// mineDown — a SAFE sealed 1-wide descending staircase miner. The bot keeps dying/stalling
// because it never closes the armor gap (86% of deaths are unarmored), and at low hp the patch
// layers gate it out of ALL mining — so it stands down forever in food deserts. But mining a
// 1-wide staircase is SAFE even at hp10: you are always in a single-block slot no mob can reach.
// This gets the bot DOWN to the iron band, collecting ore en route, breaking the surface
// stand-down deadlock and feeding the iron->armor chain.
//
// Reuses the safety idiom proven in escapePlan: pure cellSafety() (lava/bedrock), breakBlockAt,
// and a low-level forward walk (no pathfinder — descent is a 1-block drop the bot falls into).
//
// opts: { steps=40, heading=null (auto), targetY=45 }

const ORE = /(iron_ore|deepslate_iron_ore|coal_ore|deepslate_coal_ore|copper_ore|gold_ore|diamond_ore|deepslate_diamond_ore|redstone_ore|lapis_ore)/;
const FLUID = /(lava|flowing_lava)/;
const UNBREAKABLE = /(bedrock|barrier|obsidian|reinforced_deepslate)/;

// PURE: descending-staircase feet-cell sequence from start along a cardinal heading.
// Each step moves 1 on the heading axis and 1 down. Deterministic, offline-testable.
function stairCells(start, sx, sz, n) {
    const cells = [];
    let x = start.x, y = start.y, z = start.z;
    for (let i = 0; i < n; i++) { x += sx; z += sz; y -= 1; cells.push({ x, y, z }); }
    return cells;
}

// PURE: safe to dig+drop into this stair cell? reads = {feet,head,floor,lavaNear}
function stairSafety(reads) {
    if (reads.lavaNear) return { safe: false, reason: 'lava near stair cell' };
    if (FLUID.test(reads.feet || '') || FLUID.test(reads.head || '') || FLUID.test(reads.floor || '')) return { safe: false, reason: 'fluid in/under stair cell' };
    if (UNBREAKABLE.test(reads.feet || '') || UNBREAKABLE.test(reads.head || '')) return { safe: false, reason: `unbreakable (${reads.feet}/${reads.head})` };
    return { safe: true, reason: 'ok' };
}

export default async function mineDown(bot, ctx, opts = {}) {
    const { log, skills, Vec3 } = ctx;
    const steps = opts.steps || 40;
    const targetY = opts.targetY != null ? opts.targetY : 45;
    const log_ = (m) => log(bot, `[mineDown] ${m}`);
    const bn = (x, y, z) => { try { return bot.blockAt(new Vec3(x, y, z)); } catch { return null; } };
    const nm = (b) => (b && b.name) || 'air';

    // Heading: prefer away from the nearest hostile (don't dig toward a mob); else +x.
    let sx = 1, sz = 0;
    try {
        const p = bot.entity.position;
        let nearest = null, nd = Infinity;
        for (const e of Object.values(bot.entities || {})) {
            if (e && e !== bot.entity && e.position && ctx.mc.isHostile(e)) { const d = e.position.distanceTo(p); if (d < nd) { nd = d; nearest = e; } }
        }
        if (nearest && nd < 24) { const dx = p.x - nearest.position.x, dz = p.z - nearest.position.z; if (Math.abs(dx) >= Math.abs(dz)) { sx = Math.sign(dx) || 1; sz = 0; } else { sx = 0; sz = Math.sign(dz) || 1; } }
    } catch (e) {}

    log_(`START pos=${Math.round(bot.entity.position.x)},${Math.round(bot.entity.position.y)},${Math.round(bot.entity.position.z)} hp=${Math.round(bot.health)} food=${bot.food} heading=${sx},${sz} targetY=${targetY}`);
    let dug = 0, ore = 0, abort = null;

    for (let i = 0; i < steps; i++) {
        const cur = bot.entity.position;
        const cy = Math.round(cur.y);
        if (cy <= targetY) { log_(`reached targetY=${targetY} at step ${i}`); break; }
        // bail to survival if an actionable hostile got close (shouldn't in a sealed stair, but guard)
        try {
            const close = Object.values(bot.entities || {}).some(e => e && e !== bot.entity && e.position && ctx.mc.isHostile(e) && e.position.distanceTo(cur) < 4);
            if (close) { abort = 'hostile within 4 — yield to survival'; break; }
        } catch (e) {}

        const cx = Math.round(cur.x), cz = Math.round(cur.z);
        const fx = cx + sx, fz = cz + sz;                  // forward column
        // Cells to clear: forward feet (fx,cy,fz) + forward head (fx,cy+1,fz) to walk in, then
        // forward floor (fx,cy-1,fz) to drop one. Safety scan around them for lava.
        const feet = bn(fx, cy, fz), head = bn(fx, cy + 1, fz), floor = bn(fx, cy - 1, fz);
        let lavaNear = false;
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0], [0, -2, 0]]) {
            if (/lava/.test(nm(bn(fx + dx, cy + dy, fz + dz)))) { lavaNear = true; break; }
        }
        const safe = stairSafety({ feet: nm(feet), head: nm(head), floor: nm(floor), lavaNear });
        if (!safe.safe) { abort = `unsafe at ${fx},${cy},${fz}: ${safe.reason}`; break; }

        try {
            await skills.breakBlockAt(bot, fx, cy + 1, fz);   // head clearance
            await skills.breakBlockAt(bot, fx, cy, fz);       // forward feet
            await skills.breakBlockAt(bot, fx, cy - 1, fz);   // step-down floor (drop target)
            dug += 3;
            // opportunistic ore around the dug column (one ring)
            for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0]]) {
                const b = bn(fx + dx, cy + dy, fz + dz);
                if (b && ORE.test(b.name)) { try { await skills.breakBlockAt(bot, fx + dx, cy + dy, fz + dz); ore++; } catch (e) {} }
            }
        } catch (e) { abort = `dig threw: ${e && e.message || e}`; break; }

        // Walk forward; the bot falls 1 block into the cleared step. Low-level (no pathfinder).
        try {
            await bot.lookAt(new Vec3(fx + 0.5, cy - 0.5, fz + 0.5), true);
            bot.setControlState('forward', true);
            const t0 = Date.now();
            while (Date.now() - t0 < 2500) { const p = bot.entity.position; if (Math.hypot(p.x - (fx + 0.5), p.z - (fz + 0.5)) < 0.4) break; await new Promise(r => setTimeout(r, 100)); }
        } finally { try { bot.setControlState('forward', false); } catch (e) {} }

        const np = bot.entity.position;
        if (i % 5 === 0) log_(`step ${i + 1} pos=${Math.round(np.x)},${Math.round(np.y)},${Math.round(np.z)} dug=${dug} ore=${ore} hp=${Math.round(bot.health)} food=${bot.food}`);
        if (Math.abs(np.x - cx) < 0.3 && Math.abs(np.z - cz) < 0.3) { abort = `no advance at step ${i + 1} (pos ${Math.round(np.x)},${Math.round(np.y)},${Math.round(np.z)})`; break; }
    }

    let inv = {}; try { for (const it of bot.inventory.items()) inv[it.name] = (inv[it.name] || 0) + it.count; } catch (e) {}
    const r = { endY: Math.round(bot.entity.position.y), dug, oreVeins: ore, hp: Math.round(bot.health), food: bot.food, abort, raw_iron: inv.raw_iron || 0, iron_ore: 0 };
    log_(`DONE ${JSON.stringify(r)}`);
    return r;
}

export { stairCells, stairSafety };
