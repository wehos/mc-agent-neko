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
// ★C311 (T-0048): WATER was missing here — only lava was guarded. mineDown dug a staircase
// straight into an aquifer at depth (y35) and the bot drowned (#112), while its siblings
// branchMine (BAD_FLUID=/lava|water/) and digDown (_WL incl. water) both stop on water.
// Water in the feet/head/floor cell, or flowing in from a side, must STOP the descent.
const FLUID = /(lava|flowing_lava|water|flowing_water)/;
const UNBREAKABLE = /(bedrock|barrier|obsidian|reinforced_deepslate)/;

// PURE: descending-staircase feet-cell sequence from start along a cardinal heading.
// Each step moves 1 on the heading axis and 1 down. Deterministic, offline-testable.
function stairCells(start, sx, sz, n) {
    const cells = [];
    let x = start.x, y = start.y, z = start.z;
    for (let i = 0; i < n; i++) { x += sx; z += sz; y -= 1; cells.push({ x, y, z }); }
    return cells;
}

// PURE: safe to dig+drop into this stair cell? reads = {feet,head,floor,fluidNear}
function stairSafety(reads) {
    if (reads.fluidNear) return { safe: false, reason: 'fluid (lava/water) near stair cell' };
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
    // ★fluid-abort heading rotation (2026-07-02 13:07Z: 3 dispatches from the same cell all
    // aborted on the SAME flooded stair (44,61,160) — the heading is deterministic (+x when no
    // hostile), so every retry was identical and the kind burned into cooldown. Remember
    // fluid-aborted headings near this spot (TTL 10min, bot-object state per HANDOFF red line)
    // and start with the first cardinal that hasn't failed here yet.)
    try {
        const p0 = bot.entity.position;
        bot._mineDownFluidAvoid = (bot._mineDownFluidAvoid || []).filter(a => Date.now() - a.at < 600000);
        const avoid = bot._mineDownFluidAvoid.filter(a => Math.hypot(a.x - p0.x, a.z - p0.z) < 8);
        if (avoid.some(a => a.sx === sx && a.sz === sz)) {
            const clean = [[1, 0], [0, 1], [-1, 0], [0, -1]].find(([cx, cz]) => !avoid.some(a => a.sx === cx && a.sz === cz));
            if (clean) { sx = clean[0]; sz = clean[1]; log_(`heading rotated to ${sx},${sz} — ${avoid.length} fluid-aborted heading(s) remembered near here`); }
            // ★checkpoint#25 P1-A: only REFUSE on all-flooded headings when we still NEED to staircase
            // down — already at band (y<=targetY+2) the descent heading is moot (the at-band delegate
            // below hands off to branchMine, which has its own per-cell fluid guards), so stale fluid
            // memories from earlier descents must not block lateral mining at the band.
            else if (bot.entity.position.y > targetY + 2) { log_('all 4 headings fluid-aborted near here — refusing, higher layer should relocate first'); return { failed: true, abort: 'all headings flooded nearby' }; }
            else { log_('all 4 headings fluid-aborted near here — but already at band; branchMine delegate owns fluid safety laterally'); }
        }
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
    // The predicate math now lives in the shared skills.pickRunway (one tool-durability
    // budget for the descent gate, TOOL_UPKEEP proposal, and every dig loop — the local
    // copies here were the original but drifted from modes.js's kit variant; the shared
    // canFieldCraftPick is stone-strict where the old local allowed a planks-head wooden
    // fallback — stricter aborts a step earlier, the safe direction).
    const pickAboutToBreak = () => skills.pickRunway(bot).aboutToBreak;
    const canCraftPick = () => skills.pickRunway(bot).canFieldCraftPick;

    // ★KERNEL-CONTRACT entry snapshot (return-contract audit 2026-07-02): the final return judges
    // REAL progress this dispatch against these — y actually descended, or net ore units gained.
    // Hoisted from the at-depth loop so both the loop's stall judge and the return judge read one
    // definition. Do NOT trust `dug` for this: it historically counted air no-ops. Widened with
    // coal|emerald (branchMine's set has them; the old set missed the ITEM drops of coal_ore,
    // which IS in ORE above — a coal-only productive run must not judge as zero-progress).
    const oreUnits = () => invCount(/^raw_iron$/) + invCount(/^raw_copper$/) + invCount(/^raw_gold$/)
        + invCount(/^(iron_ore|deepslate_iron_ore|gold_ore|deepslate_gold_ore|redstone|lapis_lazuli|diamond|coal|emerald)$/)
        + invCount(/_ore$/);
    const entryY = Math.round(bot.entity.position.y);
    const oreUnitsAtEntry = oreUnits();

    // ★checkpoint#25 P1-A AT-BAND DELEGATE (06:53:58-06:54:03 实录: bot 首次抵达 y=12 钻石带后,
    // 三次 mineDown 派发全部 {endY:12, dug:0, abort:null, failed:true} — 起点已在目标层, mineDown
    // 是"只下降"的技能, 下降 0 被 return-contract 判败 → 3 振 → DUSK_MINE_NIGHT 冷却在钻石层
    // 正上方 → bot 上浮放弃 → 钻石 0)。已在带内 (y <= targetY+2) 时正确动作不是"再下降", 而是
    // 转入 branchMine 支线采矿 — "mine through the night" 的本意。branchMine(bot,ctx,length,targetY)
    // 自带 lava/water/断镐/低食守卫 + C305 反 x-ray 可达门 + 自己的净进度返回契约 (真进度 truthy /
    // 零进度 false), 这里按原契约透传其返回: 有进展 → kernel 保持 commitment 再派 (下一派仍 at-band
    // → 再 branchMine, 即整夜带内轮采); 零进展 → 诚实 failed:true 进冷却 (是"没挖到"的真败, 不再是
    // "没下降"的假败)。branchMine 不可用/抛错 → 退而求其次: 本轮净矿增益或实际下降 → truthy,
    // 纯零进展仍 failed:true (诚实)。entry snapshot (entryY/oreUnitsAtEntry) 语义未破坏 — fallback
    // 判据仍读它; abort 语义未破坏 — 委派路径 abort=null (无楼梯步, 无 abort 源)。
    if (bot.entity.position.y <= targetY + 2) {
        log_(`at-band start (y=${entryY} <= targetY+2=${targetY + 2}) — delegating to branchMine (lateral ore mining), not judging by descent`);
        let bmOk = null;   // true/false = branchMine's own contract verdict; null = unavailable/threw → local fallback judge
        if (typeof skills.customSkill === 'function') {
            try { bmOk = !!(await skills.customSkill(bot, 'branchMine', 24, targetY)); }
            catch (e) { bmOk = null; log_(`branchMine threw: ${e && e.message || e} — falling back to local progress judge`); }
        } else {
            log_('skills.customSkill unavailable — falling back to local progress judge');
        }
        let inv = {}; try { for (const it of bot.inventory.items()) inv[it.name] = (inv[it.name] || 0) + it.count; } catch (e) {}
        const r = { endY: Math.round(bot.entity.position.y), dug, oreVeins: ore, hp: Math.round(bot.health), food: bot.food,
                    abort, raw_iron: inv.raw_iron || 0, iron_ore: 0, atBand: true, delegated: 'branchMine', bmReturn: bmOk };
        // Fallback judge mirrors the file's KERNEL-CONTRACT: real ore units gained or real descent.
        // (In the delegate path mineDown's own dug/ore stay 0 — branchMine digs internally — so the
        // observable local progress is picked-up ore units / y actually descended.)
        const localProgress = (entryY - r.endY) >= 1 || oreUnits() > oreUnitsAtEntry;
        const progressed = bmOk === null ? localProgress : bmOk;
        if (!progressed) r.failed = true;
        log_(`DONE ${JSON.stringify(r)} (at-band delegate: bm=${bmOk} localProgress=${localProgress})`);
        return r;
    }

    for (let i = 0; i < steps; i++) {
        const cur = bot.entity.position;
        const cy = Math.round(cur.y);
        if (cy <= targetY) {
            // ★AT-DEPTH NO-OP FREEZE FIX (live y12 pin 450s+): mineDown ONLY descends, so once it reaches
            //   targetY it returns instantly and the proposer (GO_UNDERGROUND/DUSK_MINE_NIGHT) re-dispatches
            //   it → no-op every ~1.5s → the bot freezes at the bottom of the iron band having mined NO ore
            //   (live: y12, coal but 0 raw_iron). Fall through to branchMine — a horizontal ore tunnel
            //   (its own lava/water guards) — so the bot actually MINES iron/diamond at the band.
            // ★T-0092 AT-DEPTH BRANCH LOOP: a SINGLE branchMine(24) then return wasn't enough — the
            //   proposer re-dispatched, branchMine re-tunnelled the same dead-end, and the bot空转 at
            //   the band底. Instead LOOP branchMine here with a NET-PROGRESS judge: keep tunnelling for
            //   ore until either (a) no new ore came in over the last 2 rounds (this seam is mined out →
            //   return so a fresh dispatch starts a new heading/depth), (b) the pack is full (go bank),
            //   or (c) the pick is about to snap with no recraft (don't strand deep). This makes
            //   descend-then-MINE-OUT the productive unit instead of descend-then-touch-and-leave.
            // (oreUnits hoisted to function entry — return-contract audit 2026-07-02.)
            let lastUnits = oreUnits(), stallRounds = 0, rounds = 0;
            log_(`reached targetY=${targetY} at step ${i} — branch-mining loop for ore (oreUnits=${lastUnits})`);
            while (rounds++ < 8) {
                if (bot.interrupt_code) { abort = 'interrupted at-depth branch loop'; break; }
                // pack full → stop mining, let the higher layer bank/declutter (drops would be lost).
                let free = 36; try { free = bot.inventory.emptySlotCount(); } catch (e) {}
                if (free <= 1) { log_(`pack full (free=${free}) — stop at-depth mining (bank/declutter)`); break; }
                // pick guard: about to break + can't recraft → return before stranding deep.
                if (pickAboutToBreak() && !canCraftPick()) { log_('pick about to break + no recraft — stop at-depth mining'); break; }
                try { await skills.customSkill(bot, 'branchMine', 24); } catch (e) { log_(`branchMine threw: ${e && e.message || e}`); break; }
                const now = oreUnits();
                if (now > lastUnits) { stallRounds = 0; lastUnits = now; }
                else { stallRounds++; if (stallRounds >= 2) { log_(`no new ore over ${stallRounds} rounds (oreUnits=${now}) — seam mined out, return for fresh dispatch`); break; } }
            }
            break;
        }
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
        // ★C311 (T-0048): was lava-only; now lava+water — an aquifer floods the stair from the
        // SIDE (not just the cell we break), the recurring deep drowning (#112). Same ring, both fluids.
        let fluidNear = false;
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0], [0, -2, 0]]) {
            if (/lava|water/.test(nm(bn(fx + dx, cy - 1 + dy, fz + dz)))) { fluidNear = true; break; }
        }
        const safe = stairSafety({ feet: nm(newFeet), head: nm(newHead), floor: nm(support), fluidNear });
        if (!safe.safe) {
            abort = `unsafe at ${fx},${cy - 1},${fz}: ${safe.reason}`;
            // feed the heading-rotation memory (see START) so the next dispatch tries a different way
            if (/fluid/.test(safe.reason || '')) {
                try { (bot._mineDownFluidAvoid = bot._mineDownFluidAvoid || []).push({ x: bot.entity.position.x, z: bot.entity.position.z, sx, sz, at: Date.now() }); } catch (e) {}
            }
            break;
        }
        // No solid support under the new feet (cliff/cave) => don't blind-drop; stop.
        if (/^(air|cave_air|void_air|water|flowing_water)$/.test(nm(support))) { abort = `no floor support under ${fx},${cy - 2},${fz} (${nm(support)}) — stop, don't free-fall`; break; }

        if (i < 3) log_(`DIAG step${i} cur=${cur.x.toFixed(2)},${cur.y.toFixed(2)},${cur.z.toFixed(2)} cx,cy,cz=${cx},${cy},${cz} fwd=${fx},${fz} sx,sz=${sx},${sz} blocks: newFeet(${fx},${cy - 1},${fz})=${nm(newFeet)} newHead(${fx},${cy},${fz})=${nm(newHead)} clear(${fx},${cy + 1},${fz})=${nm(clear)} support(${fx},${cy - 2},${fz})=${nm(support)}`);
        try {
            const r1 = await skills.breakBlockAt(bot, fx, cy + 1, fz);   // headroom (old head level)
            const r2 = await skills.breakBlockAt(bot, fx, cy, fz);       // new head
            const r3 = await skills.breakBlockAt(bot, fx, cy - 1, fz);   // new feet (one down-forward)
            if (i < 3) log_(`DIAG step${i} breakResults head+1=${r1} head=${r2} feet=${r3}`);
            // ★return-contract audit 2026-07-02: was `dug += 3` UNCONDITIONALLY — a re-dispatched
            // wedged bot no-op'ing on already-air cells returned {dug:6} "progress" with zero world
            // change (the -22,82,10 pin family). breakBlockAt returns strict true only when a block
            // was actually removed, so count only those.
            dug += [r1, r2, r3].filter(v => v === true).length;
            // opportunistic ore around the dug column (one ring)
            for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0]]) {
                const ox = fx + dx, oy = cy + dy, oz = fz + dz;
                const b = bn(ox, oy, oz);
                if (!(b && ORE.test(b.name))) continue;
                // ★C311 (T-0048): don't pop an ore that's plugging a fluid pocket — breaking it
                // releases lava/water into the stair (#113 lava: deep ore-ring with no fluid check).
                let oreFluidAdj = false;
                for (const [ex, ey, ez] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
                    if (/lava|water/.test(nm(bn(ox + ex, oy + ey, oz + ez)))) { oreFluidAdj = true; break; }
                }
                if (oreFluidAdj) continue;
                try { await skills.breakBlockAt(bot, ox, oy, oz); ore++; } catch (e) {}
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
    // ★KERNEL-CONTRACT FIX (return-contract audit 2026-07-02): this is the file's ONLY return and
    // it was always truthy with no failed key, so every ZERO-PROGRESS exit reset the kernel's
    // dispatch-failure counter (kernel.js failed-sniff = threw / ===false / ok===false /
    // failed===true) and the committed kind re-dispatched the identical abort every ~2s forever:
    // step-0 aborts (fluid near stair cell / no floor support / pick-runway) against static world
    // blocks on a deterministic +x heading, at-depth mined-out-seam exits, and wedged air-no-op
    // re-digs. GO_UNDERGROUND stays committed until iron pick/buffer, DUSK_MINE_NIGHT ALL NIGHT —
    // unbreakable hot livelock, the 3-strike/5-min cooldown could never trip. Judge REAL progress
    // this dispatch against the entry snapshot (descended >=1 block OR net ore units gained);
    // zero progress marks failed:true so the cooldown engages and the commitment is released.
    // Shape keeps all fields (kernel is the only consumer; no other caller reads this object).
    const progressed = (entryY - r.endY) >= 1 || oreUnits() > oreUnitsAtEntry;
    if (!progressed) r.failed = true;
    log_(`DONE ${JSON.stringify(r)}`);
    return r;
}

export { stairCells, stairSafety };
