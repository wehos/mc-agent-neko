# 框架 v2 执行计划（2026-06-19 live 测试后定）

> 基于第一次 wooded_badlands live 测试（shadow）+ 用户人工肉眼观测的 9 条问题。
> 关联：[framework-v2-scaffold.md](framework-v2-scaffold.md)（骨架契约）、[agent-framework-v2.md](agent-framework-v2.md)（总蓝图）、`bots/_supervisor/CHANGELOG.md` C274-276、memory `validation-not-mock`。

---

## 0. 工作法（最高优先，兑现用户 #8）

**mock 单测 ≠ 验收。** 每个碰 bot 的功能必须**游戏内真·验收**：
1. **dev-trigger 手动触发器**：能按需点名触发任意框架功能（`sealBunker`/`clutchWater`/…），让用户当场在游戏里看对不对。比等自然触发高效。
2. CHANGELOG "观测"字段只认游戏内真观测；mock 降级为防回归/纯逻辑，明确标注非验收。
3. 验不了就直说请用户帮忙，不拿 mock 冒充。

**验收检查点在本计划中标 `🙋需人工`。**

---

## 1. 用户 9 条观测 → 分流

### A 类：策略/commit 缺失（S4 治本 — kernel 承诺计划 + 更聪明 proposer）
| # | 观测 | 修向 |
|---|---|---|
| 1 | 开局原地转悠 | kernel idle→快速 commit；proposer 开局即 BOOTSTRAP_KIT |
| 3 | 木材砍 2 个就停 | chopWood/proposer：木材**囤够量**(≥一组工具+台+备料)才算完成 |
| 5 | 造剑墨迹、不囤肉 | 决策提速；feedUp **囤肉**到富余，不只够回血 |
| 6 | 台子不收、不补木、不造镐、不下地 | kit 序列**锁定做到底**：剑→补木→木镐→石器→下矿；用完的台/炉回收 |
| 4 | 路过村庄不搜刮 | **新建 raidVillage skill**（蓝图 D.5）+ proposer 把村庄登记为资源点 |

### B 类：机械反射/工具 bug（能立刻修 + dev-trigger 验）
| # | 观测 | 机理 | 修向 |
|---|---|---|---|
| 7 | 晚上不挖三填一；封顶跑圈外把自己关外面 | seal 用会导航的 `skills.placeBlock`→放完墙 bot 被挪出圈；且没用"挖下沉+封顶"省事路线 | **重写 sealBunker**：优先 digDown 1-2 沉入坑→只封顶(以自己为中心)；必须放墙时用**不移动 bot 的贴邻放置**`bot.placeBlock(ref,face)`。**我的 sealBunker 同病，先修它** |
| 2 | 老挖沙子泥土 | 假设：无镐徒手只能挖沙/土/砾石，封顶/垫块就近抓料 | 取证确认；若是"乱挖"则收口到工具层按需取料 |
| 9 | 过河犹豫；跳河卡桥下起不来 | SWIM 状态机在"头顶有遮挡的水里"脱困失效 | mobility SWIM：头顶遮挡时优先横向找开口上岸，不死顶 |

---

## 2. 执行顺序（B 类先打通验收闭环，再回 A 类 S4）

### Phase V — 验收闭环（先做，让 #8 落地）
- **V1**：建 dev-trigger（`devTool.js` 热加载 skill + `dev_trigger.mjs` 注入脚本：cancel sticky→run devTool→观测）。
- **V2**：重写 `tools/bunker.js` sealBunker（dig-in 优先 + 不移动放置）。`node --check` + 逻辑自检。
- **V3 🙋需人工**：拉起栈→dev-trigger 触发 sealBunker→用户看"是否以自己为中心封住、人在里面"。过了才记 CHANGELOG 观测。

### Phase B — 其余机械 bug（同法：修→trigger→人工验）
- **B-#9**：mobility SWIM 头顶遮挡脱困。🙋需人工验过河/桥下。
- **B-#2**：取证沙土乱挖，按需修。

### Phase S4 — commit 承诺计划（A 类治本，最大工程）
- **S4.1**：proposer 增强——完成判据加"囤量"（木材/食物富余）、村庄资源点、kit 序列。
- **S4.2**：kernel `decide` 接 LLM 拍板（改 prompter：$SELF_PROMPT→$WORLD_MODEL+$PROPOSALS，注入 survival/companion 语义）。
- **S4.3**：kernel 接管 sticky 派发 + **承诺锁定**：committed 任务执行到底，suppress feedUp/forage/roam（取代 missionNether 食物 gate 泥潭，非打补丁）。先影子对照 missionNether，再切 live。
- **S4.4 🙋需人工**：good-spawn 重 roll，driven 全程观测开局→建家→床→下矿。

### Phase S5 — 缺失策略 skill
- **raidVillage**（#4）、家模板（床+箱+食物一体）、睡觉习惯。

---

## 3. 不变量（沿用 scaffold §8）
碰 bot 串行主循环；保命不等 LLM；精确坐标不喂 LLM；Normal+keepInventory；surfaceGate committed 后禁自动上浮；改互斥表/门控同步改文档。**新增：碰 bot 的功能未经游戏内验收，不在 CHANGELOG 标 ✅。**
</content>
