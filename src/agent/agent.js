import { History } from './history.js';
import { Coder } from './coder.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import { initModes } from './modes.js';
import { initBot } from '../utils/mcdata.js';
import { containsCommand, commandExists, executeCommand, truncCommandMessage, isAction, blacklistCommands } from './commands/index.js';
import { ActionManager } from './action_manager.js';
import { NPCContoller } from './npc/controller.js';
import { MemoryBank } from './memory_bank.js';
import { SelfPrompter } from './self_prompter.js';
import { createFramework } from './framework/index.js';
import { installVineUnstick } from './library/vine_unstick.js';
import convoManager from './conversation.js';
import { handleTranslation, handleEnglishTranslation } from '../utils/translator.js';
// NOTE (local deploy): addBrowserViewer import removed — it is HARD-DISABLED below
// (its only call site is commented out) and statically importing browser_viewer.js
// pulls in prismarine-viewer, whose require/import mix crashes Node's ESM/CJS loader
// (ERR_INTERNAL_ASSERTION) at startup. Re-add after building headless-gl if you want it.
import { serverProxy, sendOutputToServer } from './mindserver_proxy.js';
import settings from './settings.js';
import { Task } from './tasks/tasks.js';
import { speak } from './speak.js';
import { wsServer } from '../websocket/ws_server.js';
import { log, validateNameFormat, handleDisconnection } from './connection_handler.js';
import fs from 'fs';

export class Agent {
    async start(load_mem=false, init_message=null, count_id=0) {
        this.last_sender = null;
        this.count_id = count_id;
        this.taskCompleted = false; // Initialize task completion flag
        this.reconnectAttempts = 0; // Initialize reconnect attempts counter
        // Retry forever. End users' standard flow is "start N.E.K.O. first,
        // then open Minecraft and Open-to-LAN" — capping at N attempts
        // (formerly 10, ~3 minutes wall clock) would self-kill the agent
        // before they finish picking a world. The mindserver UI / launcher
        // still provides an explicit stop path, so an infinite retry loop
        // isn't unkillable.
        this.maxReconnectAttempts = Infinity;
        this.reconnectBaseDelay = 3000; // Base delay for reconnection (3 seconds)
        this.load_mem = load_mem; // Save load_mem parameter for reconnection
        this._disconnectHandled = false;
        
        // Initialize components with more detailed error handling
        this.actions = new ActionManager(this);
        this.prompter = new Prompter(this, settings.profile);
        this.name = (this.prompter.getName() || '').trim();
        console.log(`Initializing agent ${this.name}...`);

        const nameCheck = validateNameFormat(this.name);
        if (!nameCheck.success) {
            log(this.name, nameCheck.msg);
            process.exit(1);
            return;
        }

        this.history = new History(this);
        this.coder = new Coder(this);
        this.npc = new NPCContoller(this);
        this.memory_bank = new MemoryBank();
        this.self_prompter = new SelfPrompter(this);
        convoManager.initAgent(this);
        await this.prompter.initExamples();

        // load mem first before doing task
        let save_data = null;
        if (load_mem) {
            save_data = this.history.load();
        }
        let taskStart = null;
        if (save_data) {
            taskStart = save_data.taskStart;
        } else {
            taskStart = Date.now();
        }
        this.task = new Task(this, settings.task, taskStart);
        this.blocked_actions = settings.blocked_actions.concat(this.task.blocked_actions || []);
        blacklistCommands(this.blocked_actions);

        console.log(this.name, 'logging into minecraft...');
        await this.initBot();

        initModes(this);
    }

    async _setupEventHandlers(save_data, init_message) {
        const ignore_messages = [
            "Set own game mode to",
            "Set the time to",
            "Set the difficulty to",
            "Teleported ",
            "Set the weather to",
            "Gamerule "
        ];
        
        const respondFunc = async (username, message) => {
            if (message === "") return;
            if (username === this.name) return;
            if (settings.only_chat_with.length > 0 && !settings.only_chat_with.includes(username)) return;
            try {
                if (ignore_messages.some((m) => message.startsWith(m))) return;

                this.shut_up = false;

                console.log(this.name, 'received message from', username, ':', message);

                if (convoManager.isOtherAgent(username)) {
                    console.warn('received whisper from other bot??')
                }
                else {
                    let translation = await handleEnglishTranslation(message);
                    this.handleMessage(username, translation);
                }
            } catch (error) {
                console.error('Error handling message:', error);
            }
        }

		this.respondFunc = respondFunc;

        this.bot.on('whisper', respondFunc);
        
        this.bot.on('chat', (username, message) => {
            if (serverProxy.getNumOtherAgents() > 0) return;
            // only respond to open chat messages when there are no other agents
            respondFunc(username, message);
        });

        // Set up auto-eat
        this.bot.autoEat.options = {
            priority: 'foodPoints',
            startAt: 14,
            bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken"]
        };

        if (save_data?.self_prompt) {
            if (init_message) {
                this.history.add('system', init_message);
            }
            await this.self_prompter.handleLoad(save_data.self_prompt, save_data.self_prompting_state);
        }
        if (save_data?.last_sender) {
            this.last_sender = save_data.last_sender;
            if (convoManager.otherAgentInGame(this.last_sender)) {
                const msg_package = {
                    message: `You have restarted and this message is auto-generated. Continue the conversation with me.`,
                    start: true
                };
                convoManager.receiveFromBot(this.last_sender, msg_package);
            }
        }
        else if (init_message) {
            await this.handleMessage('system', init_message, 2);
        }
        else {
            // No init message, join silently
        }
    }

    checkAllPlayersPresent() {
        if (!this.task || !this.task.agent_names) {
          return;
        }

        const missingPlayers = this.task.agent_names.filter(name => !this.bot.players[name]);
        if (missingPlayers.length > 0) {
            console.log(`Missing players/bots: ${missingPlayers.join(', ')}`);
            this.cleanKill('Not all required players/bots are present in the world. Exiting.', 4);
        }
    }

    requestInterrupt() {
        this.bot.interrupt_code = true;
        this.bot.stopDigging();
        this.bot.collectBlock.cancelTask();
        this.bot.pathfinder.stop();
        this.bot.pvp.stop();
    }

    clearBotLogs() {
        this.bot.output = '';
        this.bot.interrupt_code = false;
    }

    shutUp() {
        this.shut_up = true;
        if (this.self_prompter.isActive()) {
            this.self_prompter.stop(false);
        }
        convoManager.endAllConversations();
    }

