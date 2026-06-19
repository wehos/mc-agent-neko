# 框架 v2 骨架与层间契约（实施规格书）

> 本文是 [agent-framework-v2.md](agent-framework-v2.md)（总蓝图）的**可实施落地**：把蓝图的"四部分线程模型 + 两模式"映射到真实运行时（Node 单线程 + mineflayer），定义**模块边界与层间接口契约**，让世界模型/本能/工具/agent-LLM 四块能被**独立、协作地迭代**。
>
> 关联：[world-model.md](world-model.md)（surfaceGate 门控语义）、`bots/_supervisor/CHANGELOG.md`（C263-273 可复用修复）。
> 代码：`src/agent/framework/`（本文描述的骨架）。

---

## 0. 给协作者的一页速览（TL;DR）

- 框架是在**现有地基之上加契约层**，不重写：复用 `bot._world`（C267 世界模型）、`modes.js` 两段式反射调度、`customSkill` 热加载、`bridge.mjs` sticky 派发。
- 四部分各有一个模块文件 + 一份契约（见 §3）。**子模块只依赖 `contracts.js` 的类型，不依赖彼此的实现** → 可分头开发。
- 默认 **feature flag 关闭**（`framework.enabled=false`）：现有 missionNether 生存路径继续工作；框架内核逐块填好后才切。
- **单线程现实**（§1）：蓝图说的"线程池"在这里是**逻辑泳道调度器**；只有纯计算（扫资源/路径预规划）才下放真 worker。任何碰 `bot` 的代码都跑在主 event loop。

---

## 1. 单线程现实：把"线程池"翻译成什么（最重要的工程判断）

蓝图反复说"独占线程池/世界模型线程池"。但运行时是 **Node.js 单一 event loop + mineflayer 单 bot 对象**：`bot.dig/placeBlock/inventory/entities` 全部非线程安全，必须串行在主循环上。**不能**用真 OS 线程去并发操作 bot。

因此映射如下（这是骨架的根本约定，协作者必须理解）：

| 蓝图措辞 | 真实落地 | 在哪 |
|---|---|---|
| 世界模型"独立线程池" | ①每 2s 的 god-view 聚合（`modes.js` world_model mode，已存在）+ ②**后台提议器**（kernel 决策循环里跑，不碰 bot 只读快照）+ ③**可选真 worker**：x-ray 扫资源 / 路径预规划等**纯计算**，吃世界快照、回传高阶结果（vision 已用 `child_process.fork` 先例） | `world_model.js` + 可选 `scanner_worker.mjs` |
| 工具"独占线程池，不可中断" | **协作式互斥泳道（cooperative lanes）**：一个 async 任务占住一条 lane，运行期间**不检查 `interrupt_code`**（脚本化跑完），只能被**更高优先级的互斥 lane 抢占** | `tool_lanes.js` |
| 本能"条件反射" | 现有 `modes.js` 反射（self_preservation/mobility/edge_unstick…），框架只加**契约封装**（请示 agent / 可被打断） | `instinct.js` + `modes.js` |
| Agent LLM"只拍板" | kernel 决策循环：读世界模型提议 → 调 LLM 选择/批准 → 派发。取代 self_prompter | `kernel.js` |

> **协作纪律**：任何"后台持续做某事"的需求，先问"它碰 bot 吗？"
> - 碰 bot（移动/挖/放/合成）→ 必须是主循环上的一条**工具泳道**或一个**本能反射**，串行。
> - 不碰 bot（基于快照算路线/扫矿脉/评分）→ 可以是 `setInterval` 后台任务，或下放 worker_thread。

### 真·并发只允许出现在这两处
1. **纯计算 worker**（snapshot in → plan out），不持有 bot 引用。
2. **I/O**（读写 `*.json`、WS）天然异步，无共享可变状态即可。

---

## 2. 现状接合点（骨架接到哪）

测绘结论（代码引用）：

