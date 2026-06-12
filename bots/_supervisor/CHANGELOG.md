# Neko 改动台账（科学家模式）

> 接管者从这里开始：交接书 [docs/HANDOFF.md](../../docs/HANDOFF.md)，架构图谱 [docs/agent-architecture.md](../../docs/agent-architecture.md)。

每条改动 = 一个实验：**触发证据 → 机理假设 → 改动 → 可观测预测 → 观测/归因**。
纪律：每次死亡/异常复盘时翻此表，把证据回写到相关条目的"观测"字段；预测落空的条目要么修正要么回滚。
状态：⏳待生效(等重启窗) / 🟡已生效待观测 / ✅已验证 / ⚠️部分有效 / ❌已回滚

更早改动（第1-55轮）见 memory/mc-agent-supervision.md 与 git history。本表从 2026-06-11 当班起记。

---

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
