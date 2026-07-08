// ============================================================================
// [DEPRECATED — framework-v2 retirement anchor]
//
// This top-level mission is SUPERSEDED by the framework-v2 decision stack:
//   - modes.js  : computeNightPlan / computeOpening derive the intent
//                 (FIGHT / MINE_THROUGH_NIGHT / GO_BED / DIG_ONE_CAP / SEAL_FORT;
//                  SCOUT / WOOD_BUFFER / VILLAGE_HARVEST / DONE) every ~2s,
//                 LLM-silent and purely deterministic.
//   - world_model.js proposeTasks : translates that intent into prioritized
//                 task proposals and commitGoal() writes bot._commitment
//                 {kind, skill, args, since}.
//   - kernelDriver.js : the single top-level sticky dispatch source — owns the
//                 ws_server _skillRunning lock and fans out the committed
//                 skill+args via customSkill.
//
// missionNether is RETIRED, NOT deleted: it is kept verbatim as a ROLLBACK
// ANCHOR until kernelDriver is proven live. DO NOT blind-delete it.
//
// The active sticky is selected in sticky_skill.json — NOT in this file. Editing
// this banner does not re-arm the mission; flipping sticky_skill.json (+ restart /
// watchdog) does.
//
// NOTE: the old "GO_UNDERGROUND" mission step now maps to the mineDown skill
// under the framework-v2 stack (DUSK_MINE_NIGHT / GO_UNDERGROUND -> mineDown),
// not to this mission's internal underground logic.
//
// Everything below this banner is unchanged, executable rollback code.
// ============================================================================
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
    // ★2026-07-09 用户令 HP/食物本能熔断: 两个外部熔断开关(默认 OFF, 仅 '1' 恢复原行为)。
    // 这些 supervisor 模块直接读 process.env(不 import contracts.js)。
    const _foodOn = () => process.env.MC_FOOD_INSTINCTS === '1';
    const _hpOn   = () => process.env.MC_HP_INSTINCTS   === '1';
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
            if ((_hpOn() || _foodOn()) && (bot.health < 14 || bot.food < 14)) return false;   // ★2026-07-09 用户令 HP/食物本能熔断: table-recovery hold 的血/饱和门(mixed); 任一/双闸开恢复。
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
            if (!_foodOn()) return null;   // ★2026-07-09 用户令 食物本能熔断: 低食物 hold 证据(纯食物); 食物闸开恢复。
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
    // ★2026-07-05 预审 P1: :863 引用 isDuskNow 但从未定义 — ReferenceError 被外层空 catch 吞掉,
    // C273 BOOTSTRAP COMMIT 与 lowFoodHold 后半段全部静默失效。黄昏=12000-13000 tick。
    const isDuskNow = () => { try { const t = bot.time.timeOfDay; return t >= 12000 && t < 13000; } catch (e) { return false; } };
    const hasOverheadCover = () => {
        try {
            const p = bot.entity.position.floored();
            for (let dy = 2; dy <= 6; dy++) {
                const b = bot.blockAt(p.offset(0, dy, 0));
                // ★C281: leaves/vines are NOT a ceiling. A tree canopy at the open surface counts
                // as "enclosed" → a FREE bot under a tree read as sealed-underground → fired C237
                // NO-PICK surfaceUp (climbing AWAY from the wood it needed) while prepNether's
                // hunger gate held → the two gates oscillated = 发呆 (用户截图:藤蔓/树冠下斜坡).
                // Leaves are also not real night shelter (mobs spawn/reach under trees), so
                // excluding them is correct everywhere hasOverheadCover gates "I'm covered".
                if (b && b.boundingBox === 'block' && !/_leaves$|^leaves$|vine/.test(b.name || '')) return true;
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

        // ★C226-A fresh-respawn triage (③) — the spawn point sits inside a death gauntlet
        // (live forensics 06-17: fall @0,-12 / drowning @20,-27 / night-skeleton bunkers
        // @9,34 — deaths 369→377 in ~1h, most within 30b of spawn). A NAKED respawn that
        // bootstraps in place dies to a local hazard within minutes, then respawns and
        // repeats. A human who wakes somewhere lethal LEAVES while still at full health.
        // Detect the just-respawned state (full hp + ~empty inventory + at spawn + daytime
        // + no swarm) and spend the full-hp window on a modest migrate AWAY (migrate's
        // bearing auto-points away from the death cluster). Fires ~once per respawn (see the
        // C242 arming fix below — keyed on the respawn signature + a 5-min throttle, NOT on a
        // prior >48b escape, which used to deadlock the bots stuck closest to spawn).
        // SCOPE: this moves the bot off the bad spawn; it does NOT yet stop falls during
        // the migrate itself — that is C226-C (pathfinder/sprint ledge-abort, ① restart),
        // still pending. Gate defers to EVAC when a swarm is present (hostiles>0 → skip).
        try {
            if (bot.spawnPoint && (!bot.game || !bot.game.dimension || /overworld/.test(bot.game.dimension))) {
                const _p = bot.entity.position;
                const _sd = Math.hypot(_p.x - bot.spawnPoint.x, _p.z - bot.spawnPoint.z);
                const _invTotal = Object.values(world.getInventoryCounts(bot) || {}).reduce((a, b) => a + b, 0);
                // ★C242 FIX (catch-22 in C226-A arming): the old gate `if (_sd>48) _c226Armed=true`
                // armed the triage ONLY after the bot had escaped >48b — but a bot stuck/dying
                // WITHIN 48b of spawn (the exact spawn death-gauntlet this triage exists to break)
                // never armed, so the triage NEVER fired for the bots it most needed to save.
                // VERIFIED live 06-17: bot pinned/dying 11h within 29b of spawn, deaths climbed,
                // C226-A fired 0 times. Fix: fire on the RESPAWN SIGNATURE itself (full hp + naked +
                // at spawn + day + no swarm); missionNether re-arms on each respawn so this yields
                // ~one triage per respawn, and a 5-min fire-throttle prevents a tight loop if migrate
                // returns without relocating. (No escape-distance precondition — that was the bug.)
                // ★C243 (live 06-18: C242 v1 fired 0× on the 16:06 respawn — gated by host=1).
                // A DEATH-GAUNTLET spawn reliably has a mob within 12b at respawn (that's WHY it's a
                // gauntlet), so the old `actionableHostilesNear(12)===0` gate deferred to EVAC every
                // time; EVAC then sprinted the bot >16b away, closing the `_sd<16` window before the
                // mob cleared → triage never fired at exactly the spawn it must evacuate. But this
                // triage runs BEFORE EVAC in the loop and migrate's bearing points AWAY from the death
                // cluster — i.e. starting the migrate IS the evacuation (200b > EVAC's 40b). At fresh-
                // respawn hp (>=18) walking away from a non-point-blank mob is safe (migrate self-aborts
                // at hp6 + bunkers at night). So only defer to EVAC for a POINT-BLANK mob (<5b); a mob
                // in the 5–12b ring no longer blocks the off-spawn migrate.
                // ★C245 (live 06-18: night-respawn timing gap): `_sd<16` was too tight. When the bot
                // dies at NIGHT it respawns at spawn but the triage is night-gated; by dawn it has
                // wandered out (chopWood walks toward distant trees) to ~25-35b → the <16 window already
                // closed → triage misses, bot re-grinds the barren spawn (observed: death 380 night-respawn
                // → dawn @-33,0 chopping, C242 never fired). Widen to 48b so the first-daytime triage still
                // catches a night-respawn drift. Safe: still gated by naked(inv<=8)+full-hp+day+no-pointblank
                // +5min-throttle — fires only when the bot has made NO local progress near the bad spawn,
                // which is exactly when migrating off it is right. (48 == the old arming radius.)
                if (_sd < 48 && (!_hpOn() || bot.health >= 18) && _invTotal <= 8   // ★2026-07-09 用户令 HP 本能熔断: 满血 respawn 触发门(纯 HP 前置); HP 闸开恢复。
                    && !isNightNow() && actionableHostilesNear(5) === 0
                    && (!bot._lastC226FireAt || Date.now() - bot._lastC226FireAt > 5 * 60 * 1000)) {
                    bot._lastC226FireAt = Date.now();
                    prog(`★C226-A fresh-respawn triage: hp=${Math.round(bot.health)} naked(inv=${_invTotal}) @spawn d=${_sd.toFixed(0)} day — migrate off spawn death-gauntlet`);
                    try { await skills.customSkill(bot, 'migrate', { force: true, gateFood: 0, gateHp: 8, abortHp: 6, maxBlocks: 200, settleScore: 8 }); }
                    catch (e) { prog(`C226-A migrate threw: ${e.message}`); }
                    continue;
                }
            }
        } catch (e) {}

        // ★C293 DEATH-ZONE escape — fire on death-zone MEMBERSHIP, not nakedness. C226-A above only
        // migrates a "naked" respawn (inv<=8); a bot hoarding 272 red_sand + terracotta with NO
        // pickaxe/bed reads inv>8, so it was SKIPPED and re-died at the death-zone spawn every night
        // (live 2026-06-20: deaths 53→56, world model said inDeathZone=true/recommend=true/rec=MIGRATE
        // but C226-A never fired because inv>8). A junk hoard ≠ progress. Migrate OUT of a CONFIRMED
        // death zone whenever pickless (can't bootstrap here), solid-daytime, and safe — bigger
        // maxBlocks (400) + 4-min re-fire so she actually CLEARS the gauntlet to a livable biome.
        // Not a reroll — relocate within the SAME world (user: fix the卡点 in the current world, 别恋战).
        try {
            const _mig = bot._world && bot._world.migration;
            const _noPick293 = !bot.inventory.items().some(it => /_pickaxe$/.test(it.name));
            const _todNow = (bot.time && typeof bot.time.timeOfDay === 'number') ? bot.time.timeOfDay : 6000;
            if (_mig && _mig.inDeathZone && _mig.recommend && _noPick293 && (!_hpOn() || bot.health >= 14)   // ★2026-07-09 用户令 HP 本能熔断: 死亡区逃离血量储备门(纯 HP 前置); HP 闸开恢复。
                && !isNightNow() && _todNow < 11000 && actionableHostilesNear(6) === 0
                && (!bot._lastC293FireAt || Date.now() - bot._lastC293FireAt > 4 * 60 * 1000)) {
                bot._lastC293FireAt = Date.now();
                prog(`★C293 death-zone escape: inDeathZone + pickless (junk hoard ≠ progress) hp=${Math.round(bot.health)} tod=${_todNow} → strong migrate OUT maxBlocks=400 to livable biome`);
                try { await skills.customSkill(bot, 'migrate', { force: true, gateFood: 0, gateHp: 8, abortHp: 6, maxBlocks: 400, settleScore: 6 }); }
                catch (e) { prog(`C293 migrate threw: ${e.message}`); }
                continue;
            }
        } catch (e) {}

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
                    const pocketLowFoodNoExit = _foodOn() && bot.food <= 6   // ★2026-07-09 用户令 食物本能熔断: KILL-BOX 低食物抑制驱逐(纯食物); 食物闸开恢复。
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
                        const containedLowFood = _foodOn() && bot.food <= 6   // ★2026-07-09 用户令 食物本能熔断: KILL-BOX 低食物抑制上浮驱逐(纯食物); 食物闸开恢复。
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
                        // ★C310-A (claude-A, T-0044): surfaceUp post-C281 REFUSES to pillar into OPEN
                        // SKY (returns "already at open surface" the instant openAbove — by design, to
                        // prevent the y86-spire→walk-off→fall death, the SAME #106 mechanism). So when
                        // she's at open sky but y<70 (live 19:40: y67 open desert in a death cluster,
                        // host=0 daytime), the old `surfaceUp; continue` looped FOREVER — surfaceUp can't
                        // raise her, p0.y<70 stays true, 12min+ pinned. Only run the surfaceUp pre-step
                        // when she's actually UNDER COVER (a real cave/pocket surfaceUp CAN break out of,
                        // preserving the #270 climb-high-before-expel intent). If she already has open
                        // sky, skip it and expel horizontally from here — she's surfaced, not in the
                        // honeycomb, so a horizontal expel is safe (no cave-drop).
                        if (hasOverheadCover()) {
                            const surfTarget = Math.max(70, Math.floor(p0.y) + 12);
                            prog(`★KILL-BOX: covered pocket in cluster (y=${Math.round(p0.y)}) → surfaceUp target=${surfTarget} before horizontal expel`);
                            try { await skills.customSkill(bot, 'surfaceUp', surfTarget); } catch (e) {}
                            continue;
                        }
                        prog(`★KILL-BOX: open-sky at y=${Math.round(p0.y)}<70 — surfaceUp can't pillar open air (C281 anti-spire-fall), expelling horizontally from here`);
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
                        // ★C226-C(c1): this is the ONE manual sprint that bypasses pathfinder's
                        // maxDropDown fall-safety (KILL-BOX expel fallback when goToPosition was
                        // terrain-locked). Blind sprint+jump toward a heading can launch the bot
                        // off a cliff (C226 mechanism ③: falls happen on manual-sprint paths).
                        // Reuse fleeMove's droppy() ledge-probe: >4b of air under the landing
                        // cell ahead = ledge → DON'T sprint into it (hold instead; the next iter
                        // re-plans via pathfinder, which won't path off the drop).
                        let _ledgeAhead = true;
                        for (let _dd = 1; _dd <= 4; _dd++) {
                            const _b = bot.blockAt(p0.offset(ux * 1.6, -_dd, uz * 1.6));
                            if (_b && (_b.boundingBox === 'block' || /water/.test(_b.name || ''))) { _ledgeAhead = false; break; }
                        }
                        if (_ledgeAhead) {
                            prog(`★C226-C(c1): KILL-BOX manual sprint aborted — >4b drop ahead (heading ${ux.toFixed(1)},${uz.toFixed(1)}); no blind sprint off ledge`);
                        } else {
                            try {
                                await bot.lookAt(bot.entity.position.offset(ux * 8, 1.4, uz * 8), true);
                                bot.setControlState('forward', true);
                                bot.setControlState('sprint', true);
                                bot.setControlState('jump', true);
                                await wait(2200);
                            } catch (e) {}
                            try { bot.clearControlStates(); } catch (e) {}
                        }
                    }
                    const moved = bot.entity.position.distanceTo(p0);
                    if (moved < 3) {
                        bot._killBoxFailedExpels = (bot._killBoxFailedExpels || 0) + 1;
                        // ★C312-A (claude-A, T-0044): the expel-fail SUPPRESS gated on p0.y>=60, but the
                        // open-sky anchor where the expel deadlocks (goToPosition path-locked + manual-
                        // sprint ledge-aborted, C310-A's open-sky branch) sits at y58 — just under 60 →
                        // suppress NEVER fired → infinite expel loop (live: stuck 30min @14,58,-28, the
                        // anchor death-cluster). Open sky IS surfaced regardless of exact y; suppress when
                        // she has open sky OR is high, so a near-sea-level surface cluster can't trap her.
                        if (bot._killBoxFailedExpels >= 3 && (p0.y >= 60 || !hasOverheadCover()) && !inMelee) {
                            bot._killBoxSuppressUntil = Date.now() + 120000;
                            prog(`★KILL-BOX: expel failed x${bot._killBoxFailedExpels} on safe surface (y=${Math.round(p0.y)} openSky=${!hasOverheadCover()}) — suppressing for 120s so task flow can rebuild gear`);
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
                // ★C292: count BADLANDS/desert fillers too (terracotta/sandstone/red_sand) — C280/C288
                // added these everywhere else but this rescue trigger still only counted gravel/dirt/
                // sand/cobble, so a mesa-dug bot holding 272 red_sand + 69 terracotta read "scaffold=0".
                const scaffold = bot.inventory.items().reduce((s, it) =>
                    s + (/^(gravel|dirt|sand|red_sand|cobblestone|cobbled_deepslate|stone|[a-z_]*terracotta|sandstone|red_sandstone)$/.test(it.name || '') ? it.count : 0), 0);
                const blockedRecent = bot._maroonedNoPickBlockedAt && Date.now() - bot._maroonedNoPickBlockedAt < 15000;
                const rescueReady = !bot._lastMaroonedRescueAt || Date.now() - bot._lastMaroonedRescueAt > 30000;
                // ★C292 PERSISTENT-STANDDOWN break-out: the old rescue required blockedRecent — a flag
                // that goes STALE while the bot just "stands down" without trying to move — so a
                // MAROONED+enclosed bot whose surfaceGate ALREADY says "surface for wood" (C289) logged
                // "standing down — march owns the body" FOREVER (live 2026-06-20: the original 277×打转
                // bug, recurring post-bootstrap at y55 with 272 red_sand unused). When the world model
                // RECOMMENDS surfacing (gate.allowSurface) OR we're pickless, with filler on hand, TOWER
                // OUT (surfaceUp now uses C288's badlands-aware pillar). Gated only by a 30s rate-limit
                // (rescueReady) — robust to mobility flicker (an earlier 20s-stand-down timer kept getting
                // reset by MAROONED↔FREE flicker and never fired). The perpetual stand-down IS the block.
                let gateWantsSurface = false;
                try { gateWantsSurface = !!(bot._world && bot._world.surfaceGate && bot._world.surfaceGate.allowSurface); } catch (e) {}
                if (scaffold > 0 && rescueReady && (blockedRecent || gateWantsSurface || noPick)) {
                    bot._lastMaroonedRescueAt = Date.now();
                    bot._climbingAt = Date.now();
                    const ty = Math.max(72, Math.floor(bot.entity.position.y) + 10);
                    prog(`[mission] ★C292 MAROONED break-out (scaffold=${scaffold} gateSurface=${gateWantsSurface} noPick=${noPick} y=${Math.floor(bot.entity.position.y)}) → surfaceUp target=${ty}`);
                    try { await skills.customSkill(bot, 'surfaceUp', ty); } catch (e) { prog(`C292 break-out threw: ${e.message}`); }
                    continue;
                }
                prog(`[mission] standing down: MAROONED — march owns the body`);
                await wait(5000);
                continue;
            } else if (bot._maroonedStandDownSince) { bot._maroonedStandDownSince = 0; }
        } catch (e) {}

        // ★MIGRATE — EARLY placement (C220 fix): on a healthy day, BEFORE the local grind
        // (BREAKOUT/lowFoodHold/forageExplore short-legs/prepNether bankRecover) can preempt,
        // ask the human question — is this whole spawn unlivable (desert / clustered deaths)?
        // If so, a long-haul biome-smart cross-continent relocation beats wandering the same
        // barren region. migrate self-gates (shouldMigrate: desert OR diedHere + healthy + off
        // cooldown); declines instantly otherwise → falls through to normal flow. EARLY here
        // because the catch-all and lowFoodHold spots were preempted by prepNether's
        // bankRecover/holds before the loop could re-reach them (observed: fresh respawn went
        // straight into prepNether→forageExplore wandering into barren mountains, never migrating).
        try {
            // ★2026-07-05 预审 P0 配套: migrate 是主世界语义(biome 搬迁), 下界不派。
            if (!inNether() && !isNightNow() && actionableHostilesNear(8) === 0 && (!_hpOn() || Math.round(bot.health) >= 14) && (!_foodOn() || bot.food >= 6)   // ★2026-07-09 用户令 HP/食物本能熔断: early migrate 血/饱和储备门(纯前置; 保留 actionableHostilesNear 安全门); 任一/双闸开恢复。
                && (!bot._lastMigrateTryAt || Date.now() - bot._lastMigrateTryAt > 120000)) {
                bot._lastMigrateTryAt = Date.now();
                let mr = null;
                try { mr = await skills.customSkill(bot, 'migrate', {}); } catch (e) { prog(`migrate threw: ${e.message}`); }
                if (mr && mr.migrated) {
                    prog(`★MIGRATE ran (early): settled=${mr.settled} bedOk=${mr.bedOk} moved=${mr.movedBlocks}b end=${mr.end ? mr.end.x + ',' + mr.end.z : '?'} reason=${mr.reason} — re-assess from new home`);
                    continue;
                }
            }
        } catch (e) {}

        // ★LAST-RESORT BREAKOUT (the cliff-hole entrapment: stuck in a 6-block pocket
        // for HOURS — every polite escape (door-probe, stair-place, pillar) failed, the
        // material gate forbade bare-hand stone, and NOTHING was left running. Rule:
        // pinned within 10 blocks for several minutes = subtle options are exhausted —
        // tunnel toward the anchor, but keep the human material invariant: no-pick never
        // punches stone. Dirt/gravel/wood are fair game; stone requires a pick or a real
        // planner/scaffold route.
        // ★2026-07-05 预审 P0: 停滞计时/BREAKOUT 的锚点是主世界床坐标(无维度标签, 无 1:8 换算) —
        // 下界内每 4-5 分钟触发就朝错误方向凿 10 格, 离 portal 越来越远, 把胜利态定期拆掉。
        // 下界 = 清停滞计时并整块跳过 (胜利态处理在 :1049 的 inNether 分支)。
        if (inNether()) {
            bot._stagPos = null; bot._stagAt = 0;
        } else try {
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
                // ★C273 BOOTSTRAP COMMIT (decision-speed / committed-plan, 用户#1 最大问题=决策太慢):
                // 一个无工具的 bot 每个低食物周期就 forageExplore 漫游走 → 永远做不完早期 kit。新世界实证:
                // 它手握 oak_planks+stick、臂展内有 oak,却一次次丢下去追逃跑的鸡,churn 到死(deaths 1-8)。
                // 微观能力都修通了(C269找树/C270够树/C271砍木/C272过食物gate造具),缺的是 commit:不把
                // table→镐→剑这串在原地做完。所以 bootstrap(无任何镐)+非硬饿(food>3)+白天+无actionable威胁
                // 时,**压住 forage/migrate/roam,交回 prepNether 把早期 kit 做完**(C271 砍近木+C272 造具)。
                // 有了剑才能有效猎食→食物回升。食物真危急(≤3)再 forage。这是"先把手头的事做完"的承诺。
                const _bootstrapNoPick = !bot.inventory.items().some(i => /_pickaxe$/.test(i.name || ''));
                // ★C309 (T-0042) escape hatch: only COMMIT to local bootstrap if there's actually
                // wood to bootstrap WITH (logs/planks in inv OR reachable logs nearby). In a
                // treeless area, suppressing migrate locks a pickless bot in a dead-end FOREVER
                // (live 18:38: hp20/food20/picks0, chopDBG nearest=NONE, thrashing in a water pit).
                // The early healthy-day migrate (L759) handles food-full bots; this guards the
                // low-food 4–10 path that reaches C273. When woodless, DON'T suppress — fall through
                // so the lowFoodHold migrate/forageExplore below can relocate to a tree biome.
                let _bootstrapWoodless = false;
                if (_bootstrapNoPick) {
                    const _noWoodInv = !bot.inventory.items().some(i => /_log$|_planks$/.test(i.name || ''));
                    let _logsNear = 0;
                    try {
                        const _ids = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log']
                            .map(n => bot.registry && bot.registry.blocksByName[n] ? bot.registry.blocksByName[n].id : null).filter(x => x != null);
                        if (_ids.length) _logsNear = (bot.findBlocks({ matching: _ids, maxDistance: 48, count: 1 }) || []).length;
                    } catch (e) {}
                    _bootstrapWoodless = _noWoodInv && _logsNear === 0;
                }
                if (_bootstrapNoPick && !_bootstrapWoodless && bot.food > 3 && !lowFoodHold.actionable && !isNightNow() && !isDuskNow()) {
                    if (!bot._lastBootstrapCommitLogAt || Date.now() - bot._lastBootstrapCommitLogAt > 30000) {
                        bot._lastBootstrapCommitLogAt = Date.now();
                        prog(`★C273 BOOTSTRAP COMMIT: no pickaxe, food=${bot.food}>3, daytime safe, wood reachable — suppress forage/roam, finish early kit in place (prepNether: chop→table→pick→sword)`);
                    }
                    try { await skills.wait(bot, 800); } catch (e) {}   // small yield, avoid tight re-loop
                    continue;
                }
                if (_bootstrapWoodless && (!bot._lastWoodlessReleaseLogAt || Date.now() - bot._lastWoodlessReleaseLogAt > 30000)) {
                    bot._lastWoodlessReleaseLogAt = Date.now();
                    prog(`★C309 BOOTSTRAP COMMIT released: pickless but WOODLESS (no log/plank inv + no reachable log ≤48b) — cannot bootstrap here, fall through to migrate/forage (relocate to tree biome)`);
                }
                // ★ANTI-IDLE (food-desert livelock fix): a low-food hold in a food desert is an
                // ABSORBING state — sitting still guarantees no food, while the only real fix is to
                // TRAVEL until a food source / fresh biome appears. So when it's daytime, no close
                // actionable threat, and we're not critically fragile, ACTIVELY forageExplore
                // (travel to find land animals; it self-gates on night/hostile/hp-drop and is
                // bounded) instead of idle-holding. Repeated legs across cycles = crude 搬家 out of
                // the desert. Throttled 60s so it doesn't tight-loop. Night/threat/low-hp still hold.
                if (!isNightNow() && !lowFoodHold.actionable && Math.round(bot.health) >= 10
                    && (!bot._lastHoldForageAt || Date.now() - bot._lastHoldForageAt > 60000)) {
                    bot._lastHoldForageAt = Date.now();
                    // ★MIGRATE preempt (C220): in a CONFIRMED unlivable desert, a long-haul
                    // cross-continent relocation beats another 180-block forageExplore leg that
                    // just circles the same barren spot. This is the spot the low-food bot actually
                    // reaches (L896 was preempted by this branch). migrate self-gates (shouldMigrate:
                    // desert via ocean-biome/streak/clustered-food-deaths + hp≥14 + off cooldown);
                    // if it declines it returns instantly and we fall through to the forageExplore
                    // short leg. food-gate is relaxed (6) — a human hungry in a desert leaves NOW.
                    if (Math.round(bot.health) >= 14
                        && (!bot._lastMigrateTryAt || Date.now() - bot._lastMigrateTryAt > 120000)) {
                        bot._lastMigrateTryAt = Date.now();
                        let mr = null;
                        try { mr = await skills.customSkill(bot, 'migrate', {}); } catch (e) { prog(`migrate threw: ${e.message}`); }
                        if (mr && mr.migrated) { prog(`★MIGRATE ran (low-food hold): settled=${mr.settled} bedOk=${mr.bedOk} moved=${mr.movedBlocks}b end=${mr.end ? mr.end.x + ',' + mr.end.z : '?'} reason=${mr.reason} — re-assess`); continue; }
                    }
                    if (lowFoodHold.coveredOrEnclosed) {
                        // Enclosed underground (dug down chasing ore while starving) → the surface
                        // forageExplore can't path OUT of the pocket (goToPosition fast-NoPaths when
                        // sealed). Surface FIRST; next cycle forages on the open surface. This was
                        // the missing half of C215 — the bot stayed pinned at y71 while forageExplore
                        // fired uselessly because it couldn't extract from the dug pocket.
                        const sy = Math.round(bot.entity.position.y || 71) + 18;
                        prog(`low-food hold + enclosed(y=${lowFoodHold.y}) → surfaceUp(${sy}) first (forageExplore can't extract from pocket)`);
                        try { await skills.customSkill(bot, 'surfaceUp', sy); } catch (e) { prog(`hold-surfaceUp threw: ${e.message}`); }
                    } else {
                        prog('low-food hold → forageExplore (active search/relocate out of food desert, not idle-hold)');
                        try { await skills.customSkill(bot, 'forageExplore', { gateFood: 6, gateHp: 10, maxBlocks: 180 }); }
                        catch (e) { prog(`hold-forage threw: ${e.message}`); }
                    }
                    continue;
                }
                try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
                try { bot.clearControlStates(); } catch (_) {}
                await wait(5000);
                continue;
            }
            if (!bot._stagPos || fp.distanceTo(bot._stagPos) > 10) { if (bot._stagPos && fp.distanceTo(bot._stagPos) > 10) bot._noRegenFrozenSince = null; bot._stagPos = fp.clone(); bot._stagAt = Date.now(); }
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
                if ((_hpOn() || _foodOn()) && bodyBudgetFamine()) {   // ★2026-07-09 用户令 HP/食物本能熔断: BREAKOUT body-budget famine 保命 hold(mixed hp+food); 任一/双闸开恢复。
                    prog(`★BREAKOUT gated: body-budget famine hp=${Math.round(bot.health)} food=${bot.food} hostiles10=${hostilesNear(10)} actionable10=${actionableHostilesNear(10)}; no tunneling/sprint, preserve sealed body`);
                    try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
                    try { bot.clearControlStates(); } catch (_) {}
                    await wait(10000);
                    continue;
                }
                if ((_hpOn() || _foodOn()) && famineCritical()) {   // ★2026-07-09 用户令 HP/食物本能熔断: BREAKOUT famine-critical 保命 hold(mixed hp+food); 任一/双闸开恢复。
                    prog(`★BREAKOUT gated: famine-critical hp=${Math.round(bot.health)} food=${bot.food}; no tunneling/sprint, preserve body for feedUp/shelter`);
                    try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
                    try { bot.clearControlStates(); } catch (_) {}
                    await wait(5000);
                    continue;
                }
                if (_foodOn() && noRegenNoFood() && actionableHostilesNear(10) === 0) {   // ★2026-07-09 用户令 食物本能熔断: BREAKOUT no-regen forage/relocate 派发(保留 actionableHostilesNear 安全门); 食物闸开恢复。
                    // ★C224b: no-regen + no-food is an ABSORBING hold — passive waiting never restores
                    // food, and hp can't regen until food≥18, so a hurt bot freezes forever (live: hp9
                    // food17 held at the forest surface, every subsystem holding, feedUp refusing "no
                    // close food signal"). The escape is ACTIVE: by day with no actionable threat, TRAVEL
                    // to hunt. forageExplore self-gates (night/hostile/hp-drop, bounded) — pass a low hp
                    // gate (already hurt; venturing to food beats freezing, same as C217) and
                    // targetFood:18 so the handoff forage actually fires at food17 and eats PAST the regen
                    // floor (a target of 16 no-ops at food17 → never reaches regen). Truly-sealed →
                    // surfaceUp first (forageExplore can't path out of a sealed pocket); POCKET near the
                    // surface lets forageExplore's own goToPosition extract.
                    // Only surfaceUp-first when TRULY sealed (ENTOMBED). The `enclosed` flag is true even
                    // for a FREE bot under a tree canopy / in a 1-block dip at the surface — treating that
                    // as sealed wrongly sent it to surfaceUp forever (live: `sealed(FREE) → surfaceUp` at
                    // y88-93, never foraging). FREE/POCKET → forageExplore directly (it extracts itself).
                    const sealed = !!(bot._mobility && /ENTOMBED/.test(bot._mobility.state || ''));
                    if (!isNightNow() && Math.round(bot.health) >= 6
                        && (!bot._lastNoRegenForageAt || Date.now() - bot._lastNoRegenForageAt > 45000)) {
                        bot._lastNoRegenForageAt = Date.now();
                        if (sealed) {
                            const sy = Math.round((bot.entity.position && bot.entity.position.y) || 71) + 10;
                            prog(`no-regen no-food + sealed(${bot._mobility && bot._mobility.state}) → surfaceUp(${sy}) first, forage next cycle (hp=${Math.round(bot.health)} food=${bot.food})`);
                            try { await skills.customSkill(bot, 'surfaceUp', sy); } catch (e) { prog(`noRegen-surfaceUp threw: ${e && e.message || e}`); }
                        } else {
                            prog(`no-regen no-food → forageExplore (ACTIVE hunt; passive hold can't restore food→regen) hp=${Math.round(bot.health)} food=${bot.food}`);
                            // ★C225: claim movement authority vs the ① mobility no-regen hold (noRegenSafeAirHold),
                            // which otherwise pins the body so this dispatched forage can't travel. Time-boxed +
                            // cleared in finally (backstop if finally is skipped).
                            bot._recoveryVentureUntil = Date.now() + 180000;
                            try { await skills.customSkill(bot, 'forageExplore', { gateHp: 6, gateFood: 8, abortHp: 5, targetFood: 18, maxBlocks: 220 }); }
                            catch (e) { prog(`noRegen-forage threw: ${e && e.message || e}`); }
                            finally { bot._recoveryVentureUntil = 0; }
                        }
                        continue;
                    }
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

        if (!noRegenNoFood()) bot._noRegenFrozenSince = null;   // C217b: only persist the frozen-timer while genuinely stuck-low (recovered → reset)

        // ★★C248 RECOVERY-FLOOR / pickaxe-survival invariant (ROOT CAUSE of the y66 stone-tomb
        // deadlock — see memory resource-floor-bootstrap-kit). Evidence: bot respawned with a lone
        // wooden_pickaxe, C232 dug it DOWN (mineDown targetY-14) with NO durability check, the pick
        // snapped ~14b deeper, and a naked-no-pick + no-wood bot sealed in stone = PERMANENT tomb
        // (progress spammed `TABLE gate iron_pickaxe — no wood/table/logs planksMax=2 logs=0` for
        // hours). This is the user's "明知镐子要没了还在挖". Two guards close the SOURCE (not the
        // escape symptom): (a) never dig DOWN with a dying last pick we can't replace — breaking it
        // deeper strands us; (b) while that pick still has life, spend it climbing to WOOD to rebuild
        // the kit, not digging deeper. Below-floor = no realistic pick future.
        const C248_WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry'];
        const kitCounts = () => { try { return world.getInventoryCounts(bot) || {}; } catch (e) { return {}; } };
        const pickRemainFrac = () => {
            const picks = bot.inventory.items().filter(it => /_pickaxe$/.test(it.name || ''));
            if (!picks.length) return 0;
            if (picks.length >= 2) return 1;                 // a spare exists → effectively healthy
            const p = picks[0];
            const max = p.maxDurability || 0;
            const used = (typeof p.durabilityUsed === 'number') ? p.durabilityUsed : 0;
            return max > 0 ? (max - used) / max : 1;
        };
        const canCraftReplacementPick = () => {
            const c = kitCounts();
            const planks = C248_WOODS.reduce((s, w) => s + (c[`${w}_planks`] || 0), 0);
            const logs = C248_WOODS.reduce((s, w) => s + (c[`${w}_log`] || 0), 0);
            const cobble = (c.cobblestone || 0) + (c.cobbled_deepslate || 0);
            const sticks = c.stick || 0;
            const haveTable = (c.crafting_table || 0) > 0 || planks >= 4 || logs >= 1;   // logs→planks→table
            const haveHead = cobble >= 3 || planks >= 3 || logs >= 1;                    // pick head material
            const haveSticks = sticks >= 2 || planks >= 2 || logs >= 1;                  // planks→sticks
            return haveTable && haveHead && haveSticks;
        };
        // Safe to dig DOWN only if not risking a strand: a replacement is craftable, OR the lone
        // pick still has >half its life (enough to dig + climb back). Past half + unreplaceable = stop.
        const pickHealthyForDig = () => canCraftReplacementPick() || pickRemainFrac() > 0.5;
        // Below the bootstrap floor = no realistic pick future AND no wood to rebuild one: must surface.
        const belowRecoveryFloor = () => {
            const c = kitCounts();
            const logs = C248_WOODS.reduce((s, w) => s + (c[`${w}_log`] || 0), 0);
            const planks = C248_WOODS.reduce((s, w) => s + (c[`${w}_planks`] || 0), 0);
            const noWood = logs === 0 && planks < 4;
            const noPick = !bot.inventory.items().some(it => /_pickaxe$/.test(it.name || ''));
            const dyingUnreplaceablePick = pickRemainFrac() <= 0.5 && !canCraftReplacementPick();
            return noWood && (noPick || dyingUnreplaceablePick);
        };

        // ★C232 SAFE-MINE EXIT — enclosed + 持镐 + 怪够不到 时,no-regen "保守 hold" 不该全冻死:
        // 原地下挖是零死亡风险(mineDown 自带水/岩浆/support/摔落逐格探测 + hostile<4 bail,且朝
        // 远离最近怪方向),且 ①产出 cobble→stone_pickaxe / raw_iron→脱 TABLE-gate ②凿离 mob-magnet。
        // 必须放在下面 no-regen backoff 短路(wait+continue)之前,否则永被抢走。这是 C228 通则
        // (无恢复路径的保守 hold 必须有出口)在"持镐封闭"场景落地。实测:hp6/food13/y65/enclosed/
        // 12-16怪全 nonactionable 永冻 50min+,补给出口全要 hp≥8~14 过不去,就地安全挖矿才是出路。
        const safeContainedMineExit = () => {
            try {
                if (edibleHeld()) return false;
                if (!(bot.health < 14 && bot.food < 18)) return false;   // 仅 no-regen 死区
                if (bot.health < 5) return false;                         // hp 极低危→不主动做事,等救/等死
                if (inNether()) return false;
                const hasPick = bot.inventory.items().some(it => /_pickaxe$/.test(it.name || ''));
                if (!hasPick) return false;                               // 无镐→不啃石(沿用 material invariant)
                if (!pickHealthyForDig()) return false;                   // ★C248: 垂死的唯一镐+无料造备用→不下挖(挖断会困死更深=石棺根因)
                const enclosed = !!(bot._mobility && (bot._mobility.enclosed || /POCKET|ENTOMBED/.test(bot._mobility.state || ''))) || hasOverheadCover();
                if (!enclosed) return false;                              // 仅封闭/有顶(无摔落暴露)才就地挖
                if (actionableHostilesNear(12) > 0) return false;         // 有够得到的怪→交保命逻辑
                const feet = bot.blockAt(bot.entity.position) || { name: 'air' };
                const head = bot.blockAt(bot.entity.position.offset(0, 1, 0)) || { name: 'air' };
                if (/water|lava|fire/.test(feet.name || '') || /water|lava|fire/.test(head.name || '')) return false;
                return true;
            } catch (e) { return false; }
        };
        if (safeContainedMineExit() && (!bot._lastSafeContainedMineAt || Date.now() - bot._lastSafeContainedMineAt > 45000)) {
            bot._lastSafeContainedMineAt = Date.now();
            bot._climbingAt = Date.now();   // 计为有目的工程,别被 MAROONED 90s 判定打断
            prog(`★C232 SAFE-MINE EXIT: enclosed+持镐+actionable0 no-regen hold (hp=${Math.round(bot.health)} food=${bot.food} y=${Math.round(bot.entity.position.y)}) → mineDown 安全凿离/产出,不再 backoff 空冻`);
            try {
                await skills.customSkill(bot, 'mineDown', { targetY: Math.max(48, Math.round(bot.entity.position.y) - 14) });
            } catch (e) {
                prog(`SAFE-MINE EXIT mineDown threw: ${e && e.message || e}; fallback digDown`);
                try { await skills.digDown(bot, 2); } catch (e2) {}
            }
            continue;
        }
        // ★C237: no-pick contained TERMINAL FREEZE → surface UP (the no-pick sibling of C232).
        // C232 digs DOWN with a pick; a bot with NO pickaxe can't mine, and digging down never
        // reaches wood — it must go UP to the surface to chop. Live root cause (this very bot):
        // hp6 food17 SEALED at y66 with 0 pick / 0 wood / 209 cobble spun `TABLE gate no wood` for
        // HOURS — C232 skipped (no pick), C229 paths gated at hp>=8, and surfaceUp self-blocked the
        // breach at hp<8. A no-pick bot sealed underground can ONLY recover by surfacing (→ trees →
        // wood → recraft chain; or, if the surface is also barren, at least exposure enables a clean
        // death-reset instead of an absorbing freeze). Going UP is ZERO fall-risk; enclosed = no mob
        // reaches during the climb; surfaceUp FREEZES the survival modes for the whole climb (so no
        // ① veto — no _recoveryVentureUntil needed, unlike forage/migrate) and guards water/lava,
        // breaking the ceiling bare-hand via the C237 relaxation. SAFETY: DAYTIME ONLY + no
        // actionable hostiles + not nether — never surface a hurt bot into the dark.
        const noPickContainedEscape = () => {
            try {
                if (edibleHeld()) return false;
                if (inNether()) return false;
                if (isNightNow()) return false;                          // surface into DAYLIGHT only
                if (!(bot.health < 14 && bot.food < 18)) return false;   // the no-regen stuck band
                // ★C248: normally has-pick → C232 owns it. EXCEPTION: a dying, unreplaceable lone pick
                // with NO wood (belowRecoveryFloor) must NOT keep digging — spend its last life climbing
                // to WOOD to rebuild the kit, before it snaps and strands us (the tomb's root cause).
                if (bot.inventory.items().some(it => /_pickaxe$/.test(it.name || '')) && !belowRecoveryFloor()) return false;
                const enclosed = !!(bot._mobility && (bot._mobility.enclosed || /POCKET|ENTOMBED/.test(bot._mobility.state || ''))) || hasOverheadCover();
                if (!enclosed) return false;                             // only when actually contained
                if (actionableHostilesNear(12) > 0) return false;
                // NOTE: no y-ceiling guard here. The `enclosed` check above is the correct
                // discriminator for "needs to surface" — a bot can be sealed under stone at ANY y
                // (live: C237 climbed y66→84 in one daytime window, then night-gated mid-breach,
                // still ENCLOSED at y84 with stone overhead). A y>=72 guard would wrongly block the
                // dawn resume and strand it at y84. At the true open surface, enclosed=false → this
                // gate skips on its own; surfaceUp is also idempotent (surfaceReady early-exit).
                const feet = bot.blockAt(bot.entity.position) || { name: 'air' };
                const head = bot.blockAt(bot.entity.position.offset(0, 1, 0)) || { name: 'air' };
                if (/water|lava|fire/.test(feet.name || '') || /water|lava|fire/.test(head.name || '')) return false;
                return true;
            } catch (e) { return false; }
        };
        if (noPickContainedEscape() && (!bot._lastNoPickEscapeAt || Date.now() - bot._lastNoPickEscapeAt > 45000)) {
            bot._lastNoPickEscapeAt = Date.now();
            bot._climbingAt = Date.now();   // 计为有目的工程,别被 MAROONED 90s 判定打断
            prog(`★C237 NO-PICK ESCAPE: no pick + enclosed + no-regen (hp=${Math.round(bot.health)} food=${bot.food} y=${Math.round(bot.entity.position.y)}) → surfaceUp (daytime, no hostiles) to reach trees/wood, not freeze`);
            try {
                await skills.customSkill(bot, 'surfaceUp', Math.min(90, Math.max(72, Math.round(bot.entity.position.y) + 12)));
            } catch (e) { prog(`NO-PICK ESCAPE surfaceUp threw: ${e && e.message || e}`); }
            continue;
        }
        const noRegenRemain = noRegenBackoffRemain();
        if ((_hpOn() || _foodOn()) && noRegenNoFood() && noRegenRemain.any > 0) {   // ★2026-07-09 用户令 HP/食物本能熔断: no-regen 站桩 stand-down(mixed hp+food; 威胁/夜间避难经末尾无条件 prepNether 兜底); 任一/双闸开恢复。
            const oakReady = boundedOakAppleReady();
            if (oakReady && noRegenRemain.surface > 0) {
                bot._prepNoFoodSurfaceBackoffUntil = 0;
                prog(`prepNether stand-down override: bounded oak/apple ready ${oakReady}; clear surface backoff and let prepNether retry`);
            } else {
            prog(`prepNether stand-down: low-hp/no-food cooldown ${noRegenRemain.any}s lowHp=${noRegenRemain.lowHp}s surface=${noRegenRemain.surface}s (hp=${Math.round(bot.health)} food=${bot.food}); body stays free for survival modes`);
            // ★C257 NIGHT no-regen freeze fix: at night forageExplore correctly self-gates (no
            // wandering in the dark) and every handoff below is DAY/hostile-gated
            // (daylightFamineHostileShelter, !isNightNow). So at night with hostiles16=0 the bot
            // fell THROUGH them all to wait+continue and FROZE exposed — a confirmed 6-min stall
            // @14,68,-11, hp12/food15 — "body stays free for survival modes" but nothing sealed it,
            // and a wandering mob would then swarm the unarmored bot (the death-5 pattern). At night
            // hand off to prepNether to hole up + SEAL until dawn PROACTIVELY (pairs with C256 so the
            // unarmored bot actually seals), instead of freezing in the open until a mob arrives.
            if (isNightNow()) {
                prog(`★C257 night no-regen stand-down → prepNether hole-up+seal (don't freeze exposed) hp=${Math.round(bot.health)} food=${bot.food}`);
                try { await skills.customSkill(bot, 'prepNether'); } catch (e) { prog(`night stand-down prepNether threw: ${e.message}`); }
                await wait(1000);
                continue;
            }
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
                    // ★DEADLOCK-BREAKER (C215 family, for the no-regen hold): no-regen + no local
                    // food signal would otherwise just wait/freeze HERE forever — a barren spot
                    // never produces a food signal, so the bot degrades in place to the hp4 frozen
                    // wedge. If still strong enough to travel safely (hp>=8), actively forageExplore
                    // to RELOCATE toward food instead of rotting in place (it self-gates on
                    // night/hostile/hp-drop, bounded). This is the EXIT the no-regen hold lacked —
                    // relocating at hp>=8 PREVENTS degrading into the hp4 no-win deadlock. (At hp<8
                    // it's genuinely too weak to forage safely; that no-win resolves via death.)
                    if (Math.round(bot.health) >= 8 && !isNightNow() && actionableHostilesNear(8) === 0
                        && (!bot._lastNoRegenRelocateAt || Date.now() - bot._lastNoRegenRelocateAt > 90000)) {
                        bot._lastNoRegenRelocateAt = Date.now();
                        prog(`no-regen deadlock-breaker: hp=${Math.round(bot.health)} food=${bot.food} no local food → forageExplore relocate (escape barren spot, don't freeze)`);
                        // ★C225: claim movement authority vs ① no-regen hold + targetFood 18 so the handoff
                        // forage eats PAST the regen floor (default 16 no-ops at food17 → hp stays pinned).
                        bot._recoveryVentureUntil = Date.now() + 180000;
                        try { await skills.customSkill(bot, 'forageExplore', { gateFood: 5, gateHp: 8, abortHp: 5, targetFood: 18, maxBlocks: 200 }); }
                        catch (e) { prog(`no-regen relocate threw: ${e.message}`); }
                        finally { bot._recoveryVentureUntil = 0; }
                        continue;
                    }
                    // ★HP<8 LAST-RESORT venture — the permanent-freeze the C216 reasoning missed.
                    // The hp>=8 deadlock-breaker above can't fire at hp<8, and the original code
                    // assumed hp<8-no-food "resolves via death" — FALSE: with hostiles=0 and no
                    // fall/lava the bot NEVER dies and NEVER recovers (no food source here), so it
                    // sits frozen forever (observed 50min+ pinned at hp2). Frozen-forever is
                    // strictly worse than a bounded venture: walking either loads chunks with
                    // food/terrain OR dies→respawns fresh — both beat rotting in place. After
                    // pinned very long, force ONE bounded venture regardless of hp (abortHp:1 so
                    // forageExplore won't self-abort; survival reflexes stay active during the walk).
                    if (!bot._noRegenFrozenSince) bot._noRegenFrozenSince = Date.now();
                    const frozenMin = (Date.now() - bot._noRegenFrozenSince) / 60000;
                    if (frozenMin > 12 && !isNightNow() && actionableHostilesNear(8) === 0
                        && (!bot._lastLastResortVentureAt || Date.now() - bot._lastLastResortVentureAt > 5 * 60 * 1000)) {
                        bot._lastLastResortVentureAt = Date.now();
                        // C217c: if enclosed underground, forageExplore's goToPosition fast-NoPaths
                        // (can't extract from a sealed pocket — verified live 23:37: venture fired but
                        // bot stayed at 27,78 y78 "underground/enclosed"). Surface FIRST (dig out),
                        // then a later cycle forages on the open surface. Mirrors C215b (L661-669).
                        const lrEnclosed = hasOverheadCover()
                            || !!(bot._mobility && (bot._mobility.enclosed || /POCKET|ENTOMBED/.test(bot._mobility.state || '')));
                        if (lrEnclosed) {
                            const sy = Math.round(bot.entity.position.y || 71) + 18;
                            prog(`★HP<8 LAST-RESORT (frozen ${frozenMin.toFixed(0)}min @hp${Math.round(bot.health)}, enclosed y=${Math.round(bot.entity.position.y)}) → surfaceUp(${sy}) first (forageExplore can't extract from pocket)`);
                            try { await skills.customSkill(bot, 'surfaceUp', sy); } catch (e) { prog(`last-resort surfaceUp threw: ${e.message}`); }
                        } else {
                            // Forage first (cheap; might load chunks with local food). Track consecutive
                            // failures — a bounded forageExplore that keeps returning found:false means
                            // THIS spawn is a confirmed food desert with nothing in reach.
                            prog(`★HP<8 LAST-RESORT venture: frozen ${frozenMin.toFixed(0)}min @hp${Math.round(bot.health)} food=${bot.food} hostiles0 fails=${bot._lrForageFails || 0} — forceExplore (find-or-respawn beats frozen-forever)`);
                            let fr = null;
                            try { fr = await skills.customSkill(bot, 'forageExplore', { gateHp: 1, abortHp: 1, gateFood: 4, maxBlocks: 160 }); }
                            catch (e) { prog(`last-resort venture threw: ${e.message}`); }
                            if (fr && fr.found) bot._lrForageFails = 0; else bot._lrForageFails = (bot._lrForageFails || 0) + 1;
                            // ★C241 (user-authorized): hp4-5 食物荒漠吸收态 — bounded forage can't escape
                            // (out→still desert), and feedUp/forageExplore/famine-migrate all self-abort
                            // at low hp, so the bot freezes forever until a night mob kills it. When forage
                            // has failed >=2x here, STAYING is itself certain (slow) death → the relocate
                            // abort-floor protection is moot. Force a long-range settle-migrate even at
                            // hp<8: find a livable biome (landAnimals>=2, auto-setBed at the new spot) OR
                            // die-while-moving → respawn fresh (naked-asset death cost ~= 0). This is the
                            // hp<8 symmetric branch of C230's food<=2 famine-migrate. abortHp:2 leaves a
                            // sliver; force:true bypasses migrate's own gates; migrate self-bunkers at night.
                            if ((bot._lrForageFails || 0) >= 2 && !isNightNow() && actionableHostilesNear(8) === 0
                                && (!bot._lastLastResortMigrateAt || Date.now() - bot._lastLastResortMigrateAt > 5 * 60 * 1000)) {
                                bot._lastLastResortMigrateAt = Date.now();
                                bot._recoveryVentureUntil = Date.now() + 600000;   // yield ① famine body-freeze during the march
                                prog(`★C241 HP<8 DESERT-MIGRATE: ${bot._lrForageFails} forage fails @hp${Math.round(bot.health)} food=${bot.food} — bounded forage can't escape this desert; force long-range settle-migrate (livable biome or die-moving→respawn)`);
                                try {
                                    const mr = await skills.customSkill(bot, 'migrate', { force: true, gateFood: 0, gateHp: 1, abortHp: 2, maxBlocks: 800, settleScore: 12 });
                                    if (mr && (mr.settled || (mr.movedBlocks || 0) >= 150)) bot._lrForageFails = 0;
                                    prog(`★C241 DESERT-MIGRATE done: ${JSON.stringify(mr)}`);
                                } catch (e) { prog(`C241 desert-migrate threw: ${e.message}`); }
                                finally { bot._recoveryVentureUntil = 0; }
                            }
                        }
                        continue;
                    }
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

        // ★CROSS-CONTINENT MIGRATION (C220, 用户纠偏:像人类一样决策). Before the default
        // "grind gear locally via prepNether", ask the human question: is this whole SPAWN an
        // unlivable ocean food-desert we keep dying at? migrate self-gates (shouldMigrate:
        // healthy daylight + confirmed desert via current ocean biome / streak / clustered
        // food-deaths + off cooldown). A human who's died here 3+ times doesn't re-grind the
        // same barren spot every respawn — they WALK OUT to livable land (animals/trees/plains)
        // and plant a bed. If migrate declines (not a confirmed desert / unhealthy / cooldown),
        // it returns instantly and we fall through to the normal prepNether grind. Only attempt
        // in the healthy post-respawn window (hp≥14/food≥12) — a long march needs reserves.
        if (!isNightNow() && actionableHostilesNear(8) === 0 && (!_hpOn() || Math.round(bot.health) >= 14) && (!_foodOn() || bot.food >= 6)   // ★2026-07-09 用户令 HP/食物本能熔断: cross-continent migrate 血/饱和储备门(纯前置; 保留 actionableHostilesNear 安全门); 任一/双闸开恢复。
            && (!bot._lastMigrateTryAt || Date.now() - bot._lastMigrateTryAt > 120000)) {
            bot._lastMigrateTryAt = Date.now();
            let mr = null;
            try { mr = await skills.customSkill(bot, 'migrate', {}); } catch (e) { prog(`migrate threw: ${e.message}`); }
            if (mr && mr.migrated) {
                prog(`★MIGRATE ran: settled=${mr.settled} bedOk=${mr.bedOk} moved=${mr.movedBlocks}b end=${mr.end ? mr.end.x + ',' + mr.end.z : '?'} reason=${mr.reason} — re-assess from new home`);
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
            if ((_hpOn() || _foodOn()) && ((bot.food <= 2 && !edible) || bottomBodyBudgetFamine)) {   // ★2026-07-09 用户令 HP/食物本能熔断: FAMINE backoff 站桩/觅食(mixed hp+food); 任一/双闸开恢复。
                const hostilePressure = actionableHostilesNear(16) > 0;
                // ★C228: a FAMINE backoff at food0 in a FOOD DESERT is an ABSORBING state — holding
                // still guarantees no food, hp can't regen (food<18), and easy-difficulty hunger
                // damage halts at hp10 → frozen until a night mob finally kills it (live: food0
                // hp10 y88, 24min+ no move/no recovery, then died losing iron-tier progress). The
                // only real exit is to TRAVEL out. So in a SAFE DAYLIGHT window — food0, hp>=10
                // (NOT the hp<10 danger zone), no edible, daytime, no hostile within 16 — dispatch
                // forageExplore to walk to land animals / fresher terrain. Night / hostiles / hp<10
                // still HOLD (freezing is the correct survival act there — never venture into the
                // dark or while hurt; movement at food0 costs food not hp, hunger already floored).
                // forageExplore self-gates (night/hostile/hp-abort, bounded maxBlocks) and hands the
                // kill+eat to `forage`. _recoveryVentureUntil claims body authority vs ① famineBodyFreeze
                // (whose skill-name allowlist can't release it — sticky _currentSkill='missionNether');
                // same flag-yield mechanism as the no-regen ventures at L793 / L917.
                const safeDayVenture = bot.food === 0
                    && Math.round(bot.health) >= 10
                    && !night
                    && actionableHostilesNear(16) === 0 && hostilesNear(16) === 0;
                // ★C230 (#33): forageExplore (maxBlocks 220) repeatedly landing in more desert means
                // this whole region is barren — escalate to migrate (maxBlocks 800, locked bearing, settle
                // only at landAnimals>=2) to relocate cross-continent + set bed at the new home (migrate
                // does the setBed handoff itself). _famineForageFailCount counts consecutive forageExplore
                // no-results (found:false); >=2 ⇒ area confirmed unlivable. food0-safe: migrate force-
                // bypasses its own hp>=14/food>=6 gate (shouldMigrate force-first), abortHp:6 catches hp
                // drops (easy floors hunger at hp10>6; normal/hard aborts before starving), night auto-
                // bunkers. migrate is whitelisted in ① famineBodyFreeze + honored via _recoveryVentureUntil.
                const famineMigrate = safeDayVenture && (bot._famineForageFailCount || 0) >= 2
                    && (!bot._lastFamineMigrateAt || Date.now() - bot._lastFamineMigrateAt > 300000);
                if (famineMigrate) {
                    bot._lastFamineMigrateAt = Date.now();
                    bot._recoveryVentureUntil = Date.now() + 600000;
                    prog(`★C230 FAMINE-MIGRATE: forage no-result ×${bot._famineForageFailCount} → migrate relocate (food0-safe force) hp=${Math.round(bot.health)}`);
                    let mr = null;
                    try { mr = await skills.customSkill(bot, 'migrate', { force: true, gateFood: 0, gateHp: 8, abortHp: 6, maxBlocks: 800, settleScore: 12 }); }
                    catch (e) { prog(`FAMINE-migrate threw: ${e && e.message || e}`); }
                    finally { bot._recoveryVentureUntil = 0; }
                    if (mr && mr.migrated) { bot._famineForageFailCount = 0; prog(`★FAMINE-MIGRATE done: settled=${mr.settled} bedOk=${mr.bedOk} moved=${mr.movedBlocks}b end=${mr.end ? mr.end.x + ',' + mr.end.z : '?'}`); }
                    continue;
                }
                if (safeDayVenture && (!bot._lastFamineBackoffForageAt || Date.now() - bot._lastFamineBackoffForageAt > 90000)) {
                    bot._lastFamineBackoffForageAt = Date.now();
                    prog(`FAMINE backoff → forageExplore (food0 absorbing-state escape; safe daylight, no hostiles, hp=${Math.round(bot.health)}) — walk OUT of food desert, not idle-freeze`);
                    bot._recoveryVentureUntil = Date.now() + 180000;
                    let fr = null;
                    try { fr = await skills.customSkill(bot, 'forageExplore', { gateHp: 8, gateFood: 0, abortHp: 6, targetFood: 18, maxBlocks: 220 }); }
                    catch (e) { prog(`FAMINE-backoff forage threw: ${e && e.message || e}`); }
                    finally { bot._recoveryVentureUntil = 0; }
                    // track consecutive no-results → after 2, the famineMigrate branch above escalates
                    if (fr && fr.explored && fr.found === false) {
                        bot._famineForageFailCount = (bot._famineForageFailCount || 0) + 1;
                        prog(`FAMINE forage no-result #${bot._famineForageFailCount} (220b → more desert) — ${bot._famineForageFailCount >= 2 ? 'next cycle escalates to migrate' : 'retry once more'}`);
                    } else if (fr && fr.found) {
                        bot._famineForageFailCount = 0;  // this area has food after all — cancel relocate intent
                    }
                    continue;
                }
                const holdMs = (night || hostilePressure) ? 30000 : 10000;
                prog(`FAMINE backoff: food=${bot.food}, hp=${Math.round(bot.health)}, edible=false, night=${night}, hostiles16=${hostilesNear(16)} actionable16=${actionableHostilesNear(16)} — ${holdMs / 1000}s body-budget hold`);
                await wait(holdMs);
                continue;
            }
            // ★C233 (#33 收敛核心): the "healthy-but-locally-starving" trigger GAP. The FAMINE
            // backoff above only fires at food<=2 (or hp<=8&&food<=6); the HP<8 last-resort
            // venture (C217) fires at hp<=8. BETWEEN them — hp>=8 and food 3~13 — there was NO
            // trigger that sends the bot on a long-range venture. So in a food desert the bot
            // would feedUp locally (animal64=none, 64b scan dry), hold / mine-in-place / spin the
            // prepNether defer-loop, and only slowly starve down to food<=2 (the slow path) or die
            // at night — NEVER travelling OUT of the barren region. This closes that gap with a
            // SINGLE convergent trigger: feedUp has CONFIRMED no local food source (feedUpDryNoFood:
            // a 64b huntable scan came up empty, position-local, recent TTL — the animal64=none
            // signal the design called for), food is below the regen line (food<14), and it's a
            // SAFE DAYLIGHT window with the bot healthy (hp>=8) → dispatch forageExplore, escalating
            // to migrate after repeated no-results (SHARED _famineForageFailCount counter — forage
            // failures from this trigger and the famine path both mean "this area is barren", so a
            // smooth convergent escalation to cross-biome migrate). SAFETY: hp>=8 + daylight + no
            // hostiles within 16 + not nether; forageExplore/migrate self-gate (night/hostile/
            // hp-abort, bounded maxBlocks); _recoveryVentureUntil yields the body vs ① famineBodyFreeze.
            // NEVER ventures at low hp or night — avoids the explore-and-die cascade (see C225 obs).
            else {
                const dry = feedUpDryNoFood();
                const ventureSafeDay = !!dry
                    && bot.food < 14
                    && Math.round(bot.health) >= 8
                    && !night
                    && !edible
                    && !inNether()
                    && actionableHostilesNear(16) === 0 && hostilesNear(16) === 0;
                if (_foodOn() && ventureSafeDay) {   // ★2026-07-09 用户令 食物本能熔断: C233 healthy-but-starving 觅食/迁移(纯食物派发; ventureSafeDay 内 actionableHostilesNear 安全门保留); 食物闸开恢复。
                    const ventureMigrate = (bot._famineForageFailCount || 0) >= 2
                        && (!bot._lastFamineMigrateAt || Date.now() - bot._lastFamineMigrateAt > 300000);
                    if (ventureMigrate) {
                        bot._lastFamineMigrateAt = Date.now();
                        bot._recoveryVentureUntil = Date.now() + 600000;
                        prog(`★C233 DESERT-MIGRATE: dry no-food ×${bot._famineForageFailCount} (${dry.scan}) → migrate relocate (healthy-but-starving, hp=${Math.round(bot.health)} food=${bot.food})`);
                        let mr = null;
                        try { mr = await skills.customSkill(bot, 'migrate', { force: true, gateFood: 0, gateHp: 8, abortHp: 6, maxBlocks: 800, settleScore: 12 }); }
                        catch (e) { prog(`DESERT-migrate threw: ${e && e.message || e}`); }
                        finally { bot._recoveryVentureUntil = 0; }
                        if (mr && mr.migrated) { bot._famineForageFailCount = 0; prog(`★DESERT-MIGRATE done: settled=${mr.settled} bedOk=${mr.bedOk} moved=${mr.movedBlocks}b end=${mr.end ? mr.end.x + ',' + mr.end.z : '?'}`); }
                        continue;
                    }
                    if (!bot._lastDesertVentureAt || Date.now() - bot._lastDesertVentureAt > 90000) {
                        bot._lastDesertVentureAt = Date.now();
                        bot._recoveryVentureUntil = Date.now() + 180000;
                        prog(`★C233 DESERT-FORAGE: healthy-but-locally-starving (hp=${Math.round(bot.health)} food=${bot.food}, ${dry.scan}) → long-range forageExplore OUT of food desert (closes famine↔HP<8 trigger gap)`);
                        let fr = null;
                        try { fr = await skills.customSkill(bot, 'forageExplore', { gateHp: 8, gateFood: 0, abortHp: 6, targetFood: 18, maxBlocks: 220 }); }
                        catch (e) { prog(`DESERT-forage threw: ${e && e.message || e}`); }
                        finally { bot._recoveryVentureUntil = 0; }
                        if (fr && fr.explored && fr.found === false) {
                            bot._famineForageFailCount = (bot._famineForageFailCount || 0) + 1;
                            prog(`DESERT forage no-result #${bot._famineForageFailCount} — ${bot._famineForageFailCount >= 2 ? 'next cycle escalates to migrate' : 'retry once more'}`);
                        } else if (fr && fr.found) {
                            bot._famineForageFailCount = 0;  // this area has food after all — cancel relocate intent
                        }
                        continue;
                    }
                }
            }
        } catch (e) {}
        await wait(3000);
    }
    prog('missionNether: iter cap reached (5000) — returning; sticky re-arm will resume');
    return inNether();
}
