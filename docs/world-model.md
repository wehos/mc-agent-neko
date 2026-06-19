# Neko 中央世界模型（World Model）设计

> 用户 2026-06-19 亲自下的架构方向（长期主线，最高级别）。本文把用户的思想咀嚼、整理成可实施的设计 + 分阶段计划。
> 关联：[agent-architecture.md](agent-architecture.md)（三层+俯瞰层）、`bots/_supervisor/CHANGELOG.md`（C264 自我脱困 / C265 卡台阶 / C266 假掩护）、memory `world-model-central-gate`。

---

## 1. 用户原话（不失真）

1. **夜晚 hold 的判断要更智能**：加一个**持续的背景门控**——只要 bot 产生"回到地面"的冲动就要求停滞（hold）；但如果**资源充足（主要是镐子充足）且打算下地**，则允许 **LLM（监工）经判断 bypass**；而且 **bypass 之后这个门控要对所有自动机制生效，禁止任何自动机制自动回到地面**。
2. 这个门控的**状态要时刻提醒 LLM**，作为**世界模型的一环**（包括但不限于：白天/夜晚、能下地/推荐 hold、资源不足/建议迁徙 等等）。
3. **要一个足够强大、十分强大的世界模型，把模型的内容告诉 LLM**。
4. **所有其它层（①本能反射、②core 工具、③策略 skill）在需要时都能用到这个世界模型。**

## 2. 解决的根本痛点

- **surface yo-yo 死锁**：bot 在地下取不到木/料时反复想"上浮取木"，又被各种 gate 拦回，上下窜或空冻（C264 的 surfaceUp/table-recovery 就是一例；监工反复见 bot 卡在"想回地面"）。
- **状态散落、各层各算**：白天/夜晚、mobility、威胁、kit 充足度、掩护真假——目前散在 `modes.js`(mobility/self_preservation)、`prepNether`(canFightNight/tableRecoveryBlocked)、`achieve`、`missionNether` 各处，逻辑重复且互相不知道对方判断，容易互锁（历史多次"两修复互锁"事故）。
- **LLM（监工）缺单一真相源**：现在靠 `vitals.json` 一行 + 翻 progress/act_trace 拼图。要的是一个结构化、完整、时刻刷新的世界模型直接喂过来。

## 3. 设计：单一真相源 `bot._world`

一个**每 tick（或每 1–2s）god-view 计算**的对象，挂在 `bot._world`，是全栈唯一situational真相源：

- **谁算它**：①层 modes.js 新增/升级一个 `world_model` mode（把现有 `mobility` mode 扩成完整模型，或新增一个在其后运行的聚合 mode）。零成本 blockAt 上帝视角，沿用 mobility 的 2s 节拍（门控类字段可更高频）。
- **谁读它**：
  - **LLM/监工**：写 `bots/_supervisor/world_model.json`（完整）+ 折叠关键字段进 `vitals.json` 心跳（`monitor_tick` 一行就能看门控/推荐）。
  - **①本能反射**：直接读 `bot._world.*`（如 self_preservation 读 `coverReal`、surface gate）。
  - **②core skills**：导出一个 `getWorld(bot)` 读取器，skills.js 内可用。
  - **③策略 skill**：prepNether/missionNether/migrate 读 `bot._world` 替代各自重算。
- **谁改它的"决定"位**：监工（LLM）通过 `advisory.json` / `inbox.jsonl` 写**门控决定**（如 `{surfaceGate:{mode:'committed_underground', reason, until}}`），world_model 计算时读入并据此设门控。

### 3.1 模型 schema（`bot._world`）

