# 临时禁用「饥饿 / 种田 / 食物」本能 (2026-07-08 用户令)

## 背景
用户实观: **「bot 接到命令后像疯了一样到处乱逛」**。乱逛的机制来源主要是 bot 的**主动觅食 /
种田 / 村庄采集**本能 —— 内核在空闲时会提案并派发 `feedUp`(捕猎觅食)、`wheatFarm`(种麦)、
`villageHarvest`(村庄采集),把 bot 支到处跑。用户令: **临时禁用这些本能,回头有空再开**,并明确
取舍:

> **「保留 auto_eat 但只用于补血不用于补体力。只关注补血问题,全面放弃对体力的关注。」**

即: 只在"吃能让 HP 回血"时吃背包里的食物,**完全不再管饥饿条(体力)** —— 不觅食、不种田、
不因饿而触发求生。

## 一个开关控制一切
统一开关 [`foodInstinctsEnabled()`](../src/agent/framework/contracts.js) (env `MC_FOOD_INSTINCTS`):

| 值 | 含义 |
|---|---|
| `1` | **启用**(原始行为,逐字节旧逻辑) |
| 其它 / **未设**(默认) | **禁用**(本次用户令的目标态) |

> ⚠ **默认 = 禁用**,与迁移类开关(`MC_FRAMEWORK_V2` 等 "flag-off = 旧行为")**相反**。原因:
> 用户要它**现在就是禁用态**,且必须在**所有重启路径**下都成立 —— `start-neko.ps1` /
> `start-neko-direct.bat` / **watchdog 自动重启**(子进程继承的是那个**已经在跑**的 watchdog
> 当初钉的 env,不含本变量)。只有**代码默认**才漏不掉。三个启动器里也**显式钉了 `=0`**(与
> `MC_FRAMEWORK_*` 同一"不靠 shell 碰运气"惯例 + 指明去哪改)。

## 禁用时具体关了什么 / 留了什么

**关掉(会让 bot 到处跑的主动食物/种田行为):**
| 提案/行为 | 技能 | 位置 |
|---|---|---|
| `GET_FOOD`(主动捕猎/觅食,含囤肉 @88/55/35) | `feedUp` | [world_model.js proposeTasks](../src/agent/framework/world_model.js) |
| `OPP_WHEAT_FARM`(种麦→面包 @65) | `wheatFarm` | 〃 |
| `OPENING_VILLAGE`(饿贴村庄 @89 / 开局村庄采集 @67) | `villageHarvest` | 〃 |
| 低**饥饿**触发的灰区求生(`food < 8` → 强派 surviveNow 觅食) | surviveNow | [kernel.js `_grayZoneSignal`](../src/agent/framework/kernel.js) |
| `auto_eat` **为填饥饿条**而吃(原 `food<=17` 就吃) | — | [modes.js `auto_eat`](../src/agent/modes.js) |

**留着(保命/补血,不受影响 —— 用户令"只关注补血"):**
- **`auto_eat` 补血分支**: 只在 **`hp<20 && food<18`**(受伤 + 饥饿条低于自然回血线 18)时吃背包
  现有食物,把 food 顶过 18 让 HP 自然回复,**到线即停**(绝不为填满饥饿条而吃)。含应急档
  (rotten_flesh 等)在低血无正常食物时兜底。
- **HP 灰区求生** `surviveNow @ hp<12`、`self_preservation`、硬保命 `vitalNow`(溺水/着火/岩浆/hp≤4)、
  锚点僵局检测 —— 全部照旧。
- **`hunting` 模式**(路过 8b 内动物顺手打)—— 这是"顺手收"不是"专门去找肉",保留(与 2026-07-05
  用户令 "遇到牲畜顺手收就行" 一致)。
- 夜链 / tier 链 / 挖矿 / 建造 / 战斗 / 拾取 —— 全部照旧。

### 「补血 vs 补体力」的 MC 机制依据
MC 里 **饥饿条 ≥ 18 才自然回血**。所以 `auto_eat` 只需保证"受伤时把饥饿条顶过 18",HP 就会自己
回。饥饿条高但已满血 → 不吃(不管体力);饥饿条随后掉到 0 会开始饿掉血 → 那时 `hp<20 && food<18`
成立 → 吃回来。于是 bot **平时无视饥饿条,只在饥饿真的开始扣血时才吃** —— 精确落在"只补血不补体力"。

## 涉及文件
- [`src/agent/framework/contracts.js`](../src/agent/framework/contracts.js) — `foodInstinctsEnabled()` 开关(单一真相源)。
- [`src/agent/framework/world_model.js`](../src/agent/framework/world_model.js) — `proposeTasks` 里 4 处食物/种田提案加 `foodInstincts &&` 门。
- [`src/agent/framework/kernel.js`](../src/agent/framework/kernel.js) — `_grayZoneSignal` 的 `food<8` 触发加门。
- [`src/agent/modes.js`](../src/agent/modes.js) — `auto_eat` 改「补血 vs 补体力」双路(禁用→补血 only)。
- [`start-neko.ps1`](../start-neko.ps1) / [`start-neko-direct.bat`](../start-neko-direct.bat) / [`watchdog.ps1`](../watchdog.ps1) — 显式钉 `MC_FOOD_INSTINCTS=0`。

## 回头恢复(re-enable)
1. 设 `MC_FOOD_INSTINCTS=1`(三个启动器里把 `'0'`/`0` 改成 `'1'`/`1`,或删掉那行让别处的 `=1` 生效),**并**
2. **重启 bot**(核心文件不热载);若靠 watchdog 自动重启,记得**先重启 watchdog 进程本身**(改文件不改
   已在跑的 watchdog 的 env)。或者直接改代码默认。

## 有意留下、可按需进一步收紧的点
以下引用了 `food` 但**只是保命地板**(不会导致觅食乱逛),故本次**未动**,以免动到调得很细的求生/任务系统:
- `kernel.js` admin 任务让位地板 `_foodFloor = mission ? 7 : 2`、危急解卷 `foodN <= 2`。
- `kernel.js` `_grayZoneSignal` 锚点分支里的 `food < 12`(僵局"是否值得担心"的启发,非觅食触发)。
- `surviveNow` 技能自身的觅食末枝(仅 `hp<12` 真急时才可能跑,属最后的补血兜底)。

如果想**彻底把饥饿从求生数学里抹掉**,再给上面几处也加 `foodInstinctsEnabled()` 门即可。

## 备注
- `feedUp` / `wheatFarm` / `villageHarvest` / `forage*` / `scanFood` 等技能文件**原样保留**(未激活,无害),
  恢复开关即复活。
- 提案层不 push 这些 kind 后,`isGoalDone` / 夜间-errand-gate / `commitGoal` 引用它们的分支自然变成空转,
  无副作用(commitGoal 会选下一个该做的 kind;`FREE_PLAY@1` 恒在,不会僵死)。
