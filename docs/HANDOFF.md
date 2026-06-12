# 交接书：Neko Minecraft Agent 监工（写给下一个 agent）

> 写于 2026-06-12。上一任监工（Claude）在 60+ 轮迭代后交棒。你接手的是一个**还在运行的系统**和一份**用 282 次死亡换来的经验库**。
> 必读顺序：本文 §1-§2（红线）→ [agent-architecture.md](agent-architecture.md)（代码地图）→ 本文 §4（重构方案，你的主任务）→ §9（教训全集，遇到具体问题时查）。
> 改动台账在 `bots/_supervisor/CHANGELOG.md`（C1-C40，科学家模式：每条改动=触发证据→机理→改动→可证伪预测→归因回写）。
> 上任监工的**记忆全量导出**在 [supervisor-memory-export.md](supervisor-memory-export.md)（60+ 节时间序经验日志+死因分桶分析，§9 是它的主题压缩版；§9 查不到细节时去那里翻原文）。

---

## §1 使命与监工六原则（用户多次发火立下的，最高优先级）

**总目标（用户原话）**："更聪明地教会 AI 玩 MC……起码一路下到地狱……更严密、更鲁棒地监视、帮助他，无人值守干 24 小时。" 终极标准是速通级：bot 要能**脱离监工自主通关**。

1. **产出是逻辑不是操作**。绝不手写游戏状态（不替它写锚点文件、不遥控走位）。把"人类玩家怎么想"提炼成规则，编码进 bot 的技能/本能，让它用自己的感知（death_log、findBlocks、mobility）自主决策。
2. **修复对准机理不对表象**。先问"这个异常行为的机理是什么"（空挥=够不到还出手，不是打错目标）。
3. **周期性承诺必须有机制载体**。"每 10 分钟对账"靠自觉必然失败——用节拍器 Monitor / scheduled-task 强制叫醒。
4. **任何 bug/死因第二次发生=当场沉淀成代码改进**，不许等第三次。每次死亡复盘要主动盘"×2 账目"。
5. **所有改动记台账**（CHANGELOG.md）：触发证据→机理假设→改动→可证伪预测→观测归因。预测落空就修正或回滚。
6. **用户报告卡住/打转等重要问题→立即连续监听 30 秒全量取证**（act_trace 逐帧+mobility+progress+vitals），当场排查。绝不等下一拍，绝不只回"值守中"。

另有用户战略框架：**自主决策但必须可覆盖**（bot 未来要和玩家配合；状态都走可删改的文件接口）；**绝不自主重开世界**（不可逆）；**"家"是一体的**：床（重生锚）+箱子（银行）+庇护以床为中心统一布局；**基本机制沉底层原语（②层），用户极度反感滥用 skill**。

## §2 操作红线（违反过的都流过血）

- **绝不杀 MC 服务器**（java.exe，端口 55916）。**绝不盲杀 claude.exe**（曾误杀用户别的 agent——动手前列归属表确认）。**不动 keepalive 插件**。
- **重启 agent 流程 v3**（缺一步就会被 watchdog 偷换进程或 EADDRINUSE 崩）：
  ①杀 watchdog（建 `watchdog.stop` + 杀其 powershell，过滤 `$_.ProcessId -ne $PID`）→ ②杀 agent **父进程(main.js)+子进程**（直接 `Stop-Process -Id 列表`，管道杀会 exit 255）→ ③netstat 确认 **48909 和 8765 双端口 free** → ④`NEKO_AGENT_SCREENSHOT_INTERVAL_MS=0 node main.js` → ⑤**等 48909 LISTEN** → ⑥才起 watchdog → ⑦用进程 **CreationDate 验证**是新进程。
- **重启安全双门**：夜里不重启（蹲住的夜 hold 是资产；断线重连=原坐标凌空落地，hp1 摔 1 格即死）；hp<8 不重启。例外：裸装零资产时重启零损失，可用于断"重生农场"螺旋。
- 热加载（③层 skill）改完即生效，**但顶层入口 skill 正卡在长调用里时不会重载**——判定法：`grep "run_skill direct"` 只有旧条目+日志文案还是旧版 → 必须重启。
- PowerShell 坑：bash 工具里 `$_` 会被吃掉，PS 管道一律用 PowerShell 工具；`CommandLine -like '*watchdog*'` 会匹配到查询进程自己。

