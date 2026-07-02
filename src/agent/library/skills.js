import * as mc from "../../utils/mcdata.js";
import * as world from "./world.js";
import * as tickConfirm from "./tick_confirm.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import { unclimbVines } from './vine_unstick.js';
import settings from "../../../settings.js";
import path from 'path';
import { pathToFileURL } from 'url';

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
        fs_dz.appendFileSync('bots/_supervisor/mine_motion.jsonl', JSON.stringify({
            ts: new Date().toISOString(),
            event,
            pos: motionPos(bot),
            held: bot && bot.heldItem ? bot.heldItem.name : 'empty',
            hp: bot ? Math.round(bot.health || 0) : null,
            food: bot ? bot.food : null,
            skill: bot ? (bot._currentSkill || null) : null,
            mob: bot && bot._mobility ? bot._mobility.state : null,
            data,
        }) + '\n');
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
        craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
        if (craftingTable === null){

            // Try to place crafting table
            let hasTable = world.getInventoryCounts(bot)['crafting_table'] > 0;
            if (hasTable) {
                let pos = world.getNearestFreeSpace(bot, 1, 6);
                await placeBlock(bot, 'crafting_table', pos.x, pos.y, pos.z);
                craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
                if (craftingTable) {
                    recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, craftingTable);
                    placedTable = true;
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
            const near = world.getNearestBlock(bot, 'crafting_table', 4);
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
            for (let t = 0; t < 3; t++) {
                try { const blk = bot.blockAt(placedTablePos); if (blk && blk.name === 'crafting_table') await breakBlockAt(bot, placedTablePos.x, placedTablePos.y, placedTablePos.z); } catch (e) {}
                try { await pickupNearbyItems(bot); } catch (e) {}
                if ((world.getInventoryCounts(bot)['crafting_table'] || 0) > 0) break;
                await new Promise(r => setTimeout(r, 200));
            }
        }
        try { for (const m in prevModes) bot.modes.setOn(m, prevModes[m]); } catch (e) {}
        try { bot.clearControlStates(); } catch (e) {}
    }
}

async function placeCraftingTableWithinReach(bot) {
    let existing = world.getNearestBlock(bot, 'crafting_table', 3);
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
    furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
    if (!furnaceBlock){
        // Try to place furnace
        let hasFurnace = world.getInventoryCounts(bot)['furnace'] > 0;
        if (hasFurnace) {
            let pos = world.getNearestFreeSpace(bot, 1, furnaceRange);
            await placeBlock(bot, 'furnace', pos.x, pos.y, pos.z);
            furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
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
    await bot.lookAt(furnaceBlock.position);

    console.log('smelting...');
    const furnace = await bot.openFurnace(furnaceBlock);
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
    if (!furnace.fuelItem()) {
        let fuel = mc.getSmeltingFuel(bot);
        if (!fuel) {
            log(bot, `You have no fuel to smelt ${itemName}, you need coal, charcoal, or wood.`);
            if (placedFurnace)
                await collectBlock(bot, 'furnace', 1);
            return false;
        }
        log(bot, `Using ${fuel.name} as fuel.`);

        const put_fuel = Math.ceil(num / mc.getFuelSmeltOutput(fuel.name));

        if (fuel.count < put_fuel) {
            log(bot, `You don't have enough ${fuel.name} to smelt ${num} ${itemName}; you need ${put_fuel}.`);
            if (placedFurnace)
                await collectBlock(bot, 'furnace', 1);
            return false;
        }
        await furnace.putFuel(fuel.type, null, put_fuel);
        log(bot, `Added ${put_fuel} ${mc.getItemName(fuel.type)} to furnace fuel.`);
        console.log(`Added ${put_fuel} ${mc.getItemName(fuel.type)} to furnace fuel.`)
    }
    // put the items in the furnace
    await furnace.putInput(mc.getItemId(itemName), null, num);
    // wait for the items to smelt
    let total = 0;
    let smelted_item = null;
    await new Promise(resolve => setTimeout(resolve, 200));
    let last_collected = Date.now();
    while (total < num) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (furnace.outputItem()) {
            smelted_item = await furnace.takeOutput();
            if (smelted_item) {
                total += smelted_item.count;
                last_collected = Date.now();
            }
        }
        if (Date.now() - last_collected > 11000) {
            break; // if nothing has been collected in 11 seconds, stop
        }
        if (bot.interrupt_code) {
            break;
        }
    }
    // take all remaining in input/fuel slots
    if (furnace.inputItem()) {
        await furnace.takeInput();
    }
    if (furnace.fuelItem()) {
        await furnace.takeFuel();
    }

    await bot.closeWindow(furnace);

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
    let furnaceBlock = world.getNearestBlock(bot, 'furnace', 32);
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
    let enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), range);
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
        enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), range);
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

