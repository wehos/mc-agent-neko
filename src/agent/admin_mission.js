/**
 * AdminMission — persistent, highest-priority "mission" for admin commands (用户令 2026-07-07).
 *
 * 问题: 今天一条 admin 指令(WS 'task' 或游戏内 chat)只跑 ONE-SHOT —— handleMessage('admin') 置
 *   5min _extIntentUntil, 跑 max_responses 有限回合, 然后 finally 清窗口 + 发 task_finished, 无论
 *   目标是否真的达成。缺的是"持续 self-prompt 直到判定完成"的那一半。
 *
 * 本控制器把每条 admin 指令变成一个显式状态机 (IDLE → RUNNING → ENDING → IDLE), 复用现有的
 *   self_prompter 作为持续自驱引擎 (它的 survival-interrupt→resume / modes should_reprompt 抑制 /
 *   conversation pause 全部自动继承, 不引入第二条抢身体的控制回路)。四种终止条件:
 *     DONE       — LLM 判定完成 → !endGoal        → end('done')      → task_finished status=ok
 *     OVERRIDE   — 新 admin 指令进来               → end('superseded') 旧 id → 起新任务
 *     IMPOSSIBLE — LLM 判定做不到 → !cannotComplete → end('impossible') → status=failed
 *                  或 self_prompt 连续无进展 → onNoProgress 仲裁 → 放弃; 或超时/死亡预算耗尽
 *     SURVIVAL   — modes 反射 stopLoop (瞬时) / kernel 危急强派 surviveNow / 死亡 → 任务不结束,
 *                  自动恢复; 死亡计入预算, 超预算才发一帧 interrupted。硬保命(vitalNow)恒独立。
 *
 * 上线: env MC_ADMIN_MISSION (默认开; =0 秒回退到旧一次性路径, 每个热点路径都 gate)。硬上限:
 *   MC_ADMIN_MISSION_MAX_MS(默认 30min 挂钟, 有进展则续)、MC_ADMIN_MISSION_DEATH_BUDGET(默认 3,
 *   =0 则死亡即中止)。exactly-once task_finished 由 end() 的幂等闸(state!==RUNNING 即 no-op)保证。
 *
 * 红线遵循: 无模块级可变状态(_submitLock 挂实例); telemetry/banner 全 try/catch, 绝不伤 agent。
 */

import { wsServer } from '../websocket/ws_server.js';

const IDLE = 'IDLE';
const RUNNING = 'RUNNING';
const ENDING = 'ENDING';

// Rolling kernel-yield backstop — mirrors handleMessage's 5-min crash fallback. tick() re-stamps
// it while the loop is truly ACTIVE; if the controller ever dies without end(), the kernel recovers
// full autonomy + gray-zone survival within this window.
const MISSION_EXTINTENT_MS = 300000;

export class AdminMission {
    constructor(agent) {
        this.agent = agent;
        this.state = IDLE;
        this.mission = null;          // {text, taskId, origin('ws'|'chat'), startedAt, deadlineAt, deaths}
        this.turnManaged = false;     // true while THIS controller's own handleMessage('admin') turn runs
        this._submitLock = Promise.resolve();   // instance-level serialization (no module-level mutable state)
        this._lastBanner = { text: '', at: 0 }; // anti-reflexive self-chat guard
        this._lastProgressCheckAt = 0;
        this._lastProgressSig = '';

        const ms = parseInt(process.env.MC_ADMIN_MISSION_MAX_MS, 10);
        this._maxMs = (Number.isFinite(ms) && ms > 0) ? ms : 1800000;   // 30 min default
        const db = parseInt(process.env.MC_ADMIN_MISSION_DEATH_BUDGET, 10);
        this._deathBudget = Number.isFinite(db) ? db : 3;               // deaths tolerated before abort (0 = death aborts)
    }

    // ── public state ──────────────────────────────────────────────────────────
    isActive() { return this.state === RUNNING; }
    isRunningLoop() { return this.state === RUNNING && this.agent.self_prompter.isActive(); }

    _bot() { return this.agent && this.agent.bot; }
    _syncMirror() {
        // kernel reads bot._adminMission.active to widen the survival floor during a mission.
        try { const b = this._bot(); if (b) b._adminMission = { active: this.state === RUNNING }; } catch (e) {}
    }

