# Neko Agent 架构图谱（mindcraft fork 现状，2026-06-12）

> 本文档回答"代码在哪、谁驱动谁、谁有权控制 bot 的身体"。配套的交接书（现状/教训/重构方案/操作手册）见 [docs/HANDOFF.md](HANDOFF.md)。
> 此前架构知识散落在 README、profile JSON、modes.js 注释、ALERTS.txt 和运行时代码里，本文是唯一的集中事实源；改架构时请同步更新本文。

## 0. 进程与端口拓扑

```
java.exe (MC 1.21.1 LAN server, 端口 55916)        ← 绝对不许杀
   ↑ mineflayer
node main.js                                        ← 入口
 └─ src/process/agent_process.js                    ← 父进程；子进程非0退出会自动重拉(churn 来源)
     └─ init_agent.js → src/agent/agent.js          ← 真正的 agent 子进程
         ├─ WS 插件服务 :48909 (src/websocket/ws_server.js)   ← 监工/bridge 接入点
         └─ mindserver :8765                                   ← 重启时两个端口都要清
独立 OS 进程（脱离 Claude 会话，不死）:
 ├─ watchdog.ps1（仓库根）        30s 轮询保活 + 冻结/楔死/STUCK 检测 + ALERTS.txt/heartbeat.log
 ├─ bots/_supervisor/bridge.mjs   WS 客户端：events.log、inbox.jsonl→任务投递、sticky re-arm
 └─ bots/_supervisor/overseer.mjs 俯瞰层：10s 风险引擎 + LLM 战术顾问 → advisory.json
```

启动定式：`NEKO_AGENT_SCREENSHOT_INTERVAL_MS=0 node main.js`（三处 prismarine-viewer Camera 已硬禁用——它们是历史上 agent 每 30-60s 原生崩溃的根因；env 只是保险）。

## 1. 慢脑 —— LLM prompt / command / coding

| 文件 | 职责 |
|---|---|
| `src/models/prompter.js` | Prompter 类：读 profile 层级合并（defaults/_default.json → base → individual），构建 conversing/coding/memSaving prompt，路由到 chat_model / code_model / vision_model |
| `src/models/_model_map.js` | 按 profile.model 字符串选 API 适配类 |
| `src/agent/commands/index.js` | 解析 `!commandName(args)`、executeCommand 分发到 commandMap |
| `src/agent/coder.js` | `!newAction(prompt)` → code_model 写 JS → lint → 存 `bots/{name}/action-code/` → ActionManager 执行 |
| `profiles/neko.json` + `profiles/defaults/*` | bot 名、模型、modes 开关、prompt 模板 |

**现状要点**：慢脑在 supervised 模式下被**主动压制**——`run_skill` 期间 `agent.supervised_skill=true`，handleMessage 忽略自主提示（治"LLM 抢权内战"：LLM 发 !moveAway 经 ActionManager.stop() 抢断保命 mode）。慢脑实际只剩两个用途：① 人类聊天通道；② `!newAction` 作弊/救援通道（写 `bot.chat('/give ...')`）。**整条通关线由③策略层(supervisor skills)驱动，不依赖慢脑**。code_model 会从聊天历史里抄旧代码（发 `!clearChat` 可治），一次任务只执行第一条命令。

## 2. 快脑 —— modes / reflex tick loop

| 文件 | 职责 |
|---|---|
| `src/agent/modes.js` | 全部反射。`modes_list` 顺序=隐式优先级；`ModeController.update()` 由 agent.js 的 update 循环每 tick 驱动 |
| 关键自定义 mode | `threat_radar`（黑匣子：radar.json/combat_log.jsonl）、`act_trace`（1Hz 行为心电图）、`reflex_watchdog`（反射卡死强拆+pin-breaker）、`mobility`（机动性状态机）、`bare_stone_alarm`（徒手碰石报警）、`tool_keeper`（备镐）、`auto_eat`、`self_defense`、`self_preservation`（最大的一个：夜庇护/逃跑/游泳/苦力怕/bunkerDown/kite-until-dawn/safeFleeTarget 全在里面） |

