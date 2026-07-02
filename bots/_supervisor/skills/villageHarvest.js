// Hot-reloadable REAL skill: harvest a village's grown crops for food — the OPENING_VILLAGE
// executor. (Checkpoint #13.2, 2026-07-02: the proposal has existed since checkpoint #2 but
// this FILE was never written — every dispatch died in customSkill 'Cannot find module' →
// instant false ×3 → 5-min cooldown, a permanent ghost-skill storm. Meanwhile the bot starved
// at food=6 with a farm-bearing village on the landmark list.)
//
// Bounded pass: walk toward the village landmark if no crops are in sight, harvest up to 12
// MATURE crops only (wheat/carrots/potatoes/beetroots — immature breaks waste the plot),
// pick up the drops, replant the freed farmland from harvested seeds, and when hungry craft
// + eat bread if the wheat allows. Return contract: truthy iff real progress (crops
// harvested / food eaten / bread crafted); honest false otherwise (no bed of lies for the
// kernel). No module-level mutable state (HANDOFF red line).
// Invoked via: {"skill":"villageHarvest"}  ctx = { skills, world, mc, Vec3, log }
import fs from 'fs';
import path from 'path';
const PROG = path.resolve(process.cwd(), 'bots', '_supervisor', 'progress.txt');
const prog = (s) => { try { fs.appendFileSync(PROG, `[${new Date().toISOString()}] ${s}\n`); } catch (e) {} };

const CROP_MATURE_AGE = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3 };
const CROP_REPLANT = { wheat: 'wheat_seeds', carrots: 'carrot', potatoes: 'potato', beetroots: 'beetroot_seeds' };

export default async function villageHarvest(bot, ctx) {
    const { skills, world, mc } = ctx;
    const inv = () => world.getInventoryCounts(bot);
    const hostileNear = (r) => { try { return Object.values(bot.entities || {}).some(e => e && e !== bot.entity && e.position && mc.isHostile(e) && e.position.distanceTo(bot.entity.position) < r); } catch (e) { return false; } };
    const isNight = () => { try { const t = bot.time.timeOfDay; return t >= 13000 && t <= 23000; } catch (e) { return false; } };
    const matureCrops = (r) => {
        try {
            const ids = Object.keys(CROP_MATURE_AGE)
                .map(n => bot.registry.blocksByName[n] && bot.registry.blocksByName[n].id).filter(Boolean);
            return (bot.findBlocks({ matching: ids, maxDistance: r, count: 48 }) || [])
                .map(p => bot.blockAt(p))
                .filter(b => {
                    if (!b || !(b.name in CROP_MATURE_AGE)) return false;
                    try { return Number(b.getProperties().age) >= CROP_MATURE_AGE[b.name]; } catch (e) { return false; }
                })
                .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position));
        } catch (e) { return []; }
    };

    if (isNight()) { prog('villageHarvest: night — defer to the night chain, false.'); return false; }
    if (hostileNear(12)) { prog('villageHarvest: hostile within 12b — not farming under fire, false.'); return false; }

    // 0) No crops in sight → close on the village landmark first (bounded, one walk).
    let crops = matureCrops(32);
    if (!crops.length) {
        let vlm = null;
        try { const lm = bot._world && bot._world.landmarks; if (lm && lm.village && Number.isFinite(lm.village.x)) vlm = lm.village; } catch (e) {}
        if (vlm) {
            prog(`villageHarvest: no mature crops in 32b — walking to village landmark ${Math.round(vlm.x)},${Math.round(vlm.z)}`);
            try { await skills.goToPosition(bot, vlm.x, vlm.y || bot.entity.position.y, vlm.z, 8); } catch (e) {}
            if (bot.interrupt_code || bot.health <= 0) { prog('villageHarvest: interrupted mid-walk — yielding.'); return false; }
            crops = matureCrops(32);
        }
    }
    if (!crops.length) { prog('villageHarvest: no mature crops within 32b of here (village may be farmed out / landmark stale) — false.'); return false; }

    // 1) Harvest up to 12 mature crops, pick up as we go.
    let harvested = 0;
    const freedPlots = [];
    for (const b of crops.slice(0, 12)) {
        if (bot.interrupt_code || bot.health <= 0) break;
        if (hostileNear(10)) { prog('villageHarvest: hostile closed to 10b mid-harvest — stopping the pass.'); break; }
        const p = b.position;
        try {
            if (bot.entity.position.distanceTo(p) > 4) await skills.goToPosition(bot, p.x, p.y, p.z, 2);
            const ok = await skills.breakBlockAt(bot, p.x, p.y, p.z);
            if (ok) { harvested++; freedPlots.push({ x: p.x, y: p.y - 1, z: p.z, crop: b.name }); }
        } catch (e) {}
        if (harvested % 4 === 3) { try { await skills.pickupNearbyItems(bot); } catch (e) {} }
    }
    try { await skills.pickupNearbyItems(bot); } catch (e) {}

    // 2) Replant what we can — a harvested village stays a food source; a stripped one doesn't.
    let replanted = 0;
    for (const plot of freedPlots) {
        if (bot.interrupt_code || bot.health <= 0) break;
        const seed = CROP_REPLANT[plot.crop];
        if (!seed || !(inv()[seed] > 0)) continue;
        try { if (await skills.tillAndSow(bot, plot.x, plot.y, plot.z, seed)) replanted++; } catch (e) {}
    }

    // 3) Hungry + wheat on hand → bread (3 wheat each), eat to a safe band.
    let breadCrafted = 0, ate = false;
    const wheatCt = inv().wheat || 0;
    if (bot.food < 16 && wheatCt >= 3) {
        try {
            const want = Math.min(Math.floor(wheatCt / 3), 4);
            if (await skills.craftRecipe(bot, 'bread', want)) breadCrafted = want;
        } catch (e) { prog(`villageHarvest: bread craft failed (${e && e.message || e}) — keeping the wheat.`); }
    }
    while (bot.food < 16 && (inv().bread || 0) > 0) {
        try { await skills.consume(bot, 'bread'); ate = true; } catch (e) { break; }
    }

    prog(`villageHarvest: pass done — harvested=${harvested} replanted=${replanted} bread+${breadCrafted} ate=${ate} food=${bot.food}`);
    if (harvested > 0 || breadCrafted > 0 || ate) return { harvested, replanted, breadCrafted, ate };
    return false;
}
