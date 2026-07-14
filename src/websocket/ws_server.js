import { WebSocketServer } from 'ws';
import fs from 'fs';
import { serverProxy } from '../agent/mindserver_proxy.js';

// ─────────────────────────────────────────────────────────────────────────────
// ★2026-07-07 外部 LLM 双向集成 — 出口: 15s 中文自然语言汇报 (bot_status_nl)。
//   映射表把「机器字段」翻成人话。KIND = kernel 提案目标语义 (bot._commitment.kind,
//   比 skill 名更能说明"在干嘛"); SKILL = 当前叶子技能 (bot._currentSkill, 更即时);
//   umbrella 技能 (prepNether/missionNether/…) 故意不进 SKILL 表 → 回落 KIND 表,
//   免得又汇报成用户嫌弃的 "prepNether" 废话。MOB = 近敌中文名。
// ─────────────────────────────────────────────────────────────────────────────
const STATUS_MOB_CN = {
    zombie: '僵尸', husk: '尸壳', zombie_villager: '僵尸村民', drowned: '溺尸',
    skeleton: '骷髅', stray: '流浪者', bogged: '沼骸', creeper: '苦力怕',
    spider: '蜘蛛', cave_spider: '洞穴蜘蛛', enderman: '末影人', witch: '女巫',
    phantom: '幻翼', slime: '史莱姆', pillager: '掠夺者', vindicator: '卫道士',
    evoker: '唤魔者', ravager: '劫掠兽', vex: '恼鬼', breeze: '旋风人',
    blaze: '烈焰人', ghast: '恶魂', magma_cube: '岩浆怪', piglin: '猪灵',
    piglin_brute: '猪灵蛮兵', hoglin: '疣猪兽', zoglin: '僵尸疣猪兽',
    wither_skeleton: '凋灵骷髅', silverfish: '蠹虫', endermite: '末影螨',
    warden: '监守者', shulker: '潜影贝', guardian: '守卫者', elder_guardian: '远古守卫者',
};
// ★KIND → 目标短语("在做什么"的目标, 非动作断言)。真·物理动作(挖/打/走/睡)由 _statusNL 从 live
//   bot 态(targetDigBlock/pvp.target/isMoving/isSleeping)取, 这里只作上下文/idle 兜底 —— 修
//   "说挖坑封顶实际没干"(封箱已禁用)那类失真: 描述实际动作, 不再断言 skill 名对应的假动作。
const STATUS_KIND_CN = {
    BOOTSTRAP_KIT: '凑基础装备', STONE_KIT_READY: '补石器工具', REPLENISH_KIT: '补木料和镐',
    TOOL_UPKEEP: '修补工具', GET_FOOD: '找吃的', FORAGE_SURFACE: '地面觅食',
    VILLAGE_HARVEST: '收小麦', OPP_WHEAT_FARM: '打理麦田', OPP_HUNT_ANIMAL: '打猎',
    OPENING_VILLAGE: '搜刮村庄', OPP_SEIZE_VILLAGE: '搜刮村庄', OPENING_SCOUT: '侦查周边',
    OPP_TRADER_LEAD: '找流浪商人', OPP_MINE_VEIN_ORE: '采矿脉', GET_ARMOR: '做护甲',
    GET_IRON_ARMOR_SET: '凑整套铁甲', GET_DIAMOND_ARMOR: '做钻石甲', GET_IRON_TOOLS: '做铁工具',
    GET_BED: '弄张床', GO_BED: '睡觉过夜', DUSK_GO_BED: '睡觉过夜',
    GO_UNDERGROUND: '下矿找铁/煤', DUSK_MINE_NIGHT: '挖矿过夜', MINE_THROUGH_NIGHT: '挖矿过夜',
    NIGHT_SMELT_IRON: '炼铁', SMELT_IRON: '炼铁', GET_DIAMOND: '找钻石', GET_DIAMOND_GEAR: '做钻石装备',
    MIGRATE: '换个地方', BANK_GEAR: '整理装备', BUILD_HOME: '盖据点',
    GET_PORTAL_KIT: '备下界门材料', ENTER_NETHER: '搭下界门', GET_BLAZE_RODS: '打烈焰人拿棒',
    HUNT_PEARLS: '找末影珍珠', CRAFT_EYES: '合成末影之眼', GO_END: '去末地',
    SEAL_FORT: '清要塞', SLAY_DRAGON: '打末影龙',
    NIGHT_SEAL: '躲夜等天亮', NIGHT_DIG_ONE: '躲夜等天亮', SURVIVAL_NIGHT: '躲夜等天亮',
    SURFACE_RESCUE: '自救上浮', FREE_PLAY: '自由探索',
};
// 叶子 SKILL → 目标短语 (kind 为空时兜底)。umbrella 技能不列。
const STATUS_SKILL_CN = {
    chopWood: '找木头', collectBlock: '采集方块', mineOres: '挖矿', mineDown: '下挖',
    branchMine: '分支挖矿', feedUp: '找吃的', forage: '觅食', villageHarvest: '收小麦',
    wheatFarm: '打理麦田', smeltSafe: '冶炼', smelt: '冶炼', goBedSleep: '睡觉过夜',
    nightShelter: '躲夜等天亮', surfaceUp: '上地面', escapePlan: '脱困', moveAway: '避开',
    craftPickaxe: '做镐', replenishKit: '补料补镐',
};
// dig 目标方块 → 中文 (用于"在挖X")。ore/log 走正则族, 其余给通名。
function blockCN(name) {
    const n = String(name || '');
    if (/diamond_ore/.test(n)) return '钻石矿';
    if (/iron_ore/.test(n)) return '铁矿';
    if (/coal_ore/.test(n)) return '煤矿';
    if (/gold_ore/.test(n)) return '金矿';
    if (/copper_ore/.test(n)) return '铜矿';
    if (/redstone_ore/.test(n)) return '红石矿';
    if (/lapis_ore/.test(n)) return '青金石矿';
    if (/emerald_ore/.test(n)) return '绿宝石矿';
    if (/(_log|_wood|_stem)$/.test(n)) return '树';
    if (/leaves/.test(n)) return '树叶';
    if (/deepslate$|deepslate_/.test(n)) return '深板岩';
    if (/cobblestone/.test(n)) return '圆石';
    if (/^stone$|andesite|diorite|granite|tuff|calcite/.test(n)) return '石头';
    if (/dirt|grass_block|mud|podzol|coarse/.test(n)) return '泥土';
    if (/gravel/.test(n)) return '沙砾';
    if (/sand/.test(n)) return '沙子';
    if (/obsidian/.test(n)) return '黑曜石';
    if (/netherrack/.test(n)) return '下界岩';
    if (/water/.test(n)) return '水';
    if (/wheat|carrot|potato|beetroot|melon|pumpkin|crop/.test(n)) return '庄稼';
    return name ? '方块' : '';
}
// NOTE (local deploy): `Camera` (camera.js) import removed — it was never used here
// (the screenshot path uses the lazily-loaded CameraProc), and statically importing
// camera.js pulls in node-canvas-webgl + prismarine-viewer + headless-gl, whose
// require/import mix crashes Node's ESM/CJS loader (ERR_INTERNAL_ASSERTION) at startup.
// CameraProc runs the fragile headless-gl renderer in an ISOLATED child process so
// its intermittent NATIVE crash (Windows exit -1 / 4294967295, uncatchable by JS)
// kills only the renderer worker, not the agent. See camera_proc.js / render_worker.mjs.
// NOTE (local deploy): CameraProc is lazy-loaded (dynamic import) inside the
// screenshot-enabled gate below, NOT statically imported here. Importing
// camera_proc.js at module load pulls in prismarine-viewer + headless-gl, whose
// require/import mix crashes Node's ESM/CJS loader (ERR_INTERNAL_ASSERTION) at
// startup. With screenshots off (default) the chain is never loaded.

class WSMessageServer {
    constructor(port = 48909) {
        this.port = port;
        this.wss = null;
        this.clients = new Set();
        this.agent = null;
        this.camera = null;
        this.screenshotInterval = null;
        this.screenshotInProgress = false; // Prevent concurrent screenshots
        this.currentTask = null;
        this.taskStartTime = null;
        this.taskCompleted = false; // Track task completion status
        this.lastTaskCompletionTime = null; // Track when task was completed
        this.nanWarningLogged = false; // Track if NaN warning has been logged
    }

    start() {
        this.wss = new WebSocketServer({ port: this.port, host: '0.0.0.0' });

        console.log(`WebSocket server started on ws://0.0.0.0:${this.port}`);

        this.wss.on('connection', (ws) => {
            console.log('WebSocket client connected');
            this.clients.add(ws);

            // Send welcome message
            ws.send(JSON.stringify({
                type: 'connected',
                message: 'Connected to Mindcraft WebSocket interface'
            }));

            // Check if there's a completed task that needs to be reported
            this.handleReconnection(ws);

            // Send current inventory if agent is online
            this.sendInitialInventory(ws);

            // ★2026-07-07 用户令: 给刚连上的客户端补发一帧"当前状态人话" (bot_status_nl)。
            //   周期 timer 只在状态"变化"时广播(全局 dedup _lastNLText), 所以一个在稳态中途接入的
            //   外部 LLM 本来会一直收不到"当前在干嘛", 直到状态下次变 —— 稳态下可能好几分钟空白。
            //   这里对这个新连接单独绕过 dedup 发一帧当前态(不写 _lastNLText、不镜像游戏聊天)。
            this._sendCurrentStatusNL(ws);

            ws.on('message', (data) => {
                try {
                    this.handleMessage(JSON.parse(data.toString()));
                } catch (error) {
                    console.error('Error parsing WebSocket message:', error);
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Invalid JSON format'
                    }));
                }
            });