    // ── entry: a new admin command (serialized so two fast tasks never interleave) ───────────────
    submit(input) {
        const run = () => this._submit(input || {});
        const p = this._submitLock.then(run, run);
        this._submitLock = p.catch(() => {});   // never let a rejection wedge the chain
        return p;
    }

    async _submit({ text, taskId, origin }) {
        try {
            text = String(text == null ? '' : text).replace(/\s+$/,'').trim();
            if (!text) return;
            // Bare lifecycle command typed by admin → drive the FSM via its perform() hook, no new mission.
            if (/^!(endGoal|cannotComplete|goal)\b/i.test(text)) {
                this.turnManaged = true;
                try { await this.agent.handleMessage('admin', text); }
                finally { this.turnManaged = false; }
                return;
            }
            // Anti-reflexive guard: never spawn a mission from the bot's own leaked banner/status chat.
            if (this._isReflexive(text)) {
                console.log(`[adminMission] ignored reflexive self-chat: ${text.slice(0, 60)}`);
                return;
            }
            await this.begin({ text, taskId: (typeof taskId === 'string' && taskId) ? taskId : null, origin: origin || 'ws' });
        } catch (e) {
            console.error('[adminMission] submit error:', e && e.message || e);
        }
    }

    _isReflexive(text) {
        try {
            const now = Date.now();
            if (this._lastBanner.text && now - this._lastBanner.at < 5000) {
                const b = this._lastBanner.text;
                if (text === b || text.includes(b) || b.includes(text)) return true;
            }
            if (this.mission && this.mission.text && text === this.mission.text && this.state === RUNNING
                && now - this.mission.startedAt < 5000) return true;
            // our own emitted chat: banners (🎯/✅/🔄/⚠️/⏱/⛔), NL status (🤖/🎯[按指令]), mirror (◀), inv (📦)
            if (/^(🎯|✅|🔄|⚠️|⏱|⛔|🤖|◀|📦)/.test(text)) return true;
            if (/开始执行指令|指令完成|回到自主行动|切换任务|任务(无法完成|超时|中断|中止)/.test(text)) return true;
        } catch (e) {}
        return false;
    }

    // ── begin a mission ─────────────────────────────────────────────────────────
    async begin(mine0) {
        const now = Date.now();
        const mine = { text: mine0.text, taskId: mine0.taskId, origin: mine0.origin,
            startedAt: now, deadlineAt: now + this._maxMs, deaths: 0 };
        // Supersede any running mission FIRST — fires the OLD taskId exactly once.
        if (this.state === RUNNING) { await this.end('superseded', 'new task'); }
        // Ensure the shared self_prompter is fully down before we take it over (a stray !goal loop, etc.).
        try { await this.agent.self_prompter.stop(false); } catch (e) {}
        // Wrest the body BEFORE any further await (fixes the override handoff stall).
        try { this.agent.requestInterrupt(); } catch (e) {}

        this.mission = mine;
        this.state = RUNNING;
        this._syncMirror();
        try { const b = this._bot(); if (b) b._extIntentUntil = Date.now() + MISSION_EXTINTENT_MS; } catch (e) {}
        try { wsServer.beginMissionTask(mine.text, mine.taskId, mine.origin); } catch (e) {}
        this._emitBanner('🎯 开始执行指令：' + mine.text.replace(/\n/g, ' ').slice(0, 80));
        console.log(`[adminMission] BEGIN (${mine.origin}) task_id=${mine.taskId || '-'}: ${mine.text.slice(0, 80)}`);

        // Initial turn — mission-managed so handleMessage skips its one-shot admin blocks.
        this.turnManaged = true;
        try {
            await this.agent.handleMessage('admin', mine.text);
        } catch (e) {
            console.error('[adminMission] initial turn error:', e && e.message || e);
        } finally {
            this.turnManaged = false;
        }
        // Only engage the persistent loop if this mission is STILL the active one (the LLM may have
        // already !endGoal'd a trivial task inside the initial turn → state IDLE → don't restart).
        if (this.state === RUNNING && this.mission === mine) {
            try {
                this.agent.self_prompter.owner = this;
                this.agent.self_prompter.start(mine.text);
            } catch (e) { console.error('[adminMission] self_prompter.start error:', e && e.message || e); }
        }
    }

