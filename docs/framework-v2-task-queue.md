# Framework v2 — World-Model-Maintained Task Queue (设计规格书)

> 关联：[framework-v2-scaffold.md](framework-v2-scaffold.md)（层间契约总纲）、[world-model.md](world-model.md)（surfaceGate 门控）、[agent-framework-v2.md](agent-framework-v2.md)（总蓝图）。
> 代码锚点：`src/agent/framework/world_model.js`（`proposeTasks`/`commitGoal`/`isGoalDone`/`isEmergency`/`isNightPlan`）、`src/agent/framework/contracts.js`（`PROPOSAL_KIND`/`World`/`EMPTY_WORLD`）、`src/agent/framework/instinct.js`（`runInstinct`/`episodes`/`vetoInstinct`）、`src/agent/modes.js:4446-4483`（commit 调用点 + go_to_bed_sleep 本能 + C328 扫描器 `4279-4303`）、`bots/_supervisor/skills/kernelDriver.js`（sticky 派发器）。
>
> 本文把"单承诺状态机"（`bot._commitment` + `commitGoal` + kernelDriver）升级为一个**世界模型维护的有序任务队列**：可在头/尾/任意位置插入、可删除、按 kind 去重；每个任务带一个有**生命周期**的 trigger；一个**同步 LLM-cancel 门**（已就位但**默认关闭** = 纯本能）；任务回到队头时**重新评估**（世界模型有效性 + LLM 门）；以及一个**机会主义插入目录**（铁/钻→立即挖、村庄→抢小麦/木/干草/工作站、动物→成本评估抢占、流浪商人→杀取栓绳、小麦+面包作为早期主食、床后→小麦农场+批量烤面包带动态停止）。
>
> **不变量贯穿全文**：队列是单承诺的**超集**。当前 `bot._commitment` == 队头（`status==='active'`）。所有已稳定的修复（T-0081 夜间抢占、T-0083 enclosed-frozen、T-0088 recovery-kit yield、T-0089 villageHarvest 冷却）都是**对队列转移的约束**，绝不是对队列结构的改动。

---

## 目录

