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
const OAK_APPLE_BACKOFF = path.resolve(process.cwd(), 'bots', '_supervisor', 'oak_apple_backoff.json');
const prog = (s) => { try { fs.appendFileSync(PROG, `[${new Date().toISOString()}] [mission] ${s}\n`); } catch (e) {} };
const readOakAppleBackoff = () => {
    try {
        const rec = JSON.parse(fs.readFileSync(OAK_APPLE_BACKOFF, 'utf8'));
        return rec && typeof rec.until === 'number' && rec.until > Date.now() ? rec : null;
    } catch (e) { return null; }
};

export default async function missionNether(bot, ctx) {
    const { skills, world, log } = ctx;
    const has = (n) => world.getInventoryCounts(bot)[n] || 0;
    const FOOD_RE = /cooked_|_bread|^bread$|^apple$|golden_apple|carrot|potato|^beef$|porkchop|^chicken$|^mutton$|^cod$|^salmon$|melon_slice|sweet_berries|_stew|^rabbit$|baked_/;
    const HOSTILE_RE = /zombie|skeleton|creeper|spider|witch|drowned|husk|stray|pillager|cave_spider/i;
    const edibleHeld = () => bot.inventory.items().some(i => FOOD_RE.test(i.name) && i.name !== 'rotten_flesh');
    const famineCritical = () => !edibleHeld() && (bot.food <= 1 || (bot.health <= 6 && bot.food <= 2));
    const noRegenNoFood = () => !edibleHeld() && bot.health < 14 && bot.food < 18;
    const bodyBudgetFamine = () => !edibleHeld() && bot.health <= 8 && bot.food <= 6;
    const noRegenBackoffRemain = () => {
        const lowHp = Math.max(0, (bot._prepLowHpNoFoodUntil || 0) - Date.now());
        const surface = Math.max(0, (bot._prepNoFoodSurfaceBackoffUntil || 0) - Date.now());
        return {
            lowHp: Math.ceil(lowHp / 1000),
            surface: Math.ceil(surface / 1000),
            any: Math.ceil(Math.max(lowHp, surface) / 1000),
        };
    };
    const boundedOakAppleReady = () => {
        try {
            if (!noRegenNoFood() || bot.health > 8) return null;
            if (Date.now() < (bot._prepOakApplePulseBackoffUntil || 0)) return null;
            const t = (bot.time && bot.time.timeOfDay) || 0;
            if ((t >= 11000 && t < 23000) || isNightNow()) return null;
            if (actionableHostilesNear(16) > 0) return null;
            if (bot.game && bot.game.dimension && !/overworld/.test(bot.game.dimension)) return null;
            const me = bot.entity.position;
            const dist = (p) => p && typeof p.distanceTo === 'function' ? p.distanceTo(me) : Infinity;
            const dy = (p) => p ? Math.abs(p.y - me.y) : Infinity;
            const blocks = world.getNearestBlocks(bot, ['oak_leaves', 'dark_oak_leaves', 'oak_log', 'dark_oak_log'], 14, 32) || [];
            const oak = blocks
                .filter(b => b && b.position && dist(b.position) <= 12 && dy(b.position) <= 6)
                .sort((a, b) => dist(a.position) - dist(b.position))[0];
            if (!oak) return null;
            const target = `${oak.name}@${Math.round(dist(oak.position))} dy=${Math.round(oak.position.y - me.y)}`;
            const persisted = readOakAppleBackoff();
            if (persisted && persisted.target === target) {
                try { bot._prepOakApplePulseBackoffUntil = Math.max(bot._prepOakApplePulseBackoffUntil || 0, persisted.until); } catch (e) {}
                return null;
            }
            return target;
        } catch (e) {
            return null;
        }
    };
    const hostilesNear = (r = 16) => {
        try {
            const me = bot.entity.position;
            return Object.values(bot.entities || {}).filter(e =>
                e && e.position && e.name && HOSTILE_RE.test(e.name) && e.position.distanceTo(me) < r).length;
        } catch (e) { return 0; }
    };
    const maxHeldPlankStack = () => {
        const c = world.getInventoryCounts(bot);
        return Math.max(0, ...Object.keys(c).filter(k => k.endsWith('_planks')).map(k => c[k] || 0));
    };
    const heldLogs = () => {
        const c = world.getInventoryCounts(bot);
        return Object.keys(c).filter(k => k.endsWith('_log')).reduce((s, k) => s + (c[k] || 0), 0);
    };
    const planksEqHeld = () => {
        const c = world.getInventoryCounts(bot);
        let n = 0;
        for (const [k, v] of Object.entries(c)) {
            if (k.endsWith('_planks')) n += v || 0;
            else if (k.endsWith('_log') || k.endsWith('_wood')) n += (v || 0) * 4;
        }
        return n;
    };
    const stationaryKitOpportunity = () => {
        try {
            const c = world.getInventoryCounts(bot);
            const fuel = (c.coal || 0) + (c.charcoal || 0) + planksEqHeld();
            const furnaceReady = (c.furnace || 0) > 0 || !!world.getNearestBlock(bot, 'furnace', 4) || (c.cobblestone || 0) >= 8;
            const tableReady = (c.crafting_table || 0) > 0 || !!world.getNearestBlock(bot, 'crafting_table', 4) || maxHeldPlankStack() >= 4;
            if ((c.iron_pickaxe || 0) < 1 && (c.raw_iron || 0) > 0 && fuel > 0 && furnaceReady) {
                return `raw_iron=${c.raw_iron} fuel=${fuel} furnaceReady=${furnaceReady}`;
            }
            if ((c.iron_pickaxe || 0) < 1 && (c.iron_ingot || 0) >= 3 && (c.stick || 0) >= 2 && tableReady) {
                return `iron_pickaxe craft iron=${c.iron_ingot} sticks=${c.stick} tableReady=${tableReady}`;
            }
            if ((c.shield || 0) < 1 && (c.iron_ingot || 0) >= 1 && planksEqHeld() >= 6 && tableReady) {
                return `shield craft iron=${c.iron_ingot} planksEq=${planksEqHeld()} tableReady=${tableReady}`;
            }
        } catch (e) {}
        return null;
    };
    const actionableHostilesNear = (r = 16) => {
        try {
            const me = bot.entity.position;
            const ranged = /skeleton|stray|pillager|witch/i;
            let n = 0;
            for (const e of Object.values(bot.entities || {})) {
                if (!e || !e.position || !e.name || !HOSTILE_RE.test(e.name)) continue;
                const d = e.position.distanceTo(me);
                if (d >= r) continue;
                const dy = Math.abs(e.position.y - me.y);
                if (d < 4.25 || (/creeper/i.test(e.name) && d < 5.5) || ranged.test(e.name) || dy < 5) n++;
            }
            return n;
        } catch (e) { return hostilesNear(r); }
    };
    const tableRecoveryUndergroundWorksite = () => {
        try {
            const p = bot.entity.position.floored();
            let openSurface = Math.floor(bot.entity.position.y) >= 55;
            if (openSurface) {
                for (let dy = 1; dy <= 8; dy++) {
                    const b = bot.blockAt(p.offset(0, dy, 0));
                    if (b && /water|lava/.test(b.name || '')) { openSurface = false; break; }
                    if (b && b.boundingBox === 'block') { openSurface = false; break; }
                }
            }
            return !openSurface && (bot.entity.position.y < 62 || (bot._mobility && (bot._mobility.enclosed || bot._mobility.state === 'POCKET')));
        } catch (e) {
            return bot.entity.position.y < 62;
        }
    };
    const readProgressTail = () => {
        try {
            const stat = fs.statSync(PROG);
            const len = Math.min(8192, stat.size);
            const fd = fs.openSync(PROG, 'r');
            try {
                const buf = Buffer.alloc(len);
                fs.readSync(fd, buf, 0, len, stat.size - len);
                return buf.toString('utf8');
            } finally {
                fs.closeSync(fd);
            }
        } catch (e) {
            return '';
        }
    };
    const freshProgressTail = (maxAgeMs = 90000) => {
        const now = Date.now();
        return readProgressTail()
            .split(/\r?\n/)
            .filter(line => {
                const m = /^\[(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)\]/.exec(line);
                if (!m) return false;
                const ts = Date.parse(m[1]);
                return Number.isFinite(ts) && now - ts <= maxAgeMs;
            })
            .join('\n');
    };
    const progressTailHasTableGate = () => /TABLE (gate|recovery) for /.test(freshProgressTail());
    const freshAdvisoryThreat = () => {
        try {
            const a = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'advisory.json'), 'utf8'));
            const ts = Number(a.ts || 0);
            if (!ts || Date.now() - ts > 45000) return null;
            const actionable = Number(a.actionableHostiles);
            if (!Number.isFinite(actionable)) return null;
            return {
                raw: Number(a.hostiles || 0),
                actionable,
                layered: Number(a.layeredHostiles || 0),
                nearest: Number(a.nearest || Infinity),
                source: 'advisory',
            };
        } catch (e) {
            return null;
        }
    };
    const tableRecoveryThreat = (r = 12) => {
        const local = { raw: hostilesNear(r), actionable: actionableHostilesNear(r), source: 'local' };
        const adv = freshAdvisoryThreat();
        if (adv) return { ...adv, localRaw: local.raw, localActionable: local.actionable };
        return local;
    };
    const tableRecoveryHold = () => {
        try {
            if (bot.health < 14 || bot.food < 14) return false;
            if (tableRecoveryThreat(12).actionable > 0) return false;
            if (has('crafting_table') > 0 || world.getNearestBlock(bot, 'crafting_table', 4)) return false;
            if (maxHeldPlankStack() >= 4 || heldLogs() > 0) return false;
            if (!tableRecoveryUndergroundWorksite()) return false;
            const recentPrepGate = Date.now() - (bot._lastPrepTableGateLogAt || 0) < 90000;
            const recentAchieveGate = Date.now() < (bot._prepTableRecoveryBlockedUntil || 0);
            return recentPrepGate || recentAchieveGate || progressTailHasTableGate();
        } catch (e) {
            return false;
        }
    };
    const lowFoodHoldEvidence = () => {
        try {
            if (edibleHeld() || bot.food > 10) return null;
            const tail = freshProgressTail();
            if (!/(HUNGER\/LOWHP gate|HUNGRY\/LOWHP .*night|hungry-night hold|no concrete food signal before cave climb|last surface\/feedUp found no food)/.test(tail)) return null;
            const adv = freshAdvisoryThreat();
            const actionable = adv ? adv.actionable : actionableHostilesNear(12);
            if (actionable > 0) return null;
            const p = bot.entity.position.floored();
            const coveredOrEnclosed = hasOverheadCover()
                || !!(bot._mobility && (bot._mobility.enclosed || /POCKET|ENTOMBED/.test(bot._mobility.state || '')));
            if (!coveredOrEnclosed && p.y < 62) return null;
            return {
                source: adv ? 'advisory' : 'local',
                actionable,
                coveredOrEnclosed,
                y: p.y,
            };
        } catch (e) {
            return null;
        }
    };
    const safeCloseFoodSignal = () => {
        try {
            const me = bot.entity.position;
            const hostile = /zombie|skeleton|creeper|spider|witch|drowned|husk|stray|pillager|cave_spider/i;
            const animal = /cow|pig|sheep|chicken|rabbit/i;
            const foodDrop = /rotten_flesh|beef|porkchop|chicken|mutton|rabbit|cod|salmon|bread|apple|carrot|potato|melon/i;
            const mobs = Object.values(bot.entities || {}).filter(e => e && e.position && e.name);
            if (actionableHostilesNear(14) > 0) return false;
            if (mobs.some(e => animal.test(e.name) && e.position.distanceTo(me) < 12 && Math.abs(e.position.y - me.y) <= 3)) return true;
            return mobs.some(e => {
                if (e.name !== 'item' || e.position.distanceTo(me) > 10 || Math.abs(e.position.y - me.y) > 3) return false;
                try {
                    const item = e.getDroppedItem && e.getDroppedItem();
                    return item && foodDrop.test(item.name || '');
                } catch (_) { return false; }
            });
        } catch (e) { return false; }
    };
    const feedUpDryNoFood = () => {
        try {
            const rec = bot._feedUpDryNoFood || {};
            const until = Math.max(bot._feedUpDryNoFoodUntil || 0, rec.until || 0);
            const left = until - Date.now();
            if (left <= 0 || edibleHeld() || safeCloseFoodSignal()) return null;
            const p = bot.entity.position;
            if (Number.isFinite(rec.x) && Number.isFinite(rec.y) && Number.isFinite(rec.z)) {
                const moved = Math.hypot(p.x - rec.x, p.z - rec.z);
                const dy = Math.abs(p.y - rec.y);
                if (moved > 18 || dy > 8) return null;
            }
            return {
                left,
                reason: rec.reason || 'dry-no-food',
                food: rec.food,
                hp: rec.hp,
                scan: rec.scan || 'scan=unknown',
            };
        } catch (e) {
            return null;
        }
    };
    const gateDryFeedUp = (label) => {
        const dry = feedUpDryNoFood();
        if (!dry) return false;
        if (!bot._lastFeedUpDryGateAt || Date.now() - bot._lastFeedUpDryGateAt > 30000) {
            bot._lastFeedUpDryGateAt = Date.now();
            prog(`${label} gated: feedUp dry no-food cooldown ${Math.ceil(dry.left / 1000)}s reason=${dry.reason} food=${bot.food} hp=${Math.round(bot.health)} prev=${dry.food}/${dry.hp}; ${dry.scan}`);
        }
        try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
        try { bot.clearControlStates(); } catch (_) {}
        return true;
    };
    const inNether = () => { try { return /nether/.test(bot.game.dimension); } catch (e) { return false; } };
    const wait = (ms) => skills.wait(bot, ms);
    const isNightNow = () => { try { const t = bot.time.timeOfDay; return t >= 13000 && t <= 23000; } catch (e) { return false; } };
    const hasOverheadCover = () => {
        try {
            const p = bot.entity.position.floored();
            for (let dy = 2; dy <= 6; dy++) {
                const b = bot.blockAt(p.offset(0, dy, 0));
                if (b && b.boundingBox === 'block') return true;
            }
        } catch (e) {}
        return false;
    };
    const sealedBodyBudgetHold = () => {
        try {
            if (!bodyBudgetFamine()) return false;
            const me = bot.entity.position;
            let closest = Infinity;
            let closestCreeper = Infinity;
            for (const e of Object.values(bot.entities || {})) {
                if (!(e && e.position && e.name && HOSTILE_RE.test(e.name))) continue;
                const d = e.position.distanceTo(me);
                if (d < closest) closest = d;
                if (/creeper/i.test(e.name) && d < closestCreeper) closestCreeper = d;
            }
            const pointBlank = closest < 4.25 || closestCreeper < 5.5;
            const coveredOrEnclosed = hasOverheadCover() || !!(bot._mobility && bot._mobility.enclosed)
                || !!(bot._mobility && /POCKET|MAROONED|ENTOMBED/.test(bot._mobility.state || ''));
            const feet = bot.blockAt(bot.entity.position) || { name: 'air' };
            const head = bot.blockAt(bot.entity.position.offset(0, 1, 0)) || { name: 'air' };
            const fluidOrFire = /water|lava|fire/.test(feet.name || '') || /water|lava|fire/.test(head.name || '');
            const falling = !bot.entity.onGround && bot.entity.velocity && bot.entity.velocity.y < -0.25;
            return coveredOrEnclosed && !pointBlank && !fluidOrFire && !falling;
        } catch (e) {
            return false;
        }
    };
    const safeDaylightFamineForage = () => {
        try {
            if (!famineCritical() || isNightNow()) return false;
            if (bot.game && bot.game.dimension && !/overworld/.test(bot.game.dimension)) return false;
            if (bot.entity.position.y < 55) return false;
            return actionableHostilesNear(16) === 0;
        } catch (e) { return false; }
    };
    const daylightFamineHostileShelter = () => {
        try {
            return (famineCritical() || (noRegenNoFood() && bot.health <= 10))
                && !isNightNow()
                && (!bot.game || !bot.game.dimension || /overworld/.test(bot.game.dimension))
                && bot.entity.position.y >= 55
                && !hasOverheadCover()
                && actionableHostilesNear(16) > 0;
        } catch (e) { return false; }
    };

    prog('==== missionNether START ====');
    let portalFails = 0, victoryLogged = false;
    for (let iter = 0; iter < 5000; iter++) {
        if (bot._supervisorCancelAt && Date.now() - bot._supervisorCancelAt < 30000) {
            prog('supervisor cancel received — returning to release run_skill lock');
            try { bot.interrupt_code = false; bot._supervisorCancelAt = 0; } catch (e) {}
            return { cancelled: true };
        }
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
        if (adv && adv.directive === 'evac' && sealedBodyBudgetHold()) {
            if (!bot._lastAdvisoryEvacSealGateAt || Date.now() - bot._lastAdvisoryEvacSealGateAt > 30000) {
                bot._lastAdvisoryEvacSealGateAt = Date.now();
                prog(`★ADVISORY evac gated: sealed body-budget hold hp=${Math.round(bot.health)} food=${bot.food} risk=${adv.risk}; no 40b sprint from covered/enclosed position`);
            }
            adv = null;
        }
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
            const killBoxSuppressed = bot._killBoxSuppressUntil && Date.now() < bot._killBoxSuppressUntil;
            if (d0 < z.r && !killBoxSuppressed) {
                if (isNightNow() && hasOverheadCover()) {
                    if (!bot._lastKillBoxNightHoldAt || Date.now() - bot._lastKillBoxNightHoldAt > 30000) {
                        bot._lastKillBoxNightHoldAt = Date.now();
                        prog(`★KILL-BOX: inside cluster but night+covered — hold bunker until dawn`);
                    }
                    await wait(3000);
                    continue;
                }
                const HOSZ = /zombie|skeleton|creeper|spider|witch|drowned|husk|stray|pillager|cave_spider/i;
                const inMelee = Object.values(bot.entities).some(e =>
                    e && e.position && e.name && HOSZ.test(e.name) && e.position.distanceTo(p0) < 6);
                if (!inMelee) {
                    const pocketLowFoodNoExit = bot.food <= 6
                        && !edibleHeld()
                        && !safeCloseFoodSignal()
                        && actionableHostilesNear(12) === 0
                        && (hasOverheadCover() || !!(bot._mobility && (bot._mobility.enclosed || /POCKET|ENTOMBED|MAROONED/.test(bot._mobility.state || ''))));
                    if (pocketLowFoodNoExit) {
                        const kit = stationaryKitOpportunity();
                        if (kit && (!bot._lastKillBoxStaticKitHandoffAt || Date.now() - bot._lastKillBoxStaticKitHandoffAt > 60000)) {
                            bot._lastKillBoxStaticKitHandoffAt = Date.now();
                            prog(`★KILL-BOX low-food stationary kit handoff: ${kit}; prepNether may smelt/craft locally but still no expel`);
                            try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
                            try { bot.clearControlStates(); } catch (_) {}
                            try { bot._prepStationaryKitOnlyUntil = Date.now() + 45000; } catch (_) {}
                            try { await skills.customSkill(bot, 'prepNether'); } catch (e) { prog(`prepNether stationary kit threw: ${e.message}`); }
                            await wait(1000);
                            continue;
                        }
                        if (!bot._lastKillBoxLowFoodPocketGateAt || Date.now() - bot._lastKillBoxLowFoodPocketGateAt > 30000) {
                            bot._lastKillBoxLowFoodPocketGateAt = Date.now();
                            prog(`★KILL-BOX gated: low-food pocket recovery food=${bot.food} hp=${Math.round(bot.health)} y=${Math.round(p0.y)}; no horizontal/vertical expel without food signal`);
                        }
                        try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
                        try { bot.clearControlStates(); } catch (_) {}
                        await wait(5000);
                        continue;
                    }
                    // UNDERGROUND/LOW-ROOF inside the cluster (death #270: stuck 28min at y32
                    // in the honeycomb core; 09:34 live: surfaceUp reached y64, then a
                    // horizontal expel immediately dropped it back to y58/y53). Do not treat
                    // "barely above sea level" as safe surface in this cave-riddled death
                    // cluster. Climb to a high, open column first; only then walk sideways.
                    // next iter expels radially from up there.
                    if (p0.y < 70 || hasOverheadCover()) {
                        const containedLowFood = bot.food <= 6
                            && !edibleHeld()
                            && !safeCloseFoodSignal()
                            && actionableHostilesNear(12) === 0
                            && (hasOverheadCover() || !!(bot._mobility && (bot._mobility.enclosed || /POCKET|ENTOMBED|MAROONED/.test(bot._mobility.state || ''))));
                        if (containedLowFood) {
                            if (!bot._lastKillBoxLowFoodPocketGateAt || Date.now() - bot._lastKillBoxLowFoodPocketGateAt > 30000) {
                                bot._lastKillBoxLowFoodPocketGateAt = Date.now();
                                prog(`★KILL-BOX gated: low-food contained recovery food=${bot.food} hp=${Math.round(bot.health)} y=${Math.round(p0.y)}; no surfaceUp/vertical expel without food signal`);
                            }
                            try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
                            try { bot.clearControlStates(); } catch (_) {}
                            await wait(5000);
                            continue;
                        }
                        const surfTarget = Math.max(70, Math.floor(p0.y) + 12);
                        prog(`★KILL-BOX: pocket/low-roof in cluster (y=${Math.round(p0.y)}) → surfaceUp target=${surfTarget} before horizontal expel`);
                        try { await skills.customSkill(bot, 'surfaceUp', surfTarget); } catch (e) {}
                        continue;
                    }
                    const ux = d0 > 0.5 ? (p0.x - z.cx) / d0 : 1, uz = d0 > 0.5 ? (p0.z - z.cz) / d0 : 0;
                    const tx = Math.round(z.cx + ux * (z.r + 16)), tz = Math.round(z.cz + uz * (z.r + 16));
                    if (bot._lastKillBoxExpelAt && Date.now() - bot._lastKillBoxExpelAt < 15000) {
                        await wait(1000);
                        continue;
                    }
                    bot._lastKillBoxExpelAt = Date.now();
                    prog(`★KILL-BOX: ${Math.round(d0)}b inside death cluster @${z.cx},${z.cz}(${z.n} deaths) → expelling to ${tx},${tz}`);
                    try {
                        await Promise.race([
                            skills.goToPosition(bot, tx, Math.round(p0.y), tz, 3),
                            new Promise((_, rej) => setTimeout(() => rej(new Error('killbox-expel-timeout')), 8000)),
                        ]);
                    } catch (e) { try { bot.pathfinder.stop(); } catch (_) {} }
                    if (bot.entity.position.distanceTo(p0) < 3) {
                        try {
                            await bot.lookAt(bot.entity.position.offset(ux * 8, 1.4, uz * 8), true);
                            bot.setControlState('forward', true);
                            bot.setControlState('sprint', true);
                            bot.setControlState('jump', true);
                            await wait(2200);
                        } catch (e) {}
                        try { bot.clearControlStates(); } catch (e) {}
                    }
                    const moved = bot.entity.position.distanceTo(p0);
                    if (moved < 3) {
                        bot._killBoxFailedExpels = (bot._killBoxFailedExpels || 0) + 1;
                        if (bot._killBoxFailedExpels >= 3 && p0.y >= 60 && !inMelee) {
                            bot._killBoxSuppressUntil = Date.now() + 120000;
                            prog(`★KILL-BOX: expel failed x${bot._killBoxFailedExpels} on safe surface — suppressing for 120s so task flow can rebuild gear`);
                        }
                    } else {
                        bot._killBoxFailedExpels = 0;
                    }
                    continue;
                }
            }
        }
        if (adv && adv.directive === 'eat_now') {
            // failure cooldown: when feedUp comes back empty (no animals/forage in
            // reach), re-firing every 3s is a spin loop (saw 4 fires in 10s in the
            // cliff alcove). One honest attempt per minute is plenty.
            const noCloseFood = !safeCloseFoodSignal();
            const advisoryDryNoRegen = noRegenNoFood() && noCloseFood;
            const advisoryDryFamine = famineCritical() && noCloseFood && !safeDaylightFamineForage();
            if (advisoryDryFamine || advisoryDryNoRegen) {
                if (!bot._lastFamineEatSkipAt || Date.now() - bot._lastFamineEatSkipAt > 30000) {
                    bot._lastFamineEatSkipAt = Date.now();
                    prog(`★ADVISORY eat_now gated: ${advisoryDryFamine ? 'famine-critical' : 'no-regen low-hp/no-food'} hp=${Math.round(bot.health)} food=${bot.food}; no close confirmed food signal`);
                }
            } else if (gateDryFeedUp('★ADVISORY eat_now')) {
                // Dry-site cooldown came from feedUp itself. Let mission/prep recover or
                // wait for a new close food signal instead of retrying the same target.
            } else if (!bot._lastFeedUpAt || Date.now() - bot._lastFeedUpAt > 60000) {
                bot._lastFeedUpAt = Date.now();
                prog(`★ADVISORY eat_now (food low, safe window) → feedUp`);
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
        if (isNightNow() && tableRecoveryHold()) {
            if (!bot._lastTableRecoveryNightStanddownAt || Date.now() - bot._lastTableRecoveryNightStanddownAt > 30000) {
                bot._lastTableRecoveryNightStanddownAt = Date.now();
                const threat = tableRecoveryThreat(12);
                prog(`table recovery night stand-down: actionable12=${threat.actionable} raw16=${hostilesNear(16)} threatSrc=${threat.source}; no EVAC/GoalInvert while prepNether owns wood/table recovery`);
            }
            try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
            try { bot.clearControlStates(); } catch (_) {}
            await wait(5000);
            continue;
        }

        try {
            const HOS = /zombie|skeleton|creeper|spider|witch|drowned|husk|stray|pillager|cave_spider/i;
            const scan = () => Object.values(bot.entities).filter(e =>
                e && e.position && e.name && HOS.test(e.name) && e.position.distanceTo(bot.entity.position) < 16);
            const swarm = scan();
            const armed = Object.keys(world.getInventoryCounts(bot)).some(n => /_sword$|_axe$/.test(n));
            const tableRecoveryEvacHold = tableRecoveryHold();
            // advisory 'evac' lowers the trigger from "3+ and unarmed" to "any hostile":
            // the overseer has wider context (trend, heat-map) than this local scan.
            // NIGHT + unarmed also floors at 1 (deaths #272/#273, two in two minutes:
            // a naked night respawn has 5 pipeline steps between revival and dug-in —
            // a single zombie closes that gap first. One mob at night = leave NOW).
            const isNightHere = (() => { try { const t = bot.time.timeOfDay; return t >= 13000 && t <= 23000; } catch (e) { return false; } })();
            const evacFloor = ((adv && adv.directive === 'evac') || isNightHere) ? 1 : 3;
            const sealedEvacHold = sealedBodyBudgetHold();
            if (tableRecoveryEvacHold && swarm.length >= evacFloor && !armed && (!bot._lastTableRecoveryEvacGateAt || Date.now() - bot._lastTableRecoveryEvacGateAt > 30000)) {
                bot._lastTableRecoveryEvacGateAt = Date.now();
                const threat = tableRecoveryThreat(16);
                prog(`EVAC gated: table recovery hold raw16=${swarm.length} actionable16=${threat.actionable} threatSrc=${threat.source}; layered/blocked threats do not break sealed wood/table recovery`);
            }
            if (sealedEvacHold && swarm.length >= evacFloor && !armed && (!bot._lastLocalEvacSealGateAt || Date.now() - bot._lastLocalEvacSealGateAt > 30000)) {
                bot._lastLocalEvacSealGateAt = Date.now();
                prog(`EVAC gated: sealed body-budget hold hp=${Math.round(bot.health)} food=${bot.food}, hostiles<16b=${swarm.length}; no bunker-breaking sprint`);
            }
            // cooldown: a failed EVAC re-firing every iter (~200ms) short-circuited the
            // WHOLE loop — including the BREAKOUT last-resort below it — for hours (the
            // axiom AGAIN: a failed high-priority branch must yield, not spin).
            if (!tableRecoveryEvacHold && !sealedEvacHold && swarm.length >= evacFloor && !armed && famineCritical()) {
                prog(`EVAC gated: famine-critical hp=${Math.round(bot.health)} food=${bot.food}, hostiles<16b=${swarm.length}; no 40b sprint → prepNether emergency recovery`);
                try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
                try { bot.clearControlStates(); } catch (_) {}
                try { await skills.customSkill(bot, 'prepNether'); } catch (e) { prog(`prepNether emergency recovery threw: ${e.message}`); }
                await wait(1000);
                continue;
            }
            if (!tableRecoveryEvacHold && !sealedEvacHold && swarm.length >= evacFloor && !armed && (!bot._lastEvacAt || Date.now() - bot._lastEvacAt > 45000)) {
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
                const noPick = !bot.inventory.items().some(it => /_pickaxe$/.test(it.name));
                const scaffold = ['gravel', 'dirt', 'sand', 'cobblestone', 'cobbled_deepslate']
                    .reduce((s, n) => s + (has(n) || 0), 0);
                const blockedRecent = bot._maroonedNoPickBlockedAt && Date.now() - bot._maroonedNoPickBlockedAt < 15000;
                if (noPick && scaffold > 0 && blockedRecent && (!bot._lastMaroonedRescueAt || Date.now() - bot._lastMaroonedRescueAt > 60000)) {
                    bot._lastMaroonedRescueAt = Date.now();
                    bot._climbingAt = Date.now();
                    const ty = Math.max(84, Math.floor(bot.entity.position.y) + 8);
                    prog(`[mission] MAROONED no-pick stone gate + scaffold=${scaffold} → surfaceUp rescue target=${ty}`);
                    try { await skills.customSkill(bot, 'surfaceUp', ty); } catch (e) { prog(`surfaceUp rescue threw: ${e.message}`); }
                    continue;
                }
                prog(`[mission] standing down: MAROONED — march owns the body`);
                await wait(5000);
                continue;
            }
        } catch (e) {}

        // ★LAST-RESORT BREAKOUT (the cliff-hole entrapment: stuck in a 6-block pocket
        // for HOURS — every polite escape (door-probe, stair-place, pillar) failed, the
        // material gate forbade bare-hand stone, and NOTHING was left running. Rule:
        // pinned within 10 blocks for several minutes = subtle options are exhausted —
        // tunnel toward the anchor, but keep the human material invariant: no-pick never
        // punches stone. Dirt/gravel/wood are fair game; stone requires a pick or a real
        // planner/scaffold route.
        try {
            const fp = bot.entity.position;
            const lowFoodHold = lowFoodHoldEvidence();
            if (lowFoodHold) {
                bot._stagPos = fp.clone();
                bot._stagAt = Date.now();
                bot._envDumped = false;
                if (!bot._lastBreakoutLowFoodHoldGateAt || Date.now() - bot._lastBreakoutLowFoodHoldGateAt > 30000) {
                    bot._lastBreakoutLowFoodHoldGateAt = Date.now();
                    prog(`★BREAKOUT gated: prepNether low-food hold evidence food=${bot.food} hp=${Math.round(bot.health)} y=${lowFoodHold.y} covered=${lowFoodHold.coveredOrEnclosed} actionable=${lowFoodHold.actionable} threatSrc=${lowFoodHold.source}; reset pinned timer, no blind shelter tunnel`);
                }
                try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
                try { bot.clearControlStates(); } catch (_) {}
                await wait(5000);
                continue;
            }
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
                if (tableRecoveryHold()) {
                    const threat = tableRecoveryThreat(12);
                    prog(`★BREAKOUT gated: table recovery hold hp=${Math.round(bot.health)} food=${bot.food} tableInv=${has('crafting_table')} tableNear=${world.getNearestBlock(bot, 'crafting_table', 4) ? 'yes' : 'no'} planksMax=${maxHeldPlankStack()} logs=${heldLogs()} actionable12=${threat.actionable} threatSrc=${threat.source}; prepNether owns wood/table recovery`);
                    try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
                    try { bot.clearControlStates(); } catch (_) {}
                    await wait(5000);
                    continue;
                }
                if (bodyBudgetFamine()) {
                    prog(`★BREAKOUT gated: body-budget famine hp=${Math.round(bot.health)} food=${bot.food} hostiles10=${hostilesNear(10)} actionable10=${actionableHostilesNear(10)}; no tunneling/sprint, preserve sealed body`);
                    try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
                    try { bot.clearControlStates(); } catch (_) {}
                    await wait(10000);
                    continue;
                }
                if (famineCritical()) {
                    prog(`★BREAKOUT gated: famine-critical hp=${Math.round(bot.health)} food=${bot.food}; no tunneling/sprint, preserve body for feedUp/shelter`);
                    try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
                    try { bot.clearControlStates(); } catch (_) {}
                    await wait(5000);
                    continue;
                }
                if (noRegenNoFood() && actionableHostilesNear(10) === 0) {
                    const remain = noRegenBackoffRemain();
                    prog(`★BREAKOUT gated: no-regen low-hp/no-food hp=${Math.round(bot.health)} food=${bot.food} cooldown=${remain.any}s surfaceBackoff=${remain.surface}s night=${isNightNow()}; no blind tunneling/sprint without threat`);
                    try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
                    try { bot.clearControlStates(); } catch (_) {}
                    await wait(5000);
                    continue;
                }
                let bx = 96, bz = -34;
                try { const bj = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'bed.json'), 'utf8')); if (typeof bj.x === 'number') { bx = bj.x; bz = bj.z; } } catch (e) {}
                let vx = bx - fp.x, vz = bz - fp.z;
                const L = Math.hypot(vx, vz) || 1; vx /= L; vz /= L;
                const sx = Math.abs(vx) > Math.abs(vz) ? Math.sign(vx) : 0;
                const sz = sx === 0 ? Math.sign(vz) || 1 : 0;
                const STONY = /stone|deepslate|andesite|diorite|granite|tuff|_ore$|obsidian|cobble/;
                const hasPick = () => bot.inventory.items().some(it => /_pickaxe$/.test(it.name));
                const canBreakoutDig = (b) => b
                    && b.boundingBox === 'block'
                    && !/water|lava|bedrock/.test(b.name)
                    && (hasPick() || !STONY.test(b.name));
                prog(`★BREAKOUT: pinned 4min — tunneling toward anchor dir=${sx},${sz}, material-gated`);
                let blocked = null;
                for (let st = 0; st < 10; st++) {
                    if (bot.interrupt_code || bot.health <= 0) break;
                    const m = bot.entity.position.floored();
                    for (const c of [m.offset(sx, 1, sz), m.offset(sx, 0, sz)]) {
                        const b = bot.blockAt(c);
                        if (b && b.boundingBox === 'block' && !/water|lava|bedrock/.test(b.name)) {
                            if (!canBreakoutDig(b)) { blocked = b; break; }
                            try { await bot.tool.equipForBlock(b); } catch (e) {}
                            try { await bot.dig(b); } catch (e) {}
                        }
                    }
                    if (blocked) {
                        prog(`★BREAKOUT gated: no-pick stone ${blocked.name} @${blocked.position.x},${blocked.position.y},${blocked.position.z}; yielding to scaffold/planner path`);
                        bot._breakoutBlockedAt = Date.now();
                        break;
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

        const noRegenRemain = noRegenBackoffRemain();
        if (noRegenNoFood() && noRegenRemain.any > 0) {
            const oakReady = boundedOakAppleReady();
            if (oakReady && noRegenRemain.surface > 0) {
                bot._prepNoFoodSurfaceBackoffUntil = 0;
                prog(`prepNether stand-down override: bounded oak/apple ready ${oakReady}; clear surface backoff and let prepNether retry`);
            } else {
            prog(`prepNether stand-down: low-hp/no-food cooldown ${noRegenRemain.any}s lowHp=${noRegenRemain.lowHp}s surface=${noRegenRemain.surface}s (hp=${Math.round(bot.health)} food=${bot.food}); body stays free for survival modes`);
            if (daylightFamineHostileShelter() && (!bot._lastFamineHostileShelterAt || Date.now() - bot._lastFamineHostileShelterAt > 30000)) {
                bot._lastFamineHostileShelterAt = Date.now();
                prog(`cooldown shelter handoff: no-regen/low-food exposed with hostiles16=${hostilesNear(16)} actionable16=${actionableHostilesNear(16)}; prepNether digs in instead of freezing`);
                try { await skills.customSkill(bot, 'prepNether'); } catch (e) { prog(`cooldown shelter prepNether threw: ${e.message}`); }
                await wait(1000);
                continue;
            }
            if (!isNightNow() && (!bot._lastFeedUpAt || Date.now() - bot._lastFeedUpAt > 45000)) {
                const foodSignal = safeCloseFoodSignal();
                const noRegenDryScan = noRegenNoFood() && !foodSignal;
                if ((famineCritical() && !foodSignal && !safeDaylightFamineForage()) || noRegenDryScan) {
                    if (!bot._lastFamineCooldownEatSkipAt || Date.now() - bot._lastFamineCooldownEatSkipAt > 30000) {
                        bot._lastFamineCooldownEatSkipAt = Date.now();
                        prog(`cooldown feedUp gated: ${famineCritical() ? 'famine-critical' : 'no-regen low-hp/no-food'} hp=${Math.round(bot.health)} food=${bot.food}; no close confirmed food signal`);
                    }
                } else if (gateDryFeedUp('cooldown feedUp')) {
                    // Same dry-site guard as the advisory path.
                } else {
                    bot._lastFeedUpAt = Date.now();
                    try { await skills.customSkill(bot, 'feedUp', 18); } catch (e) { prog(`cooldown feedUp threw: ${e.message}`); }
                }
            }
            await wait(12000);
            continue;
            }
        }

        prog(`not kitted (obsidian=${has('obsidian')} f&s=${has('flint_and_steel')}) → prepNether`);
        try { await skills.customSkill(bot, 'prepNether'); }
        catch (e) { prog(`prepNether threw: ${e.message}`); }
        try {
            const t = (bot.time && bot.time.timeOfDay) || 0;
            const night = t >= 13000 && t <= 23000;
            const edible = bot.inventory.items().some(i => /cooked_|_bread|^bread$|^apple$|golden_apple|carrot|potato|^beef$|porkchop|^chicken$|^mutton$|^cod$|^salmon$|melon_slice|sweet_berries|_stew|^rabbit$|baked_/.test(i.name));
            const bottomBodyBudgetFamine = bot.health <= 8 && bot.food <= 6 && !edible;
            if ((bot.food <= 2 && !edible) || bottomBodyBudgetFamine) {
                const hostilePressure = actionableHostilesNear(16) > 0;
                const holdMs = (night || hostilePressure) ? 30000 : 10000;
                prog(`FAMINE backoff: food=${bot.food}, hp=${Math.round(bot.health)}, edible=false, night=${night}, hostiles16=${hostilesNear(16)} actionable16=${actionableHostilesNear(16)} — ${holdMs / 1000}s body-budget hold`);
                await wait(holdMs);
                continue;
            }
        } catch (e) {}
        await wait(3000);
    }
    prog('missionNether: iter cap reached (5000) — returning; sticky re-arm will resume');
    return inNether();
}
