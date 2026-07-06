# Review 2026-07-06 — 用户肉眼实观行为 bug 诊断台账（session#5, 55916 世界）

用户接手 55916 世界值守后连续肉眼上报 7 个行为异常。每个都经"定位根因(运行时日志核实)→修复方案+同款全库排查→**对抗验证**"三段（3 个并行工作流, 15 agents, ~1.08M subagent tokens）。**关键: 对抗验证把 6 个初诊里的 3 个推翻了——朴素修法是死代码或脱靶。修复前务必以本表的"真根因"为准, 别照初版方案改。**

红线: 全程只读诊断, 未改任何代码。

## 难度表（难度=对抗验证后终值）

| # | 现象 | 真根因(核实) | 难度 | 初诊 |
|---|------|------------|------|------|
| 2 | 穿墙挖树 | direct-chop 裸 `bot.dig` 绕过 C339 视线闸 | easy | ✅确认 |
| 5 | 垫脚用木板 | chopWood 填料 `.find()` 含 `_planks` 无贱料优先 | easy | ✅确认 |
| 3 | 工作台不收 | reuse 门 pocket 拒近台+无收台步; prepNether 3 处放台不登记 | moderate | ⚠确认但范围要扩 |
| 4 | 乱放木板 | digOneCapOne 封顶料 fallback 选 spruce_planks | moderate | ❌初诊推翻 |
| 1 | 坑里跳不出 | probe 只看 y0/y1 分不清 2 格墙唇; edge_unstick 未接管 | hard | ❌初诊推翻 |
| 6 | 砍木换手抖动 | **pathfinder unstick 时 `bot.stopDigging()` 打断** dig | hard | ❌初诊推翻 |
| 7 | 地底空转/smeltSafe | 无炉+窄坑建站失败→pathfinder 随机脱困; 过早下矿 | moderate | 现场诊断 |

## 逐条

### #2 穿墙挖树 — easy ✅确认
- **真根因**: chopWood 的贴脸直砍(direct-chop)分支用裸 `bot.dig(lb)`（[chopWood.js:1998](skills/chopWood.js)）, 绕开只在 `guardedDig` 里生效的 C339 视线闸（chopWood.js:174-183）。唯一准入是距离 ≤4.5b, 不查 `canSeeBlock` → mineflayer bot.dig 在臂展内不校验中间墙 → 隔掩体墙挖穿外面 3.7b 的树。运行时铁证 `xray_skip`=0。
- **修**: direct-chop 入口补 C339 同参视线闸(`d>2.2 && !canSeeBlock → 不直砍`); 循环内裸 dig 改走 `guardedDig`。~18 行。
- **验证官纠正**: 初版"第 3 层 sealed 硬否决"对本实录是空护栏(砍树那刻 mobility 已翻回 FREE/enclosed=false)。真正生效的是入口视线闸。
- **同款必扫**: funnel-dig [chopWood.js:988](skills/chopWood.js)、[feedUp.js:971](skills/feedUp.js) 都是对 log 的裸 dig, 同能穿墙。

### #5 垫脚用木板 — easy ✅确认
- **真根因**: chopWood 三处填料选材 `bot.inventory.items().find(/…|_planks$|_log$/)`（732 surf-stair、1488 LEASH-stair、1519 LEASH-pillar）把木板/原木纳入填料且 `.find()` 按槽位序取首个命中, 无"贱料(dirt/cobble)优先"。木板槽位靠前就用木板。+ 第 4 副本 [modes.js:4536/4641](../../src/agent/modes.js)(MAROONED 架桥)。
- **修**: 改成全库既有正确范式(skills.js:2016 / modes.js:1691 的两段式)——有序贱料数组优先, `_planks/_log` 仅末位回退(**不能删木料回退**: coffin 无土石时唯有木板可垫脱困)。
- **验证官补**: modes.js:25 FILL_RE(creeperInterpose 1012 + 裸重生 bunker 1188)是同类, 与 #4 同域, 建议一并。

