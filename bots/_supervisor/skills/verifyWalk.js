// verifyWalk — a bounded, SAFE locomotion VERIFICATION probe (NOT a mission skill).
//
// Why it exists: the locomotion fixes in C212 (pathfinder arrival tolerance 0.35 +
// allowParkour on + air-swing gate) need to be VERIFIED in motion, but the live bot was
// pinned by the prepNether low-food hold (food=7) and refused to travel, so the
// motion_quality monitor saw all-zero (nothing moving). This probe makes the bot walk a
// short out-and-back patrol so motion_quality can sample edgeStallMs / crossEff on the
// NEW pathfinder config. It is a one-shot diagnostic dispatched by the supervisor.
//
// HARD-GUARDED: daytime + no close hostile to start; aborts mid-walk on nightfall,
// a close hostile, or any hp drop. Bounded radius. This is deliberately conservative — the
// C210 lesson (reckless low-food live poke drowned the bot) means a probe must be able to
// bail to survival instantly and never wander far.
//
// SELF-RESTORING: rewrites sticky_skill.json back to the mission on exit, so the bridge's
// 8s re-arm resumes missionNether instead of looping this probe.

import fs from 'fs';

const STICKY = 'bots/_supervisor/sticky_skill.json';

function restoreMission(L) {
    try {
        fs.writeFileSync(STICKY, JSON.stringify({ skill: 'missionNether', args: [] })); // Node = no BOM
        L('restored sticky -> missionNether');
    } catch (e) { L(`restore sticky failed: ${e && e.message || e}`); }
}

export default async function verifyWalk(bot, ctx, opts = {}) {
    const { log, skills, mc } = ctx;
    const L = (m) => log(bot, `[verifyWalk] ${m}`);
    const R = opts.radius || 15;

    const isNight = () => { try { const t = bot.time.timeOfDay; return t > 13000 && t < 23000; } catch { return false; } };
    const closeHostile = () => { try { return Object.values(bot.entities || {}).some(e => e && e !== bot.entity && e.position && mc.isHostile(e) && e.position.distanceTo(bot.entity.position) < 10); } catch { return false; } };

    // Restore the mission no matter how we exit (gate refusal, abort, or completion).
    try {
        if (isNight()) { L('night — daytime-only probe, skip'); return { ok: false, reason: 'night' }; }
        if (closeHostile()) { L('hostile within 10 — skip probe'); return { ok: false, reason: 'hostile close' }; }

        const home = bot.entity.position.clone();
        const startHp = bot.health;
        L(`START ${home.x.toFixed(0)},${home.y.toFixed(0)},${home.z.toFixed(0)} hp=${Math.round(startHp)} food=${bot.food}`);

        // The probe IS the deliberate mover — clear a stale MAROONED so goToGoal's gate
        // doesn't silently suppress every leg (same as forageExplore/escapePlan do).
        try { if (bot._mobility && bot._mobility.state === 'MAROONED') { bot._mobility.state = 'FREE'; L('cleared MAROONED'); } } catch (e) {}

        // out, around, back-to-home — a small square patrol so it returns near the start.
        const wps = [[R, 0], [R, R], [0, R], [0, 0]];
        for (let i = 0; i < wps.length; i++) {
            if (isNight() || closeHostile() || bot.health < startHp - 4) {
                L(`ABORT at leg ${i + 1} (hp=${Math.round(bot.health)} night=${isNight()} hostile=${closeHostile()})`);
                break;
            }
            const tx = Math.round(home.x + wps[i][0]);
            const tz = Math.round(home.z + wps[i][1]);
            const ty = Math.round(bot.entity.position.y);
            const before = bot.entity.position.clone();
            L(`leg ${i + 1}/${wps.length} -> ${tx},~${ty},${tz}`);
            try { await skills.goToPosition(bot, tx, ty, tz, 2); }
            catch (e) { L(`leg ${i + 1} nav: ${e && e.message || e}`); }
            const d = bot.entity.position.distanceTo(before);
            L(`leg ${i + 1} moved ${d.toFixed(1)}b -> ${bot.entity.position.x.toFixed(0)},${bot.entity.position.y.toFixed(0)},${bot.entity.position.z.toFixed(0)}`);
        }

        const end = bot.entity.position;
        const r = { ok: true, backNearHome: end.distanceTo(home) < 6, totalDisp: +end.distanceTo(home).toFixed(1), startHp: Math.round(startHp), endHp: Math.round(bot.health), food: bot.food };
        L(`DONE ${JSON.stringify(r)}`);
        return r;
    } finally {
        restoreMission(L);
    }
}