## §3 现状快照（2026-06-12）

- **世界**：第 3 个世界（重开过两次），出生点 (0,87,0) 高地有橡树，周边是破碎崖壁+大片水域+荫蔽怪窝。死亡计数 ~282（death_log.jsonl 累计，跨重启可信；heartbeat 的 deaths 会被重启清零，别信）。
- **bot 处境**：反复在"重生满血满食→重建（最多到木剑/熔炉/盾）→饥饿损血/怪伤→死亡"循环。**食物死结是当前头号结构问题**：活动区无动物无瓜无浆果，feedUp 持续空手，hp 低位常态；荒诞但真实——死亡重置（重生 food20）目前是最稳定的"食物来源"。次级杀手：水域溺尸（死 278/279/281/282）、enderman 激怒（lookAt 扫脸，死 276 根因，**待修**）、深坑 fall。
- **用户最新反馈（本次交接的直接原因）**：监工不在时 bot 又卡在一个空穴里出不去——**"特别简单的问题一直犯"**。用户判定补丁路线到头，要求重构（§4）。
- **已验证可靠的机制资产**（重构时这些是要保留/复用的零件，不是要扔的）：mobility 状态机+ENTOMBED 挖出反射、ENCLOSED 封闭地穴夜门豁免链、C34 威胁可达性过滤、MAROONED 行军全链（17 分钟挖出 >12h 迷宫）、kite-until-dawn（6 怪围攻撑到天亮零伤）、苦力怕拉距反射、骷髅蛇皮走位、MLG 垫柱（apex 30ms 轮询放块）、placeBlockNearby、collectBlock reach-guard+veinFollow、贴脸直砍、corpseRun 完整协议、死亡热图避区+kill-box 寻路软排斥、churn 三 viewer 根除、台账纪律。
- **git 状态**：工作树有未提交改动（modes.js/skills.js/agent.js/ws_server.js/full_state.js/vision_interpreter.js/mcdata.js/settings.js + 根目录一堆 crash-*.log）。**接手第一件事：把代码改动 commit 到分支，crash log 清进子目录**——三天的修复只存在于工作树是不可接受的风险。
- **任务列表**：#8 凑钻石装备、#9 搭真地狱门 in_progress；#10 地狱、#11 屠龙 pending。监工侧 Monitor 栈是会话级的，你需要按 §6 重挂。

## §4 重构方案（你的主任务：别再加补丁，换骨架）

### 4.0 诊断：为什么补丁到头了

60 轮修出来的 bug 几乎全部属于四个**结构性家族**：

| 家族 | 实例 | 结构根因 |
|---|---|---|
| 调度陷阱 | threat_radar 断片、tool_keeper 磨灰、auto_eat 不吃、行军被 sp 饿死、凿崖被行军饿死 | mode 调度是隐式优先级+active 标志，长流程互相饿死 |
| 拔河 | moveAway 绕过 MAROONED 门、两个 achieveLoop 并发抢 pathfinder、EVAC 旁路 setGoal | **身体没有独占权**，5 类控制流并发抢 |
| 保护互绞 | idle-wedge 误判蹲坑、pin-breaker 踢夜蹲、独占门吃掉 noPath 信号、eat_now 短路饿死任务流 | 每个保护各自为政，没有统一仲裁 |
| 幽灵状态 | bed.json 三处消费漏一处、模块级黑名单不持久、_stoneAborts 归零 | 状态散落（文件/模块变量/bot 字段），无 ownership |

而用户点名的"bot 卡在空穴出不去"反复发作，是因为**所有脱困手段都是启发式**（digToSurface 的方向轮换、dig-staircase、MAROONED 行军的 2 连败右转）——bot 明明有全知 blockAt，却从来没有真正**规划**过一条"从这里到开阔天空"的挖掘路径。

### 4.1 目标架构（五个部件）

```
WorldModel(黑板, 1-2Hz) ──→ Arbiter(唯一仲裁器) ──→ BodyGate(身体独占令牌) ──→ 原语层执行
        ↑                        ↑        │
   全知感知探针              策略层提案    decision_trace.jsonl(决策心电图)
                            (achieve等)
```