- **主循环**：`agent.js:860-870` 每 300ms `await this.update(delta)` → `update()`（`agent.js:876`）跑 `bot.modes.update()` + `self_prompter.update()` + `checkTaskDone()`。**内核挂在这里。**
- **self-prompt**：`self_prompter.js` — `startLoop()` 注入 system 消息逼 LLM 出命令。**supervised 流程下已被 `ws_server.js:307` 停掉**，所以生存路径里 LLM 几乎不参与，决策实际由 missionNether 硬编码。
- **世界模型**：`modes.js:3514` world_model mode，每 2s 聚合 `bot._world`（schema 见 world-model.md §3.1），写 `world_model.json`。**直接复用为单一真相源。**
- **反射**：`modes.js` 两段式 —— always 观察者（threat_radar/world_model/act_trace/edge_unstick…）+ 可中断反射（self_preservation/mobility/auto_eat…）。`bot.interrupt_code` 软中断（200ms 轮询）。
- **工具**：`skills.js` 全裸 async、无锁、软中断。`customSkill()`（`skills.js:4112`）热加载策略 skill（`import(...?t=Date.now())`）。
- **派发**：`bridge.mjs` 读 `sticky_skill.json` → WS `run_skill` → `ws_server.js:281 runSkill()` → `supervised_skill=true` + `customSkill(bot, name)`。一次只跑一个 supervised skill（再入守卫）。
- **决策中枢（今天）**：`missionNether.js` 顶层 sticky 巨型状态机 + `overseer.mjs`/`advisory.json`（risk 指令）。**框架要把它拆成 world-model proposer + LLM judge。**

---

## 3. 四部分模块 + 层间契约

所有类型定义在 `contracts.js`（JSDoc typedef，运行时零开销）。子模块 import 类型注释，不互相 import 实现。

### 3.1 世界模型（`world_model.js`）

**职责**：单一真相源的**读取门面** + **任务提议** + **心智状态(idle)检测** + 背景扫描接入。

```
getWorld(bot): World            // 读 bot._world（world_model mode 已算好）；不可用时返回安全空模型
mentalState(bot): MentalState   // { busy: bool, skill: string|null, idleMs: number } —— survival 下决定是否让 LLM 自由发挥
proposeTasks(world, bot): Proposal[]   // ★核心：基于世界模型生成候选任务（固定开局流程 + 资源/威胁驱动），按 priority 排序
registerResourceNode(world, kind, pos) // 资源富集点登记（per-world）
markDepleted(world, nodeId)            // 资源耗尽标记
// 背景扫描（开挂级，绝不把精确坐标喂 LLM）：
ingestScan(scanResult)          // worker 回传的高阶结果并入世界模型（只供本能/提议器用）
```

**契约要点**：
- `proposeTasks` 是把 missionNether 硬决策拆出来的地方。输出 `Proposal[]`，**不直接执行**——执行权在 kernel（LLM 拍板后）或本能。
- 背景扫描结果**只进世界模型驱动本能/提议**，`proposeTasks` 给 LLM 的 proposal 里**只放高阶信息**（"附近有铁矿富集点，建议下矿"），**绝不放精确 x/y/z**（蓝图 C 节硬约束：避免暴露开挂 + 避免 LLM 过载）。

### 3.2 本能（`instinct.js`）

**职责**：现有 `modes.js` 反射的**契约封装**——把"条件满足即自动行为，执行中请示 agent，可被 LLM 打断"显式化。

```
Instinct = {
  name, priority,
  test(world, bot): bool,          // 触发条件（游戏事件 or 世界模型字段）
  act(world, bot, ctx): Promise,   // 行为（多数转调一条工具泳道）
  interruptibleBy: 'agent'|'higher'|'none',  // 谁能打断
  notifyAgent: bool,               // 执行中是否同步请示 agent
}
register(instinct) / list() / evaluate(world, bot)
```

**契约要点**：
- v2 第一阶段，本能**主要是现有 modes 的清单 + 一层 adapter**（modes 已经实现了 test/act 的本质）。`instinct.js` 先做**注册表 + 文档化契约**，逐步把 modes 迁过来。
- 反射执行体若是"动作"（移动/挖/放），**必须走工具泳道**（§3.3），不可裸调 skills（保证不可中断 + 互斥）。

### 3.3 工具独占泳道（`tool_lanes.js`）

**职责**：把"落地水/垫方块/瞬堡垒/翻地形"这类**本应万无一失**的脚本化原子操作，跑在**不可中断的互斥泳道**上。

