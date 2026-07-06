# Spec: 开局模板硬化 (#7) — 设计 + 7机制代码核查 + 待定决策

用户 2026-07-06 session#5 指令。目标: 进世界强制走完 木→台→石镐→**床(睡=锚)→口粮 buffer**→再放开下矿/远征。杜绝"无床下矿→镐断→挨饿→暴毙→重生回出生点"的死亡循环(session#5 实录 deaths 1-7 全此模式: 僵尸/窒息/溺水/骷髅环境死, 无一是敌人强、全是无基地远游被环境收割)。

**核查方法**: 7 机制各一 agent 对最新代码只读审计(workflow wf_ea60d126, 7 agents)。以下"现状"均带 file:line。

## ⛔ 头号约束: 无 RCON → 1024 找村庄不可行
session#5 连用户自开 LAN 世界 55916, **无 RCON**(oracle-daemon /locate 已停用, watchdog.ps1:195 注释)。村庄情报**唯一源**=C328 landmark 本地扫描(modes.js:5695-5697, bell 方块/村民实体, 仅 **48 格**)。**bot 无法知道 48 格外有没有村庄** → 用户 spec 的"1024 内优先村庄"在无 RCON 下无法主动搜。
- ★矿情报例外: oracle-ores.json 是**离线 region 扫描**(ore-oracle.mjs, ±128b), **不依赖 RCON**, session#5 下仍新鲜(含 iron y46-64 浅带)。故"浅挖权衡/镐材料 oracle 化"不受影响。别把 oracle.json(村庄, 无)和 oracle-ores.json(矿, 有)混。

## 7 机制核查 + 设计

### 1. 床锚生命周期 — PARTIAL, moderate
- ✅睡过标记(goBedSleep.js:220 / setBed.js:266 双写 bed.json+landmark)。
- ❌>512 清锚: 全库无 512 门(只有 BED_REACH_DIST=64 可达门 / modes.js/chopWood 的 60/80 缰绳)。新增: 距 bed.json 锚>512 时 unlink/归档(照抄 migrate.js:510 / agent.js:306 清锚写法)。
- ❌钻石远征前收床: prepNether goals(939)直接 iron→diamond 无收床; 反而有 own-infra ban 保护床不被挖(branchMine.js:94)。新增: 下潜钻带(DIAMOND_TARGET_Y=-54)前 findBlock(_bed)→collectBlock 挖回+临时豁免 ban。
- 🟡地底不强制回床: bedAffordable 的 (y>=50||床y<=y+8) 门(modes.js:5831)+deep-no-bed-climb 已实现夜间版, 但只夜间 GO_BED 用; (2)(3) 路径要加同款 y<50 门。
- ★风险: 清 bed.json **别连清 landmark**(断夜链 P0-2, world_model.js:1786); 收床后 bed.json 要同步清否则幽灵床拉回空地; spawn_pos.json 是清锚后回家兜底(agent.js:1123)。

### 2. farm 锚生命周期 — PARTIAL, easy
- 唯一距离门 wheatFarm.js:47 的 fd<250("够近才回"非"超远弃")。farmRipe 提案(world_model.js:709)无距离项, 永远派回收。
- 改: 提案层(709 + modes.js:6077 OPP dropDist 99999→512)加 farm 距离项; wheatFarm 巡回上界 250→512。清锚复用 modes.js:6037 condFor。
- ★风险: 清锚破坏性(farm.json 唯一坐标源), **建议软标记 farm.abandoned=true 而非直接 unlink**(避免夜里瞬时逃远>512 误删永久丢农场)。→ **[决策4]**

### 3. 直线挖矿(branchMine)远征门 — ABSENT, moderate
- branchMine 零远征门, 6 派发点(achieve×2/mineDown×2/mineOres/mineDiamonds/escapePlan/setupEndPortal)无条件调。
- "64面包+床+3铁镐"不变量: 64面包有雏形(dynamicBreadTarget world_model.js:1762)、床有 bedKnown(1781), **3铁镐判据全库不存在**(只判镐档 canMineOreWith 1755, 不判数量)。
- ★关键歧义: branchMine 既是"远征直线掘进"**也是** mineDown/mineDiamonds 采空后"带内刷暴露面"子例程。门只加"远征性派发"(achieve lateralInstead 长隧道+proposer 首次下矿), **不加 branchMine 本体**(会误伤带内采矿)。→ **[决策2]**
- ★首矿悖论: 门要 3 铁镐, 但造铁镐要先采铁 → bootstrap 采铁阶段(尚无 iron_pickaxe)必须豁免门, 否则死锁。
- 建议: world_model.js 加 expeditionReady(bot,w)=bread>=64 && bedKnown && iron_pickaxe>=3 纯函数, 挂 kit 契约。

### 4. oracle 村庄找床/占床/收作物 — PARTIAL, moderate
- ✅收作物: villageHarvest 已收全4种(wheat/carrot/potato/beetroot), 只回种收下的种子(符合"所有作物收/只种小麦")。
- ❌占床/攻击村民: goBedSleep 床被占就 bail。新增: 睡前检测床被村民占→attackNearest('villager',true)清场→再 sleep(attackNearest 现成)。★铁傀儡会因攻村民敌对, 与 hostileNearBed 门冲突需协调。
- ❌1024范围/❌缓存: 全链 32b, village landmark 永久持久(已积 554 条含 y21 bogus)。**无 RCON 下 1024 不可满足**(见头号约束)。→ **[决策1]**

