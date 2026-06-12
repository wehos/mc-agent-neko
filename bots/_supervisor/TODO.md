# MC-agent 能力边界 TODO（未来方向，按用户 2026-06-01 决策暂缓）

> 用户当前优先级：**先磨"从零到屠龙整条线"的流畅性 + 鲁棒性**。
> 下面三条是已对齐但暂缓的探索方向，将来回来时按需开工。
> 入口提示：本文件 + `memory/mc-agent-supervision.md` 是恢复上下文的两个锚点。

## 方向 A：去监督化 · 自主跑（测真正的自主能力上限）
- 撤掉 `run_skill` 人工投喂（bridge inbox → ws_server.runSkill 这条直通道）。
- 让 LLM coder（src/agent/coder.js）+ modes（src/agent/modes.js）自己端到端跑，
  观察不靠我手动喂 `{"skill":...}` 能自力走多远。
- 关注点：supervised_skill 锁现在会吞掉 system/self 消息（agent.js handleMessage 顶部），
  自主模式下要确认 LLM 的 think→code→execute 循环没被这套监督脚手架卡死。
- 度量：清世界冷启动 → 无人工干预能达成的最高 progress 阶段（progress.txt）。

## 方向 B：泛化到任意目标（别只盯 diamond_pickaxe 硬编码链）
- achieve.js 目前是为 diamond_pickaxe 通关链特化的递归编排器。
- 测 achieve() / achieveLoop 对任意目标的鲁棒性：建房子、找村庄、搭刷怪塔、
  收集任意 N 个某资源、做附魔台等。
- 关注点：achieve.js 里大量 if-branch 是针对特定物品（furnace/diamond/planks）的，
  泛化时要抽出"目标 → 前置依赖树"的通用解析，而不是逐物品 hardcode。

## 方向 C：补高阶本能（战斗/生存操作天花板）
- 落地水 MLG water clutch：高空下落时检测将要落地 → 放水桶接 → 落地后收水。
  需要水桶在物品栏 + 朝下放水时机判断。
- 风筝/蛇皮走位 kiting：对远程怪（骷髅/凋灵骷髅）边后撤边射/砍，不站桩。
  shieldFight.js 已有 RANGED-FIRST 雏形，但缺"边移动边攻击"的连续走位。
- 岩浆/深渊处理：挖矿遇 lava 主动封堵/绕行（现在只靠 digDown 的被动避让）；
  深水/海洋穿越。

---
## 本轮在做：整条通关线的流畅性 + 鲁棒性（进行中）
当前已知最大卡点：**下降到矿层这一步**——
- 慢速全封闭楼梯下降：安全但 ~20min，根本到不了挖矿就超时。
- 快速 digDown 下降：会挖进水里淹死。
目标：做一个"避水 + 不超时"的下降（检测下方水/熔岩则封堵或绕，
速度介于两者之间）。修稳后 → 钻石镐 → 顺下去测后半程（地狱门→屠龙）。
