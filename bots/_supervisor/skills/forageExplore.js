// forageExplore — escape a FOOD DESERT by travelling to find land animals, then eat.
//
// The bot keeps respawning at a spawn whose loaded radius has only distant water salmon (no
// land animals / crops). So it can never sustain itself, degrades, dies, repeats. The only real
// fix is to WALK OUT to fresh terrain and load chunks until huntable land animals appear — but
// ONLY from a healthy window (this is suicidal at low hp). It hands the actual kill+eat to the
// proven `forage` skill once animals are in range.
//
// HARD GATE: daylight + hp>=GATE_HP + food>=GATE_FOOD. At low hp/food this returns immediately
// with a refusal (do NOT explore-and-die — that was the whole lesson). Bounded distance; aborts
// on a close actionable hostile or an hp drop.
//
// opts: { maxBlocks=160, legBlocks=16, gateHp=14, gateFood=10 }

// PURE readiness gate — offline-testable. Exploring is only safe when healthy in daylight.
function exploreReady(state) {
    const s = state || {};
    if (s.isNight) return { ok: false, reason: 'night — do not explore (mobs); shelter' };
    if (s.hp < (s.gateHp ?? 14)) return { ok: false, reason: `hp=${s.hp} < ${s.gateHp ?? 14} — too fragile to explore` };
    if (s.food < (s.gateFood ?? 10)) return { ok: false, reason: `food=${s.food} < ${s.gateFood ?? 10} — too low to travel far` };
    if (s.actionableClose) return { ok: false, reason: 'actionable hostile close — handle threat first' };
    return { ok: true, reason: `healthy daylight (hp=${s.hp} food=${s.food}) — explore for food` };
}

// PURE bearing — head away from the death-zone centroid (where the bot keeps dying), else +x.
function exploreBearing(pos, dzone) {
    if (dzone) {
        const dx = pos.x - dzone.cx, dz = pos.z - dzone.cz;
        const m = Math.hypot(dx, dz) || 1;
        return { x: dx / m, z: dz / m };
    }
    return { x: 1, z: 0 };
}

const LAND_HUNT = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom', 'goat'];

export default async function forageExplore(bot, ctx, opts = {}) {
    const { log, skills, mc } = ctx;
    const log_ = (m) => log(bot, `[forageExplore] ${m}`);
    const maxBlocks = opts.maxBlocks || 160, legBlocks = opts.legBlocks || 16;
    const gateHp = opts.gateHp ?? 14, gateFood = opts.gateFood ?? 10;

    const isNight = () => { try { const t = bot.time.timeOfDay; return t > 13000 && t < 23000; } catch { return false; } };
    const closeActionable = () => { try { return Object.values(bot.entities || {}).some(e => e && e !== bot.entity && e.position && mc.isHostile(e) && e.position.distanceTo(bot.entity.position) < 8); } catch { return false; } };
    const landAnimal = () => {
        const p = bot.entity.position; let best = null, bd = Infinity;
        for (const e of Object.values(bot.entities || {})) { if (e && e.position && LAND_HUNT.includes((e.name || '').toLowerCase())) { const d = e.position.distanceTo(p); if (d < bd) { bd = d; best = { e, d }; } } }
        return best;
    };

    const ready = exploreReady({ isNight: isNight(), hp: Math.round(bot.health), food: bot.food, actionableClose: closeActionable(), gateHp, gateFood });
    log_(`gate: ${ready.reason}`);
    if (!ready.ok) return { explored: false, reason: ready.reason };

    // Bearing away from death-zone (read advisory if present).
    let dzone = null; try { const fs = (await import('fs')).default; const path = (await import('path')).default; dzone = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'bots/_supervisor/advisory.json'), 'utf8')).dzone; } catch {}
    const start = bot.entity.position.clone();
    const b = exploreBearing({ x: Math.round(start.x), z: Math.round(start.z) }, dzone);
    log_(`bearing ${b.x.toFixed(2)},${b.z.toFixed(2)} maxBlocks=${maxBlocks}`);

    const legs = Math.ceil(maxBlocks / legBlocks);
    for (let i = 1; i <= legs; i++) {
        // Re-check safety each leg — abort to survival if night falls / threat / hp drop.
        if (isNight()) { log_(`abort: night fell at leg ${i}`); return { explored: true, found: false, reason: 'night fell — return to shelter' }; }
        if (closeActionable()) { log_(`abort: actionable hostile at leg ${i}`); return { explored: true, found: false, reason: 'hostile close' }; }
        if (bot.health <= 6) { log_(`abort: hp=${Math.round(bot.health)} dropped at leg ${i}`); return { explored: true, found: false, reason: 'hp dropped' }; }

        // Found land food in range? Hand off to the proven forage skill to hunt+eat.
        const a = landAnimal();
        if (a && a.d <= 40) {
            log_(`land animal ${a.e.name} at d=${a.d.toFixed(1)} (leg ${i}) — handoff to forage`);
            const r = await skills.customSkill(bot, 'forage', { targetFood: 16 });
            return { explored: true, found: true, forageResult: r, endY: Math.round(bot.entity.position.y) };
        }

        const tx = Math.round(start.x + b.x * legBlocks * i), tz = Math.round(start.z + b.z * legBlocks * i);
        log_(`leg ${i}/${legs} -> ${tx},~,${tz} (hp=${Math.round(bot.health)} food=${bot.food})`);
        try { await skills.goToPosition(bot, tx, Math.round(bot.entity.position.y), tz, 2); } catch (e) { log_(`leg ${i} nav: ${e && e.message || e}`); }

        const moved = Math.hypot(bot.entity.position.x - start.x, bot.entity.position.z - start.z);
        if (i >= 2 && moved < legBlocks * (i - 1) * 0.5) { log_(`stalled at leg ${i} (moved ${moved.toFixed(0)}b) — terrain blocked, stop`); break; }
    }

    const end = bot.entity.position;
    const r = { explored: true, found: false, movedBlocks: Math.round(Math.hypot(end.x - start.x, end.z - start.z)), hp: Math.round(bot.health), food: bot.food, reason: 'no land animals found within range' };
    log_(`DONE ${JSON.stringify(r)}`);
    return r;
}

export { exploreReady, exploreBearing };
