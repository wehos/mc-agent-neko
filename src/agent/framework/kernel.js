/**
 * Framework v2 — Kernel (blueprint part ④ + §B modes).
 *
 * The kernel is the Survival/Companion MODE CONTROLLER + DECISION LOOP that
 * replaces the role of self_prompter. It does NOT run reflexes (instincts/modes
 * do) and does NOT mutate the bot directly (tool lanes / skills do). It:
 *
 *   survival:  read world → if idle, get proposals → LLM picks/approves → commit
 *              a task (dispatch a skill). Safety never waits for the LLM.
 *   companion: a player message switched us here; player intent leads, the LLM
 *              orchestrates instincts; the world model only nudges on high need.
 *
 * MIGRATION SAFETY: gated behind a feature flag (default OFF — see contracts).
 * When disabled, tick() is a no-op and the existing missionNether path is
 * untouched. When enabled, it runs in SHADOW first (logs the decision it WOULD
 * commit without dispatching) until decideAndDispatch is turned live.
 */

import fs from 'fs';
import { AGENT_MODE, FRAMEWORK_ENABLED_DEFAULT } from './contracts.js';
import { getWorld, mentalState, proposeTasks, commitGoal } from './world_model.js';
import { pending as pendingInstincts } from './instinct.js';

const SHADOW_LOG = 'bots/_supervisor/framework-shadow.log';

// ── ★DISPATCH-FAILURE COOLDOWN (livelock closure): a committed goal whose skill file is
//    missing / hard-fails means customSkill returns false and the 2s survival tick re-dispatches
//    it forever (e.g. OPENING_VILLAGE→villageHarvest.js not written yet). After
//    DISPATCH_FAIL_LIMIT consecutive failures of one kind, suppress that kind's proposals for
//    DISPATCH_COOLDOWN_MS via bot._kindCooldownUntil (read by world_model.proposeTasks — shared
//    through the bot object because modes.js commitGoal re-commits from the SAME proposal list
//    every ~2s, so a kernel-private suppression would not stick) and release the commitment. ──
const DISPATCH_FAIL_LIMIT = 3;
const DISPATCH_COOLDOWN_MS = 300000;   // 5 min — the kind naturally re-proposes on expiry

// ── ★NO-DELTA OVERRIDE (mechanism over discipline, 2026-07-02): the return contract says
//    truthy = real progress THIS dispatch, but 25 violations were found in one day (8 live
//    incidents + 17 in the 51-agent audit) — trusting the skill's self-report alone is
//    structurally fragile, and every NEW skill re-inherits the risk. The kernel now measures
//    its OWN progress signal: a world snapshot (position / inventory counts / dimension)
//    before each dispatch, compared after. A truthy return with NO observable world delta
//    NO_DELTA_LIMIT times in a row is treated like a failure streak (cooldown + release).
//    Idle-by-design kinds are exempt — sitting still IS their job. This does not replace
//    the contract (honest false returns are still faster: 3 strikes vs 4) — it is the
//    backstop that turns future violations from unbreakable livelocks into 4-run blips.
const NO_DELTA_LIMIT = 4;              // one more chance than DISPATCH_FAIL_LIMIT — it's a heuristic
const NO_DELTA_MOVE_BLOCKS = 6;        // below this, movement is jitter/knockback, not travel
const NO_DELTA_EXEMPT = /^(NIGHT_|DUSK_GO_BED$|HOLD$|SLEEP$|FREE_PLAY$)/;

// ── ★SUPERVISOR-CANCEL WINDOW: ws cancel_skill / modes watchdog kicks stamp
//    bot._supervisorCancelAt; skills poll cancelRequested() with this same 30s TTL
//    (prepNether.js:26, missionNether.js:381) and bail with `false` the moment they start.
//    A dispatch inside the window therefore CANNOT progress — it yields false in seconds,
//    the idle kernel re-dispatches ~6s later, and 3 attempts fit easily in 30s → every
//    cancel_skill handed the committed kind a pointless 5-min dispatch-cooldown. So the
//    kernel HOLDS dispatch while the window is live, and a failure that lands inside it
//    (cancel arrived mid-run) is NOT counted as a strike. ──
const SUPERVISOR_CANCEL_WINDOW_MS = 30000;   // MUST mirror the skills' cancelRequested() TTL