**调度机制（也是结构病灶）**：
- 普通 mode 只在 `isIdle()||interruptible` 时被调度 → sticky skill 期间饿死（"调度陷阱家族"）。补丁：纯观察 mode 挂 `always=true` 无条件先跑；要行动的挂 `interrupts:['all']`。
- mode 触发行动 = `requestInterrupt()` → ActionManager.stop() → `bot.interrupt_code=true`。**modes.js 里手写的长循环必须自己遵守中断纪律**（进入清一次、循环内见 interrupt/死亡立即 break、绝不每轮重置），否则死亡时拒停 10s → 整个进程被杀 = churn。
- **mobility 状态机**（核心资产，要求持续维护）：每 2s 用全知 blockAt 把处境分类为 FREE/POCKET/ENTOMBED/SWIM/MAROONED + 正交属性 `enclosed`（封闭地穴判定，3x3 采样列×上探 35 格），挂 `bot._mobility`，vitals 广播 mob 字段。ENTOMBED→立即挖出反射；MAROONED→锁方向行军（独占移动权）。

改这一层**必须重启 agent**。

## 3. 身体 —— mineflayer skills / action manager

| 文件 | 职责 |
|---|---|
| `src/agent/library/skills.js` | ~100 个原语：collectBlock（含 veinFollow、reach-guard≤4.6、bounded dig、不可达 exclude）、placeBlockNearby（密封井凿龛）、pillarUp、craftRecipe（复用+收台）、goToGoal/goToPosition（公共寻路入口，带 MAROONED 门、藤蔓 climbable 剔除、kill-box 软排斥、maxDropDown=2）、attackEntity（可达预检+无进展超时）、customSkill（热加载入口） |
| `src/agent/action_manager.js` | 动作串行化；stop() 每 300ms 置 interrupt_code，10s 拒停 → cleanKill 杀进程（churn 风险点） |
| `bots/_supervisor/skills/*.js` | ③策略层（热加载，见 §7 分层）：chopWood、prepNether、missionNether、achieve、feedUp、setBed、bankGear、surfaceUp、shieldFight、craftChain… |

**身体只有一个，但有多个并发控制流可以抢它**（见 §8 结构病灶）。

## 4. 感知 —— full state / vitals / vision

| 来源 | 产物 | 频率 |
|---|---|---|
| `src/agent/library/full_state.js` | getFullStateAsync → mindserver 状态推送（**绝不能抛错**，曾因未守卫的 inventory 读取制造"半死 wedge"） | 周期 |
| `src/agent/library/world.js` | 全部世界查询原语（getNearestBlock/Entity、getInventoryCounts——注意它会把合成格也算进去） | 按需 |
| modes:threat_radar | `radar.json`（24格实体全量）+ `combat_log.jsonl`（交战 1Hz 快照） | 5s / 交战期 1s |
| modes:act_trace | `act_trace.jsonl` 行为心电图（pos/按键/action/寻路/挖掘目标）；**act 字段对 run_skill 不可见** | 1Hz |
| ws_server 广播 → bridge | `vitals.json`/`vitals.jsonl`（pos/dim/hp/food/tod/hostiles/skill/mob/全背包） | 15s |
| agent.js 死亡钩子 | `death_log.jsonl`（死因/坐标/装备/怪列表，append-only 跨重启） | 每死 |
| 策略 skill | `progress.txt`（fs 直写，实时） | 持续 |
| `src/agent/vision/` | **已禁用**。三处 prismarine-viewer Camera（ws_server / agent.js addBrowserViewer / vision_interpreter）全部硬禁——headless-gl 原生崩溃带走整个进程。要看画面临时 `=5000` 再关回 |

**观测可信度排序**：act_trace/vitals/progress.txt（实时）> query_inv.mjs（WS 实时）> agent.err mtime（死活判据）>> agent.log（块缓冲，延迟数分钟）。achieve 的目标标签是"想做什么"不是"在哪死"。

## 5. 记忆 —— history summary / memory bank / self prompt

| 文件 | 职责 |
|---|---|
| `src/agent/history.js` | 对话历史分块 → promptMemSaving 摘要 → `bots/{name}/memory.json`；全量存 `bots/{name}/histories/` |
| `src/agent/memory_bank.js` | 地点 KV（rememberPlace/recallPlace） |
| `src/agent/self_prompter.js` | 目标自驱循环（supervised 期间被暂停） |
| **supervisor 侧持久状态（bot 的真"外部记忆"）** | `bots/_supervisor/` 下：`bed.json`（家锚）、`spawn_pos.json`（实测重生点）、`chest.json`/`bank.json`（银行）、`stations.json`（台/炉站点池）、`death_pos.json`（一次性消费）、`death_log.jsonl`（学习数据集）、`sticky_skill.json`（重投令牌）、`bank_ghost.json` |

