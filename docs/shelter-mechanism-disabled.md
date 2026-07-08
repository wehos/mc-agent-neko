# 地表封箱 Shelter 机制 — 已禁用 (设计决策记录)

> **状态**: 🔴 DISABLED — 2026-07-07 用户决定 · 关联 memory `feedback-shelter-selfinside-material-sleep-2026-07-07`
> **用户令**: 「站在 shelter 外面建了一堆 shelter 但是人不在里面……shelter 机制我们已经改了很多轮。我决定放弃。禁用 shelter 机制。」
> **边界裁定 (用户原话)**: **「允许挖三填一，不允许封箱」** — 保留挖坑下沉口袋 (`dig_one` / 挖三填一)，永久关闭地表封箱 (`seal` / 封箱)。
>
> **⚠️ 2026-07-08 夜间行为 RESPEC (本文 §6 已更新)**: 用户重申「shelter 机制临时禁用」+ 把夜间决策链收敛成一份带优先级的白名单：
> `FIGHT > 近床(≤15) > [炼铁·保留] > 下矿 > 挖三填一(就地|≤15格找地) > 背包床兜底 > 黄昏远床 > SEAL_FORT(裸hold)`。
> 关键改动：近床阈值 **6→15**（最高优先级）、挖三填一新增 **≤15 格找可挖地**、远床改 **仅黄昏**、SMELT_IRON **保留**。seal 封箱仍全禁（本文主旨不变）。详见 §6。
>
> 代码锚点:
> - `bots/_supervisor/skills/nightShelter.js` — `SURFACE_SEAL_DISABLED` 旗 + `seal` 分支 + PHASE 1.5 门 (执行层，权威)
> - `src/agent/modes.js` `computeNightPlan()` (~6098) — 决策层终兜底 `SEAL_FORT` 说明
> - `src/agent/framework/world_model.js` (~1237 `case 'SEAL_FORT'`) — 派发层说明
> - `bots/_supervisor/skills/shelter.js` — 独立 panic-box 技能，已 no-op (死代码)

---

## 0. TL;DR

地表「封箱」(在 bot 四周砌一圈墙把自己关起来) 反复失败：**bot 把墙砌好了，人却站在盒子外面**。改了 4+ 轮 (最后一轮是 PHASE 1.5「强制自己在里面」的复核补墙) 仍没根治。用户放弃，决定禁用。

**只禁「封箱 seal」，保留「挖三填一 dig_one」和其余全部夜间生存手段** (睡床 / 夜挖 / 打怪 / 逃跑 / keepInv 求死重生)。

禁用方式不是删代码、也不是让决策层返回 `NONE`，而是：
- **决策层照旧返回 `SEAL_FORT`** (保留优先级 91 > 白天作业 90 + unstuck 保护)，
- **执行层 `nightShelter('seal')` 不再砌墙**，改为**原地 hold** (站住、饿了吃、挨打就让位给反射/re-decide)。

即：语义从「把自己墙起来」变成「就地坚守过夜」。地表再也不会出现那个把 bot 关外面的破盒子。

---

## 1. 用户看到的现象 (bug)

夜里 (或有威胁时)，bot 在地表：
1. 掏出泥土/圆石，绕着自己啪啪啪放了一圈方块 (feet ring + head ring + 顶盖)。
2. 墙砌完了，**但 bot 站在这圈墙的外面**，暴露在夜怪面前。
3. 观测面还以为「已 sheltered」，实则漏风 / 人在外面 → 挨打 → 送死或空转。

用户实拍截图：一个砌了一半的泥土/圆石堡垒，bot (第一人称视角) 明显在堡垒**外侧**。`botwatch.mjs` 有一个 `FALSE-SHELTER` 看门狗告警正是抓这个 (`botwatch.mjs:240,256`)。

---

## 2. 根因 (为什么总是站外面)

**`skills.placeBlock(bot, mat, x, y, z, ...)` 会寻路把 bot 移到「够得到目标方块面」的位置** (mineflayer 标准行为)。

而封箱循环 (`shelter.js` / `nightShelter.js` seal 段) 是以**进场那一刻冻结的锚点** `const p = bot.entity.position.floored()` 为中心，算出 9 个环格坐标，然后逐格 `placeBlock`。放前几块时 bot 为了够到目标面被寻路挪开了，**后面的墙仍围着旧的 `p` 砌**，等一圈砌完，墙围住的是一个 bot 已经不在的空格，人站到了环外。