```
runExclusive(bot, laneClass, fn, opts): Promise   // 占住 laneClass，跑 fn(不可中断)，完成/被抢占才释放
LANES = { LOCOMOTION, PLACEMENT, COMBAT, SURVIVAL_MLG, DIG, CRAFT, ... }  // 互斥类
preempts(a, b): bool                              // 互斥表：a 是否能抢占 b
```

**契约要点（蓝图 F 节工程教训）**：
- **不可中断**：lane 内的 fn 运行期间**不检查 `bot.interrupt_code`**——脚本化跑完它该跑的（这正是落地水/垫方块"本应万无一失"的保证）。
- **只被更高优先互斥 lane 抢占**：`SURVIVAL_MLG`（落地水保命）优先级最高，能抢占 DIG/LOCOMOTION；普通 PLACEMENT 不能抢占 COMBAT。**互斥表要持续维护**（§5）。
- **留余量、别太极限**：垫方块放慢、跳跃滞空高一点、放置后确认——容错优先于速度。封装进 lane 的标准实现，不让调用方各自调参。
- **新互斥工具总覆盖前一个**（蓝图原话）：抢占语义 = 后来的高优先 lane 接管，前一个被打断并标记 `preempted`。

### 3.4 内核 / Agent LLM（`kernel.js`）

**职责**：Survival/Companion **模式控制器** + **决策循环**，取代 self_prompter。

```
Kernel = {
  mode: 'survival'|'companion',
  tick(delta): Promise,            // 挂进 agent.update()
  onPlayerMessage(source, msg),    // 玩家(监工)消息 → 切 companion，优先编排本能
  decide(proposals): Promise<Decision>,  // 调 LLM 拍板（survival 下；idle 时才自由发挥）
}
```

**决策循环（survival）**：
1. `world = getWorld(bot)`；`ms = mentalState(bot)`。
2. 本能/工具泳道**永远在跑**（保命不等 LLM）。
3. 若 `ms.busy`（有承诺任务在执行）→ 不打扰，继续。
4. 若 idle → `proposals = proposeTasks(world)` → **LLM 拍板** `decide(proposals)` → 派发为承诺任务（走 sticky/customSkill 或工具泳道）。
5. 若世界模型检测到 idle 且无 proposal → 让 LLM **自由发挥**（蓝图 B 节）。

**companion**：玩家消息进来自动切；优先玩家指令，LLM 编排本能完成；世界模型只在**高必要性**时提示。

**模式语义写进 LLM 提示词**（蓝图 G 节）：内核负责把"你处于 survival/companion、世界模型会 propose、你主要拍板、idle 才自由发挥"注入 system prompt（改 `prompter.js` 的占位符，把 `$SELF_PROMPT` 换/增为 `$WORLD_MODEL` + `$PROPOSALS`）。

---

## 4. Survival 固定开局流程（proposeTasks 的内容）

蓝图 D 节，写成有序提议（前置未满足则该步是当前最高优先 proposal）：

1. **资源 bootstrap**：木 → 4 planks → crafting_table → 木镐 → 石器（剑/镐）。出生点不够则主动找资源（不原地干等）。
2. **食物**：狩猎/农作物，确保 food 富足。
3. **床**（必须）：尽快获得羊毛 → 床（重生锚）。
4. **家**（必须）：以床为中心一体化布局——床 + 箱子（银行）+ 顶盖庇护 + 食物（农作+烹饪）。村子可拆可占。
5. **稳扎稳打**：下矿（铁→甲→钻）由 surfaceGate 门控（world-model.md §4）；committed 后禁自动上浮。
6. **睡觉习惯**：地面附近夜睡（世界模型建议 + LLM 拍板，保命本能维护安全）；别打断有效的下矿。

> 这套流程**既是 proposeTasks 的逻辑，也写进 LLM 提示词**让 bot 懂战略。每步的"前置/完成"判据读 `bot._world.kit` 等字段。

---

## 5. 工具互斥表（初版，持续维护）

优先级数字越大越高。`preempts(a,b)` = `prio[a] > prio[b] && 物理冲突(a,b)`。

