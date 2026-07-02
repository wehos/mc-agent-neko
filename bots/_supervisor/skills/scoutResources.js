// scoutResources — OPENING SCOUT: find the first tree (wood) and/or the nearest village so the
// bootstrap chain (wood→table→pickaxe / village beds+crops) can begin. This is the daytime answer
// to the "naked spawn sleepwalks into a generic prepNether" failure: instead of wandering, the bot
// does a deliberate, BOUNDED radial search for the two resources that unlock the early game.
//
// WHY THIS EXISTS (framework-v2 opening spec): computeOpening (modes.js) classifies the opening into
//   SCOUT / WOOD_BUFFER / VILLAGE_HARVEST / DONE with need = wood | village | both | null.
//   The SCOUT state proposes OPENING_SCOUT(skill=scoutResources). This skill TURNS that intent into
//   movement: it walks toward known/visible wood and/or hop-marches a bounded radial pattern probing
//   for a village, letting the C328 landmark scanner (modes.js) auto-PERSIST whatever it loads into
//   range. This skill itself never writes landmarks.json — it only MOVES so the scanner can see.
//
// HARD SAFETY (the explore-and-die lesson): defer to the survival layer on night / hp<=6 / a close
//   actionable hostile. Movement is short hops the planner can solve; the self_preservation reflex
//   (modes.js) runs throughout goToPosition. Only when WE actively move do we clear a stale MAROONED
//   flag (same authority-take as forageExplore/migrate) so a dead flag can't silently no-op every hop.
//
// opts: { need, hop=8, maxBlocks=64, treeDist=24, treeDy=6 }
//   need overrides bot._world.opening.need (default 'both').
//
// ctx = { log, skills, world, mc, Vec3 }
// returns { scouted:true, need, treeCost, villageCost, best, pursued, reason? } on REAL progress
// (net travel / new landmark); { scouted:false, failed:true, reason } on zero-progress runs and on
// the low-hp / hostile-close defers, so the kernel dispatch-cooldown can trip (kernel contract).

const LOG_TYPES = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'];
const VILLAGE_BLOCKS = ['bell', 'hay_block', 'farmland', 'composter'];
const NIGHT_START = 13000, NIGHT_END = 23000;

// PURE — pick which resource to chase when need='both'/null: the nearer cost wins. A null cost means
// "not found"; if both are null nothing is pursued. PURE so it's offline-testable.
function chooseTarget(need, treeCost, villageCost) {
    const n = need || 'both';
    if (n === 'wood') return treeCost != null ? 'wood' : null;
    if (n === 'village') return villageCost != null ? 'village' : null;
    // both / null → nearer of the two known costs
    if (treeCost == null && villageCost == null) return null;
    if (treeCost == null) return 'village';
    if (villageCost == null) return 'wood';
    return treeCost <= villageCost ? 'wood' : 'village';
}

