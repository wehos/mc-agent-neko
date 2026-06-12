import * as mc from "../../utils/mcdata.js";
import * as world from "./world.js";
import * as tickConfirm from "./tick_confirm.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import settings from "../../../settings.js";
import path from 'path';
import { pathToFileURL } from 'url';

const blockPlaceDelay = settings.block_place_delay == null ? 0 : settings.block_place_delay;
const useDelay = blockPlaceDelay > 0;

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
class _NoScaffoldMovements extends _PFMovements {
    constructor(...args) {
        super(...args);
        this.scafoldingBlocks = [];
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
    }
}
pf.Movements = _NoScaffoldMovements;

export function log(bot, message) {
    bot.output += message + '\n';
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
        if (bot.entity.position.distanceTo(pos) > 5) {
            console.log('moving to mob...')
            await goToPosition(bot, pos.x, pos.y, pos.z);
        }
        console.log('attacking mob...')
        await bot.attack(entity);
        // bot.attack sends use_entity fire-and-forget; settle one tick so the
        // damage tick lands before caller queries entity state.
        await tickConfirm.sleepMs(100);
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
async function safeDig(bot, block, { maxMs = 15000, approach = true, equip = true, pickup = false } = {}) {
    const dead = (b) => !b || b.boundingBox === 'empty' || b.name === 'air';
    if (dead(block)) return 'gone';
    const reachOf = () => bot.entity.position.offset(0, 1.62, 0).distanceTo(block.position.offset(0.5, 0.5, 0.5));
    try {
        if (approach && reachOf() > 4.4)
            await goToPosition(bot, block.position.x, block.position.y, block.position.z, 2);
        if (reachOf() > 4.6) return 'unreachable';
        const cur = bot.blockAt(block.position);
        if (dead(cur)) return 'gone';
        if (equip) await equipForDig(bot, cur);
        // ★Shorter timeout for normal blocks: a mineral/block we CAN'T actually break (wedged in
        // a corner / behind rock whose face we can't reach — the "对着夹角拼命空挥" the user keeps
        // seeing) gets abandoned in ~8s instead of flailing the full 15s. 8s safely covers every
        // legit slow break (barehand stone 7.5s, any pick far less); only genuinely hard blocks
        // (obsidian ~9.4s w/ diamond pick, for the nether portal) keep the long backstop. We can't
        // use canSeeBlock to pre-skip — x-ray ore is buried (6 faces hidden) and would all be skipped.
        const _hard = /obsidian|ancient_debris|reinforced/.test(cur.name || '');
        const _digMs = _hard ? maxMs : Math.min(maxMs, 8000);
        await Promise.race([
            bot.dig(cur),
            new Promise((_, rej) => setTimeout(() => rej(new Error('dig-timeout')), _digMs)),
        ]);
        if (pickup) { try { await pickupNearbyItems(bot); } catch (e) {} }
        return 'ok';
    } catch (e) {
        try { bot.stopDigging(); } catch (_) {}
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
    // A human in a ravine takes 2-block steps or doesn't go. Clamp it.
    movements.maxDropDown = 2;

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
            }, 64, 1);
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
        const block = blocks[0];
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
                const r = await safeDig(bot, block, { maxMs: 15000, equip: false });
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
    const getNearestItem = bot => bot.nearestEntity(entity => entity.name === 'item' && bot.entity.position.distanceTo(entity.position) < distance);
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
            if (error.message === 'Pathfind timeout') {
                log(bot, `⚠️ Failed to reach item (timeout), skipping.`);
                consecutiveFailures++;
                if (consecutiveFailures >= 3) {
                    log(bot, `Too many consecutive failures, stopping item pickup.`);
                    break;
                }
            }
        }
        
        await new Promise(resolve => setTimeout(resolve, 200));
        let prev = nearestItem;
        nearestItem = getNearestItem(bot);
        if (prev === nearestItem) {
            consecutiveFailures++;
            if (consecutiveFailures >= 2) {
                log(bot, `Unable to reach item at ${prev.position}, giving up.`);
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
            if (!block.canHarvest(itemId)) {
                log(bot, `Don't have right tools to break ${block.name}.`);
                return false;
            }
        }
        
        // Add timeout to prevent infinite hanging
        const digTimeout = 60000; // 60 seconds max
        const digPromise = bot.dig(block, true);
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Dig timeout')), digTimeout)
        );
        
        try {
            await Promise.race([digPromise, timeoutPromise]);
            log(bot, `Broke ${block.name} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
        } catch (error) {
            if (error.message === 'Dig timeout') {
                log(bot, `⚠️ Digging ${block.name} timed out after ${digTimeout/1000}s, stopping dig.`);
                bot.stopDigging();
                return false;
            }
            throw error;  // Re-throw other errors
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

    if (blockType === 'air') {
        log(bot, `Placing air (removing block) at ${target_dest}.`);
        return await breakBlockAt(bot, x, y, z);
    }

    if (bot.modes.isOn('cheat') && !dontCheat) {
        if (bot.restrict_to_inventory) {
            let block = bot.inventory.findInventoryItem(blockType);
            if (!block) {
                log(bot, `Cannot place ${blockType}, you are restricted to your current inventory.`);
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
        return false;
    }

    const targetBlock = bot.blockAt(target_dest);
    if (targetBlock.name === blockType || (targetBlock.name === 'grass_block' && blockType === 'dirt')) {
        log(bot, `${blockType} already at ${targetBlock.position}.`);
        return false;
    }
    const empty_blocks = ['air', 'water', 'lava', 'grass', 'short_grass', 'tall_grass', 'snow', 'dead_bush', 'fern'];
    if (!empty_blocks.includes(targetBlock.name)) {
        log(bot, `${targetBlock.name} in the way at ${targetBlock.position}.`);
        const removed = await breakBlockAt(bot, x, y, z);
        if (!removed) {
            log(bot, `Cannot place ${blockType} at ${targetBlock.position}: block in the way.`);
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
        return false;
    }

    // Check for interrupt before potentially long operations
    if (bot.interrupt_code) {
        log(bot, `Interrupted before placing ${blockType}.`);
        return false;
    }

    const pos = bot.entity.position;
    const pos_above = pos.plus(Vec3(0,1,0));
    const dont_move_for = ['torch', 'redstone_torch', 'redstone', 'lever', 'button', 'rail', 'detector_rail', 
        'powered_rail', 'activator_rail', 'tripwire_hook', 'tripwire', 'water_bucket', 'string'];
    if (!dont_move_for.includes(item_name) && (pos.distanceTo(targetBlock.position) < 1.1 || pos_above.distanceTo(targetBlock.position) < 1.1)) {
        // too close
        let goal = new pf.goals.GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 2);
        let inverted_goal = new pf.goals.GoalInvert(goal);
        await goToGoal(bot, inverted_goal);
    }
    
    if (bot.interrupt_code) {
        log(bot, `Interrupted while positioning for ${blockType}.`);
        return false;
    }
    
    if (bot.entity.position.distanceTo(targetBlock.position) > 4.5) {
        // too far
        let pos = targetBlock.position;
        let movements = new pf.Movements(bot);
        bot.pathfinder.setMovements(movements);
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }

    // will throw error if an entity is in the way, and sometimes even if the block was placed
    try {
        if (item_name.includes('bucket')) {
            await useToolOnBlock(bot, item_name, buildOffBlock);
        }
        else {
            // Confirm the held slot lands on the server before we send block_place,
            // otherwise the server resolves the place packet against the previous
            // held item (typically 'air') and silently rejects it.
            const equipRes = await tickConfirm.equipConfirmed(bot, block_item.name, 'hand');
            if (!equipRes.ok) {
                log(bot, `Failed to equip ${block_item.name} to place: ${equipRes.reason}.`);
                return false;
            }
            await bot.lookAt(buildOffBlock.position.offset(0.5, 0.5, 0.5));
            const res = await tickConfirm.placeBlockConfirmed(
                bot, buildOffBlock, faceVec, target_dest, blockType,
                { retries: 2, confirmTimeoutMs: 600, backoffMs: 200 }
            );
            if (!res.ok) {
                log(bot, `Failed to place ${blockType} at ${target_dest}: ${res.error_class} (${res.reason}).`);
                return false;
            }
            log(bot, `Placed ${blockType} at ${target_dest}.`);
            return true;
        }
    } catch (err) {
        log(bot, `Failed to place ${blockType} at ${target_dest}.`);
        return false;
    }
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
    const _fill2 = () => { const c = world.getInventoryCounts(bot); return ['dirt','cobblestone','cobbled_deepslate','stone','andesite','diorite','granite','tuff','gravel','netherrack'].find(n => (c[n]||0) > 0) || Object.keys(c).find(n => /_planks$/.test(n) && c[n] > 0); };
    const _crampedNow = () => ![[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]].some(o => { const bl = bot.blockAt(bot.entity.position.offset(o[0],o[1],o[2])); return bl && empty.has(bl.name); });
    for (let up = 0; up < 8 && _crampedNow() && Math.floor(bot.entity.position.y) < 70 && !bot.interrupt_code; up++) {
        const f = _fill2(); if (!f) break;
        const h = bot.blockAt(bot.entity.position.offset(0, 2, 0));
        if (h && h.boundingBox === 'block' && !noBuild.has(h.name)) { try { await breakBlockAt(bot, h.x, h.y, h.z); } catch (e) {} }
        try { bot.setControlState('jump', true); await new Promise(r => setTimeout(r, 280)); const p = bot.entity.position.floored(); await placeBlock(bot, f, p.x, p.y - 1, p.z, 'top', true); bot.setControlState('jump', false); await new Promise(r => setTimeout(r, 150)); }
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
    const FILL2 = ['dirt', 'cobblestone', 'cobbled_deepslate', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'gravel', 'netherrack', 'oak_planks', 'spruce_planks', 'jungle_planks', 'birch_planks', 'dark_oak_planks', 'acacia_planks', 'mangrove_planks', 'cherry_planks'];
    const filler2 = () => { const c = world.getInventoryCounts(bot); return FILL2.find(n => (c[n] || 0) > 0) || Object.keys(c).find(n => /_planks$|_log$/.test(n) && c[n] > 0); };
    const headOpen = () => { const h = bot.blockAt(bot.entity.position.offset(0, 2, 0)); return !h || /^(air|cave_air|void_air|short_grass|tall_grass|snow)$/.test(h.name || ''); };
    for (let up = 0; up < 6 && filler2() && !bot.interrupt_code; up++) {
        if (!headOpen()) { const h = bot.blockAt(bot.entity.position.offset(0, 2, 0)); try { if (h) await breakBlockAt(bot, h.x, h.y, h.z); } catch (e) {} }
        const f = filler2(); if (!f) break;
        try {
            bot.setControlState('jump', true);
            await new Promise(r => setTimeout(r, 280));
            const p = bot.entity.position.floored();
            await placeBlock(bot, f, p.x, p.y - 1, p.z, 'top', true);
            bot.setControlState('jump', false);
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

/**
 * Execute pathfinding with a specific movement set and stuck timeout.
 * @returns {Promise<{success: boolean, stuckDetected: boolean}>}
 */
async function executePathfindingPhase(bot, goal, movements, stuckTimeoutMs, doorCheckInterval) {
    let stuckCheckInterval;
    let lastPosition = bot.entity.position.clone();
    let stuckTime = 0;
    let lastCheckTime = Date.now();
    const stuckRadius = 1.5; // Tighter radius for faster stuck detection
    
    bot.pathfinder.setMovements(movements);
    
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
        return { success: true, stuckDetected: false };
    } catch (err) {
        clearInterval(stuckCheckInterval);
        bot.pathfinder.setGoal(null);
        
        const errorMsg = err.message || err.toString();
        if (errorMsg.includes('Interrupted') || bot.interrupt_code) {
            throw new Error('Navigation interrupted');
        }
        if (errorMsg.includes('PhaseStuck')) {
            return { success: false, stuckDetected: true };
        }
        // Goal reached or path completed normally despite "error"
        if (errorMsg.includes('Goal') || errorMsg.includes('arrived')) {
            return { success: true, stuckDetected: false };
        }
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
            return;
        }
    }

    // Setup movements
    const nonDestructiveMovements = new pf.Movements(bot);
    const dontBreakBlocks = ['glass', 'glass_pane'];
    for (let block of dontBreakBlocks) {
        nonDestructiveMovements.blocksCantBreak.add(mc.getBlockId(block));
    }
    nonDestructiveMovements.placeCost = 2;
    nonDestructiveMovements.digCost = 10;
    
    nonDestructiveMovements.liquids.add(mc.getBlockId('water'));
    nonDestructiveMovements.liquids.add(mc.getBlockId('flowing_water'));
    nonDestructiveMovements.liquids.add(mc.getBlockId('lava'));
    nonDestructiveMovements.liquids.add(mc.getBlockId('flowing_lava'));
    
    const scaffoldBlocks = ['dirt', 'cobblestone', 'stone', 'netherrack'];
    scaffoldBlocks.forEach(blockName => {
        const blockId = mc.getBlockId(blockName);
        if (blockId) {
            nonDestructiveMovements.scafoldingBlocks.push(blockId);
        }
    });

    const destructiveMovements = new pf.Movements(bot);
    destructiveMovements.liquids.add(mc.getBlockId('water'));
    destructiveMovements.liquids.add(mc.getBlockId('flowing_water'));
    destructiveMovements.liquids.add(mc.getBlockId('lava'));
    destructiveMovements.liquids.add(mc.getBlockId('flowing_lava'));
    
    scaffoldBlocks.forEach(blockName => {
        const blockId = mc.getBlockId(blockName);
        if (blockId) {
            destructiveMovements.scafoldingBlocks.push(blockId);
        }
    });

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
    const nonDestructivePath = await bot.pathfinder.getPathTo(nonDestructiveMovements, goal, pathfind_timeout);
    if (nonDestructivePath.status === 'success') {
        currentMovements = nonDestructiveMovements;
        isDestructive = false;
        log(bot, `Found non-destructive path.`);
    } else {
        const destructivePath = await bot.pathfinder.getPathTo(destructiveMovements, goal, pathfind_timeout);
        if (destructivePath.status === 'success') {
            currentMovements = destructiveMovements;
            isDestructive = true;
            log(bot, `Found destructive path.`);
        } else {
            currentMovements = destructiveMovements;
            isDestructive = true;
            log(bot, `Path not found, attempting navigation with destructive movements.`);
        }
    }

    try {
        while (Date.now() - totalStartTime < totalTimeout) {
            if (bot.interrupt_code) {
                throw new Error('Navigation interrupted');
            }

            const result = await executePathfindingPhase(
                bot, goal, currentMovements, phaseStuckTimeout, doorCheckInterval
            );

            if (result.success) {
                clearInterval(doorCheckInterval);
                return true;
            }

            if (result.stuckDetected) {
                // Phase 1: Non-destructive stuck → switch to destructive
                if (!isDestructive) {
                    log(bot, `⚠️ Stuck with non-destructive path, switching to destructive...`);
                    currentMovements = destructiveMovements;
                    isDestructive = true;
                    continue;
                }

                // Phase 2: Destructive also stuck → manual unstick
                if (unstickAttempts < maxUnstickAttempts) {
                    unstickAttempts++;
                    log(bot, `⚠️ Stuck! Attempting manual unstick (${unstickAttempts}/${maxUnstickAttempts})...`);
                    await attemptUnstick(bot);
                    
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
                log(bot, `Path failed, attempting unstick (${unstickAttempts}/${maxUnstickAttempts})...`);
                await attemptUnstick(bot);
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
        throw betterError;
        
    } catch (err) {
        clearInterval(doorCheckInterval);
        bot.pathfinder.setGoal(null);
        
        const errorMsg = err.message || err.toString();
        if (errorMsg.includes('Interrupted') || bot.interrupt_code) {
            throw new Error('Navigation interrupted');
        }
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
    if (x == null || y == null || z == null) {
        log(bot, `Missing coordinates, given x:${x} y:${y} z:${z}`);
        return false;
    }
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
        'netherrack', 'granite', 'andesite', 'diorite', 'tuff', 'blackstone', 'gravel',
        'sand', 'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks',
        'acacia_planks', 'dark_oak_planks'];
    const held = new Set(bot.inventory.items().map(i => i.name));
    const usable = SCAFFOLD.filter(n => held.has(n));
    if (usable.length === 0) {
        log(bot, `Can't pillar up: no placeable full blocks (dirt/cobblestone/etc.) in inventory.`);
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
    return await fn(bot, ctx, ...args);
}