// ── ★BUSY-STUCK WATCHDOG: how long bot._currentSkill may sit set with NO supervised
//    skill and NO executing action before the kernel declares it an orphan and clears it.
//    No legitimate state holds that combination for minutes (kernel/ws dispatches set
//    agent.supervised_skill; mode-invoked skills run inside actions.executing). ──
const BUSY_STUCK_MS = 180000;   // 3 min — kernel skills run longer but are supervised

export class Kernel {
    /**
     * @param {any} agent  the mindcraft Agent (has .bot, .prompter, .actions, .supervised_skill)
     * @param {Object} [opts]
     * @param {boolean} [opts.enabled]   master flag (default from contracts/env)
     * @param {boolean} [opts.shadow]    when enabled, only LOG decisions, don't dispatch (default true)
     * @param {(msg:string)=>void} [opts.log]
     */
    constructor(agent, opts = {}) {
        this.agent = agent;
        this.bot = agent && agent.bot;
        this.mode = AGENT_MODE.SURVIVAL;
        const envFlag = (typeof process !== 'undefined' && process.env && process.env.MC_FRAMEWORK_V2 === '1');
        this.enabled = opts.enabled ?? (envFlag || FRAMEWORK_ENABLED_DEFAULT);
        this.shadow = opts.shadow ?? true;          // safe default: don't act yet
        // S3-shadow (scaffold §6): observe + LOG what the proposer WOULD dispatch vs
        // what missionNether is actually running, even while the decision loop stays
        // gated OFF. Pure read + append to SHADOW_LOG — ZERO behavior change. This is
        // the parity data we need before flipping the kernel live as the dispatcher.
        this.observe = opts.observe ?? false;
        this.log = opts.log || ((m) => { try { console.log(m); } catch (e) {} });
        this._lastDecideAt = 0;
        this._decideEveryMs = 2000;                  // don't spam the LLM
        this._dispatchFails = Object.create(null);   // kind -> consecutive dispatch-failure count (★cooldown)
        this._noDeltaRuns = Object.create(null);     // kind -> consecutive truthy-but-zero-world-delta runs (★no-delta override)
        this._cancelHoldAt = 0;                      // last _supervisorCancelAt we logged a dispatch-hold for
        this._companionUntil = 0;                    // companion-mode sticky window after a player msg
        this._lastShadowLog = '';
        this._lastObserveAt = 0;
        this._lastObserveLine = '';
        if (this.bot) this.bot._agent = agent;       // let world_model read agent state defensively
    }

    /** Called from agent.update(delta). Cheap + guarded; no-op when disabled. */
    async tick(delta) {
        if (!this.bot || !this.bot.entity) return;
        // S3-shadow observation runs INDEPENDENTLY of the decision-loop flag: it only
        // reads the world + proposeTasks and appends a line — it never dispatches.
        if (this.observe) { try { this._shadowObserve(); } catch (e) {} }
        if (!this.enabled) return;

        // Companion window decays back to survival.
        if (this._companionUntil && Date.now() > this._companionUntil) {
            this._companionUntil = 0;
            this.mode = AGENT_MODE.SURVIVAL;
        }

        if (this.mode === AGENT_MODE.COMPANION) {
            // Player intent leads; the existing handleMessage path drives the LLM.
            // The kernel only watches for high-necessity world-model nudges here.
            return this._companionNudge();
        }
        return this._survivalTick();
    }

    /** A player (supervisor) message arrived → enter companion mode. */
    onPlayerMessage(/* source, msg */) {
        this.mode = AGENT_MODE.COMPANION;
        this._companionUntil = Date.now() + 60_000; // stay companion ~60s after last player msg
    }

