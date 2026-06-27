// task_queue.js — framework-v2 Phase-A/B: the world-model-maintained TASK QUEUE that
// supersedes the single bot._commitment. PURE functions over a Task[] (q[0] = HEAD).
//
// Design: docs/framework-v2-task-queue.md §2.4. The queue is a STRUCTURAL SUPERSET of the
// old single commitment — the ranked proposeTasks output seeds an ordered queue; lower-ranked
// goals survive in the backlog (the old model dropped them) and auto-recover once higher goals
// finish. commitQueue() in world_model.js owns reconcile/HEAD-selection (it has the
// isEmergency/isNightPlan/isGoalDone authority); THIS module is dependency-free array ops only,
// so it never imports world_model (no cycle) and never calls the LLM.
//
// Invariant: exactly one task has status 'active' and it is q[0] (the HEAD kernelDriver runs).
// commitQueue.reconcile() re-establishes this every ~2s; the enqueue* ops just add-without-dup,
// and reconcile's sort is the real ordering authority (so emergency/nightPre stickiness lives in
// ONE place, not smeared across the ops).

/** Stable string hash for an opportunistic locus → dedup id suffix. */
function coordHash(locus) {
    try {
        if (!locus || typeof locus.x !== 'number') return 'noloc';
        return `${Math.round(locus.x)},${Math.round(locus.y)},${Math.round(locus.z)}`;
    } catch (e) { return 'noloc'; }
}

/** Derive the dedup id: proposer task = its kind (one per kind); opportunistic = kind#locus. */
function deriveId(spec) {
    if (spec.id) return spec.id;
    if (spec.source === 'opportunistic' && spec.locus) return `${spec.kind}#${coordHash(spec.locus)}`;
    return `${spec.kind}`;
}

export function makeQueue() { return []; }

/** Normalise a raw spec into a Task. args is ALWAYS an array (kernelDriver spreads it). */
export function makeTask(spec, nowTs) {
    const now = typeof nowTs === 'number' ? nowTs : 0;
    const args = Array.isArray(spec.args) ? spec.args.slice() : (spec.args != null ? [spec.args] : []);
    return {
        id: deriveId(spec),
        kind: spec.kind,
        skill: spec.skill || '',
        args,
        priority: typeof spec.priority === 'number' ? spec.priority : 1,
        position: spec.position || 'priority',          // 'head' | 'tail' | 'priority'
        status: 'queued',                               // queued | active | done | cancelled
        trigger: spec.trigger || {
            source: spec.source || 'proposer',
            cond: spec.cond || null,
            lifecycle: spec.lifecycle || 'persistent',
            episodeId: spec.episodeId || null,
            vetoedUntil: 0,
            until: spec.until || 0,
        },
        resolve: spec.resolve || null,                  // late-bind {skill,args} at dispatch (opp tasks)
        rationale: spec.rationale || '',
        source: spec.source || (spec.trigger && spec.trigger.source) || 'proposer',
        createdTs: now,
        since: 0,
    };
}

export function find(q, id) { return q.find(t => t.id === id) || null; }
export function findByKind(q, kind) { return q.find(t => t.kind === kind) || null; }
/** dedup key = task.id. Returns the existing same-id task (proposer: same kind) or null. */
export function dedup(q, id) { return q.find(t => t.id === id) || null; }
export function peekHead(q) { return (q && q.length) ? q[0] : null; }

/** Insert at front (high-urgency, e.g. found-diamond). commitQueue.reconcile re-asserts the true
 *  head next pass, so emergency protection is enforced there, not here. */
export function enqueueHead(q, t) {
    const ex = dedup(q, t.id);
    if (ex) { _refresh(ex, t); return ex; }
    q.unshift(t);
    return t;
}

export function enqueueTail(q, t) {
    const ex = dedup(q, t.id);
    if (ex) { _refresh(ex, t); return ex; }
    q.push(t);
    return t;
}