0. [术语与不变量](#0-术语与不变量)
1. [Motivation：队列为何胜过状态机](#1-motivation队列为何胜过状态机)
2. [Architecture：队列 + ops + Task/Trigger schema](#2-architecture队列--ops--tasktrigger-schema)
3. [Trigger 生命周期：once-per-night + llm-cancel + 回头重评](#3-trigger-生命周期once-per-night--llm-cancel--回头重评)
4. [LLM gate：stubbed-off 契约](#4-llm-gatestubbed-off-契约)
5. [Opportunistic catalog](#5-opportunistic-catalog)
6. [Layer contracts：谁拥有什么](#6-layer-contracts谁拥有什么)
7. [Migration：shadow → cutover（保留所有稳定修复）](#7-migrationshadow--cutover保留所有稳定修复)
8. [Open questions](#8-open-questions)

---

## 0. 术语与不变量

| 术语 | 含义 |
|---|---|
| **Task** | 队列里的一个有序条目（策略层）。携带 `{id, kind, skill, args, priority, position, status, trigger, resolve, ...}`。 |
| **HEAD** | `q[0]`，最高优先级，kernelDriver 实际执行的那个。等价于今天的 `bot._commitment`。 |
| **active** | 队头且其子 skill 正在跑的那个 Task 的 status。**最多一个** active（单 mineflayer 身体串行）。 |
| **Trigger** | 一个 Task 存在的**理由 + 生命周期**。今天 `commitGoal` 的隐式 `isGoalDone`/`isEmergency` 判断被显式化成 trigger。 |
| **lifecycle-key** | trigger 的"本次发作 episode"的字符串标识。同 key = 同一次发作（抑制重复）；不同 key = 全新独立发作（重新武装）。 |
| **Reflex / Instinct** | `modes.js` 的反射本能（self_preservation 等）。**永不进队列**，中断驱动，照旧跑。 |

**五条不变量（任何实现/重构都必须保持）：**

1. **HEAD ≡ commitGoal 的选择**（Phase A/B）：队头 kind 必须和 `commitGoal` 当下会写进 `bot._commitment` 的 kind 一致。队列只是把"被丢弃的次优提议"变成可见、可恢复的 backlog。
2. **单 active**：恰好一个 Task `status==='active'` 且它**就是** HEAD。队列不引入并发——单身体仍串行；队列泛化的是**选择 + 抢占(SUSPENDED) + backlog(PENDING)**，不是并行。
3. **Reflex 在队列外**：`modes.js` 一切反射/本能（含 `go_to_bed_sleep`）永不成为 Task。kernelDriver 的 `reflexBusy()` 门是**派发时**的让位，不是队列概念。
4. **emergency 不可侵犯**：HOLD@95 / GET_FOOD(food≤4) / MIGRATE(inDeathZone) 一旦是队头，任何机会主义/夜间任务都不得把它挤下队头（最多插到 index 1）。这是 T-0081 回归守卫的核心。
5. **每个非持久 Task 都带 dedup-key + 生命周期闸**：耗尽/消费完的机会绝不重复派发成冻结循环（villageHarvest 冷却是被验证过的防冻机制，所有机会任务复刻它）。

---

## 1. Motivation：队列为何胜过状态机

今天 `commitGoal`（`world_model.js:382-439`）维护**单个** `bot._commitment = {kind, skill, args, since}`，每 2s 从 `proposeTasks` 排名里选一个，sticky 到 `isGoalDone`。这是当前系统的瓶颈，五个具体痛点：

1. **次优提议被丢弃，无法恢复**。`proposeTasks` 每 2s 产出**全部**排名候选，但 `commitGoal` 只选一个；GET_BED@50、GO_UNDERGROUND@45 等低优任务必须等所有高优任务 `isGoalDone` 才有机会——而一旦更高优任务完成，它们**从头重算**，不是从 backlog 恢复。一个被 emergency 临时打断的 MIGRATE 在旧模型里**丢了**（覆写式单承诺）；队列里它降级到尾部，emergency 清除后**自动恢复**。这是最大的升级。
2. **无法表达"先做 A，A 完了接着做 B"**。单承诺没有 backlog 概念，所有顺序意图都得靠优先级数字间接编码，脆弱且不可见。
3. **机会主义抓取无处插入**。C328 扫到一条钻石矿脉 / 路过一个村庄 / 一个流浪商人——今天没有干净的方式把"现在去抓一下"插进正在跑的 bootstrap，只能改 `commitGoal` 加 if 分支。队列给出 `spliceOpportunistic`：新生产者只需调一次，零 `commitGoal` 改动。
4. **trigger 无生命周期**。`computeNightPlan`/`computeOpening` 每 tick 重算，没有"今晚已经决策过"的去重；LLM 否决一个夜间计划后，下一 tick `proposeTasks` 又把它重新提出来（见 triggers map 的 gap 列表）。队列把 trigger 提升为一等公民，带 `once-per-night` 等生命周期。
5. **派发触发器太窄**。kernelDriver 只在 `c.skill !== lastSkill` 时派发（`kernelDriver.js:110`）。若队列重排到另一个**恰好用同一 skill** 的任务（例如两个 nightShelter 模式），skill 不变 → kernelDriver 看不到变化 → 不重派发。队列引入 `c.id` 作为第二触发器闭合这个缺口。

**队列不改的东西**（关键，降低风险）：`proposeTasks` 完全不动（照旧每 2s 产出全排名）；`isGoalDone`/`isEmergency`/`isNightPlan` **逐字复用**；reflex 层不动；kernelDriver 改动最小（只加 `c.id` 触发器）。队列是**结构升级**，不是行为重写。

---

## 2. Architecture：队列 + ops + Task/Trigger schema

### 2.1 它住在哪 / 全局不变量

- `bot._taskQueue : Task[]` —— 单个**有序数组**，`q[0]=HEAD`。新模块 `src/agent/framework/task_queue.js` 拥有全部纯函数 ops；`world_model.js` 拥有 `commitQueue`（reconcile）。
- `bot._taskQueue` **取代** `bot._commitment` 成为真理来源，但**向后兼容 shim**：`commitQueue` 每次 reconcile 都把 `bot._commitment = peekHead 快照`（含 `.id`），于是**未改动的 kernelDriver 读路径**（`kernelDriver.js:100` `const c = bot._commitment`）和 `bot._world.commitment` 遥测**零改动**继续工作。
- **仅内存**（per-session），与今天的 commitment 完全一致（不跨重启）。跨重启持久化是显式 out-of-scope（见 §8 + §7 Phase D 之后）——加了它会改变崩溃/重生语义，且触及 landmarks.json 多 bot 文件冲突风险。
- **Reflex 永不进队列**：`self_preservation` / `self_defense` / `threat_radar` / `reflex_watchdog` / `mobility` / `auto_eat` / `item_collecting` / `tool_keeper` / `edge_unstick` / `go_to_bed_sleep` 本能照旧在 `modes.js` 调度器上中断驱动。队列**只**装策略层（proposer + opportunistic + llm）。`HOLD@95` 是唯一一个"survival 味"的 Task（它今天就是 proposal），走 emergency 路。
- **`reflexBusy()` 门**（kernelDriver 的 ENTOMBED/POCKET/MAROONED/SEALED/SWIM + threat&hp<10）保持为**派发时的独立门**，不是队列 op（详见 §6）。

### 2.2 Task 对象 schema

```js
/** @typedef {Object} Task */
{
  id:        string,          // 稳定逻辑标识：proposer 任务 = `${kind}`（每 kind 一个，dedup key）；
                              //   opportunistic = `${kind}#${coordHash}`（kind+目标 locus）。dedup/remove/find 用。
  kind:      string,          // ProposalKind | OppKind，例如 'BOOTSTRAP_KIT' | 'OPP_MINE_VEIN_ORE'。与今天同枚举 + opp 扩展。
  skill:     string,          // kernelDriver 派发的 supervised skill 名（'prepNether'|'mineDown'|...）。'' = idle/free_play。
  args:      any[],           // 入队时 SNAPSHOT 的位置参数（冻结副本），转发给 customSkill(bot,ctx,...args)。
                              //   永远是数组（绝不 undefined）—— 保证 kernelDriver spread 安全（复刻 world_model.js:428）。
  priority:  number,          // proposer 预排名（95..1）。决定 'priority' 插入策略的默认位置。
  position:  'head'|'tail'|'priority',  // 插入策略：head=跳到队首（found-diamond）；tail=最低；
                              //   priority=按优先级有序插入（proposer seed 默认）。
  status:    'queued'|'active'|'done'|'cancelled',  // active = 当前派发的 HEAD 子 skill 正在跑。
  trigger:   {                // 描述"为何存在"+生命周期（取代今天隐式的 test()）。
    source:    'proposer'|'opportunistic'|'llm',
    cond:      null | ((world,bot)=>boolean),  // 重验谓词；proposer 任务为 null（proposeTasks 每 tick 重新派生它们）。
    lifecycle: 'persistent'|'one_night'|'one_cycle'|'one_shot',  // trigger episode 何时结束（见 §3）。
    episodeId: string|null,   // 绑定到一个 phase/cycle id（如 nightSeq），让被否决的夜间任务同夜不再发作。
    vetoedUntil: number,      // ts；Date.now()<vetoedUntil 时此 kind 被抑制（LLM/冷却否决）。0 = 活跃。
    until:     number,        // 通用冷却/到期 ts（承载 _villageHarvestCooldownUntil 风格门）。0 = 无。
  },
  resolve:   null | ((world,bot)=>({skill,args}|null)),  // 可选晚绑定：opportunistic 任务在派发时重算 skill+args
                              //   （如 OPP_MINE_VEIN_ORE 用 live landmark 解析成 collectBlock(oreType)）。
                              //   null = 静态 {skill,args} 已设好。proposer 任务留 null（每 tick 重新 seed 即可保鲜）。
  rationale: string,          // 高层 WHY（对 LLM/遥测安全），从 proposal 拷贝。
  source:    'proposer'|'opportunistic'|'llm',   // 顶层冗余一份便于过滤（= trigger.source）。
  createdTs: number,
  since:     number,          // 成为 HEAD/active 的时刻（激活时设；镜像 commitment.since）。
}
```

**`resolve` 是"如何变成具体 skill+args"的答案**：proposer 任务是静态的（skill+args 在 seed 时烘焙，且**每 2s 重新 seed**，新鲜度来自重 seed）；opportunistic 任务带 `resolve` thunk，让陈旧的 landmark 坐标在派发瞬间被重读。

### 2.3 Trigger 对象（与 §3 的注册表配合）

`trigger` 是 Task 上的内联字段（如上 schema），但其**行为**由 `src/agent/framework/triggers.js` 的注册表 + per-bot episode 状态驱动。注册表里每个 kind 一个 `TriggerSpec`：

```js
TriggerSpec = {
  id,                       // == kind，例如 'SURVIVAL_NIGHT'
  lifecycleScope,           // 'night' | 'encounter' | 'node' | 'once' | 'persistent'
  condition(world, bot),    // 纯谓词：本 trigger 的情境是否当前存在
  lifecycleKey(world, bot), // -> string|null。算当前 episode key（见 §3.1）。null = 当前不适用。
  resolve(world, bot),      // -> { skill, args, priority, rationale } | null。动态派发（§3.4）。
}
```

per-bot episode 状态（懒初始化，镜像 `bot._instinctEpisodes`）：

```js
bot._triggerState[id] = {
  firedKey:        null,        // 上次实际发作的 lifecycle-key（dedup：同 key 不再发作）
  llmCancelledFor: new Set(),   // 被 LLM cancel 的 lifecycle-key 集合（仅抑制那些 key）
  cooldownUntil:   0,           // Date.now() ms 门（承载 _villageHarvestCooldownUntil 风格刹车）
  since:           0,
}
```

> **冲突解决（重要）**：原始三个组件给出了**两套**重叠的取消存储——lifecycle 组件的 `bot._triggerState[id].llmCancelledFor:Set<key>` 和 llmhook 组件的 `bot._llmCancelledFor[key]`。本设计**统一为单一存储 `bot._triggerState`**（在 `triggers.js` 里）。`llm_gate.js` **不**自带第二个 `bot._llmCancelledFor`；它的 `markLlmCancelled` 直接调用 `triggers.cancelTrigger(bot, id, key, reason)`，写进 `bot._triggerState[id].llmCancelledFor`。这避免两个真理来源漂移。`llm_gate.js` 只拥有 **enable 标志 + 同步 gate 函数 + 注入式 prompter**，取消的生命周期账本归 `triggers.js`。

### 2.4 队列结构 & ops（`task_queue.js`，纯函数）

```
bot._taskQueue : Task[]   // 有序，[0]=HEAD

makeQueue() : Task[]                                  // 返回 []
makeTask(spec) : Task                                 // 规范化 args→[]、status='queued'、createdTs=now、派生 id
enqueueHead(q, t) : Task     // dedup 后插 index 0；但若 q[0] isEmergency 则插 index 1（emergency 不可侵犯）
enqueueTail(q, t) : Task     // dedup 后 push 末尾
enqueueByPriority(q, t) : Task  // dedup 后有序插入（queued 同 status 间 priority 降序；active HEAD 原位保持）。SEED 默认
insertBefore(q, refId, t) : Task   // dedup 后插到 id===refId 之前（refId 不存在则插尾）
insertAfter(q, refId, t) : Task    // dedup 后插到 refId 之后
remove(q, id) : boolean      // 按 id 删；若它是 active HEAD → markCancelled 触发 kernelDriver 重派发
peekHead(q) : Task|null      // q[0] 或 null（kernelDriver 跑的那个）
reorder(q, idOrder[]) : void // 按显式 id 序重排；未列出的 id 在尾部保持相对序
dedup(q, key) : Task|null    // id===key（proposer 同 kind）的现存 Task，否则 null。所有 enqueue* 内部调用
find(q, id) : Task|null
findByKind(q, kind) : Task|null
markActive(q, id) / markDone(q, id) / markCancelled(q, id) : void   // status 转移（§3 生命周期）
prune(q, world, bot) : void  // 丢弃 done/cancelled + trigger.cond()===false + one_night 过白昼 + until 过期的任务
```

**Dedup key = `task.id`**。proposer 任务 id===kind，故每 kind 最多一个 queued 任务（无重复 BOOTSTRAP_KIT）。opportunistic 任务 key 在 kind+locus，故两条不同钻石矿脉可共存，但同一矿脉不会被双入队。`dedup` 在每个 `enqueue*` 里被调用：若同 key 任务已 `queued` 或 `active`，enqueue 是 no-op（或刷新现存任务的 args/priority，**绝不**加第二个）。

### 2.5 从 proposeTasks seed（commitQueue 取代 commitGoal）

`proposeTasks` **不变**——照旧每 2s 产出全排名 `Proposal[]`。`commitGoal` 被 `commitQueue(bot, proposals, world)` **取代**，从同一 `modes.js` 调用点（`4448-4450`）调用，每 2s reconcile：

1. **RE-SEED proposer 任务**：对每个 proposal p（排除 `FREE_PLAY@1`，除非队列空），构建 Task（id=p.kind、source='proposer'、position='priority'、priority=p.priority、skill/args/rationale 来自 p、args 快照）。按 kind dedup upsert：若该 kind 的 proposer 任务已存在，**刷新其 priority+args**（保鲜，复刻今天 `world_model.js:428` 的 `match.args` 行）；否则 `enqueueByPriority`。本 tick **消失**的 proposal（条件不再成立）→ 其 proposer Task 被 remove，**除非**它是 active HEAD 且尚未 `isGoalDone`（stickiness，见 §2.6）。
2. **PRESERVE opportunistic/llm 任务**（它们不被 proposeTasks 重产，只活在队列里）。逐个用 `trigger.cond(world,bot)` 重验；false → remove（机会过去了）。
3. **APPLY emergency + nightPre 排序**（§2.6）决定 HEAD。
4. **SORT** queued（非 active）尾部按 priority 降序；active HEAD 按 stickiness 原位保持。
5. **写向后兼容快照**：`bot._commitment = {kind,skill,args,since,id}`（来自 peekHead）；`bot._world.commitment = {kind,skill,rationale,preemptedFrom}`；`bot._world.taskQueue = q.map(slim)` 遥测（写进 world_model.json 供监工检查 backlog）。

**净效果**：排名 proposal **变成**初始有序队列（priority 降序），HEAD 等于 commitGoal 会承诺的那个——队头行为完全一致，而尾部现在可见/可重排而非被丢弃。

### 2.6 HEAD 选择 = 保留的 commitGoal 逻辑（约束，非新行为）

`commitGoal` 里逐字的 T-0081 / 回归守卫逻辑（`world_model.js:390-413`）变成 `commitQueue` 内的 **HEAD 排序规则**。设 H = 当前 active HEAD（其子正在跑），首次运行时从现存 `bot._commitment` seed：

- **若 H 存在且 `!isGoalDone(H.kind)`**：H 保持 HEAD，**除非**被以下抢占——
  - **(a) EMERGENCY**：队列里任意位置存在一个不同 kind 的 emergency 任务（`isEmergency`：HOLD / GET_FOOD food≤4 / MIGRATE inDeathZone）→ `enqueueHead` 它；
  - **(b) NIGHTPRE**：**仅当** H 不是 night plan **且** H 不是 emergency 时，一个 nightPlan 任务（`isNightPlan`，pri 91-94）其 priority > H 的 live priority → `enqueueHead` 它。
  这是 `world_model.js:408-413` 的 `cIsEmergency` / outranks 守卫的**逐字搬运**，防 NIGHT_SEAL↔GET_FOOD thrash。被抢占的 H **不删除**——降到它的 priority 槽位（emergency/night 清除后恢复，这是旧单承诺模型**做不到**的 backlog 保留升级）。
- **若 H 为 null 或 `isGoalDone(H)`** → `markDone(H)`，HEAD 变为最高优先级的未否决 queued 任务。这是 `world_model.js:433-435` 的 `top` 分支。
- `isGoalDone` / `isEmergency` / `isNightPlan` 从 `world_model.js` **不改复用**。

所以四个稳定修复都作为 HEAD-转移约束保留：nightPre-vs-emergency（上面守卫）、villageHarvest 冷却（`trigger.until`，§3）、recovery-kit yield（活在 modes.js，不动）、enclosed-freeze（kernelDriver `reflexBusy`，不动）。

---

## 3. Trigger 生命周期：once-per-night + llm-cancel + 回头重评

> 这是把 `instinct.js` 的"execute-first / ask-LLM / veto-suppress-for-cycle"契约从**反射层**提升到**任务层**，但把生命周期从"连续 test 窗口"泛化为一个**scoped lifecycle-key**，让"每晚一次、次晚独立"算术地涌现。

新模块 `src/agent/framework/triggers.js`。状态在 `bot._triggerState`（内存，镜像 `bot._instinctEpisodes`）。每个 task-kind 一个 TriggerSpec，注册一次。队列/commit 层在（重新）入队一个 trigger-backed 任务前，问该 trigger `shouldFire(world, bot)`，而非盲目重提。

### 3.1 lifecycle-key —— "每晚一次/次晚独立"的心脏

一个 trigger 的生命周期由一个**从世界算出的字符串 KEY** 标识。两次同 KEY 的发作 = 同一 episode（抑制重复）；不同 KEY = 全新独立 episode（重新武装）。每 scope 的 key 函数：

- **night**：`night#<nightSeq>`。**冲突解决（关键）**：原始 lifecycle 组件主张 `nightIndex = Math.floor(bot.time.age / 24000)`，依赖 mineflayer 单调 `bot.time.age`。但本代码库**今天只读 `bot.time.timeOfDay`**（`modes.js:182,502,2466,...`、`agent.js:837`、`full_state.js`），**从不读 `bot.time.age`**——而 `timeOfDay` 每天黎明 wrap 到 0，用它会让每一晚塌缩成同一个 key（致命）。因此本设计把 **`bot._nightSeq`（单调计数器，在 `modes.js` world_model mode 的 day→dusk phase 边沿 +1）定为权威**，`bot.time.age` 仅作可选优化（若该 mineflayer 版本确实填充了 `age` 且经验证单调，则 `night#${age>0 ? floor(age/24000) : _nightSeq}`，否则纯用 `_nightSeq`）。trigger 仅在 `phase ∈ {dusk,night}` 时发作。今晚 `night#N`，明晚 `night#N+1`——严格不同 key → 自动独立。
- **encounter**：`enc#<entityKey>`——绑定到具体敌对/商人/事件（如 `enc#wandering_trader@<entityId>`）。每次独立遭遇是自己的 episode；同一个被否决的商人保持被否决直到它 despawn/离开、其 key 消失。
- **node**：`node#<kind>@<x,y,z>`——绑定到资源节点 landmark 身份（C328 landmark key `kind@x,y,z`）。被否决的矿脉保持否决；不同矿脉是全新 key。
- **once**：常量 key `once`——bot 一生发作恰好一次（如一次性 bootstrap 里程碑）。veto = 永久。
- **persistent**：key 每 tick 变（`p#<ts-bucket>`）或该 scope 退出 dedup——只要条件成立就每 tick 发作，持续重评（这是今天 `proposeTasks` 对 GET_FOOD/BOOTSTRAP_KIT 等非夜任务的行为）。

### 3.2 Firing 逻辑：`shouldFire()` 与 `markFired()`

commit/queue 层在（重新）入队一个 trigger-backed 任务前调 `shouldFire(trigger, world, bot)`：

```
shouldFire(trigger, world, bot):
  state = triggerState(bot, trigger.id)
  if (Date.now() < state.cooldownUntil) return false           // 时间窗刹车（villageHarvest 冷却）
  if (!trigger.condition(world, bot)) return false             // 情境不在
  key = trigger.lifecycleKey(world, bot)
  if (key == null) return false                                // scope 说当前 N/A（如非夜）
  if (state.llmCancelledFor.has(key)) return false             // LLM 取消了本 episode → 抑制
  if (state.firedKey === key) return false                     // 本 episode 已发作 → 不重复
  return true                                                  // OK 发作（入队）本 episode
```

**两种抑制，都 key 在同一个 lifecycle-key 上：**
- `firedKey === key` → "今晚已经触发过，别再触发"（无重复触发，头号需求）。
- `llmCancelledFor.has(key)` → "LLM 今晚说不，本晚保持抑制"——但 key 次晚变了，故次晚 `has(key)` 为 false → 重新发作。独立 trigger 涌现。

成功发作时（任务实际入队/承诺）调 `markFired(bot, trigger, key)` → `state.firedKey = key; state.since = Date.now()`。

LLM cancel 路（stubbed，模块在但关）：`cancelTrigger(bot, id, key, reason)` → `state.llmCancelledFor.add(key)`。逐字镜像 `instinct.vetoInstinct()`，但抑制范围是 lifecycle-KEY 集合而非单 boolean（因 encounter/node scope 一个 trigger 可有多个并发 live key）。

**GC**：`llmCancelledFor` 和 `firedKey` 是廉价字符串；night/once 有界。encounter/node 在 2s tick 里 sweep——丢掉任何不在当前 live key-set 里的 key（landmark/实体没了）。这是 `instinct.js:128` `if (!hit) delete eps[name]` 重新武装的类比。入口：`gcKeys(bot, liveKeysByTrigger)`，每 world_model tick 调一次。

### 3.3 survival trigger 的 worked example（一个 trigger → 一个任务 → 动态解析成不同本能）

**这是"ONE trigger fires ONE survival task that DYNAMICALLY RESOLVES into different instincts"需求。** trigger 单一；它产出的 TASK 在每次派发时重解析其具体 skill：

```js
SURVIVAL_NIGHT trigger:
  id:             'SURVIVAL_NIGHT'
  lifecycleScope: 'night'
  condition:      (w) => w.time.phase === 'dusk' || w.time.phase === 'night'
  lifecycleKey:   (w,bot) => `night#${ (bot.time && bot.time.age > 0)
                                ? Math.floor(bot.time.age / 24000)
                                : (bot._nightSeq | 0) }`
  resolve:        (w,bot) => {
     // 复用既有 computeNightPlan 链的决策（从 w.nightPlan 读，modes.js 每 2s 重算），映射成具体 skill+args。
     const d = w.nightPlan.decision   // FIGHT|MINE_THROUGH_NIGHT|GO_BED|DIG_ONE_CAP|SEAL_FORT
     switch (d) {
       case 'MINE_THROUGH_NIGHT': return { skill:'mineDown',    args:[{targetY:(w.nightPlan.targetY||12)}], priority:94 }
       case 'GO_BED':             return { skill:'prepNether',   args:[],          priority:93 }  // 见下注
       case 'DIG_ONE_CAP':        return { skill:'nightShelter', args:['dig_one'], priority:92 }
       case 'SEAL_FORT':          return { skill:'nightShelter', args:['seal'],    priority:91 }
       case 'FIGHT':              return null  // 战斗归 self_defense 反射，不入队（与今天 proposeTasks 一致）
       default:                   return null
     }
  }
```

> **与现有 skill 对齐的注**：原始 lifecycle 组件把 GO_BED/FIGHT 映射到 `nightShelter 'go_bed'/'fight'`，但当前代码里 `nightShelter` 只有 `'dig_one'`/`'seal'` 两个模式（`world_model.js:274,279`），GO_BED 走的是 `prepNether` 兜底（`world_model.js:269`），FIGHT 根本不产 proposal（self_defense 反射拥有战斗，`world_model.js:283`）。本设计**遵从现有代码**：GO_BED→prepNether、FIGHT→null。给 nightShelter 加 go_bed/fight 模式是单独的 skill 改动，不在本队列迁移内。

**所以**：ONE trigger 每晚发作一次（`night#N` 上 dedup）。它生成的任务是 `SURVIVAL_NIGHT`，其 `resolve()` 被 kernelDriver 在**每次派发**时调用——夜幕展开（bot 下地→挖矿，出现床→去床，兜底→挖三填一/seal），**同一个承诺任务**静默换它的子 skill，正是既有 computeNightPlan 链。决策中途变化时 trigger **不**重发作（`firedKey` 仍 == `night#N`），只有 resolution 变。若 LLM 今晚取消 SURVIVAL_NIGHT，`llmCancelledFor.add('night#N')` → 整晚抑制；次晚 `night#N+1` 是干净 key → 再发作。

这**取代**四个分离的 DUSK_MINE_NIGHT/DUSK_GO_BED/NIGHT_DIG_ONE/NIGHT_SEAL proposal（它们的 `isGoalDone` 都已塌缩到 `phase==='day'`）成一个 survival 任务——保留 T-0081 nightPlan-抢占守卫，因 survival 任务携带夜间 priority band 91-94 且 `isNightPlan()` 可测 `kind==='SURVIVAL_NIGHT'`。

`isGoalDone(SURVIVAL_NIGHT)`：`w.time.phase === 'day'`——与今天的夜任务一致。黎明完成时 trigger **不**因完成而重武装；它纯因 lifecycle-key 次黄昏前进而重武装。

> **迁移注**：SURVIVAL_NIGHT 的引入是**可选的第二步**。Phase A/B/C 的纯结构镜像**保留四个分离的夜任务**（最低风险）；SURVIVAL_NIGHT 合并是 Phase C 之后的一个独立增量（见 §7）。两者都满足"一个 trigger 动态解析"——四任务版用 `proposeTasks` 的 switch 实现同样的动态选择，只是把选择留在 proposer 而非 resolve thunk。

### 3.4 回到队头的重新评估（reevaluateHead）

当一个任务**回到队头**（子 skill 完成/bail，或被抢占后现在又居首），派发器**必须**在重派发前重评。两道门，按序：

```
reevaluateHead(bot, task, world) -> { keep:boolean, reason:string, task? }
  // GATE A —— 世界模型：trigger 条件是否仍满足/仍需要？
  if (!stillValid(task, world, bot)) return { keep:false, reason:'world-invalidated' }
  // GATE B —— LLM 门（STUBBED，模块在但关；默认裁决 = proceed）
  const verdict = llmGate(task, world, 'head-return-reeval')   // -> {proceed, cancel?, reorderHint?}
  if (verdict && !verdict.proceed && verdict.cancel) {
     // llmGate 内部已调 cancelTrigger 记账（§4），这里只需丢弃
     return { keep:false, reason:`llm-cancel` }
  }
  // 重解析具体 skill（动态解析，§3.3）让队头重派发用最新决策
  const r = task.resolve ? task.resolve(world, bot) : { skill:task.skill, args:task.args }
  if (!r) return { keep:false, reason:'resolve-empty' }
  return { keep:true, reason:'revalidated', task: { ...task, skill:r.skill, args:r.args, priority:r.priority ?? task.priority } }
```

`stillValid(task, world, bot)`：薄包装，返回 `!isGoalDone(task.kind, world, bot) && trigger.condition(world, bot) && cooldown-ok && !isCancelled(key)`。具体回答"如果还没发作过，这个 trigger 现在还会想发作吗"——**忽略 `firedKey===key` dedup**（这个任务**就是**那次发作），但**尊重** condition + cooldown + llmCancelledFor。对 SURVIVAL_NIGHT，`stillValid` 在黎明为 false（`phase==='day'` → `isGoalDone` true）→ 任务掉出队头，trigger 明天重武装。

**重评时机**：这是 kernelDriver 中断监视的泛化。派发器在子返回时**或**队头身份变化时跑 `reevaluateHead`。1500ms 反热旋节流和 `reflexBusy` 门保持在它前面不变。

---

## 4. LLM gate：stubbed-off 契约

新模块 `src/agent/framework/llm_gate.js`，经 `framework/index.js` 再导出。坐在确定性决策层（proposeTasks/commitQueue）和执行器（kernelDriver）之间，在**两个 seat** 被调用：(1) trigger 发作/承诺选择时；(2) 队头回归重评前。**默认关闭**时它是纯透传，**同步**返回 `{proceed:true}`，零 LLM 调用、零 chat、零 self-prompt——bot 保持**纯本能**。启用时它**同步**（await，阻塞 trigger）问 LLM proceed/cancel/reprioritize，并把 CANCEL 喂回 trigger 生命周期（`triggers.cancelTrigger`）。

### 4.1 enable 标志

```js
const LLM_GATE_ENABLED_DEFAULT = false;   // 镜像 contracts.js FRAMEWORK_ENABLED_DEFAULT (line 194)
```

解析顺序，模块加载时求值一次进可变模块级 `let _enabled`：env `MC_LLM_GATE==='1'` **OR** `decision-config.json` 字段 `{llmGate:true}`（BOM-safe 读，**逐字复刻** `world_model.js:76-105` 的 loadDecisionConfig 模式；PARSE 失败 append 到 progress.txt，**绝不**静默吞——C251 教训）**ELSE** `false`。公共 getter `llmGateEnabled():boolean` + setter `setLlmGateEnabled(b)`，让监工命令（`!llmGate on/off`）热翻无需重启。**关键**：每个调用点用 `if (llmGateEnabled())` 包裹，关闭时门函数体**永不进入**——保证零开销零分歧。

### 4.2 gate 函数

`llmGate(task, world, reason): Promise<Verdict>`，从调用者视角同步（返回一个 caller `await` 的 Promise，阻塞 trigger 直到裁决）。契约：

- **若 `!llmGateEnabled()`** → 立即返回 `{proceed:true}`（已 resolve 的 Promise，不 await 任何东西，无 LLM、无 I/O、无 log）。**这是今天唯一跑的路**。必须是**第一条语句**，故关闭代价 = 单个 boolean 检查 + 对象分配。
- **若 task null/无 kind** → `{proceed:true}`（无可门）。
- **若 `isCancelled(bot, task.kind, key)` 已为本 episode 设** → 短路 `{proceed:false, cancel:true}` **不重问** LLM（同 episode 内不重复骚扰，同 `instinct.js:133` `ep.vetoed` 纪律）。
- **启用 + 未决** → 同步调注入的 prompter：`verdict = await _askLlm(task, world, reason)`。归一化为 `{proceed, cancel, reorderHint}`。prompter 经 `wireLlm(fn, bot)` 注入（S4），未注入前 gate **fail-open** 返回 `{proceed:true}`（够不到 LLM 的门绝不冻死 bot——无 soft-lock 教条）。
- **CANCEL 裁决**：返回前先调 `triggers.cancelTrigger(bot, task.kind, key, reason)`（写进统一的 `bot._triggerState`，**不**另起 `bot._llmCancelledFor`），再返回 `{proceed:false, cancel:true}`。
- **REPRIORITIZE 裁决**：返回 `{proceed:false, cancel:false, reorderHint:<kind|hint>}`——proceed:false（别照原样跑），但未取消（决策层下 tick 尊重 reorderHint 重排；无 episode 抑制）。S0 阶段决策层可把 reorderHint 当**仅咨询**（log 并仍 proceed），但字段现在就定义，调用者按稳定形状接线。

`Verdict = { proceed: boolean, cancel?: boolean, reorderHint?: string|null }`。`proceed:true` 是关闭门唯一返回的值。

### 4.3 lifecycle-key 复用

llm_gate **不**自带 key 公式——它调 `triggers.lifecycleKey(trigger, world, bot)`（§3.1 的单一来源）。这消除原始 llmhook 组件里独立 `lifecycleKey/nightCycleId` 与 lifecycle 组件公式的**重复定义冲突**。夜任务 cancel 自动 key 在 `night#<nightSeq>`，黎明经 `gcKeys` 自动扫除重新武装。

### 4.4 两个 seat 的接线（都在 `if(llmGateEnabled())` 后）

**SEAT 1 —— TRIGGER FIRING**（`modes.js:4448-4450` commitQueue 后）：

```js
const head = this._fw.commitQueue(bot, props, bot._world);   // 取代 commitGoal
if (this._fw.llmGateEnabled && this._fw.llmGateEnabled()) {
  const g = await this._fw.llmGate(head, bot._world, 'trigger-fire');
  if (g && !g.proceed) { this._fw.removeHeadAndReselect(bot); }  // cancel/reprioritize 了队头
}
```

关闭默认下此块同步执行 commitQueue 一如今天，`await` 在同一 microtask resolve——无行为改变、无 LLM、无 chat。

**SEAT 2 —— HEAD-RETURN RE-EVAL**（kernelDriver 子返回重派发点，`kernelDriver.js:137-149` 前）：经 `reevaluateHead`（§3.4，内部已含 GATE B = llmGate）。关闭默认 → gate 返回 proceed:true → 循环与今天逐字节一致（18:17:30 反热旋节流 `kernelDriver.js:146` 保留）。

### 4.5 为何关闭路 = 纯本能（load-bearing 保证）

1. 每个调用点 `if(llmGateEnabled())` 包裹；false 时门体首行 early-return 后永不跑。
2. `llmGate` 首语句 `if(!llmGateEnabled()) return {proceed:true}`——即使调用者忘了包裹，门自短路，零 LLM/chat/log。
3. 关闭路上无 askLLM/notify/openChat/self-prompt 可达——注入的 prompter 只在启用分支调用，且启用了若未接线也 fail-open。
4. `bot._triggerState[*].llmCancelledFor` 关闭时永不写，故 `isCancelled` 恒 false，决策层的 withhold 检查是 no-op。

净：标志关闭时 bot 跑 proposeTasks→commitQueue→kernelDriver 完全如今天，**纯本能，LLM 全程不出声**。

---

## 5. Opportunistic catalog

机会主义目录是一个**独立生产者**，跑在 C328 扫描器节拍（`modes.js:4279` 每 12s）+ 每 tick 实体 sweep 上。它**不**取代 `proposeTasks`——在每 2s tick 跑在其后，把机会插进队列。每个检测器调 `spliceOpportunistic(bot, oppSpec)`：

```js
spliceOpportunistic(bot, {
  kind,           // 'OPP_MINE_VEIN_ORE'|'OPP_HUNT_ANIMAL'|'OPP_SEIZE_VILLAGE'|'OPP_TRADER_LEAD'|'OPP_WHEAT_FARM'
  locus,          // {x,y,z} 目标 —— 形成 dedup id `${kind}#${hash(locus)}`
  skill, args,    // 或 resolve() thunk 晚绑定到 live landmark
  resolve,
  priority,       // 由临近度计算（见目录表）
  lifecycle,      // 'one_shot' | 'persistent-recurring'
  cond,           // (w,b)=>landmarkStillThere(b,kind,locus)  重验；false 时 remove
})
```

### 5.1 全局门（任何机会主义发作前）

```
mobility.state ∉ {ENTOMBED,POCKET,MAROONED,SEALED,SWIM}        // = reflexBusy 的 mobility 部分
  && !(threat.actionable>0 && vitals.hp<10)                    // = reflexBusy 的 threat 部分
  && Date.now() >= bot._recoveryVentureUntil                   // T-0088 recovery 拥有身体
```

机会主义**永不**凌驾生存。

### 5.2 优先级 band（resolved，无冲突）

> **冲突解决**：原始 opportunistic 组件在 OPP_SEIZE_VILLAGE 上自相矛盾（先 @70 又改 @67-tier）。本设计**钉死下表**。机会主义全部 **≤ 87**，坐在生存链（HOLD95 / 夜链 91-94 / 食物危机 88）之下、日间作业之上。OPP_TRADER_LEAD@87 是最高机会主义（用户"毫不犹豫杀商人"），但仍 < 食物危机 88 且 < 夜链——**夜里夜计划赢过商人**（91-94 > 87，正确：别为栓绳在夜里送命）。

| 任务 | priority | 入队位置 | 生命周期 | dedup store / TTL | 门（除全局门外） |
|---|---|---|---|---|---|
| **OPP_TRADER_LEAD**（流浪商人）| 87 | head（让位 emergency→index1）| per-trader / `enc#trader@xyz` | `bot._oppTraderSeen` / ~2h | dist≤24；当前非夜非 emergency 不要求（用户：毫不犹豫）。夜里仅当贴脸可发 |
| **OPP_MINE_VEIN_ORE**（铁/钻矿脉）| 86 | diamond→head；iron→by-priority | per-node / `node#ore@xyz` | `bot._oppOreSeen` / 30min | dist≤16 + pick-tier 满足（HARD）。diamond 绕近任何非生存；iron 夜里仅当 alreadyDeepEnclosed |
| **OPP_SEIZE_VILLAGE**（村庄）| 67（armor<4 时 77）| before-current | per-village / cooldown | `bot._villageHarvestCooldownUntil`（既有）/ 480s | dist<32 + 冷却过 + 非(picks0&wood<1) + 当前非夜非 emergency |
| **OPP_HUNT_ANIMAL**（动物）| 动态 30..72 | score>cur→before-current；否则 tail | per-encounter / `enc#hunt@xyz\|entityId` | `bot._oppHuntSeen` / 5min | score>0（成本/收益，§5.4）。day-gated |
| **OPP_WHEAT_FARM**（小麦农场）| 40 | tail | persistent-recurring / `wheat_farm` | `bot._wheatFarmCooldownUntil` / ~5min | bedKnown + day + 安全 + breadStock<dynamicBreadTarget + 有种子/农田 |

完整排序：`HOLD95 > 夜链91-94 > 食物危机88 > 商人87 > 矿86 > armor68 > 村庄67(/77) > hunt(scored 30..72) > migrate60 > bed50 > go_underground45 > wheat_farm40 > free_play1`。
nightPre 守卫（`isNightPlan` + `cIsEmergency`，`world_model.js:408-413`）**不改复用**：机会主义任务非夜非 emergency，故夜计划能像挤掉陈旧 migrate 一样挤掉陈旧机会主义绕路。

### 5.3 trigger→task→position→lifecycle→gate 目录（详表）

**#1 IRON/DIAMOND ORE → "立即挖这条矿脉"**
- **检测缺口**：C328（`modes.js:4296-4299`）扫 wood/crops/chest/animal/village/bed 但**不扫矿**。补：在 4299 后加 `reg('ore', findBlocks(/(^|_)(iron|diamond)_ore$/, maxDistance:16, count:12), meta=/diamond/.test(...)?'diamond':'iron')`，`reg()` 扩展存 `meta` 子类型。
- **谓词**：`oreLm && oreLm.dist≤16 && pickTierSatisfies(oreLm.meta) && !(key in bot._oppOreSeen)`。pick-tier 是 HARD 门（`collectBlock` 的 PICK_REQ 门 `skills.js:888` 本就会拒徒手挖矿，触发无对应 pick 只浪费派发）。iron-ore 需 `/stone|iron|diamond|netherite/` pick；diamond-ore 需 `/iron|diamond|netherite/`。
- **任务**：`{kind:'OPP_MINE_VEIN_ORE', priority:86, skill:'collectBlock', args:[oreLm.meta, 64, null, true]}`。用既有 `collectBlock(blockType, num, exclude, veinFollow)` 签名（`skills.js:846-896`）；veinFollow=true 经 `harvestConnectedVein` 全脉穷尽；num=64 封顶失控脉。
- **位置**：diamond→`enqueueHead`（值得绕任何非生存）；iron 或当前承诺 priority≥86 时→`enqueueByPriority`。**绝不**越过夜计划(91-94)/HOLD(95)/食物危机(88)。
- **生命周期**：per-node。key=`node#ore@xyz`。任务 DONE（collectBlock 返回/脉穷尽）→ key 加进 `bot._oppOreSeen`（30min TTL）。`isGoalDone`：collectBlock 返回即 true（one-shot）OR 源 landmark `seen` 陈旧（>20s 未重扫 ⇒ 脉没了）。
- **门**：仅 pick-tier + dist≤16；diamond 绕过日间/安全检查；iron 加 `phase!=='night' OR alreadyDeepEnclosed`（`modes.js:4386` 逻辑）。

**#2 VILLAGE → "抢村庄资源（永远囤小麦)"**
- **检测**：今天就有。C328 从 villager 实体 + bell/crafting_table/furnace 注册 `village`（`modes.js:4288-4289`）+ `crops`/`chest`。
- **谓词**：`villLm && villLm.dist<32 && Date.now()>=bot._villageHarvestCooldownUntil`（既有门 `modes.js:4407` 逐字复用）`&& !(picks===0 && woodUnits<1)`（零镐零木死锁守卫 `modes.js:4408`）`&& 当前非 emergency 非夜`。与 OPENING_VILLAGE 的区别：本机会版**bootstrap 后也发**（挖矿途中、migrate 途中）。
- **任务**：`{kind:'OPP_SEIZE_VILLAGE', priority: armor<4?77:67, skill:'villageHarvest', args:[{priorityCrop:'wheat'}]}`。复用 `villageHarvest.js`。**增强**（用户"永远囤小麦"）：CROP_BLOCKS 把 wheat 排首位 + 更高 cap；hay_block 无条件收 + 收完 craft hay→9 wheat。
- **位置**：`before-current`（村庄静止不逃，不夺当前 live 承诺，但走出 32b 前要跑）。
- **生命周期**：per-village + 既有 480s 冷却（`villageHarvest.js:78,211` stamp `bot._villageHarvestCooldownUntil`，谓词尊重）。`isGoalDone(OPP_SEIZE_VILLAGE)`：镜像 OPENING_VILLAGE（`world_model.js:346-350`，phase 非 VILLAGE_HARVEST OR village.dist>32）。
- **门**：dist<32 + 冷却 + 零镐零木守卫 + 非夜非 emergency。

**#3 ANIMAL → 成本/收益 → push-back-current 或 skip**
- **检测**：今天就有。C328 从 cow/pig/sheep/chicken/mooshroom 实体注册 `animal`（`modes.js:4299`，32b 内）。
- **成本/收益（本条核心，决定 push-back vs skip）**：
  ```
  benefit = foodDeficit_weight + woolBonus
    foodDeficit_weight = (food<=6 ? 100 : food<12 ? 50 : 20) * (meatStock<4 ? 1.0 : 0.3)
    woolBonus          = (species==='sheep' && !bedKnown(bot)) ? 60 : 0
    // ★#5A 预甲偏置：armor<4 且 wheat/bread 源可达时 foodDeficit_weight *= 0.7（优先安全主食，但不拒肉）
  cost = distCost + dangerCost + interruptCost
    distCost      = dist * 2
    dangerCost    = (threat.actionable>0 ? 40 : 0) + (phase!=='day' ? 25 : 0) + (hp<10 ? 50 : 0)
    interruptCost = (cur is OPP_MINE_VEIN_ORE||night||emergency ? 999 : cur.priority*0.5)
  score = benefit - cost
  if (score <= 0) SKIP
  else priority = clamp(30 + score, 30, 72)
  PUSH-BACK-CURRENT(before-current, raise interrupt_code) iff priority > cur.priority && cur 非夜非 emergency 非 ore；否则 tail
  ```
- **任务**：`{kind:'OPP_HUNT_ANIMAL', priority:<30..72>, skill:'attackNearest', args:[species, true]}`。复用 `attackNearest(bot, mobType, kill)`（`skills.js:635`）。
- **生命周期**：per-encounter。key=`enc#hunt@<entityId|round-pos>`。kill（attackNearest 返回 true）或动物出范围（landmark>20s 陈旧）→ `bot._oppHuntSeen`（5min TTL，新动物可重触发）。单飞行 + 每扫重排（更近/更需的赢，替换不堆叠）。

**#4 WANDERING TRADER → 毫不犹豫杀取栓绳 → head-insert**
- **检测缺口（两个）**：(a) C328 不扫 wandering_trader（`modes.js:4288` 实体 sweep 只匹配 villager + 牲畜）。补：实体循环加 `if (/^wandering_trader$/.test(e.name)) reg('trader', ...)` + `/^trader_llama$/ reg('trader_llama', ...)`（杀 llama 也掉栓绳）。(b) `attackNearest('wandering_trader')` 本就能工作（泛 mobType，`skills.js:648`）——**无需新战斗 skill**。栓绳掉落由 `item_collecting` 自动捡。
- **谓词**：`traderLm && traderLm.dist≤24 && !(key in bot._oppTraderSeen)`。**除全局生存门外无其他门**（用户 spec：毫不犹豫）。
- **任务**：`{kind:'OPP_TRADER_LEAD', priority:87, skill:'attackNearest', args:['wandering_trader', true]}`。若有 llama，链一个第二节点 `attackNearest('trader_llama', true)`。
- **位置**：`enqueueHead`（最高机会主义@87，刚好食物危机88 之下，矿86 + 一切日间之上）。立即 raise interrupt_code，kernelDriver ≤1s 内夺位派发。**仅** HOLD95/夜链91-94/食物危机88 凌驾它。
- **生命周期**：per-trader。key=`enc#trader@xyz`。kill 或 despawn/landmark>30s 陈旧 → `bot._oppTraderSeen`（长 TTL ~2h，商人一次性）。`isGoalDone`：attackNearest 返回（one-shot）。

**#5 FOOD STRATEGY：预铁甲 wheat+bread 主食 / 床后小麦农场 + 动态停止**
- **(A) 预铁甲偏置**（无新任务，重加权既有 GET_FOOD + 村庄/动物 trigger）：`(vitals.armor||0)<4` 时——GET_FOOD 的 feedUp 得 `preferBread:true` 提示（优先觅食小麦/掠村庄面包/用携带小麦烤面包**先于**狩猎，因狩猎让裸甲 bot 暴露于 mob——86% 裸甲死根）；OPP_SEIZE_VILLAGE +10 priority（67→77）；OPP_HUNT_ANIMAL 的 `foodDeficit_weight *= 0.7`（当 wheat/bread 源可达）。**偏置非硬规**——绝不死锁无食 bot（无 wheat 可达时仍狩猎）。
- **(B) 床后小麦农场 + 批量面包**：
  - **新 skill** `bots/_supervisor/skills/wheatFarm.js`（唯一真缺口）：`tillAndSow(bot,x,y,z,'wheat')`（`skills.js:3639` 种植原语）+ `collectBlock('wheat')`（收熟）+ `craftRecipe('bread', n)`（3 wheat→1 bread）。循环：床旁确保小块田（till+sow 带水相邻）、收熟麦、补种、烤到目标、RETURN。自限时 ~90s，任何 guard（hostiles>2/food<6/hp≤4/interrupt_code）yield。stamp `bot._wheatFarmCooldownUntil`。
  - **谓词**：`bedKnown(bot) && phase==='day' && !threat && breadStock<dynamicBreadTarget() && hasSeedsOrFarmReachable && Date.now()>=bot._wheatFarmCooldownUntil`。
  - **任务**：`{kind:'OPP_WHEAT_FARM', priority:40, skill:'wheatFarm', args:[{breadTarget:dynamicBreadTarget()}]}`，position=tail，lifecycle=persistent-recurring，key=`wheat_farm`。
  - **动态停止 `dynamicBreadTarget(bot, world) → int`**：
    ```
    base = 6
    if (!bedKnown) return 0                                   // 无床不农（前提）
    if (armor<4) base += 4                                    // 预甲：面包为主食 → 囤更多(10)
    else if (pickTier∈{iron,diamond}) base -= 2              // 后期：肉/它食充足，缩到 4
    if (woodUnits<WOOD_BUFFER || picks<1) base -= 3          // bootstrap 未完 → 别过投农场
    if (migration.recommend) base = min(base, 2)             // 将搬迁 → 别农会弃的田
    if (freeSlots < 6) base = min(base, currentBreadStock)   // 背包将满 → 停囤
    if (bankChestKnown(bot)) base += 4                       // 有家箱存余 → 可多囤
    if (food < 8) base += 2                                  // 当前饿 → 多烤点
    return clamp(base, 0, 14)                                // 绝不囤>14
    ```
    STOP 语义：`isGoalDone(OPP_WHEAT_FARM)` = `currentBreadStock >= dynamicBreadTarget()`。每扫重算 → 喂饱/后期/将搬/无存储时自然停，吃掉面包/进度变化时重武装。~5min 跨 pass 冷却（作物分钟级成熟，每 2s 重发会冻在未熟田——villageHarvest-pin 失败模式）。

**#6（仅引用，单独 ticket T-0090）IRON-ARMOR 后猪栏**
不在此构建。前提：`armor≥4(iron) && invCount(/^lead$/)≥1（来自#4）&& bedKnown`。属 BUILD_HOME band（~42，空闲安全时跑，**非** head-insert）。本目录只确保其输入（栓绳/小麦/床）被机会主义产出。

### 5.4 跨切约束（保留稳定修复）
- 全局门（§5.1）= kernelDriver reflexBusy + recovery-kit yield。
- 夜里仅 OPP_MINE_VEIN_ORE（alreadyDeepEnclosed 时）和 OPP_TRADER_LEAD（贴脸）可发；#2/#3/#5 day-gated。夜链 91-94 总凌驾每个机会主义。
- 每个机会任务带 lifecycle key + dedup store + TTL（复刻 villageHarvest 冷却），单 kind 单飞行，每扫重排替换不堆叠。
- ARG 快照：入队时冻结 args（ore subtype/species/breadTarget），重排/defer 不让它陈旧。

---

## 6. Layer contracts：谁拥有什么

> 三层 + 一个新模块簇。**Reflex 留在队列外**是铁律。

### ① `modes.js` —— 反射 + 世界模型 + trigger 计算 + 扫描器（队列外）
- **反射/本能**（队列外，中断驱动，照旧）：self_preservation / self_defense / threat_radar / reflex_watchdog / mobility / auto_eat / item_collecting / tool_keeper / edge_unstick / **go_to_bed_sleep 本能**（`modes.js:4459-4482`，经 `instinct.runInstinct`，不进队列）。
- **世界模型计算**：每 2s 算 `bot._world`（`modes.js:4080-4490`）。
- **trigger 输入计算**：`computeNightPlan`（`~4382`，喂 `bot._world.nightPlan`）、`computeOpening`（`~4400`，含 T-0089 冷却门 `4407`）。
- **`bot._nightSeq` 维护**（新）：world_model mode 里追踪 `this.lastPhase`，day→dusk 边沿 `bot._nightSeq++`。可选把 `bot.time.age` 透传进 `bot._world.time.age`（若该 mineflayer 版本填充）。
- **C328 扫描器**（`4279-4303`）+ 机会主义检测器：加 ore/trader/trader_llama sweep；调 `this._fw.spliceOpportunistic(bot, {...})` 喂机会进队列。
- **commit 调用点**（`4448-4450`）：`commitGoal` → `commitQueue`（同签名）。加 SEAT 1 LLM gate（`if(llmGateEnabled())`）+ `triggers.gcKeys(bot, liveKeys)`。
- **famineBodyFreeze T-0088 yield**（`modes.js:22-63`，`_recoveryVentureUntil`）：**不动**。门 body 不门 dispatcher。

### ② `world_model.js` —— 队列 ops + 生命周期 + reconcile
- **`commitQueue(bot, proposals, world)`**（取代 `commitGoal`，`382-439`）：reconcile，复用 `isGoalDone`(`325-358`)/`isEmergency`(`360-367`)/`isNightPlan`(`372-375`) **逐字不改**作为 HEAD 排序规则。逐字保留 T-0081 nightPre + 回归守卫(`408-413`)作 HEAD 抢占条件。继续写 `bot._commitment` 头快照（含 `.id`）向后兼容。
- `seedFromProposals` / `spliceOpportunistic` / `vetoTask` 新增。
- `proposeTasks` **不变**（照旧产全排名）。
- `dynamicBreadTarget()` / `pickTierSatisfies()` 助手新增。
- `isGoalDone` 加 OPP_* + （可选）SURVIVAL_NIGHT 分支。

### ③ `task_queue.js`（新）/ `triggers.js`（新）/ `llm_gate.js`（新）
- **`task_queue.js`**：`makeQueue`/`makeTask` + 全部 ops（§2.4）。零 LLM，纯函数 over `Task[]`。
- **`triggers.js`**：TriggerSpec 注册表 + `bot._triggerState` episode 状态 + `shouldFire`/`markFired`/`cancelTrigger`/`isCancelled`/`gcKeys`/`lifecycleKey`/`reevaluateHead`/`stillValid`。**唯一**的取消账本拥有者。模式匹配 `instinct.js:91-156` 的懒初始化 + 重武装 sweep。
- **`llm_gate.js`**：enable 标志 + 同步 `llmGate` + `wireLlm`。取消委托给 `triggers.cancelTrigger`（不自带存储）。BOM-safe config 读（复刻 `world_model.js:76-105`）。

### kernelDriver —— consume-head（改动最小）
- 读：`const c = bot._commitment`（**不变**——commitQueue 持续写头快照，现含 `c.id`）。
- 派发触发器（`kernelDriver.js:110`）：`(c.skill !== lastSkill || c.id !== lastId)`——加 id-change 让同 skill 队头互换重派发。需 commitQueue 也写 `bot._commitment.id`。
- 中断监视（`121-129`）：`nc.id !== startId`（从 `nc.kind !== startKind` 泛化）——任意队头变化（重排/抢占）raise interrupt_code。同 1000ms setInterval、同机制。
- 子返回：经 SEAT 2 `reevaluateHead`（§3.4，含 llmGate）。`reflexBusy`门(`38-54`)、nether/portal win-state、cancel 握手、1500ms 反热旋节流 **全不变**——队列对 kernelDriver 不可见，除头快照外。

---

## 7. Migration：shadow → cutover（保留所有稳定修复）

> 指导原则：队列是单承诺的**超集**。`shadow → parity → cutover → teardown`，flag 门控，parity 记进 `framework-shadow.log`，每步 `node --check` + 重启验证（新进程 CreationDate）。**每个稳定修复是队列转移的约束，绝不改队列结构。**

### 7.0 数据结构（跨所有 phase）
`bot._taskQueue : Task[]`（`[0]=HEAD`，内存）。不变量：恰一个 active 且 == HEAD（== 今天 `bot._commitment`）。无并行。args 入队时不可变快照。`bot._commitment` 作头快照 dual-write 保留到 Phase D。flags `taskqInsert`/`taskqLive` 从 `decision-config.json` 读（BOM-safe，`world_model.js:76` 已加载）→ 翻 flag 只需 watchdog-restart，无代码重部署。

### 7.1 PHASE A（SHADOW，零行为改变）
- 加 `commitQueue()` 到 `world_model.js`，**镜像** commitGoal 的选择——队头**必须**等于 commitGoal 刚写进 `bot._commitment` 的。`modes.js` 调用点**同时调两者**（commitGoal 仍权威；commitQueue 只填影子队列）。
- 扩展 `kernel._shadowObserve`（`kernel.js:91-109`）log `qhead=<kind> parity=<head.kind===commitment.kind?Y:N>` 到 `framework-shadow.log`。
- kernelDriver 仍读 `bot._commitment`。
- **退出判据**：parity=Y 跨完整 day→dusk→night→dawn 周期 **AND** 一次 food≤4 emergency 抢占 **AND** 一次 nightPre 陈旧日间→夜计划提升（两条 thrash 易发路）。

### 7.2 PHASE B（OPPORTUNISTIC INSERTIONS，flag `taskqInsert` 默认 OFF）
- 允许 commitQueue 为低排名 proposal（GET_BED@50/GO_UNDERGROUND@45）入 queued 节点，backlog 显式。HEAD 选择仍镜像 commitGoal。flag OFF = 无 queued 节点 = 纯镜像。
- 同 flag 下接入 `spliceOpportunistic`（§5）+ `triggers.js`。隔离唯一新能力（backlog + 机会主义），独立 parity-check 后才允许影响派发。
- **可选**：Phase B 可整体推迟，先发 A→C→D 纯结构镜像（最低风险，backlog 作后续）。

### 7.3 PHASE C（CUTOVER，flag `taskqLive` 默认 OFF）
- kernelDriver 读 `taskqLive ? peekHead(bot._taskQueue) : bot._commitment`。commitQueue 继续写 `bot._commitment = head`（任何 straggler reader + 中断监视 fallback 仍工作）。翻 flag → kernel 消费头。回滚 = 清 flag（无决策逻辑重部署）。
- **RESTART-class**（kernelDriver 是 sticky 顶层循环——必须 kill+restart，hot-reload 不重入，见 hot-reload-deploy-mechanics 记忆）。
- SEAT 1/SEAT 2 LLM gate 在此 phase 已接线但 `llmGateEnabled()` 默认 false（纯本能，§4）。

### 7.4 PHASE C+（可选增量）SURVIVAL_NIGHT 合并
Phase C 稳定后，可把四个 DUSK_*/NIGHT_* 任务合并为单 SURVIVAL_NIGHT trigger（§3.3），`isNightPlan` 加 `kind==='SURVIVAL_NIGHT'`。这是独立可回滚增量——四任务版与单任务版行为等价（都"一个 trigger 动态解析"）。

### 7.5 PHASE D（TEARDOWN）
Phase C 稳定跨多个昼夜 + 一次死亡/重生 + 一次 marooned-march 后：删 commitGoal 单承诺体（保留薄 shim `commitGoal = ()=>peekHead(commitQueue(...))` 一个 release 作回滚锚，镜像 missionNether 保留方式），移除 `bot._commitment` dual-write，移除 flags。modes.js 调用点丢掉 commitGoal。

### 7.6 RESTART vs HOT-RELOAD（每改动）
| 改动 | class | 原因 |
|---|---|---|
| `world_model.js` commitQueue/proposeTasks | **RESTART** | 经 `this._fw=await import(...)`（`modes.js:4447`）缓存，ES 重导入不像 customSkill `?t=Date.now()` 每 tick 失效 |
| `task_queue.js`/`triggers.js`/`llm_gate.js`/`contracts.js`/`kernel.js` | **RESTART** | 同 import 缓存 |
| `modes.js` 调用点行 | **RESTART** | ① 层 always-on mode |
| `kernelDriver.js` | **RESTART** | sticky 顶层循环；文件 hot-reload 仅下次 `customSkill('kernelDriver')` 派发拾取，运行中循环不重入——须 watchdog-restart/cancel 重武装 |
| flag 翻（`taskqInsert`/`taskqLive`/`llmGate` 经 config.json） | **config-edit + watchdog-restart** | BOM-safe 加载，无代码重部署 |

### 7.7 PRESERVE-STABLE 清单（cutover 后必须全部成立）
- **T-0081**：陈旧 MIGRATE@60（黎明起）在黄昏被夜计划@91-94 夺位，kernel 经队头变化中断 ≤1s 重派发。
- **回归守卫**：food=1-at-night feedUp↔nightShelter thrash **不能**复发（emergency 队头不被夜计划夺位——`cIsEmergency` 短路逐字保留）。
- **T-0083**：地下挖矿 bot（mobility FREE 但 enclosed）**不**被冻（reflexBusy 忽略裸 enclosed，`kernelDriver.js:42-49`）。
- **T-0088**：food=0/hp<8 recovery 仍**移动**身体（`_recoveryVentureUntil` 窗尊重；recovery skill 仍是 head skill + freeze allowlist；recovery skill 映射到 GET_FOOD/MIGRATE 即 emergency kind，本就最高优先级队头，无需新逻辑）。
- **T-0089**：耗尽村庄冷却期内**不**重派发（OPENING_VILLAGE 在 computeOpening 源头被抑制，从不进队列；`isGoalDone(OPENING_VILLAGE)` 在冷却抑制时返回 true 让头自然完成）。
- **反热旋**：nightShelter('seal') 瞬返**不**热旋（1500ms 节流 `kernelDriver.js:146` 不变）。

---

## 8. Open questions

1. **`bot.time.age` 可用性**：本代码库今天只读 `bot.time.timeOfDay`（多处证实），从不读 `bot.time.age`。本设计已把 `bot._nightSeq`（day→dusk 边沿 +1）定为**权威**夜钟，`age` 仅作可选优化。仍需在目标 mineflayer 版本上确认 `bot.time.age` 是否单调填充，再决定是否启用该优化路；在确认前**纯用 `_nightSeq`**。
2. **跨重启持久化**：v1 内存（匹配今天 commitment / instinct episode 的不持久语义）。`persist:true` Task flag（如"挖矿后回家"survive death）需 per-bot 文件命名空间避免 landmarks.json 多 bot 冲突——deferred 到 Phase D 之后单独 ticket。中途重启的 SURVIVAL_NIGHT cancel 是否需 survive 同问。
3. **机会主义优先级校准**：临近度→优先级阈值（diamond<8b→90+? animal<16b→?）需游戏内调。起步保守（机会主义 ≤89，below noPick BOOTSTRAP@90 + food@88），found-diamond 显式用 enqueueHead 而非高数字。#3 成本/收益常数（distCost=dist*2、dangerCost、meatStock<4 cutoff）是初版权重，需对真实 playthrough 校准（建议把 score+decision log 进 act_trace 调优）。
4. **OPP_SEIZE_VILLAGE@67 vs GET_ARMOR@68**：armor≥4 时村庄坐 armor 之下——正确还是"路过的村庄总该赢过造甲"？倾向 bootstrap 后 armor>village，但 flag 待定。
5. **backlog 陈旧 vs 重 seed**：proposer 任务每 2s 重 seed 保鲜 args，但**被抢占的** proposer 任务坐尾部时保留旧快照 args 直到重 seed——确认 commitQueue 在每次现存任务 upsert 时刷新 args（应该，镜像 `world_model.js:428`）。
6. **LLM cancel 粒度**：spec 说 SURVIVAL 任务整晚取消（whole lifecycle）——cancel 抑制当晚全部下地/去床/seal。若用户要"只否决挖矿、仍允许 seal"需 sub-trigger 粒度（node/decision-keyed sub-scope），本设计可扩展但未实现。
7. **encounter/node key GC 节奏**：`gcKeys` 在 2s tick 用 live key-set。wandering-trader 需 entityId 跨 tick 稳定，确认 bot 实体 id 稳定让被否决商人保持否决直到真 despawn（非每 tick 当"新"遭遇重发）。
8. **reflexBusy 导出**：kernelDriver 的 `reflexBusy()` 仍是局部。若 commitQueue 需在 ENTOMBED 时避免提升 HEAD，reflexBusy 应成世界模型谓词——v1 不需（kernelDriver 仍门派发），记录。
9. **中断延迟**：队头变化仍有最多 1s 检测延迟（1000ms setInterval）。可接受（匹配今天），但 found-diamond enqueueHead 不会快于 ~1s 抢占——除非某用例需亚秒。
10. **commitGoal stickiness 与 shouldFire 交互**：今天 commitGoal hold 到 isGoalDone。有了 trigger，被取消的 SURVIVAL_NIGHT 即使 proposeTasks 仍 surface 它也**不得**重承诺——确认 commitQueue 调 `shouldFire`（非仅读 proposal 列表）让 `llmCancelledFor` 在**承诺座位**而非仅**提议座位**被尊重。
