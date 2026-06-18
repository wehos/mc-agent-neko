# Neko 自主值守交接书 — 2026-06-19 ~08:00（接班必读）

> 上一个我连续值守约 4 小时（用户 24h 不在，授权：什么都不要问、不断思考、随意杀/重启、bot 不离视线超 5min、目标=迭代多维系统让 bot 自主不作弊通关 MC）。context 满了交接。**先读这份，再读 `CHANGELOG.md` 顶部 C253-C261，再读 `memory/MEMORY.md`。**

## 0. 接班第一件事：确认栈健康（应 5 个 node 进程）
```bash
node bots/_supervisor/monitor_tick.mjs       # 看 vitals 一行
powershell.exe -NoProfile -Command "(Get-Process node).Count"   # 应=5
powershell.exe -NoProfile -Command "Get-NetTCPConnection -State Listen -LocalPort 48909,8765,55916"
```
- 48909=agent WS(`node main.js`)；8765=mindserver；55916=MC客户端LAN(java，用户开的世界)。
- 两个 Monitor 节拍器(A=monitor_tick 200s；B=tail botwatch|grep ★|skill:)+ botwatch(`node botwatch.mjs 240`) 在跑，task id 用 TaskList 查。
- **监控原则(用户血泪)**：绝不只读vitals.json。心跳行已含hp/food/skill/pos/mob/host/inv，健康只回一行。**确认的livelock(act="-"冻结)必破**(头号忌讳)；死亡=廉价重置(裸资产成本≈0)，**别逐死取证**。

## 1. 架构(三层+监工)
- **①反射** `src/agent/modes.js`：中断驱动反射(self_preservation/self_defense/swim/mobility状态机)。**改完需重启agent**。
- **②core skills** `src/agent/library/skills.js`(collectBlock/placeBlockNearby/digDown…)。**改完需重启**。
- **③策略skill** `bots/_supervisor/skills/*.js`(missionNether/prepNether/achieve/feedUp/branchMine/surfaceUp/chopWood…)：**热加载**(customSkill每次调用cache-bust重载，`node --check`过即生效，无需重启)。
  - ⚠️**例外：`missionNether`是顶层sticky，运行中不热重载**。改它必须重启或cancel_skill让它re-arm。
- 监工：botwatch.mjs(位移STALL/hp/food/death) + CHANGELOG台账。

**栈启动顺序**(项目根，run_in_background)：
```bash
node --max-old-space-size=8192 --expose-gc main.js > bots/_supervisor/main_stdout.log 2>&1
node bots/_supervisor/bridge.mjs > bots/_supervisor/bridge_stdout.log 2>&1
node bots/_supervisor/botwatch.mjs 240 > bots/_supervisor/botwatch_stdout.log 2>&1
```
settings.js 已硬写`port:55916`(LAN端口,用户重开世界会变；agent报`No server found on LAN`就查java监听TCP端口改settings)。`host:localhost auth:offline`，无独立服务器jar，靠用户MC客户端LAN。

## 2. 重启/cancel/注入(关键操作)
**重启agent**(改①②层或missionNether后)：TaskStop停main.js+bridge后台任务→清残留端口占用→按上面顺序重拉。验收=新进程+48909监听+vitals新鲜。
```bash
powershell.exe -NoProfile -Command "Get-NetTCPConnection -State Listen -LocalPort 48909,8765 -EA SilentlyContinue | Select -Expand OwningProcess -Unique | % { Stop-Process -Id \$_ -Force }"
```
**cancel_skill/注入**(破livelock/强制missionNether重载)——往`inbox.jsonl`append一行，bridge~1s中继：
```bash
# ★必须bash printf(无BOM)！PowerShell写JSON带BOM→Node JSON.parse静默崩→死局
printf '%s\n' '{"type":"cancel_skill","reason":"..."}' >> bots/_supervisor/inbox.jsonl
```
⚠️注入`{"skill":"X"}`会被"busy: missionNether already running"拒(竞态)。换sticky靠改sticky_skill.json+重启。cancel在**夜间封顶bunker慎用**(拽出致死)；**纯livelock/白天/host=0时安全**。新世界流程见`memory/fresh-world-startup.md`。

## 3. 本会话8修复(C253-C261，全commit+部署，CHANGELOG顶部有详条)
| # | 文件(层) | 修了什么 | 状态 |
|---|---|---|---|
|C253|achieve③|夜间地表横穿去远程台→撞怪死。`_nightExposed&&d>2.5`拒横穿defer白天|✅验证|
|C255|achieve③|**铁瓶颈根因**:iron被当浅层矿封y48-68(铜带)→零铁。iron专属staircase下探y14|✅验证(raw_iron0→12→iron_pickaxe)|
|C256|prepNether③|**canFightNight不看盔甲**(86%裸甲死总根因)。加`armor≥1`→裸甲夜间一律封顶不夜战|✅验证(连续封顶过夜)|
|C257|missionNether(顶层需重启)|夜no-regen冻结livelock(觅食夜gate+封顶handoff白天gate→留空冻6min)。加夜handoff prepNether封顶|✅重启验证|
|C258|achieve③|cramped pocket放不下台→死循环。改surfaceUp到开阔处放台|✅验证(y41→y59出pocket→做出iron_pickaxe)|
|C259|feedUp③|饥饿地板reach陷阱:food≤2时hunt范围缩到32→够不到唯一食源永卡food2。低食物保持范围≥56+dy24|🟡部分|
|C260|prepNether③|夜hold只roof不wall→山顶侧僵尸杀入。digDown后封4侧开口|🟡待验证|
|C261|prepNether③|**dawn-exit hold无超时**→1只阴影僵尸不走冻6min。累计>72s就proceed让self_defense打|🟡刚部署|