```jsonc
{
  "ts": 1781849089219,
  "time": { "tod": 22756, "phase": "night|day|dusk|dawn", "isDay": false },
  "pos": { "x": 17, "y": 69, "z": 12, "depthBand": "surface|shallow|mid|deep" },
  "mobility": { "state": "FREE|POCKET|ENTOMBED|SWIM|MAROONED", "enclosed": true, "exits": [[1,0]] },
  "vitals": { "hp": 20, "food": 20, "canRegen": true, "armor": 0 },
  "threat": {
    "hostiles": 0, "closest": Infinity, "creeperDist": Infinity,
    "phantomNear": false,            // 空中攻击者(C266)
    "swarm": 0,                      // 10b 内可战怪数
    "actionable": 0,                 // 够得到/能伤到的威胁数(可达性过滤,C34)
    "takingDamage": false            // 最近是否净掉血(假掩护探测,C266)
  },
  "cover": {
    "overhead": false,               // 头顶 2-6 有块(旧的宽判定)
    "coverReal": false,              // ★真顶:head+1/+2 实心 roof,挡得住俯冲(非仅"附近有块")
    "sealed": false                  // 四壁+顶都封
  },
  "kit": {
    "picks": 0, "pickTier": "none|wooden|stone|iron|diamond",
    "hasTablePath": false,           // 有 table 或 wood/planks/logs 能造台
    "foodSufficient": false, "cobbleBuffer": 0, "torches": 0,
    "sufficientForUnderground": false // ★下矿是否够本(主看镐≥1且有备镐/能补,详见门控)
  },
  "migration": {
    "biomeScore": -8, "hasBed": false, "inDeathZone": true, "recommend": true
  },
  "surfaceGate": {
    "mode": "hold|committed_underground|free",   // 见 §4
    "allowSurface": false,           // 当前是否允许任何自动机制上浮
    "reason": "night + no committed venture",
    "decidedBy": "auto|supervisor",
    "until": 0                       // committed 的有效期(到期回 auto)
  },
  "recommendation": { "action": "HOLD|GO_UNDERGROUND|FORAGE_SURFACE|MIGRATE|FIGHT|FLEE", "reason": "..." }
}
```

> 字段是增量的——先实现已有数据能填的（time/mobility/threat/vitals/kit/cover），migration/recommendation 后补。

## 4. 地面/hold 门控（surfaceGate）语义 —— 用户指令的核心

门控有三态 `mode`：

| mode | 含义 | allowSurface | 谁能进入 |
|---|---|---|---|
| `hold` | **默认**。压住"回地面"的冲动，要求停滞/原地解决。 | false | 自动：夜间 / 资源不足 / 有威胁 / 无 committed venture 时 |
| `committed_underground` | 监工判定"镐够+计划下矿"后**承诺下地**。禁止一切自动机制把 bot 拽回地面。 | false（但语义是"待在地下干活"，非"hold 不动"） | **仅监工(LLM)** 经判断设置 |
| `free` | 白天、安全、资源富余、无下矿承诺时的正常自由活动。 | true | 自动 |

**规则（咀嚼自用户原话）**：
1. **默认 deny 上浮**：任何自动机制（surfaceUp、prepNether table-recovery 的上浮、missionNether handoff、feedUp 上地表觅食、migrate 起步…）在执行"回地面"动作前，**必须查 `bot._world.surfaceGate.allowSurface`**；为 false 就**不上浮，改为 hold / 原地求解 / 等监工决定**。这是用户说的"只要 bot 产生回到地上的冲动就要求停滞"。
2. **bypass 条件**：`kit.sufficientForUnderground`（核心=镐够：≥1 把可用镐，理想是有备镐或能就地补镐；不在"跌破最小 kit"红线，见 memory `resource-floor-bootstrap-kit`）**且**当前意图是下矿。满足时，**监工(LLM)** 可写 `surfaceGate.mode='committed_underground'`。
3. **committed 后全局生效**：一旦 committed，**所有自动机制都不许自动上浮**——贯彻下矿计划，不 yo-yo。只有监工撤销（或 `until` 到期、或硬安全事件如濒死）才解除。
4. **状态时刻喂 LLM**：`surfaceGate` 是 world_model.json + 心跳的固定字段；`monitor_tick` 一行就显示 `gate=hold/committed/free allowSurface=…`。

> **谁来"产生冲动"→被门控拦**：把现有所有"上浮"原语收口到一个公共入口 `requestSurface(bot, reason)`，内部查门控；散落的 `surfaceUp`/goToPosition-to-surface 调用改走它。（同 memory 教训："门要加公共入口不是单个调用方；循环开头检查形同虚设，检查下沉到原语层"。）

