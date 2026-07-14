// verifyMove — a flexible, SAFE locomotion STRESS-TEST probe (NOT a mission skill).
//
// Drives the bot through a configurable patrol so the motion_quality monitor can sample
// edgeStallMs / crossEff / airRate on rugged terrain (surface) or underground (cave),
// to verify the C212 locomotion fixes (arrival tolerance 0.35 + allowParkour + air-swing
// gate). Test-harness only — the user explicitly authorized cheat commands for setup
// (/time set day, /give iron_pickaxe, /tp to a surface/cave spot).
//
// opts (passed as a single object via run_skill args):
//   cmds:    string[]  chat/cheat commands to run first (e.g. ["/time set day"])
//   surface: bool      if true, scan for the surface Y at the bot's x,z and /tp up to it
//   tp:      [x,y,z]   if set, /tp @s there before traversing
//   laps:    int       how many times to repeat the patrol (default 2)
//   radius:  int       patrol square half-size in blocks (default 22)
//   guardHp: int       abort below this hp (default 8)
//   allowNight: bool   skip the night abort (for underground tests; default false)
//   label:   string    tag for logs
//
// HARD-GUARDED: aborts mid-patrol on hp drop / close hostile / nightfall (unless allowNight).
// SELF-RESTORING: rewrites sticky_skill.json -> missionNether on exit so the mission resumes.

import fs from 'fs';

const STICKY = 'bots/_supervisor/sticky_skill.json';