    // ── per-tick housekeeping (called from agent.update, wrapped so a throw can't stall the loop) ──
    tick(/* delta */) {
        if (this.state !== RUNNING) return;
        const bot = this._bot();
        if (!bot) return;
        const m = this.mission;
        const now = Date.now();

        this._maybeExtendDeadline(now);
        if (now > m.deadlineAt) { this.end('impossible', 'deadline'); return; }

        // Roll extIntent ONLY while the loop is truly ACTIVE — a conversation-paused mission must
        // stop muzzling survival (paused ≠ active).
        if (this.agent.self_prompter.isActive()) {
            try { bot._extIntentUntil = now + MISSION_EXTINTENT_MS; } catch (e) {}
        }

        // Re-arm if an external stop() left the loop STOPPED (recover from run_skill's stop(false),
        // a leaked reflex stop, etc.) — but NOT while a supervised skill owns the body, and not in
        // the brief post-death settle window.
        if (!this.agent.supervised_skill && this.agent.self_prompter.isStopped()
            && !(bot._diedAt && now - bot._diedAt < 4000)) {
            try {
                this.agent.self_prompter.owner = this;
                this.agent.self_prompter.start(m.text);
            } catch (e) {}
        }
    }

    _maybeExtendDeadline(now) {
        // Extend the stall clock ONLY on real acquisitive progress (inventory / dimension change),
        // so a genuinely-working mission is never cut off but a no-progress livelock still hits MAX_MS.
        if (now - this._lastProgressCheckAt < 15000) return;
        this._lastProgressCheckAt = now;
        const bot = this._bot();
        if (!bot || !bot.entity) return;
        let sig = '';
        try {
            let items = 0; for (const it of bot.inventory.items()) items += it.count;
            sig = items + '|' + ((bot.game && bot.game.dimension) || '');
        } catch (e) { return; }
        if (this._lastProgressSig && sig !== this._lastProgressSig) {
            this.mission.deadlineAt = now + this._maxMs;
        }
        this._lastProgressSig = sig;
    }

    // ── self_prompter callback: MAX_NO_COMMAND reached while WE own the loop ─────────────────────
    async onNoProgress() {
        if (this.state !== RUNNING) return;
        const m = this.mission;
        const adjudicate = `You are working on the assigned task: "${m.text}". You have issued no command for several turns. `
            + `If the task is ACCOMPLISHED, respond with !endGoal. If it is genuinely IMPOSSIBLE (e.g. a required resource is absent), `
            + `respond with !cannotComplete("short reason"). Otherwise issue the next command to make progress. Respond:`;
        let used = false;
        try { used = await this.agent.handleMessage('system', adjudicate, 1); } catch (e) {}
        if (this.state !== RUNNING) return;   // !endGoal / !cannotComplete already ended it
        if (used) {
            // A command ran → keep going.
            try { this.agent.self_prompter.owner = this; this.agent.self_prompter.start(m.text); } catch (e) {}
        } else {
            await this.end('impossible', 'no-progress');
        }
    }

    // ── supervised-skill parking (run_skill mid-mission) ────────────────────────────────────────
    suspendForSupervised() {
        if (this.state !== RUNNING) return;
        try { this.agent.self_prompter.stopLoop(); } catch (e) {}   // interrupt only; state stays ACTIVE
    }
    resumeAfterSupervised() {
        if (this.state !== RUNNING) return;
        // self_prompter.update() auto-restarts once idle; nudge it if it was fully stopped.
        try {
            if (this.agent.self_prompter.isStopped()) {
                this.agent.self_prompter.owner = this;
                this.agent.self_prompter.start(this.mission.text);
            }
        } catch (e) {}
    }

    // ── death (survival interrupt with a bounded resume budget) ─────────────────────────────────
    // returns true = handled by the mission (caller must NOT fire a raw interrupted frame).
    noteDeath() {
        if (this.state !== RUNNING) return false;
        const m = this.mission;
        m.deaths = (m.deaths || 0) + 1;
        console.log(`[adminMission] death ${m.deaths} (budget ${this._deathBudget}) during mission`);
        if (this._deathBudget <= 0 || m.deaths > this._deathBudget) {
            this.end('deaths-exceeded', `died ${m.deaths}x`);
        }
        // else: keep the mission live; monitorRespawn suppresses the sticky grind and the loop resumes.
        return true;
    }

