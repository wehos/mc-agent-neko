# Session #4 复盘（2026-07-06，用户叫停：效率过低）

停车时进度：石器层，deaths 51→87，铁镐得而复失×4，钻石 0，未进下界。
用户裁定：连接用户自开的 55916 世界，由用户肉眼监督；**不允许 agent 栈再自开 server**。

## 一、为什么慢 — 三层原因

### A. 隐性机制缺陷的乘积（本次挖出并已修复，全在 origin）
每个缺陷单独看都不致命，但乘起来 = 采矿产能长期趋零，且每个都要 20-40 分钟实弹周期才暴露一个：
1. **幻影矿**（ae8565a）：server autosave 重排 .mca 偏移表 → 长驻 Anvil 实例错位读 → oracle 铁坐标全假。RCON 逐坐标验块（`execute if block`）是唯一可靠核真手段。
2. **矿可达门 partial 一刀切 ×2 副本**（450f548 + 50efb05）：穿石挖掘路径 800ms 算不完返 partial 被拒 → 包石矿全不可挖，只剩怪窝裸露矿。**修复曾半落地 2 小时**（修了 C304 漏了孪生 C305）。
3. **死亡区 2D 阴影**（be4e548）：地表死亡把正下方矿整列拉黑。
4. busy 语义三迭代（cfa5d05→7bf7951）：hold 类 mode 动作占满 executing / 孤儿 _currentSkill 噤声 9min。
5. sticky 伏击（ffb6ecf）：escapePlan navTo 无条件写 sticky_skill.json，重启后 missionNether 抢占一切。
6. tierReady 木耦合：planksEq<16 时整条 tier/endgame 链（含 GET_DIAMOND）消失。
7. 幻影村庄地标（**未修**）：landmarks.json 里 10 个假村庄（RCON 实测最近真村 1219b），villageHarvest 反复三振。

### B. 环境恶性循环（新世界出生区）
1. **粮食荒漠 + 树荒**（历史砍伐耗尽）+ **出生点怪营**（重生锚在绞肉机内，白天不烧的洞穴怪 + 僵尸村民）→ 死亡节拍 ~5min/次，打断一切复利。
2. **镐跑步机**：石镐 131 耐久/铁镐 250 耐久 vs 高强度挖掘 → 镐寿命 10-40 分钟；铁镐×4 全部耗死在杂活/下潜石头上（孤镐护航闸 533eb22 已堵）。
3. 面包经济立不起来：农田被怪踩、锄头丢、羊毛混色（2白1灰）造不了床。
4. keepInv 死亡重置"能用"但每次 2-5 分钟摩擦 + 任务上下文清零 = 慢性放血。

### C. 值守方法论错误（供后任引以为戒）
1. **抢跑干预**：两次在供应链未就绪时直令钻潜，各烧一把铁镐（教训已固化为孤镐护航闸）。
2. **事故响应延迟**：死亡速率异常 13 分钟后才读 ALERTS.txt。规约：**死亡 5min 内 +3 → 立即事故流程**（ALERTS + death_log 尾 + 簇分析）。
3. **修复半落地**：改一处不查同款副本。规约：**每修一处必 grep 全库同模式**。
4. **验证靠等待**：应主动查观测孔（mine_dbg 的 REJECT/OK 行、RCON 验块）而非等下一轮实弹。

## 二、本次沉淀的资产（全部可复用）
- **灰区指挥官**全套（surviveNow B+C 树 + LLM 战术官 + kernel 强制派发 + 仲裁行 + 软 hold 挂起）——僵局从 2.5h 不可破变为有限步出口，多次实弹兑现（含战术官优质决策）。
- **oracle 全知层**：三族矿+ironDeep 分层+地表水扫描，坐标 RCON 三验为真。
- **mineOres 制导远征**（全套闸门：清囊/MAROONED 让位/围殴中止/秒败收工/雷区过滤/yMax）。
- 采矿三连根修 + 优先级反倒挂（昼夜钻石优先）+ satiety 口粮档。
- 观测/运维：轮询式 Monitor（tail -F 会锁死 heartbeat，铁律）、RCON 验块手法、mine_dbg 观测孔。

## 三、新 task 处方（连接 55916）
1. **连接配置**：settings.js `"port": 55916`（显式，不再 -1 扫描）、host localhost；**watchdog.ps1 不得再拉起 mc-server**（server-watchdog.ps1 停用）；ORE_REGION 指向用户世界的 region 目录（用户端存档路径待确认——LAN 世界的 region 在 .minecraft/saves/<世界名>/region，注意单人 LAN 无 RCON，oracle-daemon 的 /locate 通道不可用，ore-oracle 离线扫描仍可用）。
2. **开局公式硬化**：进入新世界后第一优先=一次成型的 bootstrap（木→台→镐×3→床[杀羊collect白毛]→8+口粮→再进提案市场），不要靠提案市场碰运气拼开局。
3. **床纪律**：每晚必睡（重生锚=复利保护），无床=当日最高优先补床。
4. **镐纪律**：铁镐只碰钻矿（护航闸已在），常备石镐≥2。
5. 幻影村庄地标清理（landmark 陈旧修剪）待做。
6. 用户监督接口：用户在场=可视验证；bot 行为异常用户直接喊停，供给 bot 的 supervisor 通道照旧（inbox/ws）。

## 四、红线不变
信息级作弊全开（RCON 只读——注意 LAN 世界无 RCON、region 离线扫描、inbox 直令）；状态级零使用（/give /tp /setblock /gamemode /effect）。keepInventory 状态在用户世界**未知，需先验证**（LAN 世界默认 false！求死分支会自动禁用直到 keepinv.json 验真——没有 RCON 时用死亡实测或问用户）。