## 5. 分层消费（所有层都能用）

- **①反射(modes.js)**：self_preservation 读 `cover.coverReal` 而非自己的 `hasOverheadCover`；mobility 把状态写进 `_world.mobility`；edge_unstick 等都能读 `_world`。
- **②core skills**：`getWorld(bot)` 读取器；collectBlock/goToGoal 等可参考 `surfaceGate`、`threat.actionable`。
- **③策略 skill**：prepNether 的 `tableRecoveryBlocked`/`canFightNight`、missionNether 的 dispatch、migrate 的 start-gate，都改读 `bot._world`（消除各自重算 + 互锁）。

## 6. 分阶段实施计划（低风险→行为变更）

- **Phase 1（本文 + 记忆）✅**：咀嚼、写设计文档 + memory。
- **Phase 2（只读广播，零行为变更，低风险，先做）**：在 modes.js 实现 `world_model` mode，聚合现有数据算出 `bot._world` 并写 `world_model.json` + 折叠进 vitals 心跳。**不改任何行为**，先让"模型内容告诉 LLM"落地 + 用真实数据校准字段。
- **Phase 3（门控只读 + 公共入口）**：实现 `surfaceGate` 计算（auto 部分：夜/资源/威胁→hold）与 `requestSurface()` 公共入口；把现有上浮原语**改为查询门控但暂时只记日志不拦**（影子模式，验证门控判断对不对，不误伤）。
- **Phase 4（门控生效 + 监工 bypass 通道）**：门控真正拦截自动上浮；监工经 advisory/inbox 写 `committed_underground` 的 bypass；committed 后禁所有自动上浮。逐一迁移调用方，每步用 act_trace/progress 验证不互锁。
- **Phase 5（全层收敛）**：①②③层改读 `bot._world`，删除各层重复判定。

> 纪律：每阶段 `node --check` + 重启验收（①层）/热加载（③层），挂可证伪预测进 CHANGELOG；行为变更阶段先影子模式再生效，防互锁（历史血泪）。

## 7. 待用户确认的解释（我按此推进，可纠正）

- **committed_underground 的触发**：我理解为"监工(LLM)显式决定"，不是 bot 自动进入（自动只在 hold/free 间切）。bot 端只在 kit 充足时**建议**可下矿，最终 commit 由监工拍板。
- **`sufficientForUnderground` 的镐判据**：≥1 可用镐 **且**（有备镐 或 手里有料能补一把 或 不在"最后一把镐"红线）。可调。
- **hold 默认范围**：夜间 + 资源不足 + 有 actionable 威胁 + 无 committed venture，任一成立即 hold。白天安全富余=free。

---

## 附录 A：stepHeight 联机作弊问题（用户问：调了会被服务器 ban 吗？）

**结论：保留 jump 式 `edge_unstick`（CHANGELOG C265，已部署），不动 `bot.physics.stepHeight`。**

技术事实：
- **当前环境（用户自己的单机世界 Open-to-LAN，host=localhost，无插件）**：原版服务端**不检测** step height，无反作弊插件 → 调 stepHeight **零 ban 风险**。
- **公开反作弊服（Spigot/Paper + NCP/Grim/Vulcan 等）**：`stepHeight>0.6`（不跳就上整格）是**著名的 "Step" 外挂特征**，会被 flag/ban。
- **真人可见性**：stepHeight 让 bot **不跳就平滑滑上整格**，反而**不像真人**（真人遇整格台阶是**跳**）。`edge_unstick` 的 **jump 是原版合法动作**，对真人和反作弊服**都最不可见**。

所以 jump 方案在"人和服务器都看不出作弊"这条标准上**严格优于** stepHeight，且已解决卡台阶。stepHeight 不需要、且是唯一可能在未来联机时露馅的点 → 不动它。若用户仍想要额外顺滑，可仅在私有 LAN 下加极小 stepHeight 并在连真服时自动关闭——但当前不做。

（注：用户已允许开图/扫怪/扫矿/上帝视角——这些是 bot 端**信息获取**，服务器收不到异常包、真人看回放也看不出，与会发异常移动包的 stepHeight 性质不同。）
