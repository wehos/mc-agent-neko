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
    let dug = 0, ore = 0, abort = null, noProg = 0;

    // ★C248b mid-dive pickaxe-survival guard (root-harden — see memory resource-floor-bootstrap-kit).
    // C248 gates the DISPATCH (don't start a dive on a dying lone pick), but a pick that starts
    // healthy can still snap mid-dive (a 14-step staircase digs ~42 blocks > a worn wooden pick's
    // ~30 uses). Digging on past the snap strands a no-pick bot deeper in stone = the y66 tomb.
    // So each step: if the lone pick is about to break AND we can't craft a replacement, ABORT
    // now (still has a few uses to climb back; higher layer then surfaces for wood).
    const invCount = (re) => bot.inventory.items().filter(it => re.test(it.name || '')).reduce((s, it) => s + it.count, 0);
    const pickAboutToBreak = () => {
        const picks = bot.inventory.items().filter(it => /_pickaxe$/.test(it.name || ''));
        if (!picks.length) return true;          // already pickless → stop digging
        if (picks.length >= 2) return false;     // spare exists
        const p = picks[0];
        const max = p.maxDurability || 0;
        const used = (typeof p.durabilityUsed === 'number') ? p.durabilityUsed : 0;
        return max > 0 && (max - used) <= 6;     // ≤6 uses ≈ 2 more steps (3 blocks/step)
    };
    const canCraftPick = () => {
        const planks = invCount(/_planks$/), logs = invCount(/_log$/);
        const cobble = invCount(/^(cobblestone|cobbled_deepslate)$/), sticks = invCount(/^stick$/);
        const haveTable = invCount(/^crafting_table$/) > 0 || planks >= 4 || logs >= 1;
        const haveHead = cobble >= 3 || planks >= 3 || logs >= 1;
        const haveSticks = sticks >= 2 || planks >= 2 || logs >= 1;
        return haveTable && haveHead && haveSticks;
    };

    for (let i = 0; i < steps; i++) {
        const cur = bot.entity.position;
        const cy = Math.round(cur.y);
        if (cy <= targetY) { log_(`reached targetY=${targetY} at step ${i}`); break; }
        // bail to survival if an actionable hostile got close (shouldn't in a sealed stair, but guard)
        try {
            const close = Object.values(bot.entities || {}).some(e => e && e !== bot.entity && e.position && ctx.mc.isHostile(e) && e.position.distanceTo(cur) < 4);
            if (close) { abort = 'hostile within 4 — yield to survival'; break; }
        } catch (e) {}
        // ★C248b: stop before the only pick snaps with no replacement → don't strand deeper.
        if (pickAboutToBreak() && !canCraftPick()) { abort = `pick about to break + no replacement (planks=${invCount(/_planks$/)} logs=${invCount(/_log$/)} cobble=${invCount(/^(cobblestone|cobbled_deepslate)$/)} stick=${invCount(/^stick$/)}) — stop before stranding`; break; }

        // ★ROOT-CAUSE FIX (-22,82,10 live pin): block cells use floor(), NOT round(). At
        // x=-22.30 the bot is physically in cell floor=-23, but round=-22 → mineDown dug the
        // forward staircase one cell off from where the bot actually stood, so the bot wedged
        // against the undug side wall and never advanced (live evidence: 40 steps, dug=93, pos
        // pinned -22,82,10, walk "moved dx=0", and agent.log spamming "Skipping block ...because
        // it is air" — it kept re-digging an already-empty column 1 cell away from the body).
        // round≠floor whenever frac>0.5 or coord<0 — exactly this negative-coord food-desert pocket.
        const cx = Math.floor(cur.x), cz = Math.floor(cur.z);
        const fx = cx + sx, fz = cz + sz;                  // forward column
        // DESCEND-forward: the new standing cell is ONE block down-and-forward. New feet at
        // (fx,cy-1,fz), new head at (fx,cy,fz), plus (fx,cy+1,fz) headroom. The support under
        // the new feet is (fx,cy-2,fz) and MUST stay solid or the bot free-falls.
        const newFeet = bn(fx, cy - 1, fz), newHead = bn(fx, cy, fz), clear = bn(fx, cy + 1, fz);
        const support = bn(fx, cy - 2, fz);
        let lavaNear = false;
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0], [0, -2, 0]]) {
            if (/lava/.test(nm(bn(fx + dx, cy - 1 + dy, fz + dz)))) { lavaNear = true; break; }
        }
        const safe = stairSafety({ feet: nm(newFeet), head: nm(newHead), floor: nm(support), lavaNear });
        if (!safe.safe) { abort = `unsafe at ${fx},${cy - 1},${fz}: ${safe.reason}`; break; }
        // No solid support under the new feet (cliff/cave) => don't blind-drop; stop.
        if (/^(air|cave_air|void_air|water|flowing_water)$/.test(nm(support))) { abort = `no floor support under ${fx},${cy - 2},${fz} (${nm(support)}) — stop, don't free-fall`; break; }

        if (i < 3) log_(`DIAG step${i} cur=${cur.x.toFixed(2)},${cur.y.toFixed(2)},${cur.z.toFixed(2)} cx,cy,cz=${cx},${cy},${cz} fwd=${fx},${fz} sx,sz=${sx},${sz} blocks: newFeet(${fx},${cy - 1},${fz})=${nm(newFeet)} newHead(${fx},${cy},${fz})=${nm(newHead)} clear(${fx},${cy + 1},${fz})=${nm(clear)} support(${fx},${cy - 2},${fz})=${nm(support)}`);
        try {
            const r1 = await skills.breakBlockAt(bot, fx, cy + 1, fz);   // headroom (old head level)
            const r2 = await skills.breakBlockAt(bot, fx, cy, fz);       // new head
            const r3 = await skills.breakBlockAt(bot, fx, cy - 1, fz);   // new feet (one down-forward)
            if (i < 3) log_(`DIAG step${i} breakResults head+1=${r1} head=${r2} feet=${r3}`);
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
        if (i < 3) log_(`DIAG step${i} afterWalk pos=${np.x.toFixed(2)},${np.y.toFixed(2)},${np.z.toFixed(2)} (moved dx=${(np.x - cur.x).toFixed(2)} dy=${(np.y - cur.y).toFixed(2)} dz=${(np.z - cur.z).toFixed(2)})`);
        if (i % 5 === 0) log_(`step ${i + 1} pos=${Math.round(np.x)},${Math.round(np.y)},${Math.round(np.z)} dug=${dug} ore=${ore} hp=${Math.round(bot.health)} food=${bot.food}`);
        // ★FIX no-advance guard: the OLD test compared np.x to the cell INDEX with a <0.3 band,
        // which a stable .30 fractional offset slips through forever (live: 40 steps, 0 descent,
        // guard never fired). Judge ACTUAL per-step progress instead: a real step drops y by ~1
        // OR moves >0.5 horizontally. Neither = wedged this step. Abort after 2 wedged steps so a
        // genuinely-stuck mineDown returns an honest "no descent" fast (→ higher layer can relocate)
        // instead of grinding 120 no-op digs in place.
        const stepDescended = (cur.y - np.y) > 0.5;
        const stepMovedHoriz = Math.hypot(np.x - cur.x, np.z - cur.z) > 0.5;
        if (!stepDescended && !stepMovedHoriz) noProg++; else noProg = 0;
        if (noProg >= 2) { abort = `no descent — wedged ${noProg} steps at ${Math.round(np.x)},${Math.round(np.y)},${Math.round(np.z)} (off-axis/blocked); yield`; break; }
    }

    let inv = {}; try { for (const it of bot.inventory.items()) inv[it.name] = (inv[it.name] || 0) + it.count; } catch (e) {}
    const r = { endY: Math.round(bot.entity.position.y), dug, oreVeins: ore, hp: Math.round(bot.health), food: bot.food, abort, raw_iron: inv.raw_iron || 0, iron_ore: 0 };
    log_(`DONE ${JSON.stringify(r)}`);
    return r;
}

export { stairCells, stairSafety };
