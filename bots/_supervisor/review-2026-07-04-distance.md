# 通关距离全面审查（2026-07-04 06:00Z, session #2 接手评审）

12-agent workflow（6 findings 核对 + 4 系统审查 + 2 对抗核验），全部结论经运行时证据（progress.txt 5.8MB / framework-shadow.log / death_log.jsonl / act_trace / arbitration.json）交叉验证。

## 一句话结论

**代码侧全链已写完且 44 findings 中 38 条（含全部 11 critical）已确认修复；运行侧 bot 53 小时卡在 11 级天梯的第 2 级（stone），8 个 endgame kind 连提案队列都没进过。距离通关的瓶颈不再是 endgame 代码质量，而是三个结构洞：消耗品补给无一等任务、夜间时间黑洞、armor≥4 供给断层。**

## 1. 44 findings 修复状态（review-endgame-chain.md 逐条核对）

- **FIXED 38 / PARTIAL 3 / OPEN 3**。全部 11 critical 已修复，修复批 = e8c7825（07-02 09:03, 24文件+2492行）+ 98f3be2（07-02 13:00, 16文件+1220行）+ kernel NO-DELTA override（truthy 但世界零变化 4 次→冷却，系统级兜底）。
- 修复质量抽样属实：eye 采样加 MIN-SAMPLE 守卫+strongholdKnown 可回滚；dragonDead 加 FALSE-KILL GUARD（inEnd+存活三重复查）；pillarUp SCAFFOLD 已含 end_stone；craftChain 零进度返 false；entered:false 误伤嗅探已删；egRead/egPatch 收敛为共享原子写 helper。
- 残留：
  - **OPEN(major, 实质)** gatherObsidian.js:70 — 硬性要求 ~4 铁（桶3+打火石1）+32 格内 gravel，但 GET_PORTAL_KIT 提案门不预检铁，endgame 阶段无补铁提案 → false→冷却→重派循环。
  - PARTIAL setupEndPortal:124 travelTo 仅 HARDENING-LITE（水腿 abort/体征门有了，无 bearing-fan/est 失效）。
  - PARTIAL vision:16 进程内 headless-gl 捕获期原生崩溃仍可杀整个 agent（launcher kill-switch 默认关着 = 缓解中）。
  - OPEN(minor)×2: slayDragon bowShot 重复拷贝、modes creeper interpose 双分支漂移。

## 2. 运行时实况（现役世界 53h，07-01T23:55Z 起）

**已实证**：5h 内冲到全铁（07-02T04:48Z iron tier secured, armor=4）；床锚+respawn 链（70 死全部回锚）；睡眠成功×3（仅 07-03 晨）；船渡水×2；仲裁 1115 裁（matrix639/LLM277/生死地板69）；断路器/watchdog升级链/EAT-VOID观测/C362 石棺脱困（04:17 修复→05:00 reached open surface y=60）各有首证。死亡 44→24→2/日 显著收敛。

**从未发生**（framework-shadow.log + progress.txt 双零证明）：进下界、黑曜石≥1、flint_and_steel 持有、blaze/pearl/eye/stronghold/dragon 全链遥测恒零。GET_DIAMOND_GEAR/GET_PORTAL_KIT/ENTER_NETHER/GET_BLAZE_RODS/HUNT_PEARLS/GO_END/SLAY_DRAGON/CRAFT_EYES **八个 kind 连 shadow 提案都 0 命中**（门槛从未满足，非代码缺失）。钻石链最接近的两次：07-02T06:24-09:49（famine 冻死收场）、07-02T23:24 branchMine 在 y15-16 实挖 4 分钟（无钻石矿）+ 07-03T07:03 二次点火。

**轨迹**：「5 小时冲顶，48 小时震荡」。铁镐三落三起（最后一把 07-03T11:18 消失至今>18h，损耗机制不可见：疑耐久耗尽+capSurplus误伤）；armor 两轮 4→0（24死磨损）；13 锭铁 07-02 存入家箱后箱子 ghost 蒸发。第 53 小时库存不如第 5 小时。

**当前**（07-04T05:23Z）：y=57 浅层村庄旁，hp15/food8/armor0，2×石镐，tier=stone rank2。mineDown 幽灵方块楔死中（前方"空气"物理撞墙，每步挪 0.04b，诚实 fail→冷却）。

## 3. 结构洞清单（本次新发现，不在 44 findings 内）

按对通关的伤害排序：