    // ★C344 (T-0071): assert /gamerule keepInventory true AND VERIFY it actually took, instead of the
    // old "send it and assume success" self-deception (实锤 06-25 死后掉光物品 ⇒ 命令被静默拒, keepInv
    // 仍 OFF)。mineflayer 不暴露 gamerule 当前值, 所以唯一可靠的运行时校验 = 监听服务器对该命令的回应:
    //   • 成功 → translate key commands.gamerule.set, 文本含 "Game rule …" / "has been updated" / 中文
    //     "游戏规则 … 更新"。记一行确认。
    //   • 拒绝 → commands.help.failed / "do not have permission" / "Unknown or incomplete command"。立即
    //     写 events.log 告警。
    //   • 静默拒 (LAN 未开 allow-cheats 的典型) → 一条回应都没有 → 6s 超时后写同样告警。
    // 告警行带明确"用户世界层操作"指引, 监工/用户据此处置。幂等: 旧探针未结束就先拆掉再挂新的。
    _assertKeepInventory() {
        const b = this.bot;
        if (!b) return;
        const evt = (line) => { try { fs.appendFileSync('bots/_supervisor/events.log', `[${new Date().toISOString()}] ${line}\n`); } catch (_e) {} };
        // tear down any prior probe (e.g. a reconnect before the previous one timed out)
        if (this._keepInvProbe) { try { b.removeListener('messagestr', this._keepInvProbe.onMsg); } catch (_e) {} try { clearTimeout(this._keepInvProbe.timer); } catch (_e) {} this._keepInvProbe = null; }
        const probe = { settled: false, onMsg: null, timer: null };
        const settle = (ok, why) => {
            if (probe.settled) return;
            probe.settled = true;
            try { b.removeListener('messagestr', probe.onMsg); } catch (_e) {}
            try { clearTimeout(probe.timer); } catch (_e) {}
            this._keepInvProbe = null;
            if (ok) {
                console.log('★C344 keepInventory VERIFIED ON (T-0071):', why);
                evt(`KEEPINV OK — /gamerule keepInventory true verified ON (${why})`);
            } else {
                console.warn('★C344 keepInventory NO-OP (T-0071):', why);
                evt(`KEEPINV NO-OP — /gamerule keepInventory true did NOT take (${why}). Bot likely lacks op / LAN cheats OFF → every death drops the whole kit (iron→stone relapse). NEEDS WORLD-LEVEL ACTION: re-open the world to LAN with "Allow Cheats: ON" (or /op the bot, or set keepInventory at world creation).`);
            }
        };
        probe.onMsg = (message, _pos, jsonMsg) => {
            try {
                const txt = (message || '').toString();
                const key = (jsonMsg && jsonMsg.translate) || '';
                // only react to messages about THIS gamerule (avoid latching onto an unrelated /gamerule)
                const aboutKeepInv = /keepInventory/i.test(txt) || /keepInventory/i.test(JSON.stringify(jsonMsg && jsonMsg.with || ''));
                // success: vanilla "commands.gamerule.set" / EN "has been updated to true" / 中文 "更新为 true"
                if (key === 'commands.gamerule.set' || (aboutKeepInv && /(has been updated|updated to true|更新为|已更新|已将.*更新)/i.test(txt))) {
                    settle(true, key || txt.slice(0, 80));
                    return;
                }
                // explicit rejection
                if (key === 'commands.help.failed' || /(do not have permission|don't have permission|没有.*权限|无权)/i.test(txt)
                    || /(Unknown or incomplete command|Unknown command|未知.*命令|命令.*无效)/i.test(txt)) {
                    settle(false, `rejected: ${(key || txt.slice(0, 80))}`);
                    return;
                }
            } catch (_e) {}
        };
        b.on('messagestr', probe.onMsg);
        // 6s silent-rejection timeout (LAN allow-cheats OFF ⇒ no response at all)
        probe.timer = setTimeout(() => settle(false, 'no server response in 6s (silent reject — allow-cheats likely OFF)'), 6000);
        this._keepInvProbe = probe;
        try { b.chat('/gamerule keepInventory true'); console.log('★C344 sent /gamerule keepInventory true, awaiting server ack (T-0071)'); }
        catch (e) { settle(false, `chat() threw: ${e && e.message}`); }
    }

    // ★C333 (T-0065): see the call site in the spawn handler for the full rationale. One centralized
    // chokepoint (用户: 门要加公共入口不是单个调用方) so EVERY death_log consumer (chopWood/migrate/
    // prepNether/achieve死区, botwatch hotspot…) sees a clean log on a new world without per-reader
    // edits. Pure-additive, swallow all errors — a miss just leaves the old behavior, never worse.
    async _archiveStaleWorldStateOnSwitch() {
        const b = this.bot;
        const dir = 'bots/_supervisor/';
        const isNaked = () => {
            const items = (b.inventory ? b.inventory.items() : []) || [];
            const armorN = b.inventory ? [5, 6, 7, 8].filter(s => b.inventory.slots[s]).length : 0;
            const hasTool = items.some(i => /_pickaxe$|_axe$|_sword$|_shovel$|_hoe$/.test(i.name));
            const hasShield = items.some(i => i.name === 'shield') || (b.inventory && b.inventory.slots[45] && b.inventory.slots[45].name === 'shield');
            const totalItems = items.reduce((s, i) => s + (i.count || 0), 0);
            // fresh character: no armor worn, no tool/weapon/shield, only a tiny scrap of starter blocks
            return armorN === 0 && !hasTool && !hasShield && totalItems <= 16;
        };
        if (!isNaked()) return;                                  // has gear → same-world reconnect, never reset
        // (a) defeat inventory LOAD-LAG: a real fresh char is still naked after 5s; lag has resolved by then.
        await new Promise((r) => setTimeout(r, 5000));
        if (!isNaked()) return;                                  // gear loaded in → was just lag, not a new world
        // read newest death to apply guard (b)
        let recent = null;
        try {
            const lines = fs.readFileSync(dir + 'death_log.jsonl', 'utf8').trim().split('\n').filter(Boolean);
            if (lines.length) {
                const last = JSON.parse(lines[lines.length - 1]);
                const ageMin = (Date.now() - new Date(last.ts).getTime()) / 60000;
                const p = b.entity && b.entity.position;
                const near = !!(p && typeof last.x === 'number' && Math.hypot(last.x - p.x, last.z - p.z) < 24);
                recent = { ageMin, near, n: lines.length };
            }
        } catch (e) { recent = null; }
        if (!recent || recent.n < 1) return;                    // nothing to contaminate
        // (b) same-world bot that died naked moments ago → its log is still relevant, keep it.
        if (recent.ageMin < 10 && recent.near) return;
        const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
        const archived = [];
        for (const f of ['death_log.jsonl', 'landmarks.json', 'bed.json']) {
            try { if (fs.existsSync(dir + f)) { fs.renameSync(dir + f, `${dir}${f}.${ts}.oldworld`); archived.push(f); } } catch (e) {}
        }
        try {
            fs.appendFileSync(dir + 'progress.txt',
                `[${new Date().toISOString()}] [world-scope] ★C333 NEW-WORLD detected (naked fresh char, armor=0/tools=0; newest death ${recent.ageMin.toFixed(0)}min ago near=${recent.near}) → archived ${archived.join(',') || 'none'} (phantom-hazard reset)\n`);
        } catch (e) {}
        console.log(`🌍 C333 world-switch: archived stale coordinate state [${archived.join(',')}] — naked fresh character, old log won't poison death-zones`);
    }

    async initBot() {
        this.bot = initBot(this.name);
        this._disconnectHandled = false;
        
        // Increase max listeners to prevent warnings when multiple systems listen to events
        // This is necessary because bot events are listened to by: agent, mindserver_proxy, 
        // action_manager, vision, websocket server, prismarine-viewer, and various plugins
        this.bot.setMaxListeners(50);
        
        this.setupBotEventHandlers();
    }

    setupBotEventHandlers() {
        this.bot.on('login', () => {
            console.log(this.name, 'logged in!');
            serverProxy.login();
            
            // Set skin for profile, requires Fabric Tailor. (https://modrinth.com/mod/fabrictailor)
            if (this.prompter.profile.skin)
                this.bot.chat(`/skin set URL ${this.prompter.profile.skin.model} ${this.prompter.profile.skin.path}`);
            else
                this.bot.chat(`/skin clear`);
        });

        const spawnTimeoutDuration = settings.spawn_timeout || 30;
        const spawnTimeout = setTimeout(() => {
            const msg = `Bot has not spawned after ${spawnTimeoutDuration} seconds. Exiting.`;
            log(this.name, msg);
            process.exit(1);
        }, spawnTimeoutDuration * 1000);
        
        this.bot.once('spawn', async () => {
            try {
                clearTimeout(spawnTimeout);
                // HARD-DISABLED (unconditional): the prismarine-viewer browser renderer
                // crashes the agent subprocess (exit 1) → auto-restart → ~15s offline → bot
                // dies AFK. Env-gating didn't survive subprocess restarts, so the viewer (and
                // the churn) came back on every restart. Never start it. (Visual feed gone;
                // bot staying alive matters more. To restore the feed, re-enable this line.)
                // addBrowserViewer(this.bot, this.count_id);
                console.log('🛑 addBrowserViewer HARD-DISABLED (no renderer, no churn)');
                console.log('Initializing vision intepreter...');
                this.vision_interpreter = new VisionInterpreter(this, settings.allow_vision);

                // wait for a bit so stats are not undefined
                await new Promise((resolve) => setTimeout(resolve, 1000));
                
                console.log(`${this.name} spawned.`);
                this.clearBotLogs();

                // ★C332-A / C344 (T-0071): keepInventory 必须【可靠常 ON】,不能只在 devGive 救援路径临时设。
                // 新开的世界默认 keepInventory OFF → 每次死亡掉光 iron kit → tier relapse(把 T-0068 夜死
                // 耦合进 T-0060 reset-loop 的放大器)。devGive(skills/devGive.js:48)只在"救援"时设,而 bot
                // 一旦 bootstrap 越过救援触发就再不设 → keepInv 仍关。giveKit 也没设。整个"死亡成本≈0"
                // 策略 + 远征廉价(C269)都建立在 keepInv ON 上。故在【每次 spawn】(世界加载/重连/进程重启)
                // 断言一次,幂等,中途换世界也会重新断言。需开 cheats(蓝图: Normal+keepInventory+cheats)。
                //
                // ★C344 (T-0071 决定性验收): 旧码"发了就当成功"是自欺 — 实锤 06-25 死后掉光物品 (只剩
                // kelp+sand) 证明 keepInventory 当时仍 OFF, 即 /gamerule 被服务器静默拒 (bot 无 op 权 /
                // LAN 未勾 allow-cheats)。mineflayer 不暴露 gamerule 当前值, 唯一可靠的运行时校验 = 监听
                // 服务器对该命令的【回应消息】: 成功广播 commands.gamerule.set ("Game rule … updated"),
                // 拒绝回 commands.help.failed / "You do not have permission" / "Unknown … command", 静默拒
                // 则一条回应都没有。所以这里发命令后挂一次性 messagestr 探针: 收到成功→记确认; 收到拒绝
                // 或 6s 超时无回应→写 events.log 告警 (KEEPINV NO-OP), 监工/用户据此判定"必须在 MC 世界层
                // 开 cheats / 给 bot op"。绝不再"发了就当成功"。
                try { this._assertKeepInventory(); } catch (e) { console.warn('keepInventory assert failed:', e && e.message); }

                // ★C333 (T-0065): WORLD-SWITCH coordinate-state reset. death_log deaths / landmarks /
                // bed anchor are world-LOCAL but persisted GLOBALLY — on a fresh world they poison
                // death-zone & site-scoring with PHANTOM hazards from the previous world (用户实证: 新
                // 世界开局乱挖+横跳, 129 旧死有 54 条落在新生点 16 格内 → chopWood 死区误判 → 无限背撤).
                // No world seed is exposed (this mineflayer's game.js sets no hashedSeed) and this LAN
                // server pins bot.spawnPoint to (0,0), so neither seed nor spawn-coord identifies the
                // world. The robust available signal: a SAME-world process reconnect PRESERVES the
                // inventory (the world save persists player data — confirmed live: a reboot reconnect
                // kept full iron armor), so a NAKED fresh character at startup ⇒ new world / new char.
                // Two false-positive guards: (a) inventory LOAD-LAG — re-confirm naked after 5s (lag
                // resolves in <5s; a real fresh char stays naked); (b) SAME-world bot that died naked
                // right before restart — skip reset when the newest death is fresh(<10min)+near(<24b),
                // that log is still relevant. Archive (rename .oldworld), don't delete — forensics.
                try { await this._archiveStaleWorldStateOnSwitch(); } catch (e) { console.warn('world-scope reset failed:', e && e.message); }

                // Start WebSocket server and connect this agent
                if (this.count_id === 0) { // Only start server for the first agent
                    wsServer.start();
                }
                wsServer.setAgent(this);
              
                this._setupEventHandlers(this.load_mem ? this.history.load() : null, null);
                this.startEvents();
              
                if (!this.load_mem) {
                    if (settings.task) {
                        this.task.initBotTask();
                        this.task.setAgentGoal();
                    }
                } else {
                    // set the goal without initializing the rest of the task
                    if (settings.task) {
                        this.task.setAgentGoal();
                    }
                }

                await new Promise((resolve) => setTimeout(resolve, 10000));
                this.checkAllPlayersPresent();

            } catch (error) {
                console.error('Error in spawn event:', error);
                process.exit(0);
            }
        });

        // Bot event handlers
        this.bot.on('error', (err) => {
            if (String(err).includes('Duplicate') || String(err).includes('ECONNREFUSED')) {
                void this.handleBotDisconnection(err);
            } else {
                log(this.name, `[LoginGuard] Connection Error: ${String(err)}`);
            }
        });

        this.bot.on('end', async (reason) => {
            await this.handleBotDisconnection(reason);
        });

        this.bot.on('death', () => {
            console.log(`${this.name} died, stopping current actions...`);
            this.actions.cancelResume();
            this.actions.stop();
            // NOTE: do NOT set a death-abort flag here. An earlier attempt (bot.death_abort
            // polled by prepNether) backfired: at a death-prone spawn it created a tight
            // re-arm/​bail loop (prepNether bailed instantly every 2s, never grinding, frozen
            // for 20+ min even in daylight). The running supervised skill survives the
            // in-place respawn and resumes on its own — that's the behavior that previously
            // got the bot all the way to diamonds. Leave it alone.

            // Fire a critical-severity alert before the task_finished
            // broadcast below. Rationale: task_finished is only meaningful
            // to the plugin when a minecraft_task is pending; otherwise it
            // gets consumed as a stale frame and the dialog LLM never
            // hears about the death. The alert path is unconditional —
            // dialog LLM is informed regardless of pending state.
            try {
                const deathCause = this._inferDamageCause();
                wsServer.broadcast({
                    type: 'alert',
                    severity: 'critical',
                    text: '角色阵亡。物品已掉落原地，即将重生。',
                    hp: 0,
                    cause: deathCause,
                    timestamp: Date.now(),
                });
            } catch (e) {
                console.warn('death alert broadcast failed:', e);
            }

            // Report task interruption due to death
            wsServer.onTaskCompleted({
                status: 'interrupted',
                message: '任务因死亡而中断',
                score: 0,
                reason: 'death'
            });
            
            // Monitor respawn to ensure bot position is valid after death
            this.monitorRespawn();
        });

        this.bot.on('kicked', async (reason) => {
            await this.handleBotDisconnection(reason);
        });

        this.bot.on('messagestr', async (message, _, jsonMsg) => {
            if (jsonMsg.translate && jsonMsg.translate.startsWith('death') && message.startsWith(this.name)) {
                console.log('Agent died: ', message);
                let death_pos = this.bot.entity.position;
                this.memory_bank.rememberPlace('last_death_position', death_pos.x, death_pos.y, death_pos.z);
                // Persist the death spot to disk so the supervised grind skill can do a
                // bounded "corpse run" on respawn and reclaim the gear we just dropped
                // (items despawn ~5 min). The skill consumes (deletes) this file once.
                try {
                    // v = corpse VALUE flag. Three junk-corpse runs in one day burned entire
                    // daytime rebuild windows (food 20→8 hiking to recover 19 tuff) — the trip
                    // itself then killed the bot twice (203 water, 211 nightfall). Only iron+
                    // tools/weapons, diamonds, or a real ingot stash justify the journey;
                    // cobble/planks re-gather faster than the walk.
                    let v = false;
                    try {
                        const inWaterAtDeath = (() => { try { const bl = this.bot.blockAt(death_pos); return !!bl && /water/.test(bl.name || ''); } catch (e) { return false; } })();
                        const items2 = (this.bot.inventory ? this.bot.inventory.items() : []) || [];
                        v = items2.some(i =>
                            /^(iron|diamond|netherite)_(sword|pickaxe|axe|shovel|helmet|chestplate|leggings|boots)$/.test(i.name)
                            || i.name === 'shield' || i.name === 'diamond' || i.name === 'obsidian' || i.name === 'flint_and_steel'
                            || /_bed$/.test(i.name) || i.name === 'white_wool'   // 床/羊毛=重生锚级资产,值得跑
                            || (i.name === 'iron_ingot' && i.count >= 2) || (i.name === 'raw_iron' && i.count >= 4));
                        fs.writeFileSync('bots/_supervisor/death_pos.json',
                            JSON.stringify({ x: death_pos.x, y: death_pos.y, z: death_pos.z, t: Date.now(), v, inWater: inWaterAtDeath }));
                    } catch (e2) {
                        fs.writeFileSync('bots/_supervisor/death_pos.json',
                            JSON.stringify({ x: death_pos.x, y: death_pos.y, z: death_pos.z, t: Date.now() }));
                    }
                } catch (e) { console.warn('death_pos write failed:', e); }
                // ★COMBAT-EXPERIENCE RECORDER (用户: 死亡时自动记战斗快照,积累成可学习的"何时打/何时溜"
                // 数据集). Append one JSON line per death to death_log.jsonl — the situation that
                // killed us: cause, depth/underground, water, light, nearby hostile types+counts+
                // distances, our gear (sword/shield/armor), time, and what we were doing. The
                // fight-vs-flee policy reads this to learn which situations are deadly (→ avoid/
                // flee) vs winnable (→ fight). Captured at the death message: the killer mobs are
                // still right here, gear/pos still readable.
                try {
                    const b = this.bot, p = death_pos;
                    const y = Math.round(p.y);
                    let cause = 'unknown';
                    let mm;
                    if ((mm = /slain by ([A-Za-z ]+?)(?: using|\.|$)/.exec(message))) cause = mm[1].trim();
                    else if ((mm = /shot by ([A-Za-z ]+?)(?: using|\.|$)/.exec(message))) cause = 'shot:' + mm[1].trim();
                    else if (/blew up|blown up|intentional game design/i.test(message)) cause = 'creeper';
                    else if (/drown/i.test(message)) cause = 'drowning';
                    else if (/hit the ground|fell|doomed to fall|fly into a wall/i.test(message)) cause = 'fall';
                    else if (/lava|burn|in fire|fire tick/i.test(message)) cause = 'fire/lava';
                    else if (/suffocat/i.test(message)) cause = 'suffocation';
                    else if (/starv/i.test(message)) cause = 'starve';
                    const HRE = /zombie|skeleton|spider|creeper|witch|drowned|husk|stray|phantom|slime|enderman|pillager|vindicator|silverfish|cave_spider|warden|piglin|hoglin/i;
                    const hostiles = Object.values(b.entities || {})
                        .filter(e => e && e.position && e.name && HRE.test(e.name) && e.position.distanceTo(p) < 16)
                        .map(e => ({ name: e.name, dist: +e.position.distanceTo(p).toFixed(1) }))
                        .sort((a, x) => a.dist - x.dist).slice(0, 10);
                    const items = (b.inventory ? b.inventory.items() : []) || [];
                    const sword = items.find(i => /_sword$/.test(i.name));
                    const axe = items.find(i => /_axe$/.test(i.name));
                    const shield = items.some(i => i.name === 'shield') || (b.inventory && b.inventory.slots[45] && b.inventory.slots[45].name === 'shield');
                    const armorCount = b.inventory ? [5, 6, 7, 8].filter(s => b.inventory.slots[s]).length : 0;
                    let coveredAbove = 0;
                    try { for (let dy = 2; dy <= 9; dy++) { const blk = b.blockAt(p.offset(0, dy, 0)); if (blk && blk.boundingBox === 'block') coveredAbove++; } } catch (e) {}
                    let inWater = false; try { const bl = b.blockAt(p); inWater = !!bl && /water/.test(bl.name || ''); } catch (e) {}
                    const t = (b.time && b.time.timeOfDay) || 0;
                    const rec = {
                        ts: new Date().toISOString(), cause, y,
                        // x/z: without them fall deaths couldn't be clustered spatially —
                        // took a filmstrip dig to discover 196+197 were the SAME ravine.
                        x: Math.round(p.x), z: Math.round(p.z),
                        underground: y < 50 || coveredAbove >= 3, coveredAbove, inWater,
                        timeOfDay: t, isNight: t >= 13000 && t <= 23000,
                        hostileCount: hostiles.length, hostiles,
                        gear: { sword: sword ? sword.name : null, axe: axe ? axe.name : null, shield, armorCount },
                        action: (this.actions && this.actions.currentActionLabel) || null,
                    };
                    fs.appendFileSync('bots/_supervisor/death_log.jsonl', JSON.stringify(rec) + '\n');
                    console.log('💀 death snapshot recorded:', cause, `y=${y}`, `mobs=${hostiles.length}`, `gear=${rec.gear.sword ? 'sword' : 'no-sword'}/${shield ? 'shield' : 'no-shield'}`);
                } catch (e) { console.warn('death snapshot failed:', e.message); }
                // ADAPTIVE: if we FELL to death, leave a flag so the grind preps a water
                // bucket — the MLG water-clutch reflex (modes.js) needs a bucket as ammo.
                // We invest in a bucket only AFTER falling has actually killed us (learn).
                try {
                    if (/hit the ground|fell|doomed to fall|fly into a wall/i.test(message) ||
                        (jsonMsg.translate && /fell|fall|flyIntoWall/i.test(jsonMsg.translate))) {
                        fs.writeFileSync('bots/_supervisor/prep_water.json', JSON.stringify({ t: Date.now(), reason: 'fall_death' }));
                    }
                } catch (e) {}
            }
        });
    }

    async handleBotDisconnection(reason) {
        if (this._disconnectHandled) return;
        this._disconnectHandled = true;

        const { msg } = handleDisconnection(this.name, reason);

        // Debug output for bot disconnection
        console.log('\n🚨 ===== BOT DISCONNECTION DETECTED =====');
        console.log('🔗 Reason:', msg);
        console.log('⏰ Timestamp:', new Date().toISOString());
        console.log('🤖 Agent:', this.name);
        const attemptCapStr = Number.isFinite(this.maxReconnectAttempts) ? String(this.maxReconnectAttempts) : '∞';
        console.log('🔄 Reconnect attempts:', this.reconnectAttempts, '/', attemptCapStr);
        console.log('========================================\n');
        
        // Always send task_finished message when bot disconnects
        try {
            wsServer.onTaskCompleted({
                status: 'interrupted',
                message: '任务中断',
                score: 0,
                reason: reason
            });
            console.log('Task interrupted due to bot disconnection, task_finished message sent');
        } catch (error) {
            console.error('Failed to send task interruption message:', error);
        }

    // Try to reconnect if we haven't exceeded max attempts
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        const capStr = Number.isFinite(this.maxReconnectAttempts) ? `/${this.maxReconnectAttempts}` : '';
        console.log(`Attempting to reconnect bot (attempt ${this.reconnectAttempts}${capStr})...`);
        
        // Use exponential backoff with jitter for reconnection delay.
        // Cap at 10s (was 30s) so the "open Minecraft after agent started"
        // flow doesn't make the user wait half a minute between retries.
        const baseDelay = this.reconnectBaseDelay || 3000;
        const exponentialDelay = baseDelay * Math.pow(1.5, this.reconnectAttempts - 1);
        const maxDelay = 10000; // Maximum 10 seconds between retries
        const jitter = Math.random() * 1000; // Add up to 1 second random jitter
        const delay = Math.min(exponentialDelay, maxDelay) + jitter;
        
        console.log(`Waiting ${Math.round(delay / 1000)} seconds before reconnection...`);
        
        setTimeout(async () => {
            try {
                // Create new bot instance
                this.bot = initBot(this.name);
                this._disconnectHandled = false;
                
                // Re-initialize modes for the new bot instance
                initModes(this);
                
                this.setupBotEventHandlers();
                console.log(`✅ Bot reconnected successfully (attempt ${this.reconnectAttempts})`);
            } catch (error) {
                console.error(`❌ Reconnection attempt ${this.reconnectAttempts} failed:`, error);
                if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                    console.error('Max reconnection attempts reached. Killing agent process.');
                    this.cleanKill('Max reconnection attempts reached. Killing agent process.');
                }
            }
        }, delay);
    } else {
        console.error('Max reconnection attempts reached. Killing agent process.');
        this.cleanKill('Max reconnection attempts reached. Killing agent process.');
    }
    }

    async handleMessage(source, message, max_responses=null) {
        // ``lastConversationReply`` is the most recent free-text reply the
        // agent emitted while servicing this message — used by the WS bridge
        // to populate ``task_finished.message`` so the upstream plugin's
        // minecraft_task LLM tool returns useful commentary instead of an
        // empty string. Reset on every entry.
        let lastConversationReply = '';

        try {
            await this.checkTaskDone();
            if (!source || !message) {
                console.warn('Received empty message from', source);
                return false;
            }

            // SUPERVISED LOCK: while a supervisor-driven scripted skill (run_skill,
            // e.g. achieve) is in control of the bot, suppress AUTONOMOUS LLM
            // command generation — i.e. system self-prompts and the bot's own
            // self-prompt loop (death-recovery "!goToBed/!moveAway", idle wandering).
            // Without this the LLM brain issues !commands that go through
            // ActionManager.stop() -> requestInterrupt(), which preempts BOTH the
            // scripted skill AND the survival modes mid-action, so the bot thrashes
            // between mining/fleeing/fighting and gets killed. Tick-based modes
            // (self_defense/self_preservation/auto_eat) still run for survival.
            // User-typed commands (non-self_prompt) are still honored.
            if (this.supervised_skill && (source === 'system' || source === this.name)) {
                return false;
            }

            let used_command = false;
            if (max_responses === null) {
                max_responses = settings.max_commands === -1 ? Infinity : settings.max_commands;
            }
            if (max_responses === -1) {
                max_responses = Infinity;
            }

            const self_prompt = source === 'system' || source === this.name;
            const from_other_bot = convoManager.isOtherAgent(source);

            if (!self_prompt && !from_other_bot) { // from user, check for forced commands
                const user_command_name = containsCommand(message);
                if (user_command_name) {
                    if (!commandExists(user_command_name)) {
                        this.routeResponse(source, `Command '${user_command_name}' does not exist.`);
                        return false;
                    }
                    this.routeResponse(source, `*${source} used ${user_command_name.substring(1)}*`);
                    if (user_command_name === '!newAction') {
                        // all user-initiated commands are ignored by the bot except for this one
                        // add the preceding message to the history to give context for newAction
                        this.history.add(source, message);
                    }
                    let execute_res = await executeCommand(this, message);
                    if (execute_res) {
                        this.routeResponse(source, execute_res);
                        lastConversationReply = execute_res;
                    }
                    return true;
                }
            }

            if (from_other_bot)
                this.last_sender = source;

            // Now translate the message
            message = await handleEnglishTranslation(message);
            console.log('received message from', source, ':', message);

            const checkInterrupt = () => this.self_prompter.shouldInterrupt(self_prompt) || this.shut_up || convoManager.responseScheduledFor(source);

            let behavior_log = this.bot.modes.flushBehaviorLog().trim();
            if (behavior_log.length > 0) {
                const MAX_LOG = 500;
                if (behavior_log.length > MAX_LOG) {
                    behavior_log = '...' + behavior_log.substring(behavior_log.length - MAX_LOG);
                }
                behavior_log = 'Recent behaviors log: \n' + behavior_log;
                await this.history.add('system', behavior_log);
            }

            // Handle other user messages
            await this.history.add(source, message);
            this.history.save();

            if (!self_prompt && this.self_prompter.isActive()) // message is from user during self-prompting
                max_responses = 1; // force only respond to this message, then let self-prompting take over
            for (let i=0; i<max_responses; i++) {
                if (checkInterrupt()) break;
                let history = this.history.getHistory();
                let res = await this.prompter.promptConvo(history);

                console.log(`${this.name} full response to ${source}: ""${res}""`);

                if (res.trim().length === 0) {
                    console.warn('no response')
                    break; // empty response ends loop
                }

                let command_name = containsCommand(res);

                if (command_name) { // contains query or command
                    res = truncCommandMessage(res); // everything after the command is ignored
                    this.history.add(this.name, res);

                    if (!commandExists(command_name)) {
                        this.history.add('system', `Command ${command_name} does not exist.`);
                        console.warn('Agent hallucinated command:', command_name)
                        continue;
                    }

                    if (checkInterrupt()) break;
                    this.self_prompter.handleUserPromptedCmd(self_prompt, isAction(command_name));

                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();

                    if (settings.show_command_syntax === "full") {
                        this.routeResponse(source, res);
                    }
                    else if (settings.show_command_syntax === "shortened") {
                        // show only "used !commandname"
                        let chat_message = `*used ${command_name.substring(1)}*`;
                        if (pre_message.length > 0)
                            chat_message = `${pre_message}  ${chat_message}`;
                        this.routeResponse(source, chat_message);
                    }
                    else {
                        // no command at all
                        if (pre_message.trim().length > 0)
                            this.routeResponse(source, pre_message);
                    }

                    // Track the natural-language portion the agent emitted
                    // alongside its command so a "I'll grab some logs !collectBlocks(...)"
                    // turn still yields useful text in the final task_finished
                    // frame even though the loop continues after the command.
                    if (pre_message.length > 0) {
                        lastConversationReply = pre_message;
                    }

                    let execute_res = await executeCommand(this, res);

                    console.log('Agent executed:', command_name, 'and got:', execute_res);
                    used_command = true;

                    if (execute_res)
                        this.history.add('system', execute_res);
                    else
                        break;
                }
                else { // conversation response
                    this.history.add(this.name, res);
                    this.routeResponse(source, res);
                    lastConversationReply = res;
                    break;
                }

                this.history.save();
            }

            return used_command;
        } finally {
            // Wake the WS-injected task waiter (game_agent_minecraft plugin's
            // minecraft_task tool) when the response loop exits naturally.
            // Free-play mode (no settings.task) means checkTaskDone() at the
            // top of this function never fires; without this hook the plugin
            // would always hit its task_timeout_seconds and surface a
            // {status: "timeout"} to the LLM even on perfectly successful
            // tasks. The ``markChatTaskComplete`` call is a no-op when
            // currentTask is null (covers regular in-game chat from real
            // admin players, and the second invocation of nested handleMessage
            // calls where the outer call already consumed the slot).
            if (source === 'admin') {
                try {
                    // The mini LLM often emits just '\t' when it has no
                    // narrative to add (see neko.json's "respond with just
                    // a tab" prompt rule). That value is useless to the
                    // upstream LLM, so fall back to the last meaningful
                    // signal we have: the last command's action output,
                    // or the last system-recorded line, before letting
                    // markChatTaskComplete's '(no final reply)' kick in.
                    let reply = lastConversationReply;
                    const isUseful = (s) => typeof s === 'string'
                        && s.trim().length > 0
                        && s.trim() !== '\\t'
                        && s.trim() !== '\t';
                    if (!isUseful(reply)) {
                        try {
                            const hist = this.history.getHistory();
                            for (let i = hist.length - 1; i >= 0; i--) {
                                const entry = hist[i];
                                const content = (entry && entry.content) || '';
                                // Prefer system-injected action output (from
                                // executeCommand) — that's typically the
                                // most concrete description of what just
                                // happened. Skip the user/admin's own task
                                // text and the agent's hollow '\t' replies.
                                if (entry && entry.role === 'system' && isUseful(content)) {
                                    reply = content;
                                    break;
                                }
                            }
                        } catch (_) { /* history shape may vary; ignore */ }
                    }
                    wsServer.markChatTaskComplete(reply);
                } catch (e) {
                    console.error('markChatTaskComplete failed:', e);
                }
            }
        }
    }

    async routeResponse(to_player, message) {
        if (this.shut_up) return;
        let self_prompt = to_player === 'system' || to_player === this.name;
        if (self_prompt && this.last_sender) {
            // this is for when the agent is prompted by system while still in conversation
            // so it can respond to events like death but be routed back to the last sender
            to_player = this.last_sender;
        }

        if (convoManager.isOtherAgent(to_player) && convoManager.inConversation(to_player)) {
            // if we're in an ongoing conversation with the other bot, send the response to it
            convoManager.sendToBot(to_player, message);
        }
        else {
            // otherwise, use open chat
            this.openChat(message);
            // note that to_player could be another bot, but if we get here the conversation has ended
        }
    }

    async openChat(message) {
        let to_translate = message;
        let remaining = '';
        let command_name = containsCommand(message);
        let translate_up_to = command_name ? message.indexOf(command_name) : -1;
        if (translate_up_to != -1) { // don't translate the command
            to_translate = to_translate.substring(0, translate_up_to);
            remaining = message.substring(translate_up_to);
        }
        message = (await handleTranslation(to_translate)).trim() + " " + remaining;
        // newlines are interpreted as separate chats, which triggers spam filters. replace them with spaces
        message = message.replaceAll('\n', ' ');

        if (settings.only_chat_with.length > 0) {
            for (let username of settings.only_chat_with) {
                this.bot.whisper(username, message);
            }
        }
        else {
            if (settings.speak) {
                speak(to_translate, this.prompter.profile.speak_model);
            }
            if (settings.chat_ingame) {this.bot.chat(message);}
            sendOutputToServer(this.name, message);
        }
        
        // Broadcast agent response to WebSocket clients
        wsServer.broadcastAgentResponse(message);
    }

    startEvents() {
        const firstStart = !this.eventsInitialized;
        this.eventsInitialized = true;

        // Periodic memory cleanup every 5 minutes
        if (firstStart) {
            this._memoryCleanupInterval = setInterval(() => {
                this._performMemoryCleanup();
            }, 5 * 60 * 1000);
        }

        // Custom events
        this.bot.on('time', () => {
            if (this.bot.time.timeOfDay == 0)
            this.bot.emit('sunrise');
            else if (this.bot.time.timeOfDay == 6000)
            this.bot.emit('noon');
            else if (this.bot.time.timeOfDay == 12000)
            this.bot.emit('sunset');
            else if (this.bot.time.timeOfDay == 18000)
            this.bot.emit('midnight');
        });

        let prev_health = this.bot.health;
        this.bot.lastDamageTime = 0;
        this.bot.lastDamageTaken = 0;
        // Per-severity cooldown so a continuous combat (zombie hitting bot
        // every second) doesn't fire an alert each tick. The dialog LLM only
        // needs to know "you're being hurt" once, not 12x. Critical alerts
        // (HP at the edge of death) reset the cooldown so they can fire even
        // if a warning-level alert just fired moments ago.
        const ALERT_COOLDOWN_MS = 10000;
        let lastAlertAt = { warn: 0, critical: 0 };
        this.bot.on('health', () => {
            const newHp = this.bot.health;
            if (newHp < prev_health) {
                this.bot.lastDamageTime = Date.now();
                this.bot.lastDamageTaken = prev_health - newHp;

                // Decide alert severity. Thresholds tuned for survival mode:
                //  - HP ≤ 6 (3 hearts): critical, one more hit could be fatal
                //  - HP < prev:        warn, took damage (but not in danger zone)
                const now = Date.now();
                let severity = null;
                if (newHp <= 6) {
                    severity = 'critical';
                } else if (this.bot.lastDamageTaken >= 1) {
                    severity = 'warn';
                }
                if (severity) {
                    const last = lastAlertAt[severity] || 0;
                    if (now - last >= ALERT_COOLDOWN_MS) {
                        lastAlertAt[severity] = now;
                        const hpInt = Math.max(0, Math.round(newHp));
                        const text = severity === 'critical'
                            ? `角色生命值告急：${hpInt}/20，再受一次伤可能致命。`
                            : `角色受到伤害：失去 ${this.bot.lastDamageTaken.toFixed(0)} HP，当前 ${hpInt}/20。`;
                        const cause = this._inferDamageCause();
                        try {
                            wsServer.broadcast({
                                type: 'alert',
                                severity,
                                text,
                                hp: newHp,
                                food: this.bot.food,
                                cause,
                                timestamp: now,
                            });
                        } catch (e) {
                            console.warn('alert broadcast failed:', e);
                        }
                    }
                }
            }
            prev_health = newHp;
        });
        // Bot event handlers are now in setupBotEventHandlers()
        this.bot.on('messagestr', async (message, _, jsonMsg) => {
            if (jsonMsg.translate && jsonMsg.translate.startsWith('death') && message.startsWith(this.name)) {
                console.log('Agent died: ', message);
                let death_pos = this.bot.entity.position;
                this.memory_bank.rememberPlace('last_death_position', death_pos.x, death_pos.y, death_pos.z);
                let death_pos_text = null;
                if (death_pos) {
                    death_pos_text = `x: ${death_pos.x.toFixed(2)}, y: ${death_pos.y.toFixed(2)}, z: ${death_pos.z.toFixed(2)}`;
                }
                let dimention = this.bot.game.dimension;
                this.handleMessage('system', `You died at position ${death_pos_text || "unknown"} in the ${dimention} dimension with the final message: '${message}'. Your place of death is saved as 'last_death_position' if you want to return. Previous actions were stopped and you have respawned.`);
            }
        });
        this.bot.on('idle', () => {
            this.bot.clearControlStates();
            this.bot.pathfinder.stop(); // clear any lingering pathfinder
            this.bot.modes.unPauseAll();
            setTimeout(() => {
                if (this.isIdle()) {
                    this.actions.resumeAction();
                }
            }, 1000);
        });

        // Init NPC controller
        this.npc.init();

        if (firstStart) {
            // Framework v2 kernel (survival/companion decision loop). Feature-flagged
            // OFF by default — when disabled tick() is a no-op and the existing
            // missionNether path is untouched. See docs/framework-v2-scaffold.md.
            // observe:true turns on S3-shadow logging (proposer vs live skill → framework-shadow.log)
            // WITHOUT enabling the decision loop — gathers parity data before any live cutover.
            //
            // ── P1 (speedrun): make the enable/shadow flags env-driven so the launcher can
            //    drive the tier chain LIVE without a code edit, while the SAFE default (off /
            //    shadow-only) is preserved when the env vars are unset:
            //      MC_FRAMEWORK_V2=1        → enable the kernel decision loop (also read in kernel.js)
            //      MC_FRAMEWORK_SHADOW=0    → let it actually DISPATCH skills (else it only shadow-logs)
            //    So `MC_FRAMEWORK_V2=1 MC_FRAMEWORK_SHADOW=0` = live tier-chain driving.
            const _fwEnabled = process.env.MC_FRAMEWORK_V2 === '1';
            const _fwShadow = process.env.MC_FRAMEWORK_SHADOW !== '0'; // shadow ON unless explicitly disabled
            try {
                this.framework = createFramework(this, { observe: true, enabled: _fwEnabled, shadow: _fwShadow });
                if (_fwEnabled) console.log(`🧠 framework-v2 kernel ENABLED (${_fwShadow ? 'SHADOW — logs only' : 'LIVE — driving skills'})`);
            } catch (e) { console.warn('framework init failed:', e && e.message); }
            // Mineflayer-layer vine-trap unstick (recurring terrain trap, user-flagged).
            try { installVineUnstick(this.bot, (m) => { try { console.log(m); } catch (e) {} }); } catch (e) { console.warn('vine_unstick init failed:', e && e.message); }

            // This update loop ensures that each update() is called one at a time, even if it takes longer than the interval
            const INTERVAL = 300;
            let last = Date.now();
            setTimeout(async () => {
                while (true) {
                    let start = Date.now();
                    await this.update(start - last);
                    let remaining = INTERVAL - (Date.now() - start);
                    if (remaining > 0) {
                        await new Promise((resolve) => setTimeout(resolve, remaining));
                    }
                    last = start;
                }
            }, INTERVAL);
        }

        this.bot.emit('idle');
    }

    async update(delta) {
        await this.bot.modes.update();
        this.self_prompter.update(delta);
        // Framework v2 kernel tick (no-op while feature flag is OFF).
        if (this.framework) { try { await this.framework.tick(delta); } catch (e) {} }
        await this.checkTaskDone();
    }

    isIdle() {
        return !this.actions.executing;
    }
    
    monitorRespawn() {
        // Wait for bot to respawn and validate position
        const checkInterval = 500; // Check every 500ms
        const maxWaitTime = 10000; // Wait maximum 10 seconds
        let elapsed = 0;
        
        const respawnCheck = setInterval(() => {
            elapsed += checkInterval;
            
            if (!this.bot || !this.bot.entity) {
                // Bot not yet available
                if (elapsed >= maxWaitTime) {
                    clearInterval(respawnCheck);
                    console.warn('⚠️ Bot did not respawn within 10 seconds');
                }
                return;
            }
            
            const pos = this.bot.entity.position;
            if (this.isValidPosition(pos)) {
                clearInterval(respawnCheck);
                console.log(`✅ Bot respawned successfully at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
                // RESPAWN ANCHOR: record the *actual* respawn coordinate as a bank anchor.
                // This LAN server never sends a real world spawn (bot.spawnPoint stays at the
                // (0,0) sentinel), so spawn-anchored banking fails. But with no bed the bot
                // always respawns at the same fixed world-spawn position — so the live respawn
                // position IS a reliable anchor. Overwrite each respawn (point is fixed when
                // bedless; if a bed ever sets the spawn, the bankGear chain prefers bed.json
                // anyway and this file is harmless). Pure-additive, swallow all errors.
                try {
                    fs.writeFileSync('bots/_supervisor/spawn_pos.json',
                        JSON.stringify({ x: pos.x, y: pos.y, z: pos.z, t: Date.now() }));
                } catch (e) { console.warn('respawn spawn_pos write failed:', e); }
                // Reset reconnect attempts on successful respawn
                this.reconnectAttempts = 0;
                // AUTO-RESUME supervised control after an IN-PLACE respawn. A death does NOT
                // reconnect the WS, so the bridge's reconnect-sticky never fires and the LLM
                // brain resumes — its post-death !goToRememberedPlace walks straight back into
                // the mobs that just killed it (the death spiral). Re-arm the sticky supervised
                // skill ourselves (mirrors the bridge) so the scripted grind takes over and
                // runs its bounded corpse-run to reclaim dropped gear. Re-entry-guarded in
                // runSkill, so a concurrent bridge resend is harmless.
                try {
                    if (fs.existsSync('bots/_supervisor/sticky_skill.json')) {
                        const sticky = JSON.parse(fs.readFileSync('bots/_supervisor/sticky_skill.json', 'utf8'));
                        if (sticky && sticky.skill) {
                            // Single-shot re-arm: if a supervised skill is still running it'll
                            // be rejected as "busy" and simply keep running (that survives the
                            // in-place respawn fine). Only when nothing is running does this
                            // kick the grind back off. (A retry-loop here caused a runSkill
                            // spam storm when combined with the reverted death-abort.)
                            setTimeout(() => {
                                try { if (!wsServer._skillRunning) wsServer.runSkill(sticky.skill, sticky.args || []); }
                                catch (e) { console.warn('respawn re-arm runSkill failed:', e); }
                            }, 3500);
                        }
                    }
                } catch (e) { console.warn('respawn sticky read failed:', e); }
            } else if (elapsed >= maxWaitTime) {
                clearInterval(respawnCheck);
                console.warn('⚠️ Bot position invalid after respawn, may need reconnection');
            }
        }, checkInterval);
    }
    
    isValidPosition(pos) {
        if (!pos) return false;
        return typeof pos.x === 'number' && !isNaN(pos.x) && isFinite(pos.x) &&
               typeof pos.y === 'number' && !isNaN(pos.y) && isFinite(pos.y) &&
               typeof pos.z === 'number' && !isNaN(pos.z) && isFinite(pos.z);
    }

    _performMemoryCleanup() {
        const memUsage = process.memoryUsage();
        const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
        const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
        
        console.log(`📊 Memory: ${heapUsedMB}MB / ${heapTotalMB}MB heap`);
        
        // Trigger GC if available and memory is high (> 2GB)
        if (heapUsedMB > 2048 && global.gc) {
            console.log('🧹 High memory usage detected, triggering GC...');
            global.gc();
            
            const afterGC = process.memoryUsage();
            const afterHeapMB = Math.round(afterGC.heapUsed / 1024 / 1024);
            console.log(`📊 After GC: ${afterHeapMB}MB heap (freed ${heapUsedMB - afterHeapMB}MB)`);
        }
        
        // Clean up vision interpreter if available
        if (this.vision_interpreter && this.vision_interpreter.camera) {
            // Don't fully cleanup, just trigger GC if available
        }
    }

    // Best-effort scan of why the bot just lost HP. mineflayer doesn't
    // expose attacker directly for damage taken by the local player, so we
    // fall back to environment inspection + nearest-hostile heuristic. The
    // plugin forwards the result to the dialog LLM so the character can
    // narrate "a creeper got me" instead of inventing reasons.
    //
    // Returns ``null`` when nothing actionable found — caller still
    // surfaces the alert, just without a cause hint.
    _inferDamageCause() {
        if (!this.bot || !this.bot.entity) return null;
        const hints = {};

        // Environmental: block at / over the bot's feet
        try {
            const pos = this.bot.entity.position;
            const at = this.bot.blockAt(pos);
            const below = this.bot.blockAt(pos.offset(0, -1, 0));
            if (at && at.name) {
                if (at.name === 'lava') hints.environment = 'lava';
                else if (at.name === 'fire' || at.name === 'soul_fire') hints.environment = 'fire';
                else if (at.name === 'water' && (this.bot.oxygenLevel ?? 20) < 18) hints.environment = 'drowning';
                else if (at.name === 'sweet_berry_bush' || at.name === 'cactus') hints.environment = at.name;
            }
            if (!hints.environment && below && (below.name === 'magma_block')) {
                hints.environment = 'magma_block';
            }
        } catch (_) { /* ignore */ }

        // Fall damage — large downward velocity in the last tick is a
        // strong signal even when the actual hit lands on landing.
        try {
            if (this.bot.entity.velocity && this.bot.entity.velocity.y < -0.6) {
                hints.fall = true;
            }
        } catch (_) { /* ignore */ }

        // Nearest hostile entity within reach. mineflayer tags mobs by
        // ``kind === 'Hostile mobs'`` in older versions; in newer ones the
        // safer check is the name list. Include both for robustness.
        const HOSTILES = new Set([
            'zombie', 'husk', 'drowned', 'zombie_villager', 'zombified_piglin',
            'skeleton', 'stray', 'wither_skeleton', 'bogged',
            'creeper', 'spider', 'cave_spider',
            'witch', 'enderman', 'endermite', 'silverfish',
            'pillager', 'vindicator', 'evoker', 'vex', 'ravager',
            'piglin', 'piglin_brute', 'hoglin', 'zoglin',
            'blaze', 'ghast', 'magma_cube', 'slime',
            'phantom', 'guardian', 'elder_guardian', 'shulker', 'warden',
            'breeze',
        ]);
        let closest = null;
        let closestDist = Infinity;
        try {
            const myPos = this.bot.entity.position;
            for (const id of Object.keys(this.bot.entities || {})) {
                const e = this.bot.entities[id];
                if (!e || !e.position || e === this.bot.entity) continue;
                const name = (e.name || e.displayName || '').toLowerCase();
                if (!name || !HOSTILES.has(name)) continue;
                const d = myPos.distanceTo(e.position);
                if (d < closestDist) {
                    closestDist = d;
                    closest = e;
                }
            }
        } catch (_) { /* ignore */ }
        if (closest && closestDist <= 6) {
            hints.attacker = {
                kind: (closest.name || closest.displayName || 'mob').toLowerCase(),
                distance: Number(closestDist.toFixed(1)),
            };
        }

        // Nearest other player. Without this, when the human user hits
        // the bot the dialog LLM gets a cause-less alert and invents
        // "被怪打了一下" (the historical UX bug). A close player who is
        // not us is the most likely melee attacker; we don't try to
        // confirm intent (no swing animation tracking), the dialog LLM
        // can use the hint loosely as "X 可能打了我".
        try {
            const myPos = this.bot.entity.position;
            const myName = this.bot.username || this.name;
            let closestPlayer = null;
            let closestPlayerDist = Infinity;
            for (const pname of Object.keys(this.bot.players || {})) {
                if (pname === myName) continue;
                const p = this.bot.players[pname];
                const ent = p && p.entity;
                if (!ent || !ent.position) continue;
                const d = myPos.distanceTo(ent.position);
                if (d < closestPlayerDist) {
                    closestPlayerDist = d;
                    closestPlayer = pname;
                }
            }
            // Players have longer reach than the 6-block mob window —
            // include a slightly wider 5-block player melee range.
            if (closestPlayer && closestPlayerDist <= 5) {
                // Prefer player over hostile mob if both present and the
                // player is closer: a human swinging at point-blank is a
                // stronger signal than a distant zombie.
                if (!hints.attacker || closestPlayerDist < (hints.attacker.distance ?? Infinity)) {
                    hints.attacker = {
                        kind: 'player',
                        name: closestPlayer,
                        distance: Number(closestPlayerDist.toFixed(1)),
                    };
                }
            }
        } catch (_) { /* ignore */ }

        if (Object.keys(hints).length === 0) return null;
        return hints;
    }

    cleanKill(msg='Killing agent process...', code=1) {
        // Send task_finished message before killing the process
        if (!this.taskCompleted) {
            try {
                wsServer.onTaskCompleted({
                    status: 'interrupted',
                    message: '任务中断',
                    score: 0,
                    reason: msg
                });
                console.log('Task interrupted due to agent restart, task_finished message sent');
            } catch (error) {
                console.error('Failed to send task interruption message:', error);
            }
        }
        
        this.history.add('system', msg);
        this.bot.chat(code > 1 ? 'Restarting.': 'Exiting.');
        this.history.save();
        process.exit(code);
    }
    async checkTaskDone() {
        if (this.task && this.task.data) {
            // Debug: Log task checking frequency (but limit to avoid spam)
            if (!this.lastTaskCheckTime || Date.now() - this.lastTaskCheckTime > 10000) {
                console.log(`🔍 Checking task completion for ${this.name}...`);
                this.lastTaskCheckTime = Date.now();
            }
            
            let res = this.task.isDone();
            if (res) {
                // Prevent duplicate task completion broadcasts
                if (this.taskCompleted) {
                    console.log('⚠️ Task completion already detected, skipping duplicate broadcast');
                    return true;
                }
                
                this.taskCompleted = true;
                
                await this.history.add('system', `Task ended with score : ${res.score}`);
                await this.history.save();
                // await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 second for save to complete
                console.log('Task finished:', res.message);
                
                // Debug output for task completion
                console.log('\n🎯 ===== AGENT TASK COMPLETION DETECTED =====');
                console.log('📋 Message:', res.message);
                console.log('📊 Score:', res.score);
                console.log('⏰ Timestamp:', new Date().toISOString());
                console.log('🤖 Agent:', this.name);
                console.log('==========================================\n');
                
                // Broadcast task completion to WebSocket clients
                try {
                    wsServer.onTaskCompleted({
                        message: res.message,
                        score: res.score
                    });
                } catch (error) {
                    console.error('Failed to broadcast task completion:', error);
                }
                
                this.killAll();
                return true;
            }
        }
        return false;
    }

    killAll() {
        serverProxy.shutdown();
    }
}