/** Ordered insert among QUEUED tasks by priority desc; the active HEAD keeps index 0. SEED default. */
export function enqueueByPriority(q, t) {
    const ex = dedup(q, t.id);
    if (ex) { _refresh(ex, t); return ex; }
    let i = 0;
    if (q.length && q[0].status === 'active') i = 1;     // never displace the active HEAD
    while (i < q.length && (q[i].priority || 0) >= (t.priority || 0)) i++;
    q.splice(i, 0, t);
    return t;
}

export function insertBefore(q, refId, t) {
    const ex = dedup(q, t.id);
    if (ex) { _refresh(ex, t); return ex; }
    const idx = q.findIndex(x => x.id === refId);
    if (idx < 0) { q.push(t); return t; }
    q.splice(idx, 0, t);
    return t;
}

export function insertAfter(q, refId, t) {
    const ex = dedup(q, t.id);
    if (ex) { _refresh(ex, t); return ex; }
    const idx = q.findIndex(x => x.id === refId);
    if (idx < 0) { q.push(t); return t; }
    q.splice(idx + 1, 0, t);
    return t;
}

/** Remove by id. Returns true if removed. If it was the active HEAD, mark cancelled first so
 *  kernelDriver re-dispatches (the head-snapshot will change). */
export function remove(q, id) {
    const idx = q.findIndex(t => t.id === id);
    if (idx < 0) return false;
    if (q[idx].status === 'active') q[idx].status = 'cancelled';
    q.splice(idx, 1);
    return true;
}

/** Reorder by explicit id order; ids not listed keep their relative order at the tail. */
export function reorder(q, idOrder) {
    const order = new Map(idOrder.map((id, i) => [id, i]));
    q.sort((a, b) => {
        const ai = order.has(a.id) ? order.get(a.id) : (idOrder.length + q.indexOf(a));
        const bi = order.has(b.id) ? order.get(b.id) : (idOrder.length + q.indexOf(b));
        return ai - bi;
    });
}

export function markActive(q, id) { const t = find(q, id); if (t) t.status = 'active'; return t; }
export function markDone(q, id) { const t = find(q, id); if (t) t.status = 'done'; return t; }
export function markCancelled(q, id) { const t = find(q, id); if (t) t.status = 'cancelled'; return t; }

/** Drop done/cancelled + tasks whose trigger.cond() is now false + expired one_night/until tasks.
 *  Reflexes are never in the queue, so this is purely strategic-task housekeeping. */
export function prune(q, world, bot) {
    for (let i = q.length - 1; i >= 0; i--) {
        const t = q[i];
        if (t.status === 'done' || t.status === 'cancelled') { q.splice(i, 1); continue; }
        const tr = t.trigger || {};
        try {
            if (typeof tr.cond === 'function' && !tr.cond(world, bot)) { q.splice(i, 1); continue; }
        } catch (e) {}
        // generic until-expiry handled by trigger layer / cooldown; nothing time-based here to avoid
        // needing Date.now() inside a pure module — commitQueue passes already-pruned opp tasks.
    }
}

/** Refresh an existing same-id task in place (keeps its position/status, updates priority+args+
 *  skill+rationale from the fresh spec — mirrors world_model.js:428 keep-args-fresh on re-seed). */
function _refresh(existing, fresh) {
    existing.priority = (typeof fresh.priority === 'number') ? fresh.priority : existing.priority;
    if (Array.isArray(fresh.args)) existing.args = fresh.args.slice();
    if (fresh.skill) existing.skill = fresh.skill;
    if (fresh.rationale) existing.rationale = fresh.rationale;
    if (fresh.resolve) existing.resolve = fresh.resolve;
}

/** slim view for telemetry (world_model.json backlog inspection by the overseer). */
export function slim(t) {
    return { id: t.id, kind: t.kind, skill: t.skill, priority: t.priority, position: t.position, status: t.status, src: t.source };
}
