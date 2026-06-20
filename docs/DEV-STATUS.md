# 开发状态（持续维护）

记**接下来做什么 / 做完什么 / 已知问题**。当前主线：overseer 监工系统。
（设计细节见 `overseer.md`，过程笔记见 `overseer-notes.md`。）

## 🔜 接下来要做（TODO）

**▶ 下一任务：ticket-server 扩展**
- `route: agent|human` 字段（worker 只认领 agent 单，拿不准归 human）。
- `commit`+`report` 关单硬闸门（agent 单进 fixed/closed 必带，可 `git cat-file` 验 SHA）。
- `related` 关联 + `POST /link`。

**▶ botwatch 生产重启（暂存，下个自然窗口）**
- 重构已提交（2d138b0）+ boot-test 验证启动，但 live 进程仍跑旧码；当前健康稳定、双开已自然消失，故不主动打断 → 下个自然重启由 watchdog 加载（bb-readers.mjs 已在工作树，重启必成功）。

## ✅ 已完成（2026-06-20）

- **取数链路落地 + 实跑验证通过 + 已提交**（本 session 重建——上个 session 写好但因 `.gitignore` 的 `bots/**/` 父目录排除规则未能进 git、文件丢失）：
  - `bb-readers.mjs`：共享读取层（rd/rj/readJsonl/latestFrame/eventsTail/readState/chunkKey）。提交 76bcf51。
  - `overseer-snapshot.mjs`：监工唯一取数命令，四区 + 6 指标注册表，每项带 id/evidence/change，维护 overseer-prev.json 算 delta。提交 76bcf51。
  - `botwatch.mjs` 重构为 import bb-readers（324 → 272 行，零逻辑改动）；同提交落盘 C284 sentinel 重写。提交 2d138b0。
  - `.gitignore`：三段式 negate 放行两个源文件（运行时产物仍忽略）。
  - 验证：snapshot exit 0、~16KB JSON、四区完整；抓到真实信号——`death_breakdown`（近24h 92死/100%无甲/84%空手/67%夜）、`death_hotspot`（chunk 1,-2 = 已建单 badlands 死亡区 spawn）、`repeat_loop`（20.5% pocket-carve 假活）。
- **监工首轮跑通（人召唤 = 一轮）**：取数→判断→落地闭环。结论 = **0 新单**（强信号均已被 T-0002/T-0028/T-0029 等覆盖，慢性病不重报）+ **1 留观 WL-1**（"反射受击中 wedge force-release 28×"，疑助推空手死，下轮复核）。验证了防幻觉设计——不为交差硬建单。
- 监工设计闭环：`overseer.md`（含已审定的指标→异常对照表 6 项）、`overseer-notes.md`。
- 删旧 `overseer.mjs`；`NEW-SESSION.md` 加监工入口；memory。

## ⚠️ 已知问题 / 待打磨

- **advisory.json 技术债**：旧 overseer 已删，但 modes / skills / worldModel 十几处仍读停更的 `advisory.json`（try/catch 降级）。待：重建生产者，或摘死分支。
- **指标窗口对齐（小）**：`resident_chunks` / `vitality_struggle` 用"最近4000样本"窗口（实测≈25h，做整体画像够用，但抓"最近15min骤停"偏粗——botwatch 实时检测器已覆盖那一面）；`death_hotspot` 用全时死亡÷近窗停留密度，久不去的旧死点 ratio 会虚高（但本轮 top 命中的是真高密度死亡区，未误导）。待按需细化时间对齐。
