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
        if (ms.busy) return;

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
            if (line !== this._lastShadowLog) { this.log(`[shadow] ${line}`); this._lastShadowLog = line; }
            return;
        }
        if (!p.skill) return;
        this.log(line);
        try {
            // Dispatch through the same supervised path the bridge uses, so the
            // re-entry guard + supervised lock still apply (one skill at a time).
            const skills = await import('../library/skills.js');
            this.agent.supervised_skill = true;
            try {
                await skills.customSkill(this.bot, p.skill, ...(p.args || []));
            } finally {
                this.agent.supervised_skill = false;
            }
        } catch (e) {
            this.log(`[kernel] commit error: ${e && e.message || e}`);
        }
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