## 4. 仍broken(按优先级，待fresh context谨慎修)
**核心困局**:bot 4小时**死15次**永远consolidate不了。每cycle:respawn空背包→重建到石器/有时iron_pickaxe→成甲前死→重置回**东spawn死亡区**(0,67,0,15死聚集吸引夜怪)。**总根=无甲脆弱+死亡区spawn+食物稀缺三互锁**。8修复改善具体向量但破不了循环。

**死亡FAMILY(已诊断待谨慎修)**:
1. **洞穴swarm**(死7/11):裸甲暗洞遇多怪走`self_defense`硬战→群殴(hp20→5)。机理=modes的armor-aware DEFEND/FLEE没catch。**①modes修(复杂heavily-tuned,谨慎)**:裸甲+多怪(≥2-3非creeper)→FLEE/SEAL不fight。代码modes.js 200-495。
2. **溺水**(死10/12 recurring):挖矿撞地下水→breath耗尽前没游到空气。swim-to-air本能失效。**①modes修**(相对clean但①需重启)。
3. **spawn夜spiral**(死1-4/12-15):空背包夜重生撞point-blank怪群封不住连环死,dawn自终=**C254地表spawn死亡陷阱**(待修队列)。硬问题。candidate:早期优先做床(3羊毛)在安全区设新spawn/夜respawn徒手挖土dig-down。
4. **不稳perch/山顶seal失败**(死5/8/9):surfaceUp/relocate把bot弄到y85+山顶不稳perch(foot/head/under=air)→placeBlock无依附面封不住夜死。C260在自然地形有效,perch上无效。candidate:night-hold前确保稳定实地。

**★★最高杠杆候选(下次bot攒到铁时做)**:**铁分配armor优先**。现mission顺序shield→iron_pickaxe→…,bot拿铁先做镐/盾,**dies before armor**。若前8铁先做**iron chestplate**(survival>mining)能扛住洞穴/dawn遭遇→consolidate→破循环。源头预防型(非whack-a-mole)。代码:`prepNether.js`的`goals`数组(~461行起)。**需谨慎设计+测试别rush**。

**食物结构性**:这片有cow/pig@40-60+sweet_berry_bush,非绝对荒漠。feedUp多gate互锁(hostileNear(8)/concreteOnly/calorie-floor/maxAnimalClose随食物缩)。候选:生肉入furnace cook(生3熟8)、低食物+单非creeper怪放宽hostileNear觅食门。详见CHANGELOG待修队列我加的长note。

## 5. 战略建议
1. **别再逐死打补丁**(whack-a-mole,用户死亡威胁警告过)。死亡廉价重置。**livelock(冻结)才必破**=零进展真敌人。
2. **配速**:还~20h。健康心跳一行ack。深挖只给livelock/里程碑/清晰高杠杆。节拍器200s(<5min满足要求,别>270s违反规则)。
3. **下一实质动作**:等bot进入较长survive stretch(deaths=15已稳一阵,西/中区挖矿),趁攒6-8铁时做**armor-first**(最高杠杆可能破循环)。或洞穴swarm-flee(①需重启,bot空背包时重启零成本)。
4. **"这片地形/spawn值不值得救"**(memory死276转折):东spawn是死亡区。若一直绕它spiral,考虑帮bot在西区(有食物、曾活更久)建床设新spawn=结构破局。
5. 攻坚后**当场写CHANGELOG+memory**,挂可证伪预测。重启验收=新进程CreationDate+双端口。

## 6. 路径速查
- 工作区`C:\Users\wehos\Project\mc-agent-upstream-sync`(worktree,分支codex/upstream-sync)。另有mc-agent=develop主worktree。
- 台账`bots/_supervisor/CHANGELOG.md`(顶=最新C261;底"待修队列"有enderman/tool_keeper/食物/armor长note)。
- 运行时(gitignore,bots/_supervisor整目录被忽略,**commit用`git add -f`**):vitals.json/events.log/progress.txt/act_trace.jsonl/mine_motion.jsonl/death_log.jsonl/botwatch_stdout.log/inbox.jsonl/monitor_tick.mjs。
- 旧世界状态归档在`_worldreset_20260619_0214/`。
- memory:`C:\Users\wehos\.claude\projects\C--Users-wehos-Project-mc-agent\memory\`(MEMORY.md索引;★mc-agent-supervision.md核心;fresh-world-startup.md;autonomy-just-act/monitoring-multi-signal/root-cause-not-whackamole/bom-json-silent-dispatch-kill)。

## 7. 交接时刻快照(~07:54)
bot:hp9/food7(no-regen偏低但host=0白天),iron_pickaxe在手,copper216/raw_iron熔用中,y70,deaths=15稳一阵(较长survive stretch)。栈健康。**等它攒铁做armor-first是下一最高杠杆动作。**
