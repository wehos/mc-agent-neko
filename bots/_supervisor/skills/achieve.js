// Hot-reloadable GENERAL goal orchestrator. Give it any item goal and it
// recursively figures out HOW to get it from mc data (craft recipe / smelting /
// block source + required tool) and satisfies each sub-goal — instead of the
// hardcoded autoProgress pipeline. Bypasses the LLM coder via run_skill:
//   {"skill":"achieve","args":["diamond_pickaxe"]}      // or {"item":"x","count":n}
// ctx = { skills, world, mc, Vec3, log }
import fs from 'fs';
import path from 'path';
const PROG = path.resolve(process.cwd(), 'bots', '_supervisor', 'progress.txt');
const prog = (s) => { try { fs.appendFileSync(PROG, `[${new Date().toISOString()}] ${s}\n`); } catch (e) {} };

const TOOL_TIER = ['wooden', 'stone', 'iron', 'diamond', 'netherite'];

// ── STATION REGISTRY (用户实拍怒斥: 满地没收的工作台 — "找不到台子→铺新的→旧的扔原地"
// 的状态管理缺失). stations.json 状态池: 每次放置必登记,造新前必查池(32格内有登记台子
// 就走过去用,绝不铺新的),路过顺手收(prepNether keepKit 读同一个池). ──────────────
const STATIONS_F = path.resolve(process.cwd(), 'bots', '_supervisor', 'stations.json');
export const stLoad = () => { try { const a = JSON.parse(fs.readFileSync(STATIONS_F, 'utf8')); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
export const stSave = (a) => { try { fs.writeFileSync(STATIONS_F, JSON.stringify(a)); } catch (e) {} };
export const stRegister = (type, p) => {
    const a = stLoad().filter(s => !(s.type === type && Math.abs(s.x - p.x) < 2 && Math.abs(s.y - p.y) < 2 && Math.abs(s.z - p.z) < 2));
    a.push({ type, x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), t: Date.now() });
    stSave(a);
};
export const stDeregister = (type, p) => {
    stSave(stLoad().filter(s => !(s.type === type && Math.abs(s.x - p.x) < 2 && Math.abs(s.y - p.y) < 2 && Math.abs(s.z - p.z) < 2)));
};
export const stNearest = (bot2, type, maxD) => {
    const me = bot2.entity.position;
    let best = null, bd = maxD;
    for (const s of stLoad()) {
        if (s.type !== type) continue;
        const dd = Math.hypot(s.x - me.x, s.y - me.y, s.z - me.z);
        if (dd < bd) { bd = dd; best = s; }
    }
    return best;
};

export default async function achieve(bot, ctx, goal, depth = 0, _active = new Set()) {
    const { skills, world, mc, Vec3, log } = ctx;
    const g = typeof goal === 'string' ? { item: goal, count: 1 } : goal;
    const item = g.item;
    const need = g.count || 1;
    // Count USABLE inventory only. world.getInventoryCounts sums ALL slots incl.
    // the personal 2x2 crafting grid (slots 1-4) + result (0). Items stranded there
    // by an interrupted bot.craft (e.g. a flee mid-craft) are NOT usable by
    // recipesFor/bot.craft — counting them makes achieve believe it has materials
    // it can't actually craft with (the "3 diamonds + 5 phantom sticks but
    // diamond_pickaxe won't craft" deadlock). Skip slots 0-4; keep armor (5-8, so
    // equipped gear still counts), storage (9-44) and offhand (45).
    const inv = () => { const c = {}; const sl = bot.inventory.slots || []; for (let i = 5; i < sl.length; i++) { const s = sl[i]; if (s && s.name) c[s.name] = (c[s.name] || 0) + s.count; } return c; };
    // Wood is fungible: any *_planks satisfies an oak_planks goal, any *_log an
    // oak_log goal. Jungle/oak/etc are interchangeable for crafting tools.
    const sumRe = (re) => Object.keys(inv()).filter(k => re.test(k)).reduce((s, k) => s + (inv()[k] || 0), 0);
    // For PLANKS use the MAX single-species count, not the sum. Crafting recipes
    // consume one plank species (a crafting_table needs 4 of the SAME type), so
    // "3 cherry + 2 oak" is NOT a usable 5 planks — treating it as such made
    // achieve think it could craft a table when it couldn't ("NO KNOWN
    // crafting_table" -> no table -> tool crafts fail). Logs stay summed (any log
    // species can be turned into planks).
    const maxRe = (re) => Object.keys(inv()).filter(k => re.test(k)).reduce((m, k) => Math.max(m, inv()[k] || 0), 0);
    // Stone-tier tool material is fungible too: cobblestone, cobbled_deepslate and blackstone
    // are interchangeable (and freely MIXABLE) for stone tools / furnace. The bot kept getting
    // stranded at deepslate depth with cobbled_deepslate it didn't "count" as cobblestone →
    // "collect stone [0/8]" forever → no stone pickaxe → no iron. SUM them (mixable, unlike planks).
    const STONE_MAT = /^(cobblestone|cobbled_deepslate|blackstone)$/;
    const have = (n = item) => /_planks$/.test(n) ? maxRe(/_planks$/) : (/_log$/.test(n) ? sumRe(/_log$/) : (n === 'cobblestone' ? sumRe(STONE_MAT) : (inv()[n] || 0)));
    const tag = '  '.repeat(depth);
    prog(`${tag}NEED ${need}x ${item} (have ${have()})`);
    if (have() >= need) return true;
    if (depth > 14 || _active.has(item)) { prog(`${tag}GIVEUP ${item} (loop/too deep)`); return false; }
    _active = new Set(_active); _active.add(item);
    // unstuck mode misreads "standing still while mining/digDown" as being stuck
    // and aborts the dig ("Digging aborted"/"trapped"). It resets to ON on every
    // agent restart, so turn it off at the top of each achieve run.
    if (depth === 0) {
        // Reclaim items stranded in the personal 2x2 crafting grid (slots 1-4) and
        // result slot (0) — an interrupted bot.craft leaves them there, where they
        // count toward getInventoryCounts but can't be used by recipesFor/bot.craft.
        // Move them back to storage so they become usable again.
        try {
            for (let s = 0; s <= 4; s++) {
                const it = bot.inventory.slots[s];
                if (it && it.name) {
                    const dest = bot.inventory.firstEmptyInventorySlot();
                    if (dest != null) { try { await bot.moveSlotItem(s, dest); await skills.wait(bot, 60); } catch (e) { prog(`${tag}reclaim slot${s} fail: ${e.message}`); } }
                }
            }
            // OFFHAND (slot 45) too — materials parked there are counted by inv() but are
            // INVISIBLE to bot.recipesFor/bot.craft (crafting pulls from main inventory
            // only). Saw it live: 16 oak_planks in offhand → "NEED stick (have 16 planks)"
            // yet recipesFor=[] → "NO KNOWN WAY to obtain stick" → pick-recraft chain dead.
            // Keep a shield there (that's the offhand's job); evict anything else.
            const oh = bot.inventory.slots[45];
            if (oh && oh.name && oh.name !== 'shield') {
                const dest = bot.inventory.firstEmptyInventorySlot();
                if (dest != null) { try { await bot.moveSlotItem(45, dest); await skills.wait(bot, 60); prog(`${tag}reclaimed offhand ${oh.name} x${oh.count} (unusable for crafting there)`); } catch (e) { prog(`${tag}reclaim offhand fail: ${e.message}`); } }
            }
        } catch (e) {}
        // Reclaim any crafting_table / furnace we left placed nearby (from a prior
        // run) — break it and pick it back up so we CARRY and reuse the same one,
        // instead of littering the world with stations and crafting a fresh table
        // every time (placeTable only crafts when we don't already hold one).
        try {
            for (const st of ['crafting_table', 'furnace']) {
                const nb = world.getNearestBlock(bot, st, 4);
                if (nb) {
                    const nbPos = nb.position;
                    await skills.collectBlock(bot, st, 1).catch(() => {});
                    // 收回成功(原地没了)→ 状态池注销
                    try { const still = bot.blockAt(nbPos); if (!still || still.name !== st) stDeregister(st, nbPos); } catch (e) {}
                }
            }
        } catch (e) {}
        // Disable non-survival modes that physically interrupt digging/pathing.
        // item_collecting ("Picking up item!") + unstuck + idle wandering kept
        // aborting digDown mid-mine. Keep self_defense/self_preservation/auto_eat
        // (those interrupts are legitimate — staying alive).
        try { for (const m of ['unstuck', 'item_collecting', 'torch_placing', 'hunting', 'cowardice', 'idle_staring', 'elbow_room']) bot.modes.setOn(m, false); } catch (e) {}
        // SURVIVAL: secure a weapon ASAP. A weaponless bot must flee every mob
        // (self_defense only fights when armed), which stalls the rebuild; a cheap
        // wooden sword lets it clear single zombies instead. Best-effort — never
        // blocks the actual goal. Skipped if we already hold any sword.
        // NIGHT GATE for the best-effort pre-steps (sword + wood buffer): both involve
        // EXPOSED surface work (chopping). A naked night respawn that runs these next to
        // the mob that just killed it feeds the death spiral — at night on the surface,
        // skip them and let the orchestrator's hole-up own the night; the pre-steps fire
        // on the next daytime achieve.
        const _nightExposed = (() => { try { const t = bot.time.timeOfDay; return t >= 13000 && t <= 23000 && bot.entity.position.y >= 50 && !(bot._mobility && bot._mobility.enclosed); } catch (e) { return false; } })();   // enclosed(封闭地穴)豁免——C32 同款
        try {
            const hasSword = Object.keys(inv()).some(n => /_sword$/.test(n) && inv()[n] > 0);
            if (!hasSword && !_nightExposed) await achieve(bot, ctx, 'wooden_sword', depth + 1, _active).catch(() => {});
        } catch (e) {}
        // PLAN AHEAD — stock a WOOD BUFFER up front. Every tool/table/furnace craft
        // needs a few planks; gathered just-in-time, each shortfall sends the bot on a
        // slow climb back to the surface for 1-2 planks (the deep<->surface yo-yo that
        // wastes minutes once it's mining at depth). One bulk chop now — while we're
        // still at/near the surface early in the run — covers the whole tree+iron tier,
        // so later crafts draw from inventory instead of re-surfacing. Best-effort.
        try {
            const logBuf = 8;
            // Gate on PLANKS too — the buffer exists to supply planks; with 16 planks held,
            // chopping more wood is pure waste AND can deadlock (saw it: all nearby trees on
            // an unreachable y79 hillside → blacklist/staircase thrash forever while sticks
            // were one 2x2 craft away). TIMEBOX the chop for the same reason: a tree-hunt
            // that can't succeed must not hold the whole achieve hostage.
            if (sumRe(/_log$/) < 6 && sumRe(/_planks$/) < 8 && !_nightExposed) {
                await step('stock wood buffer', () => Promise.race([
                    skills.customSkill(bot, 'chopWood', logBuf - sumRe(/_log$/)),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('woodbuf-timeout')), 90000)),
                ]).catch(e => { try { bot.pathfinder.stop(); } catch (_) {} try { bot.clearControlStates(); } catch (_) {} }));
            }
        } catch (e) {}
    }

    // ---- helpers ----
    const findTable = () => world.getNearestBlock(bot, 'crafting_table', 5);
    const affordableRecipe = (recipes) => {
        const h = {}; for (const it of bot.inventory.items()) h[it.type] = (h[it.type] || 0) + it.count;
        for (const r of recipes) { const nd = {}; for (const d of (r.delta || [])) if (d.count < 0) nd[d.id] = (nd[d.id] || 0) - d.count; if (Object.entries(nd).every(([t, c]) => (h[t] || 0) >= c)) return r; }
        return null;
    };
    const craftNow = async (count) => {
        const id = mc.getItemId(item); if (id == null) return false;
        const table = findTable();
        let rs = bot.recipesFor(id, null, 1, table) || [];
        if (rs.length === 0) rs = bot.recipesFor(id, null, 1, null) || [];
        if (rs.length === 0) {
            // bot.recipesFor can return [] for items that ARE craftable right now (seen
            // live: stick with 16 oak_planks held → instant "NO KNOWN WAY", which poisoned
            // the whole pick-recraft chain into a tree-hunt deadlock). mindcraft's
            // craftRecipe has independent recipe resolution — try it before giving up.
            const before0 = have();
            prog(`${tag}recipesFor empty for ${item} — trying craftRecipe fallback`);
            try { await skills.craftRecipe(bot, item, count); } catch (e) { prog(`${tag}craftRecipe fallback fail: ${e.message}`); }
            return have() > before0;
        }
        const r = affordableRecipe(rs) || rs[0];
        // Stand RIGHT NEXT TO the table before crafting. findTable's radius is 5,
        // but bot.craft against a table ~4-5 blocks away clicks ingredients into the
        // grid then fails to retrieve the result — consuming materials while losing
        // the product (this silently ate 14 diamonds: gear crafts reported failure
        // yet the diamonds were gone). Verify by product count, not bot.craft's
        // return, so a lossy craft is reported as failure rather than a phantom win.
        if (table) { try { await skills.goToPosition(bot, table.position.x, table.position.y, table.position.z, 2); } catch (e) {} }
        const before = have();
        // Protect the craft from concurrent MODE actions. A tick-driven mode firing
        // mid-craft (item_collecting walking off to grab a dropped item, auto_eat,
        // self_preservation moveAway, ...) moves the bot / changes the held item /
        // opens another window and CORRUPTS the in-progress craft window — ingredients
        // get consumed but the product is never retrieved (this silently ate diamonds
        // and planks). Freeze movement + disable interrupting modes for the ~1s craft.
        const _guard = ['item_collecting', 'auto_eat', 'self_defense', 'self_preservation', 'hunting', 'torch_placing', 'unstuck', 'cowardice', 'idle_staring', 'elbow_room', 'tool_keeper'];
        const _prev = {};
        try { bot.clearControlStates(); } catch (e) {}
        try { for (const m of _guard) if (bot.modes && bot.modes.exists(m)) { _prev[m] = bot.modes.isOn(m); bot.modes.setOn(m, false); } } catch (e) {}
        try { await bot.craft(r, count, table || undefined); }
        catch (e) { prog(`${tag}craft ${item} fail: ${e.message}`); }
        finally { try { for (const m in _prev) bot.modes.setOn(m, _prev[m]); } catch (e) {} }
        return have() > before;
    };
    const placeTable = async () => {
        if (findTable()) { try { stRegister('crafting_table', findTable().position); } catch (e) {} return true; }
        // 状态池优先: 32格内有登记过的台子 → 走过去用,绝不铺新的 (满地工作台的根治)
        try {
            const reg = stNearest(bot, 'crafting_table', 32);
            if (reg) {
                prog(`${tag}registered table @${reg.x},${reg.y},${reg.z} — walking to reuse`);
                try { await skills.goToPosition(bot, reg.x, reg.y, reg.z, 2); } catch (e) {}
                const ft = findTable();
                if (ft) { stRegister('crafting_table', ft.position); return true; }
                stDeregister('crafting_table', reg);
                prog(`${tag}registered table vanished — deregistered, will craft fresh`);
            }
        } catch (e) {}
        if (!have('crafting_table')) await achieve(bot, ctx, 'crafting_table', depth + 1, _active);
        // Robust, cheat-free placement (core placeBlockNearby digs a niche on solid
        // footing, retries, relocates). No more /setblock fallback — if it genuinely
        // can't place, we return false and let achieveLoop retry, rather than cheat.
        // TIMEBOX each attempt: placeBlockNearby can HANG indefinitely deep underground
        // in a cramped/sealed shaft (no open cell to relocate to), which froze the whole
        // run for minutes inside ensureTool and never let the caller (e.g. the diamond
        // branch's surface-and-retry) run. On hang, stop the pathfinder and bail so the
        // caller can recover (climb to the surface where there's room to place).
        for (let a = 0; a < 3 && !findTable(); a++) {
            await Promise.race([
                skills.placeBlockNearby(bot, 'crafting_table'),
                new Promise((_, rej) => setTimeout(() => rej(new Error('place-timeout')), 30000)),
            ]).catch(() => { try { bot.pathfinder.stop(); } catch (_) {} try { bot.clearControlStates(); } catch (_) {} });
            if (!findTable()) await skills.wait(bot, 200);
        }
        const placed = findTable();
        if (placed) { try { stRegister('crafting_table', placed.position); } catch (e) {} }   // 放置必登记
        return !!placed;
    };

    // ---- special collectors ----
    if (item.endsWith('_log')) { await step(`chop ${item}`, () => skills.customSkill(bot, 'chopWood', need)); return have() >= need; }
    if (/_planks$/.test(item)) {
        if (have() >= need) return true; // any *_planks already counts
        let log = Object.keys(inv()).find(k => /_log$/.test(k) && inv()[k] > 0);
        if (!log) {
            // NIGHT GATE: chopping for planks at night on the exposed surface is the death
            // spiral's favorite entry (saw it 50ms after a respawn, beside the killer mob).
            // Fail fast — the orchestrator's hole-up owns the night; planks resume at dawn.
            const _ne = (() => { try { const t = bot.time.timeOfDay; return t >= 13000 && t <= 23000 && bot.entity.position.y >= 50 && !(bot._mobility && bot._mobility.enclosed); } catch (e) { return false; } })();   // enclosed(封闭地穴)豁免夜门——与 chopWood NIGHT-BAIL/prepNether 夜hold 同款(C32)
            if (_ne) { prog(`${tag}night-exposed — skip chopping for planks (hole up owns the night)`); return false; }
            await step('chop for planks', () => skills.customSkill(bot, 'chopWood', Math.ceil(need / 4) + 1));
            log = Object.keys(inv()).find(k => /_log$/.test(k) && inv()[k] > 0);
        }
        if (log) { const pk = log.replace('_log', '_planks'); await step(`craft ${pk} x${need}`, () => skills.craftRecipe(bot, pk, need)); }
        return have() >= need;
    }
    if (item === 'diamond' || item === 'diamond_ore' || item === 'deepslate_diamond_ore') {
        // MANDATORY tool first: a stone pickaxe CANNOT harvest diamond (ore won't
        // drop). Secure iron+ pickaxe BEFORE anything else, and abort the whole
        // dive if we can't — descending with a stone pickaxe just wastes time and
        // health for zero diamonds. (Past bug: ensureTool failed silently, armor
        // then ate all the iron, and the bot dove pickaxe-less.)
        const hasIronPick = () => Object.keys(inv()).some(n => /^(iron|diamond|netherite)_pickaxe$/.test(n) && inv()[n] > 0);
        await ensureTool('iron_pickaxe');
        if (!hasIronPick() && Math.floor(bot.entity.position.y) < 50) {
            // Couldn't secure the pickaxe AND we're deep — almost certainly because a
            // crafting table can't be seated in a cramped mine shaft (the 3x3 pickaxe
            // recipe then fails -> "NO KNOWN WAY" -> dive hangs forever, sealed-in so it
            // never even dies to reset). Climb to the SURFACE (open room) and retry the
            // craft there. This unsticks the deep-broken-pickaxe trap.
            await step('surface to craft pickaxe', () => Promise.race([
                skills.customSkill(bot, 'surfaceUp', 63),
                new Promise((_, rej) => setTimeout(() => rej(new Error('surfaceUp-timeout')), 60000)),
            ]).catch(e => { try { bot.pathfinder.stop(); } catch (_) {} try { bot.clearControlStates(); } catch (_) {} }));
            await ensureTool('iron_pickaxe');
        }
        if (!hasIronPick()) { prog(`${tag}ABORT diamond: still no iron+ pickaxe (stone can't harvest diamond)`); return false; }
        // Carry a SPARE iron pickaxe. The slow water-aware descent + branch-mining burns
        // through one pickaxe's ~250 durability before reaching diamond, and remaking it
        // deep underground fails (can't reliably seat a table down there) — the dive then
        // ABORTs pickaxe-less with diamond in x-ray range (exactly what just happened).
        // A second pickaxe lets collectBlock keep harvesting after the first wears out.
        await achieve(bot, ctx, { item: 'iron_pickaxe', count: 2 }, depth + 1, _active).catch(() => {});
        // SURVIVAL prep is best-effort ONLY and runs AFTER the pickaxe is in hand,
        // so it can never starve the (mandatory) pickaxe of iron. Deep caves =
        // skeletons/zombies; armor+torches keep an un-killed bot alive, but a
        // missing helmet must not block the dive.
        await step('combat kit (sword+shield+armor)', async () => {
            // Real combat kit for the deep dive: a sword to kill, a SHIELD to block
            // skeleton arrows / hits (self_defense's shieldFight closes under guard),
            // and body armour. This lets the bot WIN fights instead of only fleeing.
            await achieve(bot, ctx, 'stone_sword', depth + 1, _active).catch(() => {});
            await achieve(bot, ctx, 'shield', depth + 1, _active).catch(() => {});
            await achieve(bot, ctx, 'iron_chestplate', depth + 1, _active).catch(() => {});
            // (iron_helmet dropped: chestplate + stone_sword + flee logic already
            // keeps the bot alive through the dive; mining 5 more iron for a helmet
            // every achieveLoop retry was pure wasted time before the dive.)
            if (bot.armorManager) try { await bot.armorManager.equipAll(); } catch (e) {}
        });
        // PRE-DIVE STOCKING (plan ahead / carry a buffer): gather consumables at/near
        // the surface BEFORE descending, so the bot never has to climb back up for
        // wood mid-dive (the cause of the repeated dig-down / pillar-up / surface
        // round-trips). Spare logs = raw material to craft sticks/handles deep down;
        // a healthy stick + torch buffer covers tool repairs and lighting the shaft.
        await step('pre-dive stock (logs/sticks/torches)', async () => {
            await achieve(bot, ctx, { item: 'oak_log', count: 4 }, depth + 1, _active).catch(() => {});
            await achieve(bot, ctx, { item: 'stick', count: 8 }, depth + 1, _active).catch(() => {});
            await achieve(bot, ctx, { item: 'torch', count: 32 }, depth + 1, _active).catch(() => {});
        });
        // Top up HEALTH + FOOD at the surface before descending. The bot kept dying
        // in deep caves because it dove at ~10 HP with no food to regen, so a single
        // skeleton volley was lethal. Hunt + eat to full first (animals are here at
        // the surface; there are none at y-50). Best-effort.
        // ★#23 FIX: TIMEBOX the dive steps. mineDiamonds/feedUp can HANG (pathfind/collectBlock
        // to an unreachable target deep down) with no internal progress → progress.txt+agent.err
        // both go stale → froze the whole (best-resourced) run until the watchdog hard-restarted
        // it 379s later. A timeout returns control to achieve, which re-evaluates (logs → resets
        // the freeze clock → keeps the bot ALIVE + its kit, then re-dives) instead of freezing.
        await step('feed up to full HP before dive', () => Promise.race([
            skills.customSkill(bot, 'feedUp', 18),
            new Promise((_, rej) => setTimeout(() => rej(new Error('feedUp-timeout')), 60000)),
        ]).catch(e => { try { bot.pathfinder.stop(); } catch (_) {} try { bot.clearControlStates(); } catch (_) {} }));
        await step('mine diamonds (deep+xray)', () => Promise.race([
            skills.customSkill(bot, 'mineDiamonds', need),
            // 300s (not 180): the WATER-AWARE descent from surface to y-52 (~112 blocks, slow
            // because it seals sides vs aquifers each step) ate the whole 180s before ever
            // REACHING diamond depth → it branch-mined stone (604 cobblestone, zero deepslate)
            // and never saw a diamond. 300s lets it actually get down + mine. Still < the 360s
            // freeze-watchdog, and mineDiamonds log()s as it digs so agent.err stays fresh
            // (watchdog won't false-trip during a legit slow dive — only a true silent hang).
            new Promise((_, rej) => setTimeout(() => rej(new Error('mineDiamonds-timeout')), 300000)),
        ]).catch(e => { try { bot.pathfinder.stop(); } catch (_) {} try { bot.clearControlStates(); } catch (_) {} }));
        return have() >= need;
    }

    // ---- 1. SMELT (smelted products prefer smelting; avoids ingot<->nugget craft loops) ----
    const smeltRaw = mc.getItemSmeltingIngredient(item);
    if (smeltRaw) {
        const okRaw = await achieve(bot, ctx, { item: smeltRaw, count: need }, depth + 1, _active);
        await achieve(bot, ctx, { item: 'coal', count: Math.max(1, Math.ceil(need / 8)) }, depth + 1, _active).catch(() => {});
        // Ensure a FURNACE exists before smelting. smeltSafe's own craftRecipe
        // ('furnace') silently fails when no crafting table is nearby (furnace is
        // a 3x3 recipe needing a table) -> no furnace -> smeltItem returns 0
        // ingots no matter how many times we retry. Routing the furnace through
        // achieve() reuses its place-table logic so the furnace actually gets made.
        await achieve(bot, ctx, 'furnace', depth + 1, _active).catch(() => {});
        if (okRaw) {
            // Retry the smelt: the FIRST smelt right after (re)login often yields 0
            // ingots because the furnace's placeBlock blockUpdate times out before
            // the chunk is fully ready. The furnace persists once placed, so a 2nd
            // pass succeeds. Loop until we have enough or the raw material is gone.
            for (let s = 0; s < 3 && have() < need && have(smeltRaw) > 0; s++) {
                await step(`smelt ${smeltRaw}->${item} [${have()}/${need}]`, () => skills.customSkill(bot, 'smeltSafe', smeltRaw, Math.min(need - have(), have(smeltRaw))));
            }
            if (have() >= need) return true;
        }
    }

    // ---- 2. CRAFT ----
    let recipes = mc.getItemCraftingRecipes(item);
    // Skip "reverse" recipes that craft the item from its own aggregate block
    // (e.g. coal<-coal_block, raw_iron<-raw_iron_block, iron_ingot<-iron_block/
    // iron_nugget) — those are dead-end loops; the real source is collect/smelt.
    if (recipes) recipes = recipes.filter(([ing2]) => !Object.keys(ing2).some(k => k === item + '_block' || k.endsWith('_nugget') || k === 'iron_block' || k === 'gold_block' || k === 'diamond_block'));
    if (recipes && recipes.length) {
        const [ing, meta] = recipes[0];
        const per = (meta && meta.craftedCount) || 1;
        const times = Math.max(1, Math.ceil((need - have()) / per));
        const total = Object.values(ing).reduce((a, b) => a + b, 0);
        const needsTable = total > 4 || /pickaxe|sword|_axe|shovel|hoe|furnace|chest|bed|shield|bow|helmet|chestplate|leggings|boots/.test(item);
        // ENSURE THE TABLE FIRST, then gather the target's ingredients. Crafting a NEW
        // crafting_table consumes 4 planks; if we gather the target's ingredients
        // BEFORE placing the table, table-making eats those planks and the target
        // craft then fails with "missing ingredient" — the wooden_sword/wooden_pickaxe
        // bootstrap deadlock (chop 4 planks -> table eats all 4 -> sword craft fails ->
        // "NO KNOWN WAY"). Doing the table first means it chops its own wood, then the
        // ingredient pass chops fresh wood for the actual item. (Once a table exists
        // nearby, placeTable just reuses it for free.)
        if (needsTable) await step('place table', () => placeTable());
        // Satisfy ingredients best-effort (don't bail on one — craftNow picks
        // whatever variant we actually have, so jungle_planks covers oak_planks).
        for (const [name, cnt] of Object.entries(ing)) {
            await achieve(bot, ctx, { item: name, count: cnt * times }, depth + 1, _active);
        }
        await step(`craft ${item} x${times}`, () => craftNow(times));
        if (have() >= need) return true;
    }

    // ---- 3. COLLECT (x-ray, mine the source BLOCK) ----
    let sources = mc.getItemBlockSources(item);
    if ((!sources || !sources.length) && item.endsWith('_ore')) sources = [item];
    if (sources && sources.length) {
        let block = sources.find(s => !/deepslate/.test(s)) || sources[0];
        // STONE-TIER DEPTH FIX: cobblestone's only source is 'stone', but at deepslate depth
        // (y<0) there IS no stone — so "collect stone" found nothing forever. cobbled_deepslate
        // is an equal stone-tool material (counted by have() now), so if no stone is reachable
        // but deepslate is, mine deepslate instead. (A human at deepslate just mines deepslate.)
        if (item === 'cobblestone' && !world.getNearestBlock(bot, 'stone', 12) && world.getNearestBlock(bot, 'deepslate', 12)) block = 'deepslate';
        // Craftable/placeable items (torch, crafting_table) "drop from themselves"
        // but don't occur naturally — don't loop trying to mine them.
        if (block === item && mc.getItemCraftingRecipes(item) && !item.endsWith('_ore')) { prog(`${tag}${item} is craftable, not naturally minable — give up collect`); return false; }
        const tool = mc.getBlockTool(block);
        if (tool) await ensureTool(tool);
        // Loop: x-ray collect within 64, then dig deeper to expose more, until we
        // have enough. One pass rarely yields enough ore (the #1 cause of "NO KNOWN
        // iron_ingot" -> iron_pickaxe fail).
        let g2 = 0;
        while (have() < need && g2++ < 8) {
            if (bot.interrupt_code) break;
            // ★徒手采石=零掉落死循环 (BARE-HAND alarm 实拍: collect stone [0/3] 永远 0/3,
            // 对着脚下石头白刨几分钟): pick-requiring block + no pickaxe → 这条采集路线
            // 是死的,立即放弃让上层换路径(找木→造镐)。
            if (/stone|deepslate|andesite|diorite|granite|tuff|ore$|obsidian|cobble/.test(block)
                && !bot.inventory.items().some(i => /_pickaxe$/.test(i.name))) {
                prog(`${tag}★NOPICK — collect ${block} drops nothing bare-handed; abandoning this branch (need a pickaxe first)`);
                return false;
            }
            // ★死亡热图避区 MVP (236前夜: 蜂窝区11分钟3死,且锚点回落世界出生点后雷区恰在
            // 圈内,缰绳反而圈住它): death_log 近50条里,16格内有3+死亡=雷区;身处雷区采矿
            // → 背着死亡质心撤24格再继续。x/z字段(为此而加)的第一个自动化消费者。
            try {
                const dlF = path.resolve(process.cwd(), 'bots', '_supervisor', 'death_log.jsonl');
                const dl = fs.readFileSync(dlF, 'utf8').trim().split('\n').slice(-50);
                const me3 = bot.entity.position;
                let nd = 0, cx3 = 0, cz3 = 0;
                for (const ln of dl) { try { const r = JSON.parse(ln); if (typeof r.x === 'number' && Math.hypot(r.x - me3.x, r.z - me3.z) < 16) { nd++; cx3 += r.x; cz3 += r.z; } } catch (e) {} }
                if (nd >= 3) {
                    cx3 /= nd; cz3 /= nd;
                    let dxz = Math.hypot(me3.x - cx3, me3.z - cz3) || 1;
                    const ux3 = (me3.x - cx3) / dxz, uz3 = (me3.z - cz3) / dxz;
                    prog(`${tag}★DEATH-ZONE (${nd}死/16格内) — 背质心撤24格再采`);
                    try { await skills.goToPosition(bot, Math.round(me3.x + ux3 * 24), null, Math.round(me3.z + uz3 * 24), 3); } catch (e) {}
                }
            } catch (e) {}
            // ★采矿缰绳 (deaths 214/216/217/221 全部坠亡在同一片 ±20,-40 雷区 — bot 自己旧矿井
            // 凿出来的蜂窝地形,而采矿路径无缰绳,digDown 链一路漂出家圈 100+ 格): 锚=bed.json
            // (家规划地)否则世界出生点;超 80 格先收 40 格再继续采。和 chopWood 的树缰绳同款。
            try {
                let ax2 = 0, az2 = 0;
                try { const bj2 = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'bed.json'), 'utf8')); if (typeof bj2.x === 'number') { ax2 = bj2.x; az2 = bj2.z; } } catch (e) {}
                const me2 = bot.entity.position;
                const dh2 = Math.hypot(me2.x - ax2, me2.z - az2);
                if (dh2 > 80) {
                    prog(`${tag}mining LEASH: ${Math.round(dh2)}格离锚 — 收40格再采`);
                    const ux2 = (ax2 - me2.x) / dh2, uz2 = (az2 - me2.z) / dh2;
                    try { await skills.goToPosition(bot, Math.round(me2.x + ux2 * 40), null, Math.round(me2.z + uz2 * 40), 3); } catch (e) {}
                }
            } catch (e) {}
            // collectBlock now exhausts the connected ore vein itself (veinFollow
            // 'auto'), so no separate vein pass is needed here.
            // TIMEBOX it: collectBlock can HANG indefinitely pathfinding to an ore it
            // can't reach (vein walled behind lava/across a ravine) — this froze the
            // whole run for 13 min stuck at "collect iron_ore [0/1]" with zero progress,
            // since the loop never got to the digDown that would expose fresh ground.
            // On timeout, stop the pathfinder and fall through to digDown to relocate.
            await step(`collect ${block} (xray) [${have()}/${need}]`, () => Promise.race([
                skills.collectBlock(bot, block, need - have()),
                new Promise((_, rej) => setTimeout(() => rej(new Error('collect-timeout')), 25000)),
            ]).catch(e => { try { bot.pathfinder.stop(); } catch (_) {} try { bot.clearControlStates(); } catch (_) {} throw e; }));
            if (have() >= need) break;
            // ★雷区禁挖 (242-246五连死的真磁铁: 雷区过滤让x-ray找不到目标后,回落"原地往
            // 下挖"——而出生点就在蜂窝雷区屋顶上,digDown直接凿进死亡洞穴): 身处雷区时
            // digDown 跳过,改为撤离后下轮再挖。
            let _inDZ = false;
            try {
                const dlZ = fs.readFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'death_log.jsonl'), 'utf8').trim().split('\n').slice(-50);
                const meZ = bot.entity.position;
                let ndZ = 0;
                for (const ln of dlZ) { try { const r = JSON.parse(ln); if (typeof r.x === 'number' && Math.hypot(r.x - meZ.x, r.z - meZ.z) < 16) ndZ++; } catch (e) {} }
                _inDZ = ndZ >= 3;
            } catch (e) {}
            if (_inDZ) { prog(`${tag}★雷区禁挖 — 跳过digDown,先撤离`); continue; }
            await step(`dig down to expose more ${block}`, () => skills.digDown(bot, 8));
        }
        return have() >= need;
    }

    prog(`${tag}NO KNOWN WAY to obtain ${item}`);
    return false;

    // ---- nested helpers needing closures ----
    async function step(label, fn) { prog(`${tag}> ${label}`); try { await fn(); } catch (e) { prog(`${tag}! ${label}: ${e.message}`); } }
    async function ensureTool(toolName) {
        // already have this tool or a better one in same family?
        const fam = toolName.replace(/^(wooden|stone|iron|diamond|netherite)_/, '');
        const tierOf = (n) => TOOL_TIER.indexOf((n.match(/^(wooden|stone|iron|diamond|netherite)_/) || [, ''])[1]);
        const want = tierOf(toolName);
        const haveGood = Object.keys(inv()).some(n => n.endsWith('_' + fam) && tierOf(n) >= want && inv()[n] > 0);
        if (haveGood) return true;
        return await achieve(bot, ctx, toolName, depth + 1, _active);
    }
}