**坐标引用比实物长寿**（幽灵锚家族病）：任何读这些文件的消费方都需要 ghost 守卫（如距床>60 → fallback spawn_pos）；修一个数据源要 grep 全部消费方（bed.json 有 3 处读取）。热加载 skill 的模块级变量**每次调用全新**——跨调用状态一律挂 bot 对象或落盘。

## 6. 监督 —— watchdog / WebSocket / run_skill

| 组件 | 职责 |
|---|---|
| `watchdog.ps1`（根目录，OS 进程） | 30s：48909 down→清双端口重拉；freeze（progress 与 agent.err 双 stale>360s）；wedge（err 静默>1200s 且 stale-state **新增**）；STUCK（pos+inv 20min 不变）；死亡螺旋（+4死/10min）；写 `heartbeat.log` + `ALERTS.txt` + 日志轮转。停它：建 `watchdog.stop` |
| `src/websocket/ws_server.js` | :48909。消息：task / query_inventory / **run_skill**（直连 customSkill，绕过 LLM coder；`_skillRunning` 防重入 + `supervised_skill` 锁压制慢脑）；vitals 15s 广播 |
| `bots/_supervisor/bridge.mjs` | WS 客户端：events.log、status.json、inbox.jsonl 投递（`{"skill":"name","args":[...]}` 一行 = 一次 run_skill）、**sticky 自动 re-arm**（sticky_skill.json 存在则重连/skill 结束 8s 后重投，跳过 busy 拒绝） |
| `bots/_supervisor/overseer.mjs` | ④俯瞰层：radar+vitals 趋势+death_log 热图+tod → risk 0-100 + directive（evac/shelter_now/leave_zone/eat_now/dzone 雷区聚类）→ `advisory.json`；risk≥60 节流 90s 或 6min 周期调 LLM。**只产判断，行动全走 bot 自己的 skill** |
| `bots/_supervisor/query_inv.mjs` / `checkpoint.mjs` | 一次性库存查询 / 死亡检测 |
| Claude 监工会话 | 5 个 persistent Monitor（mobility 转换/ALERTS 全行/death_log/崩溃+掉血/8min 节拍器）+ scheduled-tasks 巡检。Monitor 是会话级的，会话回收即死，新会话要重挂 |

## 7. 在六模块之上：监工四层心智模型（改 bot 行为时用这个定位"该改哪层"）

1. **① 反射本能** = modes.js（中断驱动，永远在线）——"该自动反应却没反应/反应错"改这里。重启生效。
2. **② 工具内置行为** = skills.js core 原语里的聪明默认（veinFollow、reach-guard、放置重试）——"某个动作本身笨/不稳"改这里。重启生效。**通用基本机制一律沉到这层，用户极度反感把基本机制堆在 skill 层**。
3. **③ 策略 skill** = bots/_supervisor/skills/*（多步计划、编排）——"整体计划/顺序/缺步骤"改这里。热加载即时生效（但顶层入口 skill 卡在长调用里时改文件**不会**重载，需重启）。
4. **④ 俯瞰层** = overseer（上帝视角风险判断，advisory 输出，不接管）。

判据永远是"**人类玩家这局面会怎么做**"。

## 8. 结构病灶：谁都能抢身体（重构的靶心）

bot 的身体（pathfinder + control states）当前有 **5 类并发控制流**可以同时下手：

1. modes 的 execute（self_preservation 等，interrupt 驱动）；
2. sticky supervised skill 的异步循环（run_skill 不走 ActionManager，act_trace 都看不见它）；
3. 慢脑 LLM（supervised 锁压住，但死亡重启窗口会漏）;
4. 直接 setGoal 的旁路（EVAC 等）；
5. 反射里的 raw setControlState（kite/苦力怕冲刺）。

仲裁是**隐式的**：靠 modes_list 顺序 + active 标志 + 散落各处的门（goToGoal 的 MAROONED 门、sp 让位、climbing 心跳让步、夜蹲豁免……）。每修一个 bug 就再加一道门，门与门互锁——这就是"调度陷阱家族""拔河家族""保护系统互绞家族"反复发作的结构原因，也是补丁路线收益递减的根源。**重构方案（单一仲裁器 + 身体独占令牌 + 全知逃生规划器）见 [HANDOFF.md](HANDOFF.md) §4。**
