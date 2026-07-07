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
import { resolve as arbitrate, setBodyOwner, releaseBodyOwner, vitalNow as arbiterVitalNow } from './arbiter.js';

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
// ★INTERRUPT-UNWIND (checkpoint #13, goBedSleep postmortem 2026-07-02): a reflex raising
//    bot.interrupt_code makes any well-behaved skill bail with false BY DESIGN (the stop()
//    contract) — same shape as cancel-unwind, and counting those as strikes is how DUSK_GO_BED
//    burned 3 strikes in 16s (self_preservation fired mid-approach to a bed 2.5b away) and the
//    bot slept through ZERO nights. Not a strike; but bounded — a reflex firing every single
//    attempt means it is CHRONIC at this task's location, and without a valve the kind would
//    livelock (dispatch→interrupt→re-dispatch forever). After each unwind, dispatch pauses
//    INTERRUPT_HOLD_MS so the reflex finishes instead of being re-dispatched into.
const INTERRUPT_UNWIND_LIMIT = 8;      // consecutive unwinds of one kind → cooldown anyway
const INTERRUPT_HOLD_MS = 4000;        // post-unwind dispatch pause (reflex settle time)

// ── ★GRAY-ZONE COMMANDER (session#4 大修 2026-07-05): 灰区(hp<12 || food<8 || 同锚>5min)
//    无唯一决策人是全部僵局的机制根源 — 每个僵局都是 2-4 个局部合理否决闸的合取, 组合空间
//    指数级, 打地鼠不可完成(#3 全天 45+ commits 实证)。触发时 kernel 绕过提案市场强制派发
//    surviveNow(确定性生存树: 吃>打>床>觅食>挖墙转移>求死重置; 树平手时 LLM 战术官选罐装
//    动作)。技能激活期间软 hold 让位: 走 execute() 的由 arbitration.json kernel:surviveNow
//    精确行挡下, 绕过 execute() 的直写路径查 bot._surviveNowUntil 滚动戳(modes.js
//    surviveNowActive)。真·保命地板(vitalNow/溺水 hold)不受影响。
//    反活锁: SVN 不占用 _kindCooldownUntil(它不走提案), 自带升级冷却(零进度 60s*2^n 封顶
//    8min, 期间滚动戳 ≤30s 过期 → 正常行为接管); 树的末枝(keepInventory 死亡重置, 服务器
//    已 RCON 验证 → bots/_supervisor/keepinv.json)保证任何灰区在有限步内终止。 ──
const SVN_HP_FLOOR = 12;               // hp < 12 → 灰区
const SVN_FOOD_FLOOR = 8;              // food < 8 → 灰区
const SVN_ANCHOR_MS = 300000;          // 同 10b 锚 >5min → 灰区(僵局信号)
const SVN_ANCHOR_RADIUS = 10;          // 与 reflex_watchdog pin/pocketFuse 同口径
const SVN_COOLDOWN_BASE_MS = 60000;    // 零进度升级冷却基数
const SVN_COOLDOWN_CAP_MS = 480000;    // 冷却封顶 8min

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
        this._interruptUnwinds = Object.create(null); // kind -> consecutive interrupt-unwind count (★valve)
        this._interruptHoldUntil = 0;                // dispatch pause after an interrupt-unwind (reflex settle)
        this._arbHoldLogAt = 0;                      // last arbitration-hold log (10s rate limit, ★仲裁 B)
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

    // ── ★GRAY-ZONE anchor tracker: 每 tick 便宜维护(水平 hypot, >10b 或睡眠中重置)。
    //    reflex_watchdog 的 pinAt 被豁免族反复清零, pocketFuse 锚只在 kick 分支更新,
    //    都不可复用(recon 定论) — kernel 自持一份。 ──
    _trackAnchor() {
        try {
            const bot = this.bot;
            const p = bot.entity.position;
            const a = bot._svnAnchor;
            if (bot.isSleeping || !a || Math.hypot(p.x - a.x, p.z - a.z) > SVN_ANCHOR_RADIUS) {
                bot._svnAnchor = { x: p.x, z: p.z, since: Date.now() };
            }
        } catch (e) {}
    }

    /** 灰区信号: 触发原因字符串 | null。死亡/重生盈余期(20s)不触发。 */
    _grayZoneSignal() {
        try {
            const bot = this.bot;
            if (!bot.entity) return null;
            const hp = (typeof bot.health === 'number') ? bot.health : 20;
            const food = (typeof bot.food === 'number') ? bot.food : 20;
            if (hp <= 0) return null;
            if (bot._diedAt && Date.now() - bot._diedAt < 20000) return null;
            if (bot.isSleeping) return null;
            if (hp < SVN_HP_FLOOR) return `hp${Math.round(hp)}<${SVN_HP_FLOOR}`;
            if (food < SVN_FOOD_FLOOR) return `food${food}<${SVN_FOOD_FLOOR}`;
            const a = bot._svnAnchor;
            if (a && Date.now() - a.since > SVN_ANCHOR_MS) {
                // 夜间健康驻守(蓄意夜宿/封箱 = 本仓库鼓励行为)不算僵局 — 锚独触发要么白天,
                // 要么伴随血粮不适(评审: 否则每个无床之夜必然整夜 SVN↔冷却抖动)。
                let night = false;
                try { const t = bot.time.timeOfDay; night = t >= 12542 && t <= 23459; } catch (e) {}
                if (!night || hp < 16 || food < 12) return `anchor${Math.round((Date.now() - a.since) / 60000)}min`;
            }
        } catch (e) {}
        return null;
    }

    // ── survival ───────────────────────────────────────────────────────────
    async _survivalTick() {
        // ★2026-07-07 外部意图独占 (用户令): admin 指令(WS task / 游戏内 chat)由内部 gpt-5.4-mini 执行
        //   期间, 内核完全让位 —— 不派发任何提案(夜挖/FREE_PLAY), 也不 force 灰区求生 —— 直到那个
        //   chat-loop 结束(agent.handleMessage 的 finally 清 bot._extIntentUntil)。这就是"外部意图=最高
        //   优先级、独占, 直到 gpt-5.4-mini 判定完成"。硬保命反射(modes vitalNow: 溺水/着火/岩浆/hp≤4)
        //   独立于内核、仍生效; 5min 戳是崩溃兜底。
        if (this.bot._extIntentUntil && Date.now() < this.bot._extIntentUntil) {
            // ★2026-07-07 让位硬保命 (用户 Q2 "独占但让位硬保命" + 实观 bug: 命令让 LLM 死循环重试
            //   一个做不到的任务(如无树可砍), 独占把求生压住 → bot 掉到 hp=1)。血粮危急时不再让位独占,
            //   放行下面的 surviveNow 救命强派; 非危急才真正独占。硬保命永远高于任何外部命令。
            const _hp = (typeof this.bot.health === 'number') ? this.bot.health : 20;
            const _food = (typeof this.bot.food === 'number') ? this.bot.food : 20;
            if (_hp > 6 && _food > 2) return;   // 非危急 → 外部意图独占, 内核让位
            // 危急(hp<=6 或 food<=2) → 不 return, 继续走 surviveNow 强派救命
        }
        const ms = mentalState(this.bot);
        this._trackAnchor();
        // 0) ★GRAY-ZONE force-commit: 唯一决策人钩子。首飞实录(2026-07-06 00:22): 僵局态
        //    ms.busy 恒 true — hold 类 mode 动作(flee-hold wait(2500) 每 ~6s 一轮)把
        //    actions.executing 占满, 全 busy 闸 = 钩子自噤 = 病灶原样。所以 force 门只认
        //    技能互斥(_currentSkill/supervised_skill, 不打断真技能), 无视 mode 动作;
        //    真·保命地板(vitalNow: 溺水/着火/hp<=4 掉血/岩浆)进行时不抢体。
        // skillBusy 口径(第三实录修订, 孤儿名噤声 9min): _currentSkill 单独在位可能是孤儿
        // (17:02 replenishKit 幽灵名 + 夜宿 hold 的 executing 饿着 busy-stuck 清理器 540s)。
        // 真派发必有 supervised_skill(kernel/ws 同步置), mode 内嵌技能必有 actions.executing —
        // 纯孤儿在 hold 间隙(每 ~6s 有 2.5s+ 空窗)会被 force 逮住, 9min 噤声变秒级。
        const skillBusy = !!((this.agent && this.agent.supervised_skill)
            || (this.bot._currentSkill && this.agent && this.agent.actions && this.agent.actions.executing));
        let vitalBusy = false;
        try { vitalBusy = arbiterVitalNow(this.bot); } catch (e) {}
        // ★危急升级阀 (实录 2026-07-06 01:07: replenishKit 复派楔在夜宿 hold 里占死互斥
        // 17:00→17:07, food=1 全程无门可入, 最后靠骷髅天然死亡完成重置): 危急档灰区
        // (hp<=6 || food<=2) + 互斥被占且当前派发已跑 >=60s + 非恢复族技能 → 每 90s 抬一次
        // interrupt_code 礼貌解卷(kernel 按 interrupt-unwind 不罚), 下一 idle tick force 接管。
        if (skillBusy) {
            try {
                const hpN = (typeof this.bot.health === 'number') ? this.bot.health : 20;
                const foodN = (typeof this.bot.food === 'number') ? this.bot.food : 20;
                const critical = (hpN > 0) && (hpN <= 6 || foodN <= 2)
                    && !(this.bot._diedAt && Date.now() - this.bot._diedAt < 20000);
                const cur = String(this.bot._currentSkill || '');
                const recovery = /feedUp|forage|villageHarvest|wheatFarm|smeltSafe|goBedSleep|escapePlan|surfaceUp|surviveNow/i.test(cur);
                if (critical && !recovery && !this.bot.interrupt_code
                    && Date.now() >= (this.bot._svnCooldownUntil || 0)   // 灰区冷却中解卷=白打断(08:00 实录: 解完没人接, REPLENISH 复派同技能 90s 循环)
                    && Date.now() - (this._lastDispatchAt || 0) > 60000
                    && Date.now() - (this._svnNudgeAt || 0) > 90000) {
                    this._svnNudgeAt = Date.now();
                    this.bot.interrupt_code = true;
                    this.log(`[kernel] ★危急灰区解卷: hp=${Math.round(hpN)} food=${foodN} 互斥被 '${cur || this.agent.supervised_skill}' 占用 — 抬 interrupt 礼貌让位(unwind 不罚), 灰区指挥官下 tick 接管`);
                    try { fs.appendFileSync('bots/_supervisor/progress.txt', `[${new Date().toISOString()}] [kernel] ★危急灰区解卷 hp=${Math.round(hpN)} food=${foodN} cur=${cur || '-'}\n`); } catch (e) {}
                }
            } catch (e) {}
        }
        if (!skillBusy && !vitalBusy) {
            // 连败计数 30min 衰减: 陈年连败不该给全新灰区解锁求死分支(deathEligible exhausted 条款)
            if (this.bot._svnFails && Date.now() - (this.bot._svnLastFailAt || 0) > 1800000) this.bot._svnFails = 0;
            const gz = this._grayZoneSignal();
            if (gz && Date.now() >= (this.bot._svnCooldownUntil || 0)
                && Date.now() - (this._svnLastForceAt || 0) > 2000) {
                this._svnLastForceAt = Date.now();
                return this._commit({
                    chosen: { kind: 'SURVIVE_NOW', skill: 'surviveNow', args: [{ reason: gz }], priority: 200 },
                    reason: `gray-zone force: ${gz}`, freePlay: false,
                }, true);
            }
        }
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

    /** Commit a decision = dispatch its skill (or shadow-log it).
     *  @param {boolean} [force] ★灰区强制派发: 跳过 supervisor-cancel 窗(pin-kick 会盖戳,
     *  否则每次踢完 kernel 哑 30s)/interrupt-hold/仲裁 hold(矩阵行本就让 surviveNow 赢,
     *  跳过是信封保险); 溺水 hold 是保命地板, force 也不跳。 */
    async _commit(decision, force = false) {
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
        if (!force && this.bot._supervisorCancelAt && Date.now() - this.bot._supervisorCancelAt < SUPERVISOR_CANCEL_WINDOW_MS) {
            if (this._cancelHoldAt !== this.bot._supervisorCancelAt) {
                this._cancelHoldAt = this.bot._supervisorCancelAt;
                const left = Math.ceil((this.bot._supervisorCancelAt + SUPERVISOR_CANCEL_WINDOW_MS - Date.now()) / 1000);
                this.log(`[kernel] supervisor-cancel window — holding dispatch ~${left}s (not committing ${p.kind}/${p.skill})`);
            }
            return;
        }
        // ★INTERRUPT-UNWIND HOLD: the previous dispatch just bailed on a live reflex interrupt —
        // re-dispatching immediately lands in the same interrupt (goBedSleep: 3 strikes in 16s).
        // Silent skip (≤13 ticks at 300ms); the unwind itself was logged in _settleDispatch.
        if (!force && this._interruptHoldUntil && Date.now() < this._interruptHoldUntil) return;
        // ★DROWNING HOLD (C345, drowning death 2026-07-02 12:46): the kernel dispatched
        // nightShelter into a bot that was actively sinking — the new skill's pathfinder and
        // the swim rescue then fought over one control channel until the bot died. While the
        // bot is in water with falling air, survival reflexes own the body; tasks can wait
        // the ~10s a rescue takes.
        try {
            const _wp = this.bot.entity.position;
            const _inW = ['water', 'flowing_water'].includes((this.bot.blockAt(_wp) || {}).name)
                || ['water', 'flowing_water'].includes((this.bot.blockAt(_wp.offset(0, 1, 0)) || {}).name);
            if (_inW && this.bot.oxygenLevel !== undefined && this.bot.oxygenLevel <= 15) {
                if (!this._drownHoldLogAt || Date.now() - this._drownHoldLogAt > 10000) {
                    this._drownHoldLogAt = Date.now();
                    this.log(`[kernel] drowning hold — in water, oxygen=${this.bot.oxygenLevel}; not dispatching ${p.kind}/${p.skill} until the rescue surfaces`);
                }
                return;
            }
        } catch (e) {}
        // ★仲裁接入点 B (Phase 1, 签核设计 bots/_supervisor/arbitration-design.md): 派发前
        // 若身体在一个活跃营救反射手里 (self_preservation 的 swim/drowning 营救、mobility
        // 的 march/ENTOMBED dig-out), 先过仲裁 — holder 胜 / pending 则本 tick hold, 与上面
        // 的 supervisor-cancel / interrupt-unwind / drowning hold 家族并列 (drowning hold 是
        // 本机制的特例先行版, 保留不动)。"活跃" = 该 mode 动作正在执行, 或令牌 30s 内新置
        // (防泄漏令牌永久扣押派发)。C345 血案: kernel 把 nightShelter 派进正在下沉的 bot,
        // 新技能的 pathfinder 和 swim 营救抢一条控制通道直到淹死。异常全吞 → 照旧派发。
        try {
            const holder = this.bot._bodyOwner;
            if (!force && holder && holder.kind === 'mode' && /^mode:(self_preservation|mobility)$/.test(holder.name || '')) {
                // ★评审F3: live 加 3min 年龄上限 — death#264 类挂死(runAction 永不 resolve →
                // finally 永不跑 → 令牌永不释放)叠加种子矩阵永久 holder 规则会无限期扣押
                // 全部派发; 挂死营救最多扣 3 分钟, 与 BUSY_STUCK_MS 同一时间尺度。
                const live = !!(this.agent.actions && this.agent.actions.executing
                    && this.agent.actions.currentActionLabel === holder.name)
                    && Date.now() - (holder.since || 0) < 180000;
                const fresh = Date.now() - (holder.since || 0) < 30000;
                if (live || fresh) {
                    const v = arbitrate(holder, { name: `kernel:${p.skill}`, kind: p.kind || 'skill', vital: false },
                        { agent: this.agent, detail: `kernel wants to dispatch ${p.kind}/${p.skill}` });
                    if (v.winner !== 'claimant') {
                        if (!this._arbHoldLogAt || Date.now() - this._arbHoldLogAt > 10000) {
                            this._arbHoldLogAt = Date.now();
                            this.log(`[kernel] arbitration hold — ${holder.name} owns the body (${v.source}); not dispatching ${p.kind}/${p.skill}`);
                        }
                        return;
                    }
                }
            }
        } catch (e) {}
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
        // force 路径只查技能互斥 — mode 动作(hold wait)占着 actions.executing 是灰区常态,
        // 全 busy 复查会把强制派发也噤掉(首飞实录同因)。
        const _busyNow = force
            ? !!((this.agent && this.agent.supervised_skill)
                || (this.bot._currentSkill && this.agent && this.agent.actions && this.agent.actions.executing))
            : mentalState(this.bot).busy;
        if (_busyNow) {
            this.log(`[kernel] dispatch skip: a supervised skill is already running — not committing ${p.skill}`);
            return;
        }
        // Owner-tagged lock (truthy string, same readers as the old `true`): ws_server.runSkill
        // tags 'ws'. Each side releases ONLY its own tag — an unconditional clear here is how a
        // finishing kernel dispatch used to clobber the flag mid-ws-skill, so the next tick saw
        // busy=false and double-dispatched into the running ws probe (pathfinder tug-of-war).
        this.agent.supervised_skill = 'kernel';
        this._lastDispatchAt = Date.now();   // ★危急解卷阀参照: 新派发至少跑 60s 才可被危急灰区打断
        // ★所有权令牌 (伴随 supervised_skill, 同步置 — 反射的仲裁接入点 A 读它认 holder):
        // name 带具体技能名, LLM persist 的规则可以精确到 skill; 矩阵通配 `kernel:*` 兜底。
        setBodyOwner(this.bot, `kernel:${p.skill}`, p.kind || 'skill');
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
            // ★OUTPUT FLUSH (checkpoint #13): skills.log() only appends to bot.output, and the
            // kernel dispatch path never surfaced it anywhere — goBedSleep 3-struck twice with
            // zero visible diagnostics while dutifully logging into the void. Mark the buffer
            // length now, flush the delta to progress.txt after settle. Concurrent mode actions
            // share bot.output (they clear it at action start), so a shrunk buffer → flush from
            // 0; occasional interleave is cosmetic, invisibility was not.
            const outMark = (typeof this.bot.output === 'string') ? this.bot.output.length : 0;
            try {
                res = await skills.customSkill(this.bot, p.skill, ...(p.args || []));
            } catch (e) {
                threw = true;
                this.log(`[kernel] commit error: ${e && e.message || e}`);
            } finally {
                if (this.agent.supervised_skill === 'kernel') this.agent.supervised_skill = false;
                releaseBodyOwner(this.bot, `kernel:${p.skill}`);   // 只释放自己的 (owner-tag)
            }
            try {
                const buf = (typeof this.bot.output === 'string') ? this.bot.output : '';
                const out = buf.slice(outMark <= buf.length ? outMark : 0).trim();
                if (out) fs.appendFileSync('bots/_supervisor/progress.txt',
                    `[${new Date().toISOString()}] [kernel-out ${p.skill}] ${out.replace(/\s*\n+\s*/g, ' | ').slice(0, 1500)}\n`);
            } catch (e) {}
            try { this._settleDispatch(p, snap, res, threw); } catch (e) { this.log(`[kernel] settle error: ${e && e.message || e}`); }
        })();
    }

    /** Post-dispatch accounting (failure strikes / cooldowns / no-delta override) — runs in
     *  the detached dispatch context after the skill settles, NOT on the tick chain. */
    _settleDispatch(p, snap, res, threw) {
        // ── ★SURVIVE_NOW 专用阀 (不参与 3-strike/_kindCooldownUntil/NO-DELTA 常规簿记 —
        //    它不走提案市场, 常规冷却对它无意义且中毒: 危机中被压 5min = 灰区病灶复发)。
        //    零进度 → 升级冷却 60s*2^n 封顶 8min(期间滚动戳 ≤30s 过期, 正常行为接管;
        //    连败计数喂给技能的求死分支门槛); 有进度 → 清计数 + 5s 小憩(给正常派发窗口);
        //    interrupt-unwind → 照常规 4s settle, 不罚。 ──
        if (p.kind === 'SURVIVE_NOW') {
            // noop = 假触发(仅同锚但健康+无威胁): 中性 — 不计连败不升级(技能已重置锚,
            // 5min 内不会再触发); 固定 60s 冷却兜底防抖。
            if (res && typeof res === 'object' && res.noop === true) {
                this.bot._svnCooldownUntil = Date.now() + 60000;
                return;
            }
            const failed = threw || res === false
                || (res && typeof res === 'object' && (res.ok === false || res.failed === true));
            if (failed && this.bot.interrupt_code) {
                this._interruptHoldUntil = Date.now() + INTERRUPT_HOLD_MS;
                this.log(`[kernel] surviveNow interrupt-unwind — 不罚, ${Math.round(INTERRUPT_HOLD_MS / 1000)}s 后再评估`);
            } else if (failed) {
                const n = (this.bot._svnFails || 0) + 1;
                this.bot._svnFails = n;
                this.bot._svnLastFailAt = Date.now();
                const cd = Math.min(SVN_COOLDOWN_CAP_MS, SVN_COOLDOWN_BASE_MS * Math.pow(2, n - 1));
                this.bot._svnCooldownUntil = Date.now() + cd;
                this.log(`[kernel] surviveNow 零进度 x${n} — 灰区专用冷却 ${Math.round(cd / 1000)}s`);
                try { fs.appendFileSync('bots/_supervisor/progress.txt', `[${new Date().toISOString()}] [kernel] ★surviveNow 零进度 x${n} → 冷却 ${Math.round(cd / 1000)}s\n`); } catch (e) {}
            } else {
                this.bot._svnFails = 0;
                this.bot._svnCooldownUntil = Date.now() + 5000;
            }
            return;
        }
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
        // ★INTERRUPT-UNWIND is not a strike either (see constants above): the flag is still set
        // at settle time — nothing clears it between the skill's stop()-poll bail and here
        // (_commit's stale-interrupt hygiene clears it on the NEXT dispatch). `threw` included:
        // a reflex grabbing the pathfinder mid-goToPosition surfaces as GoalChanged in skills
        // that don't catch it — same unwind, different shape.
        const interruptUnwind = failed && !cancelUnwind && this.bot.interrupt_code;
        if (failed && interruptUnwind) {
            const k = p.kind;
            this._interruptHoldUntil = Date.now() + INTERRUPT_HOLD_MS;
            this._interruptUnwinds[k] = (this._interruptUnwinds[k] || 0) + 1;
            if (this._interruptUnwinds[k] >= INTERRUPT_UNWIND_LIMIT) {
                this._interruptUnwinds[k] = 0;
                if (!this.bot._kindCooldownUntil) this.bot._kindCooldownUntil = {};
                this.bot._kindCooldownUntil[k] = Date.now() + DISPATCH_COOLDOWN_MS;
                if (this.bot._commitment && this.bot._commitment.kind === k) this.bot._commitment = null;
                this.log(`[kernel] interrupt-unwind valve: ${k}/${p.skill} interrupted ${INTERRUPT_UNWIND_LIMIT}x consecutively — a reflex is chronic at this task; cooldown + release`);
                try { fs.appendFileSync('bots/_supervisor/progress.txt', `[${new Date().toISOString()}] [kernel] ★interrupt-unwind valve ${k} via ${p.skill}\n`); } catch (e) {}
            } else {
                this.log(`[kernel] interrupt-unwind: ${k}/${p.skill} bailed on a live reflex interrupt (${this._interruptUnwinds[k]}x) — not a strike; holding dispatch ${Math.round(INTERRUPT_HOLD_MS / 1000)}s`);
            }
        } else if (failed && !cancelUnwind) {
            const k = p.kind;
            this._interruptUnwinds[k] = 0;   // genuine failure breaks the "consecutive" chain
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
            this._interruptUnwinds[p.kind] = 0;
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