    // ── the single idempotent termination funnel ────────────────────────────────────────────────
    async end(reason, detail) {
        if (this.state !== RUNNING) return;   // first cause wins; any racing second cause no-ops
        this.state = ENDING;
        const m = this.mission;
        // Stop the loop from firing one more stray turn (interrupt is synchronous).
        try { this.agent.self_prompter.owner = null; } catch (e) {}
        try { this.agent.self_prompter.interrupt = true; } catch (e) {}
        try { const b = this._bot(); if (b) b._extIntentUntil = 0; } catch (e) {}

        // Fire the terminal frame SYNCHRONOUSLY (before any await) so cleanKill/process.exit paths
        // still deliver it. Chat-origin missions fire no wire frame — local teardown only.
        const bann = this._endBanner(reason, detail);
        if (bann) { try { this._emitBanner(bann); } catch (e) {} }
        try {
            if (m && m.origin === 'ws') {
                wsServer.finishMission(m.taskId, this._statusFor(reason), this._messageFor(reason, detail));
            }
        } catch (e) { console.error('[adminMission] finishMission error:', e && e.message || e); }
        console.log(`[adminMission] END ${reason}${detail ? ' (' + detail + ')' : ''} task_id=${m && m.taskId || '-'}`);

        this.mission = null;
        this.state = IDLE;
        this._syncMirror();
        // Fully unwind the loop + stop actions (async; safe after the frame).
        try { await this.agent.self_prompter.stop(true); } catch (e) {}
    }

    // ── outcome mapping ─────────────────────────────────────────────────────────
    _statusFor(reason) {
        switch (reason) {
            case 'done': return 'ok';
            case 'superseded': return 'superseded';
            case 'impossible':
            case 'no-progress':
            case 'deadline':
            case 'deaths-exceeded': return 'failed';
            case 'aborted':
            default: return 'interrupted';
        }
    }
    _messageFor(reason, detail) {
        const reply = this._deriveTerminalReply();
        switch (reason) {
            case 'done': return reply || '任务已完成。';
            case 'superseded': return '任务已被新指令覆盖。';
            case 'impossible': return '任务无法完成' + (detail ? '：' + detail : '。');
            case 'no-progress': return '任务无进展，已判定无法完成。';
            case 'deadline': return '任务超时（超过时限），已停止。';
            case 'deaths-exceeded': return '任务因多次死亡而中止。';
            case 'aborted': return '任务已中断' + (detail ? '：' + detail : '。');
            default: return reply || '任务结束。';
        }
    }
    _deriveTerminalReply() {
        try {
            const hist = this.agent.history.getHistory();
            const useful = (s) => typeof s === 'string' && s.trim().length > 0 && s.trim() !== '\\t' && s.trim() !== '\t';
            for (let i = hist.length - 1; i >= 0; i--) {
                const e = hist[i];
                if (e && e.role === this.agent.name && useful(e.content)) return String(e.content).slice(0, 300);
            }
            for (let i = hist.length - 1; i >= 0; i--) {
                const e = hist[i];
                if (e && e.role === 'system' && useful(e.content)) return String(e.content).slice(0, 300);
            }
        } catch (e) {}
        return '';
    }

    // ── banners (mirror the old 🎯/✅ chat markers; recorded for the anti-reflexive guard) ────────
    _emitBanner(text) {
        this._lastBanner = { text: String(text), at: Date.now() };
        try {
            const bot = this._bot();
            if (bot && typeof bot.chat === 'function' && bot.entity && String(process.env.DEBUG_CHAT || '1') !== '0') {
                let s = String(text).replace(/[\r\n]+/g, ' ').trim();
                if (s.length > 250) s = s.slice(0, 247) + '...';
                bot.chat(s);
            }
        } catch (e) {}
    }
    _endBanner(reason, detail) {
        switch (reason) {
            case 'done': return '✅ 指令完成，回到自主行动';
            case 'superseded': return '🔄 收到新指令，切换任务';
            case 'impossible': return '⚠️ 任务无法完成' + (detail ? '：' + detail : '') + '，回到自主行动';
            case 'no-progress': return '⚠️ 任务无进展，判定无法完成，回到自主行动';
            case 'deadline': return '⏱ 任务超时，停止，回到自主行动';
            case 'deaths-exceeded': return '⚠️ 多次死亡，任务中止';
            case 'aborted': return '⛔ 任务中断，回到自主行动';
            default: return '✅ 任务结束';
        }
    }
}