### #3 工作台不收 — moderate ⚠范围要扩
- **真根因**: (1) achieve reuse 门 [achieve.js:448](skills/achieve.js) `(!pocket && d<=12)||mustReuseTable` 因 pocket=true 拒了 10b 外已登记台→就地新造第二张(progress.txt:2136 实锤); (2) craft flow(710-728)放台+craft+return 无收台步。收台路径只有 pre-craft 4 格清理(212-231)和 prepNether 8 格顺手收(2666-2679), 下潜即出界。
- **验证官加**: **诊断枚举不全**——prepNether 还有 3 处 `placeBlockNearby('crafting_table')` 就地放台后立即 craft: [prepNether.js:246/2564/2636](skills/prepNether.js), 既不登记也不收。类修复必须覆盖全 5 处。craftChain.js:87-100 也是独立乱扔源。
- **修**: craft 后收本轮就地放的台(仅本地放置分支收, reuse-walk 分支不收——旗要精确穿过 placeTable 多出口); reuse 门放宽 pocket(近台照走); 全 5 处放台点统一登记+收台。

### #4 乱放木板 — moderate ❌初诊推翻
- **初诊(错)**: 归到 modes.js FILL_RE + bunkerDown fillerOf。
- **对抗验证推翻**: 运行时 `skill="nightShelter"` 才是放板者, 经 `skills.customSkill` 加载 [nightShelter.js](skills/nightShelter.js); modes.js 里 nightShelter 只在注释出现, bunkerDown 从没执行。**真凶=skills.js `digOneCapOne()` 封顶料 fallback（~4330-4335）**: `_CAP_PREFS`(4324)无木料除 oak_planks, bot 持 spruce_planks 不命中→fallback"任意非重力固体"选中 spruce_planks 当顶盖; 平地 cap 悬空、邻格放置失败→散落几块木板。初版 modes.js 改动对此路径**完全无效**。
- **修**: `digOneCapOne` 封顶料 fallback 排除 `_planks/_log/_wood`(或平地/无侧撑时不放 cap); 和/或 nightShelter 在平地唯木料时拒 dig_one。注意 digOneCapOne 被所有 dig-in 调用方共用, 别误伤裸重生封顶。

### #1 坑里跳不出 — hard ❌初诊推翻
- **现象实锤**: act_trace 03:27:14-22 钉 [-53.7,72,-7.7] ~8s, `ctrl=forward,jump,sprint`, 零位移, path:0, edgeStall 6.1s, 最后被僵尸打死。self_preservation 的 "Kiting the swarm" 整夜逃怪把 bot 甩进 2 格高墙唇。
- **初诊(错)**: 归到 `_found=false` 逼角, 提议在该分支加垫柱跳。
- **对抗验证推翻**: act_trace 全程 `dig:'-'` 从没挖过, 而现有凿墙兜底门控在 `!_found && hasPick`——它带镐没触发凿墙 ⇒ **`_found` 实为 true**(运动爬升, 扇形一直找到前向, 只是 jump=1 格翻不过 2 格墙唇)。提议的垫柱跳与凿墙共用同一 `!_found` 闸 ⇒ **死代码**。
- **真修点**: probe(851-857)只探 y0/y1 两层, 分不清"1 格台阶"vs"2 格墙唇", 把 2 格唇误判成能跳的 1 格。修在 `needJump` 的 2 格高差识别, 不在 `_found=false` 兜底。且漏了现役 `always:true` 的 `edge_unstick`(modes.js:5168, 专治顶台阶楔死)——须先查清它为何没接管, 否则新叠逻辑与它抢控制键互搏。
- **难度 hard**: 触及 probe 高差识别 + edge_unstick 失效诊断 + kite 循环整夜霸占身体饿死 mobility 脱困反射的仲裁互锁(1407-1412 与 122-123 自证)。孪生逃怪路径 creeper kite(modes.js:2320-2374)同款须同修。