            ws.on('close', () => {
                console.log('WebSocket client disconnected');
                this.clients.delete(ws);
            });

            ws.on('error', (error) => {
                console.error('WebSocket error:', error);
                this.clients.delete(ws);
            });
        });
    }

    setAgent(agent) {
        this.agent = agent;
        console.log(`WebSocket server connected to agent: ${agent.name}`);

        // Reset NaN warning flag when agent reconnects
        this.nanWarningLogged = false;
        this.nanErrorCount = 0;

        // Wait for bot to be properly spawned before initializing camera
        this.waitForBotSpawn(agent);

        // Periodic hard-state telemetry for the OS-level watchdog. The watchdog's old
        // signals (file mtimes, port liveness) all said "alive" while the bot was stuck
        // in a 2.5h task-level loop — only pos/inventory/skill HARD metrics can expose
        // "process alive but task dead". Broadcast every 15s; the bridge persists the
        // latest snapshot to vitals.json for the watchdog/patrol to read.
        this.startVitalsTimer();
        this.startStatusNLTimer();
    }

    // ★2026-07-07 用户令 (取代原来每 5s 的 [dbg] 刷屏): 把"经 WS 与外部 LLM 往来的消息"(仅文本)
    //   同步到游戏聊天, 方便肉眼 debug —— 出口=每条 bot_status_nl 的中文人话(startStatusNLTimer 调用),
    //   入口=收到的外部指令 task/run_skill/cancel(handleMessage 调用)。不再周期性刷原始字段。
    //   env DEBUG_CHAT=0 整体关闭。MC chat 单条上限 256, 超长截断; 全 try/catch, 聊天镜像绝不伤 agent。
    _chatToMC(text) {
        if (String(process.env.DEBUG_CHAT || '1') === '0') return;
        try {
            const bot = this.agent && this.agent.bot;
            if (!bot || typeof bot.chat !== 'function' || !bot.entity) return;
            let s = String(text == null ? '' : text).replace(/[\r\n]+/g, ' ').trim();
            if (!s) return;
            if (s.length > 250) s = s.slice(0, 247) + '...';
            bot.chat(s);
        } catch (e) { /* chat mirror must never hurt the agent */ }
    }

    // ★2026-07-07 外部 LLM 集成 — 出口: 每 15s 广播一条中文自然语言状态 (bot_status_nl)。
    //   与 vitals(硬字段, 同 15s) 并行, 专给外部 LLM 读"人话"。env STATUS_NL=0 关, STATUS_NL_MS 调间隔。
    //   照 vitals/debugChat 的"telemetry must never hurt the agent"范式全 try/catch。
    startStatusNLTimer() {
        if (this.statusNLInterval) clearInterval(this.statusNLInterval);
        if (String(process.env.STATUS_NL || '1') === '0') return;
        const ms = Math.max(2000, parseInt(process.env.STATUS_NL_MS || '15000', 10) || 15000);
        this.statusNLInterval = setInterval(() => {
            try {
                const bot = this.agent && this.agent.bot;
                if (!bot || !bot.entity || !bot.entity.position) return;
                const nl = this._statusNL(bot);
                // ★2026-07-07 用户令 (空闲去抖): 挖矿间隙等【几秒内的短暂空隙】不该翻成"停下" —— 否则抖动被
                //   下游 LLM 反复叙述成"本喵刚停下了"。idle 必须【持续 >= STATUS_NL_IDLE_MS(默认 8s)】才切到
                //   空闲态; 未够时长就跳过本次广播, 保留上一条(动作/目标)状态。活动一恢复即清零计时。
                //   STATUS_NL_IDLE_MS=0 关闭去抖(空闲立刻上报)。
                if (nl.idle) {
                    if (!this._idleSince) this._idleSince = Date.now();
                    const _raw = parseInt(process.env.STATUS_NL_IDLE_MS ?? '8000', 10);
                    const _db = Number.isFinite(_raw) ? Math.max(0, _raw) : 8000;
                    if (Date.now() - this._idleSince < _db) return;   // 短暂空隙 → 先不报"停下"
                } else {
                    this._idleSince = 0;
                }
                if (nl.text === this._lastNLText) return;   // ★去重(用户令): 状态没变就不发, 消除刷屏
                this._lastNLText = nl.text;
                this.broadcast({ type: 'bot_status_nl', ts: Date.now(), ...nl });
                this._chatToMC(nl.text);   // ★用户令: 发给外部 LLM 的人话同步进游戏聊天(仅文本, 无图片)
            } catch (e) { /* NL status must never hurt the agent */ }
        }, ms);
    }

    // ★2026-07-07 用户令: 把"当前状态人话"单发给一个指定客户端(新连接补发用), 绕过周期广播的全局
    //   dedup —— 不读写 _lastNLText, 也不镜像游戏聊天(免得每次重连都刷一条 MC chat)。与周期 timer
    //   同样尊重 STATUS_NL=0 总开关, 且照 "telemetry must never hurt the agent" 全 try/catch。
    _sendCurrentStatusNL(ws) {
        try {
            if (String(process.env.STATUS_NL || '1') === '0') return;
            const bot = this.agent && this.agent.bot;
            if (!bot || !bot.entity || !bot.entity.position) return;
            const nl = this._statusNL(bot);
            ws.send(JSON.stringify({ type: 'bot_status_nl', ts: Date.now(), ...nl }));
        } catch (e) { /* connect-time NL snapshot must never hurt the agent */ }
    }

    // Build the Chinese status object — LEADS WITH THE ACTUAL PHYSICAL ACTION read from the
    // live bot (dig / fight / move / sleep), so it reflects what the bot is REALLY doing, not a
    // skill-name label that may be a no-op (e.g. nightShelter after 封箱 was disabled just HOLDS —
    // the old text wrongly said "挖坑封顶"). The committed goal (kind) is used only as context or
    // as the idle/holding fallback. No coordinates (the LLM doesn't need them). Returns {text,...}.
    _statusNL(bot) {
        const hp = Math.round(bot.health ?? 0);
        // ★2026-07-09 用户令: 饥饿信息(有点饿/食物充足…)不再进 chat log 与 admin LLM 的 ws 通道 —— 与
        //   [[hunger-fully-inert]] 定调一致(饥饿不 gate/不改道/不上报)。这里刻意不读 bot.food, 状态人话与
        //   bot_status_nl 载荷里都不再带任何食物字段, 下游 LLM 也就无从叙述"有点饿/食物充足"。
        const tod = (() => { try { return bot.time.timeOfDay || 0; } catch (e) { return 0; } })();
        const night = tod >= 12542 && tod <= 23459;
        const dim = (bot.game && bot.game.dimension) || 'overworld';
        const cmt = bot._commitment || null;
        const kind = (cmt && cmt.kind) || null;
        const skill = this._skillRunningName || bot._currentSkill || (cmt && cmt.skill) || null;
        // ★2026-07-08 ADMIN MISSION 真实性修复 (用户实观: 命令追蜘蛛却报"挖矿过夜"): 任务态下身体听的是
        //   mission(外部/chat 指令, 如 "kill a spider"), 而 kernel 的 _commitment.kind 只是被搁置的后台目标 ——
        //   拿它当"在干嘛"会谎报。任务活跃时目标短语改由 mission 取(取不出→null→退回真实动作/中性兜底),
        //   绝不再断言那个不相干的 kernel 目标; mission 原文另放进返回对象供下游 LLM 精确叙述。
        let missionText = null;
        try {
            const am = this.agent && this.agent.adminMission;
            if (am && typeof am.isActive === 'function' && am.isActive() && am.mission && am.mission.text)
                missionText = am.mission.text;
        } catch (e) {}

        // nearby hostiles (< 16b): count + up to 3 distinct Chinese names
        let hostiles = 0; const names = [];
        try {
            const bp = bot.entity && bot.entity.position;
            if (bp) for (const id in bot.entities) {
                const e = bot.entities[id];
                if (e && e.kind === 'Hostile mobs' && e.position && bp.distanceTo(e.position) < 16) {
                    hostiles++;
                    const nm = STATUS_MOB_CN[e.name] || e.name;
                    if (nm && names.indexOf(nm) < 0 && names.length < 3) names.push(nm);
                }
            }
        } catch (e) {}

        const hpTxt = hp >= 20 ? '血满' : hp >= 15 ? '血挺足' : hp >= 10 ? '半血' : hp >= 6 ? '血不多' : '快没血';
        const svnActive = (bot._surviveNowUntil && Date.now() < bot._surviveNowUntil)
            || skill === 'surviveNow' || kind === 'SURVIVE_NOW';
        const goal = missionText ? this._missionGoalPhrase(missionText) : this._goalPhrase(kind, skill);   // 短目标短语, 或 null

        // ★ACTUAL physical action from live bot state (truthful, ordered by specificity).
        let act = null;
        try {
            if (bot.isSleeping) act = '在床上睡觉';
            else if (bot.pvp && bot.pvp.target && bot.pvp.target.name) act = `在打${STATUS_MOB_CN[bot.pvp.target.name] || '怪'}`;
            else if (bot.targetDigBlock && bot.targetDigBlock.name) {
                // ★目标块(矿/木/庄稼)自解释 → "在挖X"; 填充块(石/土/深板岩…)是下矿开路的手段,
                //   报目标、块作附注 —— 否则"挖了几百石头"看着像在囤石头(实为穿石找矿, 用户实观)。
                const bn = bot.targetDigBlock.name;
                const isTarget = /_ore$|_log$|_wood$|_stem$|obsidian|ancient_debris|glowstone|_leaves$|amethyst|wheat|carrot|potato|beetroot|melon|pumpkin/.test(bn);
                // ★用户令(粒度): 动作+原因。目标块(矿/木/庄稼)自解释, 报动作即可; 填充块(石/土/深板岩…)
                //   是手段不是目的 —— 有目标就报"目标（挖开X开路）", 没目标也补个"（清路）", 免得裸"在挖石头"
                //   看着像在囤石头(用户实观: 实为穿石开路)。
                act = /(_log|_wood|_stem)$/.test(bn) ? '在砍树'
                    : isTarget ? `在挖${blockCN(bn)}`
                    : (goal ? `在${goal}（挖开${blockCN(bn)}开路）` : `在挖${blockCN(bn)}（清路）`);
            }
            else if (bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving()) act = goal ? `在赶路，去${goal}` : '在赶路';
        } catch (e) {}

        let head;
        if (svnActive) head = act ? `${act}（保命中）` : '情况紧张，在保命自救（找吃的/避险/等，尽快脱困）';
        else if (act) head = act;                       // 有真动作 → 直接报动作
        else if (goal) head = `在${goal}`;              // 没动作(hold/idle) → 报正在为之等待的目标(如 躲夜等天亮)
        else if (missionText) head = '在按指令行动';     // ★任务态但此刻无具体动作/目标短语 → 中性但不谎报"空闲"
        else head = '暂时空闲，在想下一步';

        // ★2026-07-07 用户令: 状态前缀标出模式 —— 🎯[按指令]=正在跑外部/chat 指令(admin 独占 或 run_skill),
        //   🤖[自主]=内核自主行动。让人(和外部 LLM)一眼知道 bot 现在听谁的。
        const onCommand = (bot._extIntentUntil && Date.now() < bot._extIntentUntil)
            || (this.agent && this.agent.supervised_skill === 'ws');
        let text = (onCommand ? '🎯[按指令] ' : '🤖[自主] ') + head + '，' + hpTxt;
        if (dim === 'the_nether') text += '，在下界';
        else if (dim === 'the_end') text += '，在末地';
        text += hostiles > 0 ? `，附近有${hostiles}只怪${names.length ? `（${names.join('、')}）` : ''}` : '，周围没怪';
        text += `，${night ? '夜里' : '白天'}。`;

        // ★idle 标志: 纯空闲兜底(非 保命/真动作/目标 hold) = head 落到 '暂时空闲'。供 startStatusNLTimer
        //   的"空闲去抖"用 —— 只有空闲持续够久才报"停下", 短暂空隙不报。
        //   ★任务态视为"在做事"(非空闲) —— 免得任务中途的短暂空隙被去抖成"停下"。
        const isIdle = !svnActive && !act && !goal && !missionText;
        // ★任务态: 抹掉不相干的 kernel kind(否则下游 LLM 又照它叙述成"在挖矿"), 改附 mission 原文让其精确叙述。
        return { text, kind: missionText ? null : kind, skill, hp, hostiles, night, dim, idle: isIdle, mission: missionText || undefined };   // ★不含坐标, 也不含食物字段(用户令: 饥饿不进 admin ws)
    }

    // Short GOAL phrase (what it's trying to achieve) — context / idle-fallback only, never the
    // asserted physical action. Umbrella skills (prepNether/…) fall through to null so the head
    // becomes the actual action or a plain '空闲', never the "prepNether" 废话.
    _goalPhrase(kind, skill) {
        if (kind && STATUS_KIND_CN[kind]) return STATUS_KIND_CN[kind];
        if (skill && STATUS_SKILL_CN[skill]) return STATUS_SKILL_CN[skill];
        return null;
    }

    // ★2026-07-08 任务态目标短语: 从 mission 原文(自由文本, 如 "Goal: kill a spider. Equip stone_sword…")
    //   提炼一句短短语当"在干嘛"。去掉 "Goal:/Task:" 前缀与引号, 取第一小句并截断。取不出返回 null →
    //   调用方退回真实动作/中性兜底。刻意不翻译(下游叙述 LLM 会用返回对象里的 mission 原文润色成中文)。
    _missionGoalPhrase(text) {
        try {
            let s = String(text || '').replace(/[\r\n]+/g, ' ').replace(/["“”'`]/g, '').trim();
            s = s.replace(/^\s*(goal|task|objective|mission)\s*[:：\-]\s*/i, '');
            s = s.split(/[.。;；!！?？\n]/)[0].trim();
            if (!s) return null;
            if (s.length > 20) s = s.slice(0, 20).trim() + '…';
            return s;
        } catch (e) { return null; }
    }

    startVitalsTimer() {
        if (this.vitalsInterval) clearInterval(this.vitalsInterval);
        this.vitalsInterval = setInterval(() => {
            try {
                const bot = this.agent && this.agent.bot;
                if (!bot || !bot.entity || !bot.entity.position) return;
                const pos = bot.entity.position;
                // FULL-slot scan (5..45: armor + main + hotbar + offhand), not items()
                // (9-44 only) — an equipped shield/armor or offhand-parked item vanished
                // from telemetry and fired false "gear lost" alerts (saw both live).
                const inv = {};
                try {
                    const sl = bot.inventory.slots || [];
                    for (let i = 5; i < sl.length; i++) {
                        const s = sl[i];
                        if (s && s.name) inv[s.name] = (inv[s.name] || 0) + s.count;
                    }
                } catch (e) {}
                let hostiles = 0;
                try {
                    for (const id in bot.entities) {
                        const e = bot.entities[id];
                        if (e && e.kind === 'Hostile mobs' && e.position && pos.distanceTo(e.position) < 16) hostiles++;
                    }
                } catch (e) {}
                // EFFECTIVE picks: a >85%-worn pickaxe is about to snap — count only real
                // life. Surfaces the human "durability sense" to the watchdog/patrol so a
                // dying last pick is visible BEFORE the bot ends up punching stone.
                let pickFx = 0;
                try {
                    for (const it of bot.inventory.items()) {
                        if (!/_pickaxe$/.test(it.name)) continue;
                        const max = it.maxDurability || 0;
                        const used = (typeof it.durabilityUsed === 'number') ? it.durabilityUsed : 0;
                        if (!max || (used / max) < 0.85) pickFx++;
                    }
                } catch (e) {}
                // ★C314-A: expose worn ARMOR — we were BLIND to it (no armor field), so a cheat-given
                // iron set that never auto-equipped left her defenseless and we couldn't tell why she
                // kept dying to swarms (#117: 3-sec zombie kill "armored"). Armor slots = inventory
                // slots 5(head)/6(torso)/7(legs)/8(feet). Report worn pieces so survival is observable.
                let armor = '?';
                try {
                    const _sl = bot.inventory && bot.inventory.slots;
                    const _a = [_sl && _sl[5], _sl && _sl[6], _sl && _sl[7], _sl && _sl[8]].filter(Boolean).map(it => it.name);
                    armor = _a.length ? _a.join(',') : 'none';
                } catch (e) { armor = '?'; }
                this.broadcast({
                    type: 'vitals', ts: Date.now(),
                    x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z),
                    dim: (bot.game && bot.game.dimension) || '?',
                    hp: Math.round(bot.health ?? -1), food: (bot.food ?? -1),
                    tod: (bot.time && bot.time.timeOfDay) ?? -1,
                    hostiles,
                    skill: this._skillRunningName || null,
                    held: (bot.heldItem && bot.heldItem.name) || 'empty',   // exposes digging-with-wrong-tool
                    pickFx,                                                  // effective (non-worn-out) pickaxes
                    armor,                                                   // ★C314-A worn armor pieces (none = defenseless → swarm death risk)
                    mob: ((bot._mobility && bot._mobility.state) || '?') + (bot._mobility && bot._mobility.enclosed ? '/ENC' : ''),   // mobility state machine (FREE/POCKET/ENTOMBED/SWIM[/ENC=封闭地穴])
                    pinKicks: bot._persistentPinKicks || 0,   // ★reflex_watchdog escalation: N (>3) = bot is in a PERSISTENT pin the forced-interrupt kick can't break — supervisor should dispatch a relocating recovery (forageExplore/escapePlan). 0 = not pinned / kick still working.
                    // ★2026-07-14 admin 独占标志 (用户令: admin 要求的炼铁/待命是合法站桩): watchdog 的
                    //   STUCK-ZONE 位置锚是累积的, 长炉次/待命会被 10min cancel / 25min 硬重启误杀 —
                    //   cmd=1 时 watchdog 保护性 re-anchor (对应 watchdog.ps1 $adminCmdHold)。
                    cmd: (bot._extIntentUntil && Date.now() < bot._extIntentUntil) ? 1 : 0,
                    inv,
                });
            } catch (e) { /* telemetry must never hurt the agent */ }
        }, 15000);
    }

    waitForBotSpawn(agent) {
        // Check if bot is properly spawned
        if (!agent.bot.entity || !agent.bot.entity.position) {
            console.log('Waiting for bot to spawn before initializing camera...');
            setTimeout(() => this.waitForBotSpawn(agent), 2000);
            return;
        }

        // Validate bot position data
        const pos = agent.bot.entity.position;
        if (!this.isValidNumber(pos.x) || !this.isValidNumber(pos.y) || !this.isValidNumber(pos.z)) {
            console.log('Bot position data invalid, waiting for valid position...');
            setTimeout(() => this.waitForBotSpawn(agent), 2000);
            return;
        }

        // Bot is ready, initialize camera — UNLESS screenshots are disabled. The
        // prismarine-viewer headless WebGL renderer (created here) keeps rendering the
        // world even when we never capture, and it crashes the agent subprocess (exit 1)
        // intermittently → auto-restart → ~15s offline → the bot dies AFK at the surface
        // spawn at night. Disabling captures alone wasn't enough (the renderer still ran);
        // skipping Camera creation entirely when NEKO_AGENT_SCREENSHOT_INTERVAL_MS<=0
        // removes the renderer and the churn with it. (We lose the visual feed, but the
        // bot staying ALIVE and online matters far more.)
        // RE-ENABLED via env gate. The "prismarine-viewer renderer crashes the agent
        // subprocess (exit 1)" blamed here was almost certainly the getFullStateAsync WEDGE
        // (unguarded getInventoryCounts → throw → mindserver marks agent stale → half-dead,
        // which looked like a crash/auto-restart). That root is now fixed in
        // library/full_state.js, so we restore the visual feed for diagnosis. Gate on
        // NEKO_AGENT_SCREENSHOT_INTERVAL_MS: init the camera ONLY when it's >0. Defaults OFF
        // when unset/≤0 — so if the env fails to propagate to a subprocess restart it stays
        // safely OFF (no renderer, no churn), the OPPOSITE of the old default-ON failure mode.
        const _ssMs = parseInt(process.env.NEKO_AGENT_SCREENSHOT_INTERVAL_MS || '0', 10);
        if (!Number.isFinite(_ssMs) || _ssMs <= 0) {
            console.log('🛑 Camera/viewer init disabled (NEKO_AGENT_SCREENSHOT_INTERVAL_MS<=0)');
            return;
        }
        console.log(`📷 Camera/viewer init ENABLED (screenshot interval ${_ssMs}ms)`);
        // ★2026-07-09 全局卡顿根因修 (render-worker 泄漏): 每次掉线重连 spawn → setAgent →
        //   这里无条件 new CameraProc, 旧相机从不 cleanup() → 每重连泄漏一个 ~0.6-1GB 的
        //   render_worker 子进程 (实录 5 个并存 ≈4.1GB, 32GB 只剩 1GB 空闲 → 系统换页 →
        //   客户端+bot 一顿一顿)。杀 worker 没用: 旧 CameraProc 的 exit-respawn 还活着会复活它,
        //   必须走 cleanup() (置 _destroyed → 杀 worker 且不复活, 并摘掉旧 bot 的 worldView 监听)。
        if (this.screenshotInterval) { clearInterval(this.screenshotInterval); this.screenshotInterval = null; }
        if (this.camera) {
            try { this.camera.cleanup(); } catch (e) { /* 回收失败不挡新相机 */ }
            this.camera = null;
        }
        // 竞态防线: import() 是异步的, 两次快速重连可能有两个 then 同时在飞 —— 只认最新一代,
        // 旧代 then 落地时立即 cleanup 自己刚建的相机, 不覆盖 this.camera。
        const _camEpoch = (this._cameraEpoch = (this._cameraEpoch || 0) + 1);
        /* eslint-disable no-unreachable */
        try {
            // CameraProc isolates the GL renderer in a child process (crash-safe).
            // It exposes the same {.on('ready'), .capture() -> base64 jpeg} surface
            // we rely on below, so the rest of the screenshot loop is unchanged.
            // Lazy-loaded ONLY here (screenshots enabled) so the prismarine-viewer /
            // headless-gl chain is never imported at startup.
            import('../agent/vision/camera_proc.js').then(({ CameraProc }) => {
                const cam = new CameraProc(agent.bot, `./bots/${agent.name}/screenshots/`);
                if (_camEpoch !== this._cameraEpoch) {   // 已被更新一代取代 → 自毁, 不泄漏
                    try { cam.cleanup(); } catch (e) { /* ignore */ }
                    return;
                }
                this.camera = cam;
                this.camera.on('ready', () => {
                    if (_camEpoch !== this._cameraEpoch) return;   // ready 迟到于换代 → 不再起定时器
                    console.log('Camera initialized for WebSocket screenshots (forced initialization)');
                    // Wait a bit more for bot to be fully ready before starting screenshots
                    setTimeout(() => {
                        if (_camEpoch !== this._cameraEpoch) return;
                        this.startScreenshotTimer();
                    }, 5000); // Wait 5 seconds after camera is ready
                });
            }).catch((error) => {
                console.error('Failed to lazy-load/initialize camera for WebSocket screenshots:', error);
            });
        } catch (error) {
            console.error('Failed to initialize camera for WebSocket screenshots:', error);
        }
    }

    handleMessage(data) {
        if (!this.agent) {
            this.broadcast({
                type: 'error',
                error: 'No agent connected'
            });
            return;
        }

        // ★2026-07-07 用户令: 把收到的外部 LLM 指令(仅文本)同步到游戏聊天, 便于 debug。
        //   ping/query_inventory 是心跳/快照噪声, 不镜像。
        try {
            if (data.type === 'task') this._chatToMC(`◀外部指令[task] ${data.task}`);
            else if (data.type === 'run_skill') this._chatToMC(`◀外部指令[run_skill] ${data.skill}(${JSON.stringify(data.args || [])})`);
            else if (data.type === 'cancel_skill') this._chatToMC(`◀外部指令[cancel] ${data.reason || ''}`);
        } catch (e) { /* incoming chat mirror must never hurt the agent */ }

        switch (data.type) {
            case 'task':
                // Forward optional task_id so we can echo it back on the
                // matching task_finished frame. The plugin uses that echo
                // to do explicit ID-based correlation (see plugin
                // game_agent_minecraft service.py _on_task_finished's
                // ``echoed_task_id`` branch); without it the plugin falls
                // back to a fragile FIFO drop counter that mis-attributes
                // completions whenever a task takes longer than the
                // plugin-side ``task_timeout_seconds``.
                // ★2026-07-07 ADMIN MISSION (用户令): when MC_ADMIN_MISSION is on, an external task
                // becomes a persistent highest-priority mission (self-prompt until done/impossible/
                // overridden/survival-interrupt). The controller owns the preempt + task_id +
                // completion, so route straight to it and skip the legacy one-shot inject below.
                if (this.agent && this.agent._missionEnabled && this.agent.adminMission) {
                    try { this.agent.adminMission.submit({ text: data.task, taskId: data.task_id, origin: 'ws' }); }
                    catch (e) { console.error('adminMission.submit failed:', e); }
                    break;
                }
                // ── legacy one-shot path (flag OFF) ──
                // ★2026-07-07 AUTO-PREEMPT: an external NL command is highest priority — if a
                // skill is running, interrupt it so the injected admin turn's body actions
                // aren't blocked by the BodyGate. Sync interrupt only (no await): the LLM turn's
                // network latency is the unwind window; hard-safety reflexes stay always-on.
                if (this._skillRunning || (this.agent && this.agent.supervised_skill)) {
                    this._interruptRunning(`external task 抢占 ${this._skillRunningName || this.agent.supervised_skill}`);
                }
                this.injectMessage(data.task, data.task_id);
                break;
            case 'ping':
                this.broadcast({
                    type: 'pong'
                });
                break;
            case 'query_inventory':
                // On-demand snapshot. Plugin uses this to back its
                // ``query_inventory`` plugin entry — without a live
                // request path, the entry could only return what was
                // cached on the last ``task_finished`` (minutes stale
                // between actions, which made the dialog LLM narrate
                // outdated 持有物 lists like a robot).
                this.broadcastCurrentInventory();
                break;
            case 'run_skill':
                // Supervisor-direct skill execution. Bypasses the LLM coder
                // (newAction) entirely — the named custom skill runs exactly as
                // written, with the given args, no rewriting/dropping of steps.
                // This is the reliable execution path for scripted progression.
                this.runSkill(data.skill, data.args || []);
                break;
            case 'cancel_skill':
                this.cancelSkill(data.reason || 'supervisor requested cancel');
                break;
            default:
                this.broadcast({
                    type: 'error',
                    error: `Unknown message type: ${data.type}`
                });
        }
    }

    // Raise every stop signal a long-running skill polls, so it unwinds in ms.
    // Shared by cancel_skill (supervisor) and the external-command auto-preempt
    // path so both interrupt identically.
    _interruptRunning(reason) {
        const bot = this.agent && this.agent.bot;
        if (!bot) return false;
        try { bot.interrupt_code = true; } catch (e) {}
        try { bot._chopGen = (bot._chopGen || 0) + 1; } catch (e) {}
        try { bot._supervisorCancelAt = Date.now(); } catch (e) {}
        try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
        try { bot.clearControlStates(); } catch (e) {}
        // ★ROOT-CAUSE of the 4-min cancel-ignored hang: the in-flight bot.dig() promise was
        // never rejected, so breakBlockAt/safeDig sat in their 60s/15s Promise.race waiting out
        // the timeout while a long mining loop chained more digs. requestInterrupt() (agent.js)
        // already does this; the supervisor cancel path was missing it. stopDigging() rejects the
        // pending dig immediately so the skill unwinds in milliseconds.
        try { bot.stopDigging(); } catch (e) {}
        try { bot.collectBlock && bot.collectBlock.cancelTask && bot.collectBlock.cancelTask(); } catch (e) {}
        try { bot.pvp && bot.pvp.stop && bot.pvp.stop(); } catch (e) {}
        console.log(`🧯 interrupt: ${reason}`);
        return true;
    }

    cancelSkill(reason) {
        // ★2026-07-14 用户令 (admin 任务不被别的命令打断): supervisor 侧的自动 cancel (watchdog
        //   STUCK-ZONE 10min 站桩判定等) 在 admin 独占窗口内一律拒绝 — admin 要求的炼铁/原地待命
        //   本来就是合法站桩, 不是卡死。admin 自己撤销/改令走 'task' 注入路 (auto-preempt), 不经此门;
        //   窗口随任务结束清零 (handleMessage finally / mission end), 真卡死时续期停止 → 窗口 ≤5min
        //   内过期, watchdog cancel 恢复效力; 25min STUCK-ZONE 硬重启是进程级, 不走这里, 终极兜底不变。
        try {
            const _b = this.agent && this.agent.bot;
            if (_b && _b._extIntentUntil && Date.now() < _b._extIntentUntil) {
                console.log(`[ws] cancel_skill REFUSED (admin-exclusive window active): ${reason}`);
                this.broadcast({ type: 'cancel_result', ok: false, error: 'admin-exclusive active — an on-command task holds the body; refusing supervisor cancel', reason });
                return;
            }
        } catch (e) {}
        if (!this._interruptRunning(reason)) {
            this.broadcast({ type: 'cancel_result', ok: false, error: 'no agent online', reason });
            return;
        }
        this.broadcast({
            type: 'cancel_result',
            ok: true,
            reason,
            running: this._skillRunningName || null,
        });
    }

    // ★2026-07-07 外部 LLM 集成 — 入口 auto-preempt: 外部指令 = 最高优先级。收到 run_skill/
    //   task 时若正忙, 打断当前技能并等它解卷(锁清空), 再让外部指令接管。硬保命反射(vitalNow:
    //   溺水/着火/岩浆/hp≤4)始终在 modes tick 上跑、无视 supervised → "凌驾提案+求生, 让位硬保命"。
    //   返回 true = 锁已清可派发; false = 4s 内没解卷(罕见), 调用方放弃避免双技能抢寻路。
    async _preemptForExternal(reason) {
        this._interruptRunning(reason);
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline && (this._skillRunning || (this.agent && this.agent.supervised_skill))) {
            await new Promise(r => setTimeout(r, 150));
        }
        return !(this._skillRunning || (this.agent && this.agent.supervised_skill));
    }

    // sticky_skill.json 里登记的保活技能名 (BOM-safe 读, 读不到就当不是)。
    _isStickySkill(name) {
        try {
            const raw = fs.readFileSync('bots/_supervisor/sticky_skill.json', 'utf8').replace(/^﻿/, '');
            const sticky = JSON.parse(raw);
            return !!(sticky && sticky.skill === name);
        } catch (e) { return false; }
    }

    async runSkill(skillName, args) {
        if (!this.agent || !this.agent.bot) {
            this.broadcast({ type: 'skill_result', skill: skillName, ok: false, error: 'no agent online' });
            return;
        }
        // ★2026-07-14 (用户令: admin 任务不被别的命令打断 — in-game 实锤 20:03:48): bridge 每收到
        //   一个 skill_result 就 8s 后重挂 sticky (kernelDriver), 而下方 AUTO-PREEMPT 把它当"外部
        //   指令最高优先"→ 刚起跑的 admin/直派技能被自动保活反杀 (`run_skill kernelDriver 抢占
        //   smeltSafe`), admin mission 也被它饿死。sticky 保活不是外部命令: 身体被占 或 admin 独占
        //   窗口新鲜时, 一律 busy 拒绝 (bridge 对 busy 前缀转 30s 慢心跳重试, 前台技能结束后的
        //   skill_result 也会再触发重挂 — 自主照常恢复, 不会 dead-idle)。真人/监工手动直派的
        //   非 sticky 技能不受影响, 保留 auto-preempt。
        try {
            const _busyNow = this._skillRunning || this.agent.supervised_skill;
            const _b = this.agent.bot;
            const _adminFresh = _b && _b._extIntentUntil && Date.now() < _b._extIntentUntil;
            if ((_busyNow || _adminFresh) && this._isStickySkill(skillName)) {
                const who = this._skillRunningName || this.agent.supervised_skill || 'admin-exclusive window';
                console.log(`🛠️ run_skill ${skillName} (sticky re-arm) — busy 拒绝, '${who}' 占用中`);
                this.broadcast({ type: 'skill_result', skill: skillName, ok: false, error: `busy: ${who} running (sticky re-arm rejected)` });
                return;
            }
        } catch (e) {}
        // RE-ENTRY GUARD: never run two supervised skills at once. The bridge re-arms a
        // sticky skill on every (re)connect, so a WS blip can fire a SECOND achieveLoop
        // while one is already running — two loops then fight over the SAME bot.pathfinder,
        // each cancelling the other's goal ("goal was changed before it could be completed"),
        // which pinned the bot (couldn't climb/move). One supervised skill at a time.
        // ★KERNEL-MUTEX: the framework kernel (kernel.js _commit) dispatches customSkill
        // directly and never sets our _skillRunning — its lock is agent.supervised_skill
        // (owner-tagged 'kernel'; we tag 'ws'). Check BOTH, or a run_skill landing mid-kernel-
        // dispatch runs two supervised skills that fight over the same bot.pathfinder,
        // exactly like the WS-blip double-achieveLoop case above.
        // ★2026-07-07 AUTO-PREEMPT (was: reject-if-busy): an external command is highest
        // priority, so a busy bot gets its current skill (ws or kernel dispatch) interrupted
        // and we take over once it unwinds. If it won't release within the window we bail
        // rather than run two supervised skills that fight over the same bot.pathfinder
        // (the original re-entry hazard this guard existed for).
        if (this._skillRunning || this.agent.supervised_skill) {
            const who = this._skillRunningName || this.agent.supervised_skill || 'current activity';
            console.log(`🛠️ run_skill ${skillName} 抢占 '${who}' (external command = highest priority)`);
            const cleared = await this._preemptForExternal(`external run_skill ${skillName} 抢占 ${who}`);
            if (!cleared) {
                const still = this._skillRunningName || this.agent.supervised_skill || 'unknown';
                console.log(`🛠️ run_skill ${skillName} — 抢占超时, '${still}' 仍占用, 放弃(避免双技能抢寻路)`);
                this.broadcast({ type: 'skill_result', skill: skillName, ok: false, error: `preempt timeout: ${still} still running` });
                return;
            }
        }
        this._skillRunning = true; this._skillRunningName = skillName;
        console.log(`🛠️ run_skill direct: ${skillName}(${JSON.stringify(args)})`);
        // Clear any stale interrupt + death-abort so the freshly-started supervised skill
        // isn't pre-empted before it begins (death sets death_abort to bail the PREVIOUS skill).
        try { this.agent.bot.interrupt_code = false; this.agent.bot.death_abort = false; } catch (e) {}
        // SUPERVISED LOCK: take exclusive control. Pause the bot's autonomous LLM
        // brain (self-prompt loop) and flag handleMessage to ignore system/self
        // prompts, so the scripted skill isn't fought/interrupted by the LLM
        // issuing !goToBed/!moveAway on death/hurt (which preempts the skill AND
        // the survival modes -> bot thrashes and dies). Tick modes still protect it.
        try { this.agent.supervised_skill = 'ws'; } catch (e) {}   // owner-tagged (truthy, same readers)
        // ★2026-07-07 ADMIN MISSION: if a mission is active, PARK its self-prompt loop (stopLoop —
        //   interrupt only, state stays ACTIVE) instead of stop(false). A blind stop(false) sets
        //   state=STOPPED, which the mission would otherwise have to disambiguate from "done"; parking
        //   keeps it ACTIVE so it self-heals when this supervised skill releases (resumeAfterSupervised).
        try {
            if (this.agent._missionEnabled && this.agent.adminMission && this.agent.adminMission.isActive()) {
                this.agent.adminMission.suspendForSupervised();
            } else if (this.agent.self_prompter && this.agent.self_prompter.isActive()) {
                this.agent.self_prompter.stop(false);
            }
        } catch (e) {}
        // ★2026-07-07 命令战斗覆盖 (用户令): 外部指令跑战斗技能时置滚动戳, 让 modes.js self_preservation.
        //   shouldFlee override 胆怯档逃跑(hp<7/无盾被远程), 但保留 苦力怕/≥3围殴/硬地板(vitalNow)。
        //   窗口给足(>maxMs 默认 14s), finally 里清 → 只在这次命令战斗期间生效, 不外溢到自主战斗。
        const _isCombatSkill = /^(shieldFight|attackEntity|huntEntity|defendSelf|attackNearest|killMob)$/i.test(skillName);
        if (_isCombatSkill) { try { this.agent.bot._commandedFightUntil = Date.now() + 30000; } catch (e) {} }
        try {
            const skills = await import('../agent/library/skills.js');
            const result = await skills.customSkill(this.agent.bot, skillName, ...args);
            let inv = {};
            try { for (const it of this.agent.bot.inventory.items()) inv[it.name] = (inv[it.name] || 0) + it.count; } catch (e) {}
            this.broadcast({
                type: 'skill_result', skill: skillName, ok: true,
                result: (result && typeof result === 'object') ? JSON.stringify(result) : (result ?? null),
                inventory: inv,
            });
        } catch (e) {
            this.broadcast({ type: 'skill_result', skill: skillName, ok: false, error: String(e && e.message || e) });
        } finally {
            // Release the supervised lock so the bot's autonomous brain resumes
            // once the scripted skill is done (or threw). Release ONLY our own tag —
            // an unconditional clear here would clobber a kernel dispatch's lock and
            // let the next run_skill/tick double-dispatch (the 23:58 concurrent-skill bug).
            try { if (this.agent.supervised_skill === 'ws') this.agent.supervised_skill = false; } catch (e) {}
            // ★命令战斗覆盖: 技能结束即清战斗戳, shouldFlee 立刻恢复常规保命(不外溢到自主行为)。
            if (_isCombatSkill) { try { this.agent.bot._commandedFightUntil = 0; } catch (e) {} }
            this._skillRunning = false; this._skillRunningName = null;
            // ★2026-07-07 ADMIN MISSION: resume the parked mission loop now the supervised skill released.
            try { if (this.agent._missionEnabled && this.agent.adminMission && this.agent.adminMission.isActive()) this.agent.adminMission.resumeAfterSupervised(); } catch (e) {}
        }
    }

    // Build + broadcast an ``inventory`` frame from the live bot. Called
    // from the ``query_inventory`` request path; safe to call any time
    // (no-op when bot is offline). The plugin matches this frame to a
    // pending ``request_fresh_inventory`` future to wake the awaiting
    // ``query_inventory`` entry.
    broadcastCurrentInventory() {
        const inventory = {};
        if (this.agent && this.agent.bot) {
            try {
                for (const item of this.agent.bot.inventory.items()) {
                    if (item != null) {
                        if (!inventory[item.name]) {
                            inventory[item.name] = 0;
                        }
                        inventory[item.name] += item.count;
                    }
                }
            } catch (err) {
                console.warn('Failed to read inventory for query response:', err);
            }
        }
        this.broadcast({
            type: 'inventory',
            inventory: inventory,
            ts: Date.now(),
        });
    }

    // ★2026-07-07 ADMIN MISSION bookkeeping. A mission (AdminMission) owns its task_id EXPLICITLY —
    //   these two methods replace injectMessage + markChatTaskComplete for the mission path and
    //   NEVER touch injectedTaskIdQueue (missions are serialized; the FIFO is a legacy-only concern),
    //   which structurally eliminates every FIFO-desync / wrong-id-echo class. beginMissionTask records
    //   the active mission; finishMission fires EXACTLY ONE task_finished with the passed id.
    beginMissionTask(text, taskId, origin) {
        this.currentTask = text;
        this.currentTaskId = (typeof taskId === 'string' && taskId) ? taskId : null;
        this.taskStartTime = Date.now();
        this.taskCompleted = false;
        this.lastTaskCompletionTime = null;
        console.log(`🎯 mission begin (${origin || 'ws'}) task_id=${this.currentTaskId || '-'}: ${String(text).slice(0, 80)}`);
    }
    finishMission(taskId, status, message) {
        const id = (typeof taskId === 'string' && taskId) ? taskId : null;
        this.onTaskCompleted({ status, message, score: null, reason: `mission ${status}`, task_id: id, mission_end: true });
        this.currentTask = null;
        this.currentTaskId = null;
    }
    // ★2026-07-14 节流回执: AdminMission 无视重复指令时, 用一帧轻量 task_finished(status='duplicate')
    //   给插件收尾该 task_id (静默丢帧会让插件挂到自身超时, 反而诱发更多重发)。刻意不走 onTaskCompleted:
    //   ① mission_end 去重戳会误压制 5s 内正在跑任务的真实尾帧; ② 不带 inventory、不动
    //   currentTask/currentTaskId —— 正在跑的任务仍拥有它们。'duplicate' 不在插件已知状态词表
    //   (ok/failed/superseded/interrupted), 按文档约定未知词当"非成功"处理, message 才是主信号。
    // ★2026-07-14 节流: 是否真有 legacy WS 任务在飞 (injectMessage 注入且尚未完成)。断线/死亡/cleanKill
    //   的 legacy 'interrupted' 帧只在此门为真时才发 —— 无任务时的断线重连风暴曾以 ~10s 一帧向对话 LLM
    //   轰炸 "任务中断" (0714 实录: server 维护中 115 连发)。mission 路径不经此门 (isActive 分支自理)。
    hasInflightTask() {
        return !!(this.currentTask && !this.taskCompleted);
    }
    ackDuplicateTask(taskId, message) {
        try {
            const payload = {
                type: 'task_finished',
                status: 'duplicate',
                message: String(message || '重复指令已忽略。'),
                score: null,
                timestamp: Date.now(),
            };
            if (typeof taskId === 'string' && taskId) payload.task_id = taskId;
            this.broadcastTaskCompletion(payload);
        } catch (e) { console.error('ackDuplicateTask failed:', e && e.message || e); }
    }

    injectMessage(message, taskId) {
        if (!message || typeof message !== 'string') {
            this.broadcast({
                type: 'error',
                error: 'Task must be a non-empty string'
            });
            return;
        }

        try {
            // Inject message as if it came from "admin" user
            // This leverages the existing respondFunc mechanism
            console.log(`😊WebSocket injecting task from admin: "${message}"` + (taskId ? ` (task_id=${taskId})` : ''));

            // Call the agent's respondFunc directly with "admin" as sender
            this.agent.respondFunc('admin', message);

            // Track current task for completion detection.
            //
            // ``injectedTaskIdQueue`` is a FIFO of plugin-supplied UUIDs
            // pending chat-loop completion; ``markChatTaskComplete``
            // shifts the head when a chat-loop ends. Why a queue rather
            // than a single ``currentTaskId``: agent.handleMessage runs
            // SYNCHRONOUSLY one user-turn at a time. If the plugin
            // dispatches task #2 while the chat-loop for task #1 is
            // still running (e.g. plugin's task_timeout_seconds fired
            // and plugin moved on), task #2 would otherwise overwrite
            // currentTaskId. When task #1's chat-loop finally finishes,
            // markChatTaskComplete would echo task #2's id along with
            // task #1's reply — plugin then attributes the wrong
            // completion to the wrong slot, causing the dialog LLM to
            // see "task succeeded" cues that don't match what actually
            // happened. Queue + FIFO shift keeps id↔reply alignment.
            //
            // ``currentTaskId`` is the most-recent id, kept around as a
            // fallback for death/disconnect/cleanKill paths that don't
            // tie to a specific chat-loop.
            this.injectedTaskIdQueue = this.injectedTaskIdQueue || [];
            const safeTaskId = (typeof taskId === 'string' && taskId) ? taskId : null;
            this.injectedTaskIdQueue.push(safeTaskId);
            this.currentTask = message;
            this.currentTaskId = safeTaskId;
            this.taskStartTime = Date.now();
            this.taskCompleted = false; // Reset completion status for new task
            this.lastTaskCompletionTime = null;

        } catch (error) {
            console.error('Error injecting message:', error);
            this.broadcast({
                type: 'error',
                error: 'Failed to inject task'
            });
        }
    }

    // Called by agent.handleMessage when its response loop exits naturally
    // (no in-flight commands, agent emitted a conversation reply). In
    // free-play mode (no this.task.data) checkTaskDone() never fires, so
    // without this hook the plugin's awaiting minecraft_task tool call
    // would never wake up and would always time out — see plugin
    // game_agent_minecraft README's "free-play 完成识别" note.
    //
    // We gate on `this.currentTask` so:
    //   - chat from a non-WS source (real admin player) doesn't spuriously
    //     fire task_finished frames (currentTask is null → no-op)
    //   - death / disconnect / cleanKill paths that already fired an
    //     'interrupted' completion are not double-fired here, because they
    //     set taskCompleted within the last few seconds (see guard below)
    markChatTaskComplete(lastReply) {
        if (!this.currentTask) {
            return; // nothing to complete (no WS task pending)
        }
        if (this.taskCompleted && this.lastTaskCompletionTime &&
            (Date.now() - this.lastTaskCompletionTime) < 5000) {
            // Another path (checkTaskDone / death / disconnect) just
            // broadcast a completion for this task slot. Don't double-fire.
            this.currentTask = null;
            return;
        }
        const taskText = this.currentTask;
        this.currentTask = null;
        const replyText = (typeof lastReply === 'string' && lastReply.trim())
            ? lastReply.trim()
            : '(chat loop ended without a final reply)';
        // Shift the FIFO of injected task ids — this chat-loop is the
        // oldest still-pending one (mc-agent's chat-loop is sequential,
        // so completion order matches inject order). Pass the shifted
        // id explicitly to onTaskCompleted so it doesn't fall back to
        // ``currentTaskId``, which has already been overwritten by any
        // newer inject that occurred while this chat-loop was running.
        this.injectedTaskIdQueue = this.injectedTaskIdQueue || [];
        const taskId = this.injectedTaskIdQueue.shift() || null;
        this.onTaskCompleted({
            status: 'ok',
            message: replyText,
            score: null,
            reason: `chat-loop completed: "${taskText.slice(0, 60)}"`,
            task_id: taskId,
        });
    }

    // Handle reconnection by checking if there's a completed task to report
    handleReconnection(ws) {
        if (this.taskCompleted && this.lastTaskCompletionTime) {
            // If task was completed recently (within last 30 seconds), report it
            const timeSinceCompletion = Date.now() - this.lastTaskCompletionTime;
            if (timeSinceCompletion < 30000) {
                console.log('Reporting previously completed task to reconnected client');
                // Reconnected client missed the original task_finished.
                // Replay it in Chinese first-person so the dialog LLM
                // forwards it cleanly to猫娘 instead of leaking
                // English transport vocabulary into her narration.
                ws.send(JSON.stringify({
                    type: 'task_finished',
                    status: 'ok',
                    message: '上一段动作在你掉线那会儿就跑完了。',
                    timestamp: this.lastTaskCompletionTime,
                    reconnected: true
                }));
            }
        }
    }

    // Send initial inventory information when client connects
    sendInitialInventory(ws) {
        if (!this.agent || !this.agent.bot) {
            console.log('Agent not online, skipping initial inventory');
            return;
        }

        try {
            const bot = this.agent.bot;
            const inventory = {};
            for (const item of bot.inventory.items()) {
                if (item != null) {
                    if (!inventory[item.name]) {
                        inventory[item.name] = 0;
                    }
                    inventory[item.name] += item.count;
                }
            }

            // Format inventory as Chinese text
            const items = Object.entries(inventory).filter(([name, count]) => count > 0);
            let inventoryMessage = '';
            if (items.length > 0) {
                inventoryMessage = 'Agent已在线。当前持有道具：' + items.map(([name, count]) =>
                    `${name} x${count}`
                ).join('、');
            } else {
                inventoryMessage = 'Agent已在线。当前持有道具：无';
            }

            // Get agent status
            const status = {
                name: this.agent.name,
                health: bot.health || 0,
                food: bot.food || 0,
                position: bot.entity ? {
                    x: bot.entity.position.x.toFixed(2),
                    y: bot.entity.position.y.toFixed(2),
                    z: bot.entity.position.z.toFixed(2)
                } : null,
                gameMode: bot.game?.gameMode || 'unknown'
            };

            console.log('📦 Sending initial inventory to new client');
            ws.send(JSON.stringify({
                type: 'agent_status',
                message: inventoryMessage,
                inventory: inventory,
                status: status,
                timestamp: Date.now()
            }));
        } catch (err) {
            console.warn('Failed to send initial inventory:', err);
        }
    }

    // Method to be called when task completion is detected by agent
    onTaskCompleted(completionData) {
        // ★2026-07-07 mission single-fire backstop (defense-in-depth beyond AdminMission.end()'s
        //   idempotent state guard). Two guarded races: (a) a duplicate mission-end frame for the
        //   same id within 10s; (b) a trailing raw 'interrupted' frame (death/disconnect) landing
        //   right after a mission just fired its terminal frame → the plugin would double-report.
        try {
            const cd = completionData || {};
            const now = Date.now();
            if (cd.mission_end) {
                if ((cd.task_id && cd.task_id === this._lastFiredMissionId && now - (this._lastFiredMissionAt || 0) < 10000)
                    || (!cd.task_id && this._missionJustEndedAt && now - this._missionJustEndedAt < 5000)) {
                    console.log('onTaskCompleted: duplicate mission-end suppressed');
                    return;
                }
                this._lastFiredMissionId = cd.task_id || null;
                this._lastFiredMissionAt = now;
                this._missionJustEndedAt = now;
            } else if (this._missionJustEndedAt && now - this._missionJustEndedAt < 5000) {
                console.log('onTaskCompleted: trailing frame suppressed (mission just ended)');
                return;
            }
        } catch (e) { /* dedup must never block a real completion */ }

        this.taskCompleted = true;
        this.lastTaskCompletionTime = Date.now();

        // Get current inventory
        let inventoryInfo = '';
        let inventoryData = {};
        if (this.agent && this.agent.bot) {
            try {
                const bot = this.agent.bot;
                const inventory = {};
                for (const item of bot.inventory.items()) {
                    if (item != null) {
                        if (!inventory[item.name]) {
                            inventory[item.name] = 0;
                        }
                        inventory[item.name] += item.count;
                    }
                }

                // Format inventory as Chinese text
                const items = Object.entries(inventory).filter(([name, count]) => count > 0);
                if (items.length > 0) {
                    inventoryInfo = '\n\n当前持有道具：' + items.map(([name, count]) =>
                        `${name} x${count}`
                    ).join('、');
                } else {
                    inventoryInfo = '\n\n当前持有道具：无';
                }

                inventoryData = inventory;
            } catch (err) {
                console.warn('Failed to get inventory:', err);
                inventoryInfo = '\n\n当前持有道具：获取失败';
            }
        }

        // status defaults to 'ok' for normal completion. Death / disconnect /
        // forced restart paths pass 'interrupted' so the downstream LLM doesn't
        // mis-read a forced abort as a successful finish (the plugin transparently
        // forwards this status into its tool result).
        const status = completionData.status || 'ok';

        // Highligh debug output for task_finished
        console.log('\n🎯 ===== TASK FINISHED =====');
        console.log('📋 Status:', status);
        console.log('📋 Message:', completionData.message || 'Task completed');
        console.log('📊 Score:', completionData.score);
        console.log('⏰ Timestamp:', new Date(this.lastTaskCompletionTime).toISOString());
        console.log('🔗 Reason:', completionData.reason || 'Normal completion');
        console.log('🎒 Inventory:', inventoryInfo.replace('\n\n当前持有道具：', ''));
        console.log('=============================\n');

        // Append inventory info to message
        const messageWithInventory = (completionData.message || 'Task completed') + inventoryInfo;

        // Echo back the plugin-supplied task_id so the plugin can use
        // explicit ID-based correlation instead of FIFO drop counter.
        // Two sources, by precedence:
        //   1. completionData.task_id  — explicitly passed by the agent
        //      callsite (e.g. checkTaskDone for eval-mode score reporting,
        //      where completion isn't tied to the WS-injected currentTask)
        //   2. this.currentTaskId      — the active WS task; chat-loop
        //      completion / death / disconnect / cleanKill all relate to it
        // Drop the field entirely (instead of sending null/empty) when
        // neither is present, so the plugin's id-mismatch path treats
        // the frame as legacy/un-correlated and falls back to FIFO.
        const taskId = completionData.task_id || this.currentTaskId || null;
        const payload = {
            type: 'task_finished',
            status,
            message: messageWithInventory,
            score: completionData.score,
            timestamp: this.lastTaskCompletionTime,
            inventory: inventoryData,
        };
        if (taskId) payload.task_id = taskId;

        // Broadcast to all connected clients with retry mechanism
        this.broadcastTaskCompletion(payload);

        // Once the completion is on the wire, the in-flight WS task is
        // resolved — clear currentTaskId so a stale/late frame doesn't
        // re-use the same id and confuse the plugin.
        this.currentTaskId = null;

        console.log('Task completion broadcasted to all WebSocket clients');
    }

    // Enhanced task completion broadcasting with retry mechanism
    broadcastTaskCompletion(data, retryCount = 0) {
        // ★2026-07-07 用户令: task_finished 走这条(带重试)独立通道, 不经 broadcast() —— 在此把原文
        //   镜像进公屏 chat (完成日志: '进入' 有 ◀外部指令, 现在 '完成' 有 ▶task_finished, 闭环)。
        //   仅首发镜像(retryCount===0), 重试不重复刷屏。全 try/catch, 绝不伤 agent。
        if (retryCount === 0) {
            try { this._chatToMC('▶' + JSON.stringify(data)); } catch (e) { /* completion mirror must never hurt the agent */ }
        }
        const maxRetries = 3;
        const message = JSON.stringify(data);
        let sentCount = 0;
        let failedCount = 0;

        this.clients.forEach(client => {
            if (client.readyState === client.OPEN) {
                try {
                    client.send(message);
                    sentCount++;
                } catch (error) {
                    console.error('Failed to send task completion to client:', error);
                    failedCount++;
                    // Remove failed client
                    this.clients.delete(client);
                }
            } else {
                // Remove disconnected clients
                this.clients.delete(client);
            }
        });

        console.log(`Task completion message sent to ${sentCount} clients, ${failedCount} failed (attempt ${retryCount + 1})`);

        // If there were failures and we haven't exceeded max retries, retry after a short delay
        if (failedCount > 0 && retryCount < maxRetries) {
            setTimeout(() => {
                console.log(`Retrying task completion broadcast (attempt ${retryCount + 2})`);
                this.broadcastTaskCompletion(data, retryCount + 1);
            }, 1000); // Retry after 1 second
        }
    }

    // Method to broadcast agent responses back to WebSocket clients
    // ★2026-07-07 用户令 (节流): 任务态 self-prompt ~2s 一回合 → agent 叙述(log)洪流, 公屏+WS 两边都被刷屏。
    //   log 出口是 WS 帧与公屏镜像的同源 (broadcast() 里对 'log' 做镜像), 所以在这里一处节流即同时覆盖两面。
    //   leading+trailing 节流 + 相邻去重: 每 LOG_MIN_MS 至多发一条, 窗口内只保留最新一条并在窗口末尾补发(尾随)
    //   → 频率降到每 ~LOG_MIN_MS 一条, 但最后一句叙述不丢。重要帧 (skill_result/cancel_result/error/alert/
    //   task_finished) 不经这里, 完全不受影响。env LOG_MIN_MS=0 关闭节流 (回到每条都发)。
    broadcastAgentResponse(response) {
        const emit = (msg) => {
            this._lastLogAt = Date.now();
            this._lastLogText = msg;
            console.error('🤖Broadcasting log message:', msg);
            this.broadcast({ type: 'log', message: msg });
        };
        // ★2026-07-07 用户实观 (下游 admin LLM "复读"): 一条心跳/卡死循环会每 ~30s 重发【一模一样】的 log
        //   (modes.js:2494 'Nightfall — securing till dawn' 夜守心跳 → openChat → 这里)。send-on-change
        //   去重(始终生效, 与 bot_status_nl 同范式): 与【上一条已发】完全相同的 log 直接丢 → 下游只叙述一次,
        //   状态真变了(或换过别的 log 后再复现)才再发。30s 间隔 > 节流窗, 旧的"仅窗口内去重"逮不到它,
        //   故改成无条件同文去重, 放在节流之前 (LOG_MIN_MS=0 关节流时也照样去重复读)。
        if (response === this._lastLogText) return;
        const minMs = parseInt(process.env.LOG_MIN_MS || '6000', 10);
        if (!Number.isFinite(minMs) || minMs <= 0) { emit(response); return; }
        this._pendingLog = response;   // keep the LATEST distinct message for the trailing send (coalesce)
        const since = Date.now() - (this._lastLogAt || 0);
        if (since >= minMs) {
            // leading edge — the window is open, send immediately
            if (this._logTimer) { clearTimeout(this._logTimer); this._logTimer = null; }
            const m = this._pendingLog; this._pendingLog = null; emit(m);
        } else if (!this._logTimer) {
            // trailing edge — schedule the latest to go out when the window reopens
            this._logTimer = setTimeout(() => {
                this._logTimer = null;
                if (this._pendingLog != null) { const m = this._pendingLog; this._pendingLog = null; emit(m); }
            }, minMs - since);
            if (this._logTimer && this._logTimer.unref) this._logTimer.unref();
        }
        // else: a trailing send is already scheduled; _pendingLog was updated to the latest above.

        // Note: Task completion detection is now handled by agent.js checkTaskDone()
        // This prevents duplicate detection and ensures consistency
    }

    startScreenshotTimer() {
        // Default 1s/frame — tightened from the original 2s to improve
        // realtime sync with the upstream LLM (it sees the world half as
        // stale). Override with env NEKO_AGENT_SCREENSHOT_INTERVAL_MS,
        // clamped to [200, 10000] so a misconfig can't either DoS the
        // socket (sub-200ms) or freeze the visual feed (>10s).
        const envMs = parseInt(process.env.NEKO_AGENT_SCREENSHOT_INTERVAL_MS || '', 10);
        // DISABLE switch: env <= 0 turns the screenshot/viewer-capture loop OFF entirely.
        // The prismarine-viewer headless render is the prime suspect for the intermittent
        // agent-subprocess crash (exit 1 → agent_process.js auto-restart → ~15s offline →
        // the bot dies AFK at the surface spawn if it's night). Disabling captures lets us
        // confirm/eliminate that churn so the survival instincts (bunker/flee) actually run.
        if (Number.isFinite(envMs) && envMs <= 0) {
            console.log('📷 Screenshot timer DISABLED (NEKO_AGENT_SCREENSHOT_INTERVAL_MS<=0)');
            return;
        }
        const intervalMs = Number.isFinite(envMs)
            ? Math.max(200, Math.min(10000, envMs))
            : 1000;
        console.log(`📷 Screenshot timer starting at ${intervalMs}ms interval`);
        // 防重入 (2026-07-09 render-worker 泄漏修的配套): 重连换代时不叠双定时器。
        if (this.screenshotInterval) { clearInterval(this.screenshotInterval); this.screenshotInterval = null; }
        // Skip if previous screenshot is still in progress so we never
        // queue captures faster than the camera can produce them; the
        // 1s default plus this gate makes the effective rate
        // self-throttling on slower machines.
        this.screenshotInterval = setInterval(async () => {
            // Skip if previous screenshot is still in progress
            if (this.screenshotInProgress) {
                console.log('⏳ Screenshot still in progress, skipping this cycle');
                return;
            }

            try {
                await this.captureAndBroadcastScreenshot();
            } catch (error) {
                console.warn('Screenshot capture failed:', error);
            }
        }, intervalMs);
    }

    async captureAndBroadcastScreenshot() {
        if (!this.camera || !this.agent || !this.agent.bot) return;

        // Prevent concurrent screenshot captures
        if (this.screenshotInProgress) {
            return;
        }

        this.screenshotInProgress = true;

        try {
            const bot = this.agent.bot;

            // Check for valid bot position and orientation data
            // Safety check: bot.entity is null when dead
            if (!bot.entity || !bot.entity.position) {
                if (!this.deadWarningLogged) {
                    console.warn('🚨 Bot entity is null (dead/not spawned), skipping screenshot');
                    this.deadWarningLogged = true;
                }
                return;
            }

            // Reset dead warning when bot is alive again
            this.deadWarningLogged = false;

            const pos = bot.entity.position;
            const height = bot.entity.height || 1.62; // Default player height
            const yaw = bot.entity.yaw || 0;
            const pitch = bot.entity.pitch || 0;

            // Validate position and orientation values to prevent NaN errors
            if (!this.isValidNumber(pos.x) || !this.isValidNumber(pos.y) || !this.isValidNumber(pos.z) ||
                !this.isValidNumber(yaw) || !this.isValidNumber(pitch) || !this.isValidNumber(height)) {

                this.nanErrorCount = (this.nanErrorCount || 0) + 1;

                // Log detailed error information
                console.error('❌ Bot position data contains NaN/invalid values:');
                console.error('   Position:', { x: pos.x, y: pos.y, z: pos.z });
                console.error('   Orientation:', { yaw, pitch });
                console.error('   Height:', height);
                console.error(`   Consecutive errors: ${this.nanErrorCount}`);

                this.nanWarningLogged = true;

                // If we've had NaN errors for more than 10 consecutive attempts, try to recover
                if (this.nanErrorCount > 10) {
                    console.warn(`⚠️ NaN errors persisting (${this.nanErrorCount} consecutive), attempting camera reinitialization...`);

                    // Stop current screenshot timer
                    if (this.screenshotInterval) {
                        clearInterval(this.screenshotInterval);
                        this.screenshotInterval = null;
                    }

                    // Reset error count
                    this.nanErrorCount = 0;
                    this.nanWarningLogged = false;

                    // Wait a bit and try to reinitialize camera
                    setTimeout(() => {
                        if (this.agent && this.agent.bot) {
                            console.log('🔄 Attempting to reinitialize camera system...');
                            this.waitForBotSpawn(this.agent);
                        }
                    }, 5000);
                }
                return;
            }

            // Reset NaN error count on successful position read
            this.nanErrorCount = 0;

            // Calculate camera center with validated values
            const center = pos.offset(0, height, 0);

            // Validate center position (should never fail if above checks passed, but double-check)
            if (!this.isValidNumber(center.x) || !this.isValidNumber(center.y) || !this.isValidNumber(center.z)) {
                console.error('❌ Invalid camera center position (NaN detected):');
                console.error('   Center:', { x: center.x, y: center.y, z: center.z });
                console.error('   This should not happen after position validation!');
                return;
            }

            // Render + JPEG-encode happen in the ISOLATED renderer child process.
            // CameraProc.capture() forwards the bot's current pos/yaw/pitch, the child
            // renders against the chunk/entity stream it has been fed, and returns a
            // base64 JPEG (or null on skip / worker-restarting / timeout — never throws).
            // 'center' above is still used only for the NaN validation guards.
            void center;
            const base64Image = await this.camera.capture();
            if (!base64Image) {
                // Worker (re)starting, bot dead, or a frame was skipped — just wait for
                // the next tick. The agent process is never affected by a renderer fault.
                return;
            }

            this.broadcast({
                type: 'screenshot',
                image: base64Image,
                encoding: 'jpeg-base64'
            });

        } catch (error) {
            console.warn('Failed to capture screenshot:', error);
        } finally {
            // Always reset the flag, even on error
            this.screenshotInProgress = false;
        }
    }

    // Helper method to validate numeric values and prevent NaN
    isValidNumber(value) {
        return typeof value === 'number' && !isNaN(value) && isFinite(value);
    }

    broadcast(data) {
        // ★2026-07-07 用户令: 每条对外(→外部 LLM)的 WS 消息原文都镜像进公屏 chat, 供肉眼 debug
        //   ('▶'=出站, 对应 handleMessage 里 '◀'=入站)。用户令: 公屏只留「可读往来」——
        //   ◀命令 / ▶命令结果(skill_result/cancel_result/task_finished) / log(agent 叙述) / error /
        //   bot_status_nl 人话状态。以下「数字流+噪声」不镜像公屏 (WS 照发不变, 只是不刷公屏):
        //   · pong        = 心跳回复噪声 (对称: 入站 ping/query_inventory 也不镜像)。
        //   · bot_status_nl = 已在 startStatusNLTimer 里以「人话」镜像, 跳过免同条状态出现两遍。
        //   · screenshot  = 用户令: 截图不转发公屏 (base64 大图, 公屏也看不了图)。
        //   · vitals      = 用户令: 每 15s 一坨硬字段数字, 太吵 (要人话看 bot_status_nl 即可)。
        //   · inventory   = 用户令: 按需库存数字回执, 不刷公屏。
        //   task_finished 走 broadcastTaskCompletion 独立通道, 在那边单独镜像 (不经这里)。
        //   全 try/catch, 镜像绝不伤 agent; DEBUG_CHAT=0 可一并全关。
        try {
            const t = data && data.type;
            const noMirror = (t === 'pong' || t === 'bot_status_nl' || t === 'screenshot'
                || t === 'vitals' || t === 'inventory');
            if (t && !noMirror) {
                this._chatToMC('▶' + JSON.stringify(data));
            }
        } catch (e) { /* outbound chat mirror must never hurt the agent */ }

        const message = JSON.stringify(data);
        let sentCount = 0;
        let failedCount = 0;

        this.clients.forEach(client => {
            if (client.readyState === client.OPEN) {
                try {
                    client.send(message);
                    sentCount++;
                } catch (error) {
                    console.error('Failed to send message to client:', error);
                    failedCount++;
                    // Remove failed client
                    this.clients.delete(client);
                }
            } else {
                // Remove disconnected clients
                this.clients.delete(client);
            }
        });

        if (data.type === 'task_finished') {
            console.log(`Task completion message sent to ${sentCount} clients, ${failedCount} failed`);
        }
    }

    stop() {
        if (this.screenshotInterval) {
            clearInterval(this.screenshotInterval);
            this.screenshotInterval = null;
        }
        if (this.vitalsInterval) {
            clearInterval(this.vitalsInterval);
            this.vitalsInterval = null;
        }
        if (this.statusNLInterval) {
            clearInterval(this.statusNLInterval);
            this.statusNLInterval = null;
        }
        if (this.wss) {
            this.wss.close();
            console.log('WebSocket server stopped');
        }
    }
}

// Create singleton instance. NEKO_PLUGIN_WS_PORT lets a host launcher
// pick a non-default port when 48909 is taken; the N.E.K.O. plugin reads
// the same env to know where to connect.
const pluginWsPort = parseInt(process.env.NEKO_PLUGIN_WS_PORT, 10) || 48909;
const wsServer = new WSMessageServer(pluginWsPort);

export { wsServer };
