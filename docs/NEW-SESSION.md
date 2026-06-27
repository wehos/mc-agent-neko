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
| `botwatch.mjs` | **sentinel**：读全知态(world_model+vitals)探测异常→建工单+自动复验，写 `sentinel.json` | — |
| `ticket-server.mjs` | 工单单写者 + 网页 UI | 48920 |

## 2. 取证（主动求证全知态，不被动读单行日志）

- **先读 `bots/_supervisor/sentinel.json`**（每 15s 刷新）：world_model+vitals+活跃探测器+最新帧 的**单文件全知摘要**——pos/hp/food/mobility/picks/commitment/threat/成果向量(staleMin)/activeDetectors。一眼看清"现在真实状态 + 卡在哪"。
- 原始源：`world_model.json`（mobility.state/kit.picks/commitment——bot 自己算好的全知态）、`vitals.json`（pos/hp/food/**inv**）、`events.log`（死亡/告急/自报卡死）、`progress.txt`（skill 心电图）。
- **黑匣子回放**：`node bots/_supervisor/frame-at.mjs 04:52`（UTC→最近帧路径，Read 出来**用视觉信号核对**）。`--window 90` 列窗口帧。
- **铁律：主动求证 + 多信号交叉 + 视觉核对**。①别信单行乐观日志（死亡/卡死藏在别处）；②"有动静"≠"有进展"——missionNether 自踢重启会刷日志/微抖位置制造假活，**只有成果向量(镐/台/木/食/矿/甲)推进才算进展**；③下"她没事/在干活"结论前，必读 sentinel.json + events.log `阵亡|告急` + 看一帧。

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
- **★Autonomous 工单契约（不空转）**：同一时刻只"真正在改"≤1 张单；首次修完+部署+冒烟 → 转 `verifying`（=**观察中**，挂 Monitor 盯复发、不主动死盯）→ **立刻 `claim next` 接下一张**。`verifying`/观察中的**不算**占用，不阻塞接新单。复发（botwatch 同 dedupKey 再命中）→ reopen，由**原认领者返工**；观察够久没复发+游戏内验证过才 `closed`。详见 [parallel-tickets.md](parallel-tickets.md) 的「Autonomous 工作契约」。
