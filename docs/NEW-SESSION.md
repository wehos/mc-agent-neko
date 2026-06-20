# 新 session 从这里开始（Neko MC 监工）

> 一个**正在运行**的 Minecraft bot（Neko），你的工作是观测问题、诊断、改代码让它更鲁棒。
> 这份是 2 分钟快速上手；深层背景在 [HANDOFF.md](HANDOFF.md)，并行工作流在 [parallel-tickets.md](parallel-tickets.md)，改动台账在 `bots/_supervisor/CHANGELOG.md`。

## 0. 第一件事：看板认领（跨 session 不撞车）

```
node bots/_supervisor/ticket.mjs onboard      # 打印所有 active 工单 + 谁认领了 + 怎么领
node bots/_supervisor/ticket.mjs claim T-0007 --as <你的唯一tag>   # 领一张(挑唯一tag:claude-B/user)
```
认领走常驻 server（:48920，人类网页 UI 也在那），第二个领同一张的收 409。**这就是你和其他 agent/主 session 同步的地方。**

## 1. 在跑的栈（都常驻，watchdog.ps1 保活）

| 进程 | 作用 | 端口 |
|---|---|---|
| `main.js` | bot 本体（agent + WS server） | 48909 |
| `bridge.mjs` | 写 vitals.json/events.log/frame.jpg + 滚动帧黑匣子 frames/ | — |
| `botwatch.mjs` | 自动探测异常 → 建工单 | — |
| `ticket-server.mjs` | 工单单写者 + 网页 UI | 48920 |
| `overseer.mjs` | 风险引擎 → advisory.json | — |

## 2. 取证（诊断靠"录好的证据"，不靠盯实机）

- `bots/_supervisor/vitals.json`（pos/hp/food/skill，~15s 刷新）、`events.log`（死亡/告急/日志）、`progress.txt`（skill 逐步心电图）
- **黑匣子回放**：`node bots/_supervisor/frame-at.mjs 04:52`（UTC 时间→最近帧路径，Read 出来看）。`--window 90` 列窗口帧。只从黑匣子启用时刻起有帧。
- **判健康必须多信号交叉**：看一行乐观日志就下结论会出大错（死亡藏在 events.log）。

## 3. 三层架构（遇问题先想该改哪层）

① **反射本能** `src/agent/modes.js`（中断驱动，如封顶/脱困/mobility 状态机）—— 改完**需重启**
② **工具内置行为** `src/agent/library/skills.js`（collectBlock/pickup/寻路 Movements）—— 改完**需重启**
③ **策略 skill** `bots/_supervisor/skills/*.js`（missionNether 顶层 sticky、chopWood、prepNether…）—— **热加载即时**（但顶层 missionNether 改了要重启 re-arm）

## 4. 部署闸门（必须串行——只有一个 bot/世界）

1. `node --check <改的文件>`
2. ③ 子 skill 改完即生效；① ② + 顶层 missionNether → **重启 main.js**（配方见 watchdog.ps1 `Restart-Agent`：杀 main+清端口 8765/48909+`NEKO_AGENT_SCREENSHOT_INTERVAL_MS=15000 node main.js`，冒烟自检=48909 listening + vitals.json ts<20s 新鲜）
3. 重启前先 `ticket.mjs comment <id> "deploying now"`，做完 `"deployed"`（约定串行，别两个 agent 同时重启）
4. 工单转 `verifying` 盯实机，**游戏内验证过**才 `closed`（mock 单测 ≠ 验收）

## 5. 铁律（用户多次强调）

- **全程中文**交流。
- **绝不甩锅世界 / 绝不建议重 roll**——bot 哪都失败=代码的错，在当前世界把卡点修到能活。
- **功能必须游戏内验收**，验不了就请用户手动触发检查。
- **任何 bug 第二次发生=当场沉淀成代码改动 + CHANGELOG**（带可证伪预测）。
- **高自主**：能决定就自己决定，随便重启折腾；但**绝不自动重开世界**（不可逆）。