**A. WorldModel 黑板（单一事实源）**——把现有 mobility 状态机扩成完整世界模型，挂 `bot.wm`，每 1-2s 更新一次：
- 处境：mobility（FREE/POCKET/ENTOMBED/SWIM/MAROONED）、enclosed、光照、是否在水边/崖边（LEDGE/LAVA_ADJ 等待扩状态）；
- 威胁：可达性过滤后的敌对列表（C34 逻辑收编于此）、苦力怕/远程怪单列、risk（收编 overseer 规则）；
- 自身：hp/food/氧/装备档位/kit 完整度（镐×2、火把、填料、食物）；
- 锚点：bed/spawn/bank/stations 的**带 ghost 校验的**统一读取（幽灵锚检测只写一次）；
- **逃生可达性**：到开阔天空的预估代价（见 C 规划器）。
所有层（反射/工具/策略/俯瞰）只读 `bot.wm`，禁止各自重复探测。这是把"主动状态建模碾压被动停滞计时"的已验证哲学推到全局。

**B. Arbiter 唯一仲裁器（替换散落的门和 shouldX）**——一个每 tick 跑的纯函数：`intent = arbitrate(bot.wm, taskProposal)`。
- 输出**唯一**当前意图：如 `ESCAPE_ENTOMBED > FLEE_CREEPER > FIGHT_POINTBLANK > ESCAPE_MAROONED > CRITICAL_EAT > NIGHT_POLICY(enclosed 豁免在此) > RECOVER(corpseRun/bank) > TASK(策略层提的)`。
- 带**迟滞**（最短驻留时间、进入/退出阈值不对称）防振荡——bunker↔flee thrash、FREE↔MAROONED 振荡都是没有迟滞的代价。
- 每秒把"选了什么意图+前三名得分+谁被否决、为什么"写 `decision_trace.jsonl`。以后调"它为什么不干活"直接读决策日志，不用 30 秒抓帧反推。
- **纯函数=可离线测试**：把历次事故时刻的 wm 快照存成 fixtures，仲裁器改动跑回归（"hp4+贴脸骷髅+有剑→应选 FIGHT_POINTBLANK"）。这是第一次拥有不靠 bot 真死就能验证修复的手段。
- modes.js 退化为两类：纯观察 mode（telemetry，保留 always 通道）和**意图执行器**（每个意图一段执行代码，由 Arbiter 唯一调度）。shouldNightShelter/shouldFlee/各种豁免门全部熔进仲裁表，互锁从此可见、可测。

