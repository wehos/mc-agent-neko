// Hot-reloadable TOP-LEVEL MISSION: get Neko into the Nether and stay there, fully
// unattended. This is the new sticky skill — it closes the autonomy gap where
// prepNether RETURNS after gathering its kit and the bot then idles until the next
// reconnect re-arms the sticky. missionNether never idles: it loops state →
// next-step forever, and every customSkill child it calls hot-reloads per call, so
// code fixes land mid-mission without a restart.
//
//   state                                  → action
//   in the nether                          → hold safe near the portal (the win state;
//                                            light netherrack mining keeps the watchdog's
//                                            pos+inv STUCK detector fed)
//   kitted (obsidian>=10 + flint_and_steel)→ realNetherPortal (build + light + walk in)
//   anything else                          → prepNether (re-entrant gear/material grind)
//
// Invoked via: {"skill":"missionNether","args":[]}
// ctx = { skills, world, mc, Vec3, log }
import fs from 'fs';
import path from 'path';
const PROG = path.resolve(process.cwd(), 'bots', '_supervisor', 'progress.txt');
const prog = (s) => { try { fs.appendFileSync(PROG, `[${new Date().toISOString()}] [mission] ${s}\n`); } catch (e) {} };

export default async function missionNether(bot, ctx) {
    const { skills, world, log } = ctx;
    const has = (n) => world.getInventoryCounts(bot)[n] || 0;
    const inNether = () => { try { return /nether/.test(bot.game.dimension); } catch (e) { return false; } };
    const wait = (ms) => skills.wait(bot, ms);

    prog('==== missionNether START ====');
    let portalFails = 0, victoryLogged = false;
    for (let iter = 0; iter < 5000; iter++) {
        if (bot.interrupt_code) { try { bot.interrupt_code = false; } catch (e) {} await wait(2500); }

        // ★EVAC reflex — a human who respawns (or wakes) surrounded doesn't fight or
        // grind: they sprint away first and think later. Death #261 (blackbox replay):
        // respawned with a zombie 2.8b away + 11 hostiles in 24b, full hp, yet
        // self_preservation's short local hops got terrain-locked on a y=32 cave shelf
        // and it was punched from 20→0 in 28s, bare-handed. Swarmed (3+ hostiles <16b)
        // with no weapon to answer = leave NOW, 40b opposite the mob centroid, in legs
        // so mode interrupts can't kill the whole retreat. Any task waits.
        // ★Overseer advisory — the god's-eye risk engine (bots/_supervisor/overseer.mjs)
        // fuses radar/vitals-trend/death-heat-map/blackbox into advisory.json. A fresh
        // high-risk directive outranks task work: it sees threats gathering BEFORE the
        // bot's local reflexes fire (death #261: the swarm was visible a full minute
        // before first contact). The bot still does all the acting via its own skills.
        let adv = null, advRaw = null;
        try {
            const a = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'advisory.json'), 'utf8'));
            if (a && Date.now() - a.ts < 45000) {
                advRaw = a;
                // eat_now is preventive (hunger-bleed killed #260/#262 long before risk
                // spiked) — honor it at any risk level; danger directives need risk>=70.
                if (a.risk >= 70 || a.directive === 'eat_now') adv = a;
            }
        } catch (e) {}
        // ★KILL-BOX EXPULSION — deaths #259/261/263/266 all inside one ~30b honeycomb
        // patch (cave-riddled roof: #266 fell through 18 blocks in one second and got
        // creeper-blasted on landing). Point-level avoidance can't prevent falling in
        // while passing over, so this is REGIONAL: overseer clusters the death log into
        // dzone {cx,cz,r}; any iter that finds us inside it (and not in melee contact)
        // walks straight out radially before doing anything else. No risk gate —
        // standing in the kill-box IS the risk.
        if (advRaw && advRaw.dzone) {
            const z = advRaw.dzone;
            const p0 = bot.entity.position;
            const d0 = Math.hypot(p0.x - z.cx, p0.z - z.cz);
            if (d0 < z.r) {
                const HOSZ = /zombie|skeleton|creeper|spider|witch|drowned|husk|stray|pillager|cave_spider/i;
                const inMelee = Object.values(bot.entities).some(e =>
                    e && e.position && e.name && HOSZ.test(e.name) && e.position.distanceTo(p0) < 6);
                if (!inMelee) {
                    // UNDERGROUND inside the cluster (death #270: stuck 28min at y32 in the
                    // honeycomb core — horizontal pathing through the cave maze never
                    // succeeds): go VERTICAL first. The surface has no roof to fall through;
                    // next iter expels radially from up there.
                    if (p0.y < 55) {
                        prog(`★KILL-BOX: underground in cluster (y=${Math.round(p0.y)}) → surfaceUp first`);
                        try { await skills.customSkill(bot, 'surfaceUp'); } catch (e) {}
                        continue;
                    }
                    const ux = d0 > 0.5 ? (p0.x - z.cx) / d0 : 1, uz = d0 > 0.5 ? (p0.z - z.cz) / d0 : 0;
                    const tx = Math.round(z.cx + ux * (z.r + 16)), tz = Math.round(z.cz + uz * (z.r + 16));
                    prog(`★KILL-BOX: ${Math.round(d0)}b inside death cluster @${z.cx},${z.cz}(${z.n} deaths) → expelling to ${tx},${tz}`);
                    try { await skills.goToPosition(bot, tx, Math.round(p0.y), tz, 3); } catch (e) {}
                    continue;
                }
            }
        }
        if (adv && adv.directive === 'eat_now') {
            // failure cooldown: when feedUp comes back empty (no animals/forage in
            // reach), re-firing every 3s is a spin loop (saw 4 fires in 10s in the
            // cliff alcove). One honest attempt per minute is plenty.
            if (!bot._lastFeedUpAt || Date.now() - bot._lastFeedUpAt > 60000) {
                bot._lastFeedUpAt = Date.now();
                prog(`★ADVISORY eat_now (food low, daylight, no contact) → feedUp`);
                try { await skills.customSkill(bot, 'feedUp'); } catch (e) { prog(`feedUp threw: ${e.message}`); }
                if (bot.food > 6) continue;   // actually ate — re-assess from the top
            }
            // ★NO continue here. The old wait(3000)+continue turned a persistent
            // eat_now (food=0 with nothing edible in reach) into a TOTAL short-circuit:
            // act_trace showed the bot perfectly still — no keys, no path, no dig —
            // while the loop spun wait(3000) forever and KILL-BOX/LEASH/prepNether
            // never ran again. When foraging fails, the TASK FLOW is the food path
            // (find trees → pickaxe → gear → hunt); starving quietly in place is not.
        }
        if (adv && adv.directive === 'shelter_now') {
            prog(`★ADVISORY shelter_now (risk=${adv.risk}: ${adv.reason})${adv.llm ? ` | ${adv.llm.hint}` : ''} → prepNether night-gate`);
            try { await skills.customSkill(bot, 'prepNether'); } catch (e) { prog(`prepNether threw: ${e.message}`); }
            await wait(3000);
            continue;
        }
        if (adv && adv.directive === 'leave_zone') {
            prog(`★ADVISORY leave_zone (risk=${adv.risk}: ${adv.reason})${adv.llm ? ` | ${adv.llm.hint}` : ''} → moveAway 24`);
            try { await skills.moveAway(bot, 24); } catch (e) {}
            continue;
        }

        try {
            const HOS = /zombie|skeleton|creeper|spider|witch|drowned|husk|stray|pillager|cave_spider/i;
            const scan = () => Object.values(bot.entities).filter(e =>
                e && e.position && e.name && HOS.test(e.name) && e.position.distanceTo(bot.entity.position) < 16);
            const swarm = scan();
            const armed = Object.keys(world.getInventoryCounts(bot)).some(n => /_sword$|_axe$/.test(n));
            // advisory 'evac' lowers the trigger from "3+ and unarmed" to "any hostile":
            // the overseer has wider context (trend, heat-map) than this local scan.
            // NIGHT + unarmed also floors at 1 (deaths #272/#273, two in two minutes:
            // a naked night respawn has 5 pipeline steps between revival and dug-in —
            // a single zombie closes that gap first. One mob at night = leave NOW).
            const isNightHere = (() => { try { const t = bot.time.timeOfDay; return t >= 13000 && t <= 23000; } catch (e) { return false; } })();
            const evacFloor = ((adv && adv.directive === 'evac') || isNightHere) ? 1 : 3;
            // cooldown: a failed EVAC re-firing every iter (~200ms) short-circuited the
            // WHOLE loop — including the BREAKOUT last-resort below it — for hours (the
            // axiom AGAIN: a failed high-priority branch must yield, not spin).
            if (swarm.length >= evacFloor && !armed && (!bot._lastEvacAt || Date.now() - bot._lastEvacAt > 45000)) {
                bot._lastEvacAt = Date.now();
                let cx = 0, cz = 0;
                for (const e of swarm) { cx += e.position.x; cz += e.position.z; }
                cx /= swarm.length; cz /= swarm.length;
                const me0 = bot.entity.position;
                let dx = me0.x - cx, dz = me0.z - cz;
                const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
                prog(`★EVAC: ${swarm.length} hostiles <16b, unarmed — sprinting 40b away from mob centroid before anything else`);
                for (let leg = 0; leg < 4; leg++) {
                    const p = bot.entity.position;
                    try { await skills.goToPosition(bot, Math.round(p.x + dx * 10), Math.round(p.y), Math.round(p.z + dz * 10), 2); } catch (e) {}
                    if (bot.interrupt_code) { try { bot.interrupt_code = false; } catch (e) {} }
                    if (scan().length === 0) break;
                }
                const moved = bot.entity.position.distanceTo(me0);
                prog(`EVAC done @ ${Math.round(bot.entity.position.x)},${Math.round(bot.entity.position.y)},${Math.round(bot.entity.position.z)} hostiles<16b=${scan().length} moved=${moved.toFixed(1)}`);
                if (moved >= 5) continue;   // actually escaped — re-assess
                // moved <5 = terrain-locked: FALL THROUGH so BREAKOUT/task flow still runs
            }
        } catch (e) {}

        // ★MAROONED STAND-DOWN — the mobility state machine owns the body while
        // marooned. Movement was already suppressed at the goToPosition gate, but the
        // task loop kept running its OWN digs and lookAts (nearest-block targets are
        // often BEHIND the bot) — on screen: "digging, then turns its back mid-dig"
        // (用户实拍). While marooned, the task layer parks entirely; the march has the
        // hands, the eyes, and the feet.
        try {
            if (bot._mobility && bot._mobility.state === 'MAROONED') {
                prog(`[mission] standing down: MAROONED — march owns the body`);
                await wait(5000);
                continue;
            }
        } catch (e) {}

        // ★LAST-RESORT BREAKOUT (the cliff-hole entrapment: stuck in a 6-block pocket
        // for HOURS — every polite escape (door-probe, stair-place, pillar) failed, the
        // material gate forbade bare-hand stone, and NOTHING was left running. Rule:
        // pinned within 10 blocks for 20+ min = all subtle options are exhausted —
        // tunnel STRAIGHT toward the anchor at any cost, material gates suspended.
        // Bare-hand stone here is CORRECT (it fires the BARE-HAND alarm = supervisor
        // sees the breakout in progress; slow beats entombed).
        try {
            const fp = bot.entity.position;
            if (!bot._stagPos || fp.distanceTo(bot._stagPos) > 10) { bot._stagPos = fp.clone(); bot._stagAt = Date.now(); }
            else if (Date.now() - bot._stagAt > 2 * 60 * 1000 && !bot._envDumped) {
                // ★ENVIRONMENT SNAPSHOT at 4min pinned — the code-side version of the
                // user's screenshot: what EXACTLY surrounds the bot (7x4x7), so the
                // supervisor diagnoses geometry from data instead of guessing.
                bot._envDumped = true;
                try {
                    const m = fp.floored();
                    const rows = [];
                    for (let dy = 2; dy >= -1; dy--) {
                        let grid = `y=${m.y + dy}: `;
                        for (let dz2 = -3; dz2 <= 3; dz2++) {
                            for (let dx2 = -3; dx2 <= 3; dx2++) {
                                const b = bot.blockAt(m.offset(dx2, dy, dz2));
                                grid += !b ? '?' : (b.boundingBox === 'block' ? (/water/.test(b.name) ? 'W' : '#') : (/water/.test(b.name) ? 'w' : (dx2 === 0 && dz2 === 0 ? '@' : '.')));
                            }
                            grid += '|';
                        }
                        rows.push(grid);
                    }
                    prog(`★ENV-SNAPSHOT pinned@${m.x},${m.y},${m.z}:\n` + rows.join('\n'));
                } catch (e) { prog(`env-snapshot err: ${e.message}`); }
            }
            else if (Date.now() - bot._stagAt > 4 * 60 * 1000) {
                bot._stagPos = null; bot._envDumped = false;   // re-arm after this attempt
                let bx = 96, bz = -34;
                try { const bj = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'bed.json'), 'utf8')); if (typeof bj.x === 'number') { bx = bj.x; bz = bj.z; } } catch (e) {}
                let vx = bx - fp.x, vz = bz - fp.z;
                const L = Math.hypot(vx, vz) || 1; vx /= L; vz /= L;
                const sx = Math.abs(vx) > Math.abs(vz) ? Math.sign(vx) : 0;
                const sz = sx === 0 ? Math.sign(vz) || 1 : 0;
                prog(`★BREAKOUT: pinned 20min — tunneling toward anchor dir=${sx},${sz}, material gates OFF`);
                for (let st = 0; st < 10; st++) {
                    if (bot.interrupt_code || bot.health <= 0) break;
                    const m = bot.entity.position.floored();
                    for (const c of [m.offset(sx, 1, sz), m.offset(sx, 0, sz)]) {
                        const b = bot.blockAt(c);
                        if (b && b.boundingBox === 'block' && !/water|lava|bedrock/.test(b.name)) {
                            try { await bot.tool.equipForBlock(b); } catch (e) {}
                            try { await bot.dig(b); } catch (e) {}
                        }
                    }
                    try { await bot.lookAt(m.offset(sx + 0.5, 1.6, sz + 0.5), true); } catch (e) {}
                    bot.setControlState('forward', true);
                    await new Promise(r => setTimeout(r, 800));
                    try { bot.clearControlStates(); } catch (e) {}
                }
                prog(`★BREAKOUT done @ ${Math.round(bot.entity.position.x)},${Math.round(bot.entity.position.y)},${Math.round(bot.entity.position.z)}`);
                continue;
            }
        } catch (e) {}

        if (inNether()) {
            // ── WIN STATE ── hold near the portal. Don't wander (ghasts/piglins); mine a
            // bit of netherrack on a slow cadence — useful sealing blocks AND it keeps
            // pos/inventory changing so the watchdog never mistakes the hold for STUCK.
            if (!victoryLogged) {
                victoryLogged = true;
                prog('★★★★★ IN THE NETHER — mission goal reached. Holding near portal. ★★★★★');
                log(bot, 'I made it to the Nether!');
            }
            try {
                const rack = world.getNearestBlock(bot, 'netherrack', 6);
                if (rack && has('netherrack') < 64) await skills.collectBlock(bot, 'netherrack', 1);
            } catch (e) {}
            await wait(20000);
            continue;
        }
        victoryLogged = false;   // (walked back out / died home — re-earn the banner)

        if (has('obsidian') >= 10 && has('flint_and_steel') >= 1) {
            prog(`kitted (obsidian=${has('obsidian')} f&s=${has('flint_and_steel')}) → realNetherPortal (attempt ${portalFails + 1})`);
            let r = null;
            try { r = await skills.customSkill(bot, 'realNetherPortal'); }
            catch (e) { prog(`realNetherPortal threw: ${e.message}`); }
            if (r && r.entered) { portalFails = 0; continue; }   // next iter detects nether
            portalFails++;
            prog(`portal attempt failed (${portalFails}) reason=${r && r.reason}`);
            // Materials burned or terrain hostile — fall back to prepNether to re-stock /
            // relocate, with a pause so a hard-fail can't hot-loop.
            await wait(portalFails >= 3 ? 30000 : 8000);
            if (portalFails >= 3 && r && r.reason !== 'light') {
                try { await skills.moveAway(bot, 24); } catch (e) {}   // try fresh terrain
                portalFails = 0;
            }
            continue;
        }

        prog(`not kitted (obsidian=${has('obsidian')} f&s=${has('flint_and_steel')}) → prepNether`);
        try { await skills.customSkill(bot, 'prepNether'); }
        catch (e) { prog(`prepNether threw: ${e.message}`); }
        await wait(3000);
    }
    prog('missionNether: iter cap reached (5000) — returning; sticky re-arm will resume');
    return inNether();
}