    // ── S3 shadow observation ────────────────────────────────────────────────
    /**
     * Throttled (10s) pure-read comparison: what the proposer WOULD pick vs what
     * skill is actually running. Appends one line to SHADOW_LOG when the picture
     * changes. No bot mutation, no dispatch — this is the migration-discipline step
     * (scaffold §6 S3): collect parity data before the kernel ever drives dispatch.
     */
    _shadowObserve() {
        const now = Date.now();
        if (now - this._lastObserveAt < 10_000) return;
        this._lastObserveAt = now;
        const world = getWorld(this.bot);
        const proposals = proposeTasks(world, this.bot);
        const top = proposals[0];
        const ms = mentalState(this.bot);
        const live = this.bot._currentSkill || ms.skill || '(none)';
        const topStr = top ? `${top.kind}/${top.skill || '-'}@${top.priority}` : 'none';
        const alt = proposals.slice(1, 3).map(p => `${p.kind}@${p.priority}`).join(',') || '-';
        const agree = top && (top.skill === live);
        // ── task-queue (Phase A/B) PARITY: shadow queue head must == commitGoal's commitment in
        //    Phase A (no opportunistic). qparity=N in Phase B is EXPECTED where an opp/backlog task
        //    outranks (informational, not a failure). qlen exposes the backlog depth. ──
        let qstr = '';
        try {
            const q = this.bot._taskQueue;
            if (Array.isArray(q) && q.length) {
                const qh = q[0];
                const cmt = this.bot._commitment;
                const par = (qh && cmt && qh.kind === cmt.kind) ? 'Y' : 'N';
                qstr = ` qhead=${qh ? qh.kind : '-'} qparity=${par} qlen=${q.length}`;
            }
        } catch (e) {}
        const line = `proposer=${topStr} live=${live} busy=${ms.busy} agree=${agree?'Y':'N'} alts=[${alt}]${qstr}`;
        if (line === this._lastObserveLine) return;     // only log on change
        this._lastObserveLine = line;
        try {
            fs.appendFileSync(SHADOW_LOG, `[${new Date().toISOString()}] ${line}\n`);
        } catch (e) {}
    }

    // ── survival ───────────────────────────────────────────────────────────
    async _survivalTick() {
        const ms = mentalState(this.bot);
        // 1) Safety/instincts always run independently (modes.js). If a reflex is
        //    about to fire, don't also commit an LLM task into this instant.
        const reflexes = pendingInstincts(this.bot);
        if (reflexes.length && reflexes[0].priority >= 80) return;

        // 2) A committed task is running → don't disturb it (decision-speed: commit, don't yo-yo).
        if (ms.busy) { this._busyStuckWatchdog(); return; }
        this._busyStuck = null;

        // 3) Idle → throttle, then propose + decide.
        const now = Date.now();
        if (now - this._lastDecideAt < this._decideEveryMs) return;
        this._lastDecideAt = now;

        const world = getWorld(this.bot);
        const proposals = proposeTasks(world, this.bot);
        if (!proposals.length) return;

        // commitGoal() makes the choice STICKY — it holds the committed goal until
        // it's actually done (or an emergency preempts), so the bot stops yo-yoing
        // (the #1 root fix). The LLM judge (S4.2) will layer on top of this.
        const committed = commitGoal(this.bot, proposals, world);
        const decision = await this.decide(proposals, world, committed);
        if (!decision || !decision.chosen) return;

        await this._commit(decision);
    }

    // ── ★BUSY-STUCK WATCHDOG (orphaned-_currentSkill self-heal). Live incident 2026-07-02
    //    00:16→00:38: achieve.js races customSkill(inner) vs timeouts; a raced-out inner
    //    skill finished LATE and its finally restored prevSkill='prepNether' over the fresh
    //    null — ms.busy stayed true with NOTHING running and the kernel sat muted 22 min
    //    while the bot stood idle. customSkill now restore-guards (skills.js finally); this
    //    is the belt-and-braces for any other way the name gets orphaned. Timer accrues per
    //    held NAME (executing flickers from mode actions don't reset it), but it only FIRES
    //    in an executing gap so a live mode-invoked skill is never yanked mid-action. ──
    _busyStuckWatchdog() {
        const name = this.bot._currentSkill;
        const supervised = !!(this.agent && this.agent.supervised_skill);
        if (!name || supervised) { this._busyStuck = null; return; }
        if (!this._busyStuck || this._busyStuck.name !== name) this._busyStuck = { name, since: Date.now() };
        const heldMs = Date.now() - this._busyStuck.since;
        // ★post-death fast path (checkpoint #4; CONDITION FIXED per checkpoint #7: the
        // original `_diedAt >= _busyStuck.since` was provably always false — this counter
        // only STARTS once supervised_skill clears, which happens AFTER the death when the
        // skill's awaits finally settle, so `since` always postdates `_diedAt` and the 07:53
        // death still ate 266s of mute. "A death happened recently" is the real signal: a
        // death invalidates whatever context the held name had; 45s is plenty for a
        // legitimately-resumed skill to re-assert itself (the deliberate skills-survive-
        // respawn design, agent.js death handler NOTE, stays untouched).
        const recentDeath = !!(this.bot._diedAt && Date.now() - this.bot._diedAt < 300000);
        if (heldMs < (recentDeath ? 45000 : BUSY_STUCK_MS)) return;
        if (this.agent && this.agent.actions && this.agent.actions.executing) return;
        this.log(`[kernel] ★busy-stuck watchdog: bot._currentSkill='${name}' held ${Math.round(heldMs / 1000)}s with no supervised skill and no executing action — clearing the orphan (kernel unmutes)`);
        try { fs.appendFileSync('bots/_supervisor/progress.txt', `[${new Date().toISOString()}] [kernel] ★busy-stuck watchdog cleared orphaned _currentSkill='${name}' after ${Math.round(heldMs / 1000)}s\n`); } catch (e) {}
        this.bot._currentSkill = null;
        this._busyStuck = null;
    }