循环里两次放置之间**从不重读 `bot.entity.position`**，`placeBlock` 前也没先 pin 住 bot。这就是「站外面」的机械根因 —— **是放置过程中的 bot 漂移，不是环几何算错** (环偏移 `[±1,0,0],[0,0,±1]…` 本身是正确的闭环)。

> 挖三填一 (`dig_one`) 没有这个病：它是**往脚下挖 + 封顶**，bot 掉进自己挖的坑里，天然被地形围住，`placeBlock` 漂移挪不出一个洞。所以它被保留。

---

## 3. 战斗史 (改了几轮)

从代码注释重建，这个 bug 至少经历 **4+ 轮修复**才被放弃：

| 轮次 | 时间 | 尝试 | 锚点 |
|---|---|---|---|
| ① 首诊 | 2026-06-19 | ★USER #7 首次记录「placeBlock NAVIGATES → walked the bot OUT of its own ring」 | `framework/tools/bunker.js` 头注释 |
| ② dig-down 转向 | — | 应急路径改用 `bunkerDown()` 往下挖 3 + 封顶，让顶盖落在地表下、人挪不出去 (这就是 dig-down 为何可靠) | `bunker.js`、`modes.js bunkerDown()` |
| ③ 自封守卫 | 2026-07-02 | 防止无镐 bot 把自己封进 1×1 石棺 (ENTOMBED/SEALED 跳过、无镐留最后一个出口) | `nightShelter.js` seal 段守卫 |
| ④ PHASE 1.5 自己在里面 | 2026-07-07 | ★用户令「强制要求自己在里面」：seal 后停寻路、清控、以 bot **当前**落点为中心复核补墙 | `nightShelter.js` PHASE 1.5 |
| 🔴 放弃 | 2026-07-07 | ④ 仍不够 (用户又拍到站外面) → 禁用封箱 | 本文 |

即使 ④「复核补墙」也没根治 (复核补墙自身还是用 `placeBlock`，同样会把 bot 挪开)，用户遂决定不再修，直接禁。

---

## 4. 禁用了什么 · 保留了什么

### 🔴 禁用 (地表封箱 seal / 封箱)
- `nightShelter.js` mode `'seal'` 的**砌墙循环** (feet/head/ceiling 环) — 改为原地 hold，不放任何方块。
- `nightShelter.js` **PHASE 1.5**「自己在里面」复核补墙 — 整段跳过 (它本身也在砌那个盒子)。
- `shelter.js` 独立 panic-box 技能 — no-op (返回 0，不放方块)。本就是死代码 (只有 `!newAction` 聊天注释引用，无活派发)。
- **`prepNether.js` SURVIVE-FIRST 囤 shelter 方块** (`collectBlock('dirt',18)`, ~1596) — 2026-07-08 追禁。这段**只**为喂封箱反射存在 (pillar-box up 要 ~7 预囤方块、自己不挖料)；封箱既禁，它就成了纯空转：裸重生每条命徒手刨 ~18 泥土 (用户观测到的「突然往地下挖」) 去建一个永不落成的 shelter。保留的**挖三填一 `dig_one` / `bunkerDown` 是往下挖、用挖出的土自封顶**，不吃这个预囤 → 禁掉不伤它们。同一个 `NEKO_ENABLE_SEAL_SHELTER` 旗门控，随封箱一起复活/默认一起关。

### 🟢 保留 (全部其余夜间生存手段)
- **挖三填一 `dig_one` / `DIG_ONE_CAP`** — 往脚下挖 1 格 + 封顶的下沉口袋。**可挖时照常触发** (`modes.js computeNightPlan` 的 `if (digOneViable) return DIG_ONE_CAP`)。用户明确保留。
- **睡床 `goBedSleep` / `DUSK_GO_BED@93`** — 有可达床就去睡到天亮。
- **夜挖 `MINE_THROUGH_NIGHT / DUSK_MINE_NIGHT@94`** — 地下有镐够用就整夜挖。
- **打怪 `FIGHT`** + always-on self-defense 反射 — 贴脸能打的仗照打。
- **逃跑 `surviveNow` `RELOCATE`** (escapePlan/surfaceUp/moveAway) + **求死重生 `DEATH`** (keepInventory 已验证 ON)。
- **`bunkerDown()`** (creeper/自保反射的往下挖应急舱，`modes.js:1119+`) — 与地表封箱是两码事，保留。
- **`surviveNow` 的 `SHELTER` 节点** (`surviveNow.js:362`) — 它派的是 `nightShelter('dig_one')`，**不是** seal，保留。