export default async function scoutResources(bot, ctx, opts = {}) {
    const { log, skills, world, mc } = ctx;
    const log_ = (m) => log(bot, `[scoutResources] ${m}`);

    const HOP = opts.hop || 8;
    const maxBlocks = opts.maxBlocks || 64;
    const treeDist = opts.treeDist ?? 24;
    const treeDy = opts.treeDy ?? 6;

    const isNight = () => { try { const t = bot.time.timeOfDay; return t > NIGHT_START && t < NIGHT_END; } catch { return false; } };
    const closeActionable = () => {
        try {
            return Object.values(bot.entities || {}).some(e =>
                e && e !== bot.entity && e.position && mc.isHostile(e)
                && e.position.distanceTo(bot.entity.position) < 6);
        } catch { return false; }
    };

    // ── HARD SURVIVAL GATE: scouting is a healthy-daylight activity; hand night / low-hp / point-blank
    //    hostile to the survival layer rather than walk out into a deadly window. ──
    // ★kernel return contract (audit 2026-07-02): the low-hp and hostile-close defers were truthy
    //   ({deferred:true}) — kernel-success, strike counter reset — but NOTHING dethrones the committed
    //   OPENING_SCOUT in those states: the proposal gate has no hp term, isGoalDone needs BOTH
    //   lm.wood && lm.village (never true for a bare bot), HOLD@95 needs actionable>0 && hp<10, and
    //   GET_FOOD's emergency needs food<=4 — so a hp<=6 bot (or one with a sealed/unreachable hostile
    //   <6b that never engages) re-dispatched this instant no-op every ~2s ALL DAY (same family as the
    //   craftChain/feedUp/migrate livelocks). failed:true lets 3 strikes trip the kernel's 5-min
    //   dispatch-cooldown, releasing the body to GET_FOOD@88/BOOTSTRAP_KIT@90/combat while the blocker
    //   persists. NIGHT stays a truthy defer BY DESIGN: at night the SCOUT proposal isn't pushed, so
    //   commitGoal's livePri falls to 50 and any night plan @91+ provably dethrones — it cannot loop.
    if (isNight()) { log_('defer: night — shelter, do not scout'); return { scouted: false, deferred: true, reason: 'night' }; }
    if (Math.round(bot.health) <= 6) { log_(`defer: hp=${Math.round(bot.health)}<=6 — too fragile to scout`); return { scouted: false, failed: true, reason: 'low-hp' }; }
    if (closeActionable()) { log_('defer: actionable hostile close — handle threat first'); return { scouted: false, failed: true, reason: 'hostile-close' }; }

    const need = opts.need || (bot._world && bot._world.opening && bot._world.opening.need) || 'both';
    const start = bot.entity.position.clone();
    // Entry landmark snapshot — "a NEW landmark appeared during this run" counts as progress for the
    // kernel return contract even when net travel was short (audit 2026-07-02).
    const lm0 = (bot._world && bot._world.landmarks) || {};
    const hadWood = !!lm0.wood, hadVillage = !!lm0.village;
    log_(`★SCOUT need=${need} @${Math.round(start.x)},${Math.round(start.z)} maxBlocks=${maxBlocks}`);

    // We are the deliberate mover — clear a stale MAROONED flag so goToPosition isn't silently
    // suppressed (same authority-take as forageExplore/migrate).
    const takeMovement = () => { try { if (bot._mobility && bot._mobility.state === 'MAROONED') { bot._mobility.state = 'FREE'; log_('cleared MAROONED — scout owns movement'); } } catch (e) {} };

    // ── TREE COST: nearest reachable log via the world primitive (no re-implementing search). Relax to
    //    dist<=treeDist & |dy|<=treeDy so a steep plateau log isn't counted (C324 reachability lesson). ──
    const findTree = () => {
        try {
            const logs = world.getNearestBlocks(bot, LOG_TYPES, 32, 16) || [];
            const by = start.y;
            for (const lp of logs) {
                const pos = (lp && lp.position) ? lp.position : lp;
                if (!pos) continue;
                const d = Math.hypot(pos.x - start.x, pos.z - start.z);
                if (d <= treeDist && Math.abs(pos.y - by) <= treeDy) {
                    return { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), cost: +d.toFixed(1) };
                }
            }
        } catch (e) { log_(`findTree err: ${e && e.message || e}`); }
        return null;
    };

    // ── VILLAGE COST: prefer the C328 landmark memory (persisted village), else live-sense a villager
    //    entity or a village-tell block in range. Returns {x,y,z,cost} or null. ──
    const knownVillage = () => { try { const v = bot._world && bot._world.landmarks && bot._world.landmarks.village; if (v && Number.isFinite(v.x)) return { x: v.x, y: v.y, z: v.z, cost: +Math.hypot(v.x - bot.entity.position.x, v.z - bot.entity.position.z).toFixed(1) }; } catch (e) {} return null; };
    const senseVillage = () => {
        const p = bot.entity.position;
        // villager entity
        try {
            let best = null, bd = Infinity;
            for (const e of Object.values(bot.entities || {})) {
                if (e && e.position && /villager/.test((e.name || '').toLowerCase())) {
                    const d = e.position.distanceTo(p);
                    if (d < bd) { bd = d; best = e.position; }
                }
            }
            if (best) return { x: Math.round(best.x), y: Math.round(best.y), z: Math.round(best.z), cost: +bd.toFixed(1) };
        } catch (e) {}
        // village-tell block (bell/hay/farmland/composter)
        try {
            const blks = world.getNearestBlocks(bot, VILLAGE_BLOCKS, 48, 1) || [];
            if (blks.length) {
                const pos = blks[0].position || blks[0];
                return { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), cost: +Math.hypot(pos.x - p.x, pos.z - p.z).toFixed(1) };
            }
        } catch (e) {}
        return null;
    };

    // Initial costs from where we stand.
    let tree = (need === 'village') ? null : findTree();
    let village = (need === 'wood') ? null : (knownVillage() || senseVillage());
    let treeCost = tree ? tree.cost : null;
    let villageCost = village ? village.cost : null;
    let pursued = null;
    let best = null;

    // ── If we already have a target in range, pursue the nearer one directly (C328 scanner falls the
    //    landmark as we approach; we don't write landmarks.json here). ──
    const goTo = async (t, label) => {
        if (!t) return false;
        takeMovement();
        log_(`pursue ${label} @${t.x},${t.z} (cost=${t.cost})`);
        try { await skills.goToPosition(bot, t.x, Math.round(bot.entity.position.y), t.z, 2); }
        catch (e) { log_(`${label} nav err: ${e && e.message || e}`); }
        return true;
    };

    const direct = chooseTarget(need, treeCost, villageCost);
    if (direct === 'wood') { pursued = 'wood'; best = tree; await goTo(tree, 'wood'); }
    else if (direct === 'village') { pursued = 'village'; best = village; await goTo(village, 'village'); }

    // ── BOUNDED RADIAL HOP-MARCH: nothing known in range → probe outward to LOAD chunks so the C328
    //    scanner (and our own sense) can find resources. Turn through a fan so we sweep an arc, not a
    //    single ray. Re-check survival each hop; re-sample tree/village after each hop. ──
    if (!pursued && (need !== 'wood' || treeCost == null) && (need !== 'village' || villageCost == null)) {
        const TURNS = [0, 45, -45, 90, -90, 135, -135, 180];
        let turnIdx = 0;
        let adv = 0;
        const baseAng = Math.random() * Math.PI * 2;   // deterministic-enough seed varies the sweep ray per run
        const dir = (deg) => { const a = baseAng + (deg * Math.PI) / 180; return { x: Math.cos(a), z: Math.sin(a) }; };

        for (let hop = 1; adv < maxBlocks && turnIdx < TURNS.length; hop++) {
            if (bot.interrupt_code) { log_(`interrupted at hop ${hop}`); break; }
            if (isNight()) { log_(`night fell at hop ${hop} — abort scout`); break; }
            if (closeActionable()) { log_(`hostile close at hop ${hop} — abort scout`); break; }
            if (Math.round(bot.health) <= 6) { log_(`hp dropped <=6 at hop ${hop} — abort scout`); break; }

            // re-sense from new vantage (chunks loaded)
            if (need !== 'village' && treeCost == null) { const t = findTree(); if (t) { tree = t; treeCost = t.cost; } }
            if (need !== 'wood' && villageCost == null) { const v = knownVillage() || senseVillage(); if (v) { village = v; villageCost = v.cost; } }
            const pick = chooseTarget(need, treeCost, villageCost);
            if (pick === 'wood') { pursued = 'wood'; best = tree; await goTo(tree, 'wood'); break; }
            if (pick === 'village') { pursued = 'village'; best = village; await goTo(village, 'village'); break; }

            // advance one hop along the current sweep ray
            takeMovement();
            const d = dir(TURNS[turnIdx]);
            const hx = Math.round(bot.entity.position.x + d.x * HOP);
            const hz = Math.round(bot.entity.position.z + d.z * HOP);
            const before = bot.entity.position.clone();
            try { await skills.goToPosition(bot, hx, Math.round(bot.entity.position.y), hz, 2); }
            catch (e) { /* PathfindingNoPlan — treated as a stalled hop below */ }
            const moved = bot.entity.position.distanceTo(before);
            adv += moved;
            if (moved < HOP * 0.4) {
                // stalled this ray → rotate the sweep
                turnIdx++;
                if (turnIdx < TURNS.length) log_(`hop ${hop} stalled (moved ${moved.toFixed(0)}b) — turn ${TURNS[turnIdx]}°`);
            }
        }
        log_(`hop-march done adv=${Math.round(adv)}b pursued=${pursued || 'none'}`);
    }

    // ★kernel return contract (audit 2026-07-02): this tail was UNCONDITIONALLY scouted:true — a
    // boxed-in bot (all 8 sweep rays NoPath'd, moved≈0, nothing found) or an unreachable pursued
    // target (goTo swallows nav errors; the same tree across a ravine re-picked every run) returned
    // kernel-success forever, resetting the strike counter so the 3-strike/5-min cooldown never
    // tripped while isGoalDone (lm.wood && lm.village) kept OPENING_SCOUT committed — an unbreakable
    // ~2s hot livelock that also starved the MIGRATE/woodBarren escape (it only runs once the
    // cooldown suppresses this kind) and re-cleared MAROONED via takeMovement() each pass, resetting
    // the mobility system's own escalation. Truthy now REQUIRES real progress this dispatch: genuine
    // travel (net displacement >= 12b ≈ 1.5 hops) or a NEW landmark the C328 scanner persisted
    // during the run. Zero-progress runs return failed:true so the kernel cooldown engages.
    const lmNow = (bot._world && bot._world.landmarks) || {};
    const newLandmark = (!hadWood && !!lmNow.wood) || (!hadVillage && !!lmNow.village);
    const movedNet = bot.entity.position.distanceTo(start);
    if (!newLandmark && movedNet < 12) {
        log_(`zero-progress run (moved=${Math.round(movedNet)}b, pursued=${pursued || 'none'}, no new landmark) → failed for kernel cooldown`);
        return { scouted: false, failed: true, need, treeCost, villageCost, pursued,
                 reason: 'zero-progress: no movement and no new landmark (boxed in / target unreachable)' };
    }
    const r = {
        scouted: true,
        need,
        treeCost,
        villageCost,
        best: best ? { x: best.x, y: best.y, z: best.z, cost: best.cost } : null,
        pursued,
        reason: pursued ? `pursued ${pursued}` : 'no wood/village found within scout range',
    };
    log_(`DONE ${JSON.stringify(r)}`);
    return r;
}

export { scoutResources, chooseTarget };
