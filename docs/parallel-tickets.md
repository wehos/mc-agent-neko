# 并行问题处理：ticket 系统（单一 MC session，多 agent 协作）

一场游戏（一个 bot、一个世界）只能有**一个驾驶员**，但"观测→诊断→改码"这条尾巴可以并行。
本系统把问题变成**持久、可认领、跨 session 同步**的工单，让我（主 session）spawn 的 subagent、
以及你新开的 Claude session，能瓜分问题而互不踩车。

## 架构

```
[1 个 bot：唯一控制车道] ──► 黑匣子(events.log/progress.txt/vitals.json/frame)
                                  │
                   botwatch.mjs 自动探测(death/stuck/idle/seal-fail) ─┐
                                                                      ├─► ticket-server (单写者, :48920)
                                  你 / agent 手动建单 ────────────────┘        tickets/<id>.json
                                  │
          ┌───────────────────────┼───────────────────────┐
      [agent A]               [agent B]               [user 新 session]   ← 并行,各读"录好的证据"
      claim T-1 → 诊断 → 补丁    claim T-2 → ...           claim T-3 → ...
          └───────────────────────┼───────────────────────┘
                          部署闸门：串行热重载/重启 + 冒烟自检（一次一个补丁）
```

**控制=1 车道（bot）；诊断+改码=N 车道（读证据+写代码）；部署=1 车道（串行）。**

## 新 session 一条命令上手

```
node bots/_supervisor/ticket-server.mjs   # 若没起(GET :48920/health 失败)先起这个
node bots/_supervisor/ticket.mjs onboard
```

`onboard` 打印：server 地址、各状态计数、所有 active 工单、哪些未认领、怎么认领。**读完即可开工。**

## 认领（跨 session 防撞车）

所有认领走 server 单写者 → 两个 agent 不可能同时拿到同一张单（第二个收 409）。

```
node bots/_supervisor/ticket.mjs next                 # 看下一张该做的未认领单
node bots/_supervisor/ticket.mjs claim T-0007 --as claude-B   # 认领;失败=已被别人拿,换一张
node bots/_supervisor/ticket.mjs mine --as claude-B   # 看自己认领了哪些
```

**身份 `--as <tag>`：每个 session 挑一个唯一 tag**（`claude-A`/`claude-B`/`user`…），否则认领会混。
也可设环境变量 `TICKET_ACTOR`。

## 工单生命周期

`open → claimed → in_progress → fixed → verifying(=观察中) → closed`（或 `wontfix`）

```
node bots/_supervisor/ticket.mjs update T-0007 --status in_progress
node bots/_supervisor/ticket.mjs comment T-0007 "根因=X,在 file:line"
node bots/_supervisor/ticket.mjs update T-0007 --status fixed --note "C282 ..." --commit <sha>
# 部署+游戏内验证后:
node bots/_supervisor/ticket.mjs update T-0007 --status verifying   # 已部署,盯实机
node bots/_supervisor/ticket.mjs update T-0007 --status closed --note "实机验证通过:..."
```

## ★Autonomous 工作契约（agent 不空转 / 观察中不阻塞接单）

**核心：每个 agent 同一时刻只"真正在改" ≤1 张单（`in_progress`）；首次修完转"观察中"就立刻去接下一张，永不空转。**

- **observing ＝ `verifying`**：首次修好 + 部署 + 冒烟自检通过 → 转 `verifying`（语义＝**观察中**：补丁已部署在跑，等是否复发）。**转入观察后不再主动死盯**——靠 botwatch / Monitor 的复发信号被动触发返工。挂个 Monitor 盯回归信号即可，人/agent 不用守着。
- **不空转铁律**：当你**没有任何 `in_progress` 单**时（`verifying`/观察中的**不计入**占用），**立即 `claim next` 接下一张未认领单**开工。一个 agent 可以同时挂着 N 张 `verifying`（观察中）＋ 至多 1 张 `in_progress`（在改）。
- **复发 → 原认领者返工**：一张 `verifying` 单若**复发**（botwatch 对其 `dedupKey` 再次命中，或人工发现），该单 **reopen**（转回 `open`/`in_progress`），由**原 `claimedBy` 返工**（不是丢给新人）——预测落空的条目要么修正要么回滚（同 CHANGELOG 科学家纪律）。
- **真正 `closed`**：只有"观察足够久没复发 ＋ 游戏内验证通过"才 `closed`。observing 不是终点，是**待复发裁决的中间态**。

agent 主循环（伪代码）：
```
loop:
  if 我有 in_progress 单 → 继续改 → 修好+部署+冒烟 → update verifying(观察中) + 挂 Monitor 盯复发
  elif 有未认领 open 单   → claim next --as <我的唯一tag> → update in_progress → 开干
  else                    → 盯自己 verifying 单的复发信号 / 帮审别人的补丁 / 打磨三层
```

### ★agent 自驱动：别停在 checkpoint（自 loop 反模式，实测踩过）

