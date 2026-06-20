# Neko 改动台账（科学家模式）

> 接管者从这里开始：交接书 [docs/HANDOFF.md](../../docs/HANDOFF.md)，架构图谱 [docs/agent-architecture.md](../../docs/agent-architecture.md)。

每条改动 = 一个实验：**触发证据 → 机理假设 → 改动 → 可观测预测 → 观测/归因**。
纪律：每次死亡/异常复盘时翻此表，把证据回写到相关条目的"观测"字段；预测落空的条目要么修正要么回滚。
状态：⏳待生效(等重启窗) / 🟡已生效待观测 / ✅已验证 / ⚠️部分有效 / ❌已回滚

更早改动（第1-55轮）见 memory/mc-agent-supervision.md 与 git history。本表从 2026-06-11 当班起记。

---

## C278. ★★S4.1 承诺计划逻辑(治 #1决策慢/不commit + #3木囤量 + #5食物囤量)（framework world_model.js+kernel.js,✅9项逻辑单测;in-game待 S4.3 suppress钩子+driven验收）
- **触发(用户 9 条观测 A 类 + C276 commit 病根定位)**: missionNether 有食物时不 commit、被 feedUp/漫游拽走(#1);木材砍2个就停(#3);不囤肉(#5)。治本=框架 propose→commit→suppress 取代食物 gate 泥潭。
- **改动(纯逻辑,影子安全)**: world_model.js 加 ①囤量常量(WOOD_BUFFER=8 plank当量/FOOD_STOCK=16)+库存助手 woodUnits;②**完成判据**: isBootstrapDone=镐≥1&&石器&&木囤≥8(不在2个log算完,#3),GET_FOOD done=food≥16(#5),isGoalDone(kind)逐类;③**commitGoal 粘性选择器**: 维护 bot._commitment 跨tick,选定目标**死守到真完成**,只有 emergency(food≤4/低血威胁/死亡区)才抢占——扫全部proposal不只top(food=4的GET_FOOD@88在BOOTSTRAP@90之下也能抢占)。kernel decide 改走 commitGoal。
- **预测(可证伪)**: ✅逻辑层: 食物中等(8)死守BOOTSTRAP不被拽走、危急(4)抢占GET_FOOD、补回继续bootstrap、囤够才move on——9/9单测过。**🟡 in-game 待验**: commitGoal 只让 kernel 决策粘住,但**skill 内部(prepNether/feedUp)仍可能自行让步**→需 S4.3 suppress 钩子(committed BOOTSTRAP 时 feedUp/forage 读 bot._commitment 让步,除非food危急)+ kernel 真 live 驱动。若只有 commitGoal 不接 suppress,bot 仍会被 skill 内部 feedUp 拽走(下一层 gate,C276 预言)。
- **关联**: docs/framework-v2-plan.md S4。纯逻辑单测≠游戏内验收([[validation-not-mock]]),in-game 在 S4.3+driven 验。下一步 S4.3(suppress机制)+S4.2(LLM拍板)。[[decision-speed-keepinventory]]。

---

## C277. ★★sealBunker 重写 + 首个游戏内真·验收(用户#7封顶把自己关外面 + #8验收纪律)（framework/tools/bunker.js,✅dev-trigger游戏内三信号一致验收cap路径）
- **触发(用户 #7 肉眼观测 + #8 纪律)**: 用户看 live 报"晚上不挖三填一,封顶时跑到外面围着建筑盖→人在外面没庇护"。且 #8: "你实现的功能你自己没法好好评估,需想办法验收,做不到请人工帮,给手动触发钩子让我检查"。
- **★根因(两层,V3 round1 实测挖出)**: ①`skills.placeBlock` 目标太近(<1.1)时 `GoalInvert` 把 bot 往外推腾放置空间(skills.js:1490)→封自己周围时所有目标都<1.1→bot 被推出圈=#7。②换成 `bot.placeBlock(ref,face)`(只转身不寻路)后 round1 仍失败: a) **mineflayer modes(unstuck等)在 tool 执行中把 bot 拽出坑**(JS tool-lane 挡不住底层 modes,见 [[mineflayer-layer-primitives]]); b) **只挖1-2格→cap 那格落在地表/空气层无可贴实心面**→贴到旁边树干飘头顶。
- **改动(framework/tools/bunker.js 重写)**: ①**mode-guard**(暂停 unstuck/item_collecting/followers)+**pin**(pathfinder.stop+clearControlStates,挖前挖后放前都 pin)防 bot 被拽走;②**挖三填一=向下挖3格**(用户纠正:脚 Y-3 头 Y-2,cap=头顶=Y-1 在地表下→四周原土实心有可贴面)→ digDown(1)×3 逐格 pin;③cap 用 `bot.placeBlock(ref,faceVec)` 转身放置不走位;④**诚实上报**: covered 读世界模型真实方块,不信工具自报(#8);⑤POCKET(已封闭凹处)脚下空洞时 digDown 测到会掉落→dig=0 只补顶(正确)。
- **★验收(游戏内真·验收,#8 工作法首次跑通)**: 建 dev-trigger(devTool.js 热加载 + dev_trigger.mjs WS 注入,main.js 无 bridge 跑→无 sticky 锁→run_skill 直派)。**round1 失败**(截图: bot 站草地只在头顶偏前贴树挂一块土,露天; 世界模型 coverReal=false 与工具自报 sealed=true **矛盾**→暴露假阳性,正是 #8 要防的)。**round2 通过**(jungle POCKET: dig=0+cap): 工具自报 cap=true/covered=true + 世界模型 **ENTOMBED/enclosed/coverReal=true/overhead=true** + **用户肉眼确认"成功了"** 三信号一致。
- **预测(可证伪)**: cap 路径已验。**dig-3 平地路径尚未 live 走到**(round2 是 POCKET cap-only,dig=0)→待平坦开阔地触发验"挖3+封顶+pin住不被拽走"。若平地 dig-3 后 bot 仍被 mode 拽出或 cap 偏→mode-guard 覆盖不全或 pin 不够频。
- **★方法论(写进 memory)**: [[validation-not-mock]](mock≠验收,三信号交叉,用户眼睛是真相)+[[mineflayer-layer-primitives]](modes vs tool 冲突须 mineflayer 层 resolve,地形原语下沉补丁)。dev-trigger 是 #8 的机制载体。
- **关联**: docs/framework-v2-plan.md §0 工作法 + V 阶段。下一步: 平地 dig-3 验收,然后 #9 SWIM/#2 沙土,再 S4。

---

## C276. ★★新世界 live 测试(shadow)——chopWood leash stale-reset 根因修复 + commit 病根精确定位（③chopWood 热加载✅live验证远征自救; missionNether commit seam 已定位待 S4 接管）
- **触发(用户开新世界 wooded_badlands 实地测框架 v2 shadow)**: 框架 flag=shadow(零行为变更,跑 live missionNether 老路 + kernel 旁路记决策)。新世界出生点 wooded_badlands 河谷,chopDBG `nearest=NONE total=0`(树在台地顶,谷里无可达树)。
- **★发现1(C275-fix leash 根因,✅live验证)**: `_treeDesert = _noWoodBootstrap && stale>=2` 中 `stale` 是**每次 chopWood 调用重置**的计数器。bot 跨调用漂到 90 格外时是新一轮调用(stale=0)→_treeDesert=false→_pullR=80→`LEASH 90格离锚硬回拉`,**永远够不到树荒外森林**。改:`_treeDesert = _noWoodBootstrap`(无木即放宽到 256,不依赖会重置的 stale;keepInventory 远征廉价=C269 原意)。**✅live 验证**: 部署后 bot 一路远征 300+ 格(spawn→badlands→desert→**forest**),在橡树林敲叶得苹果(food0→9)、猎羊(food→16),**自己走出了荒漠区**——leash 不再 80 格硬拉。
- **★发现2(commit 病根精确定位,#1 真根活体证据)**: bot 到了有树有羊的森林,却被 feedUp(猎羊/敲叶)/漫游拉走、**从不 commit 砍树**,森林↔沙漠↔海滩来回飘,~20min picks=0,最终沙漠夜死×2(keepInventory)。**seam 定位**: `★C273 BOOTSTRAP COMMIT`(missionNether.js:746)埋在 `if(lowFoodHold)`(:738)块内→bot **有食物时(food 10-16)lowFoodHold=null→整块跳过→commit 永不触发**(C273 台账自己预言的"scope局限待扩")。且 feedUp 在多处食物 gate(achieve LOW-FOOD gate/prepNether 内部让步)被抢占。**老路=层叠食物 gate 互锁泥潭,surgical 提取会牵出下一层(whack-a-mole)**。
- **预测(可证伪)**: ①(已验证)leash 修复后无木 bot 远征 >80 格不被硬拉,能到远处森林。②commit 病根的治本=框架 kernel 接管 sticky(S4):`proposeTasks→decide(commit BOOTSTRAP_KIT)→suppress feedUp/forage/roam 直到拿镐`,取代 missionNether 食物 gate 泥潭。若只在 missionNether 提取 C273 commit 而不接管,预测仍会被 prepNether 内部 feedUp 让步抢占(下一层 gate)。
- **观测**: ✅ shadow kernel 全程正确提议 BOOTSTRAP_KIT(proposer 验证)。✅ C275-fix leash 热加载 live 验证远征自救。✅ commit 病根 + seam 定位(missionNether:738/746)。⚠️ wooded_badlands 河谷 spawn 不理想(树不可达+河陷阱),未来 driven 测试建议 re-roll 到平坦可见树 spawn。🟡 S4 接管待建。
- **关联**: 这次 live 测试同时验证了"框架 shadow 能旁路诊断而不改行为"的价值。下一步 S4 = kernel 真驱动 + 承诺计划(取代 missionNether 决策泥潭,非再打补丁)。[[decision-speed-keepinventory]](commit 病根)[[agent-framework-v2]]。

---

## C275. ★★工具独占泳道层落地(S2)——MLG落地水/垫方块/封顶堡垒搬进不可中断互斥泳道 + 防岩浆判定器（新建 src/agent/framework/tools/*,✅node--check+10项mock单测全过,未接live调用零行为变更）
- **触发(框架 v2 迁移 S2,蓝图 §E/§F)**: 蓝图点名"很多固定动作(落地水/垫方块/瞬搭堡垒/翻地形)用脚本实现本应万无一失,现在却经常出问题"——根因=裸 async 被 reflex/interrupt_code 半路截断。§E.2 要 MLG 落地水写进"最高级 DNA"(脚本级触发+永远收水+防岩浆例外),§F 要独占线程+留余量。
- **改动(新建 framework/tools/ 五文件,各自获取泳道,调用方不管泳道)**: `lava_guard.js`(纯读谓词:safeToDigDown[DIG前置]/canClutchWater[MLG前置]/landingBelow,岩浆即拒,fail-safe)+ `survival_mlg.js`(clutchWater 在 **SURVIVAL_MLG lane prio100 抢占一切**:坠落检测→**防岩浆FIRST**→放水→落地settle→**永远收水**[equip water→activate,再 equip bucket→activate],generous 早arm/看下/宽settle)+ `bridging.js`(placeUnderFeet/pillarUp 在 LOCOMOTION lane,**generous 参数** jumpMs1100/settleMs280 vs 原900/180,容错优先)+ `bunker.js`(sealBunker 在 PLACEMENT lane,4向头环+顶,复用 skills.placeBlock 同 prepNether 块集)+ `index.js`(TOOL_CATALOG 自描述目录+triggers)。**不可中断**(lane 内不查 interrupt_code)+ 只被更高优先互斥泳道抢占(ctx.preempted() 协作 bail)。
- **预测(可证伪)**: ①工具层导入不改任何行为(未接 live 调用方,flag 关)。②S2b/S5 把坠落本能接上 clutchWater 后,live 中 bot 高空坠落应**脚本级放水救命且事后水被收回**(不再淹没工地),**岩浆上空不放水**(progress 出 `[mlg] no clutch: lava below`)。③挖矿前查 safeToDigDown,**不再挖穿进岩浆**。④垫方块 generous 后台阶/搭桥放置成功率升(更长 jump/settle)。若 live 落地水时机不对(放早/放晚没救到)→ARM/PLACE_WINDOW 阈值需对真服调(本条只验证控制流,时机待 live)。
- **观测**: ✅ `node --check` 5 文件全过。✅**mock-bot 10项单测全过**: 防岩浆(stone可挖/lava拒挖)、canClutchWater(stone可/lava拒)、clutchWater 岩浆上空**不放水且 activateItem 从不调用**、实地**放水且永远收水**(equip 序列 water→bucket)、无水桶优雅拒绝。🟡 in-game 放水时机待 live 调(诚实记录:mock 验控制流,真服验时机)。
- **★工程要点(写进规格书 §1 红线)**: "线程池"=单线程协作式互斥泳道,非 OS 线程;碰 bot 代码串行主循环。落地水 prio100 抢占 DIG/LOCOMOTION = 保命第一(冒烟已验 MLG 抢占运行中 DIG)。
- **关联**: docs/framework-v2-scaffold.md §5 互斥表 + §6 迁移 S2。复用 skills.placeBlockUnderFeet/placeBlock/pillarUp/activateItem 桶机理。下一步 S2b(把坠落本能/挖矿守卫接上这些工具,影子先行)或 S3(proposeTasks 拆解对照 missionNether)。[[agent-framework-v2]]。

---

## C274. ★★★框架 v2 骨架落地——四部分线程模型契约层 + survival proposer + 工具独占泳道（新建 src/agent/framework/*,✅node--check+冒烟全过,feature flag 默认关零行为变更）
- **触发(用户 2026-06-19 框架级重设计,亲定方向)**: 用户和 MC 老玩家商量后定的框架 v2(详 docs/agent-framework-v2.md):四部分线程模型(世界模型池/本能反射/工具独占线程/agent LLM 拍板)+ survival/companion 双模式。用户拍板:"**先重构框架,大框架搭好再完善各部分;后续子模块迭代可能和其他开发者协作**"——要清晰层间契约支持并行协作。
- **★关键工程判断(诚实映射,比蓝图设想微妙)**: ①**当前决策驱动根本不是 self-prompt 而是 missionNether 硬编码巨型状态机**——supervised 流程下 `ws_server.js:307` 已停掉 self-prompt,LLM 在生存里几乎不参与。所以"退役 self-prompt"几乎已发生,框架真正工作=**把 missionNether 单体硬决策拆成 world-model proposer + LLM judge**。②**"线程池"在 Node/mineflayer 不能是真 OS 线程**(bot 非线程安全,全走单 event loop)→落成**协作式互斥泳道**;只有纯计算(x-ray 扫矿/路径预规划,吃快照不碰 bot)才下放真 worker。这是骨架根本约定。
- **改动(新建 6 文件,与现有并存,flag 默认关)**: `src/agent/framework/` = contracts.js(零依赖类型/枚举单一真相源:World/Proposal/ToolSpec/LANE 互斥表)+ tool_lanes.js(ToolLaneManager 互斥泳道,**不可中断+只被更高优先互斥泳道抢占+留余量**,preempts/conflict-domain 表)+ world_model.js(getWorld 封装 bot._world + **proposeTasks 固定开局流程提议器**[blueprint §D]+ mentalState idle 检测 + 资源点登记/depleted + ingestScan 背景扫描[坐标不喂 LLM])+ instinct.js(反射契约+注册表,MODE_BACKED_REFLEXES 文档化现有 modes 别重建)+ kernel.js(Survival/Companion 模式控制器+决策循环,**取代 self_prompter 角色**,enabled 默认 false/shadow 默认 true)+ index.js(createFramework 工厂)。接进 agent.js update()(flag 关时 tick no-op)+ startEvents firstStart 构造。
- **预测(可证伪)**: ①flag 关闭时整栈行为与 C273 完全一致(missionNether 路径不受影响),world_model.json 照常 2s 刷新。②flag 开+shadow 时 progress 出 `[shadow] [kernel] commit BOOTSTRAP_KIT via prepNether`(无镐时)对照 missionNether 实际行为验证 proposer 一致。③MLG 落地水搬进 SURVIVAL_MLG lane 后,挖矿中触发落地水能 100% 抢占执行完(收水也在同 lane),不再被 interrupt 半路截断。若 proposer 与 missionNether 行为大幅背离→拆解粒度需调(S3 影子先验证)。
- **观测**: ✅ `node --check` 6 文件 + agent.js 全过。✅**冒烟测试端到端**: proposeTasks(无镐+食物5)正确排 `BOOTSTRAP_KIT@90→GET_FOOD@88→FREE_PLAY@1`(对症 #1 真根:先做完镐链别漫游);互斥表 MLG抢DIG✓/PLACEMENT不抢COMBAT✓/CRAFT不自抢✓;泳道抢占 clutch(MLG)抢占运行中DIG→dig协作bail→MLG完成。🟡 待 flag 开启 shadow 验证 proposer↔missionNether 一致性(下一步 S2/S3)。
- **★迁移路径(docs/framework-v2-scaffold.md §6,影子模式纪律)**: S1骨架(本条✅)→S2工具泳道先行(MLG/垫方块/封顶搬进 runExclusive,影子记日志验不误抢占)→S3 proposeTasks 拆解(对照 missionNether 影子验证)→S4 LLM 拍板回归(接 prompter,改 $SELF_PROMPT→$WORLD_MODEL+$PROPOSALS)→S5 模式切换+companion+退役 self_prompter→S6 全层收敛读 getWorld。每步 node--check+影子先行。
- **关联**: docs/framework-v2-scaffold.md(契约规格书,协作接口地基)+ docs/agent-framework-v2.md(总蓝图)+ docs/world-model.md(surfaceGate 门控,框架复用)。复用 C267(bot._world)/C263-273(具体修复)/modes 两段式调度/customSkill 热加载。[[agent-framework-v2]][[decision-speed-keepinventory]][[world-model-central-gate]]。

---

## C270. ★坡上树够不着——raw-approach 不会爬坡 + dy 门太窄,找到树却拉黑（③chopWood 热加载,🟡待验证）
- **触发(新世界 plains dawn1,C269 后暴露)**: C269 让 bot 远征到橡树区(`> stock wood buffer oak_log@7.9b`),但 `raw-approach: 6.8b after walk (was >4.5)` + `blacklist oak_log@13,82,-93 (unreachable,树柱fails)`——树在 y82-83、bot 在 y78-80(**小山坡 +3~4y**),够不到去砍,拉黑后又 nearest=NONE,广域漫游仍 0 木、裸甲夜死。
- **★根因(chopWood.js:1533/1552)**: 生走逼近 gate `Math.abs(dy)<=3` 且只 `forward+sprint` **不跳**→坡上树停 6.8b 关不上;direct-chop 要 ≤4.5b;defer-climb 要 ≥6y。**+3~5y 小坡树落在缝里**:raw-approach 够不着(不爬坡)、不够高触发 defer-climb → 被拉黑。bot 找到树却因"不会走上小坡"永远拿不到木。
- **改动(③chopWood,机理修复,热加载)**: ①gate `dy<=3`→`dy<=5`(覆盖小坡树);②raw-approach 树更高(dy>0.5)时**加 jump 边走边跳爬坡逼近**。人走向坡上的树=走+跳,别因导航否决放弃眼前的树。体现用户#1(果断执行)。
- **预测(可证伪)**: 下次够到 +1~5y 坡上树时,progress 应出 `raw-approach: <4.5b after walk (jump-climb)` 然后 `direct-chop: dug N logs`,**不再 6.8b 拉黑**;inv 出 _log。若仍 0 木: ①树隔着水(unsafe 探针挡住 raw-approach,需涉水逼近)②chopWood 被 food/夜 优先级打断没机会完成砍(→需承诺计划,世界模型 Phase4)。
- **观测**: ✅ `node --check` 通过+热加载。🟡 部署后夜降+food 低,bot 在 wood/food/夜hold 间被拉扯,待 dawn 较稳窗口验证拿木。
- **关联**: C269(远征找树)+C270(爬坡够树) 是新世界 wood-bootstrap 的两环;更深 blocker=bot 不 commit 把采木做到底(food/夜反复打断)=[[decision-speed-keepinventory]] 的承诺计划(世界模型 Phase4)。

## C273. ★★承诺计划增量(用户#1 决策太慢真根)——bootstrap 期间压住漫游、原地把早期 kit 做完（顶层missionNether,✅重启部署,⚠️scope偏窄待扩）
- **触发**: C269-272 修通微观能力后,bot 仍 wander/被打断不把 table→镐→剑做完(deaths 1-8)。
- **改动(missionNether lowFoodHold 块内,需重启)**: 无任何镐 + food>3 + 白天 + 无actionable威胁 → suppress forage/migrate/roam,`continue` 交回 prepNether 把 kit 做完(C271砍近木+C272过食物gate造具)。
- **观测**: ✅ `node --check`+重启部署(11:18)。⚠️**scope 局限**: 放在 lowFoodHold 块内→food 充足(如杀羊后 food18)时该块不执行→C273 不触发。**待扩**: bootstrap-commit 应不分食物水平、只要无镐就承诺做完 kit(下个 session)。
- **★关键澄清(完整 inv 取证)**: bot 的 oak_door:1/oak_stairs:1/white_wool:2 是**plains 村庄战利品**(grep 全码无造门/楼梯),**非 craft 浪费 planks**。planks=0 真因=**砍木→4planks→crafting_table 这条链一直没完成**(被 wander/水/re-target 打断,凑不齐4planks)。
- **★食物已解决(大胜)**: bot 杀羊得 mutton→food 0→18。**plains biome 是好的**,狩猎有效,告别旧世界食物荒漠。剩余 keystone blocker = wood→4planks→table→镐 链的可靠完成(需聚焦 live 调试: 抓 ≥4planks 时 table craft 是否真 recipesFor empty,还是纯 planks 没凑够)。
- **关联**: [[decision-speed-keepinventory]]。这是承诺计划的第一个增量,需扩 scope + 修 craft-chain 完成。

## C271+C272. ★★bootstrap 优先级倒置——饿危机/食物 gate 锁死近木的工具链（③prepNether+achieve 热加载,✅微观验证）
- **触发(新世界 churn 取证)**: bot hp1 next to oak_log@2 却锁在 feedUp(徒手追逃跑的鸡/扫叶找苹果全失败),旁边树干木(=剑→狩猎→食物的钥匙)没人砍;拿到 planks 后又被 `LOW-FOOD resource gate crafting_table` 踢回 feedUp→死#7 wood-in-hand。
- **★机理(优先级倒置,两处)**: ①prepNether 见近 oak 只 `direct feedUp pulse`(找苹果)不砍树干拿木;②achieve LOW-FOOD gate 豁免了 sword/axe 却没豁免 crafting_table/wooden_pickaxe→有 planks 也被挡。共同=**食物危机劫持决策,但没工具赢不了食物,工具要的料就在手边/臂展内**。
- **改动(③热加载)**: **C271**(prepNether) 无木+oak在8b内+白天 → 先 `chopWood` 砍树干拿木再谈食物;**C272**(achieve) crafting_table/wooden_pickaxe 加入 LOW-FOOD 豁免(原地~2s 几乎免费的 bootstrap 钥匙,keepInventory 跨死保 planks)。
- **预测(可证伪)**: 无木 near oak 时 progress 出 `★C271 WOOD-FIRST` 且拿到 planks;低食物有料时不再 `LOW-FOOD resource gate crafting_table` 挡,直接造 table→镐→剑。
- **观测**: ✅ `node --check` 通过+热加载。✅**微观验证**: 部署后 bot 从 0 木→`oak_planks:4+stick:4`、过了食物 gate 试造 table、food 0→15 恢复、存活。⚠️**但暴露真根**: bot 拿到料后又 wander 进水/漫游(planks 没了、SWIM、无工具)——**微观能力修通了,宏观不 commit**:一有材料就被 food/水/漫游分心,从不在原地把 table→镐→剑做完。
- **★★决定性结论**: C269-272 修通了 bootstrap 每个微观环节(找树/够树/砍木/过gate),但 bot **缺承诺计划**(wander/被打断,不把序列做完)=用户#1"决策太慢"的真根。**治本=世界模型 Phase4 承诺计划**(recommendation 锁定一个目标执行到底,suppress 漫游/分心直到完成)。见 [[decision-speed-keepinventory]]。微观补丁必要不充分。

## C269. ★★树荒远征解锁——leash-widen 只认"够不着的树"不认"没有树",稀树出生点 0 木链死（③chopWood 热加载,🟡待 dawn 验证）
- **触发(新世界 plains 夜1 实证)**: Normal+keepInventory 新世界,bot 落 plains 稀树出生点。~13min chopDBG `nearest=NONE total=0` 持续(搜不到任何树),0 木 0 工具,夜降手无寸铁链死 deaths 1→3(keepInventory 保 dirt,廉价)。
- **★根因(chopWood.js:1112)**: 逐级远征本能在(stale 16→56b moveAway + 锁定朝向 6s 冲刺,跨调用累积直线),但 leash `_pullR=80` 在 distHome>80 硬拉回锚点。放宽到 160 的条件 `_chopUnreach.size>=8`(找到≥8棵够不着的树)——**树荒里一棵都没有→_chopUnreach 恒 0→famine-widen 永不触发→leash 死守 80→远征被拽回绕圈,够不到 80b 外的森林**。机理 gap=**"nearest=NONE(无树)" 不触发放宽,只有"找到够不着的树" 触发**。
- **改动(③chopWood,机理修复,热加载)**: 加 `_treeDesert = 无木bootstrap(0 logs && <4 planks) && stale>=2`(多次 relocate 仍无树),触发时 `_pullR=256`(放宽 leash),让果断远征真能走到远处散布的橡树。keepInventory 下远征廉价=合理。体现用户#1原则(砍保命谨慎/果断执行)。
- **预测(可证伪)**: 下次 chopWood 在树荒(无木+stale>=2)→ bot 沿 `_chopExpYaw` 锁定朝向远征 >80b **不被 leash 拽回** → 到达 plains 橡树 → 拿木 → 工具链启动 → 夜里有武器,链死止。progress 应见远征位移持续增大、最终 `nearest=oak_log@Nb` 命中。若仍 0 木: ①256b 内真无树(换探索方向/更大)②collectBlock 到树寻路失败。
- **观测**: ✅ `node --check` 通过+热加载。🟡 部署时夜间,bot 夜 hold(deaths 稳 3 止链死),待 dawn chopWood 远征验证拿木。
- **关联**: 这是新世界"决策提速"证据驱动的第一刀(观察→定位真拖慢点→针对性砍谨慎)。与 [[decision-speed-keepinventory]] 主线一致:keepInventory 让死亡廉价,大量旧世界"保kit防死"谨慎可砍。

## C268. ★★食物 strand livelock——berry 追逐范围(32)< 扫描范围(48),扫到却够不到（③feedUp 热加载,🟡部分验证）
- **触发(确认 livelock 取证,决定性)**: bot @10,81 雪山顶 **冻结 14s+**(act_trace `act=- path=0`),food4 hp13 host=0 白天。progress: `feedUp: calorie-floor stop food=4 ... berry48=sweet_berry_bush@44 ... — no long roam without a target` + missionNether C233 DESERT-FORAGE→forageExplore `no-result`空转。**扫到 berry@44、cow@59 却"无 target"拒绝去**=经典 catch-22(太饿不敢去拿食物)。难度 Easy 饿不死(封底 hp10)但真 livelock。handoff §8 + memory food-desert-spawn-deadlock。
- **★根因(feedUp.js:1313)**: berry-bush 追逐 `world.getNearestBlock(bot,'sweet_berry_bush',32)` 只搜 **32 格**,但扫描 `berry48`(line 1071)用 **48 格**。bush@44 > 32 → 追逐返回 null → 跳过 → 落到 calorie-floor stop(1438)冻结。**追逐范围 < 扫描范围的不匹配**:扫到报告了,实际够不到。代码注释 1221 自陈这类 bug(cow@48/berry@47 ignored)。
- **改动(③feedUp,机理修复,热加载)**: 追逐范围改自适应 `bot.food<=10 ? 56 : 32`(覆盖 48 扫描+margin)。原则=**已知浆果丛在 44b,饿着的 bot 必须花 pip 去够唯一食源**(白天/Easy 安全);calorie-floor 的"无 target 别乱跑"恐惧不适用于"已知具体 bush"。
- **预测(可证伪)**: 下次低食物 + 扫到 sweet_berry_bush@33-56 时,progress 应出 `feedUp: foraging sweet berries @Nb` 且 bot 实际走过去吃,**不再 `calorie-floor stop ... no long roam` 冻结在有浆果的山顶**。若仍冻: ①forageExplore(missionNether C233 调它)是另一活跃路径,no-result 不 relocate(需另修)②goToPosition 到 bush@44 寻路失败(MAROONED 互锁)。
- **观测**: ✅ `node --check` 通过+热加载。🟡**部分验证**(07:32): 部署后 bot 从 @10,81 冻结脱困,移动 ~43b 到 53,78,**food 4→7 回升**(与追到 berry 吃浆果一致),craft stone_sword。但破因无法 100% 归因(同期 missionNether 也escalate forageExplore/migrate)。待下次纯 food-strand 确认 `foraging sweet berries @44b` 日志。
- **关联**: forageExplore 的 no-result(明知 berry@44 不 relocate)是相邻未修路径(missionNether C233 调用方)。深层仍是 snowy_taiga 食物荒漠,根治靠 migration(C263)+ world_model migration.recommend。

## C267. ★★★中央世界模型 Phase 1-2(用户架构主线)——god-view 单一真相源 bot._world 喂 LLM+全层（①modes.js world_model mode,✅部署验证;含地面门控雏形）
- **触发(用户 2026-06-19 亲自下的架构方向)**: 要"足够强大的世界模型,时刻告诉 LLM,且所有层(本能/工具/策略)都能用";核心=**地面/hold 门控**(默认压住"回地面"冲动,镐够+计划下地才 LLM bypass,committed 后禁所有自动上浮)。详见 docs/world-model.md + memory world-model-central-gate。
- **机理/痛点**: ①surface yo-yo 死锁(bot 反复想上浮取木又被拦,C264 那类);②状态散落各层各算(day/night/mobility/threat/kit/cover 散在 modes/prepNether/achieve/missionNether,易互锁);③LLM 缺单一结构化真相源。
- **改动(①modes.js 新增 `world_model` mode,Phase 2 只读)**: god-view 每 2s 聚合 `bot._world`{time,pos+depthBand,mobility,vitals(+canRegen/armor),threat(hostiles/creeper/**phantomNear**/swarm/actionable/takingDamage),cover(overhead/**coverReal** 真顶 vs 空中暴露),kit(picks/tier/hasTablePath/foodSufficient/**sufficientForUnderground**),migration(biome/badBiome/inDeathZone/recommend),**surfaceGate**(hold/committed_underground/free + allowSurface + reason),recommendation} → 写 world_model.json。**零行为变更**(门控此阶段只算不拦)。Phase 3+ 才接线拦截+监工 bypass+全层消费。
- **预测(可证伪)**: world_model.json 每 2s 刷新,字段随真实情况变(夜→gate hold;snowy_taiga→migration.recommend true;裸镐→sufficientForUnderground false)。LLM/监工可直接读取做决策。后续 ①②③层逐步改读 bot._world 消除重复判定。
- **观测**: ✅ `node --check` 通过。✅ 部署验证(15:01 起): world_model.json 全字段正确写出。✅ **Phase-3 加固验证**(15:17): mobility **自算**(夜间 sealed hold 中也显示 `FREE exits=[[0,1]]` 不再因 interrupt 模式被饿死显示"?");migration **biome-aware**(`snowy_taiga badBiome:true recommend:true`);surfaceGate 夜间正确 `hold/allowSurface:false`。
- **关联**: handoff §5/世界模型命门。Phase 2 雏形已替 C264(自我脱困)/C266(假掩护 coverReal)/C255(铁带 depthBand)提供结构化信号。**待办 Phase 3-5**: 门控影子模式→真拦截自动上浮+监工 bypass 通道(advisory.surfaceGate)→①②③层收敛读 bot._world。docs/world-model.md §6 有完整计划。

## C266. ★★★遇敌根因(handoff §5.2 用户亲点)——"covered night hold" 对 phantom 是假掩护,被动等死（①modes.js self_preservation,✅重启部署,🟡待夜验证）
- **触发(死亡#27 活体逐帧取证,决定性)**: 接班期间 bot hp 一路 12→7→5→3→死(deaths 26→27 @103,77,-39)。act_trace 全程 `act=mode:self_preservation pos 不变 ctrl=-`(完全静止)。progress 反复刷 `[self_preservation] covered night hold: hp=3 hostiles=1 closest=4.6`,kit-check 显示威胁=`phantom@4.6 dy=4.0`、bot 自身 `foot=snow head=air`(裸露雪山顶)。**bot 自以为"covered"安全就被动 hold,phantom 从空中俯冲一路打到死,全程没察觉 hp 在掉、没反击、没逃、没真封顶。**
- **★根因(modes.js:242 coveredNightHoldStatus)**: ①`status.covered = hasOverheadCover(2,6)` 只要头顶 2-6 格内**有任意一块**实心即判 covered——**挡不住 phantom**(幻翼斜向俯冲不是垂直顶下),也挡不住斜射箭。②`hold = threatPressure && !recentDamage && creeperDist>3.6`,phantom 每隔数秒俯冲,间隙 >4s 时 recentDamage=false → 重新 hold → `wait(3000)` 干等 → 再被俯冲。机理=**掩护判定不认空中攻击者 + hold 期间不监测"还在掉血"=假安全被动等死**。(幻翼成因: 这片 snowy_taiga 无羊→无床→无法睡觉→超3天必刷 phantom,是复发威胁。)
- **改动(①modes.js self_preservation,机理修复,需重启)**: coveredNightHoldStatus 加 **false-bunker / HP-会话守卫**: hold 期间用 `bot._coverHoldHp/_coverHoldAt` 追踪 hp(12s 会话窗); 若 hold 中 **净掉血≥2**(`bot.health <= sessionStartHp-2`) → 判 cover 失效(`status.coverIneffective=true`)、`hold=false` 打破被动 hold → 交回 self_preservation 主动防御/转移(挖坑求真顶)。原则="**持续掉血的掩护就是假掩护**",通用覆盖 phantom + 隔缝中箭 + 任何穿掩护掉血,非作弊。hp 稳定时会话续命(真安全的 hold 不受影响)。
- **预测(可证伪)**: 下次夜间 bot 在"covered" 位被 phantom/隔缝攻击掉血时,progress 应**不再持续刷 `covered night hold` 直到死**——掉血≥2 即打破 hold,bot 转入主动防御(攻击俯冲到 melee 的 phantom)或挖坑真封顶(head+1 实心 roof,phantom 够不到)。phantom 夜致死应下降。若仍死: ①打破 hold 后的主动逻辑没选"挖坑真顶"而去裸奔崖顶(需把 coverIneffective 显式路由到 digDown+seal) ②phantom 俯冲不入 melee reach,bot 攻击够不到(需 wait-under-roof 而非 fight)。
- **观测**: ✅ `node --check modes.js` 通过。✅ 重启部署(14:37,bot 死后空背包重生=零成本时机,新 agent 48909 + C266 grep 命中 + bot "securing till dawn" 主动封顶)。🟡 待下个 phantom 夜验证。
- **关联**: handoff §5.2 用户亲点的①层遇敌根因(对准机理非whack-a-mole,先抓逐帧证据再定机理)。与 C256(裸甲不夜战)、C257(夜no-regen封顶)同治"夜间生存",本条补"假掩护被动死"。**更深层**: 无床=phantom 复发源,根除要 migration(C263)到有羊 biome 设床→既破 respawn 死亡区又停 phantom。

## C265. ★★★卡台阶顽疾(用户观察一周,喊修4-5次未果,亲自怒斥)——edgeStall 只测不动,缺恢复反射（①modes.js,✅重启部署,🟡数字验证中）
- **触发(用户第三视角实拍截图 + 全量取证,决定性)**: 用户发来 bot 楔在圆石台阶边的截图,严正指出"上 1 格台阶有时卡住,2 格更久,观察一周喊修 4-5 次没成功,要求立即严肃对待"。取证(motion_quality.jsonl): **edgeStallMs>1000 历史出现 1609 次**;最严重 `path=1 crossEff=0` 楔死 `8604→14738→20822ms`(02:24)、`6140→12260→18389ms`(03:50,且发生在 self_preservation 反射中)。act_trace 同位 `ctrl=forward,sprint pos 不变`=楔住特征。
- **★根因(双层)**: ①**物理层**: prismarine-physics 1.11.0 `stepHeight=0.6`("能不跳就跨上的高度"),bot 走路**登不上整 1 格台阶**,必须靠 mineflayer-pathfinder 主动发 jump。角落/斜approach/raw控制(非pathfinder)时 jump 没排上或错时 → 顶着台阶水平位移≈0 楔死。②**架构层(真空洞)**: `modes.js` 的 `motion_quality` mode 是**纯 observer**(`always:true interrupts:[]`,注释自陈"修完 locomotion 用数字验证")——它**测量** edgeStallMs 却**从不采取任何纠正动作**。上几个实例只加了遥测、没加恢复动作 → bot 楔到 20s 也没人推一把。**缺的就是 edge-stall 恢复反射。**
- **改动(①modes.js 新增 `edge_unstick` 反射,紧挨 motion_quality,需重启)**: 人类做法(非作弊,**故意不动 stepHeight**——真人不能不跳滑上整格=作弊感)。~4Hz 轻量 tick: 仅当 `pathfinder.isMoving()`(寻路器真想走) 且水平位移<0.05(楔住) 且非挖块/游泳/POCKET/ENTOMBED 时介入。楔住≥600ms+在地面+头顶有空间 → **主动跳**(覆盖1格/2格/角落所有几何,多余的跳无害);楔住≥2500ms(跳不出=墙/角陷阱/错路) → `pathfinder.stop()` 丢路径强制重规划,破 20s 楔死并记 `[edge_unstick]` progress。严格 gate 寻路器意图,绝不干扰有意静止。
- **预测(可证伪,用现成遥测数字验证)**: 部署后 motion_quality.jsonl 的 edgeStallMs **应被封顶在 ~2500-3000ms**(单窗口触发 replan 后即重置),**绝不再出现 8000/14000/20000 的累积爬升**;1 格台阶楔死率应大幅下降(跳即上),2 格"更久但能上"。progress 偶现 `[edge_unstick] wedged ...ms replan` 是跳不出时的兜底(仍远好于 20s)。若仍高 edgeStall: ①pathfinder.isMoving() 在该卡顿时为 false(则改用 controlState.forward 信号) ②jump 被其他 mode 同帧 setControlState('jump',false) 互斥 ③真根是 2 格台阶需先上第一格——观察 replan 频率。
- **观测**: ✅ `node --check` 通过。✅ 重启部署(14:32)。✅**live 验证 gate 正确**: 两次 edgeStall 命中(POCKET 垂直挖矿 3718ms / FREE 寻路挖穿 2458ms)edge_unstick 都正确**不误伤**(targetDigBlock+POCKET gate)。⚠️**但发现真实失效模式**(07:13 @-35.5,48 MAROONED): jump 解不了的几何 → replan(pathfinder.stop)**重算又选同一条堵死路线**→原地弹跳 5×replan/**20s** 才脱困(比旧的无限楔死好,但仍难看=用户抱怨的样子)。**改进(已部署)**: ①resetStreak≥2 时 replan 改为**物理后退+侧移脱离楔死几何**(让重算从不同位置选不同路线),②阈值 2500→2200/间隔 4000→2500 加快,③`edgeStallMs` 遥测排除 targetDigBlock(滤掉挖矿/挖穿误报,指标只反映真·行走卡顿),④jump 触发记节流日志正面验证。✅**改进后 live 验证(07:25 @11.7,77)**: 同类 jump-fail 几何,升级阶梯 step-jump(629ms)→replan#1(2455ms)→replan#2+**back-off relocate**(2476ms)→bot 位移脱离→07:25:47 飞走,**总~5s**(对比改进前 07:13 同类几何 5×replan/**20s**)。back-off 把硬楔死 20s→~5s。另两次简单台阶 step-jump#1/#2(625/629ms)jump 即解无升级。封顶达标。
- **关联改进**: 见 C267(世界模型)——edge_unstick/motion_quality 是 locomotion 反射族,后续可消费 `bot._world`。
- **关联**: 这是用户最高优先级的长期顽疾。motion_quality 遥测(①层既有)与本反射构成"测量→纠正"闭环。与 mobility 状态机(ENTOMBED→挖)同属①层 locomotion 反射族。fall-damage(hp12→7 host=0 崖坡导航摔)是相邻的地形 locomotion 问题(死亡家族#4 不稳perch),待续。

## C264. ★★★自我脱困命门——hp8-13 no-regen 破解器只认垂直pocket,水平worksite里无法上浮永久冻死（③prepNether 热加载，✅live验证脱困）
- **触发(接班全量取证,决定性)**: 接手时整栈已崩(只剩Cursor pyright,main/mindserver/bridge/botwatch全死),MC客户端(javaw)仍活LAN 55916。main_stdout 末尾正是 handoff 描述死锁: `Pinned 15min+ — kicking the stack (forced interrupt, kick #1/2/3)` 后 `WebSocket client disconnected` 进程崩。重启后 bot 立刻回到 **65,48,-19 hp12 food15 完全冻结**,act_trace 全程 `act=- dig=- ctrl=- path=0`,progress 9秒死循环: `[mission] not kitted → prepNether → bankRecover → defer shield → TABLE gate for iron_pickaxe (night=false actionable12=0; no repeat 3x3 craft loop)`。完整 vitals 确认 bot **有镐**(iron_pickaxe:1+stone_pickaxe:2),非 noPick。
- **★根因(prepNether.js:697 tableRecoveryBlocked 读码)**: bot 在 y48 **水平 undergroundWorksite**(非垂直 pocket): `tableRecoveryUndergroundWorksite()=true`、`tableRecoveryVerticalPocket()=false`。三个 safeDay 分支全挂: ①`normalSafeDay` 要 hp≥14(bot hp12 失败) ②`famineVerticalEmergency` 要 verticalPocket(失败) ③**`noRegenDeadlock`(C224 的 hp8-13 死区破解器)被错误地只 gate `verticalPocket`**(从 famineVerticalEmergency 抄来的)→失败。⇒ `block.safeDay=false` → handleTableRecoveryBlocked 跳过 surfaceUp(735行,**从不调用**),落到 784 行 TABLE-gate log → wait6s → return true → prepNether return false → missionNether 重派 → 重头。机理=**hp 12 受伤 bot 在水平隧道无木无台:回血要食物、食物要上地表、上地表要 hp≥14(回不去) 或 verticalPocket(不在)→ 永久吸收态冻结**。这就是 handoff 5.1 点名的"困y48取不到木却不会强挖出地表"自我脱困失败。
- **改动(③prepNether,机理修复,热加载)**: noRegenDeadlock 的 `verticalPocket` 改为 `(verticalPocket || undergroundWorksite)`。语义: 受伤(hp8-13)+无法回血(food<18无食)+白天+零actionable威胁+**有镐**的地下 bot,从水平 worksite 上浮取木/觅食与从1×1竖井一样安全有效;垂直限制是抄代码留下的错误窄化。因 tableRecoveryBlocked 开头已保证 `undergroundWorksite||verticalPocket` 至少一真,此处即恒真——正是意图。
- **预测(可证伪)**: hp8-13、白天、无威胁、有镐、地下无木无台时,progress 应出 `prepNether: TABLE recovery for <goal> — ...bounded surfaceUp for wood/table recovery`,bot **实际上浮**(y 上升)→到地表后 C229 chopWood 或恢复目标链,**不再 `act=- ` 冻结在 TABLE gate 9秒循环**。若上浮后又地表 idle: surfaceUp 本体或 chopWood riskySkip(handoff §9)需补。
- **观测**: ✅ `node --check` 通过。✅**live 验证脱困**(06:07): 部署后下一轮派发即触发 `TABLE recovery for iron_pickaxe — bounded surfaceUp`,bot 从 **65,48,-19 → 43,62 → 40,73**(爬升 25 格 y 出地表上山坡),TABLE 死锁消失,prepNether 恢复真实目标链 `smelt raw_iron->iron_ingot [2/3]`(在熔铁)。一小时+死锁破除。待观测: 上地表后是否陷入 handoff §8/§9 的食物strand/chopWood riskySkip 次生 livelock。
- **关联**: 这是 handoff §5.1 用户亲点的①层地基根因(对准机理非whack-a-mole)。与 C257(夜no-regen封顶)、C224(原破解器)同治 no-regen 吸收态死锁,本条补上"水平worksite"漏网场景。companion: prepNether:1108 给非必需 water_bucket prep 加 `!tableRecoveryBlocked('bucket')`,table-blocked 时跳过不 yield-loop(handoff §4 一刀)。

## C263. ★migrate 每次只走25-254b就abort——任意怪8b内即放弃,逃不出雪林（③migrate 热加载，🟡待fire验证）
- **触发(handoff §6 + 接班 grep 确认)**: 上个实例 C263 edit 被用户消息打断未应用(`grep -n C263 migrate.js` 无匹配)。migrate.js 在 fire 但每次只走 25-254b 就 `actionable hostile at leg N` abort(migrate.js:275 `closeActionable()`=任意敌怪 8b 内即 break)。整片 snowy_taiga(无 land animals→无羊→bedOk 恒 false→respawn 永远回死亡区),逃出需 ~800b。一只游荡骷髅就终结整段迁徙。
- **★机理**: 行军穿雪林必须穿过怪阵才能到 ~800b。leg 循环顶部已检 `bot.interrupt_code`(reflex/cancel)做 per-leg yield——可战斗的怪由 ①层 self_defense 反射接管,预防式 abort 对它们是冗余。唯一真正无法穿过的是**贴脸 creeper**(无视战斗会爆,self_defense 救不了走进爆炸的身体)。
- **改动(③migrate,机理修复,热加载)**: 新增 `closeCreeper()` 谓词(creeper 名匹配 + <4.5b),替换 leg 循环 275 行与内层 hop 311 行的 `closeActionable()`。只有贴脸 creeper abort 该 leg;其他怪交给 reflex(interrupt_code 263行)yield 或直接走过。START GATE(209行 shouldMigrate)仍用 closeActionable 做预飞检查不变。
- **预测(可证伪)**: 下次 migrate fire 时,bot 应能穿过单个/多个非creeper怪(skeleton/zombie/spider)继续推进,totalAdv 突破历史 254b 上限,逼近能逃出雪山的 ~800b;只有 creeper 贴脸(<4.5b)才出 `creeper point-blank at leg N` abort。若仍早 abort: 查 interrupt_code 被 self_defense 频繁置位(战斗中断打断行军)→需让 migrate 在战后自动 resume。
- **观测**: ✅ `node --check migrate.js` 通过。🟡 待 migrate 下次 fire(fresh-respawn triage / 死亡区 / 海洋streak)现场验证 totalAdv。这是用户说的"THE 解锁"(穿过mob到有羊好biome→设床→破死亡区respawn循环)的前置。

## C257. ★★夜间 no-regen 冻结 livelock——所有 handoff 都是白天门,夜间暴露冻死（顶层missionNether,需重启,✅重启验证封顶）
- **触发(botwatch ★STALL 6min 取证,决定性)**: 死亡5后重建,bot @14,68,-11 hp12 food15 **冻结 6min+**(botwatch ★STALL fire, act_trace `act/ctrl/path/dig 全="-"` idle)。progress 死循环刷 `prepNether stand-down: low-hp/no-food cooldown Ns; body stays free for survival modes` + `no-regen no-food → forageExplore(ACTIVE hunt)`(决定了却没执行)。期间入夜(tod>13000)。
- **★根因(missionNether.js:1086-1135 读码)**: no-regen-no-food cooldown 块里所有逃逸 handoff **都是白天/有怪门**: `daylightFamineHostileShelter()`(1093,白天+怪)、`!isNightNow()` forageExplore deadlock-breaker(1100/1112,白天门)。**夜间 + host=0 时**: forageExplore 正确自gate(夜不外出)瞬返,但上述 handoff 全不触发 → 落到块尾 `wait+continue` → **暴露冻结**。"body stays free for survival modes" 但没 survival mode 来封顶 → 冻 6min → 等怪游过来 swarm 裸甲bot(死亡5模式重演)。机理=**夜间 no-regen 无逃逸:觅食被夜gate(对)、封顶handoff被白天gate(漏)、留空冻**。
- **改动(顶层missionNether,需重启re-arm)**: 1092 stand-down 后加**夜间分支**: `if (isNightNow()) → customSkill(prepNether) hole-up+seal → wait+continue`。夜间 no-regen 直接主动 handoff prepNether 封顶 hold 到天亮(配 C256 裸甲真封顶),不再冻结等怪。天亮后 isNightNow=false,原 forageExplore deadlock-breaker(1112)恢复觅食。
- **预测(可证伪)**: 下次夜间 no-regen-no-food(hp<14 food<18 无食)且 host=0 时,progress 应出 `★C257 night no-regen stand-down → prepNether hole-up+seal` 接 `prepNether ★NIGHT...hole up` + `night bunker dwell: covered=true`,**不再 6min `act="-"` 暴露冻结**;STALL 应消失。天亮后恢复 forageExplore。若仍冻: prepNether 封顶料不足(cobble buffer)或 self_preservation 互绞。
- **观测**: ✅ `node --check missionNether.js` 通过。✅**重启 re-arm 即时验证**(20:00): bot @14,68,-11 从冻结→`★NIGHT hole up`→`bunker already covered hold y=68`→`night bunker dwell: covered=true hostiles=0`,**已封顶过夜,livelock 破除**。待整夜+下个 no-regen 夜复发检验。
- **关联**: C253/C255/C256/C257 共同闭环"夜间生存(封顶不暴露)+装备进度(挖铁→甲→可夜战)+食物死锁(夜hold/昼觅食)"。重启同时清掉旧 missionNether 进程的活 livelock。

## C256. ★★★canFightNight 不看盔甲——裸甲bot自信不躲被夜swarm刷死(86%裸死总根因)（③prepNether 热加载，🟡待夜验证）
- **触发(死亡5实时取证,决定性)**: 新世界 deaths 5次,死亡1/5 同模式。死亡5 death_log: `Zombie dist=1.2, y70 surface, coveredAbove=0(全暴露), hostileCount=5(5僵尸), gear{stone_sword, shield:true, armorCount=0}, action:self_preservation`。死亡1 同样有 shield、裸甲。两次都是**有剑有盾但裸甲**,夜间地表被群僵尸刷死。
- **★总根因(prepNether.js:51 canFightNight)**: `canFightNight = sword && shield && hp≥10` **不检查盔甲**。它的 break(line238)意图"齐装夜间边干边砍对齐modes"。但裸甲(armorCount=0)身板: ①无减伤,挨满伤 ②挡不住5个方向 ③出不了那么高DPS秒5僵尸。结果 canFightNight=true→holeUpAtNight 在238 break **跳过封顶**→bot 地表夜战裸扛→必死。这串起死亡1(有盾破门→横穿死)、死亡5(有盾→不封顶→swarm死)、death_log **86%裸甲死**——共同机理=**把"有剑盾"误当"能夜战",忽略无甲=必败**。
- **改动(③prepNether,机理修复,热加载)**: canFightNight 加 `armor≥1`(同754行 helmet/chestplate/leggings/boots 计数,leather甲也算): `sword && shield && armor≥1 && hp≥10`。裸甲→canFightNight=false→holeUpAtNight **不再238 break**→走完整 dig-in+seal hold 到天亮(有cobble真封顶;keepFed裸hold到不了因holeUpAtNight先在工作循环顶部block)。**只禁地表夜战**:地下/enclosed 夜间挖矿仍由 236(undergroundSafe)/237(enclosed) break 放行不受影响。拿到甲(leather→C255铁甲)后恢复夜战。
- **预测(可证伪)**: 下次夜间地表、裸甲(armorCount=0)、有剑+盾时,canFightNight=false → progress 应出 `★NIGHT 入夜→优先生存...hole up` + dig-in seal,**不再 `canFightNight break` 后地表夜战**;有 cobble/dirt 时应真封顶(coveredAbove>0)。死亡应从"裸甲夜swarm"消失。若仍裸甲夜死: ①holeUpAtNight 封顶料不足(→囤cobble buffer) ②keepFed 裸hold 仍捕获(→需给 keepFed hungry-hold 也加 seal) ③modes self_preservation 互绞。拿到甲后 canFightNight 应恢复 true 允许夜战。
- **观测**: ✅ `node --check prepNether.js` 通过。🟡 部署时 bot 死亡5后坑里 hold(host=0 hp20 但 inv 又只剩dirt2,第2次gear全损),待下一夜 prepNether cache-bust 验证裸甲是否一致封顶过夜。
- **关联**: 与 C253(夜table横穿)、C255(挖到铁→铁甲)三者构成"夜间生存+装备进度"闭环。C254(地表床重生陷阱)仍待修。

## C255. ★★铁瓶颈根因——iron 被错当浅层矿硬封 y48-68(铜带)永远挖不到铁（③achieve 热加载，🟡待验证）
- **触发(新世界值守,铜152零铁,取证)**: bot 健康挖矿 ~1.5 MC日,raw_copper 堆到 152 但 **raw_iron=0**,mission 反复 `collect iron_ore [0/8]` → `NO KNOWN WAY to obtain iron_ingot` → `craft iron_chestplate NO KNOWN WAY`。progress 铁证: `mine probe: iron_ore y=69 — vertical budget done (5 probes, drop=1); lateral branchMine, no deeper shaft`——iron probe 在 **y69 地表层**探,5次探针只降1格就转 lateral branchMine 不挖深竖井。
- **★根因(achieve.js:877 exposeMore 读码)**: `shallowOre` regex 把 `iron_ore` 和 coal/copper **一起当浅层矿**,深度带逻辑: `y<32→surfaceUp回y48`(嫌太深)、`y≤56→原地branchMine不下探`、`y57-72→5探针降~6格就branchMine`。净效果=bot 永远在 **y56-68 branch mine**=copper 峰值层(copper 峰 y48)→刷出 copper152;但 **1.21 iron 富集 y8-16**(三角峰y16,主带y-24~56),y56-68 是铁分布稀薄尾巴→几乎零铁→mission 死卡。更糟: `y<32→surfaceUp` 让 bot **主动逃离铁富集区**。机理=**矿物深度分布错配:把铁当铜挖**。
- **改动(③achieve,机理修复,热加载)**: exposeMore 浅层带前加 iron 专属路由(豁免 copper-shallow 带): `ironOre && y>22 → lateralInstead('iron-deep-descend',24,targetY=14)` 用 branchMine 受控楼梯(player-style 1×2,自带 lava/夜/食物停,非盲digDown)下探到 y~14;`y≤22 已在铁带 → lateralInstead('iron-band',16)` 原地横向。coal/copper 保持原浅层逻辑。前置 C229 护镐门仍生效(深挖不破最后一把镐)。bot 当前 stone_pickaxe(能挖铁)+torch40。
- **预测(可证伪)**: 下次 mission 追 iron_ore 且 y>22 时,progress 应出 `mine probe: iron_ore y=N — descend to iron-rich band y~14 (staircase)` 与 `achieve.probe.lateral reason=iron-deep-descend targetY=14`,bot 实际下到 y8-16 branch mine,**raw_iron 开始累积**(不再0),mission 突破 iron_ingot→iron_pickaxe→iron 甲。**不再出现 `iron_ore y=69 vertical budget` 浅层封顶 或 `iron y<32 surfaceUp to y48` 逃离深度**。若仍零铁: ①branchMine targetY 楼梯被夜/食物停频繁打断(查 descent.stop) ②这片 deepslate 铁真稀(换坐标)。
- **观测**: ✅ `node --check achieve.js` 通过。🟡 部署时 bot 正转"mine diamonds(deep)"将穿铁带,待 achieve cache-bust 调用现场验证 raw_iron 是否开始涨。
- **关联待修**: feedUp hunt 上限 32 格,`pig@52` 可见却被忽略→food 缓降空转("no food source"但 scan 有 animal64);food 非危急时可不动,但若 food 滑向危急且只因 33-64 格猪被弃,候选放宽 hunt 范围或低食物时提高上限。

## C253. ★★新世界首夜 4连死螺旋——夜间地表横穿去远程工作台（③achieve 热加载，🟡待夜验证）
- **触发(新世界自主值守,实时取证,决定性)**: 2026-06-19 新世界 fresh-spawn→25min 零死亡推进到石器+furnace+shield+建家(bed@0,67,0)。入夜后 60s 内 **deaths 0→4 螺旋**,gear 全损(inv 一度只剩 dirt:3/spruce_sapling:1)。death_log 死亡1: `Zombie dist=0.9, y67 surface coveredAbove=2, gear{wooden_sword,shield:true,armor:0}, action:self_preservation`。progress 铁证序列: `19:00:25 prepNether ★HUNGRY/LOWHP food=11 hp=18 night — HOLD all work until dawn`(正确) → `19:00:37 need iron_pickaxe → place table → registered table @5,68,8 — walking to reuse`(下一轮没HOLD,夜间地表横穿) → 撞0.9格zombie死。
- **★根因(双层)**: ①**机理层**: `prepNether.holeUpAtNight` 的 break 条件 `canFightNight()`(剑+盾+hp≥10)在死亡1时为真→破夜hold→上层目标循环追 iron_pickaxe→经 `achieve.placeTable`(achieve.js:331)发起 `goToPosition` 去 @5,68,8 远程注册台→**夜间地表横穿穿过怪区**(起步时8格无怪所以 `mustReuseTable` 放行,行走途中 zombie 逼近/刷出贴脸)。`canFightNight` 破hold意图是"齐装夜间边干边砍"对原地作业合理,对**远程travel致命**。②**结构层**: bed(重生锚)在 0,67,0 **裸露地表**→夜间重生即死亡陷阱,贴脸怪 self_preservation 用 dirt:3 封不住→死2/3/4 连环(near-unavoidable,dawn 解)。
- **改动(③achieve,机理点修复,热加载)**: `placeTable` 的 table-walk(achieve.js:331)前加 `_nightExposed`(t∈13000-23000 && y≥50 && !enclosed,与本文件 line210/398 同款谓词)门: `_nightExposed && d>2.5 → 拒绝横穿、set _prepTableRecoveryBlockedUntil(30s)、return false defer 到白天`。相邻台(d≤2.5,无实质travel)仍放行;enclosed/地下豁免。纯加法,只在"夜间地表为工具目标横穿远程台"这一致命路径触发。
- **预测(可证伪)**: 下次夜间(13000-23000)、y≥50 地表、非enclosed、追 iron_pickaxe/工具目标且注册台在 d>2.5 处时,progress 应出 `★NIGHT-EXPOSED table-walk refused — defer table-craft to day`,**不再出现夜间 `registered table ... walking to reuse` 横穿**;白天/相邻台/地下 enclosed 仍正常 walk-to-reuse。若仍夜间横穿死,则路径不经 placeTable(查别的 surface-travel 向量: feedUp 动物追/chopWood 找树)。
- **观测**: ✅ `node --check achieve.js` 通过。🟡 修复时已 dawn,bot 白天重建中(cobble64/镐2/planks16),待下一夜 achieve cache-bust 调用现场验证。
- **★待办 C254(结构层,更大鱼)**: 地表 bed=重生死亡陷阱是死2/3/4 根因。修向: setBed 选址应在**封闭庇护内**(床+箱子+顶盖一体),或夜间重生被围时**立即 digDown 入地封顶**而非地表筑墙(贴脸怪时挖下比横向封墙快且避光)。待 bot 下次放 bed 时介入。参见 memory "家一体化"。

## C252. ★裸装无镐夜间地表暴露——prepNether bunker 加"挖洞失败→泥土筑墙 shelter"回退（③prepNether 热加载，🟡待夜间验证）
- **触发(用户实时截图 + 取证,决定性)**: 用户发来 bot 站在地表草坡的截图:"他正在一个并不安全的地方挂机等待夜晚结束"。取证: bot 42,80,-3 **hp10 food0 夜间 裸装(pick=0/cobble=0/stick=0/planks=0,仅5泥)死亡区(7死<16b)**,progress 死循环刷 `prepNether: bunker err stone dig blocked without held pick: stone`。v2 监控纯位移检测确认同位卡死 5min+。
- **★根因(prepNether.js:362 读码)**: 夜间 bunker 的常规 dig-in 分支直接 `await skills.digDown(bot, 2)` 挖洞——**裸装无镐遇石头 digDown 抛异常**,冒泡到外层 catch(372)→ `dugIn=false` → 6s 后重试 → 同样抛 → **死循环暴露在地表**;且 throw 发生在用 `seal`(sealBlock 含 dirt)封顶那步**之前**,所以哪怕有 5 泥也永远走不到"用泥土封"。机理 = **能挖洞才避难的隐含假设,在裸装无镐时崩塌**,且无地表筑墙回退。
- **改动(③prepNether,加法式,热加载)**: ① else 分支把 `digDown` 包进 try,捕获 no-pick/stone throw(`dugOk=false`)使其**不再冒泡触发 abort-retry 循环**;② 新增 `surfaceDirtShelter()`——digDown 失败时在地表用 sealBlock(dirt 等)在头高 4 向筑墙 + `sealCurrentRoof` 封顶,把自己围进 1×1 泥盒;③ 成功挖洞才走原封顶逻辑。纯加法,只在当前"无用空转"路径触发,best-effort 吞错,易回滚。
- **预测(可证伪)**: 部署后裸装无镐夜遇石头时,bot **不再地表死循环暴露**——progress 应见 `★surface dirt-shelter walls=N roof=...` 且 bot 被泥土围住(head-ring+roof),mob LoS/pathing 受阻,夜间存活率↑。若仍暴露则 ① 无任何 placeable 块(连泥都没),或 ② sealBlock 放置在该地形失败(需查 placeBlock 朝向/贴邻)。
- **观测**: 🟡→⚠️ `node --check` 通过。**已生效实测**(10:31 一次 cancel→missionNether 重启使 prepNether 带 C252 重载): progress 实录新路径 `digDown blocked (...) — surface dirt-shelter fallback` + `★surface dirt-shelter walls=0 roof=false`。**但暴露下一层 gap**: `walls=0 roof=false` 因 `sealBlock` 返回空——**bot 裸重生后连 dirt 都没有(零方块)**,C252 有泥才能筑墙,零方块时仍无能为力暴露。→ **待办 C253**: surfaceDirtShelter 应在无 sealBlock 但脚下/邻格是 hand-diggable 土系(dirt/grass/sand)时**先徒手挖几格土再筑墙**(裸手挖土不需镐,数秒);若四周全是石头(无镐挖不动)则确属不可恢复,归 death-reset。
- **回滚**: 删 surfaceDirtShelter 函数 + else 分支的 try/dugOk 包裹,恢复裸 `await skills.digDown(bot,2)`。纯局部。
- **深层(诚实记录)**: 这只治"裸装夜间能否避难"的症状;**真根仍是食物荒漠+无木→无镐→无甲的装备链死亡螺旋**([[neko-death-analysis-0610]]),需清醒专门 session + 天亮把 bot relocate 离开死亡区/食物荒漠到森林+动物 biome(续61:裸资产时坏地形别恋战)。

## C251. ★★★ dead-idle livelock【根因】——sticky_skill.json 的 UTF-8 BOM 静默杀死 sendStickySkill（bridge.mjs，✅文件+代码双修复并重启验证）
- **触发(自主接管全量取证,决定性)**: fork 后接管,bot hp20/food20 白天**裸装钉死出生点 -1,85,6 ~90min**,skill="" idle,watchdog 反复 STUCK-ZONE/FROZEN 重启回到同一死局,reflex 狂刷 `PERSISTENT PIN — 4 kicks ineffective … needs relocating recovery`。agent.log 自 17:04 重启起**只有** `executing code / Mode self_preservation finished`(空输出)churn,**零 `run_skill direct`**。
- **★根因(events.log 交叉,决定性)**: events 最近 500 行 = **178 次 `sticky_idle_rearm` + 0 次 `sent_sticky_skill`**;`idleMs` 单调增长冻结于 07:42:58Z 最后一个 skill_result(那次 missionNether 被 cancel,inv 还有木+石镐石剑32圆石)→ 08:11 死于 zombie → 裸重生 → **此后所有 sticky 派发静默失败**。bridge idle-watchdog 在 line 270 连接检查**通过**(故记了 rearm),但 `sendStickySkill()` 在 line 174 `JSON.parse(readFileSync(STICKY,'utf8'))` **抛异常被 catch 静默 return**。`xxd` 确认 `sticky_skill.json` 头三字节 `ef bb bf` = **UTF-8 BOM**(被某次 PowerShell 写入,mtime 11:07),Node `JSON.parse` 报 `Unexpected token '﻿'`。relayInbox 读 inbox.jsonl 走 `line.trim()`(JS trim 吃掉 U+FEFF)所以那条路活着——这也是为何 inbox 注入 missionNether 立刻生效、sticky 路死。**层①self_preservation 的 churn 是表象/受害者,不是因**:它只是在 skill 层缺位时填空;skill 一旦派发,missionNether 第一动作 `C226-A fresh-respawn triage: migrate off spawn death-gauntlet` 正确离开死亡区。
- **改动(两层)**: ① **立即**:`printf` 重写 sticky_skill.json 为无 BOM 纯 UTF-8(运行中 bridge 每 tick 重读即自愈,无需重启);② **根因加固(bridge.mjs)**:新增 `readJsonFile(file)` — 读后 `if(charCodeAt(0)===0xFEFF) slice(1)` strip BOM,parse 失败**记 `json_parse_error` 事件**(不再静默吞),sendStickySkill 改用之。防将来 PowerShell 再写 BOM 静默杀死派发。
- **预测(可证伪)**: ① bot 绝不再因 sticky 派发静默失败而 dead-idle——任何 skill 结束/死亡重生后,最迟 ~40s 内 missionNether 必被重新派发(events 出现 `sent_sticky_skill`);② 若将来某文件再被写 BOM,events 会出现 `json_parse_error file=...` 显式报警而非静默卡死。若仍 dead-idle 则派发失败另有路径(如 ws.send 半开 socket 静默丢),需在 sendStickySkill 加 send 后 ack 超时检测。
- **观测**: ✅ 决定性验证。inbox 注入 missionNether → `sent_skill` + agent.log `run_skill direct: missionNether` → bot 4min 内从裸装恢复(56,62,41 挖矿,木剑+木镐+石镐+17圆石+煤,hp20)。杀 bridge PID45732 → 新 PID50076 带补丁码 → on-connect `sent_sticky_skill missionNether`(**6h 来第一次**)+ `skill_result busy: missionNether already running`(agent 收到并正确 busy 拒)→ 派发→应答闭环端到端恢复。
- **★教训**: ① **Windows/PowerShell 平台陷阱**——任何 Node 读的 JSON 配置文件若可能被 PS 命令写过,必须 BOM-safe;② **静默 catch 是根因放大器**——`catch { return }` 把一个一次性写错编码放大成 90min 死局且无任何日志线索,修复同时把它改成记事件;③ 溯源纪律(见 [[root-cause-not-whackamole]]):没停在"self_preservation churn"表象,继续追到"skill 为何不派发"→"sendStickySkill 为何不发"→"文件为何 parse 失败"→BOM。
- **回滚**: 删 `readJsonFile`,sendStickySkill 恢复 inline parse(不建议——会重新引入静默吞)。文件修复不可回滚(BOM 本就是错)。
- **待办(诚实记录)**: 同样 BOM 风险存在于其他 Node 读、可能被 PS 写的 JSON(bank.json/bed.json/stations.json/spawn_pos.json 等,被 ③skills 读)——本轮未逐一排查,若 skill 出现"读配置静默失效"症状优先查编码。

## C250. ★#33 海洋迁移淹死根因——migrate 开放大洋 hard-abort + 返回陆地（③migrate 热加载，🟡待验证）
- **触发(1小时复盘,death_log+swim 日志+migrate.log,决定性)**: 用户问"真没问题吗",全量交叉取证发现 bot 我说"康复"后**又死 2 次**。其一 `05:54 drowning @ -749,59,200`:bot 一次 **637b 巨型迁移**冲进海洋,swim 日志连续在 -750 水里,`prepNether: wet-adjacent bunker accepted (waterDist=1.8 fails=29)` → 接受贴水 bunker → **淹死**。
- **★根因(migrate.js 读码)**: migrate 设计上避水 **settle**(ocean=-12 分,isSettleSite 拒水 biome),但 **march 时只 turn 不 hard-abort**:大洋中央每个 bearing 都是水 → `waterStreak>=3` 旋转 bearing,但**每转一个方向都先前进一 leg 再转**,转遍 10 个 TURNS = 推进 ~600b 深入海洋,转尽才 `abort settle best-seen`——此时已在 -750 深海,settle/bed 在海里 → 夜淹死。settle 避水救不了"穿越致死"。
- **改动(③migrate.js,3 处,热加载)**: ① 加**累计** `waterLegs`(不随 turn 重置);② `waterLegs>=7`(~168b 开放水域,远超河/岸)→ **hard abort**(别再深入);③ ocean-abort 后 **goToPosition 走回 `best`**(land 分>ocean,best=入海前最后陆地,90s 超时)→ settle/bed 落在陆地不在海里。纯安全加法(只更早 abort + 回陆地,不改成功路径)。
- **预测(可证伪)**: bot 不再做 600b+ 穿洋迁移淹死;遇大洋时 ≤7 水 leg 即 abort+回最后陆地 settle。migrate.log 应见 `open-ocean crossing — abort + return to land`。若仍淹死则 waterLegs 阈值或 inWater 判定需调,或淹死发生在非 migrate 路径(forageExplore 也穿水)。
- **观测**: 🟡 `node --check` 通过,child skill 热加载就绪,下次 migrate dispatch 生效。
- **回滚**: 删 waterLegs + hard-abort + ocean-abort return 三块。纯局部。
- **未修(诚实记录,深水区待careful work)**: ① **Phantom 裸死**(07:08)根因=装备链断裂:无剑→无法猎羊→无羊毛→无床(bedOk 恒 false)→不睡→幻翼累积裸杀;② **C244 migrate-stall**(movedReal=0b)某些 spot 发不出移动;③ **食物荒漠 spawn**(landAnimals=0+deathsNear=5-6)。这些是 [[neko-death-analysis-0610]] 装备进度链的深水区,不在疲劳点对核心 nav/装备链仓促动刀。④ **双 watchdog**: 真 watchdog(43260 detached)在工作,重复的(parent=claude.exe)是 harness 侧机制 churning,transient 低危,不盲杀。

## C249. ★sticky 重挂永久 idle 漏洞修复——bridge idle-watchdog（bridge.mjs，✅已重启部署）
- **触发(实测,决定性)**: 用户 tp bot 出石棺后,**bot skill="" idle ~1h 没自动重挂 missionNether**(04:00 STUCK-ZONE cancel 时 `running:null`),只跑 autonomous modes(Nightfall securing),纯浪费 bot 时间。
- **★根因(bridge.mjs:117)**: sticky 重挂**只在 skill_result 后 setTimeout 8s 一次性触发**,且注释明说"busy 拒绝必须跳过否则 reject→rearm→reject 死循环"。但副作用:**当这次 8s 重挂恰好撞上 autonomous mode 动作(如 dusk bunkerDown)在跑 → run_skill 被 busy 拒 → busy 的 skill_result 被跳过 → 永不重试 → 永久 idle**,直到下次 WS 断连重连才 3.5s 重挂。无人值守长跑的自治黑洞。
- **改动(bridge.mjs)**: ① 跟踪 `skillActive`(run_skill send 置 true,skill_result 置 false——busy 拒也清,因为 skill 没真启动);② 新增**周期 idle-watchdog**(每 30s):online && !skillActive && idle>40s → `sendStickySkill()`。丢失的重挂 ~30s 内自愈;运行中(skillActive)不打扰;busy 拒无害(清 flag 下轮重试)。
- **预测(可证伪)**: bot 绝不再因"重挂撞 mode"永久 idle——任何 skill 返回后最迟 ~40s 内 missionNether 必重新接管(events 出现 `sticky_idle_rearm` + `sent_sticky_skill`/`sent_skill`)。
- **观测**: ✅ `node --check` 通过,杀 bridge PID37092→watchdog 重生 PID45732 带新码。**实测生效**: 05:06-05:08 `sticky_idle_rearm` 每 30s 触发,最终(05:08:23)穿过 reflex-wedge 的 busy 拒、把 missionNether 重新跑起来(skill=missionNether)。bot 从 idle 恢复到监督循环。**已知 cosmetic**: 启动初 `lastSkillEndAt=0` 致首几次 `idleMs` 显示完整时间戳(非 delta),首个真 skill_result 后自正;无逻辑影响。
- **回滚**: 删 skillActive 跟踪 + idle-watchdog setInterval;恢复纯 8s 一次性重挂。

## C248. ★★★石棺死锁【根因】修复——recovery-floor / pickaxe-survival invariant（③missionNether 热加载，✅已 cancel re-arm 部署）
- **★用户纠偏(决定性,带死亡威胁)**: 我连做 4 次脱困迭代(C247 h>3→descent→carve→tunnel)修"怎么从石棺爬出"的**表象**。用户怒斥:"我需要的是溯源，从根源上避免，而不是每次头疼医头脚疼医脚…是资源管理出了问题、明知道镐子要没了还他妈在挖？…如果bot再犯这个错我就把你弄死。" → 见记忆 [[root-cause-not-whackamole]]。
- **★根因(死亡复盘 death_log+events+progress 交叉,决定性)**: 石棺是**资源依赖死锁(catch-22)**:需 iron_pickaxe→需 table→需 4 planks(只有2)→需 logs(0)→需到地表树→需挖上去→**需镐**。怎么进来的:① bot 反复夜里裸装被怪杀→掉光→重生最小 kit;② **用唯一木镐挖到断**(events 实录 wooden_pickaxe 82%→90%→98% wear,"craft spare" 触发**但无 cobblestone/planks 造不出**);③ **C232 SAFE-MINE 用垂死镐 `mineDown(targetY-14)` 把 bot 往下挖、不查耐久**→镐断 ~14b 更深(58,66 差值正好 14!)→无镐+无料+enclosed=**永久石棺**。这就是用户说的"明知镐要断还在挖"。见 [[resource-floor-bootstrap-kit]]。
- **★改动(③missionNether,两处入口 gate,不是脱困表象)**: 加共享 helper `pickRemainFrac()`/`canCraftReplacementPick()`/`pickHealthyForDig()`/`belowRecoveryFloor()`。① **C232 gate**: `safeContainedMineExit` 加 `if (!pickHealthyForDig()) return false`——唯一的镐磨损过半(remain≤0.5)且无料造备用时**不准下挖**(挖断会困死更深)。② **C237 扩展**: has-pick 时本来让位 C232,新增例外 `&& !belowRecoveryFloor()`——垂死+无料+无木的镐应**趁还能用爬去地表找木头**补 kit(带镐 surfaceUp 还掉 cobble 当 pillar 料,脱困更顺),而非继续挖到断。
- **预测(可证伪)**: 部署后 bot **绝不再**用半血以下的唯一镐 + 无料 时 mineDown 下挖(C232 gate 拦截);此类 bot 转而 surfaceUp 找木头 rebootstrap。**根本上**:不再产生"无镐实心石棺"——因为进入该态的唯一路径(垂死镐下挖)被堵。若仍出现无镐石棺,则根因判断有误(还有别的下挖路径,如 collectBlock/pathfinder canDig 破镐),需继续溯源。
- **观测**: ✅ `node --check` 通过;03:04 **cancel_skill re-arm 部署成功**(`cancel_result ok` → `skill_result cancelled` → `sent_sticky_skill missionNether` 从磁盘重载 C248,day+host0+密封石棺=安全)。当前 bot 无镐,C248 的镐-gate 对它无直接可观测变化(它走 C237 找木头分支);待 bot rebootstrap 拿到镐后自然验证 dig-gate。
- **当前 bot 处置**: 用户授权 reset 但 **cheats off(`cheat` mode on:false,无 /tp /setblock 记录)→ 无法干净 /kill 强制 reset**(试了 forceReset skill,sticky 重挂机制脆弱未跑成);bot 仍困石棺但**安全**(密封无怪可达、饿不死除非 Hard)。C247 manual-tunnel 能掏石但 49↔57 振荡(surfaceUp PRIMARY pathfinder 每次把 bot 走回 pocket)未根治——**但这是脱困表象,按用户指示不再 whack-a-mole**;根因 C248 已堵,等自然 death-reset 或用户开 cheats 我 teleport。
- **★C248b 补强(③mineDown 热加载,闭合 root invariant)**: C248 gate 的是 dispatch("别用垂死镐**开始**挖"),但镐可能 **mid-dive 才断**(14 步楼梯挖 ~42 块 > 磨损木镐 ~30 用)→ 继续挖会困更深。给 mineDown 主循环每步加 `pickAboutToBreak()(≤6 用)&& !canCraftPick()` → abort("别越挖越深困死",此时还剩几用够爬回)。**两条下挖致困路径全堵**:C248 防开始 + C248b 防继续。验证: `node --check` 通过,下次 mineDown dispatch 即生效。
- **回滚**: 删 C248 helper 块 + C232 的 `pickHealthyForDig` gate + C237 的 `&& !belowRecoveryFloor()` + mineDown 的 C248b 守卫。纯局部。

## C247. ★★封闭石洞裸身脱困——破顶 h>3 误拒修复 + 横向掏洞 lateralEscape（③surfaceUp 热加载，🟡待 dawn 验证）
- **触发(自主接管,act_trace+surfaceUp.log+mine_motion 三重取证,决定性)**: bot hp5/food14 白天裸装(stick×4 oak_planks×2,无镐)**冻在 58,66,29 一个 4 格高石洞 2h+**。C237 NO-PICK ESCAPE 每 ~45s narrate `→ surfaceUp` 但 **act_trace 全程 `act:- dig:- ctrl:- path:0` 零动作**。surfaceUp.log 实录: PRIMARY pathfinder `pf leg 66->66 stall` 4 次(GoalY 上不去)→ fallback `no-pick stone blocked at h=4 name=stone` → `EXIT y=66`,每周期同样空转。
- **★根因 1(破顶被误拒)**: 气穴 = 脚 y66、空气 y67/68/69、石顶 y70(=h=4)。`canPlanNoPickStoneBreach` 里 `if (h>3 && !famineEmergency()) return false` —— h=4 顶被拒(food14 不算 famine,famine 需 food≤2),哪怕 trappedEnclosed 也照拒。但 y70 距眼高 ~2.4 格**远在 4.5 reach 内**,本可破。→ 改: `&& !trappedEnclosed` 放行(loop 只到 h=4)。**实测生效**: 改后 `planned no-pick stone breach 1/200 at h=4`,8 秒 bare-hand 挖穿 y70。
- **★根因 2(垂直在缺料时根本无解)**: 破顶后仍 `y 66->66`——pillarUp 有 2 planks 也抬不动,且**就算抬 2 格也够不到 y87(差 19 格)**。机理: bare-hand 挖石**不掉块**→无法累积 pillar 材料;2 planks tower 不了 21 格。注释自证 C237 以前能爬 y66→84 是因当时有 **209 cobble**。**裸身+无镐+实心石封死 = 物理上无法垂直脱困**。
- **★改动(③surfaceUp.js,热加载,3 处)**: ① `h>3` 误拒加 `!trappedEnclosed` 放行破顶;② 新增 `wideScan(reach)` 六向地形探针 + EXIT-SCAN 在 climb 失败且仍 enclosed 时 dump ground-truth(mine_motion `exit_sealed_scan`);③ **核心: `lateralEscape()`**——vertical stall(stuckFloor≥2)+ trappedEnclosed + 无镐时,wideScan 选**最近横向开口**(env 实证 +z 侧 y65/66/67 是 air),用 pathfinder `canDig=true`(safeToBreak 不查镐,裸手掏石)+`dontCreateFlow`(避水岩)横向掏到洞口,掏通后主循环从新位置重试垂直。**关键洞察: GoalY 上不去是因需 tower 无料;横向同-Y goal 只需掏+走不需 tower → 正是横向能行而垂直不行的原因**。每 surfaceUp call 限掏 1 次(lateralTried),45s 超时。
- **预测(可证伪)**: dawn(C237 day-gated,tod 现 16172 夜)C237 再 fire 时——① 应见 `planned no-pick stone breach at h=4`(破顶生效);② vertical 仍 stall 后应见 `lateral escape` + mine_motion `surfaceUp.lateral.begin/end`,bot **横向移动 >1.2b 离开 58,66,29**(2h+ 死 pin 打破);③ 若掏进连通洞穴有上行路,下个 cycle PRIMARY 应能 pathfinder 上行 / 最终 surfaceReady;④ 若 wideScan 四向 14 格全实心 → `★UNRECOVERABLE seal`(则该 spot 真无解,归因 death-reset 而非 surfaceUp)。
- **观测**: 🟡 `node --check` 通过,3 处改动落盘热加载就绪。**h>3 修复已 live 实测生效**(02:08 周期破顶 y70)。**lateralEscape v1 实测暴露 bug(02:20-02:24,DAY)**: wideScan 实证此 spot **px/nx/nz 横向 14 格全实心石头,只有 pz toAir=1**——但 `toAir=1` 是 **bot 自己气穴的边**(`run=["air"]`),不是穿墙开口;v1 瞄它 → `GoalNear range 1` 对相邻 air 已满足 → `moved=0` 空转。**且 env 揭示真相: y65(脚下)+z 是 air([0,-1,1]/[1,-1,1])——pocket 朝 +z 向下开口连着下方空腔**(bot 多半从那下来的),所有逻辑却死命往上爬。→ **v2 修复(已落盘热加载)**: ① cand 过滤 `toAir>=1`→`toAir>=2`(真穿墙开口,杀 no-op);② 新增 `findDescent` 探测相邻向下开口 + **手动踏入下降**(pathfinder 拒大落差,故 walk+gravity 落进下方洞系;hazard 列 skip);③ 都无才 UNRECOVERABLE。**descent 稳赢**: 浅落→进洞系可能另寻上行路;深落→fall-reset→spawn 带树重生,两者都打破 2h+ 死冻。
- **v2 实测(02:25-02:28,决定性)**: descent **真打破了死冻**——`DESCEND 0,1 depth=1 → moved=1.6 y=65 pos=57,65,29`,bot 从 58,66,29 落到 58,65,30。**但暴露新互绞**: descent 落到 y65 后,**同一次 surfaceUp 的 `step-edge assist` 立刻把 bot 爬回 y66**(`y 65.00->66.00 settled=true`)→ y65↔y66 振荡,depth=1 浅腔只是相邻微口袋不是真逃。且 wideScan 实证此 spot **px/nx/nz 横向 14+ 全实心石头**——bot 挖进了山体实心石核,14 格内无洞穴。
- **★v3 修复(已落盘热加载,两改)**: ① **删浅 descent**(只 deep≥4 才下落,深腔=真洞;浅腔振荡无意义);② **核心: HOMEWARD CARVE**——无洞口时朝 spawn(0,87,树+地表,且山体朝那侧坡降)用 pathfinder `canDig=true` 横向掏 ~20 格(GoalNear 同-Y,**不需 tower,这正是 GoalY 上不去而横向能行的根因**),每次 call 掏一程;③ **wiring continue→break**——lateral 成功即 EXIT surfaceUp(不再 continue 进 climb 循环被 step-edge-assist 爬回),下个 C237 cycle 从新位置 fresh 重 carve,cumulative 出山。
- **预测(v3,可证伪)**: 下个 dawn(C237 night-gated,现 tod17772 夜)C237 fire 时应见 `lateral: CARVE homeward→40,65,20`,bot **朝 -x-z 横向位移数格**(pathfinder canDig 真掏石),几个 day-window 后 tunnels 出实心核到 home 侧地表/洞穴(enclosed→false,C237 自停,恢复正常 play)。**关键未验证假设: pathfinder canDig 能横向掏石**(垂直 GoalY 因缺 tower 料失败≠横向也失败,但需 live 确认);若 carve 也 moved=0 则改手写水平 tunnel(mineDown 横向版)。
- **v3 实测失败(02:37-02:40,决定性)**: `CARVE homeward→39,66,19` 但 **63ms 秒返回 moved=0**——pathfinder.goto(GoalNear horizontal, canDig=true) **根本不掏石**(没 throw 也没动,A* 瞬间判无路)。与 PRIMARY GoalY 的 `66->66` 一致 → **pathfinder canDig 在这环境对裸石完全不工作**(垂直/横向都不掏)。查 patch 确认 safeToBreak 只看 canDig+blocksCantBreak 不查镐,但经验压倒理论:A* 就是不碰裸石。
- **★v4 修复=手动 tunnel(已落盘,实测成功)**: 关键反证——**guardedDig 裸手破石是 WORK 的**(h>3 那次 `8 秒挖穿 y70 石顶`就是它)。故弃 pathfinder,改**手动逐格水平掏**: 沿 home 主轴(`|Δx|≥|Δz|→±x`)每步 guardedDig 挖前向 head+foot 两格(挖前设 `_plannedNoPickStoneUntil` 启用裸手石)→ lookAt+forward 走进 → 重复,8 格/call,hazard 逐格守(lava/water skip),无前进即停。mineDown idiom 的水平版。
- **★★v4 实测成功(02:40,决定性)**: `MANUAL-TUNNEL homeward -1,0 from 57,66,28` → vitals **pos 57→55→54→53**,bot **真在掏穿实心石朝 home 前进**(monitor [POS] 连续 -x)。**2h+ 死 pin 彻底打破**。cumulative across cycles → 出实心核。
- **预测(v4,可证伪)**: 后续每个白天 window bot 应继续 -x 掏 ~8 格/cycle 朝 home(x57→…→x0 方向),几个 window 后 tunnels 出山体到地表/洞穴(enclosed→false → C237 自停 → forageExplore/正常 play 恢复);或中途破入洞穴 → PRIMARY pathfinder 接管走开放路上行。**残留风险**: ① host=1 已现(hp5)——若 tunnel 破入怪所在洞需 ① 层 self_defense 接管(surfaceUp 退出后恢复);② 若一路纯实心到 x0 很慢(每昼夜仅白天 ~10min×8格≈数 window);③ tunnel 可能挖进更深 trap,届时 wideScan 重新选向。
- **★教训(本轮,4 次迭代取证驱动)**: ① "保护系统互绞"母题再现——descent(下)与 step-edge-assist(上)同控制流对冲,**脱困成功后必须 EXIT 让出控制权**;② **经验压倒理论**——理论上 pathfinder canDig 该掏石(safeToBreak 不查镐),实测就是不掏;**别信推断,信 live 遥测**,guardedDig 能破石(垂直已证)才是可依赖的原语;③ wideScan+EXIT-SCAN 遥测让我每 cycle 看清地形,4 次迭代(h>3→descent→pf-carve→manual-tunnel)逐步逼近;④ MC 昼夜 ~20min,C237 night-gated → 每昼夜仅 ~10min 验证窗,但 tunnel cumulative 不丢进度。
- **回滚**: ① `h>3` 去掉 `&& !trappedEnclosed`;② 删 wideScan/EXIT-SCAN;③ 删 lateralEscape 函数 + stuck 分支调用。纯局部,易回退。
- **待办(若 dawn 验证 lateral 有效)**: 考虑让 C237 在**纯横向**脱困时放宽 day-gate(横向掏洞无 surfacing-into-dark 风险,bot 全程地下);以及上游防止 bot 把自己挖进无料石棺(mineDown/digReset 下挖前检查脱困材料储备)。

## C240. ★★mineDown round()→floor() 取整 off-by-one 根治 -22,82,10 活 pin（③mineDown 热加载，🟡待 live 观测）
- **触发(自主接管取证)**: bot 在 -22~-23,y81~82,z9~11 食物荒漠口袋**连续 ~11h 不动**(deaths 自 11:20 冻在 377),progress 每 ~100s 刷 `★C232 SAFE-MINE EXIT → mineDown` 与 `no-regen → forageExplore` 交替,但 y 永远不降。交接报告归因"mineDown 没真下挖",根因待查。
- **★根因(mine_motion.jsonl + agent.log 取证,决定性)**: mineDown 是下行楼梯式挖掘器,每步在前向列 `(fx,fz)=(cx+sx,cz+sz)` 挖头顶/头/脚 3 格再走进下挖一格的台阶。agent.log 实录 **跑满 40 步、dug=93、pos 死钉 `-22,82,10`,`DIAG afterWalk moved dx=0 dy=0 dz=0`**,且狂刷 `Skipping block at x:-21.0 ... because it is air`(前向柱早挖空却进不去)。**机理 = `Math.round` 选错方块格**: bot 在 x=-22.30 时物理处于格 `floor=-23`,但 mineDown 用 `round(-22.30)=-22` 算 cx → 按格 -22 挖前向楼梯,bot 却站在格 -23 → 挖出的 1 宽斜道和 bot 真实所在格**错开一格**,bot 撞未挖侧壁永远进不去。`round≠floor` 在 `frac>0.5` 或坐标<0 时发生,正好这片负坐标 .3/.7 偏移的口袋全踩中。**叠加** line 107 的 no-advance guard 用 `|np.x - 格号| < 0.3` 判定,被稳定的 0.30 偏移完美绕过 → 空挖 40 步从不 abort(代码算出了真实位移 `moved=0` 却没拿来判)。
- **改动(③mineDown.js,热加载)**: ①**根因**: 格坐标 `cx,cz` 从 `Math.round`→`Math.floor`(正确 MC 方块语义),挖出的斜道对齐 bot 真实所在格,bot 能真正走进去下降;②**guard 修复**: no-advance 判据改用**真实每步位移**——`stepDescended=(cur.y-np.y)>0.5 || stepMovedHoriz=hypot(np-cur)>0.5`,两者皆无=本步卡住,连续 2 步即 honest abort `no descent — wedged`(从空挖 120 格变快速诚实返回,让上层能改派 relocate)。cy 保留 round(垂直非卡因,整数时 round=floor)。recenter 暂未加(floor 若不够再补)。
- **预测(可证伪)**: 重投 mineDown 后,**bot 应从 y81/82 真实下降**(mine_motion pos.y 递减 / vitals y≤78 / `[mineDown] reached targetY`),-22,82,10 的 11h pin 应在数分钟内打破(移动>10b 重置 watchdog+C234 anchor,deaths 仍 377 不应因此增长);若仍卡,新 guard 应在 2 步内打 `no descent — wedged` 快速返回(而非 40 步空挖),届时再加 recenter/上层仲裁。
- **观测**: 🟡 `node --check` 通过,fix 已落盘热加载就绪。**但 live 验证被我自己的扰动打断、未干净取得**:为强制热重载我投了 cancel_skill,恰逢夜间——cancel 把 bot 从 hp12 夜 bunker 拽出暴露窗口,一只 skeleton 贴脸(15:17:47 hp6@2.4),bot 逃到 y88,**掉到 hp4**,进入 critical no-regen hold,C232 SAFE-MINE EXIT 因 hp4<5 不再触发 → mineDown 这次没被干净调用。**教训(已记忆): 夜间/有怪近时投 cancel_skill = 把 bot 拽出庇护,危险;热重载等自然 dispatch(~100s)或仅在白天无怪时强制**。floor fix 仍部署,待 bot 回 hp≥5 挖矿时验证(或死后重生新局验证)。
- **回滚**: `cx,cz` 恢复 `Math.round`;no-advance guard 恢复 `Math.abs(np.x-cx)<0.3 && Math.abs(np.z-cz)<0.3`;删 noProg。纯局部,易回退。

## C245. ★C242/C243 重生 triage 窗口 `_sd<16`→`_sd<48`(夜重生时序 gap)（③missionNether 热加载，🟡待 re-arm 部署+验证）
- **触发(实测)**: death380 bot 夜里被 skeleton 远程射杀(逃出 C244 trap),重生回 spawn。但**夜重生→triage 夜间 gate→天亮前 bot 已 chopWood 漫游到 ~33-40b**(`-33,0`/`-40,-10`)→ `_sd<16` 窗口早关 → C242/C243 **没在 dawn 触发**,bot 又在 spawn 周边 wood-desert 死磕(树 17-25b 不可达)。
- **★机理**: C242 的 `_sd<16` 假设 bot 重生后**立即**触发,但夜重生有"夜 hold→天亮已漂出"的时序延迟,窄窗口接不住。
- **改动(③missionNether L391)**: `_sd < 16` → `_sd < 48`(48=旧 arming 半径)。安全性不变:仍由 `naked(inv≤8) + hp≥18 + 白天 + 无贴脸怪(<5b) + 5min节流` 多门 gate——只在 bot **裸装无本地进展**时才迁,正是该离开烂 spawn 的时刻。
- **预测(可证伪)**: C245 部署后,bot 夜重生→天亮即便漂到 20-45b,只要仍裸装/满血/无贴脸怪,应触发 `★C226-A fresh-respawn triage → migrate`(🛫),不再在 spawn 周边 chopWood 死磕整个白天。
- **观测**: 🟡 `node --check` 通过,已落盘。**待部署**: 需 re-arm;本想趁 daytime+host0 立即重启部署(bot 当时 -33,0 正好命中触发态),但取证瞬间 host 变 1+food 降→放弃强制(遵 [[cancel-skill-night-hazard]] 同理:有怪不动)。等下次 watchdog STUCK-ZONE cancel/restart 自然加载。
- **回滚**: `_sd < 48` 恢复 `_sd < 16`。

## 📋 C246 (新发现,待查)：bot.health 遥测卡死在 0(长途 migrate 后区块重载/entomb→free 急转)→ hp-gated 逻辑全冻
- **触发(06-18 实测)**: bot 远征 -140,89(165b)hp6+host 时"Outmatched 挖墙 digging-in"→ ENTOMBED,随后 **bot.health 读数卡死 0 持续数分钟**(deaths 不增、bot 仍活动、host=2 夜间没死→真实 hp 必>0,仅读数卡 0)。progress 多拍 `hp=0 food=12` 跑 prepNether stand-down / `[mobility] ENTOMBED no-regen safe-air gate hp=0`,mob 后转 FREE 但 hp 仍 0。
- **影响**: 所有 hp-gated 逻辑(venture/migrate 触发、ENTOMBED-dig-out、combat 判定)以为 hp=0 → 冻在最保守 hold,bot 对真实血量失明,可能在 night+怪 时误判致死。
- **根因推测**: 长途 migrate 跨大陆后**区块/实体重载** 或 **entomb→free 急转**时 mineflayer `health` 包没刷新,bot.health 卡 0。属 mineflayer/telemetry 层。
- **自解**: 已验证——死亡(384 Zombie)→重生重新同步 hp 即恢复;或受伤/愈合的 health 事件、watchdog restart 也可刷新。
- **修方向(待查)**: ① ws_server vitals 广播时若 `bot.health===0 && !死亡标志` 视为 stale、用上一非零值或标记 suspect;② 或在长途 migrate/区块重载后主动请求 health 重新同步;③ 或加"hp=0 持续>30s 且未死 → 强制 health resync / restart"兜底。需复现取证(长途 migrate + entomb 组合)。

## 📋 C244 (取证完毕,深 skill 设计,待清醒实现)：forageExplore/migrate 从某些 spot 发不出移动 → famine venture 空转、bot 物理不动
- **触发(C242/C243 部署后实测,act_trace+vitals+progress 交叉)**: bot food0/hp10 白天 host0 卡 -4,85,9。C228 FAMINE backoff/C230 famine-migrate/C233 desert-forage venture 机理**全部正确触发**(progress 日志为证:`FAMINE backoff → forageExplore`、`FAMINE forage no-result #3 (220b → more desert)`),但 **vitals 证明 bot 整窗口(tod2552→5872 ~3min)死钉 -4,85,9 零位移**。watchdog STUCK-ZONE 每10min cancel 但 re-arm 后重入同一冻结。
- **★根因(收敛)**: venture 被 dispatch 了但 **bot 物理发不出移动**。关键证据链:forageExplore 设 `_recoveryVentureUntil=now+180s`(让 ①famineBodyFreeze 让位),但 `FAMINE body freeze` 仍在 ~13s 后(17:02:37)触发 → 说明 forageExplore 在 ~13s 内就返回了(没走成,goToPosition NoPath 或秒拒)→ finally 清 flag → 冻身重启。`220b` 是 forageExplore 的意图/扫描射程,非实际位移。mob=FREE+covered=false → **不是封闭 pocket,是地形寻路从该点发不出**(崖/水/难地形 NoPath)。这是 hp10/food0 食物荒漠吸收态的真正剩余阻塞(与已修的 C241 hp<8 分支同母题但卡在 venture 的"动不了"而非"触发不了")。
- **修方向(待清醒设计,深 skill)**: forageExplore/migrate 检测到"原地 goToPosition fast-NoPath / N 秒零位移"时,应 ① 先 surfaceUp/dig-out 一格换可达性(C217c 对封闭 pocket 已有此 idea,需扩展到开阔但 NoPath 的地形),或 ② 换 bearing/目标点重试,或 ③ 上报"此点 marooned"信号让上层用 mineDown 凿离。**为何不即改**: 改 forageExplore/migrate 核心移动逻辑=高回归风险(它们是多处复用的恢复器),且交接书标 venture 区"待授权清醒设计";已连续 5 修 marathon,不疲劳手术关键深代码。bot 当前 frozen 但不死(easy hp10 floor)、裸装无损失,非紧急。
- **临时缓解(已有,部分有效)**: C242/C243 在 bot 偶尔回到 spawn≤16b 且 hp 满(罕见,需先脱此态)时可 migrate;watchdog STUCK-ZONE 25min 会 restart。但都绕不开"venture 从该点发不出"的核心。
- **★决定性证据(17:23 取证)**: `★C230 FAMINE-MIGRATE` 在 16:43/16:57/17:03/17:17/17:23 **fire 了 5 次,每次 `★FAMINE-MIGRATE done: settled=null moved=0b`**(migrate 跑 0.6s 即返回零位移)。过去 30min bot 仅 4 个 distinct (x,z) 位置。**bot 撑过整个昼夜无怪杀(survived night host0)→ 确认永久死锁,绝不自解**。且查证 **escapePlan 也用 goToPosition**(L24/34)→ forageExplore/migrate/escapePlan **三个恢复器全依赖 pathfinder**,全在此 spot NoPath;唯一用低层移动的 mineDown 需镐而 bot 裸装。mob=FREE(有本地可走格)但远目标 NoPath → 极可能**水/地形包围的小平台**(ocean food-desert)。
- **修复必须项(C244 真正内容)**: 给恢复 venture 加 pathfinder-trap 兜底——检测 `moved=0b`(连续 N 次)→ 低层移动脱困:① 朝 mobility 算出的 walkable exit 方向 setControlState 走几格(带 fall/water/lava 逐格安全探测,mineDown idiom)改变寻路原点;或 ② 若水围则 swim-to-nearest-land;或 ③ 标 MAROONED 让 digReset 凿离。**高回归风险**(改多处复用的核心 nav),flagged 深水,需 fresh 谨慎实现 + 离线 fixture 回归(escapePlan 已有 livelock fixture 范式)。**不在 5-修 marathon 末尾对核心 nav 动刀**(疲劳手术违纪)。

## C243. ★C226-A 重生 triage 的 hostile 门 catch-22(死亡门 spawn 必有怪→永不触发）→ 放宽到 point-blank（③missionNether 热加载，🟡待下次有怪重生验证）
- **触发(C242 v1 实测,决定性)**: C242 v1 在 15:46 watchdog 重启时已加载 live。16:06 bot 死亡(Zombie@16,83)重生到真实 spawn≈(8,-8),但 **C242 fire 0 次**——vitals 显示重生瞬间 16:06:28 pos=8,-8 **host=1**。
- **★根因(又一个同类 catch-22)**: C242 的触发门含 `actionableHostilesNear(12)===0`。**death-gauntlet spawn 必然在重生时 12b 内有怪(这正是它叫 gauntlet 的原因)** → hostile 门每次都让位 EVAC → EVAC sprint 40b 把 bot 移出 spawn → C242 的 `_sd<16` 窗口在怪清掉前就关闭 → triage 在最该 evacuate 的场景永不触发。与 C242 修的 arming catch-22 同构,只是换成 hostile 门。
- **机理洞察**: C226-A triage 在循环里**先于 EVAC**,且 migrate bearing **背离死亡簇**——所以"启动 migrate 本身就是 evacuation"(200b 远撤 > EVAC 的 40b)。fresh-respawn hp≥18 时走离非贴脸怪是安全的(migrate 自带 hp6 abort + 夜 bunker)。
- **改动(③missionNether L382,热加载)**: hostile 门 `actionableHostilesNear(12)===0` → `actionableHostilesNear(5)===0`——仅**贴脸怪(<5b)**才让位 EVAC;5-12b 环内的怪不再阻挡离开 spawn 的 migrate。
- **预测(可证伪)**: 下次 bot 死亡重生到 spawn(满血裸装)、且最近怪在 5-12b(非贴脸)时,应**首次出现** `★C226-A fresh-respawn triage → migrate off spawn`,bot 远撤≥150b(🧭 migration 里程碑);仅当怪贴脸<5b 时才先 EVAC。若仍 fire 0 次则 hostile 门外还有别的 gate(继续取证)。
- **观测**: 🟡 `node --check` 通过。**已部署 live**: 06-18 00:21 安全窗口(白天 tod2692+无怪+hp20)主动干净 watchdog 重启(杀 main.js+init_agent→watchdog 重生 pid42144@00:21:39,init_agent34388,48909 监听,vitals fresh,agent.err 无崩溃),C243+C241+C242 全套加载 live。等下次有怪重生验证 triage 首触发。
- **回滚**: hostile 门恢复 `actionableHostilesNear(12)===0`。
- **部署机制注记(重要)**: missionNether 是长循环 sticky,**死亡不重载**(循环继续跑),只有 watchdog 重启/cancel re-arm 才从磁盘加载新码。故 ③ 改 missionNether 后必须 re-arm 才生效(C240 mineDown 等被 customSkill `?t=` 调用的子 skill 则每次调用即重载,无需 re-arm)。安全 re-arm = 白天+无怪 时杀 main.js+init_agent 让 watchdog 重生(勿夜间 cancel,见 [[cancel-skill-night-hazard]])。

## C242. ★★C238/C226-A 重生 migrate 的 arming catch-22 根治（③missionNether 热加载，⚠️v1 实测被 hostile 门挡→见 C243）
- **触发(C240/C241 后 bot 死亡378重生,取证发现)**: bot 重生回烂 spawn(0,87,0,DEATH-ZONE 3死/16格)后**没远撤,又在原地死磕**(chopWood 树36b不可达 / prepNether)。查 C238(本会话另一并发会话写的 C226-A 重生 triage,标"未实战验")。
- **★根因(决定性取证)**: C226-A 触发需 `_c226Armed && _sd<16 && hp≥18 && inv≤8 && 白天 && 无怪`,但 `_c226Armed` **只在 `_sd>48`(离 spawn >48格)时才 arm**。grep 证实 **C226-A 从未触发过**(progress+.1 零记录),且 bot 最近200条 vitals 离 spawn 最远仅 **29.1格** < 48。**catch-22**: 触发需先逃离 spawn >48格才 arm,但 triage 的全部目的就是帮 bot 逃离 spawn → **卡在 spawn 附近<48格死磕的 bot(最该被救的)永远 arm 不了、triage 永不触发**。这正是 bot 反复在烂 spawn 死循环、deaths 一直涨的原因。
- **改动(③missionNether L370,热加载)**: 删除 `_sd>48` arm 前置 + `_c226Armed` 标志(仅此块用);改为**重生签名直接触发**——`_sd<16 && hp≥18 && inv≤8 && !night && 无怪 && 5min节流` 即 migrate。missionNether 每次重生 re-arm(sticky),故此=每次重生 ~一次 triage;5min fire-throttle 防 migrate 没relocate时 tight-loop。migrate 参数不变(`force,gateFood0,gateHp8,abortHp6,maxBlocks200,settleScore8`,bearing 自动背离死亡簇,到落点自动 setBed)。
- **预测(可证伪)**: 下次 bot 死亡重生(满血裸装回 spawn≤16格、白天无怪)时,progress 应**首次出现** `★C226-A fresh-respawn triage ... migrate off spawn death-gauntlet`,migrate 把 bot 带离 spawn ≥150格到宜居点(landAnimals≥2)并自动 setBed→重生锚迁出 0,87,0;不应再重生后在烂 spawn 原地 chopWood/prepNether 死磕。若夜间重生则等天亮当次循环触发(不再因 never-armed 永久漏掉)。
- **观测**: 🟡 `node --check` 通过,已落盘。**部署**: missionNether 循环体,需 re-arm 加载——下次 death/watchdog 重启自然生效(bot 当前已重生用旧码、正离开 spawn 觅食中,~46b)。
- **回滚**: 恢复 `if (_sd > 48) bot._c226Armed = true;` 前置 + `_c226Armed` 门 + `bot._c226Armed=false` disarm。纯局部。

## C241. ★★hp<8 食物荒漠"吸收态"出口:forage 连续失败→强制 settle-migrate（③missionNether 热加载，用户授权实现，🟡待下次荒漠卡死验证）
- **触发(C240 扰动后实测,act_trace+progress+vitals 三信号交叉)**: bot hp4/food9 白天(tod8772)host0,**完全 idle**(act_trace `ctrl:- act:- path:0 dig:-`),pos -24,88,11 静止数分钟。progress 钉死循环: `feedUp: critical local-only stop hp=4 food=9 — no long roam` + `prepNether HUNGER/LOWHP gate ... food did not improve (9->9)` + `★ADVISORY eat_now gated` + `★BREAKOUT gated`。
- **★根因(收敛,机理)**: hp4 食物荒漠是**多 abort-floor 互锁的吸收态**——①feedUp 在 critical hp 走 `local-only/no long roam`(防危急 hp 远 roam 致死,正当);②HP<8 LAST-RESORT venture(missionNether L1064)虽配 `forageExplore{gateHp:1,abortHp:1}` 能过门,但 5min throttle 偶发且 bounded 160b **escape 不出荒漠**(出去仍荒漠);③C230 famine-migrate 要 `food≤2` 且 `abortHp:6` → food9 不触发、即便触发 hp4<6 也自 abort。**净效果**: 太虚不能远 roam + 远征 bounded/自 abort + 本地无食 + food9<18 不回血 + host0 不死 = **冻死锁,只能等夜怪杀(→死→C238 重生 migrate,反而是设计内的解)**。
- **改动(③missionNether L1070 HP<8 LAST-RESORT 非封闭分支,热加载,用户授权)**: forageExplore 后捕获返回——`fr.found` 清零 `bot._lrForageFails`,否则累加。当 `_lrForageFails>=2 && !night && actionableHostilesNear(8)===0 && 5min节流` → 升级 dispatch `migrate{force:true,gateFood:0,gateHp:1,abortHp:2,maxBlocks:800,settleScore:12}`(force 短路 migrate 自身 hp/food 门;abortHp:2 留一丝;migrate 自带夜 bunker+bearing-lock+到落点自动 setBed)。`_recoveryVentureUntil=now+600s` 让 ①famineBodyFreeze 让位;migrate `settled || movedBlocks>=150` 则清零 fails。**机理**: hp<8 confirmed 荒漠时 staying=certain slow death,relocate 的 abortHp 保护是伪保护(不动也死)→ find-livable-biome 或 die-moving→重生(裸资产成本≈0)严格优于 frozen-forever。是 C230 food≤2 famine-migrate 的 **hp<8 对称分支**(触发器=hp<8+荒漠+卡住)。
- **预测(可证伪)**: 下次 bot hp<8 卡 confirmed 荒漠(feedUp 连续无食)、白天无怪时,progress 应在 2 次 forage fail 后打 `★C241 HP<8 DESERT-MIGRATE`,migrate leg-by-leg 行军 movedBlocks 持续增长,最终 `settled`(landAnimals≥2,自动 setBed)或 best movedBlocks≥150 移出≥150格;**不应再在 hp4 食物荒漠原地 idle 数小时**(act_trace `act:- ctrl:-`)直到夜怪杀。若残血 migrate 途中死亡率显著升高(因 abortHp:2 过低),则把 abortHp 提到 4 并加 hp<6 缩短射程。
- **观测**: 🟡 `node --check` 通过,已落盘。**部署**: missionNether 是长循环 sticky,本改动需 re-arm 才加载——bot 15:30 夜死已用旧码重生 re-arm,新 C241 在**下次 death/watchdog 重启**自然加载(遵教训不投 cancel)。当前 bot 已重生 hp20/food20 健康移动(0,81,-2),不在荒漠卡死态,无紧迫;C241 为下次 hp<8 荒漠卡死兜底。
- **回滚**: 删 `_lrForageFails` 追踪 + C241 migrate 升级块,恢复纯 forageExplore。纯增量,易回退。
- **历史诊断(取证完整,保留)**: hp4-5 食物荒漠吸收态多 abort-floor 互锁——①feedUp critical hp 走 `local-only/no long roam`;②HP<8 venture forageExplore bounded 160b escape 不出荒漠;③C230 famine-migrate 要 food≤2 且 abortHp:6,food9 不触发、即便触发 hp4<6 也自 abort。净效果=太虚不能远 roam+远征 bounded/自 abort+本地无食+food9<18 不回血+host0 不死=冻死锁。act_trace+progress+vitals 三信号交叉取证(2026-06-17 自主接管)。

## C239. ★实现 C226-C(c1)+C226-B1：手动sprint落差保护 + 裸装近处猎杀解锁设床（③missionNether+setBed 热加载，⏳待 node --check 后热加载）
- **触发**: 接 C238(C226-A)继续推进 C226 余项。死因取证中 fall 死(#371@0,-12 / #377@y77)+ "裸装永无床→永远烂 spawn 重生"(C226 机理③④)是 A 之外的两块。
- **★机理复核(对当前码,非 plan 旧行号)**: ①c1——missionNether 里**唯一绕过 pathfinder maxDropDown 的手动 sprint** 是 KILL-BOX expel fallback(goToPosition 卡住后 2.2s `forward+sprint+jump`),会朝 heading 冲下崖;EVAC 实为 `goToPosition` 腿(已带落差安全),fleeMove 已有 droppy——所以 c1 范围就这一处,且**在 ③ missionNether 里=可热加载**(plan 误标 ①)。②B1——`setBed._huntFit` 要 `石剑+ && hp≥16 && food≥8`,裸装(木剑)永过不了 → 猎不到蛛/羊 → 无 wool → 无床 → 永烂 spawn 重生。218/222 教训是"木剑低血**远征**100格送死",**近处(≤12b)被动目标白天用木剑安全**。
- **改动(均 ③ 热加载)**: **c1(missionNether KILL-BOX fallback)**: 手动 sprint 前用 fleeMove 同款 droppy 探测(脚下 heading 方向 1-4 格内无实心/水=ledge)→ 有 ledge 则 `★C226-C(c1) aborted` 不冲,让下一 iter 走 pathfinder。**B1(setBed)**: 新增 `_huntFitClose = 任意剑 && hp≥10 && food≥6`、`_huntRange = _huntFit?48:(_huntFitClose?12:0)`;蜘蛛猎(A)/羊猎(B)的门从 `_huntFit` 改 `_huntRange>0`、扫描射程改 `_huntRange`(羊 `_huntFit?64:_huntRange`)→ **木剑只在 ≤12b 近处机会猎杀**(远征仍需石剑+/hp16/food8,守 218/222)。
- **★根治链闭合(关键)**: migrate.js:351 落点后**已自动调 setBed**(先写 bed.json 锚点→setBed 建床设重生点)。故 **C226-A + B1 自动串成根治链**:死→migrate 远撤到 isSettleSite(landAnimals≥2,落点必有动物)→自动 setBed→B1 让木剑猎近处羊/蛛→wool→床→**重生点永久迁出烂 spawn**。B2 无需单独写。
- **可证伪预测**: ①KILL-BOX expel 卡住时,若 heading 是崖边,progress 出 `★C226-C(c1) ... aborted — >4b drop ahead`,**不再有 KILL-BOX 后紧跟 fall 死**;②裸装 bot 在有近羊/蛛的安全白天,setBed 不再 `no sword skip`/`defer`,而是 `attackEntity` 取 string/wool→建床→`bed.json` 锚点更新→后续死亡**重生点 ≠ 旧 spawn**(0,87,0),基地死亡簇消失。若 B1 致裸装 bot 远征猎杀摔死(_huntRange 误放 >12b)则证负回滚。
- **观测**: ⏳ 改动完成 + 人工复核结构干净;node --check 因命令分类器临时不可用暂未跑——**待分类器恢复 node --check 通过后才热加载**(绝不跳语法检查直接重投,语法错会崩 skill)。**回滚**: c1 删 droppy 块恢复直接 sprint;B1 删 `_huntFitClose`/`_huntRange` 恢复 `_huntFit` 三处(纯增量)。
- **遗留**: C226-C(c2) Movements maxClimb(① 重启,plan 标"可后置单验",mineflayer-pathfinder 无干净 maxClimb、乱改废寻路)——观察 A+c1+B1 见效后再单独验;届时连同两个 watchdog(43260+34712 singleton 没杀净)一起在重启窗收拾。

## C238. ★实现 C226-A：重生即 migrate 远撤——破"裸装重生→基地死亡 gauntlet"快循环（③missionNether 热加载，🟡待下次重生验）
- **触发(本会话 live 取证,#369→#377 九连死)**: 接管自被 kill 的并发会话。监工实测 deaths 369→377 ~1h,死因簇:`Drowned@157,170` / `shot:Skeleton@36,149` / `fall@0,-12` / `drowning@20,-27` / `shot:Skeleton@9,34`(基地脚下)/ `Zombie@-260,-275` / `fall@y77`。**关键:循环已收缩到重生点 30b 内速死**(基地 `0,0` 周边有摔死洞 `0,-12`、水体 `20,-27`、夜怪坑),裸装重生 bootstrap 来不及武装就被本地 hazard 杀,7-8min 一条命;偶尔 pathfinder 翻山到高 y 夜暴露/摔死(C226 机理②③)。
- **★机理(沿用 subagent adbb51dcb4d7f6165 的 C226 设计)**: 重生点在 dzone 外 ~41b → KILL-BOX/leave_zone 撤离不触发(`d0<z.r` 假);真凶 = 重生→pathfinder 为避 >2 格下降反而翻山登顶(maxDropDown 只限下降)+ 摔死在非寻路手动 sprint 路径(fleeMove/KILL-BOX/EVAC,裸装无水桶 MLG);setBed 因 `_huntFit` 要石剑、裸装永过不了 → 无床 → 永远原点重生。C226-A 是其落地链首选:**满血窗口主动远撤,把 bot 移出凶宅**。
- **改动(③missionNether 主循环 interrupt 检查后、EVAC 前,热加载)**: 加 fresh-respawn triage——`bot.spawnPoint` 存在 + overworld 时,`_sd>48` 置 `bot._c226Armed=true`(离开过才武装);满足 `_c226Armed && _sd<16 && hp≥18 && invTotal≤8 && 白天 && actionableHostilesNear(12)===0` → `migrate{force:true,gateFood:0,gateHp:8,abortHp:6,maxBlocks:200,settleScore:8}` 远撤 + `continue`。**arm/disarm 保证每次 death→respawn 恰触发一次**(离开>48b 武装、回 spawn<16b 满血裸装时开火、开火即 disarm)。门控保守:有怪让位 EVAC(hostiles>0 skip)、夜间不远征、geared 返家(inv>8)不误触发。
- **可证伪预测**: 下次死亡重生后(满血、裸装、白天、spawn 附近、无怪),progress.txt ≤数秒出 `★C226-A fresh-respawn triage ... → migrate off spawn death-gauntlet`,bot **移出 spawn 30b 凶宅区**(不再原地 bootstrap 速死);基地簇死亡(fall@0,-12 / drown@20,-27 / 夜怪@9,34)应显著减少。**残留(C226-A 不覆盖)**:migrate 途中若 pathfinder 仍翻山/手动 sprint 冲崖 → 摔死,需 C226-C(①重启);新落点裸装无床 → 仍回旧 spawn 重生,需 C226-B2 设床。若 deaths 不降或 migrate 途中摔死增加则部分证负。
- **观测**: 🟡 `node --check missionNether.js` 通过;12:32:40Z 投 `cancel_skill` 触发热加载,missionNether 已返回进入 sticky 重投。**C226-A 仅在下次死亡重生触发**,等监工 `★C226-A`/migrate 实证。**回滚**: 删 missionNether interrupt 检查后的 C226-A try 块(纯增量,热加载即回退)。
- **遗留(C226 余项,我接着做)**: C226-C(①pathfinder maxClimb + 手动 sprint droppy 落差检测,需重启窗——届时先收拾两个 watchdog 防竞争)→ C226-B2(migrate 落点设床,根治重生点迁移)。落地顺序按 subagent 设计:A→C-c1→B2。

## C237. ★★★无镐+封闭+低hp 终态永冻 → 安全向上脱困（③surfaceUp+missionNether 热加载，🟡待白天窗 live 验；用户授权 fresh 实现）
- **触发(本会话 live 取证,第六原则当场取证)**: vitals 实时——bot **hp6/food17 @-32,66,194 y66 封闭**(`mob=FREE/ENC`=state FREE+enclosed),`pickFx:0`,inv=`cobblestone 209 / furnace1 / wooden_sword1 / stone_sword1 / dirt83`,**0 镐 / 0 原木 / 0 plank / 0 stick**。每 9s 死刷 `prepNether TABLE gate no wood`+`not kitted→prepNether`。结合 C235(watchdog 整夜同一点 -32,66,194/hp6/food17 每 ~10min cancel→sticky 重派但救不了),这是**持续数小时的终态冻结**——纯净的 C229 软锁现场。
- **★机理(三道闸全堵,subagent+源码取证)**: 无镐 bot 封闭地下,**唯一恢复路径=向上到地表**(够树→补木→重造链;或地表也荒则暴露后可死亡重置,胜过吸收态永冻)。但:①**C232 安全挖出口要 `hasPick`**(向下挖且要镐)→无镐 skip;②**C229 补木/C233 venture 全 gate hp≥8**→hp6 进不去;③**surfaceUp 自己在 hp<8 封死破顶**(`canPlanNoPickStoneBreach` L629 `trappedEnclosed && hp<8 → return false`——L628 本已为 trapped 放宽 hp<16/food<14,但 L629 又在 hp<8 切断)。三闸叠加=无镐+封闭+hp<8 没有任何出口=永冻。`digReset.js`(hp≤6 死亡重置)存在但 **grep 全工程零派发**(missionNether 不调它),机制空转。
- **★洞察**: 向**上**破顶=**零死亡风险**(L630 stableFloorBelow 保证无摔落、L632-634 水火岩浆守卫、封闭=无怪够到、surfaceUp 爬升期 freeze 所有生存模式无 ① veto),与 hp 无关;唯一残留风险=破到夜空被怪杀→**白天破顶即安全**。"find beats frozen" 在"无镐封闭低hp"场景的落地(C217/C224 同理)。用户选"实现安全脱困机制"(非死亡重置)。
- **改动(均 ③ 热加载,无需重启)**: ①**surfaceUp.js canPlanNoPickStoneBreach(L629)**——`trappedEnclosed && hp<8` 破顶改为**仅夜晚才拒**(`breachIsNight` 读 bot.time;白天放行徒手破顶逐格上浮)。②**missionNether.js C232 块后**加 `noPickContainedEscape()` gate(C232 的无镐姊妹):`无edible + 白天 + hp<14&&food<18 + 无镐 + 封闭 + actionable12=0 + y<72 + 脚头非水火` → dispatch `surfaceUp(min(90,max(72,y+12)))`。**安全**:白天+无怪+非nether;surfaceUp 自带 freeze 模式(无需 `_recoveryVentureUntil`,与 forage/migrate 不同)+ canDig=enclosedNoPick 徒手破 + 209 cobble 架柱兜底。无镐时 C232(向下)让位给 C237(向上)。
- **可证伪预测**: missionNether 下次 sticky 重派(watchdog ~10min cancel→sticky 自动加载新代码)后,bot 在**白天**仍 hp6/食物荒漠封闭无镐时,progress.txt 出 `★C237 NO-PICK ESCAPE → surfaceUp`,surfaceUp.log 出 `planned no-pick stone breach`,**y 从 66 持续上升出地表(y→72+)**,脱离 `TABLE gate no wood` 死刷;到地表后 feedUp 可够到动物→food→18→回血→hp 爬出危险区→C229/C233 窗口打开。夜间仍不破顶(预期,安全)。若 y 不升或夜间破顶则证伪。
- **观测**: ✅**端到端 live 验证成功(04:55-04:57)**:missionNether 04:55:44 sticky 重派加载新代码即触发 `★C237 NO-PICK ESCAPE: no pick + enclosed + no-regen (hp=6 food=17 y=66) → surfaceUp`,`ENTER y=66 target=78`(=`min(90,max(72,66+12))`)。surfaceUp.log 铁证 **hp6 徒手破石** `planned no-pick stone breach 7/8/9/200 at h=2/3 name=stone`(老代码 `hp<8 trapped return false` 绝不破石→破石成功=L629 放宽生效),**y 66→81→82→83→84(+18格)**,耗 11 cobble 架柱(209→198)。入夜(tod 跨13000)后 `blocked at h=2 stuck` `EXIT y=84`——**我的 breachIsNight 夜间门正确拦住破顶**,bot 停 y84 等天亮(enclosed 过夜安全,怪够不到)。**数小时 y66 终态永冻已破。** `node --check` 全过。
- **★自纠 bug(同会话立修)**: 原 gate 有 `if (y>=72) return false`(防"已在地表带"),但 bot 现 **y84 仍 enclosed**(头顶还有石、没到真地表),此条天亮会误拦 C237 续爬→卡死 y84。**`enclosed` 检查才是正确判据**(到真地表 enclosed=false 自然不触发,surfaceUp 亦 idempotent)→删除 y>=72 守卫。修正待下次 sticky 重派加载,天亮 C237 应从 y84 续爬出真地表。
- **回滚**: 删 surfaceUp 的 breachIsNight 三行(还原 `hp<8 return false`)+ missionNether 的 noPickContainedEscape gate+dispatch 块(纯增量)。
- **遗留(下次)**: digReset 仍无派发器(可作 C237 surfaceUp 反复无果后的终极兜底:无镐封闭白天 surfaceUp 失败 N 次→若 hp≤6 派 digReset 死亡重置);C229② tool_keeper 反射加固(①重启)。

## C236. ★★★#33 食物荒漠收敛根治：实现 📋C233 venture 触发空档 + 📋C229 木材反向路径（③missionNether+achieve+prepNether 三处热加载，🟡待 live 验）
- **背景(实现 📋C233 + 📋C229 两条蓝图)**: 本会话 fresh-context 落地两条已充分取证的 PLANNED 结构修复。核心是用户 #33 愿景"像人类跨大陆找安家地"的触发逻辑,+ 收敛掉 bot 在食物荒漠反复 pin/churn 的两个根因(venture 触发空档 + 木材软锁)。
- **改动 1 — C233 venture 触发空档(③missionNether.js:1094 之后,FAMINE backoff 块的 `else` 分支,热加载)**: 长程 venture 原只有两个触发器,都够不到"健康但局部饿"区:①FAMINE backoff 要 `food≤2`(或 hp≤8&&food≤6);②HP<8 last-resort 要 hp≤8。**hp≥8 且 food 3~13 = 触发空档**→bot 食物荒漠局部 feedUp(animal64=none)/原地挖/prepNether defer-loop 钉死,慢慢饿到 food≤2 或夜死,从不远征。**单一收敛触发器**:复用 feedUp 已有的 `feedUpDryNoFood()` 信号(64格 huntable 扫描为空 + 位置局部 + TTL 新鲜 = 设计要的 animal64=none)+ `food<14` + `hp≥8` + 安全白天 + 无怪16 + 非nether → dispatch `forageExplore{gateHp:8,gateFood:0,abortHp:6,targetFood:18,maxBlocks:220}`,**共享 `_famineForageFailCount` 计数器**:连续 found:false ≥2 次 → 升级 `migrate{force:true,gateFood:0,gateHp:8,abortHp:6,maxBlocks:800,settleScore:12}` 跨群系搬家。复用 C228/C230 已验证的 `_recoveryVentureUntil` 让位机制对抗 ①famineBodyFreeze。**安全**:hp≥8+白天+无怪+forageExplore/migrate 自带 night/hostile/hp-abort 门;绝不低 hp/夜晚远征(防 C225 explore-and-die 级联)。
- **改动 2 — C229 ①治本 recraft-gate(③achieve.js exposeMore 顶部,L824 之后,热加载)**: 系统所有补木逻辑都要"已在地表+健康+有木",缺"深挖途中木材耗尽→爬回地表补木"的反向路径(06-16 02:50 强复现:y-60 镐断+0木+0stick→造不出棍→重造不了镐/台→prepNether `TABLE gate no wood` 死循环)。在 exposeMore(branchMine/digDown dispatch 的唯一入口)顶部加**预防性 gate**:`picks≤1 && !(cobble≥3 && sticks≥2) && woodEq<8` 时**不深挖**——`optionalWoodSafe().ok`(地表+白天+无怪+hp/food)则 surfaceUp+chopWood 补到 woodEq≥8;不满足安全门则**就地停挖+hold return false**(绝不徒手深挖磨光最后一把镐成软锁)。
- **改动 3 — C229 ③兜底 真 chopWood(③prepNether.js handleTableRecoveryBlocked surfaceUp 后,热加载)**: 原 TABLE-recovery fallback 只 `surfaceUp(63)` **只爬不砍**(L661),爬上地表后仍 wood-blocked。补:surfaceUp 后若 `heldLogs<2 && maxHeldPlankStack<8` 且 `optionalWoodSafe().ok`(其门含 hp>14/无夜/无怪/食物)→ 真 `chopWood(4)`。这是反向木材路径的**前向半段**(achieve gate 拒绝磨镐=预防,这里=爬上来真补木)。低 hp/夜/有怪静默跳过让位生存(尊重 📋C229 风险点:补木分支不 gate 会过度干预致死)。
- **可证伪预测**: ①bot hp≥8/food 3~13/白天/无食/无怪 时,progress.txt ≤90s 内出 `★C233 DESERT-FORAGE`+pos 移动>16格(不再原地 hold/mine 钉死),连续 2 次无果出 `★C233 DESERT-MIGRATE` 跨群系行军;②bot ≤1 镐+无 cobble/stick+woodEq<8 时,在地表出 `★C229 RECRAFT-GATE ... restock wood`(地下则 `HOLD refuse deep-mine`),motion `achieve.recraft_gate.*`,**绝不再出现 0 镐 0 木深挖软锁**;③TABLE-recovery 爬上地表后出 `★C229 TABLE recovery ... chopWood`,woodEq 回升脱 TABLE gate。若 venture 后 deaths 因白天 forage 遇险增长则收紧 gate(提 hp 门/缩 maxBlocks);若 recraft-gate 误拦健康挖矿(woodEq≥8 时触发)则证负。
- **观测**: 🟡 `node --check` 三文件全过;均 ③ 热加载下次 dispatch 即 live(无需重启)。**回滚**: 改动1删 missionNether FAMINE 块后的 `else` 分支;改动2删 exposeMore 顶部 RECRAFT-GATE try 块;改动3删 handleTableRecoveryBlocked 的 C229 chopWood try 块(均纯增量,热加载即回退)。
- **遗留**: 📋C229 ②反射加固(tool_keeper 料尽设 `_toolKeeperNeedsWood` 标志,①modes.js 需重启)未做,留下次重启窗口;C232 mineDown 全封闭不 relocate 时升级 branchMine/forageExplore 的 refinement 亦待办。

## C235. ★bridge.mjs WS 重连加固：有界指数退避 + AggregateError cause 解包 + 去重断线日志（③tooling bridge.mjs，✅热部署生效）
- **触发(整夜 events.log 取证)**: 用户报"整晚反复退出重进"。全文件累计 `bridge_disconnected×1937 / bridge_error×1658 / AggregateError×1658 / bridge_connected×296`,比例 ~6.5:1;遍布每天每小时。深挖发现**风暴呈 ~26min 规律节拍**——watchdog.log 自 09:10 起连续 7+ 次清一色 `RESTART (STUCK-ZONE - bot pinned within 10b for 25min at -32,66,194)`→`relaunched node main.js`,三次重连后 bot 状态(`pos=-32,66,194 hp=6 food=17` + 库存)**一字不差**,`deaths=366` 不增长。
- **★机理(WS 风暴=下游症状,非 bridge bug)**: 真因是 **C229 木材锁 + C233 venture 空档** 的策略层 livelock——bot inv 无任何镐/无木(planksEq=0/logs=0)/无铁,在 y66 封闭区:missionNether 判"not kitted"→prepNether 要 iron_pickaxe→要铁要挖矿(无镐挖不了)→要造镐要木棍要木板(无木)→`TABLE gate no local table`/`defer shield underground don't surface`→空返→missionNether 再判 not kitted→死循环原地空转。bot 25min 不移动→watchdog STUCK-ZONE 重启 agent→48909 socket 掉→bridge 失连→重启 gap 内 localhost(::1+127.0.0.1)双双 ECONNREFUSED→Node happy-eyeballs 包成 `AggregateError`→重连→bot 重投 missionNether 同点重锁。**bridge 只是忠实重连器**,但自身有三处放大缺陷。
- **★bridge 三缺陷(`bots/_supervisor/bridge.mjs` connect())**: ①**固定 3s 无退避**:重启 gap(~15-25s)内每 3s 死撞,长时 outage(如 watchdog 自身挂)永久 20 行/min 刷屏。②**error+close 双重日志**:每次失败尝试 ws 先 emit `error`(记 bridge_error)再 emit `close`(记 bridge_disconnected),失败的"重连尝试"伪装成"断线"→disconnected 计数虚高、与真实断线混淆(这就是 1937 disconnected 远超 296 connected 的来源)。③**AggregateError cause 被吞**:`String(e.message)` 只得到光秃秃 "AggregateError",无法区分预期的 ECONNREFUSED(重启 gap,正常)与真故障(端口冲突/server bug),诊断全盲。
- **改动(③bridge.mjs,热部署=杀进程 watchdog 自动重生)**: ①**有界指数退避**:`reconnectDelay` 从 2s 起 ×2 封顶 **8s**(紧上限——常见就是 ~15-25s 重启 gap,要保持 snappy,端口回来后 ≤8s 重连),**每次成功 open 即复位**;`scheduleReconnect` 加 `reconnectTimer` 单飞守卫(error+close 同尝试只排一次重连)。②**去重断线日志**:加 `wasConnected` 旗标——只有**真活过的 socket 掉了**才记 `bridge_disconnected`;失败的重连尝试不再伪装断线 → disconnected 计数从此 1:1 等于"agent 真宕"。③**cause 解包**:`describeErr()` 拆 AggregateError 的 `.errors[]`/`.cause`/`.code`,日志变 `AggregateError [ECONNREFUSED]` 之类。④**error 节流**:每次 outage 首条必记(带 cause + nextRetryMs),之后 ≤1 条/30s,长 outage 不再刷屏。
- **预测(可证伪)**: 下次 watchdog 25min 重启时,events.log 该窗的 bridge_error 应**从 ~5-6 条降到 1-2 条**且带 `[ECONNREFUSED]` cause;`bridge_disconnected` 在"失败重连尝试"中**不再出现**(只在真断线时 1 条);长 outage 不再每 3s 刷。**但风暴节拍(~26min)不会消失**——那是 watchdog 重启 livelocked bot 的产物,要彻底止住必须破 C229 木材锁/C233 venture 空档让 bot 离开 -32,66,194。若 disconnected 仍随每次失败尝试翻倍,则 wasConnected 旗标失效。
- **观测**: ✅**已验证**。`node --check` 通过;热部署:杀旧 bridge pid 27892,watchdog 30s 内重生新 pid **37092**(CreationDate 12:30:46),04:30:46Z 干净上线。**恰逢 12:32 一次重启(watchdog `agent DOWN 48909 not listening`,实为并发会话部署 C236 杀 agent 所致)给出完美前后对比**:旧风暴(04:16)= disconnect×5+error×4+connected ≈ **10 行**;新风暴(04:32)= `bridge_disconnected`×**1** + `bridge_error "AggregateError [ECONNREFUSED]" nextRetryMs:4000`×**1** + `bridge_connected` = **3 行**。三预测全中:①去重生效(disconnected 仅真断线 1 条,失败重连不再伪装);②cause 解包成功(`[ECONNREFUSED]` 坐实重启 gap localhost 拒连,非 bridge bug);③退避生效(2000→4000)。一次重启日志量 10→3 行。**风暴节拍此前如预测仍在**——但底层 C229/C233 已由并发会话 C236 实现修复(🟡待 live 验),若 C236 让 bot 离开 -32,66,194 则节拍亦随之消失,本条 bridge 加固确保残余重启窗的日志清爽可诊断。
- **★旁证(并发活动+延迟生效教训)**: 排查中发现 12:16 watchdog 重启后 kick 仍每 60s 刷旧消息(无 `kick #N`)、`PERSISTENT PIN` 0 次 → 那个 agent 跑的是**旧 modes.js**;modes.js mtime=12:28:11、CHANGELOG 同期被外部改写(均非本会话)→ 确有另一会话/actor 在动同一 working tree。**教训复发(记忆已记"多会话抢同一 session")**: 并发改 working tree + watchdog 自动重启 = "改了 disk 但 live 没生效"的窗口;验收必须比 `进程 CreationDate > 文件 mtime`,不能只看 `node --check` 通过。
- **回滚**: 恢复 connect() 为原 `setTimeout(connect,3000)` 单行 + `String(e.message||e)`,删 backoff/describeErr/wasConnected/outageErrLogged 诸状态。纯增量,易回退。

## C234. ★reflex_watchdog pin-breaker 从"每分钟无限同款 kick"改为退避+升级（①modes.js pin-breaker + ws_server vitals，需重启）
- **触发(整晚 events.log 实测)**: bot 在食物荒漠 hp6/food17 无木卡 prepNether(C229/C233 底层 stuck),pin-breaker 每 ~1min 死循环刷:`Pinned 15min+ — kicking the stack (forced interrupt)` → `skill_result missionNether cancelled` → bridge 8s 后 `sent_sticky_skill missionNether` → 立刻重入同一死锁 → 1min 后再 kick。**活锁空转**——kick 治标不治本(底层是资源死锁非软件 pin),还和 bridge 断线重连风暴叠加。
- **★机理(modes.js:2184 reflex_watchdog pin-breaker)**: 处置逻辑是"pinned>5min 后**固定每 60s** kick 一次,每次只 cancel 当前 sticky + 清控制状态"。但 cancel 触发 bridge.mjs 的 sticky 重挂(`skill_result` 非 busy → 8s 后 re-arm 同一 skill),重挂即重钉。kick 本是为破"挂起的 await"(让 loop honor interrupt_code 返回 BREAKOUT),但对**不可破的资源死锁**,固定频率无限重复 = 纯空转。**违反"活锁要么收敛要么升级,不能无限同样重复"**。本 task 只修 watchdog 处置策略,不碰底层 stuck(C229/C233 另办)。
- **改动(①modes.js,需重启)**: 三层。①**收敛-退避**: 加 `pinKickCount`,kick 间隔从固定 60s 改 `min(60000·2^count, 8min)`(1m→2m→4m→8m 封顶);bot 一旦离开 pin 区(anchor reset)或进入正当 shelter-hold,计数清零、cadence 复位 → 有效的 kick 不付退避代价。②**升级-信号**: count>3(kick 4 次仍钉死同 10 格)判定 PERSISTENT PIN,停掉每拍 chatty 叙述,改写一条醒目 `★PERSISTENT PIN — N kicks ineffective` 到 progress.txt(带 hp/food/skill/mob),并置 `bot._persistentPinKicks/_persistentPinSince` 供上层消费;interrupt 仍按 8min 退避 cadence 保留(给 BREAKOUT 留机会,不彻底放弃)。③**信号可见**: ws_server vitals 广播加 `pinKicks` 字段(=`_persistentPinKicks`),让监工多信号交叉(vitals.json)直接看到升级信号,无需 grep progress.txt。真正破不可破 pin 的手段=上层派 relocating recovery(forageExplore/escapePlan),反射层不自派命名 skill(三层职责:反射层检测+破楔+升级,不做策略)。
- **预测(可证伪)**: 再钉死时 events.log **不应再每分钟无限 kick**——首 kick 后间隔应递增到 8min 封顶(同一 pin 窗口内 1h 至多 ~10 次 kick 而非 ~60 次);kick≥4 次后 chat 出现一次 `PERSISTENT PIN — N kicks ineffective`(而非继续刷 `kicking the stack`);vitals.json `pinKicks` 在持续 pin 时 >3 递增,bot 离开 pin 区后归 0。若仍每 60s 等频 kick 则退避未生效;若 pinKicks 永 0 则计数器/字段未接通。
- **观测**: 🟡 `node --check src/agent/modes.js` 与 `node --check src/websocket/ws_server.js` 通过。等重启 live 后整夜观测 events.log kick 频率。
- **回滚**: modes.js kick 间隔恢复固定 `60000`、删 `pinKickCount`/PERSISTENT-PIN 分支与三处计数清零;ws_server 删 vitals `pinKicks` 字段。纯增量,易回退。

## 📋 C233 (✅已由 C236 实现 — 见顶部 C236 改动1)：famine 与 HP<8 之间的"长程 venture 触发空档"——所有可持续 pin 的共同根因
- **多拍取证(自主 loop)**: 本会话 bot 反复陷"可持续 pin"——hp17/food3、hp10/food16、C232-mining-in-place(@0,75 firing 20次/cobble累到44 但 y75 不 relocate)。共同特征:bot **健康(hp≥8)但食物荒漠局部无食(`animal64=none`)**,却**没有任何机制派长程 forageExplore/migrate 去远方找食**。
- **★根因(收敛)**: 长程 venture 的触发器只有两个,都够不到这个区:① famine backoff 要 `food≤2`(C230);② HP<8 last-resort 要 `hp≤8`(C217)。**hp≥8 且 food 3~16 的"健康但局部饿"区 = 触发空档** → bot 只能局部 feedUp(64格无果)/C232 原地挖 cobble(sustainable 不进展)/prepNether defer-loop,**永不远征找食** → 钉死直到 food 慢慢耗到 ≤2(慢)或夜死重置。
- **修方向(#33 核心,待授权)**: 加"**食物荒漠确认 + 卡住 → 长程 venture**"触发器:`feedUp 报 animal64=none 连续 N 次(或 pos ~不变 N 分钟)+ food<14 + 安全白天 + hp≥8 + actionable=0 → dispatch forageExplore(无果再升级 migrate)`。这是覆盖所有空档的**单一收敛修复**(非逐个 band-aid),且是 #33(跨群系找宜居家)的核心触发逻辑。forageExplore 在 hp≥8/白天 自带安全门,低风险。
- **为何 PLANNED 不自主做**: 是实质新触发机制 + 用户明确的 #33 核心愿景,该清醒一起设计(触发阈值/pos-history/与 C232/C230 的交互);bot 当前 sustainable(hp10/food16 挖 cobble 不死),非紧急。**C232 附带 refinement**: mineDown 在全封闭格不 relocate 时(K 次 pos 不变)应升级 branchMine/forageExplore,而非空转原地挖。

## C232. ★★no-regen 持镐封闭"保守 hold"吸收态永冻 → 安全就地挖矿出口（③missionNether 热加载，✅即时 live 验证成功）
- **触发(实测,自主 loop 取证)**: bot hp6/food13 在 y65 封闭石头掩体,持 stone_pickaxe,12-16 只怪全 nonactionable(够不到),**永冻 50min+ 跨多昼夜不死不动不产出**。progress 钉死 `[unstuck] no-regen contained hold ... enclosed=true covered=true` + `prepNether defer shield/TABLE gate no wood` 循环。food13≠0 → C228/C230 famine venture 不触发(死区盲点)。
- **★机理(subagent aea2b1c 取证)**: 死锁在 ③ prepNether 层——它把"无木无台造不了 iron_pickaxe/shield"当成**必须先上地表补给**,但 hp6 锁死所有上地表出口(`normalSafeDay` 要 hp≥14、`noRegenDeadlock` 要 hp8-13)→ enclosed+hp6 = 补给不了 + 不肯就地挖 = 吸收态永冻。MAROONED 凿离不触发(任务层全 `wait+continue` 不发寻路→`noPath` 信号断流,记忆里记过的"独占门饿死信号"复发);BREAKOUT 不触发(missionNether L885 顶部 no-regen backoff `wait(12000)+continue` 抢在 4min 钉住判定前短路)。
- **★洞察**: bot **持镐+封闭在石头里+怪够不到** 时,**原地下挖是零死亡风险**(无摔落、怪碰不到),且能 ①产出 cobble/raw_iron(脱 TABLE-gate)②朝远离最近怪方向凿离 mob-magnet。"保守 hold 在能安全产出时不该全冻"——C228 通则在"持镐封闭"场景的落地。
- **改动(③missionNether:884 L885 backoff 短路前,热加载)**: 加 `safeContainedMineExit()` gate(`no edible + hp<14&&food<18 + hp≥5 + 持镐 + enclosed/有顶 + actionableHostilesNear(12)===0 + 脚头不在水火 + 非nether`)→ dispatch `mineDown{targetY: max(48, y-14)}`(45s 节流,`bot._climbingAt` 防 MAROONED 误判打断)。**安全**: mineDown 自带逐格 water/lava/support/摔落探测 + hostile<4 bail + 朝远离怪方向,失败退 `digDown(bot,2)`(同带安全探测)。
- **观测**: ✅**即时 live 验证成功**:cancel 重挂 missionNether 后 progress 出 `★C232 SAFE-MINE EXIT ... → mineDown 安全凿离`,**y 65→64→63 下降中**,50min+ 永冻破除,deaths 仍 361(无淹/烧死=安全探测生效)。`node --check` 通过。
- **预测(可证伪)**: bot 此后在 enclosed/hp6/food13/怪够不到 不再刷 `no-regen contained hold`/`defer shield`,而是 `★C232 SAFE-MINE EXIT`→y 持续下降/水平移动凿离、cobble/raw_iron 增长;绝不应出现挖矿后 drowning/lava 死亡(若有则 mineDown 安全探测被绕过,改直调 digDown)。
- **回滚**: 删 `safeContainedMineExit` helper + dispatch 块(纯增量),热加载即回 C228 现状。
- **遗留**: 仍未解的 C229 木材锁(无木→无台→造不了 iron_pickaxe)依旧在;C232 让 bot 产出 cobble+下挖找资源,但要彻底脱 TABLE-gate 仍需 C229 补木。mineDown targetY floor=48,到底后若再 enclosed-stick 是新状态待观察。

## C230. ★★★#33 食物荒漠根治:famine venture 升级 forageExplore→migrate 跨群系搬家（③missionNether 热加载，🟡待白天 food0 验证；用户批准 fresh 实施）
- **触发**: C228 venture-exit 上线后实测——forageExplore 触发并把 bot 移动 ~120格,但**射程 maxBlocks=220 太小,出去落到另一片荒漠**(`feedUp.leaf_sweep.none`、无动物),food0 无解,陷"觅食-失败"循环。**死亡重置不可靠**(用户取证:bot 在"有怪但够不到"的点 36min+ 不死也不脱困;overseer 快照证实 creeper@18.3 没够到)。
- **★机理(subagent a6a3cf3 设计)**: migrate.js 本是成熟远程移动器(C222 验证)——bearing 锁定不绕圈、hop-march、`isSettleSite` 硬要求 landAnimals≥2+非水域+score≥阈值、夜 bunker、hp-abort、**到落点自动 setBed 衔接**(覆写 bed.json 锚点+设重生点)。**唯一缺口=三个 migrate 入口全卡 `hp≥14 && food≥6`→food0 famine 时进不去**。
- **改动(③missionNether C228 FAMINE backoff 内,热加载)**: ①**跨-venture 失败计数器** `bot._famineForageFailCount`:forageExplore 返回 `found:false` 累加、`found:true` 清零(撤销搬家意图);②**升级分支**:`safeDayVenture && failCount>=2 && 300s节流` → dispatch `migrate{force:true,gateFood:0,gateHp:8,abortHp:6,maxBlocks:800,settleScore:12}`。force 短路 migrate 自身 hp/food 门;food0 安全(easy 饿伤止 hp10>abortHp6、夜 bunker);`_recoveryVentureUntil=now+600s` 让 ①famineBodyFreeze 让位(白名单已含 migrate,C228 机制)。返回字段亲验:forageExplore `{explored,found}`、migrate `{migrated,settled,bedOk,movedBlocks,end}`。
- **预测(可证伪)**: bot 内陆 food0/hp10/白天连续 2 次 forageExplore `found:false`(220格落荒漠)后,第3个 famine cycle 打 `★C230 FAMINE-MIGRATE`,migrate.log leg-by-leg 行军 totalAdv 持续增长,最终 `settled`(landAnimals≥2)或 best-seen movedBlocks≥150,end 距起点≥150格,bed.json src→migrate。若 forage 中途 `found:true` 则计数清零不搬(证负向逻辑)。
- **观测**: 🟡 `node --check` 通过,重启已 live(进程 44480@7:54)。**回滚**: 删 famineMigrate 分支 + forageExplore 的计数器累加,回到 C228 纯 forage。

## C231. ★mob=POCKET 误判(开阔崖边被当封闭 pocket)→ 误触发挖上反射与 venture 竞争（①modes.js mobility，重启已 live）
- **触发(C228/C230 取证时发现)**: bot 在 y94 **开阔地表**(surfaceUp 证实 openAbove),mobility 却标 `POCKET`→触发 `low-food hold + enclosed → surfaceUp(112)` 分支(被 C226-D 封顶到90 后 no-op)+ POCKET 挖上反射,与 famine venture 竞争主循环周期 → bot 反复回到原点、venture 拿不到持续控制权。
- **机理(subagent 定位)**: `st = ... (upOpen ? 'POCKET' : 'ENTOMBED')`(modes.js ~:2423)——POCKET 判据=**无 walkable exits + 头顶+2 非实心**,但**没查天空**。崖边/柱顶四向都是落差(exits=0,因 floor 探测要求下方4格内有地板)+ 头顶开 → 误判 POCKET。
- **改动(①modes.js,需重启)**: 把已有的"3×3 向上探36格"`enc`(真封顶信号)计算**上移到 st 判定之前**,POCKET 改为 `(upOpen && enc) ? 'POCKET' : (upOpen ? 'FREE' : 'ENTOMBED')`——即头顶开**且**真封顶才 POCKET;头顶开但见天(enc=false)=FREE 暴露崖边;!upOpen 仍 ENTOMBED(不变)。移除下方重复的 enc 计算块。
- **预测(可证伪)**: bot 在开阔地表(头顶36格内见天)不再被标 POCKET/触发 enclosed→surfaceUp;progress.txt `[mobility] → POCKET` 只在真封顶(3×3 列全实心)时出现。真封闭 pocket(矿洞气穴)仍正确判 POCKET 触发垂直脱困。
- **观测**: 🟡 `node --check src/agent/modes.js` 通过,重启已 live(进程 44480)。**回滚**: 还原 st 行为 `(upOpen ? 'POCKET' : 'ENTOMBED')` + 把 enc 计算移回原位。
- **进程注记**: 本次重启同时清除了"另一 claude resume 本会话(claude.exe 59456)在 7:49 spawn 的孤儿 main.js 60504(无 init_agent、抢端口失败半死)"——双开 main.js 已消除,现单实例 44480(watchdog 43260 管理)+ init_agent 71036。

## 📋 C229 (✅治本①+兜底③已由 C236 实现 — 见顶部 C236 改动2/3；②tool_keeper 反射加固仍待重启窗口)：木材耗尽→无法重造镐→软锁,缺"深挖途中补木"反向路径
- **触发(06-16 02:50 强复现)**: bot @y92 hp4 软锁,inv 富矿(coal186/copper273/cobble346)但 0 pickaxe + 0 wood + stick仅1=镐断后无法重造(镐需3cobble+2stick;stick需plank需log,全无)→prepNether 死循环 `TABLE gate for shield — no wood`。见上方"tool_keeper 备镐失灵"强复现条。
- **★机理(subagent a4b92f9866d05913d 取证)**: 系统**所有补木/备镐逻辑都以"在地表+健康+白天+库存已有木当量"为前提**,缺一条**对称反向路径**:"深挖途中木当量跌破阈值→主动中止挖矿、爬回地表补木"。具体三处全哑:①`tool_keeper`(modes.js:3385-3437)造备镐硬卡 `stick>=2`(3419),料尽即静默返回,**无"料尽去找木"能力**;②挖矿前木材 buffer gate(achieve.js:218-245 / prepNether keepKit:1836-1846)被 `optionalWoodSafe()`(prepNether.js:1086-1093)的5道门拦截——要求 `openSurfaceNow()+!night+hp>14+food ok+无怪+有可达树`,**镐在 y-60 断时 bot 在地下→`!openSurfaceNow()`→直接 SKIP**,木材只在出门前囤、耗尽无人补;③`TABLE gate` 的 surfaceUp-找木 fallback(prepNether.js:654-678)被 `block.safeDay` 严格门控,且**只 surfaceUp(63) 爬出不真 chopWood**;非 safeDay 时退化成 `wait(6000)`(686)空转=软锁画面。无种树/sapling/bonemeal 逻辑(策略层0命中)=无可再生木源兜底。
- **方案(待 fresh 清醒实现,均③热加载)**: **①治本(首选)**: achieve.js mineProbe 下挖 dispatch 前(≈line 860,branchMine:867/digDown:894-905 之前)加"重造能力 gate"——`effectivePicks()<=1 && !(cobble>=3 && stickEq>=2) && woodEq()<8` 时**不下挖**,先在安全窗口(`hp>14 && !isNightNow() && hostilesNear(24)===0`,复用 optionalWoodSafe)surfaceUp+chopWood 补到 woodEq≥8;不满足安全门则**就地停挖+hold**(绝不徒手深挖磨光最后一把镐)。**③兜底**: prepNether `handleTableRecoveryBlocked` safeDay 分支 surfaceUp(63) 后追加真 chopWood(现在只爬不砍);注意该函数有大量 cooldown 标志+famineVerticalEmergency 特例,改时须验证交互。**②反射加固(后续,①层重启)**: tool_keeper 料尽时设 `bot._toolKeeperNeedsWood` 标志,③层循环顶部消费→安全窗 dispatch chopWood(符合"周期性承诺要有机制载体")。
- **风险点(必记)**: 补木分支若不 gate hp/night/hostile,会在残血/夜晚触发危险地表远征=过度干预致死(本班已踩过)。低 hp 必须让位生存路径,不强行上地表。
- **为何 PLANNED**: 方案①改挖矿热路径(achieve.js mineProbe)=高回归风险,③改 intricate 恢复逻辑(cooldown 交互),均须 fresh context 精审;当班 turn 已极长(C227+C226-D+取证+记账),不疲劳手术关键代码。bot 当前健康不在此软锁=无紧迫。
- **落地顺序建议**: 方案①(治本防进入,热加载即验)→ 方案③(兜底存量软锁)→ 方案②(反射加固,需重启)。

## C228. ★FAMINE body freeze 吸收态死锁缺 venture-exit（①modes.js+③missionNether，重启已 live 🟡待白天窗口验证）
- **触发(实测,bot 永久冻结 ~1hr)**: bot hp4/food0 在 y102 高处栖身,SAMEPOS ~1hr 不动不死不恢复。取证 progress.txt 钉死:`[self_preservation] FAMINE body freeze: food=0 hp=4` + `[reflex_watchdog] pinned body-budget contained hold exempt ... no forced interrupt` + `[mission] FAMINE backoff ... 10s body-budget hold`。
- **机理**: self_preservation(①)在 food0+hp4 触发 **FAMINE body freeze 冻身节能**,watchdog 豁免不打断。但**冻着就无法觅食→食物荒漠无食→永不恢复→永冻=吸收态死锁**。easy 难度饿伤止于 hp10、bot 在 hp4(摔伤)更低、稳在高处不摔死→既不死(无重置)也不动(无恢复)=最坏卡死。C217 hp<8 venture 被这个更底层的 famine 冻身 veto(身体被锁,venture 动不了)。
- **机理归属**: 与 C217/C224/C225 完全同母题——**过度保守的 hold(节能/防暴露)在"恢复路径需要主动行动"时变成吸收态死锁**。C217 给 noRegen-air-hold 加了 venture-exit,但 **FAMINE body freeze(self_preservation)这条没加**。
- **✅已应用(本班 fresh,subagent a5d6ffcd 取证+设计,我审后应用,重启已 live 新进程 62160@12:19)**: subagent **纠偏**了原假设——白名单其实匹配 forageExplore(`forage` 子串),真根因是 **`_currentSkill` 嵌套 sticky bug**:missionNether 嵌套 dispatch forageExplore 时 `_currentSkill` 仍是 'missionNether',白名单匹配不到→形同虚设。**核心修复=flag-yield(复用 C225 已验证模式)**。两层:
  - **Fix A(①modes.js:18-51 famineBodyFreeze,重启已 live)**: 函数最前加 `if (Date.now() < (bot._recoveryVentureUntil||0)) return false;`——派发的恢复 venture 持标志期间拥有身体(覆盖 self_preservation/unstuck/mobility 三处调用)。白名单补全 `forageExplore|migrate|digReset`(次要防线,与 lowHpNoRegenContainedHold 对齐)。
  - **Fix B(③missionNether:997 FAMINE backoff,热加载)**: food0 纯 hold 之前加"安全白天窗口 venture"——`food===0 && hp>=10 && !night && actionableHostilesNear(16)===0 && hostilesNear(16)===0` 时 dispatch `forageExplore{gateHp:8,gateFood:0,abortHp:6,targetFood:18,maxBlocks:220}`(前置 `_recoveryVentureUntil=now+180000`、finally 清零、90s 节流);**夜间/有怪/hp<10 仍 hold(正确保命,绝不夜venture)**。
- **安全性**: food0 移动只耗 food 不耗血(饿伤已止 hp10),hp 风险仅怪/摔→已 gate 白天+无怪16格+forageExplore 逐 leg abortHp6 复查。比 C217 的 hp4/hp9 venture 安全得多。
- **预测(可证伪)**: 重启后,bot food0/hp≥10/白天/无怪 时,progress.txt 应在 ≤90s 内出现 `FAMINE backoff → forageExplore` 且 pos 移动 >16 格(不再 24min+ 原地 `FAMINE body freeze` 刷屏);夜间 food0 仍 `FAMINE body freeze`(预期,安全)。若 venture 后 deaths 因白天 forage 遇险增长,则收紧 gate(提高 hp 门/缩 maxBlocks)。食物荒漠真无动物时 venture 走 maxBlocks 返回再 90s 重试=渐进搬家,胜过永冻饿到被夜怪杀。
- **观测**: ⚠️**部分有效(05:48 现场验证)**: ✅Fix B venture 触发(`FAMINE backoff → forageExplore` ×2),把 bot 从 -10,77 移到 -132,94(~120格)=**吸收态永冻已破**(核心目标达成)。✅C226-D 封顶正确协同:surfaceUp `ENTER y94 target=90→already at open surface` 立即早退,无 runaway。❗**但揭示真瓶颈=食物荒漠比 forageExplore 射程(maxBlocks220)还大**:venture 出去后落到**另一片荒漠**(y94 开阔但 `feedUp.leaf_sweep.none`/`safe_roam` 找不到叶子/动物),food0 无解,陷入"觅食-失败"循环(稳定移动、hp10 地板不饿死,但找不到食物)。❗**附带发现:mob=POCKET 误判**——bot 在 y94 开阔地表(surfaceUp 证实 openAbove)mobility 却标 POCKET→误触发 `low-food hold + enclosed → surfaceUp(112)` 分支与 forageExplore 竞争(①mobility 分类 bug,待查)。
- **结论+遗留(升级为头号结构项)**: C228 把"永冻死锁"改善成"主动觅食"达成核心目标,但**食物荒漠太大→必须 migrate 跨生物群系搬家(#33,用户明确愿景"像人类跨大陆找安家地")**。下一步:famine venture-exit 在 forageExplore 反复无果(N 次无食)后**升级 dispatch `migrate`**(白名单已含 migrate)远程搬出整片荒漠;migrate 落点后设床(C226-B)定居。C228 venture-exit 与 #33 食物荒漠根治合流=下个 fresh session 头号优先。**回滚**: Fix A 删让位行+白名单还原;Fix B 还原 L997 整段纯 hold。

## C227. ★用户实拍 #1优先级"基本工具质量"：2格墙 stuck → jump-flail 不挖穿（②skills.js stepEdgeAssist，✅生产验证 10/13 挖穿）
- **触发(用户实拍截图)**: bot 矿洞里面对 **2 格高墙**,反复**跳**(以为能跳上去)卡很久才自愈。用户:"工具效率不够高"。这是用户最初 #1 指示(基本 tool 质量:卡边/卡墙)。
- **机理(fresh subagent 订正,已定位)**: 真凶不是 attemptUnstick,而是 **`stepEdgeAssist`(skills.js:2055)只为"1格台阶"设计**:候选方向要求 foot 实心、head(脚前)open、above(头前)open。2格墙几何=foot 实心**且** head 实心→在 `if (!open(head)) return 'target-foot-blocked'`(skills.js:2202)直接拒绝,无可走候选→返回 false。**全链路没有任何一层挖前方墙**(own-above-notch 只挖自己头顶)。配合 pathfinder `nonDestructiveMovements.allowParkour=true` 自信规划"跳上去"的 parkour 路径→对着2格墙干跳→stuck→stepEdgeAssist 拒绝→attemptUnstick(矿洞被 skip 或只再跳)→反复到 60s 超时/20s unstuck reflex 拽走才"自愈"。modes.js step-edge reflex 同样在 target-foot-blocked skip,但其 1782 行门对2格墙 skip **不跳**(非抽搐源)。
- **改动(②skills.js stepEdgeAssist,需重启)**: 在"无可走台阶候选"(`if (!c)`,skills.js:2238)兜底加**挖穿前方墙**分支——仅 dirFromGoal/dirFromYaw 两个行进方向(不挖侧/背向墙),若前方 foot+head 两格都 solid 且 `clearableStepRoof`(复用既有镐门+bedrock/obsidian/hazard/功能方块排除)、且脚下 below 是 solid 非 hazard 地板,就**先挖头再挖脚**(避免头块砸下)开出 2 格门洞(挖法照搬 own-above-notch 的 setGoal(null)→equipForBlock→lookAt→`Promise.race(dig,5.2s timeout)`),挖完 forward 走进门洞;失败挂 12s wallKey cooldown 防 thrash。返回 true 后 goToGoal `continue` 重新规划。bodyDigLock 12s 覆盖整段防 ① 反射互绞。
- **预测(可证伪)**: 重启后下次 bot 在矿洞/地下面对 2 格墙(正前 foot+head 实心、脚下有地)被 goToGoal 卡住时,motionAudit/mine_motion.jsonl 应出现 `step_edge.wall_dig.begin` 紧接 `step_edge.wall_dig.end ok=true`,bot 挖穿走过而**不再**长时间原地 jump-flail;act_trace 不应再出现"对同一墙连续 jump>10s"。若墙含 bedrock/obsidian/熔岩/无镐则不挖(保持原 skip)。
- **观测**: ✅**生产验证通过(重启后1小时内)**: mine_motion.jsonl `step_edge.wall_dig.end` = **10 ok=true / 3 ok=false**(77% 成功挖穿),触发于 `branchMine`(why=path-destructive-stuck)/`achieve`(why=path-failed),held=stone_pickaxe/wooden_sword(镐门生效)。bot 不再对 2 格墙长时 jump-flail。3 次 false=cooldown/timeout/unclearable(预期内)。`node --check` 通过。
- **回滚**: 删除 `if (!c)` 内的 wall_dig 分支,恢复直接 `step_edge.none` + return false。
- **遗留(本轮未做)**: modes.js step-edge reflex(①)的同类 inline 实现未加 wall-dig(它对2格墙 skip 不跳,非抽搐源,优先级低)。若后续观察到"无 skill 驱动时反射撞墙空转",再下沉为公共 wall-dig 原语供两层共用(原则:门加公共入口不是单调用方)。

## 📋 C226 (PLANNED,未应用,fresh-context subagent 设计,待清醒实现+审核)：破"重生→爬峰摔死/夜怪/淹死"死亡螺旋
- **触发**: 本班尾部 no-regen 死亡级联后,bot 反复死(deaths 343→346+):重生满血裸装 @(-1.5,86,9.5)→wander 爬 y108/y138 高峰→摔死(或夜怪/淹死,死因全 night/fall)→重生→循环。
- **★机理(subagent 纠正我的假设)**: ①**重生点其实在 dzone(-1,-32 r28)之外 ~41b**——所以 leave_zone/KILL-BOX 撤离重生时不触发(`missionNether.js:390` `d0<z.r` 为假),撤离机制没坏是触发条件不满足。②**真凶=重生→pathfinder 爬峰**:`goToPosition`→`GoalNear`,Movements `maxDropDown=2`(skills.js:2589/2602)只限规划**下降**、对**上爬无上限**→规划器为避>2格下降反而偏好翻山脊登顶(y108/138)。③**摔死发生在非寻路控制路径**:fleeMove(modes.js:447 手动sprint+jump)、KILL-BOX 手动sprint(missionNether.js:478)、EVAC 腿——绕过 maxDropDown 保护,裸装无水桶 MLG(任务#17/18)→冲下峰摔死。④setBed bedOk=false 因 `_huntFit`(setBed.js:121)要石剑+,裸装永远过不了→无羊毛→无床→永远重生原点。
- **方案(未应用,审后再做)**: **A(③热加载,首选)**: missionNether 主循环 EVAC 前(~:354)加"fresh-respawn triage"——检测刚重生(hp≥18+裸装+pos≈spawn_pos+本回合首次+白天)→ `customSkill(bot,'migrate',{force:true,gateFood:0,maxBlocks:200,settleScore:8})` 用满血窗口远撤(复用已验证 migrate 作安全远征器,bearing 自动背离 dzone)。**C(①重启)**: 堵摔死两路径——(c1)把 modes.js:421-433 已有的 `droppy()` ledge-abort(死214修复)复用到 KILL-BOX(missionNether:478)/EVAC 手动 sprint 前探落差>3格 air 不冲;(c2)给 Movements 加上爬 cost/maxClimb 让规划器别登顶(可后置单验)。**B(③+①,根治)**: 让裸装能尽快设安全床——B2(稳):migrate 落点后白天安全区强制 `achieve(wooden_sword)→setBed` 作重生后第一优先;B1(增强):`_huntFit` 白天仅蜘蛛时放木剑猎蛛取 string→wool→床。
- **落地顺序**: A + C-c1(低风险,直接堵摔死+凶宅边缘重生)→观察1-2昼夜→B2(设床根治)→C-c2/B1(可选增强)。A→B 是根治链(A 移出凶宅,B 新家设床,重生点永久迁移)。
- **★追加发现 D (runaway-pillar,我 C224b 引入的 bug,优先修)**: 实测 bot 暴冲爬到 **y207+**(y131→179→207→212)。surfaceUp.log 钉死:`fallback iter 13-15 y208→212 EXIT target=213`——**surfaceUp 被以 target=213 调用**。根因=**no-regen surfaceUp 调用方用相对目标 `pos.y+10`**(C224b missionNether:~772 sealed 分支 `sy=Math.round(pos.y)+10`;C224 prepNether 类似;旧 MAROONED-rescue missionNether:622 `Math.max(84,floor(y)+8)`)。bot 在 y200 时→surfaceUp(210)→爬到210→下个 cycle surfaceUp(220)→**正反馈 runaway 爬到 build limit**,浪费方块+y200 摔死=喂死亡螺旋。**修(③+surfaceUp内部)**:①调用方改**绝对**目标(固定 surface y 或 `Math.min(pos.y+10, 80)` 封顶),别用纯相对;②**更根本**:no-regen/MAROONED surfaceUp 调用应 gate 在 `pos.y < ~72`(已在地表/高处就别 surface);③surfaceUp 内部加绝对上限(no-pick fallback 不该 pillar 到 y100+,真地表罕见那么高,登顶是 bug)。这条与 C226-C(避致命落差)同源:**bot 不该爬高,爬高就摔死**。
  - **✅已应用(本班 fresh,③surfaceUp 热加载即 live)**: 选了"下沉到原语层"方案——不改 5 个调用点,直接在 `surfaceUp.js:28` 入口 `targetY = Math.min(targetY, 90)` 封顶(`SURFACE_CEILING=90`,尊重 MAROONED-rescue 的 84 下限)。机理:封顶后既约束爬升上限,又让入口既有 `surfaceReady()`(:448,`yNow>=targetY-2 && openAbove(8)`)在高 y 自动早退——bot 在 y118 见天(被骷髅射证明暴露)时 `118>=88 && openAbove` ⇒ 入口 return true,不再被 target=136 推到 y134。低 y(target 63-90)不受影响,y40 洞穴竖井假阳性被 `yNow>=targetY-2` 挡住。
  - **取证(确认机理)**: 最后一次死亡 `2026-06-16T01:22:33 cause=shot:Skeleton y=127`(非摔死,是高空夜暴露)。surfaceUp.log 钉死:`EXIT y=119(target 120)`→2min 后 `ENTER y=118 target=136`(+18 相对)→`EXIT y=134`。runaway 坐实。
  - **预测(可证伪)**: 热加载后,surfaceUp.log 不应再出现 `target>90` 的 ENTER,也不应再出现 bot 经 surfaceUp 爬到 y>92;高 y(>88)被调用且头顶见天时应立即 `already at open surface` 早退。若 deaths 仍因 `shot:Skeleton/exposure @ y>100` 增长,则说明高 y 暴露另有来源(pathfinder 爬山 C226-C),surfaceUp 已非主犯。
  - **观测**: ✅**热加载验证通过**: surfaceUp.log 修复后 ENTER target 全 ≤90(实见 71/87),EXIT y=69/86,**无 target>90、无 y>92 经 surfaceUp 爬升**。后续 bot 一度到 y92,但取证证明是 overnight `Nightfall securing` **自筑 cobblestone 庇护柱**(mine_motion place_skill cobblestone @85,92)所致,**非 surfaceUp**——C226-D 洗清 surfaceUp 嫌疑,runaway 已断。`node --check` 通过。**回滚**: 删 `SURFACE_CEILING` 封顶两行。
  - **遗留**: C226-A(重生即 migrate 远撤)/C226-C(pathfinder 爬山 maxClimb + 手动 sprint 落差检测)/C226-B(裸装设床)仍 PLANNED;本轮只动 D(我引入的 bug、热加载低风险、取证确认致死)。
- **★为何 PLANNED 不立即做**: 当班已极深(250+调用)+尾部过度干预教训(hp9戳到hp2致级联+开 no-regen venture 门致 explore-and-die)。新代码进运行中主循环须清醒审改;bot easy 螺旋=死亡免费裸装无损失=无害,留 fresh session 实现。**fresh session 落地顺序建议**:先修 D(runaway-pillar,我引入的,封顶 surfaceUp 目标+gate 低y,③热加载可即验)→ A(重生即migrate远撤)→ C-c1(手动sprint落差检测)→ B2(设床)。subagentId adbb51dcb4d7f6165(已结束)。

## C225. ★★★no-regen 死锁层间真闸：① mobility hold veto 了 ③ 恢复 forageExplore + forage 目标<回血阈值（①modes+③missionNether/forageExplore，重启已 live，🟡待 dawn 验）
- **触发(C224 验证时接力)**: C224 把 hp9/food17 的 bot 弄上地表(y89),但**仍不恢复**:已有 deadlock-breaker(missionNether:902)确实 fire forageExplore,但 bot 不动不回血。连续取证(vitals+progress)钉死两道叠加真闸。
- **★机理1(① veto ③,层间拔河)**: bot 在 POCKET,① mobility POCKET no-regen 门(modes.js:2940)调 `noRegenSafeAirHold`(:2485)→该函数本有 survivalSkill 白名单(:2492 `prepNether|feedUp|consume|auto_eat`)**漏了 forageExplore/escapePlan**,且**嵌套 customSkill 不更新 `bot._currentSkill`**(派 forageExplore 时 _currentSkill 仍是 sticky 'missionNether')→白名单匹配不到→**返回 hold→冻住身体→③ forageExplore 的 goToPosition 动不了**(progress 实证 `POCKET no-regen gate ... skill=missionNether — hold`)。**①反射每 tick 控身,直接 veto ③skill 移动**——这是层间最隐蔽的拔河。
- **★机理2(food 目标<回血阈值)**: forageExplore handoff 到 `forage{targetFood:16}`(forageExplore.js:75),但 MC **回血需 food≥18**。bot food17≥16→forage 判定"已饱"**no-op 不狩猎**→永远到不了 18→hp 永不回。全系统 food 目标 16<18 = 受伤时结构性回不了血。
- **改动(C225, 需重启已 live)**: **①modes.js:2487** noRegenSafeAirHold 加 `if (now < bot._recoveryVentureUntil) return null`——派发的恢复 venture 持标志期间拥有移动权(带自身 night/hostile/hp-abort gate,正当出口)。**③missionNether:765(C224b)+:902** 派 forageExplore 前置 `bot._recoveryVentureUntil = now+180000`、finally 清零,且 targetFood:18(吃过回血线)、gateHp:6。**③forageExplore.js:75** targetFood 可配置(opts.targetFood)。surfaceUp 分支不需标志(它 freeze 整个 mobility)。
- **预测(可证伪)**: dawn(白天)bot hp8-13/food<18/无食时,deadlock-breaker fire→`_recoveryVentureUntil` 置位→noRegenSafeAirHold 让位(不再 `hold skill=missionNether`)→forageExplore **真移动**走向动物→forage 吃到 food≥18→**hp 开始回升**(9→…→14+)→hp≥14 后 normalSafeDay 开→craft iron_pickaxe 进度链续。若 bot 仍 `POCKET no-regen gate hold` 不动则证伪。
- **回滚**: 删 modes.js:2487 标志检查 + missionNether/forageExplore 的 targetFood/标志(恢复——已证会层间死锁)。
- **★方法论**: **层间拔河的最隐蔽形态——①反射每 tick 控身,①的"放行白名单"依赖 `_currentSkill`,但嵌套 customSkill 不更新它→放行失效→① veto ③**。修法=跨层显式信号(`_recoveryVentureUntil` 标志)而非依赖 _currentSkill。叠加"食物目标<回血阈值"的结构性 bug。no-regen 三态谱补全:hp<8(C217)/hp8-13 surface(C224)/hp8-13 移动权(C225)。**这条 no-regen 恢复链跨 ①②③ 四五处,每处都要对**(又一次"高层意图被低层闸挡"的印证)。
- **⚠️观测(诚实复盘,C224/C225 部分有效但有副作用,需 fresh-context 重设计)**: 重启后 C224b 修了 `sealed=ENTOMBED-only`(FREE/ENC 不再误 surfaceUp)→**冻结确实破除,bot 开始移动 forage**(3,193→-31,221 ~40格)。**但代价**:①**低 hp venture 在崎岖森林(y94)摔伤 hp9→hp2**——正是 forageExplore 头注释的"explore-and-die"教训,我开放低 hp gate 后立刻应验;②forage 找橡叶/苹果 `no edible (15→15)` 没找到食物;③forageExplore bearing 背离死亡簇=**wander 离开了已知森林动物点(7,182→-31,221)**,越走离食越远。**净结果 hp 更差(9→2)**,bot 现 hp2/food14 holding(无威胁存活)。**根本张力**:冻结(安全但卡)vs venture(可能摔死/找不到食)——保守 gate 本就在防这个。**正确解(fresh-context #1)**:no-regen-低hp 恢复应=**朝已知近距食物(settle 动物点/bed)短程+安全地形+落差保护**,而非通用 forageExplore 远征瞎走;或低 hp 时宁可 holding 等 C217 兜底也不强行远征崎岖地形。**教训:开放保守安全 gate 前先想清楚它在防什么——这次开了 no-regen venture 门,立刻撞回 explore-and-die。** 不在 hp2 继续戳(避免戳死),退到观察。

## C224. ★★no-regen 死锁破除：hp8-13 + food<18 + 无食 + 地下 → 白天就近 surface 狩猎/砍木（③ prepNether 热加载，🟡验证中）
- **触发(C223 脱困后接力发现)**: bot 经 C222/C223 脱困→migrate 森林安家→拿木造 table/furnace/shield/石镐(大进展!)→**又挖回地下**(挖矿/夜bunker)→木用光撞 TABLE gate→其间 **hp 掉到9**。dawn(night=false)后 bot **仍卡 TABLE gate 不上地表**,SAMEPOS 持续。
- **★机理(取证钉死=吸收态死锁)**: prepNether 补木 surface 窗口 `normalSafeDay`(prepNether.js:601)要 **hp≥14**;famineVerticalEmergency 要 food≤2。bot hp9/food17 **两窗口都不开**。而 **hp9 不回血**(MC 自然回血需 food≥18,food17 差1点)→**回血需 surface 狩猎 food→18→却被 hp<14 挡**→**hp9↔food17 互锁永冻**。这是 C217(hp<8 last-resort)与 normalSafeDay(hp≥14)之间漏掉的 **hp8-13 no-regen 死区**:既不够格触发 hp<8 应急,又过不了 hp≥14 正常门,在地下 food<18 无食时永久卡 TABLE gate(live 05:37 dawn 后实测持续打转)。
- **改动(C224, ③热加载, prepNether.js:602 后)**: 加第三 surface 窗口 `noRegenDeadlock = daytime && !hasEdible() && food<18 && hp∈[8,14) && verticalPocket && threat.actionable===0`,纳入 `safeDay`。即 hp8-13 无法回血又无食时,白天无威胁可垂直上浮→**surface 去狩猎+砍木**(唯一出路;森林家白天怪自燃+有盾=可控风险,同 C217"find beats frozen")。复用 famine 短冷却快速重试。
- **预测(可证伪)**: 下个 prepNether cycle(~9s 热加载),bot 应从 `TABLE gate ... no repeat` 翻成 `TABLE recovery ... surfaceUp`,y 上升出地表→狩猎(food→18+)→回血(hp 升)→砍木→做台→craft iron_pickaxe。若仍卡 TABLE gate 不上浮则证伪。
- **回滚**: 删 noRegenDeadlock(恢复 hp≥14 硬门——已证地下 no-regen 会死锁)。
- **注**: 同 C217/C219/C223 母题——**保守安全 gate 在特定状态制造吸收态死锁;出口=识别"唯一恢复路径被 gate 挡住"时开计算过的风险窗口**。no-regen 三段谱:hp<8(C217 venture)/ hp8-13(C224 surface)/ food≤2(famine vertical)。

## C223. ★★★活埋真闸2连：挖掘超时<徒手挖石时间 + 矿石天花板不可破——C221 的门被下游悄悄废掉（①modes guardedDig 需重启 + ③surfaceUp 热加载，🟡待验）
- **触发(C222 验证时取证)**: C222 部署后 migrate 在草甸 spawn **每条腿 adv=0b**(bearing-fan 10 方向全试遍仍 0)、start-surfaceUp 跑 34s 也没把 bot 弄出来。第六原则连续取证(act_trace 逐帧 + surfaceUp.log + progress.txt)钉死:**bot 不是在烂 spawn,是困在草甸地下 y67**(biome=meadow!树就在头顶),被**两道下游闸**封死,C221 开的"允许徒手挖"门形同虚设。
- **★机理1(挖掘超时 < 徒手挖石时间)**: mobility ENTOMBED 反射的 `guardedDig`(modes.js:2637)用**固定 5000ms** `Promise.race` 超时。徒手挖 stone=~7.5s(硬度1.5×5)、coal_ore=~15s(硬度3×5)、deepslate=~16.5s——**全 >5s**。所以每次徒手挖都在 7.5s 完成前被 5s 超时砍断→`stopDigging`→"Digging aborted"→**0 进度**→重挖同块→**永久 entombed**。act_trace 铁证:seq126→129 反复挖同一块 stone@4,67,75,每次 `ok:false ms:5005`,从不破。progress.txt:`[mobility] dig retry 0/1 (ENTOMBED) stone@4,68,75: dig-timeout`。
- **★机理2(矿石天花板不可破)**: bot 头顶正是 **coal_ore**(env [0,2,0]=coal_ore)。surfaceUp 上浮的 no-pick 可破集 `NO_PICK_BREACHABLE`(surfaceUp.js:23)只含纯石族(stone/cobble/deepslate/安山岩…)**不含矿石**,而 `canPlanNoPickStoneBreach`(:597)`!NO_PICK_BREACHABLE.has(name)→return false`→coal_ore 天花板拒破→`fallback no-pick stone blocked at h=2 name=coal_ore`→**上浮死**。矿石徒手明明可破(只是不掉落)。+surfaceUp 挖石超时(:218)也是 gated 12s(对 coal_ore 15s 仍不够)。
- **改动**: **C223(①modes.js:2637, 需重启)**——`guardedDig` 超时改自适应 `digTime×1.4+1500`(封顶20s)+ bodyDigLock 同步延长,徒手 stone→12.75s/coal_ore→20s 够挖穿。**C223b(③surfaceUp.js, 热加载 LIVE)**——①`canPlanNoPickStoneBreach` 可破集加 `/_ore$/`(矿石脱困可破,丢一块煤胜过永久墓);②挖石/矿超时(:218)改自适应 `max(5000,min(26000,digTime×1.4+1500))`(coal_ore 15s→22.5s 够)。
- **预测(可证伪)**: surfaceUp 现在应能凿穿 coal_ore 天花板**逐格上浮**(surfaceUp.log 出现 `dig ... coal_ore` 成功而非 `blocked at h=2`、y 67→68→…→76),bot 浮出草甸表面→见树→chopWood→造台→脱困进入正常进度链。重启后 mobility ENTOMBED 反射也能徒手挖穿石头(progress.txt 不再刷 `dig-timeout`)。若 surfaceUp 仍 `blocked` 或 y 不升则证伪。
- **观测**: ✅ **C223b/c 实测成功(05:08-05:14)**:surfaceUp.log 从 `blocked at h=2 name=coal_ore`(脱困死)翻成 `planned no-pick stone breach 1-4/200 at h=2/3 name=coal_ore/stone`——**coal_ore 天花板现可破**;bot **净升 y67→68→69→…→72(5格)**,`manualRose=true progressed=true`。C223c 早退修复验证:iter2 `stuckFloor=1 manualRose=false` 旧代码会 break、新代码继续 `breach 4/200`。**1.5h+ 活埋首次出现垂直净进展**。升到 y72 时**再次入夜**→self_preservation `night bunker dwell covered=true` 安全 bunker 等天亮(夜不上地表=正确),距草甸表面仅 4 格。**🟡 C223(modes mobility 反射超时)仍待重启**(反射横向挖,主要靠 surfaceUp 垂直上浮;C223 是反射层鲁棒性补强,下个干净窗口批量重启)。
- **次要待修(发现)**: ①ENTOMBED 反射只朝 anchor **水平**挖不挖上(modes.js:2723)——困在地下时该优先垂直上浮,目前靠 surfaceUp 补;②徒手挖石 ~15s/块太慢,但 bot 有 166cobble+2stick,出地面砍一根木做台即可造石镐(料齐)5×加速——surfacing 是总加速点。
- **★方法论(三原则全中)**: ①产出是逻辑——没手搬 bot,是修能力让它自己挖出去。②机理非表象——"migrate 0b stall"表象下真因是**两道与 migrate 无关的挖掘闸**(超时+可破集);C221 开了高层门却被低层两闸废掉=**"一个能力要真正打通,必须把这条链上每一道闸都改对,改高层被低层挡"的再次印证**(C221 学过一次,这次是它的两个漏网兄弟)。③取证——连续逐帧 act_trace 当场破案,没等下一拍。

## C222. ★★migrate 穿越鲁棒性：hop-march + bearing-fan + cooldown-on-stall——解"会 fire 但 27b 就 stall"（③层 migrate.js 热加载，🟡待白天自触发验）
- **触发(C220 观测3)**: C221 脱困后 migrate **确实自主 fire** 但**只走 ~22-27b 就 `stalled twice (terrain) → abort settle`**——远不到 800b。旧 force-test(01:46)实证:migrate 到过一个 **meadow(30棵树/score13)@6,41** 却卡在 leg2 退出(score13 差 1 分未达 settle14,且没继续走)。跨大陆迁徙名存实亡。
- **★机理(读 goToGoal 源码钉死)**: 每条腿用**单次 `goToPosition(24格, GoalNear 3D)`**。goToGoal 的 `getPathTo` 只有 **1s 规划预算**(skills.js:2633 `pathfind_timeout=1000`),对 24格 3D 目标跨破碎/海岸地形**经常规划失败**→抛 `PathfindingNoPlan`(skills.js:2659"refusing blind destructive navigation")→**零位移**。旧 stall 逻辑 `adv<35%→stalls++`,且只有**单次 25° 微调(jittered 标志)**,第 2 次 stall 直接 abort=整个行军报废。叠加**待修②**:`lastMigrateAt=Date.now()` 无条件写=stall 也设满 20min cooldown→把 bot 锁死(实测 15min<20min 现在挡住重试)。
- **改动(C222, ③热加载, migrate.js 腿循环+持久化两段, node --check 过)**: **①HOP-MARCH**——把 24格腿拆成 8格短跳(`HOP=8`),每跳 pathfinder 1s 内能解→规划成功率暴涨,逐跳跟地形 y(`Math.round(position.y)`),某跳<40%即停跳让外层转向。**②MULTI-TURN 扇形恢复**——stall 时按 `TURNS=[0,30,-30,60,-60,90,-90,130,-130,180]°` 相对锁定 bearing 扇形轮转绕半岛/山/海湾(替代旧单次25°),穷尽 10 个方向才 abort。水域漂移(`waterStreak≥3`)也触发转向(直行进海"每段都进展"却永不到岸)。**③RELATIVE stepping**——跳目标=当前pos+bearing×HOP(非 origin+bearing×leg×i),中途转向不把目标瞬移回已失败地形。**④cooldown-on-stall**——只有真搬≥150b 或 settle 才设满 20min;stall 只设 3min(backdate lastMigrateAt),不再锁死 bot。
- **预测(可证伪)**: 下个**白天** migrate 自触发,progress 应出现逐段 `leg N adv=Mb total=Kb @x,z bearing=...`,bot **持续行进数百格(远超 27b)**,遇地形/水域出现 `try bearing offset ±X° -> ...` 转向后继续推进,最终 `★ARRIVED livable land` 或走满 maxBlocks 在 best-seen(如那个 meadow)安家。stall 退出时 `persist: cooldown=short 3min` 而非锁 20min。若仍 ≤30b 就 abort 则证伪(机理判断错,需查 goToPosition 内部 digstop)。
- **观测**: 🟡 `node --check` 过;customSkill cache-bust 即时热加载。清 migrate_state cooldown(lastMigrateAt=0)+ reload missionNether 测——但 **reload 恰撞入夜(tod13900)**,migrate `!isNight` 门正确拦下(夜不开长征=设计),bot ENTOMBED y67 安全过夜。**真验证=天亮(~8min)missionNether L632 自触发**。
- **次要待查(latent,需重启)**: goToPosition 内 `checkDigProgress`(skills.js:2924)也是 C221 同胞 canHarvest bug——寻路挖到"采不动但能徒手破"方块就 `pathfinder.stop()`。破坏式行军过石/土时可能贡献 stall。本轮先验 hop-fix(主因);若仍卡挖掘再修这层(批进下次重启)。
- **回滚**: migrate.js 腿循环恢复旧单次 goToPosition+25°单调+无条件 cooldown(不建议——已证 27b 报废)。
- **★方法论**: 第三原则机理对准——"stall"表象下真因是 pathfinder 规划预算 vs 目标距离不匹配。修法=把超出规划能力的远目标拆成规划能力内的近跳(hop),再用扇形搜索补"单方向被地形堵"。

## C221. ★★★无镐徒手脱困：5道 no-pick 挖掘门全开（enclosed 时）——破"困死在自己 bunker 里"终局（②skills+①modes+③surfaceUp，需重启，✅实测脱困）
- **触发**: C220 后 bot 困在 y79-81 enclosed 自封 bunker、**无镐**(石镐耗尽、无木无台造不出=C219连环)、SAMEPOS **1.5h+ 不死不动**(easy 饿不死到 hp10 下)。migrate/surfaceUp/forageExplore 全走不动。
- **★机理(subagent 钉死,正中第二原则"机理非表象")**: 一个人徒手就能破自己封的 cobble 顶爬出去,bot 不能——因为**多层 no-pick 挖掘门用 `canHarvest`(=挖了"会不会掉物品")当成"能不能挖动"的门**。cobblestone 徒手 `canHarvest(null)`=falsy→一刨不刨。bunker 封顶料正是 cobblestone(sealBlock dirt 耗尽后)→困死。**5 道门层层套**:①`breakBlockAt`(skills.js:1242 canHarvest)②surfaceUp `canDig=hasPick`(:474)+食物死区(:598 food≥14,bot food8 卡死)③mobility POCKET 反射 no-pick gate(modes.js:2981 跳过 stone)④`ensurePickForStone`(:2585)⑤**真·master:`bot.dig` 被 wrap(modes.js:3118),`ensurePickForDig`(:3106)无镐 stony 只认 `_plannedNoPickStoneUntil` 窗口否则 throw**——所有挖掘(含 breakBlockAt)最终都过这层。
- **改动(C221, A+B+C+master, 需重启)**: **A**(skills.js:1242)breakBlockAt 改用 `digTime`(真实可挖,<9s 放行,挡黑曜石/基岩)。**B**(surfaceUp.js ③)enclosed-no-pick 开 canDig + 食物死区加 trappedEnclosed 旁路(hp≥8 即可破顶)。**C**(modes.js ①)POCKET 反射 enclosed 时 dig 而非跳过(:2981)+ ensurePickForStone enclosed 放行(:2585)。**master**(modes.js:3106)`ensurePickForDig` enclosed 时放行无镐 stony=解锁所有挖掘路径。全 gate 统一条件:`bot._mobility.enclosed`(真被封死才放行,普通采矿仍要镐)。
- **观测**: ✅ **实测脱困成功**:5 文件 `node --check` 过,杀 main.js+init_agent→watchdog 重生(新进程 CreationDate 验)。重启后 ALERTS `BARE-HAND STONE DIG: stone held=cobblestone` + bot **从 6,81 enclosed 徒手挖穿 cobble 顶 → 脱出到 49,80 covered=false 移动 46格+**。1.5h 终局死锁打破。脱出后 food4 走 forageExplore relocate(food<6 未达 migrate 门)。
- **回滚**: 5 处 enclosed 放行条件去掉,恢复 canHarvest/hasPick 硬门(不建议——已证致困死)。
- **★方法论**: 这是"基本 tool 质量"(用户 #1)的范例修复——`canHarvest`(掉落判定)≠"能否挖"(可行性判定)是经典表象/机理错位。subagent fresh-context 刨出 5 层门的完整因果链,我审 diff 逐层修+双重启验收。**通用教训:一个能力被"看似合理但语义错位的门"层层封死时,要刨到最底层的真闸(bot.dig wrapper),改高层都被低层挡**。

## C220. ★★★migrate：跨大陆迁徙找家——像人类一样"识别烂spawn→远征→安家"（③层新技能 migrate.js + missionNether 触发，🟡待健康重生验）
- **触发(用户纠偏)**: C217/C218/C219 把 bot 推到铁 tier 后撞"食物墙"(海洋荒漠 spawn 无食),我误判"世界不可通关、建议换世界"。**用户:错误。bot 应像人类一样决策,决策包含跨大陆寻找安家地。**"换世界"是外部取巧;人在烂 spawn 会**远行几百格找有动物/树/平原的好地安家**,而非原地反复找食饿死。这是用户最初指示 #3(世界认知/搬家)+#1(WorldModel),也是三原则#1"产出是逻辑不是操作=把人类决策编码进去"。
- **机理**: 现有 forageExplore 只走 160 格短腿、bearing 每段重算(在荒漠附近兜圈)、语义是觅食非安家。缺一个"跨大陆远征找家"能力。
- **改动(C220, ③层新文件 migrate.js + missionNether 触发, subagent 设计+我审改部署)**: 新技能 `migrate(bot,ctx,opts)`:①触发判定 `shouldMigrate`(纯函数:健康 hp≥14/food≥12 + 白天无威胁 + 确认荒漠[当前 ocean biome/oceanStreak≥3/noAnimalStreak≥4]+ 反复 food-death 聚类/在 dzone 内 + 离上次≥20min冷却)②**锁定一致 bearing**(背离死亡质心/已知贫瘠质心——关键:不像 forageExplore 每段重算而兜圈)③分段长途(maxBlocks=800/leg=24,白天赶路、入夜就地 prepNether bunker、天亮继续、不消耗 travel leg)④沿途 `siteScore` 纯函数评估宜居度(biome+陆地动物×4+树+草-死亡热)⑤达标(动物≥2+非水+score≥14)即停、写 bed.json 锚点(src:migrate)再 setBed 安家⑥有界(8min/800格)+ 兜底回 bestSeen ⑦全程复用 self_preservation 反射 + 每段 night/hostile/hp/food-floor gate + water-drift转90°+stall转向,**branchMine 式 `interrupt_code break`(可取消、让位反射)**。missionNether L896 catch-all 前插触发(健康白天无威胁+120s节流,migrate 自身再 gate)。
- **预测(可证伪)**: 下次 bot 健康重生(food20)在海洋荒漠 spawn 时,progress 应出现 `★MIGRATE start ... bearing=... ` + 分段 `leg i/N`,bot **持续单向远行数百格**(心跳 pos 大幅移动、跨 biome),入夜就地 bunker 天亮续行,最终 `★ARRIVED livable land`(plains/forest+动物)→ 写锚 setBed 安家。若仍在 spawn 附近兜圈/秒退则证伪。
- **观测**: 🟡 `node --check` 多过;纯函数离线单测全过。API 全验证存在。**force-test 两次确认 migrate 技能能跑**(执行 leg loop、写 migrate_state.json、不崩、setBed 收尾)——但 bot 从 enclosed 夜bunker 启动时**没移动**:①首测=goToPosition 无法从封闭口袋水平脱出(同 forageExplore 限制)→加了"启动若 enclosed 先 surfaceUp 清顶";②二测仍没走=**bot 无镐**(石镐早断,surfaceUp 挖不动石头),而无镐又因无木无台造不出(C219 连环)=**当前 enclosed-no-pickaxe 局部死局不是 migrate 的公平测试场**。**修正三处让自动触发可靠**:food gate 12→6(人在荒漠饿了就走,abortHp8 跨难度防饿死)+ shouldMigrate 改 `荒漠 OR 反复聚类死亡`(bot 339 死亡簇=可靠触发,不再依赖站在 ocean biome 上)+ 死亡半径 40→80 + migrate 触发移到 lowFoodHold 分支(低食物 bot 实际路径,原 L896 被 preempt)。**migrate 真实测试场=下个 fresh 健康重生(开阔地)**=它的设计触发场景;当前 enclosed bot 需先死→重生→才能真迁徙。
- **观测3(C221 脱困后 live, 两个遗留问题)**: bot 经 C221 脱困后自由,migrate **确实 fire**(03:26 `MIGRATE ran (low-food hold): moved=22b reason=stalled`)但**只走 22b 就 stall abort**——两个问题:**①preemption**:fresh 重生时 prepNether(bankRecover/挖矿/holds)跑长,catch-all(L923)+lowFoodHold(L672)的 migrate 触发在 prepNether 返回后才到→常被 preempt(观察:fresh 重生直接进 prepNether→forageExplore 瞎走进 y233 barren 高山→food 耗尽→摔死→重生 cycle)。**已加早放置(L632,BREAKOUT/prepNether 之前)**应解。**②地形 stall**:migrate fire 后 goToPosition 在崎岖/水地形每段进展<35%→2 次 stall→abort settle(只走 22b,远不到 800b)=**跨大陆穿越鲁棒性不足**(需:更多 bearing-turn 容忍/水域绕行或游过/山地寻路)。**fresh-context 迭代项**:migrate 穿越鲁棒性(stall 容忍+水/山处理)是让"会 fire 的 migrate"变成"真能跨大陆到平原安家"的关键。forageExplore 短腿同样把 bot 带进 barren 高山(bearing 只背离死亡簇不朝好 biome)——根治都指向 biome-smart 定向穿越。
- **★观测4(端到端 ✅✅✅ 通关, 05:08-05:20, 本 session 最大胜利)**: C222(穿越鲁棒性 hop-march+bearing-fan+cooldown-on-stall)+ C223b/c(活埋脱困)全部 live。完整链:bot 从 **y67 活埋 1.5h+** → surfaceUp 凿穿 coal_ore 天花板升 24格到 y91 FREE → migrate **hop-march 行军 108格**(`leg5 adv=20b` 实证 hop 推进)穿草甸 → **`★ARRIVED livable land @7,182 biome=forest animals=3 trees=30 score=30 → settled`**!cooldown-on-stall 正确(settled→满20min;之前 0b stall→3min retry,实测连续重试不锁死)。**待修① 地形stall 已解(hop-march),待修②cooldown-on-stall 已解,preemption 早放置已解。用户纠偏的"像人类跨大陆找家"完整实现。** 遗留:bedOk=false(无床设重生点);待验森林家 chopWood→石镐→铁全链。
- **风险/防护(subagent核+我审)**: 迷路→锁bearing;淹死→self_pres反射+water-drift转向+ocean负分不安家;夜死→就地bunker不退出;饿死途中→food-floor 7 先forage补不到则返回;病弱→hp14门+abortHp8;卡地形→stall转向二次放弃回bestSeen;反复远征→20min冷却+记barren质心;占用过久→8min上限。**改 interrupt 处理为 branchMine 式 break(草案原版清 interrupt 会致不可取消,已修正)**。
- **回滚**: 删 missionNether L896 前的 migrate 触发块(migrate.js 留着不调即 inert)。
- **注**: 这是用户纠偏后的**核心架构补全**(世界认知/搬家),把"搬家"从 forageExplore 短腿升级成真正人类式跨大陆迁徙。若验证通过,bot 应能自主逃离任何烂 spawn→去好地安家→在那里跑通已验证的铁tier能力链(C218/C219)=可能根除"海洋荒漠死循环"。

## C219. ★★木/台回补死区：地表补木 food 门槛 14→(8||hasEdible)——解 iron_pickaxe 卡 TABLE gate（③层 prepNether 热加载，🟡待验）
- **触发**: C218 让 bot 抵达铁 tier(3 iron_ingot)后,立刻卡在下一层:`prepNether: TABLE gate for ... tableInv=0 tableNear=no planksMax=1 logs=0`(深 y41,健康 hp19/food13,重复 3min+)。有铁造不出 iron_pickaxe(需工作台,做台需木,木用光了,深处无木)。
- **机理(subagent #2 带行号钉死)**: prepNether 有"缺木→上地表 surfaceUp→chopWood→做台→craft"的闭环恢复(handleTableRecoveryBlocked L615-668,surfaceUp@L641),触发点是 `block.safeDay`。但 `safeDay = normalSafeDay(L596: food≥14) || famineVerticalEmergency(L597: food≤2)`。**food13 恰好落在 `>2 && <14` 死区——两个窗口一个都不开**→直落 L660 只打日志+wait(6000)→热加载再进→死循环。健康 bot 仅因 food 差 1 点(13 vs 14)就既不补木也不应急,纯空转。工作台没"丢"(回收逻辑 keepKit L1833 存在),是 bot 带工具深挖离开了地表的台子、把补台的木用光了。
- **改动(C219, ③热加载, prepNether.js:596)**: `bot.food >= 14` → `(bot.food >= 8 || hasEdible())`。保留 hp≥14(地表战斗安全)/白天/threat=0;手里有吃的就放行(keepFed 同轮先吃),没吃的也要 food≥8 才上,避免饿着爬。补上 8-13 死区。
- **预测(可证伪)**: 下个 prepNether 周期(food≥8 健康白天),progress 应从 `TABLE gate ... no repeat 3x3 craft loop` 翻成 `TABLE recovery for iron_pickaxe ... daylight safe window, bounded surfaceUp`,bot 上地表 chopWood→做台→`craft iron_pickaxe`,进而铁镐/铁甲。若仍 `TABLE gate` 空转则证伪。
- **观测**: 🟡 `node --check` 过;customSkill cache-bust 即时生效,下次 prepNether 调用加载。等心跳验证 surfaceUp 触发。
- **风险/副作用(subagent 核过)**: 有 pick 时 surfaceUp 冷却 120s(L637)不会抖;夜/dusk/威胁仍 false→照常 hole up(只动 food 没碰 night/threat gate);food13 砍 2 棵木消耗极小不跌 famine;防紧循环保护(L660-666)完好。
- **回滚**: 恢复 L596 `bot.food >= 14`。
- **注**: 同 C218/C217 母题——**保守 gate 阈值/假设过严,把合理的轻量推进行为卡死**。第 3 个经 subagent fresh-context 调查+我审 diff 后应用的 contained ③ 修复。这三连(C218 铁墙+C219 木台回补)若全验证,bot 应能自主 铁镐→铁甲→扛夜=打破死循环。

## C218. ★★★铁墙真根因：采矿缰绳 v2（漂移基准 bed→采矿起点）——解锁 iron/全进度链（③层 achieve.js 热加载，✅全链验证）
- **★✅验证成功(00:19-00:28, ~10h来第一次自主抵达铁 tier)**: C218 部署后白天窗口,bot 全自主跑通完整进度链:`branchMine:descent-clear y64→63→...→42`(深挖下降)→ 采到 **116 cobblestone + 木头**(C218前永远`have 0`)→ 木镐挖断 NOPICK → 递归 `place table`+`craft stone_pickaxe`(自主 bootstrap)→ `collect iron_ore (xray)` → 得 raw_iron → `smelt raw_iron->iron_ingot`(furnace×1 + coal×28 fuel)。**leash 不再阻断=铁证**(执行流到达 collectBlock/mine-probe/smelt,旧`152格离锚`消失)。死因稳定 deaths=339(深处健康作业,无死)。预测全部命中。
- **触发**: C217 把永久冻结转成 respawn 循环后,fresh 健康 bot(hp20/food20)在白天撞上老问题:`NO KNOWN WAY to obtain iron_ingot/shield` 死循环,卡石器 tier 无法造甲。**派 subagent 深查(fresh context,只读)**——根因和我假设的(y90 深挖决策)**完全不同**。
- **★机理(subagent 带 live 日志钉死)**: 真凶=**mining LEASH 采矿缰绳(achieve.js:670)用 bed 当漂移基准**。bot respawn 在世界出生点(7,35),距 bed.json(151,-14)=**152 格>80 阈值**。缰绳在 COLLECT 循环顶部、`collectBlock` 之前触发→召回(8s 走不到 152 格)→`152→152 ok=false`→**return false**。所以 bot **连脚下的 cobblestone/iron_ore(零漂移)都采不到**——"离 bed 远"被误判成"采矿漂移"。链式:无 cobble→无石镐→无 iron_ore→无 raw_iron→`NO KNOWN WAY to obtain iron_ingot`→无 shield/iron_pickaxe。日志铁证:**从无一行 `collect (xray)`/`mine probe`**=执行流到不了深挖逻辑(我原以为的 y90 决策 bug 是误判,那段对的、没被执行到)。
- **机理2(锚点错配)**: 缰绳本意防 digDown 链漂出家圈(deaths 214/221 雷区坠亡)——但那是**采矿过程的位移漂移**,基准本该是"采矿起点"而非"当前离 bed 多远"。bot 一 respawn 远离规划家就被永久禁采=世界无关的真 bug(任何世界 respawn 远离 bed 都触发)。
- **改动(C218, ③热加载, achieve.js:670-699 整段替换)**: 缰绳 v2——漂移基准改用 `bot._achieveMineOrigin`(进采集时记录、90s 无活动才重置);**drift>64 格才召回到采矿起点(近、走得到),回圈内即重置起点继续采**;bed 仅作 256 格绝对兜底(防真·跨区乱挖)。站着采脚下矿 drift≈0→永不触发。
- **预测(可证伪)**: 下个**白天**窗口(过 night-exposed gate 后),progress 应出现新格式 `mining LEASH: drift=N bedD=152` 且 **drift 小→放行→出现 `collect cobblestone/iron_ore (xray)` 真采矿**,bot 拿到 cobble→石镐→深挖到 y<57→raw_iron→熔铁→iron_ingot/pickaxe/shield。若仍 `NO KNOWN WAY` 且无 collect 日志则证伪。
- **观测**: 🟡 `node --check` 过;customSkill `?t=${Date.now()}` cache-bust=即时热加载无需重派(skills.js:4037 确认)。**00:08 旧 `mining LEASH: 152格离锚` 已消失**,采矿改由 night-exposed gate(夜临近 y90 暴露,合理)拦停→sealed night hold。但 night-exposed 在 gate 链排 leash 之前,夜里走不到 leash=**真验证待白天**。
- **风险/副作用(subagent 核过)**: 木/钻石路径走独立缰绳(chopWood/mineDiamonds),不受影响;只放宽石/矿就地采。不重新引入漂移乱挖(drift cap 仍管 digDown/branchMine 累积位移,bed 256 兜底)。深挖安全:**branchMine 自带完整 lava/water/bedrock 防护**(digBlock L150 流体即 blocked、楼梯每步查 BAD_FLUID、无地板搭桥不空踩)——这正是手动 branchMine(24,32) 能安全拿铁的原因,放行不增溺死/岩浆死风险。
- **回滚**: 恢复 achieve.js:670 的 bed-基准旧缰绳(不建议——已 live 证实是铁墙死循环根)。
- **★方法论**: 派 subagent fresh-context 攻复杂核心技能(achieve.js)的深 bug=既推进又不污染主 context、不疲劳 rush 改核心;我审 diff(核对实际代码+bed.json 152格)后才应用。这是用户"自己调 subagent、所有东西搞定"的正确执行。

## C217. ★★★补 C216 漏掉的 hp<8 永久冻结：last-resort venture 出口（③层 missionNether+forageExplore 热加载，✅全链验证）
- **★✅验证成功(C217c 全链路, 23:42-23:43)**: `★HP<8 LAST-RESORT (frozen 25min @hp2, enclosed y=78) → surfaceUp(96)` FIRE → bot 从 y78 封闭口袋升到地表(移到 20,87,37)→ fall 死(isNight=false/hostiles=0)→ **重生 fresh hp20/food20 @ -24,95,34, SAMEPOS 解除**。**50min+ 永久冻结被打破**,走 C217 设计路径"find-or-respawn beats frozen-forever"。死因 fall(非预期觅食/怪死)但结果=设计目标(满血新周期>冻死原地)。**附带纠错:`bot._noRegenFrozenSince` 挂 bot 对象上跨 skill 重派持久(只 code 重载、bot state 不重置)**——所以 timer 连续累积、重派后 2min 即 fire(非我以为的归零)。**遗留小问题:surfaceUp 后地表移动 fall 死(surfaceUp/爬升致摔)——非冻结-exit 的核心,留观**。
- **触发**: 24/7 心跳连续 ~50min+ 抓到 bot 在 27,78 **hp2/food11 完全静止**(SAMEPOS 反复刷),deaths=337 零进度。取证:`prepNether stand-down: low-hp/no-food cooldown...body stays free` + `cooldown feedUp gated: no-regen low-hp/no-food, no close confirmed food signal`→ wait 12s 循环。inventory 显示其实有 stone_pickaxe/sword+cobble21+furnace(石器 tier,非裸装)——**卡点纯食物**:hp2(摔伤)+food11<18(MC 回血需 food≥18)+easy 难度饥饿不杀到 hp10 以下+hostiles=0→**hp2 完全静止 stable freeze,既不死也不恢复**。
- **机理(C216 推理的漏洞)**: C216 给 no-regen hold 加了 **hp≥8** relocate 出口,但注释假设"hp<8 太弱,no-win 由死亡解决"——**实测错误**:hostiles=0 且无摔落/岩浆时,bot 在 hp<8 **永远不会死也永远不会恢复**(贫瘠点无食物源),坐死在原地(50min+ 实锤)。突然受伤(20→2)还会**跳过 hp≥8 窗口**直接落入 hp<8 死锁。两个出口在 hp<8-no-regen 全关:BREAKOUT(L729 no-regen gated)+C216(L840 hp≥8 gated)。
- **机理2**: forageExplore 第66行硬 `if(hp<=6) abort`(不可配)——即使放宽 gate,hp2 也会 leg1 立即 abort,所以单放 missionNether 出口无效。
- **改动(3处, 全③热加载)**: ①forageExplore L66 abort 阈值改可配 `opts.abortHp ?? 6`;②missionNether 在 C216 的 hp≥8 分支之后加 **HP<8 LAST-RESORT**:`_noRegenFrozenSince` 计时(移动>10格清零),frozen>**12min** + 白天 + 无 actionable 威胁(8格) + 5min 节流 → `forageExplore({gateHp:1,abortHp:1,gateFood:4,maxBlocks:160})` 强制 venture;③L682 移动检测清 `_noRegenFrozenSince`。**理由**:frozen-forever 严格劣于有界 venture(走出去要么 load 到食物/地形,要么死→hp20 fresh 重生,都胜过原地烂);survival 反射在 venture 中仍活。
- **预测(可证伪)**: 下次 bot 白天 hp<8 no-regen 无食物 frozen >12min 时,progress 应出现 `★HP<8 LAST-RESORT venture: frozen Nmin...forceExplore`,bot 开始移动(心跳 pos 变化/SAMEPOS 解除),要么走到新地形要么死→重生 hp20。若仍 SAMEPOS 永久不动则证伪(查 forageExplore 是否被 enclosed pocket 困住——若是需补 surfaceUp 分支,如 C215 L663-668)。
- **观测**: 🟡 `node --check` 双过;cancel→重派 fresh import 确认。**活体验证逮到 bug→C217b 修正**:首版 frozen-timer 被**每 4min 的 BREAKOUT 重置循环清零**(L705 进 BREAKOUT 时 L706 `_stagPos=null`→下轮 L682 `!_stagPos` 真→我 piggyback 的 `_noRegenFrozenSince=null` 跟着清),timer 永远到不了 12min,last-resort **永不 fire**(进度日志穿过我的块直落 `cooldown feedUp gated`=未触发)。**C217b 修复**:①L682 只在**真实移动(_stagPos 存在且 dist>10)**时清 timer,不在 re-arm(_stagPos=null)时清;②`!noRegenNoFood()` 时清 timer(recovered→reset)。23:19:20 重派 fresh。等 ~23:31 白天窗口验 venture fire。**教训:piggyback 在共享状态(_stagPos)上很脆——它的 null 有"移动"和"re-arm"两种语义,别混淆**。
- **观测2(C217b 成功+C217c 跟进)**: ✅ **23:37:10 last-resort 首次 FIRE**:`★HP<8 LAST-RESORT venture: frozen 20min @hp2 food=11 hostiles0 — forceExplore`——timer 机制+C217b 修复**验证通过**(熬过一夜累积到 20min,次日白天首次运行即触发)。**但 bot 仍 SAMEPOS 27,78 未移动**——progress 显示 `underground/enclosed y=78`,forageExplore 的 goToPosition 无法从封闭口袋水平 NoPath 出去(正是 C217 预测的证伪点 + C215 的已知限制)。**C217c 跟进**:last-resort 加 enclosed 检测(`hasOverheadCover() || mobility.enclosed/POCKET/ENTOMBED`)→ enclosed 时先 `surfaceUp(y+18)` 出坑(复用 C215b L661-669 模式),else 才 forageExplore。23:40:12 重派 fresh。**完整链待验**:下个 day+frozen12min(~23:52)应打印 `★HP<8 LAST-RESORT (...enclosed...) → surfaceUp` 且 bot y 上升出坑;出坑后下一轮在地表 forageExplore 真位移。
- **★方法论价值**: 这条是"**活体验证逮 bug**"的范例——纯静态推理给出的 C217 有两个隐藏 bug(4min-timer-reset + enclosed-NoPath),都只在跑起来盯日志才暴露。预测字段里预先写下证伪点("若 enclosed 则需补 surfaceUp")让我一看 SAMEPOS 就知道是哪个 case。
- **回滚**: 删 missionNether 的 HP<8 LAST-RESORT 块 + _noRegenFrozenSince 清除 + forageExplore abortHp 恢复硬编码 6。
- **注**: 这是给"无出口保守门叠加"病的又一个增量出口(用户核心诊断)。**根治仍是 Arbiter 死锁检测+强制解**(本条是其③层手工前身)。⚠️**世界级 confound 不变**:此修复只把"永久冻结"转成"venture/重生循环",不能让无食物海洋荒漠世界变得可通关——A/B/C 世界决策仍是真进度的红线。

## C216. ★★反死锁(C215家族)：no-regen 低血/无食 hold 加 hp≥8 relocate-forage 出口（③层 missionNether 热加载，🟡待验）
- **触发**: 24/7 值守心跳抓到 bot 在 97,72 **白天硬冻 ~40min**(hp4/food7,act_trace 100% 静止)。progress=`TABLE gate for shield(无木/台)` + `no-regen trip gate(hp4 不肯走59格去bank)` + `cooldown feedUp gated: no-regen low-hp/no-food, no food signal`→ wait 12s 循环 = **永久 freeze**。这是核心架构病"一堆无出口保守门叠加=瘫痪"的最清晰活体死锁。
- **机理**: missionNether no-regen stand-down(L813+)在 `noRegenDryScan`(no-regen+无本地食物信号)时只 log gated + wait——**贫瘠点永远等不到食物信号→原地退化到 hp4 frozen wedge**。它只会 feedUp(本地觅食,找不到),从不 RELOCATE(远行找食)。C215 给 low-food hold 加了 forageExplore relocate,但 no-regen hold 没这个出口。
- **机理2(关键)**: hp4 时 forageExplore 因 hp<6 自动 abort(太弱不能安全觅食)=hp4 deadlock 无安全出口(世界造的 no-win,只能死亡解)。**但 hp≥8 时就该 relocate**——在退化到 hp4 前主动搬去找食=**预防死锁**。
- **改动**: `noRegenDryScan` 分支加出口:**hp≥8 + 白天 + 无 actionable 威胁(8格) + 90s 节流 → forageExplore(gateFood5/gateHp8/maxBlocks200) relocate**,而非 wait/freeze。hp<8 仍走原 gated+wait(真 no-win)。
- **预测(可证伪)**: 下次 bot no-regen+无本地食物+hp≥8 白天时,progress 应出现 `no-regen deadlock-breaker: ... forageExplore relocate`,bot 主动远行找食而非原地退化;应减少"退化到 hp4 frozen wedge"的发生。若仍频繁硬冻 hp4 则证伪(需查 forageExplore 在该地形为何不动/relocate 失败)。
- **观测**: 🟡 `node --check` 过,cancel 重载触发。当前 hp4 bot 不受益(<8,经死亡解);验证下个 hp≥8 no-regen 周期。
- **回滚**: 删 noRegenDryScan 的 forageExplore 出口,恢复纯 gated+wait。
- **注**: 这是无作弊、热加载、contained 的结构修复(给死锁出口=用户要的"加油门"),非作弊 crutch、非 reckless 大改。根治仍是 WorldModel/Arbiter 统一 un-stick,本条是其增量前身。

## C215. ★★反 idle-hold：低食物 hold 改为主动 forageExplore 搜食/搬家（③层 missionNether 热加载，🟡待观测）
- **触发**: 24/7 值守中 5min 心跳抓到 bot 在 29,76 完全静止(act_trace 无按键/挖掘/寻路),progress=`★BREAKOUT gated: prepNether low-food hold food=10` + `NO KNOWN WAY to obtain iron_ingot`——海洋出生点周边陆地也食物贫瘠+无铁,bot 被低食物 hold 钉在原地空转=吸收态 livelock(用户担心的"卡住"实锤)。手动派 forageExplore 把它移动了 55 格(游泳本能 work,游过水安全上岸)但该区无食物→返回→又 idle-hold 在 65,77。
- **机理**: `missionNether.js` lowFoodHold 分支(~643)纯 `pathfinder.stop()+clearControlStates()+wait(5s)+continue`=原地 hold。食物荒漠里坐着=必无食物(吸收态);唯一真解是 TRAVEL 到有食物的生物群系。但该分支从不主动行动。
- **改动**: lowFoodHold 分支加"主动搜食"出口:**白天 && 无 actionable 威胁 && hp≥10 && 60s 节流 → `skills.customSkill(bot,'forageExplore',{gateFood:6,gateHp:10,maxBlocks:180})`**(去找陆地动物,自带夜/敌对/hp≤6 中止,有界);夜/威胁/低血仍 idle-hold。反复 forageExplore 跨 cycle=粗粒度搬家,逐步走出荒漠。热加载,无重启。
- **预测(可证伪)**: 下次白天 low-food hold 时,progress 应出现 `low-food hold → forageExplore`,bot 持续移动(心跳 pos 不再反复同点/SAMEPOS),多 cycle 逐步远离 spawn;若最终走到有动物的生物群系则 food 回升、hold 解除、能继续 prepNether。若仍 SAMEPOS 原地不动、或 forageExplore 每次秒返回无位移,则证伪(需查 forageExplore 为何不动/该区彻底无可达陆地)。
- **观测**: 🟡 `node --check` 通过,热加载。等 5min 心跳验证 bot 是否从 idle 转为持续 forage 行进。
- **回滚**: 删 lowFoodHold 分支里的 forageExplore 出口,恢复纯 idle-hold。
- **注**: 这是 idle-stuck 的对症系统化(把手动 forageExplore 自动化进 hold);**根治仍是 WorldModel 大局认知(识别"区域贫瘠→定向搬家到已知/可探的好群系")**,本条是其前身(无方向的随机搜索)。

## C214. ★dig-nav 下降：委托 branchMine 斜楼梯（不再手搓）——y84→y62 可靠下降+采矿（③层 escapePlan，✅实测）
- **触发**: Phase B 暴露通用 pathfinder 从封闭坑/竖井秒 NoPath，bot 到不了地下。我给 escapePlan 加通用 `digNavTo(target)`（下降相+水平相），但**下降相手搓反复失败、打转十几轮**：①mobility POCKET 态 tick-veto 每帧碾掉 stepToCardinal（加 `bot._climbingAt` 心跳压住瞬间空转，但只压 MAROONED 锚不压 POCKET）②楼梯 step-down-walk 脆弱（bot 在 dug ledge 不肯迈步坠落）③改直挖脚下：**坐标 bug**——方块坐标该用 `Math.floor` 不是 `Math.round`（bot 站方块中心 x.5/z.5，round 指偏一格挖错旁块）；修 floor 后**仍不掉**（`below=air` 却停 y84）= 挖正脚下方块不可靠掉落的 mineflayer 边界情况。
- **机理(只读 subagent 刨到)**: bot 在 missionNether/achieve 下确实能 y84→y57，**靠的是 collectBlock/goToGoal 破坏式寻路追矿下降**；专用下降原语 = **`branchMine(length, targetY)`**（achieve.js:852/870 在用），它挖 1×2 **斜**楼梯（下+前，永远有前方格可迈入），自带 gravity/step/tool/lava/stepEdgeAssist/localDropStep。**手搓失败根因**：挖正脚下方块不可靠掉落（mineDown.js 同款 no-op）；正解是斜楼梯，且**坐标用 floor**。
- **改动**: digNavTo 下降相从手搓改为**委托** `await ctx.skills.customSkill(bot,'branchMine', clamp(dy+6,10,40), target.y)`，循环重评（branchMine 可能遇矿/洞早停则再调）。坐标 round→floor。保留 `_climbingAt` 心跳。
- **预测(可证伪)**: 给 digNavTo 一个低于当前 y 的目标，bot 应可靠斜楼梯下降到 target.y（不再第 1 步 stall），沿途挖矿。
- **观测**: ✅ **实测**: navTo target y48，bot 从 **y84→y62**（降 22 格，无卡死），沿途挖到 **raw_iron×4 + coal×33**（productive descent）。对比手搓版第 1 步就 stall。dig-nav 下降相成立；水平相复用原 tunnel 执行器（floor 坐标已修）待单独验。
- **回滚**: digNavTo 下降相恢复手搓直挖/楼梯（不建议——已证死胡同）。
- **★通用教训**: 手搓执行原语反复失败→停，找 bot 现成能做这事的代码委托之，别 guess-test 自己的版本。

## C213. ★★BodyGate-P0：cancel 可靠即时（in-flight dig 立即中止）——4 分钟挂起→~1 秒（核心层，✅已重启验证）
- **触发**: 走位/dig-nav 测试反复被卡——给 bot 发 `cancel_skill` 后，正在挖矿的 missionNether **连续 4 分钟、两次 cancel 都不放手**、死占身体（`_skillRunning` 锁不释放→新 skill 全被 busy 拒），最后被迫重启 bot 才夺回控制。这是测试/驱动任何新控制器（探针/EscapePlanner/Arbiter）的硬前置。
- **机理(两只读审计 agent 刨到 file:line)**: `cancelSkill`(ws_server.js:258-262) 设了 `interrupt_code`/`_supervisorCancelAt`/pathfinder.stop/clearControlStates，**但漏了 `bot.stopDigging()`**——而 `breakBlockAt`(skills.js:1241) 是 `Promise.race([bot.dig(block,true), 60s超时])`，in-flight 的 dig promise 没人 reject 就死等到 60s 超时；长挖矿循环把多次 60s 叠加=分钟级挂起。`agent.requestInterrupt()`(agent.js:170) 本来就调 stopDigging，**supervisor cancel 路径漏了这一步**。`safeDig`(skills.js:794, collectBlock 走它) 同款无 interrupt 感知。
- **改动**: ①`cancelSkill` 补 `bot.stopDigging()` + `collectBlock.cancelTask()` + `pvp.stop()`(照抄 requestInterrupt)——in-flight dig 立即 reject。②`breakBlockAt` 的 Promise.race 加第三个 racer：每 200ms 轮询 `interrupt_code`，命中即 stopDigging+reject('Interrupted')→return false。③`safeDig` 同款 interrupt racer。
- **预测(可证伪)**: 发 cancel 后，正在挖矿的 missionNether 应在 ~1-2 秒内 `{cancelled:true}` 让出身体，而非 4 分钟。任意 in-flight dig 在 cancel/preempt 后 ~200ms 中止。
- **观测**: ✅✅ **重启验证两次**: cancel_result→missionNether skill_result 间隔 **1.7s 和 0.9s**（挖矿中），从 4 分钟降到秒级。`node --check` 三文件通过。
- **回滚**: 移除 cancelSkill 的 stopDigging/cancelTask/pvp.stop 三行；移除 breakBlockAt/safeDig 的 interrupt racer。
- **未做(P0 下半场)**: 身体单一主人令牌（bot._bodyOwner + bodyClaim/bodyReflexMayFire，反射可被 skill 夺权、保命反射 lava/drown/suffocate 仍 bypass）——这是 BodyGate 的"防互抢"另一半，cancel 可靠是"能停"、令牌是"停了之后谁接管不打架"。审计已出 file:line 设计方案，待实装。

## C212. ★基础 tool 质量：寻路到达容差回退上游 + parkour 开 + 空挥门 + motion_quality 监控（①②层，⏳待生效）
- **触发**: 用户第三视角实拍——bot **频繁卡在台阶/崖沿来回蹭**、**对空气挥舞**、**跨地形困难**。明确指出"对基本 tool 质量没有认知"，要求先把走位+行动做到脚本级，并设计代码质量监控。两个只读审计 agent 带回 file:line 级根因。
- **机理(根因，实锤)**:
  - ①**冒烟枪**: `patches/mineflayer-pathfinder+2.4.5.patch` 把路径节点到达容差从上游 **0.35 收紧到 0.175**(index.js:599)。台阶/崖沿上动量+跳跃弧线常落在 0.175~0.35 之间→控制器在同一节点死命重发 forward→**人在台阶边来回蹭**。影响**每一次移动**，与 Movements 配置无关。
  - ②`goToGoal` 的两套 Movements 都 `allowParkour=false`(skills.js:2543/2556)→无跨 1 格缺口/小跳→破碎地形只能绕路或挖→跨地形难。
  - ③`attackEntity` 的 `kill=false` 分支裸 `bot.attack`(skills.js:653)，逼近到 5 格就挥、不复检 reach/存活→目标移开或已死仍挥一记空拳(`kill=true` 分支早有 reach+12s 空挥门，`false` 漏了)。
  - ④空挥事件此前**完全无遥测**——肉眼可见，数据不可见。
- **改动**: (a) 容差 0.175→0.35：直接改 node_modules/index.js:599 + `npx patch-package` 重生成 patch(已无该 hunk，reinstall 不复发)。(b) `nonDestructive/destructiveMovements.allowParkour=true`(scaffold 仍关、maxDropDown 仍 2、lava 仍避)。(c) `kill=false` 分支补上"逼近到 3.5 格 + 挥前复检 `entity.isValid && dist<=3.5`，否则不挥返回 false"。(d) 新增 `motion_quality` 观察者模式(modes.js，仿 act_trace)：一次性包裹 bot.attack 计挥击、监听 entityHurt 计命中，5s 落一行 `motion_quality.jsonl`：空挥率 airRate / 台阶卡死 edgeStallMs / 平均移动速度 crossEff。
- **预测(可证伪)**: 安全重启后——edgeStallMs 在路径活跃时应大幅下降(不再长时间>2000)；crossEff 在开阔地行进应接近 sprint(~4-5 b/s)而非接近 0；近战交战的 airRate 应趋近 0(不再"挥了没命中")；肉眼第三视角台阶边来回蹭/对空挥应肉眼可见减少；parkour 开后破碎地形过境更顺、digToSurface/行军绕路减少。若 edgeStallMs 仍频繁>3000 或 crossEff 仍≈0，则容差非主因，需查 stuck 启发式(#4)与手动行走跳跃时机(#5)。
- **观测**: 🟡 **已部署+实地验证(部分)**。`node --check` 四文件全过；patch 已 patch-package 干净重生成。白天安全窗(tod~4453/hp14/地下FREE)杀 main.js→watchdog 自动重生(CreationDate 16:08,双端口 live,agent.err 空无加载错,`motion_quality.jsonl` 每6s 在写=新模式加载成功)。bot 随即被 prepNether 低食物门(food=7)钉住不动→走位指标全0,遂用 `verifyWalk.js` 探针(sticky-swap 派发,白天/hp守卫/方形巡逻/自还原)实地采样:**行走窗口 edgeStallMs 全程=0(无台阶边卡顿)、crossEff 峰值 3.58 b/s(健康步速)、totalDisp 回到原点 0.9格、hp 14→14 全程0掉血**=容差回退+parkour 的核心预测验证成立。空挥率(airRate)未测(探针未遇怪);parkour 破碎地形过境、空挥门留作 bot 自然行进/交战时的后续观测。探针自还原 sticky→missionNether 已恢复。
- **回滚**: 容差改回 0.175(还原 patch hunk)；parkour 两处改回 false；`kill=false` 分支恢复 dist>5 逼近+裸 bot.attack；删除 motion_quality 模式。
- **未做(放第二批，需数据)**: #4 stuck 启发式(1.5格/3s 太凶，误杀慢-但-真在走/挖→乱切+假 MAROONED)、#5 手动行走跳跃时机(escapePlan 顶墙 800ms 才跳；stepEdgeAssist 失败 8s 锁定)、#6 followPlayer/collectBlock 配置不统一(parkour/maxDropDown 各异且每次重建 Movements)。先用 motion_quality 数据判断这几条是否仍是瓶颈再动，避免又陷"无穷打地鼠"。

## C211. ★★★总根因：core self_preservation 赤手满血也永久 dig-in，压倒一切（①层 modes.js，已安全重启验证）
- **触发**: 一整夜 bot 反复卡死(hp10/hp3/各种状态),我误判过"食物荒漠/agent崩溃/永久软锁/我的skill坏"等多个红鲱鱼。最终读 live `events.log` 抓到真相:刷屏 `Outmatched (1 mob, hp 20) — digging in!` 每 0.3s 一条——bot **满血 hp20** 也在永久"挖洞躲"。
- **机理(真根因)**: `shouldFlee()`(modes.js:329) 判据含 `!hasWeapon → cantWin`。bot 死亡掉了剑→赤手→即使 hp20 对 **1 只**近战怪、`closest<5` 也返回 true→self_preservation 永久 dig-in。重生必然赤手→永远 bootstrap 不出武器(挖洞不会造剑)→锚定→MAROONED→锁死→死→再赤手重生→**死亡循环的总发动机**。**前面所有现象(食物荒漠困死/低血stand-down/我的mineDown/digReset/forage全空转)都是下游**:它们在跟这个每0.3s的tick行为对抗,必然被碾压。我花一整夜堆 skill,真正该改的是 core 这一个判断。
- **改动**: `shouldFlee` 加"健康-赤手 bootstrap 出口":`hp>=16 && hostiles.length===1 && !/skeleton|stray|creeper|witch|ghast|blaze|pillager/` → return false(放行,让 bot 去砍树造剑或反击)。远程/creeper/成群/低血/近期受击仍在上面照常逃。
- **预测**: 安全重启后,赤手满血 bot 不再永久 dig-in;会移动、砍树、造剑、推进。
- **观测**: ✅✅✅ **端到端验证成功**。安全重启(bot hp20、MC java全程未碰、新进程CreationDate 10:38、ports live)。bot 从卡死数小时的 `3,80,4` → 移动到 `10,76,-3` → 长途 `91,66,-36`(走~85格出 spawn 区) → `92,63,-32`,mob=FREE,`Outmatched`刷屏归零。**库存从仅 dirt+saplings → wooden_sword=1/stone_pickaxe=2/cobblestone=42/coal=36/furnace=1/oak_planks** = bot 自主 bootstrap 出武器+工具+采矿。死亡数稳定 318。
- **★教训(整夜苦战换来,最高级)**: ①**tick 级 core 行为压倒一切 supervisor skill**——skill 在 live 空转时,先查是不是 core tick 模式(self_preservation/mobility)在每帧覆盖,而不是怪 skill 本身。②**先读 live events.log 的高频刷屏行**:它直接暴露 tick 模式在干什么,是最快的根因取证。③我误判了一长串红鲱鱼(食物荒漠/agent崩溃/永久软锁),教训:**"够不到/无解"的结论下得太早,真相往往在没读过的那个高频日志里**。④一行 core 修复 > 整夜 skill 堆砌:对准压倒性的那一层。

## C210. ⚠️监工事故复盘：反射式 live 干预把稳定 bot 推进 food=0 软锁（操作纪律失败，非技术）
- **触发**: escapePlan 把 bot 从死亡区凿出(C209)后，bot 在 `25,76,3 food=2` 又进 FAMINE backoff hold。scanFood 诊断显示最近食物=24 只鲑鱼在 ~40 格外 y57 水里(无陆地牲口/作物)。我部署 forage 让 bot 远行去猎——结果走/下降耗光最后 2 点食物(2→0)，到 food=0 时 tick 层 `self_preservation FAMINE body freeze` 冻住身体，forage 走不到鱼，hp 从 15 掉到 floor=2(Hard 饥饿伤害)。bot 现 `40,63,-17 hp=2 food=0` 永久软锁。
- **机理(双重)**: ①**操作错误**：bot 本来 food=4/hp=15 是"稳定卡住但饿不死"，我连下两个 live 动作(escapePlan 挪动 4→2、forage 远行 2→0)把稳定态推成濒死软锁——在脆弱 bot 上凭"想让它进展"反射式干预、未做耗食预算。②**结构 bug**：`food=0 FAMINE 冻结反射没有出口**——库存无食物时冻住=永远拿不到食物=永久卡死(与 kill-box hold 同类：保命 hold 无退出条件)。forage 与冻结抢身体=无 BodyGate 仲裁的老病。
- **改动**: 本条仅复盘+止损，**不对 hp=2 的 bot 再做任何 live 干预**(改 core 解冻结要重启，hp<8 触红线)。让其自然了结(phantom 大概率击杀→重生满食重置)。真正修复离线进行(见预测)，只在安全时机(满血/重生后)部署。
- **预测/待办**: ①forage v2：仅在 food≤9 且仍有缓冲、食物可达、耗食预算够时**提前**触发；禁冲刺；优先陆地食物避免下水；绝不当 food≤2 的最后一搏。②core modes.js：FAMINE 冻结加退出——无存粮+食物可达时让位觅食(BodyGate 仲裁，等安全窗重启)。③根治：食物充足时主动建食物源，不饿瘫才反应。④Arbiter 的 ESCAPE 当前混淆了"被困"与"饥饿"，饥饿应走 FORAGE 而非 relocate。
- **教训(★最高，用户两次批评换来)**: **改完 live 动作必须密集盯+理解机理，绝不反射式连续干预脆弱 bot；"想让它进展"的冲动是危险的——稳定卡住 ≫ 濒死软锁；任何移动型干预先算耗食/耗血预算；层间冲突(skill vs tick 反射)未仲裁前不要硬碰。**

## C209. EscapePlanner dig-tunnel 执行器 live 生效——2h+ 活锁被 planner 打破（③层 escapePlan 热加载，bot 实测脱困）
- **触发**: C208 建好决策层后，live 部署 escapePlan execute 首跑 `abort="no advance after dig at step 1"`——挖了块但 bot 没动(仍 9,52,-11)。
- **机理**: 两个执行 bug。①`tunnelPath` 出**对角步**(如 9,-11→10,-10)，mineflayer pathfinder/walker 不能穿未挖的实心拐角→NoPath。②`goToPosition(...,min_distance=1)` 对 1 格外相邻格判定"已到达"(GoalNear 距离≤1 即满足)直接不动；且 MAROONED 门会整体否决 goToGoal。
- **改动**: ①`tunnelPath` 改**纯基本方向步**(每步只动一个轴的1格，accumulator 让 x:z 比例跟踪 heading，绝不对角)。②新增 `stepToCardinal()`——底层 `lookAt`+`setControlState('forward')` 手动行走1格(planner 直接接管身体，绕开 GoalNear/MAROONED；带 late jump-assist + finally 释放控制)。两者均纯几何/可测。
- **预测**: escapePlan execute 应连续 dig+step 把 bot 沿 ENE 凿出死亡区(dist>r28)，clearedDeathZone=true，sticky 交回 missionNether 时 bot 已在死亡区外新地形→KILL-BOX hold 前提消失不再复发。
- **观测**: ✅ live 实测打破活锁：bot `9,52,-11`→`8,52,-2`(净~9格)，distFromDZcenter `23→31.3`(清出 r28)，vitals.skill 全程 escapePlan，无死亡(deaths=306 不变)，sticky 还原后 missionNether 在 `8,52,-2` 新地形接管。**165 条补丁+stock pathfinder 都打不破的 2h+ 吸收态活锁，被 EscapePlanner 一次脱困解决。** 离线 planEscape.test.mjs 22/22。commit `135ec93`。
- **操作教训**: PowerShell **工具调用间变量不持久**——`$abs` 在下一次调用为空导致 WriteAllText 抛错、sticky 还原失败。写 supervisor 文件一律用硬编码绝对路径，且仍须无 BOM(见 C208)。
- **遗留**: ①escapePlan 还是手动 inbox 部署，下一步建 Arbiter control-runner 让 ESCAPE 自动触发(影子→实控)，无须人工。②bot 仍 food=4 无存粮，出死亡区后觅食仍是未解结构问题。③stepToCardinal 首步 x 微抖(9→8)，方向大体对、清出成功，可后续打磨。
- **回滚**: `git revert 135ec93`(回到对角+goToPosition 版，会复现 no-advance)；或整体弃用 escapePlan(纯新增，不影响补丁层)。

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

## C91. 缺木荒漠种树自给（C279,②层 chopWood,待验证）
- **触发(2026-06-20 wooded_badlands 实机取证)**: bot hp20/food20 健康、commitment 正确锁 BOOTSTRAP_KIT,但背包 0 log/0 planks,chopDBG `nearest=NONE total=0 blk=3`——树只长在够不到的台地顶(3 棵全进 unreach 黑名单),reachable 永远 NONE。chopWood 空转 `chop→nothing→try craft table(0 planks 必败)→loop`,bot 漫游找 240 格外的 log,food 20→14 在掉。背包揣着 oak_sapling×8 + bone×2 却无代码用。
- **机理**: chopWood 为"树存在但够不到"做了海量工程(生走/跳爬/贴脸砍/远征锁向),但**没有"无可达树时自产木"的回退**。缺木荒漠/mesa 是普适地形,robust agent 应能用携带的 sapling 自给。
- **改动(C279)**: chopWood barren `!nearest` 路径(已 surfaced 后、漫游 relocate 前)新增 `_trySaplingGrow()`: 无 log/planks<4 且有 sapling 时,就近找 solid floor+开放 cell+sky clearance 的格子;地面非 plantable(red_sand/terracotta)就先垫一块 dirt;种下 sapling(按 NAME 确认,因 boundingBox=empty);craft bone→bone_meal(无需台)后 activateBlock 催熟最多 8 次。成功 stale=0 continue 让下一 iter 扫到树就砍;失败/未熟设 20-30s cooldown 落到原漫游逻辑,不死循环。
- **预测(可证伪)**: 下次 day-phase bot 在无可达树区(chopDBG nearest=NONE 持续),progress.txt 应出现 `sapling-grow: planting` → `sapling planted @` →(有 bone 时)`sapling-grow done: grew=true`,随后一 iter `nearest=oak_log@<4b` 并 `dug N logs`,木材 0→正;**不应**再出现纯空转 `nearest=NONE` 持续 + food 单调下滑到饿死/漫游 240 格。
- **观测**: 🟡 `node --check` 通过,chopWood 热加载已就位;当前为夜间(night-hold 跳过 chop),挂 Monitor baghy0pns 等天亮验收。
- **回滚**: 删 `_trySaplingGrow` 定义 + barren 路径那行 `if (await _trySaplingGrow())`。

## 待修队列
- **★★死6/7 根因=无甲+no-regen 脆弱(新世界值守,2026-06-19,下个聚焦项)**: C253/256/257 修好夜暴露后,死6(dawn骷髅射,无盾无甲)、死7(y45洞穴6怪swarm,hp20→13→8→5,无甲no-regen)接连发生。**总绑定约束=食物**: bot 反复卡 hp<14/food<18 no-regen→碰怪即崩,且拿到铁(12)先做 iron_pickaxe+盾、**不做甲**→撑不过 dawn/洞穴遭遇→死前丢光12铁。诊断到的具体机理: ①**feedUp 觅食窗口太窄**(desperationRoam line211): `food≥12 && !noRegenHurt → 不roam`,故 food13-16/hp满 时忽略 52格可见猪(maxAnimalClose food>10 达96但门先挡);food 跌破12 才触发,那时常已夜/有怪/地下→`hostileNear(8)`/`isNight` 又gate掉→**四条件(food<12+白天+8格无怪+动物近)难同时满足**。②**无食物缓冲**: 自认 food12=够,从不主动囤满→deep-mine 时 no-regen。③疑似**生肉直接吃**(porkchop 在手 food 没大涨)未 cook(生3熟8)。④**铁分配优先级**: 应甲优先于 pickaxe(survival>diamond),partial甲(chestplate/helmet)就能扛 dawn/洞穴。候选修(需干净设计+测试,勿rush): feedUp 安全时主动囤食到≥17建buffer / 低食物no-regen 时禁止 deep-mine 先上浮觅食 / 铁优先做甲 / 生肉入furnace cook。
- **enderman 视线豁免**(死276根因,已二次): 行军/凿崖 lookAt 扫过 enderman 脸=激怒。修: lookAt 前查路径上 enderman,目标点压低绕开头部。①层,下个重启窗
- **tool_keeper 备镐失灵**(16:40): 木镐磨尽无备——根因=木材buffer没囤够就开挖矿(#21 资源节奏)
  - **★强复现(06-16 02:50,run-killer)**: bot @y92 hp4/food17 软锁 15min+,inv 富矿(coal186/copper273/cobble346/leather3)但 **0 pickaxe + 0 sword + 0 log/plank + stick仅1**=镐磨断后无木重造(造镐需2棍/棍需plank/plank需log,全无)。prepNether 死循环 `TABLE gate for shield — no wood` 每9s重启;watchdog `Pinned 15min+ kicking stack` 强中断也治不了(资源死锁非软件pin)。叠加 hp4 食物荒漠 no-regen(food17<18不回血、无可食、venture全在hp<5 abort)=**多因绞死的吸收态**。**这是当前 run 的真正杀手:不是单一bug,是"挖矿前不囤木buffer→镐断→无木重造→连工作台都做不了"的资源节奏崩溃 + 食物荒漠**。指向 #21(挖矿前强制木材/备镐buffer)+ 食物荒漠 migrate 两大结构项,均非 hp4 可安全速修。
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