---

## 5. 具体改动 (file : line)

| 动作 | 文件 | 位置 | 改动 |
|---|---|---|---|
| 定义旗 | `bots/_supervisor/skills/nightShelter.js` | 函数顶 (~25) | `const SURFACE_SEAL_DISABLED = process.env.NEKO_ENABLE_SEAL_SHELTER !== '1';` (默认禁用) |
| **执行层 (权威)** | `bots/_supervisor/skills/nightShelter.js` | `if (mode === 'seal')` | 禁用时不砌墙：停步 + 摘封顶旗 + log → 直落 PHASE 2 原地 hold；`else` 分支保留原砌墙逻辑 (env 打开才走) |
| **执行层 PHASE 1.5** | `bots/_supervisor/skills/nightShelter.js` | PHASE 1.5 块 | `if (!SURFACE_SEAL_DISABLED)` 整段门控 (禁用时不跑复核补墙) |
| 决策层说明 | `src/agent/modes.js` | `computeNightPlan()` 终兜底 (~6098) | 终兜底**照旧返回 `SEAL_FORT`** (保优先级 + unstuck 保护)，注释说明执行层已改 hold；`reason` 改为 `'hold in place — surface wall-box disabled'` |
| 派发层说明 | `src/agent/framework/world_model.js` | `case 'SEAL_FORT'` (~1237) | 保留派发 `nightShelter('seal')` + `NIGHT_SEAL@91`，注释说明不再砌墙；`rationale` 改为 hold |
| 死代码 no-op | `bots/_supervisor/skills/shelter.js` | 函数体首 | 禁用时早退 `return 0` + log；原 body 保留在 env-gate 后 |
| **追禁囤方块** | `bots/_supervisor/skills/prepNether.js` | SURVIVE-FIRST (~1596) | 2026-07-08：`const SEAL_SHELTER_ENABLED = process.env.NEKO_ENABLE_SEAL_SHELTER === '1';` 门控 `if (SEAL_SHELTER_ENABLED && …)` — 默认不再徒手刨土囤 shelter 料 |

**功能改动 3 处** (nightShelter.js 的 seal 段 + PHASE 1.5 + prepNether.js 囤方块)，其余是注释 / no-op / 死代码标注。

---

## 6. 禁用后夜间运行时行为 (2026-07-08 RESPEC)

夜里 `computeNightPlan()` 短路链 (**每 tick 只返回一个决策；夜内先后由这条【链序】定，不是 world_model 的优先级数字**)：

```
FIGHT                         贴脸能打的怪 → 让位常驻防御反射 (不派夜间任务)
  > GO_BED(近, ≤15格 或 近地表背包床)   ★最高优先级 (阈值 6→15, 用户令 2026-07-08). 睡到天亮.
  > SMELT_IRON                夜间炼铁/升级铁装 (用户令: 保留; 仍在下矿之上, T-0097 先锁铁档)
  > MINE_THROUGH_NIGHT        镐(资源)充足 / 已深处封闭 → 整夜下矿
  > DIG_ONE_CAP(就地 | ≤15格找地)  挖三填一: 就地可挖, 或 ≤15格内有"可挖三填一的地面"→ relocate 去挖 (半径 5→15, 有镐含石系). 需真镐 (§7.3).
  > GO_BED(背包床兜底)         深处/够不到别的但背包有床 → 就地放床睡 (零步, 不受"仅黄昏"限)
  > GO_BED(远, >15格, 仅黄昏)   黄昏才去更远的已知床 (用户令: 深夜绝不奔远床=跨图风筝死环). 最低优先.
  > SEAL_FORT(终兜底)          啥都做不了 → 原地【裸 hold】不砌墙
```

- 前面任一命中 → 走对应手段。
- 落到 `DIG_ONE_CAP` → `nightShelter('dig_one')` 挖坑下沉；就地不成 (重力柱/含水/硬地) 会由 `seal` 段的 **≤15 格 relocate 扫地** 兜底再挖 (徒手软土 / 有镐含石系, 排重力柱)。✅ 保留 + 加强。
- 落到 `SEAL_FORT` (终兜底 = 无镐 / 无软土可迁 / y≤16 深处 / 无床) → 派 `nightShelter('seal')` → **执行层原地 hold** (站住、饿了吃生肉、挨打或 hostile<4b 就 `return false` 让位反射/re-decide)。**不砌墙**。