### #6 砍木换手抖动 — hard ❌初诊推翻
- **现象实锤**: spruce_log dig 46/46 中 10 次 `'Digging aborted'`(22%), 全在 88-99% 完成度(2686-2977ms vs 满 ~3001ms)被杀从零重来; 手持在 11 种杂物间循环。
- **初诊(错)**: 归到 equip 互斥闸只保护石头 dig + equipForBlock 等时 tie-break。提议扩 equip 闸到 activeAnyDig + 徒手兜底。
- **对抗验证推翻**: 逐事件解出 10/10 abort 与 pathfinder `path.phase.stuck/unstick/end` <300ms 同刻; **真正打断者=mineflayer-pathfinder unstick/replan 时直接调 `bot.stopDigging()`（node_modules/mineflayer-pathfinder/index.js:134）**, 不经 modes.js 包装的 bot.dig/equip → 扩 equip 闸拦不住。equip.deferred 里 wood-activeDig=0、equip.blocked=0(modes 闸对木头从没触发)。循环换手也非 tie-break(Tool.js:91-98 严格 `<` 比较, 实测六连挖 held 恒定), 而是 pathfinder 装自己开路要的工具(index.js:520)。徒手兜底下一拍被 pathfinder 换回。
- **真修点**: pathfinder 移动/unstick 与 collectBlock in-flight dig 的身体互斥(把 pathfinder 纳入 `_bodyDigLock` / dig 在飞时暂停 pathfinder monitor), 或不可达树及早 blacklist 停止原地反复 unstick。

### #7 地底空转/smeltSafe 循环 — moderate（现场诊断）
- **现象**: y31 窄矿坑里"原地小跳+来回跑"+"狂挖花岗岩/安山岩"。
- **根因**: kernel 派 NIGHT_SMELT_IRON→smeltSafe, 但 (a)无熔炉(`Don't have any furnace to place` ×几十, 有 89 圆石却不合成); (b)`Refusing to place crafting_table: target intersects bot body`(坑太窄); (c)寻路到建站点全失败(`trapped`)→**pathfinder 内置随机脱困=跳一下+moveAway 两点来回**(即小跳+来回跑)。狂挖花岗岩=mineDown 井壁材料 + smeltSafe 想腾地方。
- **战略根**: bot 跳过地表 bootstrap(炉+床+口粮)就下矿→挖 18 生铁炼不了+镐断(picks 0/3)+挨饿(food 5→死)→上浮被僵尸杀重置。**违背开局公式硬化指令**。deaths 1→2 均此模式。
- **修**: (机械)smeltSafe 建站前先合成熔炉+不在窄坑建站(上浮/开阔格); (战略, 最高杠杆)提案层强制 bootstrap 门——无床/无炉/无备镐/无口粮缓冲前不许下矿远征。

## 三条贯穿性根源（比单个 bug 更高杠杆）
1. **pathfinder 对"不可达目标"的原地 unstick 反射** = #1 / #6 / #7 的共同真凶。跳、来回跑、换手、`stopDigging` 打断都是它 unstick 副作用。修它同缓三症。
2. **"木料当填料"类缺陷（~6 副本）** = #4 / #5 + creeperInterpose(modes:1012) + 裸重生 bunker(modes:1188) + digOneCapOne(skills:4330)。同模式: 木板入填料集且无贱料优先。
3. **过早下矿 / 开局公式失效** = #7 + 炼不了的铁 + 挨饿死循环。策略层, 可能最该先治。

## 建议批次
- **A 批(easy, 低风险, 可立即)**: #2 + #5。干净、已验证、回归面窄。
- **B 批(moderate)**: #3 + #4（#4/#5 同"木料填料"域, 可合并收敛)。
- **C 批(hard, 需重新设计)**: #1 + #6（共享 pathfinder-unstick 根, 一起设计)。
- **策略批**: #7 / 开局公式硬化门——止住重置循环的根。

## 工件
- 三工作流原始输出(结构化, 每问题 inv/fix/verdict 全文): session 临时目录 tasks/w8e9ulqgf.output、wf2m2nobe.output、wn03rta9e.output。
