# endgame 预审 (2026-07-05, 24-agent 对抗核实, 15 条确认缺陷)

完整证据链: 见本次审计 workflow 输出。按阶段顺序修复; P0 两条(missionNether BREAKOUT 维度洞 + oracle-daemon 下界 locate)优先。


=== gatherObsidian.js: confirmed 2, P2 3
  [P1-大概率炸] STEP B 采水是硬性入口前置但既无就地搜寻半径外的迁移逻辑、world_model 提案门也不预检水源 — 派发点 32 格内无水即确定性 false→3-strike→5min 冷却→原地重派死循环
      FIX: world_model.js:857-869 增加 waterSourceSignal(bot) 预检(照抄 flintSourceSignal 的 30s memo + findBlock water 32格 模式); gatherObsidian STEP B 加与岩浆分支对称的有界 moveA
  [P1-大概率炸] 挖矿环节不排除 bot 自己站立的方块列: safeToMine 只保证掉落物安全(water 沾边即放行'下方是岩浆'), pathfinder 会把 bot 送上黑曜石壳, 挖脚下/站立格 → 直坠壳下岩浆层
      FIX: 在 :201 的 safeToMine 之外增加: `const feet=bot.entity.position.floored(); if (c.x===feet.x && c.z===feet.z && c.y<=feet.y) continue;` 并对 `isLavaB(bot.block
  [P2] flint 断供死角 = oracle 接缝的准确位置: 无 flint 且 32 格无 gravel 时 GET_PORTAL_KIT 永不提案且无任何 kind 供 flint, 战略级静默卡死; oracle 的 ruined_portal@352,14
  [P2] 铁预检把 raw_iron 按 1:1 算作可用, 但技能内转化链还需要 熔炉+燃料(冶炼) 和 工作台(桶 3x3 配方) — 三者均无预检, 缺任一即确定性 false 循环
  [P2] 黑曜石已达标(≥target)只缺打火石时, 技能与提案门仍双双索要 3 铁的桶 + 32 格水源 — 本次 run 一次都不会倒水, :89 却因缺桶/缺水硬 abort

=== realNetherPortal.js: confirmed 1, P2 3
  [P1-大概率炸] enterPortal 走门方式是「forward 按住 1500ms」— 以 ~4.3 格/秒步速直接穿过 1 格厚的门框平面走到门背面, 生存模式需要 80 tick (4s) 连续站在 portal 方块内才换维度, 首次点火成功后大概率永远进不去门
      FIX: 把盲走 1500ms 改为条件停止: setControlState('forward') 后以 50ms 步长轮询脚下方块 === 'nether_portal' (上限 ~2s), 命中即 clearControlStates; 未命中则回退一格重试, 再进入换维度轮询。
  [P2] 点火阶段: 4 个 lightTargets 中第 3/4 个 (柱内侧面) 是死代码 — bot.activateBlock 默认点击顶面 (0,1,0), 火只会试图生成在柱子自身 gy+2 的黑曜石格里必然失败; 且点火前无任何 goToPosition
  [P2] 复用路径落盘的锚点可能是门的上层格 (gy+2/gy+3), 与 relight 分支「锚点=内部底格」的硬前置矛盾 — ghast 炸门后 below 不是 obsidian, 零成本复燃分支自我失效, 退化为 memo-miss → 全套重挖
  [P2] 门槛与技能前置不一致: ENTER_NETHER 提案门的垫块指标接受 cobbled_deepslate (fillBlocks≥32), 但技能内柱基支撑和必放的顶排临时支撑硬编码只认字面 'cobblestone' — 深板岩型库存能通过提案门却在放完 

=== missionNether.js: confirmed 2, P2 3
  [P0-首战必炸] 下界胜利态会被 BREAKOUT 定期拆掉: 停滞计时器/隧道逃生跑在 inNether() 检查之前, 且锚点用主世界 bed 坐标、无维度守卫、无 1:8 换算 — 进下界后每 ~4-5 分钟朝错误方向凿 10 格, 离 portal 越来越远
      FIX: 把 :1049 的 inNether() 胜利态检查整体移到 :826 BREAKOUT/停滞块之前 (或给 :920-1046 整块加 `!inNether()` 守卫); 若确需下界内逃生, 锚点必须带维度标签并按 1:8 换算, 且 netherrack 采集上限改为循环消耗 (如丢弃再采) 
  [P1-大概率炸] isDuskNow 未定义 — :863 直接 ReferenceError; 被 :1047 的空 catch 吞掉后, C273 BOOTSTRAP COMMIT 与整个 lowFoodHold 后半段 (anti-idle forage/migrate/hold) 全部静默失效, 控制流反而落到 C273 要压制的 :1349 migrate
      FIX: 在 :318 isNightNow 旁补定义 `const isDuskNow = () => { try { const t = bot.time.timeOfDay; return t >= 12000 && t < 13000; } catch (e) { return false; } };
  [P2] kitted 分支的 '失败回落 prepNether 补料' 注释是假的: 只要 obsidian>=10 且 f&s>=1, :1082 无条件 continue, prepNether(:1360) 永不可达 — realNetherPortal 因不消
  [P2] 迭代上限返回值违反返回契约: 跑满 5000 iter (数小时真实作业) 后 :1491 `return inNether()` — 未在下界就返回 false=申报'零进度', 会被 3-strike/冷却层错误惩罚这个明明一直在推进的 sticky
  [P2] 与 bot._world.oracle 的接缝不存在: missionNether 全文零引用 oracle — 若按 '下界总指挥' 预期启用, fortress/bastion 坐标 (oracle.nearest) 永远不会被消费, 下界阶段永久停在 p