// Pick the right tool for a block, but NEVER hold a sword to break wood — equipForBlock
// leaves a combat sword in hand when axe-less → "用木剑砍树" (slow + burns combat durability).
// Drop to bare hand for logs/wood when we have no axe. Every dig path uses this.
async function equipForDig(bot, block) {
    try { await bot.tool.equipForBlock(block); } catch (e) {}
    if (/_log$|_wood$|_stem$|_hyphae$/.test(block.name) && bot.heldItem && /_sword$/.test(bot.heldItem.name)
        && !bot.inventory.items().some(i => /_axe$/.test(i.name))) {
        try { await bot.unequip('hand'); } catch (e) {}
    }
}

// THE one block-break primitive. Walk adjacent if needed, verify eye→block-centre reach
// (≤4.6 — past that bot.dig swings at air forever on out-of-reach / leaf-occluded blocks),
// equip the right tool, dig with a hard time backstop, and STOP the swing on failure.
// Returns 'ok' | 'gone' | 'unreachable' | 'timeout' | 'error'. Caller decides cleanup
// (exclude, expand neighbours, relocate, ...). Opts: maxMs dig backstop, approach (path
// closer), equip (run equipForDig — false if caller already equipped), pickup (vacuum drop).
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
        // ★C337 (T-0035 reopen·回归): anti-x-ray LOS gate, opt-in via requireLOS (collectBlock passes it
        // for ORE). After approach the bot can still be on the NEAR side of a thin wall with the target
        // 2.5-4.6b away THROUGH solid rock → digging it = x-ray (用户"矿在距离内但中间隔着石头,违反规则").
        // Block ONLY the unambiguous x-ray: at-distance(>2.5b, not tunneled-adjacent) AND occluded
        // (no line-of-sight). A buried ore we legitimately tunneled UP TO is reachOf≤2.5 (exempt), and a
        // genuinely visible ore passes canSeeBlock — so legit vein/tunnel mining is unaffected; only the
        // reach-through-a-wall grab is refused, routing the caller to expose it properly or skip it.
        if (requireLOS && reachOf() > 2.5) {
            const _los = (() => { try { return bot.canSeeBlock(cur); } catch (e) { return true; } })();
            if (!_los) return 'occluded';
        }
        if (equip) await equipForDig(bot, cur);
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
        if (pickup) { try { await pickupNearbyItems(bot); } catch (e) {} }
        return 'ok';
    } catch (e) {
        try { bot.stopDigging(); } catch (_) {}
        if (e && e.message === 'interrupted') return 'error';
        return (e && e.message === 'dig-timeout') ? 'timeout' : 'error';
    }
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
    let blocktypes = [blockType];
    const oreDrops = ['coal','diamond','emerald','iron','gold','lapis_lazuli','redstone','copper'];
    if (oreDrops.includes(blockType)) {
        blocktypes.push(blockType+'_ore');
        blocktypes.push('deepslate_'+blockType+'_ore'); // diamond/iron/etc at deepslate depth
    }
    if (blockType.endsWith('ore'))
        blocktypes.push('deepslate_'+blockType);
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
    // nearby stone/dirt/log). 'auto' = on iff the search set contains an ore block.
    const veinActive = !isLiquid && (veinFollow === true || (veinFollow === 'auto' && blocktypes.some(n => n.endsWith('_ore'))));

    let collected = 0;

    const movements = new pf.Movements(bot);
    movements.dontMineUnderFallingBlock = false;
    movements.dontCreateFlow = true;
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
    const _mineDBG = (m) => { try { fs_dz.appendFileSync('bots/_supervisor/mine_dbg.log', `[${new Date().toISOString()}] ${m}\n`); } catch (e) {} };
    const _oreReachable = async (cand) => {
        try {
            const bp = cand.position;
            const eye = bot.entity.position.offset(0, 1.62, 0);
            const d3 = eye.distanceTo(bp.offset(0.5, 0.5, 0.5));
            const goal = new pf.goals.GoalNear(bp.x, bp.y, bp.z, 2);
            const res = await bot.pathfinder.getPathTo(reachMoves, goal, 800);
            const st = res ? res.status : 'null';
            if (!res || res.status !== 'success') {
                _mineDBG(`★C304 ${cand.name}@${bp.x},${bp.y},${bp.z} d3=${d3.toFixed(1)} REJECT status=${st} (no walk/dig path, no bridge)`);
                return false;
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
            const _dlraw = (await import('fs')).readFileSync('bots/_supervisor/death_log.jsonl', 'utf8').trim().split('\n').slice(-50);
            const _dpts = _dlraw.map(l => { try { const r = JSON.parse(l); return (typeof r.x === 'number') ? r : null; } catch (e) { return null; } }).filter(Boolean);
            _dzones = _dpts.filter(p => _dpts.filter(q => q !== p && Math.hypot(q.x - p.x, q.z - p.z) < 16).length >= 2);
        } catch (e) {}
        const _inDeathZone = (p) => _dzones.some(z => Math.hypot(z.x - p.x, z.z - p.z) < 14);

        // The scan + per-block predicate (incl. pathfinder's safeToBreak, which walks
        // neighbour blocks) can null-deref inside dependency code — that throw used to
        // escape collectBlock entirely and kill the caller's whole collect loop (seen
        // live: "collect iron_ore: Cannot read properties of null (reading 'x')" every
        // cycle). Guard per-block (skip the offending block) and around the scan.
        let blocks = [];
        try {
            blocks = world.getNearestBlocksWhere(bot, block => {
                try {
                    if (!block || !block.position || !blocktypes.includes(block.name)) {
                        return false;
                    }
                    if (_inDeathZone(block.position)) return false;   // 雷区矿物不可见
                    if (exclude) {
                        for (let position of exclude) {
                            if (block.position.x === position.x && block.position.y === position.y && block.position.z === position.z) {
                                return false;
                            }
                        }
                    }
                    if (isLiquid) {
                        // collect only source blocks
                        return block.metadata === 0;
                    }
                    return movements.safeToBreak(block) || unsafeBlocks.includes(block.name);
                } catch (e) { return false; }
            }, 64, veinActive ? 8 : 1);   // ★C304 ore: keep fallbacks so we can skip across-gap nearest to a reachable one
        } catch (err) {
            const frame = (err.stack || '').split('\n')[1] || '';
            log(bot, `⚠️ ${blockType} scan failed: ${err}.${frame ? ' @' + frame.trim() : ''} — retrying next pass.`);
            await new Promise(r => setTimeout(r, 1000));
            continue;
        }

        if (blocks.length === 0) {
            if (collected === 0)
                log(bot, `No ${blockType} nearby to collect.`);
            else
                log(bot, `No more ${blockType} nearby to collect.`);
            break;
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
                const r = await safeDig(bot, block, { maxMs: 15000, equip: false, requireLOS: _isOre });
                if (r === 'ok') {
                    // ★Actually COLLECT the drop (fixes "挖了树不捡木头"): step ONTO the broken
                    // block's spot via a dig-capable path so mineflayer auto-vacuums the item,
                    // THEN sweep any stragglers (drops land a couple blocks off through leaves/vines).
                    try { await goToPosition(bot, block.position.x, block.position.y, block.position.z, 1); } catch (e) {}
                    await pickupNearbyItems(bot);
                    success = true;
                } else if (r === 'gone') {
                    continue; // vanished before we dug — move on
                } else {
                    log(bot, `⚠️ ${block.name} ${r} — skip+exclude, next.`);
                    exclude.push(block.position);
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
    log(bot, `Collected ${collected} ${blockType}.`);
    return collected > 0;
}

// Flood-fill mine a connected ore vein starting from a just-mined block position.
// MC ore blobs often touch only diagonally, so we expand over face- AND
// diagonal-adjacent cells. Digs each reachable block of `blocktypes`, equipping
// the right pickaxe per block (so it actually drops) and pathing close so the
// pathfinder doesn't thrash. Bounded by `max`. Returns how many blocks it mined.
async function harvestConnectedVein(bot, startPos, blocktypes, max=64) {
    const NB = [
        [1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1],
        [1,1,0],[1,-1,0],[-1,1,0],[-1,-1,0],[0,1,1],[0,1,-1],[0,-1,1],[0,-1,-1],
        [1,0,1],[1,0,-1],[-1,0,1],[-1,0,-1],
    ];
    const isTarget = (b) => b && blocktypes.includes(b.name);
    const seen = new Set();
    const queue = [];
    // Seed with the neighbours of the already-mined start block.
    for (const [dx,dy,dz] of NB) queue.push(startPos.offset(dx,dy,dz));
    let mined = 0;
    while (queue.length && mined < max) {
        if (bot.interrupt_code) break;
        const p = queue.shift();
        const k = `${p.x},${p.y},${p.z}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const b = bot.blockAt(p);
        if (!isTarget(b)) continue;
        // ★Break via the same safeDig primitive as the main path — reach-guard prevents the
        // "抬头空挥" on a tall tree's high logs, the equip step keeps a sword off wood, and the
        // 8s backstop bounds each log. Expand neighbours regardless of outcome (a leaning/bent
        // trunk unreachable from here may be reachable from an adjacent cell).
        const r = await safeDig(bot, b, { maxMs: 8000, pickup: true });
        if (r === 'ok') mined++;
        for (const [dx,dy,dz] of NB) queue.push(p.offset(dx,dy,dz));
    }
    return mined;
}

export async function pickupNearbyItems(bot) {
    /**
     * Pick up all nearby items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the items were picked up, false otherwise.
     * @example
     * await skills.pickupNearbyItems(bot);
    **/
    const distance = 8;
    const maxAttempts = 10; // Prevent infinite loops
    const FOOD_ITEM_RE = /rotten_flesh|beef|porkchop|chicken|mutton|rabbit|cod|salmon|bread|apple|carrot|potato|melon|berries|stew/i;
    const droppedName = (entity) => {
        try {
            const it = entity && entity.getDroppedItem && entity.getDroppedItem();
            return it && it.name ? it.name : '';
        } catch (e) { return ''; }
    };
    const faminePickup = () => bot.food <= 2 || (bot.food <= 3 && bot.health <= 8);
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
    const _pkDBG = (m) => { try { fs_dz.appendFileSync('bots/_supervisor/mine_dbg.log', `[${new Date().toISOString()}] ★PICKUP ${m}\n`); } catch (e) {} };
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
            || Object.keys(c).find(n => /_planks$/.test(n) && c[n] > 0)
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
    // filler we carry (planks/dirt/cobble) toward open sky so the caller's retry lands in the
    // open. Bounded to 6 — escapes a shallow pocket; a human just towers out.
    // ★C300: include BADLANDS/desert fillers (terracotta/sandstone/red_sand) — the STUCK-ESCAPE pillar
    // that lets the bot tower out of a cramped/footing-less spot to place a table couldn't fire in a
    // mesa (it holds 400+ red_sand but FILL2 listed none), so table placement → tool/sword crafting
    // dead-locked there (T-0017 keystone; same C280/C288 whitelist gap, yet another site). Non-gravity
    // first (terracotta/sandstone — safe to stand on while towering), red_sand/sand last.
    const FILL2 = ['dirt', 'cobblestone', 'cobbled_deepslate', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'netherrack', 'oak_planks', 'spruce_planks', 'jungle_planks', 'birch_planks', 'dark_oak_planks', 'acacia_planks', 'mangrove_planks', 'cherry_planks'];
    const filler2 = () => {
        const c = world.getInventoryCounts(bot);
        return FILL2.find(n => (c[n] || 0) > 0)
            || Object.keys(c).find(n => (/_planks$|_log$|terracotta$|sandstone$/.test(n)) && c[n] > 0)
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

export async function discard(bot, itemName, num=-1) {
    /**
     * Discard the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to discard.
     * @param {number} num, the number of items to discard. Defaults to -1, which discards all items.
     * @returns {Promise<boolean>} true if the item was discarded, false otherwise.
     * @example
     * await skills.discard(bot, "oak_log");
     **/
    let discarded = 0;
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
    if (discarded === 0) {
        log(bot, `You do not have any ${itemName} to discard.`);
        return false;
    }
    log(bot, `Discarded ${discarded} ${itemName}.`);
    return true;
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
    let chest = world.getNearestBlock(bot, 'chest', 32);
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
    let chest = world.getNearestBlock(bot, 'chest', 32);
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
    let chest = world.getNearestBlock(bot, 'chest', 32);
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
    let item, name;
    if (itemName) {
        item = bot.inventory.findInventoryItem(itemName);
        name = itemName;
    }
    if (!item) {
        log(bot, `You do not have any ${name} to eat.`);
        return false;
    }
    const equipRes = await tickConfirm.equipConfirmed(bot, item.name, 'hand');
    if (!equipRes.ok) {
        log(bot, `Failed to equip ${item.name} to consume: ${equipRes.reason}.`);
        return false;
    }
    await bot.consume();
    log(bot, `Consumed ${item.name}.`);
    return true;
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
        if (isItemGoal && bot && bot.health <= 8 && bot.food < 18 && !normalFood) return 'lowhp-item-pickup';
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
    // ★走位质量: parkour 开 (上游默认) — 让规划器能跨 1 格缺口/小跳越,破碎地形不再
    // 只能绕路/挖路 (用户实拍"跨越地形困难"的主因之一). scaffold 仍关(不乱搭),maxDropDown
    // C281 提到 3(3 格落差零摔伤,允许小落差下跳;4-hop 连跳仍挡),lava 仍在 blocksToAvoid.
    nonDestructiveMovements.allowParkour = true;
    nonDestructiveMovements.maxDropDown = 3;
    nonDestructiveMovements.scafoldingBlocks = [];
    nonDestructiveMovements.placeCost = 2;
    nonDestructiveMovements.digCost = 10;
    
    nonDestructiveMovements.liquids.add(mc.getBlockId('water'));
    nonDestructiveMovements.liquids.add(mc.getBlockId('flowing_water'));
    nonDestructiveMovements.liquids.add(mc.getBlockId('lava'));
    nonDestructiveMovements.liquids.add(mc.getBlockId('flowing_lava'));
    
    const destructiveMovements = new pf.Movements(bot);
    destructiveMovements.canDig = true;
    destructiveMovements.allowParkour = true; // ★同上: 破坏式导航也允许 parkour 跨缺口
    destructiveMovements.maxDropDown = 2;
    // ★C319 (T-0053): let the DESTRUCTIVE fallback BUILD its way out, not just dig. A pocket /
    // mesa-terrace imprisonment (T-0052) is escapable ONLY by PLACING blocks (pillar up / bridge a
    // gap) — canDig alone can't rise out of a pit (digging up just lengthens the shaft you're stuck
    // at the bottom of). Both modes had scafoldingBlocks=[], so destructive A* returned noPath on
    // any up-and-over egress → goToPosition threw "refusing blind destructive navigation" and
    // stranded the bot (every caller, not just migrate which C318 band-aided). Give destructive the
    // fillers we ACTUALLY carry (planning with blocks we lack = a place-path that fails at exec).
    // Non-destructive stays scaffold-free — ordinary travel never improvises placement.
    const _SCAFFOLD_RE = /^(cobblestone|cobbled_deepslate|dirt|coarse_dirt|sand|red_sand|gravel|stone|granite|diorite|andesite|tuff|netherrack|sandstone|red_sandstone)$|_planks$|terracotta$/;
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
    const totalTimeout = 60000; // 60s total timeout
    const phaseStuckTimeout = 3000; // 3s stuck detection per phase
    const maxUnstickAttempts = 3;
    
    let currentMovements = nonDestructiveMovements;
    let isDestructive = false;
    let unstickAttempts = 0;

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
        while (Date.now() - totalStartTime < totalTimeout) {
            if (bot.interrupt_code) {
                throw new Error('Navigation interrupted');
            }

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
        
        const betterError = new Error(
            `Cannot reach destination after ${unstickAttempts} unstick attempts. ` +
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
            let blocks = world.getNearestBlocksWhere(bot, block => block.name === blockType && block.metadata === 0, range, 1);
            if (blocks.length === 0) {
                log(bot, `Could not find any source ${blockType} in ${range} blocks, looking for uncollectable flowing instead...`);
                blocks = world.getNearestBlocksWhere(bot, block => block.name === blockType, range, 1);
            }
            block = blocks[0];
        }
    }
    else {
        if (useAsync) {
            block = await world.getNearestBlockAsync(bot, blockType, range);
        } else {
            block = world.getNearestBlock(bot, blockType, range);
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
    log(bot, `Found ${entityType} ${distance} blocks away.`);
    await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z, min_distance);
    return true;
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
            door_pos = world.getNearestBlock(bot, door_type, 16).position;
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
    const beds = bot.findBlocks({
        matching: (block) => {
            return block.name.includes('bed');
        },
        maxDistance: 32,
        count: 1
    });
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
    let block = world.getNearestBlock(bot, type, 16);
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

    // ① _gravityPitTrap (C334 sand/gravel column): if a gravity block sits just
    // below the dig target (dy-1 / dy-2) or is poised to fall onto the cap (dy+2),
    // digging one down would bury the bot. Bail to seal instead.
    const _trapProbe = [
        bot.blockAt(feet.offset(0, -1, 0)),
        bot.blockAt(feet.offset(0, -2, 0)),
        bot.blockAt(feet.offset(0, 2, 0)),
    ];
    if (_trapProbe.some(_isGravity)) {
        log(bot, 'digOneCapOne: gravity column above/below (C334 _gravityPitTrap) — refusing dig-one, downgrade to seal.');
        return false;
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
    // can't fall through the pocket. Pick a solid filler we actually carry.
    const inv = world.getInventoryCounts(bot);
    const _CAP_PREFS = [
        'cobblestone', 'cobbled_deepslate', 'stone', 'dirt', 'deepslate',
        'andesite', 'diorite', 'granite', 'netherrack', 'tuff', 'oak_planks',
    ];
    let capName = _CAP_PREFS.find(n => (inv[n] || 0) > 0);
    if (!capName) {
        // Fall back to any carried solid block that isn't a gravity / falling type.
        const _block = bot.inventory.items().find(it =>
            !_isGravity({ name: it.name }) &&
            !/sword|pickaxe|axe|shovel|hoe|_ingot|_pickaxe|bucket|torch|seeds|^bed$|_bed$|food|apple|bread|meat|fish/.test(it.name) &&
            (mc.getItemId(it.name) != null));
        capName = _block ? _block.name : null;
    }

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

export async function pillarUp(bot, targetY = null) {
    /**
     * Tower straight up (the classic "jump and place a block under your feet"
     * climb) to escape a vertical shaft / deep pit where the pathfinder can't
     * find a walking route. Locates the open column to climb in, then leans on
     * the pathfinder's built-in 1x1 tower support — but in short vertical
     * increments and with digging disabled, so it never times out searching a
     * tall shaft (the failure that makes plain navigation tunnel sideways and
     * get stuck) and never wanders off to dig instead of climb.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} [targetY], Y to climb to. Defaults to the surface above
     *   the chosen column (clamped to the open part of that column).
     * @returns {Promise<boolean>} true if it reached (within 1 of) targetY.
     * @example
     * await skills.pillarUp(bot); // climb out of a shaft up to daylight
     **/
    const MAX_Y = 319;
    const isPassable = (b) => !b || b.boundingBox === 'empty';

    // How many open (non-solid) blocks rise above (x, fromY) before a ceiling.
    const openRunUp = (x, z, fromY) => {
        let y = fromY;
        while (y <= MAX_Y && isPassable(bot.blockAt(new Vec3(x, y, z)))) y++;
        return y - fromY;
    };
    // Highest solid block at (x,z) — i.e. the "surface".
    const surfaceY = (x, z) => {
        for (let y = MAX_Y; y > -64; y--) {
            if (!isPassable(bot.blockAt(new Vec3(x, y, z)))) return y;
        }
        return null;
    };

    // Only tower with full solid blocks we actually hold (no slabs/stairs/etc,
    // which don't make a reliable 1-high step).
    const SCAFFOLD = ['dirt', 'cobblestone', 'cobbled_deepslate', 'stone', 'deepslate',
        'netherrack', 'end_stone', 'granite', 'andesite', 'diorite', 'tuff', 'blackstone', 'gravel',
        'sand', 'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks',
        'acacia_planks', 'dark_oak_planks'];
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

    const start = bot.entity.position;
    const bx = Math.floor(start.x), by = Math.floor(start.y), bz = Math.floor(start.z);

    // --- Find the shaft column ---------------------------------------------
    // Prefer the column the bot already stands in. Only scan around when it's
    // capped low (bot tucked in a side pocket, not under the open shaft).
    let sx = bx, sz = bz;
    let bestRun = openRunUp(bx, bz, by + 1);
    if (bestRun < 3) {
        for (let dx = -2; dx <= 2; dx++) {
            for (let dz = -2; dz <= 2; dz++) {
                if (dx === 0 && dz === 0) continue;
                const nx = bx + dx, nz = bz + dz;
                // Must be a spot the bot could stand in: feet open, floor solid.
                const feet = bot.blockAt(new Vec3(nx, by, nz));
                const floor = bot.blockAt(new Vec3(nx, by - 1, nz));
                if (!isPassable(feet) || isPassable(floor)) continue;
                const run = openRunUp(nx, nz, by + 1);
                if (run > bestRun) { bestRun = run; sx = nx; sz = nz; }
            }
        }
    }
    if (bestRun < 2) {
        log(bot, `Can't pillar up: the ceiling is right overhead. You may need to dig up first.`);
        return false;
    }

    // --- Decide how high to climb ------------------------------------------
    if (targetY == null) {
        const sy = surfaceY(sx, sz);
        targetY = sy != null ? sy + 1 : by + bestRun;
    }
    // Never aim past the open part of the column — towering can't pass a ceiling.
    targetY = Math.min(Math.floor(targetY), by + bestRun);
    if (targetY <= by + 1) {
        log(bot, `Already at the top of this column (y=${by}).`);
        return true;
    }
    log(bot, `Pillaring up column (${sx}, ${sz}) from y=${by} to y=${targetY}.`);

    // Walk under the chosen column first when it isn't the current one.
    if (sx !== bx || sz !== bz) {
        try { await goToPosition(bot, sx + 0.5, by, sz + 0.5, 0.5); } catch (e) { /* best effort */ }
    }

    // --- Tower up in increments --------------------------------------------
    const moves = new pf.Movements(bot);
    moves.canDig = false;            // only tower, never tunnel
    moves.allow1by1towers = true;
    moves.scafoldingBlocks = usable.map(n => mc.getBlockId(n)).filter(id => id != null);
    moves.placeCost = 1;
    bot.pathfinder.setMovements(moves);

    const STEP = 6; // short legs so A* never times out searching a tall shaft
    try {
        while (Math.floor(bot.entity.position.y) < targetY) {
            if (bot.interrupt_code) { log(bot, `Pillar up interrupted.`); break; }
            if (!bot.inventory.items().some(i => usable.includes(i.name))) {
                log(bot, `Ran out of blocks to pillar up with.`);
                break;
            }
            const curY = Math.floor(bot.entity.position.y);
            const nextY = Math.min(curY + STEP, targetY);
            try {
                await bot.pathfinder.goto(new pf.goals.GoalBlock(sx, nextY, sz));
            } catch (e) {
                // pathfinder gave up on this leg; progress check below decides.
            }
            if (Math.floor(bot.entity.position.y) <= curY) {
                log(bot, `Stopped climbing at y=${Math.floor(bot.entity.position.y)} (couldn't place higher).`);
                break;
            }
        }
    } finally {
        bot.pathfinder.setGoal(null);
    }

    const finalY = Math.floor(bot.entity.position.y);
    const reached = finalY >= targetY - 1;
    log(bot, reached ? `Pillared up and reached y=${finalY}.` : `Pillared up to y=${finalY} (target was ${targetY}).`);
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
            let blocks = world.getNearestBlocksWhere(bot, block => block.name === targetName && block.metadata === 0, 64, 1);
            if (blocks.length === 0) {
                log(bot, `Could not find any source ${targetName}.`);
                return false;
            }
            block = blocks[0];
        }
        else {
            block = world.getNearestBlock(bot, targetName, 64);
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
     * @param {string} skillName, the file name without extension of the custom skill to run, e.g. "buildNetherPortal".
     * @param {...any} args, additional arguments forwarded to the custom skill.
     * @returns {Promise<any>} whatever the custom skill returns, or false if it could not be loaded.
     * @example
     * await skills.customSkill(bot, "buildNetherPortal");
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