即：能睡近床就睡，能挖矿就挖，能挖坑就挖坑 (含 15 格内找地)，黄昏可去远床；实在啥都做不了就**原地坚守**而不是砌那个把自己关外面的破盒子。**seal 封箱仍全禁** (`NEKO_ENABLE_SEAL_SHELTER=1` 才复活, 见 §9)。

---

## 7. ⚠️ 已知并接受的代价 (stranding gap)

`SEAL_FORT` 原本是**终兜底**，正因为它是**无镐 bot 唯一能用的庇护** (放方块不需要镐)。真实场景：**夜里、地表、无床、无镐 (或站在沙/砾石重力柱上)**。

- 从前：砌一圈墙 (虽然经常把自己关外面，但至少是个动作)。
- 现在：**原地 hold，不砌墙**。只靠 self-defense 反射 + hold 循环的「挨打即让位」+ `surviveNow` 的 `RELOCATE`/`DEATH` 兜底活命。

**这是用户明确接受的取舍** (「不允许封箱」)。缓解：
1. **keepInventory 已验证 ON** — 这种情况下真死了也只是重生，物品全保，代价仅是时间。
2. hold 循环挨任何一击就 `return false` 交还反射 (`nightShelter.js` PHASE 2 逃生舱)，不会站着白白挨打到死。
3. **不回退到「无镐强挖 dig_one」** —— `modes.js:6014-6019` 记录了另一个已修 bug：给无镐 bot 判 dig_one viable 会让它徒手往下挖软土**把自己埋到树底下** → `chopWood` 全 blacklist → wood=0 bootstrap 死锁。所以终兜底**不能**盲目重定向到 `DIG_ONE_CAP`；无镐就是 hold，不强挖。

---

## 8. 休眠的 legacy 路径 (未改，说明在此)

`prepNether.js` 有一段 legacy `holeUpAtNight()` 夜间巨块 (自带封顶/睡床/挖三填一)。它由 `nightOwnedByDecisionLayer()` 门控 —— 该谓词判的是 **kernelDriver 是否在线** (心跳 ≤10s)，**不是** nightPlan 的决策值 (`prepNether.js:151-157`)。

- **framework-v2 在线时** (当前 live 配置)：`holeUpAtNight` 早退让位，legacy 封箱**休眠**，不会触发。
- 只有回退 / Stage-0 shadow (kernelDriver 掉线) 时 legacy 才活。

因此本次**不动 legacy 巨块** (对休眠代码动刀风险大、无 live 收益)。**但记录在此**：若系统回退到 legacy 模式，`holeUpAtNight` 的封顶可能复活。届时若仍要禁封箱，需同样门控该段。

---

## 9. 如何恢复 (逃生舱)

启动前设环境变量：

```powershell
$env:NEKO_ENABLE_SEAL_SHELTER = '1'
```

置 `1` → `SURFACE_SEAL_DISABLED` 变 false → 所有被禁的封箱逻辑 (nightShelter seal 段 + PHASE 1.5 + shelter.js body) 全部原样复活。不设 / 设别的值 = 保持禁用 (默认)。

> 注意：`nightShelter.js` / `shelter.js` 是热载技能，改 env 需重启 bot 进程 (`watchdog.ps1` 拉起的 `node main.js`) 才生效。

---

## 10. 如何验证 (观测口径)

- **日志**: 走到禁用 seal 分支会打 `nightShelter: 地表封箱已禁用 — 原地 hold(不砌墙)…`；手动调 shelter 技能会打 `shelter skill 已禁用…`。
- **决策**: `bot._world.nightPlan.decision === 'SEAL_FORT'` 且 `reason` 含 `hold in place — surface wall-box disabled` → 决策层已识别为 hold。
- **行为**: 夜里终兜底场景，bot 应**站住不动**、不再有「掏方块绕圈砌墙」的动作；`FALSE-SHELTER` 看门狗告警应消失 (不再有半拉堡垒)。
- **回归红线 (勿踩)**: 不要把终兜底改成 `NONE` (会让白天作业 BOOTSTRAP_KIT@90 漏进夜里 → bot 夜游砍树 + 破坏 unstuck 保护)；不要把终兜底重定向到 `DIG_ONE_CAP` (无镐埋自己死锁，见 §7.3)。
