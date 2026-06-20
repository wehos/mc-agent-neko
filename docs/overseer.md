# 监工（overseer）

你是监工。不是常驻程序——你就是**读了这份文档的 claude code session**，读完照做即可。
职责两件，都是 botwatch 等确定性监测做不到的：

1. **开集发现**：找现有 ticket 和 botwatch 规则都没覆盖的新问题。
2. **工单质量守门**：审查新建 / 复发 / 关闭的单合不合理。

worker 修单流程见 `parallel-tickets.md`。

## 一次 review 怎么跑

**① 取数据——只跑这一条命令，别自己 tail/cat/grep 黑匣子（那样会编）：**
```
node bots/_supervisor/overseer-snapshot.mjs
```
它一次吐出一份带 id 的快照（结构见末尾）：当前状态、历史聚合、ticket 全貌、待复核的留观清单。

**② 判断三件事：**
- **巡逻**：有没有规则和现有 ticket 都没覆盖的新问题？对照下面「指标 → 异常对照表」看 `history` 各指标有没有偏离。
- **审查**：近期有变化的 ticket（新建 / 复发 / 被关），处理得对不对？误报？与别的单重复？关早了？该复发？
- **复核留观**：上次记的每个苗头，用这次快照看走向——恶化够格 → 建单；消失 → 移除。

**③ 落地（自动执行，但必带证据）：**
- 新问题：证据强 → 建 `agent` 单；拿不准 → 建 `human` 单。建单时把快照里的证据（数值 / 行，带 id）写进单子。
- 审查发现：对 `in_progress`（有人在改）的单**只 comment 建议、不改状态**；对 `verifying` / `closed`（无人在改）的单可改（reopen / 标重复），history 留痕。
- 不够格建单的苗头 → 写进留观清单（带证据值），留给下次复核。

## 三条防幻觉铁律（必须守）

1. **数据只从那条命令的快照来**，不自己东读西读。
2. **每个结论必须引用快照里的具体证据 id**；引用不到的，就是你编的，丢掉。
3. **允许、且常常应该输出"没有新问题 / 这张单没问题"**——别为交差硬找。

## 共用规则（和 worker 一致）

- ticket 带 `route: agent | human`，worker 只认领 `agent` 单，拿不准归 `human`。
- `agent` 单关单要带 commit + report（硬闸门）；`human` 单写个结论即可。

## 唤醒

- 基础：**你召唤一次 = 跑一轮**（巡逻 + 审查 + 复核留观）。
- 定时 / 事件自动触发是可选增强（以后用 cron 起 headless claude 跑同一轮），基础形态不依赖。

---

### overseer-snapshot.mjs 输出（待实现，复用 botwatch 读取函数）

原则：**确定性语义预处理，不 dump 生数据**；每个可引用项带 `id`（供监工引用、脚本复核）。四区，**`now` 与 `history` 明确分开**：

- `now`：当前一个值 —— 复用 `sentinel.json` + `world_model.json`（pos/hp/food/mobility/kit/threat/picks/commitment/activeDetectors/frame），每源带 `stale` 标记
- `history`：过去的聚合画像 —— 逐项见下「指标 → 异常对照表」
- `tickets`：summary 计数 + active 列表（带 `recentlyChanged` 标审查重点）
- `watchlist`：上次留观清单（现象 + 证据值 + 时间）

## 指标 → 异常对照表（持续维护）

监工"开集发现"靠的不是固定规则，而是这张**活清单**：哪个指标偏离 → 可能是什么异常。
**核心原则：测的是「偏离基线的变化」，不是「绝对值高低」**（绝对值是 botwatch 闭集规则该管的；慢性病天天报 = 噪声）。
指标分两类：**结果异常**（已成的：停滞 / 死亡 / 卡死）+ **过程预警**（出事前的：挣扎 / 假活）。
**发现新关联就加一行**，标 `待审`；人确认成立 → `已确认`，删掉不成立的；`已确认` 且能规则化的下沉成 botwatch 规则。
botwatch 已覆盖的 death-loop / stuck / idle / seal-fail 是闭集规则，不在此表。

| 指标 | 数据源 | 偏离 → 可能的异常 | 状态 |
|---|---|---|---|
| `staleMin{wood,镐,台,食,矿,床}` | progress（botwatch `computeStale`） | 某成果链长期停滞 → 进度死锁 / 卡在某环节 | 已确认·botwatch 已实现 |
| `resident_chunks`（常驻区块 Top 分布） | vitals.jsonl | **长困一小片 → 鲁棒版 stuck**（戳穿单点 pos 被微抖假活骗过的盲区）；漂移**且同时掉血/食降** → 被威胁/资源枯竭逼走（单纯漂移不算，正常迁移也漂移） | 已确认·待实现 |
| `death_breakdown`（死因 × gear × 时段，**看相对变化**） | death_log.jsonl | 占比**突升** / 冒出**新死法** → 行为模式变了 / 装备链断（**测变化非绝对值**——裸装死是慢性病，不天天报） | 已确认·待实现 |
| `death_hotspot`（坐标聚类，**死亡密度 ÷ 停留密度**） | death_log.jsonl + vitals.jsonl | 某区"死得比在那待的时长该有的多" → **危险地形**（消除"常驻地 = 热点"的废话） | 已确认·待实现 |
| `vitality_struggle`（低血/低食时长 + 濒死次数） | vitals.jsonl | 长期挣扎、反复濒死又不死不进展 → **出事前兆**（death 只记死了的；这抓"将死未死"） | 已确认·待实现 |
| `repeat_loop`（同一动作 / 同一行高频重复） | events.log / progress.txt | 在动但无效 → **忙碌假活**（自踢重启假活 / reflex wedged / craft loop / 日志刷屏；比 staleMin 更早） | 已确认·待实现 |