function restoreMission(L) {
    try { fs.writeFileSync(STICKY, JSON.stringify({ skill: 'missionNether', args: [] })); L('restored sticky -> missionNether'); }
    catch (e) { L(`restore sticky failed: ${e && e.message || e}`); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async function verifyMove(bot, ctx, opts = {}) {
    const { log, skills, mc, Vec3 } = ctx;
    const tag = opts.label || '?';
    // Dedicated, immediately-flushed log channel — ctx.log() goes to the agent's buffered
    // stdout/agent.log (unreliable to tail mid-run); this fs.append gives ground-truth.
    const VLOG = 'bots/_supervisor/verify.log';
    const L = (m) => { const line = `[${new Date().toISOString().slice(11, 19)}] [verifyMove:${tag}] ${m}`; try { log(bot, line); } catch (e) {} try { fs.appendFileSync(VLOG, line + '\n'); } catch (e) {} };
    const radius = opts.radius || 22;
    const laps = opts.laps != null ? opts.laps : 2;
    const guardHp = opts.guardHp || 8;
    const allowNight = !!opts.allowNight;

    const isNight = () => { try { const t = bot.time.timeOfDay; return t > 13000 && t < 23000; } catch { return false; } };
    const closeHostile = () => { try { return Object.values(bot.entities || {}).some(e => e && e !== bot.entity && e.position && mc.isHostile(e) && e.position.distanceTo(bot.entity.position) < 9); } catch { return false; } };

    // Optional test-harness difficulty override: peaceful despawns ALL hostiles instantly and
    // stops hunger drain → a clean locomotion test with no mob/food confound. Self-restored.
    const origDiff = (bot.game && bot.game.difficulty) || 'normal';

    try {
        L(`DIAG cheatMode=${(bot.modes && bot.modes.isOn && bot.modes.isOn('cheat')) ? 'ON' : 'off'} mob=${(bot._mobility && bot._mobility.state) || '?'} pos=${bot.entity.position.x.toFixed(0)},${bot.entity.position.y.toFixed(0)},${bot.entity.position.z.toFixed(0)} hp=${Math.round(bot.health)} food=${bot.food} diff=${origDiff}`);
        if (opts.peaceful) { L(`difficulty ${origDiff} -> peaceful (test); will restore`); bot.chat('/difficulty peaceful'); await sleep(1300); }

        // 1) cheat / setup commands
        for (const c of (opts.cmds || [])) {
            L(`cmd: ${c}`);
            try { bot.chat(c); } catch (e) { L(`cmd err: ${e && e.message || e}`); }
            await sleep(700);
        }

        // 2) explicit teleport
        if (opts.tp && opts.tp.length === 3) {
            L(`tp -> ${opts.tp.join(',')}`);
            bot.chat(`/tp @s ${opts.tp[0]} ${opts.tp[1]} ${opts.tp[2]}`);
            await sleep(1500);
        }

        // 3) surface: scan highest solid block at current x,z with 2 air above, tp up onto it
        if (opts.surface) {
            const p = bot.entity.position;
            const x = Math.floor(p.x), z = Math.floor(p.z);
            let surfY = null;
            for (let y = 118; y >= 50; y--) {
                try {
                    const b = bot.blockAt(new Vec3(x + 0.5, y, z + 0.5));
                    const a1 = bot.blockAt(new Vec3(x + 0.5, y + 1, z + 0.5));
                    const a2 = bot.blockAt(new Vec3(x + 0.5, y + 2, z + 0.5));
                    if (b && b.boundingBox === 'block' && !/leaves|log/.test(b.name) &&
                        a1 && a1.boundingBox === 'empty' && a2 && a2.boundingBox === 'empty') { surfY = y; break; }
                } catch (e) {}
            }
            if (surfY != null) { L(`surface Y=${surfY} at ${x},${z} — tp up`); bot.chat(`/tp @s ${x + 0.5} ${surfY + 1} ${z + 0.5}`); await sleep(3000); }
            else L(`no surface found at ${x},${z} (chunk loaded?) — traversing from here`);
        }

        // 3b) descend: dig a diagonal shaft down to a cave/ore depth (needs a pick; iron given via
        // cmds). Diagonal (x+10,z+10 offset) not straight-down to reduce lava-pillar risk.
        if (opts.descendTo != null) {
            const p0 = bot.entity.position;
            const dx = Math.round(p0.x) + 10, dz = Math.round(p0.z) + 10;
            L(`descend: dig toward ${dx},${opts.descendTo},${dz} (from y${Math.round(p0.y)} pick=${bot.heldItem && bot.heldItem.name})`);
            try { if (bot._mobility && bot._mobility.state === 'MAROONED') bot._mobility.state = 'FREE'; } catch (e) {}
            try { await skills.goToPosition(bot, dx, opts.descendTo, dz, 2); } catch (e) { L(`descend nav: ${e && e.message || e}`); }
            L(`descend done -> ${bot.entity.position.x.toFixed(0)},${bot.entity.position.y.toFixed(0)},${bot.entity.position.z.toFixed(0)}`);
            await sleep(800);
        }

        if (!allowNight && isNight()) { L('night — daytime-only; skip patrol'); return { ok: false, reason: 'night' }; }
        if (bot.health < guardHp + 2) { L(`hp=${Math.round(bot.health)} too low — skip patrol`); return { ok: false, reason: 'hp low' }; }

        const home = bot.entity.position.clone();
        const startHp = bot.health;
        L(`START ${home.x.toFixed(0)},${home.y.toFixed(0)},${home.z.toFixed(0)} hp=${Math.round(startHp)} food=${bot.food} laps=${laps} R=${radius}`);
        try { if (bot._mobility && bot._mobility.state === 'MAROONED') { bot._mobility.state = 'FREE'; L('cleared MAROONED'); } } catch (e) {}

        const corners = [[radius, 0], [radius, radius], [0, radius], [0, 0]];
        // durationSec: run continuous laps for this long so the probe OWNS the body the whole
        // window (missionNether can't re-arm and interfere). Else fixed lap count.
        const deadline = opts.durationSec ? Date.now() + opts.durationSec * 1000 : 0;
        let totalMoved = 0, stalls = 0, lap = 0;
        while (deadline ? Date.now() < deadline : lap < laps) {
            lap++;
            for (let i = 0; i < corners.length; i++) {
                if ((!allowNight && isNight()) || closeHostile() || bot.health < startHp - 5 || bot.health < guardHp) {
                    L(`ABORT lap ${lap} leg ${i + 1} (hp=${Math.round(bot.health)} night=${isNight()} hostile=${closeHostile()})`);
                    return { ok: true, aborted: true, totalMoved: +totalMoved.toFixed(0), stalls, endHp: Math.round(bot.health) };
                }
                const tx = Math.round(home.x + corners[i][0]);
                const tz = Math.round(home.z + corners[i][1]);
                const ty = Math.round(bot.entity.position.y);
                const before = bot.entity.position.clone();
                const t0 = Date.now();
                // mobility recomputes every ~2s and can RE-set MAROONED, which makes goToGoal/
                // goToPosition early-return false (no pathfinding, no move). The probe is the
                // deliberate mover, so re-clear it right before every leg.
                try { if (bot._mobility && (bot._mobility.state === 'MAROONED')) { bot._mobility.state = 'FREE'; } } catch (e) {}
                const mobNow = (bot._mobility && bot._mobility.state) || '?';
                L(`lap ${lap} leg ${i + 1}/4 -> ${tx},~${ty},${tz} (from ${before.x.toFixed(0)},${before.y.toFixed(0)},${before.z.toFixed(0)} mob=${mobNow})`);
                let navRet;
                try { navRet = await skills.goToPosition(bot, tx, ty, tz, 2); }
                catch (e) { L(`lap ${lap} leg ${i + 1} nav THREW: ${e && e.message || e}`); }
                const moved = bot.entity.position.distanceTo(before);
                const secs = (Date.now() - t0) / 1000;
                totalMoved += moved;
                const want = Math.hypot(tx - before.x, tz - before.z);
                if (want > 4 && moved < want * 0.5) { stalls++; L(`  ⚠️ partial: moved ${moved.toFixed(1)}/${want.toFixed(0)}b in ${secs.toFixed(0)}s navRet=${navRet} (terrain blocked / early-return?)`); }
                else L(`  ok: moved ${moved.toFixed(1)}b in ${secs.toFixed(0)}s -> ${bot.entity.position.x.toFixed(0)},${bot.entity.position.y.toFixed(0)},${bot.entity.position.z.toFixed(0)}`);
                if (moved < 1.5) await sleep(900); // anti-spin: a no-progress leg shouldn't tight-loop
            }
        }
        const end = bot.entity.position;
        const r = { ok: true, laps: lap, totalMoved: +totalMoved.toFixed(0), partialLegs: stalls, backNearHome: end.distanceTo(home) < 8, startHp: Math.round(startHp), endHp: Math.round(bot.health), food: bot.food };
        L(`DONE ${JSON.stringify(r)}`);
        return r;
    } finally {
        if (opts.peaceful) { try { bot.chat('/difficulty ' + origDiff); L(`restored difficulty -> ${origDiff}`); } catch (e) {} }
        restoreMission(L);
    }
}