1. **P0 消耗品基线死锁（无人认领的补给不变量）**：木→棍/台→镐链没有一等 kind，只作为前置 gate 散落在消费技能里。buffer 在地下归零→所有消费者集体 yield→BOOTSTRAP_KIT 冷却 162 次+GET_FOOD 121 次轮转（36h）。y16 石棺 11h=日志期 31%。C362 只放宽了 y<50 的洞，y≥50 同类活锁不覆盖。
2. **P0 夜间时间黑洞**：2 天仅 3 次睡觉，nightShelter 占全部 kernel-out 73%（2321/3181）且大量 sealed 0 零进度合法 hold。~50% 墙钟时间结构性归零。
3. **P0 仲裁坏规则仍在生效**：`kernel:* vs mode:mobility → holder`（LLM persist 产物，无上下文条件）——kernel 技能持身时脱困反射制度性败诉，满血被埋不触发 vital 地板。log 300 条里 149 条是 mobility 被压，05:16Z 还在以 ~10.6s/条刷。y16 石棺同框元凶。persist 闭环无人审/无 TTL。
4. **P1 armor≥4 供给断层**：ENTER_NETHER/GO_END/HUNT_PEARLS 三门都要 4 件铁甲=24 锭，但 IRON_BUFFER=7 只够工具；铁镐到手后 isGoalDone(GO_UNDERGROUND) 恒真，"为甲采铁"的 GET_IRON_ARMOR_SET 是幽灵 kind（有定义永不 push）。段6→段8 之间可长期卡死。
5. **P1 BANK_GEAR 吞 endgame 物资**：bankGear RAW 正则含 diamond，MAT 表把 cobble 削到 16（ENTER_NETHER 要 32、GO_END 要 64）、logs 留 8；craftChain/endgameNeeds 只数背包不读箱子 → mine→bank→re-mine 死环。keepInventory=true 下 BANK_GEAR 是纯负价值，最简修=停用。
6. **P1 HUNT_PEARLS 被睡觉本能压制**：modes.js:5896 go_to_bed_sleep 只对 4 个夜 kind 让位，不认 HUNT_PEARLS/NIGHT_SMELT_IRON——有床后每个珍珠夜被拖回床。珍珠段（~14 颗×0-1掉率×完美夜门 food≥12+hp≥14+armor≥4）本就是全链最慢环节。
7. **P1 运维单点**：watchdog.ps1 $proj 硬编码 `C:\Users\wehos\Project\mc-agent-upstream-sync`（本机不存在）→ watchdog 根本没在跑；且其 Restart-Agent 裸启 `node main.js` 不带 MC_FRAMEWORK_V2/内存 flags——修好路径后若启用，一次重启就静默把整条确定性链关回 LLM baseline。
8. **P2 供给层审计盲区**：51-agent review 没审过 realNetherPortal（质量尚可）/achieve/craftChain/setBed/goBedSleep/bankGear/prepNether。已知洞：craftChain truthy 漏洞（≥1 件小 craft 成功=有进度，铁镐可以永远 craft 不出而不触发 3-strike，烧木式软活锁）；setBed 幻影家（远环候选先写 bed.json 床却放脚下，bankGear 会把家箱建到从未验证的点）。
9. **P2 tierReady 木缓冲终身耦合**：woodBuffer=16（decision-config.json 覆盖默认 8），钻石 tier 的 bot 木掉到 15 单位整条 endgame 链静默消失，BOOTSTRAP_KIT@66 压过 GO_END@53。
10. **P2 冷却轮转无修复升级**：kernel 的 3-strike 本质是退避重试，无"连续 N 轮冷却同 kind→升级/换策略"阀门；decide() 的 LLM judge（S4.2）从未接线。endgame 任何一环出现持久失败模式，通关就停在那一环。
11. **P3 legacy 复活路径**：escapePlan runNavTo finally 无条件写 sticky_skill.json={missionNether}，死亡重生后不检查 framework flag 直接重投（当前文件不存在=休眠）；buildNetherPortal.js 是 /setblock 作弊死代码，建议删除。

## 4. 距离评估

- 天梯：rank 2/11。段 0-4（bootstrap→铁）已实证但不稳固（三落三起）；段 5（钻石）点火 2 次未成；段 6-13（钻镐→龙）实战覆盖 0%。
- 代码完成度 ~95%：全链合法实现+critical 全修，唯 gatherObsidian 铁预检是已知硬洞。
- 按两天实测规律（每段首战必暴露 1-3 个新 bug，每 bug 一轮修复-验证），**在先修掉 P0 三件套的前提下**：钻石 1-2 天内可达；黑曜石→下界→烈焰 2-3 轮迭代；珍珠段最慢（多个完美夜）；要塞/龙各 1-2 轮。**现实估计：以当前修复节奏还需 3-7 个自主值守日**。不修 P0 直接等，则大概率无限期停在 stone/iron 震荡——66 笔提交修实例不修类的教训。

## 5. 建议下一手（P 序）

1. REPLENISH 补给不变量 kind（备镐≥2+planks/logs 缓冲+口粮），地表白天 buffer 跌破即高优提案；mineDown/branchMine 回程预算改为派发前置条件。
2. 翻转/加条件化 `kernel:* vs mode:mobility` 仲裁规则（真被埋 dig-out 不能败诉）+ persist 规则加人工审门。
3. 夜链修复：goBedSleep 全链取证（床已知却 0 次睡成的断点）；睡不成时夜间默认改封闭走廊 branch mine（安全+产出）而非 nightShelter 空转。
4. 停用 BANK_GEAR（keepInventory 下纯负价值）或修 RAW/MAT 表。
5. GET_ARMOR 断层：让 GO_UNDERGROUND 的 done 考虑铁甲需求（iron≥7 不因铁镐到手瞬释），或复活 GET_IRON_ARMor_SET。
6. gatherObsidian 铁预检接入 GET_PORTAL_KIT 提案门。
7. watchdog.ps1 修 $proj+env flags 后启用（先修 flag 再启，顺序不能反）。
8. mineDown 幽灵格楔死（当前正发生）：wedged 中止时拉黑前进格+强制 relocate+换 heading；breakResults=false 且撞"空气"时触发 chunk 重同步。