### 5. 羊毛/床回退链 — PARTIAL, hard
- 现状是扁平"直接猎羊造床"(setBed.js:112, 猎羊范围硬编 64/12), spec 的"村庄床优先→512找羊→放弃"三态分档链不存在。
- 用户明确: **羊毛非必须、床必须**。链: 1024村庄床(无RCON不可主动搜)→512找羊→都无才暂放弃(setBed:231 软 defer 是唯一现有降级)。
- ★无 RCON 下"1024村庄床"实际=被动等走进48b, 需 [决策1] 定: 降级为"路过48b可见即占"还是恢复 RCON。
- ★风险: 512 找羊拉长白天窗口; 远征猎羊低血被怪收割(deaths 218/222); 村庄床要落 bed.json 否则 GET_BED 恒提案。

### 6. 每晚必睡成本权衡 — ABSENT, moderate
- computeNightPlan(modes.js:5841)无"床远→浅挖"分支: 床>64→bedAffordable=false→落 DIG_ONE_CAP/SEAL_FORT 就地封洞, 从不改挖。canMineWholeNight 不看床距离; oracleOres 从不进"挖 vs 睡"决策。
- 新增: computeNightPlan 里 bed.dist>阈值 时, 读 oracleOres(≠RCON, 可用)判附近浅矿(iron y46-64), 有则改判"浅挖近矿"而非纯庇护。★浅挖 targetY 别落 y12 深带(那是 MINE_THROUGH_NIGHT); 复用现有安全门(food/cobble/hp)。

### 7. 分层镐经济 — ABSENT, hard
- 现状全 tier 恒定"总镐>=3(石/木)"(REPLENISH_PICKS_MIN=3 死数, world_model.js:96; replenishKit.js 硬编 picks()>=3 只造石/木)。
- 用户 spec: 铁前石镐>=2; 铁后石镐1+铁镐囤3+铁镐总耐久<1把(250)才补; 备镐 oracle 找材料。
- 与 memory spec-pickaxe-stockpile-redesign.md 高度一致但**数字出入**(那份=铁阶段4铁镐, 本次=3铁镐+1石镐)。→ **[决策3]** 以本次为准。spec-pickaxe 确认全未落地。
- 改: hasIronTierPick(w) 切换囤镐目标(石阶=3石 / 铁阶=1石+3铁); 三处口径同步改(提案门653/isGoalDone1365/replenishKit.js:85,263,284,346); 耐久判据复用 pickRunway(skills.js:4788)按品级分桶 sumUsesLeft。★石镐目标别降到0(孤镐护航闸下限 mineDiamonds.js:43); 造铁镐的铁计入 ironDemandTotal 否则甲镐互抢。

## 🔲 待定决策 (TBD, 等用户定)
- **[决策1] 无 RCON 的 1024 村庄** — A(降级"路过48b可见即占"+512找羊, 我推的备选) / B(恢复 RCON→真1024定位, 杀龙定要塞也需要, **我首推**) / C(放弃村庄床只走羊毛)。
- **[决策2] branchMine 双语义** — 确认远征门只加"远征性派发"+bootstrap 首采铁豁免(避免误伤带内采矿/死锁)。
- **[决策3] 镐数字** — 铁后 3铁镐+1石镐(本次) vs 4铁镐(旧 spec)。
- **[决策4] farm 清锚** — 软标记 abandoned(我推) vs 直接删。

## 核心设计: openingComplete 门
新增 `openingComplete(w,bot)` = 现有 isBootstrapDone(石镐+木, world_model.js:1330) **+ 床锚(bed.json 睡过) + 口粮 buffer(携带可食用>=8件)**。overworld && !openingComplete 时: 压制 GO_UNDERGROUND@45/GET_DIAMOND@46/GET_IRON_* 到 opening 之下; 抬升 缺的那块(镐/台>床>口粮)。survurviveNow/self_preservation 永远最高。完成一次永久放开(keepInv 下 bootstrap 跨死存活)。
- ★要替换现有 preIronDescend@44(world_model.js:736)那段"先下矿延后床"逻辑——它是反向假设, 正是 7 次死亡的机制根。
- 甲不进 opening(循环依赖: 造甲需先采铁); 甲属铁科技段 GET_IRON_ARMOR_SET, opening 门开后才凑。

## 建议实现顺序(决策定后)
farm锚(easy) → 床锚512/收床/地底门(moderate) → 每晚必睡浅挖(moderate) → openingComplete门(核心) → 直线挖矿远征门(moderate) → 分层镐经济(hard) → 村庄/羊毛床链(hard, 取决于[决策1])。

## 关联
- 行为 bug 台账: review-2026-07-06-behavior-bugs.md (#1-6+8 已修 + #9 求死披甲失效已修)。
- 镐经济旧 spec: memory/spec-pickaxe-stockpile-redesign.md (未落地, 数字以本 spec [决策3] 为准)。
