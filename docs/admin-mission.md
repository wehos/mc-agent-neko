# Admin 任务态：持续 self-prompt 最高优先级任务 (2026-07-07)

## 是什么
每一条 **admin 指令**（WS `task` 帧 **或** 游戏内 chat）不再是"跑一回合就完事"的一次性动作，
而是变成一个**最高优先级、持续 self-prompt 的任务**，直到 agent（内部 gpt-5.4-mini）自己判定：
**完成 / 被新任务覆盖 / 无法完成 / 被死亡·求生打断**。

核心是新控制器 [`src/agent/admin_mission.js`](../src/agent/admin_mission.js) 的显式状态机
（`IDLE → RUNNING → ENDING → IDLE`），它**复用现有的 `self_prompter` 作为持续自驱引擎** —— 于是
"求生反射打断→自动恢复"、"modes should_reprompt 抑制"、"bot 间对话 pause/resume" 全部自动继承，
**不引入第二条抢身体的控制回路**。

> 旧行为（保留在 flag-OFF 路径）：`handleMessage('admin')` 置 5min `_extIntentUntil`，跑
> `max_responses` 有限回合，`finally` 里清窗口 + 发 `task_finished` —— **无论目标是否真的达成**。
> 缺的就是"持续自驱直到判定完成"这一半，本机制补上。

## 四种终止条件
每个任务**恰好发一帧 `task_finished`**（由 `end()` 的幂等闸 `state!==RUNNING 即 no-op` 保证，
第一个成因赢、任何竞态的第二个成因空转）：

| 条件 | 触发信号 | 上报 `status` |
|---|---|---|
| **完成 DONE** | LLM 发 `!endGoal` | `ok` |
| **覆盖 OVERRIDE** | 新 admin 指令进来（`submit` 串行化） | 旧任务 → `superseded`，随即起新任务 |
| **不可完成 IMPOSSIBLE** | LLM 发 `!cannotComplete(reason)`；或连续无进展仲裁后放弃；或超时；或死亡超预算 | `failed`（消息带原因） |
| **环境/威胁/死亡 SURVIVAL** | 溺水、着火、岩浆、坠落、现实敌对威胁反射 / `bot.on('death')` | **任务不结束**，自动恢复；仅死亡超预算才发一帧 `interrupted` |

- **环境与现实威胁优先**：`vitalNow`（溺水/着火/岩浆）及当前伤害、可达敌对生物等事实驱动反射
  独立于任务。绝对血量不会抢身体、强派任务或改变任务让位；唯一例外是使用背包已有食物/治疗药水回血。
- **死亡**是"带预算的求生打断"：默认容忍 3 次死亡（就地重生后继续奔目标），超预算才中止；
  重生时**抑制 sticky_skill 复派**（否则一个无关的旧 grind 会抢身体把任务饿死 —— 红队最危险的发现）。

## env 开关与硬上限
| 变量 | 默认 | 含义 |
|---|---|---|
| `MC_ADMIN_MISSION` | **开**（≠`0` 即开） | 设 `0` **秒回退**到旧一次性 admin 路径（每个热点路径都 gate，flag-OFF = 逐字节旧行为） |
| `MC_ADMIN_MISSION_MAX_MS` | `1800000`（30min） | 任务挂钟硬上限；**有可见进展（背包/维度变化）则续期**，只有真·停滞才被砍 → 判 `failed`（`deadline`） |
| `MC_ADMIN_MISSION_DEATH_BUDGET` | `3` | 容忍的死亡次数；`0` = 死亡即中止 |

`_extIntentUntil` 仍是**有界滚动 5min 崩溃兜底**：只在 self_prompter 真·ACTIVE 时（非 PAUSED）由
`adminMission.tick` 续戳；控制器若异常挂掉没走 `end()`，kernel 5min 内自动恢复正常任务派发。

## task_finished 状态词表（⚠️ 外部插件依赖）
本仓库侧现在会发 `ok` / `failed` / `superseded` / `interrupted` 四态（旧路径只有 `ok`/`interrupted`）。
设计保证**失败绝不会被上报成 `ok`**。但外部插件（`game_agent_minecraft`，独立仓库）需要能识别
`failed`/`superseded` 才能让对话 LLM 精确叙述结局 —— **翻 flag 前先确认/补插件侧**。若插件暂不认新词，
最坏情况也只是把 `failed`/`superseded` 当"非成功"处理，不会误读成成功。

## 命令（喂给 mini-LLM）
- `!endGoal` —— **完成**信号（任务活跃时结束任务；否则退回旧 self-prompt 停止语义）。
- `!cannotComplete("reason")` —— **不可完成**信号（新增）；仅在真·做不到时用（无树可砍、拿不到必需工具），
  别拿它当"慢/难"的借口。`neko.json` 提示词已教会模型跨回合坚持目标；背包内回血和现实威胁反射由运行时处理。

## 撤销
`MC_ADMIN_MISSION=0` 重启即回退到旧一次性 admin 行为，死亡即发 interrupted 帧
（逐字节不变）。控制器文件与命令留着无害（未激活）。

## 涉及文件
- 新增 [`src/agent/admin_mission.js`](../src/agent/admin_mission.js) —— 任务 FSM 控制器。
- [`src/agent/agent.js`](../src/agent/agent.js) —— 构造/flag/镜像、chat 路由、`handleMessage` 双闸、
  `update` tick、death/disconnect/cleanKill/shutUp 汇入 `end()`、monitorRespawn sticky 抑制。
- [`src/websocket/ws_server.js`](../src/websocket/ws_server.js) —— `task` 路由、`beginMissionTask`/
  `finishMission`（显式带 task_id，**不碰 `injectedTaskIdQueue`** → 杜绝 FIFO 错位）、`onTaskCompleted`
  单发去重、`runSkill` suspend/resume。
- [`src/agent/self_prompter.js`](../src/agent/self_prompter.js) —— `owner` 钩子、supervised 期泊车不计罚、
  `MAX_NO_COMMAND` 走 `owner.onNoProgress()` 仲裁。
- [`src/agent/commands/actions.js`](../src/agent/commands/actions.js) —— `!endGoal`/`!cannotComplete`/`!goal` 守卫。
- [`src/agent/framework/kernel.js`](../src/agent/framework/kernel.js) —— 任务期独占和普通派发仲裁。
- [`neko.json`](../neko.json) —— 持续目标 / `!endGoal` / `!cannotComplete` / 自我保命 提示。

## 上线注意
核心文件（agent.js/ws_server.js/kernel.js/self_prompter.js/admin_mission.js）在进程启动时加载，
**不热载** —— 改动**需重启** bot（`start-neko.ps1` 或 watchdog 自动重启）才生效。默认开，重启即 LIVE。