**C. EscapePlanner 全知逃生规划器（直接解"卡在空穴"）**——bot 有 X-ray（blockAt 任意坐标零成本），就该用真规划替代所有脱困启发式：
- 3D A*/BFS：节点=可站立格（脚+头空间），边=走/跳/**挖**（代价=该方块用当前最好工具的挖掘秒数；徒手石头=高代价但可行，NOPICK-FAMINE 的精神收编于此）/**垫**（消耗填料），危险惩罚（水、岩浆邻格、>2 格坠落、kill-box 区）。
- 目标谓词可插拔："开阔天空"（替代 digToSurface）、"最近可达原木"（替代朝树行军）、"锚点"（替代 LEASH 回拉）、"地表 y 目标"。
- 输出动作序列，执行器逐步走+挖+垫，偏离即重规划。搜索半径 64、限节点数，毫秒级可承受。
- **验收标准：bot 在任何可挖地形里被困，≤2 分钟内开始沿一条规划好的路径脱困**。这一条直接回应用户"空穴出不去"的愤怒。
- 现有 MLG 垫柱时序、台阶剖面挖法（C37-rev1）、材质门、placeBlockNearby 都作为执行器的原语复用。

**D. BodyGate 身体独占令牌**——pathfinder.setGoal / setControlState / dig 的公共包装：只有持有当前意图令牌的控制流能动身体，其余调用记日志并拒绝。"门要加在公共入口/原语层"的教训按构造满足，拔河家族整族灭绝。慢脑 LLM 与 run_skill 也走令牌（supervised 锁收编于此）。

**E. 策略层瘦身**——achieve/missionNether/chopWood 剥掉全部嵌入式守卫（MAROONED bail、夜门、hp bail、advisory 消费——全归 Arbiter），只剩纯编排：选目标、提 TASK 提案、被抢占时从断点续。skill 内只需响应 `bot.interrupt_code`。

### 4.2 迁移路线（每阶段都有可证伪验收，写进台账）

- **P0 基线**（半天）：commit 现状；记 48h 基线指标（死亡/小时、里程碑链 ip/d/o/f、被困事件数、监工干预次数）。重构的成败用同一组指标说话。
- **P1 WorldModel**（1-2 天）：扩 mobility mode 为 wm 模块；threat/anchors/kit 收编；vitals 广播 wm 摘要。各层改读 wm（行为不变的纯重构）。验收：删掉≥10 处重复探测代码，行为指标不退化。
- **P2 Arbiter+BodyGate**（2-3 天，核心）：先把仲裁表搭起来只**记日志不接管**（影子模式，对照现有行为找分歧）；分歧收敛后切换接管，modes 的行动逻辑逐个迁成意图执行器。验收：decision_trace 连续 24h 无振荡（同一对意图 50 次/小时级横跳=失败）；调度陷阱/拔河类事件=0。
- **P3 EscapePlanner**（2 天）：先做"开阔天空"谓词替换 digToSurface，再替换 MAROONED 行军和朝树寻路。验收：人为把 bot 埋进/困进三种地形（土洞、石穴、崖底），全部 ≤2min 自主脱困。
- **P4 策略层瘦身+食物结构解**（1-2 天）：剥守卫；然后在干净骨架上解食物死结（候选：钓鱼线=蜘蛛丝 2 根+木棍、远征找动物群系=EscapePlanner 的远距目标、腐肉链常态化）。
- **每阶段保留回滚开关**（env 或 settings 标志切回旧调度），夜间窗口不切换。

### 4.3 重构期间的纪律

- 影子模式先行，**别一刀切**——这个系统在线上跑着，bot 还要活着。
- 已验证原语（§3 资产清单）原样复用，重构的是**仲裁与导航规划**，不是重写 mineflayer 管线。
- 每个阶段完成即写台账+记忆，不等会话结束。

## §5 操作手册

- **驱动 bot**：往 `bots/_supervisor/inbox.jsonl` 追加一行 `{"skill":"missionNether","args":[]}`（bridge 转 run_skill）；sticky_skill.json 写同款则死亡/重连自动重投。聊天/作弊走 `{"task":"...","task_id":"..."}`（一次任务只执行第一条命令；`!newAction` 收自然语言）。
- **查询**：库存真值 `node bots/_supervisor/query_inv.mjs`；处境 `bots/_supervisor/vitals.json`（15s 新）；行为 `act_trace.jsonl` 尾部；进度 `progress.txt`。
- **作弊救援通道**（用户授权的一次性救援用，平时零作弊）：task 投 `!newAction("bot.chat('/give @s ...')")`；先 `!clearChat` 防 code_model 抄旧代码。
- **watchdog**：`Start-Process powershell -WindowStyle Hidden -File watchdog.ps1`；停=建 `watchdog.stop`；改完**必须验证 watchdog.log 出现新 "watchdog started (pid)"**，否则是僵尸。
- **MC 服务器存档卡"保存中"**=bot 还连着，杀 agent 断开即可让存档跑完。世界重开后 LAN 端口会变（settings.js port=-1 自动扫）。

## §6 监控手册（接手后第一小时照此搭）

1. 读 `heartbeat.log` + `ALERTS.txt` 尾部补回交接间隙的状态（这两个是不死记录）。
2. 重挂监听栈（Monitor 是会话级的，上任的已随会话死亡）：
   - ALERTS.txt 全行转发（**行里不含 'ALERT' 字样，不能 grep**）；
   - death_log.jsonl 新增行；
   - vitals/mobility 转换 + 崩溃/掉血（带 radar 快照）；
   - **节拍器**：8 分钟强制对账（硬指标：pos/y/hp/food/ms 里程碑/progress 尾；"推送回声不算情报，必须主动读"）。
3. 巡检判据速查：progress 新+err 老=半死 wedge；双老=真冻；"iter 在转但 pos/y/total 不变"=任务死循环（watchdog 抓不到，要人看）；死亡率只信 death_log 累计；判死活看 agent.err mtime。
4. 桌面通知/跨会话告警走 watchdog 的 ALERTS.txt + scheduled-tasks MCP（CronCreate/Monitor 都是会话级，会话回收即死）。

## §7 改进流程（怎么让每一滴血都变成代码)

死亡/异常 → 30 秒全量取证（第六原则）→ 问三个问题：①机理是什么（不是表象）②哪一层该改（四层模型，见 architecture §7）③第几次发生（×2 即必须修）→ 改动写台账带可证伪预测 → 下次事件归因回写。诊断工具箱：act_trace 逐帧（活问题必须活遥测）、death_log 桶分析（155 样本结论：armor0=85% 死亡，装备状态才是 fight-vs-flee 首要判据）、combat_log 录像回放、ENV-SNAPSHOT 方块矩阵、frame.jpg（需临时开截图）。**改生存本能必须立刻对比死亡率基线，单拍不算数但翻倍=回归立刻回滚**。

## §8 待修队列（按优先级）

1. **重构 P0-P4**（§4，主任务）。
2. enderman 视线豁免：行军/凿崖 lookAt 扫脸=激怒（死 276 根因，已二次）。修：lookAt 目标点压低/绕开 enderman 头部。①层。
3. 食物死结结构解（§4.2 P4；当前靠死亡重置回血是事实但不可接受为长期策略）。
4. 水域=溺尸雷区的寻路级回避（死 265/268/272/278/279/281/282——已 7 次，WATERFRONT VETO 不够；可作为 EscapePlanner 危险惩罚的一部分）。
5. tool_keeper 备镐失灵根因=木材 buffer 没囤够就开挖矿（#21 资源节奏）。
6. respawn 窗口失同步（死亡中断合成→craft 静默失败，重启重同步是 workaround；根治=respawn 时 closeWindow+槽位校验）。

## §9 教训全集（按主题压缩；细节查 CHANGELOG.md 与监工记忆 mc-agent-supervision.md）

### 9.1 调度与控制流
- interrupts:[] 的 mode 在 sticky 期间永不运行；纯观察挂 always，要行动挂 ['all']。
- 长循环中断纪律：进入清一次 interrupt，循环内见 interrupt/死亡立即 break，绝不每轮重置；逃跑 honor 停止、龟缩扛住停止（非对称，各自正确）。拒停 10s=进程被杀=churn。
- 门加在公共入口/原语层，不是单个调用方；长控制流的"循环开头检查"形同虚设。
- 高优先级分支失败必须放行任务流，不能原地等（eat_now 短路把任务流饿死）。
- 每加一层保护必须验证它与既有反射的交互；每个新长流程要审"会不会被更高优先级饿死"。
- 跨调用状态不放函数局部量/热加载模块级变量——挂 bot 对象或落盘。
- Promise.race 超时只弃养不取消=孤儿循环打架；用代际令牌（bot._gen++，循环每轮自检）。
- 超时 cap 写在循环条件里 ≠ 有超时——单个 await 永不返回时条件永远查不到。

### 9.2 挖掘/放置/移动原语
- 所有 bot.dig 调用点统一防线：equipForBlock + reach-guard（眼到方块中心≤4.6）+ bounded dig + stopDigging + 失败 exclude。空挥=够不到还出手。
- 新写 dig 必配 equipForBlock（审计：`grep "bot\.dig(" | grep -v equipForBlock`）。徒手挖石 7.5s 无掉落；裸装可挖出方块的只有土族。
- 放置类检查清单必须含"实体占位"——放进 bot 半径 0.85 内=自埋窒息（自己写的逃生代码杀过 bot）。
- MLG 垫柱：跳起后 30ms 轮询 y，越过 +1.01 瞬间放块（apex ~290ms，固定延时必败）；垫柱前确认真跳起来了；放完验证没封死自己。
- 精密操作前机械对位（_centerOnBlock：潜行碎步到格心，误差<0.15）。
- 挖掘类代码要画挖完的剖面图验证——"staircase"曾经挖的其实是水平隧道。
- pathfinder 不会爬"现挖的台阶"；垂直/斜上用 raw control 或 pillarUp。藤蔓族要从 climbables 删掉。
- 凡"原地反复尝试同一动作"的循环都要有卡死检测→换策略/换位置。
- 不可达三层兜底：孤树→黑名单（多候选 findBlocks，getNearestBlock 拉黑了也只会递回同一棵）；地形 pin 能走→强制走位；封闭坑→挖穿（将被 EscapePlanner 取代）。
- 旁路修复必须继承被绕过路径的全部副职责（直砍 v1 丢了整树+捡掉落）。

### 9.3 生存与怪物
- 怪物应对分类型：苦力怕=只拉距离（最快 raw 冲刺，秒级威胁不能用有启动延迟的寻路；任何 mode 都不许近战它）；骷髅=探测≥16 格+无盾蛇皮走位/有盾贴脸；enderman=不对视+怕水（但溺尸在水里，水庇护要查 drowned）；贴脸单怪+有武器=无视血量门开打（4 格内骷髅拉弓硬直，剑击退是唯一胜手）。
- fight-vs-flee 首要判据是装备不是怪数（armor0=85% 死亡；73% 死于 1-3 只怪）。
- 威胁要过可达性滤镜：近战怪 |dy|≥5 物理够不到不算威胁（不滤则 sp 永久占身体，作业层结构性饿死）。
- 夜间法则：地表暴露才危险，封闭地穴(enclosed)/深地下夜=昼；水边庇护"往上垒"不是"往下挖"；封不上就 kite 到天亮，绝不反复试封；蹲坑选址 8 格内有水=溺尸上岸雷区。
- 保命线不能锁死回血路径（hp bail 阈值若挡住"砍木→武器→猎食"链=死锁悖论）。
- 食物：food≥18 才回血、food≤6 紧急档吃腐肉/生肉、饥荒 PlanB 野瓜/浆果、PlanC 捡阳光烧怪掉落（5 分钟 despawn，守卫前放行）。
- 死亡重置：裸资产时成本=0，是合法的换地形手段——"这片地形值不值得救"要早评估，别恋战（崖壁区三天 10 个 bug 不如一次死亡重置后 5 分钟）。
- 阈值类参数对照游戏机制常数审查（回血 18/冲刺 7；keepFed 维持线 14<18 造出全天玻璃人）。

### 9.4 状态与数据
- 坐标引用比实物长寿：所有锚点文件消费方都要 ghost 守卫；修一个数据源 grep 全部消费方。
- 材料 fungibility 要做全（cobblestone/cobbled_deepslate/blackstone 等价；planks 同种用 max 不是 sum）。
- 副手槽(slot 45)幻影：items() 看不到，材料进副手="看得见配方用不了"；合成格(slot0-4)同病。
- 地形事实问状态机/实测，不写死（y≥64 地表线换个世界就错）。
- 同步/异步孪生函数修一个忘一个；状态上报函数绝不能抛错（一抛就被 mindserver 判死=半死 wedge）。

### 9.5 监控与诊断
- 监控信号必须纯净：渲染噪音刷 agent.err 曾让 freeze/wedge 双防线全瘫。健康判据要正交多信号。
- "有过某事件"≠"正在发生"：判据用增量不用累积计数。
- 误杀的代价可能比漏杀更糟（watchdog 误重启会 reset 合理进度）；区分"idle 等待"与"真 hang"。
- 调活问题必须活遥测；黑匣子只能验尸。增强日志把守卫值打出来，两轮就能定位潜伏数日的 bug。
- 诊断死因只看实时行为序列+death_log 分类，绝不信 achieve 目标标签；tail 内容可能陈旧，必须配 mtime。
- 排查"反复诡异死亡+WS churn"：`grep "exited with code" agent.log` + `grep "refused stop" agent.log`。viewer 全禁后 churn=0。
- 报警类改动不攒批次，写好立即上车——一个好报警器比十次巡查值钱。

### 9.6 LLM 慢脑的脾气（恢复使用慢脑时需要）
- 一次任务只执行第一条命令；code_model 抄聊天历史旧代码（!clearChat 治）；确定性多步合成走 !craftRecipe 直连不走 newAction；run_skill 直连通道绕过 coder 是可靠脚本化的正路。

---

*交接完。记住用户的判词："特别简单的问题一直犯"——不是 bot 笨，是它从来没有一个统一的大脑来用它已经拥有的全知感知。把 §4 做出来。*