**反模式（2026-06-20 实测）**：agent 做完一个工作单元，输出一段 checkpoint 进度报告，然后**停下来等用户**——即使没有任何需要用户拍板的事、`in_progress` 单还没推进、`open` 队列还有活。"我继续推 T-XXXX" 成了空话：**对话式 agent 输出文本＝让出控制＝回合结束**，没有外部驱动就自续不下去。

**根因**：这正是 mc-agent 反复强调的 bot 第三原则——"**周期性承诺必须有机制载体（节拍器强制叫醒），不靠自觉**"——agent 把它用在了 bot 身上，却对自己的工作循环靠自觉续航。自觉必断。

**改进①（行为）**：autonomous 模式下，**一个回合内做完一单立即调下一个工具推进下一单**，连续工作，进度报告**穿插从简、绝不作为停止信号**。只在两种情况收尾让出控制：(a) 看板真没有可推进的活（无 in_progress + 无未认领 open），或 (b) 撞到**不可逆操作 / 必须用户拍板**的硬阻塞（如重开世界、删数据、策略级抉择）。checkpoint 报告 ≠ 回合结束。

**改进②（机制载体）**：跨回合续航必须有节拍器，三选一——
- **用户 `/loop`**（dynamic，无间隔自排）驱动 agent：最可靠，agent 每轮被叫回来扫看板。
- agent 自挂 **`ScheduleWakeup`**（loop 上下文内）或 **cron** 定期回来跑"看板扫描"：有 `in_progress` 没推进？有未认领 `open`？有 `verifying` 复发被 reopen？→ 接着干。
- 节拍器内容固定为：`ticket.mjs onboard` + `mine --as <tag>` → 按主循环伪代码推进。

> 一句话：**agent 治 bot 的"靠自觉必断"，先治自己**。

**机制载体（已实现，T-0018）**：复发裁决由 `ticket-server.mjs` 的 `createOrMerge` 落地——同 `dedupKey` 的复发命中一张 `verifying`(观察中)/`fixed`(待部署) 单时，**自动 reopen**：有 `claimedBy` → `in_progress`（原认领者返工）、无认领 → `open`，并清空 `resolution`、history 记 `RECURRED while verifying — reopened`。所以"观察中的单复发→原认领者返工"是 server 强制的，不靠自觉。
- **配套纪律**：**别把还在复发的条件 `closed`**——`closed`/`wontfix` 不在 merge 范围，关了它复发就只能另开新 dup 单（实测 T-0010/13/16 三连重复＝当时误把食物荒漠 pin 反复 close 所致）。复发的条件留 `verifying`，让 server 自动 reopen。`closed` 仅用于"观察够久确实没复发"。

## 改码隔离（并行不踩）

多个 agent 同时改码 → 各自用 **git worktree**（`Agent`/`Workflow` 工具的 `isolation: worktree`），
补丁通过部署闸门串行合并。诊断阶段是对"录好的证据"只读 → 无限并行。

## 部署闸门（必须串行）

只有一个 bot、一个世界，所以**部署/重启必须串行**，一次一个补丁：

1. `node --check` 改动的文件（语法）
2. 判断层级：
   - `bots/_supervisor/skills/<子skill>.js`（chopWood/feedUp 等）→ **热加载**，下次调用即生效，无需重启
   - `src/agent/**`（① 层 modes/skills/framework）+ **顶层 sticky `missionNether.js`** → **必须重启 main.js**
3. 重启配方（白天/无怪时做；夜里热重载封顶 skill 有把 bot 拽出庇护的风险）：
   ```
   # 杀 main + 清端口 8765/48909 + 重启(env NEKO_AGENT_SCREENSHOT_INTERVAL_MS=0)
   # 见 watchdog.ps1 的 Restart-Agent；冒烟自检:端口 48909 listening + vitals.json ts 新鲜(<20s)
   ```
4. 冒烟自检过 → 工单转 `verifying`，挂 Monitor 盯实机；游戏内验证通过才 `closed`（验收纪律：mock 单测≠验收）。

**部署锁**：同一时刻只允许一个 agent 重启 stack。约定：要重启前先 `comment` 工单"deploying now"，
做完再 comment"deployed"。（后续可加 `deploy.lock` 文件锁强制串行。）

## 自动探测在测什么（botwatch.mjs）

| 信号 | type | dedupKey | 触发 |
|---|---|---|---|
| 死亡计数上升 | death | death-loop | death_log.jsonl 增长 |
| 位置停滞 >6min | stuck | stuck:<区块> | pos 不动 |
| 进度冻结 >6min | idle | frozen | progress.txt 末行不变 |
| 封顶反复站下 | seal-fail | seal-fail | events.log ≥4× "Can't seal" |

dedupKey 让进行中的同一问题**合并成一张单**（bump occurrences），不刷屏。手动单不去重。

## 关键端点（agent 直接 curl 也行）

```
GET  http://localhost:48920/api/tickets?status=open-ish
POST http://localhost:48920/api/tickets/T-0007/claim   {"actor":"claude-B"}
GET  http://localhost:48920/            # 人类网页 UI(建单/认领/改状态)
```