    /**
     * Ask the LLM to pick/approve among proposals (survival 拍板). Until S4 wires
     * the prompter, this falls back to the proposer's top-ranked proposal so the
     * loop is testable end-to-end. The fallback is explicit, not silent.
     * @returns {Promise<import('./contracts.js').Decision>}
     */
    async decide(proposals, world, committed) {
        // TODO(S4.2): call this.agent.prompter.promptProposalJudgment(proposals, world,
        //   committed) with the survival/companion mode semantics injected (blueprint §G).
        //   For now the kernel acts on the STICKY committed goal (S4.1) — no LLM yet.
        const pick = committed || proposals[0];
        if (pick && pick.kind === 'FREE_PLAY') {
            // idle + nothing pressing → let the LLM improvise (S4.2 routes to free chat)
            return { chosen: null, reason: 'idle, no pressing task (free-play deferred to S4.2)', freePlay: true };
        }
        const tag = pick && pick.committed ? (pick.preemptedFrom ? `preempt ${pick.preemptedFrom}→${pick.kind}` : 'committed') : 'top-rank';
        return { chosen: pick, reason: `${tag} (no LLM yet): ${pick ? pick.rationale : 'none'}`, freePlay: false };
    }

    /** Commit a decision = dispatch its skill (or shadow-log it). */
    async _commit(decision) {
        const p = decision.chosen;
        const line = `[kernel] commit ${p.kind} via ${p.skill || '(free)'} — ${decision.reason}`;
        if (this.shadow) {
            // Shadow-mode invariance: return BEFORE any dispatch/counting/heartbeat —
            // observe/shadow behavior stays byte-identical (no bot._kindCooldownUntil writes).
            if (line !== this._lastShadowLog) { this.log(`[shadow] ${line}`); this._lastShadowLog = line; }
            return;
        }
        if (!p.skill) return;
        // ★SUPERVISOR-CANCEL WINDOW → hold dispatch until it clears (see constant above).
        // Checked HERE (after decide's await, right before we touch the bot) so a cancel
        // arriving mid-tick still holds; it also keeps the stale-interrupt clear below from
        // swallowing the live cancel's interrupt_code. Reflexes/modes are untouched — this
        // only pauses task dispatch. Not a strike: nothing was dispatched.
        if (this.bot._supervisorCancelAt && Date.now() - this.bot._supervisorCancelAt < SUPERVISOR_CANCEL_WINDOW_MS) {
            if (this._cancelHoldAt !== this.bot._supervisorCancelAt) {
                this._cancelHoldAt = this.bot._supervisorCancelAt;
                const left = Math.ceil((this.bot._supervisorCancelAt + SUPERVISOR_CANCEL_WINDOW_MS - Date.now()) / 1000);
                this.log(`[kernel] supervisor-cancel window — holding dispatch ~${left}s (not committing ${p.kind}/${p.skill})`);
            }
            return;
        }
        this.log(line);
        // ★HEARTBEAT (non-shadow only, before dispatch): prepNether.js:102 reads
        // bot._kernelDriverActive (fresh ≤10s) to yield its legacy night fallback exactly
        // when the framework is live-dispatching. Nobody wrote it until now.
        try { this.bot._kernelDriverActive = Date.now(); } catch (e) {}
        // ★STALE-INTERRUPT HYGIENE: skills no longer clear bot.interrupt_code at entry
        // (setupEndPortal's entry-clear swallowed a live !stop raised just before an 8-min
        // dispatch). A flag still set HERE is a leftover — update() only reaches _commit
        // when ms.busy is false, i.e. no action is running that the flag could belong to —
        // and left alone it would abort every dispatch at its first stop() poll (3x false
        // → a pointless 5-min kind cooldown).
        if (this.bot.interrupt_code) {
            this.log(`[kernel] clearing stale interrupt_code before ${p.skill} dispatch`);
            this.bot.interrupt_code = false;
        }
        // ★NO-DELTA: pre-dispatch world snapshot (position / inventory counts / dimension).
        const snap = this._worldSnap();
        // Dispatch through the same supervised path the bridge uses, so the
        // re-entry guard + supervised lock still apply (one skill at a time).
        const skills = await import('../library/skills.js');
        // ★WS-MUTEX: the tick's ms.busy check is stale by now — the awaits since then
        // (decide, this import) are exactly where a ws run_skill can start. Re-check right
        // before taking the lock; no awaits between this check and the assignment, so
        // check-and-set is atomic on the JS thread. Skipping is not a strike.
        if (mentalState(this.bot).busy) {
            this.log(`[kernel] dispatch skip: a supervised skill is already running — not committing ${p.skill}`);
            return;
        }
        // Owner-tagged lock (truthy string, same readers as the old `true`): ws_server.runSkill
        // tags 'ws'. Each side releases ONLY its own tag — an unconditional clear here is how a
        // finishing kernel dispatch used to clobber the flag mid-ws-skill, so the next tick saw
        // busy=false and double-dispatched into the running ws probe (pathfinder tug-of-war).
        this.agent.supervised_skill = 'kernel';
        // ★DETACHED DISPATCH (postmortem 2026-07-02 05:41 — THE root of every geared death
        // today): this await used to run INLINE in agent.update's serial 300ms loop, so ALL
        // modes (self_defense, threat_radar, auto_eat, self_preservation, the works) were
        // starved for the entire duration of any kernel-dispatched skill — a bot with iron
        // sword+shield+full armor sat in nightShelter's hold loop and was punched to death
        // by two zombies with ZERO response ("Tick modes still protect it" was only ever
        // true for the ws path, which runs skills in a detached async context — ws_server.js
        // :305 — and has for days). The kernel now uses the same contract: launch detached,
        // return the tick immediately (modes keep breathing), settle the failure/no-delta
        // accounting in the completion handler. Mutual exclusion is unchanged — the
        // supervised lock above is set SYNCHRONOUSLY (mentalState.busy reads it), so the
        // next tick's ms.busy guard blocks re-dispatch until this run settles.
        (async () => {
            let res, threw = false;
            try {
                res = await skills.customSkill(this.bot, p.skill, ...(p.args || []));
            } catch (e) {
                threw = true;
                this.log(`[kernel] commit error: ${e && e.message || e}`);
            } finally {
                if (this.agent.supervised_skill === 'kernel') this.agent.supervised_skill = false;
            }
            try { this._settleDispatch(p, snap, res, threw); } catch (e) { this.log(`[kernel] settle error: ${e && e.message || e}`); }
        })();
    }

