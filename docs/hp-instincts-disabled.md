# 低血本能熔断 (MC_HP_INSTINCTS)

> ★2026-07-09 用户令: "目前版本所有食物相关的机制全部熔断，禁止因低血和饥饿度打断任何行动，饿死/死了拉倒。"

与 [食物本能熔断](food-instincts-disabled.md) (`MC_FOOD_INSTINCTS`) 同构的 hp 侧总闸。
统一开关 [`hpInstinctsEnabled()`](../src/agent/framework/contracts.js) (env `MC_HP_INSTINCTS`):
**默认 OFF = 熔断** (任何非 `'1'` 值、包括未设置, 都是熔断)。

## 直接病灶 (2026-07-08 15:44–15:49 实录)

hp=10 / food=14 的 bot 手持石镐站在铁矿旁发呆:

1. kernel 灰区 `hp10<12` → 强派 surviveNow → RELOCATE/垫柱上浮;
2. mobility `noRegenSafeAirHold` → "ENTOMBED no-regen safe-air gate — hold air pocket, no blind dig" 冻身;
3. mineOres 每次派发 ~22s 就被抢走, `gained=0/8` 连环。
4. 而 food<18 永不回血 + hp<12 永久触发灰区 = **死锁**: 低血低食的 bot 挖矿永久瘫痪。

## 熔断清单 (MC_HP_INSTINCTS ≠ '1' 时)

核心层 (改动需**重启 bot 进程**):

| 触发点 | 文件 | 原行为 |
|---|---|---|
| 灰区 `hp<12` 强派 surviveNow | [kernel.js](../src/agent/framework/kernel.js) `_grayZoneSignal` | 低血打断在跑技能 |
| 夜锚僵局的 `hp<16 / food<12` 不适限定 | 同上 | 低血低食把夜间驻守判成僵局 |
| 危急解卷 `hp<=6 / food<=2` 抬 interrupt | kernel.js `_survivalTick` | 低血掐掉互斥技能 |
| vital 地板 `hp<=4 且掉血中` | [arbiter.js](../src/agent/framework/arbiter.js) `vitalNow` | 低血秒抢身体 (**溺水/着火/岩浆保留** — 因环境非因低血) |
| `lowHpNoRegenContainedHold` 家族 | [modes.js](../src/agent/modes.js) | 低血无回血 → 冻住 self_preservation/身体 |
| `noRegenSafeAirHold` (ENTOMBED/POCKET no-regen gate) | modes.js mobility | 低血低食 → 冻住脱困挖掘, 守气穴发呆 |
| auto_eat (双闸全 OFF 时整体熔断) | modes.js | 吃饭的 execute() 掐掉在跑技能 1.6s |

技能层 (热重载, 直读 env):

| 触发点 | 文件 |
|---|---|
| `lowFoodEssentialStop` 的 `hp<14` 停矿 | [branchMine.js](../bots/_supervisor/skills/branchMine.js) |
| 单怪+`hp<=10` 让位 (真围殴 swarm>=2 保留) | [mineOres.js](../bots/_supervisor/skills/mineOres.js) |
| `_lowHpHostileYield` / NOPICK-low-resource / `hp<=4` BAIL ×2 / MAROONED `hp<=6` / 爬梯 `hp<=4` | [chopWood.js](../bots/_supervisor/skills/chopWood.js) (`_hpInstincts()`) |

**保留不动** (不属于"因低血/饥饿"):

- 死亡/重生处理 (`hp<=0`, `death_abort`)、`interrupt_code`;
- 威胁触发防御: self_defense、creeper 贴脸、真围殴 (swarm>=2)、armoredSoloBrawl;
- 环境致命地板: 溺水 (oxygen<=8+真在水里)、着火、岩浆;
- prepNether 内部的 `_prepLowHpNoFoodUntil` 节奏 backoff (蓝图自我调速, 不抢别人的身体;
  其喂给的两个冻身 hold 已熔断, 所以只影响 prepNether 自己的重试节奏)。

## 启动器钉死

[start-neko.ps1](../start-neko.ps1) / [start-neko-direct.bat](../start-neko-direct.bat) /
[watchdog.ps1](../watchdog.ps1) 均显式 `MC_HP_INSTINCTS=0` (代码默认亦熔断, 钉死只为跨重启可见性)。

## 恢复旧行为

1. 设 `MC_HP_INSTINCTS=1` (三个启动器里 `0` 改 `1`, 或删行让别处 `=1` 生效), **并**
2. 重启 watchdog 进程 + bot 进程 (核心模块不热重载)。