=== blazeRods.js: confirmed 3, P2 1
  [P0-首战必炸] oracle.fortress 接缝的数据源根本不可能出数: oracle-daemon 的下界 /locate 没切维度, RCON 命令源恒在主世界, fortress/bastion 查询 100% 返回 'Could not find a structure' → parseLocate=null → oracle.nearest.fortress 永远为 null。若按计划把 blaze
      FIX: oracle-daemon.mjs:105 改为 `execute in minecraft:${dim} positioned ... run locate ...` (dim='overworld'|'the_nether'|'the_end' 直接拼 minecraft: 前缀)。接缝落点建议
  [P1-大概率炸] 下界死亡重生回主世界后, 找堡垒/烈焰营地两个循环都不复查维度 — 技能变僵尸继续跑: 在主世界扫 nether_bricks、按下界坐标系的 origin 走探索腿, 最多烧完剩余 8 分钟预算, 且 supervised busy 锁全程占住身体 (承诺虽被 isGoalDone 释放, kernel 却派不了新技能)。首战打烈焰(3 心火球+ghast)死一次的概率很高, 死即触发。
      FIX: 在 :268 与 :302 两个循环头部 (以及 :205 exitNether 行走循环) 增加 `if (!inNether()) return eyeEq() > eyeEq0 ? eyeEq() : 0;` — 返回 0 (falsy-but-not-false) 而非 false: 死亡重
  [P1-大概率炸] goWithTimeout 把 goToPosition 的 resolve(false)(NoPath/走不拢/MAROONED 压制)当成功返回 true — 探索循环的『失败换向』逻辑因此整体失效: 撞上熔岩海方向 ~2s 快速 NoPath → ok=true → st.leg++ 沿同一堵墙越走越远, dirIdx 只在 45s 超时才轮换, 与 :278 注释 'change head
      FIX: goWithTimeout 捕获实际返回值: `let r; await Promise.race([(async () => { r = await skills.goToPosition(bot, x, y, z, range); })(), new Promise(...timeout)]);
  [P2] exitNether 两处无视 eyeEq0 delta 直接 return false (:220 卡路径 / :234 到锚点无门无法重燃), 违反文件头最高契约『false=零进度』: 本次派发若刚 farm 到棒再折在出口, 有真实进度却报零进度 → 

=== enderPearls.js: confirmed 2, P2 1
  [P1-大概率炸] 反射中断解卷时返回珍珠计数而不是 false，把 interrupt-unwind 误报成成功 — 内核的中断阀门(8次→冷却)和 4s INTERRUPT_HOLD 对这个技能永远失效，夜间反射密集环境下变成 dispatch→interrupt→立即re-dispatch 的无阀门抖动
      FIX: 在两处 interrupt break 后记录中断标志，函数尾部改为 `if (bot.interrupt_code) return false;` 再 return 计数 — 中断解卷本身就是零进度，返回 false 正好落进 kernel.js:435 的 interruptUnwind 免罚分
  [P1-大概率炸] 20-48 格远距目标在战斗子循环第一轮就 `d >= 20` break 且不进黑名单 — 主循环立刻重选同一只(48格扫描半径)，fightT0 每次重建使 45s 上限永不累积，scanIdle 也永不递增：一只洞穴里无视线的 enderman 能把整个 dispatch 乃至整夜钉死在 ~1.5s/圈的凝视-放弃自旋上，零珍珠且 60s 让夜路径不可达
      FIX: d >= 20 break 时同样 blacklist.add(id)（怪若真心追猎会自己瞬移回 20 格内、届时已不是"nearest 之外"的问题——被黑名单的近身怪仍会在攻击我们时被 modes/self_defense 接管），或者把扫描半径从 48 收到与 20-break 一致的 ~24
  [P2] HUNT_PEARLS 提案门槛缺少剑和填充方块检查，与技能内部前置不一致（兄弟门 ENTER_NETHER/GO_END 都查 swords>=1 + fillBlocks）— 剑在下界阶段损毁后，首个夜派发会退化成空手/手持食物 1 点伤害 对 40HP 

=== craftEyes.js: confirmed 0, P2 1
  [P2] 库存计数口径分裂: craftEyes 用 world.getInventoryCounts(全槽位 0-45, 含副手45/盔甲5-8)来算 n/times 并判断进度, 但实际执行 craft 的 mineflayer recipesFor/bot.cra

=== setupEndPortal.js: confirmed 2, P2 2
  [P1-大概率炸] 全模式三角测量的几何参数自相矛盾: 120格垂直基线 vs |sin|>=0.17 的近平行拒绝阈值, 在真实要塞距离(oracle 实测 ~1500格)下每次必然被拒 — 首战 full-mode 每 dispatch 白烧最多6只眼+~810格行走后才跌落 single-bearing 模式
      FIX: 三选一: (a) 基线随估距缩放(近平行分支已给出B方位, 先沿方位走到估距<700再三角), (b) 阈值降到~0.06并靠已有的 t<=0/dEst>3500 (:236) 兜底, (c) 最优 — 用 oracle.static.stronghold 播种 strongholdEst 直接跳过
  [P1-大概率炸] verify-hop 环(PHASE 2/3 垂直确认)没有眼保留底线且悬停几何有确定性的『拖离』bug: 眼在 d<=12 时已把 bot 带到要塞正上方, +60 hop 又把它拖走 44+ 格; 环会把包括12个门框配额在内的全部眼烧光 → OUT OF EYES → 整轮下界补给循环
      FIX: (1) 环入口加保留底线: has('ender_eye') <= EYE_THROW_FLOOR 即 return false 转补给; (2) 修拖离: 当 disp < 12.5(眼已到达目标=距离<12)时不 hop, 直接以眼终点为准 egPatch strongholdEst=眼终点 并
  [P2] oracle 接缝评估(用户点名): 技能零消费 bot._world.oracle.static.stronghold, 注入点应在 PHASE 1 门之前播种 strongholdEst — 语义完全兼容(/locate 与眼收敛点同为 structure
  [P2] 挖掘搜索平面钉死在 y≈30, 对 1.18+ 深度方差大的要塞(整体位于 y<-34 时)三次零证据搜索会把『正确的』strongholdKnown 当幻影擦掉 → 重新三角测量回到同一点 → 再擦, 形成以 kernel 冷却为节拍的宏观活锁, 没有任何代

=== slayDragon.js: confirmed 3, P2 3
  [P1-大概率炸] dragonDead 只能在「本次 dispatch 曾亲眼见过活龙」的确认路径里盖章;击杀落在 dispatch 边界(中断/预算/同时暴毙)就永远盖不上章 → SLAY_DRAGON 在末地永久活锁
      FIX: 在技能入口(或 !sawDragon 分支等待 90s 后)增加「龙已死」的方块级探测: 在 (0,~60-70,0) 附近 blockAt 扫 end_portal / dragon_egg / end_gateway — 出口传送门被填充=龙已死, 直接 skills.egPatch(bot,{
  [P1-大概率炸] 水晶柱顶强击完全没有掩体: 「blast bunker」两块方块放在地面(爬柱之前), 而爆炸发生在 10-40 格高的柱顶 — 每场首战至少 2 根笼装柱必走此路径, 6颗心级爆炸+击退把 bot 从 1x1 柱顶掀飞, 无水桶时坠落基本无解
      FIX: 把掩体放到打击位: pillarUp 到 crystal.y-1 后、攻击前, 在 bot 与水晶连线方向的头/胸位(自己柱顶旁)放 1-2 块 FILLER 再出手; 或改为柱顶后退到 4.5 格极限+蹲下再攻击, 并在技能入口把 water_bucket 列为强烈建议装备写进 prog 日志/前
  [P1-大概率炸] 本栈上 d.health 恒为 undefined(mineflayer 4.37.1 不给非自身实体挂 health), Phase C 的 HP 进度追踪与 lastHp>60 死亡二次确认全是死代码 → 正在有效输出也会被 3×3min 停滞判定砍成 return false(有进度返 false, 违反契约), 每个 dispatch 的 C 阶段硬上限 9 分钟
      FIX: 用 boss 栏拿龙血: mineflayer 自带 boss_bar 插件(bot.on('bossBarUpdated', b => b.health)), 在技能内挂一次性监听把最新 health 存到局部变量当 d.health 的替代; 或退而求其次把『成功命中』(bot.attack 未
  [P2] 1.21.1 末影龙是多部位实体: bot.attack(龙主实体) 的伤害被原版按『身体部位』结算 = 伤害/4+min(伤害,1) — 下界合金剑每击仅 ~3HP, 弓射身 ~3.25, 『perch melee』的 DPS 假设乐观了 3-4 倍, 直接
  [P2] Phase A 搭桥循环不查 inEnd(): 桥上死亡→自动重生回主世界后(文件头 :18-19 自认 stop() 会漏掉这种血量回弹), 循环会在主世界朝 (0,0) 蹲行搭桥最多 128 步(~3-5 分钟垃圾方块), 最后经 bail 以 {prog
  [P2] MAROONED 接缝: goToPosition 在 bot._mobility.state==='MAROONED' 时无条件秒返 false, slayDragon 的 safeGoTo 会把它误读为『不可达』→ attempts/skip/停滞三振; 