    /** Post-dispatch accounting (failure strikes / cooldowns / no-delta override) — runs in
     *  the detached dispatch context after the skill settles, NOT on the tick chain. */
    _settleDispatch(p, snap, res, threw) {
        // ★DISPATCH-FAILURE COOLDOWN. Strict `res === false` (NOT falsy): customSkill returns
        // false on a missing file / no default export / invalid name; skills returning 0 (e.g.
        // mineDiamonds' dia() count) or undefined are NOT counted. Object returns fail ONLY via
        // the explicit `failed:true` key (realNetherPortal sets it) — a generic `entered===false`
        // sniff also matched setupEndPortal's truthy PROGRESS return {phase:'enter',entered:false}
        // and cooled GO_END down while the bot stood on a lit End portal.
        const failed = threw || res === false
            || (res && typeof res === 'object' && (res.ok === false || res.failed === true));
        // ★CANCEL-UNWIND is not a strike: a supervisor cancel landing mid-run makes the skill
        // return false BY DESIGN (cancelRequested() bail). Counting those was the other half of
        // the "every cancel_skill → 5-min kind cooldown" livelock. Leave the counter untouched
        // (neither strike nor reset) when the failure arrives inside a live cancel window.
        const cancelUnwind = failed && this.bot._supervisorCancelAt
            && Date.now() - this.bot._supervisorCancelAt < SUPERVISOR_CANCEL_WINDOW_MS;
        if (failed && !cancelUnwind) {
            const k = p.kind;
            this._dispatchFails[k] = (this._dispatchFails[k] || 0) + 1;
            if (this._dispatchFails[k] >= DISPATCH_FAIL_LIMIT) {
                this._dispatchFails[k] = 0;
                // Cooldown lives on the BOT object (HANDOFF red line: no module-level mutable
                // state — survives skill hot-reload; and proposeTasks can only see the bot).
                if (!this.bot._kindCooldownUntil) this.bot._kindCooldownUntil = {};
                this.bot._kindCooldownUntil[k] = Date.now() + DISPATCH_COOLDOWN_MS;
                // Release the livelocked commitment so modes.js's next commitGoal pass commits
                // the next-ranked kind (the '(holding commitment)' fallback can't resurrect it).
                if (this.bot._commitment && this.bot._commitment.kind === k) this.bot._commitment = null;
                this.log(`[kernel] dispatch-cooldown: ${k}/${p.skill} failed ${DISPATCH_FAIL_LIMIT}x consecutively — suppressing ${k} proposals 5min + releasing commitment`);
                try { fs.appendFileSync('bots/_supervisor/progress.txt', `[${new Date().toISOString()}] [kernel] ★dispatch-cooldown ${k} via ${p.skill}\n`); } catch (e) {}
            }
        } else if (!failed) {
            this._dispatchFails[p.kind] = 0;
            // ★NO-DELTA OVERRIDE measurement: a truthy (or undefined) return claims progress —
            // check the world actually changed. Exempt idle-by-design kinds and cancel windows.
            if (snap && !NO_DELTA_EXEMPT.test(p.kind) && !(this.bot._supervisorCancelAt
                && Date.now() - this.bot._supervisorCancelAt < SUPERVISOR_CANCEL_WINDOW_MS)) {
                const now = this._worldSnap();
                const moved = (now && now.pos && snap.pos) ? now.pos.distanceTo(snap.pos) : Infinity;
                const delta = !now || moved >= NO_DELTA_MOVE_BLOCKS || now.inv !== snap.inv || now.dim !== snap.dim;
                if (delta) {
                    this._noDeltaRuns[p.kind] = 0;
                } else {
                    this._noDeltaRuns[p.kind] = (this._noDeltaRuns[p.kind] || 0) + 1;
                    if (this._noDeltaRuns[p.kind] >= NO_DELTA_LIMIT) {
                        this._noDeltaRuns[p.kind] = 0;
                        if (!this.bot._kindCooldownUntil) this.bot._kindCooldownUntil = {};
                        this.bot._kindCooldownUntil[p.kind] = Date.now() + DISPATCH_COOLDOWN_MS;
                        if (this.bot._commitment && this.bot._commitment.kind === p.kind) this.bot._commitment = null;
                        this.log(`[kernel] no-delta override: ${p.kind}/${p.skill} returned truthy ${NO_DELTA_LIMIT}x with zero world delta — cooldown + release (return-contract violation suspected)`);
                        try { fs.appendFileSync('bots/_supervisor/progress.txt', `[${new Date().toISOString()}] [kernel] ★no-delta override ${p.kind} via ${p.skill}\n`); } catch (e) {}
                    }
                }
            }
        }
        // (failed && cancelUnwind falls through: counter untouched — a cancel neither proves
        //  the kind broken nor that it works.)
    }

    // ── ★NO-DELTA world snapshot: cheap in-memory reads only (no block scans). ──
    _worldSnap() {
        try {
            const counts = {};
            for (const it of this.bot.inventory.items()) counts[it.name] = (counts[it.name] || 0) + it.count;
            return {
                pos: this.bot.entity.position.clone(),
                inv: JSON.stringify(Object.entries(counts).sort()),
                dim: String((this.bot.game && this.bot.game.dimension) || ''),
            };
        } catch (e) { return null; }
    }

    // ── companion ──────────────────────────────────────────────────────────
    async _companionNudge() {
        // High-necessity-only nudge: if the world model flags an emergency while
        // the player is chatting, surface it. Wiring to chat is S5.
        const w = getWorld(this.bot);
        if (w.vitals.hp <= 6 || w.threat.creeperDist != null && w.threat.creeperDist < 4) {
            const note = `[companion] high-necessity: hp=${w.vitals.hp} creeper=${w.threat.creeperDist}`;
            if (note !== this._lastShadowLog) { this.log(note); this._lastShadowLog = note; }
        }
    }
}
