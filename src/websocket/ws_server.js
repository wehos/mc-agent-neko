import { WebSocketServer } from 'ws';
import { serverProxy } from '../agent/mindserver_proxy.js';

// ─────────────────────────────────────────────────────────────────────────────
// ★2026-07-07 外部 LLM 双向集成 — 出口: 10s 中文自然语言汇报 (bot_status_nl)。
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
// KIND → 人话。空串 = y 相关, 在 _activityPhrase 里按当前 y 拼深度带。
const STATUS_KIND_CN = {
    BOOTSTRAP_KIT: '在凑最基础的装备（找木头→工作台→木镐→石镐）',
    STONE_KIT_READY: '在补齐石器工具', REPLENISH_KIT: '在补木料和备用镐',
    TOOL_UPKEEP: '在补充、修理工具', GET_FOOD: '在解决吃饭（找或做食物）',
    FORAGE_SURFACE: '在地面觅食', VILLAGE_HARVEST: '在收割小麦',
    OPP_WHEAT_FARM: '在打理小麦农田', OPP_HUNT_ANIMAL: '在打猎弄点肉',
    OPENING_VILLAGE: '在村庄搜刮补给', OPP_SEIZE_VILLAGE: '在村庄搜刮补给',
    OPENING_SCOUT: '在开局侦查周边', OPP_TRADER_LEAD: '在找流浪商人换东西',
    OPP_MINE_VEIN_ORE: '在就近采一条矿脉', GET_ARMOR: '在打造并穿上护甲',
    GET_IRON_ARMOR_SET: '在凑齐整套铁甲', GET_DIAMOND_ARMOR: '在打造钻石护甲',
    GET_IRON_TOOLS: '在做铁工具', GET_BED: '在弄一张床', GO_BED: '在去睡觉过夜',
    DUSK_GO_BED: '天快黑了，在去睡觉', GO_UNDERGROUND: '', DUSK_MINE_NIGHT: '',
    MINE_THROUGH_NIGHT: '', NIGHT_SMELT_IRON: '在熔炉边炼铁过夜',
    SMELT_IRON: '在熔炉边炼铁', GET_DIAMOND: '', GET_DIAMOND_GEAR: '在做钻石装备',
    MIGRATE: '在转移到更合适的地方', BANK_GEAR: '在整理、存放装备',
    BUILD_HOME: '在盖据点', GET_PORTAL_KIT: '在备下界传送门材料（黑曜石等）',
    ENTER_NETHER: '在进入、搭下界传送门', GET_BLAZE_RODS: '在下界打烈焰人拿烈焰棒',
    HUNT_PEARLS: '在找末影人拿末影珍珠', CRAFT_EYES: '在合成末影之眼',
    GO_END: '在前往末地', SEAL_FORT: '在要塞封点、清怪', SLAY_DRAGON: '在打末影龙',
    NIGHT_SEAL: '在就地封顶躲夜', NIGHT_DIG_ONE: '在挖个坑封起来躲夜',
    SURVIVAL_NIGHT: '在想办法安全过夜', SURFACE_RESCUE: '在自救上浮脱困',
    FREE_PLAY: '暂时没硬性目标，在自由探索',
};
// 叶子 SKILL → 人话 (比 kind 更即时)。umbrella/survival 技能不列 (回落 kind / survival 覆盖)。
const STATUS_SKILL_CN = {
    chopWood: '在砍树、收集木头', collectBlock: '在采集方块', mineOres: '在挖矿找矿石',
    mineDown: '在向下挖矿', branchMine: '在分支挖矿', feedUp: '在弄吃的（觅食/打猎/吃存粮）',
    forage: '在觅食', villageHarvest: '在收割小麦', wheatFarm: '在打理小麦',
    smeltSafe: '在熔炉边冶炼', smelt: '在熔炉边冶炼', goBedSleep: '在去睡觉过夜',
    nightShelter: '在就地挖坑封顶躲夜', surfaceUp: '在往地面爬', escapePlan: '在脱困、找路出去',
    moveAway: '在挪开到安全位置', craftPickaxe: '在做镐子', replenishKit: '在补木料和备用镐',
};
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
        this.startDebugChatTimer();
        this.startStatusNLTimer();
    }

    // ★2026-07-07 用户调试请求: bot 每 5s 在游戏聊天里喊出当前在干什么 ("他在想什么")。
    //   telemetry(15s→vitals.json/UI) 到不了游戏聊天, 这个直发 bot.chat。env DEBUG_CHAT=0 可关。
    startDebugChatTimer() {
        if (this.debugChatInterval) clearInterval(this.debugChatInterval);
        if (String(process.env.DEBUG_CHAT || '1') === '0') return;
        this.debugChatInterval = setInterval(() => {
            try {
                const bot = this.agent && this.agent.bot;
                if (!bot || !bot.entity || !bot.entity.position || typeof bot.chat !== 'function') return;
                const p = bot.entity.position;
                const skill = this._skillRunningName || bot._currentSkill || 'idle';
                const mob = ((bot._mobility && bot._mobility.state) || '?') + (bot._mobility && bot._mobility.enclosed ? '/ENC' : '');
                let host = 0;
                try { for (const id in bot.entities) { const e = bot.entities[id]; if (e && e.kind === 'Hostile mobs' && e.position && p.distanceTo(e.position) < 16) host++; } } catch (e) {}
                const held = (bot.heldItem && bot.heldItem.name) || 'empty';
                const night = (() => { try { const t = bot.time.timeOfDay; return (t >= 12542 && t <= 23459) ? 'night' : 'day'; } catch (e) { return '?'; } })();
                const msg = `[dbg] ${skill} | ${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)} ${night} hp${Math.round(bot.health ?? -1)}/f${bot.food ?? -1} mob=${mob} host=${host} held=${held}`;
                try { bot.chat(msg); } catch (e) {}
            } catch (e) { /* debug chat must never hurt the agent */ }
        }, 5000);
    }

    // ★2026-07-07 外部 LLM 集成 — 出口: 每 10s 广播一条中文自然语言状态 (bot_status_nl)。
    //   与 vitals(硬字段) 并行, 专给外部 LLM 读"人话"。env STATUS_NL=0 关, STATUS_NL_MS 调间隔。
    //   照 vitals/debugChat 的"telemetry must never hurt the agent"范式全 try/catch。
    startStatusNLTimer() {
        if (this.statusNLInterval) clearInterval(this.statusNLInterval);
        if (String(process.env.STATUS_NL || '1') === '0') return;
        const ms = Math.max(2000, parseInt(process.env.STATUS_NL_MS || '10000', 10) || 10000);
        this.statusNLInterval = setInterval(() => {
            try {
                const bot = this.agent && this.agent.bot;
                if (!bot || !bot.entity || !bot.entity.position) return;
                this.broadcast({ type: 'bot_status_nl', ts: Date.now(), ...this._statusNL(bot) });
            } catch (e) { /* NL status must never hurt the agent */ }
        }, ms);
    }

    // Build the fine-grained Chinese status object. Prefers the committed GOAL kind
    // (bot._commitment.kind — "what it's trying to achieve") over the raw skill name,
    // with the live leaf skill (bot._currentSkill) refining it, plus a survival overlay
    // and threat/vitals in human bands. Returns {text, ...fields} for the broadcast.
    _statusNL(bot) {
        const p = bot.entity.position;
        const x = Math.round(p.x), y = Math.round(p.y), z = Math.round(p.z);
        const hp = Math.round(bot.health ?? 0);
        const food = bot.food ?? 0;
        const tod = (() => { try { return bot.time.timeOfDay || 0; } catch (e) { return 0; } })();
        const night = tod >= 12542 && tod <= 23459;
        const dim = (bot.game && bot.game.dimension) || 'overworld';
        const cmt = bot._commitment || null;
        const kind = (cmt && cmt.kind) || null;
        const skill = this._skillRunningName || bot._currentSkill || (cmt && cmt.skill) || null;

        // nearby hostiles (< 16b): count + up to 3 distinct Chinese names
        let hostiles = 0; const names = [];
        try {
            for (const id in bot.entities) {
                const e = bot.entities[id];
                if (e && e.kind === 'Hostile mobs' && e.position && p.distanceTo(e.position) < 16) {
                    hostiles++;
                    const nm = STATUS_MOB_CN[e.name] || e.name;
                    if (nm && names.indexOf(nm) < 0 && names.length < 3) names.push(nm);
                }
            }
        } catch (e) {}

        const hpTxt = hp >= 20 ? '血是满的' : hp >= 15 ? '血挺足' : hp >= 10 ? '半血左右' : hp >= 6 ? '血不多了' : '快没血了';
        const foodTxt = food >= 18 ? '吃得很饱' : food >= 12 ? '食物中等' : food >= 6 ? '有点饿' : '很饿了';
        const svnActive = (bot._surviveNowUntil && Date.now() < bot._surviveNowUntil)
            || skill === 'surviveNow' || kind === 'SURVIVE_NOW';

        const act = svnActive
            ? '情况紧张，我在保命自救（吃东西/打怪/挖坑避险/找床过夜，尽快脱困）'
            : this._activityPhrase(kind, skill, y);

        const dimSuffix = dim === 'the_nether' ? '（下界）' : dim === 'the_end' ? '（末地）' : '';
        const hostSuffix = hostiles > 0
            ? `，附近有 ${hostiles} 只怪${names.length ? `（${names.join('、')}）` : ''}`
            : '，周围没怪';
        const text = `${act}。现在在 ${x},${y},${z}${dimSuffix}，${night ? '夜里' : '白天'}，${hpTxt}、${foodTxt}${hostSuffix}。`;

        return { text, kind, skill, pos: [x, y, z], hp, food, hostiles, night, dim };
    }

    _activityPhrase(kind, skill, y) {
        // 1) leaf skill (most immediate) — but umbrella skills aren't in the table → fall to kind
        if (skill && STATUS_SKILL_CN[skill]) return `我${STATUS_SKILL_CN[skill]}`;
        // 2) y-dependent mining goals: name the depth band
        if (kind === 'GET_DIAMOND') return `我在 y${y} 挖钻石`;
        if (kind === 'GO_UNDERGROUND' || kind === 'DUSK_MINE_NIGHT' || kind === 'MINE_THROUGH_NIGHT') {
            const band = y < 0 ? '钻石带' : y <= 20 ? '铁/煤带' : '浅层';
            return `我在 y${y} 下矿挖矿石（${band}）`;
        }
        // 3) goal kind → human phrase
        if (kind && STATUS_KIND_CN[kind]) return `我${STATUS_KIND_CN[kind]}`;
        // 4) fallbacks: never emit a bare machine token — and never surface an umbrella
        //    skill name (prepNether/… is exactly the "废话" the user rejected).
        const umbrella = /^(prepNether|missionNether|autoProgress|achieve|diagBusy)$/.test(skill || '');
        if (skill && !umbrella) return `我在执行「${skill}」`;
        if (kind) return `我在推进目标「${kind}」`;
        return '我在按计划推进（凑装备、找资源）';
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
        /* eslint-disable no-unreachable */
        try {
            // CameraProc isolates the GL renderer in a child process (crash-safe).
            // It exposes the same {.on('ready'), .capture() -> base64 jpeg} surface
            // we rely on below, so the rest of the screenshot loop is unchanged.
            // Lazy-loaded ONLY here (screenshots enabled) so the prismarine-viewer /
            // headless-gl chain is never imported at startup.
            import('../agent/vision/camera_proc.js').then(({ CameraProc }) => {
                this.camera = new CameraProc(agent.bot, `./bots/${agent.name}/screenshots/`);
                this.camera.on('ready', () => {
                    console.log('Camera initialized for WebSocket screenshots (forced initialization)');
                    // Wait a bit more for bot to be fully ready before starting screenshots
                    setTimeout(() => {
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

    async runSkill(skillName, args) {
        if (!this.agent || !this.agent.bot) {
            this.broadcast({ type: 'skill_result', skill: skillName, ok: false, error: 'no agent online' });
            return;
        }
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
        try { if (this.agent.self_prompter && this.agent.self_prompter.isActive()) this.agent.self_prompter.stop(false); } catch (e) {}
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
    broadcastAgentResponse(response) {
        console.error('🤖Broadcasting log message:', response);
        this.broadcast({
            type: 'log',
            message: response
        });

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
        if (this.debugChatInterval) {
            clearInterval(this.debugChatInterval);
            this.debugChatInterval = null;
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
