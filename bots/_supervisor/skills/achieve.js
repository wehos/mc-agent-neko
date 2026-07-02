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
const FOOD_RE = /cooked_|_bread|^bread$|^apple$|golden_apple|carrot|potato|^beef$|porkchop|^chicken$|^mutton$|^cod$|^salmon$|melon_slice|sweet_berries|_stew|^rabbit$|baked_/;

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
    const edibleHeld = () => bot.inventory.items().some(i => i && i.name && FOOD_RE.test(i.name) && i.name !== 'rotten_flesh');
    const foodGoal = FOOD_RE.test(item);
    const lowFoodNoSnack = () => bot.food <= 8 && !edibleHeld();
    const hostileNear = (r = 12) => {
        try {
            return Object.values(bot.entities || {}).some(e => e && e.position && mc && mc.isHostile && mc.isHostile(e) && e.position.distanceTo(bot.entity.position) < r);
        } catch (e) { return false; }
    };
    const lowHpWorkRisk = () => bot.health <= 14 && hostileNear(12);
    const woodEq = () => sumRe(/_planks$/) + sumRe(/_log$/) * 4;
    const openSurfaceNow = () => {
        try {
            if (Math.floor(bot.entity.position.y) < 55) return false;
            const p = bot.entity.position.floored();
            for (let dy = 1; dy <= 8; dy++) {
                const b = bot.blockAt(p.offset(0, dy, 0));
                if (b && /water|lava/.test(b.name || '')) return false;
                if (b && b.boundingBox === 'block') return false;
            }
            return true;
        } catch (e) { return false; }
    };
    const cheapWoodTarget = () => {
        const logTypes = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'];
        let blocks = [];
        try { blocks = world.getNearestBlocks(bot, logTypes, 18, 16) || []; } catch (e) {}
        const me = bot.entity.position;
        let nearest = null, best = Infinity, high = null;
        for (const b of blocks) {
            if (!b || !b.position) continue;
            const dist = b.position.distanceTo(me);
            const dy = b.position.y - me.y;
            if (!high || dist < high.dist) high = { block: b, dist, dy };
            if (dist <= 12 && Math.abs(dy) <= 3 && dist < best) { nearest = { block: b, dist, dy }; best = dist; }
        }
        if (nearest) return { ok: true, target: `${nearest.block.name}@${nearest.dist.toFixed(1)}b dy=${nearest.dy.toFixed(1)}` };
        if (high) return { ok: false, reason: `nearest tree ${high.block.name}@${high.dist.toFixed(1)}b dy=${high.dy.toFixed(1)} would require climb/stair` };
        return { ok: false, reason: 'no cheap tree within 18b' };
    };
    const optionalWoodSafe = () => {
        if (!openSurfaceNow()) return { ok: false, reason: `not true surface y=${Math.floor(bot.entity.position.y)} mob=${bot._mobility ? bot._mobility.state : '-'}` };
        if (hostileNear(24)) return { ok: false, reason: 'hostile near 24b' };
        if (bot.food <= 14 && !edibleHeld()) return { ok: false, reason: `food=${bot.food}, no edible held` };
        if (lowHpWorkRisk()) return { ok: false, reason: `hp=${Math.round(bot.health)} hostile near` };
        return cheapWoodTarget();
    };
    const moderateUndergroundWorkOk = () => {
        try {
            if (openSurfaceNow()) return false;
            if (bot.food < 8 || bot.health < 14 || edibleHeld()) return false;
            if (!bot.inventory.items().some(i => /_pickaxe$/.test(i.name || ''))) return false;
            if (hostileNear(12)) return false;
            const p = bot.entity.position.floored();
            let covered = false;
            for (let dy = 2; dy <= 6; dy++) {
                const b = bot.blockAt(p.offset(0, dy, 0));
                if (b && b.boundingBox === 'block') { covered = true; break; }
            }
            const enclosed = !!(bot._mobility && (bot._mobility.enclosed || /POCKET|ENTOMBED|ENC/.test(bot._mobility.state || '')));
            return covered || enclosed;
        } catch (e) {
            return false;
        }
    };
    const essentialUndergroundKitGoal = /^(iron_pickaxe|iron_ingot|raw_iron|iron_ore|stone_pickaxe|cobblestone)$/.test(item);
    const survivalGearGoal = /^(wooden|stone|iron)_(sword|axe)$/.test(item);
    // ★C272: cheap BOOTSTRAP crafts (crafting_table, wooden_pickaxe) — made in-place from held
    // planks/sticks (~2s, no gathering/travel), the keystone to ALL tools+weapons. Blocking them
    // at low food was the inversion that churned the bot to death (新世界: had oak_planks:4+stick:4
    // RIGHT THERE, gate kicked it to feedUp which couldn't catch fleeing chickens → died #7 with
    // wood in hand, never made a pickaxe/sword). A human with planks just crafts the table+pick,
    // THEN a sword, THEN hunts effectively. keepInventory keeps the planks across death, so the
    // craft is always available. (Gathering subgoals like oak_log are NOT exempted — only the
    // zero-travel crafts.)
    // ★C286: the exemption was TOO NARROW — only crafting_table|wooden_pickaxe. Live 2026-06-20
    // (用户实拍"沙漠发呆"续): C285 got the bot 4 logs at food=4-7, but crafting a crafting_table
    // sub-goals oak_planks, and stone_pickaxe (which she had 99 cobble + 25 stick for) was the real
    // KIT goal — NEITHER oak_planks NOR stone_pickaxe was exempt, so the low-food gate kicked the
    // bot back to a futile desert feedUp every cycle and it starved+died (#47) holding all the
    // materials to craft its way out. Extend the exemption to the ENTIRE zero-travel pickaxe chain:
    // planks (logs→planks), stick, crafting_table, wooden/stone_pickaxe. Gather sub-goals (oak_log,
    // cobblestone) remain NON-exempt and hit their own low-food gates downstream (lines ~444/458),
    // so this frees ONLY the pure in-inventory crafts — which cost zero hunger and zero travel and
    // are the sole escape from the resource floor. Never gate the bootstrap craft on food.
    const cheapBootstrapCraft = /^(crafting_table|wooden_pickaxe|stone_pickaxe|stick)$/.test(item) || /_planks$/.test(item);
    if (!foodGoal && !survivalGearGoal && !cheapBootstrapCraft && lowFoodNoSnack() && !(essentialUndergroundKitGoal && moderateUndergroundWorkOk())) {
        prog(`${tag}LOW-FOOD resource gate ${item}: food=${bot.food}, hp=${Math.round(bot.health)} no edible — return control to feedUp`);
        try { bot.clearControlStates(); } catch (e) {}
        try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
        return false;
    } else if (!foodGoal && lowFoodNoSnack() && essentialUndergroundKitGoal && moderateUndergroundWorkOk()) {
        prog(`${tag}LOW-FOOD resource gate ${item}: food=${bot.food}, hp=${Math.round(bot.health)} calm/enclosed with pick — allow essential local underground kit work`);
    }
    if (!foodGoal && bot.food <= 2 && !edibleHeld()) {
        prog(`${tag}FAMINE-FUSE ${item}: food=${bot.food}, hp=${Math.round(bot.health)} no edible — refuse resource subgoal`);
        try { bot.clearControlStates(); } catch (e) {}
        try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
        return false;
    }
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
                    // ★C282: collectBlock can mine the station from one level UP and leave the
                    // drop on the ledge below uncollected (user: dug its own crafting_table from
                    // above, walked off without it). ENSURE the drop is picked up — but only if
                    // it's a SAFE descent (never fall to death for a table). Safe-pickup primitive.
                    try { await skills.ensurePickupAt(bot, nbPos, { radius: 4 }); } catch (e) {}
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
            // Do not ask for a sword while bootstrapping the crafting table itself:
            // wooden_sword needs a table, so "crafting_table -> wooden_sword ->
            // placeTable -> crafting_table" immediately hits the active-loop guard.
            // ★C343 (husk death-spike root): prefer the MORE DURABLE stone_sword whenever we have cobble
            // (≥2). A wooden_sword needs PLANKS we often lack while sitting on stacks of cobble, so the hard
            // 'wooden_sword' target dead-ended ("NO KNOWN WAY to obtain wooden_sword") and left the bot
            // SWORD-LESS in a husk loop (live 13:00-03: 7 deaths/10min, ALL sword=null, while holding 56
            // cobble + 3 stick). Stone sword is craftable from cobble+stick AND ~2× the durability (won't
            // shatter mid-fight like wooden → the recurring "木剑打几只husk就碎→无剑→死"). Wooden only as
            // the no-cobble fallback (the truly-naked early game the wooden pre-step was written for).
            if (item !== 'crafting_table' && !hasSword && !_nightExposed) {
                const _swordGoal = (inv()['cobblestone'] || 0) >= 2 ? 'stone_sword' : 'wooden_sword';
                await achieve(bot, ctx, _swordGoal, depth + 1, _active).catch(() => {});
            }
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
            const undergroundPocket = bot.entity.position.y < 62 || (bot._mobility && (bot._mobility.enclosed || bot._mobility.state === 'POCKET'));
            const woodGate = optionalWoodSafe();
            if (!woodGate.ok) {
                prog(`> skip stock wood buffer — ${woodGate.reason}; optional tree route yields`);
            } else if (undergroundPocket) {
                prog(`> skip stock wood buffer — underground/enclosed y=${Math.floor(bot.entity.position.y)} mob=${bot._mobility ? bot._mobility.state : '-'}; don't staircase for optional wood`);
            } else if (woodEq() >= 8) {
                prog(`> skip stock wood buffer — woodEq=${woodEq()} enough; don't chase logs for a craftable plank buffer`);
            } else if (sumRe(/_log$/) < 6 && sumRe(/_planks$/) < 8 && !_nightExposed) {
                await step(`stock wood buffer (${woodGate.target})`, () => Promise.race([
                    skills.customSkill(bot, 'chopWood', logBuf - sumRe(/_log$/)),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('woodbuf-timeout')), 90000)),
                ]).catch(e => { try { bot.pathfinder.stop(); } catch (_) {} try { bot.clearControlStates(); } catch (_) {} }));
            }
        } catch (e) {}
    }

    // ---- helpers ----
    const findTable = () => world.getNearestBlock(bot, 'crafting_table', 5);
    const isWaterBlock = (b) => b && /water/.test(b.name || '');
    const wetWorksite = () => {
        try {
            const p = bot.entity.position.floored();
            return isWaterBlock(bot.blockAt(p)) || isWaterBlock(bot.blockAt(p.offset(0, 1, 0)));
        } catch (e) { return false; }
    };
    const escapeWetWorksite = async (why) => {
        const p0 = bot.entity.position.floored();
        prog(`${tag}★WET-WORKSITE ${why}: body in water @${p0.x},${p0.y},${p0.z} — surface/escape before mining or placing`);
        try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
        try { bot.clearControlStates(); } catch (e) {}
        try {
            await Promise.race([
                skills.customSkill(bot, 'surfaceUp', Math.max(63, p0.y + 8)),
                new Promise((_, rej) => setTimeout(() => rej(new Error('wet-surface-timeout')), 45000)),
            ]);
        } catch (e) {
            try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
            try { bot.clearControlStates(); } catch (_) {}
            prog(`${tag}★WET-WORKSITE escape incomplete: ${e.message}`);
        }
        return !wetWorksite();
    };
    const affordableRecipe = (recipes) => {
        const h = {}; for (const it of bot.inventory.items()) h[it.type] = (h[it.type] || 0) + it.count;
        for (const r of recipes) { const nd = {}; for (const d of (r.delta || [])) if (d.count < 0) nd[d.id] = (nd[d.id] || 0) - d.count; if (Object.entries(nd).every(([t, c]) => (h[t] || 0) >= c)) return r; }
        return null;
    };
    const craftNow = async (count) => {
        const id = mc.getItemId(item); if (id == null) return false;
        let table = findTable();
        let rs = bot.recipesFor(id, null, 1, table) || [];
        if (rs.length === 0) rs = bot.recipesFor(id, null, 1, null) || [];
        if (rs.length === 0 && !table) {
            // ★BUCKET-TABLE retry (2026-07-02 task#7): bot.recipesFor is BOTH affordability-
            // filtered and table-arg-filtered — with no table inside findTable's 5b radius it
            // returns [] for every 3x3-only recipe (bucket = 3 iron_ingot in a 3-wide V) even
            // with all ingredients in pocket, and the craftRecipeLocal fallback below ALSO
            // demands a reachable table → "NO KNOWN WAY to obtain bucket" while holding
            // 4 iron_ingot (progress.txt 2026-07-02T04:48:30Z, nearest table 14.1b away).
            // EXISTENCE must come from recipesAll (inventory-independent): if no no-table
            // recipe exists but a with-table one does, the only missing piece is a station —
            // place/reuse one and re-query before falling through to the fallback/give-up.
            try {
                if ((bot.recipesAll(id, null, null) || []).length === 0
                    && (bot.recipesAll(id, null, true) || []).length > 0
                    && await placeTable()) {
                    table = findTable();
                    if (table) rs = bot.recipesFor(id, null, 1, table) || [];
                }
            } catch (e) {}
        }
        if (rs.length === 0) {
            // bot.recipesFor can return [] for items that ARE craftable right now (seen
            // live: stick with 16 oak_planks held → instant "NO KNOWN WAY", which poisoned
            // the whole pick-recraft chain into a tree-hunt deadlock). mindcraft's
            // craftRecipe has independent recipe resolution — try it before giving up.
            const before0 = have();
            prog(`${tag}recipesFor empty for ${item} — trying local craftRecipe fallback`);
            try {
                if (skills.craftRecipeLocal) await skills.craftRecipeLocal(bot, item, count);
                else await skills.craftRecipe(bot, item, count);
            } catch (e) { prog(`${tag}craftRecipe fallback fail: ${e.message}`); }
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
        if (wetWorksite() && !(await escapeWetWorksite('place table'))) return false;
        if (findTable()) { try { stRegister('crafting_table', findTable().position); } catch (e) {} return true; }
        // 状态池优先: 32格内有登记过的台子 → 走过去用,绝不铺新的 (满地工作台的根治)
        try {
            const reg = stNearest(bot, 'crafting_table', 32);
            if (reg) {
                const d = Math.hypot(bot.entity.position.x - reg.x, bot.entity.position.y - reg.y, bot.entity.position.z - reg.z);
                const pocket = bot._mobility && (bot._mobility.enclosed || bot._mobility.state === 'POCKET');
                const canMakeLocalTable = have('crafting_table') > 0 || maxRe(/_planks$/) >= 4 || sumRe(/_log$/) > 0;
                const mustReuseTable = !canMakeLocalTable && d <= 32 && !hostileNear(8);
                // ★DEATH-SPIRAL ROOT CAUSE (deaths 1-4, 2026-06-19 night): canFightNight()
                // broke prepNether's night-hold (had shield+sword), the goal loop then chased
                // iron_pickaxe, and THIS walk crossed the exposed surface to a remote table at
                // night — a zombie reached the bot mid-transit (none within 8b at start, one
                // arrived during the walk) → death → gear dropped → naked surface respawns
                // spiralled 3 more times. Night surface travel for a daytime tool goal is never
                // worth it: refuse the cross-surface walk and defer the table-craft to daylight.
                // (Adjacent table, d<=2.5, is still fine — no real transit.) enclosed/underground
                // exempt via the same _nightExposed predicate used elsewhere in this file.
                const _nightExposed = (() => { try { const t = bot.time.timeOfDay; return t >= 13000 && t <= 23000 && bot.entity.position.y >= 50 && !(bot._mobility && bot._mobility.enclosed); } catch (e) { return false; } })();
                if (_nightExposed && d > 2.5) {
                    bot._prepTableRecoveryBlockedUntil = Date.now() + 30000;
                    bot._prepTableRecoveryBlockedReason = `night-exposed: won't cross surface ${d.toFixed(1)}b to table @${reg.x},${reg.y},${reg.z}`;
                    prog(`${tag}★NIGHT-EXPOSED table-walk refused — defer table-craft to day (${bot._prepTableRecoveryBlockedReason})`);
                    return false;
                }
                if ((!pocket && d <= 12) || mustReuseTable) {
                    prog(`${tag}registered table @${reg.x},${reg.y},${reg.z} — walking to reuse${mustReuseTable ? ' (no local wood/table; prefer station over cave wood climb)' : ''}`);
                    try {
                        await Promise.race([
                            skills.goToPosition(bot, reg.x, reg.y, reg.z, 2),
                            new Promise((_, rej) => setTimeout(() => rej(new Error('table-reuse-timeout')), 30000)),
                        ]);
                    } catch (e) { prog(`${tag}registered table reuse failed: ${e.message}`); }
                    const ft = findTable();
                    if (ft) { stRegister('crafting_table', ft.position); return true; }
                    if (d <= 12) {
                        stDeregister('crafting_table', reg);
                        prog(`${tag}registered table vanished — deregistered, will craft fresh`);
                    } else {
                        prog(`${tag}registered table not reached/loaded — keep registration, will craft local if possible`);
                    }
                } else {
                    prog(`${tag}registered table @${reg.x},${reg.y},${reg.z} too far/cramped (${d.toFixed(1)}b, pocket=${!!pocket}) — craft/place local`);
                }
            }
        } catch (e) {}
        const undergroundPocket = bot.entity.position.y < 62 || (bot._mobility && (bot._mobility.enclosed || bot._mobility.state === 'POCKET'));
        if (!have('crafting_table') && maxRe(/_planks$/) < 4 && sumRe(/_log$/) < 1 && undergroundPocket && !openSurfaceNow()) {
            try {
                bot._prepTableRecoveryBlockedUntil = Date.now() + 60000;
                bot._prepTableRecoveryBlockedReason = `no local wood/table at y=${Math.floor(bot.entity.position.y)} mob=${bot._mobility ? bot._mobility.state : '-'}`;
            } catch (e) {}
            prog(`${tag}underground table gate — ${bot._prepTableRecoveryBlockedReason}; refuse cave wood climb for crafting_table`);
            return false;
        }
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
        // ★C258 cramped-pocket table livelock: in a 1-wide shaft placeBlockNearby finds no open
        // footing cell, returns fast, the caller retries forever — a confirmed 6-min STALL
        // @117,41,-47 (hp20/food16, act="-", looping "place table → too far/cramped → craft local").
        // Carve a short 1x2 branchMine tunnel to create the open cells a table needs, then retry.
        if (!findTable() && bot._mobility && (bot._mobility.enclosed || /POCKET|ENTOMBED/.test(bot._mobility.state || ''))) {   // ★C297: ENTOMBED was missing — a bot that dug a 1-wide night-shelter pit (C296) reads ENTOMBED, not POCKET, so the cramped-pocket table recovery never fired and it stalled with table+planks in hand, unable to place (live 2026-06-20 deaths=102 post-give). Include ENTOMBED so it surfaces to open ground and places there.
            // ★C258 cramped-pocket table livelock (confirmed 6-min STALL @117,41,-47, hp20/food16):
            // a 1-wide dug shaft has NO open footing cell for a table, placeBlockNearby returns
            // fast, the caller retries placeTable every ~0.6s forever. iron_pickaxe/furnace are
            // surface-tier crafts that don't belong in a shaft. Climb to open space (surfaceUp —
            // well-tested, always moves the bot OUT of the pocket = breaks the freeze) and place
            // there. (A branchMine niche-carve was tried first and no-op'd in the cramped spot.)
            const climbTo = Math.min(72, Math.floor(bot.entity.position.y) + 20);
            prog(`${tag}★C258 table unplaceable in pocket y=${Math.floor(bot.entity.position.y)} — surfaceUp(${climbTo}) to open space, then place`);
            try { await skills.customSkill(bot, 'surfaceUp', climbTo); } catch (e) {}
            for (let a = 0; a < 2 && !findTable(); a++) {
                await Promise.race([
                    skills.placeBlockNearby(bot, 'crafting_table'),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('place-timeout')), 20000)),
                ]).catch(() => { try { bot.pathfinder.stop(); } catch (_) {} try { bot.clearControlStates(); } catch (_) {} });
                if (!findTable()) await skills.wait(bot, 200);
            }
            if (!findTable()) {
                // still stuck after surfacing — cooldown so the mission stops tight-looping and
                // moves on (mine/relocate) instead of re-entering placeTable every ~0.6s.
                try { bot._prepTableRecoveryBlockedUntil = Date.now() + 30000; bot._prepTableRecoveryBlockedReason = `table unplaceable, surfaced to y=${Math.floor(bot.entity.position.y)}`; } catch (e) {}
                prog(`${tag}★C258 table still unplaceable after surfaceUp — 30s cooldown, yield to mining/relocate`);
            }
        }
        const placed = findTable();
        if (placed) { try { stRegister('crafting_table', placed.position); } catch (e) {} }   // 放置必登记
        return !!placed;
    };

    // ---- special collectors ----
    if (item.endsWith('_log')) {
        if (lowFoodNoSnack()) {
            prog(`${tag}LOW-FOOD wood gate — food=${bot.food}, hp=${Math.round(bot.health)}, no edible; refuse ${item} until feedUp`);
            return false;
        }
        await step(`chop ${item}`, () => skills.customSkill(bot, 'chopWood', need)); return have() >= need;
    }
    if (/_planks$/.test(item)) {
        if (have() >= need) return true; // any *_planks already counts
        let log = Object.keys(inv()).find(k => /_log$/.test(k) && inv()[k] > 0);
        if (!log) {
            // NIGHT GATE: chopping for planks at night on the exposed surface is the death
            // spiral's favorite entry (saw it 50ms after a respawn, beside the killer mob).
            // Fail fast — the orchestrator's hole-up owns the night; planks resume at dawn.
            const _ne = (() => { try { const t = bot.time.timeOfDay; return t >= 13000 && t <= 23000 && bot.entity.position.y >= 50 && !(bot._mobility && bot._mobility.enclosed); } catch (e) { return false; } })();   // enclosed(封闭地穴)豁免夜门——与 chopWood NIGHT-BAIL/prepNether 夜hold 同款(C32)
            if (_ne) { prog(`${tag}night-exposed — skip chopping for planks (hole up owns the night)`); return false; }
            if (lowFoodNoSnack()) {
                prog(`${tag}LOW-FOOD planks gate — food=${bot.food}, hp=${Math.round(bot.health)}, no edible; refuse chop for planks until feedUp`);
                return false;
            }
            const undergroundPocket = bot.entity.position.y < 62 || (bot._mobility && (bot._mobility.enclosed || bot._mobility.state === 'POCKET'));
            if (undergroundPocket && !openSurfaceNow()) {
                prog(`${tag}underground planks gate — need ${need}, have ${have()}, no logs at y=${Math.floor(bot.entity.position.y)} mob=${bot._mobility ? bot._mobility.state : '-'}; refuse chopWood/surface climb`);
                return false;
            }
            const missingPlanks = Math.max(1, need - have());
            await step('chop for planks', () => skills.customSkill(bot, 'chopWood', Math.ceil(missingPlanks / 4)));
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
        const fuelNow = () => { try { return mc.getSmeltingFuel(bot); } catch (e) { return null; } };
        const f0 = fuelNow();
        if (f0) {
            prog(`${tag}fuel ready: ${f0.name} x${f0.count} — skip coal preflight`);
        } else {
            await achieve(bot, ctx, { item: 'coal', count: Math.max(1, Math.ceil(need / 8)) }, depth + 1, _active).catch(() => {});
            // smeltItem can burn logs/planks directly. If coal is not nearby, do not
            // keep blind-mining at y=15 just to satisfy a "coal" subgoal; a human burns
            // spare wood or chops one log.
            if (!fuelNow()) await achieve(bot, ctx, { item: 'oak_log', count: Math.max(1, Math.ceil(need / 2)) }, depth + 1, _active).catch(() => {});
        }
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
        let needsTable = total > 4 || /pickaxe|sword|_axe|shovel|hoe|furnace|chest|bed|shield|bow|helmet|chestplate|leggings|boots/.test(item);
        // ★BUCKET-TABLE root cause (2026-07-02 task#7): the count+name heuristic above
        // misses SHAPED recipes with <=4 ingredients that still span the 3x3 grid —
        // bucket is total=3 and its name isn't in the regex, so placeTable was skipped
        // entirely, craftNow then saw recipesFor(id,null,1,null)=[] (bucket has no 2x2
        // recipe) and the whole MLG-bucket kit step dead-ended at "NO KNOWN WAY" despite
        // the NEED chain having expanded fine (log: "NEED 3x iron_ingot (have 4)").
        // Decide from prismarine-recipe data instead: recipesAll ignores inventory, so
        // "no no-table recipe exists but a with-table one does" is the exact requiresTable
        // predicate (recipesFor-based checks misjudge existence whenever short on
        // materials). Fail-open on error: keep the heuristic's verdict, don't block crafts.
        if (!needsTable) {
            try {
                const _tid = mc.getItemId(item);
                if (_tid != null && typeof bot.recipesAll === 'function'
                    && (bot.recipesAll(_tid, null, null) || []).length === 0
                    && (bot.recipesAll(_tid, null, true) || []).length > 0) needsTable = true;
            } catch (e) {}
        }
        // ENSURE THE TABLE FIRST, then gather the target's ingredients. Crafting a NEW
        // crafting_table consumes 4 planks; if we gather the target's ingredients
        // BEFORE placing the table, table-making eats those planks and the target
        // craft then fails with "missing ingredient" — the wooden_sword/wooden_pickaxe
        // bootstrap deadlock (chop 4 planks -> table eats all 4 -> sword craft fails ->
        // "NO KNOWN WAY"). Doing the table first means it chops its own wood, then the
        // ingredient pass chops fresh wood for the actual item. (Once a table exists
        // nearby, placeTable just reuses it for free.)
        if (needsTable) {
            await step('place table', () => placeTable());
            if (!findTable()) return false;
        }
        // Satisfy ingredients best-effort (don't bail on one — craftNow picks
        // whatever variant we actually have, so jungle_planks covers oak_planks).
        for (const [name, cnt] of Object.entries(ing)) {
            await achieve(bot, ctx, { item: name, count: cnt * times }, depth + 1, _active);
        }
        // Ingredient collection can move us away from the table we prepared above
        // (stone/ore probing does this constantly). Re-anchor the craft station right
        // before opening the 3x3 recipe so table-required tools don't fail with
        // recipesFor=[] after successfully collecting all ingredients.
        if (needsTable) {
            await step('place table (post-ingredients)', () => placeTable());
            if (!findTable()) return false;
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
        const probeKey = `${item}:${block}`;
        const probeCooldownLeft = () => {
            try {
                const st = bot._achieveProbeState && bot._achieveProbeState[probeKey];
                return st && st.blockedUntil && st.blockedUntil > Date.now() ? st.blockedUntil - Date.now() : 0;
            } catch (e) { return 0; }
        };
        // Loop: x-ray collect within 64, then dig deeper to expose more, until we
        // have enough. One pass rarely yields enough ore (the #1 cause of "NO KNOWN
        // iron_ingot" -> iron_pickaxe fail).
        let g2 = 0;
        while (have() < need && g2++ < 8) {
            if (bot.interrupt_code) break;
            const probeCd = probeCooldownLeft();
            if (probeCd > 0) {
                const st = bot._achieveProbeState && bot._achieveProbeState[probeKey];
                if (!st.cooldownLogAt || Date.now() - st.cooldownLogAt > 10000) {
                    st.cooldownLogAt = Date.now();
                    prog(`${tag}mine probe cooldown for ${block}: yield ${Math.ceil(probeCd / 1000)}s after ${st.cooldownReason || 'budget-exhausted'}`);
                    motion('achieve.probe.cooldown_yield', { item, block, leftMs: probeCd, reason: st.cooldownReason || null });
                }
                try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
                try { bot.clearControlStates(); } catch (e) {}
                return false;
            }
            if (wetWorksite() && !(await escapeWetWorksite(`collect ${block}`))) return false;
            const miningBlock = /stone|deepslate|andesite|diorite|granite|tuff|ore$|obsidian|cobble/.test(block);
            try {
                const t = bot.time.timeOfDay;
                const nightish = t >= 12500 && t <= 23000;
                const exposed = bot.entity.position.y >= 50 && !(bot._mobility && bot._mobility.enclosed);
                if (nightish && exposed && miningBlock) {
                    prog(`${tag}night-exposed mining gate — stop ${block} work at y=${Math.floor(bot.entity.position.y)} tod=${Math.floor(t)} before surface/feed routing`);
                    try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
                    try { bot.clearControlStates(); } catch (e) {}
                    return false;
                }
            } catch (e) {}
            if (bot.health <= 8 && bot.food < 18) {
                const yy = Math.floor(bot.entity.position.y);
                prog(`${tag}LOW-HP mining gate — hp=${Math.round(bot.health)} food=${bot.food} at y=${yy}; surface/feed before more ${block}`);
                try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
                try { bot.clearControlStates(); } catch (e) {}
                try { await skills.customSkill(bot, 'surfaceUp', Math.max(48, yy + 12)); } catch (e) { prog(`${tag}LOW-HP surfaceUp err ${e.message}`); }
                return false;
            }
            if (bot.food <= 12 && !edibleHeld() && miningBlock) {
                const yy = Math.floor(bot.entity.position.y);
                if (moderateUndergroundWorkOk()) {
                    prog(`${tag}LOW-FOOD mining gate — food=${bot.food} hp=${Math.round(bot.health)} at y=${yy}; calm/enclosed with pick, allow essential local ${block} work instead of surface/feed`);
                } else {
                prog(`${tag}LOW-FOOD mining gate — food=${bot.food} hp=${Math.round(bot.health)} at y=${yy}; no edible held, surface/feed before more ${block}`);
                try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
                try { bot.clearControlStates(); } catch (e) {}
                try { await skills.customSkill(bot, 'surfaceUp', Math.max(63, yy + 12)); } catch (e) { prog(`${tag}LOW-FOOD surfaceUp err ${e.message}`); }
                return false;
                }
            }
            // ★徒手采石=零掉落死循环 (BARE-HAND alarm 实拍: collect stone [0/3] 永远 0/3,
            // 对着脚下石头白刨几分钟): pick-requiring block + no pickaxe → 这条采集路线
            // 是死的,立即放弃让上层换路径(找木→造镐)。
            if (/stone|deepslate|andesite|diorite|granite|tuff|ore$|obsidian|cobble/.test(block)
                && !bot.inventory.items().some(i => /_pickaxe$/.test(i.name))) {
                prog(`${tag}★NOPICK — collect ${block} drops nothing bare-handed; abandoning this branch (need a pickaxe first)`);
                return false;
            }
            // ★PICK-RUNWAY (pre-emptive twin of ★NOPICK above and of exposeMore's ★C229 gate):
            // NOPICK is the AFTER-the-fact "already bare-handed" check, and C229 counts picks/
            // wood but never DURABILITY — so a lone pick with a few uses left sailed through
            // both, and the xray iron staircase ground it to dust at depth (live 2026-07-02:
            // pickless underground at night, no wood in reach). If the LAST pick is about to
            // snap and we can't field-craft a replacement (shared skills.pickRunway read), this
            // collect route is about to strand us. Route it through the EXISTING probe-cooldown
            // machinery as one more budget-exhausted reason (no new exit path): stamp the
            // cooldown so re-dispatches hit the cooldown-yield at the loop head, and return
            // false — a zero-progress dispatch must let the kernel dispatch-cooldown engage.
            if (miningBlock && typeof skills.pickRunway === 'function') {
                try {
                    const rw = skills.pickRunway(bot);
                    if (rw && rw.aboutToBreak && !rw.canFieldCraftPick) {
                        bot._achieveProbeState = bot._achieveProbeState || {};
                        const stP = bot._achieveProbeState[probeKey] || (bot._achieveProbeState[probeKey] = {});
                        stP.blockedUntil = Date.now() + 30000;
                        stP.cooldownReason = 'pick-about-to-break';
                        stP.cooldownLogAt = Date.now();
                        prog(`${tag}★PICK-RUNWAY — last pick nearly dead (usesLeft=${rw.bestUsesLeft} tier=${rw.bestTier}), no field recraft; stop ${block} route, cooldown 30s`);
                        motion('achieve.probe.yield', { item, block, reason: 'pick-about-to-break', usesLeft: rw.bestUsesLeft, tier: rw.bestTier });
                        try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
                        try { bot.clearControlStates(); } catch (e) {}
                        return false;
                    }
                } catch (e) {}
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
            // ★采矿缰绳 v2 (C218): 约束的是"采矿过程中的位移漂移",不是"当前离 bed 多远"。
            // 旧版用 bed 当基准 → bot 一 respawn 就离规划家(bed)150+格、健康、站在矿上时,缰绳把
            // "离 bed 远"误判成"采矿漂移",在 collectBlock 之前就 return false,连脚下的石头/铁都采
            // 不到 → NO KNOWN WAY to obtain iron_ingot 死循环(live 实证:bot@7,35 距 bed@151,-14
            // =152格>80,每条支路触发缰绳召回失败)。deaths 214/221 的雷区坠亡本是 digDown 累积漂移
            // 导致,基准本就该是"采矿起点"。改为 _achieveMineOrigin:漂出 64 格才召回到起点(近、走得
            // 到),回圈内即重置起点继续采;bed 仅作 256 格绝对兜底(防真·跨区乱挖)。
            try {
                const me2 = bot.entity.position;
                const now2 = Date.now();
                let org = bot._achieveMineOrigin;
                if (!org || now2 - org.ts > 90000) org = bot._achieveMineOrigin = { x: me2.x, z: me2.z, ts: now2 };
                org.ts = now2;
                const drift = Math.hypot(me2.x - org.x, me2.z - org.z);
                let ax2 = null, az2 = null;
                try { const bj2 = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'bed.json'), 'utf8')); if (typeof bj2.x === 'number') { ax2 = bj2.x; az2 = bj2.z; } } catch (e) {}
                const bedD = (ax2 != null) ? Math.hypot(me2.x - ax2, me2.z - az2) : 0;
                const DRIFT_CAP = 64, BED_CAP = 256;
                if (drift > DRIFT_CAP || bedD > BED_CAP) {
                    const useBed = bedD > BED_CAP && ax2 != null;
                    const baseX = useBed ? ax2 : org.x, baseZ = useBed ? az2 : org.z;
                    const refD = (useBed ? bedD : drift) || 1;
                    prog(`${tag}mining LEASH: drift=${Math.round(drift)} bedD=${Math.round(bedD)} — 收回${useBed ? 'bed' : '采矿起点'}`);
                    const ux2 = (baseX - me2.x) / refD, uz2 = (baseZ - me2.z) / refD;
                    const tx2 = Math.round(me2.x + ux2 * Math.min(40, refD)), tz2 = Math.round(me2.z + uz2 * Math.min(40, refD));
                    let okLeash = false;
                    try {
                        okLeash = await Promise.race([
                            skills.goToPosition(bot, tx2, null, tz2, 3),
                            new Promise(resolve => setTimeout(() => resolve(false), 8000)),
                        ]);
                    } catch (e) {}
                    try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
                    try { bot.clearControlStates(); } catch (e) {}
                    const meAfter = bot.entity.position;
                    const driftAfter = Math.hypot(meAfter.x - org.x, meAfter.z - org.z);
                    if (driftAfter <= DRIFT_CAP) {
                        bot._achieveMineOrigin = { x: meAfter.x, z: meAfter.z, ts: Date.now() };
                    } else {
                        const k = `leash:${block}`;
                        const last = bot._achieveLeashAbort && bot._achieveLeashAbort.key === k ? bot._achieveLeashAbort : null;
                        const repeats = last && Date.now() - last.ts < 45000 ? last.repeats + 1 : 1;
                        bot._achieveLeashAbort = { key: k, ts: Date.now(), repeats };
                        prog(`${tag}mining LEASH failed drift ${Math.round(drift)}→${Math.round(driftAfter)} ok=${!!okLeash}; yield (repeat=${repeats})`);
                        return false;
                    }
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
            if (!foodGoal && (lowHpWorkRisk() || (bot.health <= 12 && bot.food <= 10 && !edibleHeld()))) {
                prog(`${tag}mine probe safety yield — hp=${Math.round(bot.health)} food=${bot.food} hostile=${hostileNear(12)}; stop optional ore route`);
                motion('achieve.probe.safety_yield', { item, block, hp: Math.round(bot.health || 0), food: bot.food, hostileNear: hostileNear(12) });
                try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
                try { bot.clearControlStates(); } catch (e) {}
                return false;
            }
            // ★雷区禁挖 (242-246五连死的真磁铁: 雷区过滤让x-ray找不到目标后,回落"原地往
            // 下挖"——而出生点就在蜂窝雷区屋顶上,digDown直接凿进死亡洞穴): 身处雷区时
            // digDown 跳过,改为撤离后下轮再挖。
            // ★CAUSE-AWARE death-zone no-dig: the gate exists to avoid digging back INTO a
            // dig-related death (lava/fall/suffocation under the spawn). But it only counted
            // deaths, ignoring cause — so a death-zone built from SURFACE/RANGED deaths
            // (pillager/skeleton/zombie) wrongly blocked digDown, pinning the bot on the surface
            // to be shot AND starving it of the iron it needs (for a shield) underground. Digging
            // DOWN escapes surface ranged threats, so only gate when the zone's deaths were
            // actually dig-danger. If a relaxed digDown then hits lava, that death's cause makes
            // _inDZ fire next time (self-correcting).
            let _inDZ = false;
            try {
                const dlZ = fs.readFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'death_log.jsonl'), 'utf8').trim().split('\n').slice(-50);
                const meZ = bot.entity.position;
                let ndZ = 0, digDanger = 0;
                const DIG_DANGER = /lava|fall|suffocat|magma|cramming|wall|in_wall/i;
                for (const ln of dlZ) { try { const r = JSON.parse(ln); if (typeof r.x === 'number' && Math.hypot(r.x - meZ.x, r.z - meZ.z) < 16) { ndZ++; if (DIG_DANGER.test(r.cause || '')) digDanger++; } } catch (e) {} }
                _inDZ = ndZ >= 3 && digDanger >= 1;   // only block digDown if deaths here were dig-related
            } catch (e) {}
            if (_inDZ) {
                const nowDZ = Date.now();
                const key = `dz:${block}`;
                const last = bot._achieveDZAbort && bot._achieveDZAbort.key === key ? bot._achieveDZAbort : null;
                const repeats = last && nowDZ - last.ts < 45000 ? last.repeats + 1 : 1;
                bot._achieveDZAbort = { key, ts: nowDZ, repeats };
                prog(`${tag}★雷区禁挖 — 跳过digDown并让出身体 (repeat=${repeats})`);
                try { bot.pathfinder.stop(); } catch (_) {}
                try { bot.clearControlStates(); } catch (_) {}
                if (repeats >= 3) {
                    bot._achieveDZMiningBlockedUntil = nowDZ + Math.min(120000, 30000 + repeats * 5000);
                    bot._achieveDZMiningBlocked = { item, block, repeats, at: nowDZ, until: bot._achieveDZMiningBlockedUntil };
                    if (!bot._achieveDZSurfaceTryAt || nowDZ - bot._achieveDZSurfaceTryAt > 30000) {
                        bot._achieveDZSurfaceTryAt = nowDZ;
                        const yy = Math.floor(bot.entity.position.y);
                        prog(`${tag}★雷区禁挖 repeat=${repeats} — bounded surfaceUp before more mining/crafting retries`);
                        try { await skills.customSkill(bot, 'surfaceUp', Math.max(84, yy + 8)); }
                        catch (e) { prog(`${tag}★雷区 surfaceUp recovery err ${e.message}`); }
                    }
                }
                if (repeats <= 2) {
                    try {
                        const meA = bot.entity.position;
                        await Promise.race([
                            skills.goToPosition(bot, Math.round(meA.x), Math.round(meA.y), Math.round(meA.z), 2),
                            new Promise(resolve => setTimeout(resolve, 1200)),
                        ]);
                    } catch (e) {}
                }
                return false;
            }
            await step(`probe to expose more ${block}`, () => exposeMore(block));
        }
        return have() >= need;
    }

    // ---- 4. PIVOT (general dead-end resolution — T-0078) ----
    // Reaching here means SMELT+CRAFT+COLLECT all failed: the goal is genuinely
    // unobtainable RIGHT NOW (no recipe affordable, no source mineable). Two
    // item-specific patches already existed for this — C338-A (iron_pickaxe →
    // fall back to stone_pickaxe in hand) and C343 (wooden_sword → stone_sword) —
    // each bolted on at the ENTRY for one item. They left every OTHER unreachable
    // goal (every Nth tier tool, every armor piece) to dead-loop the orchestrator:
    // "NO KNOWN WAY" → caller re-requests the same goal → same dead-end (打地鼠根).
    // Resolve the whole CLASS here, at the single exit, with two general rules:
    //   (a) TOOL/ARMOR DOWNGRADE: the goal is a tiered tool/armor we can't build,
    //       but we already hold a LOWER-tier equivalent of the same family → that
    //       equivalent lets the bot keep progressing (a stone pickaxe still mines
    //       iron; a wooden sword still kills). Report it as satisfied-by-equivalent
    //       so the caller advances instead of dying on the unbuildable upgrade.
    //       (ensureTool already short-circuits same-or-higher tier; this covers the
    //       strictly-lower case those two patches hand-coded per item.)
    //   (b) PREREQUISITE PIVOT: no equivalent on hand → pivot to the missing
    //       PRE-REQUISITE one level down (smelt input, or the ore behind it) and
    //       try to obtain THAT, so the next attempt at `item` has materials. Guarded
    //       so we pivot to a given prereq at most once per ~60s (no pivot thrash).
    const _toolFam = (item.match(/_(pickaxe|sword|axe|shovel|hoe)$/) || [, ''])[1];
    const _armorFam = (item.match(/_(helmet|chestplate|leggings|boots)$/) || [, ''])[1];
    const _equipFam = _toolFam || _armorFam;
    if (_equipFam) {
        // Any same-family item in hand (incl. strictly lower tier) is a usable
        // equivalent — wood/stone/iron/diamond/leather/chainmail/gold all share the
        // family suffix. tierOf returns -1 for materials we don't rank (leather,
        // chainmail, golden armor), but presence alone means "we can function".
        const heldEquiv = Object.keys(inv()).find(n => n.endsWith('_' + _equipFam) && n !== item && inv()[n] > 0);
        if (heldEquiv) {
            prog(`${tag}★PIVOT(T-0078) ${item} unobtainable now — already hold ${heldEquiv} (same ${_equipFam}); advance with the equivalent instead of dead-looping the upgrade`);
            return true;
        }
    }
    // No equivalent on hand → pivot DOWN to the missing prerequisite once. The
    // prereq is the smelt input (iron_ingot → raw_iron) or, failing that, the
    // first naturally-mined source block (raw_iron → iron_ore). Obtaining the
    // prereq is what unblocks the real goal on the next pass.
    try {
        const prereq = mc.getItemSmeltingIngredient(item)
            || (() => { const s = mc.getItemBlockSources(item); return (s && s.length && s[0] !== item) ? (s.find(b => /_ore$/.test(b)) || s[0]) : null; })();
        if (prereq && prereq !== item && have(prereq) <= 0) {
            const pKey = `${item}<-${prereq}`;
            const now = Date.now();
            const last = bot._achievePivot && bot._achievePivot.key === pKey ? bot._achievePivot : null;
            if (!last || now - last.ts > 60000) {
                bot._achievePivot = { key: pKey, ts: now };
                prog(`${tag}★PIVOT(T-0078) ${item} unobtainable now & no equivalent — pivot to missing prerequisite ${prereq} (caller's next ${item} pass then has materials)`);
                const okP = await achieve(bot, ctx, { item: prereq, count: need }, depth + 1, _active).catch(() => false);
                // Do NOT recurse back into achieve(item) here: `item` is already in
                // `_active` (added at entry, line ~172), so a same-item re-entry is
                // short-circuited by the loop guard and would no-op. Instead, having
                // stocked the prereq, return false and let the orchestrator re-issue
                // achieve(item) next tick on a FRESH stack (empty _active) — where
                // SMELT/CRAFT now find the materials and succeed.
                if (okP) prog(`${tag}★PIVOT(T-0078) prereq ${prereq} secured — yielding so next ${item} pass can consume it`);
            } else {
                prog(`${tag}★PIVOT(T-0078) ${item}: prereq ${prereq} pivot on cooldown (${Math.ceil((60000 - (now - last.ts)) / 1000)}s) — not thrashing`);
            }
        }
    } catch (e) { prog(`${tag}★PIVOT(T-0078) prereq resolution err: ${e.message}`); }

    prog(`${tag}NO KNOWN WAY to obtain ${item}`);
    return false;

    // ---- nested helpers needing closures ----
    async function step(label, fn) { prog(`${tag}> ${label}`); try { await fn(); } catch (e) { prog(`${tag}! ${label}: ${e.message}`); } }
    function motion(event, data = {}) {
        try {
            const p = bot.entity.position;
            const c = p.floored();
            const env = [];
            for (let dy = -1; dy <= 2; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const b = bot.blockAt(c.offset(dx, dy, dz));
                        env.push({ d: [dx, dy, dz], n: b ? b.name : null, bb: b ? b.boundingBox : null });
                    }
                }
            }
            fs.appendFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'mine_motion.jsonl'), JSON.stringify({
                ts: new Date().toISOString(),
                event,
                pos: { x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3) },
                cell: { x: c.x, y: c.y, z: c.z },
                held: bot.heldItem ? bot.heldItem.name : 'empty',
                hp: Math.round(bot.health || 0),
                food: bot.food,
                skill: bot._currentSkill || 'achieve',
                mob: bot._mobility ? bot._mobility.state : null,
                env,
                data,
            }) + '\n');
        } catch (e) {}
    }
    async function exposeMore(blockName) {
        const y = Math.floor(bot.entity.position.y);
        // ★C229 RECRAFT-CAPABILITY gate — never grind the LAST pickaxe away on deep ore
        // probing when there's NO way to make another. The softlock (06-16 02:50): pick wore
        // out at y-60 with 0 wood / 0 stick → couldn't craft sticks → couldn't recraft pick or
        // table → prepNether spun `TABLE gate ... no wood` forever. The whole system stocks a
        // wood buffer only at the SURFACE before descending; it had no REVERSE path "wood ran
        // out mid-dig → climb back for wood". This is the preventive half of that reverse path:
        // down to <=1 pick AND can't immediately recraft one (need 3 cobble + 2 sticks) AND <8
        // wood-equiv to even make the sticks/handle → do NOT dig deeper. In a safe SURFACE window
        // (optionalWoodSafe: surface+day+no hostile+hp/food ok) restock wood; otherwise HOLD
        // (refuse the descent) rather than break the last pick into a softlock. The forward half
        // (actively surface from depth + chop) lives in prepNether handleTableRecoveryBlocked.
        try {
            const picks = bot.inventory.items().filter(i => /_pickaxe$/.test(i.name || '')).length;
            const sticks = sumRe(/^stick$/);
            const canRecraftNow = have('cobblestone') >= 3 && sticks >= 2;
            if (picks <= 1 && !canRecraftNow && woodEq() < 8) {
                const woodGate = optionalWoodSafe();
                if (woodGate.ok) {
                    prog(`${tag}★C229 RECRAFT-GATE: ${picks} pick / cobble=${have('cobblestone')} sticks=${sticks} woodEq=${woodEq()} — restock wood before deep-mine (${woodGate.target})`);
                    motion('achieve.recraft_gate.restock', { picks, cobble: have('cobblestone'), sticks, woodEq: woodEq(), y });
                    try { await skills.customSkill(bot, 'surfaceUp', Math.max(63, Math.floor(bot.entity.position.y) + 8)); } catch (e) {}
                    try {
                        await Promise.race([
                            skills.customSkill(bot, 'chopWood', 4),
                            new Promise((_, rej) => setTimeout(() => rej(new Error('recraft-chop-timeout')), 90000)),
                        ]);
                    } catch (e) { try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {} try { bot.clearControlStates(); } catch (_) {} }
                    return woodEq() >= 8;
                }
                prog(`${tag}★C229 RECRAFT-GATE: ${picks} pick / cobble=${have('cobblestone')} sticks=${sticks} woodEq=${woodEq()} — no safe wood window (${woodGate.reason}); HOLD, refuse deep-mine (don't break last pick into softlock)`);
                motion('achieve.recraft_gate.hold', { picks, cobble: have('cobblestone'), sticks, woodEq: woodEq(), y, reason: woodGate.reason });
                try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
                try { bot.clearControlStates(); } catch (e) {}
                return false;
            }
        } catch (e) {}
        const shallowOre = /(^|_)iron_ore$|raw_iron|coal_ore|copper_ore/.test(blockName || '');
        if (shallowOre) {
            const now = Date.now();
            const key = `${item}:${blockName}`;
            bot._achieveProbeState = bot._achieveProbeState || {};
            let st = bot._achieveProbeState[key];
            const p0 = bot.entity.position;
            if (!st || now - st.ts > 90000 || Math.hypot((st.x || p0.x) - p0.x, (st.z || p0.z) - p0.z) > 18 || y > (st.startY || y) + 2) {
                st = bot._achieveProbeState[key] = { startY: y, minY: y, vertical: 0, lateral: 0, x: p0.x, z: p0.z, ts: now };
            }
            if (st.blockedUntil && now < st.blockedUntil) {
                if (!st.cooldownLogAt || now - st.cooldownLogAt > 10000) {
                    st.cooldownLogAt = now;
                    prog(`${tag}mine probe: ${blockName} cooldown ${Math.ceil((st.blockedUntil - now) / 1000)}s (${st.cooldownReason || 'budget-exhausted'}) — yield body`);
                    motion('achieve.probe.cooldown_yield', { item, blockName, reason: st.cooldownReason || null, leftMs: st.blockedUntil - now });
                }
                try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
                try { bot.clearControlStates(); } catch (e) {}
                return false;
            }
            if (st.blockedUntil && now >= st.blockedUntil) {
                prog(`${tag}mine probe: ${blockName} clears probe cooldown (${st.cooldownReason || 'budget-exhausted'}); retry from y=${y}`);
                st.startY = y; st.minY = y; st.vertical = 0; st.lateral = 0; st.x = p0.x; st.z = p0.z;
                st.blockedUntil = 0; st.cooldownReason = null; st.cooldownLogAt = 0;
                motion('achieve.probe.cooldown_clear', { item, blockName, y });
            }
            st.ts = now;
            st.minY = Math.min(st.minY, y);
            const lateralInstead = async (reason, len = 12, targetY = null) => {
                st.lateral = (st.lateral || 0) + 1;
                motion('achieve.probe.lateral.begin', { item, blockName, reason, startY: st.startY, minY: st.minY, vertical: st.vertical, lateral: st.lateral, length: len, targetY });
                if (st.lateral > 2) {
                    const coolMs = reason === 'high-mountain-descend' ? 45000 : 30000;
                    st.blockedUntil = Date.now() + coolMs;
                    st.cooldownReason = reason;
                    st.cooldownLogAt = Date.now();
                    prog(`${tag}mine probe: ${blockName} budget exhausted (${reason}) — cooldown ${Math.ceil(coolMs / 1000)}s; yield body`);
                    motion('achieve.probe.yield', { item, blockName, reason, startY: st.startY, minY: st.minY, vertical: st.vertical, lateral: st.lateral, cooldownMs: coolMs });
                    try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
                    try { bot.clearControlStates(); } catch (e) {}
                    return false;
                }
                const ok = await skills.customSkill(bot, 'branchMine', len, targetY).catch(e => {
                    prog(`${tag}mine probe branchMine fail: ${e.message}`);
                    return false;
                });
                motion('achieve.probe.lateral.end', { item, blockName, reason, ok: !!ok, y: Math.floor(bot.entity.position.y), targetY });
                return ok;
            };
            // ★IRON-DEPTH FIX (C255, 2026-06-19): iron was lumped into shallowOre and HARD-CAPPED
            // at y48-68 by the bands below — but that is the COPPER band (copper peaks y48). This
            // is why the bot piled up 150+ raw_copper but ZERO iron and stalled forever at
            // "NO KNOWN WAY to obtain iron_ingot". In 1.21 iron peaks at y16 (main band y-24..56);
            // the rich zone is y0-32, and the `y<32 → surfaceUp to y48` band below literally FLED
            // the iron-rich depth. Route iron to a CONTROLLED staircase down to the iron band
            // (branchMine targetY — player-style 1x2 stair with its own lava/night/food stops,
            // never blind digDown), exempt from the copper-shallow bands. Coal/copper keep theirs.
            const ironOre = /(^|_)iron_ore$|raw_iron/.test(blockName || '');
            if (ironOre) {
                const IRON_BAND = 14;   // y8-16 sweet spot; 14 leaves headroom above the lava-prone deep
                if (y > IRON_BAND + 8) {
                    prog(`${tag}mine probe: iron_ore y=${y} — descend to iron-rich band y~${IRON_BAND} (staircase; copper-shallow cap was the zero-iron bug)`);
                    return await lateralInstead('iron-deep-descend', 24, IRON_BAND);
                }
                prog(`${tag}mine probe: iron_ore y=${y} — in iron band, lateral branchMine`);
                return await lateralInstead('iron-band', 16);
            }
            if (y < 32) {
                prog(`${tag}mine probe: ${blockName} at y=${y} is too deep for shallow ore — surfaceUp to y48 instead of digging lower`);
                motion('achieve.probe.surface.begin', { item, blockName, y });
                return await skills.customSkill(bot, 'surfaceUp', 48);
            }
            if (y <= 56) {
                prog(`${tag}mine probe: ${blockName} y=${y} — shallow lateral branchMine, no blind digDown`);
                return await lateralInstead('at-shallow-band', 10);
            }
            if (y > 72) {
                prog(`${tag}mine probe: ${blockName} y=${y} — high mountain miss; staircase to y48 then branchMine`);
                return await lateralInstead('high-mountain-descend', 20, 48);
            }
            if (y <= 68 || st.vertical >= 5 || (st.startY - y) >= 6) {
                prog(`${tag}mine probe: ${blockName} y=${y} — vertical budget done (${st.vertical} probes, drop=${st.startY - y}); lateral branchMine, no deeper shaft`);
                return await lateralInstead('vertical-budget');
            }
            st.vertical++;
            prog(`${tag}mine probe: ${blockName} y=${y} — bounded one-block descent ${st.vertical}/5 (startY=${st.startY})`);
            motion('achieve.probe.down.begin', { item, blockName, y, startY: st.startY, minY: st.minY, vertical: st.vertical });
            const ok = await skills.digDown(bot, 1);
            motion('achieve.probe.down.end', { item, blockName, ok: !!ok, fromY: y, toY: Math.floor(bot.entity.position.y), vertical: st.vertical });
            return ok;
        }
        if (y <= 16) {
            prog(`${tag}mine probe: y=${y}, skip blind digDown; lateral branchMine instead`);
            motion('achieve.probe.lateral.begin', { item, blockName, reason: 'deep-generic', y, length: 12 });
            return await skills.customSkill(bot, 'branchMine', 12, null);
        }
        const dist = y <= 32 ? 2 : 6;
        motion('achieve.probe.down.begin', { item, blockName, y, dist });
        return await skills.digDown(bot, dist);
    }
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
