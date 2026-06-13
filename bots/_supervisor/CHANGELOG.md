# Neko 改动台账（科学家模式）

> 接管者从这里开始：交接书 [docs/HANDOFF.md](../../docs/HANDOFF.md)，架构图谱 [docs/agent-architecture.md](../../docs/agent-architecture.md)。

每条改动 = 一个实验：**触发证据 → 机理假设 → 改动 → 可观测预测 → 观测/归因**。
纪律：每次死亡/异常复盘时翻此表，把证据回写到相关条目的"观测"字段；预测落空的条目要么修正要么回滚。
状态：⏳待生效(等重启窗) / 🟡已生效待观测 / ✅已验证 / ⚠️部分有效 / ❌已回滚

更早改动（第1-55轮）见 memory/mc-agent-supervision.md 与 git history。本表从 2026-06-11 当班起记。

---

## C208. 架构重构起点：WorldModel 黑板 + Arbiter 单一仲裁器（影子模式先行；新 core/，与补丁层并行，零 live 风险）
> 这不是补丁，是 HANDOFF §4 重构的 P0。前 165 条（C42–C207）补丁路线触底——见下"机理"。新 Claude agent 接手当班。
- **触发**: (1) 用户判决："继续在这个架构上加补丁已经没用了"——bot 卡在 `pos=9,52,-11 food=4 hp=15` 干坐 **2h8m**（progress 同一行刷 237 次），food 单调下滑、hp 钉死 15、位置不动，三个"出口条件"(actionable hostile/本地食物信号/watchdog interrupt) 全部物理不可能触发或被 C206/C207 亲手焊死 = **吸收态活锁**。(2) live 取证：直接 run_skill escapePlan 算出正确逃生向量后，**90ms 返回、bot 没动 0.5 格**——根因是 bot 封在 y=52 石头口袋，连 `canDig=true` 的破坏式 mineflayer pathfinder 也**秒判 NoPath 抛错**（狭小搜索空间），goToGoal 立即放弃。这是"卡洞出不来"的字面机制。
- **机理**: 结构病灶四条——①无单一事实源：每层(mission KILL-BOX/prepNether/core pin-breaker/watchdog)各自从 raw bot 字段重新推导"形势"，互相不认账；②无全局仲裁者持有"必须推进任务"目标，所有层只做局部"hold vs move"判断，于是一致选 hold；③脱困全是启发式，没有把"挖掘秒数当边代价"的真规划——通用 pathfinder 不会为你凿 12 格石头隧道；④"卡了多久没进展"(stalledMs) 从来不是一等信号。补丁越精致 → 局部越正确 → 全局越死。
- **改动**: 新建 `bots/_supervisor/core/`：(a) `worldModel.mjs` — 纯函数黑板 `buildWorldModel(telemetry)`，把 vitals/advisory/radar/mobility 收敛成单一快照，含一等 `paralysis{starving,longStall,trappedInDeathZone}` 信号；(b) `arbiter.mjs` — 纯函数 `arbitrate(wm,prev)`，从 6 模式全序集(DEFEND>FLEE>EAT>**ESCAPE**>SHELTER>WORK)选一，带优先级抢占+迟滞(MIN_DWELL 20s 防颤动)，**ESCAPE 是一等模式**（补丁层结构上无法做出的"卡太久了，覆盖所有 hold 去逃"判断）；(c) `escapePlan.js` — 纯函数 `planEscape(state)` 算逃生几何(远离死亡区中心 ∧ 怪群质心的合向量)+干跑 skill(Phase A 不动身体)，执行半场已写但 dig-tunnel 执行器+live 部署暂缓(见预测)；(d) `shadowArbiter.mjs` — 只读影子运行器，每 6s 读 live 遥测跑 Arbiter、写 `decision_trace.jsonl`，**发零控制**。配 3 个离线回归测试 + `test/fixtures/livelock-9-52-11.json`(活锁现场夹具)。补丁终点已快照 commit `49c9637`。
- **预测**: (1) 离线：`planEscape.test.mjs` 喂活锁夹具→action=relocate_surface heading +x+z；`arbiter.test.mjs` 喂同一夹具→mode=ESCAPE。(2) 影子：`decision_trace.jsonl` 在当前 hold 上应持续记录 `arbiter=ESCAPE actual=missionNether`(DIVERGES)，证明重构会改变行为。(3) 待 dig-tunnel 执行器(lava/坠落/近敌护栏)写好并通过验收(任何可挖地形≤2分钟脱困)、影子转实控后，ESCAPE 应真正打破补丁层打不破的活锁。回归用例永久钉死：活锁夹具。
- **观测**: ✅ 离线测试全绿：`planEscape.test.mjs` 11/11、`arbiter.test.mjs` 15/15（Case1 活锁夹具→`mode=ESCAPE reason="starving(food=4,no edible)+trapped in death-zone+long stall"`，优先级排序+迟滞三态全过）。✅ live 影子 tick0：`arbiter=ESCAPE actual=missionNether food=4 hp=15 :: starving(food=4,no edible)`——只读捕获到分歧。⚠️ live execute 实测暴露真根因(pathfinder NoPath，见触发)，故 B 阶段执行器暂缓、改 P0 先建黑板+仲裁。附带修复：PowerShell `Out-File -Encoding utf8` 给 sticky_skill.json 写了 UTF8 BOM→bridge `JSON.parse` 静默抛错→re-arm 失败 bot 一度 idle；已用 .NET `File.WriteAllText`(无 BOM) 修复。**教训：PowerShell 写 supervisor 的 JSON 状态文件必须无 BOM。**
- **回滚**: 删 `bots/_supervisor/core/` 与 `test/`；本批纯新增文件，不改任何补丁层运行时代码，影子运行器只读，对 live bot 零影响，可随时弃用。

## C207. watchdog STUCK-ZONE exempts kill-box low-food recovery holds（watchdog.ps1，已 watchdog-only reload）
- **触发**: Fresh live after C206 verification stayed `classification=live` at `pos=9,52,-11 hp=15 food=4 skill=missionNether mob=FREE/ENC`, progress repeated `★KILL-BOX gated: low-food pocket recovery...`, and advisory showed far/nonactionable mobs (`actionableHostiles=0`). Core `reflex_watchdog` correctly logged `pinned kill-box low-food hold exempt...`, but detached watchdog still wrote `[06-13 16:42:24] STUCK-ZONE... hp=15 food=4` and sent `cancel_skill`, forcing sticky `missionNether` to restart the same intentional hold.
- **机理**: C200 only exempted night/bunker low-food holds (`HUNGRY/LOWHP ... night`, `inside cluster but night+covered`, etc.) and required raw `vitals.hostiles==0`. The newer C203 daylight/dawn kill-box hold is identified by progress text `KILL-BOX gated: low-food pocket recovery` and may have far raw hostiles in advisory, so watchdog's anchored STUCK-ZONE layer misclassified a deliberate body-budget hold as entrapment.
- **改动**: Added `killBoxLowFoodHold` to watchdog STUCK-ZONE exemptions. It requires `missionNether`, `food<=6`, `hp>=10`, no normal edible, contained mobility (`ENC|POCKET|MAROONED|ENTOMBED`), fresh progress tail containing `KILL-BOX gated: low-food pocket recovery`, and either fresh advisory `actionableHostiles==0` or raw vitals hostiles zero. The protected hold now re-anchors like night/no-regen/table recovery instead of sending `cancel_skill` or later restart.
- **预测**: While the current `hp=15 food=4` kill-box recovery hold remains fresh and advisory threats stay nonactionable, watchdog should not emit another `STUCK-ZONE`/`CONTROL SENT cancel_skill`; heartbeat should continue, core C206 may keep logging its own pin exemption, and sticky `missionNether` should remain undisturbed. If progress intent disappears, edible food appears, mobility is no longer contained, or actionable threats appear, normal STUCK-ZONE detection remains available.
- **观测**: 🟡 `[scriptblock]::Create((Get-Content watchdog.ps1 -Raw))` passed after fixing a literal newline artifact before reload. Watchdog-only reload succeeded through the singleton guard: new watchdog pid `30332`, old watchdog pids `11072`/`12744` stopped, and `fresh_status` stayed `classification=live` with `agentWs=open mindserver=open minecraftLan=open`, `hp=15 food=4 pos=9,52,-11`. ✅ Verified across the next anchored window: watchdog heartbeats continued through 2026-06-13T17:03:22+08:00 at the same pos=9,52,-11 hp=15 food=4 skill=missionNether mob=FREE/ENC, while ALERTS.txt showed no new STUCK-ZONE/CONTROL SENT after the pre-patch 16:42:24 false positive. Core C206 also continued logging pinned kill-box low-food hold exempt... and mine_motion remained unchanged.
- **回滚**: Remove `$advFresh`, `$advActionable`, `$killBoxLowFoodHold`, and its inclusion in the STUCK-ZONE exemption condition from `watchdog.ps1`.
## C206. core pin-breaker exempts intentional kill-box low-food recovery holds（①层 modes.js，需 core 安全重启生效）
- **触发**: After C205 hotload, fresh live stayed `classification=live` at `pos=9,52,-11 hp=15 food=4 skill=missionNether held=iron_pickaxe`. Progress kept writing `★KILL-BOX gated: low-food pocket recovery...`, no `mine_motion` advanced, no deaths/alerts changed, and advisory hostiles were nonactionable. Fresh `events.log` then wrote `Pinned 15min+ — kicking the stack (forced interrupt)` and cancelled the same intentional hold; sticky rearmed `missionNether`, which immediately returned to the same low-food kill-box gate.
- **机理**: `reflex_watchdog` pin-breaker exempts night bunker, generic low-food shelter, no-regen, body-budget, and table-recovery holds, but it did not recognize the newer C203/C204 kill-box low-food recovery gate. Its `lowFoodShelter` path requires no hostile within 12 and does not read the fresh progress intent, so a deliberate death-zone body-budget hold with far/nonactionable mobs can still be misclassified as a stale stack and kicked once a minute.
- **改动**: Added `killBoxLowFoodHold`: when fresh `progress.txt` contains `[mission] ★KILL-BOX gated: low-food pocket recovery`, current skill/progress is missionNether, `food<=6`, no normal edible, covered/enclosed/contained, no point-blank hostile, no fluid/fall, pin-breaker resets its anchor instead of forcing interrupt. It logs `[reflex_watchdog] pinned kill-box low-food hold exempt...` at most once per minute for verification.
- **预测**: After a safe core reload, this exact `hp=15 food=4` missionNether hold should no longer emit `Pinned 15min+ — kicking the stack`; instead, if the pin window matures while the C203 gate is fresh, progress should show `pinned kill-box low-food hold exempt...` and sticky mission should remain undisturbed. True pinned non-shelter loops remain kickable.
- **观测**: 🟡 `node --check src/agent/modes.js` passed. Fresh restart gates checked: daylight (`tod≈8433`), `hp=15 food=4`, no actionable hostiles, all ports open. Controlled agent-side reload was performed: watchdog stop file set, old watchdog pid `35664` stopped, only agent/mindserver port owners `34280/35952` stopped; Minecraft Java/LAN `55916` pid `9140` stayed open. First agent launch exposed a short WS gap and watchdog logged `WATCHDOG RESTART: agent DOWN (48909 not listening)`, then relaunched cleanly. Fresh status returned `classification=live` with `agentWs=open mindserver=open minecraftLan=open`; new ports are WS pid `32736`, mindserver pid `30928`, Minecraft LAN pid `9140`. Bridge reconnected and sticky re-sent `missionNether`; live remains `hp=15 food=4 pos=9,52,-11 held=iron_pickaxe`. ✅ Next matured pin window verified C206: at `2026-06-13T08:36:49.105Z`, live progress logged `[reflex_watchdog] pinned kill-box low-food hold exempt: food=4 hp=15 mob=FREE enclosed=true closestHostile=16.3 — no forced interrupt`; fresh status remained `classification=live` with `hp=15 food=4 pos=9,52,-11`, all ports open, advisory hostiles nonactionable, and no new `Pinned 15min+` forced interrupt occurred after the C206 reload.
- **回滚**: Remove `killBoxLowFoodHold` and the `pinned kill-box low-food hold exempt` branch from `src/agent/modes.js`.

## C205. prepNether honors mission stationary-kit handoff before its mirrored kill-box escape（③层 missionNether/prepNether 热加载）
- **触发**: C204 live verification fired at daylight: `★KILL-BOX low-food stationary kit handoff: raw_iron=3 fuel=93 furnaceReady=true`. But the child `prepNether` immediately hit its own mirrored kill-box branch first: `★KILL-BOX(prep): underground in cluster (y=53) → surfaceUp first`, climbed/digged to `y=67`, then did the local kit work. It did craft/equip `iron_pickaxe=1`, but food dropped `5→4`, `mine_motion` advanced with `smeltSafe`/`missionNether` destructive `GoalInvert` and step-edge events, and the supposedly stationary handoff still spent route/dig budget.
- **机理**: `missionNether` C204 handed off to `prepNether` but did not communicate "this call is only for zero-travel local kit work." `prepNether` has an older high-priority kill-box escape mirror above `famineStaticKit()`, so it interpreted the same death-zone as needing `surfaceUp` before it ever reached the local smelt/craft helper.
- **改动**: `missionNether` now sets a short `_prepStationaryKitOnlyUntil` token before the C204 `prepNether` call. `prepNether` reads that token in its kill-box block; when low-food/no-edible, covered/contained, and a local static-kit opportunity exists, it logs `KILL-BOX(prep): stationary kit override...` and skips both `surfaceUp` and horizontal expel, while still allowing the later static-kit helper to run.
- **预测**: Future C204-style handoffs should show the prep-level `stationary kit override` before any static smelt/craft logs, with no `KILL-BOX(prep) ... surfaceUp first`, no `expelling to ...`, and no new destructive path chain solely to prepare the station. If no local kit opportunity exists, the old prepNether kill-box behavior remains available.
- **观测**: 🟡 `node --check bots/_supervisor/skills/missionNether.js` and `node --check bots/_supervisor/skills/prepNether.js` passed. Inbox `cancel_skill` hotloaded C205 (`cancel_result ok=true`, sticky re-sent `missionNether`). Fresh post-hotload status is live with all ports open, `hp=15 food=4 pos=9,52,-11 skill=missionNether held=iron_pickaxe pickFx=3`, and `mine_motion` has not advanced beyond the earlier C204 path (`LastWriteTime 2026-06-13 16:23:56`). Needs a future repeat stationary-kit handoff to verify the new prep-level `stationary kit override` log.
- **回滚**: Remove `_prepStationaryKitOnlyUntil` from the C204 handoff in `missionNether.js` and remove `stationaryKitOnly()` / `stationaryKitOpportunity()` / `stationary kit override` from the prepNether kill-box block.

## C204. kill-box low-food hold can hand off to zero-travel static kit work（③层 missionNether/prepNether 热加载）
- **触发**: After C203 was verified, fresh live stayed `classification=live` for the full daylight window at `pos=8,53,-11 hp=15 food=5 skill=missionNether mob=FREE/ENC`. Progress repeated `★KILL-BOX gated: low-food pocket recovery... no horizontal/vertical expel without food signal` every 30s, `mine_motion.jsonl` did not advance, and advisory hostiles remained nonactionable. Inventory already had `raw_iron=3`, `coal=89`, `furnace=1`, `crafting_table=1`, `stick=9`, and `stone_pickaxe=2`.
- **机理**: C203 correctly prevented hungry horizontal/vertical expel, but its early kill-box `continue` also sat above `prepNether`'s local static-kit helper. `prepNether.famineStaticKit()` itself only ran under stricter famine (`food<=2` or `food<=6 hp<=10`), so the current `food=5 hp=15` contained pocket could not convert already-earned raw iron into an iron pickaxe without movement.
- **改动**: `missionNether` now detects a stationary kit opportunity inside the C203 low-food kill-box gate (raw iron+fuel+furnace, or ingots+sticks/table for iron pickaxe/shield). Once per minute it stops movement and calls `prepNether`, explicitly preserving the no-expel rule. `prepNether.famineStaticKit()` now also runs for contained low-food/no-edible holds, smelts enough raw iron for an iron pickaxe when sticks are available, and crafts/equips that iron pickaxe locally before the roaming/food gates.
- **预测**: In the current `food=5` contained death-zone pocket, the next hotloaded mission loop should emit `KILL-BOX low-food stationary kit handoff...`, then `prepNether: LOW-FOOD contained static kit check...`, smelt `raw_iron` up to `iron_ingot>=3`, and craft/equip `iron_pickaxe` without new `GoalNear`, `GoalInvert`, `surfaceUp target=...`, or horizontal `expelling to ...` movement. If no stationary ingredients/stations exist, C203 should continue holding exactly as before.
- **观测**: ⚠️ C204 was hotloaded and then verified at the next daylight pass. Progress wrote `★KILL-BOX low-food stationary kit handoff: raw_iron=3 fuel=93 furnaceReady=true`, `prepNether: LOW-FOOD contained static kit check food=4 hp=15... raw=3`, and `prepNether: LOW-FOOD contained static iron_pickaxe crafted/equipped ironPick=1`; fresh vitals now show `held=iron_pickaxe`, `pickFx=3`, inventory `iron_pickaxe=1`, `raw_iron=0`, `coal=88`. Partial/regression: before reaching static kit, prepNether's own kill-box mirror still launched `surfaceUp first`, causing y/food movement and destructive path events; C205 patches that mechanism.
- **回滚**: Remove `stationaryKitOpportunity()` and the `prepNether` handoff from the C203 gate in `missionNether.js`; restore `famineStaticKit()` to the `famineBudget()`-only guard and one-ingot smelt behavior in `prepNether.js`.

## C203. kill-box horizontal expel respects low-food pocket recovery（③层 missionNether 热加载）
- **触发**: After the controlled C202 core reload, fresh status returned live (`hp=15 food=5 mob=POCKET/ENC`, ports open). Core `Pocketed — carving a step out` spam stopped, but mission KILL-BOX saw `enclosed=false` for one loop at `y=70` and launched horizontal expel: `★KILL-BOX: 23b inside death cluster ... → expelling to 18,8`. `mine_motion` then showed `GoalNear 18,70,8` refusing blind destructive navigation, repeated `step_edge.skip target-foot-blocked`, and pathfinder `GoalInvert` unstick digging down from `y=70` to `y=64` while `food=5` and no edible/close food signal existed.
- **机理**: C201 only gated the low-roof/vertical-expel branch (`p0.y < 70 || hasOverheadCover()`). At exactly `y=70`, with mobility state still `POCKET` but overhead/enclosed freshness briefly false after restart, the code fell through to the horizontal expel branch. That let pathfinder/step-edge spend body and block budget on an unsafe route in the same low-food no-food scene.
- **改动**: Added a KILL-BOX pre-expel gate for `food<=6`, no edible, no close safe food signal, no actionable hostile within 12, and overhead/contained mobility state (`POCKET|ENTOMBED|MAROONED`). When true it stops pathfinder/controls, logs `KILL-BOX gated: low-food pocket recovery... no horizontal/vertical expel without food signal`, waits, and skips both vertical `surfaceUp` and horizontal expel.
- **预测**: In the current low-food POCKET death-cluster scene, future mission loops should not emit `expelling to ...` or `surfaceUp target=...` unless a food signal/edible item appears or an actionable hostile forces emergency movement. Expected progress line is the new `low-food pocket recovery` gate; `mine_motion` should stop adding missionNether `GoalNear 18,70,8`, `GoalInvert`, and downward unstick digs for this condition.
- **观测**: ✅ `node --check bots/_supervisor/skills/missionNether.js` passed. Inbox `cancel_skill` hotloaded C203 (`cancel_result ok=true`, sticky re-sent `missionNether`). The bad `GoalNear/GoalInvert` path chain had already descended to `y=53` before the cancel took effect; after hotload, fresh status stayed live (`hp=15 food=5 mob=FREE/ENC`). At dawn (`tod≈1213`) progress wrote repeated `★KILL-BOX gated: low-food pocket recovery food=5 hp=15 y=53; no horizontal/vertical expel without food signal`, while `mine_motion.jsonl` remained unchanged after the pre-cancel path (`LastWriteTime 2026-06-13 15:54:15`). No new `expelling to ...`, `surfaceUp target=...`, `GoalNear 18,70,8`, `GoalInvert`, or downward unstick digs appeared in the live window.
- **回滚**: Remove `pocketLowFoodNoExit` and its early KILL-BOX gate from `missionNether.js`.

## C202. core POCKET step-out also gates daytime low-food/no-edible holds（①层 modes.js，待 core 安全重启生效）
- **触发**: C201 stopped mission-level kill-box `surfaceUp`, but live events immediately showed core `mobility` repeating `Pocketed — carving a step out` at `hp=15 food=5 mob=POCKET/ENC`. `mine_motion` recorded skillless core digs around the pocket while mission was trying to preserve the low-food body budget. This is the same family as earlier POCKET famine-night/no-regen gates, but with hp above the no-regen cutoff and daytime active.
- **机理**: The POCKET branch only gated `noRegenSafeAirHold()` and `isNight && food<=6 && noEdible`. Daytime low-food contained holds still fell through to the step-out dig, even when there was no actionable hostile and no edible item, so core reflexes could consume pick/body budget while supervisor policy was holding for food.
- **改动**: Added a daytime low-food POCKET gate: when `food<=6`, no edible is held, and no same-level hostile is actionable within 12 blocks, mobility clears controls, refreshes POCKET state, and logs `POCKET low-food daylight gate ... no step-out dig without food signal` instead of carving.
- **预测**: After a safe core restart, the current `hp=15 food=5 POCKET/ENC` scene should no longer emit `Pocketed — carving a step out` or skillless POCKET dig events. It should log the new daylight gate until food, threat, or state changes. Night famine and critical no-regen gates remain unchanged.
- **观测**: ✅ `node --check src/agent/modes.js` passed. Controlled agent-side reload ran during a daylight safety window (`hp=15 food=5`, no actionable hostiles): watchdog stopped via `watchdog.stop`, only agent/mindserver port owners were restarted, Minecraft LAN stayed open. Fresh status returned `classification=live` with all ports open. After reconnect, events no longer emitted the core `Pocketed — carving a step out` spam; remaining movement came from mission KILL-BOX horizontal expel and is tracked as C203.
- **回滚**: Remove the daytime low-food POCKET gate from `src/agent/modes.js`.

## C201. kill-box low-roof vertical expel respects low-food contained recovery（③层 missionNether 热加载）
- **触发**: After dawn, fresh live remained `pos=9,72,-11 hp=15 food=5 skill=missionNether mob=POCKET/ENC`, advisory `eat_now`, no actionable hostiles, and no edible held. Instead of reaching C199/feed policy, the top-level kill-box branch repeatedly wrote `pocket/low-roof in cluster (y=72) → surfaceUp target=84 before horizontal expel`. `mine_motion` showed `surfaceUp` repeatedly attempting `place_underfoot` where the target was already `gravel@8,72,-12`, ending `reason=target-not-empty` without movement.
- **机理**: KILL-BOX is above advisory/feed/prep policy in `missionNether`, and its low-roof vertical-expel branch only gated night+covered. In daylight it treated being inside the death cluster as more urgent than the food/body budget, so it repeatedly launched an unproductive vertical climb from a contained, food=5 pocket.
- **改动**: Before kill-box `surfaceUp`, mission now checks for low-food contained recovery: `food<=6`, no edible, no close safe food signal, no actionable hostile within 12, and overhead/contained mobility. When true it logs `KILL-BOX gated: low-food contained recovery...`, stops movement, and waits instead of launching `surfaceUp` or horizontal expel.
- **预测**: The current `food=5 POCKET/ENC` death-cluster pocket should stop emitting `surfaceUp target=84` every ~18s and should preserve body budget until a food signal, edible item, threat, or non-contained state changes the decision. If actionable danger appears, or a concrete close food signal appears, the kill-box/feed paths can run again.
- **观测**: ✅ `node --check bots/_supervisor/skills/missionNether.js` passed. Inbox `cancel_skill` hotloaded C201 (`cancel_result ok=true`, sticky re-sent `missionNether`). Fresh post-hotload progress wrote `★KILL-BOX gated: low-food contained recovery food=5 hp=15 y=72; no surfaceUp/vertical expel without food signal`; the repeated mission-level `surfaceUp target=84` loop stopped. Remaining skillless `Pocketed — carving a step out` is core mobility and is tracked separately as C202.
- **回滚**: Remove the `containedLowFood` gate from the KILL-BOX low-roof branch in `missionNether.js`.

## C200. watchdog STUCK-ZONE recognizes low-food night bunker holds above the no-regen hp cutoff（watchdog.ps1，待 watchdog 安全重启生效）
- **触发**: Fresh live after C199 was `pos=9,72,-11 hp=15 food=5 skill=missionNether mob=POCKET/ENC`, with progress repeatedly writing `HUNGRY/LOWHP ... night — HOLD`, `dug-in bunker SEALED`, `POCKET famine-night gate`, and `KILL-BOX ... night+covered — hold bunker until dawn`. Immediately before this, root `ALERTS.txt`/events showed another `STUCK-ZONE within 10b for 10min` cancel at the same low-food hold, plus repeated core pin-breaker cancels before the bunker sealed.
- **机理**: Detached watchdog exempted table recovery, critical sealed body-budget (`hp<=8 food<=6`), and no-regen holds only when `hp<14`. The current bunker is intentionally stationary and low-food, but `hp=15` sits above the no-regen cutoff, and `$progLast` can be a mobility heartbeat rather than the night-hold line, so STUCK-ZONE can misclassify the valid shelter as entrapment.
- **改动**: Added `lowFoodNightShelterHold`: missionNether, `food<=6`, `hp>=10`, no normal edible, no hostiles, contained mobility (`ENC/POCKET/MAROONED/ENTOMBED`), and fresh progress tail evidence of hungry-night/famine-night/low-food-breakout/night-covered bunker. It reuses the existing STUCK-ZONE exemption path, re-anchoring instead of cancel/restart while the protected hold remains fresh.
- **预测**: After the next safe watchdog reload, this exact `hp=15 food=5 POCKET/ENC night bunker` should not emit `STUCK-ZONE` or `cancel_skill`; watchdog heartbeat should continue while mission/mobility hold until dawn. If the hold evidence disappears, hostiles become raw in vitals, edible food appears, or the bot is not contained, normal STUCK-ZONE protection remains active.
- **观测**: ⚠️ `[scriptblock]::Create((Get-Content watchdog.ps1 -Raw))` passed. Loaded during the controlled C202 core reload: old watchdog exited via `watchdog.stop`, new watchdog started (`pid 35664`), and fresh status showed `watchdog` fresh with all ports open. Current low-food night/covered hold has not emitted a fresh STUCK-ZONE alert, but keep watching until it spans a normal stuck-alert window before calling this fully verified.
- **回滚**: Remove `$lowFoodNightShelterHold` and its inclusion in the STUCK-ZONE exemption condition.

## C199. feedUp dry-site result gates mission/prepNether retries instead of re-entering unreachable forage（③层 feedUp/missionNether/prepNether 热加载）
- **触发**: Fresh live at `pos=9,77,-12 hp=15 food=5 skill=missionNether mob=FREE` showed a repeated daylight loop: advisory `eat_now` and prepNether low-food paths kept launching `feedUp`; `feedUp` found no huntable animals/forage/drops, saw only `oak_leaves@7 dy=3`, failed `safe_roam` with `moved≈0`/`targetDist≈6.5`, then wrote `calorie-floor stop ... no long roam without a target`. The same dry site was retried every mission/prep pass and food fell from 6 to 5.
- **机理**: `feedUp` had local targeted-oak cooldowns, but its final "no food here" result was not exported to the callers. `missionNether` and `prepNether` therefore treated every advisory/prep call as a fresh opportunity, even when no new close food signal or edible item had appeared and the bot had not left the same ridge.
- **改动**: `feedUp` now records a short `_feedUpDryNoFood` cooldown on calorie-floor/no-food-source exits, including position, reason, hp/food, and scan. `missionNether` gates advisory/cooldown feedUp calls while that cooldown is live, unless the bot moved to a new site, holds edible food, or `safeCloseFoodSignal()` sees a close same-level animal/drop. `prepNether.keepFed()` applies the same dry-site gate before `surfaceUp/feedUp`, using `foodSignalBeforeSurface()` as the new-signal escape hatch.
- **预测**: The current `oak_leaves@7 dy=3` failed-approach scene should stop re-launching `feedUp` every 30-60s. Expected live logs: `feedUp: dry no-food cooldown ... reason=calorie-floor`, then `★ADVISORY eat_now gated: feedUp dry no-food cooldown...` or `prepNether: HUNGER/LOWHP gate — feedUp dry no-food cooldown...`. If a real close food drop/animal appears, edible food enters inventory, or the bot leaves the dry site, feedUp should be allowed again.
- **观测**: 🟡 `node --check bots/_supervisor/skills/feedUp.js`、`missionNether.js`、`prepNether.js` passed. Inbox `cancel_skill` hotloaded C199 (`cancel_result ok=true`, sticky re-sent `missionNether`). The immediate post-hotload scene flipped to night and `prepNether` sealed a bunker at `y=72`, so the dry-site gate has not yet had a daylight feedUp retry to prove the new log. Pre-hotload evidence still shows repeated `oak_leaves@7 dy=3` failed approach and calorie-floor stop; wait for the next daylight/food-low feed pass to verify `dry no-food cooldown` and caller-side gate logs.
- **回滚**: Remove `markDryNoFood()` and `_feedUpDryNoFood*` writes from `feedUp.js`; remove `feedUpDryNoFood()`/`gateDryFeedUp()` from `missionNether.js`; remove the dry-site gate from `prepNether.keepFed()`.

## C198. branchMine low-food exception is iron-only and stops once the food buffer is spent（③层 branchMine 热加载）
- **触发**: C196/C197 correctly allowed the calm underground iron chain at `hp=15 food=8`, but the `branchMine` subskill did not know that this was an essential-iron exception. It descended from `y=84` to the `y=65→52` band and spent the last food buffer mining coal/stone/stone windows while chasing ores. Fresh vitals then showed `hp=15 food=7 pos=8,54,-10`, and mine_motion still had `branchMine` dig/path events; only after the inbox cancel did mission return to covered hold. The run did expose `raw_iron=3`, but food had already crossed below C196/C197's moderate threshold.
- **机理**: `branchMine.mineNearby()` treats all ores in `ORES` as opportunistic targets, so a low-food iron-probe run can drift into coal/copper/stone window work. Its existing night stop only handled close actionable hostiles; it did not stop at dusk/night or when `food<8`/`hp<14` in the no-edible essential-kit window.
- **改动**: `branchMine` now defines `IRON_ORES`, detects held edible food, and adds `lowFoodEssentialStop()`. With no edible held, `food<8`, `hp<14`, dusk/night at `food=8`, or fresh actionable advisory at `food=8` returns `false` from descent/ore-chase/tunnel and logs a `branchMine.stop`/`descent.stop`/`tunnel.stop`. At `food<=8` it also filters ore-chase to iron ore only and logs `low-food-essential-iron-only` skips for non-iron ores.
- **预测**: Future C197-enabled low-food iron probes may still descend/mine in a daylight calm buffer, but should not consume the last hunger point on coal/copper/general tunnel work. If food falls to 7, HP below 14, dusk/night arrives, or actionable hostiles appear, branchMine should yield and let mission/prepNether survival policy hold or recover. At `food=8` daylight with immediate iron ore, it can still collect that iron.
- **观测**: 🟡 `node --check bots/_supervisor/skills/branchMine.js` passed. Inbox `cancel_skill` hotloaded C198 after fresh `food=7`; old branchMine ended, sticky mission restarted, and live settled at `pos=8,52,-12 hp=15 food=7 raw_iron=3 skill=missionNether`, logging `★KILL-BOX: inside cluster but night+covered — hold bunker until dawn`. Needs next daylight/food=8 repeat to verify the new `branchMine.stop ... low-food` or non-iron skip signals in live mine_motion.
- **回滚**: Remove `IRON_ORES`, `FOOD_RE`, `edibleHeld()`, `isIronOre()`, `lowFoodEssentialStop()`, the non-iron ore filter, and the low-food stop checks from `branchMine.js`.

## C197. achieve low-food mining gate mirrors prepNether's calm underground exception for essential kit work（③层 achieve 热加载）
- **触发**: C196 successfully broke the prepNether cave-climb backoff loop: live progress wrote `no surface food signal, but hp=15 food=10 calm/enclosed with pick; allow local underground prep only`, crafted a spare `stone_pickaxe`, and entered the iron-pickaxe chain. The next layer immediately wrote `LOW-FOOD mining gate — food=10 hp=15 at y=70; no edible held, surface/feed before more iron_ore`, launched `surfaceUp`/`feedUp`, consumed food down to 8, found no food, then returned to mission's low-food hold.
- **机理**: `achieve` had an independent `food<=12` mining gate, plus an earlier `food<=8` resource gate, that did not know prepNether had already ruled out blind surface food climbs but allowed calm local underground work. The result was policy disagreement: prepNether allowed local kit work, achieve converted the iron subgoal back into a surface food climb.
- **改动**: `achieve` now defines `moderateUndergroundWorkOk()` (`food>=8`, `hp>=14`, no edible held, has pick, not open surface, covered/enclosed, no hostile within 12). Essential underground kit goals (`iron_pickaxe`, `iron_ingot`, `raw_iron`, `iron_ore`, `stone_pickaxe`, `cobblestone`) bypass the top low-food resource gate under that condition, and the mining gate logs `allow essential local ... instead of surface/feed` instead of launching `surfaceUp`.
- **预测**: The next calm enclosed `hp≈15 food≈8-10` iron chain should not force another surface/feed run solely because food is below 12. It should either collect/probe local iron safely, hit a concrete mining/pathing gate, or stop once food/HP drops below the moderate buffer. Exposed, hostile, no-pick, food<8, or hp<14 states should still use the old hold/feed behavior.
- **观测**: ⚠️ `node --check bots/_supervisor/skills/achieve.js` 通过，inbox hotload ok。Live wrote `LOW-FOOD resource gate iron_pickaxe/iron_ingot/raw_iron: food=8, hp=15 ... allow essential local underground kit work` and `LOW-FOOD mining gate ... allow essential local iron_ore work instead of surface/feed`, then entered `branchMine` instead of another `surfaceUp/feedUp`. Partial: this exposed C198 because branchMine consumed the buffer to `food=7` on opportunistic ore/window work before the cancel; branchMine now owns that narrower stop.
- **回滚**: Remove `moderateUndergroundWorkOk()`, `essentialUndergroundKitGoal`, and the mining-gate bypass from `achieve.js`.

## C196. moderate low-food daylight underground state can continue local prep instead of refreshing cave-climb backoff forever（③层 prepNether 热加载）
- **触发**: After C195, stale evidence stopped self-renewing, but dawn revealed a fresh loop at `pos=8,69,32 hp=15 food=10`: prepNether wrote `HUNGER/LOWHP gate — no concrete food signal before cave climb ... hold instead of surfaceUp`; after the 90s freshness window mission re-entered prepNether, which then wrote `last surface/feedUp found no food; backoff 87s before another cave climb`, and mission gated again. Advisory was calm (`risk=0`, hostiles/actionable=0), the bot was enclosed/covered, and it held a `stone_pickaxe`.
- **机理**: `keepFed()` treated any underground `food>=7` no-food-signal state as a total prep stop, even when the actual unsafe action was only a blind cave/surface food climb. With moderate buffer (`hp>=14 food≈10`) and no hostiles, this blocked safe local underground kit work and made the cave-climb backoff a mission-level idle loop.
- **改动**: `keepFed()` now has a narrow `moderateSafeUndergroundWork` exit before the surface-food backoff/no-signal hold: daylight, not open surface, `hp>=14`, `food>=8`, no edible held, has a pick, covered/enclosed, and no actionable threats within 12. In that case it logs `allow local underground prep only` and returns true, preserving the ban on blind surface food climbs while allowing local mining/prep to proceed.
- **预测**: Current `hp=15 food=8-10` calm enclosed state should stop refreshing the no-food cave-climb backoff and should move into local prep/iron work or another concrete gate. Low HP/critical famine, night/dusk, exposed/open surface, no pick, or actionable hostile states should still hold as before.
- **观测**: ⚠️ `node --check bots/_supervisor/skills/prepNether.js` 通过。First live pass at `hp=15 food=10` wrote `allow local underground prep only`, crafted a spare stone pick, and moved into the iron-pickaxe chain, proving the prepNether gate opened. It then exposed C197: `achieve` independently forced `LOW-FOOD mining gate ... surface/feed before more iron_ore`, consumed food to 8, and found no food. After C197, prepNether was aligned to `food>=8`; second hotload wrote `hp=15 food=8 ... allow local underground prep only` and reached local iron prep. Partial because the downstream branchMine layer then needed C198 to prevent spending the last buffer on non-essential mining.
- **回滚**: Remove `moderateSafeUndergroundWork()` and its early return from `keepFed()`.

## C195. low-food breakout gate requires timestamp-fresh prepNether evidence, not just fresh progress file mtime（③层 missionNether 热加载）
- **触发**: C194 blocked the unsafe blind breakout, but the next live window showed a new idle loop at `pos=8,69,32 hp=15 food=10`: `missionNether` kept writing `★BREAKOUT gated: prepNether low-food hold evidence...` every 30s through 06:57Z, while the actual prepNether `HUNGER/LOWHP gate ... backoff 141s` evidence was last written around 06:46Z. `fresh_status` stayed live/fresh because `progress.txt` mtime was renewed by mission's own gate log.
- **机理**: `freshProgressTail()` only checked `progress.txt` mtime before returning the raw tail. Mission's self-gate log refreshed the file, so stale prepNether evidence still present in the tail looked current and kept lowFoodHoldEvidence true indefinitely.
- **改动**: `missionNether` now separates raw tail reading from freshness filtering. `freshProgressTail(maxAgeMs)` parses each progress line's ISO timestamp and returns only lines within the freshness window, so mission's own later writes cannot make old prepNether `HUNGER/LOWHP` evidence fresh.
- **预测**: Once prepNether low-food evidence ages past the 90s window, C194's low-food breakout gate should stop self-renewing. Mission should re-enter normal prepNether/shelter/forage scheduling, while genuinely fresh prepNether low-food/night hold evidence can still suppress blind breakout.
- **观测**: ⚠️ `node --check bots/_supervisor/skills/missionNether.js` 通过。Inbox `cancel_skill` 热加载 C195，events 写 `cancel_result ok=true` 并由 sticky 重新发送 `missionNether`。新 run 没有继续用旧 06:46Z `HUNGER/LOWHP gate` 自续；它立即写 `not kitted ... → prepNether`，随后 prepNether 写出当前新鲜原因 `★HUNGRY/LOWHP food=10 hp=15, no food held, night — HOLD all work until dawn` 与 `hungry-night hold 30s`。Fresh status 仍 live/open，`hp=15 food=10 pos=8,69,32`，mine_motion 无新 dig/place，说明 stale-evidence self-loop 已打断；仍需等 dawn 验证下一步恢复不会盲挖。
- **回滚**: Restore `freshProgressTail()` to the old file-mtime-only tail reader and remove `readProgressTail()`.

## C194. mission breakout does not tunnel out of an intentional low-food shelter hold（③层 missionNether 热加载）
- **触发**: Fresh live after C193 showed the bot safely sealed through night at `8,82,19`, `hp=20 food=10`, no hostiles. At dawn prepNether wrote `HUNGER/LOWHP gate — no concrete food signal before cave climb ... hold instead of surfaceUp`, but missionNether's pinned timer then fired `★BREAKOUT: pinned 4min — tunneling toward anchor dir=0,1`. The breakout cut from `y=82` to `y=69`; combat/events logged `HURT dmg=5 hp=15` at `pos=[8.5,74,22.7]` with no mobs, and progress fell into repeated `last surface/feedUp found no food` backoff.
- **机理**: The mission-level last-resort breakout treats “position held for four minutes” as a geometry trap. It did not distinguish a deliberate prepNether survival/food hold, so a successful night bunker plus no-food/no-signal daylight hold was misclassified as stuck. The tunnel direction was material-gated but not shelter-preserving, so it opened/descended through the body budget and caused damage.
- **改动**: `missionNether` now reads a fresh `progress.txt` tail and gates breakout when it sees recent prepNether low-food hold evidence (`HUNGER/LOWHP`, hungry-night hold, no concrete food signal, or feedUp no-food backoff), no edible food held, `food<=10`, no actionable hostiles from fresh advisory/local fallback, and covered/enclosed/high-y context. When gated it stops movement, clears controls, resets the pinned timer, logs `★BREAKOUT gated: prepNether low-food hold evidence...`, and waits instead of blind tunneling.
- **预测**: The next safe low-food/no-food hold should no longer produce `★BREAKOUT: pinned 4min`; it should log the new gated line about once per 30s and preserve the bunker/tunnel body. If actionable hostiles appear or the fresh hold evidence disappears, normal mission escape/task flow remains available.
- **观测**: ✅ `node --check bots/_supervisor/skills/missionNether.js` passed. Inbox `cancel_skill` hotloaded C194; events wrote `cancel_result ok=true`, sticky rearmed `missionNether`, and the new run immediately logged `★BREAKOUT gated: prepNether low-food hold evidence food=10 hp=15 y=69 covered=true actionable=0 threatSrc=advisory; reset pinned timer, no blind shelter tunnel`. Fresh status remained `classification=live`, ports open, `hp=15 food=10`, no hostiles. Next heartbeat saw repeated gated lines at 06:47:23Z and 06:47:53Z with no new `★BREAKOUT: pinned 4min` and no movement/damage, so the immediate low-food hold regression is blocked.
- **回滚**: Remove `freshProgressTail()`, `lowFoodHoldEvidence()`, and the low-food gate before the pinned breakout timer; restore `progressTailHasTableGate()` to its old direct file-tail reader.

## C193. branchMine stops night high-y mining when fresh advisory reports close actionable hostile（③层 branchMine 热加载）
- **触发**: After C192, branchMine successfully descended from `y=89` to the `y=64` band and was mining coal/copper, but night fell while it kept ore-chasing. Fresh advisory at `pos=[16,63,4]` reported `risk=80`, `actionableHostiles=1`, `actionableNearest=3.4`, `creeper-close`, `night+surface`, and local `deathsNear16=3`. Progress showed repeated `[self_preservation] covered night hold` while vitals still moved and food dropped `14→13`, so supervisor branchMine was still owning movement/digging under a close creeper.
- **机理**: `achieve` has a night-exposed mining gate before starting collection, but `branchMine` itself can be launched during daylight and continue across dusk. Once inside branchMine, descent/ore-chase/tunnel loops had no fresh advisory/actionable-hostile stop, so core could only log covered hold while the supervisor skill continued local mining and item pickup pathing.
- **改动**: `branchMine` now reads fresh `advisory.json` and, at night above y50, stops descent, tunnel steps, stepInto, and ore-chase when `actionableHostiles>0` and `actionableNearest<=8`. If advisory is stale, it falls back to local hostile distance via `mc.isHostile`. It logs `branchMine.stop` / `branchMine.descent.stop` / `branchMine.tunnel.stop` with `night-actionable-hostile` and returns `false` so mission/prepNether can hole up or feed instead of continuing the mine.
- **预测**: In the next repeat where a branchMine run crosses into night with a close actionable creeper, mine_motion should show `branchMine.stop ... night actionable hostile ...` and progress should transition to bunker/food/survival policy, not continued coal/copper dig/pickup steps. Daytime branchMine and night mining with no actionable close hostile should continue unchanged.
- **观测**: ⚠️ Immediate inbox cancel sent first when live creeper reached `3.4b`; `node --check bots/_supervisor/skills/branchMine.js` passed, then C193 hotload sent. In the post-hotload window, no further branchMine continuation was observed; the earlier low-food mining gate handed off to `surfaceUp`, then the next prepNether night pass wrote `★NIGHT ... shelter` and `★dug-in bunker SEALED y=82`. Latest fresh advisory has `shelter_now`, no hostiles, `hp=20 food=10`. Partial because the exact `branchMine.stop ... night actionable hostile` signal needs a future repeat branchMine-at-night-close-hostile scene.
- **回滚**: Remove `nightActionableStop()` and its checks from `mineNearby`, `stepInto`, descent, and tunnel loops.

## C192. high-mountain iron probe exhaustion cools down, and branchMine can locally drop into safe one-block descents（③层 achieve/branchMine/prepNether 热加载）
- **触发**: After C191 moved the bot out of the local death cluster, live dawn resumed iron prep at `hp=20 food=16 pos=20,89,19`. `progress.txt` then repeated `mine probe: iron_ore y=89 — high mountain miss; staircase to y48 then branchMine` followed by `budget exhausted (high-mountain-descend) — yield body; no more blind descent` many times per second, immediately re-entering `NO KNOWN WAY to obtain iron_ingot/shield/iron_pickaxe`. Earlier `mine_motion` for the same recovery chain also showed repeated `branchMine.step.end reason=wrong-y` on a safe adjacent `descent-step y85->84` where target foot/head were air and floor was stone.
- **机理**: `achieve.exposeMore()` tracked lateral probe attempts, but once `st.lateral>2` it returned `false` without a real cooldown. The recursive dependency chain immediately requested raw iron again, so the same exhausted probe state produced a busy-loop instead of yielding to mission/survival policy. Separately, `branchMine.stepInto()` trusted pathfinder/structured edge assist for a one-block down adjacent target; when pathfinder refused, it only logged `rawHop.skipped` and left the player on the higher Y.
- **改动**: `achieve` now records a per `item:block` probe cooldown (`45s` for `high-mountain-descend`, `30s` for other shallow lateral exhaustion), logs `achieve.probe.cooldown_yield`, and clears/resets the probe state after the cooldown before retrying. `branchMine` adds a guarded `local_drop` fallback after failed structured edge assist: only for nearby one-block downward targets with solid floor, clear foot/head, and no fluid, it briefly walks toward the target and logs `branchMine.step.local_drop.begin/end`. It also retries equipping filler before bridge placement and returns `false` if a requested `targetY` descent makes no Y progress. `prepNether` now reads the active iron probe cooldown and yields iron-dependent goals before re-entering impossible shield/iron-pickaxe crafts while no iron/raw iron is held.
- **预测**: The current high-y iron miss should no longer spam `budget exhausted`/`NO KNOWN WAY` in a tight loop; it should show `mine probe cooldown ... yield Ns` / `prepNether: iron probe cooldown ... yield Ns` while other policy can run. On the next safe descent attempt, a pathfinder `wrong-y` at an adjacent lower clear cell should be followed by `branchMine.step.local_drop.end ok=true` or a clear failed local-drop log, rather than only `rawHop.skipped`. If bridge placement fails before any descent, `branchMine` should return `false` and let the probe budget/cooldown engage.
- **观测**: ⚠️ `node --check bots/_supervisor/skills/achieve.js`、`branchMine.js`、`prepNether.js` passed. Inbox hotloads C192/C192b/C192c sent. Live after C192 showed `mine probe cooldown for iron_ore: yield 4s`, proving the busy-loop cooldown loaded. The next branchMine attempts descended from surface `y=89` to `y=83`, then to `y=68`, with successful `branchMine.step.end ok=true`, stone/dirt dig events, and coal ore mining; live stayed healthy (`hp=20 food=15`, no hostiles). `achieve.probe.yield ... cooldownMs=45000` and `achieve.probe.cooldown_yield leftMs≈32s` appeared, so the probe budget now cools down instead of spamming. Partial: before C192c, prepNether still tried iron-pickaxe crafts during cooldown; the next cooldown window expired into active descent before proving `prepNether: iron probe cooldown ... yield`.
- **回滚**: Remove `probeCooldownLeft()` / `blockedUntil` handling in `achieve.js`, remove `localDropStep()` plus bridge retry/no-progress return from `branchMine.js`, and remove `ironProbeCoolingDown()` gates from `prepNether.js`.

## C191. repeated local death-zone mining aborts trigger surface recovery and pause iron-dependent kit retries（③层 achieve/prepNether 热加载）
- **触发**: After C190 reload, fresh live was healthy (`hp=20 food=20`) but progress repeated `★DEATH-ZONE ... 背质心撤24格再采` → `collect iron_ore (xray)` → `★雷区禁挖 — 跳过digDown并让出身体 (repeat=13..17)` → `NO KNOWN WAY to obtain iron_ingot/shield/iron_pickaxe`. mine_motion showed every radial expel goal around `30,78,16` was refused as partial `blind-destructive-navigation`, so the craft chain immediately retried instead of allowing recovery movement.
- **机理**: `achieve` correctly avoided blind digDown inside the local death cluster, but after repeat>2 it only returned `false`. `prepNether` interpreted the missing iron as a normal dependency failure and retried iron-dependent goals every few seconds. The local death-zone detector was stricter than overseer `dzone`, so mission's regional expel did not take over.
- **改动**: `achieve` now records `bot._achieveDZMiningBlockedUntil` / details on repeated local death-zone mining aborts and, once per short window, calls bounded `surfaceUp` before returning. `prepNether` checks that cooldown before top-level and mid-goal iron-dependent goals (`shield`, `iron_pickaxe`, diamond tier, flint/steel, obsidian) and yields instead of re-entering the same iron craft chain while no `iron_ingot/raw_iron` is available.
- **预测**: Repeat logs should switch from tight `NO KNOWN WAY to obtain iron_ingot` churn to either `★雷区禁挖 repeat=N — bounded surfaceUp...` followed by movement, or `prepNether: death-zone mining cooldown... yield Ns`. Once moved out of the local death cluster or after cooldown, iron collection may resume. It should not suppress goals if iron/raw iron is already held.
- **观测**: ⚠️ `node --check bots/_supervisor/skills/achieve.js`、`prepNether.js` 通过；inbox `cancel_skill` hotload ok. Before cancellation returned, new `achieve` wrote `★雷区禁挖 repeat=34 — bounded surfaceUp...` and moved from the local death cluster to `pos=18,85,24`; fresh advisory then reported `deathsNear16=0`. After sticky `missionNether` re-armed, new `prepNether` wrote `death-zone mining cooldown after iron_ore repeat=34; yield 30s...` countdown instead of immediate `NO KNOWN WAY` iron churn. At cooldown expiry it did not resume tight churn; night policy took over, wrote `spawn-proofed with 4 torches`, `★NIGHT ... hole up`, and `dug-in bunker SEALED y=87` with live `hp=20 food=20 hostiles=0`. Partial because next daylight still needs to verify clean iron-route resumption outside the local cluster.
- **回滚**: Remove `_achieveDZMiningBlocked*` writes/surfaceUp call in `achieve.js` and remove `deathZoneMiningBlocked()` gates in `prepNether.js`.

## C190. creeper backoff rejects routes into another visible creeper corridor（①层 modes.js 待安全重启）
- **触发**: 06:04Z live death: bot `hp=10 food=0` held at `-1,90,18` while events spammed `Creeper 10m — backing off!`; combat/radar then showed a second creeper entering from `[-23,97,26]` and closing to `[-8,96,18]`. At 06:04:20 core `mode:self_preservation` sprinted from `-1,90,18` toward negative X, passing the newcomer (`d=4.8`), then stalled at `-28,92,16` and died to creeper at `d=2.8`.
- **机理**: raw creeper backoff chooses one nearest creeper target and uses `safeFleeTarget()` / away-vector plus ledge checks. The candidate direction is not rejected for moving into another visible creeper's approach corridor, so fleeing from creeper A can route straight through creeper B as it enters radar, especially in famine/no-gear state where stopping to fight is impossible.
- **改动**: `modes.js` creeper backoff now samples each candidate run direction against all visible creepers within 24b. It rejects directions that move toward a non-target creeper within 18b or project the run corridor within 7.5b, and it also rejects non-away movement when the target creeper is point-blank. If all physical run directions are cliff/corridor-gated, it logs `creeper backoff gated ... risk=...` and falls back to emergency bunker/hold instead of sprinting through the hazard.
- **预测**: In a repeat two-creeper scene, act_trace should no longer show a long sprint from one creeper directly into another; progress should either show a safe lateral/away sprint or `creeper backoff gated ... risk=creeper@...` followed by bunker/hold. Single-creeper clear terrain should retain the fast raw backoff.
- **观测**: 🟡 `node --check src/agent/modes.js` 通过。06:08Z fresh gate was favorable (`hp=20 food=20`, day `tod=6633`, hostiles/actionable=0, directive=leave_zone only), so performed controlled agent-side reload: stopped old agent/mindserver port owners `32580/33680`, left Minecraft Java/LAN `55916` PID `9140` untouched, restarted agent `48909` PID `26512` and mindserver `8765` PID `34832`, restarted watchdog (`watchdog started pid 27608`). `fresh_status` returned `classification=live`, sticky `missionNether` re-armed, latest bot `hp=20 food=20`. Awaiting repeat creeper-corridor scene for behavioral validation.
- **回滚**: Remove `creeperCorridorRisk()` and restore candidate selection to only `!hazard && drop<=maxDrop`; restore the old `creeper backoff cliff-gated` log text.

## C189. daylight famine-hostile shelter uses fresh advisory actionable, so nonactionable mobs do not consume the food-search window（③层 prepNether 热加载）
- **触发**: C188/C187 verified the climb: fresh moved from `y=83` to `y=93/94`, mine_motion showed hand-dug stone and successful placements, and advisory later reported `actionableHostiles=0` with creeper layered below and zombie far. But prepNether spent the daylight window in `★DAY famine-hostile shelter` / `dug-in bunker SEALED` / static kit checks, then reached dusk still `food=0 hp=10`.
- **机理**: `shouldDayFamineHostileShelter()` still used local `noRegenActionableThreats(16)`. At high-y surface edge this can treat far/layered or path-separated mobs as actionable enough to shelter, while fresh advisory has already classified them as nonactionable. Because `holeUpAtNight()` runs before `daylightFamineForageWindow()` / `keepFed()`, that raw local mismatch burns the only safe daytime food-search window.
- **改动**: `shouldDayFamineHostileShelter()` now prefers fresh advisory(<45s) `actionableHostiles` and falls back to local threat only when advisory is stale/unavailable. This mirrors C184 table-recovery threat semantics but only for daytime famine shelter gating.
- **预测**: Next daylight `food=0 hp>=8` window with fresh advisory `actionableHostiles=0` should not enter `★DAY famine-hostile shelter`; prepNether should reach `FAMINE daylight forage window` / `keepFed` or a more specific no-food signal. If advisory reports a true actionable/close hostile, shelter still wins.
- **观测**: 🟡 `node --check bots/_supervisor/skills/prepNether.js` 通过；current live has reached dusk, so verification likely waits until next dawn unless food appears sooner.
- **回滚**: Restore `shouldDayFamineHostileShelter()` to use only local `noRegenActionableThreats(threatRadius).actionable`.

## C188. famine table-recovery no-pick cooldown override uses geometry, not stale mobility state（③层 prepNether 热加载）
- **触发**: C187 热加载后 fresh 仍 `classification=live hp=10 food=0 pos=6,83,29 mob=?`，progress 继续反复 `TABLE gate for shield ... night=false actionable12=1 threatSrc=advisory`，没有新的 `TABLE recovery`/`surfaceUp`。mine_motion 仅有 05:44:47 的旧 `surfaceUp.no_pick_stone.blocked ... food=0 hp=10 plannedStoneLimit=200`，说明 C187 还没拿到重试机会。
- **机理**: 05:44 的 famine surfaceUp 尝试在进入前写入了无镐长 cooldown；C182 的 cooldown override 仍要求 `mob` 是 `ENTOMBED|POCKET`。当前 fresh vitals/mine_motion 的 mobility 已经退化为 `mob=?/null`，但方块现场仍是高 y covered stone pocket，因此旧 runtime cooldown 卡住了新 C187 planned breach。
- **改动**: `handleTableRecoveryBlocked()` 的 `verticalRecoveryPocket()` 改为复用 C186 的 `tableRecoveryVerticalPocket()` 几何判定，不再依赖 mobility state。famineVerticalEmergency 的 no-pick surfaceUp 预设 cooldown 从普通 10min 改为 30s；若 surfaceUp 没有净上升但仍处于 famine vertical emergency，则改写为 12s 短 cooldown，便于 C187 继续尝试 planned no-pick stone breach。
- **预测**: 当前 stale cooldown 应被 `TABLE recovery overrides no-pick surface cooldown` 清掉，随后写 `TABLE recovery for shield ... famine vertical emergency` 并触发 C187 的 `surfaceUp.no_pick_stone.planned_breach`。普通高食 table recovery 仍保留长 cooldown，避免裸手挖石循环。
- **观测**: 🟡 `node --check bots/_supervisor/skills/prepNether.js` 通过，待 inbox 热加载后观察。
- **回滚**: 恢复 `verticalRecoveryPocket()` 内联 mobility-state 判定，并把 famine no-pick cooldown 恢复为普通 600000ms。

## C187. famine surfaceUp 可用 planned no-pick stone 清顶，不再被正常血粮探测门槛挡住（③层 surfaceUp 热加载）
- **触发**: C186 后 fresh `classification=live`，dawn/day `hp=10 food=0 pos=6,83,29`。progress 从旧 `FAMINE gate` 变为 `TABLE gate for shield ... night=false actionable12=1 threatSrc=advisory`，说明高 y covered pocket 已被识别；同时 mine_motion 新写 `surfaceUp.no_pick_stone.blocked ... block=stone@5,85,28 food=0 hp=10 plannedStoneBreaches=0 plannedStoneLimit=200` 与 `manual_pillar.blocked_low_ceiling`。这正是 C186 预测的下一层 stone cap 阻塞。
- **机理**: `surfaceUp` 已在 famineEmergency 下把 `plannedStoneLimit` 放宽到 200，但 `canPlanNoPickStoneBreach()` 仍有 C180 正常探测门槛 `hp>=16 && food>=14`。因此 famine emergency 虽然允许多次 planned breach，真正判定时仍因 `food=0 hp=10` 直接拒绝，永远不会打开 `_plannedNoPickStoneUntil`，`guardedDig()` 也就不会拿到 12s 徒手 stone timeout。
- **改动**: `surfaceUp` 新增 `famineNoPickStoneBreachOk()`：仅在 `food<=2`、无可食物、`hp>=8`、fresh advisory(<45s) 显示 0 actionable 或单个 actionable 且 `actionableNearest/nearest>5.5` 时，放行 no-pick stone planned breach。普通非 famine 路径仍保持 `hp>=16 && food>=14`、最多 2 次、h<=3 的旧门槛。
- **预测**: 当前 `stone@5,85,28 food=0 hp=10 plannedStoneLimit=200` 应转为 `surfaceUp.no_pick_stone.planned_breach`，随后 `dig.begin/end ok=true` 或明确 dig timeout；不应继续只写 blocked。若 creeper 贴近到 <=5.5、advisory stale、hp<8、出现流体/危险块，仍应拒绝徒手石头清障。
- **观测**: 🟡 `node --check bots/_supervisor/skills/surfaceUp.js` 通过，待 inbox 热加载后观察。
- **回滚**: 删除 `famineNoPickStoneBreachOk()` 并恢复 `canPlanNoPickStoneBreach()` 对所有无镐 stone breach 统一要求 `hp>=16 && food>=14`。

## C186. famine vertical recovery recognizes high-y covered stone pockets after mobility state drops（③层 prepNether 热加载）
- **触发**: C185 等到 dawn 后，fresh `classification=live`、`hp=10 food=0 pos=6,83,29 tod=23433→633`，mission 正确写 `EVAC gated ... no 40b sprint → prepNether emergency recovery`。但 prepNether 每次进入后只写 `FAMINE static kit check` 与 `FAMINE gate — no edible food ... yield before kit goal shield`，没有进入预测中的 `TABLE recovery ... famine vertical emergency`。同一 fresh advisory 仍是单个 actionable creeper `d≈6.2`，core 只写 `creeper covered hunger hold`，没有继续烧饥饿。
- **机理**: `handleTableRecoveryBlocked()` 的顺序本来在 famine gate 之前，但 `tableRecoveryBlocked()` 先要求 `tableRecoveryUndergroundWorksite()`。当前 bot 已被 `surfaceUp` 推到 `y=83`，有稳定脚下和 `stone@5,85,28` 顶盖，但 mobility 状态不再可靠呈现 `POCKET/ENC`，所以高 y 竖井被误判为非 worksite，C185 的 `famineVerticalEmergency` 分支根本进不去。
- **改动**: `prepNether` 新增 `tableRecoveryVerticalPocket()`，用现场方块直接识别“脚/头可站、脚下稳定、头顶普通石质 cap、且有顶/封闭”的竖井口袋。`tableRecoveryBlocked()` 允许 `undergroundWorksite || verticalPocket` 继续判定；普通 safeDay 仍限地下 worksite，高 y verticalPocket 只给 C185 famine emergency 使用，并保留 daylight、无食物、food<=2、hp>=8、威胁不贴脸（0 actionable 或 1 actionable 且 nearest>5.5）的门槛。
- **预测**: 当前同类 dawn `food=0 hp>=8 covered stone pocket creeper>5.5` 不应再卡在 `FAMINE gate ... yield before kit goal shield`；应先写 `TABLE recovery for shield ... famine vertical emergency` 并进入 bounded `surfaceUp`。若再撞 `surfaceUp.no_pick_stone.blocked plannedStoneBreaches=2 plannedStoneLimit=2`，那就是下一层 no-pick stone cap 限额问题，单独按 live second occurrence 处理。
- **观测**: 🟡 `node --check bots/_supervisor/skills/prepNether.js` 通过，待 inbox 热加载后观察。
- **回滚**: 删除 `tableRecoveryVerticalPocket()`，恢复 `tableRecoveryBlocked()` 只接受 `tableRecoveryUndergroundWorksite()`。

## C185. 同层 creeper raw-backoff 卡墙把食物烧空：低食有顶 hold 与 famine EVAC→prepNether handoff（①层 modes.js 已重启；③层 mission/prepNether 热加载）
- **触发**: C184 后 bot 在 `y=83` 接近出洞，advisory 从 layered-only 转为 `actionableHostiles=1`、creeper `dy=0..2 d≈6-7`，core 合法进入 creeper backoff；但 `progress` 连续写 `[self_preservation] creeper backoff wedged: stuck=8 pos=5,83,28 cdist=6-7 rotate=...`，位置不变，food 从 14 快速掉到 0，hp 随后因饥饿从 20 掉到 10。mission 还在 food0 时每轮 `EVAC gated: famine-critical ... no 40b sprint` 后 `continue`，导致新版 prepNether emergency recovery 进不来。
- **机理**: raw creeper backoff 只在低血无食物时有 covered hold，漏掉 food<=8 但 hp 尚高的“马上会饿伤”阶段；一旦 backoff 在石井里 wedged，它会持续烧饥饿直到 food0。随后 mission 的 famine EVAC gate 虽然阻止 40b sprint，但变成顶层 spin，挡住 prepNether 的 table/surface recovery。prepNether 自己也只把 hp/food 足够的 table recovery 视为 safeDay，没给 food0/hp>=8/creeper非贴脸的白天垂直求生窗口。
- **改动**: `modes.js` 的 creeper covered hold 放宽为 `food<=8 && 无正常食物 && 有顶/封闭 && creeperDist>5.5`，日志改为 `creeper covered hunger hold... no calorie-burning backoff`；加载需 core 重启。`prepNether.tableRecoveryBlocked()` 增加 `famineVerticalEmergency`: 白天、无食物、food<=2、hp>=8、有顶/封闭、威胁不贴脸（0 actionable 或 1 actionable 且 nearest>5.5）时，也允许 bounded `surfaceUp`，日志写 `famine vertical emergency`。`missionNether` 的 famine EVAC gate 改为 `no 40b sprint → prepNether emergency recovery`，不再原地 continue。
- **预测**: 同类“有顶石井 + creeper 6-8m + food<=8 + 无食物”不应再继续 raw backoff 烧饥饿；应写 `creeper covered hunger hold`。若白天且 hp>=8，mission 应把 famine EVAC 交给 prepNether，prepNether 应进入 `TABLE recovery ... famine vertical emergency` 或给出明确的夜间/威胁 gate。若已入夜，covered hold 可保持 hp 不再继续掉，但需要等 dawn/安全窗再恢复找食物。
- **观测**: ⚠️ `node --check src/agent/modes.js`、`missionNether.js`、`prepNether.js` 通过。13:31Z 在 food2/hp20 急窗受控重启 core：新端口 `48909` PID `32580`、`8765` PID `33680`，LAN `55916` 仍 Java PID `9140`，watchdog PID `12504`；加载后 05:31Z 写 `[self_preservation] creeper covered hunger hold ... food=0 ... no calorie-burning backoff`，raw `Creeper ... backing off` 停止，hp 最终稳定在 10。05:32Z/05:34Z 通过 inbox 热加载 prep/mission；新版 mission 写 `EVAC gated ... no 40b sprint → prepNether emergency recovery` 并进入 prepNether。但此时已转夜 `tod≈13833`，prepNether 正确写 `★NIGHT ... bunker already covered`、`NO-REGEN static kit skip — actionable hostile within 8`，未出洞验证白天 `famine vertical emergency`。当前 live 保持 `hp=10 food=0` 有顶夜间 hold，等待 dawn 或新可行动食物信号。
- **回滚**: 恢复 creeper covered hold 只检查 `hp<=8 && food<18`；删除 prepNether `famineVerticalEmergency` safeDay 扩展；恢复 mission famine EVAC gate 为 wait+continue。

## C184. table-recovery 使用 fresh advisory actionable 统一判敌，core 白天也不再被隔层 creeper raw-backoff 抢走身体（③层 mission/prepNether 热加载；①层 modes.js 已安全重启）
- **触发**: C183 热加载后 05:20Z 又出现一次 `★EVAC: 1 hostiles <16b, unarmed` / `EVAC done ... moved=0.0`，同一 fresh advisory 写 `actionableHostiles=0 layeredHostiles=2`；白天后 prepNether 仍把隔层 creeper 写成 `TABLE gate ... actionable12=1`，core 也持续广播 `Creeper 7-8m — backing off!` / `Kiting creeper+swarm...`，把 C182 的 table recovery 竖井上探打断。
- **机理**: C183 的 `tableRecoveryHold()` 仍先用本地 `actionableHostilesNear()`；该函数把 `dy≈5` 的 creeper 归为 actionable，而 overseer/advisory 已按地形/高差判定为 nonactionable layered。supervisor 与 core 因此在同一现场分裂：advisory 说可以继续 table recovery，本地 raw creeper/backoff 说必须移动。
- **改动**: `missionNether` 新增 `freshAdvisoryThreat()` / `tableRecoveryThreat()`，仅在 table-recovery hold、EVAC gate、BREAKOUT gate 中用 fresh(<45s) advisory `actionableHostiles` 覆盖本地威胁数，并在日志写 `threatSrc=advisory`。`prepNether.tableRecoveryBlocked()` 同步使用同一 fresh advisory 语义，TABLE gate/recovery 日志补 `threatSrc`。`src/agent/modes.js` 把 `tableRecoveryNightHold()` 扩为全天 `tableRecoveryHold()`，并在 self-preservation creeper backoff、unstuck、ENTOMBED mobility 前置 gate；只有 table recovery fresh、封闭/POCKET/ENTOMBED、无 table/wood、hp/food 足够且 fresh advisory actionable=0 时抑制 raw backoff，真正贴脸/同层 actionable creeper 仍触发保命。
- **预测**: layered-only table recovery 现场不应再出现新的 mission `★EVAC ... moved=0.0`，prepNether 的 table gate 应写 `actionable12=0 threatSrc=advisory`，core 应写 `[self_preservation] creeper table-recovery hold...` / `[unstuck] table recovery hold...` 而不是持续 raw `Creeper ... backing off`。若 creeper 变成同层/可行动，advisory 应转 `actionableHostiles=1`，raw backoff 允许恢复。
- **观测**: ✅ `node --check bots/_supervisor/skills/missionNether.js`、`prepNether.js`、`src/agent/modes.js` 通过。05:24Z inbox `cancel_skill` 热加载 supervisor，05:24:56Z 新 mission 写 `★BREAKOUT gated ... actionable12=0 threatSrc=advisory`，05:25:01Z prepNether 写 `TABLE gate ... actionable12=0 threatSrc=advisory`，之后未见新的 `★EVAC`。05:27Z safe gate 满足（day、hp=20、food=17、fresh advisory actionable=0、LAN `55916` 仍 Java PID `9140`），受控重启 core：停 watchdog PID `33756` 与 agent node `30276/27816`，新端口 `48909` PID `28432`、`8765` PID `20204`，watchdog PID `23500`，`fresh_status` 恢复 live。05:28Z core 写 `[unstuck] table recovery hold ... day=true` 与 `[self_preservation] creeper table-recovery hold ... day=true`，随后 prepNether `TABLE recovery ... bounded surfaceUp` 把 bot 从 `y=79` 推到 `y=83`。05:28:47Z advisory 更新为 `actionableHostiles=1`、creeper `dy=1 d=6.2 reason=creeper-same-layer`，core 恢复 `Creeper 6m — backing off!`，这是预期的真威胁保命分支。
- **回滚**: 删除 mission/prepNether 的 `freshAdvisoryThreat/tableRecoveryThreat` 覆盖并恢复本地 `actionableHostilesNear/noRegenActionableThreats`；将 `modes.js` 的 `tableRecoveryHold()` 恢复夜间限定并删除 self-preservation creeper gate。

## C183. table-recovery 夜间/隔层怪 hold 不再触发 mission EVAC、bank path，core 待安全重启后抑制 ENTOMBED GoalInvert（③层 mission/prepNether 已加载；①层 modes.js 待重启）
- **触发**: C182 把 bot 竖井恢复到 `y=77` 后，fresh `classification=live hp=20 food=19 mob=ENTOMBED/ENC`，advisory 明确 `actionableHostiles=0 layeredHostiles=2`，但 mission 仍因 raw `1 hostiles <16b, unarmed` 在夜间反复 `★EVAC ... sprinting 40b`，结果 `EVAC done ... moved=0.0`；同时 `mine_motion` 连续写 `GoalInvert`/`GoalNear` noPath 和 `step_edge.skip target-foot-blocked`，目标格 `foot/head=stone`，实际是封死侧壁，不是可走台阶。prepNether 也会在同一封闭 table gate 前先跑 `bankRecover`，碰到 ghost bank/无路径。
- **机理**: C173/C176/C179 认识 table recovery hold，但 mission 的本地 EVAC 仍使用 raw hostile count，没复用 actionable/layered 语义；prepNether 的 bankRecover 在 `handleTableRecoveryBlocked('bucket')` 之前执行，会抢身体做不可达 bank path；core `unstuck` 与 `mobility ENTOMBED` 还不知道 fresh table-recovery night hold，会继续 GoalInvert/裸手 dig-out 尝试。隔层怪+夜间+封闭竖井因此被多层误当“必须移动”。
- **改动**: `missionNether` 在 `isNightNow() && tableRecoveryHold()` 时先停车、清控制、节流写 `table recovery night stand-down ... no EVAC/GoalInvert` 并 continue；EVAC 分支额外把 `tableRecoveryHold()` 当 gate，raw layered 威胁不再打破 wood/table recovery。`prepNether.bankRecover()` 在封闭 table recovery hold 中跳过 bank path。`src/agent/modes.js` 新增 `tableRecoveryNightHold()`，要求 progress fresh(<90s) 且含 `TABLE gate|recovery`、advisory fresh(<45s) 且 `actionableHostiles=0`（无 advisory 时才用本地 dy fallback）、夜间、封闭/ENTOMBED、无 table/planks/log；命中时 `unstuck` 抑制 GoalInvert/step-edge，`mobility ENTOMBED` 抑制 dig-out，等待 dawn/supervisor surface recovery。
- **预测**: 热加载后同类夜间 table recovery + layered-only 威胁不应再写新的 `★EVAC ... moved=0.0` 或 prepNether bank path；应看到 `table recovery night stand-down`。下一次安全 core 重启加载后，同场景还应减少/停止 `Entombed — digging out!`、`GoalInvert` 与 step-edge target-foot-blocked 噪音，直到白天 C182 继续 bounded `surfaceUp`。
- **观测**: 🟡 `node --check bots/_supervisor/skills/missionNether.js`、`prepNether.js`、`src/agent/modes.js` 均通过。05:17Z 通过 inbox `{"type":"cancel_skill","reason":"reload C183 table recovery night standdown and bank path gate"}` 热加载 supervisor，events 写 `sent_control` / `cancel_result ok=true` / `skill_result cancelled` / sticky `missionNether`。新版启动后 progress 写 `[mission] table recovery night stand-down: actionable12=0 raw16=1; no EVAC/GoalInvert while prepNether owns wood/table recovery`，截至随后 12s fresh 窗口未再出现新的 `★EVAC`；但 core 仍继续 `Entombed — digging out!` / `GoalInvert` / step-edge skip，因为 `modes.js` 改动待安全 core 重启加载。当前夜间不重启 core。
- **回滚**: 删除 mission 的 table recovery night stand-down 与 EVAC gate；删除 prepNether bankRecover 的 table recovery skip；删除 modes.js 的 `tableRecoveryNightHold()` 及 `unstuck`/`ENTOMBED` 两处 gate。

## C182. table-recovery 无镐竖井取得高度后缩短 cooldown，并覆盖旧长冷却继续上探（③层 prepNether.js，部分有效）
- **触发**: C180 把缺工作台恢复从 `y=67` 推到 `y=69` 后，`prepNether` 已经写入 10min `_prepTableRecoverySurfaceTryUntil`，但 fresh 状态仍是 `ENTOMBED/ENC` 且无 `crafting_table/planks/logs`；core/pathfinder 随后反复 `step-edge structural skip ... target-foot-blocked target=4,69,28 foot=stone head=stone`，说明它在把封死石壁误当侧向台阶尝试，而不是继续垂直恢复。
- **机理**: C173/C180 的 no-pick table recovery 会先长冷却来避免裸手挖石烧循环，但它没有区分“失败且无进展”和“刚清了顶、垫脚获得净 y 进展”。一旦上一次 bounded `surfaceUp` 已经抬高但仍未出洞，旧 10min 冷却会把继续上探压住，让 core mobility 在封闭竖井里接管并重复不可执行侧步。
- **改动**: `handleTableRecoveryBlocked()` 在 no-pick `surfaceUp` 前记录 `beforeY`，若返回后 `gainedY>=0.75` 且 table recovery 仍阻塞，则把下一次 surface recovery 冷却缩到 12s，并写 `TABLE recovery surfaceUp gained ... short cooldown`。另加 `verticalRecoveryPocket()` 覆盖旧 runtime 长冷却：白天、安全、无镐、脚/头可站、脚下稳定、上方仍有石质 cap、mob 为 `ENTOMBED/POCKET` 时，清掉旧 `_prepTableRecoverySurfaceTryUntil`，写 `TABLE recovery overrides no-pick surface cooldown ... continue bounded surfaceUp`，让 supervisor 继续垂直解困。
- **预测**: 同类 no-pick table recovery 只要每轮有净上升，就不应被旧 10min 冷却卡住；应每约 12s 继续进入 bounded `surfaceUp`，并看到 `surfaceUp.no_pick_stone.planned_breach` / `dig.end ok=true` / `place_underfoot.end ok=true` 串联。若没有净上升、不是安全白天、脚下不稳、上方非石质普通块、或不在封闭竖井，仍保留长冷却。
- **观测**: ⚠️ `node --check bots/_supervisor/skills/prepNether.js` 两次通过；先后用 inbox `cancel_skill` 热加载 short-cooldown 与 stale-cooldown override，events 均写 `sent_control` / `cancel_result ok=true` / sticky 重启 `missionNether`。05:10:52Z fresh progress 命中 `TABLE recovery overrides no-pick surface cooldown ... y=69.0`，随后 `surfaceUp.no_pick_stone.planned_breach` 清 `stone@5,71,28`、`stone@5,72,28` 并 `dig.end ok=true`，`place_underfoot.end ok=true`；05:11:11Z 写 `gained 1.0y`，05:11:46Z 写 `gained 3.0y`，05:12:18Z/05:12:38Z 又分别写 `gained 2.0y`。最新 live `classification=live`，`pos≈6,75-77,29 hp=20 food=19`，说明 C182 已恢复净上升；但 bot 仍 `ENTOMBED/ENC` 且上方 `stone@5,79,28`，继续观察是否最终出洞/拿木，或是否需要更好的 no-pick 竖井终止/换向策略。
- **回滚**: 删除 `beforeY/gainedY` 短冷却、`verticalRecoveryPocket()` 与 `_prepTableRecoveryVerticalContinueUntil` override，恢复 no-pick table recovery 失败后固定长冷却。

## C181. core mobility 急救镐先验检查可触达工作台，并隔离 supervisor planned no-pick 窗口（①层 modes.js，已验证）
- **触发**: C180 验证后 bot 从 `5,65,28` 抬到 `5,67,28`，fresh `classification=live hp=20 food=20 mob=ENTOMBED/ENC`，背包有 `cobblestone=145 stick=4 iron_ingot=3` 但仍无 `crafting_table/planks/logs`。core mobility 每 2s 连续写 `[mobility] emergency pick craft (ENTOMBED): stone_pickaxe`，同时 `prepNether` 已明确 `TABLE gate/recovery ... no local wood/table/logs`。`mine_motion` 还显示 C180 的 `_plannedNoPickStoneUntil` 窗口泄漏到 core mobility，ENTOMBED 在 `skill=missionNether` 下裸手尝试挖侧墙 `stone@5,68,29`，5s 后 `Digging aborted`。
- **机理**: `ensureEmergencyPick()` 只看 `cobblestone>=3 && stick>=2` 就选择 `stone_pickaxe`，没有先确认 3x3 配方需要的可触达工作台；`craftRecipeLocal()` 在缺 table 时返回 `false`，但调用方没有检查返回值，也没有失败冷却，于是每 tick 重试并刷日志。另一个耦合点是 core mobility 复用全局 `_plannedNoPickStoneUntil`，把 supervisor `surfaceUp` 的计划性无镐清顶窗口误当成 ENTOMBED 自己的无镐挖石许可。
- **改动**: `modes.js` 的 mobility `plannedNoPickStone()` 改读专用 `_mobilityPlannedNoPickStoneUntil`，不再消费 supervisor 窗口。`ensureEmergencyPick()` 新增 `reachableCraftingTable()` 与 `hasTableMaterials()`：无现成/近处工作台时，若没有 4 planks 可本地制台，则节流写 `emergency pick blocked ... needs reachable crafting_table` 并 10s 冷却；若能制台则先本地 craft/place table，再尝试 pick。pick craft 返回 `false` 也进入 blocked 冷却，避免无效重试。
- **预测**: 同类 `ENTOMBED` 且 `cobble+stick` 足够但无 table/planks/logs 时，不应再每 2s 写 `emergency pick craft`; 应最多约 10s 一次写 blocked，并继续把 table recovery 交给 prepNether/surfaceUp。C180 的 planned no-pick stone 只应被 supervisor 清障消费，不应再触发 core ENTOMBED 裸手侧挖。
- **观测**: ✅ `node --check src/agent/modes.js` 通过。05:06Z 在 `hp=20 food=20 tod≈day actionableHostiles=0` 安全窗受控重启 core：停止旧 watchdog PID `25300` 与旧 agent `21544/32620`，未触碰 Minecraft Java `55916` PID `9140`；新版端口为 `8765` PID `27816`、`48909` PID `30276`，watchdog PID `33756`，`fresh_status` 恢复 `classification=live`。加载后 05:06:27Z 首次写 `[mobility] emergency pick blocked (ENTOMBED): stone_pickaxe needs reachable crafting_table cobble=145 stick=4 table=0`；随后的 20s 窗口没有新的 `emergency pick craft` 刷屏，05:06:49Z 仅节流再写一次 blocked。三端口 open，`minecraftLan=open` 仍为 Java PID `9140`。
- **回滚**: 恢复 mobility `plannedNoPickStone()` 读取 `_plannedNoPickStoneUntil`；删除 `reachableCraftingTable/hasTableMaterials/emergencyPickBlocked` 和 `craftRecipeLocal()` 返回 false 的冷却处理。

## C180. surfaceUp table-recovery 允许极窄无镐石顶清障，避免缺工作台状态被 2 格低顶永久锁住（③层 surfaceUp.js，已验证）
- **触发**: C177/C178 加载后，live `classification=live`，`hp=20 food=20 risk=0 actionableHostiles=0`，table recovery 白天窗口仍在同一格 `pos=6,65,29 / foot=5,65,28` 反复进入 `surfaceUp.no_pick_stone.blocked ... block=stone@5,67,28 hasPick=false` 与 `manual_pillar.blocked_low_ceiling`。背包有 `iron_ingot=3 stick=4 cobblestone=147`，但无 planks/logs/crafting_table，无法先做镐；不出洞又拿不到木头/台。
- **机理**: `surfaceUp` 已有 `plannedStoneLimit` 与 `_plannedNoPickStoneUntil` 这条“计划性无镐石头清障”通道，但 fallback 的 no-pick stone 分支在 C177 后只记录 blocked 并直接 break；`guardedDig()` 对所有 dig 统一 5s 超时，也不足以手挖普通 stone。于是 table recovery 的唯一出口被低顶普通石块封死。
- **改动**: 新增 `NO_PICK_BREACHABLE` 白名单，只允许普通 `stone/cobblestone/andesite/diorite/granite/tuff/deepslate/cobbled_deepslate`；在 fallback 中仅当 `hp>=16 food>=14`、脚下稳定、无当前格危险块、次数未超过 `plannedStoneLimit`，且 h<=3（非 famine）时，写 `surfaceUp.no_pick_stone.planned_breach` 并打开 `_plannedNoPickStoneUntil=15s`。`guardedDig()` 在 planned no-pick stone 窗口把单次 dig timeout 从 5s 放宽到 12s；普通挖掘不变。
- **预测**: 下次同类 `stone@5,67,28 hasPick=false` table recovery 窗口，应先出现 `surfaceUp.no_pick_stone.planned_breach`，随后 `dig.end ok=true` 或明确 `dig.retry/blocked`；不应直接永久 `no_pick_stone.blocked`。若低血低粮、脚下不稳、危险/流体、矿石/黑曜石/功能块、或超过 2 次普通清障，仍保持 blocked。
- **观测**: ✅ `node --check bots/_supervisor/skills/surfaceUp.js` 通过。04:52Z 通过 inbox `{"type":"cancel_skill","reason":"reload C180 surfaceUp no-pick stone breach"}` 热加载，events 写 `sent_control` / `cancel_result ok=true` / `skill_result cancelled`，sticky 于 04:52:26Z 重启 `missionNether`；`fresh_status` 仍 `classification=live`，三端口 open，`hp=20 food=20 skill=missionNether`。05:02Z 入 daylight safe window 后，fresh progress 写 `TABLE recovery for bucket ... bounded surfaceUp`；`mine_motion` 随后写 `surfaceUp.no_pick_stone.planned_breach ... block=stone@5,67,28 plannedStoneBreaches=1` → `dig.end ok=true ms=7504`，接着第二次 planned breach 清掉 `stone@5,68,28` → `dig.end ok=true ms=7503`，再因 `plannedStoneLimit=2` 对 `stone@5,69,28` 保持 blocked，并成功 `place_underfoot.end ok=true` 把 bot 抬到 `y=66.177`。验证 C180 命中且限额生效；继续观察后续是否顺利离开竖井/找木。
- **回滚**: 删除 `NO_PICK_BREACHABLE`、`canPlanNoPickStoneBreach()`、planned breach 分支，以及 `guardedDig()` planned no-pick stone 的 12s timeout，恢复无镐石头直接 blocked。

## C179. core pin-breaker 的 table recovery 豁免改用 fresh progress/actionable 证据，避免 raw 隔层怪或技能瞬态漏判（①层 modes.js，已验证）
- **触发**: C175 加载后曾在 04:12Z 与 04:28Z 写出 `[reflex_watchdog] pinned table recovery hold exempt ... no forced interrupt`，但 04:27Z 仍出现一次 `Pinned 15min+ — kicking the stack (forced interrupt)`，紧接着 sticky 重发 `missionNether`；同一窗口 progress 前后持续写 `prepNether: TABLE gate for bucket ... actionable12=0`，说明 C173 的 table recovery hold 是真实现场，不是 stale tail。
- **机理**: C175 的 core 判据同时依赖 `_currentSkill==='missionNether'` 与 raw `closestHostile>=16`。在 table gate 这种长时间静止状态里，pin-breaker tick 可能刚好撞上 supervisor cancel/sticky 重发边界，或把隔层/不可行动怪当 raw 近怪；supervisor 侧已经给出 `actionable12=0`，但 core 没利用这个更贴近风险语义的证据。
- **改动**: `reflex_watchdog` 读取 `progress.txt` 时同时记录 mtime，只有 progress fresh(<90s) 且尾部含 `TABLE gate|recovery` 才考虑 table hold；若 progress 明确 `actionable12=0` 或 `TABLE recovery ... daylight safe window`，则允许豁免，不再被 raw `closestHostile<16` 单独打断。`_currentSkill` 瞬态不为 `missionNether` 时，只要 fresh progress 仍显示 mission/prepNether/table gate，也归为 mission 拥有的恢复等待。
- **预测**: 下次 core 安全重启后，同类 `TABLE gate ... actionable12=0` 窗口不应再出现 `Pinned 15min+` / `skill_result missionNether cancelled`；应每分钟最多写一次 `pinned table recovery hold exempt`。若 progress stale、没有 table gate/recovery、近身 actionable 威胁出现、或低血低粮/流体/下落，pin-breaker 仍可强拆真卡死。
- **观测**: ✅ `node --check src/agent/modes.js` 通过。04:43Z 又出现一次 `Pinned 15min+ — kicking the stack`，随后 fresh `tod=793 hp=20 food=20 risk=0 actionableHostiles=0`，只有 `layered-creeper`，满足重启安全门。受控 core 重启加载：先一次脚本因 PowerShell `$PID` 保留变量未停旧进程，仅启动了短命/占端口失败的新 main 并由 watchdog singleton 清掉重复 watchdog；随后修正变量名，停止 watchdog PID `15572`，停止旧 agent main/child PID `4800/30256`，确认 `48909/8765` 释放且 MC LAN `55916` 仍为 java PID `9140`，启动新版 main PID `21544` / child `32620`，启动 watchdog PID `25300`。`fresh_status` 恢复 `classification=live`，sticky 于 04:46Z 重投 `missionNether`。04:51:11Z 在 fresh `TABLE gate ... actionable12=0` 窗口写 `[reflex_watchdog] pinned table recovery hold exempt: food=20 hp=20 mob=FREE closestHostile=21.1 — no forced interrupt`，同窗口未出现新的 `Pinned 15min+` / `skill_result missionNether cancelled`，验证 C179 命中。
- **回滚**: 恢复 `tableRecoveryHold` 只在 `_currentSkill==='missionNether' && closestHostile>=16` 下按 progress tail 正则判定，删除 progress freshness/actionable/missionOwnsProgress 逻辑。

## C178. torch_placing 不再在低顶身体格放地火把，避免再次污染 surfaceUp 垫脚目标（①层 world.js，已加载待验证）
- **触发**: C177 热加载后，04:22Z daylight table recovery 现场验证 `surfaceUp.manual_pillar.blocked_low_ceiling ... above=stone@5,67,28 hasPick=false`，旧 `place_underfoot` 循环没有复发；但 `surfaceUp` 退出后 core `torch_placing` 立即在同一身体格 `5,65,28` 放置 `torch`，motion 写 `place_skill.target ... intersectsBody=true` 与 `place.end foot=torch`。这会把下一次恢复窗口重新变成脚下火把目标，浪费 torch 并污染垫脚前置状态。
- **机理**: `world.shouldPlaceTorch()` 只检查当前位置方块是 `air` 且 6 格内无火把；`modes.js` 的 `torch_placing` 随后直接调用 `skills.placeBlock(bot,'torch', pos.x,pos.y,pos.z,'bottom')`。在两格低顶矿洞里，地火把放在 bot 足部格是合法 Minecraft 状态，但对 `surfaceUp` 的 underfoot/pillar 动作是坏目标。
- **改动**: `shouldPlaceTorch()` 在无近火把时额外检查身体格：若头部格可通过但头顶第二格是实体方块，说明是低顶身体预算/矿洞格，直接返回 false，不让 idle torch_placing 在脚下放地火把。开阔矿道/正常高空间仍可按旧逻辑放 torch。
- **预测**: 下次 core 安全重启后，同类 `pos=5,65,28 above=stone@5,67,28` 状态不应再出现 `place_skill.target blockType=torch target=5,65,28 intersectsBody=true`；若低顶 table recovery 仍需要下一次 `surfaceUp`，不会先被 core 火把污染。若头顶有正常空间或附近无火把的开阔矿道，torch_placing 仍可照明。
- **观测**: 🟡 `node --check src/agent/library/world.js` 通过。04:46Z 同 C179 受控 core 重启加载后，`surfaceUp` 在同一低顶格先看到历史遗留 `torch@5,65,28`，写 `clear_foot_target.begin` → `dig.end ok=true` → `clear_foot_target.end ok=true after=air@5,65,28`，随后 `blocked_low_ceiling above=stone@5,67,28 hasPick=false`；截至本次回写未再出现新的 `place_skill.target blockType=torch target=5,65,28 intersectsBody=true`，初步符合预测，继续观察下一次 idle torch_placing 周期。
- **回滚**: 删除 `shouldPlaceTorch()` 中的 `head/above` 低顶检查，恢复只按当前位置 `air` 与附近火把判定。

## C177. surfaceUp 手动垫脚先识别低顶/脚下火把，不再在必败 underfoot place 上烧循环（③层 surfaceUp.js，已加载待验证）
- **触发**: live `classification=live`，table recovery 白天窗口中 `surfaceUp` 在 `pos=5.5,65,28.5 hp=20 food=20` 多轮写 `place_underfoot.end ok=false reason=exhausted-retries`；04:06Z 又出现 core `torch_placing` 先把 `torch@5,65,28` 放到脚下，随后 `surfaceUp` 连续三次 `place_underfoot.end reason=target-not-empty targetBlock=torch`，并且 `surfaceUp.no_pick_stone.blocked stone@5,67,28` 说明两格高石顶使 jump-place 本身不可执行。
- **机理**: hotloadable `surfaceUp.manualPillar()` 直接调用 core `placeBlockUnderFeet()`。core 只把 air/草/雪等视作可替换，不认脚下 torch；同时即使 `y+2` 是无镐 stone ceiling，manual pillar 仍尝试跳到 `target.y+0.92`，在两格低顶里物理上跳不够，只会写 delay/exhausted-retries。
- **改动**: `surfaceUp` 新增 `clearReplaceableFootTarget()` 与 `underfootPillarHasHeadroom()`。manual pillar 前若脚下是 torch/redstone/soul torch 这类空碰撞可清小物件，先记录 `surfaceUp.manual_pillar.clear_foot_target.begin/end` 并挖掉；若自己头/头顶第二格是实体方块，则记录 `surfaceUp.manual_pillar.blocked_low_head|blocked_low_ceiling` 并跳过 underfoot place，把控制交回 scaffold/step-edge/失败路径。
- **预测**: 下一次同类 `surfaceUp` 在 `stone@5,67,28` 低顶无镐状态下，不应再刷 `place_underfoot ... exhausted-retries`；应先写 `surfaceUp.manual_pillar.blocked_low_ceiling ... above=stone@5,67,28`。若脚下仍有 torch，应看到 `clear_foot_target.begin/end ok=true` 后才允许 underfoot place；不能清掉时不再进入 core `target-not-empty` 循环。
- **观测**: ✅ `node --check bots/_supervisor/skills/surfaceUp.js` 通过。04:16Z 通过 inbox `{"type":"cancel_skill","reason":"reload C177 surfaceUp underfoot low-ceiling gate"}` 热加载，events 写 `sent_control ... cancel_skill` 与 `cancel_result ok=true`，progress 写 `supervisor cancel received` 后 sticky 于 04:16:54Z 重启 `missionNether`；`fresh_status` 仍 `classification=live`、三端口 open。04:22Z 下一次 daylight table recovery 命中 `surfaceUp.manual_pillar.blocked_low_ceiling ... above=stone@5,67,28 hasPick=false` 两次，并且未再出现新的 `place_underfoot.begin/end` 循环；随后暴露 C178 core `torch_placing` 在脚下补 torch 的独立问题。
- **回滚**: 删除 `FOOT_REPLACEABLE`、`clearReplaceableFootTarget()`、`underfootPillarHasHeadroom()` 以及 `manualPillar()` 的两个前置检查，恢复直接 `skills.placeBlockUnderFeet()`。

## C176. mission BREAKOUT 识别 table recovery hold，不再把缺工作台等待当作 4min 卡死（③层 missionNether.js，已加载待验证）
- **触发**: live `classification=live`，`pos=6,65,29 hp=20 food=20 skill=missionNether mob=FREE/ENC`，夜间 `tod≈20573` 且 C173 正在 `TABLE gate for bucket ... no local wood/table/logs ... no repeat 3x3 craft loop`。但 mission 层仍在 03:58 写 `★BREAKOUT: pinned 4min — tunneling toward anchor ... material-gated`，随后才被 `★BREAKOUT gated: no-pick stone stone @5,66,29` 拦住。
- **机理**: C173/C174/C175 已覆盖 prepNether table gate、外部 watchdog 与 core pin-breaker；但 hotloadable `missionNether` 自己的 4min last-resort breakout 只看位置停滞，不知道 table recovery 是合法静止。当前无镐石顶使它暂未挖动，但下一次若材料/方向不同，可能越过 prepNether 的安全恢复节奏。
- **改动**: `missionNether` 新增 `tableRecoveryHold()`：`hp>=14 && food>=14`、12 格内无 actionable 威胁、无本地 `crafting_table`/planks/logs、处于地下/封闭 worksite，且近期 prep gate/achieve gate/progress tail 有 `TABLE gate|recovery`。BREAKOUT 触发前先检查该 hold，命中时停止 pathfinder/清控制、等待 5s、重置 stagnation，不再 tunnel。
- **预测**: 当前 table gate 夜间窗口内，下次 4min stagnation 不应出现 `★BREAKOUT: pinned 4min — tunneling...`；应出现 `★BREAKOUT gated: table recovery hold ... prepNether owns wood/table recovery`，或直接继续 prepNether gate。若 table/wood 出现、血粮不足、近身威胁出现、或不再是 table recovery，BREAKOUT 仍保留原有兜底。
- **观测**: ✅ `node --check bots/_supervisor/skills/missionNether.js` 通过；首次 inbox 热加载误写成 `{"type":"control","control":"cancel_skill"}`，bridge 明确回 `Unknown message type: control` 且未生效；随后补发正确 `{"type":"cancel_skill"}`，events 写 `sent_control ... cancel_skill` 与 `cancel_result ok=true`，progress 写 `supervisor cancel received` 后 sticky 重新启动新版 `missionNether`。04:06Z 为加载 C175 受控重启 core 后，sticky 再次重发新版 `missionNether`；04:10:44Z live progress 写 `★BREAKOUT gated: table recovery hold hp=20 food=20 tableInv=0 tableNear=no planksMax=0 logs=0 actionable12=0; prepNether owns wood/table recovery`，同窗口未再出现 `★BREAKOUT: pinned 4min — tunneling...`。
- **回滚**: 删除 `maxHeldPlankStack/heldLogs/tableRecoveryUndergroundWorksite/progressTailHasTableGate/tableRecoveryHold` 与 BREAKOUT 前置 gate 分支，恢复 4min pinned 直接尝试 material-gated tunnel。

## C175. core pin-breaker 识别 table recovery hold，不再每分钟强拆 C173 的合法等待（src/agent/modes.js，待 core 重启生效）
- **触发**: live `classification=live`，`pos=6,65,29 hp=20 food=20 skill=missionNether mob=FREE/ENC`，C173 已把缺工作台/木头状态变成 `TABLE gate for bucket ... no repeat 3x3 craft loop`；外部 watchdog C174 也已停止误发 STUCK-ZONE。但 `events.log` 随后从 03:47Z 到 03:52Z 连续每分钟写 `Pinned 15min+ — kicking the stack (forced interrupt)`，每次 cancel `missionNether` 后由 sticky skill 重发。
- **机理**: 这是 `src/agent/modes.js` 的 always-on `reflex_watchdog` pin-breaker，不是 detached watchdog。它已有 night/low-food/no-regen/body-budget 合法静止豁免，但不知道 C173 新增的 table recovery gate；于是把“缺 table 等安全窗口/恢复窗口”的有意静止当成深层 await 卡死。
- **改动**: pin-breaker 新增极窄 `tableRecoveryHold` 豁免：仅当 `_currentSkill==='missionNether'`、`hp>=14`、`food>=14`、16 格内无敌对、非流体/非下落，且 `progress.txt` 尾部含 `TABLE gate for` 或 `TABLE recovery for` 时成立。命中时和其它合法 hold 一样重置 pin anchor，不发 forced interrupt，并节流写 `[reflex_watchdog] pinned table recovery hold exempt ... no forced interrupt`。
- **预测**: 下次安全重启 core 后，同类 table-gate 等待不应再每分钟出现 `Pinned 15min+` / `skill_result missionNether cancelled`；若 progress 尾部没有 TABLE gate/recovery、或低血低粮/近身敌对/流体/下落，pin-breaker 仍会按旧逻辑强拆真卡死。
- **观测**: ⚠️ `node --check src/agent/modes.js` 通过。按安全规则夜间未为 core 改动重启；入白天后 live `hp=20 food=20 hostiles=0 advisory=calm`，执行受控 core 重启：停止 watchdog PID `9092`，停止旧 agent `main.js`/child，确认 `48909/8765` 释放，启动新版 `main.js` PID `4800` / child `30256`，再启动 watchdog PID `27340`；`fresh_status` 恢复 `classification=live`，三端口 open，MC LAN `55916` 仍由 java PID `9140` 监听未触碰。04:11:30Z 仍出现一次 `Pinned 15min+ — kicking the stack`，随后 04:12:30Z live progress 写 `[reflex_watchdog] pinned table recovery hold exempt: food=20 hp=20 mob=FREE closestHostile=31.0 — no forced interrupt`；说明豁免已命中，但继续观察是否还会间歇漏判。
- **回滚**: 删除 `tableRecoveryHold` 计算、progress tail 读取与 `pinned table recovery hold exempt` 日志分支，并从 forced-interrupt 条件中移除该豁免。

## C174. watchdog STUCK-ZONE 识别 table recovery hold，不再把缺工作台冷却误当卡死（watchdog.ps1，待重启验证）
- **触发**: C173 生效后，live `hp=20 food=20 hostiles=0 mob=FREE/ENC` 正在 `TABLE gate for bucket ... no repeat 3x3 craft loop` 的有意等待/冷却；但 detached watchdog 仍在 03:43 发 `STUCK-ZONE within 10b for 10min`，打断 `missionNether`。若继续到 25min，旧逻辑会走 agent restart，破坏当前安全状态。
- **机理**: watchdog 的 STUCK-ZONE 豁免只覆盖 night/no-regen/sealed body-budget hold；table recovery 是新的合法静止状态，且 progress 最新行可能是 `fall-death prep`，只看 `$progLast` 容易漏掉真正 gate 行。
- **改动**: STUCK-ZONE 判据新增 `$tableRecoveryHold`：`skill=missionNether && hp>=14 && food>=14 && hostiles=0`，且 `progress.txt` 尾 12 行含 `TABLE gate for` 或 `TABLE recovery for`。命中时和其它合法 hold 一样重置 anchor/alert，不发 `cancel_skill`，也不走 25min restart。
- **预测**: 当前 table-gate 等待窗口内，watchdog heartbeat 继续更新，但不应再新增 `sent_control cancel_skill reason=STUCK-ZONE`；若 table gate 消失且 bot 仍在 10b 内无进展，STUCK-ZONE 仍可报警/重启。
- **观测**: ✅ `[scriptblock]::Create((Get-Content watchdog.ps1 -Raw))` 通过。精确停止旧 watchdog PID `21796` 并 hidden 启动新版 PID `9092`；`fresh_status` 仍 `classification=live`，`agentWs/mindserver/minecraftLan=open`。重启后跨过 10min anchor 窗口，watchdog heartbeat 继续写 `pos=6,65,29 hp=20 food=20 skill=missionNether mob=FREE/ENC`，`watchdog.log/events.log` 均无新的 `STUCK-ZONE` / `sent_control cancel_skill reason=STUCK-ZONE`。
- **回滚**: 删除 `$tableRecoveryHold` 与 progress tail 匹配，恢复仅 night/no-regen/sealed hold 豁免。

## C173. 缺工作台/木头的地下 3x3 合成不再 3 秒空转，转为 table recovery gate（③层 achieve.js + prepNether.js，已加载待验证）
- **触发**: live `classification=live`，`pos=0,61,35 hp=20 food=20 mob=FREE/ENC`，背包有 `iron_ingot=3 stick=4 cobblestone=149` 但 `crafting_table/planks/log=0`。`prepNether` 为 `iron_pickaxe` 每 3 秒重复：注册台 `10,70,22` noPath → `underground table gate` → 再试铁镐；夜间/地下正确拒绝 cave wood climb，但上层没有把“缺 3x3 工作台”变成调度状态。
- **机理**: `achieve.placeTable()` 只返回 false，不向 `prepNether` 暴露“本地无 table/wood 且地下不可开口”的阻塞语义；`prepNether` 因而把不可执行的 3x3 craft 当普通失败重试。另有小偏差：`canMakeLocalTable` 只看 `oak_planks`，没有复用同文件的 max single-species planks 判据。
- **改动**: `achieve` 在地下 table gate 时写运行时 `_prepTableRecoveryBlockedUntil/Reason`，并把本地制台判据改为任意单种 planks>=4 或 logs>0。`prepNether` 新增 table recovery gate：目标需要 crafting table、且无 table/近台/planks/log、且地下/封闭不可开口时，停止 pathfinder/清控制并短等，30s 节流日志；若白天、满血满饱、无 actionable 威胁，则给 bounded `surfaceUp(63)` 恢复窗口。fall-death 水桶前置也复用同一 gate，避免 bucket 在主目标前先空转；无镐 surface probe 失败成本更高，冷却 10min，有镐仍 120s。
- **预测**: 当前同类夜间地下缺 table 状态不应再刷 `registered table ...` / `need iron_pickaxe try 1/2/3` 空转；应出现 `prepNether: TABLE gate for bucket|iron_pickaxe ... no repeat 3x3 craft loop`。下个安全白天窗口才允许一次 `TABLE recovery ... bounded surfaceUp`，失败需写 timeout/incomplete 而不是继续 3 秒重试。
- **观测**: ⚠️ `node --check bots/_supervisor/skills/achieve.js` 与 `prepNether.js` 通过。03:38 首轮热加载后，主目标 `iron_pickaxe` 已写出 `TABLE gate ... no repeat 3x3 craft loop`；但更早的 fall-death bucket 前置仍先触发旧 table noPath。03:41 修正 bucket 前置与初始化顺序后再次热加载，live `classification=live`，`prepNether` 写出 `TABLE gate for bucket ... no repeat 3x3 craft loop`；`mine_motion` 在 03:40:04 后无新的 `GoalNear 10,70,22` path 事件。03:42 白天窗口触发 `TABLE recovery for bucket ... bounded surfaceUp`，bot 从 `0,61,35` 推进到 `6,65,29`；随后 `surfaceUp.no_pick_stone.blocked` 与 `place_underfoot ... exhausted-retries` 表明无镐石顶阻断继续上行，已追加无镐长冷却，避免重复烧垫块。
- **回滚**: 删除 `_prepTableRecoveryBlocked*` 写入、`tableRecoveryBlocked/handleTableRecoveryBlocked` 分支，并恢复 `canMakeLocalTable` 只看 `oak_planks` 的旧写法。

## C172. oak/apple runtime backoff 绑定 target，上一棵树的坏证据不再污染本地叶子（③层 prepNether.js，已加载待验证）
- **触发**: C171 热加载后，高树信号被收窄，但 live 随即写 `bounded oak/apple forage backoff 165s for oak_leaves@3 dy=0`。持久 backoff 文件还是上一轮 `target=oak_log@4 dy=4 reachable=0`，说明内存里的 `_prepOakApplePulseBackoffUntil` 是全局值，旧高树失败仍套到了新的本地叶子目标上。
- **机理**: runtime backoff 只有 until，没有 target。`persistedOakBackoff` 会按 target 过滤，但 `runtimeOakBackoff` 不过滤；于是 A 目标无动作写 300s 后，B 目标即使是近身叶子也被冷却。
- **改动**: 给 runtime backoff 增加 `_prepOakApplePulseBackoffTarget`。读取时若 target mismatch 则清零；critical 状态下遇到旧版无 target 的 runtime backoff 也清零。所有设置 oak/apple pulse backoff 的位置同步写 target；清 stale backoff 时同步清 target。
- **预测**: 新目标如 `oak_leaves@3 dy=0` 不应再因为旧 `oak_log@4 dy=4` 的 runtime until 写长 backoff；应要么进入 bounded/local feedUp，要么因 dusk/night/actionable 威胁明确 hold。后续 backoff 日志若出现，target 应来自同一目标的真实 sweep 证据。
- **观测**: 🟡 `node --check bots/_supervisor/skills/prepNether.js` 通过。当前进入 dusk/night critical hold，等待下个 daylight local oak/leaf 样本验证。
- **回滚**: 删除 `_prepOakApplePulseBackoffTarget` 读写与 mismatch/unscoped 清理逻辑，恢复全局 runtime until。

## C171. critical oak/apple 信号只接受本地可执行目标，高树不再触发 300s 空 pulse（③层 prepNether.js，已加载待验证）
- **触发**: 重启恢复后 live `food=2 hp=7`，`prepNether` 写 `bounded oak/apple forage — oak_log@4 dy=4`；`feedUp` 随后 `PlanD leaf sweep no reachable leaves ... nearest=oak_leaves@7 dy=3`、`targeted oak forage skip high tree dy=5 ... avoid stair-edge climb`，没有真实 leaf/log action，却写 `oak pulse backoff 300s`。这正是“高树/台阶边缘路线很糟糕”的一种：策略层把不可执行高树当成食物路线。
- **机理**: `oakAppleForageSignal()` 在 critical body budget 下仍使用宽松 `dist<=12 dy<=6`，而 `feedUp` 的身体预算逻辑正确拒绝高树 climb/chop。两层判据不一致，导致一次无动作 pulse 后长锁。
- **改动**: `oakAppleForageSignal()` 在 `food<=3 hp<=8` 时先调用 `localCriticalOakSignal()`；只有近身低原木或可达叶子通过才返回 ok。否则返回 `critical-local-only ...`，让 critical gate 保持短 hold/本地信号等待，不再接受高树目标，也不再为高树写 oak/apple backoff。
- **预测**: 同类 `oak_log@4 dy=4`/高树样本不应再出现 `bounded oak/apple forage` 和 `oak pulse backoff 300s`；若确有 `oak_log<=3.1 dy<=2.5` 或 `leaves<=5.25 dy<=4.25`，仍应走 `CRITICAL local oak forage` 或 bounded feedUp。夜晚/黄昏/可行动威胁仍 hold。
- **观测**: 🟡 `node --check bots/_supervisor/skills/prepNether.js` 通过。等待热加载后下一轮 critical keepFed 样本验证。
- **回滚**: 删除 `oakAppleForageSignal()` 中的 `food<=3 hp<=8` local-only 分支，恢复宽松 oak scan。

## C170. surfaceUp 自带 step-edge assist 也补 own-above roof notch，出洞上坡不等核心重启（③层 surfaceUp.js，已加载待验证）
- **触发**: 旧 motion 中反复出现 `pathOk=true moved=0`、`feedUp.oak_tunnel.step.edge_miss`、`step_edge.blocked reason=own-above-blocked`。C158 已在 core `src/agent/library/skills.js` 给通用 `stepEdgeAssist()` 加了 own-above roof notch，但该改动需要 agent core 重启；而 hot-reloadable `surfaceUp.js` 里还有一套局部 `stepEdgeAssist()`，遇到 `ownAbove` 阻塞仍直接 `return false`。
- **机理**: 低顶洞/矿道上坡时，bot 自己所处格的头顶第二格会撞住跳步体积；前方台阶本身可走，但碰撞余量不足，pathfinder/assist 表面成功或反复 quiet，实际位置不前进。
- **改动**: `surfaceUp.stepEdgeAssist()` 在 `ownHead` 可通、`ownAbove` 不通时，先记录 `surfaceUp.step_edge.own_above_notch.begin/end`；若该块非危险/功能方块/不可挖特殊方块，且石质块有镐，则用 `guardedDig(..., 'own-above-notch')` 清理自己上方第二格，再继续候选台阶判断和 press/runup。不可清理则记录 blocked 证据并返回。
- **预测**: 下次 `surfaceUp` quiet/stall 且 `ownAbove` 为可挖石/土/木时，不应直接放弃 step assist；应先出现 `surfaceUp.step_edge.own_above_notch.begin/end ok=true`，随后 `surfaceUp.step_edge.begin/end` 尝试上台阶。无镐石质顶、bedrock/obsidian/工作台/危险块仍不挖。
- **观测**: ✅ `node --check bots/_supervisor/skills/surfaceUp.js` 通过。07:23Z future sample hit the exact signal: `surfaceUp.step_edge.own_above_notch.begin block=grass_block@9,77,-12` → `surfaceUp.step_edge.own_above_notch.end ok=true after=air@9,77,-12`, followed by successful step/underfoot placement. This verifies the local supervisor notch can clear the bot's own second-headroom block instead of abandoning the step edge.
- **回滚**: 删除 `clearableStepRoof`、`own_above_notch` 分支，恢复 `if (!open(ownHead) || !open(ownAbove)) return false`。

## C169. critical no-regen 近处橡木信号走 bounded feedUp，不再被 300s cave-climb backoff 吞掉（③层 prepNether.js，已加载待验证）
- **触发**: C168 已把近身原木/树叶 backoff 压短，但白天窗口里 `prepNether` 随后仍可能落到 generic `CRITICAL no-regen food gate`，口头写“hold for bounded/local forage only”，实际立刻写 `bot._prepNoFoodSurfaceBackoffUntil = now + 300000`。这会把下一次近身 oak/leaf 机会压掉，表现为有局部可操作物但 5 分钟只站住。
- **机理**: `oakAppleForageSignal()` 对远距离 oak 保留 `tod>=11000` late-day 禁令是合理的，但 critical gate 没有二级局部判据；近身 log/leaves 与 blind `surfaceUp` 风险不是同类动作。旧 backoff 把“禁止盲爬洞”错误扩大成“禁止短窗本地 forage”。
- **改动**: 新增 `localCriticalOakSignal()`：仅在 `food<=3 hp<=8`、无 edible、overworld、非夜/非黄昏、10 格内无 actionable 威胁时，接受近身 `oak_log/dark_oak_log <=3.1b dy<=2.5` 或 `oak_leaves/dark_oak_leaves <=5.25b dy<=4.25`。critical gate 命中该信号时只调用一次 bounded `feedUp`，写 sweep/backoff 证据，失败后 45-60s 短冷却；无局部信号时 cave-climb backoff 从 300s 缩到 90s，仍不放开 blind `surfaceUp`。
- **预测**: 下个安全白天窗口若当前位置附近仍有 oak/log/leaves，应看到 `CRITICAL local oak forage ... bounded feedUp only`，并伴随 `feedUp.local_oak_decay` 或 `feedUp.leaf_sweep` motion；不应出现 `surfaceUp target` 或 300s backoff。夜晚/黄昏、同层怪、creeper/射手可行动威胁仍必须 hold。
- **观测**: ⚠️ `node --check bots/_supervisor/skills/prepNether.js` 通过，inbox `cancel_skill` 热加载成功。热加载后白天样本先被更早的 `oakAppleForageSignal()` 主路径接住：`bounded oak/apple forage — oak_log@2 dy=1` → `feedUp.local_oak_decay.begin/end ok=true`，随后 `oak pulse backoff 45s`，未出现 `surfaceUp target` 或 300s backoff。C169 的 exact `CRITICAL local oak forage` fallback 尚待一个 `oakAppleForageSignal` 未命中但近处 local oak 命中的样本验证。
- **回滚**: 删除 `localCriticalOakSignal()` 与 critical gate 中的 bounded feedUp 分支，将 `_prepNoFoodSurfaceBackoffUntil` 恢复为 300000。

## C166. overseer 触发器区分 actionable/layered 威胁，隔层怪不再误发 evac（③层 overseer.mjs，已验证）
- **触发**: live `pos=31,85,29 hp=7 food=2 mob=FREE`，策略层已根据 ENV-SNAPSHOT/covered hold 反复 gate 掉 `ADVISORY evac`，但 overseer 仍因 raw `7 hostiles + nearest 8b + night+surface` 输出 `risk=100 directive=evac` 并持续触发 LLM。这暴露实时 trigger 只看裸计数/粗 y>=60，不懂隔层可信度。
- **机理**: 当前蜘蛛在 `y+6`、其它怪在 `y-21`，对低血低粮封闭身体预算不是可接触威胁；但 overseer 不区分 actionable 与 layered，把山体内部误判为夜间地表，并把高差隔层怪当撤离理由。
- **改动**: 新增 `classifyMobThreat()`，为 radar mob 标注 `actionable/layered/dy/reason`；低血低粮无食物且只有 layered 威胁时认定 `sealedBodyBudgetHold`，风险封顶且不咨询 LLM、不下发 `evac`。risk/directive 改用 actionable 威胁驱动，输出补充 `actionableHostiles/layeredHostiles/actionableNearest`。
- **预测**: 当前同类隔层蜘蛛/下层怪场景中，`advisory.json` 应从 `risk=100 directive=evac` 变为无撤离指令，且写出 `sealedBodyBudgetHold=true`；若怪贴身、同层、近 creeper 或射手有实际射线风险，仍应保持 actionable 并可触发 evac。
- **观测**: ✅ `node --check bots/_supervisor/overseer.mjs` 通过。只停止 overseer PID 1376，watchdog 于 `02:05:04Z` 拉起新版；随后 live `advisory.json` 写出 `risk=55 directive=null actionableHostiles=0 layeredHostiles=6 nearest=8 sealedBodyBudgetHold=true`，overseer.log 也记录 `risk=55 directive=- (... sealed body-budget hold)`。
- **回滚**: 删除 `classifyMobThreat()` 与 actionable/layered 字段，恢复 raw `hostiles/nearest` 驱动 risk/directive 与 LLM gate。

## C167. food=2 近身橡木只打本地一根触发叶衰减，不再把 calorie floor 等同“完全不能碰树”（③层 feedUp.js，已验证）
- **触发**: C164/C165 后 bot 在 `food=2 hp=7` 从 `31,85,29` 通过 leaf-window step 推到 `36,85,27`，三轮扫叶 `broken=8/8/7` 只掉 stick/sapling；日志显示 `oak_log@2` 已贴脸，但 PlanD 因 `food<=2` 直接 `skip oak chop at calorie floor`，targeted oak 也写 `no chop/climb`。
- **机理**: 旧 C90 正确禁止的是低食物下调用 `chopWood` 的长路径/爬树/连砍；但当前是零漫游、近身可达原木。拆一根贴脸 log 可触发叶衰减并产出木材，身体预算远小于重新 roam 或 surfaceUp。
- **改动**: `feedUp` 新增 `localOakDecayKick()`：仅在 `food<=2 hp>=7`、无食物、非夜间、无 10 格 actionable 威胁时，选择 4.35 格内非脚下 `oak_log/dark_oak_log`；停止 pathfinder、清控制态、必要时卸下剑，只 bounded dig 一根，不走路、不爬高、不调用 `chopWood`。成功后等 2.5s、pickup、再做一次本地 `appleLeafSweep`，并写 `feedUp.local_oak_decay.*` motion。
- **预测**: food=2 且 oak_log 贴脸时，应出现 `PlanD local oak decay kick ... no roam/no climb` 与 `feedUp.local_oak_decay.begin/end ok=true`；不得出现 `chopWood LOW-FOOD BAIL`、长距离 `safe_roam` 或 `surfaceUp target`。
- **观测**: ✅ `node --check bots/_supervisor/skills/feedUp.js` 通过，热加载后 `02:11:11Z` 现场写出 `PlanD local oak decay kick oak_log@35,85,28 dist=0.7 dy=0.0 ... no roam/no climb`；motion 记录 begin/end，目标从 `oak_log@35,85,28` 变 `air@35,85,28`，身体未长距离移动。未掉 apple，但新增 `oak_log` 入包，后续静态 kit 成功做出 crafting table/stone_pickaxe。
- **回滚**: 删除 `localOakDecayKick()` 与 PlanD/targeted-oak 两处调用，恢复 food<=2 只扫叶不打 log。

## C168. 本地原木触发叶衰减后 oak/apple backoff 缩短，避免 300s 锁死近身 oak（③层 prepNether.js + feedUp.js，已验证短窗）
- **触发**: C167 成功拆掉近身 log 后，`appleLeafSweep` 最后一拍因 `nearest oak_leaves@6` 写 `reachable=0 broken=0`，`prepNether` 将其归为 `no real leaf action` 并写 `oak pulse backoff 300s`。这让“刚拆 log 等叶衰减/掉落”的局面反而被长锁。
- **机理**: `reachable=0` 的 300s backoff 适合“附近根本够不到叶子”，不适合“近身 log 刚拆，叶子开始衰减，下一轮可能有掉落或新叶窗口”的状态。缺少 `decayKick` 语义，prepNether 只能按坏证据处理。
- **改动**: `feedUp.localOakDecayKick()` 成功后将 `_feedUpLastLeafSweep.decayKick=true` 并记录 decay target；`prepNether` 对 `decayKick` sweep 只给 45s backoff。兼容已写入的旧坏记录：当 `oakSignal.dist<=2.5` 且 persisted/runtime backoff 来自 `reachable=0 maxReach>=5 nearest<=6.5` 时，长 backoff 被压短到约 45s。
- **预测**: 近身 `oak_log@<=2` 的 no-leaf/decay 状态不应再刷 180-300s backoff；应看到 `backoff <=45s` 或下一轮重新进入 bounded feedUp。非近身、无叶、无 decayKick 的真正失败仍可长 backoff。
- **观测**: 🟡 `node --check bots/_supervisor/skills/prepNether.js` 与 `feedUp.js` 通过。热加载后，原本同一近身 oak 状态从 `backoff 168s/104s` 降到 `backoff 44s`，证明 runtime 长锁被压短。随后进入夜间/critical hold，尚待下个白天窗口验证是否重新执行 bounded feedUp。
- **回滚**: 删除 `decayKick` 字段写入；删除 `nearLogRetryBackoff/nearLogRuntimeRetry` 和 decayKick backoff 分支，恢复 `reachable=0` 固定 300s。

## C165. 旧 4.5 reach 的 oak/apple backoff 视为坏证据，允许 C164 立即重试（③层 prepNether.js，已验证）
- **触发**: C164 热加载并手动清 `oak_apple_backoff.json` 后，`prepNether` 仍写 `bounded oak/apple forage backoff 160s/96s for oak_log@7 dy=5`；原因是旧 `bot._prepOakApplePulseBackoffUntil` 留在 bot 运行时内存里。该 backoff 来自 `reachable=0 maxReach=4.5 nearest=oak_leaves@4.66 dy=3`，正是 C164 已修的旧判据。
- **机理**: backoff 有两份来源：持久文件和 bot 内存字段。旧代码只忽略 `rec.maxReach == null` 的古早记录，不忽略 `maxReach<5.05` 的刚产生坏记录，也不会清运行时 pulse backoff。
- **改动**: `prepNether` 将 `reachable=0 && nearest<=5.1 && maxReach<5.05` 识别为 stale reach backoff；持久 backoff 直接忽略，运行时 `_prepOakApplePulseBackoffUntil` 在同类 `lastSweep` 下清零，并写 `clears stale runtime reach backoff`。
- **预测**: 旧 `maxReach=4.5` 造成的 300s backoff 不应阻止 C164 立即重试；下一轮应进入 `bounded oak/apple forage` → `feedUp.leaf_sweep.begin maxReach=5.05` 或更具体失败证据。
- **观测**: ✅ `node --check bots/_supervisor/skills/prepNether.js` 通过。热加载后清掉旧 `maxReach=4.5 reachable=0` 文件 backoff，并在下一轮白天窗口实际进入 `bounded oak/apple forage — oak_log@7 dy=5`，不再等待完整 300s；随后触发 C164 的新版 `feedUp.leaf_sweep.begin maxReach=5.05`。
- **回滚**: 恢复 staleReachBackoff 只认 `maxReach == null`，删除 runtime backoff 清零分支。

## C164. food=2 PlanD/紧急扫叶使用 no-regen 近叶阈值，不再把 5 格 dy3 叶子判不可达（③层 feedUp.js，已验证）
- **触发**: C163 后首个白天窗口成功进入 `FAMINE daylight forage window` 和 `bounded oak/apple forage`，但 `feedUp` 对 `oak_leaves@33,88,28 dist≈5 dy=3` 写 `PlanD leaf sweep no reachable leaves maxUp=3 maxReach=4.5 nearest=oak_leaves@5 dy=3`；随后 emergency leaf approach 也用同样旧参数，仍无真实 leaf action，写入 300s oak backoff。
- **机理**: C155/C156 已给 no-regen oak pulse 使用 `maxReach=5.05/maxUp=4/directReach=4.8`，但 PlanD famine leaf sweep 和 `emergencyLeafApproach()` 仍保留默认 `4.5/3`。于是同一个 5 格边缘叶子在 targeted-oak 路径可尝试，在 PlanD 路径却被归为不可达。
- **改动**: `feedUp` 的 food<=2 PlanD first sweep 和 emergency leaf approach 的 already-reachable / safeRoam success / partial-reach sweep 都显式传 `stopFood=10,maxUp=4,maxReach=5.05,directReach=4.8`。这只扩大本地扫叶/开窗/步进尝试范围，不启用长距离 roam 或 chop。
- **预测**: 下次同类 `oak_leaves@5 dy=3` 不应再写 `no reachable leaves maxUp=3 maxReach=4.5`；应进入 `feedUp.leaf_sweep.begin maxUp=4 maxReach=5.05`，随后直接打叶或记录 `dig_failed/window/window_step`。若仍失败，应保留 `failed/openedWindows/nearest` 证据，而不是空 backoff。
- **观测**: ✅ `node --check bots/_supervisor/skills/feedUp.js` 通过。`2026-06-13T01:54Z` 现场验证：`PlanD leaf sweep — breaking up to 2/7/5 oak leaves ... maxReach=5.05`，`mine_motion` 写出最终 `feedUp.leaf_sweep.end reachable=5 broken=5 failed=1 openedWindows=3 maxUp=4 maxReach=5.05 directReach=4.8`；期间 `window_step.end moved=true`，身体从 `30,85,31` 推进到约 `31.5,85,28.5`，mobility 从 `ENTOMBED/POCKET` 变成 `FREE`。未掉 apple，仅捡到 stick，food 仍为 2。
- **回滚**: PlanD 与 emergency leaf approach 恢复只传 `{ stopFood: 10 }`。

## C163. dawn-exit 出坑警戒复用 actionable threat，隔层蜘蛛不再假装堵门（③层 prepNether.js，已加载待验证）
- **触发**: C162 热加载后首个黎明样本仍卡在 `prepNether: ★dawn-exit hold — 1 mob(s) lingering at the door`；同一时刻雷达仍是 `spider@7.2 dy≈6`，C161 已证明它是 sealed layered threat，不是门口贴身怪。
- **机理**: `holeUpAtNight()` 的黎明出坑警戒内联了另一套 raw hostile 计数，只额外放过“白天 hp>=9 且有剑”的蜘蛛；当前 hp=7，虽然有隔层/封闭保护，仍被当成堵门怪，导致天亮后继续 60s 一轮等待。
- **改动**: `dawnLingeringHostiles()` 改用 `noRegenActionableThreats(10).actionable`；日志改为 `actionable/raw/layered`。这只影响是否继续 dawn-exit 等待，不放开 blind surfaceUp、breakout 或移动。
- **预测**: 当前 sealed `spider@7.2 dy=6.1` 不应再触发 `dawn-exit hold`；若同层/贴身/creeper/射手真的在门口，仍应等待并写 actionable 数量。
- **观测**: 🟡 `node --check bots/_supervisor/skills/prepNether.js` 通过。等待热加载后下一轮 `prepNether` 进入 dawn gate 验证。
- **回滚**: 恢复 dawnLingeringHostiles 的 raw entity filter 与旧日志。

## C162. 白天 famine forage / mission 低粮门复用 actionable threat，不再被隔层近战怪误拦（③层 prepNether.js + missionNether.js，已加载待验证）
- **触发**: C161 验证后，`NO-REGEN static kit` 已能把当前蜘蛛识别为 `actionable8=0 layered8=1`，但其它门仍写 raw `hostiles10=1/hostiles16>0`：`missionNether` 的 `★BREAKOUT gated: body-budget famine ... hostiles10=1`、`prepNether` 的白天 `shouldDayFamineHostileShelter()`、`daylightFamineForageWindow()`、`oakAppleForageSignal()` 都可能在天亮后继续把上层隔墙蜘蛛当成可接触威胁。
- **机理**: C154 只把 secured 的威胁半径从 16 降到 10，没有解决“10 格内但隔层”的语义错误。结果是 static kit 已解锁，但白天觅食/苹果叶救援仍可能被 raw radar 锁住，保护逻辑在不同层级不一致。
- **改动**: `prepNether` 的白天 famine shelter、daylight forage window、oak/apple forage signal 改用 `noRegenActionableThreats()`；日志补写 `actionable10/layered10`。`missionNether` 新增轻量 `actionableHostilesNear()`，忽略非射手/非 creeper 的高差隔层近战怪，用于 bounded oak ready、close food signal、daylight famine shelter/forage、bottom famine backoff 的 hostile pressure；breakout gate 日志改为 `hostiles10/actionable10`。
- **预测**: 当前这种 sealed `spider@7.2 dy=6.1` 不应在天亮后继续阻断 bounded oak/apple 或 daylight forage 的“是否可尝试”判断；若无近处 oak/food 信号，仍应 hold。body-budget famine 仍禁止 blind tunneling/sprint；同层怪、贴身怪、creeper、skeleton/witch/pillager 仍是 actionable。
- **观测**: 🟡 `node --check bots/_supervisor/skills/prepNether.js`、`node --check bots/_supervisor/skills/missionNether.js` 通过。当前仍是夜晚 `food=2 hp=7 ENTOMBED`，等待热加载后下一次 day/forage 样本验证。
- **回滚**: `prepNether` 恢复白天门使用 `hostilesNear(...)`；`missionNether` 删除 `actionableHostilesNear()` 并恢复 raw hostiles 判据与日志。

## C161. sealed 低血低粮 static kit 不再被隔层怪物硬拦（③层 prepNether.js，已验证）
- **触发**: 现场 `pos=30,85,31 hp=7 food=2 mob=ENTOMBED`，雷达最近蜘蛛 `27,91,30 d=7.2 dy≈+6`；`ENV-SNAPSHOT` 显示头顶/周围大量实心块，属于封闭气穴隔层威胁。但 `NO-REGEN static kit` 只看 `hostilesNear(8)`，反复写 `hostile within 8`，连零移动原地整理都不允许。
- **机理**: 威胁模型把欧氏距离当可接触威胁，没有区分贴身/同层/射线威胁和 sealed 上下隔层威胁，导致保护互绞：身体越安全，越被 raw radar 锁死。
- **改动**: 新增 `noRegenActionableThreats()`，在 `bodyBudgetBunkerHold && covered/enclosed` 下把 `abs(dy)>=4.5 && d>=5.5` 的非射手/非 creeper 怪物归为 `layered`；`nightBunkerStaticWeapon()` 与 `noRegenStaticKit()` 只因 `actionable` 威胁跳过，并在日志写 `hostiles8/actionable8/layered8/secured/nearest`。
- **预测**: 同类 sealed 上层蜘蛛不应再阻止零移动 local crafting；若怪贴身、同层、creeper 或射手靠近，仍应写 `actionable hostile` 并保持防御。不得因此放开移动、挖路或 surfaceUp。
- **观测**: ✅ `node --check bots/_supervisor/skills/prepNether.js` 通过；`2026-06-13T01:37Z` 热加载后现场写出 `actionable8=0 layered8=1 secured=true nearest=spider@7.2 dy=6.1`，随后 `ignoring 1/1 layered sealed threat(s) for zero-move local crafting`。本次 `helped=false` 是资源事实：无木板/工作台/食物，已有石剑/镐/棍/石头。
- **回滚**: 删除 `noRegenActionableThreats()`，`nightBunkerStaticWeapon()` 与 `noRegenStaticKit()` 恢复直接使用 `hostilesNear(8)>0` 拦截。

## C160. critical no-regen 无食物时禁止 enclosed/high-pocket blind surfaceUp（③层 prepNether.js，已验证）
- **触发**: `01:26` 现场 `food=3 hp=7 no edible` 从安全叶子隧道/高位气穴写 `enclosed/high-pocket food run — surfaceUp target=89`，爬升后食物降到 `2`；`feedUp` 随即因 `critical guard hp=7 hostile16=true` 放弃，bot 变成 `food=2 hp=7 ENTOMBED`。
- **机理**: “surface before feedUp must have concrete food signal” 只覆盖 `food>=7`，对最危险的 `food<=3` 反而直接走 blind surfaceUp。无回血状态下爬升/挖路消耗饥饿且可能暴露，是错误的身体预算。
- **改动**: `keepFed()` 在 generic surfaceUp 前新增 critical gate：`!openSurfaceNow && food<=3 && hp<=8 && !edible` 时写 `CRITICAL no-regen food gate`，设置 low-hp/no-food backoff，清控制态并 stop pathfinder，返回 false；只允许 bounded/local forage 之类已有信号路径。
- **预测**: 后续 `food<=3 hp<=8 no edible` 且不是真开阔地表时，不应再出现 `enclosed/high-pocket food run — surfaceUp target=...`；应进入 `CRITICAL no-regen food gate` 或更早的安全 shelter/local forage hold。
- **观测**: ✅ `node --check bots/_supervisor/skills/prepNether.js` 通过；`2026-06-13T01:31Z` 热加载后至 `01:37Z` 无新的 `surfaceUp target`，当前由 famine-hostile/night sealed hold 接管。
- **回滚**: 删除 critical gate，恢复 generic hungry/lowhp branch 直接 surfaceUp。

## C159. place/scaffold 动作补全运动审计字段（②层 skills.js，待重启生效）
- **触发**: 用户要求检查矿洞行进中每一次挖砖路线、垫砖时机，尤其需要“所处方块、目标方块坐标、周围图景以及结果”；原 `placeBlock()`/`placeBlockUnderFeet()` 失败只留高层结果，无法复盘身体格、目标格、参考面、清障和最终确认之间的因果。
- **机理**: 垫砖/放块是矿洞导航和脱困的关键身体动作，但缺少和 dig/path 同粒度的轨迹证据，导致只能靠 progress 文本猜测“为什么垫/为什么没垫”。
- **改动**: `src/agent/library/skills.js` 新增 `motionBlockObj/motionVecObj/motionEnvSnap`，并在 `placeBlock()` 写 `place_skill.begin/target/clear.begin/clear.end/reference/positioning.begin/positioning.end/end`，在 `placeBlockUnderFeet()` 写 `place_underfoot.begin/attempt/delay/confirm_failed/end`，包含 body block、target block、周围快照、结果原因。
- **预测**: 下一次 agent-only 重启后，`mine_motion.jsonl` 应出现 `place_skill.*` 与 `place_underfoot.*`；每次垫脚/放块都能追踪当前位置、目标格、参考块、清障结果和最终确认。不得改变放块行为本身。
- **观测**: ⏳ `node --check src/agent/library/skills.js` 通过；这是 core agent 文件，当前 `food=2 hp=7` 高危，不主动重启，仅等待安全窗口或自然 watchdog 重启后生效。
- **回滚**: 删除 motion helper 与 `motionAudit(...)` 调用，恢复原 `placeBlock()`/`placeBlockUnderFeet()` 日志粒度。

## C158. 低矮矿洞上台阶先凿 own-above roof notch，不再直接 own-above-blocked 放弃（②层 skills.js + modes.js，已生效待观测）
- **触发**: 历史 `mine_motion.jsonl` 多次显示 path/unstuck 在矿洞台阶边缘失败时写 `step_edge.blocked reason=own-above-blocked`，典型现场是脚下/头部两格可站，但当前头顶第二格是 `stone`，目标方向本可通过凿一格顶棚再上台阶；旧逻辑直接返回 false，随后 pathfinder 继续失败、随机解卡或转破坏性寻路。
- **机理**: 一格上坡在低矮 2-high 洞里需要额外跳跃/抬升空间；当前格 `ownAbove` 被挡时，原 assist 把它当不可解结构，而不是把它视为“上台阶前的安全 roof notch”。这正对应用户观察到的“上坡卡在台阶边缘频繁触发”。
- **改动**: `src/agent/library/skills.js::stepEdgeAssist()` 对 `ownAbove` 阻塞新增 `step_edge.own_above_notch.begin/end`：安全、非功能方块、非危险方块，且石质块有镐时，先停止 pathfinder/清控制态/持 dig lock 凿掉头顶第二格，再继续原来的候选 step assist。`src/agent/modes.js` 的实时 `unstuck` step-edge 也同步允许 `ownAbove` 先 notch，不再在 skipReason 里提前拦截。
- **预测**: 后续矿洞/上坡卡边缘时，不应再看到连续 `step_edge.blocked reason=own-above-blocked` 或 `step_edge.skip own-above-blocked` 后无动作；应先出现 `step_edge.own_above_notch.begin/end ok=true`，随后 `step_edge.begin/end ok=true` 或带明确失败原因。不得挖 bedrock/obsidian/危险块/功能方块，不得下挖。
- **观测**: 🟡 `node --check src/agent/library/skills.js`、`node --check src/agent/modes.js` 通过。`2026-06-13T01:20Z` watchdog 完成 agent-only 重启，`fresh_status` 为 live，`agentWs/mindserver/minecraftLan` 全 open；当前已入夜 covered hold，等待下一次自然上坡/矿洞台阶样本验证。
- **回滚**: 删除 `clearableStepRoof` 与 `step_edge.own_above_notch.*` 分支；`modes.js` 恢复 `isStepLikeNow()`/`stepSkipReason()` 对 `ownAbove` 的硬开放要求。

## C157. 已开好的叶子窗口也要迈步，不只在“本轮新开窗”后迈步（③层 feedUp.js，已验证）
- **触发**: C156 reassert/goto 补丁热加载后，下一次 daylight forage 写出 `feedUp.leaf_sweep.begin maxReach=5.05 directReach=4.55 reachable=4`，但四片叶子全部 `leaf-direct-out-of-range dist=4.64/4.74/4.85/4.95`；因为上一轮已经打开了 `27,81,35/27,82,35/27,83,35` 的窗口，本轮 `clearLeafSightWindow()` 没有新开块，`openedWindows=0`，代码只在 `openedWindows>0` 时调用 `stepIntoLeafWindow()`，于是明明窗口已通也不迈步。
- **机理**: C156 把“开窗”和“迈入窗口”错误耦合到同一个计数；已开窗口是更常见的重试状态，尤其 30s backoff 后现场不会重复挖同一空气格。结果 low-food rescue 卡在 `directReach` 外 0.1-0.4 格，无法继续打叶。
- **改动**: `directReach` 从 4.55 放宽到 4.8（只直接 `bot.dig`，不会触发 pathfinder，失败仍记录 `dig_failed`）；leaf direct 失败后，若本轮新开窗或叶子在 `directReach+0.65` 近窗口范围内，都调用 `stepIntoLeafWindow()`，让已打开窗口也能执行 reassert/goto 步进。`openedWindows` 阈值同步改为 `<3`，与 C156 的最多三格窗口一致。
- **预测**: 下一次同类 `dist≈4.64` 叶子应先尝试 direct dig；若仍失败，应看到 `feedUp.leaf_sweep.window_step.begin/end` 或 `window_step.goto`，并带 `clearedForwardTicks/reassertTicks/fallbackTried`。不得再出现 `reachable=4 failed=4 opened=0` 但完全没有 `window_step` 的重试。
- **观测**: ✅ `node --check bots/_supervisor/skills/feedUp.js` 通过；`2026-06-13T01:08Z` 通过 supervisor inbox 热加载。`01:09` daylight forage 现场验证：`feedUp.leaf_sweep.begin directReach=4.8` 后先直接打叶；`oak_leaves@31,82,37` 在 `dist=4.848` 失败后触发 `feedUp.leaf_sweep.window_step.begin/end moved=true`，身体从 `26.5,81,35.5` 推到 `27.127/27.5,81,35.5`，`leafDist=4.272`，`clearedForwardTicks=0 reassertTicks=4 fallbackTried=false`；随后继续直接打掉两片叶子，最终 `leaf_sweep.end broken=4 failed=1 openedWindows=0 directReach=4.8`。`01:11` 第二轮从新位置继续推进：`window_step.end moved=true` 把身体从 `27.5,81,35.5` 推到 `28.332,81,35.506`，`leafDist=4.085`，`clearedForwardTicks=1 reassertTicks=5`，随后 `leaf_sweep.end reachable=8 broken=8 failed=1 openedWindows=3 directReach=4.8`。无新的 leaf-target destructive path；暂未掉落 apple/食物，仍需继续观察觅食闭环。
- **回滚**: `directReach` 恢复 4.55；failure 分支恢复只在 `openedWindows>0` 时调用 `stepIntoLeafWindow()`；窗口阈值恢复 `<2`。

## C156. 近叶子扫叶不再触发 breakBlockAt 内部 destructive path（③层 feedUp.js + prepNether.js，部分有效继续观测）
- **触发**: C155 天亮后验证成功进入 `feedUp.leaf_sweep.begin maxReach=5.05 reachable=1`，但 `skills.breakBlockAt(oak_leaves@30,83,36)` 因内部硬阈值 `distance>4.5` 自动启动 pathfinder 到叶子，产生 destructive path；现场连续 3 次 `dig.begin target=stone@27,82,35` 后 `Digging aborted` / `goal changed`，最终 `leaf_sweep.end reachable=1 broken=0 failed=1`，又被记成 180s backoff。
- **机理**: C155 放宽了“可尝试距离”，但复用了 `breakBlockAt()`；该原语不是纯打目标方块，距离稍远会自行寻路/挖路。对低血低粮近叶子救援，正确动作应是：只在直接 reach 内直接打叶子；若被近处石头挡视线，开一个有限视线窗；失败后短重试，而不是把它归类为“附近叶子无效”长冷却。
- **改动**: `appleLeafSweep()` 新增 direct leaf dig，不再让 `breakBlockAt()` 对叶子触发 pathfinder；失败时记录 `feedUp.leaf_sweep.dig_failed`，并在 no-regen 下清有限安全遮挡块，记录 `feedUp.leaf_sweep.window.begin/end`，随后尝试一次直接重打。现场发现只清头/头顶仍差半格后，窗口候选补入前脚格，并新增 `feedUp.leaf_sweep.window_step.*`：先短周期重申 `forward` 控制态并记录 `clearedForwardTicks/reassertTicks`，若 350ms 仍零位移，再用 `Movements.canDig=false` 的 adjacent `GoalBlock` 兜底进入已打开目标格。`_feedUpLastLeafSweep` 增加 `openedWindows/directReach`。`prepNether` 将 `reachable>0 broken=0 failed>0 maxReach>=5 nearest<=5.2` 视为遮挡型失败，backoff 从 180s 缩到 30s，并能忽略旧的长 occlusion backoff。
- **预测**: 下一次 `oak_leaves@4-5 dy=2 food=3 hp=7` 不应再出现 leaf sweep 期间 pathfinder 反复 destructive dig 到目标叶子；若叶子视线被石头挡住，应写 `leaf_sweep.window.*`，最多开三个上/前方小窗。窗口打开后应出现 `window_step.end moved=true` 或 `window_step.goto ok=true`，并把叶子距离压到 `directReach<=4.55` 后直接打叶。若仍失败，应 `backoff 30s` 而非 180s，并保留 `failed/openedWindows/clearedForwardTicks` 证据。
- **观测**: ⚠️ `node --check bots/_supervisor/skills/feedUp.js`、`node --check bots/_supervisor/skills/prepNether.js` 通过并已热加载。现场第一阶段有效：后续 leaf sweep 不再对叶子启动 `GoalNear` destructive path；`00:48` 样本曾打掉 2 片叶子但无掉落。第二阶段暴露新问题：`00:53` 窗口成功打开 `stone@27,81,35`、`stone@27,82,35`、`stone@27,83,35`，但旧 `forward` 步进 `moved=false`，叶距仍 `4.637`，回退为 30s oak pulse backoff。`00:57` 新的 reassert+adjacent-goto 步进补丁已热加载；已入 dusk/night，等待下一轮 daylight forage 验证 `window_step.goto` 与 `clearedForwardTicks`。
- **回滚**: `appleLeafSweep()` 恢复调用 `skills.breakBlockAt()` 打叶子；删除 direct dig/window events 和 `openedWindows/directReach`；`prepNether` 恢复 `sweep.reachable ? 180000 : 300000` backoff。

## C155. 无回血近叶子不再被旧 4.5 格 reach/backoff 判据卡死（③层 feedUp.js + prepNether.js，已加载待验证）
- **触发**: C153 二次现场在 `pos=25.5,81,35.5`，目标 `oak_leaves@30,83,36` 精确距离 `4.95`、dy=2。旧 `appleLeafSweep()` 只接受 `dist<=4.5`，`controlledOakTunnel()` 尾部只在 `<=4.8` 扫叶，于是明明已经在可尝试采叶范围边缘，却继续尝试压进 `x=26` 目标格；press 失败后写入 `reachable=0` 的 300s backoff，直接把白天窗口压到 dusk。
- **机理**: 这是两个局部保守阈值叠加出的死结：运动层在窄洞/台阶边缘进格失败，感知层又把 4.95 格叶子归为不可达；随后持久 backoff 使用旧判据的失败记录，阻止热加载后的新策略立即重试。
- **改动**: `appleLeafSweep()` 新增 `maxReach`，无回血近叶子路径用 `5.05`，并写 `feedUp.leaf_sweep.begin/end/none`，记录 `reachable/broken/failed/maxReach/nearest`。`controlledOakTunnel()` 在 starvingNoRegen 下距离 `<=5.05` 先扫叶，不再硬挤下一格。`prepNether` 的 oak backoff 写入 `maxReach/failed`，并对旧记录中 `reachable=0 && nearest<=5.1 && maxReach缺失` 的低粮救命场景忽略旧 backoff。
- **预测**: 下一个白天同类 `food=3 hp=7 oak_leaves@5 dy=2` 应直接进入 `leaf_sweep.begin maxReach=5.05` 或 `oak_tunnel.sweep maxReach=5.05`；不得再因为旧 `reachable=0` backoff 等完整 300s。若 5.05 仍超出实际破坏距离，应看到 `failed>0 broken=0`，后续再改成“先开侧向/头顶小窗”而不是盲目下挖或垫柱。
- **观测**: 🟡 `node --check bots/_supervisor/skills/feedUp.js`、`node --check bots/_supervisor/skills/prepNether.js` 通过。`2026-06-13T00:40Z` 已热加载；当前已入夜，bot 在 covered/enclosed hold，等待下一个白天 feedUp 样本。
- **回滚**: `appleLeafSweep()` 恢复硬 `4.5`，删除 `maxReach` 与 `feedUp.leaf_sweep.*` 事件；`controlledOakTunnel()` 恢复 `4.6/4.8` 扫叶门；`prepNether` 删除旧 backoff 忽略逻辑与 `maxReach/failed` 字段。

## C154. 已封顶低粮 hold 不再被 11-16 格远怪永久压住 feedUp（③层 prepNether.js，已验证）
- **触发**: C150/C152 后 bot 已在 `pos=23,81,35`、covered/enclosed、hp=7、food=3 安全 hold，但 `prepNether` 仍因 16 格内一只蜘蛛反复进入 `★DAY famine-hostile shelter` / `NO-REGEN static kit`，不给 `keepFed/feedUp` 接管；当前蜘蛛长期约 11.7 格，既未贴脸，也足够让 C153 的受控橡树隧道在 10 格近身门内安全尝试。
- **机理**: `shouldDayFamineHostileShelter()` 只有一个硬 `hostilesNear(16)>0`。这个门适合“尚未封顶/未封闭”的暴露低粮态，但对已经 secured 的 bunker 会造成保护互绞：越安全越原地蹲，远处怪永远阻止本地觅食。
- **改动**: 新增 `coveredAboveNow()` 与 `containedMobilityNow()`；低粮低血且已封顶/封闭时，白天 famine-hostile shelter 与 `daylightFamineForageWindow()` 都只看 10 格近身威胁；未 secured 时仍看 16 格。`oakAppleForageSignal()` 同步用 `hostilesNear(10)`，与 `feedUp.controlledOakTunnel()` 的 10 格守卫对齐。FAMINE gate 日志补写 `hostiles10/hostiles16/secured`，防止再把远怪压制误判成夜门。
- **预测**: 当前这类 `secured=true hostiles10=0 hostiles16=1/2 food=3 hp=7` 不应继续无限 `DAY famine-hostile shelter` 或 goal-loop `FAMINE gate`；下一轮应进入 `FAMINE daylight forage window` → `bounded oak/apple forage` / `feedUp`，并由 C153 决定是否开水平叶子隧道。若怪进入 10 格内，仍应 hold，不准出洞/开挖。
- **观测**: ✅ `node --check bots/_supervisor/skills/prepNether.js` 通过。热加载后当前 `secured=true hostiles10=0 hostiles16=2 food=3 hp=7` 不再无限 `DAY famine-hostile shelter`，而是写出 `FAMINE daylight forage window` 并实际进入 `bounded oak/apple forage` / `feedUp`。后续 `FAMINE gate ... secured=true hostiles10=0 hostiles16=2` 样本来自 60s/90s forage cooldown，而非远怪压制。
- **回滚**: 删除 `coveredAboveNow/containedMobilityNow`，`shouldDayFamineHostileShelter()` 与 `oakAppleForageSignal()` 恢复 `hostilesNear(16)`。

## C153. food=3 无回血时允许受控水平橡树隧道（③层 feedUp.js，待现场验证）
- **触发**: 00:07 现场 `feedUp.safe_roam` 试图到 `targeted-oak` 的同层目标 `30,82,36`，从 `23.484,82,36.511` 只挪到 `23.7,82,35.5` 后 `No path to the goal!`，目标叶子 `oak_leaves@30,83,36` 距离约 6.4、dy=2。随后 `controlledOakTunnel()` 没有接管，因为旧门槛要求 `food>=4` 且 `abs(dy)<=1.5`；当前 food=3/hp=7 正好被卡成“安全 hold 但永不觅食”。
- **机理**: C150/C152 已经阻断了低血低粮时的错误下挖，但 food=3 仍无回血、无食物。对近处叶子，正确动作不是 surfaceUp/爬树，而是沿同层挖 1x2 水平通道，把身体送到叶子 4.6 格内后扫叶；dy=2 的叶子可通过 `appleLeafSweep(maxUp=4)` 够到，不需要上坡或垫柱。
- **改动**: `controlledOakTunnel()` 新增 `starvingNoRegen` 模式：`hp<=8 && food>=3 && food<4`、有镐、白天、无 10 格内威胁、目标 <=7.5 格且 `abs(dy)<=2.5` 时允许进入；循环守卫按 food>=3 继续，但仍逐步检查 hostile/night/hp。motion 事件补写 `starvingNoRegen`，每步仍记录目标格、foot/head/floor、dig begin/end、step end。现场发现第二步 `pathOk=true` 但停在 x=24.5 格边后，center-press 阶段改为先 `pathfinder.stop/setGoal(null)`，body lock 延长到 2.2s，forward press 延长到 1.5s，并新增 `feedUp.oak_tunnel.press.begin/end`。
- **预测**: 下一次同类 `targeted-oak safe-roam-no-progress nowDist<=8.5 noRegen=true food=3` 时，应出现 `feedUp: controlled oak tunnel start ... starving=true`，随后最多 4 步水平 dig/step/sweep；不得触发 surfaceUp、垫柱或向下挖。若 pathfinder 停在目标格边，应出现 `press.begin/end`，成功则进入目标格并继续下一步/扫叶，失败则带 `targetDist` 留证。如果 10 格内出现敌人、夜晚或 floor 不稳，应写 `feedUp.oak_tunnel.stop` 或直接不启动。
- **观测**: ⚠️ `node --check bots/_supervisor/skills/feedUp.js` 通过，C153 首次现场触发成功放行: `FAMINE daylight forage window` → `bounded oak/apple forage` → `controlled oak tunnel start ... starving=true`；只挖同层 `stone@24,81,35`，无 surfaceUp/垫柱/下挖。二次现场证明 press 日志有效但身体仍可卡在目标格边：`pathOk=true moved=0 targetDist=0.707` → `press.end ok=false`，目标叶子距离 `4.95`。C155 改为先近距扫叶并保留 `failed` 证据。
- **回滚**: 恢复 `controlledOakTunnel()` 的 `bot.food < 4`、`abs(dy)>1.5`、`hostileNear(8)` 旧门槛，并删除 `starvingNoRegen` 事件字段。

## C152. self_preservation no-regen covered hold 阻断 Outmatched→bunkerDown 下挖（①层 modes.js，已验证）
- **触发**: C150 热加载后，现场又出现新路径：`self_preservation` 在 `hp=7 food=3`、已有 cover 时因为 spider 接近输出 `Outmatched ... digging in!`，随后 `mine_motion` 显示 `path.phase destructive`、`dig.begin target=stone/dirt under/side`，位置从 `y=86` 变到 `y=82` 并补盖。这不是 `prepNether` 分支，而是 mode 层 `shouldFlee → bunkerDown` 抢身体。
- **机理**: `lowHpNoRegenContainedHold()` 已存在并被 `unstuck` 使用，所以日志里会看到 suppress；但 `self_preservation` 的 `shouldFlee` 分支没有接这道门。`coveredNightHoldStatus()` 又只在夜间生效，白天阴影里的 spider 会绕过 covered hold，触发下挖。
- **改动**: `shouldFlee` 分支入口先调用 `lowHpNoRegenContainedHold(bot)`；若低血、低粮、无正常食物且已有 pocket/enclosed/cover，并且敌人未贴脸/苦力怕未近爆，则清控制、停 pathfinder、原地 wait，并写 `[self_preservation] no-regen flee hold ... — no bunkerDown/dig`，不再进入 `bunkerDown`。
- **预测**: 下一次同类 `hp<=8 food<18 no normal food covered` + 非贴脸敌人时，不应再出现 `Outmatched ... digging in!` 后的 `digDown`/destructive path；应改为 `no-regen flee hold`。若敌人贴脸 `<4.25` 或 creeper `<5.5`，仍允许紧急 bunker/flee。
- **观测**: ✅ `node --check src/agent/modes.js` 通过。agent-only restart 后 `fresh_status` 恢复 `classification=live`，`audit.installed` 于 `2026-06-13T00:12:31Z` 重装。现场同类 spider 威胁已写出两条 `[self_preservation] no-regen flee hold ... — no bunkerDown/dig`，没有再触发 `Outmatched ... digging in!` 或新的 destructive dig。
- **回滚**: 删除 `shouldFlee` 分支开头的 `noRegenHold` 检查与 wait/log 逻辑。

## C151. stair-edge 失败后确认式回中再助跑（③层 chopWood.js，已加载待现场验证）
- **触发**: `mine_motion` 旧样本显示 `raw-stair` 连续失败时，身体从 `z≈0.57` 只压到 `z≈0.70`，`y` 没有抬升，`targetDist≈0.8`；下一次 attempt 又从同一个台阶边缘开始，重复卡边。这对应用户说的“上坡很容易卡在台阶边缘，触发非常频繁”。
- **机理**: `_ascendStep()` 失败恢复只做“看向台阶 + sneak/back 300ms”，没有验证身体是否回到当前格中心；短时序可能仍停在边缘，于是下一次 run-up 不存在真实助跑距离。C144 收紧成功判定能避免假成功，但还缺少失败后的确定性回中。
- **改动**: `_ascendStep()` 新增 `recoverRunupCenter()`，每次 `edge_miss` 或 `no-rise` 后写 `ascend.recenter.begin/end`，调用机械 `_centerOnBlock()` 并验证中心误差 `<0.22`，下一次 attempt 从中心重新助跑。
- **预测**: 下一次台阶边缘失败后，应看到 `ascend.recenter.end ok=true` 且后续 attempt 的 start 靠近 `.5/.5`；若仍 `ok=false`，说明有其它 body lock/碰撞/流体因素阻止回中，日志会给出起止坐标。
- **观测**: 🟡 `node --check bots/_supervisor/skills/chopWood.js` 通过。`2026-06-13T00:06:59Z` 热加载确认 `sent_control/cancel_result ok=true`。等待下一次 raw-stair/pinned-stair/surf-stair 样本。
- **回滚**: 删除 `recoverRunupCenter()` 及失败路径末尾的调用，恢复原来的 timed back-only 恢复。

## C150. 低血低饱食 shelter 不再因 mobility 未封闭而下挖（③层 prepNether.js，已加载待现场验证）
- **触发**: C142 后现场仍出现 `prepNether: ★DAY famine-hostile shelter — hp=7 food=3` 后走 `★dug-in bunker unsealed(无封顶料...) y=89`，而当时 inventory 有大量 `cobblestone/dirt`。`mine_motion` 显示低资源态仍发生向下/脚下挖掘和随后补封顶，导致 y 轴抖动，正中用户指出的“挖砖块路线、垫砖块时机糟糕”。
- **机理**: C142 只在 `bodyBudgetBunkerHold() && containedMobility()` 时禁止 `digDown`；但 `containedMobility()` 是实时状态机输出，低血低粮 shelter 刚触发时可能短暂 false，于是落到旧 `digDown(bot, 2)` 分支。封顶材料判断日志也不够可信，placement 失败会被误写成“无封顶料”。
- **改动**: `bodyBudgetBunkerHold()` 现在无条件进入 no-dig hold：先尝试 `sealCurrentRoof()` 原地封顶，记录 `contained`、实际 seal block、placement 失败/耗尽原因；无论封顶成功与否都不再 `digDown`。保留普通非低资源夜间 bunker 的旧 digDown 路径。
- **预测**: 下一次 `hp<=8 food<=6 && !hasEdible()` shelter 时，应出现 `prepNether: body-budget bunker ... — no digDown`，且之后不应出现同一轮 `skills.digDown` 造成的 y 下降或 `★dug-in bunker unsealed(无封顶料...)`。若封顶失败，日志会显示具体 seal block 和失败坐标。
- **观测**: 🟡 `node --check bots/_supervisor/skills/prepNether.js` 通过。`2026-06-13T00:02:42Z` 热加载确认 `sent_control/cancel_result ok=true`，sticky 重新进入 `missionNether`。当前点已 covered，需等待下一次未 covered 的 body-budget shelter 样本验证新 no-dig 分支。
- **回滚**: 恢复 `bodyBudgetBunkerHold() && containedMobility()` 条件，删除 `sealCurrentRoof()` 的失败原因日志和 `lowResourceNoDigHold` 分支。

## C149. oak_tunnel 已开通道的最后半步用身体锁压入目标格（③层 feedUp.js，已加载待现场验证）
- **触发**: C148 现场验证后，`feedUp.oak_tunnel.step.edge_miss` 正确识别了 `pathOk=true moved=0 targetDist≈0.927`，但 460ms center-press 只从 `x=25.573` 回到 `x=25.500`，仍未进入目标格 `x=26,z=33`；本轮已挖出 1x2 通道，叶子距离从 7.1 降到 5.1，却差最后半步无法靠近到扫叶范围。
- **机理**: 受控隧道进格动作没有 body move lock，且固定 460ms 对窄通道/边缘位置太短；同时保护层可能仍在低血低粮时抢控制状态，导致 `forward` 压入不足。不能放宽 `moved` 判据，应该加强实际进格动作。
- **改动**: center-press 阶段设置 `bot._bodyMoveLockOwner='feedUp:oak-tunnel-step'` / `bot._bodyMoveLockUntil`，清 sneak/jump/sprint，只 forward 朝目标中心压入最多 900ms，`inTargetCell()` 一旦成立立即停；finally 释放 body move lock。
- **预测**: 下一次同类 `pathOk=true moved=0 targetDist≈0.9` 后，若通道确实开通，应在 `feedUp.oak_tunnel.step.edge_miss` 后进入目标格，`step.end moved=true to` 变化到目标 cell；若保护/碰撞仍阻止，仍应 `moved=false`，但不会假成功。
- **观测**: 🟡 `node --check bots/_supervisor/skills/feedUp.js` 通过。`2026-06-12T23:58:28Z` 热加载确认 `sent_control/cancel_result ok=true`。当前 bot 入夜 covered hold，等待下一次 daylight oak pulse 验证锁定 center-press。
- **回滚**: 删除 center-press 的 `_bodyMoveLockOwner/_bodyMoveLockUntil` 设置和 900ms 循环，恢复固定 `skills.wait(460)`。

## C148. oak_tunnel 不再把 GoalNear range 成功误当进格成功（③层 feedUp.js，已语法验证待热加载/现场验证）
- **触发**: C146 首次现场触发。`feedUp.oak_tunnel` 挖开 `stone@24,83,33` 和 `stone@24,84,33` 后，`safe_roam.end ok=true moved=0 targetDist=0.872/0.716`，但 `oak_tunnel.step.end moved=true`，并在同一 `targetCell=24,83,33` 原地重复 4 次，最后 `oak_tunnel.end dist=6.96`。这说明 `GoalNear(range=1)` 的“离目标够近”被错当成“身体进了目标格”。
- **机理**: 受控短隧道需要的是逐格推进；`safeRoamTo()` 面向普通觅食靠近，range 内成功可以不移动。C146 复用它但没有二次验证 `floor(x,z)==targetCell` 或实际位移，导致“挖对了路，却没有走进去”。
- **改动**: `controlledOakTunnel()` 新增 `inTargetCell()`，step 成功只接受进入目标格并接近中心，或实际位移 >0.45。若 pathfinder 返回 ok 但没有进格/位移，写 `feedUp.oak_tunnel.step.edge_miss`，再执行短 `center-press`；仍未进格则 `moved=false` 并停止，不再原地刷 4 次假成功。
- **预测**: 下一次 oak tunnel 在相邻格 range 内但身体没动时，应出现 `feedUp.oak_tunnel.step.edge_miss`，随后若 center-press 成功，`step.end moved=true to` 应进入 `targetCell`；若不成功，`step.end moved=false` 并退出/等待下一轮，不得再次同一格 `moved=true to==from moved=0`。
- **观测**: 🟡 `node --check bots/_supervisor/skills/feedUp.js` 通过。等待热加载后现场验证；当前 bot 已回到 `hp=7 food=4` famine-hostile covered hold。
- **回滚**: 删除 `inTargetCell()`/`pathOk` 二次验证与 `feedUp.oak_tunnel.step.edge_miss`，恢复直接使用 `safeRoamTo()` 返回值作为 `moved`。

## C147. surfaceUp fallback 向上挖前必须先稳定脚下，全局标记悬空挖掘（③层 surfaceUp.js + ①层 modes.js，已语法验证待现场验证）
- **触发**: 复盘 `mine_motion` 旧样本发现 `surfaceUp` 在 `pos=23,79,33` 且脚下支撑不稳定时继续向上挖 `stone@23,83,33`；`dig.end` 时身体掉到 `y=77`，随后 `placeBlockUnderFeet`/手动垫块在同一列超时。这正是用户指出的“矿洞里挖砖块路线、垫砖块时机很糟糕”的一个可复现机制。
- **机理**: fallback loop 只按 `h=2..4` 清头顶并累计 `opened`，没有在每轮向上挖前证明当前脚下有稳定实体；`guardedDig()` 的返回值也没有被用于中止，挖掘期间掉格后仍可能把这次 headroom 当成成功继续垫柱，导致“先挖空/掉落，再补救”的错误节奏。
- **改动**: `surfaceUp` 新增 `ensureStableFooting()`：fallback 每轮清头顶前先检查脚下实体，若不稳则停 pathfinder/清控制、等待落稳、尝试一次垫柱恢复，并写 `surfaceUp.footing.*`。`guardedDig()` 失败或挖掘期间 `y` 下降时，立即设 `verticalBlocked`，写 `surfaceUp.fallback.fell_during_dig`，不再继续按旧 `opened` 数进行 pillarUp。全局 `mine_motion_audit` 升到 v3，`dig.begin` 带 `support` 字段；脚下不稳时额外写 `dig.unsupported_before`，便于后续按操作日志回放每次坏动作。
- **预测**: 下一次 surfaceUp fallback 不应在 `support.stable=false` 时继续清 2-4 格头顶；若身处竖井半空，应先出现 `surfaceUp.footing.unstable/settled|pillar_recovered|blocked`。若挖掘中仍发生掉格，应出现 `surfaceUp.fallback.fell_during_dig`，且不会继续把该轮当作成功 headroom 去垫柱。任何其它技能若悬空挖掘，应写 `dig.unsupported_before`。
- **观测**: 🟡 `node --check bots/_supervisor/skills/surfaceUp.js`、`node --check src/agent/modes.js` 通过。等待热加载/agent-only reload 后现场验证；当前 live 仍在夜间 `POCKET hp=7 food=4` covered hold，无新 surfaceUp 样本。
- **回滚**: 删除 `stableFloorBelow()/ensureStableFooting()` 与 fallback loop 中的前置稳定门、`guardedDig()` 返回/掉格中止逻辑；`mine_motion_audit` 版本恢复 v2 并删除 `supportObj()`、`dig.unsupported_before`。

## C146. no-regen 近叶子不可达时允许受控短隧道，而不是随机乱挖或无限等待（③层 feedUp.js，已加载待现场验证）
- **触发**: C145 证明当前 `oak_leaves@7 dy=0` 不是路径审计缺失，而是从 `pos=23,83,33` 看得见但被石头隔开：`feedUp.safe_roam.end ok=false moved=0 targetDist=7.144`，env 3x4x3 基本全是 `stone/cobblestone`。C145 将其 backoff 后，bot 安全但仍处 `hp=7 food=4` 食物死结；单纯等待不会产生食物。
- **机理**: 旧策略只有两端：随机/启发式上坡觅食，或低血低粮完全 hold。它没有“全知 blockAt 下的短程受控开路”：同层 7-8 格叶子若隔着少量 stone，安全白天用镐开 1x2 短通道，比继续把它当不可达诱饵或让其它层随机 step-out 更可控。
- **改动**: `feedUp` 新增 `controlledOakTunnel(oak,label)`，仅在白天、无 8 格近敌、`hp>=7 food>=4`、8.5 格内、垂直差 ≤1.5、身上有 pickaxe、下一格无水/火/岩浆/无底洞时生效。每步按目标方向最多 4 步：检查 foot/head/floor，必要时挖 1x2，使用 audited `safeRoamTo('oak-tunnel-step')` 或短 center press 进格；靠近到 4.6 格内就 `appleLeafSweep`。所有步骤写 `feedUp.oak_tunnel.*` 到 `mine_motion`。
- **预测**: 下一个白天 oak pulse 若仍是 `oak_leaves@7 dy=0` 且近敌为空，不应只写 `safe_roam moved=0` 后 backoff；应先写 `feedUp.oak_tunnel.begin`，随后最多 4 步 `dig/step/end`。若出现 hazard/no-floor/近敌/夜间/血粮更低，则不得挖，仍走 C145 backoff。
- **观测**: 🟡 `node --check bots/_supervisor/skills/feedUp.js` 通过。23:36:50 通过 inbox 发 `cancel_skill` 热重挂，event 确认 `cancel_result ok=true running=missionNether`、23:36:59 sticky 重进；之后已入 dusk/night，`prepNether` 正确 `critical snackless shelter` 和 `bunker already covered`，未触发新 feedUp/oak tunnel，也无新 dig/place。等待下个白天 oak pulse 现场验证。
- **回滚**: 删除 `controlledOakTunnel()` 及 targeted-oak failure 分支中对它的调用，恢复 C145 的 approach-failed→backoff 行为。

## C145. feedUp 安全接近写入 mine_motion，并把不可达 oak/leaves 回传给 prepNether 持久 backoff（③层 feedUp.js，已验证）
- **触发**: C144 reload 后天亮，`prepNether` 在 `pos=23,83,34 hp=7 food=4` 发现 `oak_leaves@7 dy=0`，调用 `feedUp`；`feedUp` 写 `targeted oak forage oak_leaves@7 ... noRegen=true` 后 9ms 内直接 `failed to approach nowDist=7`，没有 `mine_motion` 路径证据，也没有 `_feedUpLastLeafSweep`。结果 `prepNether` 只知道“没改善”，无法持久识别这片叶子其实隔着石头不可达。
- **机理**: `feedUp.safeRoamTo()` 直接调用 `bot.pathfinder.goto(new GoalNear(...))`，绕过 `skills.goToPosition` 的 `path.begin/path.plan/path.step_edge` 审计；当 pathfinder 立即返回但身体没动时，函数只返回 false，不记录目标/当前位置/周围图景/结果。`prepNether` 的 oak backoff 只看 `_feedUpLastLeafSweep.reachable/broken`，而 approach 阶段失败不会设置它，导致“可见 oak 信号”仍可能被周期性当成具体食物目标。
- **改动**: `safeRoamTo()` 新增 `feedUp.safe_roam.begin/end` 写入 `mine_motion.jsonl`，包含当前位置、目标坐标、range、移动距离、targetDist、周围 3x4x3 图景与错误。`targetedOakAppleForage()` 在 no-progress approach 失败时写 `feedUp.oak_approach.failed`，并设置 `_feedUpLastLeafSweep={reachable:0, broken:0, nearest, approachFailed:true}`，让 `prepNether` 复用既有持久 backoff。
- **预测**: 下一次同类 `oak_leaves@7` 不可达时，`mine_motion` 应明确记录 safe_roam begin/end 且 `moved=0/targetDist≈7`；`prepNether` 应写 `bounded oak/apple forage no real leaf action reachable=0 broken=0 ... oak pulse backoff 300s`，后续循环只写 backoff 倒计时，不再立刻重进 feedUp 打同一目标。
- **观测**: ✅ `node --check bots/_supervisor/skills/feedUp.js` 通过。23:30 通过 inbox `cancel_skill` 热重挂，event 确认 `cancel_result ok=true running=missionNether`，sticky 23:30:22 重进。23:30:42 新样本写出 `feedUp.safe_roam.begin target=30,83,36 range=4`、`feedUp.safe_roam.end ok=false error=null moved=0 targetDist=7.144`，env 显示当前 3x4x3 周围被 stone/cobblestone 围住；随后 `feedUp.oak_approach.failed reason=safe-roam-no-progress`。同一轮 `prepNether` 写 `bounded oak/apple forage no real leaf action reachable=0 broken=0 nearest=oak_leaves@7 dy=0 30,83,36; oak pulse backoff 300s`；23:31:52 下一轮只写 `bounded oak/apple forage backoff 230s`，没有再次 feedUp 冲同一片不可达叶子。
- **回滚**: 删除 `feedUp.safe_roam.*`/`feedUp.oak_approach.failed` motion 日志；删除 `rememberOakApproachFailed()` 和 approach-failed 时设置 `_feedUpLastLeafSweep` 的逻辑。

## C144. 上坡 step-edge 成功条件收紧：必须落进目标格，edge-miss 先中心压入再失败冷却（①层 skills.js/modes.js + ③层 surfaceUp.js，待现场验证）
- **触发**: 用户指出“上坡很容易卡在台阶边缘，触发非常频繁”。复查现有三套上坡辅助发现：`skills.stepEdgeAssist`、always-mode `step_edge`、`surfaceUp.stepEdgeAssist` 都把“升高了且离目标中心约 1.25 格内”当成功；这会把身体挂在台阶边缘/格子边界的假成功上报给上层，下一轮继续沿错误状态推进。
- **机理**: 台阶边缘失败的关键不是“有没有升高”，而是“是否真的进入目标 foot cell 并稳定接近中心”。旧判据允许 `rose=true` 但 `floor(x,z)` 仍在旧格或邻边，surfaceUp 还在 press 阶段只要 `maxRise>0.12` 就跳过 runup，进一步放大边缘假成功。
- **改动**: 三套 step-edge 成功判据统一为 `roseEnough && floor(x,z)==target && targetDist<=0.9`。若检测到 `roseEnough` 但未 `settledInTarget`，写 `step_edge.edge_miss` / `surfaceUp.step_edge.edge_miss`，随后短暂 `center-press` 向目标中心压入 420ms；仍未落入目标格则返回失败并给该方向冷却。`surfaceUp` 删除“微小升高就跳过 runup”的早退。
- **预测**: 下一次台阶边缘卡住时，不应再出现 `ok=true targetDist>1` 或已升高但未进目标格的假成功；应出现 `edge_miss`，若中心压入成功则最终 `ok=true settledInTarget=true`，否则 `ok=false` 并换方向/进入后续 fallback。普通真正跨上台阶的样本仍应成功。
- **观测**: 🟡 `node --check src/agent/library/skills.js`、`node --check src/agent/modes.js`、`node --check bots/_supervisor/skills/surfaceUp.js` 通过。23:23 精确停止 agent PID `8765=15196`、`48909=40816`，保留 Minecraft LAN `55916=8620`；watchdog 重挂后新 PID `8765=15916`、`48909=41536`，`fresh_status=live`。`mine_motion.jsonl` 在 23:24 写新 `audit.installed`，证明新栈已加载。当前 `hp=7 food=4 pos=23,83,34` 处于合法 covered night hold，reload 后无新 dig/place/step-edge 样本，等待下个真实上坡窗口验证。
- **回滚**: 三处 step-edge 恢复旧 `rose && targetDist<1.25/1.28` 成功条件；删除 `edge_miss` 日志与 `center-press` 恢复动作；surfaceUp 恢复 `maxRise>0.12` 早退。

## C143. watchdog 保护性 hold 不再跳过循环收尾，singleton 同时识别相对启动（watchdog.ps1，已验证）
- **触发**: C140 后 `fresh_status` 一度显示 `heartbeat` 新但 `watchdog` 旧；旧 watchdog PID 仍在，`watchdog.log` 停在 `relaunched node main.js`/首条 heartbeat，而 `heartbeat.log` 却每秒刷同一类状态。进一步枚举发现同时存在 `-File watchdog.ps1` 的旧相对启动进程和 `-File C:\...\watchdog.ps1` 的新绝对启动进程，两个 watchdog 写同一个心跳文件。
- **机理**: ①C140 在 `$nightHold/$noRegenHold/$sealedBodyBudgetHold` 命中时直接 `continue`，跳过 `$tick++`、death spiral、log rotation 和末尾 `Start-Sleep 30s`，导致保护性蹲坑时 watchdog 自己紧循环/日志节奏失真。②脚本启动时的 singleton 只匹配绝对路径 `...\watchdog.ps1`，漏掉历史的相对 `-File watchdog.ps1`，于是重复 watchdog 会同时写 `heartbeat.log`，污染“是否实时”的判断。
- **改动**: protected hold 分支只重置 anchor/alert，不再 `continue`；STUCK-ZONE 的 alert/restart 逻辑移入 `else`，让所有合法 hold 仍走到底部 bookkeeping/sleep。singleton 匹配同时覆盖绝对路径和相对 `-File watchdog.ps1` 形态。
- **预测**: 修复后只应有一个 watchdog 进程；`heartbeat.log` 约每 30s 新增一条，不再每秒刷；`fresh_status` 仍应保持 live，且 protected body-budget hold 不再被 STUCK-ZONE cancel/restart。
- **观测**: ✅ `watchdog.ps1` scriptblock parse 通过。07:14 枚举确认旧 `15492 -File watchdog.ps1` 与新 `26196 -File C:\...\watchdog.ps1` 双 watchdog；精确停止旧 15492 后只剩一个。补 singleton 后重启为 PID `11576`，35s 观察窗 `heartbeat_lines_delta=1`，`fresh_status=live`，端口 `agentWs/mindserver/minecraftLan=open`，当前位置仍 `pos=23,83,34 hp=7 food=4 skill=missionNether mob=POCKET`。
- **回滚**: protected hold 分支恢复 `continue`；singleton 删除相对 `-File watchdog.ps1` 匹配，仅按绝对路径去重。

## C142. prepNether 夜间 bunker 在 body-budget contained hold 中先原地封顶，不再默认 digDown 下沉（③层 prepNether.js，部分验证）
- **触发**: C141 重启后，22:55-22:57 没再出现新的 `Pocketed — carving a step out.`，但到 dusk/night，`prepNether` 在 `pos=23,87,34 hp=7 food=4 mob=POCKET` 写 `★DUSK critical snackless shelter` 后执行 `skills.digDown(bot, 2)`，挖掉脚下 `cobblestone@23,85,33`，从 y87 下沉到 y86；随后又在 `night-bunker` 中挖 `cobblestone@23,84,33`、放 `dirt@23,87,33/@23,86,33`、再挖 `cobblestone@23,83,33`，最终 y83。它不是 POCKET step-out，但仍是低血低粮无食物时由策略层扩大动作面的坏路线。
- **机理**: 夜间 bunker 只看 `coveredAbove()`；只要头顶 1-3 格没有方块，就先 `digDown(2)` 再尝试封顶。它没有利用 mobility 的 POCKET/封闭事实，也没有在已有大量 dirt/cobblestone 时优先原地补顶，导致“为了安全”先破坏脚下、制造下沉和不稳定 body。
- **改动**: 新增 `bodyBudgetBunkerHold()` 和 `containedMobility()`。若 `hp<=8 && food<=6 && 无正常食物` 且 mobility 为 `POCKET/ENC/MAROONED/ENTOMBED` 或 enclosed，bunker 分支先尝试用 dirt/cobblestone 等在当前位置 y+2/y+3 补顶；随后记录 `body-budget contained bunker ... no digDown` 并持有，不再调用 `digDown(2)`。普通非 contained/exposed 夜间地表仍保留原有 digDown shelter。
- **预测**: 当前夜间 `POCKET hp=7 food=4` 热重挂后，不应再出现新的 `★dug-in bunker ...` 或 prepNether 低血低粮 digDown；可出现 `bunker already covered`、`body-budget contained bunker ... no digDown`、`self_preservation sealed night hold`。若不在 contained 状态或没有身体预算风险，原夜间 shelter 行为不变。
- **观测**: ⚠️ `node --check bots/_supervisor/skills/prepNether.js` 通过。23:02:40 通过 inbox 发 `cancel_skill` 热重挂，bridge 回 `cancel_result ok running=missionNether`；23:03:25 重新进入 `prepNether` 后现场已是 `covered=true/y83`，所以命中 `bunker already covered — skip water relocation and hold y=83`，之后只见 `NO-REGEN static kit check/result` 与 `self_preservation night bunker dwell`，未再出现新的 `★dug-in bunker`、prepNether digDown 或 y 坐标下沉。由于补丁前一轮已经把当前位置封住，本次验证了“不继续下沉”，但 `body-budget contained bunker ... no digDown` 原地封顶分支仍需下一次未封顶 contained 现场完全命中。
- **回滚**: 删除 `bodyBudgetBunkerHold()`、`containedMobility()`、`sealCurrentRoof()` 和对应 body-budget contained 分支，恢复 `coveredAbove()` 失败后直接 `digDown(2)`。

## C141. POCKET/ENTOMBED no-regen gate 直接识别 body-budget，不再在白天冷却空窗挖 step-out（①层 modes.js，已验证）
- **触发**: C140 稳住 watchdog 后，白天 `prepNether/feedUp/surfaceUp` 从 `21,70,25 hp=7 food=5` 向上 forage，最终 `pos=23,87,34 hp=7 food=4 mob=POCKET`。`feedUp` 未找到动物/鱼/食物，只因 local-only stop 停下；随后在 22:48:31-22:48:38，POCKET 分支连续写 `Pocketed — carving a step out.` 并挖 `stone@24,88,33`、`stone@22,88,33`、`dirt@23,88,34`、`stone@23,88,32`。这是低血低粮无食物时把自己重新拆开的坏动作。
- **机理**: `noRegenSafeAirHold()` 只在 `prepLow/prepSurface/isNight/survivalSkill` 命中时返回 hold；白天 feedUp/surfaceUp 结束后，prep cooldown 和 skill 名之间存在短空窗，即使 `hp<=8 && food<=6 && 无正常食物`，也会返回 `null`，让 POCKET step-out 接管身体。它还把 10 格内任意远距敌对都当作 hold 失效，和 C138/C139 的贴脸威胁判据不一致。
- **改动**: `noRegenSafeAirHold()` 新增 `bodyBudgetHold = hp<=8 && food<=6`，只要无正常食物、脚/头空气、非水火坠落、无贴脸敌对，就算白天且没有 prep cooldown，也持续 hold，不进入 step-out dig；敌对阈值改为普通敌对 `<4.25`、creeper `<5.5`。POCKET gate 日志增加 `bodyBudget=true/false`。
- **预测**: 当前 `POCKET hp=7 food=4` 重启后应只写 `POCKET no-regen gate ... bodyBudget=true ... hold, no step-out dig`，不再出现新的 `Pocketed — carving a step out.` 或低血低粮 POCKET dig/place；若贴脸怪、水火/坠落、已有正常食物或血粮预算恢复，则 gate 释放。
- **观测**: ✅ `node --check src/agent/modes.js` 通过。精确停止旧 agent core PID `8765=29280`、`48909=41148`，保留 Minecraft LAN `55916=8620`；watchdog 拉起新 PID `8765=15196`、`48909=40816`。22:55:01 bridge 重连后 fresh_status live，`pos=23,87,34 hp=7 food=4 mob=POCKET`。22:55:31、22:56:01、22:56:31、22:57:01 均写 `POCKET no-regen gate ... bodyBudget=true ... hold, no step-out dig`；22:57:31 在 `prepLow=0s night=true` 时仍 hold。`mine_motion` 在重启后的 POCKET 分支无 step-out dig/place；后续 y87→y83 位移来自 C142 的 prepNether night-bunker digDown，不是本 gate 失效。
- **回滚**: 删除 `bodyBudgetHold` 条件、贴脸敌对阈值和 POCKET 日志字段，恢复只依赖 prep/night/survival skill 的 no-regen gate。

## C140. 外部 watchdog STUCK-ZONE 识别 sealed body-budget hold，不再把合法静止 cancel/rearm（watchdog.ps1，已验证；C143 修正循环收尾）
- **触发**: C139 验证后，agent 内部 pin-breaker 已写 `pinned body-budget contained hold exempt`，overseer 也输出 `sealedBodyBudgetHold:true directive:null`，但 detached `watchdog.ps1` 仍在 22:36:34 发 `STUCK-ZONE within 10b for 10min`，把 `missionNether` cancel/rearm。现场 `act_trace` 为 `ctrl=- path=0 dig=-`、`pos=21,70,25 hp=7 food=5 mob=FREE/ENC`，这是有意 sealed hold，不是 entrapped dead task。
- **机理**: PowerShell watchdog 的 `$noRegenHold` 只认 `hostiles=0` 且依赖被截断的 `$progLast` 匹配旧字符串；当前有 10-14 格远距怪、progress 最新常是 `covered night hold` 或 `static kit`，所以 watchdog 没吃到 C138/C139 的封闭持有事实。它是外部控制流，绕过 agent 内部仲裁，形成第 5 类抢身体源。
- **改动**: `watchdog.ps1` 的 heartbeat `vitStr` 增加 `mob={vit.mob}`；STUCK 检测新增 `$sealedBodyBudgetHold`：`skill=missionNether && hp<=8 && food<=6 && 无正常食物 && (vit.mob 含 ENC/POCKET/MAROONED/ENTOMBED 或 fresh advisory.sealedBodyBudgetHold=true)`，命中时同 night/no-regen hold 一样重置 anchor，不发 `STUCK-ZONE`、也不走 25min restart。注意最初实现用了 `continue`，C143 已改为不跳过循环收尾。
- **预测**: 当前 `FREE/ENC hp=7 food=5` 持有窗口内，新的 detached watchdog heartbeat 应持续包含 `mob=FREE/ENC`，10 分钟后不得再出现新的 `sent_control cancel_skill reason=STUCK-ZONE within 10b`。若 sealed 条件消失、贴脸威胁导致 bot 真卡住或不再 missionNether，则 STUCK-ZONE 仍保留。
- **观测**: ✅ `[scriptblock]::Create((Get-Content watchdog.ps1 -Raw))` 通过。06:38 精确停止旧 watchdog PID `34612` 并 hidden 启动新 watchdog PID `21116`；fresh_status live。新 heartbeat 行已写 `mob=FREE/ENC`；到 22:48 以后已跨完整 10min anchor 窗口，未新增 `STUCK-ZONE` 或 `sent_control cancel_skill reason=STUCK-ZONE within 10b`。随后 bot 白天转入 surface/feedUp 暴露的是 C141 的 POCKET step-out 空窗，不是 watchdog 误 cancel。
- **回滚**: 删除 `$sealedBodyBudgetHold`、fresh advisory 读取、`vitStr` 中的 `mob` 字段，恢复 `$nightHold -or $noRegenHold` 作为唯一 STUCK 豁免。

## C139. sealed body-budget hold 下 overseer/missionNether 不再把远距怪误判为 evac（②层 overseer.mjs + ③层 missionNether.js，已验证）
- **触发**: C138 后现场 live 稳定在 `pos=21,70,25 hp=7 food=5 mob=FREE/ENC`，`mine_motion` 无新动作；但 `advisory.json` 仍写 `risk=89 directive=evac reason=3 hostiles, mobs gathering, ENGAGED, hp 7, food 5`，实际最近怪在 11-15 格外，bot 有顶/封闭且无正常食物。该 advisory 虽然当前因 armed 没触发 40b sprint，但会污染 LLM/监控，并在 unarmed 或旁路条件下重新拆开安全地堡。
- **机理**: overseer 只有雷达/血粮/engaged 视角，没利用 vitals 里的 `mob=FREE/ENC`；它把远距怪聚集和旧 combat ENGAGED 当作撤离理由，却不知道“低血低粮无正常食物时，封闭不动才是身体预算最优”。missionNether 也缺少对旧/错误 `evac` advisory 的 sealed hold 保险丝。
- **改动**: `overseer.mjs` 读取 `v.mob` 与 inventory，新增 `sealedBodyBudgetHold = hp<=8 && food<=6 && 无正常食物 && (ENC/POCKET/MAROONED/ENTOMBED) && 无贴脸敌对`；命中时 cap risk 到 69、directive 置空、输出 `sealedBodyBudgetHold:true`，且跳过 LLM override。`missionNether` 新增同名判据，若旧 advisory 仍是 `evac`，写 `★ADVISORY evac gated: sealed body-budget hold ... no 40b sprint` 并清掉 adv；本地 unarmed/night EVAC 也用同一 gate。
- **预测**: 当前 sealed hold 不再出现新 `directive=evac` advisory，也不再触发 40b sprint；若普通敌对 <4.25 或 creeper <5.5、受水火/坠落影响，则 sealed gate 失效，保命分支仍可介入。
- **观测**: ✅ `node --check bots/_supervisor/overseer.mjs`、`node --check bots/_supervisor/skills/missionNether.js` 通过。22:31 通过 inbox 热重挂 missionNether，并精确重启 overseer；首轮旧 LLM 还在 `risk=69` 时短暂改回 `evac`，missionNether 正确写 `★ADVISORY evac gated... no 40b sprint`。随后补上 `sealedBodyBudgetHold` 禁止 LLM override，22:33 新 overseer 输出 `risk=69 directive=- (... sealed body-budget hold)`，`advisory.json` 含 `sealedBodyBudgetHold:true`、`directive:null`、`llm:null`；progress 继续 `unstuck no-regen contained hold`，22:33:23 写 `pinned body-budget contained hold exempt... no forced interrupt`，无新 dig/path/place。
- **回滚**: 删除 `overseer.mjs` 中 normal food/mob sealed 判据、risk cap、LLM skip/override gate；删除 `missionNether.sealedBodyBudgetHold()` 与 advisory/local EVAC gate。

## C138. pin-breaker 识别低血低粮封闭持有，不再每分钟强拆 missionNether（①层 modes.js，部分验证）
- **触发**: C137 二次热重挂后，`mine_motion` 已无新 dig/path/place，但 events 仍在 22:13/22:14/22:15 每分钟写 `Pinned 15min+ — kicking the stack (forced interrupt)`，导致 `missionNether` 被 cancel/sticky 重发。当前 `hp=7 food=5`、无正常食物、有顶/封闭、creeper 约 11 格；这是 C134/C135/C137 共同制造的合法 body-budget hold，不是应被 pin-breaker 强拆的卡死。
- **机理**: 旧 pin-breaker 豁免只覆盖 night bunker、food<=2 famine、或依赖 prep backoff 且 12 格内无敌对的 no-regen hold。当前远距 creeper 在 12 格内但不贴脸，self_preservation 已判定 covered hold 更安全；pin-breaker 仍把“有远距怪”当成强拆理由，造成监督层和任务层拔河。
- **改动**: `reflex_watchdog` pin-breaker 新增 `bodyBudgetContainedHold`：`hp<=8 && food<=6 && 无正常食物`，且 covered/enclosed/contained，且无贴脸敌对（普通敌对 <4.25 或 creeper <5.5）、非水火/坠落时，重置 pin window，不发 forced interrupt。命中时低频写 `[reflex_watchdog] pinned body-budget contained hold exempt ... no forced interrupt`。
- **预测**: 当前 `21,70,25 hp=7 food=5` 持有窗口内，5 分钟 pin window 到期时应出现 exempt 日志，而不是 `Pinned 15min+` / `skill_result cancelled=true` / sticky re-arm。若贴脸 creeper、受伤、水火、坠落或 active dig/escape work 卡住，仍允许 pin-breaker 介入。
- **观测**: ⚠️ `node --check src/agent/modes.js` 通过；22:16 精确停止 `48909=44812`、`8765=33460`，保留 MC LAN `55916=8620`，watchdog 35s 后重挂，fresh_status live：`pos=21,70,25 hp=7 food=5 skill=missionNether`。22:18 新 `mine_motion` 写入仅为 `audit.installed`，不是新 dig/path/place。22:18-22:25 跨过新 pin window 后没有新的 `Pinned 15min+`、`skill_result cancelled=true`、sticky re-arm；progress 只见 covered/night bunker hold 与 static kit check。注意这段已进入夜间 bunker，旧 nightBunker 豁免也会生效；C138 的“白天/远距怪 body-budget contained hold”仍交给 heartbeat 在下个白天窗口验证。
- **回滚**: 删除 `bodyBudgetContainedHold`、`closestHostile/closestCreeper/pointBlankHostile` 与 exempt progress 日志，恢复 forced interrupt 判定只看旧四类豁免。

## C137. last-resort BREAKOUT 同步 body-budget famine 门，低血低粮不再继承 pinned 计时后开隧道（③层 missionNether.js，已验证）
- **触发**: C136 热重挂后，`missionNether` 继承旧 `_stagAt` pinned 计时，22:01:51 立即触发 `★BREAKOUT: pinned 4min — tunneling toward anchor dir=0,1`。当时 `hp=7 food=5`、无正常食物、creeper 约 8-10 格；旧 gate 只挡 `famineCritical(food<=2)` 或 `noRegenNoFood && hostilesNear(10)===0`，所以有远距怪时反而放行 tunneling。
- **机理**: BREAKOUT 是最后手段，但在 no-regen body-budget 窗口里，隧穿本身会消耗饱食/位移并打开未知空间；远距 creeper 已由 self_preservation 的 covered hold 管住，不该让任务层用“有怪”作为开挖理由。
- **改动**: `missionNether` 新增 `bodyBudgetFamine()`，在 BREAKOUT 入口优先判断 `hp<=8 && food<=6 && 无正常食物`，命中后清 pathfinder/control，写 `★BREAKOUT gated: body-budget famine ... no tunneling/sprint`，等待 10s 并继续。底部 famine backoff 复用同一口径但保留局部变量名避免遮蔽。
- **预测**: 当前/同类 `hp=7 food=5` 窗口不得再出现新的 `★BREAKOUT: pinned 4min` 后续 dig；只应看到 prepNether famine gate + 30s body-budget hold。若之后贴脸伤害/水火/坠落，仍由 self_preservation/mobility 保命，不走任务层隧穿。
- **观测**: ✅ `node --check bots/_supervisor/skills/missionNether.js` 通过。第一次 22:02 热重挂后的“未再 BREAKOUT”判断被旧实例/旧 pinned 计时打脸：22:06 又出现一次旧 BREAKOUT，从 `29,70,25/26` 继续隧穿到 `21,70,25`，`mine_motion.jsonl` 最后旧运动事件停在 22:06:50。随后 22:09:10 再次通过 inbox `cancel_skill reload missionNether C137 patched bodyBudget breakout gate` 强制释放旧实例，event 确认 `cancel_result ok=true running=missionNether`、22:09:20 sticky 重进。22:09:20-22:12:08 跨过 pinned 窗口只看到 prepNether 静态 kit check 与 `[unstuck] no-regen contained hold`，无新 `★BREAKOUT`/dig/path/place；fresh_status live，`hp=7 food=5 pos=21,70,25` 稳定。
- **回滚**: 删除 `bodyBudgetFamine()` 与 BREAKOUT 入口 gate，底部变量名可恢复为 `bodyBudgetFamine` 局部。

## C136. missionNether 对 prepNether 的 famine body-budget 返回做 30s 背压（③层 missionNether.js，已验证）
- **触发**: C135/C134 后身体已经不再乱动，但 `missionNether` 仍每 3 秒调用一次 `prepNether`，每轮都写 `FAMINE gate — no edible food and food=5, hp=7`。这不烧身体，但淹没实时信号，也让 pinned 计时更容易在 reload 后立刻触发。
- **机理**: `prepNether` 的 famine body budget 是 `hp<=8 && food<=6 && 无食物`，而 `missionNether` 底部只在 `food<=2` 才拉长 backoff。两个层的饥荒口径不一致，导致任务层把“应保存身体”的返回当成普通失败重试。
- **改动**: `prepNether` 返回后，若 `hp<=8 && food<=6 && 无正常食物`，mission 写 `FAMINE backoff ... body-budget hold`；夜间或 16 格内有敌对时等待 30s，白天无压力时等待 10s。
- **预测**: 当前夜间 `hp=7 food=5 hostiles16>0` 不应再每 3 秒刷 prepNether；应改为约 30 秒一次。food/hp/pos 不应在 hold 中下降或移动。
- **观测**: ✅ `node --check bots/_supervisor/skills/missionNether.js` 通过。22:01 通过 inbox 热重挂；C136 首次重进先暴露 C137 BREAKOUT 漏门。C137 二次热重挂后，missionNether 不再 3 秒热循环 prepNether；22:09:20 之后只按长间隔重入静态 kit/famine 检查，期间由 C134/C135 的 hold 负责身体保护，`hp/food/pos` 未继续因任务层背压不足而下降或抖动。
- **回滚**: 删除底部 `bodyBudgetFamine/bottomBodyBudgetFamine` 判断，恢复仅 `food<=2 && !edible` 时 backoff。

## C135. 远距 creeper + covered lowhp/no-food 时不再后退烧饱食（①层 modes.js，已验证）
- **触发**: C134 重启后 live `hp=7 food=12→10→6`，进度反复写 `[self_preservation] creeper backoff wedged`。bot 在封闭/有顶盖位置，creeper 约 7.5-9 格，并非贴脸爆炸威胁；self_preservation 的原始后退循环持续抢身体和烧饱食。
- **机理**: 自封/矿洞 covered 状态下，远距 creeper 更像“保持封闭别开口”的威胁；低血无正常食物时，后退/跳跑的成本比收益高。旧逻辑只看 creeper 在扫描范围内，没有把 covered/enclosed 与 no-regen body budget 纳入仲裁。
- **改动**: self_preservation creeper 分支在进入 backoff 前计算 `lowHpNoRegenNoFood` 与 `coveredOrEnclosed`。当 `hp<=8 && food<18 && 无正常食物`、有顶盖/封闭、且 creeper 距离 >5.5 时，清控制/清 pathfinder，写 `creeper covered lowhp hold ... no calorie-burning backoff`，等待 2s 后返回；贴脸 creeper 仍走原保命分支。
- **预测**: 同类 covered lowhp 场景不应再出现 `creeper backoff wedged` 连续刷屏或 food 下降；应出现 `creeper covered lowhp hold`，位置稳定。
- **观测**: ✅ `node --check src/agent/modes.js` 通过。21:49 精确停止 `48909=19192`、`8765=40108`，watchdog 重挂为 `48909=34032`、`8765=36832`，LAN `55916=8620` 未动。重启后 progress 连续写 `creeper covered lowhp hold... no calorie-burning backoff`，food 在旧 BREAKOUT 后稳定为 5，未再见远距 backoff wedged；22:09 二次重挂后只剩 no-regen contained hold/静态 kit 检查，没有 self_preservation 继续后退烧饱食。
- **回滚**: 删除 creeper 分支中的 `lowHpNoRegenNoFood/coveredOrEnclosed` early return，恢复原 backoff。

## C134. pathfinder item/POCKET 失败不再落到随机 unstick/GoalInvert（①层 skills.js，已验证）
- **触发**: C131 后仍在 `mine_motion` 看到 21:34 `path.unstick`：`GoalFollow item` 在 `hp=7 food=15`、无正常食物时失败后进入随机 unstick。之后 21:54 又由 `unstuck` mode 触发 `GoalInvert(GoalNear current)`，选中 destructive path 并在 POCKET 中挖 `stone@29,74,13`。
- **机理**: C131 只挡了封闭/矿洞技能内的随机 unstick；低血 no-regen 的 item pickup 与 always-mode `unstuck -> moveAway(5)` 仍会绕过任务层保护。POCKET 中的 `GoalInvert` 看似“离开当前位置”，实际会让 pathfinder 为逃离而乱挖。
- **改动**: `skills.js` 把 `shouldAvoidRandomUnstick` 扩成 `randomUnstickSkipMode(bot, goalInfo)`，对 `MAROONED/POCKET/ENTOMBED`、封闭矿洞、低血无正常食物的 item pickup 返回具体 mode，并在 path failure/stuck 时写 `path.unstick.skipped`。`modes.js` 新增 `lowHpNoRegenContainedHold()`，`unstuck` mode 在 `hp<=8 food<18 无正常食物` 且 POCKET/封闭/有顶盖、无贴脸威胁/水火/坠落时，清 pathfinder/control，写 `unstuck no-regen contained hold... suppress moveAway/GoalInvert`，不再调用 `skills.moveAway(5)`。
- **预测**: 同类场景不得再出现新的 `GoalInvert` destructive path 或 `path.unstick` 随机跳跑；`mine_motion` 应只保留 audit/skip/hold，无新 dig/path/place。
- **观测**: ✅ `node --check src/agent/library/skills.js` 与 `node --check src/agent/modes.js` 通过。21:47 精确重启加载 `skills.js`，21:57 再精确重启加载 `modes.js`；当前 live 三端口 open。22:09 二次释放旧 missionNether 实例后，`mine_motion.jsonl` 最后写入停在 22:06:50 的旧 BREAKOUT 尾声，之后无新 dig/path/place；`progress` 只剩 prepNether 静态检查与 `unstuck no-regen contained hold... suppress moveAway/GoalInvert`。C134 的 item/POCKET random unstick/GoalInvert 入口未再复发。
- **回滚**: `skills.js` 恢复原 `shouldAvoidRandomUnstick()` 与 `path.unstick` 分支；`modes.js` 删除 `lowHpNoRegenContainedHold()` 及 `unstuck` early return。

## C133. feedUp 掉落物命名与叶扫后拾取可诊断（③层 feedUp.js，热加载）
- **触发**: C132 把 bot 推到树冠附近后，`feedUp` 扫了 39 片 oak leaves 仍没回血；后续 `food_scan` 只写 `drop32=item@1`，无法判断脚边到底是 apple、sapling 还是别的掉落，也看不到 `fetchFoodDrop()` 是因为非食物、敌对威胁、还是拾取失败而返回。
- **机理**: 旧 `foodScan()` 对 item 实体只输出通用 `item@dist`；`fetchFoodDrop()` 找不到食物掉落或被 close hostile 拦截时静默 false。叶扫结束后虽然调用 `pickupNearbyItems()`/`eat()`，但没有记录附近剩余掉落和背包可吃物，导致“扫叶失败”不可归因。
- **改动**: 新增 `droppedItemName()/isFoodDrop()/nearbyDropsSummary()`，`drop32` 改为写真实掉落名如 `oak_sapling@1`/`apple@2`。`fetchFoodDrop()` 对脚边非食物掉落写 `PlanC drop nearby but not food ...`，对 close hostile 拦截写 `PlanC food drop blocked...`，对食物掉落拾取写 held food 摘要。`appleLeafSweep()` 在最终 pickup/eat 后若仍无食物，记录 `PlanD leaf sweep drops after pickup ... invFood=...`。
- **预测**: 下一次叶扫后如果掉的是 sapling，应明确看到 `oak_sapling@...` 而不是裸 `item@...`；若掉 apple 且 2 格内，应看到 `PlanC food drop pickup attempted apple@...` 或 `invFood=apple`，并随后 `eat()` 提升 food。若 close hostile 阻止远处食物掉落，应有明确 blocked 日志。
- **观测**: 🟡 `node --check bots/_supervisor/skills/feedUp.js` 通过。21:39 通过 supervisor inbox 追加 `cancel_skill reload feedUp C133 named drop telemetry`，夜门收到 `supervisor cancel observed`，mission 释放 run_skill lock；当前 live `pos=31,82,14 hp=7 food=14 mob=POCKET`，夜间 covered hold，等待天亮后下一次 feedUp/leaf sweep 现场验证。
- **回滚**: 删除 `FOOD_DROP_RE/droppedItemName/isFoodDrop/nearbyDropsSummary` 及 `PlanC drop nearby/food drop blocked/leaf sweep drops after pickup` 相关日志，恢复 `foodScan()` 输出通用 `item@dist`。

## C132. food=11/hp=7 的腐肉 no-regen 死角与一次性近树上探（③层 prepNether.js + feedUp.js，已验证部分有效）
- **触发**: C131 reload 后 live 长时间停在 `hp=7 food=11 no normal food`，背包仅有 `rotten_flesh=1`。旧 `prepNether.keepFed()` 只在 `food<=10 && hp<=10` 吃腐肉；`feedUp.emergencyJunk()` 又因 `food>10` 直接返回，形成“差 1 点食物就不吃、又不能回血、也不敢下矿”的死结。与此同时同一棵 `oak_log@5 dy=3` 已被 C130 证明不可达并处于 backoff。
- **机理**: Minecraft 自然回血需要更高 food；`food=11/hp=7` 虽然不算极限饥饿，但仍是 no-regen 低血。腐肉是有副作用的紧急食物，旧阈值把它当作 only food<=10 的最后手段，错过了让 bot 获得一点移动/上探预算的窗口。
- **改动**: `prepNether.keepFed()` 在 `food<=11 && hp<=8 && !hasEdible()` 时允许吃 `rotten_flesh/spider_eye`；吃完若仍未达到 `food>=18/hp>=14/有正常食物`，不放行下矿，而是继续走 food route。若刚吃过 emergency junk、food>=14、hp<=8、白天安全且同一 oak 正在 backoff，则允许一次 `boosted oak climb probe`: 先 `surfaceUp` 到当前 y+6，再只调用一次 `feedUp(18)` 扫近树叶，失败后恢复 hold。
- **预测**: 当前 `food=11 hp=7 rotten_flesh=1` 应立即出现 `prepNether: emergency food — eating rotten_flesh...`，food 提升后不得直接恢复 mining；若近树 backoff 仍在且白天无敌，应出现一次 `boosted oak climb probe`，成功则吃苹果/回血，失败则 `resume hold`。
- **观测**: ⚠️ 21:34 现场验证：`emergency food — eating rotten_flesh before movement (food=11 hp=7)` 后 food 11→15；随后 `boosted oak climb probe ... surfaceUp target=87` 成功从 y81 到 y87 并触发 `feedUp: targeted oak forage oak_leaves@2 dy=1`，扫叶 `reachable=43 broken=39`。未掉苹果，food 随后降到14/hp仍7，日志正确写 `boosted oak climb probe found no recovery; resume hold`，没有回到盲下矿。部分有效：解开 food=11 阈值死角并安全上探，但该区域仍无稳定食物来源。
- **回滚**: `prepNether.keepFed()` 腐肉门恢复 `food<=10 && hp<=10`；删除 `_prepEmergencyJunkAteAt/_prepBoostedOakClimbUntil` 与 boosted oak climb probe；`feedUp.emergencyJunk()` 恢复 `bot.food > 10 || bot.health > 10` 直接返回。

## C131. 矿洞移动只走结构化步骤，台阶辅助先判阻塞并冷却失败目标（①层 skills.js + ③层 branchMine.js，待重启观测）
- **触发**: 用户点名“矿洞里挖砖块路线、垫砖块时机糟糕”，并要求若无全量轨迹就记录每次操作所处方块、目标方块、周围图景与结果。当前 live 仍在 `hp=7 food=11 pos=30,81,3` 夜间 hold；历史 `mine_motion` 已有 dig/place 的 env，但路径/台阶移动仍暴露两类问题：① `skills.stepEdgeAssist()` 对候选失败只写 `step_edge.none`，看不到每个候选为何被拒；② 公共路径失败后会落到随机 `attemptUnstick()`，在封闭矿洞/ENTOMBED/branchMine 中可能把 bot 随机带偏；③ `branchMine` 下行楼梯的 clear 阶段还直接 `bot.dig()` 并吞异常，step assist 失败后还会盲目 forward+jump。
- **机理**: 上坡卡边缘不是单纯“跳得不够”，常见是目标格本来就不是可进入的一格台阶：目标脚/头/上方被堵、功能站点、危险块、或上一次失败的同一目标。旧公共辅助没有把这些结构性拒绝变成冷却事实，路径层又会用随机 unstick 补救，导致同一墙面/边缘反复触发。`branchMine` 绕过自身 `digBlock()` 时，也绕过了 tool/reach/body-lock/失败归因。
- **改动**: `skills.stepEdgeAssist()` 增加结构化候选审计：`step_edge.blocked` 记录自身头/上方阻塞，`step_edge.none` 记录最多 6 个 rejected candidates 及 `front-not-step/target-foot-blocked/target-head-blocked/functional-station/hazard/cooldown`，成功候选写 `from/target/foot/head/above/below`，失败或异常对同一目标冷却 8s 并在 `step_edge.end` 记录最终目标格四邻状态。公共 `goToGoal()` 在 `branchMine/surfaceUp/mineDiamonds/prepNether/missionNether`、封闭或 `MAROONED/POCKET/ENTOMBED` 时，若 step-edge 不适用，改写 `path.unstick.skipped mode=enclosed-mining`，不再随机跳跑。`branchMine` 下行楼梯改用 `digBlock()` 清脚/头/头顶格，清格失败立即 `branchMine.descent.stop clear-*`；`stepInto()` 的 step-edge 失败后只写 `branchMine.step.rawHop.skipped`，不再盲目 forward+jump。
- **预测**: 下一次矿洞/上坡失败时，`mine_motion` 应能直接读出：当前格、目标格、目标脚/头/上方、每个候选为何被拒、是否冷却、最终是否进入目标格。封闭矿洞内不得再出现 `path.unstick` 随机跳跑；应出现 `path.unstick.skipped`。`branchMine` 下行若遇到不可挖/工具不足/并发锁，应停在 `branchMine.descent.stop clear-*`，不得吞异常后继续走。上坡同一失败目标 8s 内不应反复冲跳。
- **观测**: ⚠️ `node --check src/agent/library/skills.js` 与 `node --check bots/_supervisor/skills/branchMine.js` 通过。21:28 按精确 PID 只停止 `48909=9024`、`8765=45780`，watchdog 于 21:28:50 重新 `bridge_connected` 并重发 sticky `missionNether`；fresh_status 回到 `classification=live` 且三端口 open，`mine_motion` 写出 21:28:48 新 `audit.installed`。21:36:47 首个新样本：`step_edge.begin` 在 `pos=30.5,86,13.538` 识别 `target=30,86,14 step=grass_block foot/head=air`，`step_edge.end ok=true y=86.00->87.25 targetDist=0.73`，证明台阶边缘辅助能把上坡卡边缘转为结构化一步。21:37:40 又见 `structural skip backoff reason=target-foot-blocked count=2 guard=5s target=30,85,12`，证明重复阻塞目标已有迟滞。branchMine/descent 仍待下一次下矿验证。
- **回滚**: 删除 `stepEdgeAssist` 中 rejected/cooldown/blocking audit 和 `targetBlocks` 记录；删除 `shouldAvoidRandomUnstick()` 与两处 `path.unstick.skipped` 分支；`branchMine` descent 恢复直接 `bot.tool.equipForBlock()+bot.dig()`，`stepInto()` 恢复 step assist 失败后的 forward+jump fallback。

## C130. oak/apple 不可达退避落到 supervisor 锚点，core reload 后不再忘记同一棵树不可达（③层 prepNether.js + missionNether.js，待热加载观测）
- **触发**: C128 已证明 21:06 同一 `oak_log@5 dy=3` 的叶子不可达，并设置 300s 退避；但 21:12 为加载 C129 精确重启 core 后，`bot._prepOakApplePulseBackoffUntil` 作为内存字段丢失，`missionNether/prepNether` 又立刻跑了一次相同 bounded oak pulse。该脉冲仍无 `dig/place/path` 副作用，但证明“这棵树不可达”的记忆没有跨 core reload。
- **机理**: C128 的退避只存在 bot 进程内存；skill 热重挂通常还在同一 bot 对象中，core reload 则会丢失。mission 层的 `boundedOakAppleReady()` 也只看内存 backoff，重启后会提前清掉 surface/no-food stand-down，让 prep 再次进入同一不可达 oak pulse。
- **改动**: 新增 supervisor 锚点文件 `bots/_supervisor/oak_apple_backoff.json`。`prepNether` 在 leaf sweep 结果 `reachable=0` 或 `broken=0` 时写入 `{until,target,reachable,broken,nearest}`；之后读取该文件并且只有当前 oak 目标签名一致时才恢复 backoff。`missionNether.boundedOakAppleReady()` 也读取同一文件，签名一致且未到期时不再把 oak 视为 ready。
- **预测**: 下一次不可达 oak pulse 后应创建 `oak_apple_backoff.json`；若随后 hot reload/core reload 发生，在到期前同一 `oak_log@5 dy=3` 只应写 `bounded oak/apple forage backoff ...`，不得再次进入 `feedUp: START`。如果 bot 移动到另一棵不同签名的 oak，则不被旧锚点挡住。
- **观测**: ✅ `node --check bots/_supervisor/skills/prepNether.js` 与 `node --check bots/_supervisor/skills/missionNether.js` 通过。21:19 通过 supervisor inbox `cancel_skill` 热重挂，events 显示 `cancel_result ok=true` 且 sticky `missionNether` 已重发；fresh_status 仍 `classification=live`，三端口 open。21:26 天亮后不可达 oak pulse 创建 `oak_apple_backoff.json`，内容含 `until=1781299876425 target="oak_log@5 dy=3" reachable=0 broken=0 nearest=oak_leaves@27,85,1`。随后 21:28 core reload 加载 C131；新栈在 21:28:54 对同一 oak 只写 `bounded oak/apple forage backoff 143s for oak_log@5 dy=3`，未再次进入 `feedUp: START`，证明 supervisor 锚点跨 core reload 生效。
- **回滚**: 删除 `OAK_APPLE_BACKOFF`、`readOakAppleBackoff()`、`writeOakAppleBackoff()` 及两处读取/写入逻辑；恢复仅使用 `bot._prepOakApplePulseBackoffUntil`。

## C129. step-edge 对同一结构性阻塞格子加迟滞，避免把两格高墙当台阶高频触发（①层 modes.js，待重启观测）
- **触发**: 历史 `mine_motion` 中 `step_edge.skip reason=target-foot-blocked` 高频重复：20:29 在同一位置 `pos=27.3,82,10.5` 连续多次尝试同一 `targetCell=27,82,9`，`step=stone@27,82,9` 但 `targetFoot=grass_block@27,83,9`，这是两格高/低顶阻塞，不是可跳上的一格台阶。20:46 也有 `ENTOMBED` 后 `target-foot-blocked` 样本。旧逻辑每 2.5s 重新报一次同一格子，造成“台阶边缘高频卡住/抽搐”的现场感。
- **机理**: step-edge always-mode 只在候选无效时写 `step_edge.skip` 并设置固定 2.5s guard；它没有记住“同一目标格 + 同一阻塞块组合”已经被判定为结构性非台阶。于是路径/移动状态还在时，下一轮仍以同一墙面作为候选，反复抢 unstuck 判定，而不是把问题交回路径规划或挖掘规划。
- **改动**: `modes.js` 新增 `step_skip_key/first_at/count/last_log_at`。当 skip reason 属于 `target-foot-blocked`、`target-head-blocked`、`own-head-blocked`、`own-above-blocked` 或 `front-functional-station`，且 20s 内重复命中同一目标格/方块组合时，将 guard 从 2.5s 逐步拉长到最多 15s。`mine_motion.step_edge.skip` 追加 `skipCount/guardMs`；每 10s 最多写一次 progress `structural skip backoff ...`。
- **预测**: 重启后同类墙面不应再每 2-3 秒刷 `step_edge.skip`；第二次起应看到 `guardMs=5000/7500/...` 或 progress `structural skip backoff`。真正可上台阶的 `step_edge.begin/end` 不受影响；功能站点仍被过滤。
- **观测**: 🟡 `node --check src/agent/modes.js` 通过。21:12 按精确 PID 只停止 `48909=6356`、`8765=13296`，watchdog 于 21:12:44 bridge_connected 并重发 sticky `missionNether`；fresh_status 回到 `classification=live` 且 `agentWs/mindserver/minecraftLan=open`，`mine_motion` 写出 21:12:44 新 `audit.installed`，证明 C129 已加载。当前低血无食物 hold 未再触发 step-edge，等待下一次 `target-foot-blocked` 复现验证 `skipCount/guardMs`。
- **回滚**: 删除 `step_skip_*` 状态字段及 skip 分支中的 repeat key/guardMs/backoff progress 逻辑，恢复固定 2.5s guard。

## C128. bounded oak/apple pulse 记录叶子扫掠结果，近树不可达时延长退避（③层 feedUp.js + prepNether.js，待热加载观测）
- **触发**: C127 reload 后，20:51-20:54 多次出现 `prepNether: bounded oak/apple forage — oak_log@5 dy=3; direct feedUp pulse...`、`feedUp: targeted oak forage ... noRegen=true` 与 `no-regen pulse stops after bounded leaf sweep`，但 `mine_motion` 在 20:50:59 的新 `audit.installed` 后没有任何新的 `dig.begin/place.begin/path.begin`。也就是说日志声称 sweep 结束，真实身体却没有产生可核验动作；这正是“没有全量轨迹+操作结果时很难判断路线/垫块时机”的盲区。
- **机理**: `prepNether.oakAppleForageSignal()` 接受 12 格内、`dy<=6` 的橡树信号；`feedUp.appleLeafSweep()` 实际只处理 5x5 附近、距离约 4.5、`maxUp<=4` 的可触达叶子。当扫描不到可达叶子时函数直接 `return false`，没有记录最近叶子、可达数、破坏数；`prepNether` 只能按 90s 短 backoff 重复同一套空脉冲。
- **改动**: `appleLeafSweep()` 每次扫描都写 `bot._feedUpLastLeafSweep={base,reachable,broken,maxUp,nearest}`；无可达叶子时显式记录 `PlanD leaf sweep no reachable leaves ... nearest=...`，有可达叶子时更新实际破坏数。no-regen oak pulse 的停止日志附带 `reachable/broken`。`prepNether` 在 direct `feedUp` 返回后读取该结果：若 `reachable=0`，把 oak pulse backoff 延到 300s；若可达但 `broken=0`，延到 180s，并记录最近叶子与退避时长。
- **预测**: 下一次 bounded oak/apple pulse 必须产出可核验扫掠结果。若周围橡树只是 5-12 格/高差过大而不可达，应看到 `reachable=0 broken=0 nearest=...` 与 `oak pulse backoff 300s`，后续 90s 内不再重复同一空脉冲。若叶子可达，应看到 `PlanD leaf sweep — breaking up to ...` 和 `broken>0`，再根据是否掉苹果继续决策。
- **观测**: ✅ `node --check bots/_supervisor/skills/feedUp.js` 与 `node --check bots/_supervisor/skills/prepNether.js` 通过。21:01 通过 supervisor inbox `cancel_skill` 热重挂 `missionNether`；fresh_status 保持 `classification=live`，三端口 open。21:06 黎明后第一次 bounded oak pulse 写出 `feedUp: PlanD leaf sweep no reachable leaves maxUp=4 nearest=oak_leaves@5 dy=4 27,85,1`，随后 `targeted oak forage ... reachable=0 broken=0`，`prepNether` 记录 `no real leaf action ... oak pulse backoff 300s`。`mine_motion` 最新动作仍停在 20:50:59 的 `audit.installed`，未新增 `dig.begin/place.begin/path.begin`，证明该脉冲现在是可观测的 no-op 且不会继续 90s 空跑。
- **回滚**: 删除 `bot._feedUpLastLeafSweep` 写入、`PlanD leaf sweep no reachable leaves` 日志、no-regen 停止日志中的 `reachable/broken`，以及 `prepNether` 中基于 sweep 结果延长 `_prepOakApplePulseBackoffUntil` 的分支。

## C127. ENTOMBED 区分“安全空气袋”和真活埋，no-regen oak pulse 期间不再盲挖侧墙（①层 modes.js，待重启观测）
- **触发**: C126 core reload 后，20:46 `prepNether` 在 `hp=7 food=11 no normal food` 命中 `bounded oak/apple forage — oak_log@5 dy=3` 并调用 `feedUp`。同一时刻 mobility 写 `→ ENTOMBED`，`mine_motion` 记录 `skill=feedUp mob=ENTOMBED` 连挖 `stone@29,82,3` 与 `stone@29,81,3`；环境快照显示脚/头都是 `air`，上方是自封 bunker 的 `cobblestone@29,83,2`，不是窒息，只是安全空气袋被 ENTOMBED 无条件逃生逻辑误判。随后又出现 `step_edge.skip reason=target-foot-blocked`。
- **机理**: C126 只给 POCKET 加了 no-regen body gate；ENTOMBED 分支仍按“活埋必挖”处理，没有区分 head/feet air 的自封坑与真正窒息/水火/坠落。C124/C125 让 oak pulse 在低血无食物窗口调用 `feedUp`，但 mobility always-mode 仍可并发抢 body 先挖侧墙。
- **改动**: 将 POCKET gate 提炼为 `noRegenSafeAirHold()`：`hp<14 && food<18 && 无正常食物`、脚/头都非实心、无水火/坠落/近敌，并且 prep low-hp/surface backoff、夜间、或 `prepNether/feedUp/consume/auto_eat` 正在管生存时返回 hold。ENTOMBED 在 `guardedDig()` 前先调用该 gate，命中则写 `ENTOMBED no-regen safe-air gate ... hold air pocket, no blind dig`，不挖侧墙；真正脚/头被实心堵住或有水火/坠落/敌对时仍允许原逃生。
- **预测**: 重启后，若 `feedUp`/`prepNether` 在同类 sealed bunker 中触发 oak pulse，mobility 可写 `ENTOMBED no-regen safe-air gate`，但不得再出现 `skill=feedUp mob=ENTOMBED` 的 stone `dig.begin`。若 bot 真被方块压头/脚、落水/火、坠落或近敌压迫，ENTOMBED 仍应立即挖出。
- **观测**: 🟡 `node --check src/agent/modes.js` 通过。20:50 按精确 PID 停止 `48909/8765` 后 watchdog 拉起新 core，fresh_status 回到 `classification=live` 且三端口 open；`mine_motion` 在 20:50:59 写新 `audit.installed`，证明 C127 的 `modes.js` 已加载。20:51 再次触发 `bounded oak/apple forage`→`feedUp`，日志只有 `targeted oak forage ... noRegen=true`、`critical local-only stop` 与 `hold body`，未新增 `dig.begin`/`path.begin`。本次没有再次进入 `ENTOMBED`，因此 `ENTOMBED no-regen safe-air gate` 精确日志仍待复现；但已确认 reload 后未重演 20:46 的 `skill=feedUp mob=ENTOMBED` stone blind-dig。
- **回滚**: 删除 `noRegenSafeAirHold()` 中 survivalSkill/safe-air 逻辑及 ENTOMBED 分支 gate；POCKET 可恢复为 C126 的专用 `noRegenPocketHold()`。

## C126. POCKET 在 no-regen 低血 hold 期间不再抢身体挖 step-out（①层 modes.js，待重启观测）
- **触发**: C124/C125 后，bounded oak/apple forage 没掉苹果，`prepNether` 已进入 `hp=7 food=11/12 no normal food` 的 low-hp/no-food hold；但 mobility 仍从 `POCKET` 抢到身体，连续 `step_edge.skip reason=target-foot-blocked step=stone@27,82,9` 后又启动 `GoalInvert(GoalNear...)` 的 destructive 逃离，挖掉 `cobblestone@28,83,10`，把 bot 从 `27,82,10` 拉到 `30,85,5`。这次偶然靠近橡树，但本质仍是低血无回血窗口内的隐式 body 抢占。
- **机理**: `famineBodyFreeze()` 只覆盖 `food<=0` 或极低食物，且 `FAMINE_FOOD_RE` 把 `rotten_flesh/spider_eye` 算作 edible；POCKET 自己的 gate 也只挡 `night && food<=6 && noEdible`。因此 `hp<14 && food<18 && 只有腐肉` 的 no-regen 等待状态不会阻止 POCKET 挖头部/台阶块。
- **改动**: modes 层新增 `NORMAL_FOOD_RE`，把正常可回血食物与应急食物分开。POCKET step-out 前新增 `noRegenPocketHold()`：当 `hp<14 && food<18 && 无正常食物`，且 `_prepLowHpNoFoodUntil` / `_prepNoFoodSurfaceBackoffUntil` 正在生效或夜晚，同时无近敌、非水火、非坠落时，停止 pathfinder/清控制态、续租 POCKET 状态并记录 `POCKET no-regen gate ... hold, no step-out dig`，不再执行 `guardedDig()`。
- **预测**: 重启后，在当前 `hp=7 food=11 no normal food` 且 prep/mission hold 生效的窗口，mobility 不应再出现新的 `POCKET ... carving a step out`、`guardedDig(... POCKET)` 或 POCKET 引发的 destructive `path.begin`；应每 15s 内最多写一次 `POCKET no-regen gate`。若有近敌、水火、坠落，或 backoff 结束且白天无 hold，则不挡真正逃生。
- **观测**: 🟡 `node --check src/agent/modes.js` 通过。20:44 按精确 PID 停止旧 `48909/8765` 后 watchdog 拉起新进程，fresh_status 显示 `classification=live` 且 `agentWs/mindserver/minecraftLan=open`；`mine_motion` 在 20:44:14 写出新 `audit.installed`，证明新 `modes.js` 已加载。随后 25s 观察窗内 bot 保持 `hp=7 food=11 hostiles=0 skill=missionNether` 夜间 hold，未新增 `path.begin`/`dig.begin`/`place.begin`。本窗没有再次进入 POCKET，仍待下一次 POCKET 复现时确认写出 `POCKET no-regen gate`。
- **回滚**: 删除 `NORMAL_FOOD_RE`、`normalEdibleHeld()`、`noRegenPocketHold()` 及 POCKET 分支中的 no-regen gate，恢复 C125 行为。

## C125. bounded oak pulse 与 surface/no-food backoff 解耦，近橡树不再被 180s 盲爬冷却误伤（③层 missionNether.js + prepNether.js，待热加载观测）
- **触发**: C124 首次现场验证成功触发 `bounded oak/apple forage — oak_leaves@6 dy=5; direct feedUp pulse, no surfaceUp blind climb`，`feedUp` 只做 `noRegen=true` bounded leaf sweep 且 `no chop/climb`；但没掉苹果后，mobility POCKET 把 bot 从 `27,83,11` 拉到 `30,85,5`，此时橡树变成 `oak_leaves@3 dy=3`。下一轮 `prepNether` 只剩 `oakPulseBackoff 22s`，却落入旧 `HUNGER/LOWHP gate` 并重新设置 `_prepNoFoodSurfaceBackoffUntil=180s`，导致近在手边的橡树也要等 surface/no-food 长冷却。
- **机理**: C124 的 oak pulse 是短周期、近场、无 `surfaceUp` 的安全试探；而 `_prepNoFoodSurfaceBackoffUntil` 原本用于阻止无食物信号时反复盲爬。两者语义不同，但 `keepFed()` 在 oakPulseBackoff 未到期时继续下落到旧 surface gate，把短冷却升级成 180s 长等待。mission 层又把 surface backoff 作为 stand-down 条件，导致 `prepNether` 不再有机会看到 oak pulse 已 ready。
- **改动**: `prepNether.keepFed()` 在 `oakSignal.ok && oakPulseBackoff>0` 时直接清控制/停 pathfinder/返回 false，不再下落到 surface gate；`missionNether` 新增 `boundedOakAppleReady()`，当 no-regen 低血、白天/黎明、无敌对、近橡树、且 oak pulse 冷却已过时，清掉 `_prepNoFoodSurfaceBackoffUntil` 并让流程落到 `prepNether`，日志写 `stand-down override: bounded oak/apple ready...`。
- **预测**: 如果 bot 仍在 `hp<=8 food<18 no food` 且 `oak_leaves@3 dy=3` 附近，下一次 oakPulse 到点后应跳过 180s surface backoff，直接重试 C124；不得再把 `bounded oak/apple forage backoff 22s` 后的近橡树窗口变成 `surface=177s` 长等待。
- **观测**: ⚠️ `node --check bots/_supervisor/skills/missionNether.js`、`prepNether.js`、`feedUp.js` 通过。20:33 现场验证：surface backoff 还剩 81s 时，流程仍重新进入 `prepNether` 并触发 `bounded oak/apple forage — oak_leaves@3 dy=3`；`feedUp` 写 `PlanD leaf sweep — breaking up to 22 oak leaves for apples stopFood=17`，没有 `surfaceUp`/`chopWood`/长 roam，但随机未掉苹果，food 仍 11。20:34 reload 暴露 oakPulseBackoff 期间 `prepNether` 会被 mission 每 3s 空转调用，已追加 `bot._prepLowHpNoFoodUntil = min(oakPulseBackoff,30s)` 降噪；待下一次 backoff 窗口确认不再热循环。
- **回滚**: 删除 `boundedOakAppleReady()` 与 mission stand-down override；删除 `prepNether` oakPulseBackoff 直接 return，让逻辑恢复到 C124 首版。

## C124. no-regen 低血近橡树时走 bounded apple forage，不再把 oak 信号变成 surfaceUp 盲爬（③层 prepNether.js + feedUp.js，待热加载观测）
- **触发**: C120/C122 后，bot 在 `hp=7 food=12 no normal food` 的 no-regen hold 中反复写 `nearest oak oak_leaves@6 dy=5 is not food-signal`，于是既不空跑 `feedUp`，也不允许 `surfaceUp`。但这类近橡树确实是可验证食物机会；旧逻辑的危险在于一旦把 oak 当作普通 food signal，就会先 `surfaceUp target=y+8`，又回到盲爬/台阶边缘/挖叶路线。
- **机理**: `prepNether.foodSignalBeforeSurface()` 只认动物/鱼/食物掉落/瓜/浆果，橡树只作为 false reason；`feedUp.targetedOakAppleForage()` 又只在 `food<=10` 时触发，导致 `hp<=8 && food=12..17` 这种“有行动预算但无回血”的窗口不会扫叶找苹果。
- **改动**: 新增 `oakAppleForageSignal()`：仅在 `hp<=8 && food<18 && 无正常食物`、白天早段/黎明（非黄昏且 `tod<11000 || tod>=23000`）、主世界、16格无敌对、橡树叶/原木在 `dist<=12 dy<=6` 内时放行。`keepFed()` 命中后直接调用一次 `feedUp(18)`，日志标注 `direct feedUp pulse, no surfaceUp blind climb`，失败则设置短 backoff 并原地 hold。`feedUp.targetedOakAppleForage()` 支持 no-regen oak pulse：允许 `food<targetFood`，限制 `dist<=12 dy<=6`，扫叶停止线升到 `food>17`，只做安全 `safeRoamTo(canDig=false/parkour=false)` + 可触达扫叶，不做 chop/climb；夜晚/黄昏/敌对仍拒绝。
- **预测**: 下一个白天早段若仍有近橡树，应出现 `prepNether: bounded oak/apple forage — ... no surfaceUp blind climb`，随后 `feedUp: targeted oak forage ... noRegen=true`；若扫到苹果，食物应上升并继续恢复路线；若没扫到，日志应写 `no-regen pulse stops after bounded leaf sweep` 或 `found no edible/improvement`，且不得出现同一脉冲引发的 `surfaceUp target=...`、高树 `chopWood` 或新 `destructive-no-plan`。
- **观测**: ⚠️ `node --check bots/_supervisor/skills/prepNether.js` 与 `node --check bots/_supervisor/skills/feedUp.js` 通过。20:29 现场验证：C124 正确触发 `bounded oak/apple forage — oak_leaves@6 dy=5; direct feedUp pulse, no surfaceUp blind climb`，随后 `feedUp: targeted oak forage ... noRegen=true` 与 `no-regen pulse stops after bounded leaf sweep ... no chop/climb`；未出现 `surfaceUp target`、高树 `chopWood` 或新 `destructive-no-plan`。但扫叶没掉苹果，随后暴露出 C125：oakPulseBackoff 被 surface/no-food 长 backoff 误伤，且 mobility POCKET 仍能在低血无食物窗口抢身体挖一块 cobblestone 出 pocket。
- **回滚**: 删除 `oakAppleForageSignal()` 和 `keepFed()` 中 direct feedUp pulse；恢复 `targetedOakAppleForage()` 的 `food<=10` 门槛、`stopFood=10` 与 no-regen no-chop 分支。

## C123. step-edge 不再把工作台/熔炉等功能站点当上坡台阶（①层 modes.js/skills.js + ③层 surfaceUp.js，已重启待复现验证）
- **触发**: C122 成功在 `27,82,11` 本地放置 crafting_table 后，20:06 mobility 从 POCKET 触发 `step-edge assist begin ... target=27,82,11 step=crafting_table foot=air head=air`，随后 `assist end ok=true y=82.00→83.20 dist=0.77`，bot 站到刚放的工作台上。虽然这次成功释放 POCKET，但功能站点被当成坡道/垫脚块会污染工位、造成后续边缘错位，也正中“上坡台阶边缘/垫砖时机糟糕”的问题面。
- **机理**: `modes.js` 的 mobility step-edge、公共 `skills.stepEdgeAssist()`、`surfaceUp` fallback 都只要求 frontFoot 是 solid、上方两格 open、非水火危险；没有区分“地形台阶”和“策略层刚放下的 station”。crafting_table/furnace/chest 等功能方块满足 solid，于是被自动踩踏。
- **改动**: 三处 step-edge 候选都新增 `stationStep()` 过滤，禁止 `crafting_table/furnace/blast_furnace/smoker/chest/barrel/bed/anvil/enchanting_table/grindstone/stonecutter/loom/cartography_table/smithing_table/fletching_table/lectern/composter` 作为 step foot。`modes.js` 的 skip reason 增加 `front-functional-station`，临按前二次验证则写 `functional-station-before-press`。
- **预测**: 重启后，若当前位置/相邻仍有 `crafting_table@27,82,11`，不得再出现以它为 `step=` 的 `step-edge assist begin`；应出现 `step_edge.skip reason=front-functional-station` 或改选其它真实地形台阶。公共 path/surfaceUp 的 step-edge 也不得踩工位。
- **观测**: 🟡 `node --check src/agent/modes.js`、`node --check src/agent/library/skills.js`、`node --check bots/_supervisor/skills/surfaceUp.js` 通过。20:11 按精确 PID 只停止 `48909=44684`、`8765=18984`，Minecraft LAN 保持 open；watchdog 于 20:12 重新 bridge_connected 并发 sticky `missionNether`，fresh_status 回到 `classification=live`、三端口 open。20:12 后 `mine_motion` 只有新 `audit.installed`，尚未再次触发 step-edge；等待下一次卡台阶/POCKET 时验证是否写 `front-functional-station` 或改选真实地形台阶，且不再 `step=crafting_table`。
- **回滚**: 删除三处 `stationStep()` 与相关 skip reason，恢复只按 solid/open/hazard 判断 step 候选。

## C122. no-regen hold 先做本地工作台/石镐，不再被 keepFed 挡在静态自救前（③层 prepNether.js，已验证）
- **触发**: C120/C121 后 bot 停止空跑 feedUp 和 blind-destructive 导航，但 live 卡在 `hp=7 food=12 no normal food`，背包有 `cobblestone=194/oak_planks=6/stick=4/oak_log=2/furnace=1`，却没有 pickaxe/crafting_table。`prepNether` 每轮先 `keepFed()`，命中 `HUNGER/LOWHP gate` 后直接返回，导致后面的 `keepKit()` 永远到不了，本地造台/造镐材料闲置。
- **机理**: `famineStaticKit()` 只覆盖 `food<=2 || food<=6&&hp<=10` 的极限饥荒；当前 hp7/food12 是无回血低血但不算 famine。`keepKit()` 虽然能补 stone_pickaxe，却排在 `keepFed()` 之后；而通用 `craftRecipe()`/`placeBlockNearby()` 可能触发寻路或身位调整，不适合在 no-regen hold 里调用。
- **改动**: 新增 `noRegenStaticKit(reason)`，在 `keepFed()` 判定低血无再生且无正常食物时先执行；同时接入夜间 covered bunker hold，避免夜里一直等到天亮才有机会自救。它记录当前位置、foot/head/under、hostiles8、table/pick/cobble/stick/planksEq；只在站稳、无水火、8格无敌时停 pathfinder/清控制态，使用 `craftRecipeLocal()` 本地做 planks/crafting_table/stick/stone_pickaxe/stone_sword，并依赖可触达工作台放置确认，不调用 `surfaceUp/achieve/goToGoal/placeBlockNearby`。
- **预测**: 下一次 `prepNether` 在当前 hp7/food12/no food 窗口应先写 `NO-REGEN static kit check (night-bunker-covered|keepFed) pos=...`；材料足够时应看到 `NO-REGEN static stone_pickaxe crafted/equipped`，随后仍可 `HUNGER/LOWHP gate` 原地等待食物信号。`mine_motion` 不应因这次静态自救出现新 `path.begin` 或 `selected="destructive-no-plan"`。
- **观测**: ✅ `node --check bots/_supervisor/skills/prepNether.js` 通过。20:02 通过 inbox `cancel_skill` 热重挂当前 mission/prepNether，新栈在夜间 covered bunker 内命中 `NO-REGEN static kit check (night-bunker-covered) pos=27,82,10 foot=torch head=air under=stone stable=true hostiles8=0 hp=7 food=12 pick=0 tableInv=0 tableNear=none cobble=194 stick=4 planksEq=14`；随后本地放置可触达 `crafting_table@27,82,11`，做出并装备 `stone_pickaxe=1`、`stone_sword=1`，vitals 变为 `pickFx=1 held=stone_sword`。`mine_motion` 在 20:02 只新增 `place.begin/end` 工作台事件，未新增 `path.begin` 或 `selected="destructive-no-plan"`。20:05 追加 ready 降噪门并热重挂，验证新栈只写一次 `NO-REGEN static kit ready ... pick=1 tableNear=27,82,11 stick=5 swordTier=yes`，随后进入正常 `HUNGER/LOWHP gate`，不再刷完整 no-op check/result。
- **回滚**: 删除 `noRegenStaticKit()` 与 `keepFed()/holeUpAtNight()` 中的调用点，恢复 no-regen 直接进入食物/night hold。

## C121. 通用矿洞行进收紧：无完整路径不再 destructive 盲走，普通寻路禁 parkour/脚手架，低血无食物不先跑银行（①层 skills.js + ③层 prepNether.js，已重启待观测）
- **触发**: 19:32 `prepNether` 在 hp=7/food=12/no normal food 下，先于 `keepFed()` 执行 `bankRecover`，对幽灵 bank `GoalNear(8,77,46)` 启动公共 `goToGoal`。`mine_motion` 显示 `path.plan selected="destructive-no-plan"`，non/destructive 都只是 `partial len=21`，但仍进入 `path.phase.begin canDig=true allowParkour=true maxDropDown=4`；随后从 `27,81,15` 走到 `27,82,10`，挖 `dirt@27,83,10`、`dirt@27,84,10/9`，再发现附近无箱子并标 ghost。
- **机理**: 公共 `goToGoal` 的“non-destructive” movement 默认仍允许挖掘；失败后即使 destructive 没有完整 path，也会把 destructive movement 交给 `goto()` 试运行，等同于在矿洞里边猜边挖。movement 还允许 `allowParkour=true`、`maxDropDown=4`、重新填充 scaffold blocks，导致台阶边缘/坡道上容易卡住或错位垫块。任务层方面，`bankRecover()` 排在 `keepFed()` 前，无回血低血窗口还没被食物门禁拦住就先抢身体跑路。
- **改动**: `goToGoal` 中 non-destructive 明确 `canDig=false`；两套 movement 都 `allowParkour=false`、`maxDropDown=2`、`scafoldingBlocks=[]`，普通导航只走/挖已知路线，不自动垫块/跑酷。若 non/destructive `getPathTo()` 都不是完整 `success`，记录 `path.plan selected="none" refused="blind-destructive-navigation"`，立即 `PathfindingNoPlan` 失败，不再执行 `destructive-no-plan`。`prepNether.bankRecover()` 增加 no-regen trip gate：`hp<14 && food<18 && !hasEdible()` 且 bank 距离 >4.5 时先让 `keepFed/hold` 接管，不跑银行路径。
- **预测**: 后续 `mine_motion` 不应再出现新的 `selected="destructive-no-plan"`；公共路径审计中 `allowParkour=false maxDropDown=2`。低血无正常食物且 bank 不在身边时，应记录 `bankRecover: no-regen trip gate...` 或 ghost skip，不得先为 bank path 挖矿洞坡道。若目标确有完整 destructive path，仍允许 pathfinder 挖已规划路线。
- **观测**: 🟡 `node --check src/agent/library/skills.js` 与 `node --check bots/_supervisor/skills/prepNether.js` 通过；19:39 按精确 PID 只重启 `48909/8765`，watchdog 拉起新进程 `48909=44684`、`8765=18984`，fresh_status 仍 live 且 Minecraft LAN 未动。重启后当前处于夜间 covered hold，尚无新路径样本；19:40-19:41 只见 bunker dwell，无新 `path.begin`/blind dig。
- **回滚**: 恢复 `goToGoal` 的 destructive-no-plan fallback、movement 默认 `allowParkour/maxDropDown/scafoldingBlocks`；删除 `bankRecover` no-regen trip gate，并重启 agent core。

## C120. no-regen stand-down 中无近场食物信号时，不再每 45s 空跑 feedUp 扫描（③层 missionNether.js，已验证）
- **触发**: C118/C119 后不再盲挖，但 19:26-19:37 在 `prepNether stand-down: low-hp/no-food cooldown...` 期间仍每约 45s 进入 `feedUp: START target=18 food=12 hp=7`，紧接着 `food_scan animal64=none fish32=none drop32=none melon48=none berry48=none oak...` 与 `critical local-only stop`。这些扫描不移动，但持续抢 body/control 节奏，和 “body stays free” 的 stand-down 语义相反。
- **机理**: mission 层 cooldown 分支只把 `famineCritical()` 且无安全 forage 窗口的情况挡住；hp=7/food=12/no normal food 属于无回血低血，不满足 famineCritical，于是每轮 cooldown 仍允许空 `feedUp`。
- **改动**: 新增 `safeCloseFoodSignal()`，只把近场同层动物或已确认食物掉落视为可行动信号，近敌 14 格内直接否决。cooldown feedUp 分支新增 `noRegenDryScan`：`noRegenNoFood() && !safeCloseFoodSignal()` 时记录 `cooldown feedUp gated: no-regen low-hp/no-food...; no close confirmed food signal`，不调用 `feedUp`。19:46 现场发现 `ADVISORY eat_now` 仍绕过 cooldown gate 每分钟空 `feedUp`，追加同款 dry-scan gate 到 advisory 分支，记录 `★ADVISORY eat_now gated: no-regen low-hp/no-food...`。
- **预测**: 天亮后或下一次 no-regen cooldown 内，如果附近仍无同层动物/食物掉落，应看到 `cooldown feedUp gated...` 与/或 `ADVISORY eat_now gated...`，不再出现新的 `feedUp: START` 空扫；如果真的出现近场动物/食物掉落，则允许 feedUp。
- **观测**: ✅ `node --check bots/_supervisor/skills/missionNether.js` 通过；19:39 agent core reload 后新栈加载，19:46 天亮后先命中 `cooldown feedUp gated...`，但随后发现 `★ADVISORY eat_now (food low, safe window) → feedUp` 仍空扫，确认 C120 首版只堵了 cooldown 旁路。19:48 通过 inbox `cancel_skill` 热重挂后，新栈 19:48:58 写出 `★ADVISORY eat_now gated: no-regen low-hp/no-food hp=7 food=12; no close confirmed food signal`；19:49-19:50 连续看到 `ADVISORY eat_now gated` 与 `cooldown feedUp gated`，未再出现新的 `feedUp: START` 空扫。
- **回滚**: 删除 `safeCloseFoodSignal()` 与 cooldown 分支中的 `noRegenDryScan` gate，恢复只按 famineCritical gate。

## C119. pin-breaker/STUCK-ZONE 识别 no-regen low-hp/backoff 合法等待，避免每分钟 cancel mission（①层 modes.js + watchdog.ps1，已验证）
- **触发**: C118 验证后，events 仍每分钟出现 `Pinned 15min+ — kicking the stack (forced interrupt)`，对应 `missionNether` 每分钟 `supervisor cancel received` / sticky re-arm。此时 act_trace 显示 `ctrl=- path=0 dig=-`，但 progress 同步显示 `prepNether stand-down: low-hp/no-food cooldown ... surface=...`，属于有意等待/不盲挖，不是死锁。
- **机理**: `reflex_watchdog` 的 pin-breaker 只豁免 nightBunker、`food<12 && !edible` 的低食物 shelter、以及 food<=2/hp<=6 的 famineHold；漏掉 hp=7/food=12/no normal food 且 `_prepNoFoodSurfaceBackoffUntil` 正在生效的无回血等待，于是实时触发器把正确 stand-down 当 pinned 栈，每 60s 强制 cancel。
- **改动**: pin-breaker 增加 `noRegenLowHpHold`：`hp<14 && food<18 && !normalEdible && (lowHpNoFood 或 surfaceNoFood backoff active) && 无近敌 && 非水火/坠落`，命中时像夜间地堡一样重置 pin anchor，不发 `Pinned 15min+`、不设置 `_supervisorCancelAt`。同时把 normal edible 与腐肉/蜘蛛眼分开，避免应急 junk 被误认为可回血食物。PowerShell `watchdog.ps1` 的 STUCK-ZONE 也增加同类 `$noRegenHold`，用 fresh vitals + progress tail 避免 10min/25min 误 cancel/restart。
- **预测**: agent-only reload 后，当前 hp=7/food=12/no normal food/backoff 窗口内应继续写 `prepNether stand-down ... surface=...`，但 events 不应每分钟新增 `Pinned 15min+` / `skill_result cancelled`；watchdog 不应再发 `STUCK-ZONE within 10b`。若有近敌、水火、坠落或真实 body work 卡住，pin-breaker/STUCK-ZONE 仍可触发。
- **观测**: ✅ `node --check src/agent/modes.js` 通过，`watchdog.ps1` scriptblock parse 通过；03:17 agent-only reload 后 fresh_status 回 live（48909=34768、8765=30536，MC LAN 未动）。03:21 启动新 watchdog，singleton 替换旧 watchdog，fresh_status 仍 live。19:18-19:25 夜间 progress 只见 `night bunker dwell: covered=true hold=false hp=7 food=12 hostiles=0`，events 只见 `Nightfall — securing till dawn`，未再出现新的 `Pinned 15min+`、`STUCK-ZONE` 或 `skill_result cancelled`。19:26 天亮后 `prepNether` 重新进入 no-food-signal gate，19:26-19:27 仍无新的 pin/STUCK cancel，证明日夜切换后旧锚点也被正确压住。
- **回滚**: 删除 `noRegenLowHpHold` 与 `$noRegenHold` 分支，恢复 pin-breaker/STUCK-ZONE 只豁免 nightBunker/lowFoodShelter/famineHold。

## C118. BREAKOUT no-regen gate 覆盖 prepNether 长 backoff，禁止低血无食物直线盲挖（③层 missionNether.js，已验证）
- **触发**: C117 19:06 曾命中 `BREAKOUT gated`，但 19:10 又出现反例：`prepNether` 仍在 `last surface/feedUp found no food; backoff 114s`，mission 层却执行 `★BREAKOUT: pinned 4min — tunneling toward anchor dir=0,1`；`mine_motion` 记录 hp=7/food=12/no normal food 时连续挖 stone@27,81,14、stone@27,82,15、stone@27,81,15、stone@27,82,16，位置 28,81,12 → 28,81,16，只是直线盲挖，没有食物收益。
- **机理**: C117 只看 `_prepLowHpNoFoodUntil` 的 60s cooldown 或夜间；而 `prepNether` 另有 `_prepNoFoodSurfaceBackoffUntil=180s`。60s 到期后，mission 认为可以 BREAKOUT，实际 prep 仍在“不要再上爬/无食物”长 backoff。
- **改动**: 新增 `noRegenBackoffRemain()` 同时读取 low-hp 与 surface/no-food 两个 backoff；`prepNether stand-down` 改为 `noRegenNoFood && 任一 backoff active`。BREAKOUT gate 放宽为 `noRegenNoFood && 10格内无敌对` 就禁止盲挖，并在日志写出 `surfaceBackoff` 剩余秒数。顺手把 cooldown shelter 文案从 famine-only 改成 no-regen/low-food。
- **预测**: 下次 hp<14/food<18/no normal food 且无贴脸怪，哪怕 `_prepLowHpNoFoodUntil` 已过期，只要处于 surface/no-food backoff 或 pinned 4min，都不得再出现 `★BREAKOUT: pinned 4min — tunneling...`；应看到 `★BREAKOUT gated: no-regen low-hp/no-food ... surfaceBackoff=...` 或 `prepNether stand-down ... surface=...`。
- **观测**: ✅ `node --check bots/_supervisor/skills/missionNether.js` 通过；19:12 新栈写出 `prepNether stand-down ... lowHp=33s surface=153s`，证明 mission 层已读到 surface/no-food 长 backoff；19:14:44 pinned 窗口命中 `★BREAKOUT gated: no-regen low-hp/no-food hp=7 food=12 cooldown=32s surfaceBackoff=32s night=false`，未再挖 stone/直线前冲。19:26 黎明后再次命中 `HUNGER/LOWHP gate — no concrete food signal...`，随后 19:26:28 命中 `BREAKOUT gated ... cooldown=165s surfaceBackoff=165s night=false`，证明白天/长 backoff 交界也不再盲挖。
- **回滚**: 恢复 BREAKOUT gate 只检查 `_prepLowHpNoFoodUntil || night`；stand-down 条件恢复只看 `_prepLowHpNoFoodUntil`。

## C117. 低血无 regen cooldown/夜间不触发 BREAKOUT 盲挖冲刺（③层 missionNether.js，热加载已重挂，待观测）
- **触发**: C113/C114 后仍出现 18:56 反例：`prepNether stand-down: low-hp/no-food cooldown` 期间，mission 层 4 分钟 pinned last-resort `★BREAKOUT: pinned 4min — tunneling toward anchor` 仍启动，随后 `BREAKOUT done @ 28,86,12`，hp 8→7。此时不是 food=0 饥荒，也无怪贴脸；breakout 作为脱困手段抢在 shelter/feedUp 前，继续消耗生命。
- **机理**: `missionNether` 的 BREAKOUT 只用 `famineCritical()` gate；food=12/hp=8/no normal food 属于无 regen 低血窗口，但不满足 famineCritical，于是仍可盲挖/前冲。
- **改动**: BREAKOUT 前新增 no-regen gate：`!edibleHeld && hp<14 && food<18` 且处于 `_prepLowHpNoFoodUntil` cooldown 或夜间，并且 10 格内无敌对时，记录 `BREAKOUT gated: no-regen low-hp/no-food...`，停 pathfinder/controls，等待 5s，不挖不冲。
- **预测**: 下次 low-hp/no-food cooldown 或夜间 hold 中，即使 pinned 超过 4 分钟，也不得再执行 `BREAKOUT: pinned 4min — tunneling...`；应出现 `BREAKOUT gated: no-regen low-hp/no-food...`。如果有敌对贴脸/水火等真实危险，其他 survival 分支仍可接管。
- **观测**: ⚠️ `node --check bots/_supervisor/skills/missionNether.js` 通过；19:04 通过 bridge `cancel_skill` 正常释放旧 run_skill，sticky re-arm 后出现新的 `==== missionNether START ====`, 19:06 命中 `BREAKOUT gated: no-regen...`。但 19:10 发现 60s `_prepLowHpNoFoodUntil` 过期后，仍在 180s surface/no-food backoff 内触发 `BREAKOUT: pinned 4min` 直线盲挖；C117 只挡住短 cooldown，长 backoff 漏洞已拆为 C118。
- **回滚**: 删除 BREAKOUT 前的 `noRegenNoFood/prepCooldownActive` gate。

## C116. surfaceUp 前食物信号只认已确认食物掉落，泛 item 不再放行上爬（③层 prepNether.js，热加载，待观测）
- **触发**: C113 后 18:56 出现反例：`food signal before surface climb — near item@3 dy=1`，随后仍 `surfaceUp target=92`，但 feedUp 扫描只有 `drop32=item@5`，未确认是食物，最终 hp 8→7 且无食物收益。C113 把泛 item 当作 concrete food signal 太宽。
- **机理**: `foodSignalBeforeSurface()` 只检查 item 距离/高差，没有调用 `getDroppedItem().name` 匹配食物；矿物/木头/杂物掉落会误放行无目标上爬。
- **改动**: item 信号改为必须 `getDroppedItem().name` 匹配 `rotten_flesh/beef/porkchop/chicken/mutton/rabbit/cod/salmon/bread/apple/carrot/potato/melon`；附近泛 item 只写入 false reason：`generic item ... is not confirmed food`。
- **预测**: 下次低血无正常食物且附近只有泛 item/oak 时，应被 C113 gate 拦住，日志 reason 包含 `generic item ... is not confirmed food`，不得再出现 `food signal before surface climb — near item`。
- **观测**: 🟡 `node --check bots/_supervisor/skills/prepNether.js` 通过；当前已入夜 hold，等待下一次白天低血窗口验证。
- **回滚**: 恢复 `foodSignalBeforeSurface()` 对任意近场 item 的 ok 处理。

## C115. 无 regen 时不补可选火把，避免 stockTorches 抢身体砍树（③层 prepNether.js，热加载，已现场验证）
- **触发**: C114 后 hp=8/food=12，已经吃腐肉脱离 food=8，但仍未到回血阈值且无正常食物。`prepNether` 在 `keepFed()` 前执行 `stockTorches()`，为补 torch/stick 进入 `achieve torch → oak_planks → chopWood`，现场砍了 4 根 log。动作没有卡住，但这是低血无 regen 时的可选资源路线抢身体。
- **机理**: `stockTorches()` 只用 `famineBudget()` 挡 food<=6/hp<=10；food=8-17 且 hp<14 的无 regen 带病状态仍被允许补火把。火把库存重要，但不应在无回血、无正常食物时触发 tree/chop/craft 链路。
- **改动**: `stockTorches()` 增加 no-regen body budget gate：`hp<14 && food<18 && !hasEdible()` 时记录 `SKIP torch kit — no-regen body budget...` 并返回，不做 optional torch stocking。
- **预测**: 下次 hp<14/food<18/no normal food 且 torch<12 时，应只看到 `SKIP torch kit — no-regen body budget`，不得再因火把库存进入 `NEED torch → oak_planks → chopWood`。有正常食物、可回血或恢复后仍可补火把。
- **观测**: ✅ `node --check bots/_supervisor/skills/prepNether.js` 通过；18:57 入夜低血无正常食物窗口，torch 已降到10，现场命中 `prepNether: SKIP torch kit — no-regen body budget food=12 hp=7 no normal food; don't chop/craft optional torches`，随后进入 `night — HOLD all work until dawn`，未再补火把/砍树。
- **回滚**: 删除 `stockTorches()` 中 no-regen body budget gate。

## C114. 低血低饥饿先吃腐肉，失败食物掉落拉黑，扫叶后不再本地砍树（③层 prepNether.js + feedUp.js，热加载，部分验证）
- **触发**: C113 修改后现场继续显示 hp=8/food=8、背包 `rotten_flesh=2`，但 `feedUp` 不吃腐肉，而是反复对同一个不可达 food-drop 写 `safe food-drop failed (No path to the goal!)`，随后 `targeted oak forage oak_leaves@5 dy=3 → local chop/sweep`，又被 `chopWood LOW-FOOD BAIL food=8` 拒绝。这是“能原地补一点食物，却继续走/爬/砍”的资源节奏错误。
- **机理**: `edibleHeld()` 与 `prepNether.edibleNow()` 都刻意排除 rotten_flesh，且 feedUp 只有 food<=6 才吃 junk；food=7-10/hp<=10 的无 regen 状态仍会尝试移动找食物。PlanC 食物掉落失败没有 blacklist，同一不可达 drop 可在 10 次循环中反复重选。targeted oak 在 food>6 时仍会请求 local chop，和 chopWood 的低食物门互相打架。
- **改动**: `prepNether.keepFed()` 在 hp<=10/food<=10 且无正常食物时先吃 `rotten_flesh/spider_eye`，避免先移动；`feedUp` 增加 `emergencyJunk()`，启动和循环内都可先吃应急口粮；PlanC 对不可达 food-drop 记录 `failedDropIds`，不再同轮反复追同一个目标；targeted oak 在 hp<=10/food<=10 扫叶无果后直接停止，不再调用 local chop。
- **预测**: 下一次 hp<=10/food<=10 且身上有腐肉时，应先出现 `prepNether: emergency food — eating rotten_flesh...` 或 `feedUp: no-regen ... eating rotten_flesh...`，不得再先 `surfaceUp`/`food-drop failed`/`local chop`。若 food-drop 不可达，应出现一次 `PlanC food-drop blacklist` 后本轮不再刷同一坐标。
- **观测**: ⚠️ `node --check bots/_supervisor/skills/prepNether.js` 与 `node --check bots/_supervisor/skills/feedUp.js` 通过；18:52 现场命中 `prepNether: emergency food — eating rotten_flesh before movement (food=8 hp=8)`，vitals food 8→12，避免继续 food=8 低血移动。PlanC drop blacklist 与 targeted oak no-regen skip 尚待下一次对应窗口验证。
- **回滚**: 删除 `emergencyJunk` 两处与 PlanC `failedDropIds`，targeted oak local chop 门恢复 `food<=6`。

## C113. 低血无食物先验扫描食物信号，禁止无目标 surfaceUp（③层 prepNether.js，热加载，已现场验证）
- **触发**: C112 热加载后现场验证到 `feedUp: targeted oak forage skip high tree dy=4`，但 `prepNether` 仍先从封闭 y76 `surfaceUp target=84` 再调用 feedUp；32s 后才发现无动物/瓜/浆果/食物掉落，hp 10→8，并触发 pinned breakout。说明 C112 的高树门在 feedUp 内部太晚，上行本身已经造成伤血和路线破坏。
- **机理**: `keepFed()` 的动作顺序是“无食物低血 → 先挖/垫上去 → 再让 feedUp 扫描食物”。对 food=7-11、hp<14 的无 regen 状态，附近如果没有真实食物信号，最差动作不是原地等，而是为抽象“地表找吃的”盲目开竖向路径。
- **改动**: 新增 `foodSignalBeforeSurface()`：只把同层/低高差动物、鱼、近处 item、melon、sweet_berry_bush 视为 surfaceUp 前的真实食物信号；oak/leaves 只记录为非食物信号。`keepFed()` 在 `!openSurfaceNow && food>=7` 且无信号时直接写 `no concrete food signal before cave climb`，设置 60s low-hp/no-food cooldown 与 180s surface backoff，停止 pathfinder/control，不发起 surfaceUp。
- **预测**: 下次 hp≈8-10、food≈9、封闭/地下、附近只有高差 oak/leaves 时，应先出现 `HUNGER/LOWHP gate — no concrete food signal before cave climb... hold instead of surfaceUp`，不得再出现 `enclosed/high-pocket food run — surfaceUp target=...`。若同层有动物/鱼/食物掉落/瓜果，应记录 `food signal before surface climb` 并允许上行/觅食。
- **观测**: ✅ `node --check bots/_supervisor/skills/prepNether.js` 通过；18:53 现场命中 `HUNGER/LOWHP gate — no concrete food signal before cave climb ... nearest oak oak_leaves@1 dy=1 is not food-signal; hold instead of surfaceUp (food=12 hp=8 y=84)`，随后进入 low-hp/no-food cooldown，未再发起 `surfaceUp target=...`。
- **回滚**: 删除 `foodSignalBeforeSurface()` 与 `keepFed` 中 `!openSurfaceNow && food>=7` 的早期 gate，恢复先 surfaceUp 后 feedUp。

## C112. 低血无食物时限制无收益上爬找食物与高差树目标（③层 prepNether.js + feedUp.js，热加载，部分有效）
- **触发**: C111 后 bot hp=10/food=9-10/no edible，在封闭高位矿洞反复 `prepNether → surfaceUp target=73/82 → feedUp`；附近无动物/瓜/浆果/食物掉落，仅 `oak_leaves@7 dy=6`，`chopWood` 每 45s 进入 `critical local forage` 后立刻 `made no progress`。这没有直接致死，但继续消耗食物并把身体推到更高台阶/树冠边。
- **机理**: `keepFed` 失败后只给 60s prep cooldown，下一轮仍可再次 surfaceUp；`feedUp.targetedOakForage` 的低食物保护只在 food<=6，hp=10/food=9 的“无 regen 低血”仍会尝试高差树目标。
- **改动**: `prepNether.keepFed` 在一次 surface/feedUp 无收益后，对 food>=7 的地下/封闭上爬找食物加 180s backoff；`feedUp` 在 hp<=12、food<=10、无 edible 且 oak/leaves dy>3 时跳过 targeted oak，并给 90s cooldown。
- **预测**: 下一次同类 hp≈10/food≈9 无食物窗口，应看到 `HUNGER/LOWHP gate — last surface/feedUp found no food; backoff...` 或 `targeted oak forage skip high tree dy=...`；不得再每 45-60s 对 dy≈6 的 oak 触发 `local chop/sweep`。
- **观测**: ⚠️ `node --check bots/_supervisor/skills/prepNether.js`、`node --check bots/_supervisor/skills/feedUp.js` 通过；18:46 现场命中 `feedUp: targeted oak forage skip high tree dy=4`，不再对高树 local chop/sweep。但同轮仍先 `surfaceUp target=84` 再扫描，hp 10→8，暴露出“上行前缺少食物信号门”，已拆成 C113。
- **回滚**: 删除 `_prepNoFoodSurfaceBackoffUntil` backoff 与 targeted oak 高差 skip。

## C111. 挖矿中只捡廉价掉落物，禁止为高处/远处 item 触发上坡 destructive path（①层 skills.js，已 agent-only reload，已现场验证）
- **触发**: C110 后 `branchMine` 下行正常，但 18:29 `pickupNearbyItems` 追 `item@26,71,20`，bot 在 `y66`，目标高 5 格；pathfinder 选择 `GoalFollow item` 的 destructive path，连续 `path.phase.stuck → step_edge.none/path.step_edge → path.unstick` 三次，正是用户点名的上坡台阶边缘高频卡顿。
- **机理**: 通用拾取层只按 8 格距离选择 item，不知道当前处于矿道作业；矿物/煤掉落若卡在高处洞壁，会把挖矿路线改写成“向上拆路捡东西”，和 `branchMine` 的下行/开窗同时抢身体。
- **改动**: `pickupNearbyItems` 增加 mining/cave gate：`branchMine` 或封闭低位矿洞中，只追脚边 `<=2.2` 或水平 `<=4.2`、`dy<=1.2`、`dy>=-3.2` 的廉价掉落物；高处/远处非食物 item 记录 `pickup.mining_gate` 并跳过。食物掉落仍可作为生存例外。
- **预测**: 挖矿时不再出现为高处掉落物创建 `GoalFollow item` destructive path；若有高处非食物 item，应看到 `pickup.mining_gate`，后续继续当前矿道/窗口作业。
- **观测**: ✅ `node --check src/agent/library/skills.js` 通过；按 48909/8765 精确 PID agent-only reload，新 PID `48909 -> 42616`、`8765 -> 9160`，fresh_status 回到 live。18:30 后 `mine_motion` 中 item 追踪均为脚边/同层非破坏路径，`unstickAttempts=0`；未再看到 18:29 那类高 5 格 item 的三连 unstick。
- **回滚**: 删除 `miningPickup/cheapMiningPickup` 过滤与 `pickup.mining_gate` audit，恢复只按 distance/famine gate 选择 item，并 agent-only reload。

## C110. 地下缺木板不再触发 chopWood 上爬，优先复用登记工作台/延后盾牌（③层 achieve.js + prepNether.js，热加载，已现场验证）
- **触发**: `prepNether` 在封闭矿洞/山体内为了 shield 缺 6 planks 或 stone_pickaxe 缺 crafting_table，把目标递归成 `oak_planks → chopWood`；18:23 `progress` 显示 y64-70 连续 `not-surface enclosed=true → surfacing`、`raw-stair edge-miss`，`mine_motion` 记录同一垫升路线反复 dig/place/edge miss，属于用户点名的“挖砖块路线、垫砖块时机糟糕”。
- **机理**: 上层物资目标没有区分“必要矿洞工程”和“为了木板回地表”；`achieve` 的夜间 gate 只挡 exposed surface，反而把 `enclosed` 地穴豁免成了可 chopWood；`placeTable` 在 pocket 中把 19 格登记工作台视为太远/太挤，转而制造本地木材需求。
- **改动**: `achieve.placeTable()` 在无本地木材/工作台时把 32 格内登记工作台作为强制复用目标，且若地下/POCKET 无本地木材则直接返回，不再递归到 planks；`_planks` 分支在非真地表/地下/封闭且无 logs 时记录 `underground planks gate` 并拒绝 `chopWood/surface climb`；`prepNether` 对地下/封闭且 shield 材料未就绪的情况延后 shield，避免它挡住 iron tier。
- **预测**: 地下缺 1-6 planks 不再出现新的 `chop for planks` + `chopDBG not-surface ... surfacing`；应看到 `underground planks gate` 或 `defer shield`，随后继续复用 station/下行 mining。
- **观测**: ✅ `node --check bots/_supervisor/skills/achieve.js`、`node --check bots/_supervisor/skills/prepNether.js` 通过。18:26 live 验证：旧 `chopWood` 结束后，下一轮 `achieve` 在 y76 写出 `underground planks gate — need 6... refuse chopWood/surface climb`；随后未再进入 chopWood 上爬，`mine_motion` 显示 `held=stone_pickaxe`，`branchMine.step` 从 y78→77→76 正常下行并记录目标格/周围图景/结果。
- **回滚**: 删除 `achieve.js` 的 mustReuseTable 扩展、underground table/planks gate；删除 `prepNether.js` 的 undergroundWorksite/defer shield 分支。

## C109. covered night hold 只在真实威胁压力下抢身体，避免无怪封闭矿洞夜间冻结（①层 modes.js，已 agent-only reload，已现场验证）
- **触发**: C107 后 `coveredNightHoldStatus().hold` 对所有夜晚+头顶覆盖都为 true；18:20 在 `hostiles=0` 的安全封闭矿洞中反复写 `covered night hold hostiles=0`，self_preservation 抢身体导致 `prepNether/branchMine` 停工。
- **机理**: C107 的“被怪包围时别离开 bunker”缺少 threatPressure 条件，变成了通用夜间宵禁；这和“封闭地穴夜间继续工作”的 prepNether 策略互斥。
- **改动**: `coveredNightHoldStatus` 的 `hold` 必须满足 `hostiles > 0 || creeperDist finite`，再叠加最近未受伤、creeper 非贴脸；无怪封闭矿洞不再进入 covered hold。
- **预测**: hostiles=0 的夜间封闭矿洞只允许 `night bunker dwell hold=false` 这类状态心跳，不再出现主分支 `covered night hold hostiles=0` 抢身体；有怪压门时 C107 仍可 hold。
- **观测**: ✅ `node --check src/agent/modes.js` 通过；按 48909/8765 精确 PID 做 agent-only reload 后 live 恢复。18:20:16 后未再出现新的 `covered night hold hostiles=0` 主分支冻结；18:24-18:26 只看到 `night bunker dwell: covered=true hold=false hp=19 food=15 hostiles=0`，随后 bot 恢复 `prepNether/branchMine` 工作。
- **回滚**: 将 `status.hold` 恢复为 `!status.recentDamage && status.creeperDist > 3.6` 并 agent-only reload。

## C108. 无镐石盒上行改为 surfaceUp/headroom，禁止 raw-stair 自旋（③层 chopWood.js，热加载，已现场验证）
- **触发**: 重生后 `pos=17,78,20`、hp/food=20、无镐无木、仅 dirt/gravel，在封闭石盒内反复 `raw-stair no viable climb`；`mine_motion` 记录同一格脚下/头顶/3x4x3 环境和结果，随后 pathfinder 还试图挖侧边 `crafting_table` 来脱困，属于矿洞路线/垫块时机的典型坏动作。
- **机理**: `raw-stair` 的 relax 条件把“满血满饥饿”误当作可以放宽限制，但无镐时放宽只会反复请求 `guardedDig(stone)` 后失败；外层 `chopWood` 又会在同一 sealed stone box 内重复 `digToSurface` 4 次，浪费时间并污染 path/unstick。
- **改动**: `digToSurface` 增加 no-pick boxed cooldown；无镐且非真地表时先给 `surfaceUp` 一次限时 headroom/natural-route 尝试，失败则记录 `chopWood.no_pick_surface_blocked` 并返回控制权；`raw-stair` 不再因 hp/food 满而 relax 到石头，只接受有镐或显式 planned no-pick stone 窗口。
- **预测**: 无镐石盒不再刷多轮 `raw-stair no viable climb`/挖 crafting_table；应看到 `NOPICK boxed → one surfaceUp/headroom attempt`，若成功则 y 上升并进入可接触树木区域，若失败则快速让位给 mobility。
- **观测**: ✅ `node --check bots/_supervisor/skills/chopWood.js` 通过。18:14 live 验证：surfaceUp 从 y78 找到 `headroom candidate @20,78,20 clear=9`，连续 fallback 垫升 y78→86，随后 bot 到 y87，`mine_motion` 记录 `oak_log@31,86/87/88,20` 的 dig 成功与 `marooned-catch-ledge` dirt place 成功；不再继续原地 raw-stair 自旋。
- **回滚**: 删除 no-pick boxed cooldown/surfaceUp 尝试，恢复 `_allowRelaxedStone = _pickIn() || (bot.health > 8 && bot.food > 8)`，删除外层 no-pick stone box 早退。

## C107. covered night hold 抢回身体，普通怪不再把 sealed bunker 拉成出洞逃跑（①层 modes.js，已 agent-only reload）
- **触发**: 18:01 死亡：`Spider`，死亡点 `-47,100,120`，之前 `prepNether` 已写 `★dug-in bunker SEALED y=103`；combat 轨迹显示蜘蛛从 8-10 格外靠近，self_preservation 多次 `Can't seal here, no mobs`/`Nightfall`，最后在 hp≈5 时 `Can't seal here — running from the swarm` 把身体拉出封闭点，被 spider 贴脸击杀。
- **机理**: `bunkerDown` 局部知道“有顶覆盖就 dwell”，但 `creeperBackoffTarget`、`shouldFlee` 和 seal-fail fallback 都能在它之外抢身体；夜间 covered bunker 没有显式身体独占权，普通怪外部压力会被误升级为出洞 kite。
- **改动**: 新增 `hasOverheadCover()` / `coveredNightHoldStatus()`；夜晚、有头顶实体覆盖、脚/头不在危险液体、最近 4s 未受伤且 creeper 非贴脸时，`creeperBackoffTarget` 返回空、`shouldFlee` 返回 false，主 update 进入 `covered night hold` 分支清控制/停 pathfinder/写心跳；`bunkerDown` 的 covered dwell 和 seal-fail fallback 也复用该状态，不再切到 `running from the swarm`。
- **预测**: 下次夜间 sealed/covered 且普通怪在外时，应出现 `Covered night hold... staying sealed` 或 `[self_preservation] covered night hold`；不得再在未受伤时从 covered bunker 触发 `Can't seal here — running from the swarm`。若刚受伤或 creeper 点脸，仍允许 emergency 分支接管。
- **观测**: 🟡 `node --check src/agent/modes.js` 通过；agent-only reload 后 fresh_status 恢复 live。当前已转白天/出洞，尚待下一次夜间 covered+外部怪压力验证。
- **回滚**: 删除 `coveredNightHoldStatus/hasOverheadCover`，恢复 creeper/shouldFlee/bunkerDown seal-fail 旧判断，并 agent-only reload。

## C106. starvation feedUp 动物 crawl 与 hp<=8 入口修正（③层 feedUp.js，热加载）
- **触发**: C105 后 food=1 hp=8 无 edible 时仍卡住；现场 animal scan 有 `rabbit@35 dy=20`，但旧 `desperationRoam` 只有 food<=0 才放宽 dy 到 24，food=1 反而只允许 dy<=12；同时主循环 `bot.health <= 8` critical branch 在进入 `desperationRoam({concreteOnly:true})` 前 break。
- **机理**: starvation 的两个入口条件不对称：food=1 比 food=0 更保守，hp=8 的“临界”判断又提前截断了唯一可能的动物 crawl，导致饥饿死结。
- **改动**: `crawlDyMax` 在 food<=1 时放宽到 24，label 改为 starving，进展阈值改为 5；critical micro-scout 允许 `food<=1 && hp>=7 && !edibleHeld()` 的 starvation scout；hp<=8 critical branch 先尝试 `desperationRoam({concreteOnly:true})` 再决定等待。
- **预测**: food<=1 且无 edible 时，feedUp 应尝试高差更大的动物 crawl/micro-scout，不应因 hp=8 直接停在原地。
- **观测**: ⚠️ `node --check bots/_supervisor/skills/feedUp.js` 通过，但 18:01 body 在验证前死于 Spider 并重生；功能仍需下一次 starvation 现场验证。
- **回滚**: 恢复 food<=0 才使用 dy24，删除 starvationScout 与 hp<=8 critical branch 中的 desperationRoam 前置调用。

## C105. famine pickup gate：低饥饿不追未知掉落物（①层 skills.js，已 agent-only reload）
- **触发**: food=2 hp=8 时 `pickupNearbyItems` 仍对普通 `item` 发起 GoalFollow；`mine_motion` 17:51 显示连续追 `item` 上坡，目标被 survival/prepNether 改写后落入 `path.unstick` 随机跳，位置从 -47,104,118 被拉到台阶边缘/敌对附近
- **机理**: 通用拾取层不知道饥饿预算，任何掉落物都按 8 格内可捡处理；极低食物时未知掉落物不值得用生命/饱食度换，除非已经在脚边或明确是食物
- **改动**: `pickupNearbyItems` 增加 famine gate：food<=2 或 food<=3/hp<=8 时，只追距离<=2.1 的脚边物或 `getDroppedItem()` 名称匹配食物的掉落；其他 8 格内非食物 item 记录 `pickup.famine_gate` 并跳过
- **预测**: food<=2/hp<=8 时不再出现远距离 `GoalFollow item` 造成上坡卡边；若有非食物掉落物，`mine_motion` 记录 `pickup.famine_gate`
- **观测**: 🟡 17:56 二次 agent-only reload 后 live 恢复，food=2/hp=8，后续窗口未再出现新的 item GoalFollow；待下一次 dropped-item 诱因验证 gate 事件
- **回滚**: 删除 `pickupNearbyItems` 内 faminePickup/droppedName/FOOD_ITEM_RE 过滤并 agent-only reload

## C104. 共享 step-edge assist 接入 path/branchMine（①层 skills.js + ③层 branchMine.js，已 agent-only reload）
- **触发**: 用户点名上坡频繁卡台阶边缘；live `progress/mine_motion` 显示 food=2-3 时多次在 y104-108 的坡/坑边因 GoalFollow/挖坑切换卡住，旧路径失败后直接 `path.unstick` 随机跳；branchMine 自己的 `stepInto` 失败也只有 450ms forward+jump 硬挤
- **机理**: 台阶边缘卡住不是普通随机 stuck，而是明确几何：前方脚格是 1-block step、头/上方可通、bot 贴边不居中；随机跳会把它推离目标或推到更危险的位置
- **改动**: 在 `src/agent/library/skills.js` 新增导出的 `stepEdgeAssist(bot, opts)`：记录当前位置、目标格、foot/head/above/below、3x4x3 环境，执行后撤对齐→短冲→跳上台阶；`goToGoal` 的 stuck/path-failed 分支先调用它，再 fallback 随机 unstick。`branchMine.stepInto` 失败时也先调用同一 assist，再做旧短跳
- **预测**: `mine_motion` 新增 `step_edge.begin/end/none/err` 与 `path.step_edge`；上坡/矿道 step 失败优先有几何 assist，随机 `path.unstick` 数量下降
- **观测**: 🟡 17:54-17:56 reload 前后 live 仍有旧 step-edge 原语成功把 y104→105；核心补丁已加载，待下一次 path-failed/stuck 观察 `path.step_edge`
- **回滚**: 删除 `stepEdgeAssist` 导出、恢复 `goToGoal` 两处直接 `attemptUnstick`，删除 branchMine 的 `skills.stepEdgeAssist` 调用，并 agent-only reload

## C103. POCKET 夜间饥荒不拆 bunker（①层 modes.js，已 agent-only reload）
- **触发**: dusk/夜间 food=4 hp=9 no edible，prepNether 已进入 `hole up`，但 mobility POCKET 连续 `Pocketed — carving a step out`，`mine_motion` 显示它在同一 bunker 上方/脚下反复挖 dirt/grass_block，和生存 hold 抢身体
- **机理**: POCKET 是几何 reflex，只知道"屋顶开、没出口"，不知道这是低食物夜间 shelter；它把"躲夜坑"误判成"要脱困的坑"，在最不该挖的时候挖台阶
- **改动**: POCKET execute 开头增加 famine-night gate：夜间且 food<=6 且无 edible 时清控制、重置 POCKET 计时、记录 `POCKET famine-night gate... hold bunker, no step-out dig`，不挖台阶；白天仍允许 step-out 去找食物
- **预测**: 夜间低食物 covered/near-covered bunker 不再出现新的 `Pocketed — carving a step out` 挖掘；若仍是 POCKET，最多每 30s 记录 gate
- **观测**: 🟡 17:41 agent-only reload 后 live：48909/8765 新 PID，missionNether sticky 已重投，当前 `sealed night hold`/`night bunker dwell` 持续，未见新 POCKET step-out；待下一次 POCKET 触发验证 gate 日志
- **回滚**: 删除 POCKET 分支开头的 `isNight && food<=6 && noEdible` gate，并 agent-only reload

## C102. MAROONED 饥荒禁挖释放身体（①层 modes.js，已 agent-only reload）
- **触发**: C99-C101 后 feedUp 正在 low-food 追羊，但 mobility MAROONED 抢身体，food=3 hp=9 no edible 时连续 `Marooned — engineering a road out` 并挖 stone；`mine_motion` seq421-447 记录了目标石头坐标、周围 3x4x3 环境和结果
- **机理**: 旧 MAROONED 只把 `_maxSeg` 从 6 降到 2，仍会用最后饥饿挖路；mission 的 BREAKOUT gate 不覆盖 mobility 自己的工程动作
- **改动**: MAROONED execute 开头增加 famine gate：food<=6 且无 edible 时清控制、清 march 状态、把 mobility 释放回 FREE，记录 `MAROONED famine gate... release to feedUp, no road dig`
- **预测**: 低食物无 edible 时 MAROONED 不再挖 stone road；mission/feedUp 能继续接管身体，真正要工程逃生需等食物恢复或另建全局 Arbiter
- **观测**: 🟡 17:38 agent-only reload 后 live 恢复，后续夜间未见新的 MAROONED road dig；待下一次低食物 MAROONED 触发验证 gate
- **回滚**: 删除 MAROONED 开头 famine gate，恢复 `_foodTight ? 2 : 6` 旧行为，并 agent-only reload

## C101. targeted oak 低食物 floor 扩到 food<=6（③层 feedUp.js，热加载）
- **触发**: C99/C100 后 food=3-4 时仍能进入 targeted oak，本地 `chopWood` 虽会 LOW-FOOD BAIL，但子技能启动/路径余波会和动物 crawl 抢身体
- **机理**: C93 只挡 food<=2；实际饥荒预算已扩到 food<=6/no edible，targeted oak local chop 也必须同步扩 gate
- **改动**: targeted oak 在扫叶/应急靠近后若 food<=6 且无 edible，记录 `skip local chop at low-food floor` 并返回 false；不再启动 chopWood
- **预测**: food 3-6 no edible 时不出现新的 `targeted oak forage local chop/sweep`，而是回到具体动物 crawl 或 calorie-floor stop
- **观测**: ✅ 17:34 live 验证：`targeted oak forage skip local chop at low-food floor food=3` 后继续 low-food animal crawl；旧的 17:33 local chop 来自补丁前实例
- **回滚**: targeted oak gate 恢复 food<=2 条件

## C100. low-food 动物 crawl 优先于 oak 且进展阈值更灵敏（③层 feedUp.js，热加载）
- **触发**: food=3-5 时有具体动物但 oak 更近，feedUp 先试树叶/砍树，动物窗口被延误；partial progress 要求过高，短段实际推进也被判 no progress
- **机理**: 低食物下"已看见动物"的确定性高于苹果随机掉落；短腿寻路失败只要缩短 3 格就值得继续
- **改动**: low-food concrete animal crawl 提到 oak fallback 前；低食物 partial progress 阈值降到 3，zero-food 仍用 5
- **预测**: food 1-6/no edible/动物<=96 时优先出现 `low-food concrete animal crawl`，并在距离缩短时连续推进
- **观测**: ✅ 17:35 live 验证：羊距离 75->62->50->37，随后进入 `hunting sheep dist=27` 并获得食物，food 0/1 恢复到 4-5
- **回滚**: 将 low-food animal crawl 移回 oak fallback 后，并恢复 partial 阈值 5

## C99. food<=6 低食物具体动物 crawl（③层 feedUp.js，热加载）
- **触发**: C96 只处理 food=0；实际 food=3-5 仍无 edible，但长 roam 被 calorie floor 禁止，动物在 64-80 格外时 bot 原地等 cooldown
- **机理**: food 1-6 仍应避免随机长游走，但可对已看见动物做分段、可验证、低风险靠近
- **改动**: 当 food<=6、hp>=8、无 edible、动物<=96 且 dy<=12 时，沿动物方向走 14 格 `low-food-animal-crawl`，失败后按距离变化决定是否继续
- **预测**: progress 出现 `low-food concrete animal crawl ... from=... to=...`；动物距离不应靠 mission cooldown 才推进
- **观测**: ⚠️部分有效：17:32-17:35 多次触发；在 C100 后连续推进并最终进入 hunt window
- **回滚**: 删除 low-food animal crawl 分支，仅保留 zero-food 版本

## C98. food 4-6 不再过早 calorie stop（③层 feedUp.js，热加载）
- **触发**: prepNether 把 famine budget 扩到 food<=6 后，feedUp 仍会在 food 4-6 早停，导致本该执行的 concrete food probes 没机会跑
- **机理**: calorie floor 的正确含义是"不做随机长游走"，不是"跳过所有具体目标探测"
- **改动**: 移除 food 4-6 的早期 `emergency food floor reached` break，让 local fish/drop/animal/desperation concrete probes 先执行，最后才 calorie-floor stop
- **预测**: food 4-6 no edible 时仍能看到 concrete probe 日志，只有无具体目标时才 `calorie-floor stop`
- **观测**: ✅ 后续 17:34-17:36 food=3-4 均能进入 animal crawl/scan，再根据动物 dy/距离决定 skip
- **回滚**: 恢复早期 food floor break

## C97. prepNether famine budget 扩到 food<=6 并让 feedUp 先探食物（③层 prepNether.js/feedUp.js，热加载 + mission 重挂）
- **触发**: C96 天亮后 bot 成功从 0 食物猎到 food=5，但旧 prepNether 立刻去 ghost bank/kit，food=5 hp=9 时还摔掉 1 HP
- **机理**: food=5/no edible 仍是饥荒预算，不应跑 bank/torch/shield kit；并且 ghost bank 已有证据，应跳过
- **改动**: prepNether `famineBudget` 扩为 no-edible food<=2 或 food<=6/hp<=10；bank ghost gate/kit gate 在此预算下优先让位；feedUp 将 localFish/desperation concrete probes 放到 floor stop 前
- **预测**: food<=6/no edible 时 prepNether 记录 `SKIP ... famine body budget`、`FAMINE gate` 或 daylight forage window，不再启动 bank trip/kit roam
- **观测**: ✅ 17:30 WS cancel+run 后验证：`bank marked ghost`，`SKIP torch kit — famine body budget food=3/4`，`FAMINE gate`；旧 food=5 bank trip 是补丁生效前实例
- **回滚**: `famineBudget` 恢复旧 food<=2/hp<=6 条件，并重挂 missionNether

## C96. zero-food animal crawl 进展即续跑（③层 feedUp.js，热加载）
- **触发**: C94 live 显示每段 `zero-food-animal-crawl` 多数以 `safe-roam-timeout` 返回 false，但动物距离实际从 85 推进到 27；false 让 feedUp 退出，靠 mission 冷却后重叫，白天窗口被空等消耗
- **机理**: 对低食物具体目标，"到达本段 GoalNear"不是唯一成功标准；只要动物距离明显缩短，本段就是有效路线，应立即继续下一段/进入 hunt window
- **改动**: zero-food animal crawl 在 `safeRoamTo` false 后重新扫描最近动物；若进入 dist<=32/dy<=12 或距离缩短≥5且白天无近敌，记录 partial progress 并返回 true，让 feedUp 本轮继续
- **预测**: 下个白天看到 `zero-food animal crawl partial progress A->B` 或 `reached hunt window`；动物接近应少受 mission cooldown 拖累
- **观测**: 🟡 热加载待天亮验证；当前 night sealed hold，food=0 hp=10
- **回滚**: 删除 safeRoamTo false 后的 nextAnimal 进展判定，恢复 C94 的直接 return

## C95. missionNether famineCritical 覆盖 food<=1（③层 missionNether.js，需重挂 mission）
- **触发**: live food=0 hp=10 时，mission 4min pinned 分支仍执行 `★BREAKOUT: ... tunneling toward anchor`，继续挖/走，和"保留身体给 feedUp/shelter"目标冲突
- **机理**: `famineCritical()` 只认 `hp<=6 && food<=2`；food=0 但 hp=10 被误判为不危急，BREAKOUT gate 绕过
- **改动**: `famineCritical = !edibleHeld && (food<=1 || hp<=6 && food<=2)`；通过本地 WS `cancel_skill` + `run_skill missionNether` 重挂长跑 skill，使新代码生效
- **预测**: 后续 food<=1/no edible 的 pinned 4min 不再 `BREAKOUT tunneling`，应记录 `BREAKOUT gated: famine-critical...`
- **观测**: 🟡 重挂成功（events.log cancel_result ok + missionNether START）；待下一次 pinned 4min 验证 gate
- **回滚**: famineCritical 恢复旧 hp<=6 条件，并重挂 missionNether

## C94. food=0 具体动物短腿追踪（③层 feedUp.js，热加载）
- **触发**: C91/C93 后，food=0 白天无敌对，叶子多轮无苹果；旧 `desperationRoam` 因 animal@70-85 且 dy17-23 超过 max=32/10 直接 skip，bot 只能原地等死
- **机理**: calorie-floor 禁随机长游走是对的，但把"已看见的具体动物"也当成不可追，缺少低风险分段靠近策略
- **改动**: food=0、hp>=9、无 edible、动物<=96 且 dy<=24 时，不随机 roam，而是沿动物方向走 8-14 格短腿 `zero-food-animal-crawl`，每段 6.5s timeout，下一轮重新评估
- **预测**: progress 出现 `zero-food concrete animal crawl ...`; 动物距离应分段下降，失败也不应引入长路径/乱挖
- **观测**: ⚠️部分有效：17:15-17:18 live 连续触发，pig 距离约 85→71→56→49→40→27；多数短腿以 timeout 结束但实际推进明显。随后入夜，prepNether 正确 sealed night hold；待天亮从 pig@27 继续验证能否进入 hunt range
- **回滚**: 删除 `zero-food concrete animal crawl` 分支，恢复 animal skip

## C93. targeted oak 极限饥饿禁止本地砍树（③层 feedUp.js，热加载）
- **触发**: C91 首轮真实验证：food=0 时 `emergency leaf approach` 成功接近并扫叶，但没掉苹果；随后 `targetedOakAppleForage` 仍启动 `chopWood`，引发拾取/路径目标互相覆盖，`mine_motion` 出现连续 `The goal was changed before it could be completed!`
- **机理**: C90 只禁止 PlanD 在 calorie floor 砍树，遗漏 targeted oak 的后半段 local chop；`Promise.race(customSkill(chopWood), timeout)` 超时后子技能仍可能留下路径/拾取动作余波
- **改动**: targeted oak 在 leaf sweep / emergency approach 后若仍 food<=2 且无 edible，直接记录 `skip local chop at calorie floor` 并返回 false，交给 calorie-floor stop；不再启动 chopWood
- **预测**: food<=2 且扫叶无苹果时不再出现 `[chopDBG] ENTER count=1`；后续日志应进入 `famine roam animal skip` / `calorie-floor stop`
- **观测**: ✅ 17:10:38 live 验证：`targeted oak forage skip local chop at calorie floor food=0` 后直接 `calorie-floor stop`，未再启动 chopWood
- **回滚**: 删除 targeted oak 的 calorie-floor skip 块

## C92. chopWood 上坡台阶 edge-miss 两段式 run-up（③层 chopWood.js，热加载）
- **触发**: 用户指出"上坡很容易卡在台阶边缘，触发非常频繁"；既有 C86 已把成功判定收紧，能暴露 edge_miss，但还没有把砍树/爬坡动作本身修到位
- **机理**: `_ascendStep` 第一次跳不上去后所谓"back out"实现是看向身后再按 back，实际会把身体推回同一个台阶边；且砍树上坡没有 `_bodyMoveLock`，容易被 unstuck/item_collecting 抢控制
- **改动**: `_ascendStep` 增加短 move lock；失败后改为看向目标台阶再按 back+sneak 真后撤；第二次起跳前记录 `ascend.runup.begin/end` 并做真实 run-up，延长 press/settle；新增 `ascend.move_lock.busy` 观测
- **预测**: `mine_motion.jsonl` 中同一 `ascend.edge_miss` 连续重复减少；若仍失败，应能看到 run-up 前后坐标、targetDist、锁竞争者
- **观测**: 🟡 热加载待下一次 chopWood/上坡验证
- **回滚**: 删 `_ascendStep` 的 move lock/runupPrep，恢复旧 backout 段

## C91. food=1 近叶应急靠近（③层 feedUp.js，热加载）
- **触发**: food=1 白天附近有 oak_leaves@8-9，但 targeted oak `safeRoamTo` 报 "Took too long to decide path to goal"，随后 cooldown=45s，PlanD 又因 calorie floor 跳过 chop，导致最后一点饥饿无有效动作
- **机理**: bot 明明能看到近处叶子，但路径目标设在树叶同 x/z 的当前 y 上，A* 在山坡/树冠边缘不可解；失败后长 cooldown + 禁长游走，把"近处可采叶"降级成"什么都不做"
- **改动**: `safeRoamTo` 支持短 timeout；新增 `nearestAppleLeaves` + `emergencyLeafApproach`：food<=2 时扫描 10 格内橡树叶，选 4 个候选站位短距靠近，不开挖、不随机游走、不调用 chopWood；成功或局部接近后立即 `appleLeafSweep`
- **预测**: 下一次 daylight food<=2 且 leaf<=10 时，progress 出现 `emergency leaf approach ... leaf=... candidate=...`；失败 cooldown 缩短到 10s，不再 45s 卡死
- **观测**: ⚠️部分有效：17:08-17:17 多次触发 `emergency leaf approach`，能接近并扫叶；当前区域苹果运气差，未产食物。C93/C94 接手避免扫叶失败后乱砍/空等
- **回滚**: 删除 `nearestAppleLeaves`/`emergencyLeafApproach`，`safeRoamTo` timeout 恢复固定 10s，targeted oak cooldown 恢复 45s

## C1. 黑匣子 threat_radar mode（①层 modes.js）
- **触发**: 死259后用户两点要求："索敌永远比怪先知道" + "怪注意到就进详细日志,还原图景再分析"
- **改动**: 新增 threat_radar mode：24格扫描、radar_contact 先手记录、16格内或掉血=ENGAGE→1Hz快照(pos/hp/food/held/ground/vy/act/全怪名距坐标)+HURT(伤害值)+DISENGAGE → combat_log.jsonl(20MB轮转)
- **预测**: 每次死亡都能逐秒还原战斗过程
- **观测**: ✅ 死260/261/262/263 四场全部完整还原，每场都揪出可修的机理（见C5/C8/C10/C12）。非交战死亡(窒息262)也留痕——hurt检测每秒跑
- **回滚**: 删 modes.js threat_radar 块（纯观察，无行为副作用）

## C2. modes 调度 always 通道（①层 modes.js ModeController.update）
- **触发**: C1 上线后首战只录4帧断片（01:07 ENGAGE后4分钟黑屏，hp 15.3→9无记录）
- **机理**: 调度循环只在 isIdle()||interruptible 时调 mode.update；sticky skill 让 agent 几乎永远非idle → interrupts:[] 的 mode 从不被调度
- **改动**: mode.always=true 的纯观察 mode 每 tick 无条件先跑、不受门控、不被 active break 截断；threat_radar 挂 always
- **预测**: combat_log 在 skill 执行期间持续记录
- **观测**: ✅ 死262/263 录像全程无断片（skill 执行中逐秒在录）
- **回滚**: 去掉 update 里 always 先行循环 + threat_radar 的 always 标记

## C3. radar.json 雷达快照（①层 modes.js threat_radar 内）
- **触发**: 俯瞰层(C6)需要非交战时的实时怪位（vitals 只有数量）
- **改动**: threat_radar 每5s覆盖写 radar.json {ts,pos,mobs[]}
- **预测**: overseer 的 nearest/聚集判定从"退化模式"变实时
- **观测**: 🟡 已产出且 overseer 在消费；待一次"mobs gathering"预警实例验证价值
- **回滚**: 删 threat_radar 内 lastSnap 块

## C4. EVAC 重生疏散反射（③层 missionNether.js，热加载）
- **触发**: 死261录像——重生点2.8格内站僵尸+24格11敌对，满血却被 self_preservation 短距挪动困在 y32 怪窝平台绕圈28s裸手磨死
- **机理**: 重生即被围没有"先拉开距离"的反射；fleeMove 是局部短挪，垂直地形会锁死
- **改动**: missionNether 循环开头：16格内≥3敌对且无武器 → 朝怪质心反方向分4段撤40格，任务靠后
- **预测**: 不再出现"重生→30s内被围殴致死"（死260→261间隔31s那种）
- **观测**: 🟡 sticky 重投已带新代码；死262/263 死因不同(窒息/贴脸骷髅)未触发本反射——尚无正例
- **回滚**: 删 missionNether iter 开头 EVAC 块

## C5. overseer 俯瞰层（④层新建 overseer.mjs + watchdog 保活）
- **触发**: 用户："增加背景循环,上帝视角收集信息、判断风险、LLM辅助主agent决策"
- **改动**: 独立进程每10s融合 radar+vitals趋势+黑匣子+死亡热图+tod → risk 0-100 + directive 写 advisory.json；risk≥60(节流90s)或6min周期调 gpt-4o-mini 可改判+给hint；missionNether 消费(risk≥70 或 eat_now)
- **预测**: 风险先于本能反射被识别（怪聚集/黄昏暴露/雷区接近）
- **观测**: 🟡 风险曲线动态正确(45夜地表→53有怪evac→30白天)；LLM 两次咨询合理(shelter_now+hint)；尚无"directive 实际改变 bot 行为救命"的实例
- **回滚**: 杀 overseer 进程+删 watchdog 保活段+missionNether advisory 块；advisory.json 无消费者后无害

## C6. tool_keeper 修活 + 造台链（①层 modes.js）
- **触发**: [KIT] 两把石镐带着200圆石在长挖掘中磨成灰（镐2→0,死亡数没动）
- **机理**: 调度陷阱家族第2员——interrupts:[] 在 sticky 期间从不运行；上线以来只在idle间隙跑过
- **改动**: interrupts:['all']（5s一查,>80%磨损才打断2s补造）；补"背包无台→先板后台再镐"链（死后重建期常无台）
- **预测**: [KIT] 不再出现"镐全没了"事件（磨损80%即有补造动作,progress/聊天可见 "crafting a spare"）
- **观测**: ⚠️部分有效(06-11 12:5x): 触发9次(检测线工作,耐久API正常);但断镐窗口若无台无板无log,造台链全链无料→喊了造不出,木镐仍断(deaths没动,keepKit边界重建接手)。结论: C6 解决"有料不补"(原始死因),无料窗口属于重建期固有困境,由边界重建兜底——不加复杂度
- **回滚**: interrupts 改回 []（不推荐——会回到死状态）

## C7. 窒息自救泛化（①层 modes.js self_preservation）
- **触发**: 死262——digToSurface 阶梯上行头嵌普通石头，self_preservation active 但窒息分支只认 sand/gravel/concrete_powder → 不匹配 → 手持石镐站原地3.6s磨死(hp7起步)
- **机理**: 本能触发条件太窄=有反射等于没反射
- **改动**: 头部格子是任何实心block(boundingBox==='block') → equipForBlock 换对工具(徒手挖石7.5s>>窒息致死速度,镐0.6s) → 挖头
- **预测**: 不再出现 cause:suffocation 死亡
- **观测**: 🟡 02:03 重启生效
- **回滚**: 恢复分支条件为 fall_blocks 三类

## C8. auto_eat 修活（①层 modes.js）⏳
- **触发**: 饥饿斩血×2（死260 food2→hp6.8遇僵尸死；死262 food0→hp7窒息死——共同前因都是 food 趋零仍作业,回血线18以下掉血永久化）
- **机理**: 调度陷阱家族第3员——sticky 期间背包有食物也从不吃
- **改动**: interrupts:['all']（food≤17 即打断1.6s进食）
- **预测**: vitals 的 food 不再出现"背包有食物却趋0"；饥饿性残血(双位数→个位数无交战)消失
- **观测**: 🟡 06-11 02:30 重启生效，待 food 曲线验证
- **回滚**: interrupts 改回 []

## C9. overseer eat_now 指令（④层 overseer.mjs + ③层 missionNether.js）
- **触发**: 同C8——食物断供还需要策略层硬中断（背包没食物时 auto_eat 无能为力,要去猎）
- **改动**: food≤6+白天+无敌对 → directive 'eat_now'(预防性,不卡risk≥70线) → missionNether 强制 feedUp
- **预测**: progress 出现 "★ADVISORY eat_now → feedUp"且 food 回升；不再有 food=0 过夜
- **观测**: 🟡 overseer 已重启生效+missionNether 热加载
- **回滚**: 删 overseer eat_now 分支+missionNether 映射

## C10. 贴脸骷髅拔剑（①层 modes.js self_defense + shouldFlee）⏳
- **触发**: 死263录像——hp4+骷髅1.6-4格贴脸+竖井地形：self_defense 血量门(4<12)拒战、self_preservation 垒墙(贴脸无效)霸占控制、地形堵死逃跑；背包有木剑20s没拔,挨射至死
- **机理**: 血量门对贴脸远程怪是反的——4格内骷髅拉弓0.5s硬直,剑击退打断射击循环,残血时近战是唯一胜手。且 self_pres 优先级更高,光改 self_defense 轮不到
- **改动**: ①self_defense: 敌<4.5格+有武器 → 无视血量门开打；②shouldFlee: 唯一敌对<4.5格+8格内无第二只+有武器 → return false 让位（严格单怪,群殴仍逃/垒）
- **预测**: 不再出现"贴脸单怪+有武器+被磨死"的死亡;黑匣子里贴脸场景应见 act=mode:self_defense+怪距被打出去
- **观测**: 🟡 06-11 02:30 重启生效，待首次贴脸场景验证
- **回滚**: 删两处例外块

## C11. missionNether advisory 消费框架（③层）
- **触发**: C5 的手——judgment 必须有 actuator
- **改动**: iter 开头读 advisory.json：risk≥70 的 shelter_now→prepNether / leave_zone→moveAway24 / evac→降EVAC阈值到1怪；eat_now 任意risk放行
- **预测**: progress 出现 ★ADVISORY 行为且行为合理
- **观测**: 🟡 热加载生效
- **回滚**: 删 advisory 块（EVAC 反射独立保留）

## C12. reflex_watchdog 反射看门狗（①层 modes.js，always 通道）
- **触发**: 死264——白天0敌对,bot 在 y61 水面30+秒纹丝不动溺死;act 全程显示 self_preservation active,但(功能完备的)y≥55游岸分支从未运行
- **机理**: 更早的 execute(寻路 await 永不返回)把 mode 锁在 active=true,调度器 !mode.active 门让任何新险情永远无法处理。是黑匣子调度陷阱的镜像:那边是 mode 永远不开始,这边是永远不结束。**mode execute 无超时是结构洞**
- **改动**: 新增 always 监督 mode:"正在挨打(2.5s内掉过血)+8秒没动0.5格+self_preservation active"→判反射卡死→强制释放(interrupt_code+clearControlStates+pathfinder.setGoal(null)──解寻路挂起的实际钥匙);20s后仍卡→强拆 active=false(重入竞态好过站着死)
- **预测**: 不再出现"挨打+静止+反射active"超过10秒的死亡(黑匣子可验:连续静止tick+掉血+act=self_preservation 的窗口≤10s);聊天可见 "Reflex wedged — force releasing!"
- **观测**: 🟡 06-11 10:18 重启生效
- **回滚**: 删 reflex_watchdog 块（纯监督,无正常路径副作用;风险=误判正当静止挨打场景如蹲坑被苦力怕隔墙炸——但蹲坑等天亮的 wait-loop 会重置 interrupt,自愈）

## C13. overseer 规则: 无武器+单怪贴近→evac（④层 overseer.mjs）
- **触发**: 死265——1只溺尸2-4格水中追杀22s获胜;旧 evac 门槛"≥2怪+unarmed"不触发(单怪);bot 裸装游不脱(溺尸水中速度占优)、打不过、水中垒不了墙
- **机理**: 无武器时任何敌对贴近=只有撤离一个选项,数量门槛是错维度
- **改动**: nearest<10 && !armed → directive evac(missionNether 已有映射:EVAC阈值降到1怪)
- **预测**: 裸装期(死后重建)被单怪追时 progress 出现 ★EVAC 且拉开距离;"裸装被单怪磨死"模式消失
- **观测**: 🟡 06-11 10:35 overseer 重启生效
- **回滚**: 删该 else if 分支
- **注**: 提前于"×2纪律"——水域密布的世界+溺尸密度,该模式复发概率极高;且规则端改动零风险(不动bot进程)。C12 在本场死亡中正确地未触发(bot 一直在游动,非静止卡死)——负例验证看门狗判定精度 ✓

## C14. 区域级禁行区 kill-box expulsion（④层 overseer + ③层 missionNether）
- **触发**: 雷区死亡向量第4次(259/261/263/266),观察队列升级条件命中。死266录像:徒手爬升中一秒从y50踩穿掉进y32洞穴,落地6怪环绕,苦力怕13.2伤一炸+僵尸补刀,从满血到死11秒
- **机理**: 蜂窝区屋顶到处是洞,**点级避区(避目标)挡不住过境掉洞**;死263/266几乎同坐标证明这是稳定的地形陷阱
- **改动**: ④overseer 死亡聚类(候选=死亡点,16格密度最大,核心≥8死)→advisory.dzone{cx,cz,r:28,n};③missionNether 每iter:区内+非贴脸交战→径向走出区外16格,无risk门槛("身在坟场即风险")。贴脸交战时不撤(交给C10/EVAC)
- **预测**: progress 出现 ★KILL-BOX expelling;雷区芯(中心±28)内不再新增死亡;副作用警戒:撤离寻路本身穿越区芯掉洞?(目标=径向最近出口,应优于漫游)
- **观测**: ✅(初验) 06-11 10:57 上线;聚类 center(-1,-34) r28 n=30 精确画出蜂窝区,死266位置在区内12.7格 ✓;11:00 首触发"19b inside → expelling to 30,-65",撤离成功,bot 区外34格正常作业——expulsion 全链路工作。待长期验证:雷区芯不再新增死亡
- **回滚**: 删 missionNether KILL-BOX 块 + overseer dangerZone(dzone字段无消费者后无害)

## C15. 危殆让位: 作业skill hp≤6 即 bail（③层 chopWood + digToSurface）
- **触发**: hp0.6未遂事件(03:16,没死)——爬升穿雷区芯被苦力怕缠上,hp掉到0.6还在一步步凿楼梯找树;overseer risk=100 evac 警报发了2分钟,但 bot 困在 chopWood/digToSurface 深循环里没有任何消费点
- **机理**: 长作业循环只检查死亡/超代,不检查危殆——残血时 skill 还在推进作业目标,而 advisory/编排层的生存路径全在循环外面等
- **改动**: chopWood iter 头 + digToSurface 步进: hp≤6 → 立即 return(让位),编排层持有生存路径。待推广: achieve 挖矿循环同款(下次同形态事件时做)
- **预测**: progress 出现 "BAIL (critical hp...)"; 不再有"hp<6 仍在推进作业"的录像段
- **观测**: 🟡 热加载生效(下次调用)
- **回滚**: 删两处 hp≤6 检查

## C9-rev1. eat_now 阈值扩展（④层 overseer）
- **触发**: 同上事件——hp=1 时 food=7 不满足 eat_now 的 ≤6 门,但残血时拉满饥饿条是唯一回血路
- **改动**: eat_now 条件 = (food≤6 或 (hp<8 且 food<18)) && 白天 && 无敌对
- **观测**: 🟡 已重启生效;当下因入夜白天门未触发(正确——夜里不出门觅食),天亮后 hp1+food7 应立即触发 feedUp
- **回滚**: 恢复单一 food≤6 条件

## C16. 幽灵银行守卫（③层 prepNether bankRecover）
- **触发**: 死267后裸装重生,bankRecover 走了40格夜路到 bed.json 引用的银行(96,64,-34),没有箱子,空手而归——纯暴露零收益,且每次重生都会重复这趟
- **机理**: 坐标引用比实物长寿(幽灵锚同款病);"no chest"后无记忆,下次照走
- **改动**: ①找箱半径 6→12(容错床箱不贴);②仍没有→写 bank_ghost.json{x,z,t},1小时内同坐标不再跑银行(文件持久化,热加载安全)
- **预测**: progress 不再出现连续两次"no chest within"同坐标;裸装重生不再为幽灵银行走夜路
- **观测**: ✅ 05:46 首验: "bank marked ghost — skip the trip",夜路空跑止血
- **回滚**: 删 GHOSTF 两块

## C17. 饥荒食物链: 觅食PlanB + 紧急食物档（③层 feedUp + ①层 auto_eat）⏳/🟡
- **触发**: "残血无粮"死锁×2(死267前夜 + 今日hp3/food0全天): feedUp 一整个白天4次空手而归(32格内无动物),黄昏再次面临挨饿过夜;期间杀过僵尸但拒吃腐肉(食物正则不含)
- **机理**: 食物链单一依赖动物狩猎,无 PlanB;紧急食物(腐肉/生肉)被正则排除——人类饥荒时吃腐肉不眨眼(80%短暂饥饿病,零真实危险,MC经典荒年粮)
- **改动**: ③feedUp 无动物时: 野西瓜采集(丛林世界主野生粮)→甜浆果→food≤6 吃随身腐肉/生肉(热加载🟡);①auto_eat 加紧急档: 正常食物没有且 food≤6 → rotten_flesh/生肉/蜘蛛眼(等重启窗⏳)
- **预测**: 不再出现"food=0 持续半天以上"; progress 出现 foraging melon/famine eating
- **回滚**: feedUp 删 PlanB 块; auto_eat 删紧急档

## C18. bunkerDown 振荡断路器（①层 modes.js）
- **触发**: 03:47-04:00 死268重生后,"Nightfall securing ↔ Can't seal ↔ running"每300ms一轮振荡13分钟: 裸装无料封不上+无怪可kite(循环被并发interrupt秒退)→mode tick 重燃;每轮interrupt把③层饿死(prepNether拿不到2秒连续执行,progress零输出)
- **机理**: 两个plan(封/逃)在"夜+暴露+无料+无怪"下都瞬时失败且无退避——振荡不仅站桩,还系统性饿死skill层
- **改动**: 封顶失败且12格无怪→bunkerCooldownUntil=now+45s并return(skill层dug-in有徒手能力,让它干);冷却期内无怪不再进bunkerDown;有怪压力时冷却不生效(kite/封墙照常)
- **预测**: 不再出现"securing↔Can't seal"成对刷屏;夜间无怪时progress持续有输出(③层活着)
- **观测**: 🟡 06-11 11:18 重启生效(与C17①/C12-rev1同车)
- **回滚**: 删冷却两块

## C12-rev1. reflex_watchdog 水中威胁分支（①层）🟡(11:18重启生效)
- **触发**: 死268(溺尸水杀×2,死265同款外加新形态)——水中静止5s+两溺尸4.5→2.1格逼近+sp active,但hp没在持续掉→C12"挨打"门没开,最后一击毙命
- **机理**: "挨打中"窗口(2.5s)漏掉"威胁逼近但还没挨打+反射卡死"形态;水中不存在正当静止(无法蹲坑),静止+敌对<8格=必为卡死
- **改动**: 检测条件加 OR 分支: 在水中+静止>6s+敌对<8格 → 同款强制释放
- **预测**: 黑匣子不再出现"水中静止+怪逼近"超过8s的段落
- **观测**: ⏳ 等天亮重启窗(与C17①同车)
- **回滚**: 删 waterThreat 块

## C19. kill-box 寻路软排斥（②层 skills.js _NoScaffoldMovements）
- **触发**: 死269——区外40格找树漫游,路径横穿 kill-box 上方,踩穿屋顶掉到 y29 被僵尸贴脸;expulsion 检查点在循环边界,挡不住"走路途中任意瞬间掉洞"
- **机理**: 区域规避的最后一公里是路径本身——检查点级(C14)管驻留,寻路级才管过境
- **改动**: pathfinder Movements 构造注入 exclusionAreasStep: dzone 圈内每步+60代价(advisory 5s缓存),路线自动绕弯;软代价非禁,被困区内/唯一通路时仍可走
- **预测**: 漫游/作业路径不再横穿 kill-box;区内死亡(掉洞类)归零
- **观测**: 🟡 06-11 11:32 重启生效
- **回滚**: 删 exclusionAreasStep 注入块

## C14-rev1. expulsion 地下分支: 先垂直出洞（③层 两处）
- **触发**: 死270——C19重启后 bot 就困在 kill-box 正中心 y32 洞穴层28分钟没出来,最终僵尸0.6格贴脸杀;expulsion 触发过但目标y=当前y(32),等于要求寻路在蜂窝洞穴网里水平隧穿28格——必败,goToPosition 失败被吞,流程继续区内作业
- **机理**: 区内地下的出口方向是"上",不是"横"——地表无屋顶可掉,横穿洞穴网=穿越怪窝本体
- **改动**: expulsion(missionNether/prepNether 两处): y<55 → 先 customSkill('surfaceUp') 垂直出洞,下轮再径向撤
- **预测**: 不再有"区内地下驻留>5min";progress 出现 "underground in cluster → surfaceUp first"
- **观测**: 🟡 热加载生效
- **回滚**: 删 y<55 分支

## C20. 徒手撸石报警 + 材质门 + 嵌墙自救扩展（①层×2 + ③层）
- **触发**: 用户两连实拍: ①徒手撸深板岩"哪个人类玩家这样挖石头?" ②嵌在崖壁龛里撸两下停+没报警+hp17→10
- **机理三连**: ①digToSurface"prefer dirt route"只是日志,无实现,三处dig调用材质盲 ②嵌墙=LEASH硬回拉的pathfinder半挖通道+self_pres中断风暴(徒手挖石7.5s vs 1Hz中断,永远凑不满一块),C7只查头部格,脚部嵌入不掉血但卡死移动 ③报警mode写好但攒批次没载入
- **改动**: ③chopWood digToSurface 材质门(_digOK: 徒手只挖土砾类)+阶梯两轮制(strict全土→relax撸石兜底)(热加载🟡);①bare_stone_alarm always观察mode: targetDigBlock石质+手无镐→30s去重写ALERTS.txt(碰一下就报);①C7-rev1: 嵌墙检查+挖掘扩展到脚部格(头部=窒息伤,脚部=移动锁)
- **预测**: [ALERT] BARE-HAND STONE DIG 在徒手碰石头数秒内推送;嵌墙状态<10s自救;徒手撸石频次→0(材质门)
- **观测**: ✅报警首日战果: 上线1小时连抓**五处**材质盲挖掘——①digToSurface(三点) ②pinned dig-staircase ③achieve采石循环(徒手零掉落白刨,collect stone[0/3]死循环) ④pathfinder在collectBlock('dirt')内挖穿自家圆石坑壁 ⑤stocking夜间重入拆自己封顶出坑。全部修复: 材质门(③×3)+collectBlock收获门(②)+pathfinder exclusionAreasBreak徒手石质+100(②)+stocking夜门(③)。13:42重启后全链生效
- **回滚**: 各块独立删
- **教训**: 报警类改动不该攒批次——监工的眼睛优先级高于行为优化,写好立即上车。一个好的报警器比十次巡查值钱

## C21. LEASH raw-walk fallback + eat_now 怪门放宽（③层 chopWood + ④层 C9-rev2）
- **触发**: 崖壁钟摆困局一整天: bot 困在 (41,64) 荒地口袋(8树拉黑/无动物/无西瓜/2怪盘踞/hp10 food0 三过夜),LEASH"硬回拉"完全不动——pathfinder 在崖壁 NoPath 秒败(C19副作用放大: 徒手时隧道路线被挖掘代价+100逐出,A*直接放弃),catch后无fallback原地找树;eat_now 被24格雷达边缘徘徊怪挡了一整天
- **改动**: ③LEASH goToPosition 失败且位移<6格 → 朝锚向带坑探测的 raw walk 5s脉冲(反复调用渐进回家,走planner拒绝的地形);④eat_now 怪门 hostiles===0 → (===0 或 nearest≥12)
- **预测**: bot 24h内离开 (41,64) 口袋回到锚区;food 曲线起底
- **观测**: 🟡 热加载+overseer已重启
- **回滚**: 删 raw-walk 块;eat_now 条件回收
- **C19副作用记录**: 挖掘代价注入让徒手期的崖壁寻路成功率显著下降——软代价的代价。raw-walk fallback 是对冲

## C22. MLG垫柱放置窗口修复（③层 chopWood 两处: LEASH pillar + digToSurface pillar）
- **触发**: 棺材逃生中垫柱3轮全败;增强诊断日志(refL=tuff/Vec3=true/apex通过仍placed=false)+ERR行最终揪出: "blockUpdate did not fire" = **服务器拒绝放置——bot自己的hitbox还占着目标格**
- **机理**: 跳跃apex在~290ms(+1.25格),旧代码固定380ms后才检查+放置——apex已过,身体落回占格,必败。目标格只在 y>起点+1.01 时完全让出(~200ms窗口)。**digToSurface的同款垫柱从上线起就默默全败,历史爬升全靠阶梯分支兜底**——潜伏数轮的根bug
- **改动**: 跳起后30ms轮询y,越过+1.01瞬间放块(700ms总窗),两处同修
- **预测**: pillar 日志 placed=true 出现;垫柱爬升真正可用;凹龛逃生提速
- **观测**: 🟡 热加载生效
- **回滚**: 恢复固定380ms等待
- **方法论**: 增强日志(把守卫值打出来)两轮就定位了潜伏数日的bug——"看不见的失败"必须让它说话

## C18-rev1. bunkerDown 有怪振荡断路器（①层）
- **触发**: 用户实拍"做什么都只做一下就停"——events.log 揭示"Nightfall securing"循环从06:01刷了1.5小时: 夜+暴露(烟囱顶)+2怪压制 → bunkerDown 每tick抢占 → 封不上 → kite被并发interrupt秒退 → 重入;每轮抢占把撸顶/垫柱掐死在第一下(一块圆石撸一小时的真凶)。C18只修了无怪分支
- **改动**: ①同位置3连败(封不上)→30s冷却;②冷却期间只有<5格真贴身威胁(或苦力怕<8)才重开bunkerDown——远处压制怪不再有抢占权。self_defense/贴脸拔剑不受影响
- **预测**: "Can't seal (3x) standing down"出现后,撸顶/垫柱获得≥30s连续窗口,逃生speed↑;securing消息频率大幅下降
- **观测**: 🟡 14:35 重启生效
- **回滚**: 删 _sealFailN 块+入口恢复"无怪才冷却"

## C23. act_trace 行为心电图 + eat_now 短路解除（①层遥测 + ③层）
- **触发**: 用户怒斥"你的监控与纠错系统也存在系统问题"——凹龛8小时里我用死后黑匣子猜了4个机理(悬岩/hitbox/sneak/时序)全错,因为根本看不见"它正在按什么键、哪个代码在按"
- **遥测**: ①act_trace always mode 1Hz落盘 {pos,onGround,按键,当前action,寻路状态,挖掘目标} → act_trace.jsonl(10MB轮转)。**上线90秒即破案**
- **真相**: bot 不是"循环互卡蹦跶"——是**完全静止空转**: food=0 让 advisory 持续 eat_now → missionNether 循环顶端 wait(3000)+continue 每3秒短路 → KILL-BOX/LEASH/prepNether 永远轮不到。我自己加的觅食优先级(C9)把整个任务流饿死
- **修复**: eat_now 失败后放行任务流(找树→造镐→装备→打猎才是真正的食物路径),只在真吃上(food>6)时 continue
- **遥测盲区2.0记录**: act_trace 的 act 字段对 run_skill 不可见(runSkill 不走 ActionManager)——скилл级"在干什么"仍靠 progress.txt;按键流是行为层真相
- **教训**: **调试活着的问题必须有活着的遥测**;监工连续两次被自己的优先级机制反噬(eat_now 短路=shelter抢占的同构),"高优先级分支的失败必须放行,不能原地等"应成为循环设计公理
- **观测**: 🟡 15:25 重启生效
- **回滚**: act_trace 删 mode;eat_now 恢复 continue(不推荐)

## C24. 死271复盘: stair-place 体距检查 + 窒息先挪后挖（③层 + ①层⏳）
- **触发**: 死271(窒息,凹龛内)——**我刚上的 C22-rev4 stair-place 杀的**: open()检查只查方块不查实体占位,bot跨格站位时块被放进身体;徒手挖圆石7.5s>窒息致死6s(hp10),C7反射注定挖不赢
- **改动**: ③stair-place 放置前体距检查(目标格心与hitbox水平距<0.85→不放)(热加载🟡);①C7窒息反射先试侧步走出(0.5s停伤)再挖(⏳等重启窗)
- **凹龛战役终局**: 死271把bot重置出狱(重生(0,87,0)开阔地满血满食)——30小时的棺材位被一次放置事故终结。战役总产出: act_trace心电图/邻格阶梯垫法/8个调度与放置类根bug修复——全部普适资产
- **教训**: 自己写的逃生代码成为死因——放置类操作的检查清单必须含"实体占位",不只方块;**任何 placeBlock 进 bot 半径0.85内的格子都是潜在自埋**
- **观测**: 🟡/⏳
- **回滚**: 各块独立

## C25. 蹲坑选址水域否决（③层 prepNether dug-in）
- **触发**: 死272——溺尸水杀×3(265/268/272): 蹲坑现场4格外是水体,夜里溺尸上岸0.8格贴脸拖走;旧检查只拒"脚下是水",不查"身旁有水"——夜间水岸线就是溺尸刷怪场
- **改动**: dug-in 挖坑前 8格内有水面 → 背水walk 12格再挖
- **预测**: 不再出现"死于蹲坑现场+inWater/Drowned"组合
- **观测**: 🟡 热加载生效
- **回滚**: 删 WATERFRONT VETO 块

## C26. 树荒缰绳扩展（③层 chopWood）
- **触发**: 锚区树荒——11棵拉黑(全是崖上丛林冠,徒手不可达),80格缰绳内是死果园,整条重建链卡在"差一根原木"(板→台→镐总开关);凹龛期同症
- **改动**: 拉黑≥8(树荒判定)→候选环+回拉触发同步 80→160;砍到树离开区域后拉黑TTL过期自动回缩
- **预测**: 树荒时 progress 出现 >80格的 nearest 候选;"差一根原木"死结解除时间<30min
- **观测**: 🟡 热加载生效
- **回滚**: 两处 _leashR/_pullR 恢复常量80

## C27. 机动性状态机 mobility（①层 always 建模+反射 + ②层 vitals 广播）
- **触发**: 用户: "bot应该通过上帝视角时刻对周围环境程序化建模,维护状态机;你的探针信息也不够"——活埋事故链的最终答案: ENV-SNAPSHOT 证实 bot 被自己的封顶/垒墙浇筑成全实心包围(身体两格是空气→窒息反射不触发;四面+顶实心→一切移动失败),这个状态在bot认知里不存在,8分钟兜底计时是偷懒
- **改动**: ①mobility mode 每2s分类 FREE(有出口)/POCKET(顶开无出口)/ENTOMBED(活埋)/SWIM;ENTOMBED→**立即**朝锚挖2格身位(反射级,无计时无材质门);POCKET>60s→凿台阶;状态变化记progress;②vitals 广播加 mob 字段(监工每拍可见机动状态)
- **观测**: 🟡 12:05 真重启上线;60秒内 ENTOMBED 反射开始挖掘(ALERT 12:06:02 撸 108,65 = 朝锚方向脱困,设计内可见)
- **事故链全账(11:48-12:05)**: ①idle-wedge 误判蹲坑→interrupt风暴 ②两次"重启"只杀子进程,父进程自动复活子进程,修复从未上车,监工对着空气宣布成功 ③真重启=杀父+杀子+端口确认+进程创建时间验证
- **教训三条**: 重启必须验证进程创建时间;保护系统与既有反射的交互必须验证;状态建模优于停滞计时(主动认知优于被动兜底)
- **回滚**: 删 mobility mode + vitals mob 字段

## C28. MAROONED 行军独占的"拔河"修复三连（①层sp让位+粘性驻留 + ②层全寻路门 + ③层chopWood bail）
- **触发**: 用户连报4次"还在打转"后立即30秒全量取证(第六原则的诞生现场),act_trace 60帧逐帧分析,两轮破案
- **机理链(三个互锁bug,逐层揭开)**:
  - ①sp优先级倒置: self_preservation 夜间蹲坑驻留长期占 active,modes 调度的 active-break 让 MAROONED 行军**从未获得执行权**(act字段60帧全是 mode:self_preservation,零挖掘)
  - ②修复互锁: 移动独占门拦掉任务层寻路→noPath 事件断流→粘性 MAROONED 判定失据→FREE↔MAROONED 振荡
  - ③寻路门漏网: MAROONED 门只加在 goToPosition,而 moveAway/moveAwayFromEntity/avoidEnemies 直接走 goToGoal——act_trace 实拍行军修路推进 x112→x123,任务层 chopWood 的 unstick moveAway 20秒又拉回 x112,**两个并发控制流拔河**(action系统 vs sticky skill 异步循环);missionNether 的 STAND-DOWN 只在 iter 开头查,chopWood 一进来就是分钟级控制流,形同虚设
- **改动**: ①sp update 开头 MAROONED/ENTOMBED 且无<6格威胁→return;mobility 粘性判定最短驻留3分钟;②goToGoal(公共寻路入口)开头 MAROONED 门,6格内敌对豁免(逃命优先,与sp让位对称);③chopWood 主循环开头 MAROONED bail(热加载双保险)
- **预测(可证伪)**: act 出现 mode:mobility 且位置单调远离锚区,不再"推进N格又被拉回";若仍打转→查行军 dig 被interrupt斩 / 行军改独立异步循环
- **观测**: ①上线(pid54124 21:17)后行军**首次拿到执行权,实测推进7格**——证实①②有效并暴露③;②③上线 21:32:59(pid65112,CreationDate验证)
- **✅归因(21:52 战役终结,>12h被困解除)**: 21:36 MAROONED判定→行军独占(act帧20/20,progress实锤"chopWood BAIL"+"standing down")→东向撞煤矿墙(徒手15s/块,burst 2连败)→右转盘转向西→挖穿自己的蹲坑圆石墙→114→103 单调西进→**21:52:22 mobility→FREE,任务层无缝接管**(prepNether重启,入夜正确转蹲坑)。全程17分钟,无拔河无振荡无回拉。**2连败右转的方向轮盘意外成为地形自适应**:磨不动的墙自动放弃,畅通方向自动胜出
- **遗留观察**: 13:47:17-28 有12帧 act='-'且path=1 的无主寻路(候选:EVAC直接setGoal绕门)——方向凑巧无害,复发再追
- **回滚**: goToGoal 开头 MAROONED 块 + chopWood iter 开头 MAROONED bail;①②回滚见上轮记录

## C29. pin-breaker 夜蹲豁免（①层 reflex_watchdog）
- **触发**: risk83 警报取证(21:58): "Pinned 15min+ — kicking the stack"——pin-breaker(10格内5分钟→每60s强拆)把夜间蹲坑驻留判成被钉死,把 bot 从坑里踢到夜间地表乱跑,撞上 enderman(虚惊,15格外中立,DISENGAGE无掉血)。idle-wedge 有蹲坑豁免(C12-rev2),pin-breaker 漏了——"保护系统互绞"家族第3员(idle-wedge误判蹲坑/独占门吃noPath信号/本条)
- **机理**: 正当夜蹲(静止+驻留)与死锁(钉死)在 pin-breaker 的判定维度(位移+时长)上不可区分——必须引入"这是庇护"的语义信号(夜间+头顶有盖)
- **改动**: pin-breaker 强拆前查 idle-wedge 同款豁免条件: tod∈[12000,23500] 且头顶3格内有实心块 → 不踢
- **预测(可证伪)**: 夜间不再出现"Pinned 15min+ kicking"消息;蹲坑整夜连续;不再有"踢出→地表乱跑→重蹲"循环。副作用警戒: 若 bot 夜间真死锁在有盖位置(如 MAROONED 卡死在洞里),pin-breaker 失效——但 MAROONED 行军和 BREAKOUT 各有自己的脱困路径,可接受
- **观测**: 🟡 22:02:20 重启上线(pid68060,CreationDate验证;首次执行"先杀watchdog再重启"新流程,无竞争窗口)
- **回滚**: 删 nightBunker 块恢复无条件强拆

## C30. 朝树行军（①层 mobility,行军方向初算优先级重排）
- **触发**: C28 出狱后2分钟 bot 又回到东侧迷宫再判 MAROONED——复盘发现宏观钟摆: "距床<25反向开拓"把行军派进东迷宫,>25又派回,25格边界两侧反复横跳;根因=锚区整体是寻路孤岛(树全在崖顶,11棵拉黑,"No logs within 40 blocks (x6)"),任务层在哪都 noPath 累积,MAROONED 必然复发,行军成了无目的钟摆
- **机理**: 行军缺目标——"逃离"对孤岛地形无意义,被困+缺木头的人类会朝看得见的树修路。拉黑树="寻路不可达",而行军不用寻路,修路恰恰可达
- **改动**: bot._marchDir 初算优先级: ①findBlocks 64格内 *_log,过滤 y差≤6(崖顶冠水平行军够不着,不追),取最近,方向=朝树,say "March target: log @x,y,z" ②无低位树→原朝床/背床逻辑
- **预测(可证伪)**: 下次 MAROONED 若64格内有低位树,出现"March target: log"消息且行军终点≈树底,FREE 后 chopWood 立即有收成;若树全高位,行为同旧版(回退)
- **观测**: 🟡 22:08:12 重启上线(pid45644,CreationDate验证,watchdog先停后启无竞争)
- **风险**: 行军挖到树底但树冠在 y+6 内够不着的情况(树干可达即可收);findBlocks 性能(64格8个,毫秒级,可忽略)
- **回滚**: 删朝树块,保留原床锚逻辑

## C31. NOPICK-FAMINE: 四方向全石面时放开徒手凿阶梯（③层 chopWood dig-staircase）
- **触发**: 22:09 对账发现重建链真死结: 桦树全在 y87-92 崖顶(bot y63,水平仅28格),dig-staircase 的"徒手禁撸石"门(05:01 报警事故后加的)四方向全 ABORT(stone face, no pick)→树全拉黑→**"上崖要凿石→凿石要镐→做镐要木→木在崖顶"闭环锁死**。圆石只剩1块
- **机理**: 门的本意是"换方向找土面,徒手别磨石"——前提是存在土面。全石崖壁地形该前提不成立,门从优化退化成死锁。徒手凿石10s/块×~50块≈9分钟买下整条科技树,比死结强
- **改动**: _stoneAborts 计数器: 前4次石面照旧 ABORT换向(保留"优先土面"策略);轮完4方向确认无土面→第5次起放开徒手凿(NOPICK-FAMINE 日志行)
- **预测(可证伪)**: 下个白天 chopWood pinned 后出现"NOPICK-FAMINE: all headings stone — bare-hand climb accepted",y 开始稳步爬升(10s/块),~10-15分钟后够到 y87 桦树,total>0 首根原木落袋,重建链(板→台→镐)启动
- **观测**: 🟡 22:13 热加载上线(③层,无需重启)
- **风险**: 徒手凿期间暴露时间长(夜门/危殆让位/MAROONED bail 都在循环开头兜底);凿到崖顶后摔落风险(阶梯式爬升自带落脚)
- **回滚**: 删 _stoneAborts 块恢复无条件 ABORT

## C32. ENCLOSED 全景封闭判定: 封闭地穴夜里不停工（①层 mobility 扩展 + 三处夜门消费）
- **触发**: 用户指点: "建立基于全知视角的全景状态机,判断自己是否处在封闭地穴(与地面联通很远)——是的话夜里就不需要停下来"。现状: 夜门们用 tod+y≥50 当"夜间暴露"代理变量,y≥50 的崖体隧道/封闭洞里被误当地表,整夜蹲坑停工(行军挖的隧道正是这情形)
- **机理**: "是否暴露"该由世界模型直接回答而不是 y 坐标代理——封闭空间里夜=昼,威胁只来自近身怪(已有 shouldFlee/怪压分支兜底),预防性蹲坑纯属浪费夜晚
- **改动**: ①mobility 每2s评 enclosed: 3x3采样列(间隔4格)×向上35格,全部有实心=与开放天空隔离;进入2连评(防单格屋檐),退出即时(保守不对称);挂 bot._mobility.enclosed,vitals mob 加 /ENC 后缀,转换记 progress ②sp shouldNightShelter: enclosed→return false ③prepNether 夜 hold: enclosed→break 继续作业 ④chopWood NIGHT-BAIL: enclosed→不 bail ⑤(rev1, 15:15 对账抓漏) achieve.js 两处 _nightExposed(skip chopping for planks / best-effort pre-steps)同款豁免——全库 y≥50 代理夜门 sweep 清零
- **预测(可证伪)**: progress 出现 "[mobility] enclosed → true/false" 转换;隧道/地穴内夜间 act_trace 持续有 dig/forward(不再整夜 sp 驻留);蹲坑只发生在真暴露地表
- **观测**: ⏳ ③层热加载已上(enclosed 字段未广播前 undefined=安全回退);①②层等天亮重启窗口
- **风险**: 35格上探在高顶洞穴(顶在36+格)误判 enclosed=false(保守方向,无害);封闭但有怪刷的大洞夜里作业遇怪——近身分支兜底
- **回滚**: 删 enclosed 块+三处消费行

## C31-rev1. NOPICK-FAMINE flag 挂 bot 持久化（③层）
- **触发**: progress 实拍计数器到 4/4 后永远没有第5次——_stoneAborts 是函数局部量,missionNether 每 iter 重调 chopWood 就归零,无限轮回 1/4→4/4
- **改动**: 4/4 时 bot._nopickFamineAt=now,10分钟持久豁免跨调用生效("NOPICK-FAMINE armed"日志)
- **观测**: 🟡 22:25 热加载
- **教训**: 跨调用状态不能放函数局部量——chopWood 被编排层高频重调,"本次调用内"的计数语义全部失效

## C33. 凿崖心跳: dig-staircase 活跃时不判 MAROONED（③层心跳 + ①层让步）
- **触发**: C31-rev1 后 NOPICK-FAMINE 仍未触发——结构性饿死: chopWood 需 3-4min stale 累积才进凿崖,MAROONED 90s 插队,FREE 窗口实测 ~2min 永远不够。凿崖被行军反复斩在半路(同构家族: sp占active饿死行军→行军插队饿死凿崖,**每个新长流程都要审一遍"会不会被更高优先级饿死"**)
- **机理**: 凿崖是垂直工程,水平位移小,正好踩 MAROONED 的位移判定——但爬山是有目的工程不是被困
- **改动**: ③dig-staircase 进入时 bot._climbingAt=now(每stall刷新);①mobility FREE 判定块: 心跳2min内→重置锚不判 MAROONED
- **预测(可证伪)**: 凿崖期间不再出现 MAROONED 转换;NOPICK-FAMINE armed→bare-hand climb accepted→y 稳步爬升→首根桦木
- **观测**: 🟡 22:47:01 重启上线(pid62852,CreationDate验证)。**插曲: 22:22 的 C32 重启实际被 watchdog 偷换**——我起 agent 后立刻起 watchdog,48909 还没 LISTEN,watchdog 判 DOWN 又拉一对,我那对 EADDRINUSE 崩,跑的是 watchdog 的(代码恰好已含 C32,侥幸无损)。**重启流程 v3: 杀watchdog→杀agent→起agent→等48909 LISTEN→才起watchdog**
- **回滚**: 删心跳行+①层让步块

## C34. 威胁可达性过滤: 够不到的近战怪不算威胁（①层 nearbyHostiles 源头）
- **触发**: 15:21 对账: 白天 y 爬升=0,act_trace 20/20 帧全是 self_preservation——凿崖一秒没跑。机理: 荫蔽破碎地形(白天怪不烧)里怪挂在崖上/坑底,sp 的威胁判定只算距离(10格)不算可达性,80%"威胁"物理够不到 bot(y71骷髅 vs y62bot 整夜零命中),sp 永久占身体,作业层结构性饿死。这是"sp占active饿死行军"(C28)的姐妹形态——根因都是威胁评估过保守
- **改动**: nearbyHostiles(12个判定点的共享helper)源头过滤: 近战怪 |dy|≥5=物理够不到→不算;远程怪(skeleton/stray/pillager/witch/blaze/ghast)保留(箭越高差);creeper 走 nearestCreeper 不受影响。绕下来的近战怪 |dy|<5 自然回到威胁集,响应延迟仅几秒
- **预测(可证伪)**: act_trace 的 sp 帧占比大幅下降;凿崖获得连续窗口,y 爬升曲线恢复;蹲坑/kite 只对真可达威胁触发。副作用警戒: 近战怪绕路下来的几秒延迟若造成掉血,记录归因到本条
- **观测**: 🟡 23:24:29 重启上线(pid60948,流程v3,贴入夜界但 bot 在 ENC 隧道安全位)
- **回滚**: nearbyHostiles 恢复纯距离过滤

## C35. feedUp PlanC: 捡地表食物掉落物（③层）
- **触发**: 15:37 hp 8→6(疑似凿崖跳跃摔落)进入死水局: hp6 踩中危殆bail线(作业全停)+food0 无回血+这片破碎崖壁无动物无瓜无浆果(PlanA/B 全空)=食物死结锁死一切产出
- **机理**: 白天阳光烧怪,腐肉/熟鸡散落地表——白送的紧急口粮,人类必捡;feedUp 只会猎/采,不会捡
- **改动**: PlanB 全空后 PlanC: 24格内 item 实体名匹配食物正则→goToPosition 捡→紧急档吃(food≤6 腐肉可入口)
- **预测(可证伪)**: progress 出现 "PlanC — food drop";food 曲线脱离 0;hp 缓回 >6 解锁作业线
- **观测**: 🟡 15:40 热加载;**rev1(15:45)**: 实测 feedUp 被调3次 PlanC 零触达——它排在 night/hostile 守卫后,荫蔽怪窝 10格常驻怪让守卫永远先 break;且 feedUp 的 hostileNear 没吃到 C34 过滤。修: ①hostileNear 加同款高差过滤 ②PlanC 前移到守卫前(拾取≤16格+无6格内可达威胁=低险快进快出,与 roam-hunt 不同险级);掉落物5分钟 despawn,明早天亮烧怪窗口(tod 0-2000)是主战场
- **回滚**: 删 PlanC 块+hostileNear 恢复

## C36. 危殆bail线 6→4: 保命线不能锁死回血路径（③层 chopWood+digToSurface）
- **触发**: 15:57 全量取证确认死水局闭环: hp6 踩 hp≤6 bail线→作业全停;food0→不回血→hp永远6→永久锁死;PlanC 拾尸失效(掉落在 y70+ 地表,bot 在 y59 坑里隔地形够不到);每个夜晚都在赌命
- **机理**: "hp低就让位生存"的前提是存在生存路径——本局面回血链=木头→工具→武器→猎食,全在作业线上。保命线锁死回血路径=悖论,bail 是为了活,锁死才是死
- **改动**: chopWood/digToSurface bail 线 hp≤6→hp≤4(hp5-6 允许低险作业;C34 后怪窗口干净,凿台阶1格跳无摔伤)
- **预测(可证伪)**: chopWood 重新运转(不再 "BAIL critical hp 6.0");若 hp 因作业跌到 ≤4 则证明放宽过度,回滚
- **观测**: 🟡 15:58 热加载
- **升级预案(若仍死水)**: DEADLOCK-RESET 决策逻辑——hp≤6+food0+feedUp连续空手+零资产(无武器甲食)→接受死亡重置(满血满食+离开被诅咒地形,275次死亡里裸死成本=0)。这是人类速通玩家的真实决策,编码为bot自主逻辑非外部操作
- **回滚**: 两处 4 恢复 6

## C37. 凿崖 CLIMB LOOP: 一次进入连续凿到登顶（③层 dig-staircase 内循环化）
- **触发**: 16:02 对账: C36 解锁后 NOPICK-FAMINE 连续3次 accepted 方向稳定,但 y 纹丝不动——dig-staircase 是 stall 驱动每次一格,chopWood 重入位置漂移(tgt 114↔122),爬25格需要的"同一位置连续凿+跳"永不积累
- **改动**: 单次凿逻辑包进 CLIMB LOOP: 每轮重算位置+刷新 _climbingAt 心跳,上限40轮(无tgt=3轮,纯脱困);退出=登顶(y≥tgt.y-2)/4轮零爬升/hp≤4/打断;stone-gate 与 hole-probe 的 throw 保留(跳出循环换向,下stall重进)
- **预测(可证伪)**: progress 出现连续爬升轨迹,"climb DONE y="或"climb STALL";y 从 63 向 87 单调推进;登顶后 chopWood 收割首根桦木 total>0
- **观测**: 🟡 16:04 热加载;首跑暴露 rev1 的靶(循环跑通,STALL 全 4 平轮)
- **rev1(16:11, STALL 破案)**: 旧 cells2 把前方脚位 (dx,0,dz) 也挖了——"凿台阶"实为凿水平隧道,forward+jump 走平地 y 永不涨。修: 前方脚位实心→保留当台阶,只挖头位+头上+自己头顶,跳上去站高1格;脚位本空(平地/坑)才用旧隧道模式。**教训: "staircase"代码从未真的造过台阶,挖法决定几何——挖掘类代码要画出挖完的剖面图验证**
- **回滚**: 拆掉 for 循环壳恢复单次;rev1 恢复无条件4格cells

## 死276复盘 + 战役转折（16:24, creeper 隧道爆杀 → 重生点翻盘）
- **死因链**: enderman 被激怒(疑似行军/凿崖的 lookAt 扫过它的脸——结构性风险待修: lookAt 不避 enderman)→打掉 6→4→逃进 ENC 隧道→creeper 跟进封闭空间(隧道是双刃剑,怪也能进)→2格爆杀。hp4 无容错
- **转折**: 重生(0,87,0)满血满食 = C36 预案"接受死亡重置换地形"自然兑现。**重生点旁就有橡树**——崖壁区三天卡死的"差一根原木"死结,重生点5分钟解决: oak_log×3+planks×4+stick×3+wooden_sword(几天来第一件武器),chopWood 正常运转
- **战略复盘**: 崖壁区战役(C28-C37)的全部修复是普适资产(行军/状态机/凿崖/可达性过滤/夜门豁免),但"在那片地形打转三天"本身是战略失误——**早该评估"这片地形值不值得救"**;裸资产时死亡重置成本=0,是合法的快速换地形手段。监工要更早把"换地形"放上桌面
- **enderman 激怒待修(若复发)**: 行军/凿崖/挖掘的 lookAt 路径上有 enderman → 先偏转视线(lookAt 目标点压低/绕开 enderman 头部 ±2格)

## C38. digToSurface 真地表判定（③层,y≥64 旧线 → 三条件）
- **触发**: 16:49 取证: 重生区 bot 在 y64 天窗洞里永动——digToSurface 的 DONE 条件 y≥64 是老世界地表线,重生区真地表 y82;DONE→chopWood 找不到树→再调→再 DONE 死循环;同时木镐磨尽(tool_keeper 没备上,根因=木材buffer没囤够就开挖矿,记#21)
- **改动**: DONE=三条件: y≥60+头顶整列(36格)见天+enclosed=false(C32)。单用 enclosed 不行(1格天窗翻false,对夜门保守正确对出地表过松);状态机未建退回 y≥70
- **预测(可证伪)**: "digToSurface DONE (true surface)"出现时 bot 真在地表(y~82);y64 洞不再判 DONE;爬升继续到顶后 chopWood 收割橡树→板→新镐
- **观测**: 🟡 16:52 热加载
- **教训**: 硬编码的世界常量(y64 地表线)换世界就错——地形事实要问状态机/实测,不要写死
- **回滚**: 恢复 py>=64 单条件

## C39. 行军/挖出锚的幽灵床守卫（①层 两处 bed.json 读取）
- **触发**: 17:55 行军被幽灵床带偏: bed.json 还是崖壁区老床(96,-34,死276后无意义),行军朝东水平挖,离 spawn 的树(真目标)越来越远,y 卡 67
- **改动**: MAROONED 方向初算 + ENTOMBED 挖出方向,两处 bed 读取后加 ghost-bed guard: 距床>60(缰绳外≈床已无效)→spawn_pos.json 兜底(真锚)
- **预测(可证伪)**: 下次 MAROONED 行军方向朝 spawn(2.5,82)而非(96,-34);bot 向西/向上走向重生高地
- **观测**: 🟡 01:00:01 重启上线(pid57732,流程v3含端口等待)
- **回滚**: 删两处 guard
- **rev1(17:46)**: 第三处同款——chopWood 缰绳锚 _ax,_az 也读 bed.json,树荒 LEASH 回拉会把 bot 拉回崖壁区!加同款 guard(③层热加载)。**教训: 修一个数据源的消费方要 grep 全部消费方**(bed.json 有3处读取,我修了2处漏1处)
- **死277复盘(17:36 溺水)**: hp1(骷髅射+饥饿损血+逃跑冲下9格悬崖)时 sp 逃跑路线进水,1跳致死。尸物(台/炉/板/剑/37圆石)水底捞取失败已 despawn。连续两死共同背景=食物死结(两片区域均无动物,feedUp 持续空手)——食物链是下一个结构性课题(钓鱼?种地?待评估)

## C40. enderman 水庇护逃跑评分（①层 safeFleeTarget）
- **触发**: enderman 激怒第二次(17:55,同只585237,hp 20→15→11 追杀连击)——死276同款,走位甩不掉瞬移怪。人类标准操作=跳水(enderman 碰水掉血不追)
- **改动**: safeFleeTarget 的水评分条件化: 8格内有 enderman→水 +20/项(庇护);否则照旧 -15(避溺尸)。**drowned 例外**(死278十分钟后就教了课: 水甩掉 enderman 但溺尸接锅 hp3 两下带走): 候选点10格内有 drowned→不加分照旧避水
- **死亡三连复盘(276 creeper/277 溺水/278+279 溺尸)**: 共同背景=食物死结(hp 低位常态)+水域溺尸雷区+enderman 激怒。死279=重生后68秒被东水域溺尸伏击(corpseRun 防护链没毛病,是路过水域被截)
- **观测**: 🟡 01:59:46 重启上线(pid63324)。重启命令管道杀进程两次 exit 255——改直接 Stop-Process -Id 列表,流程v3注记
- **回滚**: 水评分恢复无条件 -15

## C41. 监控新鲜度门 + 裸挖石实时 trigger/body guard（监工链+①/③层）
- **触发**: 新监工误把历史 tail 当实时现场,用户指出"游戏还没启动,你看到的应该不是实时日志";随后 live 现场连续出现 `BARE-HAND STONE DIG`(04:12 POCKET,04:14 ENTOMBED/chopWood,04:21 重启前手空)——轮询能事后看见,但动作已经发生。机理: 监工缺 fresh/live 判定;同时 5类控制流(尤其 mobility tick mode)能直接 `equipForBlock→dig`,策略层以为有 pick,身体实际 held=dirt/empty,没有统一身体门
- **改动**: ①新增/修 `fresh_status.mjs`: 端口+文件 mtime 给 `classification`,且同时 probe `127.0.0.1`/`::1` 防 mindserver 只监听 IPv6 被误报 closed;交接文档要求先跑 fresh_status 再解读日志。②bridge/ws_server/watchdog 接入 `cancel_skill` 控制帧,watchdog 在 stuck/death-spiral 可实时打断而非只轮询重启。③`chopWood`/`surfaceUp`/`mobility` 增 `guardedDig`: 挖 stony block 前必须确认**实际 held item 是 pickaxe**;确认不了就不 dig,只有显式 `_plannedNoPickStoneUntil` emergency window 才允许 no-pick stone。④POCKET/MAROONED/ENTOMBED 走同一 guard,把本轮旁路收口
- **预测(可证伪)**: live 状态下 `ALERTS.txt` 不再新增非 planned 的 bare-hand stone;若出现新条,用 lastEvent+act_trace 定位剩余 `bot.dig` 旁路并继续下沉 BodyGate。fresh_status 不再把 `[::1]:8765` 误判 closed
- **观测**: 🟢 12:23:25 重启上线(pid 48909=18088,8765=41216,MC 55916=8620 未动);12:25 fresh_status=live 且 mindserver=open;12:26 bot 从 y21→y34 持 stone_pickaxe 爬升,无新 bare-hand alert(最后一条仍是重启前 04:21:27)。仍见 self_preservation night hold 与 chopWood/surfaceUp 交错,说明 BodyGate 结构重构仍是主线而非已解决
- **回滚**: fresh_status 回退单 host probe;删 guardedDig helper并恢复裸 `equipForBlock→dig`;ws_server/bridge/watchdog 去掉 cancel_skill 控制帧

## C42. 矿洞动作黑匣子 + 台阶上坡/地表回拉修复（①/③层）
- **触发**: 用户指出矿洞行进质量差: 挖砖路线、垫砖时机、上坡卡台阶边缘都必须看全量轨迹/操作日志。C41 后仍出现两条 post-restart `BARE-HAND STONE DIG`(held=cobblestone/granite),说明只在局部 skill 加 guard 不够;同时 progress 复盘显示 bot 曾 digToSurface 到 y83/y85 真地表,随后 `chopWood LEASH`/raw-walk 又把它往锚点硬拖,跌回 y50-60 的矿洞/崖壁区域。
- **改动**: ①`modes.js` 新增 `mine_motion_audit` 常驻模式,包装 `bot.dig`/`bot.placeBlock`,把每次操作的 bot 坐标、目标/参考方块、held item、hp/food、skill/mobility、3x3x4 周围图景、耗时和结果写入 `bots/_supervisor/mine_motion.jsonl`;同时作为最后一道 BodyGate,非 planned 的 stony dig 必须实际手持 pickaxe。②`chopWood` 增 `_motion` 本地记录和 `_ascendStep` 上坡原语,所有 surf/raw/LEASH/pinned 的台阶/垫块上坡改走"清控制→居中→非 sprint forward+jump→失败后后撤再试"。③`chopWood LEASH` 增 high-open-surface 豁免: y≥70 且头顶见天时不再 raw-walk 回锚点,避免刚出矿洞又被拖回矿洞/shaft。
- **预测(可证伪)**: 新进程或热加载后 `mine_motion.jsonl` 持续出现 `dig.begin/end`, `place.begin/end`, `ascend.begin/end`;任何新裸挖石会先落 `dig.blocked` 而不是真实开挖。上坡卡边缘时应看到 ascend 多次尝试后 rise 成功或明确失败,不再长时间 forward+jump 原地磨。digToSurface 到高处开阔地表后出现 `chopWood LEASH SKIP`,不再立刻向旧锚点硬拉回矿洞。
- **观测**: 🟡 12:49 agent-only 重启加载 audit,`mine_motion.jsonl` 立即出现 `audit.installed` + 两次 torch `place.begin/end` 全上下文;12:56-12:57 记录到 `ascend.begin/end` 且 pinned/raw stair 多次 `ok=true,maxRise≈1.0`,证明新上坡原语能越过台阶边缘。12:55 试图解 hp4/food0 饥饿死结时临时放开 critical forage,抓到反例: LEASH/coffin 裸手挖顶石告警 + 随后 fall 死284;rev1 已禁 critical forage 下 LEASH,rev2 又把 hp4 覆盖收回(`allowCriticalForage` 不再突破 hp≤4 保命线)。**教训: 低血食物死结不能靠"继续作业"赌,必须另设计食物策略/死亡重置策略;movement 修复不能越过生存预算。**
- **回滚**: 去掉 `mine_motion_audit`;`chopWood` 恢复 raw forward+jump 台阶动作;删 `highOpenSurface` LEASH 豁免。

## C43. 矿洞 BodyGate 独占 + 深层禁盲挖 + 台阶边缘 reflex（①/②/③层）
- **触发**: `mine_motion.jsonl` 抓到真实并发抢手: 05:03 `dig.begin seq205` 持 `wooden_pickaxe` 挖 stone,6.2s 后 `dig.end` 时 held 变 `dirt`;05:05 y=-30 附近 `place.begin`/`dig.begin` 同毫秒交错,held 在 `stone_pickaxe` 与 `cobbled_deepslate` 间切换。机理不是"没装备工具",而是挖掘未结束时另一路垫块/装备动作抢了 hand。同时 `achieve` 的补矿 fallback `digDown(8)` 把 bot 从 y43 快速打到 y=-30,形成竖井。
- **改动**: ①`mine_motion_audit`/`installMotionAudit` 增 `bot._mineMotionActiveDig`: stony dig 期间 `bot.equip(non-pick, hand)` 与 `bot.placeBlock` 先 defer,9s 未释放才 blocked,防止挖石中途被垫块材料抢手。②`achieve` 的"expose more ore"从固定 `digDown(8)` 改为 `exposeMore`: y≤16 走 `branchMine` 横向探矿,y17-32 只下探2格,高处最多6格。③`skills.digDown` 增底层保险: y≤16 拒绝多格盲下挖,y≤32 clamp 到2格;保留 `mineDiamonds` 这类单格受控下降。④`unstuck` 增 step-edge nudge: 有前进/寻路意图、700ms位移<0.12、前方是可上台阶/边缘且非正在挖时,短退+清jump+轻跳前进,并写 `[step-edge]` 证据。
- **预测(可证伪)**: 新进程后不再出现 stony `dig.end` held=非pick 的真实裸挖告警;若垫块抢手复发,先见 `equip.deferred/place.deferred`。低层补矿日志从 `dig down to expose` 变为 `probe to expose`/`lateral branchMine`;y 不再单调快速下降。台阶边缘卡顿时 progress 出现 `[step-edge] nudge`,随后位置应脱离原格。
- **观测**: 🟢 13:14:59 agent-only 重启上线(48909 live,MC LAN 55916 未动),watchdog 13:16:21 重新挂起。13:15:06 在 y14 触发 `mine probe: y=14, skip blind digDown; lateral branchMine instead`;随后 bot 从 y14 上浮到 y61 并进入 `prepNether: HUNGRY food=0 → surfacing to hunt(feedUp)`。13:17 对账 `ALERTS.txt` 最后一条仍是重启前 05:12:32,新审计 `audit.installed` 后暂无新增 bare-hand stone。**残留风险**: hp4/food0 食物死结仍未解决,这是生存策略问题而非本轮矿洞运动问题;继续观察 feedUp 能否脱困。
- **回滚**: 删 activeDig/equip/place defer;`achieve` 恢复 `digDown(8)`;`digDown` 去掉 y-depth clamp;`unstuck` 删除 step-edge nudge 状态与触发块。

## C44. feedUp 绝境迁移（③层,待验证）
- **触发**: C43 后 bot 成功从 y14 横向探矿/上浮到 y63,但 hp4/food0 时 `feedUp` 每10秒立即返回 `food=0 hp=4`;`chopWood` 又因 hp4 bail,mission 只写 `FAMINE backoff` 空转。act_trace 05:19:01-05:19:49 全程 no keys/path/dig,说明"找食物"实际是原地等死。
- **改动**: `feedUp` 加 `desperationRoam`: 白天、food≤2、hp≤6、8格内无可达威胁时,先扫描96格内 huntable;若有动物就 path 到3格距离,否则朝 `spawn_pos.json` 方向(无文件则确定性扇形方向)迁移24格再重试。目标是把"当前格没有食物"升级成"换一片地形找食物",不再原地空转。
- **预测(可证伪)**: 下次 hp≤6/food≤2/无食物且白天安全时,agent log 应出现 `feedUp: famine roam`;act_trace 出现 path/forward,位置离开原地。若迁移导致摔落/进水/引怪,回滚或改成更保守的地表采样目标。
- **观测**: 🟡 未充分触发验证。05:21:25 在旧空转局中 self_preservation fall 死285,随后死亡重置把 bot 带回 spawn 高地并恢复 hp20/food20;05:22 direct-chop 得到4 logs,05:24 夜间 bunker 稳定。该死亡实际兑现了 C42 教训里的"低资产死亡重置",但 feedUp roam 本身仍需下个饥饿局验证。
- **回滚**: 删除 `feedUp.js` 的 `fs/path/SPAWNF` 引入与 `desperationRoam` 分支。

## C45. raw-stair 净空预检 + 高树拉黑延迟 + 水中 place 门（①/③层）
- **触发**: 05:29-05:32 `mine_motion.jsonl` 抓到上坡卡边缘的完整现场: bot 固定在 `56,67,0`, `raw-stair dir=0,1` 每轮 `targetDist≈0.8,maxRise≈0.2`,前方脚格/头格/上方全是 stone,自己头顶也是 stone。旧 `_ascendStep` 把"没清净空的墙"当"台阶边缘"硬跳,并且 `raw-stair` 在 relax=true 时即使 `guardedDig` 因无镐失败也继续攀爬。随后路线层又暴露第二个 bug: 高处树 `collectBlock` 一失败先被拉黑,再启动 `pinned → dig-staircase` 去爬向它,导致爬上坡后目标已被自己封禁。05:37 死286=Drowned,死前 `achieve` 在水中连续 `dig/place`,place 目标是 water 且反复 timeout,与 self_preservation 游泳抢身体。
- **改动**: ①`_ascendStep` 增几何预检: 若目标格是实体台阶,必须保证目标脚/头格和自身跳跃头顶有净空;`raw-stair/surf-stair-place/surf-stuck-stair` 还要求确有实体台阶。失败写 `ascend.blocked`/`raw-stair.blocked` 并快速 yield,不再原地撞边。②`raw-stair` 清净空后复查 block 是否真的消失;无镐 stone 清不掉就不攀爬。③高差≥6 且连败≤6 的高树失败先 `defer blacklist ... climb first`,保留目标给凿坡/爬坡路线,避免"爬上去后树已拉黑"。④`mine_motion_audit` v2: bot 身体仍在 water/flowing_water 时,通用 `bot.placeBlock` 直接 `place.blocked reason=in-water`,优先让游泳/上岸逻辑独占身体;热安装脚本升级为版本化安装。⑤agent-only 重启加载 v2,MC LAN 未动。
- **预测(可证伪)**: 同格同方向 `raw-stair failed dir=...` 不再以 5-7 秒节奏重复;矿洞/坡地遇到未清净空时只出现 `raw-stair.blocked` + yield 或换路线。高处树应先看到 `defer blacklist ... high tree` 并持续接近同一目标。下次水中遭遇 drowned/游泳时,不再出现 `place.begin` 后 500ms timeout 的水格垫块;若有通用 place 企图,应先落 `place.blocked reason=in-water`。
- **观测**: 🟡 05:34 cancel 后 bot 离开 `56,67,0`;05:35 起 raw-stair 从长时间重复跳撞变为 `raw-stair no viable climb ... yield`,并曾沿坡/水域移动到 y83。05:37 死286=Drowned 证明水域身体抢占仍是漏洞;05:42:53 agent-only 重启后 `audit.installed` 新时间戳出现,v2 已加载。水中 place 门尚待下一次水域现场验证。
- **回滚**: `_ascendStep` 删除 blocked 预检和 raw-stair clear 复查;恢复高树立即 blacklist;`mine_motion_audit`/`installMotionAudit` 删除 v2 water-place gate 和版本字段。

## C46. branchMine 近场追矿 + smelt 燃料前置去煤执念（③层）
- **触发**: 05:50-05:56 现场 `mine_motion.jsonl` 显示 bot 在 y15 直线开 branchMine 时,侧墙/头顶已多次出现 `iron_ore`（如 `pos=25,15,41`, env 左侧三格 iron_ore）,但库存长期 `raw_iron=0`;拿到 `raw_iron=3` 后又因 `iron_ingot` smelt 分支先强制 `achieve('coal')`,在已有 `oak_log/oak_planks/furnace` 的情况下继续 y15/y7 找煤空挖。
- **机理**: `branchMine.mineNearby` 完全委托 `collectBlock(ore)` + pathfinder,对近场侧墙矿没有人类式"凿窗口/直接追矿"动作;`achieve` 把"煤"误当成 smelt 必需品,但底层 `smeltItem` 已支持 coal/charcoal/log/planks 作燃料。
- **改动**: ①`branchMine` 增本地近场追矿: 5格内扫描全部 ORES,按距离排序,先直接挖 reach≤4.6 的矿;够不到时凿 1x2 `ore-window` 站位再挖,每次记录 `branchMine ore-chase/ore-window`。②`achieve` smelt 分支先问 `mc.getSmeltingFuel(bot)`: 已有任意燃料则写 `fuel ready ... skip coal preflight`;无燃料才找煤,再退到 `oak_log`。
- **预测(可证伪)**: 近场矿不会再被直线隧道长期擦肩而过;若看到矿但挖不到,日志会给出 `ore-chase ... => wrong-tool/timeout/lava-near`。有木头/木板时,`iron_ingot` 不再触发长时间 `NEED coal -> branchMine`;会直接 smelt。
- **观测**: ✅ 05:56 act_trace 出现 `dig=iron_ore`,vitals 从 `raw_iron=0` 到 `raw_iron=3`;agent.log 出现 `branchMine ore-window: dug stone@20,7,45`。05:59 新 achieve 生效: `fuel ready: oak_planks x15 — skip coal preflight` → `smelt raw_iron->iron_ingot` → `craft shield` → `prepNether: shield -> 1/1`。该链路验证了追矿和燃料前置两处修复。
- **回滚**: `branchMine` 恢复旧 `world.getNearestBlock + skills.collectBlock` 循环;`achieve` smelt 分支恢复无条件 `achieve('coal')`。

## C47. 饥荒身体熔断 + surfaceUp 连续出洞预算（①/③层）
- **触发**: 06:05-06:12 live 现场 food=0 后仍继续 `achieve -> coal/oak_log -> chopWood/digToSurface`, raw-stair 在 y10/y1/-5 反复撞台阶,HP 20→7;cancel 后仍有 `self_preservation/mobility` 抢身体,act_trace 显示 food=0 下持续 path/jump/dig stone/amethyst。机理=饥饿保护只在 prepNether 外层,挡不住递归 `achieve` 与 tick modes;同时 `surfaceUp` 没镐时每次只允许2次 no-pick ceiling breach,导致每轮只爬2格又退出。
- **改动**: ①`achieve` 增 `FAMINE-FUSE`: food≤2 且无可吃物时拒绝非食物资源子目标,清 controls/pathfinder,避免继续采矿/砍树。②`prepNether.keepFed` 改为返回布尔门: 夜间无食物真正 HOLD 到天亮;白天 feedUp 失败且仍 food≤2 时直接停止所有 prep/kit/achieve 工作。③`modes.js` 新增 `famineBodyFreeze`: food=0/危急且无食物、无怪/水/岩浆/坠落/受伤窗口时,`self_preservation`/`mobility` 停止 pathfinder 和 controls,只给真正逃命与 `feedUp/surfaceUp` 放行。④`surfaceUp` 在 famine emergency 下把 no-pick ceiling breach 预算从2放宽到200,并把成功条件从 y-only 改为"达到目标高度且头顶8格开阔",避免 y62 封闭山体 pocket 被误判为地表。⑤`prepNether` 的饥饿出洞用 `openSurfaceNow()` 判定,高 y 但封闭时继续 `surfaceUp(target=y+8)`;`feedUp.desperationRoam` 去掉 hp≤6 硬门,food=0 白天安全即可远程找动物/迁移。
- **预测(可证伪)**: food=0/无食物时不再出现 `achieve -> coal/oak_log/chopWood/branchMine` 资源链;无直接危险时 act_trace 应为 `ctrl:- path:0 dig:-`。白天封闭 pocket 应写 `enclosed/high-pocket food run -> surfaceUp target=...`,连续上升到 FREE;若近处无食物,feedUp 应出现 path/forward 远程搜索而非0.2s空返回。
- **观测**: ✅ 06:14 agent-only 重启后 `prepNether: FAMINE gate` 生效,`self_preservation FAMINE body freeze` 反复出现;06:18-06:45 夜间 hold 后 act_trace 连续静止(`ctrl:- path:0 dig:-`),证明 modes 层抢身体已被压住。06:46 天亮后命中 `prepNether: enclosed/high-pocket food run — surfaceUp target=70`,`surfaceUp.log` 记录 y62→y85,中途 `dig=stone/dirt/grass_block` 与 jump/pillar 序列清晰,最终 `mob=FREE`。随后暴露 feedUp hp≤6 阈值反例(hp7/food0 在地表空返回);去掉该门并重启后,act_trace 从 `(25,85,-3)` 跑到 `(-40,101,43)`,库存出现 `beef:3`,auto_eat 后 food 0→9。该链路完整验证"封闭矿洞/山体 pocket → 连续破顶 → 地表远程觅食 → 拾肉进食"。
- **回滚**: 删除 `achieve` FAMINE-FUSE;`prepNether.keepFed` 恢复无返回值/夜间只提示;`modes.js` 删除 `famineBodyFreeze` 两处调用;`surfaceUp` 恢复 plannedStoneBreaches 固定2次。

## C48. 工作台自举环 + 树冠高地误拉（③层）
- **触发**: C47 验证成功后,bot food/hp 恢复并进入 `prepNether` 补 kit。现场出现两条新运动病灶: ①`chopWood` 在 y115 高地/树冠附近因 `_skyAboveHere=false` 执行 `LEASH: 83格离锚 — 硬回拉至锚点`,把已在地表的 bot 往旧矿洞/崖壁路线拖回去;②`achieve('crafting_table')` 顶层 best-effort 先造 `wooden_sword`,而 `wooden_sword -> placeTable -> achieve('crafting_table')` 命中 active-loop,日志出现 `GIVEUP crafting_table (loop/too deep)`,浪费整段黄昏窗口。
- **改动**: ①`achieve` 的武器预步骤在目标就是 `crafting_table` 时跳过,让 2x2 工作台先完成,之后需要 3x3 的剑/盾/镐再复用正常 `placeTable`。②`chopWood._highOpenSurface` 从"y≥70 且头顶36格全无实心"扩成"y≥70、非 enclosed、且 sky clear 或 mobility=FREE+hp/food健康";树叶/山坡遮天时也不触发硬回拉,改写日志为 `high/free surface`。
- **预测(可证伪)**: 新进程后若顶层目标为 `crafting_table`,不应再先出现 `NEED wooden_sword -> place table -> GIVEUP crafting_table`;应直接采/合 planks 并 craft table。高地 FREE 状态下进入 chopWood 且距锚>80时,即使树冠导致 sky=false,也应 `LEASH SKIP: high/free surface`,不再 raw-walk 回旧锚点。
- **观测**: 🟡 07:01 agent-only 重启加载补丁后 `fresh_status=live`;库存已稳定持有 `crafting_table:1`,夜间 `prepNether` 进入 bunker hold(`covered=true hp=20 food=20`)。07:06 天亮后旧版仍在跑: 高树 `oak_log@-70,84,8` 下出现 `not-surface ... sky=false → digToSurface DONE`,随后斜向 `pinned-stair dir=1,-1` 升高但偏离目标格,又触发 `LEASH` 硬拉并跌入 y1 死于 Skeleton。rev1: chopWood 禁 item_collecting/unstuck 插队;近高树时跳过 vertical surfaceUp;上坡改轴向台阶并要求靠近目标格(`targetDist<=1.1`)才算 ascend 成功。07:12 重新 bootstrap 后没有再复现旧高地 LEASH 死链,并拿到 `oak_log:2`。
- **回滚**: 恢复 `achieve` 顶层无条件 best-effort `wooden_sword`;`chopWood._highOpenSurface` 恢复 strict sky-only 判定和旧日志。

## C49. KILL-BOX 热循环节流 + 失败降级（③层）
- **触发**: 死后重生点处在 death cluster 半径内,`missionNether` 每轮都执行 `KILL-BOX → goToPosition → continue`;当路径器瞬返时 progress 在同一秒刷出数千条 `★KILL-BOX`,iter cap 直接耗尽,任务流完全不进入 prep/chop/craft。
- **改动**: `missionNether` KILL-BOX 分支加 15s 节流和 8s timebox;若 `goToPosition` 没移动,追加 2.2s raw-walk fallback;连续3次在安全地表撤离失败时 suppress 120s,让任务流先重建木头/工具/盾,避免保护逻辑把任务层饿死。
- **预测(可证伪)**: KILL-BOX progress 不再毫秒刷屏;撤离失败时 45s 内应看到 `expel failed x3 ... suppressing`,随后进入 `not kitted → prepNether`。若 suppress 期间死亡,说明 KILL-BOX 降级过宽,需要按 hp/hostile/water 收紧。
- **观测**: ✅ 07:11 重启后 KILL-BOX 从毫秒刷屏降到每15秒一次;07:15:39 出现 `expel failed x3 on safe surface — suppressing for 120s`,随后立即进入 `prepNether`,把 `oak_log:2` 转成 `oak_planks:5, stick:8`。残留: `prepNether` 内还有独立 `KILL-BOX(prep)` 一次性撤离逻辑,水边 SWIM/self_preservation 仍会磨一段,但任务流已不再被 mission 层压死。
- **回滚**: 删除 `_lastKillBoxExpelAt/_killBoxFailedExpels/_killBoxSuppressUntil` 相关逻辑,恢复无节流 `goToPosition` 后 `continue`。

## C50. 雷区采矿让出身体 + 夜间地堡优先 + branchMine 确定性隧道步（③层,部分验证）
- **触发**: C49 suppress 后任务流进入 `prepNether`,但 `achieve` 在 death-zone 里采 `iron_ore/coal_ore/stone` 时出现 0.08s 级热循环: `DEATH-ZONE → mining LEASH → collect ... → 雷区禁挖 → continue`,既不真正撤离,也不给夜间 hole-up/监督层接管。随后夜间地堡期间 `missionNether` 仍每15s触发 KILL-BOX 外逃,与 `self_preservation night bunker dwell` 抢身体。矿洞行进方面,`branchMine` 水平段仍把前进交给 `goToPosition(2格外)`,没有保证先清脚/头格、缺地板先垫。07:31 又抓到 `chopWood` 为够 y67 树,从 y63 一路 path/dig 下到 y50,即"树在头顶却用 collectBlock 寻路"的反人类路线。
- **改动**: ①`achieve` 的 death-zone `digDown` 分支从 `continue` 改为记录 `bot._achieveDZAbort`、停止 pathfinder/controls、短退避后 `return false`,让本次资源路径失败并把身体还给生存/重规划。②`prepNether` 的 KILL-BOX 镜像尊重 `bot._killBoxSuppressUntil`。③`missionNether` KILL-BOX 在 `night+overhead cover` 时只写 `inside cluster but night+covered — hold bunker until dawn` 并等待;白天若 y<64 且仍有头顶覆盖,先 `surfaceUp(target=max(64,y+8))`,不水平撞洞壁。④`branchMine` 水平隧道改成 1-cell `tunnel-step`: 先检查目标脚/头/地板,水/岩浆则停;脚下无地板先用 dirt/cobble 等 filler 垫;再挖脚/头两格;最后短程走入目标 cell 并记录 `step ok/stalled`。⑤`chopWood` 在 `notSurface + nearHighTree` 时禁止第一次就 `collectBlock`;先 `surfaceUp` 到树高度附近/出洞,避免 pathfinder 为树向下凿路。
- **预测(可证伪)**: death-zone 里不会再出现同一秒十几条 `雷区禁挖`;应看到一次 `跳过digDown并让出身体 (repeat=N)` 后上层转入夜间 hold/新路线。夜间有覆盖时 KILL-BOX 不再输出 expelling。下一次 branchMine 水平开道应出现 `branchMine tunnel-step ...`,且挖块/垫块顺序为 floor→foot/head→step,不再直接 pathfinder 猜 2 格外路线。
- **观测**: 🟡 07:22 重启后 `prepNether` 未再触发自己的 `KILL-BOX(prep)` 抢占;07:25 顶层 mission 记录 `★KILL-BOX: inside cluster but night+covered — hold bunker until dawn`,证明夜间地堡优先已生效。07:30 y59 pocket 命中 `surfaceUp target=67`,连续开到 y65,随后短暂 FREE。07:37 near-high-tree preflight 验证: y68→y73,树距离 5.5b→1.6b,`direct-chop` dug 6 logs,随后 vitals 有 `oak_planks=24`。07:48/07:52/07:53 多次 `mining LEASH failed ... yield mining body`,证明采矿缰绳失败不再进入秒级 probe 热循环。`branchMine tunnel-step` 仍待下一次真实 branchMine 窗口验证。
- **回滚**: `achieve` 恢复 `_inDZ continue`;删除 `prepNether` suppress 检查;删除 `missionNether` 的 `isNightNow/hasOverheadCover` 和 night/pocket surfaceUp 分支;`branchMine` 水平段恢复旧 `goToPosition(tx,tz)`;`chopWood` 删除 near-high-tree collectBlock 前置 surfaceUp。

## C51. goToPosition null 坐标修复 + 水中工作区断路 + 低食物采矿硬门（①/③层,现场验证）
- **触发**: `achieve` 采矿日志反复输出 `mining LEASH: 97-99格离锚 — 收40格再采`,但实际没有有效撤离;根因之一是 `goToPosition` 注释承诺 `null` 坐标使用当前位置,实现却直接拒绝 null,导致所有 `goToPosition(x,null,z)` 水平缰绳/撤离是空操作。另一个现场是 mine_motion 抓到 bot 在水里继续 `place table`/垫块: BodyGate 拦截了 `place.blocked reason=in-water`,但策略层仍反复发起水下工作区动作。最后,food=4-6 且无食物时 `feedUp` 无收益,prep 仍继续 shield→iron→mine,把低食物窗口重新拖回采矿链。
- **改动**: ①`skills.goToPosition` 按注释实现 null 坐标替换为当前位置,恢复水平 leash/撤离能力。②`achieve` 增 `wetWorksite/escapeWetWorksite`: 脚/头在 water 时,放工作台/采矿前先 `surfaceUp`,失败则本轮资源路径返回 false。③`surfaceUp` 增水柱 `swimOutOfWater` 前置段,避免在水里把水当作不可挖天花板后退出。④`achieve` 的 mining LEASH 改为硬门: 8s 内没有明显靠近锚点则 stop pathfinder/clear controls 并 `return false`;同时夜间暴露采矿直接停止。⑤`prepNether.keepFed` 把无食物继续作业门槛从 food>6 抬到 food>=12;`feedUp.desperationRoam` 同步 food<12 远程迁移;feedUp 后 food 未改善且仍<12 时停止 prep。
- **预测(可证伪)**: 水中不再出现连续 place table/垫块尝试;应先见 `★WET-WORKSITE ... surface/escape` 或直接停止资源路径。离锚>80且撤离失败时应出现 `mining LEASH failed A→B ok=false; yield mining body`,且后续进入生存/觅食/重规划,不再每秒多次 `collect/probe`。food<12 且无食物时不再启动 shield/iron/diamond 采矿链;feedUp 应迁移或停止 prep。
- **观测**: ✅ 07:42 `surfaceUp` 从 y47 连续开到 y70,水中 place 循环停止。07:48 `mining LEASH failed 98→73 ok=false; yield mining body`;07:52/07:53 再次出现 82→66、81→63、80→60 的 yield,没有复发 0.03s probe 热循环。07:54/07:55 food=4-5 时出现 `HUNGER gate ... stop prep work`;随后 feedUp/auto_eat 迁移至 x≈104,z≈-54,food 从 3 拉到 13。残留: food=13/hp=9 仍低于满回血目标,但已越过新的硬停线;后续需要继续看是否在下一次采矿前补到更安全水平。
- **回滚**: `goToPosition` 恢复 null 直接失败;删除 `achieve` wetWorksite/night-exposed/leash hard gate;删除 `surfaceUp` water escape;`prepNether`/`feedUp` 阈值恢复 food≤6/≤2。

## C52. chopWood 低食物让位 + 台阶 blocker 清理 + 夜间水边/挖掘非重入（①/③层,部分验证）
- **触发**: 08:54-08:57 `chopWood` 为盾牌前置木板在水边/坡地长期占身体,food 7→0;同段 `raw-stair blocked target-foot-blocked`/`surf-stair-place no-step` 反复出现,说明可施工台阶被当成失败;08:58 food=0/hp=10 夜里又因水边 bunker veto 移动 12 格,08:59 被 Drowned 杀死。09:17 新 live 轨迹又抓到 `MAROONED` 行军在同一台阶边缘连续 `dig.begin`/`Digging aborted`,随后从 y76 摔到 y58,hp20→13;09:20-09:21 `prepNether` 已被 self_preservation 封顶后仍每秒水边 relocation veto。
- **改动**: ①`chopWood` 主循环、`digToSurface`、pinned-stair climb 加 `food<=8 && no edible` 让位并写 `chopWood.low_food_yield`。②`achieve` 加低食物资源总门,非食物/非最小求生武器目标直接返回给 `prepNether.keepFed`。③`prepNether` 木头 buffer 在 food<=14 且无零食时跳过;夜间饥饿/残血时软化水边 bunker veto;若头顶已 covered,最前置跳过水边 relocation,只 hold。④`_ascendStep` 对 target-foot/head/own-overhead blocker 先 `guardedDig` 清理并记录 `ascend.clear_blocker.*`,再尝试上步。⑤`near-high-tree -> surfaceUp` 加 45s timebox,超时 stop/clear 并临时拉黑该树。⑥`mobility` MAROONED 碰到 no-pick stone gate 且 16格内有原木时,重置锚/降级 FREE,把身体交给 chopWood。⑦`chopWood` 与 `mobility` 本地 `guardedDig` 共用短 `bot._bodyDigLock*`,挖前清 controls/lookAt,5s timebox,失败写 `dig.retry/dig slot busy`,避免同一秒多路 dig 互相 abort。
- **预测(可证伪)**: 下一次 food<=8 且无食物时,chopWood/achieve 应在一个技能边界内归还身体,随后 prepNether 进入 feedUp/夜间 hold;上坡卡边缘时,mine_motion 会出现 `ascend.clear_blocker.*` 或 `surfaceUp.step_edge.*`,而不是只记录 blocked 后放弃。`near-high-tree` 不得再无动作等待超过45s;MAROONED no-pick stone 不得长期压住木头自举;同一秒不应再有多条不同目标 `dig.begin` 互相 `Digging aborted`。夜间 covered 后不应再出现秒级 `bunker site too close to water` 搬迁循环。
- **观测**: ⚠️ 旧 chopWood 实例在补丁前已烧到 food=0 并导致 08:59 Drowned 死亡,不能算救回。补丁后重生夜间连续 `night bunker dwell: covered=true hp=20 food=20`,act_trace 为 `ctrl:"-" path:0`,封存稳定。`FAMINE-FUSE shield` 已验证低食物资源门会拒绝 shield。✅ 09:13 `near-high-tree surfaceUp` 无动作,09:14:00 准时 timeout、拉黑 `oak_log@15,81,-3`,随后 `digToSurface DONE` 并恢复 staircase 动作。✅ 09:14:37 `pinned-stair-climb cleared blocker ... target-foot-blocked` 验证 blocker 清理能成功一次。⚠️ 09:17 同台阶又出现多路 dig abort 并摔落,据此追加 dig 非重入锁。✅ 09:21:28 起 bot 在 y58 水边/石洞内 `night bunker dwell: covered=true hp=13 food=17 hostiles=0`,mission 只写 `inside cluster but night+covered — hold bunker until dawn`;act_trace 静止无 path/dig。`branchMine.step.*` 仍待下一次真实 branchMine 验证。
- **回滚**: 删 chopWood 的 `_needsFoodYield`、`_ascendStep clearAscendBlocker`、near-high-tree `Promise.race` 与 `_bodyDigLock` guardedDig;删 achieve 低食物资源总门/wood-planks gates;恢复 prepNether 水边 bunker relocation 与 wood buffer 旧阈值;删 modes.js 的 MAROONED no-pick nearby-log handoff 与 mobility guardedDig 非重入锁。

## C53. surfaceUp 假进展归零 + KILL-BOX 低顶只垂直 + 矿洞挖掘独占收口（①/③层,现场验证中）
- **触发**: 09:26 黎明后 mission 在 death cluster 内从 y58 调 `surfaceUp target=66`;旧 surfaceUp 先空等 4 个 30s pathfinder leg,随后 fallback 连续 80+ 次写 `opened=3 y 59->59 manualRose=true`,实际 y 不涨。机理有二: ①`guardedDig` 失败后仍把天花板当 opened;②`manualPillar()` 用内部当前 y 当 floor,即使没超过外层 y0 也返回 true。09:34 补后 surfaceUp 能 y58→y64,但 KILL-BOX 立刻把 y64 当安全地表水平 expel,bot 又掉回 y58/y53,hp13→9。09:38 起夜间 bunker 中 events 每5s刷 `Reflex wedged while taking damage`,但 act_trace 显示合法 covered night hold,是 reflex_watchdog 只向上探3格导致夜蹲误报。
- **改动**: ①`surfaceUp` fallback 清天花板后立刻重读 block;仍 solid 则 `verticalBlocked` 且不计 opened。②`manualPillar(mustBeatY)` 必须超过外层 y0 才算 rose;连续无进展写 `progressed=false stuckFloor=N`,尝试 `stepEdgeAssist/scaffoldStep`,3次后退出而非假循环。③pathfinder leg 若 `path=0` 且 2.5-8s 没位移,快速 break 到 fallback,不再固定等满30s。④`missionNether` 在 death cluster 内若 `y<70` 或头顶有盖,只 `surfaceUp target=max(70,y+12)`,禁止水平 expel;等下一轮确认高且开阔再横向撤离。⑤`surfaceUp` 与 `branchMine.digBlock` 都接入 `bot._bodyDigLock*`: 挖前拿短租约、清 controls、lookAt、bounded dig,失败写 `dig.slot.busy/dig.retry`;全局 step-edge assist 尊重该锁。⑥`reflex_watchdog` 夜间 bunker 豁免从上探3格改为6格,对齐 mission/self_preservation 的 covered 语义,避免正当蹲坑被反射强拆。
- **预测(可证伪)**: 下次 surfaceUp 不再出现 `y A->A manualRose=true progressed=true`;若 pathfinder 无路径原地站,应在数秒内进入 fallback。death cluster 内 y<70/low-roof 时不得输出 `expelling to ...`;只允许 surfaceUp 直至高开阔。矿洞挖掘中若另一路抢身体,应先见 `dig.slot.busy` 或 `dig.retry`,不再同秒多目标 `Digging aborted`。夜间 covered hold 不应继续刷 `Reflex wedged while taking damage`。
- **观测**: 🟢 09:32-09:34 rev1 已验证 surfaceUp 假进展修复: `fallback iter 0..5 y 58->64 progressed=true` 后退出,没有复发 `59->59 manualRose=true`。⚠️ 随后 y64 横向 expel 导致跌回低洞并掉血,据此追加 y<70/low-roof gate;09:36 已看到 `pocket/low-roof in cluster (y=53) -> surfaceUp target=70 before horizontal expel`。🟢 09:46 surfaceUp 新快退生效: pathfinder 原地仅数秒即触发 `surfaceUp.step_edge`,两次从 y53→55;fallback 后 `opened=2 y55->55 manualRose=false progressed=false stuckFloor=1`,证明假进展已归零。⚠️ 09:47 死291=Skeleton;根因不是 surfaceUp 本身,而是 modes 尚未重启仍刷 `Pinned 15min+`/`Reflex wedged` 误 cancel,随后裸装被近身 skeleton 击杀。09:49 按 v3 安全重启 agent/watchdog(不碰 MC Java)后,45s 内不再出现 `Reflex wedged/Pinned` 误报,bot 重生白天自举并拿到木头/镐/石头。10:00 新进程进入 y60 covered night hold,连续 `night bunker dwell: covered=true hp=18 food=9 hostiles=0`,无误拆。
- **追加(09:58-10:03)**: live mine_motion 抓到放块时机根因: 旧 `placeBlockNearby` 在窄井里跳起约280ms、`y≈61.495` 时向自己脚格 `placeAt=65,61,3` 连续放 dirt,服务端 `blockUpdate` 超时;这是"垫砖块时机糟糕"的直接证据。修 `src/agent/library/skills.js`: 新增 `placeBlockUnderFeet()` 等脚底真正离开目标格再 `placeBlockConfirmed`,通用 `placeBlock` 拒绝把实心块放进 bot AABB;`surfaceUp`/self_preservation/水中脱困均改用该原语。重启后 torch placement 三次 63ms 级成功,未再出现同类脚下 dirt timeout。
- **追加(10:03)**: `branchMine.step` 在 andesite 前写 `clear-wrong-tool`,但库存有 wooden_pickaxe;根因是 `bot.tool.equipForBlock` + `canHarvest(held)` 读瞬时 held,会被未确认换手/旧 held 误判。修为显式 pick tier: 隧道清石任意 pick≥wooden,iron/copper/lapis≥stone,diamond/redstone/emerald/gold≥iron,obsidian≥diamond;下次 customSkill 热加载验证。
- **回滚**: `surfaceUp` 恢复旧 opened/manualPillar/30s leg 判定;`missionNether` 删除 y<70/hasOverheadCover 垂直门;`surfaceUp`/`branchMine` 删除 `_bodyDigLock` guarded dig;`reflex_watchdog` 夜间豁免恢复 dy<=3。

## C54. 本地工作台急救镐 + step-edge 真触发 + feedUp 安全迁移（①/③层,现场验证）
- **触发**: 10:14-10:23 live telemetry 显示 bot 在 y62 封闭洞袋反复 `emergency pick craft stone_pickaxe` 后 12s timeout,随后 `surfaceUp` 仍用 cobblestone/wooden_sword 去挖 stone,卡在 `MAROONED no-pick stone gate`。10:31-10:34 出洞后 `feedUp` 为找食物横穿破碎山坡/洞顶,无怪时连续 HURT, hp18→4,最后 10:37 夜间被 zombie 贴脸杀死。
- **机理**: ①通用 `craftRecipe` 会优先复用/走向附近注册工作台,在洞袋中可能选中不可达/远处 table 或卡 GUI,没有"就地放一张可触达工作台再合成"原语。②`unstuck` 的 step-edge assist 中 `skill` 在声明前被引用,当不由 `cs.forward/pathingNow` 短路时会 ReferenceError 并被吞掉,导致上坡救援暗中失效。③`feedUp.desperationRoam` 使用普通 `goToPosition`,允许 parkour/较大落差,低血低食物时仍沿破碎地表奔跑。
- **改动**: ①`src/agent/library/skills.js` 新增 `craftRecipeLocal()` 与 `placeCraftingTableWithinReach()`: 3x3 配方优先把背包里的 `crafting_table` 放在 bot AABB 外、臂长内、可依附的相邻格,再本地 craft。`surfaceUp.ensureEmergencyPick` 与 `mobility.ensureEmergencyPick` 改用 `craftRecipeLocal || craftRecipe`。②`modes.unstuck` 先声明 `skill`,并让 `pathingNow/mobilityWorkNow/surfaceUp/feedUp/chopWood/branchMine` 都能唤醒 step-edge assist;`step_edge.*` 事件写入 3D env 快照。③`surfaceUp.step_edge.*` 同步写 env。④`feedUp` 增 `safeRoamTo()`: 仅觅食迁移/食物掉落拾取使用 `canDig=false, allowParkour=false, allow1by1towers=false, maxDropDown=hp<=10?1:2`,并记录安全迁移失败或仍掉血的路径。
- **预测(可证伪)**: 有 `cobblestone>=3 && stick>=2 && crafting_table` 时,下一次 no-pick stone gate 应在数秒内得到 stone_pickaxe,`mine_motion` 中 stone dig 的 `held` 应为 pickaxe。上坡卡边时 progress 应出现 `[step-edge] assist begin/end`,并在 `mine_motion` 有 env。低血觅食不应再为翻坡产生 2-4hp 的无怪摔落;若绕不过去,应记录 `feedUp: safe ... failed` 并短退。
- **观测**: ✅ 10:24 agent-only reload 后 `audit.installed` 更新。10:26:19 `surfaceUp` 再次遇到 stone ceiling,急救镐成功: 背包出现 `stone_pickaxe:1`,sticks 7→5,table 被消耗/放置;随后 `surfaceUp` 从 y62 连续爬到 y86,`mine_motion` seq56/58/60 均为 `held=stone_pickaxe` 挖 stone,最终 `mob=FREE/enclosed=false`。✅ 10:32-10:33 觅食横穿坡面时 step-edge 实际触发三次,如 y66.42→67.25、y71.00→72.25、y72.00→73.02。⚠️ 旧 `feedUp` 路线随后仍把 hp 打到4,10:37:50 死292=Zombie;据此追加 `safeRoamTo`。10:40 agent-only reload 后三端 live,新代码已加载;bot 死后夜间重生已 sealed bunker,`hp=20 food=20 inv=dirt:2`,corpseRun 正确推迟到 dawn。
- **回滚**: `surfaceUp/modes` 恢复 `skills.craftRecipe`;删除 `craftRecipeLocal/placeCraftingTableWithinReach`;`modes.unstuck` 恢复旧 step-edge 判定;`feedUp` 恢复直接 `skills.goToPosition` 的 roam/drop 获取。

## C55. 远距 creeper 抢身迟滞 + shelter pin 归零 + achieve 本地工作台（①/③层,现场验证中）
- **触发**: 10:46 黎明后合法夜间 bunker 刚结束,`reflex_watchdog` 立即用夜间驻留累计的旧 `pinAt` 触发 `Pinned 15min+ — kicking the stack`,把刚启动的 `chopWood` 踢断。随后白天 9-11 格外 creeper 每 300ms 抢一次 `self_preservation`,日志连续 `Creeper 9/10/11m — backing off!`,但 radar 显示 hostiles 多在 9m+ 且 hp=20,实际是在安全距离反复夺身体。10:50-10:51 普通 `achieve` 合成链又复现工作台病: 在 POCKET/ENC 中 `recipesFor empty for stone_pickaxe — trying craftRecipe fallback`,底层走向/打开远处 table,最终 `windowOpen` 20s 超时。10:55 新进程进入 prepNether 后还抓到 `edibleNow is not defined` 每3秒重入空转。
- **改动**: ①`self_preservation` 增 `creeperBackoffTarget()`: 白天健康状态只在 ≤8.25m 进反射,低血/近群怪放宽到10m;夜间按 9.5/11m 保守接管。反射内部仍跑到 >9m 退出,形成进入/退出迟滞,避免 9-11m 远距 creeper 白天长期抢身。②`reflex_watchdog` 在 `nightBunker/lowFoodShelter` 正当驻留时刷新 `pinAnchor/pinAt/pinKick`,让天亮/恢复后的新工作得到完整 grace window。③`achieve.craftNow` 的 recipe fallback 改用 `craftRecipeLocal || craftRecipe`;`placeTable()` 在 POCKET/ENC 或登记 table 距离>12格时跳过状态池远桌复用,改为本地 craft/place。④`prepNether` 把 `edibleNow()` 提升到 keepFed/famineCritical/goal gate 的共享作用域,修掉每3秒抛错。⑤操作教训: agent-only reload 与 watchdog 可能同时拉起两个 `main.js`;其中一个会因 `8765 EADDRINUSE` 报错,必须以 `fresh_status` 和 `agent.log` 成功监听 `48909` 为准,不能只看单个 stderr。
- **预测(可证伪)**: 白天 9-11m creeper 不再连续刷 `backing off`;只有 ≤8.25m 或低血/近群怪才接管。合法夜间 bunker 到天亮后,第一分钟内不应立刻出现 `Pinned 15min+` 踢断新技能。封闭洞袋/口袋里的 `stone_pickaxe/shield/furnace` fallback 不再等待远桌 `windowOpen` 20s;若有 table 材料,应本地摆/用桌。`prepNether` 不应再出现 `edibleNow is not defined` 空转。
- **观测**: ✅ 10:54 重启竞争后一条进程报 `EADDRINUSE: ::1:8765`,另一条成功 `WebSocket server started on ws://0.0.0.0:48909`;`fresh_status=live` 且三端 open,MC LAN 未动。✅ 10:56:39 后 `edibleNow` 错误停止,prepNether 继续 `need shield` 和 `chop for planks`。✅ C54 的 step-edge 仍在: mine_motion 记录 `surfaceUp.step_edge.begin/end`,从 y91 抬到 y92.166,证明新 env 轨迹能定位上坡边缘。🟡 creeper 迟滞和 shelter pin 归零已加载,等待下一次白天远距 creeper/夜转昼 bunker 窗口验证。
- **回滚**: `modes.js` 删除 `creeperBackoffTarget()` 并恢复 `else if (nearestCreeper)`;删除 shelter 内 pin reset;`achieve` fallback 恢复 `skills.craftRecipe` 与 32格 registered table 强复用;`prepNether` 把 `edibleNow` 恢复为 keepFed 局部函数。

## C56. MAROONED 防坠落 + 木板缺口砍木 + feedUp 黑箱补仪表（①/③层,现场验证中）
- **触发**: 10:56-11:03 shield 前置缺 `oak_planks` 时,`achieve` 用 `Math.ceil(need/4)+1` 按总需求砍3根,而不是按缺口砍1根;旧 `chopWood` 为补这点木板从 y64 死亡区一路凿到 y92,food12→9,hp18→16。11:00 已拉黑 `birch_log@96,86,-43` 后,旧实例仍 `pinned → dig-staircase ... tgt=96,86,-43`,说明目标黑名单与路径锁不同步。11:03 `feedUp` 0.25s 秒退但没有 progress 级原因,监控只能看到 `hunt done food=9`。11:05 MAROONED 接管,`Marooned — engineering a road out` / `March target: log @110,99,-36`,随后 fall 伤害 hp16→15→5→0,死293=`fall` at `108,64,1`,action=`mode:mobility`;根因是 MAROONED bridge 失败后仍 forward 700ms,山顶过冲/盲走坠落。
- **改动**: ①`achieve` planks 分支按 `missingPlanks = need - have()` 计算 chopWood 数量,不再为少量木板扩大成3根树任务。②`chopWood` 在树被正式 blacklist 后立即清 `_stairDir`、`continue` 重新选目标,不允许 pinned staircase 继续追刚判 unreachable 的树;defer-high-tree 例外保留。③`feedUp` 增 progress 仪表: `START`、critical/night/hostile guard、无32格动物、famine roam guard/animal/relocate、safeRoam fail/hurt、no food source,以后秒退可归因。④`mobility` MAROONED march 改为确认式落脚: 前方 landing 只接受≤2格落差且非水/岩浆;若无安全地板则尝试桥接,桥接后重验;仍不安全则写 `MAROONED ledge veto ... rotate, no blind step` 并不前进。⑤MAROONED 单步 forward 从700ms降到260ms,避免一次冲过多个格子。
- **预测(可证伪)**: 下次缺少少量 planks 时,chopWood `ENTER count` 应按缺口缩小;正式 `blacklist ... unreachable` 后不应紧跟同 target 的 `pinned → dig-staircase`。feedUp 秒退必须有 `feedUp: guard/no huntable/famine roam/no food source` 之一。MAROONED 山顶/崖边不应再出现 blind forward 导致 fall death;危险边缘应写 `MAROONED ledge veto` 并旋转/让位。
- **观测**: ✅ 11:03 旧实例最终砍到4根 birch_log 并 craft `birch_planks x6`,证明上坡/清 blocker 能到树,但成本过高;该成本由①②削减。⚠️ 11:05 死293=fall/action mobility,据此追加 MAROONED ledge veto。✅ 11:10 agent-only reload 成功,三端 live,sticky `missionNether` 重新下发;当前夜间 covered hold `hp=20 food=20 inv=dirt:4`,MC LAN 未动。feedUp 仪表与 MAROONED veto 等待下一次同类窗口验证。
- **回滚**: `achieve` planks chop 数量恢复 `Math.ceil(need/4)+1`;`chopWood` 删除 `_blacklistedThisPass` fast-continue;`feedUp` 删除 `prog()` 仪表;`modes.js` MAROONED 恢复 3格 floorOK/bridge后无条件走和700ms forward。

## C57. 浅铁 probe 预算 + 台阶 edge-slip + 地下木材缓冲禁用（①/③层,现场验证中）
- **触发**: 11:13-11:14 shield/iron 前置缺 `raw_iron` 时,`achieve` 从 y82/y72 连续 `mine probe: iron_ore ... short descent` 到 y64,没有纵深预算;随后 `prepNether` 没铁镐还追 `diamond_sword/chestplate`,每个钻石目标都会在封闭洞穴里触发 `stock wood buffer -> chopWood -> digToSurface`,制造大量反人类楼梯。`mine_motion` 抓到上坡失败案例: `ascend.end` 从 y68 掉回 y67 后还继续沿旧方向清障/重试,这是典型台阶边缘滑落。
- **改动**: ①`achieve.exposeMore` 给浅层矿加进程内 probe state: 高于 y68 只允许 1-block bounded descent,最多5次或总下降6格;低于/达到预算后转 `branchMine` 横向探矿,横向也最多2轮,再 `yield body`;同时把 `achieve.probe.down/lateral/yield` 写入 `mine_motion.jsonl` 的 3D env 快照流。②`achieve` 顶层通用 wood buffer 在 `y<62` 或 `mobility=POCKET/ENC` 时跳过,不再为可选木材在地下硬凿楼梯。③`chopWood._ascendStep` 把所有 `*stair*` 标签都要求真实 step;若尝试后 `end.y` 低于起始格,写 `ascend.edge_slip` 并立即 abort/rotate 当前 heading,不继续擦同一台阶边缘;`pinned-stair-climb` 连续失败后重锁方向。④`prepNether` 在 shield 后显式先追 `iron_pickaxe`;没有 iron+ pick 且 diamonds 不足时,钻石装备链直接 `hold ... finish iron tier`,不再递归触发钻石目标。⑤`prepNether` 增 `cancelRequested()` 钩子,夜间 gate/goal loop 内也尊重 `cancel_skill`,避免旧 supervised skill 只在 mission 外层才释放。
- **预测(可证伪)**: 下次浅铁失败不会再 y82→64 单调竖井;日志应出现 `bounded one-block descent N/5`、`vertical budget done ... lateral branchMine` 或 `probe.yield`。封闭/地下资源目标不应再出现 `> stock wood buffer` 后立刻 `chopWood ENTER ... enclosed=true`;应写 `skip stock wood buffer — underground/enclosed`。上坡滑落应留下 `ascend.edge_slip`,随后换方向或让出,而不是同方向多轮清障。`prepNether` 新进程应先写 `need iron_pickaxe`,没铁镐时不再进入 `need diamond_chestplate` 的三连重试。
- **观测**: 🟢 11:20 热加载期间已抓到 `raw-stair edge-slip dir=0,1 y=67.00→66.00 repeat=1 — rotate/abort this heading`,证明台阶滑落能被识别和记录。⚠️ 11:21-11:22 旧 `prepNether/achieve` 实例仍继续追 diamond_chestplate 和地下 wood buffer;11:23 `cancel_skill` 到达但旧 mission 未释放,据此加 cancel 钩子并执行 agent-only reload。✅ 11:25 watchdog 拉起新 `node main.js`,48909/8765/MC LAN 55916 均 open,sticky `missionNether` 重发;11:26 `fresh_status=live`,新栈在 y81 sealed night bunker 合法等待。✅ 11:32 浅铁窗口验证: `bounded one-block descent 1/5..5/5` 后 `vertical budget done ... lateral branchMine`,没有 y82→64 盲降。⚠️ 同一窗口暴露 C58: `shield` 前置已有 `3 logs + 1 plank`(13 planks-eq)仍因日志数不足触发 `stock wood buffer -> chopWood`,导致 y88→y67 反人类上坡/挖路。
- **回滚**: 删除 `achieve._achieveProbeState` 与 `motion()` probe 轨迹;wood buffer 恢复地下也可触发;`chopWood` 恢复旧 `mustHaveSolidStep` regex 和无 edge-slip abort;`prepNether` 删除 `iron_pickaxe` 目标、diamond hold gate、cancelRequested 钩子。

## C58. 木材等价缓冲 + 低血近怪让位 + 垫块确认化（①/③层,现场验证中）
- **触发**: 11:31-11:36 `prepNether: need shield` 时 `achieve` 看到 logs<6/planks<8 触发 `stock wood buffer`,但背包已有 `oak_planks=1 + logs=3` 足够 craft shield 前置;旧 `chopWood` 为可选日志从 y88 下探/上爬到 y67-82,期间 hp13→11、hostiles=1 仍继续 `digToSurface`/黑名单树/挖台阶。`mine_motion` 还抓到旧垫块 race: place 目标在邻格/脚下,服务器未确认就继续上坡,失败后容易卡台阶边缘。
- **改动**: ①`achieve` wood buffer 改看 `woodEq = planks + logs*4`;`woodEq>=8` 时明确跳过,不再为了日志数字追树;低血近怪也跳过可选 wood buffer。②`achieve` ore probe 在 `hp<=14+近怪` 或 `hp<=12 food<=10 无食物` 时写 `achieve.probe.safety_yield` 并停 pathfinder/归还身体,避免残血继续追铜/煤。③`chopWood` 自身加入 `woodEq>=8` 自退和 `hp<=14+近怪` 主循环/`digToSurface` 让位,防未来误调。④`chopWood` 的 `surf-stair-place`/`leash-stair-place` 改走 `skills.placeBlock(... dontCheat=true)` 确认目标格成块;self-pillar fallback 优先用 `skills.placeBlockUnderFeet` 的 tickConfirm 版本。
- **预测(可证伪)**: 下次 shield/工具前置若木材等价足够,progress 应写 `skip stock wood buffer — woodEq=... enough`,不会出现 `chopWood ENTER count=5`。hp≤14 且 12格内有敌对时,`chopWood`/`digToSurface` 应写 `low_hp_hostile_yield` 而不是继续爬坡。台阶垫块失败应在 `mine_motion` 出现 `chopWood.place.end confirmed=false`,成功才会 `_ascendStep`;不应再有未确认放块后的边缘空蹭。
- **观测**: 🟡 代码热加载待重发 mission 后验证;`node --check achieve.js/chopWood.js` 已通过。
- **回滚**: 删除 `woodEq` 跳过/自退;删除 `lowHpWorkRisk` 与 `_lowHpHostileYield`;`chopWood` stair/pillar 恢复裸 `bot.placeBlock`。

## C59. feedUp 苹果兜底 + critical forage 例外（③层,部分有效继续收紧）
- **触发**: C58 重发后新栈释放成功,但 11:40-11:42 `feedUp` 在 `food=7→0 hp=11` 的白天资源窗口连续写 `no huntable animal within 32` 并在 `(10,83,2)` ↔ `(34,84,2)` 间搬迁,没有动物/瓜/浆果/掉落物,最后 `no food source found`;夜里只能 `FAMINE body freeze`。同时 C58 的 `woodEq>=8` 自退会误拦 `allowCriticalForage` 下的紧急砍树/苹果路线。
- **改动**: ①`chopWood` 的 `woodEq>=8` 自退不再拦 `opts.allowCriticalForage`,确保饥荒救命觅食仍能执行。②`feedUp` 无动物 PlanB/C 后新增 PlanD: `food<=2`、白天、10格内无威胁、36格内有 oak/dark_oak log/leaves 时,短时 `chopWood(1,{allowCriticalForage:true})`,等待树叶/掉落并 `pickupNearbyItems`/吃 apple。硬 timebox 45s,失败停 pathfinder/清控制。
- **预测(可证伪)**: 下个白天 food<=2 且无动物时,progress 应出现 `feedUp: PlanD apple forage`;若附近橡树可达,应至少采一棵树并扫掉落,不再只在两点间搬迁到 food=0。夜间不触发 PlanD,仍保持 bunker/famine freeze。
- **观测**: ⚠️ 11:51-11:54 PlanD 触发并实际把 `food=0→4`,证明苹果/树叶兜底能救到食物;但旧版随后仍按 targetFood=18 继续 roam,把 food4 又烧回0,hp10→8,并因高树叶 `safe apple-leaves` 把 bot 推进 y90+ 台阶/树冠坏路线。已继续由 C60 收紧: 应急食物地板、本地叶子-only、本地鱼-only。
- **回滚**: `chopWood` woodEq 自退恢复拦所有调用;删除 `feedUp` PlanD apple forage 块。

## C60. 饥荒本地化: 保住一颗苹果, hp6 不追远鱼（③层,现场验证中）
- **触发**: C59 现场显示 PlanD 成功吃到一颗苹果后,`feedUp` 因目标18继续 `famine roam relocate`,food4 被移动消耗到0。随后 `PlanD leaf sweep` 使用 `safeRoamTo` 追 y89-92 高处叶子,连续 `safe apple-leaves failed`,hp10→8;再后续 hp6 时发现 `local fish salmon dist=21`,旧逻辑仍追远鱼到入夜。
- **改动**: ①`feedUp` 增 emergency food floor: `food>=4 && hp<=10 && 无下一口食物` 时停止 roam,保存救命饥饿值,让编排层冷却而不是继续跑。②PlanD leaf sweep 只打当前 5格内、相对高度0..+3且距离≤4.5的 oak/dark_oak leaves,不再 path 到高树冠。③PlanD 调 `chopWood` 改 `{allowCriticalForage:true, criticalForageLocalOnly:true}`;`chopWood` 在该模式下不做死亡热区撤离,不选>4.8格或高差>3的树。④`feedUp.localFish` 对 hp<=6 只查8格内鱼,且 fish path timebox 7s;远鱼留到安全窗口。
- **预测(可证伪)**: 下次 food0/hp≤8 且无动物时,不会出现 `famine roam relocate` 消耗唯一苹果;若吃到 food4 应写 `emergency food floor` 或 `PlanD ... preserve it` 后停止。叶子兜底不应再写 `safe apple-leaves failed ... y90+`,只应有本地 `dig oak_leaves`。hp6 不应追 `salmon dist=21`;只接受近鱼或直接 stop/hold。
- **观测**: 🟡 `node --check feedUp.js` 已通过。12:02 后入夜,hp6/food0 在 wet-adjacent bunker hold,等待下一白天验证。
- **回滚**: 删除 emergency food floor/local-only leaf sweep/localFish range+timeout;`chopWood` 删除 `criticalForageLocalOnly` 分支。

## C61. local-only 觅食硬停 + step-edge run-up + 饥荒扫描/鱼救援收口（③层,现场验证中）
- **触发**: 12:00-12:02 旧 PlanD 在 `criticalForageLocalOnly` 下仍反复 `nearest=NONE` 后进入 `digToSurface/swim`,把 hp6/food0 带进水边/坡面移动;12:08-12:10 夜间 bunker 顶盖 cobble 开顶时连续 `stony-without-held-pick`,随后 surfaceUp 才偶发拿镐挖开。上坡日志也显示典型边缘摩擦: `surfaceUp.step_edge.end ok=false maxRise=0 targetDist≈0.8`,可爬目标格但第一次直冲不抬升。白天后 feedUp 的保守停机阻止乱跑,但 hp4/food0 进入食物死锁,需要知道是真无资源还是策略看不见。
- **改动**: ①`chopWood` 在 `criticalForageLocalOnly && !nearest` 时写 `chopWood.critical_local_no_tree` 并立刻 stop/clear/return,不再 surfacing/roam。②`feedUp` 对 hp≤8 的 PlanD 入口改为只认 5格内、dy0..3、dist≤4.8 的 oak/dark_oak log/leaves;没有本地资源就直接保守停机。③`surfaceUp.stepEdgeAssist` 从一次直冲改为 press→runup 两阶段: 若 `maxRise=0`,先 sneak-back 半格再低视角 forward+jump,并写 `surfaceUp.step_edge.runup`。④`feedUp` 低血停机前写 `food_scan animal64/fish32/drop32/melon/berry/oak`。⑤`safeRoamTo` 路上掉≥1hp或出现8格威胁立即 abort;`criticalRescueFish` 只在 hp≤6/白天/无威胁/鱼≤24格且垂直差≤5 时尝试,失败冷却60s,避免深水鱼把身体拖入水循环。
- **预测(可证伪)**: 下次 `criticalForageLocalOnly` 无近树时应只出现一次 `critical_local_no_tree`,不得再紧跟 `digToSurface START`/`swim`。上坡同一目标首次 `maxRise=0` 后应出现 `surfaceUp.step_edge.runup`,成功率提升或至少不换错方向空蹭。低血 feedUp 必须留下 `food_scan`;深水 salmon dy>5 应写 `critical fish skip ... too deep`,不得连续追鱼游泳。`safe critical-fish failed` 后60秒内不得再次追同一类深鱼。
- **观测**: ✅ 12:11 hot reload 后 hp6/food0 无动物窗口写 `critical local-only stop`,没有复发 PlanD 长 roam;surfaceUp 从 bunker 近处爬到 y68,`step_edge.end ok=true`。✅ 12:17 起 `food_scan` 证明资源局面: `animal64=none fish32=salmon@17 oak48=oak_log@14`,说明不是普通32格动物漏检。⚠️ 12:19 放宽鱼救援后 salmon 在 y56/y53 深水,触发多段 SWIM,未掉血但 timeout;随后收紧 dy≤5+冷却。🟡 同次水边过程疑似拾到/吃到鱼或掉落,food 0→2;12:22 入夜,待确认新 dy gate 后不再追 deep salmon,并能稳定 sealed night hold。
- **回滚**: 删除 `critical_local_no_tree` 早退;PlanD 恢复36格 oak 检查;`surfaceUp.stepEdgeAssist` 恢复单次 forward+jump;删除 `foodScan/criticalRescueFish/safeRoamTo` 途中 hurt/hostile watcher。

## C62. famine-critical 身体预算: 禁 EVAC/BREAKOUT 烧穿 + 本地苹果一致化（③层,现场验证中）
- **触发**: 12:30-12:37 live 显示 bot hp4/food1-0 时,夜堡结束后 `feedUp` 明确看到 `oak48=oak_log@8` 却因 PlanD 本地 oak 判定只扫 dy0..+5 而直接 `critical local-only stop`。随后 `missionNether` 的 `BREAKOUT` 在 food1 打洞推进,又在 food0 反复 `EVAC ... sprinting 40b`,实测每次只移动1.3-4.6格但继续消耗饥饿。PlanD 终于触发后,`chopWood` 又因 hp4 一律 bail,苹果兜底进门即退。
- **改动**: ①`prepNether` dusk snackless gate: 黄昏+hp/food危殆+无可吃物时立即进入 hole-up loop,不再先 `KIT/feedUp`。②`feedUp.localOakLike` 与 `food_scan` 对齐: 扫 dy -6..+8,并用 `world.getNearestBlock` 兜底,低血只放行10.5格内本地 oak/dark_oak。③`chopWood.criticalForageLocalOnly` 放宽到10.5格/高差≤5,但禁止 `near-high-tree surfaceUp`、`not-surface digToSurface` 和失败后的 relocation/stair;hp4 只在该本地模式下允许一次受控 forage。④`missionNether` 增 `famineCritical()`: hp≤6、food≤2、无食物时 gate 掉 EVAC 40格冲刺与 BREAKOUT tunneling,只 stop/clear/等待,把身体留给 feedUp/shelter/近身反射。
- **预测(可证伪)**: hp≤6 food≤2 无食物时不得再出现 `★EVAC ... sprinting 40b` 或 `★BREAKOUT: pinned 4min — tunneling`;应写 `EVAC gated`/`BREAKOUT gated`。PlanD 若看到本地 oak,应进入 `chopWood CRITICAL-FORAGE allowed`;若无进展,必须 `yield without relocation/stair`,不得跟随 `digToSurface`/`surfaceUp`/`moveAway`。黄昏 shelter_now 不应再先刷 `KIT → feedUp`。
- **观测**: ✅ 12:38 cancel_skill+sticky 重发后新 mission 加载。✅ 12:39:40 出现 `★BREAKOUT gated: famine-critical hp=4 food=0; no tunneling/sprint`,证明顶层 BREAKOUT 已被禁。✅ 12:39:45 PlanD → `chopWood CRITICAL-FORAGE allowed hp=4.0`,随后 `nearest=oak_log@10.3b` 无进展即 `yield without relocation/stair`;没有复发 surfacing/roam/stair。🟡 EVAC gate 等下一次 16格怪触发验证;当前 food0/hp4 仍是结构性无食物死结,但身体预算不再被任务层主动烧穿。
- **回滚**: 删除 `missionNether.famineCritical` EVAC/BREAKOUT gates;`feedUp.localOakLike` 恢复 dy0..+5/4.8格;`chopWood` 恢复 hp4 critical forage 禁止和 critical-local 下 surfaceUp/digToSurface/relocation 旧路径。

## C63. famine static kit + feedUp gate（③层,现场验证中）
- **触发**: 12:50-12:52 live 显示 food0/hp4/no edible 已安全熬过夜,但旧 `prepNether` 黎明后仍先 `KIT torch → LOW-FOOD gate → keepFed → surfaceUp/feedUp`,把身体从 sealed bunker 推到坡面;背包明明有 `raw_iron=1,furnace=1,coal=10,oak_planks/logs`,足够原地做盾牌。
- **改动**: ①`prepNether` 新增 `famineBudget()` 与 `famineStaticKit()`: hp≤6、food≤2、无 edible 时,只允许用身上材料和臂长内 station 做静态生存装备。可本地放 furnace/crafting_table,必要时只凿脚边一个 station niche,不寻路;优先 smelt 1 raw_iron→craft/equip shield,再补 stone/wood sword。②`stockTorches/keepKit` 在 famine budget 下让位;goal loop 中静态 kit 后立即 famine gate,不再进入 `keepFed()` 推身体找食物。③`missionNether` 的 advisory eat_now 与 low-hp cooldown feedUp 增 famine gate: 只有12格内有安全动物且无近敌才允许 feedUp,否则写 gated 并等待。
- **预测(可证伪)**: hp≤6 food≤2 无 edible 且有静态材料时,progress 应出现 `FAMINE static kit check` 与 `FAMINE static shield crafted/equipped`;随后不应紧跟 `KIT — stocking torches` 或无近动物的 `feedUp`。若无近食物信号,mission 应写 `eat_now gated` 或 `cooldown feedUp gated`。
- **观测**: ✅ 12:52 现场验证: `FAMINE static kit check food=0 hp=4 shield=0 iron=0 raw=1 planksEq=43` 后放 furnace、熔铁、放 crafting_table,最终 `FAMINE static shield crafted/equipped shield=1`;vitals 显示 `shield=1 stone_sword=1 coal=9 raw_iron` 已消耗。⚠️ 同一旧实例随后仍进入 `feedUp`,因此追加 gate 前移与 mission feedUp gate;待 sticky 重发后验证不再空转。
- **回滚**: 删除 `famineBudget/famineStaticKit/localStation/planksEqHeld`;恢复 `stockTorches/keepKit/keepFed` 原顺序;删除 `missionNether.safeCloseFoodSignal` 与两个 feedUp gated 分支。

## C64. pin-breaker 饥荒冻结豁免（①层,现场验证中）
- **触发**: C63 后 body 已正确停在 `FAMINE body freeze`,但 `reflex_watchdog` 仍每分钟广播 `Pinned 15min+ — kicking the stack`,导致 sticky `missionNether` 被反复 cancel/rearm。旧豁免只覆盖夜间/有顶低食物;当前是白天坡面 food0/hp4/no edible/no hostiles 的合法省命冻结。
- **改动**: `src/agent/modes.js` pin-breaker 增 `famineHold`: food≤2、hp≤6、无 edible、无12格敌对、脚/头非水火岩浆、非坠落,且没有 active dig/escape work 时,重置 `pinAnchor/pinAt/pinKick`,不发送 forced interrupt。
- **预测(可证伪)**: C63 当前现场继续 food0/hp4 静止时,60秒后不应再出现新的 `Pinned 15min+` 或对应 `skill_result cancelled=true`;仍应保留 `FAMINE body freeze` 心跳。
- **观测**: ✅ `node --check src/agent/modes.js` 通过。20:59 首次 reload 因 PowerShell `$PID` 只读变量/自匹配 watchdog 未完成,仍有旧进程与双 bridge;13:00-13:02 继续出现 pinned kick。21:04 按明确 PID clean reload,收束为 agentWs pid37360、mindserver pid9492、单 bridge pid19164,MC LAN pid8620 未动。13:05:08 后新栈进入夜间 sealed bunker,到13:06:35 只见 `FAMINE body freeze`,无新 `Pinned 15min+`。
- **回滚**: 删除 `famineHold` 变量和 pin reset 条件中的 famineHold 分支。

## C65. step-edge 真空格判定 + 饥荒冻结挡 unstuck + 短身体移动锁（①/③层,现场验证中）
- **触发**: 13:11-13:18 live `mine_motion` 抓到高频上坡卡边: bot 在 `54,62,-6` famine-critical/ENTOMBED 状态反复向 `54,62,-7` 的 `grass_block` 台阶尝试 `step-edge assist`,但自身 `ownAbove=grass_block@54,64,-6` 不是可起跳空间,因此每次 `maxRise≈0.2,targetDist≈1` 失败。并发上还出现 `dig.begin target=grass_block@53,63,-7` 与 step-edge 同时发生,挖的不是台阶/头顶关键块,是身体被隐式控制流抢占的局部证据。
- **改动**: ①`modes.unstuck` 入口先执行 `famineBodyFreeze(agent,'unstuck')`,food0/hp4/no edible/no近敌的合法冻结不再被 unstuck 顶着走。②`modes.unstuck` 与 `surfaceUp.stepEdgeAssist` 的 `open()` 从 `/grass/` 模糊匹配改为精确 passable set,`grass_block` 不再被误认为空气;不可上台阶写 `step_edge.skip` 及自身/目标/头顶格。③step-edge 执行期间设置 `_bodyMoveLockOwner/_bodyMoveLockUntil`;`installMotionAudit` v3 中 dig/place 遇短身体移动锁会先 `*.deferred`,避免边跳边被 dig/place 打断。
- **预测(可证伪)**: famine-critical 安全冻结时不应再出现 `[step-edge] assist begin`;非饥荒的真实一格台阶仍可触发,但 `grass_block` 头顶堵塞应记录 `step_edge.skip reason=own-above-blocked/target-*` 而不是硬跳。step-edge 进行中不应再有并发 `dig.begin` 直接抢身体,应出现 `dig.deferred activeMove` 或等移动结束。
- **观测**: ✅ `node --check src/agent/modes.js bots/_supervisor/skills/installMotionAudit.js bots/_supervisor/skills/surfaceUp.js bots/_supervisor/skills/branchMine.js` 均通过。21:19 agent-only reload 窗口由 watchdog 接力拉起新进程,最终 `fresh_status=live`,agentWs pid34036、mindserver pid508、MC LAN pid8620 未动;`audit.installed` at 13:19:31Z 证明 v3 装上。13:19:31-13:21:17 一分钟+窗口内 progress 只有 `FAMINE body freeze`/`FAMINE gate`,无新的 `[step-edge] assist begin`;`mine_motion` 也无 post-audit dig/step_edge 追加。🟡 非饥荒真实上坡/矿洞 staircase 成功率待下一次 branchMine/surfaceUp 行走窗口验证。
- **回滚**: 删除 `unstuck` 的 `famineBodyFreeze` 入口;`open()` 恢复旧 `/air|grass|.../` 判定;删除 `_bodyMoveLock*` 设置和 `installMotionAudit` v3 的 `activeBodyMove/waitForBodyMove`。

## C66. branchMine 行进全量轨迹 + stepInto 身体移动锁（③层,待下一矿洞窗口验证）
- **触发**: 对最近 3000 条 `mine_motion` 回放统计发现,除 C65 已处理的 famine step-edge 外,矿洞/采矿相关仍有 `branchMine` 高位矿石/台阶失败样本,如 `branchMine` 在 `30,80,11` 附近挖 `coal_ore@29,82,10` 出现 `Digging aborted`。旧 `branchMine.step.begin/end` 只记录 floor/foot/head,没有 held/hp/food/周围3D图景/最终失败归因,不足以回答用户要求的"每一次操作的所处方块、目标方块、周围图景以及结果"。
- **改动**: ①`branchMine.motion()` 增 `foot/head/above/held/hp/food/env(3x3x4)` 全量快照,覆盖 `branchMine.step.*`、ore chase、probe stop 等自有事件。②`branchMine.stepInto()` 在 `goToPosition` 与手动 forward+jump fallback 期间设置 `_bodyMoveLockOwner=branchMine:<label>` 和 `_bodyMoveLockUntil`,让全局 `installMotionAudit` v3 延后并发 dig/place。③`branchMine.step.end` 增 `reason`: `floor-lost/foot-blocked-after-clear/head-blocked-after-clear/wrong-y/not-centered/fluid-after-move/ok`,以后矿洞路线失败不再只看 `stalled`。
- **预测(可证伪)**: 下一次 `branchMine` descent/tunnel 失败时,`mine_motion` 必须包含完整 env、held、hp/food、目标格和 `reason`;若有并发 dig/place 打断,应出现 `dig.deferred/place.deferred activeMove owner=branchMine:*`。成功路径不应因移动锁变慢超过单步约3-4秒。
- **观测**: ✅ `node --check bots/_supervisor/skills/branchMine.js` 通过。当前 bot 仍 food0/hp4 famine hold,没有安全矿洞行进窗口,等待下一次非饥荒 branchMine/surfaceUp 验证。
- **回滚**: `branchMine.motion()` 删除新增 foot/head/above/held/hp/food/env;`stepInto()` 删除 `_bodyMoveLock*`;`step.end` 删除 `reason/floor/foot/head`。

## C67. 白天饥荒觅食脉冲 + 地堡出坑验证（③层,部分验证）
- **触发**: C63/C64/C65 后 bot 能在 food0/hp4/no edible 时安全冻结/入夜地堡,但天亮后 `prepNether` 仍先 `famineCritical()` 直接 return,导致更保守的 `keepFed/feedUp` 永远没有机会运行;`missionNether` 也把 famine-critical 的 `eat_now`/cooldown feedUp 限死为"12格内有安全动物",在无动物但白天无怪时形成永久食物死锁。
- **改动**: ①`missionNether.safeDaylightFamineForage()` 放行一个很窄的窗口: famine-critical、白天、overworld、y≥55、16格内无可达/远程敌对时,允许 `feedUp` 接手,否则仍 gate。②`prepNether.daylightFamineForageWindow()` 在 goal 前/goal 中把 famine gate 改为每60秒一次 `keepFed/feedUp` 脉冲;失败后设置低血无食物 cooldown 并继续静止/入夜地堡。③保留夜间/近怪/地下深处的硬 gate,不恢复长距离乱跑。
- **预测(可证伪)**: 天亮 food0/hp4/no edible 且无近怪时,progress 应从 `FAMINE gate` 变成 `FAMINE daylight forage window ... -> keepFed/feedUp`;夜晚或有怪时仍只 hold/shelter。若 feedUp 未找到食物,应写 `HUNGER/LOWHP gate` 并 cooldown,不得进入 kit/branchMine/Breakout。
- **观测**: ✅ 13:33:49 热加载后命中 `FAMINE daylight forage window before shield`,随后 `enclosed/high-pocket food run — surfaceUp target=70`;`mine_motion` 记录 `surfaceUp` 挖 `grass_block/dirt` 的 begin/end、当前位置、目标块和 3x3x4 env,并把 bot 从 `54,62,-6` 带到地表附近 `53,69,-5`。✅ 当白天无动物/瓜/浆果/掉落时,`feedUp` 只做本地 PlanD/food_scan,失败后 `HUNGER/LOWHP gate` 冷却;没有新死亡。✅ 13:41 dusk 到来后自动 `DUSK critical snackless shelter` 并 `dug-in bunker SEALED y=68`。⚠️ 当前区域仍是结构性无食物死区: `animal64=none drop32=none melon48=none berry48=none`,只有深水 salmon 与 10格 oak_log,待 C68/后续策略找出口。
- **回滚**: 删除 `safeDaylightFamineForage/daylightFamineForageWindow`;goal loop 恢复 famineCritical 直接 return;mission cooldown/eat_now 恢复只看 `safeCloseFoodSignal()`。

## C68. 临界鱼扫描对齐 + 饥荒微侦察诊断（③层,待下一白天验证）
- **触发**: C67 出坑后 `feedUp` 的 `food_scan` 连续显示 `fish32=salmon@20..31`,但 `criticalRescueFish()` 只查24格且 dy≤5,先漏掉 26-28格鱼,后又对 `dy=6` 直接 skip。放宽后证明当前可见鱼实际多在 `dy=10..17` 深水,不适合 hp4 直接下水;同时"完全不移动"会让 bot 在无食物高地等死,但旧 `desperationRoam` 对 hp≤8 硬停。
- **改动**: ①`criticalRescueFish` 搜索半径从24对齐到 `food_scan` 的32,垂直阈值从5放到7;真正移动仍交给 `safeRoamTo` 的禁挖/禁跑酷/maxDropDown=1/受伤或见怪中止。②新增 `criticalMicroScout()`: hp≤6、food≤2、白天、10格无怪时,最多每45秒尝试一次 10格安全微侦察(优先朝 spawn 方向),仍用 `safeRoamTo` 护栏,不是长距离 roam。③增加 `critical micro-scout guard` 诊断日志,下个白天能看见是 night/hostile/cooldown 还是条件挡住。
- **预测(可证伪)**: 下个白天若无动物/瓜/掉落且鱼 dy≤7,应出现 `critical rescue fish`;若鱼 dy>7,应明确 `critical fish skip ... dy=N`。若仍无安全食物,应出现 `critical micro-scout ... safeRoam gated` 或 guard 原因;不得出现 sprint/Breakout/长距离 relocate。任何微侦察中掉血或见怪应由 `safe critical-micro-scout failed` 中止。
- **观测**: 🟡 13:37-13:40 验证到 fish 半径/垂直日志: `salmon@23..28 dy=10..17` 被 skip,没有下水送死;无新 death。⚠️ `critical micro-scout` 尚未在白天窗口落日志,13:41 已入夜并 sealed bunker;已追加 guard 日志等待下个白天验证。
- **回滚**: `criticalRescueFish` 恢复24格/dy≤5;删除 `criticalMicroScout` 与 guard 日志。

## C69. 白天饥荒近怪掩体 handoff（③层,现场验证中）
- **触发**: C68 后 13:51 白天 `feedUp` 微侦察从 `50,75,-4` 移到 `45/46,75,-8`,未受伤;随后 `zombie_villager` 进入 13-14 格。`safeDaylightFamineForage()` 正确禁止继续觅食,但 `missionNether` 低血无食物 cooldown 只反复 wait,`prepNether` 的地堡逻辑又只在夜/黄昏触发,于是出现露天 `FAMINE body freeze` 站桩。
- **改动**: ①`prepNether.holeUpAtNight()` 的 while 条件扩展为 `night || dusk || dayFamineHostileShelter`: hp≤6、food≤2、无 edible、白天、overworld、非地下安全、16格内有敌对时复用同一套 digDown+seal 地堡,写 `DAY famine-hostile shelter`。②`missionNether` 在低血无食物 cooldown 分支新增 `daylightFamineHostileShelter()` handoff,若白天露天且 hostiles16>0,每30秒最多一次调用 `prepNether`,不再空等。
- **预测(可证伪)**: 当前 hp4/food0/白天/hostiles16=1 场景应从 `cooldown feedUp gated` 转为 `cooldown shelter handoff` + `DAY famine-hostile shelter`/`dug-in bunker`;若已有顶盖或怪离开,应停止重复挖。无怪白天仍允许 C67/C68 的觅食脉冲/微侦察,不提前入坑。
- **观测**: ✅ 14:00 热加载验证: 旧循环先继续 `FAMINE gate hostiles16=1`,随后新代码命中 `prepNether: ★DAY famine-hostile shelter — hp=4 food=0 hostiles16=1`,2.2s 后 `★dug-in bunker SEALED y=73`;`mobility` 从 FREE 变 `POCKET`,vitals 显示位置 `46,73,-8`,无新 death。13:59 rearm 后再次进入同一条件,识别 `bunker already covered — skip water relocation and hold y=73`,证明不会重复乱挖。
- **回滚**: 删除 `shouldDayFamineHostileShelter/daylightFamineHostileShelter` 及 mission cooldown handoff;`holeUpAtNight` while 条件恢复夜/黄昏。

## C70. 临界饥荒优先追 oak/apple 线索（③层,待下一白天验证）
- **触发**: C68/C69 现场和历史 progress 显示,`feedUp` 多次在 hp4/food0 白天写出 `food_scan ... oak48=oak_log@10..14 oakLeaf16=oak_leaves@13..16`,但低血 PlanD 只接受 `localOakLike(10,10.5)`,因此 13:51 的 `oak_log@14/oak_leaves@13` 没有被当成食物线索,直接走 `critical micro-scout` 朝 spawn 方向。结果 bot 从安全觅食变成随机小挪,随后因近怪被 C69 掩体接管。
- **改动**: `feedUp` 新增 `criticalOakAppleForage()`: hp≤6、food≤2、白天、10格无敌对时,扫描18格内 `oak/dark_oak leaves/log`,dy≤8 才放行;若距离>5,用 `safeRoamTo(..., canDig=false, no parkour, maxDropDown=1, hurt/hostile abort)` 靠近到4格,再执行 `appleLeafSweep(40)` 和拾取/进食。调用顺序放在 `criticalRescueFish()` 之后、`criticalMicroScout()` 之前,即"明确树叶/苹果线索"优先于随机微侦察。
- **预测(可证伪)**: 下一次白天 hp4/food0 且 `food_scan` 有 oak/leaves 10-18格时,应出现 `feedUp: critical oak forage ...` 和 `safe critical-oak`/`PlanD leaf sweep`;若被怪/受伤/路径失败,应中止并保留 C69 掩体。无 oak 线索时仍走 C68 micro-scout。
- **观测**: 🟡 `node --check bots/_supervisor/skills/feedUp.js` 通过。当前为夜间 POCKET hold,等待下个白天安全觅食窗口验证。
- **回滚**: 删除 `criticalOakAppleForage()` 及其在 hp≤8 critical block 中的调用。

## C71. 饥荒濒死身体优先级修正: bankRecover/step-edge 不准抢掩体（①/③层,现场验证中）
- **触发**: 14:11-14:13 live 暴露两个优先级漏洞: ①bot hp4/food0 在白天近怪掩体中,`unstuck` 的 step-edge assist 仍把它从 bunker 边缘推出,连续写 `[step-edge] assist begin/end` 并把 mobility 从 POCKET 打回 FREE;②`prepNether START` 后 `bankRecover: under-armed ... withdraw from bank(bed) @ 8,77,46` 先于 `DAY famine-hostile shelter` 执行,在 hp4/food0/hostiles16=2 时尝试去远处幽灵 bank。
- **改动**: ①`prepNether.bankRecover` 增 famine danger gate: hp≤6、food≤2、无 edible 且有16格敌对或 bank 距离>8 时,直接让位给 shelter/food,不再跨地形跑 bank。②`modes.unstuck` 的 step-edge assist 增 `famineCriticalNoStep`: hp≤6、food≤2、无 edible、脚/头非水火岩浆/仙人掌/岩浆块、非坠落、4秒内未受伤时,只记录 `step_edge.skip reason=famine-hold`,不执行跳台阶辅助。
- **预测(可证伪)**: 当前 hp4/food0/有近怪窗口,不应再出现 `bankRecover: under-armed ... withdraw` 的远行尝试,而应写 `bankRecover: FAMINE danger gate` 后 shelter/hold。step-edge 在非立即危险的饥荒濒死态不应写 `[step-edge] assist begin`,若 unstuck 触发应在 `mine_motion` 看到 `step_edge.skip reason=famine-hold`。水/火/坠落/刚受伤仍可绕过该闸继续脱困。
- **观测**: 🟡 `node --check src/agent/modes.js bots/_supervisor/skills/prepNether.js` 通过。14:21 agent-only reload 后现场未再看到新的 `[step-edge] assist begin`,但 14:23 暴露新死因: creeper backoff 反射在崖边盲走导致 fall,见 C72。
- **回滚**: 删除 `bankRecover` 的 famine danger gate;删除 `modes.unstuck` 的 `famineCriticalNoStep` 与 `famine-hold` skip 分支。

## C72. creeper backoff 防坠崖: 悬崖方向不再 forward（①层,现场验证中）
- **触发**: C71 reload 后 14:23:02 新鲜死亡: `cause=fall x=52 y=62 z=-8`,前一秒 events 明确是 `Creeper 9m — backing off!`。代码回放发现 creeper raw backoff 虽有 `dropAhead > 3` 后关闭 sprint/jump,但仍然 `forward=true`,等价于在悬崖边慢走下去。
- **改动**: `modes.self_preservation` creeper backoff 每 tick 先检查候选逃跑方向: 原方向、左右45度、左右90度;候选必须非水/火/仙人掌/岩浆且落差≤1(hp≤8)或≤2(健康时)。找不到安全方向时清控制,写 `creeper backoff cliff-gated ... emergency bunker/hold`,转 `bunkerDown()` 而不是继续 forward。小落差只允许不 sprint/jump 的谨慎走。
- **预测(可证伪)**: 下次 creeper 9-10格且背后是崖/洞时,不应再出现一秒内 fall death;progress 应出现 `creeper backoff cliff-gated` 或选择侧向安全方向。平地 creeper 仍应继续正常 backoff。
- **观测**: 🟡 `node --check src/agent/modes.js` 通过。14:27 agent-only reload 成功(48909 pid6212,8765 pid28156,MC LAN pid8620 未动)。14:27-14:29 live 维持夜间 covered hold,无新 death;尚未复现 creeper+悬崖窗口。
- **回滚**: 删除 `inspectRunDir/rotate/maxDrop` 候选方向逻辑,恢复旧 `dropAhead` 只关 sprint/jump 的 raw forward。

## C73. MAROONED 近身树冠采集 + 台阶失败削坡（①/③层,现场验证中）
- **触发**: C72 后不再盲摔,但 14:32-14:34 出现新仲裁矛盾: mobility 判 `MAROONED` 后反复 `ledge veto`,mission 站下,`chopWood` 又无条件 `BAIL (MAROONED)`,即使 progress 已写 `MAROONED no-pick stone gate but oak_log nearby — handoff to chopWood` 也无法伸手砍近木。另一个频发样本是 `step-edge assist begin/end ok=false` 在同一台阶格循环,只跳不上去,没有降级动作。
- **改动**: ①`chopWood` 新增 `MAROONED local canopy harvest`: 仅在 MAROONED 或新鲜 wood-handoff、hp/food 安全、12格无敌对时启用;只处理臂距约5格内的 log/leaves,不 pathfinder、不远征,直接清叶/整柱挖木/扫掉落,并忽略“寻路不可达”黑名单对贴脸可挖木的误杀。②`modes.unstuck` 的 step-edge assist 正常跳失败后新增 `step_edge.notch`: 若前方台阶块可挖且下方有实地,挖低前方一格再短走过去;每次 begin/end/notch 带目标格、当前坐标、周围图景和结果写 `mine_motion.jsonl`。
- **预测(可证伪)**: 下次 MAROONED+附近木头时应出现 `MAROONED local canopy harvest` 或 `chopWood.marooned_local.*`,而不是单纯 `BAIL (MAROONED)`;同一台阶不应连续多次 ok=false,失败后应看到 `step_edge.notch.begin/end` 且要么通过,要么给出不可挖/危险原因。
- **观测**: 🟡 `node --check bots/_supervisor/skills/chopWood.js src/agent/modes.js` 通过。14:42 agent-only reload 成功(48909 pid25576,8765 pid47612,MC LAN 未动)。现场旧 skill 在 reload 前已通过贴脸 direct-chop 从 food1 场景拿到 5 根 oak_log,证明近身采集路线有效;C73 新 MAROONED 专用分支和 step-edge notch 尚待下一次触发验证。
- **回滚**: 删除 `_maroonedLocalHarvest` 及 main loop 中 handoff/MAROONED 调用;删除 `step_edge.notch` 降级段,恢复纯跳台阶 assist。

## C74. feedUp 饥饿长跑刹车: food≤4 无明确目标不再 24 格 ping-pong（③层,待验证）
- **触发**: 14:36-14:42 `feedUp` 在无动物区域反复 `famine roam relocate` 于同一高坡两侧穿梭,food 从15一路烧到2;即使 14:40-14:41 已经 PlanD 砍到 5 根 oak_log/扫叶,仍继续长跑,把刚得到的饥饿缓冲烧掉。
- **改动**: 在 `feedUp` 无动物分支、所有本地食物线索(掉落/鱼/瓜/浆果/腐肉/PlanD oak/apple/critical rescue)都失败之后,新增 calorie floor: `food<=4 && no edible` 时写 `feedUp: calorie-floor stop ... no long roam without a target` 并停止本轮,把身体交还夜间掩体/工具链,不再发起无目标 24 格 relocate。
- **预测(可证伪)**: 下一次 daylight feedUp 若 food≤4 且没有明确动物/鱼/瓜/浆果/掉落目标,应停止在本地,不得继续刷 `famine roam relocate`;若有明确目标,仍允许 `safeRoamTo` 受伤/见怪中止的短程靠近。
- **观测**: 🟡 `node --check bots/_supervisor/skills/feedUp.js` 通过。当前 14:43-14:44 live 为 night bunker, hp13 food2, inv 3 oak_log/21 dirt,不应主动拉出验证;等待天亮或下一次 advisory feedUp。
- **回滚**: 删除 calorie-floor stop 分支,恢复 `desperationRoam()` 在 food≤4 时也可无目标长跑。

## C75. 导航黑匣子 + step-edge 目标方向 + food≤6 无目标禁空跑（①/③层,现场验证中）
- **触发**: 14:52-14:54 live 复盘显示两类运动病灶仍在: ①`feedUp` 在 PlanD 得到 emergency food=5 后,旧 C74 只挡 food≤4,于是继续 `famine roam relocate` 在同一高坡两侧 20+格横跳,把 food5 烧到4才停。②上坡/矿洞失败虽然已有 `act_trace` 与 `mine_motion` 的 dig/place 记录,但缺少每次 pathfinder 的目标、路径类型、phase stuck 和结果,无法完整回答"每一次操作的所处方块、目标方块、周围图景以及结果"。同时 `step_edge` 方向仍主要来自 yaw;pathfinder 上坡时 yaw 不一定等于下一步 path 方向,容易在台阶边缘误判目标格。
- **改动**: ①`src/agent/library/skills.js` 增轻量 `motionAudit()` 并接入 `goToGoal/executePathfindingPhase`: 记录 `path.begin/path.plan/path.phase.begin/path.phase.stuck/path.phase.end/path.unstick/path.end`,包含 seq、goal、selected movement、stuckMs、attempts、hp/food/held/skill/mob。②`goToGoal` 暴露 `_lastPathGoalInfo/_lastPathGoalAt`;`modes.unstuck` 的 step-edge 方向选择改为候选集: path goal/entity/inner-goal → recent-motion → yaw → 四向 fallback,选择第一个真实 step-like 目标,并把 `dirSource/candidateDirs/pathGoal` 写入 `mine_motion`。③`feedUp` calorie floor 扩到 `food<=6 && no edible`,但先允许 `desperationRoam({concreteOnly:true})` 追 96格内真实动物;没有具体动物/鱼/瓜/浆果/掉落/本地 oak 线索时写 `targeted roam scan ... no concrete target` 后停止,不再无目标 24格 relocate。
- **预测(可证伪)**: 下一次 pathfinder 行进/卡住时,`mine_motion.jsonl` 应出现 `path.*` 序列,能从日志直接读出目标坐标、phase、stuck/unstick 结果。下一次台阶边缘卡住时,`step_edge.begin/skip` 应包含 `dirSource` 和 `candidateDirs`;不应再只按 yaw 对错误格硬跳。food 4-6 且无明确目标时不得再刷 `famine roam relocate`;若有 far animal,仍允许 `safe animal-close`。
- **观测**: ✅ `node --check src/agent/library/skills.js src/agent/modes.js bots/_supervisor/skills/feedUp.js` 均通过。✅ 23:02 agent-only reload 成功,新进程 `main.js` pid40108、`init_agent.js` pid39536,MC LAN 55916 未动;agent.log 确认 `WebSocket server started on ws://0.0.0.0:48909`。✅ 15:01 新 feedUp 已写 `targeted roam scan animal64=none fish32=none drop32=none melon48=none berry48=none oak48=oak_log@11 oakLeaf16=oak_leaves@11 ... no concrete target` 与 `calorie-floor stop food=4 ... scan=...`,证明 C75 已加载并阻止无目标长跑。🟡 当前为 night bunker hold,尚未触发新 `path.*` 或 step-edge 候选方向样本;待天亮/下矿窗口验证。
- **回滚**: 删除 `motionAudit/motionGoal/motionPathLen` 与 `goToGoal/executePathfindingPhase` 的 `path.*` 写入;`modes.unstuck` 恢复 yaw-only 方向;`feedUp` calorie floor 恢复 food≤4 且直接 stop,`desperationRoam` 恢复无目标 relocate。

## C76. feedUp targeted oak forage: food≤6 把近处橡树当具体目标（③层,待白天验证）
- **触发**: C75 生效后现场 scan 显示 `food=4 hp=13 animal64=none fish32=none drop32=none melon48=none berry48=none oak48=oak_log@11 oakLeaf16=oak_leaves@11`,但 `concreteOnly` 只承认远处动物,于是把 11 格橡树误判成 `no concrete target`。这避免了空跑,但也可能把 bot 固定在 food4 的昼夜死结里。
- **机理**: PlanD 苹果 forage 只在 `food<=2` 才运行,且 `appleLeafSweep` 内部 `bot.food > 2` 立即停止。food4 已经低到不能再盲走,却高到不会扫叶,形成中间饥饿带。
- **改动**: `appleLeafSweep(maxLeaves,{stopFood})` 支持指定停止饥饿线,默认保持 `stopFood=2`;新增 `targetedOakAppleForage()`: food≤6、无可吃物、白天、10格无敌、18格内有 oak/dark_oak 且 dy≤8 时,用 `safeRoamTo(canDig=false/noParkour)` 走到树旁,扫最多40片叶子直到 food>6。若树干/树叶有高差导致直接扫叶够不到,允许一次 18s timebox 的本地 `chopWood(... criticalForageLocalOnly)` 后再拾取/吃苹果/扫叶。失败后 45s 冷却并写 `targeted oak forage ... / no apple`。该分支放在 calorie-floor stop 之前,仍不恢复随机 24 格 relocate。
- **预测(可证伪)**: 下一次白天从当前 food4 掩体恢复时,如果 18格内橡树仍可见,progress 应先出现 `feedUp: targeted oak forage oak_log@...` 或 `oak_leaves@...`,随后 `PlanD leaf sweep ... stopFood=6`;若无苹果,45s 冷却后才允许 calorie-floor stop,不会来回长跑。
- **观测**: ⚠️ 15:11-15:12 已现场触发 `feedUp: targeted oak forage oak_log@10/4`,证明 food≤6 近处橡树识别生效;但第一版在高差树冠上出现 `safe targeted-oak failed (Took to long to decide path to goal!)` 与 `targeted oak forage no apple` 后仍停在 food3,说明仅靠直接扫叶不足。已追加 partial-approach 容忍 + 本地 `chopWood`/再扫叶收尾。✅ `node --check bots/_supervisor/skills/feedUp.js` 通过;待下一轮 feedUp 验证是否拿到苹果/木材或至少留下 `local chop/sweep` 证据。
- **回滚**: 删除 `targetedOakAppleForage()` 调用/函数,`appleLeafSweep` 恢复固定 `bot.food > 2` 停止线。

## C77. feedUp 动物目标经济阈值: food 越低越不能远追（③层,待验证）
- **触发**: C75 禁掉无目标长跑后,15:14 live 又暴露出"有真实目标但不经济": food2/1 时 `feedUp: famine roam animal 93b/58b away`,两次 `safe animal-close` 分别 timeout/hurt,food 2->1->0,hp 13->12->10,最后 `FAMINE body freeze`。它不是 blind roam,但实际同样烧掉最后饥饿。
- **机理**: `desperationRoam()` 把 96 格内动物一律当 concrete target。极低 food 下,远目标的移动成本超过收益概率;且山地高差/路径规划失败会在失败前先消耗饥饿和承伤。
- **改动**: 远动物靠近增加经济阈值: food≤2 只追≤32格,food≤4 只追≤48格,food≤6 只追≤64格,更高才保留≤96格;同时 dy>10 直接跳过。跳过时写 `famine roam animal skip ... too costly`;若处于 concreteOnly/food≤6,跳过后返回 false,进入 calorie-floor stop 而不是随机 relocate。
- **预测(可证伪)**: food≤2 时不得再出现 `famine roam animal 58b/90b away` 这种长追;应出现 `animal skip ... max=32 ... too costly` 后停住保命。food3-4 仍可追 48格内动物,food5-6 可追64格内动物。
- **观测**: ⚠️ 15:15 现场正向验证一半: food0 时 32格动物被允许 `famine roam animal 32b` 并连续猎到 rabbit/sheep,food 0→8,hp 保持10,说明"极低饥饿只追近目标"能救回一截。尚未看到 `animal skip ... too costly` 正例;随后暴露 food8/hp10 被旧 emergency floor 停住,见 C78。✅ `node --check bots/_supervisor/skills/feedUp.js` 通过。
- **回滚**: 删除 `maxAnimalClose/animalDy` 判断,恢复 96格内动物一律 `animal-close`。

## C78. feedUp emergency floor 收窄到 food4-6（③层,待验证）
- **触发**: C77 后 bot 从 food0 通过 32格近动物恢复到 food8/hp10,但 `feedUp` 立即写 `emergency food floor reached food=8 hp=10 — stop roaming to preserve calories`。food8 虽比濒死安全,仍低于自然回血线,且 hp10 无法恢复;旧 floor 把"保住最后几格饥饿"误用于"应该继续补食物"的中间态。
- **机理**: `if (bot.food >=4 && bot.health <=10 && !edibleHeld()) break` 没有上界,会把 food8/10/12 都当作应停止状态。C77 已经给远动物加了经济阈值,所以不需要用一个过宽 floor 提前截断全部觅食。
- **改动**: emergency floor 改为 `food>=4 && food<=6 && hp<=10 && no edible` 才停;food7-11 允许继续走本地食物线索和经济动物追踪。同时 C77 animal 阈值细化: food7-10 最多追72格,food>10 才恢复96格。
- **预测(可证伪)**: food8/hp10/no edible 时不得再直接 `emergency food floor reached`;若无近食物,可以尝试≤72格动物或最后由常规失败 stop。food4-6/hp≤10 仍应保留 floor,不把最后缓冲烧穿。
- **观测**: ✅ 15:26-15:31 白天窗口验证: food8/hp10 不再出现新的 `emergency food floor reached food=8`;`feedUp` 持续追经济动物,food 8→12→15→20,hp 10→11,无新伤害/死亡。⚠️ 仍有 `safe animal-close failed (goal changed/path stopped)` 样本,说明追动物途中仍可能被其它控制流改 goal,列入后续 BodyGate/仲裁问题。✅ `node --check bots/_supervisor/skills/feedUp.js` 通过。
- **回滚**: emergency floor 条件恢复 `food>=4 && hp<=10`;animal max 阈值中 food7-10 恢复96格。

## C79. feedUp 中间饥饿禁止无目标 relocate（③层,待验证）
- **触发**: C78 放开 food8/hp10 继续觅食后,复查 `desperationRoam()` 发现一个潜在回归: 若 food8 找到的动物超过 C77 经济阈值(>72格或 dy>10),代码会跳过 animal-close 但继续落到旧的 24格 `famine roam relocate`。这会把 C75/C77 修掉的"随机烧饥饿"以中间饥饿形态带回来。
- **机理**: C77 只在 `food<=6` 或 `concreteOnly` 时跳过后返回 false;C78 把 food7-11 从 emergency floor 放出来,但没有同步禁止无目标搬家。结果 food8 不会被 floor 卡住,却可能被 random relocate 烧掉。
- **改动**: `desperationRoam()` 的"动物太远/高差太大"跳过后,food≤10 直接返回 false;没有动物时,food≤10 只写 `targeted roam scan ... no concrete/economic target` 并停止,不再进入 24格 relocate。food>10 才保留旧的探索性 relocate。
- **预测(可证伪)**: food7-10/hp低/no edible 时,若没有≤72格且 dy≤10 的动物或其它具体食物线索,不得出现 `famine roam relocate`;应出现 `no concrete/economic target` 或 `animal skip ... too costly` 后停止/入夜保命。food>10 仍可用 relocate 扩大搜索。
- **观测**: ✅ 15:26-15:29 food8/hp10→food15 过程中未见新的 `famine roam relocate`;有具体动物时只写 `famine roam animal ... max=72/96` 或 `hunting ...`。🟡 尚未抓到 `animal skip ... too costly` 正例;同时 `goal changed/path stopped` 显示动物追踪仍受并发控制影响。✅ `node --check bots/_supervisor/skills/feedUp.js` 通过。
- **回滚**: `desperationRoam` 的两处 `bot.food <= 10` 恢复为 `bot.food <= 6`。

## C80. 夜间掩体静态木剑: 有木头时不再赤手等天亮（③层,待下一夜验证）
- **触发**: 15:24 live 显示 bot 夜间 sealed hold,`hp=10 food=8 armed=false`,背包 `oak_log=4 stick=11` 足够做工作台/木剑;但 `prepNether` 的 `holeUpAtNight()` 会一直 hold 到天亮,后面的 `famineStaticKit()` 根本不会运行。结果 bot 白天仍赤手出门觅食/重建。
- **机理**: 静态补装只覆盖 famine-critical(food≤2/hp≤6)且位于 night gate 之后;中等饥饿/低血的夜间掩体窗口没有"安全小制作"动作。人类玩家会在洞里把木头做成剑,而不是拿原木等天亮。
- **改动**: `prepNether.holeUpAtNight()` 内新增 `nightBunkerStaticWeapon()`: 已封顶/新挖地堡后,若无 sword、8格无敌、planksEq≥4,先把 log craft 成 planks,再 local craft/放置 crafting_table,craft wooden_sword 并 equip;30s 节流,不移动、不挖 niche、不打断夜间 hold。
- **预测(可证伪)**: 下一次夜间 covered hold 且背包有 log/planks+stick、无剑时,progress 应出现 `NIGHT static weapon check` 和 `NIGHT static wooden_sword crafted/equipped`;vitals `armed`/inventory 应出现 `wooden_sword`。若无 planks/table,不应移动找站点或离开掩体。
- **观测**: ✅ `node --check bots/_supervisor/skills/prepNether.js` 通过。🟡 本轮补丁落地时已经天亮并进入 feedUp,未验证;待下一夜/下一次 sealed hold。
- **回滚**: 删除 `nightBunkerStaticWeapon()` 及 `holeUpAtNight` 三处调用。

## C81. 尸体回收/可选备木热区门: 不再裸奔回战斗死点,不为高差树凿坡（③层,现场验证中）
- **触发**: 15:33 死于 creeper 后,bot 3 秒内裸身 `corpseRun: -> death @ -50,40,237`,目标是地下战斗死点;随后 15:35-15:37 在死亡簇附近 `stock wood buffer`/`chop for planks`,对 `oak_log@+4y` 反复 `near-high-tree surfaceUp`,黑名单树柱并继续消耗白天窗口。15:34 又在尸体回收/撤离路线上被 Zombie 杀死。
- **机理**: `death_pos.json` 只有坐标/是否贵重,没有 cause;`corpseRun` 不知道这是不是刚发生的战斗死亡。另一方面,`achieve/prepNether` 的可选备木只按白天/地表粗略判断,会把"看得到但需要垂直工程的树"当普通木材目标,触发挖坡/垫坡/台阶边缘卡顿。
- **改动**: ①`prepNether.corpseRun` 读取最近 `death_log.jsonl` 与 `death_pos` 合并判断: 新鲜(<180s) creeper/zombie/skeleton 等战斗死点,且地下/有怪、当前无 sword+shield/armor 战斗套或24格内有敌,只 defer 不消费尸体文件。②`prepNether.keepKit` 和 `achieve` 的 stock wood buffer 共用更硬门: 必须真开阔地表、白天、24格无敌、hp/food安全,且18格内有 `dist<=12 && |dy|<=3` 的廉价树;否则写明 `nearest tree ... would require climb/stair` 并跳过可选备木。
- **预测(可证伪)**: 下一次新鲜战斗死亡后,裸身不应再立即 `corpseRun: -> death`;应看到 `corpseRun: COMBAT DEATH HOT ... defer until armed/clear`。下一次高坡树/死亡簇附近缺木时,可选 `stock wood buffer` 不应进入 `near-high-tree surfaceUp` 或 `pinned → dig-staircase`;应出现 `SKIP wood buffer — nearest tree ... would require climb/stair`。必要 craft 的 `chop for planks` 仍可能调用 chopWood,但可选 buffer 不再抢身体。
- **观测**: 🟡 `node --check bots/_supervisor/skills/prepNether.js bots/_supervisor/skills/achieve.js` 通过。当前进程确认 `customSkill` 每次 cache-bust 热加载,无需重启;本补丁会在下一次 `prepNether/achieve` 调用生效。15:41 live 为 night sealed hold,等待天亮/下一次重建窗口验证。
- **回滚**: 删除 `latestDeathNear/recoveryCombatKit` 与 `COMBAT DEATH HOT` gate;删除 `reachableWoodTarget/cheapWoodTarget/optionalWoodSafe` 及两处 `SKIP wood buffer` 新门控,恢复旧白天地表备木。

## C82. 夜门返回语义 + 高坡树冠采集判真成功（③层,现场验证中）
- **触发**: C81 生效后,15:40-15:41 仍出现多次夜间 Zombie 裸死;progress 显示 `prepNether: supervisor cancel observed in night gate — returning` 后,外层仍继续 `need shield`/`place table`/工具链。天亮后又出现 `MAROONED local canopy harvest: dug 2 logs ... total 0→0`: 砍掉树冠下方 log,但物品掉到坡下/叶缝,背包木头没有增加,代码却把 `dug>0` 当成功。
- **机理**: ①`holeUpAtNight()` 返回 `false` 但调用点不检查,夜间安全门被上层目标循环穿透。②`chopWood` 本地树冠采集的成功条件是"挖过log"而不是"背包木头增加";同时高海拔树冠/山坡被 `enclosed/sky=false` 误判成地下,反复 `digToSurface`→`raw-stair no viable climb`。
- **改动**: ①`prepNether` 两处 `holeUpAtNight()` 调用改为 `if (await holeUpAtNight() === false) return false`,让夜门/cancel 真正释放 run_skill 锁并停止当轮目标。②`chopWood._maroonedLocalHarvest` 挖 log 前尝试用 dirt/cobble 等非木材填料放 `marooned-catch-ledge` 接料/落脚;只有 `total()>before` 才算成功,`dug>0` 但没入包写 `MAROONED local canopy NO-PICKUP` 并当失败。③`chopWood` 的 `_notSurface` 加入 `_highOpenSurface()` 豁免: 高 y、健康、FREE/开阔的树冠/山坡不再走地下 `digToSurface` raw-stair 循环。
- **预测(可证伪)**: 下次夜门 cancel/hold 返回后,不得继续同一轮 `need shield/place table` 工作;应直接释放到 mission 下一拍。下次树冠 MAROONED 采集若砍到但没捡到,应写 `NO-PICKUP` 而不是 `harvest ... total 0→0`;若有填料,应出现 `chopWood.place.begin/end label=marooned-catch-ledge`。在 y≥70 的树冠/山坡,不应连续刷 `not-surface ... raw-stair no viable climb`;日志应带 `highSurface=true` 或转入普通找树/黑名单逻辑。
- **观测**: 🟡 `node --check bots/_supervisor/skills/prepNether.js bots/_supervisor/skills/chopWood.js` 通过。15:49 live: hp20 food20,无怪,`mob=FREE/ENC`,背包 62 dirt,仍在高坡脱困/找木窗口;等待下一次 `chopWood` cache-bust 调用验证。
- **回滚**: 两处 `holeUpAtNight()` 调用恢复单纯 `await`;删除 `makeCatchLedge/fillerForCatch`、`NO-PICKUP` 成功条件和 `_highSurfaceLike` 对 `_notSurface` 的豁免。

## C83. 采完材料后重锚工作台 + 高山铁矿失败下矿（③层,待验证）
- **触发**: C82 后木头链正向推进: 15:52 `direct-chop: dug 4 logs ... total=4`,随后做出 wooden_sword/wooden_pickaxe 并拿到 cobblestone。但 `stone_pickaxe` 一度在 `cobblestone=30 stick=3 planks=3` 时 `recipesFor empty ... NO KNOWN WAY`,因为为采石离开了原工作台;后续铁矿又在 y93 高坡连续 `bounded one-block descent 1/5...5/5`,仍停在错误高度层找铁。
- **机理**: ①`achieve` 只在收集配方材料之前 `placeTable()`,材料收集(采石/采矿)会把 bot 带离工作台,craft 时 5格内无台,身上又只剩3 planks 不够重新做台。②浅层矿 `exposeMore()` 在 y>72 仍先做 5 次一格盲探,对高山/树冠地形只是在错误高度原地消耗白天。
- **改动**: ①`achieve` 在 table-required recipe 的 ingredient loop 后新增 `place table (post-ingredients)`,craft 前重新确保5格内有工作台。②`placeTable()` 的登记台复用门放宽: 如果身上不能做新工作台、24格内有登记 table 且16格无敌,即使当前 `POCKET/enclosed` 也尝试30s timebox 回走复用;失败时保留登记而不是误删远处台。③浅层矿高处失败: `exposeMore()` 在 y>72 写 `high mountain miss; staircase to y48 then branchMine`,调用 `branchMine(length=20,targetY=48)`,跳过5格盲探。
- **预测(可证伪)**: 下次 stone/iron tool craft 在采完材料离开 table 后,应出现 `place table (post-ingredients)` 并成功 craft,不再 `recipesFor empty`。下次 y>72 找铁失败,应直接出现 `high mountain miss; staircase to y48 then branchMine` 和 `achieve.probe.lateral targetY=48`,不得再刷 `bounded one-block descent 1/5...5/5`。
- **观测**: 🟡 `node --check bots/_supervisor/skills/achieve.js` 通过。15:58 live 已入夜 covered hold,当前旧调用残留已做出 `stone_pickaxe=1`,背包 coal/cobble/wood 足够;等待下一次 `achieve` cache-bust 调用验证 C83。
- **回滚**: 删除 post-ingredients `placeTable()`;`placeTable()` 登记台复用条件恢复 `!pocket && d<=12`;删除 `lateralInstead(... targetY)` 参数和 y>72 `high-mountain-descend` 分支。

## C84. 夜间低食物矿门不再抢先 surfaceUp（③层,待验证）
- **触发**: 16:00 live 显示 bot 已入夜并有 `self_preservation night bunker dwell`,但随后 `achieve` 在 `food=11 y=86` 先触发 `LOW-FOOD mining gate` 并调用 `surfaceUp(target=98)`,在夜里继续挖顶/垫柱到 y89,之后才回到 `prepNether` 夜门。这是 C82 夜门释放之外的另一个旁路: 低食物采矿门比夜间采矿门更早执行。
- **机理**: `achieve.collect` 中 LOW-HP/LOW-FOOD surface/feed gate 位于 `night-exposed mining gate` 之前。入夜且地表/高山暴露时,低食物条件先命中,于是把"停止暴露作业"误导成"往上爬找食物",正好复现用户指出的矿洞行进/垫砖时机糟糕。
- **改动**: 在 collect 循环开头先计算 `miningBlock`,并优先执行 `night-exposed mining gate`;命中时立即 stop pathfinder/clear controls/return false,日志改为 `... before surface/feed routing`。LOW-FOOD gate 继续保留,但只在非夜间暴露采矿时触发 `surfaceUp`。
- **预测(可证伪)**: 下一次夜里 food≤12、无可吃物、y>=50 且在采 stone/ore/cobble 等矿物时,不得出现 `LOW-FOOD ... surfaceUp` 后接垫柱;应先出现 `night-exposed mining gate ... before surface/feed routing`,随后由 `prepNether` 夜门 hold 到天亮。白天/安全地下低食物仍可 surface/feed。
- **观测**: 🟡 `node --check bots/_supervisor/skills/achieve.js` 待本轮执行验证;当前 live 已在 covered night hold,等待下一次 `achieve` cache-bust 调用。
- **回滚**: 把新增的 collect-loop 顶部 `night-exposed mining gate` 前置块删除,恢复 LOW-HP/LOW-FOOD 在夜门前执行。

## C85. surfaceUp 无镐石顶禁硬刨 + food10 近橡树觅食（③层,现场验证中）
- **触发**: 16:06-16:08 live 显示 `prepNether` 在 food=10/hp14/无食物时上浮找食物,`feedUp` 扫描到 `oak_log@7 oakLeaf16=oak_leaves@9`,却写 `no concrete/economic target` 并停止;随后 `mobility=ENTOMBED` 连续刷 `emergency pick craft (ENTOMBED): stone_pickaxe`,但 vitals 背包没有 pickaxe。`surfaceUp` 接着拿 `wooden_sword` 对 `stone@-3,93,26` 做 `planned-ceiling` dig,两次 5s `dig-timeout`。
- **机理**: ①`feedUp.targetedOakAppleForage()` 只允许 food≤6,而 `prepNether` 在 food≤10 已停止备战并要求找食物,形成 food7-10 的近橡树死区。②`surfaceUp.ensureEmergencyPick()` 只看 cobble+stick,没有先用随身 log/planks 补 `crafting_table`;本地 stone_pickaxe craft 失败后,`plannedNoPickStone` 仍允许对 stone ceiling 开挖,导致木剑/空手硬刨超时。③`mobility` 同类 emergency craft 也会因无工作台失败,但没有阻止 surfaceUp 的后续坏动作。
- **改动**: ①`feedUp` 将 targeted oak forage 放宽到 food≤10,扫叶停止线改为 `stopFood=10`,让 food=10 且 18格内有 oak/dark_oak 时尝试安全靠近/本地扫叶/短时本地 chop。②`surfaceUp.ensureEmergencyPick()` 在造镐前若无近/随身工作台,会用随身 log→planks、planks→crafting_table,再调用 local craft 放置工作台造 stone/wooden pickaxe。③如果仍没有镐,`surfaceUp` 记录 `surfaceUp.no_pick_stone.blocked` 并把该石顶视为 blocked,转 scaffold/step/失败返回,不再设置 `plannedNoPickStone` 拿木剑硬挖。
- **预测(可证伪)**: 下一次 food=7-10、白天、无动物但近处有橡树时,应出现 `feedUp: targeted oak forage ... food=10` 与 `PlanD leaf sweep ... stopFood=10`/local chop 证据,不应直接 `no concrete/economic target`。下一次 `surfaceUp` 遇到 stone ceiling 且无镐时,若材料足够应先出现 `emergency pick: crafting ... crafting_table/stone_pickaxe`;若仍失败,应出现 `surfaceUp.no_pick_stone.blocked`,不得再出现 held=`wooden_sword` 的 `planned-ceiling` stone dig-timeout。
- **观测**: ✅ `node --check bots/_supervisor/skills/surfaceUp.js` 和 `node --check bots/_supervisor/skills/feedUp.js` 通过。16:13 live 验证 `surfaceUp` 新 emergency pick 链路: `crafting oak_planks` → `crafting local crafting_table` → `crafting stone_pickaxe`,随后 y91→y98 出洞。`feedUp` 在 food=10 命中 `targeted oak forage oak_leaves@3` 与 `PlanD leaf sweep stopFood=10`,并本地砍到 logs 5→7;未出 apple,但不再直接跳过近橡树。
- **回滚**: `targetedOakAppleForage` 门槛恢复 `bot.food > 6`,两处 `stopFood` 恢复 6;`surfaceUp.ensureEmergencyPick` 删除 table prep/craftTimed helper,并恢复 `planned no-pick ceiling breach` 对 stone ceiling 的 guardedDig。

## C86. MAROONED 走出后放手 + 上坡 edge-miss 判真失败（③层,现场验证中）
- **触发**: C85 后 bot 在 food=10/hp14 树冠/高坡进入 `MAROONED`;`mine_motion.jsonl` 显示它从 `-7,98,24` 一路挖/走到 `-74,91,21` 附近,实际位移超过 60 格,但 `missionNether` 仍每 5s 写 `standing down: MAROONED — march owns the body`。同时复盘 `ascend.end` 旧样本发现 `ok=true,targetDist≈1.2`: 上坡原语升高了,但身体没有真正进入目标格,上层把边缘假成功当成成功继续执行。
- **机理**: ①`modes.js` 注释写了 ">20 blocks re-anchor to FREE",但实现只用 burst 位移清 `_marchFails`,没有按行军起点总位移释放;sticky MAROONED 还会把任务层压住最多 180s。②`_ascendStep` 的成功条件过宽,只看 rise + 目标中心距离≤1.1,对台阶边缘/格子边界的假成功不敏感。
- **改动**: ①MAROONED 进入时记录 `bot._maroonedMarchOrigin`;低食物且无食物时每 burst 从 6 段降到 2 段,减少无谓耗饥饿;从行军起点移动≥10格(低食物)或≥22格(正常)后立即写 `MAROONED release ... re-anchor FREE`,清 `_marchDir/_marchFails/_maroonedMarchOrigin`,把身体还给任务层。②`_ascendStep` 成功条件改为 `rose && settledInTarget && targetDist<=0.88`;升高但没进入目标格时写 `ascend.edge_miss`,后撤/居中/重试,失败计数会触发上层换向。
- **预测(可证伪)**: 下一次 MAROONED 低食物行军不应长时间压住 mission;挪出 10 格左右应见 `MAROONED release` 并恢复 `prepNether/feedUp/mission`。下一次上坡卡台阶边缘时,不应再出现 `ok=true,targetDist>1`;应记录 `ascend.edge_miss` 或 `ascend.failed`,随后重试或 `pinned-stair rotate after ascend fail`。
- **观测**: 🟡 `node --check src/agent/modes.js` 与 `node --check bots/_supervisor/skills/chopWood.js` 通过。00:24 agent-only reload 成功: 只停止监听 `48909` 的 node PID,watchdog 重新拉起 `node main.js`;MC LAN PID 保持不变。新进程 `fresh_status=live`,端口全开,`mine_motion.jsonl` 写入新 `audit.installed`。当前仍处夜间 bunker hold,尚未触发新 MAROONED/上坡现场;已更新 `mc-agent-monitor-loop` 每分钟盯 `MAROONED release` 与 `ascend.edge_miss`。
- **回滚**: 删除 `_maroonedMarchOrigin/_foodTight/_maxSeg/releaseDist` 相关逻辑,恢复 MAROONED 每 burst 6 段且只按 `_marchFails` 旋转;`_ascendStep` 成功条件恢复 `rose && targetDist<=1.1`,删除 `ascend.edge_miss` 记录。

## C87. 低食物单蜘蛛锁的静态武器修复（③层,现场验证中）
- **触发**: C86 reload 后 live 显示 bot `food=7 hp=14 skill=missionNether`,附近蜘蛛约5格;`feedUp` 因 `hostile=true` 反复 guard stop,而此前夜间 `prepNether: NIGHT static weapon check ...` 后 agent.log 出现 `Crafting crafting_table needs a reachable crafting table` / `Crafting wooden_sword needs`,导致白天仍无剑、无食物、无移动。
- **机理**: `nightBunkerStaticWeapon()` 用一次性的旧库存快照推进 planks/table/stick/sword 链路,合成 planks 后没有刷新;planks/stick 还把“期望产物数”误当 `bot.craft` 次数传入。若 table 没真正放到可达范围,后续 sword local craft 必然失败。且该补装只在夜间/黎明等待里触发,白天低食物+单蜘蛛锁没有入口。
- **改动**: `nightBunkerStaticWeapon(opts)` 改为每步刷新库存;planks/stick 用单次合成;若身上有 table 但4格内不可达,先 `placeBlockNearby(crafting_table)`;优先做 `stone_sword`,否则 `wooden_sword`,成功后立即 equip。新增 `allowDaySingleSpider` 只允许白天、单只 spider、hp≥12 的静态补装;在 dawn lingering-mob 与主/中途 goal 的 `food<=8 && no edible && hostilesNear(10)>0` 前置点调用。现场发现 `recipesFor(crafting_table)` 长期 empty 后,再加 `recipesAll + recipe.delta` 的直接合成 fallback,绕开坏索引。第二个现场反例是 `oak_planks=1` 会让旧判断误以为已有 planks;现在改为最大同类 plank 堆叠不足4就继续 log→planks。
- **预测(可证伪)**: 下次 `food<=8`、无食物、白天近单蜘蛛且有 log/planks+cobble/stick 时,progress 应出现 `low-food hostile-lock static weapon check` 后接 `static stone_sword/wooden_sword crafted/equipped`;随后 `feedUp` 不应因 unarmed spider 永久停止。若附近不是单蜘蛛/夜间群怪,不得冒险制作,仍应 hold/evac。
- **观测**: 🟡 `node --check bots/_supervisor/skills/prepNether.js` 通过。16:37-16:40 旧函数栈已反复触发 `NIGHT static weapon check`,但未 craft sword;因此追加 direct fallback。16:45 新栈仍在 `planksEq=29 table=0` 卡住,库存显示 `oak_planks=1/oak_log=7`,于是补上 `maxPlankStack<4` 条件。等待下一次 `prepNether` 调用现场验证。
- **回滚**: `nightBunkerStaticWeapon` 恢复无 opts/无刷新/只夜间逻辑;删除 dawn 与 `lowFoodHostileStaticWeapon()` 三处调用。

## C88. 白天被动蜘蛛不再锁死低食物觅食（③层,现场验证中）
- **触发**: C87 成功后,16:47 `DAWN lingering-mob static stone_sword crafted/equipped count=1`;但随后 `food=3 hp=10 stone_sword=1`,普通 spider 在9-13格外仍让 `feedUp: guard stop night=false hostile=true` 和 `prepNether: dawn-exit hold` 反复触发。期间 bot 已在本地扫 oak leaves,但被同一只远距离白天 spider 继续卡住。
- **机理**: `hostileNear()` 把所有 spider 都当即时威胁;白天普通 spider 在 Minecraft 中通常不主动攻击,且 >6格、已有剑、hp≥9 时,把它视为硬敌对会造成保护互绞: 不觅食、不出坑、不继续本地苹果方案。Creeper/cave_spider/夜间 spider 不能豁免。
- **改动**: `feedUp.hostileNear()` 对 `^spider$` 加被动豁免: 白天、距离>6、hp≥9、已有 stone_sword 时不算 guard hostile。`prepNether` 的 dawn-exit hold 改用 `dawnLingeringHostiles()`,同样排除白天>6格且已有剑的普通 spider,但仍等待 creeper/cave_spider/近身 spider/其它敌对。
- **预测(可证伪)**: 当前/下一次 food≤4、hp≈10、stone_sword=1、白天普通 spider>6格时,feedUp 不应再立即 `guard stop hostile=true`;应继续本地 leaf sweep/near drop pickup/targeted oak 或短距食物行动。若 spider≤6、夜间、cave_spider 或 creeper 在10格内,仍必须 hold/evac。
- **观测**: 🟡 `node --check bots/_supervisor/skills/feedUp.js` 与 `node --check bots/_supervisor/skills/prepNether.js` 通过。等待热加载后现场验证。
- **回滚**: 恢复 `feedUp.hostileNear()` 原谓词;删除 `prepNether.dawnLingeringHostiles()` 并让 dawn loop 重新使用 `hostilesNear(10)`。

## C89. 苹果方案优先靠近叶子而不是最近原木（③层,待验证）
- **触发**: C88 后 `feedUp` 不再被白天远蜘蛛卡住,但在 food3/hp10 时日志显示 `targeted oak forage oak_log@4 dy=1`,随后原地 `local chop/sweep`;`appleLeafSweep` 找不到4.5格内叶子,`chopWood` 又因 `LOW-FOOD BAIL food=3` 拒绝砍树。与此同时 scan 明确有 `oakLeaf16=oak_leaves@8`。
- **机理**: `targetedOakAppleForage()` 在 `oak_leaves/dark_oak_leaves/oak_log/dark_oak_log` 中选最近方块,近处 log 会压过稍远的 leaves。但苹果来自叶子;food≤4 时原地砍 log 既烧时间又不会立刻掉苹果,还会被 chopWood 的低食物门挡住。
- **改动**: `criticalOakAppleForage()` 与 `targetedOakAppleForage()` 改为优先选择最近 oak/dark_oak leaves;只有完全找不到叶子时才退到 log。这样 food3 且 leaves@8 时会先安全靠近叶子,再 leaf sweep,而不是对 log 原地空转。
- **预测(可证伪)**: 下一次 scan 有 `oakLeaf16/oak_leaves@<=18` 时,progress 的 targeted/critical oak forage 应写 `oak_leaves@...`,而不是更近的 `oak_log@...`;若靠近成功,应接 `PlanD leaf sweep`。无叶子时仍可退到 log。
- **观测**: 🟡 `node --check bots/_supervisor/skills/feedUp.js` 通过。等待下一次 feedUp hot-load 验证。
- **回滚**: 两个 oak forage 函数恢复单轮 `['oak_leaves','dark_oak_leaves','oak_log','dark_oak_log']` 最近目标选择。

## C90. food≤2 PlanD 不再先调用必败 chopWood（③层,待验证）
- **触发**: C89 验证成功后,16:54 `targeted oak forage oak_leaves@8` 接 `PlanD leaf sweep — breaking up to 40 oak leaves`,但没掉苹果;随后 food=2 时 PlanD 回到 `try one oak chop`,而 `chopWood LOW-FOOD BAIL food=2` 必然拒绝,形成低食物空转。
- **机理**: PlanD 的动作顺序是先 chopWood、再 leaf sweep;但 food≤2 时砍树不是立刻食品动作,且被 chopWood 自身保护门拦住。真正低成本动作应是继续扫可达叶子/捡掉落,没有苹果就停止,不应再请求砍树。
- **改动**: PlanD 改为 `leaf sweep first`: 先 `appleLeafSweep(48,{stopFood:10})` 和 pickup/eat;若仍 `food<=2 && no edible`,记录 `PlanD skip oak chop at calorie floor` 并跳过 chopWood。只有 food 已脱离极限或有食物时才允许后续单次 oak chop。
- **预测(可证伪)**: 下一次 food≤2 且无食物时,不得再出现 `PlanD apple forage — try one oak chop` 后接 `chopWood LOW-FOOD BAIL`;应先出现 `leaf sweep first`,若无苹果则 `skip oak chop at calorie floor` 再 calorie-floor stop/等待下一轮。
- **观测**: 🟡 `node --check bots/_supervisor/skills/feedUp.js` 通过。等待下一次 feedUp hot-load 验证。
- **回滚**: 恢复 PlanD 先 `skills.customSkill(bot,'chopWood',...)`,再 `appleLeafSweep(32)` 的旧顺序。

## 待修队列
- **enderman 视线豁免**(死276根因,已二次): 行军/凿崖 lookAt 扫过 enderman 脸=激怒。修: lookAt 前查路径上 enderman,目标点压低绕开头部。①层,下个重启窗
- **tool_keeper 备镐失灵**(16:40): 木镐磨尽无备——根因=木材buffer没囤够就开挖矿(#21 资源节奏)
- **食物死结结构性方案**(死276-279共同背景): 两片区域均无动物,feedUp 持续空手。候选: 钓鱼(需2线=蜘蛛掉落)/种地(慢)/腐肉依赖(PlanC)。待评估

---

---

## 待归因观察队列（每拍核对）
- C4 EVAC: 下次重生被围时是否触发+撤离成功？
- C6 tool_keeper: 下个长挖掘是否出现 "crafting a spare"？
- C8/C9 食物链: food 曲线是否不再触底？
- C10 贴脸拔剑: 下次单怪贴脸是否反击？（同时警惕副作用：贴脸反击是否在错误场景触发,如该逃的残血群殴前哨战）
- 雷区死亡向量（259/261/263 已3次,路径各异）: 若再发生"digToSurface/过境进雷区芯"死亡 → 升级为结构性修复（爬升起点位移出雷区 / 远征搬家）
- C12 reflex_watchdog: 下次"挨打+静止"是否10s内见 force release？副作用警戒: 正当蹲坑/贴脸开打场景是否被误释放？
- 死264归因注记: 游泳本能(第4轮C系)本身无罪——录像证明分支逻辑没机会运行,根因是 execute 挂起锁(C12 的靶)。游泳本能条目不动。

