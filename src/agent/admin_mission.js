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
 * 红线遵循: 无模块级可变状态(_epoch/_lastBanner 挂实例); telemetry/banner 全 try/catch, 绝不伤 agent。
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
        this._epoch = 0;                        // generation counter — supersede token; bumped on each new handoff
        this._lastBanner = { text: '', at: 0 }; // anti-reflexive self-chat guard
        this._lastProgressCheckAt = 0;
        this._lastProgressSig = '';
        // ★2026-07-14 节流 (用户令, 当日二版): 只防"打断执行中任务", 不防重跑 —— ①RUNNING 同文无视;
        //   ②RUNNING 且 ws 来源非同文 → agent LLM 判官判同一意图则无视; ③无任务在跑一律放行 (哪怕与
        //   上一轮完全相同), 无状态、不排队、不记历史指纹。被无视的回"收到"帧, 不打断当前任务。
        this._dupKey = '';                                        // 正被保护的 RUNNING 任务指纹 (计数键)
        this._dupCount = 0;                                       // 该任务累计吞掉的重复消息数 (回执 nag 用)
        this._dupBannerAt = 0;
        this._judgeCache = { mKey: '', nKey: '', verdict: '' };   // (任务,消息) 判官缓存 — 同一对刷屏只烧一次 LLM
        this._submitChain = Promise.resolve();                    // submit 到达序串行链 (判官 await 不乱序); drive 不入链
        this._judgeEnabled = process.env.MC_ADMIN_DUP_LLM !== '0';
        const jt = parseInt(process.env.MC_ADMIN_DUP_LLM_TIMEOUT_MS, 10);
        this._judgeTimeoutMs = (Number.isFinite(jt) && jt > 0) ? jt : 8000;

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

    // ── the recurring self-prompt goal, wrapped with the EXCLUSIVE-mission rule ──────────────────
    // ★2026-07-08 用户令 (admin 意志 = 独占 / 绝对 · 饥饿退环境): the deterministic freezes (kernel
    //   blueprint freeze @ _survivalTick, execute() 非致命本能冻结) stop the SYSTEM from hijacking the
    //   body. This closes the LAST leak — the agent LLM SPONTANEOUSLY issuing !getFood / side-tasks
    //   (repro 2026-07-08 05:02: mid "砍最近的树", food dipped → LLM self-prompted "!getFood(14)" → feedUp
    //   chased sheep/cow). self_prompter drives the LLM with "goal: '<prompt>'" (self_prompter.js:78),
    //   so prepending a firm rule to that goal makes the agent itself stay on-task. mine.text stays the
    //   canonical identity/telemetry string (banners / beginMissionTask / anti-reflexive guard); only
    //   the self-prompt LOOP sees this wrapped prompt.
    _loopPrompt(text) {
        const RULE = '[任务铁律] 你正在执行管理员下达的指令，这是【最高优先级、独占】的任务，专注把它做完。'
            + '只有三种情况才停止：(1)任务已完成 → !endGoal；(2)确实无法完成（例如所需资源根本不存在或到不了）'
            + ' → !cannotComplete("简短原因")；(3)遇到致命危险（溺水/着火/岩浆/濒死）。期间【不要】为饥饿或进食'
            + '分心（本版本饥饿已停用，系统会在需要时自动从背包进食）；【不要】顺手去备战下界、挖矿、找村庄、'
            + '睡觉等自主目标——它们已被系统冻结、与本任务无关。任务：';
        return RULE + String(text == null ? '' : text);
    }

    // ── entry: a new admin command ─────────────────────────────────────────────
    // Submits are SERIALIZED through _submitChain — the async LLM intent-judge would otherwise let
    // two racing frames interleave/judge against a stale mission. The chain covers only the CHEAP
    // phase (throttle + synchronous handoff); the long drive runs OUTSIDE it, so a LATER submit can
    // still preempt a mid-drive mission instead of queueing behind its initial turn.
    // Chain-jam watchdog: a single stuck link (e.g. a bare !endGoal turn whose handleMessage never
    // resolves) must not brick every future admin command — after 120s the chain moves on and the
    // stuck submit keeps running detached. Safe: the only unbounded await in _submit is the
    // lifecycle branch, which never installs a mission, so a detached link can't stomp a newer one.
    submit(input) {
        const link = () => {
            let timer = null;
            const guard = new Promise(resolve => {
                timer = setTimeout(() => {
                    console.error('[adminMission] submit-chain watchdog: link stuck >120s, releasing chain');
                    resolve();
                }, 120000);
            });
            const run = Promise.resolve()
                .then(() => this._submit(input || {}))
                .catch(e => console.error('[adminMission] submit error:', e && e.message || e))
                .finally(() => { if (timer) clearTimeout(timer); });
            return Promise.race([run, guard]);
        };
        this._submitChain = this._submitChain.then(link);
        return this._submitChain;
    }

    async _submit({ text, taskId, origin }) {
        try {
            text = String(text == null ? '' : text).replace(/\s+$/,'').trim();
            if (!text) {
                // ★2026-07-14 契约补齐: 空/纯空白 ws task 仍带 task_id — 回执一帧, 否则插件挂到自身 task_timeout
                //   再重发 (对齐 _registerDrop 建立的"绝不静默丢 ws task_id"契约)。chat 来源无 task_id, 无需回执。
                if (origin === 'ws' && typeof taskId === 'string' && taskId) {
                    try { wsServer.ackDuplicateTask(taskId, '收到，但指令为空，已忽略。'); } catch (e) {}
                }
                return;
            }
            // Bare lifecycle command typed by admin → drive the FSM via its perform() hook, no new mission.
            if (/^!(endGoal|cannotComplete|goal)\b/i.test(text)) {
                this.turnManaged = true;
                try { await this.agent.handleMessage('admin', text); }
                finally { this.turnManaged = false; }
                // ★2026-07-14 契约补齐: 裸生命周期命令的尾帧带的是被结束 mission 的 task_id, 不是本 ws 帧的 —
                //   给本帧的 task_id 单独回执, 免插件把它挂到 task_timeout (对齐"绝不静默丢 ws task_id"契约)。
                if (origin === 'ws' && typeof taskId === 'string' && taskId) {
                    try { wsServer.ackDuplicateTask(taskId, '收到，生命周期指令已执行。'); } catch (e) {}
                }
                return;
            }
            // Anti-reflexive guard: never spawn a mission from the bot's own leaked banner/status chat.
            if (this._isReflexive(text, origin)) {
                console.log(`[adminMission] ignored reflexive self-chat: ${text.slice(0, 60)}`);
                return;
            }
            // ★2026-07-14 节流 (用户令, 当日二版): 只拦"会打断执行中任务"的重复, 空闲时一律放行。
            //   ① RUNNING 且同文 → 无视 (旧行为是硬 supersede: 撕掉执行中的任务从头再来, 0714 炼铜
            //      实录里插件端 task_timeout 一到就重发, 长任务永远跑不完);
            //   ② RUNNING 且 ws 来源非同文 → agent LLM 判官判"同一意图/会产生相同动作" (换措辞重发、
            //      催促、问进度全算), SAME → 无视不打断。判官超时/出错/关闭(MC_ADMIN_DUP_LLM=0) 一律
            //      按 DIFFERENT 放行 supersede, 绝不拦真指令。游戏内 chat 不走判官: 真人换措辞 = 有意
            //      强制重跑, 必须放行 (同文仍被 ① 拦)。
            //   ③ 不在 RUNNING (空闲/刚结束) → 不节流, 与上一轮同文也正常执行 —— 无状态、不排队、
            //      不记历史指纹 (旧版"结束后 TTL 内同文无视"按用户令拆除)。
            //   被无视的都回 task_finished(status='duplicate') "收到"帧 (静默丢帧会让插件挂到自身
            //   超时, 反而催它重发), 游戏内出 🔁 banner (10s 内不重复刷)。
            if (this._throttleExact(text, taskId, origin)) return;
            // ★2026-07-14 用户令: in-game chat 任务执行期间, 静默拒绝 ws 侧新 admin LLM 请求 + 回执当前任务
            //   (游戏内玩家指令神圣 = 独占, 不被 ws 侧自主 LLM 打断)。排在 supersede 前。
            if (this._rejectWsDuringChat(text, taskId, origin)) return;
            if (await this._throttleSameIntent(text, taskId, origin)) return;
            // Synchronous handoff installs the new mission (superseding any old one atomically); the
            // UNLOCKED drive runs outside the submit chain so a later submit can preempt it mid-flight.
            const mine = this._handoff({ text, taskId: (typeof taskId === 'string' && taskId) ? taskId : null, origin: origin || 'ws' });
            this._drive(mine).catch(e => console.error('[adminMission] drive error:', e && e.message || e));
        } catch (e) {
            console.error('[adminMission] submit error:', e && e.message || e);
        }
    }

    _isReflexive(text, origin) {
        // ws frames are external (never the bot's own chat) → never reflexive.
        if (origin === 'ws') return false;
        try {
            const now = Date.now();
            if (this._lastBanner.text && now - this._lastBanner.at < 5000) {
                const b = this._lastBanner.text;
                if (text === b || text.includes(b) || b.includes(text)) return true;
            }
            if (this.mission && this.mission.text && text === this.mission.text && this.state === RUNNING
                && now - this.mission.startedAt < 5000) return true;
            // our own emitted chat: banners (🎯/✅/🔄/⚠️/⏱/⛔/🔁), NL status (🤖/🎯[按指令]), mirror (◀/▶), inv (📦)
            if (/^(🎯|✅|🔄|⚠️|⏱|⛔|🤖|◀|▶|📦|🔁)/.test(text)) return true;
        } catch (e) {}
        return false;
    }

    // ── duplicate-command throttle (★2026-07-14 用户令, 当日二版) ────────────────────────────────
    _normText(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

    // ① 精确判同: RUNNING 且 whitespace-normalize 后与执行中任务同文 → 丢弃。返回 true = 丢弃。
    _throttleExact(text, taskId, origin) {
        try {
            if (this.state !== RUNNING || !this.mission) return false;
            const mKey = this._normText(this.mission.text);
            if (this._normText(text) !== mKey) return false;
            const sec = Math.max(1, Math.round((Date.now() - this.mission.startedAt) / 1000));
            this._registerDrop(mKey, text, taskId, origin,
                `收到。相同指令已在执行中（已运行${sec}秒），继续当前任务、不重新开始；完成或失败会另行报告，请勿重发。`);
            return true;
        } catch (e) {
            return false;   // 节流器自身出错绝不拦真指令
        }
    }

    // ★2026-07-14 用户令: in-game chat 任务执行期间, ws 侧新 admin LLM 请求一律静默拒绝(不 supersede),
    //   并经 _registerDrop → wsServer.ackDuplicateTask 回执告知 ws 当前正在执行的任务。
    //   真人游戏内 chat 换指令(origin==='chat')不受此门, 仍可打断自己的 chat 任务。
    //   放在 _throttleSameIntent 之前: chat 任务保护优先于 LLM 判官 — 省判官调用, 且在 _handoff supersede 前拦截。
    _rejectWsDuringChat(text, taskId, origin) {
        try {
            if (origin !== 'ws') return false;
            if (this.state !== RUNNING || !this.mission || this.mission.origin !== 'chat') return false;
            const sec = Math.max(1, Math.round((Date.now() - this.mission.startedAt) / 1000));
            let act = '';
            try {
                const b = this._bot();
                act = String((b && b._currentSkill) || (this.agent.actions && this.agent.actions.currentActionLabel) || '')
                    .replace(/\s+/g, ' ').trim().slice(0, 120);
            } catch (e) {}
            this._registerDrop(this._normText(this.mission.text), text, taskId, origin,
                `机器人正在执行玩家在游戏内下达的指令「${this.mission.text}」（已运行${sec}秒${act ? `，当前动作：${act}` : ''}），此为独占任务，暂不接受新的管理指令，请等待其完成或失败报告。`);
            return true;
        } catch (e) {
            return false;   // 门自身出错绝不误拦真指令
        }
    }

    // ② 语义判同 (仅 ws 来源): RUNNING 中收到非同文消息 → agent LLM 判官判是否同一意图。返回 true = 丢弃。
    //   判官 await 期间 submit 链保证没有并发提交; 任务若在此期间自然结束/换代 → 无"执行中"可保护 → 放行。
    async _throttleSameIntent(text, taskId, origin) {
        try {
            if (!this._judgeEnabled || origin === 'chat') return false;
            if (this.state !== RUNNING || !this.mission) return false;
            const m0 = this.mission;
            const mKey = this._normText(m0.text);
            const nKey = this._normText(text);
            let verdict;
            if (this._judgeCache.mKey === mKey && this._judgeCache.nKey === nKey) {
                verdict = this._judgeCache.verdict;   // 同一对刷屏只烧一次 LLM
            } else {
                verdict = await this._judgeSameIntent(m0, text);
                this._judgeCache = { mKey, nKey, verdict };
            }
            if (this.state !== RUNNING || this.mission !== m0) return false;   // 用户令③: 没在跑就放行
            if (verdict !== 'SAME') return false;
            const sec = Math.max(1, Math.round((Date.now() - m0.startedAt) / 1000));
            this._registerDrop(mKey, text, taskId, origin,
                `收到。该消息与正在执行的任务是同一件事（已运行${sec}秒），继续当前任务、不打断；完成或失败会另行报告，请勿重发。`);
            return true;
        } catch (e) {
            return false;   // 节流器自身出错绝不拦真指令
        }
    }

    // 判官: 问 agent LLM 新消息 B 与执行中任务 A 是否同一意图 (含"执行 B 会产生与当前相同的动作")。
    // 拿不准/超时/出错一律 DIFFERENT (fail-open) — 宁可多打断一次, 不吞真指令 (admin 意志绝对)。
    async _judgeSameIntent(m0, newText) {
        const sec = Math.max(1, Math.round((Date.now() - m0.startedAt) / 1000));
        let act = '';
        try {
            const b = this._bot();
            act = String((b && b._currentSkill) || (this.agent.actions && this.agent.actions.currentActionLabel) || '')
                .replace(/\s+/g, ' ').trim().slice(0, 120);
        } catch (e) {}
        const prompt = '你是Minecraft机器人的任务去重判定器。机器人正在执行管理员任务A，此刻又收到新消息B。\n'
            + `任务A（执行中，已运行${sec}秒）：${m0.text}\n`
            + (act ? `机器人当前正在执行的动作：${act}\n` : '')
            + `新消息B：${String(newText == null ? '' : newText)}\n`
            + '判定规则：如果B与A是同一个任务（换了措辞的重发、催促、询问进度，或执行B会产生与当前完全相同的动作），回答 SAME。'
            + '如果B是实质不同的新任务、或明确要求停止/更改当前行为，回答 DIFFERENT。拿不准时回答 DIFFERENT。\n'
            + '只回答一个单词：SAME 或 DIFFERENT。';
        let timer = null;
        try {
            const res = await Promise.race([
                this.agent.prompter.chat_model.sendRequest([], prompt),
                new Promise(resolve => { timer = setTimeout(() => resolve('__JUDGE_TIMEOUT__'), this._judgeTimeoutMs); }),
            ]);
            if (res === '__JUDGE_TIMEOUT__') {
                console.log(`[adminMission] intent-judge timeout(${this._judgeTimeoutMs}ms) → DIFFERENT (fail-open)`);
                return 'DIFFERENT';
            }
            let out = String(res == null ? '' : res);
            if (out.includes('</think>')) out = out.split('</think>').pop();   // reasoning 模型剥壳 (对齐 promptConvo)
            const up = out.toUpperCase();
            const verdict = (/\bSAME\b/.test(up) && !/\bDIFFERENT\b/.test(up)) ? 'SAME' : 'DIFFERENT';
            console.log(`[adminMission] intent-judge=${verdict} raw="${out.trim().slice(0, 60)}" B="${String(newText).slice(0, 60)}"`);
            return verdict;
        } catch (e) {
            console.log('[adminMission] intent-judge error → DIFFERENT (fail-open):', e && e.message || e);
            return 'DIFFERENT';
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    // 丢弃簿记: 计数按被保护的 RUNNING 任务 (missionKey) 记 — 刷屏方换措辞也累计; 回执 + 🔁 banner。
    _registerDrop(missionKey, droppedText, taskId, origin, why) {
        this._dupCount = (this._dupKey === missionKey) ? this._dupCount + 1 : 1;
        this._dupKey = missionKey;
        console.log(`[adminMission] throttled duplicate #${this._dupCount} (${origin || 'ws'}) task_id=${taskId || '-'}: ${this._normText(droppedText).slice(0, 80)}`);
        const now = Date.now();
        if (now - this._dupBannerAt > 10000) {
            this._dupBannerAt = now;
            this._emitBanner('🔁 ' + why);
        }
        if (origin !== 'chat') {
            const nag = this._dupCount >= 3 ? `（已连续忽略${this._dupCount}条重复消息，请停止重发，等待完成报告即可。）` : '';
            try { wsServer.ackDuplicateTask(taskId, why + nag); } catch (e) {}
        }
    }

    // ── install a mission (SYNCHRONOUS handoff — no await anywhere; atomic on the JS thread) ───────
    _handoff(mine0) {
        const now = Date.now();
        const mine = { text: mine0.text, taskId: mine0.taskId, origin: mine0.origin,
            startedAt: now, deadlineAt: now + this._maxMs, deaths: 0 };
        mine.prompt = this._loopPrompt(mine.text);   // ★admin 独占铁律包裹的自驱 goal (见 _loopPrompt)
        // Supersede any running mission FIRST — fires the OLD taskId exactly once. keepLoop so the OLD
        // end() does NOT tear down the shared loop the incoming mission is about to own.
        if (this.state === RUNNING) this.end('superseded', 'new task', { keepLoop: true });
        this._epoch++;                                   // bump generation → breaks any in-flight OLD turn via checkInterrupt
        // Wrest the body BEFORE any await (fixes the override handoff stall).
        try { this.agent.requestInterrupt(); } catch (e) {}
        // ★admin 独占硬抢占 (2026-07-08 用户令 #1): 冻结内核【新提案】不够 — boot 时 commitGoal 已 commit 的
        //   BOOTSTRAP_KIT/prepNether 是 sticky 的, 会在 mission turn 间隙/结束后复活抢身体 (实证: "砍树"期间
        //   getWood 站在可达树旁, 内核 committed prepNether 却把 bot 拽向够不到的地下工作台 → 摔坑 + 左右横跳)。
        //   同步丢弃 bot._commitment → 内核既不复派该蓝图、mission 结束后也重新 propose 干净选择; 一并清 prepNether
        //   的工作台恢复闸旗标 (免残留拽拉)。commitGoal 在 admin 冻结期不会跑, 故清一次即锁死为 null。
        try { const b = this._bot(); if (b) { b._commitment = null; b._prepTableRecoveryBlockedUntil = 0; } } catch (e) {}

        this.mission = mine;
        this.state = RUNNING;
        // 新任务上位 → 上一任务的重复计数/判官缓存全部作废 (节流是无状态的, 只保护"正在执行的这一个")。
        this._dupKey = ''; this._dupCount = 0;
        this._judgeCache = { mKey: '', nKey: '', verdict: '' };
        this._syncMirror();
        try { const b = this._bot(); if (b) b._extIntentUntil = now + MISSION_EXTINTENT_MS; } catch (e) {}
        try { wsServer.beginMissionTask(mine.text, mine.taskId, mine.origin); } catch (e) {}
        this._emitBanner('🎯 开始执行指令：' + mine.text.replace(/\n/g, ' ').slice(0, 80));
        console.log(`[adminMission] BEGIN (${mine.origin}) task_id=${mine.taskId || '-'}: ${mine.text.slice(0, 80)}`);
        return mine;
    }

    // ── the UNLOCKED long phase (a later submit can preempt this mid-flight) ───────────────────────
    async _drive(mine) {
        // Fix H4: force the OLD skill to release the body before we run the initial turn.
        try { await this._preemptBody(2000); } catch (e) {}
        // Ensure the shared self_prompter is fully down before we take it over (parity with old begin).
        try { await this.agent.self_prompter.stop(false); } catch (e) {}

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
        // already !endGoal'd a trivial task inside the initial turn → state IDLE → don't restart; or a
        // later submit may have superseded it → this.mission !== mine → don't restart).
        if (this.state === RUNNING && this.mission === mine) {
            try {
                this.agent.self_prompter.owner = this;
                this.agent.self_prompter.start(mine.prompt || mine.text);
            } catch (e) { console.error('[adminMission] self_prompter.start error:', e && e.message || e); }
        }
    }

    // ── force the currently-running skill to release the body (mirror ws_server._preemptForExternal) ─
    async _preemptBody(maxMs) {
        const deadline = Date.now() + (maxMs || 2000);
        while (Date.now() < deadline) {
            const b = this._bot();
            if (!this.agent.supervised_skill && !(b && b._currentSkill)) break;
            try { this.agent.requestInterrupt(); } catch (e) {}
            await new Promise(r => setTimeout(r, 150));
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

        // Roll extIntent while the mission is genuinely WORKING — either the self-prompt loop is
        // ACTIVE, or a supervised skill owns the body (mineOres/replenishKit/chopWood run for
        // minutes with the prompter PAUSED/parked, so gating on isActive() alone let the 5-min
        // window silently expire mid-skill → kernel un-froze → autonomous REPLENISH_KIT劫走任务;
        // 2026-07-09 实证 18:09 `🤖[自主]REPLENISH_KIT`). A conversation-paused mission with NO skill
        // running is still (rightly) NOT refreshed — paused-chat ≠ working, survival un-muzzles.
        if (this.agent.self_prompter.isActive() || this.agent.supervised_skill || bot._currentSkill) {
            try { bot._extIntentUntil = now + MISSION_EXTINTENT_MS; } catch (e) {}
        }

        // Re-arm if an external stop() left the loop STOPPED (recover from run_skill's stop(false),
        // a leaked reflex stop, etc.) — but NOT while a supervised skill owns the body, and not in
        // the brief post-death settle window.
        if (!this.agent.supervised_skill && this.agent.self_prompter.isStopped()
            && !(bot._diedAt && now - bot._diedAt < 4000)) {
            try {
                this.agent.self_prompter.owner = this;
                this.agent.self_prompter.start(m.prompt || m.text);
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
        // !endGoal/!cannotComplete already ended it — OR a supersede swapped in a NEW mission during the
        // await (this.mission !== m). Re-check identity like _throttleSameIntent(l.235)/_drive(l.354) do,
        // else the stale-captured m's branches fire on the wrong mission (end the brand-new task as
        // 'no-progress', or self_prompter.start the OLD goal onto the live loop). ★2026-07-14 review.
        if (this.state !== RUNNING || this.mission !== m) return;
        if (used) {
            // A command ran → keep going.
            try { this.agent.self_prompter.owner = this; this.agent.self_prompter.start(m.prompt || m.text); } catch (e) {}
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
                this.agent.self_prompter.start(this.mission.prompt || this.mission.text);
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
    async end(reason, detail, opts = {}) {
        if (this.state !== RUNNING) return;   // first cause wins; any racing second cause no-ops
        this.state = ENDING;
        const m = this.mission;
        // Stop the loop from firing one more stray turn (interrupt is synchronous).
        try { this.agent.self_prompter.owner = null; } catch (e) {}
        try { this.agent.self_prompter.interrupt = true; } catch (e) {}
        try { const b = this._bot(); if (b) b._extIntentUntil = 0; } catch (e) {}
        // ★2026-07-09 用户令: admin 任务收尾 → 让 kernel 静默 20s 不 propose 自主任务 (免得刚做完
        //   立刻自己找活乱跑)。kernel._survivalTick step 3 读此戳。superseded 不打: 新任务马上接管,
        //   等它自己收尾时会重打; 硬保命/灰区求生仍走各自的闸, 不受此戳影响。
        try { if (reason !== 'superseded') { const b2 = this._bot(); if (b2) b2._proposePauseUntil = Date.now() + 20000; } } catch (e) {}

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

        // ★2026-07-14 节流 (当日二版): 刻意【不】记结束任务的指纹 —— 用户令③: 没有执行中任务时,
        //   哪怕与上一轮同文也正常执行 (无状态节流只保护 RUNNING 中的任务, 不防重跑)。

        this.mission = null;
        this.state = IDLE;
        this._syncMirror();
        // Fully unwind the loop + stop actions (async; safe after the frame). During a supersede the
        // incoming handoff owns loop teardown — the OLD end() must NOT run its own (up to 15s)
        // actions.stop()/loop teardown, which could later stomp the NEW mission's freshly-started loop.
        if (!opts.keepLoop) { try { await this.agent.self_prompter.stop(true); } catch (e) {} }
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