| Lane | prio | 说明 | 物理冲突域 |
|---|---|---|---|
| `SURVIVAL_MLG` | 100 | 落地水保命（MLG）、防溺/灭火 | 移动+放置+手持 |
| `COMBAT` | 80 | 格挡/攻击/风筝 | 移动+手持 |
| `LOCOMOTION` | 60 | 寻路/翻地形/垫方块上行 | 移动+放置 |
| `DIG` | 50 | 挖矿/挖穿 | 移动+手持 |
| `PLACEMENT` | 40 | 一般建造/封顶 | 放置+手持 |
| `CRAFT` | 30 | 合成/烧炼（开窗口期间冻结其他） | 手持+窗口 |

规则：
- 同冲突域内高 prio 抢占低 prio；不同冲突域可并存（但单线程仍串行执行，"并存"指不互斥排队）。
- MLG 落地水永远能抢占一切（保命第一）；收水也在同 lane 内保证执行（蓝图 E 节"永远记得收回水"）。
- 挖矿防岩浆判定器（蓝图 E 节）是 DIG lane 的**前置守卫**，不是单独 lane。

> 新增工具时：①定其冲突域 ②插入优先级 ③更新本表 + `tool_lanes.js` 的 `preempts`。**改这张表必须同步改文档**（历史教训：门控散落各层互锁）。

---

## 6. 迁移路径（低风险 → 行为变更）

沿用 world-model.md §6 的影子模式纪律：

- **S1（骨架，本次）**：建 `framework/` 五模块 + 契约 + 文档；flag 默认关；`node --check` 全过；接进 agent.update() 但 tick 内若 flag 关则 no-op。**零行为变更。**
- **S2（工具泳道先行）**：把现有 MLG/垫方块/封顶等最易出错的脚本搬进 `tool_lanes.runExclusive`，本能/skill 调用方改走它。先在影子模式记日志验证不误抢占，再生效。
- **S3（proposeTasks 拆解）**：把 missionNether 的开局决策逐块抽进 `proposeTasks`，先**只记录"我会提议什么"对照 missionNether 实际行为**，验证一致再切。
- **S4（LLM 拍板回归）**：kernel 决策循环接 LLM judge；survival 下 idle 才问 LLM；改 prompter 占位符。
- **S5（模式切换 + companion）**：玩家消息切 companion；退役 self_prompter（确认 supervised 路径无回归后删）。
- **S6（全层收敛）**：本能/工具/skill 统一读 `getWorld()`，删各层重算。

每步：`node --check` + 重启验收(①层)/热加载(③层)；挂可证伪预测进 CHANGELOG；行为变更先影子后生效。

---

## 7. 模块依赖图（协作边界）

```
                  contracts.js   (类型，零依赖，所有人 import)
                        │
        ┌───────────────┼───────────────┬──────────────┐
   world_model.js   tool_lanes.js   instinct.js      kernel.js
   (读 bot._world)  (互斥泳道)      (封装 modes)    (决策循环/LLM)
        │               │               │              │
        └───────────────┴───────────────┴──────────────┘
                        │
                   index.js  createFramework(agent)  ← 接进 agent.update()
```

- 子模块**只依赖 contracts**，不依赖彼此实现（kernel 通过 index 注入的引用调用它们，便于替换/mock）。
- 协作分工建议：A 做 world_model+proposeTasks（策略），B 做 tool_lanes（工程可靠性），C 做 instinct 迁移（反射），D 做 kernel+prompter（LLM 拍板）。四块可并行，契约是合同。

---

## 8. 不变量 / 红线（任何子模块不得违反）

1. **碰 bot 的代码必须串行在主循环**（§1）。后台并发只允许纯计算/IO。
2. **保命永远不等 LLM**：本能反射 + SURVIVAL_MLG lane 独立于决策循环运行。
3. **精确资源坐标不喂 LLM**（蓝图 C 节）。
4. **难度 Normal + keepInventory**：死亡廉价、可跨死累积；裸资产时死亡重置成本≈0，别恋战（memory 教训）。
5. **surfaceGate**：committed_underground 后禁一切自动上浮（world-model.md §4），由内核/监工拍板进入。
6. **改互斥表、改门控语义 → 必须同步改本文档**（防散落互锁）。
</content>
</invoke>
