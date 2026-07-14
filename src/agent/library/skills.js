import * as mc from "../../utils/mcdata.js";
import * as world from "./world.js";
import * as tickConfirm from "./tick_confirm.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import { unclimbVines } from './vine_unstick.js';
import settings from "../../../settings.js";
import path from 'path';
import { pathToFileURL } from 'url';
import { safeToDigBlock } from '../framework/tools/lava_guard.js';   // 岩浆/水裁判 (试装 into safeDig)
import { corridorSafety, orderedMiningDetours, selectMiningDetour } from '../framework/tools/mining_detour.js';
import { appendTelemetry } from '../../utils/telemetry.js';

const blockPlaceDelay = settings.block_place_delay == null ? 0 : settings.block_place_delay;
const useDelay = blockPlaceDelay > 0;

const BOT_HALF_WIDTH = 0.31;
const BOT_HEIGHT = 1.8;
const botAabbIntersectsBlock = (bot, p) => {
    const pos = bot.entity.position;
    const minX = pos.x - BOT_HALF_WIDTH, maxX = pos.x + BOT_HALF_WIDTH;
    const minY = pos.y, maxY = pos.y + (bot.entity.height || BOT_HEIGHT);
    const minZ = pos.z - BOT_HALF_WIDTH, maxZ = pos.z + BOT_HALF_WIDTH;
    return maxX > p.x + 0.02 && minX < p.x + 0.98
        && maxY > p.y + 0.02 && minY < p.y + 0.98
        && maxZ > p.z + 0.02 && minZ < p.z + 0.98;
};

// ★禁用寻路器自动脚手架 (用户实拍"想垫上台子→错位→诡异乱垫"): mineflayer-pathfinder
// 的 Movements 默认带 scafoldingBlocks(泥土/圆石),目标在高台/对岸时自动垫块搭桥/搭塔。
// 但其放块对时序/站位极敏感 — 偏一格就连锁错位(横向圆石脊/散乱土柱,社区著名顽疾)。
// 人类规则: 赶路绕障碍,垫块是专门受控动作(digToSurface 的手动MLG垫/pillarUp)。
// 子类替换让全部 `new pf.Movements(bot)`(本文件13处+其他引用方)统一禁脚手架:
// 寻路器从此只走/挖,不放块 — 过不去就快速失败,调用方换路,绝不边走边乱垫。
const _PFMovements = pf.Movements;
// ★KILL-BOX PATH AVOIDANCE (death #269: roaming for trees pathed OVER the death
// cluster and fell through its cave-riddled roof — the expulsion checks live at loop
// boundaries and can't stop a mid-walk drop). The overseer clusters deaths into
// advisory.json dzone {cx,cz,r}; here the pathfinder itself prices every step inside
// that circle +60, so routes bend around the kill-box automatically. Soft cost, not a
// ban: if the only path crosses (or we're being expelled FROM inside), it still works.
import fs_dz from 'fs';
let _dzPath = { t: 0, z: null };
function _pathDangerZone() {
    if (Date.now() - _dzPath.t < 5000) return _dzPath.z;
    _dzPath.t = Date.now();
    try {
        const a = JSON.parse(fs_dz.readFileSync('bots/_supervisor/advisory.json', 'utf8'));
        _dzPath.z = (a && a.dzone) ? a.dzone : null;
    } catch (e) { _dzPath.z = null; }
    return _dzPath.z;
}
// ★OWN-INFRASTRUCTURE BREAK BAN (live 2026-07-02 05:21Z: bot dug up its OWN white_bed —
// mine_motion.jsonl logs the dig with skill:null, i.e. no skill code asked for it; the
// pathfinder's canDig planning priced the bed like any 1-cost obstacle and chewed through.
// Same blind spot earlier had it tool-swap-looping a dig on the base furnace). Movements
// already ships blocksCantBreak as a Set pre-seeded with chest + undiggables (lib/movements.js:41)
// — so we ADD, never replace: every bed color (registry scan for /_bed$/) plus workstations
// and storage. This only forbids BREAKING these blocks during path execution; walking, route
// digging through ordinary terrain, and dig-escape retries are untouched — escaping through
// your own bed/chest is never the right move anyway. Fail-open by contract: a registry
// hiccup must not break Movements construction, so worst case we pathfind unhardened.
const _HARDEN_CANT_BREAK = [
    'crafting_table', 'furnace', 'blast_furnace', 'smoker',
    'chest', 'trapped_chest', 'barrel', 'ender_chest',
];
export function hardenMovements(bot, movements) {
    try {
        const byName = bot && bot.registry && bot.registry.blocksByName;
        if (!byName || !movements) return movements;
        if (!(movements.blocksCantBreak instanceof Set))
            movements.blocksCantBreak = new Set(movements.blocksCantBreak || []);
        for (const name of _HARDEN_CANT_BREAK) {
            if (byName[name]) movements.blocksCantBreak.add(byName[name].id);
        }
        // Beds are 16 per-color block names (white_bed, red_bed, ...) — scan the registry
        // instead of hard-coding the palette so no color (or future addition) slips through.
        for (const name of Object.keys(byName)) {
            if (/_bed$/.test(name)) movements.blocksCantBreak.add(byName[name].id);
        }
    } catch (e) { /* fail-open: unhardened Movements still pathfinds */ }
    return movements;
}
class _NoScaffoldMovements extends _PFMovements {
    constructor(...args) {
        super(...args);
        this.scafoldingBlocks = [];
        // ★防摔硬底 (2026-07-08 用户实拍"寻路很轻易掉坑/垫完塔走一步摔死", 且"跟水无关就是掉下去"):
        // 两条 lib 默认是坠落根源, 且被 maxDropDown 漏掉 —— 在子类里一次性钉死, 所有 `new pf.Movements`
        // 站点(goToGoal/collectBlock/world.isClearPath/热载技能)统一继承防摔:
        //   1) infiniteLiquidDropdownDistance 默认 true → 规划器认为"落点是水就任意高度都安全", getLanding
        //      Block(movements.js:495)对液体落点无视 maxDropDown → bot 从 12 格高塔/崖边一步跨进水里自由落体
        //      (深水不摔但会溺/困, 浅水/边缘直接摔血)。设 false: 液体落点也受 maxDropDown 约束, 不再高台跳水。
        //   2) maxDropDown 默认 4(4 格=1 点摔伤)→ 收到 3(3 格=零摔伤)当【全局默认下限】; 真需要更深下潜的
        //      技能(mineDown/digToSurface)仍各自局部覆盖, 不受影响。配合 goToGoal 已关的 allowParkour(避免
        //      跳弧下方深坑没跳到直接坠坑), 常规寻路从此不会规划出致命落差。
        this.infiniteLiquidDropdownDistance = false;
        this.maxDropDown = 3;
        // ★VINE TRAP (user: recurring, ≥5/15 explorations): don't PLAN to climb vines —
        // the physics treats them as ladders and clings/climbs, trapping the bot in
        // jungles. Removing them from climbables stops the pathfinder routing onto them
        // to climb; the vine_unstick bot hook clears any that still wedge it.
        try { unclimbVines(this, (args[0] && args[0].registry) || this.registry); } catch (e) {}
        if (Array.isArray(this.exclusionAreasStep)) {
            this.exclusionAreasStep.push((block) => {
                const z = _pathDangerZone();
                if (!z || !block.position) return 0;
                const dx = block.position.x - z.cx, dz0 = block.position.z - z.cz;
                return (dx * dx + dz0 * dz0 < z.r * z.r) ? 60 : 0;
            });
        }
        // ★BARE-HAND STONE = pathfinder too (the fifth material-blind dig path the
        // alarm caught: collectBlock('dirt')'s pathfinding punched through the bot's
        // own cobblestone bunker wall). Without a pickaxe, breaking a stone-class
        // block costs +100 — the planner routes around stone (or digs dirt) instead
        // of scheduling minute-long zero-drop punches. With a pick: no penalty.
        if (Array.isArray(this.exclusionAreasBreak)) {
            const _bot = args[0];
            this.exclusionAreasBreak.push((block) => {
                if (!block.name || !/stone|deepslate|andesite|diorite|granite|tuff|_ore$|obsidian|cobble/.test(block.name)) return 0;
                try {
                    return _bot.inventory.items().some(i => /_pickaxe$/.test(i.name)) ? 0 : 100;
                } catch (e) { return 0; }
            });
        }
        // ★MOB-COST PATHING (2026-07-05 安全自查 C4; 2026-07-08 平原寻路回归修 = 本次): pathfinder
        // 内建实体成本 (allowEntityDetection=true) 把每只【非 passable 实体】碰撞箱按 entityCost/格
        // 计入路径成本。致命细节: lib 的 passableEntities.json 只含投射物/掉落物 —— 牛/羊/猪/鸡/马
        // 等被动动物全都【不 passable】, 于是每只都按 entityCost/格 加价 (movements.js updateCollision
        // Index 给每格 stamp cost=1; getMove* 里再 *entityCost)。
        //   曾把 entityCost 调到 8 意图"硬规避 creeper" —— 那是【错药】: creeper 规避完全由下一行的
        //   entitiesToAvoid 实现 (lib 内建 100/格, 与 entityCost 无关, 触发 getMove 里 cost>100 剪枝 = 硬
        //   墙)。entityCost=8 对 creeper 仅 100→800 的无谓放大, 副作用却是把平原上【成群被动动物】每格
        //   加到 +8 → A* 绕每只牛最多外摆 8 格, 动物游走还令每次重算生成不同蛇形 → 逐拍抖动 = 用户实拍
        //   "只有 1 格高低的平原都走不利索"。(对抗核实定论: entityCost=8 = 平原走位回归的唯一实锤根因;
        //   tickTimeout=15/viewDistance=far 只是放大器, 且回调 40 会重新引发 ELOOP 卡顿 → 不动它们。)
        //   改回 lib 默认 1: 被动动物只 +1/格 (轻微自然绕行, 与原版 mineflayer 一致 → 平原丝滑), creeper
        //   硬规避不变。近身怪安全始终走 self_preservation/self_defense 反射(仲裁), 本就不靠寻路软成本。
        this.entityCost = 1;
        try { if (this.entitiesToAvoid && this.entitiesToAvoid.add) this.entitiesToAvoid.add('creeper'); } catch (e) {}
        // ★DON'T DIG OWN INFRASTRUCTURE (2026-07-02 05:21Z white_bed loss — rationale at
        // hardenMovements above). Hooked HERE so every construction site is hardened the
        // moment it's built — this file's 14 `new pf.Movements(bot)` sites, world.js's
        // isClearPath, and the hot-loaded supervisor skills that destructure mfp.Movements
        // (they hot-import after this rebinding, so they get this subclass too) — same
        // one-hook-covers-all pattern as the scaffold/vine/kill-box guards above.
        try { hardenMovements(args[0], this); } catch (e) {}
    }
}
pf.Movements = _NoScaffoldMovements;

export function log(bot, message) {
    bot.output += message + '\n';
}

export function isPlankBlock(blockName = '') {
    return typeof blockName === 'string' && /(?:^|_)planks$/.test(blockName);
}

function motionPos(bot) {
    const p = bot && bot.entity && bot.entity.position;
    return p ? { x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3) } : null;
}

function motionBlockObj(block) {
    if (!block) return null;
    return {
        name: block.name || null,
        position: block.position ? { x: block.position.x, y: block.position.y, z: block.position.z } : null,
        boundingBox: block.boundingBox || null,
    };
}

function motionVecObj(p) {
    return p ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null;
}

function motionEnvSnap(bot) {
    try {
        const c = bot && bot.entity && bot.entity.position && bot.entity.position.floored();
        if (!c) return [];
        const out = [];
        for (const dy of [-1, 0, 1, 2]) {
            for (const dz of [-1, 0, 1]) {
                for (const dx of [-1, 0, 1]) {
                    const b = bot.blockAt(c.offset(dx, dy, dz));
                    out.push({ d: [dx, dy, dz], n: b ? b.name : null, bb: b ? b.boundingBox : null });
                }
            }
        }
        return out;
    } catch (e) { return []; }
}

function motionGoal(goal, depth = 0) {
    if (!goal || depth > 2) return null;
    const out = { type: goal.constructor && goal.constructor.name ? goal.constructor.name : 'Goal' };
    for (const k of ['x', 'y', 'z', 'range', 'distance']) {
        if (typeof goal[k] === 'number') out[k] = goal[k];
    }
    if (goal.entity && goal.entity.position) {
        out.entity = {
            id: goal.entity.id,
            name: goal.entity.name || goal.entity.displayName || null,
            pos: {
                x: +goal.entity.position.x.toFixed(3),
                y: +goal.entity.position.y.toFixed(3),
                z: +goal.entity.position.z.toFixed(3),
            },
        };
    }
    if (goal.goal) out.goal = motionGoal(goal.goal, depth + 1);
    return out;
}

function motionPathLen(pathResult) {
    try {
        if (!pathResult) return null;
        if (Array.isArray(pathResult.path)) return pathResult.path.length;
        if (Array.isArray(pathResult)) return pathResult.length;
    } catch (e) {}
    return null;
}

function motionAudit(bot, event, data = {}) {
    try {
        appendTelemetry('mine_motion.jsonl', {
            ts: new Date().toISOString(),
            event,
            pos: motionPos(bot),
            held: bot && bot.heldItem ? bot.heldItem.name : 'empty',
            hp: bot ? Math.round(bot.health || 0) : null,
            food: bot ? bot.food : null,
            skill: bot ? (bot._currentSkill || null) : null,
            mob: bot && bot._mobility ? bot._mobility.state : null,
            data,
        });
    } catch (e) {}
}

async function autoLight(bot) {
    if (world.shouldPlaceTorch(bot)) {
        try {
            const pos = world.getPosition(bot);
            return await placeBlock(bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
        } catch (err) {return false;}
    }
    return false;
}

async function equipHighestAttack(bot) {
    let weapons = bot.inventory.items().filter(item => item.name.includes('sword') || (item.name.includes('axe') && !item.name.includes('pickaxe')));
    if (weapons.length === 0)
        weapons = bot.inventory.items().filter(item => item.name.includes('pickaxe') || item.name.includes('shovel'));
    if (weapons.length === 0)
        return;
    weapons.sort((a, b) => b.attackDamage - a.attackDamage);
    let weapon = weapons[0];
    if (weapon)
        await bot.equip(weapon, 'hand');
}

export async function craftRecipe(bot, itemName, num=1) {
    /**
     * Attempt to craft the given item name from a recipe. May craft many items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to craft.
     * @returns {Promise<boolean>} true if the recipe was crafted, false otherwise.
     * @example
     * await skills.craftRecipe(bot, "stick");
     **/
    let placedTable = false;

    // Reclaim a crafting table WE placed — pick it back up so we carry ONE table and
    // re-use it, instead of littering a fresh table at every craft spot as we roam (the
    // plains were carpeted with abandoned tables). Robust by design: break the EXACT block
    // we placed (not a fuzzy nearest-search), sweep the drop, retry a few times. The caller
    // runs this while interrupting modes are still suppressed, so a mode can't walk the bot
    // off mid-reclaim and strand the table (the old failure that caused the litter).
    const reclaimTable = async (pos) => {
        if (!pos) return;
        for (let t = 0; t < 3; t++) {
            const blk = bot.blockAt(pos);
            if (blk && blk.name === 'crafting_table') { try { await breakBlockAt(bot, pos.x, pos.y, pos.z); } catch (e) {} }
            try { await pickupNearbyItems(bot); } catch (e) {}
            if (world.getInventoryCounts(bot)['crafting_table'] > 0) return;
            await new Promise(r => setTimeout(r, 200));
        }
    };

    if (mc.getItemCraftingRecipes(itemName).length == 0) {
        log(bot, `${itemName} is either not an item, or it does not have a crafting recipe!`);
        return false;
    }

    // get recipes that don't require a crafting table
    let recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, null); 
    let craftingTable = null;
    const craftingTableRange = 16;
    placeTable: if (!recipes || recipes.length === 0) {
        recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, true);
        if(!recipes || recipes.length === 0) break placeTable; //Don't bother going to the table if we don't have the required resources.

        // Look for crafting table
        craftingTable = await world.getNearestBlockAsync(bot, 'crafting_table', 64);   // ★B定点16→64(0714): 找现有台走过去用(下方308"刚放的台"仍用craftingTableRange紧邻,别扩)
        if (craftingTable === null){

            // Try to place crafting table
            let hasTable = world.getInventoryCounts(bot)['crafting_table'] > 0;
            if (hasTable) {
                let pos = world.getNearestFreeSpace(bot, 1, 6);
                if (pos) {   // ★getNearestFreeSpace 可能返回 null(窄坑全封死) — 别对 undefined 取 .x 抛 TypeError
                    await placeBlock(bot, 'crafting_table', pos.x, pos.y, pos.z);
                    craftingTable = await world.getNearestBlockAsync(bot, 'crafting_table', craftingTableRange);
                    if (craftingTable) {
                        recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, craftingTable);
                        placedTable = true;
                    }
                }
            }
            else {
                log(bot, `Crafting ${itemName} requires a crafting table.`)
                return false;
            }
        }
        else {
            recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, craftingTable);
        }
    }
    if (!recipes || recipes.length === 0) {
        log(bot, `You do not have the resources to craft a ${itemName}. It requires: ${Object.entries(mc.getItemCraftingRecipes(itemName)[0][0]).map(([key, value]) => `${key}: ${value}`).join(', ')}.`);
        if (placedTable && craftingTable) {
            await reclaimTable(craftingTable.position);
        }
        return false;
    }

    if (craftingTable && bot.entity.position.distanceTo(craftingTable.position) > 4) {
        await goToNearestBlock(bot, 'crafting_table', 4, craftingTableRange);
    }

    const recipe = recipes[0];
    // ★2026-07-08 用户报"下指令后 bot 卡退"根因链的收口: 若配方【需要工作台】却没拿到【可达】的台, 绝不把它
    //   交给 bot.craft。两种坏情况: (a) craftingTable 仍是 null(16格没找到台 + 放新台失败/被身体挡住) —
    //   mineflayer craft.js:14 直接抛裸错 "Recipe requires craftingTable, but one was not supplied";
    //   (b) 台找到了但够不到(上面 goToNearestBlock 走近被 MAROONED 锁住导航, distance 仍 >4) — bot.craft
    //   对够不到的台开窗失败/悬挂。两者都会让失败动作反复重试撞进 action_manager 的 15s 不停窗口 →
    //   reconnectNow('action-refused-stop') 主动断线(卡退)。这里干净快退, 把身体交还任务层(可 moveAway 到
    //   开阔地再造台, 或 !vetoInstinct("march") 解锁导航走到已放的台旁)。4.5 与上面第330行的 >4 走近判据一致。
    if (recipe && recipe.requiresTable
        && !(craftingTable && bot.entity.position.distanceTo(craftingTable.position) <= 4.5)) {
        log(bot, `无法制作 ${itemName}: 需要工作台但够不到 —— 附近(${craftingTableRange}格)没有可用的台, 或已找到的台被锁住导航(MAROONED)走不过去, 且当前位置放不下新台。请先 moveAway 到开阔处再造台, 或解除行军锁走到已放的台旁。`);
        if (placedTable && craftingTable) { try { await reclaimTable(craftingTable.position); } catch (e) {} }
        return false;
    }
    console.log('crafting...');
    //Check that the agent has sufficient items to use the recipe `num` times.
    const inventory = world.getInventoryCounts(bot); //Items in the agents inventory
    const requiredIngredients = mc.ingredientsFromPrismarineRecipe(recipe); //Items required to use the recipe once.
    const craftLimit = mc.calculateLimitingResource(inventory, requiredIngredients);
    
    // Protect the craft from concurrent tick-driven MODE actions. A mode firing
    // mid-craft (item_collecting walking off to grab a dropped item, auto_eat,
    // self_preservation moveAway, ...) moves the bot / swaps the held item / opens
    // another window and CORRUPTS the in-progress craft window — ingredients get
    // consumed but the product is never retrieved (silent item loss). Freeze
    // movement + disable interrupting modes for the brief craft, then restore.
    const _guardModes = ['item_collecting', 'auto_eat', 'self_defense', 'self_preservation', 'hunting', 'torch_placing', 'unstuck', 'cowardice', 'idle_staring', 'elbow_room'];
    const _prevModes = {};
    try { bot.clearControlStates(); } catch (e) {}
    try { for (const m of _guardModes) if (bot.modes && bot.modes.exists(m)) { _prevModes[m] = bot.modes.isOn(m); bot.modes.setOn(m, false); } } catch (e) {}
    try {
        await bot.craft(recipe, Math.min(craftLimit.num, num), craftingTable);
        if(craftLimit.num<num) log(bot, `Not enough ${craftLimit.limitingResource} to craft ${num}, crafted ${craftLimit.num}. You now have ${world.getInventoryCounts(bot)[itemName]} ${itemName}.`);
        else log(bot, `Successfully crafted ${itemName}, you now have ${world.getInventoryCounts(bot)[itemName]} ${itemName}.`);
    }
    finally { try { for (const m in _prevModes) bot.modes.setOn(m, _prevModes[m]); } catch (e) {} }
    // NOTE: we deliberately DO NOT reclaim (pick up) the table after every craft. Doing so
    // crippled the grind — each subsequent craft then had to re-make a table (chop planks ->
    // place -> craft -> pick up -> repeat), trapping the bot in a wood/table loop that never
    // reached stone/iron. Instead we RELY ON the 16-block reuse above: at a work area we place
    // ONE table and reuse it for every craft there. Worst case is one leftover table per area
    // we roam to (minor), which is far better than a grind that can't progress. (reclaimTable
    // is kept defined for deliberate cleanup use, but not auto-invoked.)

    //Equip any armor the bot may have crafted.
    //There is probablly a more efficient method than checking the entire inventory but this is all mineflayer-armor-manager provides. :P
    bot.armorManager.equipAll(); 

    return true;
}

// ★2026-07-07 fix#1 (litter-in-pocket / 受限地形不敲台): 在 MAROONED/死角窄坑里破坏方块时,
//   掉落物会被物理弹开 1-2 格落进寻路够不到的墙角 — 实录 replenishKit/mineDiamonds 反复
//   "Broke crafting_table → Found path(success) → Unable to reach item, blacklisted 120s →
//   Picked up 0" 攒了一地散台+散铁(用户截图实观)。留在原地【不敲】的台是可复用、不会 5min
//   despawn 的实体方块, 严格优于一个够不到的散落物; 故受限地形一律跳过"敲碎回收", 台留原地,
//   择机脱困后自然复用/再收。判据两路:
//     ① mobility 子系统已判 MAROONED(exits 稀少) — 与 mineOres.marooned() 同源信号。
//     ② 几何兜底(_mobility 未 populated 时): 数脚位四正交邻格里"人能站进去"的开口. 正常 1 宽
//        隧道沿掘进向仍有前后 2 开口 → 不误伤 T-0079 随身台复用; 只有真·死角(≤1 开口)才触发,
//        那里敲碎的掉落物必弹进不可达墙角。
export function inConstrainedPocket(bot) {
    try {
        if (!bot || !bot.entity || !bot.entity.position) return false;
        if (/MAROONED/.test((bot._mobility && bot._mobility.state) || '')) return true;
        const base = bot.entity.position.floored();
        let open = 0;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const foot = bot.blockAt(base.offset(dx, 0, dz));
            const head = bot.blockAt(base.offset(dx, 1, dz));
            if (foot && foot.boundingBox !== 'block' && head && head.boundingBox !== 'block') open++;
        }
        return open <= 1;
    } catch (e) { return false; }
}

export async function craftRecipeLocal(bot, itemName, num=1) {
    /**
     * Craft from the bot's current pocket. For 3x3 recipes, prefer placing the carried
     * crafting table within arm reach instead of walking to a "nearest" table that may be
     * visible through stone. This is for emergency cave work such as remaking a pickaxe.
     **/
    const itemId = mc.getItemId(itemName);
    if (itemId == null || mc.getItemCraftingRecipes(itemName).length === 0) {
        log(bot, `${itemName} is either not an item, or it does not have a crafting recipe!`);
        return false;
    }

    let recipes = bot.recipesFor(itemId, null, 1, null);
    let craftingTable = null;
    // ★C301: bot.recipesFor() can return [] for a 2x2-craftable item EVEN WHEN the bot holds the
    // ingredients — crafting_table is built from the #planks tag, which doesn't resolve for jungle/
    // birch/etc. planks in some minecraft-data versions. The code then WRONGLY assumed a 3x3 table was
    // needed, hunted for one, found none, and gave up — so a bot with 14 jungle_planks could never
    // craft a crafting_table → no table → no tools/sword, the keystone dead-lock (T-0017). Before
    // assuming a table is needed, try recipesAll() (inventory-independent) and keep any NO-table recipe
    // the bot actually has ingredients for.
    if (!recipes || recipes.length === 0) {
        try {
            const all = bot.recipesAll(itemId, null, null) || [];
            const inv0 = world.getInventoryCounts(bot);
            const makeable = all.filter(r => r && !r.requiresTable
                && mc.calculateLimitingResource(inv0, mc.ingredientsFromPrismarineRecipe(r)).num > 0);
            if (makeable.length) { recipes = makeable; log(bot, `${itemName}: recipesFor empty but recipesAll found a no-table recipe with held ingredients (C301).`); }
        } catch (e) {}
    }
    let placedTableFromCarry = false;
    let placedTablePos = null;
    if (!recipes || recipes.length === 0) {
        const tblBefore = world.getInventoryCounts(bot)['crafting_table'] || 0;
        if (tblBefore > 0) {
            craftingTable = await placeCraftingTableWithinReach(bot);
            // ★T-0079: did we actually PLACE one from carry (vs reuse a nearby existing table)?
            // placeCraftingTableWithinReach returns an in-range existing table without placing — only
            // reclaim a table WE put down, never someone else's / a home/work-area table.
            const tblAfter = world.getInventoryCounts(bot)['crafting_table'] || 0;
            if (craftingTable && tblAfter < tblBefore) { placedTableFromCarry = true; placedTablePos = craftingTable.position; }
        } else {
            const near = await world.getNearestBlockAsync(bot, 'crafting_table', 4);
            if (near && bot.entity.position.distanceTo(near.position) <= 4.5) craftingTable = near;
        }
        if (!craftingTable) {
            log(bot, `Crafting ${itemName} needs a reachable crafting table.`);
            return false;
        }
        recipes = bot.recipesFor(itemId, null, 1, craftingTable);
    }
    if (!recipes || recipes.length === 0) {
        log(bot, `You do not have the resources to craft a ${itemName} locally.`);
        return false;
    }

    const recipe = recipes[0];
    const inventory = world.getInventoryCounts(bot);
    const requiredIngredients = mc.ingredientsFromPrismarineRecipe(recipe);
    const craftLimit = mc.calculateLimitingResource(inventory, requiredIngredients);
    if (!craftLimit.num) {
        log(bot, `Not enough ${craftLimit.limitingResource} to craft ${itemName} locally.`);
        return false;
    }

    const guardModes = ['item_collecting', 'auto_eat', 'self_defense', 'self_preservation', 'hunting', 'torch_placing', 'unstuck', 'cowardice', 'idle_staring', 'elbow_room'];
    const prevModes = {};
    try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
    try { bot.clearControlStates(); } catch (e) {}
    try { for (const m of guardModes) if (bot.modes && bot.modes.exists(m)) { prevModes[m] = bot.modes.isOn(m); bot.modes.setOn(m, false); } } catch (e) {}
    try {
        await bot.craft(recipe, Math.min(craftLimit.num, num), craftingTable);
        log(bot, `Successfully crafted ${itemName} locally, now have ${world.getInventoryCounts(bot)[itemName] || 0}.`);
        return true;
    } catch (e) {
        log(bot, `Local craft ${itemName} failed: ${e.message}.`);
        return false;
    } finally {
        // ★T-0079 (perpetual-pickless / tier-wood relapse keystone): RECLAIM the table we placed from
        // carry. Unlike craftRecipe's stay-put "16-block reuse" (a work area where leaving the table is
        // fine), craftRecipeLocal is MOBILE emergency cave-recraft — a left table is stranded the instant
        // the bot descends/moves, so the carried-table count drops to 0 → next deep pick-recraft has no
        // table → canRecraftPick=false → picks drain to 0 → wood relapse (the西西弗斯 churn). Reclaiming
        // keeps ONE carried table cycling with the bot so it can always remake a pickaxe underground from
        // free cobble+sticks. Done here while guard modes are still suppressed (no mode walks the bot off
        // mid-reclaim and re-strands it). Break the EXACT block we placed, sweep the drop, retry a few.
        if (placedTableFromCarry && placedTablePos) {
            // ★fix#1: 受限地形(MAROONED/死角窄坑)不敲台 — 敲碎会把台弹进够不到的墙角(散落一地,
            //   见 inConstrainedPocket 注释)。留台在原地: 可复用、不 despawn, 下一次 craftRecipeLocal
            //   走 placeCraftingTableWithinReach 的"就近复用既有台"分支即原地续用, 不再重放/重敲。
            if (inConstrainedPocket(bot)) {
                log(bot, `Left crafting_table placed @${Math.floor(placedTablePos.x)},${Math.floor(placedTablePos.y)},${Math.floor(placedTablePos.z)} (constrained pocket — breaking it would scatter the drop out of reach; reuse in place).`);
            } else {
                for (let t = 0; t < 3; t++) {
                    try { const blk = bot.blockAt(placedTablePos); if (blk && blk.name === 'crafting_table') await breakBlockAt(bot, placedTablePos.x, placedTablePos.y, placedTablePos.z); } catch (e) {}
                    try { await pickupNearbyItems(bot); } catch (e) {}
                    if ((world.getInventoryCounts(bot)['crafting_table'] || 0) > 0) break;
                    await new Promise(r => setTimeout(r, 200));
                }
            }
        }
        try { for (const m in prevModes) bot.modes.setOn(m, prevModes[m]); } catch (e) {}
        try { bot.clearControlStates(); } catch (e) {}
    }
}

async function placeCraftingTableWithinReach(bot) {
    let existing = await world.getNearestBlockAsync(bot, 'crafting_table', 3);
    if (existing && bot.entity.position.distanceTo(existing.position) <= 4.5) return existing;

    const empty = new Set(['air', 'cave_air', 'void_air', 'grass', 'short_grass', 'tall_grass', 'snow', 'dead_bush', 'fern']);
    const noBuild = new Set(['water', 'flowing_water', 'lava', 'flowing_lava', 'bedrock']);
    const base = bot.entity.position.floored();
    const offsets = [
        [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
        [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
        [2, 0, 0], [-2, 0, 0], [0, 0, 2], [0, 0, -2],
    ];
    const dirs = [
        new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
        new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0),
    ];
    const item = bot.inventory.findInventoryItem('crafting_table');
    if (!item) return null;

    for (const [dx, dy, dz] of offsets) {
        const target = base.offset(dx, dy, dz);
        if (botAabbIntersectsBlock(bot, target)) continue;
        const targetBlock = bot.blockAt(target);
        if (!targetBlock || !empty.has(targetBlock.name)) continue;
        let buildOff = null;
        let faceVec = null;
        for (const d of dirs) {
            const ref = bot.blockAt(target.plus(d));
            if (ref && ref.boundingBox === 'block' && !empty.has(ref.name) && !noBuild.has(ref.name)) {
                buildOff = ref;
                faceVec = new Vec3(-d.x, -d.y, -d.z);
                break;
            }
        }
        if (!buildOff || !faceVec) continue;
        try {
            const equipRes = await tickConfirm.equipConfirmed(bot, item.name, 'hand');
            if (!equipRes.ok) continue;
            await bot.lookAt(buildOff.position.offset(0.5, 0.5, 0.5), true);
            const res = await tickConfirm.placeBlockConfirmed(
                bot, buildOff, faceVec, target, 'crafting_table',
                { retries: 2, confirmTimeoutMs: 700, backoffMs: 150 }
            );
            if (!res.ok) continue;
            await tickConfirm.sleepMs(160);
            const placed = bot.blockAt(target);
            if (placed && placed.name === 'crafting_table') {
                log(bot, `Placed reachable crafting_table at ${target}.`);
                return placed;
            }
        } catch (e) {}
    }
    // ★2026-07-08 受限口袋壁龛兜底 (钻石"够不到"根因 1b, 见 [[craft-table-wedge-disconnect]] / [[diamond-never-reached-blocker-stack]]):
    //   刚钻进 1x2 石缝时身边全是实心 → 上面 12 格扫描找不到空气格 → 放不下台 → 石镐造不出 →
    //   mineDiamonds 永久 DEFER (实录 22×, 0 次真下潜)。像真玩家那样【挖出一格壁龛】再放台: 只挖脚侧一格
    //   可挖实心 (脚下支撑不动/不破流体/不吃矿石与设施/不碰基岩), 挖空后台放在其下方实心面上。fluid 六邻
    //   检沿用含水层护栏 —— 绝不朝水/岩浆挖出壁龛 (那正是 mineDiamonds 全部下潜守卫要防的)。
    try {
        const diggable = (b) => b && b.boundingBox === 'block' && !noBuild.has(b.name)
            && !/bedrock|barrier|obsidian|reinforced_deepslate|_ore$|chest|furnace|crafting_table|dispenser|dropper|hopper|spawner/.test(b.name);
        const fluidAround = (c) => {
            for (const [ex, ey, ez] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
                const nb = bot.blockAt(c.offset(ex, ey, ez));
                if (nb && /lava|water/.test(nb.name)) return true;
            }
            return false;
        };
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const niche = base.offset(dx, 0, dz);              // 脚侧一格 (非脚下支撑)
            if (botAabbIntersectsBlock(bot, niche)) continue;
            const nb = bot.blockAt(niche);
            if (!diggable(nb) || fluidAround(niche)) continue;
            const floor = bot.blockAt(niche.offset(0, -1, 0)); // 台需下方有实心可附着
            if (!floor || floor.boundingBox !== 'block' || noBuild.has(floor.name)) continue;
            try { await breakBlockAt(bot, niche.x, niche.y, niche.z); await tickConfirm.sleepMs(120); } catch (e) { continue; }
            const cleared = bot.blockAt(niche);
            if (!cleared || !empty.has(cleared.name)) continue;
            try {
                const equipRes = await tickConfirm.equipConfirmed(bot, item.name, 'hand');
                if (!equipRes.ok) continue;
                await bot.lookAt(floor.position.offset(0.5, 0.5, 0.5), true);
                const res = await tickConfirm.placeBlockConfirmed(
                    bot, floor, new Vec3(0, 1, 0), niche, 'crafting_table',
                    { retries: 2, confirmTimeoutMs: 700, backoffMs: 150 }
                );
                if (!res.ok) continue;
                await tickConfirm.sleepMs(160);
                const placed = bot.blockAt(niche);
                if (placed && placed.name === 'crafting_table') {
                    log(bot, `Placed crafting_table in a dug niche at ${niche} (constrained pocket — no ambient air spot).`);
                    return placed;
                }
            } catch (e) {}
        }
    } catch (e) {}
    log(bot, 'Could not place a reachable crafting_table for local craft.');
    return null;
}

export async function wait(bot, milliseconds) {
    /**
     * Waits for the given number of milliseconds.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} milliseconds, the number of milliseconds to wait.
     * @returns {Promise<boolean>} true if the wait was successful, false otherwise.
     * @example
     * await skills.wait(bot, 1000);
     **/
    // setTimeout is disabled to prevent unawaited code, so this is a safe alternative that enables interrupts
    let timeLeft = milliseconds;
    let startTime = Date.now();
    
    while (timeLeft > 0) {
        if (bot.interrupt_code) return false;
        
        let waitTime = Math.min(2000, timeLeft);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        let elapsed = Date.now() - startTime;
        timeLeft = milliseconds - elapsed;
    }
    return true;
}

// ★2026-07-14 admin 独占窗口续期 (用户令: admin 要求的长任务 — 炼铁/待命 — 不被别的命令打断):
// _extIntentUntil 由 handleMessage 在 admin 回合开头一次性给 5min 兜底 (agent.js:919), 长炉次/
// 长待命会跑穿这个窗口 → kernel._survivalTick 解冻、机会主义反射解冻 → 抢身体打断任务。这里在
// 任务主循环里每拍向后续期: 只在窗口【已开且新鲜】时延长 (Math.max 只延不缩), 窗口没开 (kernel
// 自主派发的同名技能) 绝不凭空开 — admin 语义只能由 admin 回合建立; 回合结束 handleMessage 的
// finally 照旧清零, 不会泄漏。
function renewAdminHold(bot, ms = 20000) {
    try {
        if (bot._extIntentUntil && Date.now() < bot._extIntentUntil)
            bot._extIntentUntil = Math.max(bot._extIntentUntil, Date.now() + ms);
    } catch (e) {}
}

// ★2026-07-14: mineflayer openBlock 无超时 — 够不到/服务器丢 interact 时 `once('windowOpen')`
// 永久 pending, 会把调用方(smeltItem 等待循环)钉死: interrupt/stale/deadline 检查全部失效,
// stop() 15s 拉不停 → 强制放行+重连 (评审实锤)。race 一个计时器: 超时返 null 让调用方下一拍
// 重试; 迟到的窗口静默关掉不留孤儿。
function openFurnaceTimed(bot, block, ms = 6000) {
    return new Promise((resolve) => {
        let done = false;
        const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
        bot.openFurnace(block).then(w => {
            if (done) { try { bot.closeWindow(w); } catch (e) {} return; }
            done = true; clearTimeout(t); resolve(w);
        }).catch(() => { if (!done) { done = true; clearTimeout(t); resolve(null); } });
    });
}

export async function smeltItem(bot, itemName, num=1) {
    /**
     * Puts 1 coal in furnace and smelts the given item name, waits until the furnace runs out of fuel or input items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to smelt. Ores must contain "raw" like raw_iron.
     * @param {number} num, the number of items to smelt. Defaults to 1.
     * @returns {Promise<boolean>} true if the item was smelted, false otherwise. Fail
     * @example
     * await skills.smeltItem(bot, "raw_iron");
     * await skills.smeltItem(bot, "beef");
     **/

    if (!mc.isSmeltable(itemName)) {
        log(bot, `Cannot smelt ${itemName}. Hint: make sure you are smelting the 'raw' item.`);
        return false;
    }

    let placedFurnace = false;
    let furnaceBlock = undefined;
    const furnaceRange = 16;
    furnaceBlock = await world.getNearestBlockAsync(bot, 'furnace', 64);   // ★B定点16→64(0714): 找现有炉走过去用(697"刚放的炉"仍用furnaceRange紧邻)
    if (!furnaceBlock){
        // Try to place furnace
        let hasFurnace = world.getInventoryCounts(bot)['furnace'] > 0;
        if (hasFurnace) {
            let pos = world.getNearestFreeSpace(bot, 1, furnaceRange);
            await placeBlock(bot, 'furnace', pos.x, pos.y, pos.z);
            furnaceBlock = await world.getNearestBlockAsync(bot, 'furnace', furnaceRange);
            placedFurnace = true;
        }
    }
    if (!furnaceBlock){
        log(bot, `There is no furnace nearby and you have no furnace.`)
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        await goToNearestBlock(bot, 'furnace', 4, furnaceRange);
    }
    bot.modes.pause('unstuck');
    // ★2026-07-14: 挪身体的机会主义本能会把炉窗挤关/把 bot 拽走 (torch 挪一格、捡物飘走) —
    //   炼铁全程站桩, 先暂停它们 (idle 时 modes.unPauseAll 自动恢复); 保命反射不动。
    for (const m of ['torch_placing', 'item_collecting', 'hunting', 'elbow_room', 'edge_unstick'])
        try { bot.modes.pause(m); } catch (e) {}
    await bot.lookAt(furnaceBlock.position);

    console.log('smelting...');
    const furnace = await openFurnaceTimed(bot, furnaceBlock, 8000);
    if (!furnace) {
        log(bot, `Could not open the furnace (out of reach or the server ignored the interact).`);
        return false;
    }
    // check if the furnace is already smelting something
    let input_item = furnace.inputItem();
    if (input_item && input_item.type !== mc.getItemId(itemName) && input_item.count > 0) {
        // TODO: check if furnace is currently burning fuel. furnace.fuel is always null, I think there is a bug.
        // This only checks if the furnace has an input item, but it may not be smelting it and should be cleared.
        log(bot, `The furnace is currently smelting ${mc.getItemName(input_item.type)}.`);
        if (placedFurnace)
            await collectBlock(bot, 'furnace', 1);
        return false;
    }
    // check if the bot has enough items to smelt
    let inv_counts = world.getInventoryCounts(bot);
    if (!inv_counts[itemName] || inv_counts[itemName] < num) {
        log(bot, `You do not have enough ${itemName} to smelt.`);
        if (placedFurnace)
            await collectBlock(bot, 'furnace', 1);
        return false;
    }

    // fuel the furnace
    // ★2026-07-14: 槽位只有一组 (64) 容量 — 燃料/输入都改成"先投一组, 循环里续投"
    //   (旧代码 num>64 时一次 putInput 直接抛 'destination full', 动作秒炸)。
    let fuelType = null, fuelNeeded = 0, fuelDeposited = 0;
    if (!furnace.fuelItem()) {
        let fuel = mc.getSmeltingFuel(bot);
        if (!fuel) {
            log(bot, `You have no fuel to smelt ${itemName}, you need coal, charcoal, or wood.`);
            if (placedFurnace)
                await collectBlock(bot, 'furnace', 1);
            return false;
        }
        log(bot, `Using ${fuel.name} as fuel.`);

        fuelNeeded = Math.ceil(num / mc.getFuelSmeltOutput(fuel.name));

        if (fuel.count < fuelNeeded) {
            log(bot, `You don't have enough ${fuel.name} to smelt ${num} ${itemName}; you need ${fuelNeeded}.`);
            if (placedFurnace)
                await collectBlock(bot, 'furnace', 1);
            return false;
        }
        fuelType = fuel.type;
        fuelDeposited = Math.min(fuelNeeded, 64);
        await furnace.putFuel(fuelType, null, fuelDeposited);
        log(bot, `Added ${fuelDeposited} ${mc.getItemName(fuelType)} to furnace fuel.`);
        console.log(`Added ${fuelDeposited} ${mc.getItemName(fuelType)} to furnace fuel.`)
    }
    // put the items in the furnace (first batch; the wait loop tops the slot up)
    let deposited = Math.min(num, 64);
    await furnace.putInput(mc.getItemId(itemName), null, deposited);
    // ★2026-07-14 用户令 (炼铁必须等炼完, 且不被别的命令打断): 旧等待段 "11s 没收到产出就 break" —
    //   一件要烧整 10s, 服务器慢一拍/炉窗被微移挤关, 就在投料后立刻放弃 → 拿回输入、收炉跑路
    //   (用户实拍的"投完煤和生铁任务自动结束")。重写 (全程 await 轮询, 不同步阻塞不掉线):
    //   • 进度 = 收到产出 或 炉内输入数下降 (一件烧完才移出输入槽) — 30s 无进度才判炉死,
    //     另有 10s/件+60s 的总时限兜底 (燃料中途烧干也能体面收场);
    //   • 炉窗被挤关 (击退/微移) → 找回炉子重开继续收, 不再把"窗关"当"炼完";
    //   • admin 驱动的炉次每拍 renewAdminHold 续期独占窗口 → kernel/非致命反射全程让位,
    //     超过 5min 兜底的长炉次也不会中途被抢身体;
    //   • 真被打断 (保命反射 / admin 撤销) → 留炉在烧、不拿回输入、不拆炉 (东西在炉里丢不了,
    //     回头 !clearFurnace 能收) — 打断者立刻要身体, 不做收尾动作。
    let total = 0;
    let smelted_item = null;
    let fur = furnace;
    let furnaceOpen = true;
    fur.once('close', () => { furnaceOpen = false; });
    let lastInputCount = (fur.inputItem() && fur.inputItem().count) || deposited;
    let lastProgress = Date.now();
    const STALE_MS = 30000;
    const deadline = Date.now() + num * 10000 + 60000;
    let interrupted = false;
    while (total < num) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (bot.interrupt_code) { interrupted = true; break; }
        renewAdminHold(bot);
        try {
            if (!fur || !furnaceOpen) {
                const fb = bot.blockAt(furnaceBlock.position);
                if (!fb || !fb.name.includes('furnace')) {
                    log(bot, `The furnace is gone.`);
                    break;
                }
                // 回【这口炉】的坐标 — goToNearestBlock 会走向"最近的"炉 (smeltSafe 满地登记炉,
                // 可能是另一口), 人在别的炉旁对原炉发 interact 会被服务器无声丢弃 (评审实锤)。
                if (bot.entity.position.distanceTo(furnaceBlock.position) > 4)
                    await goToPosition(bot, furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2);
                if (bot.entity.position.distanceTo(furnaceBlock.position) > 4.5)
                    throw new Error('still out of reach after walking back');   // → catch → 下一拍重试, stale 计时器兜底
                fur = await openFurnaceTimed(bot, fb, 6000);
                if (!fur)
                    throw new Error('reopen timed out');   // → catch → 下一拍重试
                furnaceOpen = true;
                fur.once('close', () => { furnaceOpen = false; });
            }
            if (fur.outputItem()) {
                smelted_item = await fur.takeOutput();
                if (smelted_item) {
                    total += smelted_item.count;
                    lastProgress = Date.now();
                }
            }
            let inCount = (fur.inputItem() && fur.inputItem().count) || 0;
            if (inCount < lastInputCount) {
                lastInputCount = inCount;
                lastProgress = Date.now();
            }
            // 分批续投: 输入槽空出位置且总量还没投完就补一批 (num>64 的唯一可行路径)
            if (deposited < num && inCount < 64) {
                const add = Math.min(64 - inCount, num - deposited);
                await fur.putInput(mc.getItemId(itemName), null, add);
                deposited += add;
                inCount += add;
                lastInputCount = inCount;
            }
            // 燃料续投: 首批只装得下一组; 槽烧空且还欠着就补
            if (fuelType !== null && fuelDeposited < fuelNeeded && !fur.fuelItem()) {
                const addF = Math.min(64, fuelNeeded - fuelDeposited);
                await fur.putFuel(fuelType, null, addF);
                fuelDeposited += addF;
            }
            if (inCount === 0 && deposited >= num && !fur.outputItem() && total > 0)
                break; // 全部投完+烧完+产出收干 — 到头了 (即使服务器吞了几件也别干等)
        } catch (err) {
            // 窗口中途失效 (移动/击退挤关) — 置空下一拍重开, 不当致命错
            console.log(`smeltItem furnace window hiccup: ${err.message}`);
            fur = null;
            furnaceOpen = false;
        }
        if (Date.now() - lastProgress > STALE_MS) {
            log(bot, `Furnace made no progress for ${STALE_MS / 1000}s, giving up.`);
            break;
        }
        if (Date.now() > deadline) {
            log(bot, `Smelting overran its time budget, giving up.`);
            break;
        }
    }
    if (interrupted) {
        // 被打断 (保命反射/admin 撤销): 窗口还开着就【快速】拿回输入+燃料 (窗口内点两下, ≲1s,
        // 在 stop() 的 15s 脉冲窗口内) — smeltSafe 的 input-delta 进度契约依赖"没炼完的料会拿
        // 回来"(评审实锤: 留料在炉 = 假成功喂内核)。窗口已丢就留炉在烧 (炉里丢不了, !clearFurnace
        // 可收), 不为收尾跟打断者抢身体。
        try {
            if (fur && furnaceOpen) {
                if (fur.inputItem()) await fur.takeInput();
                if (fur.fuelItem()) await fur.takeFuel();
            }
        } catch (e) {}
        try { await bot.closeWindow(fur || furnace); } catch (e) {}
        log(bot, `Smelting interrupted after collecting ${total}/${num} ${itemName}.`);
        return total >= num;
    }
    // take all remaining in input/fuel slots
    try {
        if (fur && furnaceOpen) {
            if (fur.inputItem()) await fur.takeInput();
            if (fur.fuelItem()) await fur.takeFuel();
        }
    } catch (e) { console.log(`smeltItem cleanup hiccup: ${e.message}`); }

    try { await bot.closeWindow(fur || furnace); } catch (e) {}

    if (placedFurnace) {
        await collectBlock(bot, 'furnace', 1);
    }
    if (total === 0) {
        log(bot, `Failed to smelt ${itemName}.`);
        return false;
    }
    if (total < num) {
        log(bot, `Only smelted ${total} ${mc.getItemName(smelted_item.type)}.`);
        return false;
    }
    log(bot, `Successfully smelted ${itemName}, got ${total} ${mc.getItemName(smelted_item.type)}.`);
    return true;
}

export async function clearNearestFurnace(bot) {
    /**
     * Clears the nearest furnace of all items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the furnace was cleared, false otherwise.
     * @example
     * await skills.clearNearestFurnace(bot);
     **/
    let furnaceBlock = await world.getNearestBlockAsync(bot, 'furnace', 64);   // ★B定点32→64(0714)
    if (!furnaceBlock) {
        log(bot, `No furnace nearby to clear.`);
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        await goToNearestBlock(bot, 'furnace', 4, 32);
    }

    console.log('clearing furnace...');
    const furnace = await bot.openFurnace(furnaceBlock);
    console.log('opened furnace...')
    // take the items out of the furnace
    let smelted_item, intput_item, fuel_item;
    if (furnace.outputItem())
        smelted_item = await furnace.takeOutput();
    if (furnace.inputItem())
        intput_item = await furnace.takeInput();
    if (furnace.fuelItem())
        fuel_item = await furnace.takeFuel();
    console.log(smelted_item, intput_item, fuel_item)
    let smelted_name = smelted_item ? `${smelted_item.count} ${smelted_item.name}` : `0 smelted items`;
    let input_name = intput_item ? `${intput_item.count} ${intput_item.name}` : `0 input items`;
    let fuel_name = fuel_item ? `${fuel_item.count} ${fuel_item.name}` : `0 fuel items`;
    log(bot, `Cleared furnace, received ${smelted_name}, ${input_name}, and ${fuel_name}.`);
    return true;

}


export async function attackNearest(bot, mobType, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} mobType, the type of mob to attack.
     * @param {boolean} kill, whether or not to continue attacking until the mob is dead. Defaults to true.
     * @returns {Promise<boolean>} true if the mob was attacked, false if the mob type was not found.
     * @example
     * await skills.attackNearest(bot, "zombie", true);
     **/
    bot.modes.pause('cowardice');
    if (mobType === 'drowned' || mobType === 'cod' || mobType === 'salmon' || mobType === 'tropical_fish' || mobType === 'squid')
        bot.modes.pause('self_preservation'); // so it can go underwater. TODO: have an drowning mode so we don't turn off all self_preservation
    const mob = world.getNearbyEntities(bot, 24).find(entity => entity.name === mobType);
    if (mob) {
        return await attackEntity(bot, mob, kill);
    }
    log(bot, 'Could not find any '+mobType+' to attack.');
    return false;
}

export async function attackEntity(bot, entity, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to attack.
     * @returns {Promise<boolean>} true if the entity was attacked, false if interrupted
     * @example
     * await skills.attackEntity(bot, entity);
     **/

    let pos = entity.position;
    await equipHighestAttack(bot)

    if (!kill) {
        // ★够不到/目标已失效不出手 (与 kill 分支同款臂展守卫 — 用户实拍"对空气挥舞"的根治).
        // 旧逻辑逼近到 5 格就裸 bot.attack,不复检 reach/存活 → 目标移开或已死仍挥一记空拳.
        // 收到近战射程 3.5 格内再挥,挥前复检目标仍有效.
        if (bot.entity.position.distanceTo(pos) > 3.5) {
            console.log('moving to mob...')
            await goToPosition(bot, pos.x, pos.y, pos.z, 2);
        }
        if (!entity.isValid || bot.entity.position.distanceTo(entity.position) > 3.5) {
            log(bot, `⚠️ ${entity?.name || 'target'} 够不到/已消失 — 不对空气挥.`);
            return false;
        }
        console.log('attacking mob...')
        await bot.attack(entity);
        // bot.attack sends use_entity fire-and-forget; settle one tick so the
        // damage tick lands before caller queries entity state.
        await tickConfirm.sleepMs(100);
        return true;
    }
    else {
        // ★够不到不出手 (用户实拍"对空气挥舞"的机理根治,与 safeDig 臂展守卫同款):
        // bot.pvp 对不可达目标照样接近+挥砍。先做可达性预检 — 远于4格且无清晰路径
        // 的目标直接放弃(返回false让调用方换目标),不开始一场注定空挥的攻击。
        if (bot.entity.position.distanceTo(entity.position) > 4) {
            let clear = false;
            try { clear = await world.isClearPath(bot, entity); } catch (e) { clear = true; }
            if (!clear) {
                log(bot, `⚠️ ${entity.name} unreachable (no clear path) — not engaging.`);
                return false;
            }
        }
        bot.pvp.attack(entity);
        // ★HARD TIMEOUT. The kill-loop used to spin until the target died/left 24-blocks or
        // an interrupt fired — with NO time cap. A mob we CAN'T reach (spider on a ledge /
        // behind a wall / across water) never dies and never leaves, so bot.pvp keeps trying
        // forever and this await-loop hangs indefinitely. That silently froze setBed's daylight
        // spider-string hunt for 15min (its 60s for-cap lives in the loop condition, which a
        // non-returning attackEntity never reaches). Bail after 30s of no kill: stop pvp, sweep
        // any drops, return false so the caller relocates to a reachable target. Reset the clock
        // whenever we land a hit (HP drops) so a long-but-progressing fight isn't cut short.
        const start = Date.now();
        let lastHp = entity.health != null ? entity.health : null, lastProgress = start;
        while (world.getNearbyEntities(bot, 24).includes(entity)) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (bot.interrupt_code) { bot.pvp.stop(); return false; }
            if (entity.health != null && lastHp != null && entity.health < lastHp) lastProgress = Date.now();
            if (entity.health != null) lastHp = entity.health;
            // 12s (was 30s): 零伤害挥 12 秒=在打空气 — 旧 30 秒窗口正是实拍空挥的主体
            if (Date.now() - lastProgress > 12000) {
                bot.pvp.stop();
                log(bot, `⚠️ Can't kill ${entity.name} in 12s (unreachable?) — breaking off.`);
                try { await pickupNearbyItems(bot); } catch (e) {}
                return false;
            }
        }
        log(bot, `Successfully killed ${entity.name}.`);
        await pickupNearbyItems(bot);
        return true;
    }
}

export async function defendSelf(bot, range=9) {
    /**
     * Defend yourself from all nearby hostile mobs until there are no more.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} range, the range to look for mobs. Defaults to 8.
     * @returns {Promise<boolean>} true if the bot found any enemies and has killed them, false if no entities were found.
     * @example
     * await skills.defendSelf(bot);
     * **/
    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');
    let attacked = false;
    // ★C360 (modes.js FUTILE-FIGHT 断路器同步豁免): 黑名单(bot._futileMobIds, id→expiry)里的
    // 打不动怪不选为目标 — 否则 mode 层不 engage 它, 但为别的怪进来的 defendSelf 内循环又会
    // 把它捞回来, 断路器被驱动层旁路。被它真打中时 modes 层会立即摘除黑名单 (挨打必还手)。
    const _engageable = (entity) => {
        if (!mc.isHostile(entity)) return false;
        const m = bot._futileMobIds;
        return !(m instanceof Map) || entity.id == null || !((m.get(entity.id) || 0) > Date.now());
    };
    let enemy = world.getNearestEntityWhere(bot, _engageable, range);
    while (enemy) {
        await equipHighestAttack(bot);
        if (bot.entity.position.distanceTo(enemy.position) >= 4 && enemy.name !== 'creeper' && enemy.name !== 'phantom') {
            try {
                await goToGoal(bot, new pf.goals.GoalFollow(enemy, 3.5));
            } catch (err) {/* might error if entity dies or path blocked, ignore */}
        }
        if (bot.entity.position.distanceTo(enemy.position) <= 2) {
            try {
                let inverted_goal = new pf.goals.GoalInvert(new pf.goals.GoalFollow(enemy, 2));
                await goToGoal(bot, inverted_goal);
            } catch (err) {/* might error if entity dies or path blocked, ignore */}
        }
        bot.pvp.attack(enemy);
        attacked = true;
        await new Promise(resolve => setTimeout(resolve, 500));
        enemy = world.getNearestEntityWhere(bot, _engageable, range);
        if (bot.interrupt_code) {
            bot.pvp.stop();
            return false;
        }
    }
    bot.pvp.stop();
    if (attacked)
        log(bot, `Successfully defended self.`);
    else
        log(bot, `No enemies nearby to defend self from.`);
    return attacked;
}


// ───────────────────────── DIG PRIMITIVES (用户铁律) ─────────────────────────
// Basic, reusable digging mechanics live HERE as low-level primitives, NOT copy-pasted
// into every skill / sub-loop. One spot to fix = every dig path fixed; no sub-path can
// silently miss the guard (that's exactly how the "抬头空挥" regression slipped into the
// vein flood-fill while the main collectBlock path already had it).

// ── ★2026-07-06 方案A 选镐 ([[spec-pickaxe-stockpile-redesign]]) ──────────────────
// 用户令: 挖矿护住高级镐(挖钻用铁镐, 省钻镐)、凿石用石镐; 同一品级内先用"快断的"(剩余耐久最低),
// 把近报废的镐用尽再换新的。mineflayer 的 bot.tool.equipForBlock 只按挖掘速度=最高品级选镐(铁镐
// 烧在石头上), 故对"需镐方块"改用本函数 — equipForDig 是全仓库 dig 的取镐 choke-point。
const _PICK_TIER_RANK = { wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 };
// 方块需要的最低镐品级 (0 = 非镐类方块, 交回 equipForBlock 处理木/土/沙, 不夺其选择)。
function pickReqTier(block) {
    const n = (block && block.name) || '';
    if (/obsidian|ancient_debris|crying_obsidian|respawn_anchor/.test(n)) return 4;                 // diamond+
    if (/diamond_ore|emerald_ore|redstone_ore|gold_ore/.test(n)) return 3;                          // iron+
    if (/iron_ore|lapis_ore|copper_ore/.test(n)) return 2;                                          // stone+
    if (/_ore$|stone|deepslate|andesite|diorite|granite|tuff|calcite|cobble|blackstone|basalt|netherrack|end_stone|sandstone|terracotta|concrete$|amethyst|nether_brick|quartz_block|glowstone|magma_block|smooth_|polished_|_bricks$/.test(n)) return 1;   // any pick
    return 0;
}
// 挑最优镐并装备 (方案A: 够用的最低品级 + 同级剩余耐久最低)。返回是否已握上合规镐。
async function equipPickForBlock(bot, block) {
    try {
        const req = pickReqTier(block);
        if (req <= 0) return false;
        const tierOf = (i) => _PICK_TIER_RANK[(i.name || '').split('_')[0]] || 0;
        const remain = (i) => { const m = i.maxDurability || 0, u = (typeof i.durabilityUsed === 'number') ? i.durabilityUsed : 0; return m > 0 ? (m - u) : Infinity; };
        const picks = bot.inventory.items().filter(i => /_pickaxe$/.test(i.name || '') && tierOf(i) >= req);
        if (!picks.length) return false;
        const useTier = Math.min(...picks.map(tierOf));                                                       // 够用的最低品级
        const chosen = picks.filter(i => tierOf(i) === useTier).sort((a, b) => remain(a) - remain(b))[0];     // 同级最低耐久先用
        if (!chosen) return false;
        // 已握同级且不比 chosen 更新的镐 → 免重装 (防每次 dig 抖动切换)
        if (bot.heldItem && /_pickaxe$/.test(bot.heldItem.name || '') && tierOf(bot.heldItem) === useTier && remain(bot.heldItem) <= remain(chosen)) return true;
        await bot.equip(chosen, 'hand');
        return !!(bot.heldItem && /_pickaxe$/.test(bot.heldItem.name || '') && tierOf(bot.heldItem) >= req);
    } catch (e) { return false; }
}

// Pick the right tool for a block, but NEVER hold a sword to break wood — equipForBlock
// leaves a combat sword in hand when axe-less → "用木剑砍树" (slow + burns combat durability).
// Drop to bare hand for logs/wood when we have no axe. Every dig path uses this.
// ★方案A: 需镐方块先走 equipPickForBlock (护高级镐/同级先用快断的); 命中即返回, 否则回退 equipForBlock。
async function equipForDig(bot, block) {
    try { if (block && pickReqTier(block) > 0 && await equipPickForBlock(bot, block)) return; } catch (e) {}
    try { await bot.tool.equipForBlock(block); } catch (e) {}
    if (/_log$|_wood$|_stem$|_hyphae$/.test(block.name) && bot.heldItem && /_sword$/.test(bot.heldItem.name)
        && !bot.inventory.items().some(i => /_axe$/.test(i.name))) {
        try { await bot.unequip('hand'); } catch (e) {}
    }
}

// THE one block-break primitive. Walk adjacent if needed, verify eye→block-centre reach
// (≤4.6 — past that bot.dig swings at air forever on out-of-reach / leaf-occluded blocks),
// equip the right tool, dig with a hard time backstop, and STOP the swing on failure.
// Returns 'ok' | 'gone' | 'unreachable' | 'occluded' | 'fluidguard' | 'timeout' | 'error'. Caller decides cleanup
// (exclude, expand neighbours, relocate, ...). Opts: maxMs dig backstop, approach (path
// closer), equip (run equipForDig — false if caller already equipped), pickup (vacuum drop).
// ★Pattern-3 共享 interrupt-race: 把任意长 await(bot.dig / 自定义 promise)裹成"reflex 置了
// bot.interrupt_code(或死亡)时 ≤pollMs 内可被抢占"——否则 body 会一直忽略到 await 自然结束。
// 与 safeDig(948-955)/breakBlockAt 同款 idiom:200ms 轮询 + finally 清理。timeoutMs<=0 = 纯
// interrupt-race(不封顶);>0 加上限。onAbort(默认 stopDigging)在中止时 unwind 底层操作。
// 返回 'ok'|'timeout'|'error'(不抛),调用点可直接 `if (await ... !== 'ok')` 分支。
export async function raceInterrupt(bot, work, { pollMs = 200, timeoutMs = 0, onAbort } = {}) {
    let _iv = null, _to = null;
    const arms = [Promise.resolve(work)];
    arms.push(new Promise((_, rej) => {
        _iv = setInterval(() => { try { if (bot.interrupt_code || bot.health <= 0) rej(new Error('interrupted')); } catch (e) {} }, pollMs);
    }));
    if (timeoutMs > 0) arms.push(new Promise((_, rej) => { _to = setTimeout(() => rej(new Error('timeout')), timeoutMs); }));
    try {
        await Promise.race(arms);
        return 'ok';
    } catch (e) {
        try { (onAbort || (() => { try { bot.stopDigging(); } catch (_) {} }))(); } catch (_) {}
        return (e && e.message === 'timeout') ? 'timeout' : 'error';
    } finally {
        if (_iv) clearInterval(_iv);
        if (_to) clearTimeout(_to);
    }
}

// ★后退一步 (2026-07-09 用户令 "挖矿贴墙太近了需要后退一步"; 追加"只允许在当前方块内略微退后, 不离开本格"):
//  死贴墙面(眼睛几乎顶到墙)时, 看向目标的射线先撞脸前那堵墙 → canSeeBlock 假阴 → 卡墙空挥。人类做法:
//  往后靠一点点换个视角。【只在当前 floored 方块内】沿远离墙的水平主轴挪到靠里子格(离墙远一点点),
//  一旦要越出本格立即停 — 绝不迈进相邻格。同格内退后=地板不变、无坠落/流体/邻格风险, 纯非破坏微调。
//  看向目标按 back 键即远离墙; 到位/将越格/1.2s 任一即停清控制。确有位移→true(交回 C337-C 顶复查 LOS)。
async function _stepBackForDig(bot, target) {
    try {
        if (!bot || !bot.entity || !target || !target.position) return false;
        if (!bot.entity.onGround) return false;
        const m0 = bot.entity.position;
        const ctr = target.position.offset(0.5, 0.5, 0.5);
        const dx = ctr.x - m0.x, dz = ctr.z - m0.z;             // 指向目标(墙)的水平方向
        if (Math.hypot(dx, dz) < 0.05) return false;            // 目标基本在正上/下方 — 退后无意义
        const feet = m0.floored();
        const axis = Math.abs(dx) >= Math.abs(dz) ? 'x' : 'z';
        const sign = axis === 'x' ? Math.sign(dx) : Math.sign(dz);   // >0: 墙在 +轴, 退向 -轴
        if (!sign) return false;
        // 本格内"靠里"落点: 远离墙那侧, 留身宽余量不贴对面 → floor + (墙在+轴 ? 0.3 : 0.7)。中心仍在本格。
        const aim = (axis === 'x' ? feet.x : feet.z) + (sign > 0 ? 0.3 : 0.7);
        const start = axis === 'x' ? m0.x : m0.z;
        if (sign > 0 ? start <= aim + 0.03 : start >= aim - 0.03) return false;   // 已经够靠里, 无需动
        const _t0 = Date.now();
        try {
            while (Date.now() - _t0 < 1200 && !bot.interrupt_code) {
                const m = bot.entity.position, cell = m.floored();
                if (cell.x !== feet.x || cell.z !== feet.z) break;              // 将越出本格 → 停(不离开当前方块)
                const sub = axis === 'x' ? m.x : m.z;
                if (sign > 0 ? sub <= aim : sub >= aim) break;                  // 已退到靠里子格
                try { await bot.lookAt(new Vec3(ctr.x, m.y + 1.62, ctr.z), true); } catch (e) {}   // 看向墙, back 键即远离
                try { bot.setControlState('back', true); } catch (e) {}
                await new Promise(r => setTimeout(r, 60));
            }
        } finally { try { bot.clearControlStates(); } catch (e) {} }
        const end = axis === 'x' ? bot.entity.position.x : bot.entity.position.z;
        return Math.abs(end - start) > 0.08;                                   // 确有后退位移
    } catch (e) { try { bot.clearControlStates(); } catch (_) {} return false; }
}

async function safeDig(bot, block, { maxMs = 15000, approach = true, equip = true, pickup = false, requireLOS = false } = {}) {
    const dead = (b) => !b || b.boundingBox === 'empty' || b.name === 'air';
    if (dead(block)) return 'gone';
    const reachOf = () => bot.entity.position.offset(0, 1.62, 0).distanceTo(block.position.offset(0.5, 0.5, 0.5));
    try {
        if (approach && reachOf() > 4.4)
            await goToPosition(bot, block.position.x, block.position.y, block.position.z, 2);
        if (reachOf() > 4.6) return 'unreachable';
        const cur = bot.blockAt(block.position);
        if (dead(cur)) return 'gone';
        // ★#1 (用户 2026-07-07: 挖仅 1 格外的矿要站在当前脚下方块正中——否则贴边/侧身站着挖, 挖完
        //   身子迈不进空出来的坑, 或够矿的姿势别扭). 目标水平相邻(≤1.6b)且自己明显偏离脚下方块中心
        //   (>0.33b)时, 先滑到方块正中再挖。只近距+ORE(requireLOS)触发(远处 approach 已定位), 手动
        //   nudge 上限 1.2s 不缠斗, 结束清控制; bot.dig 会自行重新看向目标, 居中不改可达/LOS。
        if (requireLOS && approach && bot.entity.onGround) {
            const _m0 = bot.entity.position;
            const _horiz = Math.hypot((block.position.x + 0.5) - _m0.x, (block.position.z + 0.5) - _m0.z);
            const _cx = Math.floor(_m0.x) + 0.5, _cz = Math.floor(_m0.z) + 0.5;
            const _off = Math.hypot(_m0.x - _cx, _m0.z - _cz);
            if (_horiz <= 1.6 && _off > 0.33) {
                const _t0 = Date.now();
                try {
                    while (Date.now() - _t0 < 1200 && !bot.interrupt_code) {
                        const _m = bot.entity.position;
                        if (Math.hypot(_cx - _m.x, _cz - _m.z) < 0.16) break;
                        try { await bot.lookAt(new Vec3(_cx, _m.y + 1.62, _cz), true); } catch (e) {}
                        try { bot.setControlState('forward', true); } catch (e) {}
                        await new Promise(r => setTimeout(r, 80));
                    }
                } finally { try { bot.clearControlStates(); } catch (e) {} }
            }
        }
        // ★C337+ (2026-07-06 用户实拍: 站墙前把墙后下方的铁隔墙挖掉, 然后卡墙乱挥镐子过不去):
        // anti-x-ray LOS gate, opt-in via requireLOS (collectBlock passes it for ORE). Enforce
        // line-of-sight to the ore at ANY distance — canSeeBlock raycasts eye→block-centre and is
        // TRUE only when the first solid-shaped block the ray hits IS the target (air passes through).
        // So an ore we legitimately tunnelled UP TO has an EXPOSED face → canSeeBlock TRUE → passes;
        // an ore behind a solid wall → the wall's shape is hit first → FALSE → refused.
        // ★The OLD `reachOf()>2.5` exemption was the x-ray HOLE: it assumed a tunnelled-up ore fails
        // canSeeBlock and needs a blanket pass, but a tunnelled-up ore does NOT fail it (its near face
        // is exposed). All the exemption actually did was let the bot reach-through a 1-block wall to
        // grab ore ≤2.5b away (bug 1), and then — because that pocket is behind the wall — jam the
        // pickup pathfind against the wall swinging forever (bug 2). No distance exemption now: occluded
        // ⇒ refuse; the caller skips+excludes and branchMine's carve-a-stand-cell path exposes it legit.
        if (requireLOS) {
            // ★后退一步 (用户令): 贴墙太近(臂展内 <2.2b)却 canSeeBlock 假阴 = 脸顶着墙看不清目标 → 先非
            //  破坏地【在当前方块内】往后靠一点点取视角(好过直接凿墙)。退后下面 C337-C 循环顶复查 LOS, 通了就直接采。
            {
                const _losNow = (() => { try { return bot.canSeeBlock(cur); } catch (e) { return true; } })();
                if (!_losNow && reachOf() < 2.2 && bot.entity.onGround) {
                    if (await _stepBackForDig(bot, cur)) {
                        appendTelemetry('mine_dbg.log', `[${new Date().toISOString()}] ★STEP-BACK dig ${cur.name}@${cur.position.x},${cur.position.y},${cur.position.z} — 贴墙太近, 本格内后退取视角\n`, { json: false });
                    }
                }
            }
            // ★C337-C (2026-07-09 "挖石头开路"落到执行层 — 实拍: C304 放行脸前 2.2 格埋铁, 这里
            // canSeeBlock=false 秒拒 'occluded' → 主循环 skip+exclude 150ms 一块 9 连败 gained=0
            // 扬长而去 = "路过铁不挖"。选目标层允许了埋矿, 抡镐层却"看不见就不挖", 中间挡视线的
            // 1-2 块石头无人负责挖开)。人类行为: 矿被一层石头挡着就先敲掉挡的那块。
            // 修: LOS 失败 → 沿眼→矿心射线取第一块遮挡物, 满足【臂展内 ≤4.6 / 不是矿 / 不是自己
            // 脚下支撑柱 / 过流体裁判】→ 挖掉它, 复查 LOS, 最多 3 块。遮挡物够不到/挖不动/是矿
            // → 维持 'occluded' 原样拒 (真·隔厚墙 x-ray 仍不可能; 矿遮矿交回主循环按矿正常采)。
            for (let _c = 0; _c < 3; _c++) {
                if (bot.interrupt_code) return 'occluded';
                const _los = (() => { try { return bot.canSeeBlock(cur); } catch (e) { return true; } })();
                if (_los) break;
                const _eye = bot.entity.position.offset(0, 1.62, 0);
                const _ctr = cur.position.offset(0.5, 0.5, 0.5);
                const _d = _ctr.minus(_eye); const _len = _d.norm();
                if (!(_len > 0.01)) break;
                let _hit = null;
                try { _hit = bot.world.raycast(_eye, _d.scaled(1 / _len), _len + 0.5); } catch (e) { _hit = null; }
                if (!_hit || !_hit.position) return 'occluded';
                if (_hit.position.equals(cur.position)) break;            // 射线已直达矿 — LOS 实际通
                const _ob = bot.blockAt(_hit.position);
                if (!_ob || _ob.boundingBox !== 'block') return 'occluded';
                if (/_ore$/.test(_ob.name || '')) return 'occluded';      // 矿遮矿: 不当渣土挖, 主循环自会采它
                if (bot.entity.position.offset(0, 1.62, 0).distanceTo(_ob.position.offset(0.5, 0.5, 0.5)) > 4.6) return 'occluded';
                const _feet = bot.entity.position.floored();
                if (_ob.position.x === _feet.x && _ob.position.z === _feet.z && _ob.position.y < _feet.y) return 'occluded';  // 自己脚下支撑柱不挖
                if (process.env.MC_DIG_FLUID_GUARD !== '0') {
                    const _og = safeToDigBlock(bot, _ob);
                    if (_og && _og.ok === false) {
                        appendTelemetry('mine_dbg.log', `[${new Date().toISOString()}] ★FLUIDGUARD skip occluder ${_ob.name}@${_ob.position.x},${_ob.position.y},${_ob.position.z} — ${_og.reason}\n`, { json: false });
                        return 'fluidguard';
                    }
                }
                try {
                    await Promise.race([
                        gazeHold(bot, _ob, bot.dig(_ob)),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('occluder-dig-timeout')), 6000)),
                    ]);
                    appendTelemetry('mine_dbg.log', `[${new Date().toISOString()}] ★C337-C carved occluder ${_ob.name}@${_ob.position.x},${_ob.position.y},${_ob.position.z} → expose ${cur.name}@${cur.position.x},${cur.position.y},${cur.position.z}\n`, { json: false });
                } catch (e) { return 'occluded'; }
            }
            const _losF = (() => { try { return bot.canSeeBlock(cur); } catch (e) { return true; } })();
            if (!_losF) return 'occluded';
        }
        // ★岩浆/水裁判 试装 (2026-07-07 用户令): DIG-lane fluid precondition. Before opening this
        // cell, ask the fluid guard whether breaking it would flood the bot's pocket — lava at any
        // depth, or water while underground (the sealed drown-pocket, deaths #112/#200). If so, refuse
        // THIS block and return 'fluidguard': the main loop skips+excludes it, harvestConnectedVein
        // drops it from the vein — same handling as 'occluded', so no caller change needed. The judge
        // is conservative (only face-adjacent fluid within a few blocks of the bot) and fail-open
        // (safeToDigBlock never throws upward), so it can't wedge mining. Observable in mine_dbg.log.
        // Off-switch: env MC_DIG_FLUID_GUARD=0.
        if (process.env.MC_DIG_FLUID_GUARD !== '0') {
            const _fg = safeToDigBlock(bot, cur);
            if (_fg && _fg.ok === false) {
                appendTelemetry('mine_dbg.log', `[${new Date().toISOString()}] ★FLUIDGUARD skip ${cur.name}@${cur.position.x},${cur.position.y},${cur.position.z} — ${_fg.reason}\n`, { json: false });
                return 'fluidguard';
            }
        }
        if (equip) await equipForDig(bot, cur);
        // ★2026-07-14 ORE-WASTE GUARD (mirror of breakBlockAt; 用户: "偶发性用石镐挖钻石"): safeDig has no
        // canHarvest gate, and equipForDig downgrades to the best-by-speed pick (a stone pick) when no iron+ is
        // owned. Breaking an ORE the held pick can't harvest drops NOTHING — refuse. This protects the vein
        // flood-fill harvestConnectedVein: if the iron pick snaps mid-diamond-vein, the remaining vein blocks
        // would otherwise be ground to dust with the stone fallback. Return 'wrong-tool' so callers skip+exclude
        // (handled exactly like 'occluded'/'fluidguard') and the ore survives for a proper-pick pass. Non-ore
        // corridor/escape stone stays ungated (bare-hand tunnelling of undroppable stone is legitimate).
        if (/_ore$|ancient_debris/.test(cur.name || '') && bot.game && bot.game.gameMode !== 'creative') {
            try { if (!cur.canHarvest(bot.heldItem ? bot.heldItem.type : null)) return 'wrong-tool'; } catch (e) {}
        }
        // ★Shorter timeout for normal blocks: a mineral/block we CAN'T actually break (wedged in
        // a corner / behind rock whose face we can't reach — the "对着夹角拼命空挥" the user keeps
        // seeing) gets abandoned in ~8s instead of flailing the full 15s. 8s safely covers every
        // legit slow break (barehand stone 7.5s, any pick far less); only genuinely hard blocks
        // (obsidian ~9.4s w/ diamond pick, for the nether portal) keep the long backstop. We can't
        // use canSeeBlock to pre-skip — x-ray ore is buried (6 faces hidden) and would all be skipped.
        const _hard = /obsidian|ancient_debris|reinforced/.test(cur.name || '');
        const _digMs = _hard ? maxMs : Math.min(maxMs, 8000);
        // ★Interrupt-aware (same fix as breakBlockAt): abort within ~200ms on cancel/preempt
        // instead of flailing out the full backstop — collectBlock's vein digs go through here.
        let _sdIv = null;
        try {
            await Promise.race([
                gazeHold(bot, cur, bot.dig(cur)),
                new Promise((_, rej) => setTimeout(() => rej(new Error('dig-timeout')), _digMs)),
                new Promise((_, rej) => { _sdIv = setInterval(() => { try { if (bot.interrupt_code) rej(new Error('interrupted')); } catch (e) {} }, 200); }),
            ]);
        } finally { if (_sdIv) clearInterval(_sdIv); }
        if (pickup) {
            let picked = false;
            // The block-change acknowledgement can arrive one tick before the item entity.
            // Give the drop a brief spawn window before deciding that nothing landed here.
            await new Promise(r => setTimeout(r, 150));
            try { picked = await ensurePickupAt(bot, cur.position, { radius: 6, maxDescend: 3, timeoutMs: 6000 }); } catch (e) {}
            if (!picked) { try { await pickupNearbyItems(bot); } catch (e) {} }
        }
        return 'ok';
    } catch (e) {
        try { bot.stopDigging(); } catch (_) {}
        if (e && e.message === 'interrupted') return 'error';
        return (e && e.message === 'dig-timeout') ? 'timeout' : 'error';
    }
}

// ★C304-T (2026-07-09 用户令"凿隧道直达"): 选矿层 C304 放行了 5–24 格外被实心石头埋住的铁, 但执行层
//  safeDig 只会 ①generic approach 够不到就秒返 'unreachable'(在任何凿开之前) ②在臂展内时沿眼→矿心
//  射线凿 ≤3 块"窥视孔"(C337-C)——两者都不产出一条能走进去的路; 于是 collectBlock 把整条矿脉一格一格
//  exclude 拆散放弃 (实录: 下潜到 y49 矿层, gained=0, 用时171s 空转白挖石头 = 用户"穿墙挖石头够不到铁
//  最终放弃矿脉")。branchMine.directMineOre 有"矿旁凿站位再步入"的近距原语, 但 collectBlock(mineOres
//  每轮首选路径)没有。本原语补上缺失的一环: 朝埋铁凿一条 1×2 密封隧道, 逐格步进, 直到矿进臂展+可见,
//  交回 safeDig 正常采(vein-follow 收尾)。安全闸(与 mineDown/reach-gate/C360-XR 同源, 缺一即安全停手
//  返 false 让调用方按旧逻辑 exclude, 绝不制造新险):
//   · 防坠: 下一站位格【脚下必须实心地板】, 否则=隔空/溶洞 → 先探同层狗腿绕路; 无安全格才停
//     (不搭桥, 守住 reach-gate "不跨空隙"语义)。
//   · 防淹: 每块 corridor 走 safeToDigBlock 岩浆/水裁判(safeDig 内建), 破面会淹 → 同样先绕路,
//     无安全格才停并保持密封。
//   · 防 x-ray: corridor 块只在臂展 ≤4.6 内破(safeDig approach:false 自带 reach 守卫); 矿块从不当渣土挖,
//     目标矿在安全前方才返 true 交 safeDig(其 requireLOS + C360-XR 仍锁真实采矿, 隔厚墙 x-ray 仍不可能)。
//   · 有界: maxSteps + budgetMs + interrupt/death 感知; 凿不开或步进不动累计 3 次即停。
//  off-switch: 环境变量 MC_ORE_TUNNEL=0 关闭(默认开)。
async function tunnelToOre(bot, oreBlock, { maxSteps = 30, budgetMs = 25000, maxD3 = 24 } = {}) {
    try {
        if (process.env.MC_ORE_TUNNEL === '0') return false;
        if (!oreBlock || !oreBlock.position) return false;
        if (bot._mobility && bot._mobility.state === 'MAROONED') return false;   // 行军独占移动, 让位
        const orePos = new Vec3(oreBlock.position.x, oreBlock.position.y, oreBlock.position.z);
        const oreCtr = orePos.offset(0.5, 0.5, 0.5);
        const isDead = (b) => !b || b.boundingBox === 'empty' || b.name === 'air';
        const isOreName = (n) => /_ore$/.test(n || '');
        const solidAt = (p) => { const b = bot.blockAt(p); return !!(b && b.boundingBox === 'block'); };
        const eyeReach = () => bot.entity.position.offset(0, 1.62, 0).distanceTo(oreCtr);
        const _dbg = (m) => appendTelemetry('mine_dbg.log', `[${new Date().toISOString()}] ${m}\n`, { json: false });
        if (eyeReach() > maxD3 + 1.5) return false;             // 太远, 不承诺(与 C304 同上限)
        const t0 = Date.now();
        let stuck = 0, carved = 0, detours = 0;
        const _MAX_DETOURS = 12;                                // 有界狗腿, 防大空腔里无限游走
        const _FLUID = /lava|water/;
        const _UNBREAKABLE = /^(bedrock|barrier|reinforced_deepslate)$/;
        const _key = (p) => `${p.x},${p.y},${p.z}`;
        const visited = new Set([_key(bot.entity.position.floored())]);
        const _corridor = (feet, sx, sy, sz) => {
            const nf = feet.offset(sx, sy, sz);      // 下一站位(脚)
            const nh = nf.offset(0, 1, 0);           // 下一站位(头)
            const floor = nf.offset(0, -1, 0);       // 下一站位脚下地板
            const carveList = [nf, nh];
            if (sy < 0 && (sx !== 0 || sz !== 0)) carveList.push(feet.offset(sx, 1, sz));
            return { sx, sy, sz, nf, nh, floor, carveList };
        };
        const _probeCorridor = (plan) => {
            const floorBlock = bot.blockAt(plan.floor);
            let fluidInCorridor = !!(floorBlock && _FLUID.test(floorBlock.name || ''));
            let fluidWouldEnter = false;
            let unbreakable = false;
            let targetAhead = false;
            let otherOreAhead = false;
            for (const p of plan.carveList) {
                const b = bot.blockAt(p);
                if (!b) continue;
                if (_FLUID.test(b.name || '')) fluidInCorridor = true;
                if (isOreName(b.name)) {
                    if (_key(p) === _key(orePos)) targetAhead = true;
                    else otherOreAhead = true;       // 不把另一条矿脉当隧道渣土挖掉
                }
                if (_UNBREAKABLE.test(b.name || '')) unbreakable = true;
                if (!isDead(b)) {
                    const guard = safeToDigBlock(bot, b);
                    if (guard && guard.ok === false) fluidWouldEnter = true;
                }
            }
            const safety = corridorSafety({
                floorSolid: solidAt(plan.floor),
                fluidInCorridor,
                fluidWouldEnter,
                unbreakable,
                visited: visited.has(_key(plan.nf)),
                targetAhead,
                otherOreAhead,
            });
            return {
                ...safety,
                targetAhead,
                score: Math.abs(orePos.x - plan.nf.x) + Math.abs(orePos.y - plan.nf.y) + Math.abs(orePos.z - plan.nf.z),
                plan,
            };
        };
        for (let step = 0; step < maxSteps; step++) {
            if (bot.interrupt_code || bot.death_abort || bot.health <= 0) return false;
            if (Date.now() - t0 > budgetMs) { _dbg(`★C304-T timeout ore@${orePos.x},${orePos.y},${orePos.z} carved=${carved} step=${step}`); return false; }
            const cur = bot.blockAt(orePos);
            if (isDead(cur) || !isOreName(cur.name)) return false;   // 矿已被采走/消失 → 交回主循环重扫
            let los = false; try { los = bot.canSeeBlock(cur); } catch (e) { los = false; }
            if (eyeReach() <= 4.4 && los) { _dbg(`★C304-T reached ore@${orePos.x},${orePos.y},${orePos.z} carved=${carved} step=${step}`); return true; }

            const feet = bot.entity.position.floored();
            const dx = orePos.x - feet.x, dy = orePos.y - feet.y, dz = orePos.z - feet.z;
            // 水平主轴 = 剩余较大的那一维; 都为 0 时靠竖直逼近
            let sx = 0, sz = 0;
            if (Math.abs(dx) >= Math.abs(dz)) { if (dx !== 0) sx = Math.sign(dx); else if (dz !== 0) sz = Math.sign(dz); }
            else { if (dz !== 0) sz = Math.sign(dz); else if (dx !== 0) sx = Math.sign(dx); }
            // 竖直每步至多 ±1, 仅当 |dy|>1 才升降(最后 1 格高差交给 safeDig 的臂展)
            const sy = dy > 1 ? 1 : (dy < -1 ? -1 : 0);
            if (sx === 0 && sz === 0 && sy === 0) return false;      // 已同格却未 reach/LOS → 交 safeDig
            if (sx === 0 && sz === 0 && sy > 0) return false;        // 纯竖直上矿需 pillar(越 reach-gate)→ 交 exclude

            // 先读、后动: 主方向遇水/流体开面/坑道落差时，不再原地 return false。探测左右和后方
            // 三个同层狗腿格，挑【安全 + 未走过 + 仍最靠近目标】的一格立即绕行；下一轮重新朝矿，
            // 自然形成绕过局部障碍后回正的折线。仍不搭桥/不 pillar，四向都危险才安全停手。
            let plan = _corridor(feet, sx, sy, sz);
            let probe = _probeCorridor(plan);
            if (probe.targetAhead && probe.safe) { _dbg(`★C304-T ore-ahead @${plan.nf.x},${plan.nf.y},${plan.nf.z} carved=${carved} step=${step}`); return true; }
            if (!probe.safe) {
                if (detours >= _MAX_DETOURS) {
                    _dbg(`★C304-T stop ${probe.reason} @${plan.nf.x},${plan.nf.y},${plan.nf.z} — detour budget ${detours}/${_MAX_DETOURS}`);
                    return false;
                }
                // 纯竖直逼近没有水平 heading，按当前朝向取一个基准再探四周。
                let hx = sx, hz = sz;
                if (hx === 0 && hz === 0) {
                    hx = -Math.sin(bot.entity.yaw || 0); hz = Math.cos(bot.entity.yaw || 0);
                    if (Math.abs(hx) >= Math.abs(hz)) { hx = Math.sign(hx) || 1; hz = 0; }
                    else { hz = Math.sign(hz) || 1; hx = 0; }
                }
                const verticalOnly = sx === 0 && sz === 0;
                const detourDirs = orderedMiningDetours(hx, hz);
                if (verticalOnly) detourDirs.unshift({ dx: hx, dz: hz, turn: 'forward' }); // 竖直无主方向, 四向都探
                const alternatives = detourDirs.map(d => {
                    const altPlan = _corridor(feet, d.dx, 0, d.dz);  // 绕路保持同层, 不盲跳/盲爬
                    const altProbe = _probeCorridor(altPlan);
                    return { ...d, ...altProbe };
                });
                const picked = verticalOnly
                    ? alternatives.filter(a => a.safe).sort((a, b) => a.score - b.score)[0] || null
                    : selectMiningDetour(hx, hz, alternatives);
                if (!picked) {
                    _dbg(`★C304-T stop ${probe.reason} @${plan.nf.x},${plan.nf.y},${plan.nf.z} — no-safe-detour ${alternatives.map(a => `${a.turn}:${a.reason}`).join(',')}`);
                    return false;
                }
                detours++;
                _dbg(`★C304-T DETOUR ${probe.reason} @${plan.nf.x},${plan.nf.y},${plan.nf.z} → ${picked.turn} ${picked.dx},${picked.dz} via ${picked.plan.nf.x},${picked.plan.nf.y},${picked.plan.nf.z} remain=${picked.score} (${detours}/${_MAX_DETOURS})`);
                plan = picked.plan;
            }
            const { nf, carveList } = plan;

            // 逐块凿开 corridor — safeDig(approach:false)自带 ≤4.6 臂展守卫 + 岩浆/水裁判 + equip
            let opened = true;
            for (const p of carveList) {
                const b = bot.blockAt(p);
                if (isDead(b)) continue;
                if (isOreName(b.name)) { _dbg(`★C304-T ore-ahead @${p.x},${p.y},${p.z} carved=${carved} step=${step}`); return true; }
                const r = await safeDig(bot, b, { approach: false, equip: true, requireLOS: false, maxMs: 9000 });
                if (r === 'fluidguard') { _dbg(`★C304-T stop fluid @${p.x},${p.y},${p.z} carved=${carved}`); return false; }
                if (r !== 'ok' && r !== 'gone') { opened = false; break; }
                if (r === 'ok') carved++;
            }
            if (!opened) { if (++stuck >= 3) { _dbg(`★C304-T stuck carve @${nf.x},${nf.y},${nf.z} carved=${carved}`); return false; } continue; }

            // 步进单格(手控, 不重启寻路以免漫游); 升格则 jump
            const ctr = nf.offset(0.5, 0, 0.5);
            const _st = Date.now(); let moved = false;
            try {
                while (Date.now() - _st < 2500 && !bot.interrupt_code) {
                    const m = bot.entity.position, here = m.floored();
                    if (here.x === nf.x && here.z === nf.z && Math.abs(m.y - nf.y) < 0.6) { moved = true; break; }
                    try { await bot.lookAt(new Vec3(ctr.x, m.y + 1.0, ctr.z), true); } catch (e) {}
                    try { bot.setControlState('forward', true); } catch (e) {}
                    try { bot.setControlState('jump', plan.sy > 0); } catch (e) {}
                    await new Promise(r => setTimeout(r, 90));
                }
            } finally { try { bot.clearControlStates(); } catch (e) {} }
            if (!moved) { if (++stuck >= 3) { _dbg(`★C304-T stuck move → ${nf.x},${nf.y},${nf.z} carved=${carved}`); return false; } }
            else { stuck = 0; visited.add(_key(bot.entity.position.floored())); }
        }
        _dbg(`★C304-T maxSteps ore@${orePos.x},${orePos.y},${orePos.z} carved=${carved}`);
        return false;
    } catch (e) { try { bot.clearControlStates(); } catch (_) {} return false; }
}

// ★perf 2026-07-09: death_log.jsonl grows all session and was re-read+split from disk on EVERY
// collectBlock attempt (dozens per call) via an `await import('fs')` anti-pattern. Cache the last-64
// raw lines on the persistent bot object (~15s TTL, shared across all skills), so the death-zone scan
// costs one read per 15s instead of one per mining attempt. Death zones don't shift within a collect
// call (a death aborts the skill), so staleness is harmless.
function _deathLinesCached(bot) {
    try {
        const now = Date.now();
        const m = bot && bot._deathLinesMemo;
        if (m && now - m.t < 15000) return m.lines;
        let lines = [];
        try { lines = fs_dz.readFileSync('bots/_supervisor/death_log.jsonl', 'utf8').trim().split('\n').slice(-64); } catch (e) {}
        if (bot) bot._deathLinesMemo = { t: now, lines };
        return lines;
    } catch (e) { return []; }
}

const ORE_COLLECT_SPECS = Object.freeze({
    coal: { targets: ['coal'], blocks: ['coal_ore', 'deepslate_coal_ore'], drop: 'coal' },
    diamond: { targets: ['diamond', 'diamonds'], blocks: ['diamond_ore', 'deepslate_diamond_ore'], drop: 'diamond' },
    emerald: { targets: ['emerald'], blocks: ['emerald_ore', 'deepslate_emerald_ore'], drop: 'emerald' },
    iron: { targets: ['iron'], blocks: ['iron_ore', 'deepslate_iron_ore'], drop: 'raw_iron' },
    gold: { targets: ['gold'], blocks: ['gold_ore', 'deepslate_gold_ore'], drop: 'raw_gold' },
    lapis: { targets: ['lapis', 'lapis_lazuli'], blocks: ['lapis_ore', 'deepslate_lapis_ore'], drop: 'lapis_lazuli' },
    redstone: { targets: ['redstone'], blocks: ['redstone_ore', 'deepslate_redstone_ore'], drop: 'redstone' },
    copper: { targets: ['copper'], blocks: ['copper_ore', 'deepslate_copper_ore'], drop: 'raw_copper' },
    quartz: { targets: ['quartz'], blocks: ['nether_quartz_ore'], drop: 'quartz' },
});

function oreCollectSpec(blockType) {
    const requested = String(blockType || '');
    return Object.values(ORE_COLLECT_SPECS).find((spec) =>
        spec.targets.includes(requested) || spec.blocks.includes(requested)) || null;
}

export function collectDropItemName(blockType) {
    return oreCollectSpec(blockType)?.drop || blockType;
}

export function collectOreBlockTypes(blockType) {
    const spec = oreCollectSpec(blockType);
    return spec ? [...spec.blocks] : [blockType];
}

export async function collectBlock(bot, blockType, num=1, exclude=null, veinFollow='auto') {
    /**
     * Collect one of the given block type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to collect.
     * @param {number} num, the number of blocks to collect. Defaults to 1.
     * @param {list} exclude, a list of positions to exclude from the search. Defaults to null.
     * @param {boolean|string} veinFollow, when collecting an ORE, exhaust the whole
     *   connected vein once one block is found (so we never leave residual ore and
     *   pick up a natural buffer). 'auto' (default) = on for *_ore families, off for
     *   everything else (logs, stone, dirt…); pass true/false to force.
     * @returns {Promise<boolean>} true if the block was collected, false if the block type was not found.
     * @example
     * await skills.collectBlock(bot, "oak_log");
     **/
    if (num < 1) {
        log(bot, `Invalid number of blocks to collect: ${num}.`);
        return false;
    }
    const oreSpec = oreCollectSpec(blockType);
    let blocktypes = collectOreBlockTypes(blockType);
    if (blockType === 'dirt')
        blocktypes.push('grass_block');
    if (blockType === 'cobblestone')
        blocktypes.push('stone');
    const isLiquid = blockType === 'lava' || blockType === 'water';
    // ★HARVESTABILITY GATE: digging a pick-requiring block bare-handed drops NOTHING,
    // so "collect stone with no pickaxe" is a dead plan that wastes minutes per block
    // (the BARE-HAND STONE DIG alarm caught achieve's collect-stone loop punching its
    // own feet at 0/3 forever). Fail FAST so the caller pivots (e.g. get wood → craft
    // a pick) instead of grinding a guaranteed-zero path.
    const PICK_REQ = /stone|deepslate|andesite|diorite|granite|tuff|_ore$|obsidian|cobble|^iron_|^copper_|^gold_/;
    // `some`, not `every`: collectBlock('coal') searches ['coal','coal_ore',...] and the
    // ITEM name 'coal' doesn't match the block regex — `every` let the gate pass and the
    // bot punched a coal vein bare-handed (zero drops). Any pick-requiring member in the
    // search set means the dig itself needs a pick.
    if (!isLiquid && blocktypes.some(n => PICK_REQ.test(n))
        && !bot.inventory.items().some(i => /_pickaxe$/.test(i.name))) {
        log(bot, `Cannot collect ${blockType} bare-handed (drops nothing without a pickaxe) — get/craft a pickaxe first.`);
        return false;
    }
    // Vein-follow only makes sense for ores (you don't want to chain-mine every
    // nearby stone/dirt/log). Keep the generic *_ore fallback for modded/unlisted
    // ores while the known specs above supply exact block-family/drop mappings.
    const veinActive = !isLiquid && (veinFollow === true
        || (veinFollow === 'auto' && (!!oreSpec || blocktypes.some(n => n.endsWith('_ore')))));

    // ★TRUTHFUL COUNT (root fix for "Collected 4 oak_log 但空包"): `collected` below counts
    // blocks BROKEN, not drops actually vacuumed. A log broken over water floats off and
    // `pickupNearbyItems` never catches it — yet the old code still logged "Collected N" and
    // returned true, so endGoal / getWood judged the mission DONE on a phantom haul. We now
    // also track the real inventory delta of the drop item and report/return on THAT.
    // Ores that pick up as a differently-named item drop need the mapping (iron→raw_iron …);
    // everything else drops as its own block name.
    const dropItem = collectDropItemName(blockType);
    const gainOf = () => bot.inventory.items()
        .filter(i => i.name === dropItem || i.name === blockType)
        .reduce((a, i) => a + i.count, 0);
    const baseGain = gainOf();

    let collected = 0;
    // ★C304-T: cap sealed-tunnel-to-ore attempts per collectBlock call so a pathological
    //  string of buried candidates can't run the 25s tunnel back-to-back for minutes.
    let _tunnelTries = 0;
    const _TUNNEL_MAX_TRIES = 4;

    // ★TARGET STICKINESS (2026-07-09 用户令"同类复用"): 根治 obsidian/collectBlocks "原地乱跳" —
    //   admin 挖黑曜石走 LLM 自驱 `!collectBlocks("obsidian",N)`, 每回合重发一次 collectBlock,
    //   每次重挑【最近的一块】当目标 → 目标坐标每 ~0.8s 漂一格 (mine_motion 实录 goal z 364→360),
    //   新 goToPosition 把上一回合在途导航掐断 ("The goal was changed before it could be completed!"),
    //   身体钉死原地只剩 step-edge/jump 微控制抖动。修: 把上次锁定的目标块记在 bot 上, 同 bot 同类
    //   采集只要那块【仍存在/同类/未挖掉/未 exclude/非雷区/非刷怪笼】就复用它当首选目标, 一条路走到底;
    //   挖掉/gone/证不可达即清, 下轮重挑并重新粘住。跨 collectBlock 调用持久 = 堵住回合间的目标 churn。
    const _stickyKey = blocktypes.join('|');
    if (!bot._collectSticky || bot._collectSticky.key !== _stickyKey) {
        // 换了采集类型 → 旧粘滞作废 (别把上一目标误带进新类型)
        if (bot._collectSticky && bot._collectSticky.key !== _stickyKey) bot._collectSticky = null;
    }

    const movements = new pf.Movements(bot);
    movements.dontMineUnderFallingBlock = false;
    movements.dontCreateFlow = true;
    // ★COLLECT-TARGET UN-HARDEN (根因: "收起工作台永远收不了"): pf.Movements 被全局换成 _NoScaffold
    //   Movements + hardenMovements, 把 crafting_table/furnace/chest/barrel/床 塞进 blocksCantBreak —
    //   那是为了【赶路时】别顺手拆自己的站台。但本函数是【显式采集】: 下面 1447 行用 movements.safeToBreak
    //   当扫描候选过滤器, safeToBreak 对 blocksCantBreak 里的方块返回 false → 目标被剔出候选 → 报
    //   "No crafting_table nearby to collect" 一镐没抡就 false (searchForBlock/nearbyBlocks 却都看得见,
    //   因为它们不走 safeToBreak)。这里把本次要采的类型从黑名单摘掉解闸; 可达/流体/LOS 安全仍由 safeDig 兜底。
    try {
        for (const n of blocktypes) {
            const bid = mc.getBlockId(n);
            if (bid != null && movements.blocksCantBreak instanceof Set) movements.blocksCantBreak.delete(bid);
        }
    } catch (e) {}
    // ★RAVINE DISCIPLINE (deaths 196/197 — both "fall" mid-iron-grind; filmstrip shows a
    // huge ravine/mineshaft complex with the ore embedded in cliff walls): the default
    // maxDropDown=4 lets the pathfinder descend cliffs via chained 4-block hops — at
    // armor0 that's cumulative chip damage and ONE mis-evaluated landing from death.
    // ★C281: 2→3. A 3-block drop deals ZERO fall damage (damage only past 3 blocks), so the
    // bot can step/hop down small ledges/slopes instead of freezing at the top of every
    // minor drop (用户实拍:站斜坡顶不肯下跳够不到下方的树). 3 keeps the ravine chip-death
    // discipline (4-hop chains still blocked) while honoring "落差不大就该允许跳下".
    movements.maxDropDown = 3;

    // Enable water movement for collectBlock — but ONLY near the surface. Underground
    // (y<55) the pathfinder happily routes through flooded aquifer tunnels; with a sealed
    // ceiling overhead the drowning-escape reflex can't chew through rock in time (death
    // 200: drowning y47, coveredAbove 8, no mobs — the recurring deep-water bucket).
    // Surface swims (rivers/shores) stay enabled: open air above, the swim reflex works.
    if (bot.entity.position.y >= 55) {
        movements.liquids.add(mc.getBlockId('water'));
        movements.liquids.add(mc.getBlockId('flowing_water'));
    }

    // Blocks to ignore safety for, usually next to lava/water
    const unsafeBlocks = ['obsidian'];

    // ★C304 (T-0035) HUMAN-LIKE ORE REACH — "只在可触达范围内碰矿".
    // The nearest ore by straight-line can sit ACROSS an air gap / behind a thin wall the bot
    // is standing on. safeDig only gates on raw eye→block distance (≤4.6), so when such an ore
    // is within 4.6 the approach branch is skipped and bot.dig swings straight THROUGH the gap —
    // x-ray-like "隔着峡谷够对面铜矿" (用户实拍:站墙头挖对面矿). A human only mines ore it can
    // actually WALK/dig up to. Gate: for ORE targets, require a real SHORT path to a cell adjacent
    // to the block. canDig=true (digging TOWARD a buried vein is legit mining) but NO scaffolding
    // (scafoldingBlocks=[]) and no pillaring — so the bot can't "bridge" across an air gap to reach
    // far ore. "短" = node count bounded vs straight-line distance: a buried-adjacent vein is a few
    // dig-nodes (passes); an across-ravine detour is dozens (rejected). Ore-only & cheap: one bounded
    // pathfind on the candidate we'd otherwise mine, skipped entirely for logs/dirt/stone.
    const reachMoves = new pf.Movements(bot);
    reachMoves.dontMineUnderFallingBlock = false;
    reachMoves.dontCreateFlow = true;
    reachMoves.canDig = true;            // mining toward a buried vein is legitimate
    reachMoves.scafoldingBlocks = [];    // but NEVER bridge across air gaps to reach ore
    reachMoves.allow1by1towers = false;  // nor pillar up to a high cliff-face ore
    reachMoves.maxDropDown = 3;
    // ★C304 DBG: persistent one-liner per ore reach-decision so the gate is observable in-game
    // (mirrors chopDBG — bot.output only reaches the LLM, never a file). Cheap: ore-only.
    const _mineDBG = (m) => appendTelemetry('mine_dbg.log', `[${new Date().toISOString()}] ${m}\n`, { json: false });
    // ★C304-V (2026-07-08 途径铁不挖根治): the partial/no-path REJECTs below are the false-reject
    // engine — a buried-through-stone vein makes the 2000ms canDig A* time out as 'partial' with
    // little progress (or occasionally noPath), so the timed-A* verdict is a coin-flip on server
    // tick/chunk load, NOT on geometry (实测同一矿同距离一次REJECT一次OK). Disambiguate on GEOMETRY:
    // voxel-walk the straight line eye→ore-center and classify intermediate cells solid vs open.
    // BURIED vein = line is (near-)solid stone → A* only stalled on slow digging → ACCEPT. Ore ACROSS
    // an air gap / ravine (the x-ray case C1 must reject) = line crosses a long contiguous OPEN run
    // → REJECT. Distance-capped so we never commit to an absurdly deep single ore. Cheap (~a dozen
    // blockAt, no 2nd pathfind → keeps C9). Downstream C337 LOS + ≤4.6 reach still gate the real dig,
    // so accepting a buried vein here can NEVER x-ray — it only lets the bot TUNNEL toward it.
    // ★C304-W (2026-07-08 用户定调"主要是要允许挖石头开路"): 12 格上限 + 无差别 open-run 把
    // "远处包石矿"和"头顶矿井壁上的矿"全打成不可达 (15:36 实录 8 候选全拒→原地空转, 其中
    // iron@-100,59,292 头顶 16 格, 凿几步楼梯就够到)。石头挡路就该挖开 — 横向凿隧道、向上
    // 凿楼梯都是合法开路; 真正要拒的只剩"横跨峡谷空隙"的 x-ray 几何 (C1)。两刀:
    //   ① 上限 12→24: "远"≠"不可达", 挖得动就挖 (下游 C337 LOS+≤4.6 仍锁真实挥镐, 不会x-ray)。
    //   ② open-run 只对【平缓视线】判 gap: 视线陡 (|dy|≥dist*0.55, 头顶/脚下矿井的空气柱) 时,
    //      空气是可以凿楼梯绕上/下去的, 不是沟 — 不再当 gap 拒。
    const _BURIED_MAX_D3 = 24;          // straight-line commit cap (dig-open-a-path is allowed; farther veins belong to branchMine/mineDown)
    const _BURIED_MAX_OPEN_RUN = 1;     // ≥2 contiguous open cells on a SHALLOW line = a real horizontal gap → REJECT (true buried vein reads maxRun=0)
    const _lineBuried = (eye, center, d3) => {
        try {
            if (d3 > _BURIED_MAX_D3) return { ok: false, why: `too-deep d3=${d3.toFixed(1)}>${_BURIED_MAX_D3}` };
            const vx = center.x - eye.x, vy = center.y - eye.y, vz = center.z - eye.z;
            const dist = Math.sqrt(vx * vx + vy * vy + vz * vz);
            if (dist < 1.001) return { ok: true, why: 'adjacent' };   // right next to bot — C337 handles it
            const oreCell = center.floored();
            const oreKey = `${oreCell.x},${oreCell.y},${oreCell.z}`;
            const steps = Math.ceil(dist / 0.3);
            let last = null, n = 0, openN = 0, run = 0, maxRun = 0;
            for (let s = 1; s < steps; s++) {
                const t = s / steps;
                const p = eye.offset(vx * t, vy * t, vz * t);
                if (p.distanceTo(eye) < 1.6) continue;                // skip bot's own body / tunnel-mouth
                const cell = p.floored();
                const key = `${cell.x},${cell.y},${cell.z}`;
                if (key === last) continue;
                last = key;
                if (key === oreKey) continue;                         // the ore's own voxel is solid by definition
                n++;
                const b = bot.blockAt(cell);
                // ★C304-W 补刀: 线上有岩浆 = 朝岩浆凿 → 直接拒, steep-carve 也不豁免 (放宽 open-run
                // 之前岩浆柱会碰巧被当 gap 拒掉, 放宽后必须显式挡)。
                if (b && /lava/.test(b.name)) return { ok: false, why: `lava-on-line@${cell.x},${cell.y},${cell.z}` };
                const isOpen = !b || b.boundingBox === 'empty';       // air/cave_air/water all 'empty'
                if (isOpen) { openN++; run++; if (run > maxRun) maxRun = run; } else run = 0;
            }
            // steep line = the open cells are shaft/pit air above or below — stair-carvable, not a gap
            const steep = Math.abs(vy) >= dist * 0.55;
            return { ok: steep || (maxRun <= _BURIED_MAX_OPEN_RUN), why: `n=${n} open=${openN} maxRun=${maxRun}${steep ? ' steep-carve' : ''}` };
        } catch (e) { return { ok: true, why: 'voxel-err(fail-open)' }; }   // C7: never hard-block on internal error
    };
    const _oreReachable = async (cand) => {
        try {
            const bp = cand.position;
            const eye = bot.entity.position.offset(0, 1.62, 0);
            const d3 = eye.distanceTo(bp.offset(0.5, 0.5, 0.5));
            const goal = new pf.goals.GoalNear(bp.x, bp.y, bp.z, 2);
            // ★2026-07-06 决胜修 (00:27 实录 iron@4.8格 REJECT partial): 穿石挖掘路径 800ms
            //   算不完 → 'partial' → 全部包石矿被拒, 只剩怪窝裸露矿可挖 = 通宵"贴矿采空"元凶。
            //   预算 800→2000ms; partial 且终点有实质接近(<60% 原距)=在朝矿挖(非隔沟), 放行。
            const res = await bot.pathfinder.getPathTo(reachMoves, goal, 2000);
            const st = res ? res.status : 'null';
            if (!res || (res.status !== 'success' && res.status !== 'partial')) {
                const bur = _lineBuried(eye, bp.offset(0.5, 0.5, 0.5), d3);
                _mineDBG(`★C304 ${cand.name}@${bp.x},${bp.y},${bp.z} d3=${d3.toFixed(1)} status=${st} → voxel ${bur.ok ? 'OK buried' : 'REJECT gap/deep'} (${bur.why})`);
                return bur.ok;
            }
            if (res.status === 'partial') {
                let remain = Infinity;
                try {
                    const pp = res.path && res.path.length ? res.path[res.path.length - 1] : null;
                    if (pp) remain = Math.hypot(pp.x - bp.x, pp.y - bp.y, pp.z - bp.z);
                } catch (e) {}
                if (!(remain < d3 * 0.6)) {
                    const bur = _lineBuried(eye, bp.offset(0.5, 0.5, 0.5), d3);
                    _mineDBG(`★C304 ${cand.name}@${bp.x},${bp.y},${bp.z} d3=${d3.toFixed(1)} partial remain=${Number.isFinite(remain) ? remain.toFixed(1) : '?'} → voxel ${bur.ok ? 'OK buried' : 'REJECT gap/deep'} (${bur.why})`);
                    return bur.ok;
                }
                _mineDBG(`★C304 ${cand.name}@${bp.x},${bp.y},${bp.z} d3=${d3.toFixed(1)} OK partial-progress (remain=${remain.toFixed(1)})`);
                return true;
            }
            const len = (res.path && res.path.length) || 0;
            // generous slack so legit travel-to-ore / dig-to-vein isn't rejected; only the
            // wildly-longer-than-straight-line detours (gaps/ravines/walls) blow the budget.
            const budget = Math.max(8, Math.ceil(d3 * 2.5));
            const ok = len <= budget;
            _mineDBG(`★C304 ${cand.name}@${bp.x},${bp.y},${bp.z} d3=${d3.toFixed(1)} len=${len} budget=${budget} ${ok ? 'OK' : 'REJECT(detour too long)'}`);
            return ok;
        } catch (e) { return true; }   // on pathfinder error, don't over-block (fail open)
    };

    // Bound the work: normally `num` finds, but vein-follow can satisfy `num` in
    // fewer outer iterations (and may overshoot a little — desired for ores), so
    // loop on `collected < num` with an attempt cap to avoid spinning on
    // unreachable targets.
    const maxAttempts = num * 4 + 8;
    for (let i=0; i<maxAttempts && collected < num; i++) {
        // ★死亡区矿物不可见 (242/243/244 17分钟三连死: 蜂窝雷区裸露矿脉是x-ray磁铁 —
        // 采集选target吸进去,避区撤退推出来,两逻辑打架死在往返路上。修在源头: 聚集区内
        // 的方块从候选里消失)。零开销缓存: 每次collect调用读一次death_log近50条,预算
        // 出"16格内有2+邻死"的雷点,谓词里拒绝雷点14格内的目标。
        let _dzones = [];
        try {
            const _dlraw = _deathLinesCached(bot).slice(-50);
            const _dpts = _dlraw.map(l => { try { const r = JSON.parse(l); return (typeof r.x === 'number') ? r : null; } catch (e) { return null; } }).filter(Boolean);
            _dzones = _dpts.filter(p => _dpts.filter(q => q !== p && Math.hypot(q.x - p.x, q.z - p.z) < 16).length >= 2);
        } catch (e) {}
        // ★2026-07-06 三维化: 2D 盲区把地表死亡正下方 27 格的矿整列拉黑 (出生区死亡密集
        //   → 出生区地下铁全部"不可见", 05:08 三振实录)。地表的死与深处的矿无关: |dy|<=12 才算。
        const _inDeathZone = (p) => _dzones.some(z => Math.hypot(z.x - p.x, z.z - p.z) < 14
            && Math.abs((typeof z.y === 'number' ? z.y : p.y) - p.y) <= 12);
        // ★C304-S (2026-07-08 用户定调"周围有怪房间最好别挖"): 刷怪笼 10 格内的矿候选直接不可见 —
        // 主动绕开地牢/废弃矿井刷怪房, 不再只靠死后 _inDeathZone 事后学。稀有方块扫描由
        // block-scan Worker 执行；扫描失败 fail-open (照旧, 交给实时威胁本能兜底)。
        let _spawners = [];
        try {
            const _spId = mc.getBlockId('spawner');
            if (_spId != null) _spawners = (await world.getNearestBlocksWhereAsync(bot, _spId, 128, 8)).map(b => b.position);
        } catch (e) { _spawners = []; }
        const _nearSpawner = (p) => _spawners.some(s => Math.hypot(s.x - p.x, s.y - p.y, s.z - p.z) < 10);

        // The scan + per-block predicate (incl. pathfinder's safeToBreak, which walks
        // neighbour blocks) can null-deref inside dependency code — that throw used to
        // escape collectBlock entirely and kill the caller's whole collect loop (seen
        // live: "collect iron_ore: Cannot read properties of null (reading 'x')" every
        // cycle). Guard per-block (skip the offending block) and around the scan.
        let blocks = [];
        try {
            // ★2026-07-06 session#7 满视距 ELOOP 修: 原先 getNearestBlocksWhere 在 64b 八面体上对每个
            //   命中格跑昂贵谓词(safeToBreak 要走邻块检查 + _inDeathZone + exclude), 且外层 maxAttempts
            //   每轮重扫 — 探针实录 act=chopWood other≈670ms(视距相关: 满视距下 64b 内加载 section 多 →
            //   全扫 + 每格 safeToBreak = 事件循环长冻)。
            //   修: 两段扫。① 先在 Worker 按方块 state ID 快扫(无 safeToBreak)
            //   拿最近的一批候选位置(取 count 的宽松倍数, 保证过滤后仍够); ② 只对这一小批候选跑昂贵谓词
            //   (safeToBreak/deathzone/exclude/液体源)。语义等价(同 64b 半径、同最终判据、同排序), 但把
            //   O(八面体×safeToBreak) 降成 O(八面体×廉价类型判) + O(少量候选×safeToBreak)。
            const _want = veinActive ? 8 : 1;
            const _ids = [];
            try { for (const n of blocktypes) { const bid = mc.getBlockId(n); if (bid != null) _ids.push(bid); } } catch (e) {}
            // ① 廉价类型快扫(候选取 max(64, want*8), 给 ② 的过滤留足冗余; 稀有目标时上限自然收敛)。
            let _cands = [];
            if (_ids.length) {
                try { _cands = (await world.getNearestBlocksWhereAsync(bot, _ids, 128, Math.max(64, _want * 8))).map(b => b.position); } catch (e) { _cands = []; }
            }
            // ② 对候选(已按距排序)跑昂贵谓词, 收满 want 即停 — safeToBreak 只在少量候选上求值。
            for (const _pos of _cands) {
                await new Promise(resolve => setImmediate(resolve));
                if (blocks.length >= _want) break;
                const block = bot.blockAt(_pos);
                try {
                    if (!block || !block.position || !blocktypes.includes(block.name)) continue;
                    if (_inDeathZone(block.position)) continue;   // 雷区矿物不可见
                    if (_nearSpawner(block.position)) continue;   // ★C304-S 刷怪笼房间的矿不碰
                    if (exclude) {
                        let _ex = false;
                        for (let position of exclude) {
                            if (block.position.x === position.x && block.position.y === position.y && block.position.z === position.z) { _ex = true; break; }
                        }
                        if (_ex) continue;
                    }
                    if (isLiquid) { if (block.metadata === 0) blocks.push(block); continue; }   // 液体只收源块
                    if (movements.safeToBreak(block) || unsafeBlocks.includes(block.name)) blocks.push(block);
                } catch (e) { continue; }
            }
        } catch (err) {
            const frame = (err.stack || '').split('\n')[1] || '';
            log(bot, `⚠️ ${blockType} scan failed: ${err}.${frame ? ' @' + frame.trim() : ''} — retrying next pass.`);
            await new Promise(r => setTimeout(r, 1000));
            continue;
        }

        if (blocks.length === 0) {
            // ★RAW-NEAREST FALLBACK (2026-07-09): findBlocks 的类型快扫偶尔吐空集 —— 半空/孤立的
            //   单块(门框黑曜石就是活例: y63 半空, 脚下邻格是空气/门, chunk 追踪时序一飘就漏)会
            //   被扫空, 于是 admin「挖最近黑曜石」每回合 collectBlocks 报"无附近", 逼 LLM 手写
            //   newAction(world.getNearestBlock + bot.dig)兜底才挖得到。这里在放弃前先用裸最近扫描
            //   (无 safeToBreak/findBlocks 时序依赖)在近距内兜一块: 够得到就走 safeDig(approach→
            //   reach→dig, 与手写 newAction 等价), 省掉 LLM 兜底。死区/刷怪笼/exclude/工具仍守。
            let _raw = null;
            for (const n of blocktypes) {
                try { const b = await world.getNearestBlockAsync(bot, n, 8); if (b && b.position) { _raw = b; break; } } catch (e) {}
            }
            if (_raw && collected < num) {
                const _p = _raw.position;
                const _exd = exclude && exclude.some(q => q.x === _p.x && q.y === _p.y && q.z === _p.z);
                if (!_exd && !_inDeathZone(_p) && !_nearSpawner(_p) && !isLiquid) {
                    log(bot, `↪ scan empty but ${_raw.name}@${_p.x},${_p.y},${_p.z} within reach — direct-dig fallback.`);
                    try {
                        await bot.tool.equipForBlock(_raw);
                        const _id = bot.heldItem ? bot.heldItem.type : null;
                        if (!_raw.canHarvest(_id)) {
                            log(bot, `Don't have right tools to harvest ${_raw.name} — need a better pickaxe.`);
                            break;
                        }
                        const r = await safeDig(bot, _raw, { maxMs: 15000, equip: false, requireLOS: false });
                        if (r === 'ok') {
                            try { await goToPosition(bot, _p.x, _p.y, _p.z, 1); } catch (e) {}
                            await pickupNearbyItems(bot);
                            collected++;
                            bot._collectSticky = null;
                            continue;   // 挖掉一块 → 重扫; 下一块最近的自然进候选或裸兜底, maxAttempts 收口
                        }
                        log(bot, `⚠️ direct-dig fallback ${_raw.name} → ${r}; give up scan.`);
                    } catch (e) { log(bot, `direct-dig fallback err: ${e.message}`); }
                    break;
                }
            }
            if (collected === 0)
                log(bot, `No ${blockType} nearby to collect.`);
            else
                log(bot, `No more ${blockType} nearby to collect.`);
            break;
        }
        // ★树列归一 (2026-07-08, 用户定调"树根/树冠就近一个为目标"): findBlocks 常只吐出树冠 (y≈75+)
        //   的上层 log, _oreReachable 的 GoalNear 便瞄向半空的树冠 → 裸手 bot 站地面够不到 (remain≈6)
        //   → 假判 "across gap/wall" → 整树被拒 → relocate 盲冲 landbias sprint → ★IN-WATER 冲海.
        //   修: 每个 log 候选沿其竖直列展开 (root..canopy), 取离 bot 最近的一块当目标. 地面自然落到树根
        //   (y=68 可走), 站高处则落树冠. 只动 log 家族; 矿/土/石候选原样 (some(_isLog)=false 时整段跳过).
        const _isLog = (n) => /(?:_log|_stem|_wood|_hyphae)$/.test(n || '');
        if (blocks.some(b => b && _isLog(b.name))) {
            const _nearestInColumn = (blk) => {
                let base = blk.position;
                for (let i = 0; i < 24; i++) {                       // 下沉到列底 (树高上限 ~24)
                    const b = bot.blockAt(base.offset(0, -1, 0));
                    if (b && _isLog(b.name)) base = b.position; else break;
                }
                let best = bot.blockAt(base);
                if (!best) return blk;
                let bestD = bot.entity.position.distanceTo(base.offset(0.5, 0.5, 0.5));
                let p = base;
                for (let i = 0; i < 24; i++) {                       // 自底向上, 记离 bot 最近的一块
                    const b = bot.blockAt(p.offset(0, 1, 0));
                    if (!b || !_isLog(b.name)) break;
                    const d = bot.entity.position.distanceTo(b.position.offset(0.5, 0.5, 0.5));
                    if (d < bestD) { bestD = d; best = b; }
                    p = b.position;
                }
                return best;
            };
            const seen = new Set(), remapped = [];
            for (const blk of blocks) {
                const t = (blk && _isLog(blk.name)) ? _nearestInColumn(blk) : blk;
                if (!t || !t.position) continue;
                const k = `${t.position.x},${t.position.y},${t.position.z}`;
                if (seen.has(k)) continue;
                seen.add(k); remapped.push(t);
            }
            remapped.sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position));
            if (remapped.length) blocks = remapped;
        }
        // ★TARGET STICKINESS 前置: 上次锁定的目标块若仍有效, 提到候选队首 → 下面 blocks[0] /
        //   vein 选择自然复用它, 不再每 pass 重挑最近 (堵回合间 goal churn)。仍有效判据: 该坐标
        //   仍是本次要采的同类方块, 且不在死区/刷怪笼/exclude 名单。失效 → 立即清粘滞, 走常规最近。
        if (bot._collectSticky && bot._collectSticky.key === _stickyKey && bot._collectSticky.pos) {
            const _sp = bot._collectSticky.pos;
            const _sv = new Vec3(_sp.x, _sp.y, _sp.z);
            const _sb = bot.blockAt(_sv);
            const _excluded = exclude && exclude.some(p => p.x === _sp.x && p.y === _sp.y && p.z === _sp.z);
            const _stillValid = _sb && blocktypes.includes(_sb.name)
                && !_inDeathZone(_sv) && !_nearSpawner(_sv) && !_excluded;
            if (_stillValid) {
                blocks = [_sb, ...blocks.filter(b => !(b.position.x === _sp.x && b.position.y === _sp.y && b.position.z === _sp.z))];
            } else {
                bot._collectSticky = null;   // 目标没了/被排除/换区 → 松手, 重挑
            }
        }
        // ★C304 ORE: pick the nearest candidate that is genuinely reachable via a short walk/dig
        // path (no bridging across gaps). Skip+exclude unreachable ones so we don't lock onto — and
        // x-ray-mine through — an ore across a ravine/wall. Non-ore (logs/dirt/stone) unchanged: nearest.
        let block;
        if (veinActive) {
            block = null;
            let _checked = 0;
            for (const cand of blocks) {
                if (_checked >= 4) break;   // bound pathfinds/pass; exclude grows so we probe outward next pass
                _checked++;
                if (await _oreReachable(cand)) { block = cand; break; }
                exclude = exclude || [];
                exclude.push(cand.position);
                log(bot, `↪ ${cand.name}@${cand.position.x},${cand.position.y},${cand.position.z} no short reach-path (across gap/wall) — skip, not mining through.`);
            }
            if (!block) {
                log(bot, `No reachable ${blockType} (nearest candidates all across gaps / behind walls) — not x-ray-mining.`);
                _mineDBG(`★C304 pass: ${blocktypes.join('/')} — ${blocks.length} cand all unreachable (collected=${collected}) → ${collected > 0 ? 'stop' : 'reprobe'}`);
                if (collected > 0) break;
                // nothing reachable yet; let exclude-driven outward probing try again next pass
                await new Promise(r => setTimeout(r, 300));
                continue;
            }
        } else {
            block = blocks[0];
        }
        // ★TARGET STICKINESS 记账: 锁定本轮目标, 下一次 collectBlock(同类)优先复用它 → 目标恒定,
        //   goToPosition 一条路走到底不被回合重发打断。挖掉(success)/gone/证不可达时下面清。
        if (block && block.position)
            bot._collectSticky = { key: _stickyKey, pos: { x: block.position.x, y: block.position.y, z: block.position.z }, ts: Date.now() };
        try {
        await bot.tool.equipForBlock(block);
        // ★Never harvest WOOD with a SWORD (chops slowly + burns the sword durability we need
        // for combat). equipForBlock leaves a combat-equipped sword in hand when we have no axe
        // → the bot "用木剑砍树". For logs/wood, if we're holding a sword and have no axe, drop
        // to BARE HAND (same speed on wood, saves the sword).
        if (/_log$|_wood$|_stem$|_hyphae$/.test(block.name) && bot.heldItem && /_sword$/.test(bot.heldItem.name)
            && !bot.inventory.items().some(i => /_axe$/.test(i.name))) {
            try { await bot.unequip('hand'); } catch (e) {}
        }
        if (isLiquid) {
            const bucket = bot.inventory.findInventoryItem('bucket');
            if (!bucket) {
                log(bot, `Don't have bucket to harvest ${blockType}.`);
                return false;
            }
            await bot.equip(bucket, 'hand');
        }
        const itemId = bot.heldItem ? bot.heldItem.type : null
        if (!block.canHarvest(itemId)) {
            log(bot, `Don't have right tools to harvest ${blockType}.`);
            return false;
        }
            let success = false;
            if (isLiquid) {
                success = await useToolOnBlock(bot, 'bucket', block);
            }
            else {
                // ★HUMAN-LIKE HARVEST for ALL solid blocks (logs/stone/dirt/ores/crops). ROOT FIX
                // for "天天空挥": the old code routed the common targets (wood/stone/ore — what we
                // mine MOST; mustCollectManually is only true for crops/torches/vines) through
                // `bot.collectBlock.collect` (mineflayer-collectblock plugin), which in jungle
                // terrain pathfinds toward a block it never actually reaches and then SWINGS AT
                // AIR. A human just walks adjacent, looks at the block, breaks it, and moves on if
                // it won't break. So for EVERY block: path to within 2, VERIFY reach (≤4.6), then
                // a bounded 10s dig; skip+exclude anything we can't reach or can't break (no more
                // swinging at air, no re-locking the same unreachable target). The flaky plugin
                // path is removed entirely.
                // ★Break via the unified safeDig primitive (reach-guard + bounded dig +
                // stopDigging all live there). equip:false — we already equipped + ran the
                // sword-guard above (537-545). 15s backstop covers the slowest legit break
                // (obsidian ~9.4s w/ diamond pick, for the nether portal) with margin.
                exclude = exclude || [];
                // ★C337 (T-0035 reopen): require line-of-sight for ORE so we never x-ray-grab ore
                // through a wall (the C304 path-exists gate selected it, but distToBlock<=4.6 alone
                // let it reach through solid rock). Non-ore (logs/stone/dirt) dig as before.
                const _isOre = /_ore$/.test(block.name || '');
                const gainBeforeDig = gainOf();
                let r = await safeDig(bot, block, { maxMs: 15000, equip: false, pickup: _isOre, requireLOS: _isOre });
                // ★C304-T (2026-07-09 "凿隧道直达"): 埋铁被 safeDig 判 unreachable/occluded 时不再直接
                //  exclude 放弃整条矿脉 — 先朝它凿一条密封隧道(防坠/防淹/防x-ray, 任一不安全即停),
                //  逼近到臂展再重试一次 safeDig(requireLOS 仍锁, 绝不 x-ray)。隧道失败=旧行为 exclude。
                if (_isOre && (r === 'unreachable' || r === 'occluded') && _tunnelTries < _TUNNEL_MAX_TRIES) {
                    _tunnelTries++;
                    if (await tunnelToOre(bot, block))
                        r = await safeDig(bot, block, { maxMs: 15000, equip: false, pickup: true, requireLOS: true });
                }
                if (r === 'ok') {
                    // ★Actually COLLECT the drop (fixes "挖了树不捡木头"): step ONTO the broken
                    // block's spot via a dig-capable path so mineflayer auto-vacuums the item,
                    // THEN sweep any stragglers (drops land a couple blocks off through leaves/vines).
                    if (gainOf() === gainBeforeDig) {
                        try { await goToPosition(bot, block.position.x, block.position.y, block.position.z, 1); } catch (e) {}
                        try { await ensurePickupAt(bot, block.position, { radius: 6, maxDescend: 3, timeoutMs: 6000 }); } catch (e) {}
                    }
                    // ★WATER-DRIFT SWEEP: a drop broken next to water floats and drifts out of the
                    // first pickup's reach (root cause of the -79,168 lakeside chop that logged 4
                    // logs but banked 0). If the drop item still didn't land, chase once wider.
                    if (gainOf() === gainBeforeDig) {
                        try { await pickupNearbyItems(bot, 12); } catch (e) {}
                    }
                    success = true;
                    bot._collectSticky = null;   // ★挖到了 → 松手, 下轮粘住下一块最近的
                } else if (r === 'gone') {
                    bot._collectSticky = null;   // ★目标消失 → 松手重挑
                    continue; // vanished before we dug — move on
                } else {
                    log(bot, `⚠️ ${block.name} ${r} — skip+exclude, next.`);
                    exclude.push(block.position);
                    bot._collectSticky = null;   // ★证不可达/挖不动 → 松手, 别再粘同一块
                    continue;
                }
            }
            if (success) {
                collected++;
                // Exhaust the rest of this connected ore vein so we never leave
                // remnants behind (and gather a natural buffer beyond `num`).
                if (veinActive)
                    collected += await harvestConnectedVein(bot, block.position, blocktypes);
            }
            await autoLight(bot);
        }
        catch (err) {
            if (err.name === 'NoChests') {
                log(bot, `Failed to collect ${blockType}: Inventory full, no place to deposit.`);
                break;
            }
            else if (err.name === 'PathfindingFailed' || (err.message && err.message.includes('path'))) {
                log(bot, `⚠️ Cannot reach ${blockType} - pathfinding failed. Trying next block or consider changing target.`);
                continue;
            }
            else {
                // include the top stack frame so a null-deref inside a dependency
                // (tool plugin / pathfinder / canHarvest) is locatable from the log
                const frame = (err.stack || '').split('\n')[1] || '';
                log(bot, `Failed to collect ${blockType}: ${err}.${frame ? ' @' + frame.trim() : ''}`);
                continue;
            }
        }
        
        if (bot.interrupt_code)
            break;  
    }
    // ★Report/judge on the REAL inventory delta, not the broken-block count. `collected`
    // (blocks broken) stays the loop's own accounting; `gained` is what actually banked.
    const gained = gainOf() - baseGain;
    if (gained < collected)
        log(bot, `Collected ${gained} ${blockType}. (broke ${collected}; ${collected - gained} drop(s) lost — floated/despawned)`);
    else
        log(bot, `Collected ${gained} ${blockType}.`);
    return gained > 0;
}

// Flood-fill mine a connected ore vein starting from a just-mined block position.
// MC ore blobs can touch on faces, edges, or corners, so use all 26 neighbours.
// A block that is temporarily occluded/unreachable is retried after another vein
// block is mined: removing its neighbour can expose a safe LOS/stand cell. Fluid
// and wrong-tool refusals remain terminal, preserving the safety contract.
export async function harvestConnectedVein(bot, startPos, blocktypes, max=64, opts={}) {
    const NB = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        if (dx || dy || dz) NB.push([dx, dy, dz]);
    }
    const isTarget = (b) => b && blocktypes.includes(b.name);
    const keyOf = (p) => `${p.x},${p.y},${p.z}`;
    const discovered = new Set();
    const scan = [];
    const component = [];
    const enqueue = (p) => {
        const key = keyOf(p);
        if (discovered.has(key)) return;
        discovered.add(key);
        scan.push(p);
    };
    for (const [dx,dy,dz] of NB) enqueue(startPos.offset(dx,dy,dz));
    while (scan.length && component.length < max) {
        const p = scan.shift();
        const b = bot.blockAt(p);
        if (!isTarget(b)) continue;
        component.push(p);
        for (const [dx,dy,dz] of NB) enqueue(p.offset(dx,dy,dz));
    }

    const dig = typeof opts.dig === 'function'
        ? opts.dig
        : (b) => safeDig(bot, b, { maxMs: 8000, pickup: true, requireLOS: true });
    let mined = 0;
    let pending = component;
    while (pending.length && mined < max) {
        let passMined = 0;
        const retry = [];
        for (const p of pending) {
            if (bot.interrupt_code || mined >= max) break;
            const b = bot.blockAt(p);
            if (!isTarget(b)) continue;
            const r = await dig(b);
            if (r === 'ok') { mined++; passMined++; }
            else if (r === 'occluded' || r === 'unreachable') retry.push(p);
        }
        if (passMined === 0) break;
        pending = retry;
    }
    return mined;
}

export async function pickupNearbyItems(bot, distance = 8) {
    /**
     * Pick up all nearby items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, search radius for drops. Defaults to 8; pass a larger value
     *   (e.g. 12) to chase drops that floated/drifted (water) out of the default reach.
     * @returns {Promise<boolean>} true if the items were picked up, false otherwise.
     * @example
     * await skills.pickupNearbyItems(bot);
    **/
    const maxAttempts = 10; // Prevent infinite loops
    const FOOD_ITEM_RE = /rotten_flesh|beef|porkchop|chicken|mutton|rabbit|cod|salmon|bread|apple|carrot|potato|melon|berries|stew/i;
    const droppedName = (entity) => {
        try {
            const it = entity && entity.getDroppedItem && entity.getDroppedItem();
            return it && it.name ? it.name : '';
        } catch (e) { return ''; }
    };
    const faminePickup = () => process.env.MC_FOOD_INSTINCTS === '1' && bot.food <= 2;
    const miningPickup = () => {
        const skill = bot._currentSkill || '';
        const mob = bot._mobility || {};
        return /branchMine/.test(skill) || (mob.enclosed && bot.entity && bot.entity.position && bot.entity.position.y < 72);
    };
    const cheapMiningPickup = (entity) => {
        if (!entity || !entity.position || !bot.entity || !bot.entity.position) return false;
        const me = bot.entity.position;
        const d = me.distanceTo(entity.position);
        const dx = entity.position.x - me.x;
        const dz = entity.position.z - me.z;
        const dy = entity.position.y - me.y;
        const horiz = Math.hypot(dx, dz);
        return d <= 2.2 || (horiz <= 4.2 && dy <= 1.2 && dy >= -3.2);
    };
    // ★unreachable-drop blacklist (live 2026-07-02 02:41-02:45: ONE item wedged in a
    // 1-gap cell ate 876 GoalFollow/step-edge events and froze branchMine at y=67 for
    // 5 straight minutes — every dig iteration re-called this function, and the give-up
    // below had no memory across calls, so the same doomed chase restarted until the
    // item DESPAWNED). Cross-call memory on bot._* (hot-reload red line), 120s TTL:
    // two more chances before the 5-min despawn, zero chance of a per-item spin.
    const UNREACHABLE_TTL = 120000;
    const blacklist = bot._pickupUnreachable || (bot._pickupUnreachable = {});
    for (const k of Object.keys(blacklist)) if (Date.now() - blacklist[k] > UNREACHABLE_TTL) delete blacklist[k];
    const getNearestItem = bot => bot.nearestEntity(entity => {
        if (!entity || entity.name !== 'item' || !entity.position) return false;
        if (blacklist[entity.id]) return false;
        if (isSelfDiscardedItem(bot, entity)) return false;
        const d = bot.entity.position.distanceTo(entity.position);
        if (d >= distance) return false;
        if (miningPickup() && !cheapMiningPickup(entity) && !FOOD_ITEM_RE.test(droppedName(entity))) return false;
        if (!faminePickup()) return true;
        return d <= 2.1 || FOOD_ITEM_RE.test(droppedName(entity));
    });
    if (miningPickup()) {
        const skipped = Object.values(bot.entities || {}).filter(entity => {
            if (!entity || entity.name !== 'item' || !entity.position) return false;
            const d = bot.entity.position.distanceTo(entity.position);
            return d < distance && !cheapMiningPickup(entity) && !FOOD_ITEM_RE.test(droppedName(entity));
        }).map(entity => {
            const me = bot.entity.position;
            return {
                name: droppedName(entity) || 'item',
                pos: {
                    x: Math.floor(entity.position.x),
                    y: Math.floor(entity.position.y),
                    z: Math.floor(entity.position.z),
                },
                dy: +(entity.position.y - me.y).toFixed(2),
                dist: +me.distanceTo(entity.position).toFixed(2),
            };
        });
        if (skipped.length > 0) {
            log(bot, `Mining pickup gate: skipped ${skipped.length} uphill/far item chases while mining.`);
            motionAudit(bot, 'pickup.mining_gate', { skipped: skipped.slice(0, 5), skill: bot._currentSkill || null, mob: bot._mobility ? bot._mobility.state : null });
        }
    }
    if (faminePickup()) {
        const skipped = Object.values(bot.entities || {}).filter(entity => {
            if (!entity || entity.name !== 'item' || !entity.position) return false;
            const d = bot.entity.position.distanceTo(entity.position);
            return d < distance && d > 2.1 && !FOOD_ITEM_RE.test(droppedName(entity));
        }).length;
        if (skipped > 0) {
            log(bot, `Famine pickup gate: skipped ${skipped} non-food item chases at food=${bot.food}, hp=${Math.round(bot.health || 0)}.`);
            motionAudit(bot, 'pickup.famine_gate', { skipped, food: bot.food, hp: Math.round(bot.health || 0) });
        }
    }
    let nearestItem = getNearestItem(bot);
    let pickedUp = 0;
    let attempts = 0;
    let consecutiveFailures = 0;
    
    while (nearestItem && attempts < maxAttempts) {
        attempts++;
        let movements = new pf.Movements(bot);
        movements.canDig = false;
        bot.pathfinder.setMovements(movements);
        
        try {
            // Add timeout for pathfinding
            const pathTimeout = 5000; // 5 seconds
            await Promise.race([
                goToGoal(bot, new pf.goals.GoalFollow(nearestItem, 1)),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Pathfind timeout')), pathTimeout)
                )
            ]);
        } catch (error) {
            // Count EVERY failed leg (path-failed/NoPath/goal-changed too, not just the
            // timeout — untyped rejections previously slipped through uncounted).
            log(bot, `⚠️ Failed to reach item (${error.message}), skipping.`);
            consecutiveFailures++;
            if (consecutiveFailures >= 3) {
                blacklist[nearestItem.id] = Date.now();   // ★don't re-chase next call
                log(bot, `Too many consecutive failures, stopping item pickup.`);
                break;
            }
        }

        await new Promise(resolve => setTimeout(resolve, 200));
        let prev = nearestItem;
        nearestItem = getNearestItem(bot);
        if (prev === nearestItem) {
            consecutiveFailures++;
            if (consecutiveFailures >= 2) {
                blacklist[prev.id] = Date.now();          // ★don't re-chase next call
                log(bot, `Unable to reach item at ${prev.position}, giving up (blacklisted 120s).`);
                break;
            }
        } else {
            consecutiveFailures = 0; // Reset on success
            pickedUp++;
        }
    }
    
    if (attempts >= maxAttempts) {
        log(bot, `⚠️ Stopped picking up items after ${maxAttempts} attempts.`);
    }
    
    log(bot, `Picked up ${pickedUp} items.`);
    return true;
}

export async function ensurePickupAt(bot, pos, opts = {}) {
    /**
     * Make sure the drops left by a just-mined block (ore / crafting_table / furnace /
     * any valuable block) actually end up in the inventory — INCLUDING the common case
     * where the bot mined a block from ONE LEVEL UP and the drop fell to a lower ledge,
     * then walked off without it (user-reported: mined its own crafting_table from above,
     * never went down to grab it).
     *
     * ★SAFETY FIRST (user: "别为了捡东西摔死"): a drop is fetched ONLY if it's within a
     * SAFE descent (≤ maxDescend blocks down → ZERO fall damage) and its resting cell isn't
     * over/in lava·fire·void. Anything below that, or that the (non-digging, maxDropDown=3)
     * pathfinder refuses to safely reach, is LEFT BEHIND on purpose — losing an item is
     * always cheaper than a death. Never throws.
     *
     * @param {MinecraftBot} bot
     * @param {Vec3} pos   the position of the block that was just mined (drop origin)
     * @param {{radius?:number,maxDescend?:number,timeoutMs?:number}} opts
     * @returns {Promise<boolean>} true if at least one item was collected
     */
    const radius = opts.radius ?? 5;
    const maxDescend = opts.maxDescend ?? 3;      // ≤3 blocks down = no fall damage
    const timeoutMs = opts.timeoutMs ?? 8000;
    const HAZARD = /lava|fire|magma|cactus|campfire|wither_rose|sweet_berry|powder_snow/;
    // ★T-0004 DBG: persistent one-liner per ensure-pickup outcome (bot.output never reaches a
    // file, so the in-game effect was unobservable). Shares mine_dbg.log; ★PICKUP prefix.
    const _pkDBG = (m) => appendTelemetry('mine_dbg.log', `[${new Date().toISOString()}] ★PICKUP ${m}\n`, { json: false });
    const totalItems = () => { try { return Object.values(world.getInventoryCounts(bot)).reduce((a, b) => a + b, 0); } catch (e) { return 0; } };
    try {
        if (!bot || !bot.entity || !bot.entity.position || !pos) return false;
        const before = totalItems();
        { // entry trace: confirm wiring actually fires + how many drops are in range
          const _nd = Object.values(bot.entities || {}).filter(e => e && e.name === 'item' && e.position && e.position.distanceTo(pos) <= radius + 2).length;
          _pkDBG(`call @${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)} drops=${_nd} (achieve/branchMine post-dig)`);
        }
        for (let pass = 0; pass < 3; pass++) {
            if (bot.interrupt_code || bot.death_abort) break;
            const me = bot.entity.position;
            const drops = Object.values(bot.entities || {}).filter(e =>
                e && e.name === 'item' && e.position && e.position.distanceTo(pos) <= radius + 2);
            if (!drops.length) break;
            // nearest SAFELY-reachable drop
            let target = null, td = Infinity, unsafeSeen = 0;
            for (const e of drops) {
                const dp = e.position;
                if (me.y - dp.y > maxDescend) { unsafeSeen++; continue; }          // too far below → don't risk it
                if (dp.distanceTo(me) > radius + 2) continue;
                const cell = bot.blockAt(dp.floored());
                const below = bot.blockAt(dp.floored().offset(0, -1, 0));
                if (cell && HAZARD.test(cell.name || '')) { unsafeSeen++; continue; }
                if (below && /lava|fire|magma/.test(below.name || '')) { unsafeSeen++; continue; }
                // need real footing at the drop (solid, or at worst shallow water) — not a void edge
                if (below && below.boundingBox !== 'block' && !/water/.test(below.name || '')) { unsafeSeen++; continue; }
                const d = dp.distanceTo(me);
                if (d < td) { td = d; target = e; }
            }
            if (!target) {
                if (unsafeSeen && pass === 0) { log(bot, `ensurePickup: ${unsafeSeen} drop(s) near ${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)} not safely reachable (descent/hazard) — leaving them rather than risk a fall.`); _pkDBG(`skip ${unsafeSeen} unsafe-drop @${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)} (descent>3/hazard/no-footing) — left (no death-risk)`); }
                break;
            }
            const tp = target.position;
            if (tp.distanceTo(bot.entity.position) > 1.4) {
                try {
                    await Promise.race([
                        goToGoal(bot, new pf.goals.GoalNear(tp.x, tp.y, tp.z, 1)),   // non-destructive, maxDropDown=3 = safe descents only
                        new Promise((_, rej) => setTimeout(() => rej(new Error('pickup-nav-timeout')), timeoutMs)),
                    ]);
                } catch (e) {
                    log(bot, `ensurePickup: couldn't safely reach drop @${Math.floor(tp.x)},${Math.floor(tp.y)},${Math.floor(tp.z)} (${e.message}) — leaving it.`);
                    _pkDBG(`reach-refuse @${Math.floor(tp.x)},${Math.floor(tp.y)},${Math.floor(tp.z)} (${e.message}) — left (pathfinder refused)`);
                    break;   // pathfinder refused (likely unsafe / blocked) — don't fight it
                }
            }
            try { await pickupNearbyItems(bot); } catch (e) {}
            await new Promise(r => setTimeout(r, 200));
        }
        const got = totalItems() - before;
        if (got > 0) { log(bot, `ensurePickup: collected ${got} item(s) from the dig site.`); _pkDBG(`got ${got} item(s) @${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)} (safe descend+pickup ✓)`); }
        return got > 0;
    } catch (e) { return false; }
}


export async function breakBlockAt(bot, x, y, z) {
    /**
     * Break the block at the given position. Will use the bot's equipped item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate of the block to break.
     * @param {number} y, the y coordinate of the block to break.
     * @param {number} z, the z coordinate of the block to break.
     * @returns {Promise<boolean>} true if the block was broken, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.breakBlockAt(bot, position.x, position.y - 1, position.x);
     **/
    if (x == null || y == null || z == null) throw new Error('Invalid position to break block at.');
    let block = bot.blockAt(Vec3(x, y, z));
    if (block.name !== 'air' && block.name !== 'water' && block.name !== 'lava') {
        if (bot.modes.isOn('cheat')) {
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            let msg = '/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z) + ' air';
            bot.chat(msg);
            log(bot, `Used /setblock to break block at ${x}, ${y}, ${z}.`);
            return true;
        }

        if (bot.entity.position.distanceTo(block.position) > 4.5) {
            let pos = block.position;
            let movements = new pf.Movements(bot);
            movements.canPlaceOn = false;
            movements.allow1by1towers = false;
            bot.pathfinder.setMovements(movements);
            await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
        }
        if (bot.game.gameMode !== 'creative') {
            await bot.tool.equipForBlock(block);
            const itemId = bot.heldItem ? bot.heldItem.type : null
            // canHarvest() answers "will this DROP an item", NOT "can I break it". A bare-handed
            // bot CAN break cobblestone/stone/netherrack (slow, no drop, but the block disappears)
            // — and that is exactly what un-traps a pickaxe-less bot sealed inside its own cobble
            // bunker. Gating on canHarvest left such a bot to rot (observed: 1.5h frozen, enclosed,
            // no pick). Gate on REAL diggability instead: allow if digTime is finite and bounded
            // (<9s/block); only truly un-diggable-by-hand blocks (obsidian/bedrock, digTime huge or
            // Infinity) are refused. Drop loss is irrelevant for escape digging. NOTE: resource
            // mining keeps its own canHarvest gate in collectBlock — this only frees breakBlockAt
            // (navigation/escape digging).
            if (!block.canHarvest(itemId)) {
                // ★2026-07-14 ORE-WASTE GUARD (用户: "偶发性用石镐挖钻石"): the relaxed <9s "escape digging"
                // allowance below breaks wrong-tool blocks so a pickless bot can tunnel out of its own cobble
                // bunker — but it must NEVER destroy an ORE. Breaking diamond/emerald/gold/redstone ore with a
                // sub-iron pick (or iron/lapis/copper with a sub-stone one) drops NOTHING = the resource is gone
                // forever. Every incidental-ore path funnels through here (mineDown's opportunistic ore-ring +
                // staircase, digDown, digReset, prepNether, escapePlan), so refusing ore here seals them all at
                // once. Return false CLEANLY (no throw) → callers wedge/skip gracefully with no abort-spin. You
                // are never trapped inside solid ore, so escape digging of stone/dirt/cobble is unaffected.
                if (/_ore$|ancient_debris/.test(block.name || '')) {
                    log(bot, `⛏️ Refusing wrong-tool break of ${block.name} with ${bot.heldItem ? bot.heldItem.name : 'hand'} — would destroy the ore (no drop). Skipping; needs a higher-tier pickaxe.`);
                    return false;
                }
                let digMs = Infinity;
                try { digMs = block.digTime(itemId, false, false, false); } catch (e) { digMs = 0; }
                if (!Number.isFinite(digMs) || digMs > 9000) {
                    log(bot, `Can't break ${block.name} with ${bot.heldItem ? bot.heldItem.name : 'hand'} (digTime ${digMs}ms) — skipping.`);
                    return false;
                }
                log(bot, `Breaking ${block.name} bare-handed/wrong-tool (no drop, ~${Math.round(digMs)}ms).`);
            }
        }
        
        // Add timeout to prevent infinite hanging
        const digTimeout = 60000; // 60 seconds max
        const digPromise = gazeHold(bot, block, bot.dig(block, true));
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Dig timeout')), digTimeout)
        );
        // ★Interrupt-aware: poll bot.interrupt_code so a supervisor cancel / mode preempt aborts
        // the dig within ~200ms instead of waiting out the 60s timeout. Without this, an in-flight
        // bot.dig() ignored cancel for up to 60s, and a chained mining loop compounded that to the
        // observed 4-minute "won't yield" hang. (cancelSkill now also calls stopDigging directly.)
        let _digIv = null;
        const interruptPromise = new Promise((_, reject) => {
            _digIv = setInterval(() => { try { if (bot.interrupt_code) reject(new Error('Interrupted')); } catch (e) {} }, 200);
        });
        try {
            await Promise.race([digPromise, timeoutPromise, interruptPromise]);
            log(bot, `Broke ${block.name} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
        } catch (error) {
            if (error.message === 'Dig timeout') {
                log(bot, `⚠️ Digging ${block.name} timed out after ${digTimeout/1000}s, stopping dig.`);
                try { bot.stopDigging(); } catch (e) {}
                return false;
            }
            if (error.message === 'Interrupted') {
                try { bot.stopDigging(); } catch (e) {}
                return false;
            }
            throw error;  // Re-throw other errors
        } finally {
            if (_digIv) clearInterval(_digIv);
        }
    }
    else {
        log(bot, `Skipping block at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)} because it is ${block.name}.`);
        return false;
    }
    return true;
}


export async function placeBlock(bot, blockType, x, y, z, placeOn='bottom', dontCheat=false) {
    /**
     * Place the given block type at the given position. It will build off from any adjacent blocks. Will fail if there is a block in the way or nothing to build off of.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to place, which can be a block or item name.
     * @param {number} x, the x coordinate of the block to place.
     * @param {number} y, the y coordinate of the block to place.
     * @param {number} z, the z coordinate of the block to place.
     * @param {string} placeOn, the preferred side of the block to place on. Can be 'top', 'bottom', 'north', 'south', 'east', 'west', or 'side'. Defaults to bottom. Will place on first available side if not possible.
     * @param {boolean} dontCheat, overrides cheat mode to place the block normally. Defaults to false.
     * @returns {Promise<boolean>} true if the block was placed, false otherwise.
     * @example
     * let p = world.getPosition(bot);
     * await skills.placeBlock(bot, "oak_log", p.x + 2, p.y, p.x);
     * await skills.placeBlock(bot, "torch", p.x + 1, p.y, p.x, 'side');
    **/
    const target_dest = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    const placeCtx = (extra = {}) => ({
        blockType,
        item: extra.item || null,
        target: motionVecObj(target_dest),
        placeOn,
        dontCheat,
        env: motionEnvSnap(bot),
        ...extra,
    });
    motionAudit(bot, 'place_skill.begin', placeCtx());

    if (blockType === 'air') {
        log(bot, `Placing air (removing block) at ${target_dest}.`);
        const ok = await breakBlockAt(bot, x, y, z);
        motionAudit(bot, 'place_skill.end', placeCtx({ ok, mode: 'remove-air' }));
        return ok;
    }

    if (bot.modes.isOn('cheat') && !dontCheat) {
        if (bot.restrict_to_inventory) {
            let block = bot.inventory.findInventoryItem(blockType);
            if (!block) {
                log(bot, `Cannot place ${blockType}, you are restricted to your current inventory.`);
                motionAudit(bot, 'place_skill.end', placeCtx({ ok: false, mode: 'cheat', reason: 'missing-restricted-inventory' }));
                return false;
            }
        }

        // invert the facing direction
        let face = placeOn === 'north' ? 'south' : placeOn === 'south' ? 'north' : placeOn === 'east' ? 'west' : 'east';
        if (blockType.includes('torch') && placeOn !== 'bottom') {
            // insert wall_ before torch
            blockType = blockType.replace('torch', 'wall_torch');
            if (placeOn !== 'side' && placeOn !== 'top') {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType.includes('button') || blockType === 'lever') {
            if (placeOn === 'top') {
                blockType += `[face=ceiling]`;
            }
            else if (placeOn === 'bottom') {
                blockType += `[face=floor]`;
            }
            else {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType === 'ladder' || blockType === 'repeater' || blockType === 'comparator') {
            blockType += `[facing=${face}]`;
        }
        if (blockType.includes('stairs')) {
            blockType += `[facing=${face}]`;
        }
        if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
        let msg = '/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z) + ' ' + blockType;
        bot.chat(msg);
        if (blockType.includes('door'))
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y+1) + ' ' + Math.floor(z) + ' ' + blockType + '[half=upper]');
        if (blockType.includes('bed'))
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z-1) + ' ' + blockType + '[part=head]');
        log(bot, `Used /setblock to place ${blockType} at ${target_dest}.`);
        motionAudit(bot, 'place_skill.end', placeCtx({ ok: true, mode: 'cheat', command: msg }));
        return true;
    }

    let item_name = blockType;
    if (item_name == "redstone_wire")
        item_name = "redstone";
    else if (item_name === 'water') {
        item_name = 'water_bucket';
    }
    else if (item_name === 'lava') {
        item_name = 'lava_bucket';
    }
    let block_item = bot.inventory.findInventoryItem(item_name);
    if (!block_item && bot.game.gameMode === 'creative' && !bot.restrict_to_inventory) {
        await bot.creative.setInventorySlot(36, mc.makeItem(item_name, 1)); // 36 is first hotbar slot
        block_item = bot.inventory.findInventoryItem(item_name);
    }
    if (!block_item) {
        log(bot, `Don't have any ${item_name} to place.`);
        motionAudit(bot, 'place_skill.end', placeCtx({ ok: false, item: item_name, reason: 'missing-item' }));
        return false;
    }

    const targetBlock = bot.blockAt(target_dest);
    motionAudit(bot, 'place_skill.target', placeCtx({
        item: item_name,
        targetBlock: motionBlockObj(targetBlock),
        intersectsBody: botAabbIntersectsBlock(bot, target_dest),
    }));
    if (targetBlock.name === blockType || (targetBlock.name === 'grass_block' && blockType === 'dirt')) {
        log(bot, `${blockType} already at ${targetBlock.position}.`);
        motionAudit(bot, 'place_skill.end', placeCtx({ ok: false, item: item_name, reason: 'already-present', targetBlock: motionBlockObj(targetBlock) }));
        return false;
    }
    const empty_blocks = ['air', 'water', 'lava', 'grass', 'short_grass', 'tall_grass', 'snow', 'dead_bush', 'fern'];
    if (!empty_blocks.includes(targetBlock.name)) {
        log(bot, `${targetBlock.name} in the way at ${targetBlock.position}.`);
        motionAudit(bot, 'place_skill.clear.begin', placeCtx({ item: item_name, targetBlock: motionBlockObj(targetBlock) }));
        const removed = await breakBlockAt(bot, x, y, z);
        motionAudit(bot, 'place_skill.clear.end', placeCtx({ item: item_name, removed, after: motionBlockObj(bot.blockAt(target_dest)) }));
        if (!removed) {
            log(bot, `Cannot place ${blockType} at ${targetBlock.position}: block in the way.`);
            motionAudit(bot, 'place_skill.end', placeCtx({ ok: false, item: item_name, reason: 'block-in-way', targetBlock: motionBlockObj(targetBlock) }));
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 200)); // wait for block to break
    }
    // get the buildoffblock and facevec based on whichever adjacent block is not empty
    let buildOffBlock = null;
    let faceVec = null;
    const dir_map = {
        'top': Vec3(0, 1, 0),
        'bottom': Vec3(0, -1, 0),
        'north': Vec3(0, 0, -1),
        'south': Vec3(0, 0, 1),
        'east': Vec3(1, 0, 0),
        'west': Vec3(-1, 0, 0),
    }
    let dirs = [];
    if (placeOn === 'side') {
        dirs.push(dir_map['north'], dir_map['south'], dir_map['east'], dir_map['west']);
    }
    else if (dir_map[placeOn] !== undefined) {
        dirs.push(dir_map[placeOn]);
    }
    else {
        dirs.push(dir_map['bottom']);
        log(bot, `Unknown placeOn value "${placeOn}". Defaulting to bottom.`);
    }
    dirs.push(...Object.values(dir_map).filter(d => !dirs.includes(d)));

    for (let d of dirs) {
        const block = bot.blockAt(target_dest.plus(d));
        if (!empty_blocks.includes(block.name)) {
            buildOffBlock = block;
            faceVec = new Vec3(-d.x, -d.y, -d.z); // invert
            break;
        }
    }
    if (!buildOffBlock) {
        log(bot, `Cannot place ${blockType} at ${targetBlock.position}: nothing to place on.`);
        motionAudit(bot, 'place_skill.end', placeCtx({ ok: false, item: item_name, reason: 'no-build-off', targetBlock: motionBlockObj(targetBlock) }));
        return false;
    }
    motionAudit(bot, 'place_skill.reference', placeCtx({
        item: item_name,
        reference: motionBlockObj(buildOffBlock),
        face: faceVec ? { x: faceVec.x, y: faceVec.y, z: faceVec.z } : null,
    }));

    // Check for interrupt before potentially long operations
    if (bot.interrupt_code) {
        log(bot, `Interrupted before placing ${blockType}.`);
        motionAudit(bot, 'place_skill.end', placeCtx({ ok: false, item: item_name, reason: 'interrupt-before-place' }));
        return false;
    }

    const pos = bot.entity.position;
    const pos_above = pos.plus(Vec3(0,1,0));
    const dont_move_for = ['torch', 'redstone_torch', 'redstone', 'lever', 'button', 'rail', 'detector_rail', 
        'powered_rail', 'activator_rail', 'tripwire_hook', 'tripwire', 'water_bucket', 'string'];
    if (!dont_move_for.includes(item_name) && botAabbIntersectsBlock(bot, target_dest)) {
        log(bot, `Refusing to place ${blockType} at ${target_dest}: target intersects bot body.`);
        motionAudit(bot, 'place_skill.end', placeCtx({ ok: false, item: item_name, reason: 'intersects-body' }));
        return false;
    }
    if (!dont_move_for.includes(item_name) && (pos.distanceTo(targetBlock.position) < 1.1 || pos_above.distanceTo(targetBlock.position) < 1.1)) {
        // too close
        motionAudit(bot, 'place_skill.positioning.begin', placeCtx({ item: item_name, reason: 'too-close', distance: +pos.distanceTo(targetBlock.position).toFixed(3) }));
        let goal = new pf.goals.GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 2);
        let inverted_goal = new pf.goals.GoalInvert(goal);
        await goToGoal(bot, inverted_goal);
        motionAudit(bot, 'place_skill.positioning.end', placeCtx({ item: item_name, reason: 'too-close', pos: motionPos(bot) }));
    }
    
    if (bot.interrupt_code) {
        log(bot, `Interrupted while positioning for ${blockType}.`);
        motionAudit(bot, 'place_skill.end', placeCtx({ ok: false, item: item_name, reason: 'interrupt-after-positioning' }));
        return false;
    }
    
    if (bot.entity.position.distanceTo(targetBlock.position) > 4.5) {
        // too far
        let pos = targetBlock.position;
        let movements = new pf.Movements(bot);
        bot.pathfinder.setMovements(movements);
        motionAudit(bot, 'place_skill.positioning.begin', placeCtx({ item: item_name, reason: 'too-far', distance: +bot.entity.position.distanceTo(targetBlock.position).toFixed(3) }));
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
        motionAudit(bot, 'place_skill.positioning.end', placeCtx({ item: item_name, reason: 'too-far', pos: motionPos(bot) }));
    }

    // will throw error if an entity is in the way, and sometimes even if the block was placed
    try {
        if (item_name.includes('bucket')) {
            await useToolOnBlock(bot, item_name, buildOffBlock);
            motionAudit(bot, 'place_skill.end', placeCtx({ ok: true, item: item_name, mode: 'bucket', reference: motionBlockObj(buildOffBlock), face: faceVec ? { x: faceVec.x, y: faceVec.y, z: faceVec.z } : null }));
        }
        else {
            // Confirm the held slot lands on the server before we send block_place,
            // otherwise the server resolves the place packet against the previous
            // held item (typically 'air') and silently rejects it.
            const equipRes = await tickConfirm.equipConfirmed(bot, block_item.name, 'hand');
            if (!equipRes.ok) {
                log(bot, `Failed to equip ${block_item.name} to place: ${equipRes.reason}.`);
                motionAudit(bot, 'place_skill.end', placeCtx({ ok: false, item: item_name, reason: 'equip-failed', equip: equipRes }));
                return false;
            }
            await bot.lookAt(buildOffBlock.position.offset(0.5, 0.5, 0.5));
            const res = await tickConfirm.placeBlockConfirmed(
                bot, buildOffBlock, faceVec, target_dest, blockType,
                { retries: 2, confirmTimeoutMs: 600, backoffMs: 200 }
            );
            if (!res.ok) {
                log(bot, `Failed to place ${blockType} at ${target_dest}: ${res.error_class} (${res.reason}).`);
                motionAudit(bot, 'place_skill.end', placeCtx({
                    ok: false,
                    item: item_name,
                    reason: 'confirm-failed',
                    confirm: res,
                    after: motionBlockObj(bot.blockAt(target_dest)),
                }));
                return false;
            }
            log(bot, `Placed ${blockType} at ${target_dest}.`);
            motionAudit(bot, 'place_skill.end', placeCtx({
                ok: true,
                item: item_name,
                confirm: res,
                reference: motionBlockObj(buildOffBlock),
                face: faceVec ? { x: faceVec.x, y: faceVec.y, z: faceVec.z } : null,
                after: motionBlockObj(bot.blockAt(target_dest)),
            }));
            return true;
        }
    } catch (err) {
        log(bot, `Failed to place ${blockType} at ${target_dest}.`);
        motionAudit(bot, 'place_skill.end', placeCtx({ ok: false, item: item_name, reason: 'exception', error: err && err.message ? err.message : String(err) }));
        return false;
    }
}

export async function placeBlockUnderFeet(bot, blockType, opts = {}) {
    const {
        minClearance = 0.92,
        jumpMs = 900,
        settleMs = 180,
        retries = 2,
    } = opts;
    let itemName = blockType;
    if (itemName === 'redstone_wire') itemName = 'redstone';
    if (isPlankBlock(itemName)) {
        log(bot, `Refusing to place ${itemName} under feet: planks are reserved for crafting.`);
        motionAudit(bot, 'place_underfoot.end', { ok: false, blockType, item: itemName, reason: 'planks-forbidden', env: motionEnvSnap(bot) });
        return false;
    }
    const empty = new Set(['air', 'cave_air', 'void_air', 'water', 'flowing_water', 'grass', 'short_grass', 'tall_grass', 'snow', 'dead_bush', 'fern']);
    motionAudit(bot, 'place_underfoot.begin', {
        blockType,
        item: itemName,
        opts: { minClearance, jumpMs, settleMs, retries },
        env: motionEnvSnap(bot),
    });
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (bot.interrupt_code) {
            motionAudit(bot, 'place_underfoot.end', { ok: false, blockType, item: itemName, attempt, reason: 'interrupt', env: motionEnvSnap(bot) });
            return false;
        }
        const target = bot.entity.position.floored();
        const targetBlock = bot.blockAt(target);
        const ref = bot.blockAt(target.offset(0, -1, 0));
        motionAudit(bot, 'place_underfoot.attempt', {
            attempt,
            blockType,
            item: itemName,
            target: motionVecObj(target),
            targetBlock: motionBlockObj(targetBlock),
            reference: motionBlockObj(ref),
            y: bot.entity && bot.entity.position ? +bot.entity.position.y.toFixed(3) : null,
            env: motionEnvSnap(bot),
        });
        if (!targetBlock || !empty.has(targetBlock.name)) {
            motionAudit(bot, 'place_underfoot.end', { ok: false, blockType, item: itemName, attempt, reason: 'target-not-empty', targetBlock: motionBlockObj(targetBlock), env: motionEnvSnap(bot) });
            return false;
        }
        if (!ref || ref.boundingBox !== 'block') {
            motionAudit(bot, 'place_underfoot.end', { ok: false, blockType, item: itemName, attempt, reason: 'no-reference-below', reference: motionBlockObj(ref), env: motionEnvSnap(bot) });
            return false;
        }
        const blockItem = bot.inventory.findInventoryItem(itemName);
        if (!blockItem) {
            log(bot, `Don't have any ${itemName} to place under feet.`);
            motionAudit(bot, 'place_underfoot.end', { ok: false, blockType, item: itemName, attempt, reason: 'missing-item', env: motionEnvSnap(bot) });
            return false;
        }
        const equipRes = await tickConfirm.equipConfirmed(bot, blockItem.name, 'hand');
        if (!equipRes.ok) {
            log(bot, `Failed to equip ${blockItem.name} for under-foot pillar: ${equipRes.reason}.`);
            motionAudit(bot, 'place_underfoot.end', { ok: false, blockType, item: itemName, attempt, reason: 'equip-failed', equip: equipRes, env: motionEnvSnap(bot) });
            return false;
        }
        try { bot.clearControlStates(); } catch (e) {}
        try {
            bot.setControlState('jump', true);
            const deadline = Date.now() + jumpMs;
            while (Date.now() < deadline && bot.entity.position.y < target.y + minClearance) {
                await tickConfirm.sleepMs(35);
            }
            if (bot.entity.position.y < target.y + minClearance) {
                log(bot, `Under-foot place delayed: y=${bot.entity.position.y.toFixed(2)} target=${target.x},${target.y},${target.z}.`);
                motionAudit(bot, 'place_underfoot.delay', {
                    attempt,
                    blockType,
                    item: itemName,
                    target: motionVecObj(target),
                    y: +bot.entity.position.y.toFixed(3),
                    neededY: +(target.y + minClearance).toFixed(3),
                    env: motionEnvSnap(bot),
                });
                continue;
            }
            await bot.lookAt(ref.position.offset(0.5, 1.0, 0.5), true);
            const res = await tickConfirm.placeBlockConfirmed(
                bot, ref, new Vec3(0, 1, 0), target, blockType,
                { retries: 1, confirmTimeoutMs: 650, backoffMs: 120 }
            );
            if (!res.ok) {
                log(bot, `Failed under-foot place ${blockType} at ${target}: ${res.error_class} (${res.reason}).`);
                motionAudit(bot, 'place_underfoot.confirm_failed', {
                    attempt,
                    blockType,
                    item: itemName,
                    target: motionVecObj(target),
                    confirm: res,
                    after: motionBlockObj(bot.blockAt(target)),
                    env: motionEnvSnap(bot),
                });
                continue;
            }
            await tickConfirm.sleepMs(settleMs);
            motionAudit(bot, 'place_underfoot.end', {
                ok: true,
                blockType,
                item: itemName,
                attempt,
                target: motionVecObj(target),
                after: motionBlockObj(bot.blockAt(target)),
                pos: motionPos(bot),
                env: motionEnvSnap(bot),
            });
            return true;
        } finally {
            try { bot.setControlState('jump', false); } catch (e) {}
            try { bot.clearControlStates(); } catch (e) {}
        }
    }
    motionAudit(bot, 'place_underfoot.end', { ok: false, blockType, item: itemName, reason: 'exhausted-retries', env: motionEnvSnap(bot) });
    return false;
}

export async function placeBlockNearby(bot, blockName, maxTries=4) {
    /**
     * Robustly place a block somewhere reachable next to the bot, on solid footing,
     * WITHOUT cheating. Finds an adjacent floor cell that has a solid block beneath
     * it, clears the cell + headroom (digging a small niche if the spot is cramped,
     * e.g. a 1-wide mine tunnel), then places the block on that floor. Retries across
     * several cells and relocates to opener ground if needed. This replaces the old
     * "try a few spots, else /setblock" pattern — survival placement that just works,
     * so we never fall back to the cheat command.
     * @param {MinecraftBot} bot
     * @param {string} blockName, e.g. 'crafting_table' or 'furnace' (must be in inventory).
     * @param {number} maxTries, relocate-and-retry rounds. Defaults to 4.
     * @returns {Promise<boolean>} true if the block ended up placed.
     **/
    const empty = new Set(['air','cave_air','void_air','water','flowing_water','grass','short_grass','tall_grass','snow','dead_bush','fern','large_fern','vine','seagrass']);
    const noBuild = new Set(['lava','flowing_lava','water','flowing_water','bedrock']);
    const isSolidFloor = (b) => b && !empty.has(b.name) && !noBuild.has(b.name) && b.boundingBox === 'block';
    const tryCell = async (cell) => {
        if (bot.interrupt_code) return false;
        const below = bot.blockAt(cell.offset(0, -1, 0));
        if (!isSolidFloor(below)) return false; // need something solid to build off
        // Clear the target cell and the headroom above it (dig a niche if cramped).
        for (const c of [cell, cell.offset(0, 1, 0)]) {
            const b = bot.blockAt(c);
            if (!b) return false;
            if (noBuild.has(b.name)) return false; // don't dig into lava/water/bedrock
            if (!empty.has(b.name)) {
                try { const ok = await breakBlockAt(bot, c.x, c.y, c.z); if (!ok) return false; await new Promise(r => setTimeout(r, 150)); }
                catch (e) { return false; }
            }
        }
        return await placeBlock(bot, blockName, cell.x, cell.y, cell.z, 'bottom', true);
    };
    // ★PRE-ESCAPE if sealed/cramped (THE "place table" deadlock deep underground). If NO
    // horizontal neighbor is open air, the offset loop below would try to DIG each stone cell —
    // barehanded ~7.5s/block, which blows achieve's place-timebox before anything ever places.
    // So FIRST pillar UP on filler (FAST: placing ~0.4s) until a side opens or we surface — a
    // human just towers out of the hole. Then place normally in the opener space. (用户:"原地
    // 垫石头就能上去"。)
    const _fill2 = () => {
        const c = world.getInventoryCounts(bot); const has = (n) => (c[n] || 0) > 0;
        return ['dirt','cobblestone','cobbled_deepslate','stone','andesite','diorite','granite','tuff','gravel','netherrack'].find(has)
            // ★C288: badlands/desert fallback so a mesa-dug bot (248 red_sand + 184 terracotta, 0
            // cobble) can still tower out of a cramped pocket — non-gravity terracotta/sandstone
            // first, then sand/red_sand (gravity, last resort).
            || Object.keys(c).find(n => /(_terracotta|^terracotta|sandstone)$/.test(n) && c[n] > 0)
            || ['sand','red_sand'].find(has);
    };
    const _crampedNow = () => ![[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]].some(o => { const bl = bot.blockAt(bot.entity.position.offset(o[0],o[1],o[2])); return bl && empty.has(bl.name); });
    for (let up = 0; up < 8 && _crampedNow() && Math.floor(bot.entity.position.y) < 70 && !bot.interrupt_code; up++) {
        const f = _fill2(); if (!f) break;
        const h = bot.blockAt(bot.entity.position.offset(0, 2, 0));
        if (h && h.boundingBox === 'block' && !noBuild.has(h.name)) { try { await breakBlockAt(bot, h.x, h.y, h.z); } catch (e) {} }
        try { await placeBlockUnderFeet(bot, f, { retries: 1, settleMs: 150 }); }
        catch (e) { try { bot.setControlState('jump', false); } catch (e2) {} }
    }
    for (let t = 0; t < maxTries; t++) {
        if (bot.interrupt_code) break;
        const base = bot.entity.position.floored();
        const offs = [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],[2,0,0],[0,0,2]];
        for (const [dx, dy, dz] of offs) {
            if (await tryCell(new Vec3(base.x + dx, base.y + dy, base.z + dz))) {
                log(bot, `Placed ${blockName} nearby.`);
                return true;
            }
        }
        // Relocate to opener ground, then retry. ★If we CAN'T move (sealed 1-wide mine shaft —
        // the classic "place table" infinite loop deep underground: nowhere to relocate, every
        // neighbor is stone), CARVE an alcove with the pickaxe: clear the 4 horizontal neighbors
        // + their headroom so the next round has an open floor cell to place on. Bounded (≤8
        // blocks), skips lava/water/bedrock. This is what a human does — dig a side-pocket to
        // craft in instead of standing in the cramped shaft forever.
        // Couldn't place at this level — step to opener ground and retry. (A sealed/cramped
        // pocket is already handled by the FAST pre-escape pillar-up above; no slow barehanded
        // stone-carving here, which would blow the timebox.)
        try { await moveAway(bot, 3); } catch (e) {}
    }
    // ★STUCK ESCAPE (用户: "原地垫石头就能上去"). Couldn't place after carving — we're sealed in
    // a cramped pocket (naked in a stone shaft: can't dig stone fast, no room). PILLAR UP on any
    // non-plank filler we carry (logs/dirt/cobble) toward open sky so the caller's retry lands in the
    // open. Bounded to 6 — escapes a shallow pocket; a human just towers out.
    // ★C300: include BADLANDS/desert fillers (terracotta/sandstone/red_sand) — the STUCK-ESCAPE pillar
    // that lets the bot tower out of a cramped/footing-less spot to place a table couldn't fire in a
    // mesa (it holds 400+ red_sand but FILL2 listed none), so table placement → tool/sword crafting
    // dead-locked there (T-0017 keystone; same C280/C288 whitelist gap, yet another site). Non-gravity
    // first (terracotta/sandstone — safe to stand on while towering), red_sand/sand last.
    const FILL2 = ['dirt', 'cobblestone', 'cobbled_deepslate', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'netherrack'];
    const filler2 = () => {
        const c = world.getInventoryCounts(bot);
        return FILL2.find(n => (c[n] || 0) > 0)
            || Object.keys(c).find(n => (/_log$|terracotta$|sandstone$/.test(n)) && c[n] > 0)
            || ['gravel', 'sand', 'red_sand'].find(n => (c[n] || 0) > 0);
    };
    const headOpen = () => { const h = bot.blockAt(bot.entity.position.offset(0, 2, 0)); return !h || /^(air|cave_air|void_air|short_grass|tall_grass|snow)$/.test(h.name || ''); };
    for (let up = 0; up < 6 && filler2() && !bot.interrupt_code; up++) {
        if (!headOpen()) { const h = bot.blockAt(bot.entity.position.offset(0, 2, 0)); try { if (h) await breakBlockAt(bot, h.x, h.y, h.z); } catch (e) {} }
        const f = filler2(); if (!f) break;
        try {
            await placeBlockUnderFeet(bot, f, { retries: 1, settleMs: 160 });
            await new Promise(r => setTimeout(r, 160));
        } catch (e) { try { bot.setControlState('jump', false); } catch (e2) {} }
        if (Math.floor(bot.entity.position.y) >= 63) break;   // surfaced
    }
    log(bot, `Could not place ${blockName} nearby after ${maxTries} tries (pillared up to retry).`);
    return false;
}

export async function equip(bot, itemName) {
    /**
     * Equip the given item to the proper body part, like tools or armor.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to equip.
     * @returns {Promise<boolean>} true if the item was equipped, false otherwise.
     * @example
     * await skills.equip(bot, "iron_pickaxe");
     **/
    if (itemName === 'hand') {
        await bot.unequip('hand');
        // give the server a couple ticks to register the unequip before any follow-up packet
        await tickConfirm.sleepMs(100);
        log(bot, `Unequipped hand.`);
        return true;
    }
    let item = bot.inventory.slots.find(slot => slot && slot.name === itemName);
    if (!item) {
        if (bot.game.gameMode === "creative") {
            await bot.creative.setInventorySlot(36, mc.makeItem(itemName, 1));
            item = bot.inventory.findInventoryItem(itemName);
        }
        else {
            log(bot, `You do not have any ${itemName} to equip.`);
            return false;
        }
    }
    let destination = 'hand';
    if (itemName.includes('leggings')) destination = 'legs';
    else if (itemName.includes('boots')) destination = 'feet';
    else if (itemName.includes('helmet')) destination = 'head';
    else if (itemName.includes('chestplate') || itemName.includes('elytra')) destination = 'torso';
    else if (itemName.includes('shield')) destination = 'off-hand';

    const res = await tickConfirm.equipConfirmed(bot, itemName, destination);
    if (!res.ok) {
        if (res.error_class === 'prerequisite') {
            log(bot, `You do not have any ${itemName} to equip.`);
        } else {
            log(bot, `Failed to equip ${itemName} (${res.error_class}): ${res.reason}.`);
        }
        return false;
    }
    log(bot, `Equipped ${itemName}.`);
    return true;
}

// ★self-toss anti-repickup registry (user-reported 2026-07-08: items the bot itself just
// threw away sometimes got walked back over and picked right back up by the background
// `item_collecting` instinct — nothing distinguished "trash I just tossed on purpose" from
// "loot worth chasing"). discard() tags every entity spawned by its own bot.toss() calls
// here; pickupNearbyItems() and the item_collecting instinct both skip tagged ids. TTL
// outlives vanilla's 5-minute item despawn timer, so a tag never needs early clearing — by
// the time it could expire the item is already gone from the world.
const SELF_DISCARD_TTL = 6 * 60 * 1000;
function pruneSelfDiscarded(bot) {
    const reg = bot._selfDiscarded;
    if (!reg) return;
    const now = Date.now();
    for (const id of Object.keys(reg)) if (reg[id] < now) delete reg[id];
}
export function isSelfDiscardedItem(bot, entity) {
    const reg = bot._selfDiscarded;
    if (!reg || !entity) return false;
    const expiry = reg[entity.id];
    return typeof expiry === 'number' && expiry > Date.now();
}

export async function discard(bot, itemName, num=-1) {
    /**
     * Discard the given item. Tags the dropped entity so the bot's own item-collecting
     * instinct won't immediately notice it and pick it back up.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to discard.
     * @param {number} num, the number of items to discard. Defaults to -1, which discards all items.
     * @returns {Promise<boolean>} true if the item was discarded, false otherwise.
     * @example
     * await skills.discard(bot, "oak_log");
     **/
    const registry = bot._selfDiscarded || (bot._selfDiscarded = {});
    const onSpawn = (entity) => {
        if (!entity || entity.name !== 'item' || !bot.entity || !entity.position) return;
        if (entity.position.distanceTo(bot.entity.position) > 3) return;
        registry[entity.id] = Date.now() + SELF_DISCARD_TTL;
    };
    bot.on('entitySpawn', onSpawn);

    let discarded = 0;
    try {
        while (true) {
            let item = bot.inventory.findInventoryItem(itemName);
            if (!item) {
                break;
            }
            let to_discard = num === -1 ? item.count : Math.min(num - discarded, item.count);
            await bot.toss(item.type, null, to_discard);
            discarded += to_discard;
            if (num !== -1 && discarded >= num) {
                break;
            }
        }
        // give the server a moment to broadcast the last toss's spawn packet before we stop listening
        await new Promise(resolve => setTimeout(resolve, 250));
    } finally {
        bot.off('entitySpawn', onSpawn);
        pruneSelfDiscarded(bot);
    }
    if (discarded === 0) {
        log(bot, `You do not have any ${itemName} to discard.`);
        return false;
    }
    log(bot, `Discarded ${discarded} ${itemName}.`);
    return true;
}

export async function discardAway(bot, itemName, num=-1, opts={}) {
    /**
     * Dedicated "throw this away" skill: walk a short distance from the current spot,
     * then PIT-discard (smartDiscard) there — the drop ends up ≥1 block below feet in a
     * low spot / dug pocket, so neither the item_collecting instinct (self-toss tag) nor
     * the SERVER's automatic pickup sphere can bring it back.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to discard.
     * @param {number} num, the number of items to discard. Defaults to -1, which discards all items.
     * @param {{distance?: number, returnToStart?: boolean}} opts, distance to step away before
     *   tossing (default 5, pass 0 to discard in place) and whether to walk back afterward
     *   (default true).
     * @returns {Promise<boolean>} true if the item was discarded, false otherwise.
     * @example
     * await skills.discardAway(bot, "rotten_flesh");
     **/
    const { distance = 5, returnToStart = true } = opts;
    const start_loc = bot.entity.position.clone();
    if (distance > 0) {
        try { await moveAway(bot, distance); } catch (e) {}
    }
    // avoidPos steers the pit cell OFF the walk-back bearing, so the return path never
    // crosses the hole we just filled with trash. (smartDiscard signature is (bot, items, opts):
    // the count rides INSIDE the items entry — passing num as a 3rd positional silently made it
    // the opts arg and discarded EVERYTHING.)
    const discarded = await smartDiscard(bot, { name: itemName, num: num === undefined ? -1 : num },
        { avoidPos: returnToStart && distance > 0 ? start_loc : null });
    if (returnToStart && distance > 0) {
        try { await goToPosition(bot, start_loc.x, start_loc.y, start_loc.z, 0); } catch (e) {}
    }
    return discarded;
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// ★smartDiscard — 坑弃引擎 v3 (2026-07-14, 用户: "扔脚底原地再捡起来"; v2 被对抗评审否掉核心机制).
// 关键物理事实 (评审核实, MC 1.21.1): 玩家扔物初速仅 0.3 格/tick 沿视线方向, 陡角朝下扔 → 水平
// 分量趋近零 → 物体落回【自己脚下】。所以"站坑边朝坑底扔"物理上根本进不去坑, 落脚下 2s pickup-delay
// 一过被服务器原样吸回 = 就是要修的 bug。_selfDiscarded 标只挡 CLIENT 追捡, 挡不住 SERVER 自动拾取
// (玩家盒水平膨胀 1.0 / 垂直 [脚下-0.5, 头顶+0.5])。
// ── v3 机制 = 扔投精度无关的【走进坑再扔】: ──
//   1. 4 个正方向邻格里找/挖一个"能走进去、站低正好 1 格"的坑 (脚落 standY-1, 满立方地板在 standY-2,
//      两格净空); 平地挖 1 块, 封闭井道挖 2-3 块开侧袋, 已有 1 深坑则 0 挖。严格白名单(绝不挖矿/箱/台),
//      挖前查四邻无液体防灌。
//   2. 机器人【走进坑】站到 standY-1, 低头朝正下方扔 → 物体落脚边坑底 (四壁 1x1 兜住, 扔投方向无关)。
//   3. 机器人【爬出来】回 standY (爬 1 格台阶 = 寻路最平凡操作)。物体停 standY-1, 机器人在 standY:
//      物体顶 standY-0.75 < 拾取盒底 standY-0.5 → 在垂直窗口之外, 服务器不再吸回。
//   4. verify 用【投前/投后/等后】三次库存快照的真实增量记账 (不靠扔计数), 只在没爬出来致反弹时重试一次;
//      诚实报告 (投不动/进不去/反弹 全如实 false)。
// 标记只贴给"弃置名单里的物品 或 落在坑格附近的挖渣", 不再无差别贴 4 格内一切 (评审: 会误杀顺手打的
// 怪的铁掉落 6 分钟)。无可用坑(液体环/挖不动/被封死) → 诚实兜底: 就地扔+走远+复核, 决不假报成功。
// ═══════════════════════════════════════════════════════════════════════════════════════
const DISCARD_TERRAIN_RE = /^(dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium|mud|packed_mud|clay|sand|red_sand|gravel|snow_block|moss_block|stone|cobblestone|mossy_cobblestone|deepslate|cobbled_deepslate|andesite|diorite|granite|tuff|calcite|dripstone_block|sandstone|red_sandstone|smooth_sandstone|netherrack|soul_sand|soul_soil|basalt|smooth_basalt|blackstone|end_stone|[a-z_]*terracotta)$/;
const DISCARD_LIQUID_RE = /^(water|lava|flowing_water|flowing_lava|bubble_column)$/;
// boundingBox 'block' 但不是满高标准立方 / 是基建的方块: 绝不当坑地板(站不平)、绝不当坑壁去挖。
const DISCARD_NONCUBE_RE = /fence|_wall$|_slab$|stairs$|_pane$|_bars$|chain$|_door$|_gate$|carpet$|_snow$|snow_layer|candle|_head$|_skull$|_sign$|_banner$|crafting_table|^chest$|trapped_chest|ender_chest|furnace|barrel|hopper|shulker_box|_bed$|anvil|cauldron|composter|beehive|bee_nest|lectern|grindstone|smithing_table|loom|stonecutter|enchanting_table|brewing_stand|conduit|beacon|spawner|dragon_egg|_ore$|ancient_debris|scaffolding|dirt_path|farmland|_leaves$|pointed_dripstone|amethyst/;

function _isFullCube(b) {
    return !!b && b.boundingBox === 'block' && !DISCARD_LIQUID_RE.test(b.name || '') && !DISCARD_NONCUBE_RE.test(b.name || '');
}

// cheapest dig time for a block with the best tool currently carried (no equip side-effects)
function _bestDigMs(bot, block) {
    let best = Infinity;
    try { best = block.digTime(null, false, false, false); } catch (e) {}
    try {
        for (const it of bot.inventory.items()) {
            try { const t = block.digTime(it.type, false, false, false); if (t < best) best = t; } catch (e) {}
        }
    } catch (e) {}
    return best;
}

async function _interruptibleWait(bot, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (bot.interrupt_code) return false;
        await new Promise(r => setTimeout(r, 100));
    }
    return true;
}

// Survey ONE cardinal neighbour for a STEP-IN pit: a cell the bot can walk into and stand
// exactly one block lower (feet at standY-1), 2-block headroom, solid full-cube floor at
// standY-2. Returns {cx,cz,floorY,standAtY,digs[]} or null. digs = the solids among
// {standY+1, standY, standY-1} that must be broken to open the pocket + entry headroom; each
// must be whitelisted diggable terrain (never ore/infra) — else the whole candidate is rejected.
function _surveyStepIn(bot, cx, cz, standY) {
    const at = (y) => { try { return bot.blockAt(Vec3(cx, y, cz)); } catch (e) { return null; } };
    const isLiquid = (b) => !!b && DISCARD_LIQUID_RE.test(b.name || '');
    const b_up = at(standY + 1), b_head = at(standY), b_stand = at(standY - 1), b_floor = at(standY - 2);
    if (!b_up || !b_head || !b_stand || !b_floor) return null;                 // unloaded — don't trust the column
    if (isLiquid(b_up) || isLiquid(b_head) || isLiquid(b_stand)) return null;  // liquid inside the pocket
    if (!_isFullCube(b_floor)) return null;                                    // need a flat solid cube to stand on
    const digs = [];
    for (const [y, b] of [[standY + 1, b_up], [standY, b_head], [standY - 1, b_stand]]) {
        if (b.boundingBox === 'block') {                                       // solid → must dig to open the pocket
            if (!DISCARD_TERRAIN_RE.test(b.name || '')) return null;           // ore/log/infra — not diggable-as-trash
            if (!Number.isFinite(_bestDigMs(bot, b)) || _bestDigMs(bot, b) > 3500) return null;
            digs.push(y);
        }
    }
    return { cx, cz, floorY: standY - 2, standAtY: standY - 1, digs };
}

// any liquid in the 4 horizontal neighbours of (cx,y,cz)? — digging next to a water/lava source
// floods the fresh pocket, floating the tossed items back into the pickup window.
function _liquidBeside(bot, cx, y, cz) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        try { const b = bot.blockAt(Vec3(cx + dx, y, cz + dz)); if (b && DISCARD_LIQUID_RE.test(b.name || '')) return true; } catch (e) {}
    }
    return false;
}

export async function smartDiscard(bot, items, opts = {}) {
    /**
     * Throw items away FOR GOOD by dropping them at the bottom of a step-in pit (existing or
     * freshly dug 1 block below the bot), so the SERVER's auto-pickup sphere can't re-collect
     * them. Throw-direction independent: the bot stands IN the pit and drops at its own feet.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string|{name,num}|Array} items, one item name, one {name,num} entry, or a batch
     *   array — a batch shares ONE pit and ONE verify pass (use this from loops).
     * @param {{avoidPos?, verify?: boolean, maxDigs?: number}} opts — avoidPos: keep the pit off
     *   this bearing (the caller's walk-back direction); verify (default true): wait out the 2s
     *   pickup delay, recount from real inventory deltas, retry once if anything rebounded;
     *   maxDigs (default 3): max blocks to break to open a pit (0 = only reuse existing 1-deep
     *   holes, 1 = flat-ground dig, 2-3 = enclosed side-pocket).
     * @returns {Promise<boolean>} true iff everything requested left the inventory and (when
     *   verify is on) stayed out.
     * @example
     * await skills.smartDiscard(bot, [{name:'cobblestone', num:200}, 'gravel']);
     **/
    const { avoidPos = null, verify = true, maxDigs = 3 } = opts;
    // normalize + MERGE same-name entries (callers pass one entry per stack), so counts/verify
    // are per-name and duplicates can't mask a rebound.
    const byName = new Map();
    for (const raw of (Array.isArray(items) ? items : [items])) {
        const e = typeof raw === 'string' ? { name: raw, num: -1 } : (raw && raw.name ? { name: raw.name, num: raw.num == null ? -1 : raw.num } : null);
        if (!e) continue;
        const prev = byName.get(e.name);
        if (!prev) byName.set(e.name, { name: e.name, num: e.num });
        else prev.num = (prev.num === -1 || e.num === -1) ? -1 : prev.num + e.num;
    }
    const entries = [...byName.values()];
    if (!entries.length) return false;
    const invCount = (name) => { try { return bot.inventory.items().filter(i => i.name === name).reduce((s, i) => s + i.count, 0); } catch (e) { return 0; } };
    const live = entries.filter(e => invCount(e.name) > 0);
    if (!live.length) {
        log(bot, `You do not have any ${entries.map(e => e.name).join(', ')} to discard.`);
        return false;
    }
    const discardNames = new Set(live.map(e => e.name));

    // Toss `want` of one item straight where the bot currently looks; measures the REAL amount
    // removed via inventory delta (immune to bot.toss's ★C299 hotbar "Can't find X in slots"
    // throw), and never over-discards past `want`.
    const tossCount = async (name, want) => {
        const start = invCount(name);
        const target = want === -1 ? 0 : Math.max(0, start - want);
        let guard = 0, stalls = 0;
        while (invCount(name) > target && guard++ < 128) {
            if (bot.interrupt_code) break;
            const remaining = invCount(name) - target;
            const stack = bot.inventory.items().find(i => i.name === name);
            if (!stack) break;
            const n = Math.min(stack.count, remaining);
            const before = invCount(name);
            try {
                if (n >= stack.count) await bot.tossStack(stack);
                else await bot.toss(stack.type, null, n);
            } catch (err) {
                // hotbar-range partial throw: fall back to a whole-stack toss ONLY if that stays
                // within `want` (never over-discard — pit drops are unrecoverable); else give up.
                if (stack.count <= remaining) { try { await bot.tossStack(stack); } catch (e2) { break; } }
                else { log(bot, `smartDiscard: can't partial-toss ${name} from a hotbar slot without over-discarding — leaving ${remaining}.`); break; }
            }
            await new Promise(r => setTimeout(r, 120));
            if (invCount(name) >= before) { if (++stalls >= 3) break; } else stalls = 0;
        }
        return start - invCount(name);
    };

    // ── choose a step-in pit among the 4 CARDINAL neighbours (diagonals corner-catch on entry)
    const feet0 = bot.entity.position.floored();
    const standY = feet0.y, bx = feet0.x, bz = feet0.z;
    const originY = bot.entity.position.y;   // REAL feet y (may be non-integer on a slab origin) — step-out target
    let avoidDir = null;
    if (avoidPos) {
        const adx = avoidPos.x - bot.entity.position.x, adz = avoidPos.z - bot.entity.position.z;
        const m = Math.hypot(adx, adz);
        if (m > 0.5) avoidDir = [adx / m, adz / m];
    }
    const cands = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const cx = bx + dx, cz = bz + dz;
        const s = _surveyStepIn(bot, cx, cz, standY);
        if (!s) continue;
        if (s.digs.length > maxDigs) continue;
        if (s.digs.some(y => _liquidBeside(bot, cx, y, cz))) continue;          // flood guard
        let score = 10 - s.digs.length * 3;
        if (avoidDir && (dx * avoidDir[0] + dz * avoidDir[1]) > 0.5) score -= 8; // off the walk-back bearing
        cands.push({ dx, dz, cx, cz, digs: s.digs, standAtY: s.standAtY, floorY: s.floorY, score });
    }
    cands.sort((a, b) => b.score - a.score);

    // tag only items we're discarding, or drops landing near the chosen pit cell (dug terrain) —
    // NOT every spawn near the bot (that mis-tags a killed mob's loot for 6 minutes).
    let pitCell = null;
    const registry = bot._selfDiscarded || (bot._selfDiscarded = {});
    const onSpawn = (entity) => {
        if (!entity || entity.name !== 'item' || !bot.entity || !entity.position) return;
        if (entity.position.distanceTo(bot.entity.position) > 5) return;
        const nearPit = pitCell && Math.abs(entity.position.x - (pitCell.x + 0.5)) < 1.4 && Math.abs(entity.position.z - (pitCell.z + 0.5)) < 1.4;
        let named = false;
        // getDroppedItem() may be null/throw on the spawn tick before metadata lands — the nearPit
        // clause already covers our own pit drops; this is only a bonus for named matches.
        try { const it = entity.getDroppedItem && entity.getDroppedItem(); named = !!(it && discardNames.has(it.name)); } catch (e) {}
        if (nearPit || named) registry[entity.id] = Date.now() + SELF_DISCARD_TTL;
    };
    bot.on('entitySpawn', onSpawn);

    // honest fallback when no step-in pit is reachable: toss where we stand, walk well away so the
    // 2s delay expires out of pickup range, then RECOUNT and report the truth (never fake success).
    const fallbackDiscard = async () => {
        log(bot, `smartDiscard: no step-in pit among the 4 neighbours — honest walk-away toss + recount.`);
        const pre = {}; for (const e of live) pre[e.name] = invCount(e.name);
        try { await moveAway(bot, 6); } catch (e) {}
        for (const e of live) { if (bot.interrupt_code) break; await tossCount(e.name, e.num); }
        try { await moveAway(bot, 6); } catch (e) {}
        if (!verify) return true;
        if (!(await _interruptibleWait(bot, 2600))) { log(bot, `smartDiscard: interrupted before walk-away verify — UNVERIFIED.`); return false; }
        let back = 0, gone = 0;
        for (const e of live) { const now = invCount(e.name); gone += Math.max(0, pre[e.name] - now); }
        // rebound = items that are back vs the low-water mark isn't tracked here (we walked away),
        // so report success only if the requested amount actually left and stayed gone.
        for (const e of live) { const now = invCount(e.name); const want = e.num === -1 ? pre[e.name] : Math.min(e.num, pre[e.name]); if (pre[e.name] - now < want) back += want - (pre[e.name] - now); }
        if (back === 0) { log(bot, `smartDiscard: ✅ walk-away discarded ${gone} item(s) — none returned.`); return true; }
        log(bot, `smartDiscard: ✖ walk-away left ${back} item(s) unrelieved (re-collected or un-tossable).`); return false;
    };

    try {
        if (!cands.length) return await fallbackDiscard();

        // ── open the pit at the best candidate (guarded digs; re-check knockback each break)
        let pit = null;
        for (const c of cands.slice(0, 3)) {
            if (bot.interrupt_code) return false;
            pitCell = { x: c.cx, z: c.cz };
            let ok = true;
            for (const y of c.digs) {
                // knockback guard: if the bot got shoved onto the candidate column, don't dig its own floor
                const p = bot.entity.position;
                if (Math.floor(p.x) === c.cx && Math.floor(p.z) === c.cz) { ok = false; break; }
                let b = null; try { b = bot.blockAt(Vec3(c.cx, y, c.cz)); } catch (e) {}
                if (!b || b.boundingBox !== 'block') continue;                          // already open
                if (!DISCARD_TERRAIN_RE.test(b.name || '') || _liquidBeside(bot, c.cx, y, c.cz)) { ok = false; break; }
                let broke = false;
                try { broke = await breakBlockAt(bot, c.cx, y, c.cz); } catch (e) { broke = false; }
                if (!broke) { ok = false; break; }
            }
            if (!ok) continue;
            const after = _surveyStepIn(bot, c.cx, c.cz, standY);                       // confirm it's now a clean 1-deep pocket
            if (after && after.digs.length === 0) { pit = { x: c.cx, z: c.cz, dx: c.dx, dz: c.dz, standAtY: after.standAtY, floorY: after.floorY }; break; }
        }
        if (!pit) return await fallbackDiscard();
        pitCell = { x: pit.x, z: pit.z };

        // move helpers. In-game validation (2026-07-14) showed the raw 'forward' step-in only
        // *sometimes* landed the bot in the pit (moved≈0.1 → tossed at feet dy=0 → re-collected,
        // honestly reported ✖). Pathfinder is the reliable primitive for a precise 1-block down/up
        // move, so lead with a GoalBlock and keep raw-control as the fallback.
        const inCell = (cx, cz, y) => { const p = bot.entity.position; return Math.floor(p.x) === cx && Math.floor(p.z) === cz && Math.abs(p.y - y) < 0.5; };
        const faceCell = async (cx, cz) => { try { await bot.lookAt(Vec3(cx + 0.5, bot.entity.position.y + 1.62, cz + 0.5), true); } catch (e) {} };
        // goToGoal sets its OWN conservative movements internally (a 1-block down/up is a plain walk
        // move — no dig/place needed to reach an already-open adjacent pit), so we just race it against
        // a timeout and cancel the goal if it doesn't land in time.
        const pathTo = async (gx, gy, gz, ms) => {
            try { await Promise.race([goToGoal(bot, new pf.goals.GoalBlock(gx, gy, gz)), new Promise(r => setTimeout(r, ms))]); } catch (e) {}
            try { bot.pathfinder.setGoal(null); } catch (e) {}
        };
        const rawWalk = async (cx, cz, targetY, ms, jump) => {
            await faceCell(cx, cz);
            const end = Date.now() + ms;
            try {
                bot.setControlState('sprint', false); bot.setControlState('forward', true); if (jump) bot.setControlState('jump', true);
                while (Date.now() < end && !bot.interrupt_code) { await new Promise(r => setTimeout(r, 60)); if (inCell(cx, cz, targetY)) break; }
            } catch (e) {} finally { try { bot.setControlState('forward', false); bot.setControlState('jump', false); } catch (e) {} }
        };
        const stepInto = async () => {
            if (bot.interrupt_code) return false;
            await pathTo(pit.x, pit.standAtY, pit.z, 3000);
            if (inCell(pit.x, pit.z, pit.standAtY)) return true;
            await rawWalk(pit.x, pit.z, pit.standAtY, 1600, false);   // pathfinder missed → raw fallback
            return inCell(pit.x, pit.z, pit.standAtY);
        };
        // step-out target y = the REAL origin feet y (not floored standY) so a slab/partial origin
        // floor doesn't false-negative the climb-back check. The tossed pile at the bot's feet is
        // protected only by the 2s (2000ms) thrower pickup delay, so the bot MUST clear the pit fast.
        const stepOut = async () => {
            await pathTo(bx, standY, bz, 2500);
            if (inCell(bx, bz, originY)) return true;
            await rawWalk(bx, bz, originY, 1500, true);              // pathfinder missed → raw jump fallback
            return inCell(bx, bz, originY);
        };

        const pitDesc = `pit @(${pit.x},${pit.standAtY},${pit.z})`;
        if (bot.interrupt_code) return false;
        if (!(await stepInto())) { log(bot, `smartDiscard: couldn't step into ${pitDesc} — honest fallback.`); return await fallbackDiscard(); }

        // ── snapshot the baseline AFTER entering (captures any dug-block pickup). `want` is fixed
        // ONCE from this baseline; success is measured as ONE metric — net items removed and STAYED
        // removed (= preToss - inventory-after-the-2s-wait) ≥ want — which folds "couldn't toss" and
        // "came back" into the same number and can't false-pass or false-fail a finite-num request.
        const preToss = {}, want = {};
        for (const e of live) { preToss[e.name] = invCount(e.name); want[e.name] = e.num === -1 ? preToss[e.name] : Math.min(e.num, preToss[e.name]); }
        const removedNet = (name) => preToss[name] - invCount(name);
        try { await bot.lookAt(Vec3(bot.entity.position.x, bot.entity.position.y - 1, bot.entity.position.z), true); } catch (e) {}
        for (const e of live) { if (bot.interrupt_code) break; await tossCount(e.name, want[e.name]); }
        // exit IMMEDIATELY — no dwell sleep; every ms here is ms the bot stands on the tossed pile
        // inside the 2s pickup window. (Accounting reads live invCount, so no settle-sleep is needed.)
        const stepped = await stepOut();               // climb the 1-block step home (within the 2s grace)
        if (!stepped) log(bot, `smartDiscard: ⚠ didn't confirm step-out of ${pitDesc}; verify will judge.`);

        if (!verify) {
            let t = 0; for (const e of live) t += removedNet(e.name);
            log(bot, `smartDiscard: tossed ${t} item(s) into ${pitDesc} (unverified).`);
            return t > 0;
        }

        // ── verify past the 2s thrower delay; ONE retry (re-enter, top up the deficit) if short
        const shortfall = () => { let s = 0; for (const e of live) s += Math.max(0, want[e.name] - removedNet(e.name)); return s; };
        const waited = await _interruptibleWait(bot, 2600);
        if (!waited) { log(bot, `smartDiscard: interrupted before verify — ${pitDesc}, UNVERIFIED.`); return false; }
        let short = shortfall();
        if (short > 0 && !bot.interrupt_code) {
            // deficit = something rebounded (incomplete exit) or a hotbar-partial couldn't toss —
            // re-enter the SAME pit, top up exactly the remaining deficit, climb out, re-verify ONCE.
            log(bot, `smartDiscard: ⚠ ${short} item(s) short (rebound / partial) — re-dropping into ${pitDesc}.`);
            if (await stepInto()) {
                try { await bot.lookAt(Vec3(bot.entity.position.x, bot.entity.position.y - 1, bot.entity.position.z), true); } catch (e) {}
                for (const e of live) { const deficit = want[e.name] - removedNet(e.name); if (deficit > 0 && !bot.interrupt_code) await tossCount(e.name, deficit); }
                await stepOut();
                if (!(await _interruptibleWait(bot, 2600))) { log(bot, `smartDiscard: interrupted before retry verify — ${pitDesc}, UNVERIFIED.`); return false; }
            }
            short = shortfall();
        }
        let tossedTotal = 0; for (const e of live) tossedTotal += removedNet(e.name);
        if (short === 0) log(bot, `smartDiscard: ✅ discarded ${tossedTotal} item(s) into ${pitDesc} — nothing re-collected.`);
        else log(bot, `smartDiscard: ✖ ${pitDesc} — ${short} item(s) NOT relieved (untossable or re-collected).`);
        return short === 0;
    } finally {
        try { bot.setControlState('forward', false); bot.setControlState('jump', false); bot.setControlState('back', false); } catch (e) {}
        bot.off('entitySpawn', onSpawn);
        pruneSelfDiscarded(bot);
    }
}

export async function putInChest(bot, itemName, num=-1) {
    /**
     * Put the given item in the nearest chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to put in the chest.
     * @param {number} num, the number of items to put in the chest. Defaults to -1, which puts all items.
     * @returns {Promise<boolean>} true if the item was put in the chest, false otherwise.
     * @example
     * await skills.putInChest(bot, "oak_log");
     **/
    let chest = await world.getNearestBlockAsync(bot, 'chest', 64);   // ★B定点32→64(0714)
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    let item = bot.inventory.findInventoryItem(itemName);
    if (!item) {
        log(bot, `You do not have any ${itemName} to put in the chest.`);
        return false;
    }
    let to_put = num === -1 ? item.count : Math.min(num, item.count);
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const chestContainer = await bot.openContainer(chest);
    await chestContainer.deposit(item.type, null, to_put);
    await chestContainer.close();
    log(bot, `Successfully put ${to_put} ${itemName} in the chest.`);
    return true;
}

export async function takeFromChest(bot, itemName, num=-1) {
    /**
     * Take the given item from the nearest chest, potentially from multiple slots.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to take from the chest.
     * @param {number} num, the number of items to take from the chest. Defaults to -1, which takes all items.
     * @returns {Promise<boolean>} true if the item was taken from the chest, false otherwise.
     * @example
     * await skills.takeFromChest(bot, "oak_log");
     * **/
    let chest = await world.getNearestBlockAsync(bot, 'chest', 64);   // ★B定点32→64(0714)
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const chestContainer = await bot.openContainer(chest);
    
    // Find all matching items in the chest
    let matchingItems = chestContainer.containerItems().filter(item => item.name === itemName);
    if (matchingItems.length === 0) {
        log(bot, `Could not find any ${itemName} in the chest.`);
        await chestContainer.close();
        return false;
    }
    
    let totalAvailable = matchingItems.reduce((sum, item) => sum + item.count, 0);
    let remaining = num === -1 ? totalAvailable : Math.min(num, totalAvailable);
    let totalTaken = 0;
    
    // Take items from each slot until we've taken enough or run out
    for (const item of matchingItems) {
        if (remaining <= 0) break;
        
        let toTakeFromSlot = Math.min(remaining, item.count);
        await chestContainer.withdraw(item.type, null, toTakeFromSlot);
        
        totalTaken += toTakeFromSlot;
        remaining -= toTakeFromSlot;
    }
    
    await chestContainer.close();
    log(bot, `Successfully took ${totalTaken} ${itemName} from the chest.`);
    return totalTaken > 0;
}

export async function viewChest(bot) {
    /**
     * View the contents of the nearest chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the chest was viewed, false otherwise.
     * @example
     * await skills.viewChest(bot);
     * **/
    let chest = await world.getNearestBlockAsync(bot, 'chest', 64);   // ★B定点32→64(0714)
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const chestContainer = await bot.openContainer(chest);
    let items = chestContainer.containerItems();
    if (items.length === 0) {
        log(bot, `The chest is empty.`);
    }
    else {
        log(bot, `The chest contains:`);
        for (let item of items) {
            log(bot, `${item.count} ${item.name}`);
        }
    }
    await chestContainer.close();
    return true;
}

export async function consume(bot, itemName="") {
    /**
     * Eat/drink the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item to eat/drink.
     * @returns {Promise<boolean>} true if the item was eaten, false otherwise.
     * @example
     * await skills.eat(bot, "apple");
     **/
    // ★EAT-VOID 第二刀之一: 进食互斥 (2026-07-04 07:42 x10 实录 — auto_eat 反射与 feedUp 猎杀
    // 应急吃并发各调 consume, mineflayer 对第二个 bot.consume() 直接取消第一个:
    // 'Consuming cancelled due to calling bot.consume() again', 谁也吃不完 1.61s, food 钉 0)。
    // 全仓所有食客均经本函数(唯一裸 bot.consume 在下方), 窗口内后来者等首个结果, 不发第二包。
    if (bot._eatInFlight) {
        try { return await bot._eatInFlight; } catch (e) { return false; }
    }
    const _run = _consumeOnce(bot, itemName);
    bot._eatInFlight = _run;
    try { return await _run; }
    finally { bot._eatInFlight = null; }
}

async function _consumeOnce(bot, itemName="") {
    let item, name;
    if (itemName && typeof itemName === 'object') {
        item = itemName;
        name = item.name;
    } else if (itemName) {
        item = bot.inventory.findInventoryItem(itemName);
        name = itemName;
    }
    if (!item) {
        log(bot, `You do not have any ${name} to eat.`);
        return false;
    }
    const equipRes = await tickConfirm.equipConfirmed(bot, item, 'hand');
    if (!equipRes.ok) {
        log(bot, `Failed to equip ${item.name} to consume: ${equipRes.reason}.`);
        return false;
    }
    // ★EAT-VOID 根修 (2026-07-02 13:57-14:01 实录: 'famine — eating mutton (emergency tier)'
    // 连报 4 分钟而 food 恒=6): mineflayer 的 bot.consume() 在 heldItemChanged / set_cooldown
    // 上也会把 eatingTask "正常" resolve (lib/plugins/inventory.js:77-97) — 任何反射在 1.61s
    // 进食窗内换手持(tool_keeper 装工具/战斗装剑)或触发冷却包, consume 都无异常返回,
    // "没 throw" ≠ "吃进去了"。两步治:
    //   ① 进食窗内短暂压制移动 (~1.8s: 停 pathfinder + 周期 clearControlStates 保持静止;
    //      honor interrupt_code — 中断请求一来立即放开身体, 绝不跟保命反射抢);
    //   ② 成败只认 bot.food 差值: 没涨 = 如实 false + 日志; 连续 3 次没涨记 ★EAT-VOID
    //      (计数挂 bot 实例, 无模块级状态), 便于观测哪个反射在偷进食窗。
    const foodBefore = bot.food;
    const nonHunger = /potion|milk_bucket/.test(item.name);   // 合法不涨 food 的消耗品
    // ★EAT-VOID 第二刀之二: 手部锁 — 4a6d7cf 只压制了移动, 但杀手是"换手持"本身
    // (tool_keeper/战斗/猎杀经 tickConfirm.equipConfirmed 在 1.61s 窗内装剑 → eatingTask
    // 被 mineflayer 静默 resolve)。equipConfirmed 现会对 hand 目的地在此窗内等待收尾。
    // ★EAT-VOID 第四刀: 副手盾卸载 (2026-07-05 x31 定案 — 自带诊断字段收网: 全部 streak
    // 共同项 offhand=shield; 05:44 盾上身前进食零失败, 每次重启后盾未及回装的窗口连吃成功。
    // 副手盾与 consume 的 use-item 通道冲突, 'Promise timed out' 连环)。吃前卸盾入包,
    // 吃完(成败都)回装; 单次代价 ~200ms, 换整类故障消失。
    let _shieldWasOff = false;
    try {
        const _off = bot.inventory.slots[45];
        if (_off && _off.name === 'shield') { _shieldWasOff = true; await bot.unequip('off-hand'); }
    } catch (e) {}
    bot._eatingItem = item.name;
    bot._eatingUntil = Date.now() + 2600;
    try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
    try { bot.pathfinder && bot.pathfinder.setGoal(null); } catch (e) {}
    try { bot.clearControlStates(); } catch (e) {}
    let eatGuardOn = true;
    const stillGuard = (async () => {
        const until = Date.now() + 1800;
        while (eatGuardOn && Date.now() < until && !bot.interrupt_code) {
            try { bot.clearControlStates(); } catch (e) {}
            await new Promise(r => setTimeout(r, 150));
        }
    })();
    let consumeErr = null;
    try { await bot.consume(); } catch (err) { consumeErr = err; }
    eatGuardOn = false;
    try { await stillGuard; } catch (e) {}
    bot._eatingUntil = 0;   // 吃完(或失败)立即释放手部锁, 不占战斗反射的拍
    bot._eatingItem = null;
    // ★第四刀回装: 盾回副手 (成败路径都走到这里; equip 目的地非 'hand' 不撞手部锁)
    if (_shieldWasOff) {
        try { const _sh = bot.inventory.items().find(i => i.name === 'shield'); if (_sh) await bot.equip(_sh, 'off-hand'); } catch (e) {}
    }
    if (nonHunger) {
        if (consumeErr) { log(bot, `Failed to consume ${item.name}: ${consumeErr.message}.`); return false; }
        log(bot, `Consumed ${item.name}.`);
        return true;
    }
    // 等 update_health 落地再判差值 (吃完事件与 food 包几乎同刻; 最多再等 ~900ms)
    for (let i = 0; i < 6 && bot.food <= foodBefore && !bot.interrupt_code; i++) {
        await new Promise(r => setTimeout(r, 150));
    }
    if (bot.food > foodBefore || foodBefore >= 20) {
        bot._eatVoidStreak = 0;
        log(bot, `Consumed ${item.name} (food ${foodBefore} -> ${bot.food}).`);
        return true;
    }
    bot._eatVoidStreak = (bot._eatVoidStreak || 0) + 1;
    const why = consumeErr ? consumeErr.message : 'eat window resolved with no effect (held-item swap / cooldown packet mid-eat)';
    log(bot, `Tried to eat ${item.name} but food did not rise (${foodBefore} -> ${bot.food}) — ${why}. Not counting it as eaten.`);
    if (bot._eatVoidStreak >= 3) {
        log(bot, `★EAT-VOID x${bot._eatVoidStreak}: consume keeps completing with zero food gain — something is stealing the 1.6s eat window.`);
        try {
            // ★2026-07-05 自带诊断 (05:57 x17 复发 'Promise timed out' 自愈, 触发因子未实证 —
            // 窗口残留/盾牌 use-item 竞争都是嫌疑): 把现场关键态钉进标记行, 下次发作免猜。
            let _diag = '';
            try {
                _diag = ` win=${bot.currentWindow ? (bot.currentWindow.type || 'open') : 'none'}`
                    + ` using=${!!bot.usingHeldItem} held=${bot.heldItem ? bot.heldItem.name : 'none'}`
                    + ` offhand=${(bot.inventory.slots[45] && bot.inventory.slots[45].name) || 'none'}`;
            } catch (e) {}
            fs_dz.appendFileSync('bots/_supervisor/progress.txt',
                `[${new Date().toISOString()}] ★EAT-VOID x${bot._eatVoidStreak} item=${item.name} food=${bot.food} hp=${Math.round(bot.health || 0)} err=${consumeErr ? consumeErr.message : 'silent-void'}${_diag}\n`);
        } catch (e) {}
    }
    return false;
}


export async function giveToPlayer(bot, itemType, username, num=1) {
    /**
     * Give one of the specified item to the specified player
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemType, the name of the item to give.
     * @param {string} username, the username of the player to give the item to.
     * @param {number} num, the number of items to give. Defaults to 1.
     * @returns {Promise<boolean>} true if the item was given, false otherwise.
     * @example
     * await skills.giveToPlayer(bot, "oak_log", "player1");
     **/
    if (bot.username === username) {
        log(bot, `You cannot give items to yourself.`);
        return false;
    }
    let player = bot.players[username]?.entity
    if (!player) {
        log(bot, `Could not find ${username}.`);
        return false;
    }
    await goToPlayer(bot, username, 3);
    // if we are 2 below the player
    log(bot, bot.entity.position.y, player.position.y);
    if (bot.entity.position.y < player.position.y - 1) {
        await goToPlayer(bot, username, 1);
    }
    // if we are too close, make some distance
    if (bot.entity.position.distanceTo(player.position) < 2) {
        let too_close = true;
        let start_moving_away = Date.now();
        await moveAwayFromEntity(bot, player, 2);
        while (too_close && !bot.interrupt_code) {
            await new Promise(resolve => setTimeout(resolve, 500));
            too_close = bot.entity.position.distanceTo(player.position) < 5;
            if (too_close) {
                await moveAwayFromEntity(bot, player, 5);
            }
            if (Date.now() - start_moving_away > 3000) {
                break;
            }
        }
        if (too_close) {
            log(bot, `Failed to give ${itemType} to ${username}, too close.`);
            return false;
        }
    }

    await bot.lookAt(player.position);
    if (await discard(bot, itemType, num)) {
        let given = false;
        bot.once('playerCollect', (collector, collected) => {
            console.log(collected.name);
            if (collector.username === username) {
                log(bot, `${username} received ${itemType}.`);
                given = true;
            }
        });
        let start = Date.now();
        while (!given && !bot.interrupt_code) {
            await new Promise(resolve => setTimeout(resolve, 500));
            if (given) {
                return true;
            }
            if (Date.now() - start > 3000) {
                break;
            }
        }
    }
    log(bot, `Failed to give ${itemType} to ${username}, it was never received.`);
    return false;
}

/**
 * Attempt to unstick the bot by jumping and moving in a random direction.
 * @param {MinecraftBot} bot - reference to the minecraft bot.
 * @returns {Promise<boolean>} true if movement was attempted.
 */
export async function stepEdgeAssist(bot, opts = {}) {
    const {
        why = 'path-stuck',
        goal = null,
        moveMs = 980,
        runupMs = 260,
        owner = 'step-edge-assist',
    } = opts;
    if (!bot || !bot.entity || bot.targetDigBlock || bot._mineMotionActiveDig) return false;
    if (bot._bodyMoveLockUntil && Date.now() < bot._bodyMoveLockUntil && bot._bodyMoveLockOwner !== owner) return false;

    bot._stepEdgeAssistCooldowns = bot._stepEdgeAssistCooldowns || {};
    const now = Date.now();
    const solid = (b) => b && b.boundingBox === 'block';
    const PASSABLE = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow']);
    const open = (b) => !b || b.boundingBox === 'empty' || PASSABLE.has(b.name || '');
    const bad = (b) => b && /water|lava|fire|cactus|magma|campfire|berry_bush/.test(b.name || '');
    const stationStep = (b) => b && /crafting_table|furnace|blast_furnace|smoker|chest|barrel|bed|anvil|enchanting_table|grindstone|stonecutter|loom|cartography_table|smithing_table|fletching_table|lectern|composter/i.test(b.name || '');
    const hasPick = () => bot.inventory && bot.inventory.items().some(it => /_pickaxe$/.test(it.name || ''));
    const clearableStepRoof = (b) => {
        if (!b || b.boundingBox !== 'block') return false;
        if (bad(b) || stationStep(b) || /bedrock|obsidian|end_portal|nether_portal/.test(b.name || '')) return false;
        const stony = /stone|deepslate|andesite|diorite|granite|tuff|_ore$|cobble/.test(b.name || '');
        return !stony || hasPick();
    };
    const blockObj = (b) => b ? { name: b.name, x: b.position.x, y: b.position.y, z: b.position.z, bb: b.boundingBox } : null;
    const envSnap = () => {
        const c = bot.entity.position.floored();
        const out = [];
        for (const dy of [-1, 0, 1, 2]) {
            for (const dz of [-1, 0, 1]) {
                for (const dx of [-1, 0, 1]) {
                    const b = bot.blockAt(c.offset(dx, dy, dz));
                    out.push({ d: [dx, dy, dz], n: b ? b.name : null, bb: b ? b.boundingBox : null });
                }
            }
        }
        return out;
    };
    const dirFromGoal = () => {
        if (!goal) return null;
        const gp = goal.entity && goal.entity.pos ? goal.entity.pos : goal;
        if (typeof gp.x !== 'number' || typeof gp.z !== 'number') return null;
        const p = bot.entity.position;
        const dx0 = gp.x - p.x, dz0 = gp.z - p.z;
        if (Math.hypot(dx0, dz0) < 0.3) return null;
        return Math.abs(dx0) >= Math.abs(dz0) ? [Math.sign(dx0) || 1, 0] : [0, Math.sign(dz0) || 1];
    };
    const dirFromYaw = () => {
        const yaw = bot.entity.yaw || 0;
        const dx = Math.abs(Math.sin(yaw)) >= Math.abs(Math.cos(yaw)) ? (Math.sign(-Math.sin(yaw)) || 1) : 0;
        const dz = dx ? 0 : (Math.sign(Math.cos(yaw)) || 1);
        return [dx, dz];
    };
    const p0 = bot.entity.position.clone();
    const cell = p0.floored();
    const ownHead0 = bot.blockAt(cell.offset(0, 1, 0));
    let ownAbove0 = bot.blockAt(cell.offset(0, 2, 0));
    if (!open(ownHead0)) {
        motionAudit(bot, 'step_edge.blocked', {
            why,
            goal,
            reason: 'own-head-blocked',
            from: { x: cell.x, y: cell.y, z: cell.z },
            ownHead: blockObj(ownHead0),
            ownAbove: blockObj(ownAbove0),
            env: envSnap(),
        });
        return false;
    }
    if (!open(ownAbove0)) {
        const clearable = clearableStepRoof(ownAbove0);
        motionAudit(bot, 'step_edge.own_above_notch.begin', {
            why,
            goal,
            clearable,
            block: blockObj(ownAbove0),
            from: { x: cell.x, y: cell.y, z: cell.z },
            env: envSnap(),
        });
        let ok = false;
        let error = null;
        if (clearable) {
            try {
                try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
                try { bot.clearControlStates(); } catch (e) {}
                bot._bodyDigLockOwner = `${owner}:own-above-notch`;
                bot._bodyDigLockUntil = Date.now() + 5200;
                try { if (bot.tool && bot.tool.equipForBlock) await bot.tool.equipForBlock(ownAbove0); } catch (e) {}
                try { await bot.lookAt(ownAbove0.position.offset(0.5, 0.5, 0.5), true); } catch (e) {}
                await Promise.race([
                    gazeHold(bot, ownAbove0, bot.dig(ownAbove0, true)),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('own-above-notch-timeout')), 4800)),
                ]);
                await new Promise(r => setTimeout(r, 120));
                ownAbove0 = bot.blockAt(cell.offset(0, 2, 0));
                ok = open(ownAbove0);
            } catch (e) {
                error = e && e.message ? e.message : String(e);
            } finally {
                try { bot.clearControlStates(); } catch (e) {}
                if (bot._bodyDigLockOwner === `${owner}:own-above-notch`) {
                    bot._bodyDigLockOwner = null;
                    bot._bodyDigLockUntil = 0;
                }
            }
        }
        motionAudit(bot, 'step_edge.own_above_notch.end', {
            why,
            goal,
            ok,
            error,
            after: blockObj(ownAbove0),
            from: { x: cell.x, y: cell.y, z: cell.z },
        });
        if (!ok) {
            motionAudit(bot, 'step_edge.blocked', {
                why,
                goal,
                reason: clearable ? 'own-above-notch-failed' : 'own-above-unclearable',
                from: { x: cell.x, y: cell.y, z: cell.z },
                ownHead: blockObj(ownHead0),
                ownAbove: blockObj(ownAbove0),
                env: envSnap(),
            });
            return false;
        }
    }

    const dirs = [];
    for (const d of [dirFromGoal(), dirFromYaw(), [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (!d || (!d[0] && !d[1])) continue;
        if (!dirs.some(x => x[0] === d[0] && x[1] === d[1])) dirs.push(d);
    }
    const candidates = [];
    const rejected = [];
    for (const [dx, dz] of dirs) {
        const foot = bot.blockAt(cell.offset(dx, 0, dz));
        const head = bot.blockAt(cell.offset(dx, 1, dz));
        const above = bot.blockAt(cell.offset(dx, 2, dz));
        const below = bot.blockAt(cell.offset(dx, -1, dz));
        const target = cell.offset(dx, 0, dz);
        const dist = Math.hypot(p0.x - (target.x + 0.5), p0.z - (target.z + 0.5));
        const reason = (() => {
            if (dist > 1.85) return 'too-far';
            if (!solid(foot)) return 'front-not-step';
            if (stationStep(foot)) return 'functional-station';
            if (!open(head)) return 'target-foot-blocked';
            if (!open(above)) return 'target-head-blocked';
            if (bad(foot) || bad(head) || bad(above) || bad(below)) return 'hazard';
            return null;
        })();
        const key = `${cell.x},${cell.y},${cell.z}->${target.x},${target.y},${target.z}:${reason || 'step'}:${foot ? foot.name : 'null'}:${head ? head.name : 'null'}:${above ? above.name : 'null'}`;
        if (reason) {
            rejected.push({
                dir: [dx, dz],
                reason,
                target: { x: target.x, y: target.y, z: target.z },
                foot: blockObj(foot),
                head: blockObj(head),
                above: blockObj(above),
                below: blockObj(below),
            });
            continue;
        }
        const cooledUntil = bot._stepEdgeAssistCooldowns[key] || 0;
        if (cooledUntil > now) {
            rejected.push({
                dir: [dx, dz],
                reason: 'cooldown',
                cooldownMs: cooledUntil - now,
                target: { x: target.x, y: target.y, z: target.z },
                foot: blockObj(foot),
                head: blockObj(head),
                above: blockObj(above),
                below: blockObj(below),
            });
            continue;
        }
        candidates.push({ dx, dz, target, foot, head, above, below, dist });
    }
    candidates.sort((a, b) => a.dist - b.dist);
    const c = candidates[0];
    if (!c) {
        // C227: no walkable step-up candidate. If a clearable wall blocks the
        // travel direction (2-block wall: front foot+head both solid, floor
        // below), dig a doorway through it instead of giving up and letting the
        // body jump-flail (pathfinder parkour kept jumping at the wall). Only
        // the goal/yaw direction — never dig sideways/backward walls.
        const wallDirs = [];
        for (const d of [dirFromGoal(), dirFromYaw()]) {
            if (!d || (!d[0] && !d[1])) continue;
            if (!wallDirs.some(x => x[0] === d[0] && x[1] === d[1])) wallDirs.push(d);
        }
        for (const [dx, dz] of wallDirs) {
            const wFoot = bot.blockAt(cell.offset(dx, 0, dz));
            const wHead = bot.blockAt(cell.offset(dx, 1, dz));
            const wBelow = bot.blockAt(cell.offset(dx, -1, dz));
            // a real 2-block wall ahead, both blocks clearable (pick-gated, no
            // hazard/bedrock/station), and a solid non-hazard floor to land on.
            if (!solid(wFoot) || !solid(wHead)) continue;
            if (!clearableStepRoof(wFoot) || !clearableStepRoof(wHead)) continue;
            if (!solid(wBelow) || bad(wBelow)) continue;
            const wallKey = `wall:${cell.x},${cell.y},${cell.z}->${dx},${dz}`;
            if ((bot._stepEdgeAssistCooldowns[wallKey] || 0) > now) continue;
            const target = cell.offset(dx, 0, dz);
            motionAudit(bot, 'step_edge.wall_dig.begin', {
                why, goal, dir: [dx, dz],
                foot: blockObj(wFoot), head: blockObj(wHead), below: blockObj(wBelow),
                from: { x: cell.x, y: cell.y, z: cell.z }, env: envSnap(),
            });
            let dugOk = false;
            let derr = null;
            try {
                bot._bodyDigLockOwner = `${owner}:wall-dig`;
                bot._bodyDigLockUntil = Date.now() + 12000;
                try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
                try { bot.clearControlStates(); } catch (e) {}
                // dig head first (avoid the head-block dropping onto us), then foot
                for (const wp of [cell.offset(dx, 1, dz), cell.offset(dx, 0, dz)]) {
                    const fresh = bot.blockAt(wp);
                    if (!fresh || fresh.boundingBox !== 'block') continue;
                    if (!clearableStepRoof(fresh)) continue;
                    try { if (bot.tool && bot.tool.equipForBlock) await bot.tool.equipForBlock(fresh); } catch (e) {}
                    try { await bot.lookAt(fresh.position.offset(0.5, 0.5, 0.5), true); } catch (e) {}
                    await Promise.race([
                        gazeHold(bot, fresh, bot.dig(fresh, true)),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('wall-dig-timeout')), 5200)),
                    ]);
                    await new Promise(r => setTimeout(r, 120));
                }
                const aFoot = bot.blockAt(cell.offset(dx, 0, dz));
                const aHead = bot.blockAt(cell.offset(dx, 1, dz));
                dugOk = open(aFoot) && open(aHead);
                if (dugOk) {
                    // walk into the cleared doorway so the next plan starts past it
                    try { await bot.lookAt(target.offset(0.5, 1.0, 0.5), true); } catch (e) {}
                    bot.setControlState('forward', true);
                    const ws = Date.now();
                    while (Date.now() - ws < 750) {
                        const q = bot.entity.position;
                        if (Math.floor(q.x) === target.x && Math.floor(q.z) === target.z) break;
                        await new Promise(r => setTimeout(r, 45));
                    }
                    try { bot.clearControlStates(); } catch (e) {}
                }
            } catch (e) {
                derr = e && e.message ? e.message : String(e);
            } finally {
                try { bot.clearControlStates(); } catch (e) {}
                if (bot._bodyDigLockOwner === `${owner}:wall-dig`) {
                    bot._bodyDigLockOwner = null;
                    bot._bodyDigLockUntil = 0;
                }
            }
            if (!dugOk) bot._stepEdgeAssistCooldowns[wallKey] = Date.now() + 12000;
            motionAudit(bot, 'step_edge.wall_dig.end', {
                why, goal, ok: dugOk, error: derr, dir: [dx, dz],
                from: { x: cell.x, y: cell.y, z: cell.z }, env: envSnap(),
            });
            if (dugOk) return true;
        }
        motionAudit(bot, 'step_edge.none', {
            why,
            goal,
            from: { x: cell.x, y: cell.y, z: cell.z },
            rejected: rejected.slice(0, 6),
            env: envSnap(),
        });
        return false;
    }
    const targetKey = `${cell.x},${cell.y},${cell.z}->${c.target.x},${c.target.y},${c.target.z}:step:${c.foot ? c.foot.name : 'null'}:${c.head ? c.head.name : 'null'}:${c.above ? c.above.name : 'null'}`;
    const targetDist = (p) => Math.hypot(p.x - (c.target.x + 0.5), p.z - (c.target.z + 0.5));
    const roseEnough = (p) => Math.floor(p.y) > cell.y || p.y > p0.y + 0.72;
    const settledInTarget = (p) => Math.floor(p.x) === c.target.x && Math.floor(p.z) === c.target.z && targetDist(p) <= 0.9;
    const stepSucceeded = (p) => roseEnough(p) && settledInTarget(p);

    motionAudit(bot, 'step_edge.begin', {
        why,
        goal,
        dir: [c.dx, c.dz],
        from: { x: cell.x, y: cell.y, z: cell.z },
        target: { x: c.target.x, y: c.target.y, z: c.target.z },
        foot: blockObj(c.foot),
        head: blockObj(c.head),
        above: blockObj(c.above),
        below: blockObj(c.below),
        env: envSnap(),
    });
    let ok = false;
    let maxY = p0.y;
    let p1 = p0;
    try {
        bot._bodyMoveLockOwner = owner;
        bot._bodyMoveLockUntil = Date.now() + moveMs + runupMs + 1200;
        try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
        try { bot.clearControlStates(); } catch (e) {}
        try { await bot.lookAt(c.target.offset(0.5, 1.05, 0.5), true); } catch (e) {}
        if (runupMs > 0) {
            bot.setControlState('sneak', true);
            bot.setControlState('back', true);
            await new Promise(r => setTimeout(r, runupMs));
            try { bot.clearControlStates(); } catch (e) {}
            await new Promise(r => setTimeout(r, 80));
        }
        await bot.lookAt(c.target.offset(0.5, 1.15, 0.5), true);
        bot.setControlState('sprint', false);
        bot.setControlState('forward', true);
        bot.setControlState('jump', true);
        const start = Date.now();
        while (Date.now() - start < moveMs) {
            const p = bot.entity.position;
            if (p.y > maxY) maxY = p.y;
            if (stepSucceeded(p)) break;
            await new Promise(r => setTimeout(r, 45));
        }
        try { bot.clearControlStates(); } catch (e) {}
        await new Promise(r => setTimeout(r, 160));
        p1 = bot.entity.position.clone();
        if (roseEnough(p1) && !settledInTarget(p1)) {
            motionAudit(bot, 'step_edge.edge_miss', {
                why,
                goal,
                target: { x: c.target.x, y: c.target.y, z: c.target.z },
                at: { x: +p1.x.toFixed(3), y: +p1.y.toFixed(3), z: +p1.z.toFixed(3) },
                dist: +targetDist(p1).toFixed(3),
                floor: { x: Math.floor(p1.x), y: Math.floor(p1.y), z: Math.floor(p1.z) },
                recovery: 'center-press',
                env: envSnap(),
            });
            try {
                await bot.lookAt(c.target.offset(0.5, 1.15, 0.5), true);
                bot.setControlState('sprint', false);
                bot.setControlState('jump', false);
                bot.setControlState('forward', true);
                await new Promise(r => setTimeout(r, 420));
            } finally {
                try { bot.clearControlStates(); } catch (e) {}
            }
            await new Promise(r => setTimeout(r, 120));
            p1 = bot.entity.position.clone();
        }
        ok = stepSucceeded(p1);
        if (!ok) bot._stepEdgeAssistCooldowns[targetKey] = Date.now() + 8000;
        return ok;
    } catch (e) {
        bot._stepEdgeAssistCooldowns[targetKey] = Date.now() + 8000;
        motionAudit(bot, 'step_edge.err', { why, goal, error: e && e.message ? e.message : String(e), env: envSnap() });
        return false;
    } finally {
        try { bot.clearControlStates(); } catch (e) {}
        if (bot._bodyMoveLockOwner === owner) {
            bot._bodyMoveLockOwner = null;
            bot._bodyMoveLockUntil = 0;
        }
        motionAudit(bot, 'step_edge.end', {
            why,
            goal,
            ok,
            target: { x: c.target.x, y: c.target.y, z: c.target.z },
            targetBlocks: {
                foot: blockObj(bot.blockAt(c.target)),
                head: blockObj(bot.blockAt(c.target.offset(0, 1, 0))),
                above: blockObj(bot.blockAt(c.target.offset(0, 2, 0))),
                below: blockObj(bot.blockAt(c.target.offset(0, -1, 0))),
            },
            from: { x: +p0.x.toFixed(3), y: +p0.y.toFixed(3), z: +p0.z.toFixed(3) },
            to: { x: +p1.x.toFixed(3), y: +p1.y.toFixed(3), z: +p1.z.toFixed(3) },
            maxRise: +(maxY - p0.y).toFixed(3),
            dist: +targetDist(p1).toFixed(3),
            settledInTarget: settledInTarget(p1),
            env: envSnap(),
        });
    }
}

async function attemptUnstick(bot) {
    const pos = bot.entity.position;
    
    // Check if standing on dangerous block
    const blockBelow = bot.blockAt(pos.offset(0, -1, 0));
    const isOnLava = blockBelow && (blockBelow.name.includes('lava'));
    
    // Random direction
    const angle = Math.random() * Math.PI * 2;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    
    // Look in the direction we want to move
    await bot.look(Math.atan2(-dx, -dz), 0);
    
    // Jump first
    bot.setControlState('jump', true);
    await new Promise(r => setTimeout(r, 150));
    bot.setControlState('jump', false);
    
    // Move forward briefly
    bot.setControlState('forward', true);
    bot.setControlState('sprint', true);
    await new Promise(r => setTimeout(r, 400));
    bot.setControlState('forward', false);
    bot.setControlState('sprint', false);
    
    // If on lava, keep jumping
    if (isOnLava) {
        for (let i = 0; i < 3; i++) {
            bot.setControlState('jump', true);
            bot.setControlState('forward', true);
            await new Promise(r => setTimeout(r, 200));
            bot.setControlState('jump', false);
            bot.setControlState('forward', false);
            await new Promise(r => setTimeout(r, 100));
        }
    }
    
    await new Promise(r => setTimeout(r, 300));
    return true;
}

function randomUnstickSkipMode(bot, goalInfo = null) {
    try {
        const skill = bot && (bot._currentSkill || '');
        const mob = bot && bot._mobility ? bot._mobility.state || '' : '';
        const p = bot && bot.entity && bot.entity.position;
        if (/branchMine|surfaceUp|mineDiamonds|prepNether|missionNether/.test(skill) && p && p.y < 72) return 'enclosed-mining';
        if (/MAROONED|POCKET|ENTOMBED/.test(mob)) return 'mobility-contained';
        if (bot && bot._mobility && bot._mobility.enclosed) return 'enclosed-mining';
        const isItemGoal = !!(goalInfo && goalInfo.entity && goalInfo.entity.name === 'item');
        const normalFood = bot && bot.inventory && bot.inventory.items().some(i =>
            i && i.name &&
            /beef|porkchop|chicken|mutton|rabbit|cod|salmon|bread|apple|berries|potato|carrot|melon|cookie|pumpkin_pie|beetroot|mushroom_stew|rabbit_stew|suspicious_stew/i.test(i.name) &&
            i.name !== 'rotten_flesh');
        if (process.env.MC_FOOD_INSTINCTS === '1' && isItemGoal && bot && bot.food <= 3 && !normalFood) return 'famine-item-pickup';
    } catch (e) {}
    return null;
}

function shouldAvoidRandomUnstick(bot, goalInfo = null) {
    return !!randomUnstickSkipMode(bot, goalInfo);
}

/**
 * Execute pathfinding with a specific movement set and stuck timeout.
 * @returns {Promise<{success: boolean, stuckDetected: boolean}>}
 */
async function executePathfindingPhase(bot, goal, movements, stuckTimeoutMs, doorCheckInterval, audit = {}) {
    let stuckCheckInterval;
    let lastPosition = bot.entity.position.clone();
    let stuckTime = 0;
    let lastCheckTime = Date.now();
    const stuckRadius = 1.5; // Tighter radius for faster stuck detection
    const phaseStartedAt = Date.now();
    
    bot.pathfinder.setMovements(movements);
    motionAudit(bot, 'path.phase.begin', {
        seq: audit.seq,
        phase: audit.phase,
        goal: audit.goal,
        canDig: movements.canDig,
        allowParkour: movements.allowParkour,
        maxDropDown: movements.maxDropDown,
    });
    
    const stuckCheckPromise = new Promise((_, reject) => {
        stuckCheckInterval = setInterval(() => {
            if (bot.interrupt_code) {
                clearInterval(stuckCheckInterval);
                reject(new Error('Interrupted'));
                return;
            }
            
            const currentPos = bot.entity.position;
            const distance = currentPos.distanceTo(lastPosition);
            const now = Date.now();
            const elapsed = now - lastCheckTime;
            
            if (distance < stuckRadius) {
                stuckTime += elapsed;
                if (stuckTime >= stuckTimeoutMs) {
                    motionAudit(bot, 'path.phase.stuck', {
                        seq: audit.seq,
                        phase: audit.phase,
                        stuckMs: Math.round(stuckTime),
                        moved: +distance.toFixed(3),
                        from: {
                            x: +lastPosition.x.toFixed(3),
                            y: +lastPosition.y.toFixed(3),
                            z: +lastPosition.z.toFixed(3),
                        },
                        goal: audit.goal,
                    });
                    clearInterval(stuckCheckInterval);
                    reject(new Error('PhaseStuck'));
                }
            } else {
                stuckTime = 0;
                lastPosition = currentPos.clone();
            }
            lastCheckTime = now;
        }, 500); // Check every 500ms for faster response
    });
    
    try {
        await Promise.race([
            bot.pathfinder.goto(goal),
            stuckCheckPromise
        ]);
        clearInterval(stuckCheckInterval);
        motionAudit(bot, 'path.phase.end', {
            seq: audit.seq,
            phase: audit.phase,
            ok: true,
            ms: Date.now() - phaseStartedAt,
            goal: audit.goal,
        });
        return { success: true, stuckDetected: false };
    } catch (err) {
        clearInterval(stuckCheckInterval);
        bot.pathfinder.setGoal(null);
        
        const errorMsg = err.message || err.toString();
        if (errorMsg.includes('Interrupted') || bot.interrupt_code) {
            throw new Error('Navigation interrupted');
        }
        if (errorMsg.includes('PhaseStuck')) {
            motionAudit(bot, 'path.phase.end', {
                seq: audit.seq,
                phase: audit.phase,
                ok: false,
                stuckDetected: true,
                ms: Date.now() - phaseStartedAt,
                error: errorMsg,
                goal: audit.goal,
            });
            return { success: false, stuckDetected: true };
        }
        // Goal reached or path completed normally despite "error"
        if (errorMsg.includes('Goal') || errorMsg.includes('arrived')) {
            motionAudit(bot, 'path.phase.end', {
                seq: audit.seq,
                phase: audit.phase,
                ok: true,
                ms: Date.now() - phaseStartedAt,
                error: errorMsg,
                goal: audit.goal,
            });
            return { success: true, stuckDetected: false };
        }
        motionAudit(bot, 'path.phase.end', {
            seq: audit.seq,
            phase: audit.phase,
            ok: false,
            stuckDetected: false,
            ms: Date.now() - phaseStartedAt,
            error: errorMsg,
            goal: audit.goal,
        });
        return { success: false, stuckDetected: false };
    }
}

export async function goToGoal(bot, goal) {
    /**
     * Navigate to the given goal with adaptive stuck recovery.
     * Strategy:
     *   1. Try non-destructive path, 3s stuck → switch to destructive
     *   2. Try destructive path, 3s stuck → manual jump unstick
     *   3. After unstick, retry up to 3 times
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {pf.goals.Goal} goal, the goal to navigate to.
     **/

    const navSeq = (bot._navMotionSeq || 0) + 1;
    bot._navMotionSeq = navSeq;
    const goalInfo = motionGoal(goal);
    bot._lastPathGoalInfo = goalInfo;
    bot._lastPathGoalAt = Date.now();
    motionAudit(bot, 'path.begin', { seq: navSeq, goal: goalInfo });

    // ★MAROONED gate at the COMMON pathfinding entry (打转终极机理: 只给 goToPosition
    // 加门漏掉了 moveAway/moveAwayFromEntity/avoidEnemies — 它们直接走 goToGoal。
    // act_trace 实拍: 行军把 bot 修路推进 x112→x123,任务层 unstick 的 moveAway 20 秒
    // 又拉回 x112,两控制流拔河。被困态下一切寻路注定 NoPath 还干扰行军 — 在公共入口
    // 一刀拦掉。例外: 6 格内有敌对时放行(逃命寻路优先,与 sp 让位判定对称)。)
    if (bot._mobility && bot._mobility.state === 'MAROONED') {
        let closeThreat = false;
        try {
            closeThreat = Object.values(bot.entities || {}).some(e =>
                e && e !== bot.entity && e.position && mc.isHostile(e)
                && e.position.distanceTo(bot.entity.position) < 6);
        } catch (e) {}
        if (!closeThreat) {
            log(bot, `goToGoal suppressed: MAROONED (march owns movement)`);
            motionAudit(bot, 'path.suppressed', { seq: navSeq, reason: 'MAROONED', goal: goalInfo });
            return;
        }
    }

    // Setup movements. Keep ordinary travel conservative: mineflayer-pathfinder's
    // parkour/scaffold shortcuts are brittle in caves and on one-block lips. Dedicated
    // skills may still place/pillar explicitly, but generic navigation should walk or
    // dig a known route, not improvise block placement while moving.
    const nonDestructiveMovements = new pf.Movements(bot);
    const dontBreakBlocks = ['glass', 'glass_pane'];
    for (let block of dontBreakBlocks) {
        nonDestructiveMovements.blocksCantBreak.add(mc.getBlockId(block));
    }
    nonDestructiveMovements.canDig = false;
    // ★防摔回归修 (2026-07-08 用户实拍"寻路很轻易地掉进坑里", 失去 13 HP): parkour 曾从 false 翻成
    // true 想解"跨越地形困难" —— 但 mineflayer-pathfinder 的 parkour【执行】极不可靠: 规划器判一跳"落点
    // 安全"就排, 可跳弧【下方是深坑】时物理起跳一旦没跳到(卡顿/贴脸/rubber-band 常有)就直接坠进坑里 =
    // 用户实拍的"轻易掉坑摔血/摔死"。lib 没有"只走安全 parkour"的开关, 故关掉 parkour: 规划器不再朝深
    // 坑上方发起跳跃。真要跨 1 格缺口, 下面 destructive 段 canDig 会挖条安全的路过去(慢但不摔)。
    // maxDropDown 保持 3(3 格落差零摔伤;4-hop 连跳本就挡), lava 仍在 blocksToAvoid。
    nonDestructiveMovements.allowParkour = false;
    nonDestructiveMovements.maxDropDown = 3;
    nonDestructiveMovements.scafoldingBlocks = [];
    nonDestructiveMovements.placeCost = 2;
    nonDestructiveMovements.digCost = 10;
    // ★避水路 (2026-07-08 用户实拍"寻路各种跌落到水里"): lib 默认 liquidCost=1, A* 把水潭当"几乎免费的
    // 平地"直接斜穿过去(每格水 base1+liquid1≈2, 跟绕路一格差不多)→ 老往水里钻。调高 liquidCost 让规划器
    // 【优先绕开】水: 有旱路就走旱路, 但水是唯一/更短通路时仍会过(加价不是禁行, 过河可达性不受损)。
    nonDestructiveMovements.liquidCost = 12;

    nonDestructiveMovements.liquids.add(mc.getBlockId('water'));
    nonDestructiveMovements.liquids.add(mc.getBlockId('flowing_water'));
    nonDestructiveMovements.liquids.add(mc.getBlockId('lava'));
    nonDestructiveMovements.liquids.add(mc.getBlockId('flowing_lava'));
    
    const destructiveMovements = new pf.Movements(bot);
    destructiveMovements.canDig = true;
    destructiveMovements.allowParkour = false; // ★同上防摔回归修: 破坏式也关 parkour, 跨缺口靠 canDig 挖路(不摔)
    destructiveMovements.maxDropDown = 2;
    destructiveMovements.liquidCost = 8;   // ★同上避水路(破坏式稍低: 挖路本就更贵, 别把过河逼成绕远大坑)
    // ★C319 (T-0053): let the DESTRUCTIVE fallback BUILD its way out, not just dig. A pocket /
    // mesa-terrace imprisonment (T-0052) is escapable ONLY by PLACING blocks (pillar up / bridge a
    // gap) — canDig alone can't rise out of a pit (digging up just lengthens the shaft you're stuck
    // at the bottom of). Both modes had scafoldingBlocks=[], so destructive A* returned noPath on
    // any up-and-over egress → goToPosition threw "refusing blind destructive navigation" and
    // stranded the bot (every caller, not just migrate which C318 band-aided). Give destructive the
    // fillers we ACTUALLY carry (planning with blocks we lack = a place-path that fails at exec).
    // Non-destructive stays scaffold-free — ordinary travel never improvises placement.
    const _SCAFFOLD_RE = /^(cobblestone|cobbled_deepslate|dirt|coarse_dirt|sand|red_sand|gravel|stone|granite|diorite|andesite|tuff|netherrack|sandstone|red_sandstone)$|terracotta$/;
    const _scaffoldIds = [];
    try {
        for (const it of bot.inventory.items()) {
            if (_SCAFFOLD_RE.test(it.name || '')) { const id = mc.getBlockId(it.name); if (id != null && !_scaffoldIds.includes(id)) _scaffoldIds.push(id); }
        }
    } catch (e) {}
    destructiveMovements.scafoldingBlocks = _scaffoldIds;
    destructiveMovements.liquids.add(mc.getBlockId('water'));
    destructiveMovements.liquids.add(mc.getBlockId('flowing_water'));
    destructiveMovements.liquids.add(mc.getBlockId('lava'));
    destructiveMovements.liquids.add(mc.getBlockId('flowing_lava'));

    // ★JUNGLE VINE FIX (user: 寻路特别容易卡在藤蔓面前动不了). Vines are CLIMBABLE in
    // mineflayer-pathfinder by default → the planner invents bogus "climb the vine" paths up
    // trunks/walls that the bot can't actually execute, so it stalls in front of the vine
    // curtain. Remove vine-family from climbables on BOTH movement sets so they're treated as
    // ordinary walk-through (empty bounding box) / break-through blocks. delete() is a no-op if
    // the id isn't present, so this is safe regardless of pathfinder version.
    for (const m of [nonDestructiveMovements, destructiveMovements]) {
        for (const cn of ['vine', 'weeping_vines', 'twisting_vines', 'cave_vines', 'cave_vines_plant', 'glow_lichen']) {
            const id = mc.getBlockId(cn);
            if (id != null && m.climbables && typeof m.climbables.delete === 'function') { try { m.climbables.delete(id); } catch (e) {} }
        }
    }

    const doorCheckInterval = startDoorInterval(bot);
    const totalStartTime = Date.now();
    // ★进度感知长途修 (用户令 2026-07-09 "这么普通的越野也吃 3 次 unstick 就 bail"): 老逻辑两处硬墙 —
    //   (a) maxUnstickAttempts=3 是【整趟终身计数】: bot.pathfinder.goto 一次走到底, 山地每物理楔住 3s 耗
    //       一次 unstick, 累计 3 次就抛"到不了" —— 哪怕两次楔住之间已走了上百格(成功脱困也从不清零)。
    //   (b) totalTimeout=60s 是绝对墙钟, 长途本就不够。
    //   改成【进度感知】: 只要朝目标有实质推进(距目标缩短 ≥PROGRESS_EPS)就把 unstick 预算清零 —— cap 语义从
    //   "整趟累计 3 次"变成"连续 3 次无推进 = 真被困"; 并把绝对超时换成"无推进超时"(推进就续命), 另加宽松硬顶
    //   防病态死循环。normal 越野(单调靠近)永不再误 bail; 真被困(20s 挪不动)才照常放弃。
    const noProgressTimeout = 20000; // 只在【连续 20s 零推进】才判失败 (推进会重置计时)
    const hardTimeout = 180000;      // 绝对安全顶 (防病态无限循环; 正常长途远够用)
    const phaseStuckTimeout = 3000;  // 3s stuck detection per phase
    const maxUnstickAttempts = 3;    // 现语义: 【连续】无推进 unstick 上限 (有推进即清零)

    let currentMovements = nonDestructiveMovements;
    let isDestructive = false;
    let unstickAttempts = 0;

    // ── 进度感知 unstick 预算 (见上方常量注释) ──────────────────────────────────
    // 进度度量: 能从 goal 读到 x/y/z 就用【到目标的直线距离缩短】(GoalNear/GoalBlock, 即 goToCoordinates
    // 的常规路径); 复合目标无坐标时退化用【身体净位移】兜底。bot.entity.position 是 Vec3, .clone()/.distanceTo
    // 现成可用, 无需额外 import。
    const _goalPos = (typeof goal.x === 'number' && typeof goal.y === 'number' && typeof goal.z === 'number')
        ? { x: goal.x, y: goal.y, z: goal.z } : null;
    const _distToGoal = () => {
        if (!_goalPos) return null;
        try { const p = bot.entity.position; const dx = p.x - _goalPos.x, dy = p.y - _goalPos.y, dz = p.z - _goalPos.z; return Math.sqrt(dx * dx + dy * dy + dz * dz); }
        catch (e) { return null; }
    };
    const PROGRESS_EPS = 1.5;   // 靠近目标 ≥1.5b (或复合目标兜底: 净位移 ≥1.5b) 记为一次推进
    let _bestDist = _distToGoal();          // 距目标历史最优(最小); null → 用位移兜底
    let _lastAnchor = null; try { _lastAnchor = bot.entity.position.clone(); } catch (e) {}
    let lastProgressAt = Date.now();
    const markProgress = () => {
        let progressed = false;
        const cur = _distToGoal();
        if (cur != null && _bestDist != null) {
            if (cur < _bestDist - PROGRESS_EPS) { _bestDist = cur; progressed = true; }   // 比历史最近还近 → 真推进(绕路回摆不算)
        } else {
            try { const p = bot.entity.position; if (_lastAnchor && p.distanceTo(_lastAnchor) >= PROGRESS_EPS) { progressed = true; _lastAnchor = p.clone(); } } catch (e) {}
        }
        if (progressed) {
            if (unstickAttempts > 0) motionAudit(bot, 'path.progress_reset', { seq: navSeq, clearedAttempts: unstickAttempts, dist: cur != null ? +cur.toFixed(1) : undefined, goal: goalInfo });
            unstickAttempts = 0;
            lastProgressAt = Date.now();
        }
    };

    // Determine initial path type
    const pathfind_timeout = 1000;
    // ★C320 (T-0053): ACCEPT 'partial' plans, not only 'success'. The initial getPathTo is just a
    // PRE-CHECK to pick non-destructive vs destructive; the real navigation (executePathfindingPhase
    // → bot.pathfinder.setGoal) continuously follows partial paths and RE-PLANS as the bot moves.
    // The old gate threw `refusing blind destructive navigation` whenever BOTH modes returned
    // anything but 'success' — but in broken/mesa/pocket terrain A* routinely returns 'partial' (a
    // real route 7-14 nodes TOWARD the goal). Discarding partial = the bot refuses to make progress
    // it CAN make → stall/imprisonment (live 00:14-00:16: skill=achieve, nd=partial/len14,
    // d=partial/len14 → selected=none → stuck). Follow the partial, the executor re-plans from the
    // new spot; genuine no-path (no partial either) still throws. Preference: complete before
    // partial, non-destructive before destructive (don't dig/build when a walk-route progresses).
    const _usable = (s) => s === 'success' || s === 'partial';
    const nonDestructivePath = await bot.pathfinder.getPathTo(nonDestructiveMovements, goal, pathfind_timeout);
    let _destructivePath = null;
    if (nonDestructivePath.status !== 'success') {
        _destructivePath = await bot.pathfinder.getPathTo(destructiveMovements, goal, pathfind_timeout);
    }
    // pick: nd-success > d-success > nd-partial > d-partial
    let _pick = null;
    if (nonDestructivePath.status === 'success') _pick = 'nd';
    else if (_destructivePath && _destructivePath.status === 'success') _pick = 'd';
    else if (nonDestructivePath.status === 'partial') _pick = 'nd';
    else if (_destructivePath && _destructivePath.status === 'partial') _pick = 'd';
    if (_pick === 'nd') {
        currentMovements = nonDestructiveMovements;
        isDestructive = false;
        log(bot, `Found non-destructive path (${nonDestructivePath.status}).`);
        motionAudit(bot, 'path.plan', {
            seq: navSeq,
            selected: 'non-destructive',
            status: nonDestructivePath.status,
            nonDestructive: { status: nonDestructivePath.status, len: motionPathLen(nonDestructivePath) },
            destructive: _destructivePath ? { status: _destructivePath.status, len: motionPathLen(_destructivePath) } : undefined,
            goal: goalInfo,
        });
    } else if (_pick === 'd') {
        currentMovements = destructiveMovements;
        isDestructive = true;
        log(bot, `Found destructive path (${_destructivePath.status}).`);
        motionAudit(bot, 'path.plan', {
            seq: navSeq,
            selected: 'destructive',
            status: _destructivePath.status,
            nonDestructive: { status: nonDestructivePath.status, len: motionPathLen(nonDestructivePath) },
            destructive: { status: _destructivePath.status, len: motionPathLen(_destructivePath) },
            goal: goalInfo,
        });
    } else {
        {
            const destructivePath = _destructivePath || { status: 'noPath' };
            const betterError = new Error(
                `No complete path to destination. Non-destructive=${nonDestructivePath.status}, ` +
                `destructive=${destructivePath.status}; refusing blind destructive navigation.`
            );
            betterError.name = 'PathfindingNoPlan';
            log(bot, `Path not found: ${betterError.message}`);
            motionAudit(bot, 'path.plan', {
                seq: navSeq,
                selected: 'none',
                nonDestructive: { status: nonDestructivePath.status, len: motionPathLen(nonDestructivePath) },
                destructive: { status: destructivePath.status, len: motionPathLen(destructivePath) },
                refused: 'blind-destructive-navigation',
                goal: goalInfo,
            });
            clearInterval(doorCheckInterval);
            try { bot.pathfinder.setGoal(null); } catch (e) {}
            motionAudit(bot, 'path.end', {
                seq: navSeq,
                ok: false,
                unstickAttempts,
                ms: Date.now() - totalStartTime,
                error: betterError.message,
                goal: goalInfo,
            });
            throw betterError;
        }
    }

    try {
        while (Date.now() - lastProgressAt < noProgressTimeout && Date.now() - totalStartTime < hardTimeout) {
            if (bot.interrupt_code) {
                throw new Error('Navigation interrupted');
            }
            markProgress();   // ★朝目标有推进 → 清零 unstick 预算 + 续命 no-progress 计时 (长途越野不再累计误 bail)

            const result = await executePathfindingPhase(
                bot, goal, currentMovements, phaseStuckTimeout, doorCheckInterval,
                { seq: navSeq, phase: isDestructive ? 'destructive' : 'non-destructive', goal: goalInfo }
            );

            if (result.success) {
                clearInterval(doorCheckInterval);
                motionAudit(bot, 'path.end', {
                    seq: navSeq,
                    ok: true,
                    unstickAttempts,
                    ms: Date.now() - totalStartTime,
                    goal: goalInfo,
                });
                return true;
            }

            if (result.stuckDetected) {
                // Phase 1: Non-destructive stuck → switch to destructive
                if (!isDestructive) {
                    // ★不因"泡在水里晃不动"就切破坏式乱挖 (2026-07-08 用户实拍"移动中莫名其妙挖土", S1 的水域facet):
                    // 站在水里被浮力晃住 → 3s 内挪不出 1.5b → 触发 PhaseStuck → 老逻辑立刻切 destructive(canDig)
                    // 朝目标挖泥开路 = "莫名其妙挖土"。水里晃不动是【游泳假象】不是【墙】, 挖土解决不了。改: 脚/头
                    // 泡水时先 stepEdgeAssist 推一把、留在 non-destructive 继续游, 最多跳过 2 次; 2 次后仍卡(真被水
                    // 里箱死)才落到下面正常 destructive 促升(C319 口袋自救保留)。只在"站水里"生效, 干地脱困不变。
                    const _fb = bot.blockAt(bot.entity.position);
                    const _hb = bot.blockAt(bot.entity.position.offset(0, 1, 0));
                    const _inWater = /(flowing_)?water$/.test((_fb && _fb.name) || '') || /(flowing_)?water$/.test((_hb && _hb.name) || '');
                    const _wkey = `${Math.round(bot.entity.position.x)},${Math.round(bot.entity.position.z)}`;
                    const _wskips = (bot._ndWaterSkipKey === _wkey) ? (bot._ndWaterSkips || 0) : 0;
                    if (_inWater && _wskips < 2) {
                        bot._ndWaterSkips = _wskips + 1; bot._ndWaterSkipKey = _wkey;
                        motionAudit(bot, 'path.water_skip', { seq: navSeq, skips: bot._ndWaterSkips, goal: goalInfo });
                        await stepEdgeAssist(bot, { why: `path-water-skip-${bot._ndWaterSkips}`, goal: goalInfo, owner: `path:${navSeq}:water-skip` });
                        await new Promise(r => setTimeout(r, 300));
                        continue;   // 留在 non-destructive 继续游, 不切挖土
                    }
                    bot._ndWaterSkips = 0; bot._ndWaterSkipKey = null;
                    log(bot, `⚠️ Stuck with non-destructive path, switching to destructive...`);
                    motionAudit(bot, 'path.switch', { seq: navSeq, from: 'non-destructive', to: 'destructive', reason: 'stuck', goal: goalInfo });
                    currentMovements = destructiveMovements;
                    isDestructive = true;
                    continue;
                }

                // Phase 2: Destructive also stuck → manual unstick
                if (unstickAttempts < maxUnstickAttempts) {
                    unstickAttempts++;
                    const stepped = await stepEdgeAssist(bot, {
                        why: `path-${isDestructive ? 'destructive' : 'non-destructive'}-stuck-${unstickAttempts}`,
                        goal: goalInfo,
                        owner: `path:${navSeq}:step-edge`,
                    });
                    motionAudit(bot, 'path.step_edge', { seq: navSeq, attempt: unstickAttempts, ok: stepped, reason: 'stuck', goal: goalInfo });
                    if (!stepped) {
                        const skipMode = randomUnstickSkipMode(bot, goalInfo);
                        if (skipMode) {
                            log(bot, `⚠️ Stuck in ${skipMode}; skipping random unstick (${unstickAttempts}/${maxUnstickAttempts}).`);
                            motionAudit(bot, 'path.unstick.skipped', { seq: navSeq, attempt: unstickAttempts, reason: 'stuck', mode: skipMode, goal: goalInfo });
                        } else {
                            log(bot, `⚠️ Stuck! Attempting manual unstick (${unstickAttempts}/${maxUnstickAttempts})...`);
                            motionAudit(bot, 'path.unstick', { seq: navSeq, attempt: unstickAttempts, reason: 'stuck', goal: goalInfo });
                            await attemptUnstick(bot);
                        }
                    }
                    
                    // Brief pause then retry
                    await new Promise(r => setTimeout(r, 500));
                    continue;
                }

                // All attempts exhausted
                break;
            }

            // Non-stuck failure (path blocked, etc.) - try unstick anyway
            if (unstickAttempts < maxUnstickAttempts) {
                unstickAttempts++;
                const stepped = await stepEdgeAssist(bot, {
                    why: `path-failed-${unstickAttempts}`,
                    goal: goalInfo,
                    owner: `path:${navSeq}:step-edge`,
                });
                motionAudit(bot, 'path.step_edge', { seq: navSeq, attempt: unstickAttempts, ok: stepped, reason: 'path-failed', goal: goalInfo });
                if (!stepped) {
                    const skipMode = randomUnstickSkipMode(bot, goalInfo);
                    if (skipMode) {
                        log(bot, `Path failed in ${skipMode}; skipping random unstick (${unstickAttempts}/${maxUnstickAttempts}).`);
                        motionAudit(bot, 'path.unstick.skipped', { seq: navSeq, attempt: unstickAttempts, reason: 'path-failed', mode: skipMode, goal: goalInfo });
                    } else {
                        log(bot, `Path failed, attempting unstick (${unstickAttempts}/${maxUnstickAttempts})...`);
                        motionAudit(bot, 'path.unstick', { seq: navSeq, attempt: unstickAttempts, reason: 'path-failed', goal: goalInfo });
                        await attemptUnstick(bot);
                    }
                }
                await new Promise(r => setTimeout(r, 500));
                continue;
            }
            break;
        }

        clearInterval(doorCheckInterval);
        bot.pathfinder.setGoal(null);
        
        const _bailReason = (Date.now() - totalStartTime >= hardTimeout)
            ? `hit the ${Math.round(hardTimeout / 1000)}s hard cap`
            : `made no progress toward the goal for ${Math.round(noProgressTimeout / 1000)}s (${unstickAttempts} consecutive unstick attempts failed)`;
        const betterError = new Error(
            `Cannot reach destination: ${_bailReason}. ` +
            `You may be trapped or the path is blocked. Try a different target.`
        );
        betterError.name = 'PathfindingFailed';
        log(bot, `⚠️ Pathfinding failed: ${betterError.message}`);
        motionAudit(bot, 'path.end', {
            seq: navSeq,
            ok: false,
            unstickAttempts,
            ms: Date.now() - totalStartTime,
            error: betterError.message,
            goal: goalInfo,
        });
        throw betterError;
        
    } catch (err) {
        clearInterval(doorCheckInterval);
        bot.pathfinder.setGoal(null);
        
        const errorMsg = err.message || err.toString();
        if (errorMsg.includes('Interrupted') || bot.interrupt_code) {
            motionAudit(bot, 'path.end', {
                seq: navSeq,
                ok: false,
                interrupted: true,
                unstickAttempts,
                ms: Date.now() - totalStartTime,
                error: errorMsg,
                goal: goalInfo,
            });
            throw new Error('Navigation interrupted');
        }
        motionAudit(bot, 'path.end', {
            seq: navSeq,
            ok: false,
            unstickAttempts,
            ms: Date.now() - totalStartTime,
            error: errorMsg,
            goal: goalInfo,
        });
        throw err;
    }
}

let _doorInterval = null;
function startDoorInterval(bot) {
    /**
     * Start helper interval that opens nearby doors if the bot is stuck.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {number} the interval id.
     **/
    if (_doorInterval) {
        clearInterval(_doorInterval);
    }
    let prev_pos = bot.entity.position.clone();
    let prev_check = Date.now();
    let stuck_time = 0;


    const doorCheckInterval = setInterval(() => {
        const now = Date.now();
        if (bot.entity.position.distanceTo(prev_pos) >= 0.1) {
            stuck_time = 0;
        } else {
            stuck_time += now - prev_check;
        }
        
        if (stuck_time > 1200) {
            // shuffle positions so we're not always opening the same door
            const positions = [
                bot.entity.position.clone(),
                bot.entity.position.offset(0, 0, 1),
                bot.entity.position.offset(0, 0, -1), 
                bot.entity.position.offset(1, 0, 0),
                bot.entity.position.offset(-1, 0, 0),
            ]
            let elevated_positions = positions.map(position => position.offset(0, 1, 0));
            positions.push(...elevated_positions);
            positions.push(bot.entity.position.offset(0, 2, 0)); // above head
            positions.push(bot.entity.position.offset(0, -1, 0)); // below feet
            
            let currentIndex = positions.length;
            while (currentIndex != 0) {
                let randomIndex = Math.floor(Math.random() * currentIndex);
                currentIndex--;
                [positions[currentIndex], positions[randomIndex]] = [
                positions[randomIndex], positions[currentIndex]];
            }
            
            for (let position of positions) {
                let block = bot.blockAt(position);
                if (block && block.name &&
                    !block.name.includes('iron') &&
                    (block.name.includes('door') ||
                     block.name.includes('fence_gate') ||
                     block.name.includes('trapdoor'))) 
                {
                    bot.activateBlock(block);
                    break;
                }
            }
            stuck_time = 0;
        }
        prev_pos = bot.entity.position.clone();
        prev_check = now;
    }, 200);
    _doorInterval = doorCheckInterval;
    return doorCheckInterval;
}

export async function goToPosition(bot, x, y, z, min_distance=2) {
    // ★MAROONED = the engineered march owns ALL movement (打转机理之二: 任务层寻路
    // 目标在西、行军向东开路,两个系统拔河,bot 被来回拖。被困状态下任务层的每次
    // goToPosition 注定 NoPath 还干扰行军 — 快速让位,等状态机宣布自由再恢复寻路。)
    if (bot._mobility && bot._mobility.state === 'MAROONED') {
        log(bot, `goToPosition suppressed: MAROONED (march owns movement)`);
        return false;
    }
    /**
     * Navigate to the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to navigate to. If null, the bot's current x coordinate will be used.
     * @param {number} y, the y coordinate to navigate to. If null, the bot's current y coordinate will be used.
     * @param {number} z, the z coordinate to navigate to. If null, the bot's current z coordinate will be used.
     * @param {number} distance, the distance to keep from the position. Defaults to 2.
     * @returns {Promise<boolean>} true if the position was reached, false otherwise.
     * @example
     * let position = world.world.getNearestBlock(bot, "oak_log", 64).position;
     * await skills.goToPosition(bot, position.x, position.y, position.x + 20);
     **/
    const cur = bot.entity.position;
    if (x == null) x = cur.x;
    if (y == null) y = cur.y;
    if (z == null) z = cur.z;
    if (bot.modes.isOn('cheat')) {
        bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
        log(bot, `Teleported to ${x}, ${y}, ${z}.`);
        return true;
    }
    
    const checkDigProgress = () => {
        if (bot.targetDigBlock) {
            const targetBlock = bot.targetDigBlock;
            const itemId = bot.heldItem ? bot.heldItem.type : null;
            if (!targetBlock.canHarvest(itemId)) {
                log(bot, `Pathfinding stopped: Cannot break ${targetBlock.name} with current tools.`);
                bot.pathfinder.stop();
                bot.stopDigging();
            }
        }
    };
    
    const progressInterval = setInterval(checkDigProgress, 1000);
    
    try {
        await goToGoal(bot, new pf.goals.GoalNear(x, y, z, min_distance));
        clearInterval(progressInterval);
        const distance = bot.entity.position.distanceTo(new Vec3(x, y, z));
        if (distance <= min_distance+1) {
            log(bot, `You have reached at ${x}, ${y}, ${z}.`);
            return true;
        }
        else {
            log(bot, `Unable to reach ${x}, ${y}, ${z}, you are ${Math.round(distance)} blocks away.`);
            return false;
        }
    } catch (err) {
        log(bot, `Pathfinding stopped: ${err.message}.`);
        clearInterval(progressInterval);
        return false;
    }
}

export async function goToNearestBlock(bot, blockType,  min_distance=2, range=64) {
    /**
     * Navigate to the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to navigate to.
     * @param {number} min_distance, the distance to keep from the block. Defaults to 2.
     * @param {number} range, the range to look for the block. Defaults to 64.
     * @returns {Promise<boolean>} true if the block was reached, false otherwise.
     * @example
     * await skills.goToNearestBlock(bot, "oak_log", 64, 2);
     * **/
    const MAX_RANGE = 256;
    if (range > MAX_RANGE) {
        log(bot, `Maximum search range capped at ${MAX_RANGE}. `);
        range = MAX_RANGE;
    }
    let block = null;
    
    // Use async search for large ranges to avoid blocking the event loop
    const useAsync = range > 64;
    
    if (blockType === 'water' || blockType === 'lava') {
        if (useAsync) {
            let blocks = await world.getNearestBlocksWhereAsync(bot, block => block.name === blockType && block.metadata === 0, range, 1);
            if (blocks.length === 0) {
                log(bot, `Could not find any source ${blockType} in ${range} blocks, looking for uncollectable flowing instead...`);
                blocks = await world.getNearestBlocksWhereAsync(bot, block => block.name === blockType, range, 1);
            }
            block = blocks[0];
        } else {
            let blocks = await world.getNearestBlocksWhereAsync(bot, block => block.name === blockType && block.metadata === 0, range, 1);
            if (blocks.length === 0) {
                log(bot, `Could not find any source ${blockType} in ${range} blocks, looking for uncollectable flowing instead...`);
                blocks = await world.getNearestBlocksWhereAsync(bot, block => block.name === blockType, range, 1);
            }
            block = blocks[0];
        }
    }
    else {
        if (useAsync) {
            block = await world.getNearestBlockAsync(bot, blockType, range);
        } else {
            block = await world.getNearestBlockAsync(bot, blockType, range);
        }
    }
    if (!block) {
        log(bot, `Could not find any ${blockType} in ${range} blocks.`);
        return false;
    }
    log(bot, `Found ${blockType} at ${block.position}. Navigating...`);
    await goToPosition(bot, block.position.x, block.position.y, block.position.z, min_distance);
    return true;
}

export async function goToNearestEntity(bot, entityType, min_distance=2, range=64) {
    /**
     * Navigate to the nearest entity of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} entityType, the type of entity to navigate to.
     * @param {number} min_distance, the distance to keep from the entity. Defaults to 2.
     * @param {number} range, the range to look for the entity. Defaults to 64.
     * @returns {Promise<boolean>} true if the entity was reached, false otherwise.
     **/
    let entity = world.getNearestEntityWhere(bot, entity => entity.name === entityType, range);
    if (!entity) {
        log(bot, `Could not find any ${entityType} in ${range} blocks.`);
        return false;
    }
    let distance = bot.entity.position.distanceTo(entity.position);
    log(bot, `Found ${entityType} ${Math.round(distance)} blocks away.`);
    // ★2026-07-08 修"追不上的怪 → 反复 !searchForEntity/!newAction 空转"(用户实观: 命令杀蜘蛛, 蜘蛛在
    //   崖上/洞里/水面 —— 原实现直奔怪的【精确 Y】(GoalNear x,y,z), 那个 Y 到不了 → 每次 goToPosition 都
    //   "Unable to reach" → 上游 LLM 反复重开同一场空猎, 且旧实现【无条件 return true】谎报成功。改为:
    //   ① 先直奔(同层怪, 常见情形就够了); ② 到不了则重扫一次(怪会动/已死)再【水平逼近】(GoalNearXZ, 无视
    //   Y, 走到怪脚下那一柱的可走高度) —— 正是外部 LLM 手写进任务文本的 "small horizontal waypoints at safe
    //   ground height rather than exact entity Y" 那套; ③ 如实返回是否真的靠近, 让上游能据实收手/换招。
    const near = (ent) => {
        try { return !!(ent && ent.position && bot.entity.position.distanceTo(ent.position) <= min_distance + 2); }
        catch (e) { return false; }
    };
    const reached = await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z, min_distance);
    if (reached || near(entity)) return true;
    // exact-Y 直奔失败 → 重扫最近的同类(可能已移动/被杀), 再水平逼近它当前所在的柱。
    entity = world.getNearestEntityWhere(bot, e => e.name === entityType, range);
    if (!entity) {
        log(bot, `${entityType} no longer within ${range} blocks.`);
        return false;
    }
    const ep = entity.position;
    log(bot, `Direct path failed (exact height unreachable) — approaching ${entityType} horizontally.`);
    try {
        await goToGoal(bot, new pf.goals.GoalNearXZ(ep.x, ep.z, Math.max(2, min_distance)));
    } catch (e) {
        log(bot, `Approach error: ${e && e.message || e}.`);
    }
    if (near(entity)) return true;
    let d = '?';
    try { d = Math.round(bot.entity.position.distanceTo(entity.position)); } catch (e) {}
    log(bot, `Could not reach ${entityType} (still ${d} blocks away — likely on terrain the bot can't path to).`);
    return false;
}

export async function goToPlayer(bot, username, distance=3) {
    /**
     * Navigate to the given player.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to navigate to.
     * @param {number} distance, the goal distance to the player.
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.goToPlayer(bot, "player");
     **/
    if (bot.username === username) {
        log(bot, `You are already at ${username}.`);
        return true;
    }
    if (bot.modes.isOn('cheat')) {
        bot.chat('/tp @s ' + username);
        log(bot, `Teleported to ${username}.`);
        return true;
    }

    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');
    let player = bot.players[username]?.entity
    if (!player) {
        log(bot, `Could not find ${username}.`);
        return false;
    }

    distance = Math.max(distance, 0.5);
    const goal = new pf.goals.GoalFollow(player, distance);

    await goToGoal(bot, goal, true);

    log(bot, `You have reached ${username}.`);
}


export async function followPlayer(bot, username, distance=4) {
    /**
     * Follow the given player endlessly. Will not return until the code is manually stopped.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to follow.
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.followPlayer(bot, "player");
     **/
    let player = bot.players[username]?.entity
    if (!player)
        return false;

    const move = new pf.Movements(bot);
    move.digCost = 10;
    bot.pathfinder.setMovements(move);
    let doorCheckInterval = startDoorInterval(bot);

    bot.pathfinder.setGoal(new pf.goals.GoalFollow(player, distance), true);
    log(bot, `You are now actively following player ${username}.`);


    while (!bot.interrupt_code) {
        await new Promise(resolve => setTimeout(resolve, 500));
        // in cheat mode, if the distance is too far, teleport to the player
        const distance_from_player = bot.entity.position.distanceTo(player.position);

        const teleport_distance = 100;
        const ignore_modes_distance = 30; 
        const nearby_distance = distance + 2;

        if (distance_from_player > teleport_distance && bot.modes.isOn('cheat')) {
            // teleport with cheat mode
            await goToPlayer(bot, username);
        }
        else if (distance_from_player > ignore_modes_distance) {
            // these modes slow down the bot, and we want to catch up
            bot.modes.pause('item_collecting');
            bot.modes.pause('hunting');
            bot.modes.pause('torch_placing');
        }
        else if (distance_from_player <= ignore_modes_distance) {
            bot.modes.unpause('item_collecting');
            bot.modes.unpause('hunting');
            bot.modes.unpause('torch_placing');
        }

        if (distance_from_player <= nearby_distance) {
            clearInterval(doorCheckInterval);
            doorCheckInterval = null;
            bot.modes.pause('unstuck');
            bot.modes.pause('elbow_room');
        }
        else {
            if (!doorCheckInterval) {
                doorCheckInterval = startDoorInterval(bot);
            }
            bot.modes.unpause('unstuck');
            bot.modes.unpause('elbow_room');
        }
    }
    clearInterval(doorCheckInterval);
    return true;
}


export async function moveAway(bot, distance) {
    /**
     * Move away from current position in any direction.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.moveAway(bot, 8);
     **/
    const pos = bot.entity.position;
    let goal = new pf.goals.GoalNear(pos.x, pos.y, pos.z, distance);
    let inverted_goal = new pf.goals.GoalInvert(goal);
    bot.pathfinder.setMovements(new pf.Movements(bot));

    if (bot.modes.isOn('cheat')) {
        const move = new pf.Movements(bot);
        const path = await bot.pathfinder.getPathTo(move, inverted_goal, 10000);
        let last_move = path.path[path.path.length-1];
        if (last_move) {
            let x = Math.floor(last_move.x);
            let y = Math.floor(last_move.y);
            let z = Math.floor(last_move.z);
            bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
            return true;
        }
    }

    await goToGoal(bot, inverted_goal);
    let new_pos = bot.entity.position;
    log(bot, `Moved away from ${pos.floored()} to ${new_pos.floored()}.`);
    return true;
}

export async function moveAwayFromEntity(bot, entity, distance=16) {
    /**
     * Move away from the given entity.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to move away from.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     **/
    let goal = new pf.goals.GoalFollow(entity, distance);
    let inverted_goal = new pf.goals.GoalInvert(goal);
    await goToGoal(bot, inverted_goal);
    return true;
}

export async function avoidEnemies(bot, distance=16) {
    /**
     * Move a given distance away from all nearby enemy mobs.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.avoidEnemies(bot, 8);
     **/
    bot.modes.pause('self_preservation'); // prevents damage-on-low-health from interrupting the bot
    let enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), distance);
    while (enemy) {
        const follow = new pf.goals.GoalFollow(enemy, distance+1); // move a little further away
        const inverted_goal = new pf.goals.GoalInvert(follow);
        bot.pathfinder.setMovements(new pf.Movements(bot));
        bot.pathfinder.setGoal(inverted_goal, true);
        await new Promise(resolve => setTimeout(resolve, 500));
        enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), distance);
        if (bot.interrupt_code) {
            break;
        }
        if (enemy && bot.entity.position.distanceTo(enemy.position) < 3) {
            await attackEntity(bot, enemy, false);
        }
    }
    bot.pathfinder.stop();
    log(bot, `Moved ${distance} away from enemies.`);
    return true;
}

export async function stay(bot, seconds=30) {
    /**
     * Stay in the current position until interrupted. Disables all modes.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} seconds, the number of seconds to stay. Defaults to 30. -1 for indefinite.
     * @returns {Promise<boolean>} true if the bot stayed, false otherwise.
     * @example
     * await skills.stay(bot);
     **/
    bot.modes.pause('self_preservation');
    bot.modes.pause('unstuck');
    bot.modes.pause('cowardice');
    bot.modes.pause('self_defense');
    bot.modes.pause('hunting');
    bot.modes.pause('torch_placing');
    bot.modes.pause('item_collecting');
    let start = Date.now();
    while (!bot.interrupt_code && (seconds === -1 || Date.now() - start < seconds*1000)) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `Stayed for ${(Date.now() - start)/1000} seconds.`);
    return true;
}

export async function standby(bot, seconds=60) {
    /**
     * Hold the current position and wait for the given number of seconds (admin 待命).
     * Unlike stay(), the life-critical reflexes (self_preservation / self_defense / auto_eat /
     * mobility escape) stay armed — only the wander-y opportunistic modes are paused.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} seconds, how long to hold position (1-1200).
     * @returns {Promise<boolean>} true if the full time elapsed, false if interrupted.
     * @example
     * await skills.standby(bot, 120);
     **/
    // ★2026-07-14 用户令 (admin 主动要求原地待命 N 秒): 站桩不游荡 — 暂停会挪身体的机会主义
    //   本能 (idle 时 modes.unPauseAll 自动恢复); 保命反射全程在线 (跟 stay() 的"全暂停"区别开,
    //   待命不该待成活靶子); 每拍 renewAdminHold 续期 admin 独占窗口 → kernel/非致命反射全程
    //   让位, 超过 5min 兜底窗口的长待命也不被抢身体。新的 admin 指令照常能打断 (admin 意志绝对)。
    //   上限 1200s (20min): watchdog 的 STUCK-ZONE 25min 硬重启是终极防冻死兜底, 待命必须停在它
    //   之下 — 更久的待命让 admin 到点重发, 别拿掉真卡死的最后一张网。
    seconds = Math.max(1, Math.min(1200, Math.floor(Number(seconds) || 60)));
    for (const m of ['unstuck', 'cowardice', 'hunting', 'item_collecting', 'torch_placing', 'elbow_room', 'edge_unstick', 'idle_staring'])
        try { bot.modes.pause(m); } catch (e) {}
    try { bot.pathfinder.stop(); } catch (e) {}
    try { bot.pathfinder.setGoal(null); } catch (e) {}
    try { bot.clearControlStates(); } catch (e) {}
    const started = Date.now();
    const until = started + seconds * 1000;
    log(bot, `Standing by in place for ${seconds}s.`);
    while (Date.now() < until) {
        if (bot.interrupt_code) {
            // 保命反射/新指令抢走了身体 — 待命不自动续 (resume 机制会在 idle 反复重放, 有 standby
            // 永动风险)。把剩余秒数报给 LLM, 想继续等就精确重发。
            const remain = Math.max(1, Math.round((until - Date.now()) / 1000));
            log(bot, `Standby interrupted after ${Math.round((Date.now() - started) / 1000)}s (of ${seconds}s). Re-issue !standby(${remain}) to continue the hold.`);
            return false;
        }
        renewAdminHold(bot);
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `Stood by for ${seconds} seconds as requested.`);
    return true;
}

export async function useDoor(bot, door_pos=null) {
    /**
     * Use the door at the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Vec3} door_pos, the position of the door to use. If null, the nearest door will be used.
     * @returns {Promise<boolean>} true if the door was used, false otherwise.
     * @example
     * let door = world.getNearestBlock(bot, "oak_door", 16).position;
     * await skills.useDoor(bot, door);
     **/
    if (!door_pos) {
        for (let door_type of ['oak_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door', 'dark_oak_door',
                               'mangrove_door', 'cherry_door', 'bamboo_door', 'crimson_door', 'warped_door']) {
            door_pos = (await world.getNearestBlockAsync(bot, door_type, 64)).position;   // ★B定点16→64(0714)
            if (door_pos) break;
        }
    } else {
        door_pos = Vec3(door_pos.x, door_pos.y, door_pos.z);
    }
    if (!door_pos) {
        log(bot, `Could not find a door to use.`);
        return false;
    }

    bot.pathfinder.setGoal(new pf.goals.GoalNear(door_pos.x, door_pos.y, door_pos.z, 1));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    while (bot.pathfinder.isMoving()) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    
    let door_block = bot.blockAt(door_pos);
    await bot.lookAt(door_pos);
    if (!door_block._properties.open) {
        await tickConfirm.activateBlockConfirmed(bot, door_block, {
            confirm: async () => bot.blockAt(door_pos)?._properties?.open === true,
            retries: 3,
            confirmTimeoutMs: 500,
        });
    }

    bot.setControlState("forward", true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    bot.setControlState("forward", false);
    // close on the way out — no critical confirm here, just settle a tick
    await bot.activateBlock(door_block);
    await tickConfirm.sleepMs(100);

    log(bot, `Used door at ${door_pos}.`);
    return true;
}

export async function goToBed(bot) {
    /**
     * Sleep in the nearest bed.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the bed was found, false otherwise.
     * @example
     * await skills.goToBed(bot);
     **/
    const beds = (await world.getNearestBlocksWhereAsync(bot, (block) => block.name.includes('bed'), 64, 1)).map(b => b.position);
    if (beds.length === 0) {
        log(bot, `Could not find a bed to sleep in.`);
        return false;
    }
    let loc = beds[0];
    await goToPosition(bot, loc.x, loc.y, loc.z);
    const bed = bot.blockAt(loc);
    await bot.sleep(bed);
    log(bot, `You are in bed.`);
    bot.modes.pause('unstuck');
    while (bot.isSleeping) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `You have woken up.`);
    return true;
}

export async function tillAndSow(bot, x, y, z, seedType=null) {
    /**
     * Till the ground at the given position and plant the given seed type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to till.
     * @param {number} y, the y coordinate to till.
     * @param {number} z, the z coordinate to till.
     * @param {string} plantType, the type of plant to plant. Defaults to none, which will only till the ground.
     * @returns {Promise<boolean>} true if the ground was tilled, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.tillAndSow(bot, position.x, position.y - 1, position.x, "wheat");
     **/
    let pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    let block = bot.blockAt(pos);
    log(bot, `Planting ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);

    if (bot.modes.isOn('cheat')) {
        let to_remove = ['_seed', '_seeds'];
        for (let remove of to_remove) {
            if (seedType.endsWith(remove)) {
                seedType = seedType.replace(remove, '');
            }
        }
        placeBlock(bot, 'farmland', x, y, z);
        placeBlock(bot, seedType, x, y+1, z);
        return true;
    }

    if (block.name !== 'grass_block' && block.name !== 'dirt' && block.name !== 'farmland') {
        log(bot, `Cannot till ${block.name}, must be grass_block or dirt.`);
        return false;
    }
    let above = bot.blockAt(new Vec3(x, y+1, z));
    if (above.name !== 'air') {
        if (block.name === 'farmland') {
            log(bot, `Land is already farmed with ${above.name}.`);
            return true;
        }
        let broken = await breakBlockAt(bot, x, y+1, z);
        if (!broken) {
            log(bot, `Cannot cannot break above block to till.`);
            return false;
        }
    }
    // if distance is too far, move to the block
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        let pos = block.position;
        bot.pathfinder.setMovements(new pf.Movements(bot));
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }
    if (block.name !== 'farmland') {
        let hoe = bot.inventory.items().find(item => item.name.includes('hoe'));
        let to_equip = hoe?.name || 'diamond_hoe';
        if (!await equip(bot, to_equip)) {
            log(bot, `Cannot till, no hoes.`);
            return false;
        }
        await tickConfirm.activateBlockConfirmed(bot, block, {
            confirm: async () => bot.blockAt(pos)?.name === 'farmland',
            retries: 3,
            confirmTimeoutMs: 600,
        });
        log(bot, `Tilled block x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }

    if (seedType) {
        if (seedType.endsWith('seed') && !seedType.endsWith('seeds'))
            seedType += 's'; // fixes common mistake
        let equipped_seeds = await equip(bot, seedType);
        if (!equipped_seeds) {
            log(bot, `No ${seedType} to plant.`);
            return false;
        }

        await bot.activateBlock(block);
        await tickConfirm.sleepMs(100);
        log(bot, `Planted ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    return true;
}

export async function activateNearestBlock(bot, type) {
    /**
     * Activate the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} type, the type of block to activate.
     * @returns {Promise<boolean>} true if the block was activated, false otherwise.
     * @example
     * await skills.activateNearestBlock(bot, "lever");
     * **/
    let block = await world.getNearestBlockAsync(bot, type, 64);   // ★B定点16→64(0714)
    if (!block) {
        log(bot, `Could not find any ${type} to activate.`);
        return false;
    }
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        let pos = block.position;
        bot.pathfinder.setMovements(new pf.Movements(bot));
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }
    await bot.activateBlock(block);
    // No generic observable for activateBlock — settle one tick so a subsequent
    // command that depends on the resulting block state (e.g. lever flip, chest
    // open) sees the new state.
    await tickConfirm.sleepMs(100);
    log(bot, `Activated ${type} at x:${block.position.x.toFixed(1)}, y:${block.position.y.toFixed(1)}, z:${block.position.z.toFixed(1)}.`);
    return true;
}

/**
 * Helper function to find and navigate to a villager for trading
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager
 * @returns {Promise<Object|null>} the villager entity if found and reachable, null otherwise
 */
async function findAndGoToVillager(bot, id) {
    id = id+"";
    const entity = bot.entities[id];
    
    if (!entity) {
        log(bot, `Cannot find villager with id ${id}`);
        let entities = world.getNearbyEntities(bot, 16);
        let villager_list = "Available villagers:\n";
        for (let entity of entities) {
            if (entity.name === 'villager') {
                if (entity.metadata && entity.metadata[16] === 1) {
                    villager_list += `${entity.id}: baby villager\n`;
                } else {
                    const profession = world.getVillagerProfession(entity);
                    villager_list += `${entity.id}: ${profession}\n`;
                }
            }
        }
        if (villager_list === "Available villagers:\n") {
            log(bot, "No villagers found nearby.");
            return null;
        }
        log(bot, villager_list);
        return null;
    }
    
    if (entity.entityType !== bot.registry.entitiesByName.villager.id) {
        log(bot, 'Entity is not a villager');
        return null;
    }
    
    if (entity.metadata && entity.metadata[16] === 1) {
        log(bot, 'This is either a baby villager or a villager with no job - neither can trade');
        return null;
    }
    
    const distance = bot.entity.position.distanceTo(entity.position);
    if (distance > 4) {
        log(bot, `Villager is ${distance.toFixed(1)} blocks away, moving closer...`);
        try {
            bot.modes.pause('unstuck');
            const goal = new pf.goals.GoalFollow(entity, 2);
            await goToGoal(bot, goal);
            
            
            log(bot, 'Successfully reached villager');
        } catch (err) {
            log(bot, 'Failed to reach villager - pathfinding error or villager moved');
            console.log(err);
            return null;
        } finally {
            bot.modes.unpause('unstuck');
        }
    }
    
    return entity;
}

/**
 * Show available trades for a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager to show trades for
 * @returns {Promise<boolean>} true if trades were shown successfully, false otherwise
 * @example
 * await skills.showVillagerTrades(bot, "123");
 */
export async function showVillagerTrades(bot, id) {
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }
    
    try {
        const villager = await bot.openVillager(villagerEntity);
        
        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }
        
        log(bot, `Villager has ${villager.trades.length} available trades:`);
        stringifyTrades(bot, villager.trades).forEach((trade, i) => {
            const tradeInfo = `${i + 1}: ${trade}`;
            console.log(tradeInfo);
            log(bot, tradeInfo);
        });
        
        villager.close();
        return true;
    } catch (err) {
        log(bot, 'Failed to open villager trading interface - they might be sleeping, a baby, or jobless');
        console.log('Villager trading error:', err.message);
        return false;
    }
}

/**
 * Trade with a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager to trade with
 * @param {number} index - the index (1-based) of the trade to execute
 * @param {number} count - how many times to execute the trade (optional)
 * @returns {Promise<boolean>} true if trade was successful, false otherwise
 * @example
 * await skills.tradeWithVillager(bot, "123", "1", "2");
 */
export async function tradeWithVillager(bot, id, index, count) {
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }
    
    try {
        const villager = await bot.openVillager(villagerEntity);
        
        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }
        
        const tradeIndex = parseInt(index) - 1; // Convert to 0-based index
        const trade = villager.trades[tradeIndex];
        
        if (!trade) {
            log(bot, `Trade ${index} not found. This villager has ${villager.trades.length} trades available.`);
            villager.close();
            return false;
        }
        
        if (trade.disabled) {
            log(bot, `Trade ${index} is currently disabled`);
            villager.close();
            return false;
        }

        const item_2 = trade.inputItem2 ? stringifyItem(bot, trade.inputItem2)+' ' : '';
        log(bot, `Trading ${stringifyItem(bot, trade.inputItem1)} ${item_2}for ${stringifyItem(bot, trade.outputItem)}...`);
        
        const maxPossibleTrades = trade.maximumNbTradeUses - trade.nbTradeUses;
        const requestedCount = count;
        const actualCount = Math.min(requestedCount, maxPossibleTrades);
        
        if (actualCount <= 0) {
            log(bot, `Trade ${index} has been used to its maximum limit`);
            villager.close();
            return false;
        }
        
        if (!hasResources(villager.slots, trade, actualCount)) {
            log(bot, `Don't have enough resources to execute trade ${index} ${actualCount} time(s)`);
            villager.close();
            return false;
        }
        
        log(bot, `Executing trade ${index} ${actualCount} time(s)...`);
        
        try {
            await bot.trade(villager, tradeIndex, actualCount);
            log(bot, `Successfully traded ${actualCount} time(s)`);
            villager.close();
            return true;
        } catch (tradeErr) {
            log(bot, 'An error occurred while trying to execute the trade');
            console.log('Trade execution error:', tradeErr.message);
            villager.close();
            return false;
        }
    } catch (err) {
        log(bot, 'Failed to open villager trading interface');
        console.log('Villager interface error:', err.message);
        return false;
    }
}

function hasResources(window, trade, count) {
    const first = enough(trade.inputItem1, count);
    const second = !trade.inputItem2 || enough(trade.inputItem2, count);
    return first && second;

    function enough(item, count) {
        let c = 0;
        window.forEach((element) => {
            if (element && element.type === item.type && element.metadata === item.metadata) {
                c += element.count;
            }
        });
        return c >= item.count * count;
    }
}

function stringifyTrades(bot, trades) {
    return trades.map((trade) => {
        let text = stringifyItem(bot, trade.inputItem1);
        if (trade.inputItem2) text += ` & ${stringifyItem(bot, trade.inputItem2)}`;
        if (trade.disabled) text += ' x '; else text += ' » ';
        text += stringifyItem(bot, trade.outputItem);
        return `(${trade.nbTradeUses}/${trade.maximumNbTradeUses}) ${text}`;
    });
}

function stringifyItem(bot, item) {
    if (!item) return 'nothing';
    let text = `${item.count} ${item.displayName}`;
    if (item.nbt && item.nbt.value) {
        const ench = item.nbt.value.ench;
        const StoredEnchantments = item.nbt.value.StoredEnchantments;
        const Potion = item.nbt.value.Potion;
        const display = item.nbt.value.display;

        if (Potion) text += ` of ${Potion.value.replace(/_/g, ' ').split(':')[1] || 'unknown type'}`;
        if (display) text += ` named ${display.value.Name.value}`;
        if (ench || StoredEnchantments) {
            text += ` enchanted with ${(ench || StoredEnchantments).value.value.map((e) => {
                const lvl = e.lvl.value;
                const id = e.id.value;
                return bot.registry.enchantments[id].displayName + ' ' + lvl;
            }).join(' ')}`;
        }
    }
    return text;
}

export async function digDown(bot, distance = 10) {
    /**
     * Digs down a specified distance. Will stop if it reaches lava, water, or a fall of >=4 blocks below the bot.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {int} distance, distance to dig down.
     * @returns {Promise<boolean>} true if successfully dug all the way down.
     * @example
     * await skills.digDown(bot, 10);
     **/

    const startY = Math.floor(bot.entity.position.y);
    if (distance > 2 && startY <= 16) {
        log(bot, `Refusing blind multi-block digDown at y=${startY}; use a staircase or branch mine instead.`);
        return false;
    }
    if (distance > 2 && startY <= 32) {
        log(bot, `Clamping blind digDown from ${distance} to 2 at y=${startY}.`);
        distance = 2;
    }

    let start_block_pos = bot.blockAt(bot.entity.position).position;
    for (let i = 1; i <= distance; i++) {
        const targetBlock = bot.blockAt(start_block_pos.offset(0, -i, 0));
        let belowBlock = bot.blockAt(start_block_pos.offset(0, -i-1, 0));

        if (!targetBlock || !belowBlock) {
            log(bot, `Dug down ${i-1} blocks, but reached the end of the world.`);
            return true;
        }

        // Check for lava/water in target, below, AND the 4 HORIZONTAL neighbours + block above.
        // An aquifer floods the shaft from the SIDE (the old check only looked straight down) —
        // that's the recurring y~45 underground drowning that掉装备→ignites the death spiral.
        // Include flowing_water/flowing_lava (aquifers flow). Stop BEFORE breaking into the pocket.
        const _WL = new Set(['water', 'flowing_water', 'lava', 'flowing_lava']);
        const _around = [targetBlock, belowBlock,
            bot.blockAt(targetBlock.position.offset(1, 0, 0)), bot.blockAt(targetBlock.position.offset(-1, 0, 0)),
            bot.blockAt(targetBlock.position.offset(0, 0, 1)), bot.blockAt(targetBlock.position.offset(0, 0, -1)),
            bot.blockAt(targetBlock.position.offset(0, 1, 0))];
        if (_around.some(b => b && _WL.has(b.name))) {
            log(bot, `Dug down ${i - 1} blocks, stopping — water/lava adjacent (don't flood the shaft).`);
            return false;
        }

        const MAX_FALL_BLOCKS = 2;
        let num_fall_blocks = 0;
        for (let j = 0; j <= MAX_FALL_BLOCKS; j++) {
            if (!belowBlock || (belowBlock.name !== 'air' && belowBlock.name !== 'cave_air')) {
                break;
            }
            num_fall_blocks++;
            belowBlock = bot.blockAt(belowBlock.position.offset(0, -1, 0));
        }
        if (num_fall_blocks > MAX_FALL_BLOCKS) {
            log(bot, `Dug down ${i-1} blocks, but reached a drop below the next block.`);
            return false;
        }

        if (targetBlock.name === 'air' || targetBlock.name === 'cave_air') {
            log(bot, 'Skipping air block');
            console.log(targetBlock.position);
            continue;
        }

        let dug = await breakBlockAt(bot, targetBlock.position.x, targetBlock.position.y, targetBlock.position.z);
        if (!dug) {
            log(bot, 'Failed to dig block at position:' + targetBlock.position);
            return false;
        }
    }
    log(bot, `Dug down ${distance} blocks.`);
    return true;
}

export async function digOneCapOne(bot) {
    /**
     * "挖三填一" night-shelter primitive: dig ONE block straight down (reusing
     * digDown's water/lava neighbour + fall guards), then cap the head with a
     * non-gravity block and patch only the genuinely open side holes — netting a
     * sealed 1x1 pocket to ride out the night without a fortress' wall spend.
     *
     * Replaces the old digDown(2)+8-wall fortress: in solid terrain this places
     * ~0-1 blocks (cap + at most the open sides), instead of a fixed 8-block ring.
     *
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the pocket was dug AND fully capped/sealed.
     **/
    const _GRAVITY = new Set([
        'sand', 'red_sand', 'gravel',
        'suspicious_sand', 'suspicious_gravel',
    ]);
    const _isGravity = (b) => !!b && (_GRAVITY.has(b.name) || /^suspicious_/.test(b.name));

    const feet = bot.entity.position.floored();

    // ★封顶料 capName 先算(与 ④ 同优先级: 泥土>石系>...>非木板兜底)——① 的 gravity
    //   闸门要靠它判定"能不能挖三填一穿沙"。inv/capName 下游 ④⑤ 直接复用。
    const inv = world.getInventoryCounts(bot);
    // ★#4 (review-2026-07-06 乱放木板): cap/侧墙材料 cheap-first。旧版 _CAP_PREFS 只列
    // oak_planks(漏 spruce 等), fallback 抓"任意固体"会选中 spruce_planks → 工作台旁乱堆木板(真凶,
    // 初诊误判在 modes.js)。扩充贱料清单，并在 fallback 中硬排除所有木板；cap(④)与侧墙(⑤ 4376)
    // 共用 capName，只有木板时宁可诚实失败，也不消耗工具链材料。
    // ★材料优先级 (用户令 2026-07-07: 泥土 > 石头 > 其他): dirt/coarse_dirt 优先, 石系其次;
    //   其他非木板固体仍可末位 fallback，但所有 *_planks 一律禁用。
    const _CAP_PREFS = [
        'dirt', 'coarse_dirt', 'cobblestone', 'cobbled_deepslate', 'stone', 'deepslate',
        'andesite', 'diorite', 'granite', 'netherrack', 'tuff', 'sandstone', 'red_sandstone', 'terracotta',
    ];
    let capName = _CAP_PREFS.find(n => (inv[n] || 0) > 0);
    if (!capName) {
        const _solidOK = (it) =>
            !_isGravity({ name: it.name }) &&
            !/sword|pickaxe|axe|shovel|hoe|_ingot|_pickaxe|bucket|torch|seeds|^bed$|_bed$|food|apple|bread|meat|fish/.test(it.name) &&
            (mc.getItemId(it.name) != null);
        const items = bot.inventory.items();
        const _nonPlank = items.find(it => _solidOK(it) && !isPlankBlock(it.name));
        capName = (_nonPlank && _nonPlank.name) || null;
    }

    // ① _gravityPitTrap (C334 sand/gravel column): if a gravity block sits just
    // below the dig target (dy-1 / dy-2) or is poised to fall onto the cap (dy+2),
    // digging one down would bury the bot.
    // ★挖三填一 (用户令 2026-07-08): 沙子/砾石本身是可以挖穿的 —— 前提是手里有泥土等
    //   可封顶方块。所以 gravity 列只在【无封顶料】时才拒挖 downgrade-to-seal; 手里有
    //   capName 时照常挖一格再封顶(④ 会把落下的沙压在 cap 上, 形成密封坑)。
    const _trapProbe = [
        bot.blockAt(feet.offset(0, -1, 0)),
        bot.blockAt(feet.offset(0, -2, 0)),
        bot.blockAt(feet.offset(0, 2, 0)),
    ];
    if (_trapProbe.some(_isGravity)) {
        if (!capName) {
            log(bot, 'digOneCapOne: gravity column above/below (C334 _gravityPitTrap) 且手里无封顶料 — refusing dig-one, downgrade to seal.');
            return false;
        }
        log(bot, `digOneCapOne: gravity column (sand/gravel) present but cap block '${capName}' in hand — 挖三填一 proceeding (dig-through + cap).`);
    }

    // ② Bedrock-floor / deep-shaft guard: never dig the one-down at or below y=16.
    const startY = Math.floor(bot.entity.position.y);
    if (startY <= 16) {
        log(bot, `digOneCapOne: y=${startY} too low (<=16) to dig down — downgrade to seal.`);
        return false;
    }

    // ②b Undiggable / own-infrastructure guard (live 2026-07-02 04:33: a PICKLESS bot
    // standing on its own furnace churned all night — furnace is pick-tier, ~17.5s
    // bare-hand vs the ~3-5s per-dig budget, and every held-item swap between attempts
    // RESET the break progress). Utility blocks are never a shelter dig target anyway
    // (they're the bot's own infra); anything the CURRENT hand can't break inside the
    // budget downgrades to seal instead of burning the night. digTime is fail-open.
    const _below = bot.blockAt(feet.offset(0, -1, 0));
    if (_below && /furnace|crafting_table|chest|barrel|smoker|blast_furnace|_bed$|^bed$/.test(_below.name || '')) {
        log(bot, `digOneCapOne: block below is ${_below.name} (own utility block) — refusing dig-one, downgrade to seal.`);
        return false;
    }
    try {
        if (_below && _below.digTime(bot.heldItem ? bot.heldItem.type : null, false, false, false) > 4500) {
            log(bot, `digOneCapOne: ${_below.name} undiggable within budget with held ${bot.heldItem ? bot.heldItem.name : 'bare hand'} — refusing dig-one, downgrade to seal.`);
            return false;
        }
    } catch (e) {}

    // ③ Dig exactly ONE block down through digDown's safety gates (water/lava
    // 6-neighbour flood guard + >=2 fall guard). Reusing it means we never
    // bypass the aquifer / cliff protections.
    const dugOk = await digDown(bot, 1);
    if (!dugOk) {
        log(bot, 'digOneCapOne: digDown(1) refused/failed — downgrade to seal.');
        return false;
    }

    // ④ Cap the head: place a NON-gravity block two above the (new) feet so it
    // can't fall through the pocket. capName 已在 ① 之前算好(泥土>石系>...>非木板兜底)。

    // ★C346 depth-adaptive cap (deaths #4/#5 2026-07-02 13:11, zombie siege at the FLAT
    // village: a 1-deep pocket's cap cell (feet+2) sits one ABOVE the original surface —
    // all six neighbours are air, so placeBlock always failed 'nothing to place on' and the
    // bot rode out sieges in an open hole. The skill's own name says the geometry: 挖三填一
    // — at 3 deep the cap cell sits flush IN the ground layer with solid side support. Try
    // the cap at each depth 1→3 and deepen only while the cap cell floats; slopes still cap
    // at depth 1 like before, flat ground now digs to where a roof is physically possible.
    let capped = false;
    for (let depth = 1; depth <= 3; depth++) {
        const here0 = bot.entity.position.floored();
        const top0 = here0.offset(0, 2, 0);
        const existingCap = bot.blockAt(top0);
        if (existingCap && existingCap.boundingBox === 'block') { capped = true; break; }   // roofed by terrain
        if (!capName) { log(bot, 'digOneCapOne: no non-gravity cap block carried — cannot roof pocket.'); break; }
        capped = await placeBlock(bot, capName, top0.x, top0.y, top0.z, 'bottom', true);
        if (capped) break;
        if (depth === 3) break;
        // cap cell floats (flat terrain) — deepen one more through digDown's own guards
        const deeper = await digDown(bot, 1);
        if (!deeper) { log(bot, `digOneCapOne: cap floats at depth ${depth} and digDown refused deeper — pocket stays open.`); break; }
        log(bot, `digOneCapOne: cap had nothing to place on at depth ${depth} — deepened to ${depth + 1} (挖三填一 geometry).`);
    }
    const here = bot.entity.position.floored();

    // ⑤ Patch ONLY the genuinely open side holes (boundingBox !== 'block') across
    // the two body layers (feet dy0, head dy1). Solid terrain is left untouched
    // (net ~0-1 blocks placed), so we don't waste cobble walling solid stone.
    const _H = [
        [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
    ];
    let openRemaining = false;
    for (let dy = 0; dy <= 1; dy++) {
        for (const [dx, , dz] of _H) {
            const cell = here.offset(dx, dy, dz);
            const blk = bot.blockAt(cell);
            if (blk && blk.boundingBox === 'block') continue; // solid wall already
            // open side — try to fill it
            if (!capName) { openRemaining = true; continue; }
            const filled = await placeBlock(bot, capName, cell.x, cell.y, cell.z, 'side', true);
            const after = bot.blockAt(cell);
            if (!filled || !after || after.boundingBox !== 'block') {
                openRemaining = true;
            }
        }
    }

    return capped && !openRemaining;
}

export async function goToSurface(bot) {
    /**
     * Navigate to the surface (highest non-air block at current x,z).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the surface was reached, false otherwise.
     **/
    const pos = bot.entity.position;
    for (let y = 360; y > -64; y--) { // probably not the best way to find the surface but it works
        const block = bot.blockAt(new Vec3(pos.x, y, pos.z));
        if (!block || block.name === 'air' || block.name === 'cave_air') {
            continue;
        }
        const targetY = block.position.y + 1;
        try {
            await goToPosition(bot, block.position.x, targetY, block.position.z, 0);
            log(bot, `Going to the surface at y=${targetY}.`);
            return true;
        } catch (err) {
            // The pathfinder couldn't walk a route up — the classic case is
            // being trapped at the bottom of a vertical shaft, where there is
            // no foothold to climb. Fall back to towering straight up.
            log(bot, `No walkable route to the surface, towering up instead...`);
            return await pillarUp(bot, targetY);
        }
    }
    return false;
}

export async function pillarUp(bot, targetY = null, opts = {}) {
    /**
     * Pillar straight up IN PLACE: stand exactly where you are, jump and place a
     * block under your feet, repeat — the classic MLG tower. No column scan, no
     * pathfinder, no walking (the admin "just pillar up RIGHT HERE" primitive).
     * It drives the audited placeBlockUnderFeet by hand, so it works in dry pits
     * AND flooded water columns (holding jump swims the bot up in water, where the
     * pathfinder's 1x1 towering can't even generate a move — movements.js bails on
     * `block1.liquid`). Non-combat movement modes are frozen for the climb so a
     * reflex can't drag the bot off the pillar; combat/eat reflexes stay live, and
     * a fresh admin command still preempts via bot.interrupt_code.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} [targetY], Y to climb to. null/undefined ⇒ keep pillaring
     *   until the scaffold blocks run out (the "pillar until the dirt is gone"
     *   default). Clamped to the world build height.
     * @param {object} [opts], test seams: opts.placeUnder (place-one-block fn,
     *   default placeBlockUnderFeet) and opts.sleep (default tickConfirm.sleepMs).
     * @returns {Promise<boolean>} true if it reached targetY (target given) or
     *   climbed at least one block / ran out of blocks (no target); false only if
     *   it could not place a single block.
     * @example
     * await skills.pillarUp(bot);      // pillar up in place until blocks run out
     * await skills.pillarUp(bot, 72);  // pillar up in place until feet reach y=72
     **/
    const MAX_Y = 319;
    const place = opts.placeUnder || placeBlockUnderFeet;
    const sleep = opts.sleep || ((ms) => tickConfirm.sleepMs(ms));

    // Only tower with full solid blocks we actually hold (no slabs/stairs/etc,
    // which don't make a reliable 1-high step).
    const SCAFFOLD = ['dirt', 'cobblestone', 'cobbled_deepslate', 'stone', 'deepslate',
        'netherrack', 'end_stone', 'granite', 'andesite', 'diorite', 'tuff', 'blackstone', 'gravel',
        'sand'];
    const held = new Set(bot.inventory.items().map(i => i.name));
    const usable = SCAFFOLD.filter(n => held.has(n));
    // ★C288: SCAFFOLD lists no badlands/desert fillers — a mesa-dug bot holding 248 red_sand +
    // 184 terracotta + 24 sandstone but 0 cobble/dirt got "no placeable full blocks" and stayed
    // MAROONED+entombed, unable to tower out (C280 added these to modes.js FILL_RE but never
    // reached pillarUp). Append held terracotta/sandstone (non-gravity, safe footing) FIRST, then
    // red_sand (gravity, still climbable) — purely a FALLBACK after all standard blocks, so normal
    // pillaring is unchanged; it only kicks in when nothing better is held.
    for (const n of [...held]) { if (!usable.includes(n) && /(_terracotta|^terracotta|sandstone)$/.test(n)) usable.push(n); }
    for (const n of [...held]) { if (!usable.includes(n) && n === 'red_sand') usable.push(n); }
    if (usable.length === 0) {
        log(bot, `Can't pillar up: no placeable full blocks (dirt/cobblestone/terracotta/etc.) in inventory.`);
        return false;
    }

    if (targetY != null) targetY = Math.min(Math.floor(targetY), MAX_Y);

    // --- Freeze non-combat body-mover modes for the climb ------------------
    // The admin pillar bypasses the LOCOMOTION lane, so nothing else stops a
    // tick-driven mode (mobility/unstuck/elbow_room walking off to "unstick" or
    // reposition) from dragging the bot off the pillar mid-place. Pause exactly
    // those movement modes and restore them in finally. Combat (self_defense/
    // self_preservation), auto_eat and a fresh admin interrupt stay live.
    const GUARD = ['mobility', 'unstuck', 'elbow_room', 'idle_staring', 'item_collecting', 'torch_placing', 'hunting'];
    const prevModes = {};
    try { for (const m of GUARD) if (bot.modes && bot.modes.exists && bot.modes.exists(m)) { prevModes[m] = bot.modes.isOn(m); bot.modes.setOn(m, false); } } catch (e) {}

    const yOf = () => Math.floor(bot.entity.position.y);
    const heldUsable = () => usable.find(n => bot.inventory.items().some(i => i.name === n));
    const solidBelowFeet = () => {
        const ref = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
        return !!(ref && ref.boundingBox === 'block');
    };
    // The head cell (feet+1) must be open, or the jump can't clear the feet cell
    // to place a block there — a real ceiling, so pillaring can't continue.
    const headOpen = () => {
        const h = bot.blockAt(bot.entity.position.floored().offset(0, 1, 0));
        return !h || h.boundingBox !== 'block';
    };
    // ★C361: a jump-place lifts the feet ~1 block, which raises the 1.8-tall body
    // into feet+2 — so a solid block at feet+2 (a low 2-high tunnel ceiling) caps
    // the jump and the place never fires, even though feet+1 (head) is open. That
    // is the "Under-foot place delayed → placed 0" entombment observed at
    // (-155,54,383): bot boxed in a 2-high pocket with stone at (0,2,0), pillarUp
    // spins 6 no-op tries and gives up. Mine BOTH overhead cells (feet+1, feet+2)
    // before placing so the tower can escape a 2-high tunnel, not just an open
    // shaft. breakBlockAt refuses obsidian/bedrock, so an undiggable ceiling still
    // stops us (headOpen() below then breaks the loop); open-air pillaring is
    // unchanged (both cells are already air → no-op).
    const LIQUID_OR_AIR = /^(air|cave_air|void_air|water|lava|flowing_water|flowing_lava)$/;
    const clearJumpColumn = async () => {
        const fp = bot.entity.position.floored();
        for (const dy of [1, 2]) {
            if (bot.interrupt_code) return false;
            const c = bot.blockAt(fp.offset(0, dy, 0));
            if (c && c.boundingBox === 'block' && !LIQUID_OR_AIR.test(c.name)) {
                try { await breakBlockAt(bot, c.position.x, c.position.y, c.position.z); }
                catch (e) { return false; }
            }
        }
        return true;
    };
    // In water the bot floats a block or two above the block it just placed; stop
    // swimming and let it sink back down so the cell under its feet is a solid
    // support to place on (placeBlockUnderFeet needs that reference).
    const settleOntoFooting = async () => {
        if (solidBelowFeet()) return true;
        try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
        try { bot.clearControlStates && bot.clearControlStates(); } catch (e) {}
        for (let t = 0; t < 20 && !solidBelowFeet(); t++) await sleep(100);
        return solidBelowFeet();
    };

    const startY = yOf();
    log(bot, targetY == null
        ? `Pillaring up IN PLACE from y=${startY} until blocks run out.`
        : `Pillaring up IN PLACE from y=${startY} to y=${targetY}.`);

    const MAX_STUCK = 6; // consecutive no-progress tries at one level before giving up
    let placed = 0, stuck = 0;
    try {
        while (!bot.interrupt_code) {
            if (targetY != null && yOf() >= targetY) break;
            if (yOf() >= MAX_Y) { log(bot, `Reached the world build height (y=${yOf()}).`); break; }
            const name = heldUsable();
            if (!name) { log(bot, `Out of blocks — pillared ${placed}, now at y=${yOf()}.`); break; }
            // Mine a low 2-high-tunnel ceiling out of the jump column first (no-op in
            // open air); if the head cell is still capped it's an undiggable ceiling.
            await clearJumpColumn();
            if (!headOpen()) { log(bot, `Ceiling overhead at y=${yOf()} — can't pillar higher (placed ${placed}).`); break; }
            const y0 = yOf();
            await settleOntoFooting();
            try { await place(bot, name, { jumpMs: 1100, settleMs: 260, retries: 3, minClearance: 0.92 }); }
            catch (e) { try { bot.setControlState && bot.setControlState('jump', false); } catch (_) {} }
            await sleep(150);
            if (yOf() > y0) { placed += yOf() - y0; stuck = 0; }
            else if (++stuck >= MAX_STUCK) { log(bot, `Stuck at y=${yOf()} after ${stuck} tries — stopping (placed ${placed}).`); break; }
        }
    } finally {
        try { bot.clearControlStates && bot.clearControlStates(); } catch (e) {}
        try { for (const m in prevModes) bot.modes.setOn(m, prevModes[m]); } catch (e) {}
    }

    const finalY = yOf();
    if (bot.interrupt_code) log(bot, `Pillar up interrupted at y=${finalY} (placed ${placed}).`);
    // Success = reached the target (target given), or climbed at all / exhausted
    // the block stock (no target — "pillar until dirt gone" did its job).
    const reached = targetY != null ? finalY >= targetY : (placed > 0 || heldUsable() == null);
    log(bot, `Pillar up done: y=${startY}->${finalY} (+${finalY - startY}), placed ${placed} block(s).`);
    return reached;
}

export async function useToolOn(bot, toolName, targetName) {
    /**
     * Equip a tool and use it on the nearest target.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {string} targetName - entity type, block type, or "nothing" for no target
     * @returns {Promise<boolean>} true if action succeeded
     */
    if (!bot.inventory.slots.find(slot => slot && slot.name === toolName) && !bot.game.gameMode === 'creative') {
        log(bot, `You do not have any ${toolName} to use.`);
        return false;
    }

    targetName = targetName.toLowerCase();
    if (targetName === 'nothing') {
        const equipped = await equip(bot, toolName);
        if (!equipped) {
            return false;
        }
        await bot.activateItem();
        await tickConfirm.sleepMs(100);
        log(bot, `Used ${toolName}.`);
    } else if (world.isEntityType(targetName)) {
        const entity = world.getNearestEntityWhere(bot, e => e.name === targetName, 64);
        if (!entity) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
        }
        await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z);
        if (toolName === 'hand') {
            await bot.unequip('hand');
            await tickConfirm.sleepMs(100);
        }
        else {
            const equipped = await equip(bot, toolName);
            if (!equipped) return false;
        }

        // For lead specifically: confirm by inventory delta (one lead leaves the bot
        // on a successful leash). Without this we cannot tell a successful leash
        // from a fire-and-forget packet that the server dropped.
        if (toolName === 'lead') {
            const before = tickConfirm.snapshotItemCount(bot, 'lead');
            if (before <= 0) {
                log(bot, `No lead in inventory to use on ${targetName}.`);
                return false;
            }
            const res = await tickConfirm.useOnEntityConfirmed(bot, entity, {
                confirm: async () => tickConfirm.snapshotItemCount(bot, 'lead') < before,
                retries: 3,
                backoffMs: 200,
                confirmTimeoutMs: 600,
            });
            if (!res.ok) {
                log(bot, `Failed to leash ${targetName} after ${res.attempts} attempt(s) (${res.error_class}). The ${targetName} may be out of range, already leashed, or unleashable.`);
                return false;
            }
            log(bot, `Leashed ${targetName} with ${toolName}.`);
        } else {
            // Generic use_entity: caller has no observable side-effect, just settle one tick.
            const res = await tickConfirm.useOnEntityConfirmed(bot, entity, {
                retries: 1,
                confirmTimeoutMs: 50,
            });
            // res is always ok here (no confirm fn)
            void res;
            await tickConfirm.sleepMs(100);
            log(bot, `Used ${toolName} on ${targetName}.`);
        }
    } else {
        let block = null;
        if (targetName === 'water' || targetName === 'lava') {
            // we want to get liquid source blocks, not flowing blocks
            // so search for blocks with metadata 0 (not flowing)
            let blocks = await world.getNearestBlocksWhereAsync(bot, block => block.name === targetName && block.metadata === 0, 64, 1);
            if (blocks.length === 0) {
                log(bot, `Could not find any source ${targetName}.`);
                return false;
            }
            block = blocks[0];
        }
        else {
            block = await world.getNearestBlockAsync(bot, targetName, 64);
        }
        if (!block) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
        }
        return await useToolOnBlock(bot, toolName, block);
    }

    return true;
 }

 export async function useToolOnBlock(bot, toolName, block) {
    /**
     * Use a tool on a specific block.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {Block} block - the block reference to use the tool on.
     * @returns {Promise<boolean>} true if action succeeded
     */

    const distance = toolName === 'water_bucket' && block.name !== 'lava' ? 1.5 : 2;
    await goToPosition(bot, block.position.x, block.position.y, block.position.z, distance);
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));

    // if block in view is closer than the target block, it is in our way. try to move closer
    const viewBlocked = () => {
        const blockInView = bot.blockAtCursor(5);
        const headPos = bot.entity.position.offset(0, bot.entity.height, 0);
        return blockInView && 
            !blockInView.position.equals(block.position) && 
            blockInView.position.distanceTo(headPos) < block.position.distanceTo(headPos);
    }
    const blockInView = bot.blockAtCursor(5);
    if (viewBlocked()) {
        log(bot, `Block ${blockInView.name} is in the way, moving closer...`);
        // choose random block next to target block, go to it
        const nearbyPos = block.position.offset(Math.random() * 2 - 1, 0, Math.random() * 2 - 1);
        await goToPosition(bot, nearbyPos.x, nearbyPos.y, nearbyPos.z, 1);
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
        if (viewBlocked()) {
            const blockInView = bot.blockAtCursor(5);
            log(bot, `Block ${blockInView.name} is in the way, not using ${toolName}.`);
            return false;
        }
    }

    const equipped = await equip(bot, toolName);

    if (!equipped) {
        log(bot, `Could not equip ${toolName}.`);
        return false;
    }
    if (toolName.includes('bucket')) {
        await bot.activateItem();
    }
    else {
        await bot.activateBlock(block);
    }
    // Both activateItem and activateBlock are fire-and-forget; wait one tick
    // so observable effects (bucket fill, block state change) settle before
    // the caller proceeds.
    await tickConfirm.sleepMs(100);
    log(bot, `Used ${toolName} on ${block.name}.`);
    return true;
 }

export async function customSkill(bot, skillName, ...args) {
    /**
     * Load and run a hot-reloadable custom skill written to bots/_supervisor/skills/<skillName>.js. The supervisor adds these files at runtime to teach the bot a procedure; the file is re-imported fresh on every call so edits take effect with NO agent restart. The skill module must export a default async function with signature (bot, ctx, ...args) where ctx = { skills, world, mc, Vec3, log }.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} skillName, the file name without extension of the custom skill to run, e.g. "realNetherPortal".
     * @param {...any} args, additional arguments forwarded to the custom skill.
     * @returns {Promise<any>} whatever the custom skill returns, or false if it could not be loaded.
     * @example
     * await skills.customSkill(bot, "realNetherPortal");
     **/
    if (typeof skillName !== 'string' || !/^[A-Za-z0-9_-]+$/.test(skillName)) {
        log(bot, `Invalid custom skill name: ${skillName}`);
        return false;
    }
    const abs = path.resolve(process.cwd(), 'bots', '_supervisor', 'skills', `${skillName}.js`);
    let mod;
    try {
        mod = await import(pathToFileURL(abs).href + `?t=${Date.now()}`);
    } catch (err) {
        log(bot, `Custom skill '${skillName}' failed to load: ${err.message}`);
        return false;
    }
    const fn = mod.default || mod[skillName];
    if (typeof fn !== 'function') {
        log(bot, `Custom skill '${skillName}' has no default export function.`);
        return false;
    }
    const ctx = { skills: await import('./skills.js'), world, mc, Vec3, log };
    const prevSkill = bot._currentSkill;
    try {
        bot._currentSkill = skillName;
        return await fn(bot, ctx, ...args);
    } finally {
        // Restore ONLY while we are still the holder. A Promise.race-orphaned inner skill
        // (achieve.js races customSkill vs timeouts; the loser keeps running detached) can
        // finish LATE — after the outer skill already returned and cleared this — and its
        // stale prevSkill would overwrite null/newer state. That poisons ms.busy forever
        // and MUTES the kernel (live incident 2026-07-02 00:16→00:38: a raced-out inner
        // skill restored 'prepNether' over null; bot stood idle 22 min).
        if (bot._currentSkill === skillName) bot._currentSkill = prevSkill;
    }
}

// ── Endgame milestone store (bots/_supervisor/endgame.json) ─────────────────
// ONE shared read/merge/write helper for the endgame chain. Skills used to carry
// divergent copies (blazeRods/setupEndPortal/slayDragon + world_model's read-only
// endgameState) whose merge orders could silently wipe or resurrect persisted
// milestones — e.g. a cached bot._endgame={} after a transient read error made
// setupEndPortal's cache-only patch erase strongholdKnown/portalRoom from disk.
// Contract: egPatch re-reads the FILE every call and merges file ∪ bot cache ∪
// patch, then writes atomically (tmp+rename) so a watchdog kill mid-write can
// never leave torn JSON that erases the irreversible milestones on next parse.
const EG_FILE = path.resolve(process.cwd(), 'bots', '_supervisor', 'endgame.json');
export function egRead(bot) {
    try {
        let s = fs_dz.readFileSync(EG_FILE, 'utf8');
        if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);            // BOM-safe
        const j = JSON.parse(s);
        return (j && typeof j === 'object') ? j : {};
    } catch (e) { return (bot && bot._endgame) || {}; }
}
export function egPatch(bot, patch) {
    try {
        const cur = Object.assign({}, egRead(bot), (bot && bot._endgame) || {}, patch, { ts: Date.now() });
        if (bot) bot._endgame = cur;                               // keep the world model's cache fresh
        const tmp = EG_FILE + '.tmp';
        fs_dz.writeFileSync(tmp, JSON.stringify(cur, null, 2));
        fs_dz.renameSync(tmp, EG_FILE);
        return cur;
    } catch (e) { return (bot && bot._endgame) || {}; }
}

// ── pickRunway ───────────────────────────────────────────────────────────────
// ONE shared read of the tool-durability budget — durability is the third budget
// next to time (maxMs) and food/hp gates, and until now it lived in three divergent
// fragments (modes.js kit 85%-worn effective picks, mineDown's pickAboutToBreak /
// canCraftPick, MINE_NIGHT_PICK_BUDGET's summed uses). Live 2026-07-02: achieve's
// xray iron staircase wore the lone stone pick to dust mid-descent (none of the
// fragments guarded that path) → pickless underground at night → every kind
// rotated through dispatch-cooldowns till dawn. All dig loops and the TOOL_UPKEEP
// proposal consult THIS predicate so the numbers can never disagree.
export function pickRunway(bot) {
    let total = 0, effective = 0, bestTier = 0, bestUsesLeft = 0, sumUsesLeft = 0;
    const tierRank = { wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 };
    const tierName = ['none', 'wooden', 'stone', 'iron', 'diamond', 'netherite'];
    const counts = {};
    for (const it of bot.inventory.items()) {
        counts[it.name] = (counts[it.name] || 0) + it.count;
        if (!/_pickaxe$/.test(it.name || '')) continue;
        total += it.count;
        const max = it.maxDurability || 0;
        const used = (typeof it.durabilityUsed === 'number') ? it.durabilityUsed : 0;
        const left = max > 0 ? Math.max(0, max - used) : 999;   // unknown durability = don't panic
        sumUsesLeft += left;
        if (!max || (used / max) < 0.85) effective += it.count; // "effective" mirrors modes.js kit
        if (left > bestUsesLeft) bestUsesLeft = left;
        const t = tierRank[(it.name || '').split('_')[0]] || 0;
        if (t > bestTier) bestTier = t;
    }
    // Field-recraft check mirrors mineDown's canCraftPick + modes.js canRecraftPick:
    // a spare only protects you if you can MAKE the next one where you stand —
    // cobble for the head, sticks (or planks for them), and a carried table (or
    // planks to build one; a "nearby" table is a lie deep underground).
    const planksMax = Math.max(0, ...Object.keys(counts).filter(k => k.endsWith('_planks')).map(k => counts[k]));
    const logs = Object.keys(counts).filter(k => k.endsWith('_log')).reduce((s, k) => s + counts[k], 0);
    const sticks = counts['stick'] || 0;
    const cobble = (counts['cobblestone'] || 0) + (counts['cobbled_deepslate'] || 0);
    const carriedTable = (counts['crafting_table'] || 0) > 0;
    const woodForRecraft = planksMax + logs * 4;
    const planksToRecraft = (carriedTable ? 0 : 4) + (sticks >= 2 ? 0 : 2);
    const canFieldCraftPick = cobble >= 3 && woodForRecraft >= planksToRecraft;
    return {
        total, effective, bestTier: tierName[bestTier] || 'none', bestUsesLeft, sumUsesLeft,
        carriedTable, canFieldCraftPick,
        // ≤6 uses ≈ 2 more staircase steps (3 blocks/step) — enough to climb back out.
        aboutToBreak: total === 0 || (total === 1 && bestUsesLeft <= 6),
    };
}

// ── gazeHold ─────────────────────────────────────────────────────────────────
// Keep the head ON the block being dug for the dig's whole duration. bot.dig's
// forceLook (and the one-shot lookAt the call sites do) aims the head only at dig
// START; a tick later vein scans / pathfinder steps re-aim it while the server
// keeps breaking the block regardless of facing — on screen the bot "digs the ore
// behind its back" (user-reported, 2026-07-02). Purely cosmetic held gaze: re-look
// every 250ms until the dig promise settles. Returns a promise that settles exactly
// like the passed dig promise (safe inside Promise.race).
export function gazeHold(bot, block, digPromise) {
    const at = block && block.position && block.position.offset(0.5, 0.5, 0.5);
    if (!at) return digPromise;
    const iv = setInterval(() => { try { bot.lookAt(at, true); } catch (e) {} }, 250);
    return Promise.resolve(digPromise).finally(() => clearInterval(iv));
}

// ── eatPreferred ─────────────────────────────────────────────────────────────
// Shared "eat the best SAFE food" idiom (blazeRods/enderPearls carried copies;
// slayDragon's first-FOOD_RE-match variant could lock onto carrot_on_a_stick /
// poisonous_potato / raw chicken mid-dragon-fight and starve at low hp).
const FOOD_PRIORITY = ['golden_apple', 'cooked_beef', 'cooked_porkchop', 'cooked_mutton',
    'cooked_chicken', 'cooked_salmon', 'cooked_cod', 'cooked_rabbit', 'baked_potato',
    'bread', 'apple', 'carrot', 'melon_slice', 'sweet_berries'];
export async function eatPreferred(bot) {
    const counts = {};
    for (const it of bot.inventory.items()) counts[it.name] = (counts[it.name] || 0) + it.count;
    let f = FOOD_PRIORITY.find(n => counts[n] > 0);
    if (!f) { const it = bot.inventory.items().find(i => /^cooked_|^bread$|^baked_|_stew$/.test(i.name)); f = it && it.name; }
    if (!f) return false;
    try { await consume(bot, f); return true; } catch (e) { return false; }
}

// ── boatEscape ───────────────────────────────────────────────────────────────
// 渡水根治 (2026-07-03 值守血账: 2 溺亡 + 3 水中被射/被啃 + 2 次 40min 级水域 PIN —
// 本世界大洋/湖密布, 开阔深水里 swim/escapePlan/watchdog 全部乏力)。船 = 5 板:
// 渡水 ~8×速 + 免溺 + 甩开大部分追击。modes.js 深水反射与 boatCross.js 技能共用
// 这一个实现 (反射内不能 customSkill)。
//
// mineflayer 1.21.1 载具 API 实测 (本仓 node_modules 源码):
//   bot.mount(entity) / bot.dismount() / bot.vehicle / 'mount' 'dismount' 事件 — 可用;
//   bot.placeEntity(refBlock, face) — 对 *_boat 走 vanilla 路径 (block_place + use_item
//   + 等 entitySpawn 'boat'), 可用 (1.21.1 船实体名就叫 'boat');
//   bot.moveVehicle(left, forward) — 1.21.1 (< 1.21.3 newPlayerInputPacket) 只发
//   steer_vehicle 桨输入包, 而原版服务器对 boat 是【客户端权威】物理: 只认控船乘客发的
//   serverbound vehicle_move {x,y,z:f64, yaw,pitch:f32}, mineflayer 从不发这个包 →
//   "mount 后 moveVehicle 无效"的历史坑属实, 不能用。
//
// 所以这里自己充当船的物理引擎: mount 后以 ≤0.34b/50ms (≈6.8b/s, 低于原版桨速 ~8b/s,
// 远低于服务器每包 10b 的 moved-too-quickly 上限) 逐 tick 发 vehicle_move 逼近目标,
// y 恒定在船落水面。服务器对每包做碰撞复算, 不认时回发 clientbound vehicle_move 纠正 —
// 挂临时监听把本地模型钳回去; 连续被钳且无净位移 = 服务器不吃这套 → 诚实中止。mount
// 期间 mineflayer 物理停摆且停发玩家位置包 (physics.js on('mount')→shouldUsePhysics=
// false, updatePosition 被门), 驾驶场地干净; dismount 后服务器传送玩家 → forcedMove
// 自动恢复物理。本地同步 bot.vehicle.position / bot.entity.position 让看门狗与世界模型
// 看得到真实进度。
//
// 红线: 无模块级状态 (全部函数局部+finally 摘监听) / 每 50ms honor bot.interrupt_code
// (interrupt 时跳过回收但必 dismount 恢复物理) / 氧气 <12 先浮到水面再放船 (vital 地板)。
// 契约: 净水平位移 >16b → {crossed:<整数距离>}; 否则 false — 绝不虚报。
async function _boatRecover(bot, trace) {
    // 尝试打掉船回收 (船会掉自身物品; 拿不回也接受 — 船 5 板, 命更贵)
    try {
        for (let hit = 0; hit < 6; hit++) {
            if (bot.interrupt_code || bot.health <= 0 || bot.vehicle) return false;
            let veh = null, bd = 5;
            for (const id in bot.entities) {
                const e = bot.entities[id];
                if (!e || (e.name !== 'boat' && e.name !== 'chest_boat') || !e.position) continue;
                const d = e.position.distanceTo(bot.entity.position);
                if (d < bd) { bd = d; veh = e; }
            }
            if (!veh) { if (hit > 0) trace(`boat broken after ${hit} hits (item should drop nearby)`); return true; }
            try { await bot.lookAt(veh.position.offset(0, 0.3, 0), true); } catch (e) {}
            try { bot.attack(veh); } catch (e) {}
            await new Promise(r => setTimeout(r, 350));
        }
    } catch (e) {}
    trace('boat not recovered (left afloat) — accepted');
    return false;
}
export async function boatEscape(bot, tx, tz, opts = {}) {
    const tag = opts.tag || '-';
    const trace = (s) => { try { fs_dz.appendFileSync('bots/_supervisor/progress.txt', `[${new Date().toISOString()}] [boat] (${tag}) ${s}\n`); } catch (e) {} };
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    tx = Number(tx); tz = Number(tz);
    if (!Number.isFinite(tx) || !Number.isFinite(tz) || !bot.entity || !bot.entity.position) return false;
    const start = bot.entity.position.clone();

    // vital 地板: 淹没状态先浮到水面 (氧气恢复或 6s 超时), 再谈放船
    if (bot.oxygenLevel !== undefined && bot.oxygenLevel < 12) {
        trace(`oxygen ${bot.oxygenLevel} low → float first`);
        try { await bot.look(bot.entity.yaw, -1.45, false); } catch (e) {}
        bot.setControlState('jump', true);
        const tF = Date.now();
        while (Date.now() - tF < 6000 && !bot.interrupt_code && bot.health > 0
            && bot.oxygenLevel !== undefined && bot.oxygenLevel < 15) await sleep(200);
        bot.setControlState('jump', false);
    }
    if (bot.interrupt_code || bot.health <= 0) return false;

    const isWaterName = (n) => n === 'water' || n === 'flowing_water';
    const nearBoat = (maxD) => {
        let best = null, bd = maxD;
        for (const id in bot.entities) {
            const e = bot.entities[id];
            if (!e || (e.name !== 'boat' && e.name !== 'chest_boat') || !e.position) continue;
            const d = e.position.distanceTo(bot.entity.position);
            if (d < bd) { bd = d; best = e; }
        }
        return best;
    };
    let veh = nearBoat(6);   // 上一次尝试留下的船 → 直接骑, 省一只

    if (!veh) {
        const boatOf = () => bot.inventory.items().find(it => /(_boat|_raft)$/.test(it.name || ''));
        if (!boatOf()) { trace('no boat item & no boat entity — abort'); return false; }
        // 找可放船的水面块: 目标方向 2~3.2b > 自己脚下 > 周身 r=2 环
        const surfWater = (cx, cz) => {
            try {
                const yBase = Math.floor(bot.entity.position.y);
                for (let dy = 2; dy >= -3; dy--) {
                    const b = bot.blockAt(new Vec3(Math.floor(cx), yBase + dy, Math.floor(cz)));
                    if (!b || !isWaterName(b.name)) continue;
                    const up = bot.blockAt(b.position.offset(0, 1, 0));
                    if (up && (isWaterName(up.name) || up.boundingBox === 'block')) continue;
                    return b;
                }
            } catch (e) {}
            return null;
        };
        const px = bot.entity.position.x, pz = bot.entity.position.z;
        const ux = tx - px, uz = tz - pz, un = Math.hypot(ux, uz) || 1;
        const cands = [[px + ux / un * 2, pz + uz / un * 2], [px, pz], [px + ux / un * 3.2, pz + uz / un * 3.2],
            [px + 2, pz], [px - 2, pz], [px, pz + 2], [px, pz - 2], [px + 2, pz + 2], [px - 2, pz - 2]];
        let ref = null;
        for (const [cx, cz] of cands) { ref = surfWater(cx, cz); if (ref) break; }
        if (!ref) { trace('no placeable water surface in reach — abort'); return false; }
        // ★实弹验尸修复 (2026-07-03 09:43 双败 'Failed to place entity' ×2): 死因不是瞄准 —
        // bot.placeEntity 的 boat 分支在 1.21.1 上就是坏的: place_entity.js:39 发 use_item
        // 只带 {hand}, 而 1.21.1 的 use_item 包定义是 hand+sequence+rotation:vec2f, 序列化
        // 直接抛 "SizeOf error ... reading 'x'" (本机 createSerializer 复现实锤)。nmp 的
        // client.write 序列化错误走异步 error 不在调用点抛 → 包根本没上线, 服务器从没收到,
        // waitForEntitySpawn 5s 超时 = 我们看到的报错。次因: 原 activateItem 兜底只有单发+
        // 700ms 一次轮询, 且 kernel 技能并发抢手 (09:43:33 [chopDBG] digToSurface 换镐与放
        // 船同帧实锤) 会在 equip→发包窗口把手上的船顶掉。
        // 修法: 弃 placeEntity, 自己打 6 发点射 — 每发 ①验手 (被顶就重 equip) ②强制 look
        // ③bot.activateItem() (它发的 use_item 自带 sequence+rotation, 1.21.1 服务器按包内
        // 朝向 absRotateTo 再 raycast — 并发扭头再也搅不了瞄准) ④1.2s 内每 150ms 轮询船实体;
        // 三发不中换自己脚下水柱 (踩水自放是 vanilla 最稳姿势)。
        for (let shot = 0; shot < 6 && !veh; shot++) {
            if (bot.interrupt_code || bot.health <= 0) return false;
            const boatItem = boatOf();
            if (!boatItem) { trace('boat item vanished mid-place — abort'); return false; }
            try {
                if (!bot.heldItem || bot.heldItem.name !== boatItem.name) await bot.equip(boatItem, 'hand');
            } catch (e) { trace(`shot${shot} equip ${boatItem.name} err ${e.message}`); await sleep(250); continue; }
            try { await bot.lookAt(ref.position.offset(0.5, 0.9, 0.5), true); } catch (e) {}
            if (bot.heldItem && bot.heldItem.name === boatItem.name) {   // 验手后立刻发, 不留被顶窗口
                try { bot.activateItem(); } catch (e) { trace(`shot${shot} activateItem err ${e.message}`); }
            } else { trace(`shot${shot} hand stomped (held=${bot.heldItem && bot.heldItem.name || 'none'}) — retry`); continue; }
            const tP = Date.now();
            while (!veh && Date.now() - tP < 1200) { await sleep(150); veh = nearBoat(8); }
            if (!veh && shot === 2) {   // 三发不中 → 换自己脚下水柱再打
                const r2 = surfWater(bot.entity.position.x, bot.entity.position.z);
                if (r2) { ref = r2; trace(`re-aim own column @${r2.position.x},${r2.position.y},${r2.position.z}`); }
            }
        }
        if (!veh) { trace('boat place failed x6 (use_item volley w/ packet rotation) — abort'); return false; }
    }
    trace(`boat @${veh.position.x.toFixed(1)},${veh.position.y.toFixed(1)},${veh.position.z.toFixed(1)} → mount`);

    for (let att = 0; att < 3 && !bot.vehicle; att++) {
        if (bot.interrupt_code || bot.health <= 0) break;
        try {
            if (veh.position.distanceTo(bot.entity.position) > 3.5) {
                try { await bot.lookAt(veh.position, true); } catch (e) {}
                bot.setControlState('forward', true); bot.setControlState('jump', true);
                await sleep(700);
                bot.setControlState('forward', false); bot.setControlState('jump', false);
            }
        } catch (e) {}
        try { bot.mount(veh); } catch (e) { trace(`mount err ${e.message}`); }
        const tM = Date.now();
        while (!bot.vehicle && Date.now() - tM < 2000) await sleep(100);
    }
    if (!bot.vehicle) { trace('mount failed x3 — abort + recover'); await _boatRecover(bot, trace); return false; }

    // ── 驾驶: 客户端权威 vehicle_move, 我们就是船的物理引擎 ──
    try { bot.clearControlStates(); } catch (e) {}
    const drive = { x: veh.position.x, y: veh.position.y, z: veh.position.z };
    let clamped = 0;
    const onVehMove = (pk) => {   // 服务器拒绝这步 → 回发纠正, 本地模型钳回去 (诚实)
        clamped++;
        if (pk && Number.isFinite(pk.x)) { drive.x = pk.x; drive.y = pk.y; drive.z = pk.z; }
    };
    try { bot._client.on('vehicle_move', onVehMove); } catch (e) {}
    const arrive = opts.arrive || 7;
    const maxMs = opts.maxMs || 120000;
    const tD = Date.now();
    let reason = 'timeout';
    let anchor = { x: drive.x, z: drive.z, at: Date.now() };
    try {
        while (Date.now() - tD < maxMs) {
            if (bot.interrupt_code || bot.health <= 0) { reason = 'interrupt'; break; }
            if (!bot.vehicle) { reason = 'vehicle lost (broken/ejected)'; break; }
            const dx = tx - drive.x, dz = tz - drive.z, d = Math.hypot(dx, dz);
            if (d <= arrive) { reason = 'arrived'; break; }
            const step = Math.min(0.34, d);
            drive.x += dx / d * step; drive.z += dz / d * step;
            const nyaw = Math.atan2(-dx, dz) * 180 / Math.PI;   // notchian 度数, 仅船头朝向 (纯装饰)
            try { bot._client.write('vehicle_move', { x: drive.x, y: drive.y, z: drive.z, yaw: nyaw, pitch: 0 }); }
            catch (e) { reason = `write err ${e.message}`; break; }
            // 本地模型跟上 — mount 期间 physics 停发玩家包, 不会外泄; 看门狗看得到进度
            try { if (bot.vehicle && bot.vehicle.position) bot.vehicle.position.set(drive.x, drive.y, drive.z); } catch (e) {}
            try { bot.entity.position.set(drive.x, drive.y + 0.55, drive.z); } catch (e) {}
            if (Date.now() - anchor.at > 20000) {   // 20s 净位移 <2b → 搁浅/被拒, 诚实中止
                if (Math.hypot(drive.x - anchor.x, drive.z - anchor.z) < 2) { reason = 'no displacement 20s'; break; }
                anchor = { x: drive.x, z: drive.z, at: Date.now() };
            }
            if (clamped >= 10 && Math.hypot(drive.x - start.x, drive.z - start.z) < 3) { reason = `server clamped x${clamped} at origin`; break; }
            await sleep(50);
        }
    } finally {
        try { bot._client.removeListener('vehicle_move', onVehMove); } catch (e) {}
    }
    trace(`drive end: ${reason} clamped=${clamped} pos=${drive.x.toFixed(1)},${drive.z.toFixed(1)}`);

    // dismount 恢复物理 (必须走到 — 否则 shouldUsePhysics 停在 false, 人冻在船里)
    for (let att = 0; att < 3 && bot.vehicle; att++) {
        try { bot.dismount(); } catch (e) {}
        const tU = Date.now();
        while (bot.vehicle && Date.now() - tU < 1500) await sleep(100);
    }
    if (bot.vehicle) trace('WARN: still mounted after dismount x3 — physics may stay frozen');
    await sleep(800);   // 等服务器下船传送 → forcedMove 恢复物理 + 拿到服务器真实位置
    if (reason !== 'interrupt') await _boatRecover(bot, trace);
    const dist = Math.hypot(bot.entity.position.x - start.x, bot.entity.position.z - start.z);
    trace(`done: net ${Math.round(dist)}b (${reason}) hp=${Math.round(bot.health)} O2=${bot.oxygenLevel}`);
    if (dist > 16) return { crossed: Math.round(dist) };
    return false;
}
