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

`open → claimed → in_progress → fixed → verifying → closed`（或 `wontfix`）

```
node bots/_supervisor/ticket.mjs update T-0007 --status in_progress
node bots/_supervisor/ticket.mjs comment T-0007 "根因=X,在 file:line"
node bots/_supervisor/ticket.mjs update T-0007 --status fixed --note "C282 ..." --commit <sha>
# 部署+游戏内验证后:
node bots/_supervisor/ticket.mjs update T-0007 --status verifying   # 已部署,盯实机
node bots/_supervisor/ticket.mjs update T-0007 --status closed --note "实机验证通过:..."
```

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
