import * as skills from './library/skills.js';
import * as world from './library/world.js';
import * as mc from '../utils/mcdata.js';
import settings from './settings.js'
import convoManager from './conversation.js';
import fs from 'fs';
import Vec3 from 'vec3';

const FAMINE_FOOD_RE = /cooked_|_bread|^bread$|apple|golden_apple|carrot|potato|beef|porkchop|chicken|mutton|cod|salmon|melon_slice|sweet_berries|_stew|rabbit|baked_|rotten_flesh|spider_eye/;
const NORMAL_FOOD_RE = /cooked_|_bread|^bread$|apple|golden_apple|carrot|potato|beef|porkchop|chicken|mutton|cod|salmon|melon_slice|sweet_berries|_stew|rabbit|baked_/;

async function say(agent, message) {
    agent.bot.modes.behavior_log += message + '\n';
    if (agent.shut_up || !settings.narrate_behavior) return;
    agent.openChat(message);
}

function famineBodyFreeze(agent, owner) {
    const bot = agent && agent.bot;
    if (!bot || !bot.entity) return false;
    if (bot.food > 0 && !(bot.food <= 2 && bot.health <= 8)) return false;
    const skill = bot._currentSkill || '';
    if (/feedUp|surfaceUp|consume|auto_eat/i.test(skill)) return false;
    const edible = bot.inventory && bot.inventory.items().some(i => i && i.name && FAMINE_FOOD_RE.test(i.name));
    if (edible) return false;
    const p = bot.entity.position;
    const feet = bot.blockAt(p) || { name: 'air' };
    const head = bot.blockAt(p.offset(0, 1, 0)) || { name: 'air' };
    if (/water|lava|fire/.test(feet.name || '') || /water|lava|fire/.test(head.name || '')) return false;
    if (!bot.entity.onGround && bot.entity.velocity && bot.entity.velocity.y < -0.25) return false;
    if (Date.now() - (bot.lastDamageTime || 0) < 4000) return false;
    const hostile = Object.values(bot.entities || {}).some(e =>
        e && e !== bot.entity && e.position && mc.isHostile(e) && e.position.distanceTo(p) < 12);
    if (hostile) return false;
    try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
    try { bot.pathfinder && bot.pathfinder.stop && bot.pathfinder.stop(); } catch (e) {}
    try { bot.clearControlStates(); } catch (e) {}
    if (Date.now() - (bot._lastFamineFreezeLogAt || 0) > 15000) {
        bot._lastFamineFreezeLogAt = Date.now();
        try {
            fs.appendFileSync('bots/_supervisor/progress.txt',
                `[${new Date().toISOString()}] [${owner}] FAMINE body freeze: food=${bot.food} hp=${Math.round(bot.health)} pos=${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)} skill=${skill || '-'}\n`);
        } catch (e) {}
    }
    return true;
}

function lowHpNoRegenContainedHold(bot) {
    if (!bot || !bot.entity) return null;
    if (!(bot.health <= 8 && bot.food < 18)) return null;
    const hasNormalFood = bot.inventory && bot.inventory.items().some(i => i && i.name && NORMAL_FOOD_RE.test(i.name));
    if (hasNormalFood) return null;
    const p = bot.entity.position;
    const feet = bot.blockAt(p) || { name: 'air' };
    const head = bot.blockAt(p.offset(0, 1, 0)) || { name: 'air' };
    if (/water|lava|fire/.test(feet.name || '') || /water|lava|fire/.test(head.name || '')) return null;
    if (!bot.entity.onGround && bot.entity.velocity && bot.entity.velocity.y < -0.25) return null;
    if (Date.now() - (bot.lastDamageTime || 0) < 4000) return null;

    let covered = false;
    try {
        for (let dy = 2; dy <= 6; dy++) {
            const b = bot.blockAt(p.offset(0, dy, 0));
            if (b && b.boundingBox === 'block') { covered = true; break; }
        }
    } catch (e) {}
    const mob = bot._mobility ? (bot._mobility.state || '') : '';
    const enclosed = !!(bot._mobility && bot._mobility.enclosed);
    if (!(/MAROONED|POCKET|ENTOMBED/.test(mob) || enclosed || covered)) return null;

    let closest = Infinity;
    let closestName = null;
    for (const e of Object.values(bot.entities || {})) {
        if (!(e && e !== bot.entity && e.position && mc.isHostile(e))) continue;
        const d = e.position.distanceTo(p);
        if (d < closest) {
            closest = d;
            closestName = e.name || 'hostile';
        }
    }
    if (closestName && (closest < 4.25 || (/creeper/i.test(closestName) && closest < 5.5))) return null;
    return { mob, enclosed, covered, closest, closestName };
}

function tableRecoveryHold(bot) {
    if (!bot || !bot.entity) return null;
    let isNight = false;
    try {
        const t = bot.time && bot.time.timeOfDay;
        isNight = t >= 13000 && t <= 23000;
    } catch (e) {}
    if (bot.health < 14 || bot.food < 14) return null;
    const mob = bot._mobility ? (bot._mobility.state || '') : '';
    const enclosed = !!(bot._mobility && bot._mobility.enclosed);
    if (!(/POCKET|ENTOMBED/.test(mob) || enclosed)) return null;
    const counts = {};
    try {
        for (const it of bot.inventory.items()) counts[it.name] = (counts[it.name] || 0) + it.count;
    } catch (e) {}
    const planksMax = Math.max(0, ...Object.keys(counts).filter(k => k.endsWith('_planks')).map(k => counts[k] || 0));
    const logs = Object.keys(counts).filter(k => k.endsWith('_log')).reduce((s, k) => s + (counts[k] || 0), 0);
    if ((counts.crafting_table || 0) > 0 || planksMax >= 4 || logs > 0) return null;
    let progressFresh = false;
    try {
        const p = 'bots/_supervisor/progress.txt';
        const stat = fs.statSync(p);
        if (Date.now() - stat.mtimeMs < 90000) {
            const len = Math.min(8192, stat.size);
            const fd = fs.openSync(p, 'r');
            try {
                const buf = Buffer.alloc(len);
                fs.readSync(fd, buf, 0, len, stat.size - len);
                progressFresh = /TABLE (gate|recovery) for /.test(buf.toString('utf8'));
            } finally {
                fs.closeSync(fd);
            }
        }
    } catch (e) {}
    if (!progressFresh) return null;
    let raw = 0, actionable = null, layered = 0, nearest = Infinity;
    try {
        const a = JSON.parse(fs.readFileSync('bots/_supervisor/advisory.json', 'utf8'));
        if (a && Date.now() - a.ts < 45000 && typeof a.actionableHostiles === 'number') {
            raw = typeof a.hostiles === 'number' ? a.hostiles : 0;
            actionable = a.actionableHostiles;
            layered = typeof a.layeredHostiles === 'number' ? a.layeredHostiles : 0;
            nearest = typeof a.nearest === 'number' ? a.nearest : Infinity;
        }
    } catch (e) {}
    if (actionable == null) {
        actionable = 0;
        const p = bot.entity.position;
        for (const e of Object.values(bot.entities || {})) {
            if (!(e && e !== bot.entity && e.position && mc.isHostile(e))) continue;
            const d = e.position.distanceTo(p);
            if (d >= 16) continue;
            raw++;
            if (d < nearest) nearest = d;
            const dy = Math.abs(e.position.y - p.y);
            const ranged = /skeleton|stray|pillager|witch|blaze|ghast/i.test(e.name || '');
            if (d < 4.25 || (/creeper/i.test(e.name || '') && d < 5.5) || dy < 5 || (ranged && dy < 8)) actionable++;
            else layered++;
        }
    }
    if (actionable > 0) return null;
    return { raw, actionable, layered, nearest, mob, enclosed, isNight };
}

// a mode is a function that is called every tick to respond immediately to the world
// it has the following fields:
// on: whether 'update' is called every tick
// active: whether an action has been triggered by the mode and hasn't yet finished
// paused: whether the mode is paused by another action that overrides the behavior (eg followplayer implements its own self defense)
// update: the function that is called every tick (if on is true)
// when a mode is active, it will trigger an action to be performed but won't wait for it to return output

// the order of this list matters! first modes will be prioritized
// while update functions are async, they should *not* be awaited longer than ~100ms as it will block the update loop
// to perform longer actions, use the execute function which won't block the update loop
const modes_list = [
    {
        name: 'self_preservation',
        description: 'Respond to drowning, burning, and damage at low health. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        fall_blocks: ['sand', 'gravel', 'concrete_powder'], // includes matching substrings like 'sandstone' and 'red_sand'
        nearbyHostiles: function (bot) {
            try {
                return Object.values(bot.entities).filter(e => {
                    if (!(e && e !== bot.entity && e.position && mc.isHostile(e))) return false;
                    if (e.position.distanceTo(bot.entity.position) >= 10) return false;
                    // ★REACHABILITY 过滤 (怪窝实拍: 荫蔽破碎地形里怪挂在崖上/坑底,80%的
                    // "威胁"物理够不到bot(y71骷髅 vs y62bot 整夜零命中),却让 sp 永久占
                    // 身体,凿崖/作业层结构性饿死——act_trace 全天 20/20 帧 self_preservation,
                    // y 零爬升。近战怪隔≥5格高差打不到人,不算威胁;远程怪(skeleton/stray/
                    // pillager/witch)保留(箭/药水越高差)。绕路下来的近战怪 |dy|<5 时自然
                    // 回到威胁集,响应只延迟几秒。creeper 走 nearestCreeper 不受影响。)
                    if (/skeleton|stray|pillager|witch|blaze|ghast/.test((e.name || '').toLowerCase())) return true;
                    return Math.abs(e.position.y - bot.entity.position.y) < 5;
                });
            } catch (e) { return []; }
        },
        // Nearest CREEPER within range — the one mob you must NEVER bunker/melee next to
        // (it detonates). Wider scan than nearbyHostiles so the back-off reflex fires
        // EARLY (before it's in blast range) and preempts the night-shelter/flee branches.
        nearestCreeper: function (bot, range = 11) {
            try {
                let best = null, bd = range;
                for (const e of Object.values(bot.entities)) {
                    if (!e || !e.position || !e.name || !e.name.toLowerCase().includes('creeper')) continue;
                    const d = e.position.distanceTo(bot.entity.position);
                    if (d < bd) { bd = d; best = e; }
                }
                return best;
            } catch (e) { return null; }
        },
        creeperBackoffTarget: function (bot) {
            const cr = this.nearestCreeper(bot, 12);
            if (!cr) return null;
            const d = cr.position.distanceTo(bot.entity.position);
            const bunkerHold = this.coveredNightHoldStatus(bot);
            if (bunkerHold.hold && d > 3.6) return null;
            const swarmClose = this.nearbyHostiles(bot).some(e => e.position && e.position.distanceTo(bot.entity.position) < 8);
            if (this.isDay(bot)) {
                // Hysteresis: the backoff loop exits at >9m, so re-entering at 11m
                // produces day-long body theft around harmless distant creepers.
                return d <= (bot.health < 12 || swarmClose ? 10 : 8.25) ? cr : null;
            }
            return d <= (swarmClose ? 11 : 9.5) ? cr : null;
        },
        hasOverheadCover: function (bot, minDy = 2, maxDy = 6) {
            try {
                const p = bot.entity.position;
                for (let dy = minDy; dy <= maxDy; dy++) {
                    const b = bot.blockAt(p.offset(0, dy, 0));
                    if (b && b.boundingBox === 'block') return true;
                }
            } catch (e) {}
            return false;
        },
        coveredNightHoldStatus: function (bot) {
            const status = {
                hold: false, covered: false, recentDamage: false,
                hostiles: 0, closest: Infinity, creeperDist: Infinity
            };
            try {
                if (!bot || !bot.entity || this.isDay(bot)) return status;
                const p = bot.entity.position;
                const feet = bot.blockAt(p) || { name: 'air' };
                const head = bot.blockAt(p.offset(0, 1, 0)) || { name: 'air' };
                if (/water|lava|fire/.test(feet.name || '') || /water|lava|fire/.test(head.name || '')) return status;
                status.covered = this.hasOverheadCover(bot, 2, 6);
                if (!status.covered) return status;
                status.recentDamage = Date.now() - (bot.lastDamageTime || 0) < 4000;
                const hs = this.nearbyHostiles(bot);
                status.hostiles = hs.length;
                for (const h of hs) {
                    if (!h || !h.position) continue;
                    const d = h.position.distanceTo(p);
                    if (d < status.closest) status.closest = d;
                }
                const cr = this.nearestCreeper(bot, 12);
                if (cr && cr.position) status.creeperDist = cr.position.distanceTo(p);
                // A sealed/covered night bunker is safer than opening the body and running.
                // Only recent damage or a point-blank creeper is allowed to break the hold.
                // This is threat arbitration, not a generic night curfew: quiet enclosed
                // mines are already exempted by shouldNightShelter and should keep working.
                const threatPressure = status.hostiles > 0 || Number.isFinite(status.creeperDist);
                status.hold = threatPressure && !status.recentDamage && status.creeperDist > 3.6;
            } catch (e) {}
            return status;
        },
        // SMART ESCAPE ROUTING (uses the world block-scan — don't flee blindly!). The naive
        // "sprint opposite the mob centroid" kept running the bot INTO water (drown/slow) or
        // INTO another mob cluster just off-axis — that's how the zombie swarms cornered it.
        // Instead, sample candidate landing spots in a ring around us and SCORE each by:
        //   + distance from the nearest hostile (get away from the swarm)
        //   − running toward any cluster (heavy penalty per mob near the candidate)
        //   − water at/around the spot (never flee into/along water)
        //   − height change (don't leap into pits)
        // Returns the best standable spot (solid ground + 2 air) to path to, or null if none
        // scan up — caller then falls back to the simple away-vector.
        safeFleeTarget: function (bot) {
            try {
                const WSET = ['water', 'flowing_water'];
                const LAVA = ['lava', 'flowing_lava'];
                const isAirish = (b) => b && (b.name === 'air' || b.name === 'cave_air' || b.name.includes('grass') || b.name === 'fern' || b.name.includes('snow'));
                const isSolid = (b) => b && b.boundingBox === 'block' && !WSET.includes(b.name) && !LAVA.includes(b.name);
                const mobs = Object.values(bot.entities).filter(e => e && e.position && mc.isHostile(e) && e.position.distanceTo(bot.entity.position) < 22);
                if (mobs.length === 0) return null;
                const p = bot.entity.position.floored();
                let best = null, bestScore = -1e9;
                const DIRS = 10;
                for (let a = 0; a < DIRS; a++) {
                    const ang = (a / DIRS) * Math.PI * 2;
                    const ux = Math.cos(ang), uz = Math.sin(ang);
                    for (const dist of [6, 11]) {
                        const ddx = Math.round(ux * dist), ddz = Math.round(uz * dist);
                        // Find a standable spot in this column (first solid from top with 2 air above).
                        let cand = null;
                        for (let dy = 3; dy >= -4; dy--) {
                            const g = bot.blockAt(p.offset(ddx, dy, ddz));
                            if (!g) continue;
                            if (isSolid(g)) {
                                const a1 = bot.blockAt(p.offset(ddx, dy + 1, ddz));
                                const a2 = bot.blockAt(p.offset(ddx, dy + 2, ddz));
                                if (isAirish(a1) && isAirish(a2)) cand = p.offset(ddx, dy + 1, ddz);
                                break; // first solid top in column
                            }
                        }
                        if (!cand) continue;
                        let score = 0, minMob = 1e9, closeMobs = 0;
                        for (const m of mobs) {
                            const d = m.position.distanceTo(cand);
                            if (d < minMob) minMob = d;
                            if (d < 6) closeMobs++;
                        }
                        score += minMob * 3;            // farther from nearest threat = better
                        score -= closeMobs * 30;        // NEVER flee into a cluster
                        // water scoring: normally AVOID (drowned ambush / slow), but vs an
                        // angry ENDERMAN water is the sanctuary — it takes damage in water
                        // and will not pursue (死276+今日复发,激怒小黑追杀连击,走位甩不掉
                        // 瞬移;人类标准操作=跳水). Invert the water term in that case.
                        let water = 0;
                        for (const [ox, oz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
                            const f = bot.blockAt(cand.offset(ox, 0, oz));
                            const u = bot.blockAt(cand.offset(ox, -1, oz));
                            if (f && WSET.includes(f.name)) water += 2;
                            if (u && WSET.includes(u.name)) water += 1;
                        }
                        const endermanClose = mobs.some(m => /enderman/i.test(m.name || '') && m.position.distanceTo(bot.entity.position) < 8);
                        // 死278十分钟后就教了课: 水甩掉了 enderman 但溺尸在水里接锅(hp3 两下
                        // 带走)。水庇护只在该片水没有 drowned 时成立。
                        const drownedNearCand = mobs.some(m => /drowned/i.test(m.name || '') && m.position.distanceTo(cand) < 10);
                        score += (endermanClose && !drownedNearCand) ? water * 20 : -water * 15;   // enderman→water sanctuary (unless drowned); else avoid
                        score -= Math.abs((cand.y) - p.y) * 2; // prefer level ground
                        if (score > bestScore) { bestScore = score; best = cand; }
                    }
                }
                return best;
            } catch (e) { return null; }
        },
        shouldFlee: function (bot) {
            const hostiles = this.nearbyHostiles(bot);
            // RANGED THREAT (check FIRST — skeletons shoot from beyond the 10-block melee
            // bubble, so the nearbyHostiles check below would return false and we'd just stand
            // and get plinked from 14+ blocks: the repeated "shot by Skeleton" deaths). If a
            // skeleton/stray is within 16, we've been hit recently, and we have no shield to
            // block arrows → FLEE so the dispatch's run-fallback can 蛇皮走位 toward cover.
            const _hurt = Date.now() - bot.lastDamageTime < 3000;
            const _shield0 = bot.inventory.items().some(i => i.name === 'shield') || (bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield');
            if (this.coveredNightHoldStatus(bot).hold) return false;
            // ★POINT-BLANK EXCEPTION (death #263, must beat the ranged-flee check below):
            // ONE non-creeper hostile already inside melee reach while we hold a weapon →
            // do NOT flee/wall — return false so self_defense takes it. At 1.6-4b a
            // skeleton beats every other option: walls don't block point-blank arrows,
            // shaft terrain blocks flight, and standing passive = shot dead (the #263
            // tape: 20s jittering in a 1-block box, sword in bag, never drawn). Melee
            // knockback interrupts the bow cycle — that duel is winnable at ANY hp.
            // Strictly ONE attacker <4.5b with no second hostile inside 8b: against a
            // pack, fleeing/walling is still right.
            {
                const _HR0 = /zombie|skeleton|creeper|spider|witch|drowned|husk|stray|pillager|vindicator|cave_spider/i;
                const _near8 = Object.values(bot.entities).filter(e =>
                    e && e.position && e.name && _HR0.test(e.name) && e.position.distanceTo(bot.entity.position) < 8);
                if (_near8.length === 1 && !/creeper/i.test(_near8[0].name)
                    && _near8[0].position.distanceTo(bot.entity.position) < 4.5
                    && bot.inventory.items().some(i => /_sword$|_axe$/.test(i.name))) return false;
            }
            if (!_shield0 && _hurt && Object.values(bot.entities).some(e => e && e.position && /skeleton|stray/i.test(e.name || '') && e.position.distanceTo(bot.entity.position) < 16)) return true;
            if (hostiles.length === 0) return false;
            // CREEPER: never let one get close — meleeing it = it explodes = death.
            // Always back away from a creeper within 6 (shieldFight also avoids, but
            // fleeing here is higher priority so we disengage before it detonates).
            if (hostiles.some(e => (e.name || '').toLowerCase().includes('creeper') && e.position.distanceTo(bot.entity.position) < 8)) return true;
            const hasWeapon = bot.inventory.items().some(i => /_sword$|_axe$/.test(i.name));
            const hasShield = bot.inventory.items().some(i => i.name === 'shield') || (bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield');
            const recentlyHurt = Date.now() - bot.lastDamageTime < 3000;
            // With a sword AND shield we can actually WIN (block arrows/hits, close,
            // strike) — don't flee, let self_defense's shieldFight take it. Only flee
            // when truly outmatched: critically low, or genuinely swarmed (3+).
            if (hasWeapon && hasShield) return bot.health < 7 || hostiles.length >= 3;
            // No shield: stay conservative (can't block arrows) — flee if can't win.
            const cantWin = !hasWeapon || bot.health < 14 || hostiles.length >= 2;
            const closest = Math.min(...hostiles.map(e => e.position.distanceTo(bot.entity.position)));
            return cantWin && (recentlyHurt || bot.health < 14 || closest < 5);
        },
        isDay: function (bot) { try { return !bot.time || bot.time.timeOfDay < 13000 || bot.time.timeOfDay > 23000; } catch (e) { return true; } },
        // ★SMART FLEE MOVE (fixes "逃跑乱跳卡台阶/树"): the old raw flee held jump=true every tick
        // → on jungle terraces/dug steps/trees the bot bounced erratically and snagged. A human
        // runs flat, hops ONLY a real 1-block step in front, and STEERS AROUND a 2-block obstacle
        // (tree/wall) instead of ramming it. Face target, forward+sprint always; jump only on a
        // foot-blocked-but-head-clear step; if foot+head both blocked, turn ~60° aside (don't ram).
        fleeMove: async function (bot, target) {
            // Run toward `target` (an away-from-threat point) but go AROUND obstacles, don't ram
            // them. (用户诊断: 前方上方树叶挡住,bot 一根筋直冲撞树叶卡死/原地挥手,而不是向左绕。)
            // The OLD logic only handled a FOOT block (foot-blocked→hop, foot+head→turn) and MISSED
            // the "head blocked, foot clear" case (overhanging leaves/branch) → it fell through to
            // jump=false and rammed straight into the canopy and snagged. NEW: probe the straight
            // heading, then fan out ±45°/±90°, and take the first heading whose HEAD is clear (a
            // blocked head = tree/leaves/wall — walking into it just snags). Jump ONLY for a real
            // 1-block step (foot blocked, head clear); never on flat ground (kills the乱跳). Steering
            // by choosing the heading (not look(yaw+offset) every tick) avoids fighting lookAt.
            const me = bot.entity.position;
            let dx = (target.x + 0.5) - me.x, dz = (target.z + 0.5) - me.z;
            const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
            const sol = (b) => b && b.boundingBox === 'block';
            // ★WATER-BLIND FLEE killed twice (198+202, same shape: night kite "Can't seal →
            // running" steered INTO a river — water probes as "clear" since it's not solid —
            // where the bot is slow and drowned mobs own the fight; caught at 1.5 blocks).
            // A fleeing human never jumps into water with melee mobs behind. Treat watery
            // headings (1 and 2 cells out) as BLOCKED in the fan-out; only swim if EVERY
            // heading is wet (peninsula/island — then water genuinely beats the swarm).
            const wet = (b) => b && /water/.test(b.name || '');
            // drop probe: >3 blocks of air under the 1-cell-ahead landing spot = a ledge
            // (death 214: hp6 night flee off an 18-block cave drop — the foot/head/water
            // probes never looked DOWN; #17's ledge logic lived in the old flee path only).
            const droppy = (ux, uz) => {
                for (let dd = 1; dd <= 4; dd++) {
                    const b = bot.blockAt(me.offset(ux * 1.6, -dd, uz * 1.6));
                    if (b && (b.boundingBox === 'block' || /water/.test(b.name || ''))) return false; // floor (or water cushion) within 4
                }
                return true;
            };
            const probe = (ux, uz) => ({
                foot: sol(bot.blockAt(me.offset(ux * 1.1, 0, uz * 1.1))),
                head: sol(bot.blockAt(me.offset(ux * 1.1, 1, uz * 1.1))),
                water: wet(bot.blockAt(me.offset(ux * 1.1, 0, uz * 1.1))) || wet(bot.blockAt(me.offset(ux * 2.2, 0, uz * 2.2)))
                    || wet(bot.blockAt(me.offset(ux * 1.1, -1, uz * 1.1))),
                drop: droppy(ux, uz),
            });
            let hx = dx, hz = dz, needJump = true;   // boxed-in fallback: jump + push straight
            let _found = false;
            for (const pass = { dry: true }, arr = [true, false]; arr.length && !_found;) {
                pass.dry = arr.shift();
                for (const a of [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2]) {
                    const ca = Math.cos(a), sa = Math.sin(a);
                    const ux = dx * ca - dz * sa, uz = dx * sa + dz * ca;   // rotate desired heading by a
                    const p = probe(ux, uz);
                    if (!p.head && !p.drop && (!pass.dry || !p.water)) { hx = ux; hz = uz; needJump = p.foot; _found = true; break; }   // head clear + no ledge (+dry on first pass) → run
                }
            }
            try { await bot.lookAt(me.offset(hx * 4, 1.6, hz * 4), true); } catch (e) {}
            try {
                bot.setControlState('forward', true);
                bot.setControlState('sprint', true);
                bot.setControlState('jump', needJump);
                bot.setControlState('left', false); bot.setControlState('right', false); bot.setControlState('back', false); // clear stray strafe (skel weave), keep forward/sprint
            } catch (e) { try { bot.setControlState('jump', true); } catch (e2) {} }
        },
        shouldNightShelter: function (bot) {
            // ★PROACTIVE NIGHT INSTINCT (用户诊断: bot 没夜晚意识——天黑还慢悠悠挖,直到被怪偷袭
            // 致死;要"入夜主动转生存,而不是等到遇到怪再反应"). The OLD code required a mob to be
            // ALREADY near (`hostiles.length===0 → return false`) = purely REACTIVE → mobs spawn
            // in the dark and ambush before we'd ever detect them. NOW: at NIGHT on the EXPOSED
            // surface, shelter REGARDLESS of whether a mob is visible yet. This is a reflex (fires
            // EVERY tick) so it also triggers mid-operation — the resource-layer holeUpAtNight only
            // checked at task boundaries and missed nightfall during a long chop/mine (the
            // "挖着挖着天黑被偷袭" window). Underground (y<50) is already safe; daytime handled by isDay.
            if (this.isDay(bot)) return false;
            if (bot.entity.position.y < 50) return false;
            // ★ENCLOSED override (用户: "全知视角判断是否处在封闭地穴——是的话夜里不需要
            // 停"。y<50 是"地下=安全"的代理变量,漏掉了 y≥50 的崖体隧道/封闭洞——bot 在
            // 全实心包围里被当地表暴露,整夜蹲坑停工。状态机的 enclosed(3x3列探测)直接
            // 回答这个问题: 封闭=夜晚白天没区别,继续干活。近身威胁仍由 shouldFlee/
            // bunkerDown 的怪压分支兜底——enclosed 只豁免"无怪也要预防性蹲坑"。)
            if (bot._mobility && bot._mobility.enclosed) return false;
            // ★GEAR-AWARE (用户: 有铁剑+盾却被僵尸打死). The unconditional `return true` made
            // self_preservation bunker/flee EVERY night → self_defense (lower priority) never got
            // to fight → an EQUIPPED bot never used its sword+shield, just fled, and when the
            // bunker couldn't seal (water edge) it got caught by the swarm and died. Now mirror
            // shouldFlee's win-condition: if we can WIN (sword + shield + decent HP, not a 3+
            // swarm) DON'T shelter — let self_defense stand and kill the mobs (a human with iron
            // sword+shield drops 1-2 zombies trivially). Only bunker when NAKED/weak/swarmed
            // (the early-game case the night instinct was actually for).
            const hasSword = bot.inventory.items().some(i => /_sword$/.test(i.name));
            const hasShield = bot.inventory.items().some(i => i.name === 'shield') || (bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield');
            const swarm = this.nearbyHostiles(bot).length;
            const canWin = hasSword && hasShield && bot.health >= 8 && swarm < 3;
            return !canWin;
        },
        // EMERGENCY BUNKER (shared by night-shelter AND the outmatched-at-night flee):
        // dig DOWN into solid ground and seal, breaking all contact with a mob swarm.
        // In this mob-dense water world, surface-fleeing just runs into MORE mobs and
        // eventually gets cornered/killed — digging down + capping is the only reliable
        // escape. Robust at a water edge (dig 4 to get below the water table into solid
        // rock; cap the head; seal open sides; blockless L-niche fallback when naked).
        bunkerDown: async function (agent) {
            const bot = agent.bot;
            // ★OSCILLATION BREAKER (the 300ms "securing ↔ Can't seal ↔ running" thrash,
            // 03:47, 13min of standstill): with NO mobs around, a failed bunker re-fired
            // every mode tick, and each refire's interrupt starved the skill layer
            // (prepNether's own hole-up never got 2 consecutive seconds to run; progress
            // froze). After a no-mob failure, COOL DOWN 45s: the skill layer has a full
            // dug-in implementation (bare-hand capable) — let it work. Under actual mob
            // pressure the cooldown does not apply (kiting/sealing stays available).
            if (Date.now() < (this.bunkerCooldownUntil || 0)) {
                // during cooldown only a TRUE close threat (<5b, or creeper <8b) re-opens
                // bunkering; loitering mobs that can't reach us don't get to keep
                // preempting the escape work (the chimney-top 1.5h "one swing then stop").
                const _close = this.nearbyHostiles(bot).some(e => e.position && e.position.distanceTo(bot.entity.position) < 5)
                    || this.nearestCreeper(bot, 8);
                if (!_close) return;
            }
            // ★ALREADY-IN-A-CAVE: NO self-sealing (用户: "夜里在矿底下能不能别再封路了?
            // 封路后就出不来" — the bot sealed itself inside a deep cliff hole at night,
            // then spent the whole next day bare-hand chewing its own caps back out,
            // re-sealing them again each dusk: a self-built tomb-door loop). If there is
            // already NATURAL cover overhead (solid blocks within 5 above head height)
            // and no hostile within 6, we are in a cave/pit — the terrain IS the bunker.
            // Stay put; do not place a single block.
            try {
                const pC = bot.entity.position;
                let covered = false;
                for (let dyC = 2; dyC <= 6; dyC++) {
                    const bC = bot.blockAt(pC.offset(0, dyC, 0));
                    if (bC && bC.boundingBox === 'block') { covered = true; break; }
                }
                const nightHold = this.coveredNightHoldStatus(bot);
                const quietCovered = covered && !this.nearbyHostiles(bot).some(e => e.position && e.position.distanceTo(pC) < 6);
                if (nightHold.hold || quietCovered) {
                    // DWELL, don't fast-return: an instant return re-fires the mode every
                    // ~300ms ("Nightfall securing" spam round 3) and the interrupt storm
                    // starves every other system. We're sheltered — sit 5s per pass.
                    if (Date.now() - (this._nightDwellAt || 0) > 30000) {
                        this._nightDwellAt = Date.now();
                        try {
                            fs.appendFileSync('bots/_supervisor/progress.txt',
                                `[${new Date().toISOString()}] [self_preservation] night bunker dwell: covered=true hold=${nightHold.hold} hp=${Math.round(bot.health)} food=${bot.food} hostiles=${this.nearbyHostiles(bot).length} closest=${Number.isFinite(nightHold.closest) ? nightHold.closest.toFixed(1) : '-'} creeper=${Number.isFinite(nightHold.creeperDist) ? nightHold.creeperDist.toFixed(1) : '-'}\n`);
                        } catch (e) {}
                    }
                    await new Promise(r => setTimeout(r, 5000));
                    return;
                }
            } catch (e) {}
            const OPENISH = ['air', 'cave_air', 'water', 'flowing_water', 'short_grass', 'tall_grass'];
            // ANY placeable solid we carry — CRUCIALLY including planks/logs/wood. A fresh
            // respawn is wood-only (no stone/dirt yet); the old list omitted wood, so
            // fillerOf() returned nothing → the bot couldn't cap/wall its shelter → it just
            // spammed "digging in" and bled out to a single zombie. A human walls up with
            // whatever's in hand — so do we: planks and logs seal a bunker just fine.
            const FILL_RE = /cobblestone|cobbled|deepslate|^dirt$|andesite|diorite|granite|^stone$|tuff|gravel|^sand$|netherrack|_planks$|_log$|_wood$|^planks$|hyphae|^mud$|^clay$|terracotta|^dirt_path$|coarse_dirt|rooted_dirt|mossy/;
            const fillerOf = () => { const c = world.getInventoryCounts(bot); return Object.keys(c).find(n => c[n] > 0 && FILL_RE.test(n)); };
            try { bot.clearControlStates(); } catch (e) {}
            // ★ STEP ONTO DRY LAND FIRST (the human move at a water edge). The endless
            // "Can't seal" came from trying to dig DOWN where we stand — but the spawn is a
            // water edge, so the block below is water and digDown can't descend → never seals.
            // A human just steps a couple blocks onto solid ground and digs there. If our feet
            // aren't over diggable solid ground, scan ≤5 blocks for the nearest dry, solid,
            // standable spot and walk to it before digging. (Digging gives the dirt we cap with
            // — no pre-stocked blocks needed.)
            const _isWater = (b) => b && /water/.test(b.name || '');
            const _AIR = ['air', 'cave_air', 'short_grass', 'tall_grass', 'fern', 'snow'];
            const _diggableUnderFeet = () => { const below = bot.blockAt(bot.entity.position.offset(0, -1, 0)); return below && below.boundingBox === 'block' && !_isWater(below); };
            if (!_diggableUnderFeet()) {
                // ★INSTANT-BUNKER reach (user-requested): the water-edge spawn often has NO dry
                // ground within a few blocks — the old ≤5 scan failed, so the naked bot couldn't
                // dig+cap and bled out / ran into the swarm. Widen to ≤14 AND prefer DIRT-FAMILY
                // ground (grass/dirt/sand/gravel) — the only blocks a TOOL-LESS bot can dig to
                // yield its OWN cap material (the whole point of the instant bunker: mine your
                // ceiling as you descend, zero pre-stocked blocks). Stone is useless naked (digs
                // to nothing). Pick the nearest dirt-family standable spot; fall back to nearest
                // any-solid only if no dirt exists. Reaching diggable dirt is what makes the
                // dig-2-and-cap below reliably seal a naked respawn at this spawn.
                const DIRT_RE = /grass_block|^dirt$|coarse_dirt|rooted_dirt|dirt_path|podzol|mycelium|^mud$|^clay$|^sand$|red_sand|gravel|moss_block|snow_block|farmland/;
                const p0 = bot.entity.position.floored();
                let bestDirt = null, bdDirt = 1e9, bestAny = null, bdAny = 1e9;
                // ★Under an ACTIVE swarm, DON'T commit to a long relocate — walking 14 blocks
                // through zombies to find dirt got the naked bot cornered and killed (death rate
                // DOUBLED when this was unconditional ≤14). Keep it LOCAL (≤5) under threat so we
                // fail fast to kite/run; only search WIDE when the area is clearish (dusk, getting
                // ahead of night) where reaching dirt to instant-bunker is actually safe.
                const _HRE = /zombie|skeleton|spider|creeper|witch|drowned|husk|stray|enderman|slime|phantom|pillager|vindicator|silverfish/i;
                const _swarm = Object.values(bot.entities).filter(e => e && e.position && e.name && _HRE.test(e.name) && e.position.distanceTo(bot.entity.position) < 10).length;
                const R = _swarm >= 2 ? 5 : 14;
                for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
                    const d2 = dx * dx + dz * dz; if (d2 < 1) continue;
                    for (let dy = 3; dy >= -4; dy--) {
                        const g = bot.blockAt(p0.offset(dx, dy, dz));
                        if (!g) continue;
                        if (g.boundingBox === 'block' && !_isWater(g)) {   // first solid top in column
                            const a1 = bot.blockAt(p0.offset(dx, dy + 1, dz)), a2 = bot.blockAt(p0.offset(dx, dy + 2, dz));
                            if (a1 && _AIR.includes(a1.name) && a2 && _AIR.includes(a2.name)) {
                                const spot = p0.offset(dx, dy + 1, dz);
                                if (DIRT_RE.test(g.name)) { if (d2 < bdDirt) { bestDirt = spot; bdDirt = d2; } }
                                else if (d2 < bdAny) { bestAny = spot; bdAny = d2; }
                            }
                            break;
                        }
                    }
                }
                const best = bestDirt || bestAny;   // dirt first (diggable naked) → any solid fallback
                if (best) { try { await skills.goToPosition(bot, best.x, best.y, best.z, 0); } catch (e) {} }
            }
            const y0 = Math.floor(bot.entity.position.y);
            // SPEED MATTERS: under a swarm we lose ~1hp per dig-tick, so get SEALED ASAP.
            // Dig just 2 down (bot ends 2 below the surface, out of melee reach from above)
            // then IMMEDIATELY cap the opening. 2-deep+capped is fully safe (mobs can't path
            // in or hit down a 1-wide capped shaft); digging 4 took too long and the bot
            // bled out at ~hp6 mid-dig. Deeper/side-sealing happens AFTER we're capped.
            for (let d = 0; d < 2 && Math.floor(bot.entity.position.y) > y0 - 2; d++) {
                const before = Math.floor(bot.entity.position.y);
                try { await skills.digDown(bot, 1); } catch (e) {}
                if (Math.floor(bot.entity.position.y) >= before) break; // couldn't descend (water/lava/stuck) — stop
            }
            let p = bot.entity.position.floored();
            // CAP FIRST (highest priority — this is what actually stops the swarm). FASTEST
            // possible: ≤4 tries 60ms apart, RE-READING our position each pass (a 3-4 mob swarm
            // knocks the bot around mid-place), stop the instant the head is covered. The old
            // 6×150ms (~0.9s) was too slow — at ~1hp/tick under a swarm the naked bot bled out
            // before the cap landed (the recurring "Can't seal here" → 连死). Speed = survival.
            for (let i = 0; i < 4; i++) {
                const head2 = bot.blockAt(p.offset(0, 2, 0));
                if (head2 && !OPENISH.includes(head2.name)) break;
                const f = fillerOf(); if (!f) break;
                try { await skills.placeBlock(bot, f, p.x, p.y + 2, p.z, 'bottom', true); } catch (e) {}
                await new Promise(r => setTimeout(r, 60));
                p = bot.entity.position.floored();
            }
            // Now (sealed/safer) dig 2 more down for water-table robustness, re-capping if the
            // descent reopened the head. Skip if we couldn't descend at all (hit water/rock).
            for (let d = 0; d < 2 && Math.floor(bot.entity.position.y) > y0 - 4; d++) {
                const before = Math.floor(bot.entity.position.y);
                try { await skills.digDown(bot, 1); } catch (e) {}
                if (Math.floor(bot.entity.position.y) >= before) break;
            }
            p = bot.entity.position.floored();
            for (let i = 0; i < 4; i++) {   // re-cap after deepening — same fast cadence as above
                const head2 = bot.blockAt(p.offset(0, 2, 0));
                if (head2 && !OPENISH.includes(head2.name)) break;
                const f = fillerOf(); if (!f) break;
                try { await skills.placeBlock(bot, f, p.x, p.y + 2, p.z, 'bottom', true); } catch (e) {}
                await new Promise(r => setTimeout(r, 60));
                p = bot.entity.position.floored();
            }
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                for (const dy of [0, 1]) {
                    const c = bot.blockAt(p.offset(dx, dy, dz));
                    if (c && OPENISH.includes(c.name)) {
                        const f = fillerOf(); if (!f) break;
                        try { await skills.placeBlock(bot, f, p.x + dx, p.y + dy, p.z + dz, 'bottom', true); } catch (e) {}
                    }
                }
            }
            const headOpen = () => { const h = bot.blockAt(bot.entity.position.offset(0, 2, 0)); return !h || OPENISH.includes(h.name); };
            if (headOpen() && !fillerOf()) {
                for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const pp = bot.entity.position.floored();
                    const roof = bot.blockAt(pp.offset(dx, 2, dz));
                    if (!roof || OPENISH.includes(roof.name)) continue;
                    for (let step = 1; step <= 2; step++) {
                        const q = bot.entity.position.floored();
                        for (const cell of [q.offset(dx, 1, dz), q.offset(dx, 0, dz)]) {
                            const b = bot.blockAt(cell);
                            if (b && !OPENISH.includes(b.name)) { try { await bot.dig(b); } catch (e) {} }
                        }
                        try { await skills.goToPosition(bot, q.x + dx, q.y, q.z + dz, 0); } catch (e) {}
                    }
                    break;
                }
            }
            // DID WE ACTUALLY SEAL? A fresh respawn is naked — no pickaxe, so digDown hits
            // stone it CAN'T break ("Don't have right tools to break stone"), and it often has
            // no placeable block either. Then every dig+cap above is a no-op: the bot stands in
            // a half-dug hole and the swarm whittles it to death while it spams "digging in"
            // (exactly the loop we kept seeing). Per the user's rule — "判断形势：打不过就
            // 一直跑或者造避难所" — building the shelter is plan A; if we COULDN'T build it,
            // plan B is to RUN, not stand here and bleed out.
            const headBlocked = () => { const h = bot.blockAt(bot.entity.position.offset(0, 2, 0)); return h && !OPENISH.includes(h.name); };
            // ★WATER-EDGE FALLBACK — build UP when we can't dig DOWN. This is THE fix for the
            // endless "bunkering → can't seal → running" thrash that got the bot killed ~1/min:
            // it's a WATER WORLD and the spawn is a water edge, so digging down just floods and
            // never seals. So pillar UP on our own blocks (2 high) and box ourselves in (cap +
            // 4 walls) = a sealed platform that zombies/skeletons/creepers can't reach. A naked
            // respawn has dirt from digging; works anywhere we have filler.
            if (!headBlocked() && fillerOf()) {
                for (let up = 0; up < 2 && fillerOf(); up++) {
                    const fb = fillerOf();
                    try { await skills.placeBlockUnderFeet(bot, fb, { retries: 1, settleMs: 160 }); } catch (e) { try { bot.setControlState('jump', false); } catch (e2) {} }
                    await new Promise(r => setTimeout(r, 160));
                }
                const q = bot.entity.position.floored();
                for (let i = 0; i < 4; i++) {                       // cap head
                    const h2 = bot.blockAt(q.offset(0, 2, 0));
                    if (h2 && !OPENISH.includes(h2.name)) break;
                    const f = fillerOf(); if (!f) break;
                    try { await skills.placeBlock(bot, f, q.x, q.y + 2, q.z, 'bottom', true); } catch (e) {}
                    await new Promise(r => setTimeout(r, 140));
                }
                for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { // wall 4 sides (feet+head)
                    for (const dy of [0, 1]) {
                        const c = bot.blockAt(q.offset(dx, dy, dz));
                        if (c && OPENISH.includes(c.name)) { const f = fillerOf(); if (!f) break; try { await skills.placeBlock(bot, f, q.x + dx, q.y + dy, q.z + dz, 'bottom', true); } catch (e) {} }
                    }
                }
            }
            if (!headBlocked()) {
                const nightHold = this.coveredNightHoldStatus(bot);
                if (nightHold.hold) {
                    if (Date.now() - (this._coveredSealFailHoldAt || 0) > 12000) {
                        this._coveredSealFailHoldAt = Date.now();
                        try {
                            fs.appendFileSync('bots/_supervisor/progress.txt',
                                `[${new Date().toISOString()}] [self_preservation] covered seal-fail hold: hp=${Math.round(bot.health)} food=${bot.food} hostiles=${nightHold.hostiles} closest=${Number.isFinite(nightHold.closest) ? nightHold.closest.toFixed(1) : '-'} creeper=${Number.isFinite(nightHold.creeperDist) ? nightHold.creeperDist.toFixed(1) : '-'}\n`);
                        } catch (e) {}
                    }
                    try { bot.clearControlStates(); } catch (e) {}
                    await new Promise(r => setTimeout(r, 3000));
                    return;
                }
                // seal failed with no mobs in sight → back off 45s (see cooldown at entry)
                // instead of kiting nothing / re-firing every tick.
                if (this.nearbyHostiles(bot).length === 0 && !this.nearestCreeper(bot, 12)) {
                    this.bunkerCooldownUntil = Date.now() + 45000;
                    say(agent, 'Can\'t seal here, no mobs — standing down, skill-layer dig-in owns it.');
                    return;
                }
                // ★WITH-MOB oscillation breaker (the C18 gap): mobs present + seal fails +
                // the kite exits instantly on a concurrent interrupt → re-fire every tick,
                // and EACH refire preempts whatever escape work (ceiling chew / pillar) was
                // running — "does one swing then stops" for 1.5h on a chimney top. If we
                // fail to seal at the SAME spot 3 times running, the environment hasn't
                // changed: cool down 30s so the skill layer gets a contiguous window.
                // self_defense / point-blank reflexes are untouched by this cooldown.
                {
                    const pk = `${Math.floor(bot.entity.position.x)},${Math.floor(bot.entity.position.z)}`;
                    if (this._sealFailPos === pk) this._sealFailN = (this._sealFailN || 0) + 1;
                    else { this._sealFailPos = pk; this._sealFailN = 1; }
                    if (this._sealFailN >= 3) {
                        this._sealFailN = 0;
                        this.bunkerCooldownUntil = Date.now() + 30000;
                        say(agent, 'Can\'t seal here (3x) — standing down 30s, let the escape work run.');
                        return;
                    }
                }
                say(agent, 'Can\'t seal here — running from the swarm.');
                // Sprint directly AWAY from the hostiles' centroid, re-aiming each hop as they
                // move. Bounded (~12 hops) so it can never become its own loop; breaks the
                // instant we lose contact. Running relocates us — onto diggable dirt or out of
                // the spawn pocket — so the NEXT self_preservation tick may bunker successfully,
                // or the supervised grind resumes once we're clear. Staying ALIVE + moving beats
                // dying in place. Eat while moving to regen.
                //
                // INTERRUPT DISCIPLINE (do NOT reset interrupt_code inside this loop): when the
                // flee fails and the bot DIES mid-run, the executor requests a stop; the OLD code
                // reset interrupt_code every hop, which FOUGHT that stop, so "stop within 10s" was
                // refused and the whole agent process got KILLED ("Code execution refused stop
                // after 10 seconds") → restart → ~15s offline = churn by another name (a self-
                // inflicted death gap). Same class as the death_abort lesson: never battle the
                // stop. So: consume our own mode-activation interrupt ONCE on entry, then bail the
                // instant a NEW interrupt (death / respawn / framework stop) arrives.
                // ★KITE UNTIL DAWN (the human move — user: "真人遇险能一直灵活走位逃跑到天亮").
                // We CAN'T seal here (water edge). The OLD code ran 12 hops then RETURNED, so the
                // dispatch re-ran bunkerDown → tried to seal again → failed → ran again: that
                // pause-to-re-dig = standing still = caught and killed (the whole "bunkering ↔
                // Can't seal ↔ running" thrash). A human doesn't keep re-trying to dig in — they
                // just KEEP MOVING (flexible footwork toward the safest open ground, juking
                // skeletons) until DAWN, when the mobs burn. So: loop the WHOLE night, never
                // returning to re-bunker; exit only at daybreak (or interrupt/death/water).
                // Watchdog discipline: honor interrupt; say() periodically so agent.err stays
                // fresh (the freeze-watchdog's alive signal during this long loop).
                try { bot.interrupt_code = false; } catch (e) {}
                for (let kited = 0; kited < 4000 && !this.isDay(bot); kited++) {
                    if (bot.interrupt_code || bot.health <= 0) break;     // real stop / death — return promptly
                    // Only bail to the swim reflex if we're ACTUALLY DROWNING (low O2). Do NOT
                    // bail on merely standing in a shallow water-edge tile — that made the kite
                    // exit instantly at the water-edge spawn → re-bunker → kite → exit → a new
                    // thrash. safeFleeTarget already steers toward DRY land, so just keep kiting
                    // (wade out toward the dry target) unless we're truly going under.
                    if (bot.oxygenLevel !== undefined && bot.oxygenLevel <= 6) break;
                    const hs = this.nearbyHostiles(bot);
                    const cr = this.nearestCreeper(bot, 12);
                    if (hs.length === 0 && !cr) { try { bot.clearControlStates(); } catch (e) {} await new Promise(r => setTimeout(r, 1000)); continue; } // no mob → stop & keep watch (do NOT return = bunker-thrash)
                    // ★Do NOT clearControlStates here. The old per-iteration clear stopped forward/
                    // sprint right before fleeMove's lookAt(await) ran with forward=false — a stutter
                    // every cycle that cut average speed so a plain zombie caught the naked bot (died
                    // to mobs=1). Keep forward+sprint CONTINUOUS (like the creeper reflex that "sustains
                    // fine"); fleeMove just re-aims + manages jump. Strafe keys are cleared inside fleeMove.
                    const safe = this.safeFleeTarget(bot);
                    const skel = Object.values(bot.entities).some(e => e && e.position && /skeleton|stray/i.test(e.name || '') && e.position.distanceTo(bot.entity.position) < 16);
                    if (safe && skel) {
                        for (let s = 0; s < 3; s++) {                      // 蛇皮走位: weave toward safe ground, dodging arrows
                            if (bot.interrupt_code || bot.health <= 0 || this.nearbyHostiles(bot).length === 0) break;
                            try { await bot.lookAt(safe.offset(0.5, 0, 0.5), true); } catch (e) {}
                            try { bot.clearControlStates(); } catch (e) {}
                            bot.setControlState('forward', true);
                            bot.setControlState('sprint', true);
                            bot.setControlState(s % 2 === 0 ? 'left' : 'right', true);
                            bot.setControlState('jump', s % 2 === 0);
                            await new Promise(r => setTimeout(r, 220));
                        }
                        try { bot.clearControlStates(); } catch (e) {}
                    } else if (safe) {
                        // RAW sprint toward the safe spot (NOT goToPosition): pathfinder sets/
                        // checks interrupt_code and is slow to start, which broke the kite after
                        // ~1 iteration every time (Kiting count stayed 0 = never sustained → it
                        // returned → re-bunker thrash). Raw control keeps us continuously moving,
                        // like the creeper reflex (which sustains fine).
                        await this.fleeMove(bot, safe);   // smart: hop steps, steer around trees/walls, no乱跳
                        await new Promise(r => setTimeout(r, 200));   // keep moving — no clear (continuous sprint)
                    } else {
                        // No scanned-safe spot — sprint directly away from the swarm centroid.
                        let cx = 0, cz = 0; for (const e of hs) { cx += e.position.x; cz += e.position.z; } cx /= (hs.length || 1); cz /= (hs.length || 1);
                        const me = bot.entity.position;
                        let dx = me.x - cx, dz = me.z - cz; const len = Math.hypot(dx, dz) || 1; dx /= len; dz /= len;
                        await this.fleeMove(bot, me.offset(dx * 4, 0, dz * 4));   // smart: away from swarm, hop/steer not乱跳
                        await new Promise(r => setTimeout(r, 200));   // keep moving — no clear (continuous sprint)
                    }
                    const food = bot.inventory.items().find(i => /cooked_|_bread|^bread$|^apple$|carrot|potato|^beef$|porkchop|^chicken$|^mutton$|cod|salmon|_stew|baked_|rabbit/.test(i.name));
                    if (food && bot.food < 20) { try { await skills.consume(bot, food.name); } catch (e) {} }
                    if (kited % 8 === 7) { try { say(agent, 'Kiting the swarm till dawn…'); } catch (e) {} } // agent.err heartbeat (watchdog alive-signal)
                }
                try { bot.clearControlStates(); } catch (e) {}
                return;   // dawn / clear / interrupt — exit; the grind resumes by daylight
            }
            // Sealed OK — wait for daylight (bounded ~9 min), eating to regen meanwhile.
            // INTERRUPT DISCIPLINE (★the watchdog killer): action_manager.stop() calls
            // requestInterrupt() every 300ms (setting interrupt_code=true) and force-kills
            // the WHOLE process if our handler doesn't RETURN within 10s. mode handlers are
            // NOT auto-injected with interrupt checks (only LLM code is, via coder.js), so we
            // must honor it ourselves. The OLD loop RESET interrupt_code every 3s → it never
            // returned on a death/stop → "Code execution refused stop after 10s. Killing
            // process." → restart → ~15s offline = churn. Fix: consume our own activation
            // interrupt ONCE, then BREAK the instant a new one arrives (death/stop). Don't
            // reset inside. (If self_pres merely re-activates we just exit the wait and
            // re-evaluate next tick — safe; being killed mid-wait is not.)
            try { bot.interrupt_code = false; } catch (e) {}
            for (let w = 0; w < 110 && !this.isDay(bot); w++) {
                if (bot.interrupt_code || bot.health <= 0) break;   // real stop / death — return promptly, never refuse
                const food = bot.inventory.items().find(i => /cooked_|_bread|^bread$|^apple$|carrot|potato|^beef$|porkchop|^chicken$|^mutton$|baked_|_stew/.test(i.name));
                if (food && bot.food < 20) { try { await skills.consume(bot, food.name); } catch (e) {} }
                if (w % 10 === 0) {
                    try {
                        fs.appendFileSync('bots/_supervisor/progress.txt',
                            `[${new Date().toISOString()}] [self_preservation] sealed night hold: w=${w} hp=${Math.round(bot.health)} food=${bot.food}\n`);
                    } catch (e) {}
                }
                await skills.wait(bot, 3000);
            }
        },
        update: async function (agent) {
            const bot = agent.bot;
            if (famineBodyFreeze(agent, 'self_preservation')) return;
            // ★YIELD TO THE MARCH (the 60s act_trace tape: sp's night-bunker dwell held
            // `active` continuously, and the scheduler's active-break meant the MAROONED
            // march NEVER got a turn — right diagnosis, starved reaction. While the
            // mobility machine says we're entrapped, bunkering/fleeing are meaningless
            // (the terrain is the enemy); sp only keeps the body for a CLOSE threat.)
            if (bot._mobility && /MAROONED|ENTOMBED/.test(bot._mobility.state)) {
                const closeThreat = this.nearbyHostiles(bot).some(e => e.position && e.position.distanceTo(bot.entity.position) < 6);
                if (!closeThreat) return;
            }
            let block = bot.blockAt(bot.entity.position);
            let blockAbove = bot.blockAt(bot.entity.position.offset(0, 1, 0));
            if (!block) block = {name: 'air'}; // hacky fix when blocks are not loaded
            if (!blockAbove) blockAbove = {name: 'air'};
            const WSET = ['water', 'flowing_water'];
            const feetWater = WSET.includes(block.name);
            const headWater = WSET.includes(blockAbove.name);
            // ===== MLG WATER-BUCKET CLUTCH (highest-priority reflex) =================
            // Falling toward a fatal drop? If we carry a water bucket, slap water on the
            // block we're about to hit so we land in it and take ZERO fall damage — the
            // classic clutch a human does. This is the payoff of keeping a bucket after a
            // fall death (the adaptive prep). Fires before the water/hostile branches because
            // a long fall kills faster than anything. Re-fires each tick as we approach the
            // floor, so timing self-corrects; we scoop the water back after landing to keep
            // the bucket reusable.
            const _vy = bot.entity.velocity ? bot.entity.velocity.y : 0;
            if (!bot.entity.onGround && _vy < -0.45 && !feetWater && !headWater) {
                let drop = 0, floor = null;
                for (let d = 1; d <= 24; d++) {
                    const b = bot.blockAt(bot.entity.position.offset(0, -d, 0));
                    if (!b) continue;
                    if (WSET.includes(b.name)) { floor = null; break; }   // water below — already safe, no clutch
                    if (b.boundingBox === 'block') { drop = d; floor = b; break; }
                }
                if (floor && drop >= 4) {
                    const wb = bot.inventory.items().find(i => i.name === 'water_bucket');
                    if (wb) {
                        execute(this, agent, async () => {
                            say(agent, 'MLG water clutch!');
                            try { await bot.equip(wb, 'hand'); } catch (e) {}
                            try { await bot.look(bot.entity.yaw, -Math.PI / 2, true); } catch (e) {} // straight down
                            try { bot.activateItem(); } catch (e) {}                                  // place water below
                            for (let w = 0; w < 8 && !bot.entity.onGround; w++) await new Promise(r => setTimeout(r, 120));
                            // landed — PAUSE a beat before scooping (用户: 队友在看,瞬间收水
                            // 像闪现挂; 顿1.8s让人看清"垫水→落水→收水"的完整机制), then scoop
                            // the water back so we keep the bucket for next time.
                            await new Promise(r => setTimeout(r, 1800));
                            try {
                                const src = world.getNearestBlock(bot, 'water', 4);
                                if (src) { await bot.lookAt(src.position.offset(0.5, 0.5, 0.5), true); bot.activateItem(); }
                            } catch (e) {}
                        });
                        return;
                    }
                }
            }
            if (feetWater || headWater) {
                // ===== SWIMMING INSTINCT (hardcoded reflex, not a skill) ==========
                // The bot is in water. Three regimes, by situation:
                // ★Trigger EARLY (≤14, not ≤8). y51 deep-water deaths kept recurring (the death-
                // spiral IGNITER: drown underground with gear →裸装重生 → 连死): escaping a flooded
                // aquifer means chewing through rock toward the dug tunnel, which takes seconds. At
                // oxy≤8 there isn't enough air left to finish — by the time the reflex fired the bot
                // was already committed to dying. ≤14 ~doubles the escape window. Only affects y<55
                // deep water (the mining case); surface/river swims use the y≥55 branch, unaffected.
                const drowning = bot.oxygenLevel !== undefined && bot.oxygenLevel <= 14;
                const y0 = Math.floor(bot.entity.position.y);
                // Only defer to the pathfinder when it is ACTIVELY moving (a real path is
                // executing). A goal that's set-but-stuck must NOT block the swim reflex,
                // or the bot bobs in place forever behind a dead goal.
                const pathing = bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving();
                if (drowning && y0 < 55) {
                    // DEEP & out of air (flooded tunnel / aquifer): no shore to swim to.
                    // The OLD code only towered straight UP toward the distant surface —
                    // fatal at e.g. y-13 (76 blocks of rock to chew through while drowning),
                    // and it spun 11× "escaping up" while a cave spider finished us off. The
                    // air we actually need is the TUNNEL WE JUST DUG IN FROM — usually 2-3
                    // blocks HORIZONTALLY, not 76 up. So: seek the NEAREST reachable air
                    // pocket (biased horizontal, must have a solid floor to stand on) and
                    // path to it (pathfinder digs the short route). Tower-up only as a last
                    // resort when we're fully sealed in water/rock with no air anywhere near.
                    say(agent, 'Drowning — heading for air!');
                    execute(this, agent, async () => {
                        const AIRSET = ['air', 'cave_air', 'void_air'];
                        const isAirN = (b) => b && AIRSET.includes(b.name);
                        const nearestAir = () => {
                            const p = bot.entity.position.floored();
                            let best = null, bd = 1e9; const R = 6;
                            for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) for (let dy = R; dy >= -3; dy--) {
                                const d2 = dx * dx + dy * dy * 1.5 + dz * dz; // bias horizontal (cheaper/safer to reach than digging up)
                                if (d2 < 1 || d2 >= bd) continue;
                                const b = bot.blockAt(p.offset(dx, dy, dz));
                                if (isAirN(b)) {
                                    const below = bot.blockAt(p.offset(dx, dy - 1, dz));
                                    if (below && below.boundingBox === 'block') { best = p.offset(dx, dy, dz); bd = d2; } // standable air = our tunnel
                                }
                            }
                            return best;
                        };
                        for (let i = 0; i < 10 && (bot.oxygenLevel === undefined || bot.oxygenLevel < 16); i++) {
                            if (bot.interrupt_code) break;
                            const air = nearestAir();
                            if (air) {
                                try { await skills.goToPosition(bot, air.x, air.y, air.z, 0); } catch (e) {}
                                const hb = bot.blockAt(bot.entity.position.offset(0, 1, 0));
                                if (isAirN(hb) && bot.entity.onGround) break; // reached the air pocket
                            } else {
                                // Fully enclosed — last resort: dig straight up + pillar.
                                const head = bot.blockAt(bot.entity.position.offset(0, 2, 0));
                                if (head && !['air', 'cave_air', 'water', 'flowing_water'].includes(head.name)) { try { await bot.dig(head); } catch (e) {} }
                                try { await skills.pillarUp(bot, Math.floor(bot.entity.position.y) + 2); } catch (e) {}
                                bot.setControlState('jump', true);
                                await new Promise(r => setTimeout(r, 300));
                            }
                        }
                        try { bot.clearControlStates(); } catch (e) {}
                    });
                }
                else if (pathing && !drowning) {
                    // Deliberately swimming somewhere under pathfinder control (e.g.
                    // crossing a river toward a goal). Don't hijack — just hold jump so we
                    // ride the SURFACE instead of sinking and bleeding oxygen mid-crossing.
                    bot.setControlState('jump', true);
                }
                else if (y0 >= 55) {
                    // SURFACE / OPEN WATER (lake, river, shallow pool) or idle-bobbing.
                    // This is the instinct the bot lacked: it used to float in place at a
                    // lake surface (blockAbove=air, so the old check never even fired) until
                    // night + mobs killed it. Now: SWIM to the nearest dry land and climb
                    // out, holding jump the whole way so we never sink or drown. Gated to
                    // y>=55 (near surface, where a shore is actually reachable) so it can't
                    // hijack a CONTROLLED DEEP DIVE — underground, mineDiamonds seals/dodges
                    // aquifers itself; yanking the bot "to shore" from y40 (no shore exists)
                    // would just tower it back up and undo the descent.
                    say(agent, 'In water — getting out.');
                    execute(this, agent, async () => {
                        // ★trace (the #264-family hang has never been pinned down: the
                        // execute wedges somewhere in here while the bot floats. Cheap
                        // breadcrumbs to progress.txt so the NEXT float tells us WHERE.)
                        const _tr = (s) => { try { fs.appendFileSync('bots/_supervisor/progress.txt', `[${new Date().toISOString()}] [swim] ${s}\n`); } catch (e) {} };
                        _tr(`enter y=${Math.floor(bot.entity.position.y)}`);
                        const isWater = (b) => b && WSET.includes(b.name);
                        const AIRY = ['air', 'cave_air', 'void_air', 'short_grass', 'tall_grass', 'fern'];
                        const isAir = (b) => b && AIRY.includes(b.name);
                        const FILL = ['dirt', 'cobblestone', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'stone', 'tuff', 'gravel', 'sand', 'netherrack', 'deepslate'];
                        const filler = () => { const c = world.getInventoryCounts(bot); return FILL.find(n => (c[n] || 0) > 0) || Object.keys(c).find(n => /_planks$|_log$/.test(n) && c[n] > 0); };
                        const inWaterNow = () => isWater(bot.blockAt(bot.entity.position)) || isWater(bot.blockAt(bot.entity.position.offset(0, 1, 0)));
                        const findShore = () => {
                            const p = bot.entity.position.floored();
                            let best = null, bd = 1e9; const R = 20;
                            for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
                                const d2 = dx * dx + dz * dz; if (d2 < 2 || d2 >= bd) continue;
                                for (let dy = 3; dy >= -5; dy--) {
                                    const g = bot.blockAt(p.offset(dx, dy, dz));
                                    if (!g) continue;
                                    if (g.boundingBox === 'block' && !WSET.includes(g.name)) {
                                        const a1 = bot.blockAt(p.offset(dx, dy + 1, dz)), a2 = bot.blockAt(p.offset(dx, dy + 2, dz));
                                        if (isAir(a1) && isAir(a2)) { best = p.offset(dx, dy + 1, dz); bd = d2; }
                                        break;
                                    }
                                }
                            }
                            return best;
                        };
                        // ★FIX: the old code swam toward findShore's target forever — when the bank
                        // was unreachable (across deep water / behind a wall) it bobbed in place 80
                        // iters, re-fired, and NEVER got out ("swimming to shore" spam, water-locked).
                        // It only pillared when NO shore was found. Now: if we're NOT getting closer
                        // to the shore (stuck) OR there's no shore, and we carry blocks (we hoard
                        // dirt), PILLAR UP out of the water — the 100%-reliable escape. We have 40
                        // dirt; build a tower under our feet until we're standing dry. Swim only
                        // when we're actually making progress toward a reachable bank.
                        try { bot.interrupt_code = false; } catch (e) {}
                        let lastDist = 1e9, stall = 0, exploreTicks = 0, exploreYaw = bot.entity.yaw;
                        for (let i = 0; i < 80; i++) {
                            if (bot.interrupt_code || bot.health <= 0) { _tr(`exit@${i} interrupt=${!!bot.interrupt_code}`); break; }
                            if (!inWaterNow() && bot.entity.onGround) { _tr(`exit@${i} OUT ok`); break; }
                            if (i % 10 === 0) _tr(`i=${i} pos=${Math.floor(bot.entity.position.x)},${Math.floor(bot.entity.position.y)},${Math.floor(bot.entity.position.z)} stall=${stall}`);
                            const target = findShore();
                            let stuck = false;
                            if (target) {
                                const pp = bot.entity.position;
                                const d = Math.hypot((target.x + 0.5) - pp.x, (target.z + 0.5) - pp.z);
                                if (d >= lastDist - 0.15) stall++; else stall = 0; // not getting closer
                                lastDist = d;
                                if (stall >= 3) stuck = true;
                            }
                            const f = filler();
                            if ((!target || stuck) && f) {
                                // PILLAR UP — jump + place a block under our feet, rise out of water.
                                bot.setControlState('forward', false);
                                try { await skills.placeBlockUnderFeet(bot, f, { retries: 1, settleMs: 160 }); } catch (e) { try { bot.setControlState('jump', false); } catch (e2) {} }
                                await new Promise(r => setTimeout(r, 160));
                                stall = 0; lastDist = 1e9;
                            } else if (target && !stuck) {
                                try { await bot.lookAt(target.offset(0.5, 0, 0.5), true); } catch (e) {}
                                bot.setControlState('forward', true);
                                bot.setControlState('sprint', true);
                                bot.setControlState('jump', true);             // ride the surface
                                await new Promise(r => setTimeout(r, 220));
                            } else {
                                // ★FIX(water-lock + EMPTY inventory): no shore within R, OR stuck
                                // against an obstacle, AND no block to pillar with. The old code
                                // just bobbed in place ("stay afloat") → naked water-edge respawn
                                // never escaped, collected 0 wood, deadlocked forever. A water body
                                // is FINITE: COMMIT to a heading and swim hard (forward+sprint+jump
                                // to ride the surface); whenever we stall, rotate the heading ~72°
                                // to work around walls / out of a cove. This escapes any water-lock
                                // with ZERO blocks — the instinct must not depend on carried filler.
                                exploreTicks++;
                                if (exploreTicks % 6 === 0) { exploreYaw += Math.PI / 2.5; stall = 0; lastDist = 1e9; }
                                try { await bot.look(exploreYaw, -0.05, true); } catch (e) {}
                                bot.setControlState('forward', true);
                                bot.setControlState('sprint', true);
                                bot.setControlState('jump', true);             // ride the surface, don't sink
                                await new Promise(r => setTimeout(r, 220));
                            }
                        }
                        try { bot.clearControlStates(); } catch (e) {}
                    });
                }
                else {
                    // DEEP (y<55), in water, oxygen still OK, no active path: a controlled
                    // dive is in progress (mineDiamonds handling the aquifer) or we're in a
                    // cave pool. Don't hijack — just hold jump so we don't passively sink and
                    // start drowning; if oxygen does run out the drowning branch above fires.
                    bot.setControlState('jump', true);
                }
            }
            else if (this.fall_blocks.some(name => blockAbove.name.includes(name))
                || (blockAbove.boundingBox === 'block' && blockAbove.name !== 'lava')
                || (block.boundingBox === 'block' && block.name !== 'lava')) {
                // (third clause: FEET wedged in a solid block — doesn't suffocate but
                // freezes all movement; seen entombed in a cliff alcove, pathfinder
                // half-dug nook + interrupt storm. Dig free exactly like a head wedge.)
                execute(this, agent, async () => {
                    // ANY solid block in the bot's HEAD space = suffocation in progress.
                    // Originally this branch only matched sand/gravel (falling columns) —
                    // death #262 (blackbox): head wedged into plain stone during a
                    // dig-to-surface stair climb, self_preservation was ACTIVE but this
                    // branch didn't match, and the bot stood still holding a stone pickaxe
                    // while 2dmg/1.2s ground 7hp to 0 in 3.6s. Generalized: head block is
                    // solid → equip the right tool FIRST (bare-hand stone is 7.5s/block,
                    // far slower than suffocation kills; with the pick it's 0.6s) → dig the
                    // head space clear, eating a falling column if one feeds it. Then a
                    // best-effort step aside (swallow PathfindingFailed so it never
                    // thrashes).
                    // ★STEP-OUT FIRST (death #271: wedged into own placed cobble, bare-hand
                    // dig is 7.5s/block but suffocation kills in ~6s at hp10 — digging
                    // CANNOT win without a pick. Walking out of the cell stops the damage
                    // in ~0.5s. Try a quick sidestep toward any open neighbor BEFORE
                    // committing to the dig.)
                    {
                        const m0 = bot.entity.position.floored();
                        for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                            const a1 = bot.blockAt(m0.offset(sx, 0, sz)), a2 = bot.blockAt(m0.offset(sx, 1, sz));
                            const ok = (b) => !b || b.boundingBox !== 'block';
                            if (!ok(a1) || !ok(a2)) continue;
                            const fl = bot.blockAt(m0.offset(sx, -1, sz));
                            if (!fl || fl.boundingBox !== 'block') continue;
                            try { await bot.lookAt(m0.offset(sx + 0.5, 1.6, sz + 0.5), true); } catch (e) {}
                            bot.setControlState('forward', true); bot.setControlState('sprint', true);
                            await new Promise(r => setTimeout(r, 700));
                            try { bot.clearControlStates(); } catch (e) {}
                            break;
                        }
                    }
                    for (let i = 0; i < 8; i++) {
                        // head first (suffocation damage), then feet (movement lock)
                        const head = bot.blockAt(bot.entity.position.offset(0, 1, 0));
                        const feet = bot.blockAt(bot.entity.position);
                        const tgt = (head && head.boundingBox === 'block') ? head
                            : (feet && feet.boundingBox === 'block') ? feet : null;
                        if (!tgt) break;
                        try { await bot.tool.equipForBlock(tgt); } catch (e) {}
                        try { await bot.dig(tgt); } catch (e) { break; }
                        await new Promise(r => setTimeout(r, 200)); // let the next block fall in
                    }
                    try { await skills.moveAway(bot, 1); } catch (e) {}
                });
            }
            else if (block.name === 'lava' || block.name === 'fire' ||
                blockAbove.name === 'lava' || blockAbove.name === 'fire') {
                say(agent, 'I\'m on fire!');
                // if you have a water bucket, use it
                let waterBucket = bot.inventory.findInventoryItem('water_bucket');
                if (waterBucket) {
                    execute(this, agent, async () => {
                        let success = await skills.placeBlock(bot, 'water_bucket', block.position.x, block.position.y, block.position.z);
                        if (success) say(agent, 'Placed some water, ahhhh that\'s better!');
                    });
                }
                else {
                    execute(this, agent, async () => {
                        let waterBucket = bot.inventory.findInventoryItem('water_bucket');
                        if (waterBucket) {
                            let success = await skills.placeBlock(bot, 'water_bucket', block.position.x, block.position.y, block.position.z);
                            if (success) say(agent, 'Placed some water, ahhhh that\'s better!');
                            return;
                        }
                        let nearestWater = world.getNearestBlock(bot, 'water', 20);
                        if (nearestWater) {
                            const pos = nearestWater.position;
                            let success = await skills.goToPosition(bot, pos.x, pos.y, pos.z, 0.2);
                            if (success) say(agent, 'Found some water, ahhhh that\'s better!');
                            return;
                        }
                        await skills.moveAway(bot, 5);
                    });
                }
            }
            else if (this.coveredNightHoldStatus(bot).hold) {
                const hold0 = this.coveredNightHoldStatus(bot);
                if (Date.now() - (this._coveredNightHoldSayAt || 0) > 15000) {
                    this._coveredNightHoldSayAt = Date.now();
                    say(agent, `Covered night hold (${hold0.hostiles} mob, nearest ${Number.isFinite(hold0.closest) ? hold0.closest.toFixed(1) : '-'}m) — staying sealed.`);
                }
                execute(this, agent, async () => {
                    try { bot.clearControlStates(); } catch (e) {}
                    try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
                    try {
                        fs.appendFileSync('bots/_supervisor/progress.txt',
                            `[${new Date().toISOString()}] [self_preservation] covered night hold: hp=${Math.round(bot.health)} food=${bot.food} hostiles=${hold0.hostiles} closest=${Number.isFinite(hold0.closest) ? hold0.closest.toFixed(1) : '-'} creeper=${Number.isFinite(hold0.creeperDist) ? hold0.creeperDist.toFixed(1) : '-'}\n`);
                    } catch (e) {}
                    await skills.wait(bot, 3000);
                });
            }
            else if (this.creeperBackoffTarget(bot)) {
                // ===== CREEPER REFLEX (highest-priority hostile response) =============
                // A creeper is the ONE mob you must never bunker or melee beside: stopping
                // to dig a shelter (or trading blows) lets it close to ~3 blocks, fuse, and
                // detonate — which is exactly how we kept dying ("blown up by Creeper"). The
                // night-shelter / flee branches below would do precisely the wrong thing, so
                // this preempts them. The ONLY correct reflex is to put DISTANCE between us:
                // sprint directly away from the creeper until it's >9 blocks (fuse resets and
                // it stops tracking). No digging, no fighting — just back off. Watchdog
                // discipline: honor a real interrupt/death so we never refuse stop (churn).
                const cr0 = this.creeperBackoffTarget(bot) || this.nearestCreeper(bot);
                const cr0Dist = cr0 && cr0.position ? cr0.position.distanceTo(bot.entity.position) : Infinity;
                const hasNormalFood = bot.inventory.items().some(i => i && i.name && NORMAL_FOOD_RE.test(i.name));
                const lowHpNoRegenNoFood = bot.health <= 8 && bot.food < 18 && !hasNormalFood;
                const coveredOrEnclosed = (bot._mobility && bot._mobility.enclosed) || this.hasOverheadCover(bot, 2, 6);
                const hungryNoFoodCovered = bot.food <= 8 && !hasNormalFood && coveredOrEnclosed;
                if ((lowHpNoRegenNoFood || hungryNoFoodCovered) && coveredOrEnclosed && cr0Dist > 5.5) {
                    if (Date.now() - (this._creeperCoveredLowHpHoldAt || 0) > 5000) {
                        this._creeperCoveredLowHpHoldAt = Date.now();
                        try {
                            fs.appendFileSync('bots/_supervisor/progress.txt',
                                `[${new Date().toISOString()}] [self_preservation] creeper covered hunger hold: cdist=${cr0Dist.toFixed(1)} hp=${Math.round(bot.health)} food=${bot.food} enclosed=${!!(bot._mobility && bot._mobility.enclosed)} covered=${this.hasOverheadCover(bot, 2, 6)} lowHp=${lowHpNoRegenNoFood} — no calorie-burning backoff\n`);
                        } catch (e) {}
                    }
                    execute(this, agent, async () => {
                        try { bot.clearControlStates(); } catch (e) {}
                        try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
                        await skills.wait(bot, 2000);
                    });
                    return;
                }
                const tableHold = tableRecoveryHold(bot);
                if (tableHold && cr0Dist > 5.5) {
                    if (Date.now() - (this._creeperTableRecoveryHoldAt || 0) > 5000) {
                        this._creeperTableRecoveryHoldAt = Date.now();
                        try {
                            fs.appendFileSync('bots/_supervisor/progress.txt',
                                `[${new Date().toISOString()}] [self_preservation] creeper table-recovery hold: cdist=${cr0Dist.toFixed(1)} raw16=${tableHold.raw} layered16=${tableHold.layered} day=${!tableHold.isNight} — suppress raw backoff for advisory-nonactionable layered threat\n`);
                        } catch (e) {}
                    }
                    execute(this, agent, async () => {
                        try { bot.clearControlStates(); } catch (e) {}
                        try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
                        await skills.wait(bot, 2000);
                    });
                    return;
                }
                say(agent, `Creeper ${Math.round(cr0.position.distanceTo(bot.entity.position))}m — backing off!`);
                execute(this, agent, async () => {
                    try { bot.interrupt_code = false; } catch (e) {}   // consume activation interrupt once
                    // FAST raw sprint (NOT pathfinder — a creeper fuses in ~1.5s; goToPosition's
                    // startup latency got us blown up). safeFleeTarget = direction hint (away from
                    // ALL mobs + water); ledge-check so we don't sprint off a cliff.
                    // ★UNIFIED WITH KITE: a lone short 14-iter backoff (then return) let the broader
                    // zombie/skeleton swarm kill us between re-fires (the "Creeper backing off"
                    // thrash, hp→2). So in DAY we back off until the creeper is clear then resume;
                    // at NIGHT we MERGE into kite-till-dawn — keep moving from creeper+swarm
                    // continuously until daybreak, never returning to re-thrash.
                    let lastRunPos = bot.entity.position.clone();
                    let stuckRun = 0;
                    let sideFlip = 1;
                    let lastWedgeLog = 0;
                    for (let i = 0; i < 4000; i++) {
                        if (bot.interrupt_code || bot.health <= 0) break;
                        if (bot.oxygenLevel !== undefined && bot.oxygenLevel <= 6) break; // drowning → swim reflex
                        const c = this.nearestCreeper(bot, 12);
                        const swarm = this.nearbyHostiles(bot).length > 0;
                        const me = bot.entity.position;
                        if (this.isDay(bot)) { if (!c || c.position.distanceTo(me) > 9) break; }  // day: clear of creeper → resume
                        else if (!c && !swarm) break;                                            // night: only stop when fully clear
                        try { bot.clearControlStates(); } catch (e) {}
                        const safe = this.safeFleeTarget(bot);
                        let dx, dz;
                        if (safe) { dx = (safe.x + 0.5) - me.x; dz = (safe.z + 0.5) - me.z; }
                        else if (c) { dx = me.x - c.position.x; dz = me.z - c.position.z; }
                        else { const hs = this.nearbyHostiles(bot); let sx = 0, sz = 0; for (const e of hs) { sx += e.position.x; sz += e.position.z; } sx /= (hs.length || 1); sz /= (hs.length || 1); dx = me.x - sx; dz = me.z - sz; }
                        const len = Math.hypot(dx, dz) || 1; dx /= len; dz /= len;
                        if (stuckRun >= 8) {
                            // Raw creeper backoff can wedge on cliff/step lips: it keeps
                            // forward+jump+sprint in the same cell until the fuse catches up.
                            // Rotate sideways first; if point-blank and still wedged, stop
                            // "running" and attempt an emergency seal/pillar instead.
                            const odx = dx, odz = dz;
                            dx = -odz * sideFlip; dz = odx * sideFlip;
                            if (i % 12 === 0) sideFlip *= -1;
                            if (Date.now() - lastWedgeLog > 1500) {
                                lastWedgeLog = Date.now();
                                try {
                                    fs.appendFileSync('bots/_supervisor/progress.txt',
                                        `[${new Date().toISOString()}] [self_preservation] creeper backoff wedged: stuck=${stuckRun} pos=${Math.floor(me.x)},${Math.floor(me.y)},${Math.floor(me.z)} cdist=${c ? c.position.distanceTo(me).toFixed(1) : '-'} rotate=${dx.toFixed(2)},${dz.toFixed(2)}\n`);
                                } catch (e) {}
                            }
                            if (stuckRun >= 16 && c && c.position.distanceTo(me) < 5) {
                                try { bot.clearControlStates(); } catch (e) {}
                                try {
                                    fs.appendFileSync('bots/_supervisor/progress.txt',
                                        `[${new Date().toISOString()}] [self_preservation] creeper backoff failed point-blank — emergency bunker fallback\n`);
                                } catch (e) {}
                                await this.bunkerDown(agent);
                                break;
                            }
                        }
                        try { await bot.lookAt(me.offset(dx * 4, 0, dz * 4), true); } catch (e) {}
                        const inspectRunDir = (rx, rz) => {
                            try {
                                const fwd = bot.entity.position.offset(rx, 0, rz).floored();
                                const foot = bot.blockAt(fwd);
                                const head = bot.blockAt(fwd.offset(0, 1, 0));
                                const bad = (b) => b && /water|lava|fire|cactus|magma/.test(b.name || '');
                                let drop = 5;
                                for (let d = 0; d <= 4; d++) {
                                    const b = bot.blockAt(fwd.offset(0, -d, 0));
                                    if (b && b.boundingBox === 'block') { drop = d; break; }
                                }
                                return { fwd, foot, head, drop, hazard: bad(foot) || bad(head) };
                            } catch (e) { return { fwd: null, foot: null, head: null, drop: 5, hazard: true }; }
                        };
                        const creeperCorridorRisk = (rx, rz, target) => {
                            try {
                                const p0 = bot.entity.position;
                                for (const e of Object.values(bot.entities || {})) {
                                    if (!e || !e.position || !/creeper/i.test(e.name || '')) continue;
                                    const d0 = e.position.distanceTo(p0);
                                    if (d0 > 24) continue;
                                    const vx = e.position.x - p0.x;
                                    const vz = e.position.z - p0.z;
                                    const h = Math.hypot(vx, vz);
                                    if (h < 0.001) return { risk: true, name: e.name || 'creeper', d: d0, toward: 1, projected: 0 };
                                    const toward = (rx * vx + rz * vz) / h;
                                    let projected = d0;
                                    for (const step of [2, 4, 6]) {
                                        const px = p0.x + rx * step;
                                        const pz = p0.z + rz * step;
                                        projected = Math.min(projected, Math.hypot(e.position.x - px, e.position.z - pz));
                                    }
                                    if (e === target) {
                                        if (d0 <= 5.5 && toward > -0.1) return { risk: true, name: e.name || 'creeper', d: d0, toward, projected };
                                        if (d0 > 5.5 && d0 < 10 && toward > 0.25) return { risk: true, name: e.name || 'creeper', d: d0, toward, projected };
                                        continue;
                                    }
                                    if ((d0 < 18 && toward > 0.15) || projected < 7.5) {
                                        return { risk: true, name: e.name || 'creeper', d: d0, toward, projected };
                                    }
                                }
                            } catch (e) {}
                            return { risk: false };
                        };
                        const rotate = (rx, rz, a) => {
                            const ca = Math.cos(a), sa = Math.sin(a);
                            return [rx * ca - rz * sa, rx * sa + rz * ca];
                        };
                        const maxDrop = bot.health <= 8 ? 1 : 2;
                        let runDir = null;
                        let runInfo = null;
                        let runRisk = null;
                        for (const a of [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2]) {
                            const [tx, tz] = rotate(dx, dz, a);
                            const info = inspectRunDir(tx, tz);
                            const risk = creeperCorridorRisk(tx, tz, c);
                            if (!info.hazard && info.drop <= maxDrop && !risk.risk) {
                                runDir = [tx, tz];
                                runInfo = info;
                                break;
                            } else if (!info.hazard && info.drop <= maxDrop && !runRisk) {
                                runRisk = risk;
                            }
                        }
                        if (!runDir) {
                            try { bot.clearControlStates(); } catch (e) {}
                            const bad = inspectRunDir(dx, dz);
                            try {
                                fs.appendFileSync('bots/_supervisor/progress.txt',
                                    `[${new Date().toISOString()}] [self_preservation] creeper backoff gated: pos=${Math.floor(me.x)},${Math.floor(me.y)},${Math.floor(me.z)} cdist=${c ? c.position.distanceTo(me).toFixed(1) : '-'} drop=${bad.drop} hp=${Math.round(bot.health)} food=${bot.food} risk=${runRisk && runRisk.risk ? `${runRisk.name}@${runRisk.d.toFixed(1)} proj=${runRisk.projected.toFixed(1)} toward=${runRisk.toward.toFixed(2)}` : 'cliff'}; emergency bunker/hold\n`);
                            } catch (e) {}
                            await this.bunkerDown(agent);
                            break;
                        }
                        dx = runDir[0]; dz = runDir[1];
                        const ledge = runInfo.drop > 1;                     // cautious walk only on a small step-down
                        try { await bot.lookAt(me.offset(dx * 4, 0, dz * 4), true); } catch (e) {}
                        bot.setControlState('forward', true);
                        bot.setControlState('sprint', !ledge);
                        bot.setControlState('jump', !ledge);
                        await new Promise(r => setTimeout(r, 160));
                        const nowPos = bot.entity.position.clone();
                        const moved = Math.hypot(nowPos.x - lastRunPos.x, nowPos.z - lastRunPos.z);
                        if (moved < 0.12 && (c || swarm)) stuckRun++;
                        else stuckRun = 0;
                        lastRunPos = nowPos;
                        if (i % 10 === 9) { try { say(agent, 'Kiting creeper+swarm till dawn…'); } catch (e) {} } // agent.err heartbeat (watchdog alive-signal)
                    }
                    try { bot.clearControlStates(); } catch (e) {}
                });
            }
            else if (this.shouldNightShelter(bot)) {
                if (Date.now() - (this._lastNightfallSayAt || 0) > 30000) {
                    this._lastNightfallSayAt = Date.now();
                    say(agent, 'Nightfall — securing till dawn (proactive, before mobs swarm).');
                }
                execute(this, agent, () => this.bunkerDown(agent));
            }
            else if (this.shouldFlee(bot)) {
                // THREAT RETREAT — "judge you can't win, then run." Count nearby
                // hostiles and check for a weapon; if we're outmatched (no weapon /
                // low health / 2+ mobs) FLEE decisively and KEEP fleeing every tick
                // until clear, rather than trading one step for a hit and getting
                // caught (the old single moveAway let zombies catch up). Staying
                // ALIVE preserves the inventory so the re-entrant achieve run can
                // resume — far better than dying and rebuilding from nothing.
                const hostiles = this.nearbyHostiles(bot);
                const noRegenHold = lowHpNoRegenContainedHold(bot);
                if (noRegenHold) {
                    if (Date.now() - (this._noRegenFleeHoldAt || 0) > 5000) {
                        this._noRegenFleeHoldAt = Date.now();
                        try {
                            const p = bot.entity.position.floored();
                            fs.appendFileSync('bots/_supervisor/progress.txt',
                                `[${new Date().toISOString()}] [self_preservation] no-regen flee hold: food=${bot.food} hp=${Math.round(bot.health || 0)} pos=${p.x},${p.y},${p.z} mob=${noRegenHold.mob || '-'} enclosed=${noRegenHold.enclosed} covered=${noRegenHold.covered} closest=${noRegenHold.closestName || '-'}@${Number.isFinite(noRegenHold.closest) ? noRegenHold.closest.toFixed(1) : '-'} — no bunkerDown/dig\n`);
                        } catch (e) {}
                    }
                    execute(this, agent, async () => {
                        try { bot.clearControlStates(); } catch (e) {}
                        try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
                        try { bot.pathfinder && bot.pathfinder.stop && bot.pathfinder.stop(); } catch (e) {}
                        await skills.wait(bot, 2500);
                    });
                    return;
                }
                say(agent, `Outmatched (${hostiles.length} mob, hp ${Math.round(bot.health)}) — digging in!`);
                execute(this, agent, async () => {
                    // ★UNDERGROUND RANGED WALL-OFF (deaths 196+197, same shape twice: cave
                    // "fall" with a skeleton ~8 blocks — arrow KNOCKBACK near mining shafts.
                    // Strafing/fleeing underground = getting knocked into a hole; pathfind-
                    // aware flee can't help because knockback ignores paths.) The human move:
                    // slam a 2-high block wall between you and the archer FIRST — arrows AND
                    // knockback vanish — then seal calmly. Bounded ~1s, only fires deep
                    // (y<60) with an actual skeleton/stray in range and a block in the bag.
                    try {
                        const me2 = bot.entity.position;
                        // 泛化 (223: 家底洞穴4怪窝,僵尸1.3格贴脸 — 原版只防骷髅): underground +
                        // outmatched → wall vs the NEAREST hostile of ANY type before sealing.
                        // Works on zombie pursuit and creeper LoS the same as arrows.
                        const HO2 = /zombie|skeleton|stray|creeper|spider|husk|drowned|witch|pillager|vindicator/i;
                        const skel2 = Object.values(bot.entities)
                            .filter(e => e && e.position && HO2.test(e.name || '') && e.position.distanceTo(me2) < 12)
                            .sort((a, b) => a.position.distanceTo(me2) - b.position.distanceTo(me2))[0];
                        if (skel2 && me2.y < 60) {
                            const mat = bot.inventory.items().find(i => /^(cobblestone|cobbled_deepslate|dirt|andesite|diorite|granite|tuff|netherrack)$/.test(i.name));
                            if (mat) {
                                let ddx = skel2.position.x - me2.x, ddz = skel2.position.z - me2.z;
                                const L = Math.hypot(ddx, ddz) || 1;
                                ddx = Math.round(ddx / L); ddz = Math.round(ddz / L);
                                const base = me2.floored().offset(ddx, 0, ddz);
                                for (const c of [base, base.offset(0, 1, 0)]) {
                                    const wb = bot.blockAt(c);
                                    if (wb && (wb.name === 'air' || wb.name === 'cave_air')) {
                                        try { await skills.placeBlock(bot, mat.name, c.x, c.y, c.z, 'bottom', true); } catch (e) {}
                                    }
                                }
                                say(agent, 'Walled off the archer.');
                            }
                        }
                    } catch (e) {}
                    // Outmatched = we can't win. Surface-fleeing in this mob-dense world just
                    // runs into MORE mobs and gets cornered — it killed us at hp1 in BROAD
                    // DAYLIGHT (skeletons/spiders/zombies in shade don't all burn off). The
                    // ONE reliable escape is to dig DOWN and seal, breaking all contact. At
                    // night bunkerDown also waits out the dark; in daytime its wait-loop is a
                    // no-op, so it just digs in, seals, and returns fast — then the grind
                    // resumes underground (where we want to be mining anyway). Eat first if
                    // we can, to start regen while we dig.
                    const food = bot.inventory.items().find(i => /cooked_|_bread|^bread$|apple|carrot|potato|beef|porkchop|chicken|mutton|cod|salmon|melon_slice|sweet_berries|_stew|rabbit|baked_/.test(i.name));
                    if (food && bot.food < 20) { try { await skills.consume(bot, food.name); } catch (e) {} }
                    await this.bunkerDown(agent);
                });
            }
            else if (agent.isIdle()) {
                bot.clearControlStates(); // clear jump if not in danger or doing anything else
            }
        }
    },
    {
        name: 'unstuck',
        description: 'Attempt to get unstuck when in the same place for a while. Interrupts some actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        prev_location: null,
        distance: 2,
        stuck_time: 0,
        last_time: Date.now(),
        max_stuck_time: 20,
        prev_dig_block: null,
        step_prev_location: null,
        step_prev_time: 0,
        step_guard_until: 0,
        step_skip_key: null,
        step_skip_first_at: 0,
        step_skip_count: 0,
        step_skip_last_log_at: 0,
        update: async function (agent) {
            const bot = agent.bot;
            if (famineBodyFreeze(agent, 'unstuck')) {
                this.prev_location = null;
                this.stuck_time = 0;
                this.step_prev_location = null;
                return;
            }
            const containedHold = lowHpNoRegenContainedHold(bot);
            if (containedHold) {
                try {
                    bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null);
                    bot.pathfinder && bot.pathfinder.stop && bot.pathfinder.stop();
                    bot.clearControlStates();
                } catch (e) {}
                this.prev_location = null;
                this.stuck_time = 0;
                this.prev_dig_block = null;
                this.step_prev_location = null;
                if (Date.now() - (bot._lastUnstuckContainedHoldAt || 0) > 15000) {
                    bot._lastUnstuckContainedHoldAt = Date.now();
                    const p = bot.entity.position.floored();
                    try {
                        fs.appendFileSync('bots/_supervisor/progress.txt',
                            `[${new Date().toISOString()}] [unstuck] no-regen contained hold: food=${bot.food} hp=${Math.round(bot.health || 0)} pos=${p.x},${p.y},${p.z} mob=${containedHold.mob || '-'} enclosed=${containedHold.enclosed} covered=${containedHold.covered} closest=${containedHold.closestName || '-'}@${Number.isFinite(containedHold.closest) ? containedHold.closest.toFixed(1) : '-'} — suppress moveAway/GoalInvert\n`);
                    } catch (e) {}
                }
                return;
            }
            const tableHold = tableRecoveryHold(bot);
            if (tableHold) {
                try {
                    bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null);
                    bot.pathfinder && bot.pathfinder.stop && bot.pathfinder.stop();
                    bot.clearControlStates();
                } catch (e) {}
                this.prev_location = null;
                this.stuck_time = 0;
                this.prev_dig_block = null;
                this.step_prev_location = null;
                if (Date.now() - (bot._lastUnstuckTableRecoveryHoldAt || 0) > 15000) {
                    bot._lastUnstuckTableRecoveryHoldAt = Date.now();
                    const p = bot.entity.position.floored();
                    try {
                        fs.appendFileSync('bots/_supervisor/progress.txt',
                            `[${new Date().toISOString()}] [unstuck] table recovery hold: pos=${p.x},${p.y},${p.z} mob=${tableHold.mob || '-'} raw16=${tableHold.raw} layered16=${tableHold.layered} day=${!tableHold.isNight} — suppress GoalInvert/step-edge until actionable threat\n`);
                    } catch (e) {}
                }
                return;
            }
            const pathingNow = !!(bot && bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving());
            const mobilityWorkNow = !!(bot && bot._mobility && /MAROONED|POCKET|ENTOMBED/.test(bot._mobility.state || ''));
            if (agent.isIdle() && !pathingNow && !mobilityWorkNow) {
                this.prev_location = null;
                this.stuck_time = 0;
                this.step_prev_location = null;
                return; // don't get stuck when idle
            }
            const now = Date.now();
            try {
                const cs = bot.controlState || {};
                const p = bot.entity.position;
                if (!this.step_prev_location) {
                    this.step_prev_location = p.clone();
                    this.step_prev_time = now;
                } else if (now - this.step_prev_time >= 700) {
                    const moved = p.distanceTo(this.step_prev_location);
                    const skill = bot._currentSkill || '';
                    const yaw = bot.entity.yaw || 0;
                    const snapDir = (rx, rz) => {
                        if (!Number.isFinite(rx) || !Number.isFinite(rz) || Math.hypot(rx, rz) < 0.08) return null;
                        return Math.abs(rx) >= Math.abs(rz)
                            ? [Math.sign(rx) || 1, 0]
                            : [0, Math.sign(rz) || 1];
                    };
                    const candidates = [];
                    const addDir = (dir, source) => {
                        if (!dir) return;
                        const [cx, cz] = dir;
                        if (candidates.some(c => c.dx === cx && c.dz === cz)) return;
                        candidates.push({ dx: cx, dz: cz, source });
                    };
                    if (pathingNow && bot._lastPathGoalInfo && Date.now() - (bot._lastPathGoalAt || 0) < 10000) {
                        const g = bot._lastPathGoalInfo;
                        if (typeof g.x === 'number' && typeof g.z === 'number') addDir(snapDir(g.x - p.x, g.z - p.z), 'path-goal');
                        if (g.entity && g.entity.pos) addDir(snapDir(g.entity.pos.x - p.x, g.entity.pos.z - p.z), 'path-entity');
                        if (g.goal && typeof g.goal.x === 'number' && typeof g.goal.z === 'number') addDir(snapDir(g.goal.x - p.x, g.goal.z - p.z), 'path-inner-goal');
                    }
                    addDir(snapDir(p.x - this.step_prev_location.x, p.z - this.step_prev_location.z), 'recent-motion');
                    addDir(snapDir(-Math.sin(yaw), Math.cos(yaw)), 'yaw');
                    for (const d0 of [[1, 0], [0, 1], [-1, 0], [0, -1]]) addDir(d0, 'fallback');
                    let dx = candidates[0] ? candidates[0].dx : 1;
                    let dz = candidates[0] ? candidates[0].dz : 0;
                    let dirSource = candidates[0] ? candidates[0].source : 'default';
                    const cell = p.floored();
                    let targetCell, frontFoot, frontHead, frontAbove, frontBelow;
                    const refreshStepProbe = () => {
                        targetCell = cell.offset(dx, 0, dz);
                        frontFoot = bot.blockAt(targetCell);
                        frontHead = bot.blockAt(targetCell.offset(0, 1, 0));
                        frontAbove = bot.blockAt(targetCell.offset(0, 2, 0));
                        frontBelow = bot.blockAt(targetCell.offset(0, -1, 0));
                    };
                    refreshStepProbe();
                    const ownHead = bot.blockAt(cell.offset(0, 1, 0));
                    const ownAbove = bot.blockAt(cell.offset(0, 2, 0));
                    const solid = (b) => b && b.boundingBox === 'block';
                    const PASSABLE = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow']);
                    const open = (b) => !b || b.boundingBox === 'empty' || PASSABLE.has(b.name || '');
                    const bad = (b) => b && /water|lava|fire|cactus|magma/.test(b.name || '');
                    const stationStep = (b) => b && /crafting_table|furnace|blast_furnace|smoker|chest|barrel|bed|anvil|enchanting_table|grindstone|stonecutter|loom|cartography_table|smithing_table|fletching_table|lectern|composter/i.test(b.name || '');
                    const hasPick = () => bot.inventory && bot.inventory.items().some(it => /_pickaxe$/.test(it.name || ''));
                    const clearableStepRoof = (b) => {
                        if (!b || b.boundingBox !== 'block') return false;
                        if (bad(b) || stationStep(b) || /bedrock|obsidian|end_portal|nether_portal/.test(b.name || '')) return false;
                        const stony = /stone|deepslate|andesite|diorite|granite|tuff|_ore$|cobble/.test(b.name || '');
                        return !stony || hasPick();
                    };
                    const isStepLikeNow = () => solid(frontFoot) && open(frontHead) && open(frontAbove) && open(ownHead) && !stationStep(frontFoot) && !bad(frontFoot) && !bad(frontHead) && !bad(frontAbove);
                    if (!isStepLikeNow()) {
                        for (const c of candidates) {
                            dx = c.dx; dz = c.dz; dirSource = c.source;
                            refreshStepProbe();
                            if (isStepLikeNow()) break;
                        }
                    }
                    const stepLike = isStepLikeNow();
                    const wantsForward = !!(cs.forward || pathingNow || mobilityWorkNow || /surfaceUp|feedUp|chopWood|branchMine/.test(skill));
                    // Step-edge assist is specifically for traversal stalls. The hard
                    // guard is active digging/mining, not the surrounding skill name:
                    // surfaceUp/branchMine are exactly where one-block lip stalls recur.
                    const hasBodyWork = !!(bot.targetDigBlock || bot._mineMotionActiveDig || (bot._bodyDigLockUntil && Date.now() < bot._bodyDigLockUntil));
                    const blockName = (b) => b ? `${b.name}@${b.position.x},${b.position.y},${b.position.z}` : 'null';
                    const famineCriticalNoStep = (() => {
                        try {
                            if (!(bot.food <= 2 && bot.health <= 6)) return false;
                            const edible = bot.inventory && bot.inventory.items().some(i => i && i.name && FAMINE_FOOD_RE.test(i.name));
                            if (edible) return false;
                            const feetNow = bot.blockAt(cell);
                            const headNow = bot.blockAt(cell.offset(0, 1, 0));
                            if (bad(feetNow) || bad(headNow)) return false;
                            if (!bot.entity.onGround && bot.entity.velocity && bot.entity.velocity.y < -0.25) return false;
                            if (Date.now() - (bot.lastDamageTime || 0) < 4000) return false;
                            return true;
                        } catch (e) { return false; }
                    })();
                    const stepSkipReason = () => {
                        if (!wantsForward || moved >= 0.12 || hasBodyWork || now <= this.step_guard_until) return null;
                        if (famineCriticalNoStep) return 'famine-hold';
                        if (!solid(frontFoot)) return 'front-not-step';
                        if (stationStep(frontFoot)) return 'front-functional-station';
                        if (!open(frontHead)) return 'target-foot-blocked';
                        if (!open(frontAbove)) return 'target-head-blocked';
                        if (!open(ownHead)) return 'own-head-blocked';
                        if (bad(frontFoot) || bad(frontHead) || bad(frontAbove)) return 'hazard';
                        return null;
                    };
                    const skipReason = stepSkipReason();
                    if (skipReason) {
                        const skipKey = `${skipReason}:${targetCell.x},${targetCell.y},${targetCell.z}:${blockName(frontFoot)}:${blockName(frontHead)}:${blockName(frontAbove)}`;
                        const repeatedSkip = this.step_skip_key === skipKey && now - (this.step_skip_first_at || 0) < 20000;
                        this.step_skip_key = skipKey;
                        this.step_skip_first_at = repeatedSkip ? this.step_skip_first_at : now;
                        this.step_skip_count = repeatedSkip ? (this.step_skip_count || 0) + 1 : 1;
                        const structuralBlock = /target-foot-blocked|target-head-blocked|own-head-blocked|own-above-blocked|front-functional-station/.test(skipReason);
                        const guardMs = structuralBlock && this.step_skip_count >= 2 ? Math.min(15000, 2500 * this.step_skip_count) : 2500;
                        this.step_guard_until = now + guardMs;
                        if (guardMs > 2500 && now - (this.step_skip_last_log_at || 0) > 10000) {
                            this.step_skip_last_log_at = now;
                            try {
                                fs.appendFileSync('bots/_supervisor/progress.txt',
                                    `[${new Date().toISOString()}] [step-edge] structural skip backoff reason=${skipReason} count=${this.step_skip_count} guard=${Math.ceil(guardMs / 1000)}s target=${targetCell.x},${targetCell.y},${targetCell.z} step=${frontFoot ? frontFoot.name : 'null'} foot=${frontHead ? frontHead.name : 'null'} head=${frontAbove ? frontAbove.name : 'null'} skill=${skill || '-'}\n`);
                            } catch (e) {}
                        }
                        try {
                            fs.appendFileSync('bots/_supervisor/mine_motion.jsonl', JSON.stringify({
                                ts: new Date().toISOString(),
                                event: 'step_edge.skip',
                                pos: { x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3) },
                                skill: bot._currentSkill || null,
                                mob: bot._mobility ? bot._mobility.state : null,
                                data: {
                                    reason: skipReason,
                                    moved: +moved.toFixed(3),
                                    dir: [dx, dz],
                                    dirSource,
                                    candidateDirs: candidates,
                                    pathGoal: bot._lastPathGoalInfo || null,
                                    targetCell: { x: targetCell.x, y: targetCell.y, z: targetCell.z },
                                    step: blockName(frontFoot),
                                    targetFoot: blockName(frontHead),
                                    targetHead: blockName(frontAbove),
                                    ownHead: blockName(ownHead),
                                    ownAbove: blockName(ownAbove),
                                    skipCount: this.step_skip_count,
                                    guardMs,
                                },
                            }) + '\n');
                        } catch (e) {}
                    }
                    if (wantsForward && stepLike && moved < 0.12 && !hasBodyWork && !famineCriticalNoStep && now > this.step_guard_until) {
                        this.step_guard_until = now + 3000;
                        try {
                            fs.appendFileSync('bots/_supervisor/progress.txt',
                                `[${new Date().toISOString()}] [step-edge] assist begin moved=${moved.toFixed(2)} dir=${dx},${dz}/${dirSource} target=${targetCell.x},${targetCell.y},${targetCell.z} step=${frontFoot ? frontFoot.name : 'null'} foot=${frontHead ? frontHead.name : 'null'} head=${frontAbove ? frontAbove.name : 'null'} below=${frontBelow ? frontBelow.name : 'null'} skill=${skill || '-'}\n`);
                        } catch (e) {}
                        execute(this, agent, async () => {
                            const exact = () => {
                                const q = bot.entity.position;
                                return { x: +q.x.toFixed(3), y: +q.y.toFixed(3), z: +q.z.toFixed(3) };
                            };
                            const envSnap = () => {
                                const c = bot.entity.position.floored();
                                const out = [];
                                for (let dy = -1; dy <= 2; dy++) {
                                    for (let dz0 = -1; dz0 <= 1; dz0++) {
                                        for (let dx0 = -1; dx0 <= 1; dx0++) {
                                            const b = bot.blockAt(c.offset(dx0, dy, dz0));
                                            out.push({
                                                d: [dx0, dy, dz0],
                                                n: b ? b.name : null,
                                                bb: b ? b.boundingBox : null,
                                            });
                                        }
                                    }
                                }
                                return out;
                            };
                            const motionLog = (event, data = {}) => {
                                try {
                                    fs.appendFileSync('bots/_supervisor/mine_motion.jsonl', JSON.stringify({
                                        ts: new Date().toISOString(),
                                        event,
                                        pos: exact(),
                                        skill: bot._currentSkill || null,
                                        mob: bot._mobility ? bot._mobility.state : null,
                                        env: envSnap(),
                                        data,
                                    }) + '\n');
                                } catch (e) {}
                            };
                            const centerOnCurrentCell = async () => {
                                const c = bot.entity.position.floored();
                                const center = c.offset(0.5, 0.05, 0.5);
                                const dist = Math.hypot(bot.entity.position.x - center.x, bot.entity.position.z - center.z);
                                if (dist < 0.24) return;
                                try {
                                    await bot.lookAt(center.offset(0, 1.45, 0), true);
                                    bot.setControlState('sprint', false);
                                    bot.setControlState('jump', false);
                                    bot.setControlState('forward', true);
                                    await new Promise(r => setTimeout(r, Math.min(260, Math.max(120, dist * 420))));
                                } finally {
                                    try { bot.clearControlStates(); } catch (e) {}
                                }
                            };
                            try {
                                bot._bodyMoveLockOwner = 'unstuck:step-edge';
                                bot._bodyMoveLockUntil = Date.now() + 2800;
                                const start = bot.entity.position.clone();
                                const freshCell = bot.entity.position.floored();
                                const freshTarget = freshCell.offset(dx, 0, dz);
                                const freshStep = bot.blockAt(freshTarget);
                                const freshFoot = bot.blockAt(freshTarget.offset(0, 1, 0));
                                const freshHead = bot.blockAt(freshTarget.offset(0, 2, 0));
                                const freshOwnHead = bot.blockAt(freshCell.offset(0, 1, 0));
                                let freshOwnAbove = bot.blockAt(freshCell.offset(0, 2, 0));
                                if (!open(freshOwnAbove)) {
                                    const clearable = clearableStepRoof(freshOwnAbove);
                                    motionLog('step_edge.own_above_notch.begin', {
                                        clearable,
                                        dir: [dx, dz],
                                        targetCell: { x: freshTarget.x, y: freshTarget.y, z: freshTarget.z },
                                        block: blockName(freshOwnAbove),
                                    });
                                    let notchOk = false;
                                    let notchErr = null;
                                    if (clearable) {
                                        try {
                                            bot._bodyDigLockOwner = 'unstuck:step-edge-own-above-notch';
                                            bot._bodyDigLockUntil = Date.now() + 5200;
                                            try { bot.clearControlStates(); } catch (e) {}
                                            try { if (bot.tool && bot.tool.equipForBlock) await bot.tool.equipForBlock(freshOwnAbove); } catch (e) {}
                                            try { await bot.lookAt(freshOwnAbove.position.offset(0.5, 0.5, 0.5), true); } catch (e) {}
                                            await Promise.race([
                                                bot.dig(freshOwnAbove, true),
                                                new Promise((_, rej) => setTimeout(() => rej(new Error('own-above-notch-timeout')), 4800)),
                                            ]);
                                            await new Promise(r => setTimeout(r, 120));
                                            freshOwnAbove = bot.blockAt(freshCell.offset(0, 2, 0));
                                            notchOk = open(freshOwnAbove);
                                        } catch (e) {
                                            notchErr = e && e.message ? e.message : String(e);
                                        } finally {
                                            try { bot.clearControlStates(); } catch (e) {}
                                            if (bot._bodyDigLockOwner === 'unstuck:step-edge-own-above-notch') {
                                                bot._bodyDigLockOwner = null;
                                                bot._bodyDigLockUntil = 0;
                                            }
                                        }
                                    }
                                    motionLog('step_edge.own_above_notch.end', {
                                        ok: notchOk,
                                        error: notchErr,
                                        after: blockName(freshOwnAbove),
                                        dir: [dx, dz],
                                        targetCell: { x: freshTarget.x, y: freshTarget.y, z: freshTarget.z },
                                    });
                                }
                                if (!(solid(freshStep) && open(freshFoot) && open(freshHead) && open(freshOwnHead) && open(freshOwnAbove))
                                    || stationStep(freshStep) || bad(freshStep) || bad(freshFoot) || bad(freshHead)) {
                                    motionLog('step_edge.skip', {
                                        reason: stationStep(freshStep) ? 'functional-station-before-press' : 'stale-or-invalid-before-press',
                                        dir: [dx, dz],
                                        targetCell: { x: freshTarget.x, y: freshTarget.y, z: freshTarget.z },
                                        step: blockName(freshStep),
                                        targetFoot: blockName(freshFoot),
                                        targetHead: blockName(freshHead),
                                        ownHead: blockName(freshOwnHead),
                                        ownAbove: blockName(freshOwnAbove),
                                    });
                                    return;
                                }
                                motionLog('step_edge.begin', {
                                    dir: [dx, dz],
                                    dirSource,
                                    candidateDirs: candidates,
                                    pathGoal: bot._lastPathGoalInfo || null,
                                    targetCell: { x: targetCell.x, y: targetCell.y, z: targetCell.z },
                                    step: blockName(frontFoot),
                                    targetFoot: blockName(frontHead),
                                    targetHead: blockName(frontAbove),
                                    ownHead: blockName(ownHead),
                                    ownAbove: blockName(ownAbove),
                                });
                                try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
                                await centerOnCurrentCell();
                                let maxY = bot.entity.position.y;
                                const targetDistFrom = (q) => Math.hypot(q.x - (targetCell.x + 0.5), q.z - (targetCell.z + 0.5));
                                const roseEnoughAt = (q) => Math.floor(q.y) > cell.y || q.y > start.y + 0.72;
                                const settledInTarget = (q) => Math.floor(q.x) === targetCell.x && Math.floor(q.z) === targetCell.z && targetDistFrom(q) <= 0.9;
                                const stepSucceeded = (q) => roseEnoughAt(q) && settledInTarget(q);
                                for (let attempt = 0; attempt < 2; attempt++) {
                                    const c = bot.entity.position.floored();
                                    const tgt = c.offset(dx + 0.5, 1.15, dz + 0.5);
                                    await bot.lookAt(tgt, true);
                                    bot.setControlState('sprint', false);
                                    bot.setControlState('forward', true);
                                    bot.setControlState('jump', true);
                                    const t0 = Date.now();
                                    while (Date.now() - t0 < 820) {
                                        if (bot.entity.position.y > maxY) maxY = bot.entity.position.y;
                                        const cur = bot.entity.position;
                                        if (stepSucceeded(cur)) break;
                                        await new Promise(r => setTimeout(r, 40));
                                    }
                                    try { bot.clearControlStates(); } catch (e) {}
                                    await new Promise(r => setTimeout(r, 120));
                                    const cur = bot.entity.position;
                                    if (stepSucceeded(cur)) break;
                                }
                                let end = bot.entity.position.clone();
                                let ok = stepSucceeded(end);
                                if (!ok && roseEnoughAt(end) && !settledInTarget(end)) {
                                    motionLog('step_edge.edge_miss', {
                                        dir: [dx, dz],
                                        targetCell: { x: targetCell.x, y: targetCell.y, z: targetCell.z },
                                        at: { x: +end.x.toFixed(3), y: +end.y.toFixed(3), z: +end.z.toFixed(3) },
                                        floor: { x: Math.floor(end.x), y: Math.floor(end.y), z: Math.floor(end.z) },
                                        targetDist: +targetDistFrom(end).toFixed(3),
                                        recovery: 'center-press',
                                    });
                                    try {
                                        await bot.lookAt(targetCell.offset(0.5, 1.15, 0.5), true);
                                        bot.setControlState('sprint', false);
                                        bot.setControlState('jump', false);
                                        bot.setControlState('forward', true);
                                        await new Promise(r => setTimeout(r, 420));
                                    } finally {
                                        try { bot.clearControlStates(); } catch (e) {}
                                    }
                                    await new Promise(r => setTimeout(r, 120));
                                    end = bot.entity.position.clone();
                                    ok = stepSucceeded(end);
                                }
                                let notch = null;
                                if (!ok) {
                                    const c2 = bot.entity.position.floored();
                                    const t2 = c2.offset(dx, 0, dz);
                                    const step2 = bot.blockAt(t2);
                                    const below2 = bot.blockAt(t2.offset(0, -1, 0));
                                    const stonyStep = /stone|deepslate|andesite|diorite|granite|tuff|_ore$|obsidian|cobble/.test((step2 && step2.name) || '');
                                    const hasPick2 = () => bot.inventory.items().some(it => /_pickaxe$/.test(it.name || ''));
                                    const canNotch = step2 && step2.boundingBox === 'block'
                                        && below2 && below2.boundingBox === 'block'
                                        && !/bedrock|water|lava|fire|cactus|magma/.test(step2.name || '')
                                        && (!stonyStep || hasPick2());
                                    if (canNotch) {
                                        notch = {
                                            block: blockName(step2),
                                            below: blockName(below2),
                                            targetCell: { x: t2.x, y: t2.y, z: t2.z },
                                        };
                                        motionLog('step_edge.notch.begin', { dir: [dx, dz], ...notch });
                                        try {
                                            bot._bodyDigLockOwner = 'unstuck:step-edge-notch';
                                            bot._bodyDigLockUntil = Date.now() + 5000;
                                            try { bot.clearControlStates(); } catch (e) {}
                                            try { await bot.tool.equipForBlock(step2); } catch (e) {}
                                            try { await bot.lookAt(step2.position.offset(0.5, 0.5, 0.5), true); } catch (e) {}
                                            await Promise.race([
                                                bot.dig(step2, true),
                                                new Promise((_, rej) => setTimeout(() => rej(new Error('notch-timeout')), 4500)),
                                            ]);
                                            await new Promise(r => setTimeout(r, 120));
                                            const afterStep = bot.blockAt(t2);
                                            notch.after = blockName(afterStep);
                                            if (!afterStep || afterStep.boundingBox !== 'block') {
                                                try { await bot.lookAt(t2.offset(0.5, 1.25, 0.5), true); } catch (e) {}
                                                bot.setControlState('sprint', false);
                                                bot.setControlState('jump', false);
                                                bot.setControlState('forward', true);
                                                await new Promise(r => setTimeout(r, 520));
                                                try { bot.clearControlStates(); } catch (e) {}
                                                await new Promise(r => setTimeout(r, 120));
                                                end = bot.entity.position.clone();
                                                ok = Math.hypot(end.x - (t2.x + 0.5), end.z - (t2.z + 0.5)) < 0.95
                                                    && end.y >= start.y - 0.35;
                                            }
                                            notch.ok = ok;
                                        } catch (e) {
                                            notch.error = e.message;
                                            try { bot.clearControlStates(); } catch (e2) {}
                                        } finally {
                                            if (bot._bodyDigLockOwner === 'unstuck:step-edge-notch') {
                                                bot._bodyDigLockOwner = null;
                                                bot._bodyDigLockUntil = 0;
                                            }
                                        }
                                        motionLog('step_edge.notch.end', {
                                            dir: [dx, dz],
                                            ...notch,
                                            end: { x: +end.x.toFixed(3), y: +end.y.toFixed(3), z: +end.z.toFixed(3) },
                                        });
                                    }
                                }
                                motionLog('step_edge.end', {
                                    ok,
                                    dir: [dx, dz],
                                    start: { x: +start.x.toFixed(3), y: +start.y.toFixed(3), z: +start.z.toFixed(3) },
                                    end: { x: +end.x.toFixed(3), y: +end.y.toFixed(3), z: +end.z.toFixed(3) },
                                    maxRise: +(maxY - start.y).toFixed(3),
                                    targetDist: +targetDistFrom(end).toFixed(3),
                                    settledInTarget: settledInTarget(end),
                                    notch,
                                });
                                try {
                                    fs.appendFileSync('bots/_supervisor/progress.txt',
                                        `[${new Date().toISOString()}] [step-edge] assist end ok=${ok} y=${start.y.toFixed(2)}→${end.y.toFixed(2)} dist=${targetDistFrom(end).toFixed(2)} settled=${settledInTarget(end)}${notch ? ' notch=' + (notch.ok ? 'ok' : 'fail') : ''}\n`);
                                } catch (e) {}
                            } catch (e) {
                                try { bot.clearControlStates(); } catch (e2) {}
                                motionLog('step_edge.end', { ok: false, error: e.message, dir: [dx, dz] });
                            } finally {
                                if (bot._bodyMoveLockOwner === 'unstuck:step-edge') {
                                    bot._bodyMoveLockOwner = null;
                                    bot._bodyMoveLockUntil = 0;
                                }
                            }
                        });
                    }
                    this.step_prev_location = p.clone();
                    this.step_prev_time = now;
                }
            } catch (e) {}
            const cur_dig_block = bot.targetDigBlock;
            if (cur_dig_block && !this.prev_dig_block) {
                this.prev_dig_block = cur_dig_block;
            }
            if (this.prev_location && this.prev_location.distanceTo(bot.entity.position) < this.distance && cur_dig_block == this.prev_dig_block) {
                this.stuck_time += (Date.now() - this.last_time) / 1000;
            }
            else {
                this.prev_location = bot.entity.position.clone();
                this.stuck_time = 0;
                this.prev_dig_block = null;
            }
            const max_stuck_time = cur_dig_block?.name === 'obsidian' ? this.max_stuck_time * 2 : this.max_stuck_time;
            if (this.stuck_time > max_stuck_time) {
                say(agent, 'I\'m stuck!');
                this.stuck_time = 0;
                execute(this, agent, async () => {
                    // With smart timeout (10s if stuck, 60s if moving), give it 65s total
                    const crashTimeout = setTimeout(() => { 
                        agent.cleanKill("Got stuck and couldn't get unstuck") 
                    }, 65000); // 65 seconds to allow pathfinding timeout to work
                    try {
                        await skills.moveAway(bot, 5);
                        clearTimeout(crashTimeout);
                        say(agent, 'I\'m free.');
                    } catch (err) {
                        clearTimeout(crashTimeout);
                        say(agent, `Failed to get unstuck: ${err.message}. May be trapped in water or impassable terrain.`);
                        // Don't crash immediately, let agent try to handle the situation
                    }
                });
            }
            this.last_time = Date.now();
        },
        unpause: function () {
            this.prev_location = null;
            this.stuck_time = 0;
            this.prev_dig_block = null;
            this.step_prev_location = null;
        }
    },
    {
        name: 'cowardice',
        description: 'Run away from enemies. Interrupts all actions.',
        interrupts: ['all'],
        on: false, // off: conflicts with self_defense (caused flee/fight thrash and paralysis). Retreat is handled by self_preservation at low health.
        active: false,
        update: async function (agent) {
            const enemy = world.getNearestEntityWhere(agent.bot, entity => mc.isHostile(entity), 16);
            if (enemy && await world.isClearPath(agent.bot, enemy)) {
                say(agent, `Aaa! A ${enemy.name.replace("_", " ")}!`);
                execute(this, agent, async () => {
                    await skills.avoidEnemies(agent.bot, 24);
                });
            }
        }
    },
    {
        name: 'self_defense',
        description: 'Attack nearby enemies. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        update: async function (agent) {
            // Balance survival vs. getting work done (like a player):
            // - normally only clear CLOSE threats (<=5) so we don't abandon mining/
            //   chopping to chase every distant mob (that paralysis stopped all
            //   resource gathering).
            // - if we were just hit (skeleton arrow / zombie), expand to 12 and
            //   fight back so ranged/sneaky attackers don't get free damage.
            // isClearPath intentionally removed so corner/behind-block mobs count.
            const bot = agent.bot;
            const recentlyHurt = Date.now() - bot.lastDamageTime < 2500;
            const range = recentlyHurt ? 12 : 5;
            // EXCLUDE creepers — meleeing one = it detonates = death ("Fighting creeper!"
            // was a suicidal conflict with self_preservation's back-off reflex). Creepers are
            // handled ONLY by self_pres (sprint to >9 blocks). self_defense never engages them.
            const enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity) && !/creeper/i.test(entity.name || ''), range);
            // Only STAND AND FIGHT when we can actually win: a weapon in hand and
            // health > 12. Otherwise self_preservation (checked first, higher
            // priority) flees. Never trade blows barehanded or while low — that
            // "fight to the death" is exactly what got the bot killed repeatedly.
            const hasWeapon = bot.inventory.items().some(i => /_sword$|_axe$/.test(i.name));
            const hasShield = bot.inventory.items().some(i => i.name === 'shield') || (bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield');
            const swarmed = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), 6) &&
                Object.values(bot.entities).filter(e => e && mc.isHostile(e) && e.position && e.position.distanceTo(bot.entity.position) < 8).length >= 3;
            // With a shield we can fight even at lower HP (block negates the hits); the
            // shieldFight skill closes on the enemy under guard then strikes — the real
            // counter to skeletons. Without a shield, only fight when healthy (>12).
            const minHp = hasShield ? 8 : 12;
            // ★EXCEPTION — point-blank ranged enemy: the hp gate is BACKWARDS for a
            // skeleton inside melee reach. Death #263 (blackbox): hp4, skeleton at
            // 1.6-4b in a dug shaft — self_defense refused (4<12), self_preservation
            // walled (useless point-blank), terrain blocked flight; the bot jittered
            // in a 1-block box for 20s and was shot dead WITH a sword in the bag.
            // Point-blank, melee IS the best (often only) move: bow draw has ~0.5s
            // windup and sword knockback interrupts the firing cycle, so a wooden
            // sword wins that duel at any hp. Same logic for any non-creeper hostile
            // already in our face: it's hitting us regardless — hit back.
            const pointBlank = enemy && enemy.position &&
                enemy.position.distanceTo(bot.entity.position) < 4.5;
            if (enemy && hasWeapon && !swarmed && (bot.health > minHp || pointBlank)) {
                say(agent, `Fighting ${enemy.name}!`);
                execute(this, agent, async () => {
                    if (hasShield) { try { await skills.customSkill(bot, 'shieldFight', range); } catch (e) { await skills.defendSelf(bot, range); } }
                    else await skills.defendSelf(bot, range);
                });
            }
        }
    },
    {
        name: 'threat_radar',
        description: 'See hostiles BEFORE they see us (24-block scan); flight-record every engagement.',
        interrupts: [],
        on: true,
        active: false,
        always: true,   // pure observer: must tick even while a sticky skill is executing
        last_tick: 0, known: {}, engaged: false, lastHp: 20, logSize: 0,
        update: async function (agent) {
            // ★威胁雷达+战斗黑匣子 (用户: ①索敌必须永远比怪先知道 ②怪一注意到就进详细
            // 日志模式,事后能还原图景). 24格扫描(超过怪16格仇恨半径=先手知情);任何敌对
            // 进入16格=交战,1Hz连拍快照进 combat_log.jsonl: 自身pos/hp/速度/手持/onGround
            // +全部敌对的名字/距离/坐标+受击事件 — 死因复盘从"遗体照片"升级为"全程录像"。
            const bot = agent.bot;
            const now = Date.now();
            if (now - this.last_tick < 1000) return;
            this.last_tick = now;
            const HR = /zombie|skeleton|creeper|spider|witch|drowned|husk|stray|phantom|slime|enderman|pillager|vindicator|silverfish|cave_spider/i;
            let mobs = [];
            try {
                const me = bot.entity.position;
                mobs = Object.values(bot.entities)
                    .filter(e => e && e.position && e.name && HR.test(e.name) && e.position.distanceTo(me) < 24)
                    .map(e => ({ id: e.id, name: e.name, d: +e.position.distanceTo(me).toFixed(1), x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z) }));
            } catch (e) { return; }
            // god's-eye feed: latest 24-block radar snapshot for the overseer process
            // (bots/_supervisor/overseer.mjs). Overwritten every 5s — cheap, and gives
            // the risk engine live mob positions even when nothing is engaged yet.
            if (!this.lastSnap || now - this.lastSnap > 5000) {
                this.lastSnap = now;
                try {
                    const p = bot.entity.position;
                    fs.writeFileSync('bots/_supervisor/radar.json', JSON.stringify({
                        ts: now, pos: [Math.round(p.x), Math.round(p.y), Math.round(p.z)], mobs,
                    }));
                } catch (e) {}
            }
            const W = (rec) => {
                try {
                    if (this.logSize === 0) { try { this.logSize = fs.statSync('bots/_supervisor/combat_log.jsonl').size; } catch (e) { this.logSize = 1; } }
                    if (this.logSize > 20 * 1024 * 1024) { try { fs.renameSync('bots/_supervisor/combat_log.jsonl', 'bots/_supervisor/combat_log.jsonl.1'); } catch (e) {} this.logSize = 1; }
                    const line = JSON.stringify(rec) + '\n';
                    fs.appendFileSync('bots/_supervisor/combat_log.jsonl', line);
                    this.logSize += line.length;
                } catch (e) {}
            };
            // 雷达: 新接触即记录 (先手知情)
            for (const m of mobs) {
                if (!this.known[m.id]) {
                    this.known[m.id] = now;
                    W({ t: new Date().toISOString(), ev: 'radar_contact', mob: m.name, d: m.d, at: [m.x, m.y, m.z] });
                }
            }
            for (const k of Object.keys(this.known)) { if (!mobs.some(m => m.id == k)) delete this.known[k]; }
            // 交战判定: 16格内有敌对(怪的仇恨半径) 或 本tick掉血
            const near = mobs.filter(m => m.d <= 16);
            const hurt = bot.health < this.lastHp - 0.4;
            if (hurt) {
                W({ t: new Date().toISOString(), ev: 'HURT', dmg: +(this.lastHp - bot.health).toFixed(1), hp: +bot.health.toFixed(1), mobs });
            }
            this.lastHp = bot.health;
            if (near.length || hurt) {
                if (!this.engaged) { this.engaged = true; W({ t: new Date().toISOString(), ev: 'ENGAGE' }); }
                const me = bot.entity.position, v = bot.entity.velocity || {};
                W({
                    t: new Date().toISOString(), ev: 'tick',
                    pos: [+me.x.toFixed(1), +me.y.toFixed(1), +me.z.toFixed(1)],
                    hp: +bot.health.toFixed(1), food: bot.food,
                    held: (bot.heldItem && bot.heldItem.name) || 'empty',
                    ground: !!bot.entity.onGround,
                    vy: +(v.y || 0).toFixed(2),
                    act: (bot.modes && bot.modes.behavior_log ? '' : '') || (agent.actions && agent.actions.currentActionLabel) || '',
                    mobs,
                });
            } else if (this.engaged && mobs.every(m => m.d > 20)) {
                this.engaged = false;
                W({ t: new Date().toISOString(), ev: 'DISENGAGE', hp: +bot.health.toFixed(1) });
            }
        }
    },
    {
        name: 'reflex_watchdog',
        description: 'Force-release a wedged self_preservation execute (taking damage, standing still, reflex locked).',
        interrupts: [],
        on: true,
        active: false,
        always: true,   // pure supervisor: must tick even while everything else is wedged
        lastPos: null, lastMove: 0, lastHp: 20, hurtAt: 0, releasedAt: 0,
        update: async function (agent) {
            // ★Death #264 (blackbox): bot floated DEAD STILL at y61 surface water for 30+s
            // and drowned at full daylight, zero mobs — act showed self_preservation active
            // the whole time, yet the (fully capable) y>=55 swim-to-shore branch never ran.
            // Mechanism: an earlier execute() (pathfinder await that never resolves) leaves
            // the mode active=true forever, and the scheduler's !mode.active gate means NO
            // new emergency can ever be handled. This is the mirror image of the blackbox
            // scheduler trap: there a mode never STARTED, here one never ENDS.
            // Detector: taking damage + hasn't moved 0.5 blocks in 8s + self_preservation
            // active = the life-saving reflex itself is wedged. Release: interrupt flag +
            // clear controls + pathfinder.setGoal(null) (the actual key for a hung
            // goToPosition promise). If still wedged 20s later, force active=false so the
            // scheduler can re-enter the correct branch — a re-entry race beats dying still.
            const bot = agent.bot;
            const now = Date.now();
            try {
                const p = bot.entity.position;
                if (!this.lastPos || p.distanceTo(this.lastPos) > 0.5) { this.lastPos = p.clone(); this.lastMove = now; }
                if (bot.health < this.lastHp - 0.4) this.hurtAt = now;
                this.lastHp = bot.health;
                // ★PIN-BREAKER (layer-independent): pinned within ~10b for 15+ min means
                // SOME long loop (any layer — prepNether night-hold, chopWood, a skill
                // await) is holding control while making zero progress. Fire a forced
                // interrupt once a minute: every well-behaved loop honors interrupt_code
                // and returns, control flows back to missionNether's top-of-loop where
                // the BREAKOUT last-resort lives. (The mission-layer stagnation timer
                // could never fire while a child loop held the stack — same trap as the
                // chopWood deep-dig; an always-mode is the only layer that sees it all.)
                if (!this.pinAnchor || bot.entity.position.distanceTo(this.pinAnchor) > 10) {
                    this.pinAnchor = bot.entity.position.clone(); this.pinAt = now; this.pinKick = 0;
                } else if (now - this.pinAt > 5 * 60 * 1000 && now - (this.pinKick || 0) > 60000) {
                    // ★BUNKER EXEMPTION (idle-wedge 同款,pin-breaker 漏了这层 — 实拍: 夜间
                    // 蹲坑驻留>5min 被判 pinned,每60s强拆一次,bot被踢到夜间地表乱跑,撞上
                    // enderman 拉响 risk83。正当夜蹲(夜间+头顶有盖)的"钉住"是庇护不是死锁。)
                    let nightBunker = false;
                    let coveredNow = false;
                    const tP = (bot.time && bot.time.timeOfDay) || 0;
                    for (let dyP = 1; dyP <= 6; dyP++) {
                        const bP = bot.blockAt(bot.entity.position.offset(0, dyP, 0));
                        if (bP && bP.boundingBox === 'block') { coveredNow = true; break; }
                    }
                    if (tP >= 12000 && tP <= 23500 && coveredNow) nightBunker = true;
                    let lowFoodShelter = false;
                    let famineHold = false;
                    let noRegenLowHpHold = false;
                    let bodyBudgetContainedHold = false;
                    let tableRecoveryHold = false;
                    let killBoxLowFoodHold = false;
                    let closestHostile = Infinity;
                    let closestCreeper = Infinity;
                    try {
                        const normalEdible = bot.inventory.items().some(i => i && i.name && NORMAL_FOOD_RE.test(i.name));
                        const emergencyEdible = bot.inventory.items().some(i => i && i.name && /rotten_flesh|spider_eye/.test(i.name));
                        const edible = normalEdible || emergencyEdible;
                        for (const e of Object.values(bot.entities || {})) {
                            if (!(e && e.position && e.name && /zombie|skeleton|creeper|spider|witch|drowned|husk|stray|pillager|cave_spider/i.test(e.name))) continue;
                            const d = e.position.distanceTo(bot.entity.position);
                            if (d < closestHostile) closestHostile = d;
                            if (/creeper/i.test(e.name) && d < closestCreeper) closestCreeper = d;
                        }
                        const hostileNear = closestHostile < 12;
                        const pointBlankHostile = closestHostile < 4.25 || closestCreeper < 5.5;
                        lowFoodShelter = coveredNow && bot.food < 12 && !edible && !hostileNear;
                        const pNow = bot.entity.position;
                        const feetNow = bot.blockAt(pNow) || { name: 'air' };
                        const headNow = bot.blockAt(pNow.offset(0, 1, 0)) || { name: 'air' };
                        const fluidNow = /water|lava|fire/.test(feetNow.name || '') || /water|lava|fire/.test(headNow.name || '');
                        const fallingNow = !bot.entity.onGround && bot.entity.velocity && bot.entity.velocity.y < -0.25;
                        famineHold = bot.food <= 2 && bot.health <= 6 && !edible && !hostileNear && !fluidNow && !fallingNow;
                        const prepBackoff = (bot._prepLowHpNoFoodUntil && now < bot._prepLowHpNoFoodUntil)
                            || (bot._prepNoFoodSurfaceBackoffUntil && now < bot._prepNoFoodSurfaceBackoffUntil);
                        noRegenLowHpHold = bot.health < 14 && bot.food < 18 && !normalEdible
                            && !!prepBackoff && !hostileNear && !fluidNow && !fallingNow;
                        const enclosedNow = !!(bot._mobility && bot._mobility.enclosed);
                        const containedMob = !!(bot._mobility && /POCKET|MAROONED|ENTOMBED/.test(bot._mobility.state || ''));
                        bodyBudgetContainedHold = bot.health <= 8 && bot.food <= 6 && !normalEdible
                            && (coveredNow || enclosedNow || containedMob) && !pointBlankHostile && !fluidNow && !fallingNow;
                        let progressTail = '';
                        let progressFresh = false;
                        try {
                            const progressFile = 'bots/_supervisor/progress.txt';
                            const stat = fs.statSync(progressFile);
                            progressFresh = now - stat.mtimeMs < 90000;
                            const len = Math.min(8192, stat.size);
                            const fd = fs.openSync(progressFile, 'r');
                            try {
                                const buf = Buffer.alloc(len);
                                fs.readSync(fd, buf, 0, len, stat.size - len);
                                progressTail = buf.toString('utf8');
                            } finally {
                                fs.closeSync(fd);
                            }
                        } catch (e) {}
                        killBoxLowFoodHold = progressFresh
                            && /\[mission\] ★KILL-BOX gated: low-food pocket recovery/.test(progressTail)
                            && ((bot._currentSkill || '') === 'missionNether' || /==== missionNether START/.test(progressTail))
                            && bot.food <= 6
                            && !normalEdible
                            && (coveredNow || enclosedNow || containedMob)
                            && !pointBlankHostile
                            && !fluidNow
                            && !fallingNow;
                        if (bot.health >= 14 && bot.food >= 14 && !fluidNow && !fallingNow) {
                            const tableProgressHold = progressFresh && /TABLE (gate|recovery) for /.test(progressTail);
                            const progressSaysNoActionable = /TABLE gate for [^\n]*actionable12=0/.test(progressTail)
                                || /TABLE recovery for [^\n]*daylight safe window/.test(progressTail);
                            const missionOwnsProgress = /==== prepNether START|\[mission\] not kitted .*prepNether|TABLE (gate|recovery) for /.test(progressTail);
                            tableRecoveryHold = tableProgressHold
                                && ((bot._currentSkill || '') === 'missionNether' || missionOwnsProgress)
                                && (progressSaysNoActionable || closestHostile >= 16);
                        }
                    } catch (e) {}
                    const activeBodyWork = !!(bot.targetDigBlock || bot._mineMotionActiveDig || (bot._bodyDigLockUntil && Date.now() < bot._bodyDigLockUntil));
                    const activeEscapeWork = /surfaceUp|feedUp/.test(bot._currentSkill || '');
                    if ((nightBunker || lowFoodShelter || famineHold || noRegenLowHpHold || bodyBudgetContainedHold || tableRecoveryHold || killBoxLowFoodHold) && !activeBodyWork && !activeEscapeWork) {
                        // Legit sheltering is deliberate immobility, not a stale stack.
                        // Reset the pin window so dawn/food recovery gets a fresh grace
                        // period instead of being kicked immediately by old shelter time.
                        if (killBoxLowFoodHold && now - (bot._lastPinKillBoxLowFoodExemptAt || 0) > 60000) {
                            bot._lastPinKillBoxLowFoodExemptAt = now;
                            try {
                                fs.appendFileSync('bots/_supervisor/progress.txt',
                                    `[${new Date().toISOString()}] [reflex_watchdog] pinned kill-box low-food hold exempt: food=${bot.food} hp=${Math.round(bot.health || 0)} mob=${bot._mobility ? bot._mobility.state : '-'} enclosed=${!!(bot._mobility && bot._mobility.enclosed)} closestHostile=${Number.isFinite(closestHostile) ? closestHostile.toFixed(1) : 'none'} — no forced interrupt\n`);
                            } catch (e) {}
                        }
                        if (bodyBudgetContainedHold && now - (bot._lastPinBodyBudgetExemptAt || 0) > 60000) {
                            bot._lastPinBodyBudgetExemptAt = now;
                            try {
                                fs.appendFileSync('bots/_supervisor/progress.txt',
                                    `[${new Date().toISOString()}] [reflex_watchdog] pinned body-budget contained hold exempt: food=${bot.food} hp=${Math.round(bot.health || 0)} mob=${bot._mobility ? bot._mobility.state : '-'} enclosed=${!!(bot._mobility && bot._mobility.enclosed)} covered=${coveredNow} — no forced interrupt\n`);
                            } catch (e) {}
                        }
                        if (tableRecoveryHold && now - (bot._lastPinTableRecoveryExemptAt || 0) > 60000) {
                            bot._lastPinTableRecoveryExemptAt = now;
                            try {
                                fs.appendFileSync('bots/_supervisor/progress.txt',
                                    `[${new Date().toISOString()}] [reflex_watchdog] pinned table recovery hold exempt: food=${bot.food} hp=${Math.round(bot.health || 0)} mob=${bot._mobility ? bot._mobility.state : '-'} closestHostile=${Number.isFinite(closestHostile) ? closestHostile.toFixed(1) : 'none'} — no forced interrupt\n`);
                            } catch (e) {}
                        }
                        this.pinAnchor = bot.entity.position.clone();
                        this.pinAt = now;
                        this.pinKick = 0;
                    }
                    if (!nightBunker && !lowFoodShelter && !famineHold && !noRegenLowHpHold && !bodyBudgetContainedHold && !tableRecoveryHold && !killBoxLowFoodHold && !activeBodyWork && !activeEscapeWork) {
                        this.pinKick = now;
                        say(agent, 'Pinned 15min+ — kicking the stack (forced interrupt).');
                        try { bot.interrupt_code = true; } catch (e) {}
                        try { bot._chopGen = (bot._chopGen || 0) + 1; } catch (e) {}
                        try { bot._supervisorCancelAt = Date.now(); } catch (e) {}
                        try { bot.pathfinder.setGoal(null); } catch (e) {}
                        try { bot.clearControlStates(); } catch (e) {}
                    }
                }
                const sp = modes_list.find(m => m.name === 'self_preservation');
                if (!sp || !sp.active) { this.releasedAt = 0; return; }
                const beingHurt = now - this.hurtAt < 2500;
                const frozen = now - this.lastMove > 8000;
                // ★IN-WATER variant (death #268): floating dead-still while two drowned
                // closed from 4.5b to 2.1b — hp wasn't actively dropping, so the
                // being-hurt gate never opened, and the final hit was lethal. In water
                // there is NO legitimate stand-still-while-locked state (bunkering is
                // impossible in water), so a closing hostile + frozen reflex = wedged.
                let waterThreat = false;
                try {
                    const WS = ['water', 'flowing_water'];
                    const inWater = WS.includes((bot.blockAt(p) || {}).name) || WS.includes((bot.blockAt(p.offset(0, 1, 0)) || {}).name);
                    if (inWater && now - this.lastMove > 6000) {
                        const HRW = /zombie|skeleton|creeper|spider|witch|drowned|husk|stray|pillager|cave_spider/i;
                        waterThreat = Object.values(bot.entities).some(e =>
                            e && e.position && e.name && HRW.test(e.name) && e.position.distanceTo(p) < 8);
                    }
                } catch (e) {}
                // ★IDLE-WEDGE variant (3rd form, caught live by act_trace: act=
                // self_preservation pinned for minutes with ZERO keys pressed and zero
                // movement — an execute hanging on an await with no control output,
                // while no damage and no water meant neither earlier detector fired).
                // sp active + 30s still + every control key off = wedged, period.
                let idleWedge = false;
                try {
                    if (now - this.lastMove > 30000) {
                        const cs = bot.controlState || {};
                        // no keys at all = wedged; ALSO jump-only with zero displacement
                        // (the lake-float form: swim branch holds jump to stay afloat
                        // while its shore-swim execute hangs — real swimming always has
                        // forward; bobbing in place for 30s+ is never legitimate)
                        const horiz = ['forward', 'back', 'left', 'right', 'sprint'].some(k => cs[k]);
                        idleWedge = !horiz;   // with or without jump — 30s still + no horizontal intent = wedged
                        // ★BUNKER EXEMPTION (the watchdog-vs-bunker death spiral, 300ms
                        // "securing ↔ releasing" pairs flooding agent.err: a NIGHT bunker
                        // wait IS still + keyless + sp-active — that's what sheltering
                        // looks like. Releasing it re-fires bunkerDown, which gets
                        // released again: an interrupt storm that froze EVERYTHING,
                        // act_trace included. Covered overhead at night = legitimate.)
                        if (idleWedge) {
                            const t = (bot.time && bot.time.timeOfDay) || 0;
                            if (t >= 12000 && t <= 23500) {
                                for (let dyB = 1; dyB <= 6; dyB++) {
                                    const bB = bot.blockAt(bot.entity.position.offset(0, dyB, 0));
                                    if (bB && bB.boundingBox === 'block') { idleWedge = false; break; }
                                }
                            }
                        }
                    }
                } catch (e) {}
                if (!(beingHurt && frozen) && !waterThreat && !idleWedge) return;
                if (!this.releasedAt) {
                    this.releasedAt = now;
                    say(agent, 'Reflex wedged while taking damage — force releasing!');
                    try { bot.interrupt_code = true; } catch (e) {}
                    try { bot.clearControlStates(); } catch (e) {}
                    try { bot.pathfinder.setGoal(null); } catch (e) {}
                } else if (now - this.releasedAt > 20000) {
                    this.releasedAt = 0;
                    say(agent, 'Reflex still wedged — hard reset.');
                    try { bot.pathfinder.setGoal(null); } catch (e) {}
                    try { bot.clearControlStates(); } catch (e) {}
                    sp.active = false;
                }
            } catch (e) {}
        }
    },
    {
        name: 'mobility',
        description: 'Continuous god-view modeling of the bot\'s freedom of movement; instant dig-out when entombed.',
        interrupts: ['all'],
        on: true,
        active: false,
        lastEval: 0, lastState: '', stateSince: 0,
        update: async function (agent) {
            // ★机动性状态机 (用户: "bot应该通过上帝视角时刻对周围环境程序化建模,维护
            // 一个状态机" — 活埋事故的机理: 身体两格是空气(窒息反射不触发)但四面+顶
            // 全实心(一切移动失败),这个状态在bot的认知里根本不存在,于是它"转身但出
            // 不去"几小时。blockAt 就是零成本上帝视角 — 每2秒分类:
            //   FREE     有≥1个可走出口(2高空间+4内落脚)     → 正常
            //   POCKET   无水平出口但头顶开(可垫/可跳)        → 60s未变则垫/挖上
            //   ENTOMBED 出口零且头顶实心(活埋)               → 立即挖,不等任何计时
            //   SWIM     在水里                                → 交给游泳本能
            // 状态写 bot._mobility(vitals广播给监工),变化记 progress。)
            const bot = agent.bot;
            const now = Date.now();
            if (now - this.lastEval < 2000) return;
            this.lastEval = now;
            // ★MAROONED detection inputs (用户: "FREE只管了最小的——寻路找不到路径持续
            // 原地打转怎么判?" 答案=bot自己已有的两个信号流的交集):
            //   ① pathfinder 失败流: path_update 事件里 noPath/timeout 的滚动计数
            //   ② 净位移锚: 离锚>20格才重锚 — 微观晃动骗不过(watchdog v2 同款搬进bot)
            // FREE(局部能动) + 锚定>8min(宏观没动) + 10min内寻路失败≥4 = MAROONED
            if (!this._pathHooked) {
                this._pathHooked = true;
                this.noPathTimes = [];
                try {
                    bot.on('path_update', (r) => {
                        try { if (r && (r.status === 'noPath' || r.status === 'timeout')) { this.noPathTimes.push(Date.now()); if (this.noPathTimes.length > 50) this.noPathTimes.shift(); } } catch (e) {}
                    });
                } catch (e) {}
            }
            let st;
            try {
                const m = bot.entity.position.floored();
                const solid = (b) => b && b.boundingBox === 'block';
                const exits = [];
                for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    if (solid(bot.blockAt(m.offset(dx, 0, dz))) || solid(bot.blockAt(m.offset(dx, 1, dz)))) continue;
                    let floor = false;
                    for (let dd = 1; dd <= 4; dd++) { const fb = bot.blockAt(m.offset(dx, -dd, dz)); if (solid(fb) || /water/.test((fb && fb.name) || '')) { floor = true; break; } }
                    if (floor) exits.push([dx, dz]);
                }
                const upOpen = !solid(bot.blockAt(m.offset(0, 2, 0)));
                const inWater = /water/.test((bot.blockAt(m) || {}).name || '') || /water/.test((bot.blockAt(m.offset(0, 1, 0)) || {}).name || '');
                st = inWater ? 'SWIM' : (exits.length ? 'FREE' : (upOpen ? 'POCKET' : 'ENTOMBED'));
                // regional entrapment check (only escalates FREE — the others have own reflexes)
                const p = bot.entity.position;
                if (!this.regAnchor || p.distanceTo(this.regAnchor) > 20) { this.regAnchor = p.clone(); this.regAt = now; }
                if (st === 'FREE') {
                    // ★CLIMBING heartbeat (凿崖让步: chopWood dig-staircase 是垂直工程,水平
                    // 位移小,正好踩 MAROONED 判定(90s没挪20格)——行军插队把凿崖斩在半路,
                    // FREE窗口(~2min)<凿崖启动(3-4min)=结构性饿死。爬山=有目的工程不是被困:
                    // 心跳2分钟内 → 重置锚,不判。)
                    if (bot._climbingAt && now - bot._climbingAt < 120000) { this.regAnchor = bot.entity.position.clone(); this.regAt = now; }
                    // speedrun-grade thresholds (用户: "8分钟你要上天吧" — 正确。代价分析:
                    // 误判 MAROONED 无害(行军=朝锚挖几格路,顺路),漏判昂贵(原地空转分钟级)
                    // → 阈值激进: 90秒没挪出20格 + 3分钟内寻路失败≥3 = 困,开挖。人类试三
                    // 个方向走不通也就这个耗时。)
                    const noPathRecent = (this.noPathTimes || []).filter(t => now - t < 180000).length;
                    if (now - this.regAt > 90 * 1000 && noPathRecent >= 3) st = 'MAROONED';
                    // ★STICKY MAROONED (打转机理之一: 行军挖出20格→重锚FREE→寻路依然全堵
                    // →90s后再判MAROONED→方向已被清,重选可能反向→挖回去 = FREE↔MAROONED
                    // 振荡。修: 退出不光看位移,还要寻路真恢复;且最短驻留3分钟——因为移动
                    // 独占门拦掉任务层寻路后 noPath 信号断流,纯信号判定会被自己饿死。)
                    else if (this.lastState === 'MAROONED'
                        && ((this.noPathTimes || []).some(t => now - t < 120000)
                            || now - (this.maroonedAt || 0) < 180000)) st = 'MAROONED';
                    if (st === 'MAROONED' && this.lastState !== 'MAROONED') {
                        this.maroonedAt = now;
                        try { bot._maroonedMarchOrigin = p.clone(); } catch (e) {}
                    }
                }
                if (st !== this.lastState) {
                    this.lastState = st; this.stateSince = now;
                    if (st !== 'MAROONED') { bot._marchDir = null; bot._marchFails = 0; bot._maroonedMarchOrigin = null; }   // fresh heading next entrapment
                    try { fs.appendFileSync('bots/_supervisor/progress.txt', `[${new Date().toISOString()}] [mobility] → ${st}${exits.length ? ' exits=' + JSON.stringify(exits) : ''}\n`); } catch (e) {}
                }
                // ★ENCLOSED 正交属性 (用户: "全知视角判断自己是否处在封闭地穴(与地面联通
                // 很远)——是的话夜里就不需要停下来"。夜门们用 tod+y≥50 当"夜间暴露"的代理
                // 变量是错的: 崖体隧道里的 bot 是封闭环境,夜晚白天没区别,却被停工/蹲坑/
                // 驻留。判定: 3x3采样网格(间隔4格,覆盖±4格),每列向上探35格,全部有实心
                // = 与开放天空隔离(开口至少在远处/高处)。进入需连续2次评定(防单格屋檐误
                // 判),退出即时(怀疑暴露就按暴露处理,保守方向不对称)。每2s一评,~315次
                // blockAt,毫秒级。消费方: sp蹲坑/prepNether夜hold/chopWood NIGHT-BAIL。)
                let enc = true;
                try {
                    const mP = bot.entity.position.floored();
                    outer:
                    for (const ddx of [-4, 0, 4]) {
                        for (const ddz of [-4, 0, 4]) {
                            let covered = false;
                            for (let dy = 2; dy <= 36; dy++) {
                                const cb = bot.blockAt(mP.offset(ddx, dy, ddz));
                                if (cb && cb.boundingBox === 'block') { covered = true; break; }
                            }
                            if (!covered) { enc = false; break outer; }
                        }
                    }
                } catch (e) { enc = false; }
                this._encStreak = enc ? (this._encStreak || 0) + 1 : 0;
                const enclosed = this._encStreak >= 2;
                if (enclosed !== this._lastEnc) {
                    this._lastEnc = enclosed;
                    try { fs.appendFileSync('bots/_supervisor/progress.txt', `[${new Date().toISOString()}] [mobility] enclosed → ${enclosed}\n`); } catch (e) {}
                }
                bot._mobility = { state: st, since: this.stateSince, exits, enclosed };
            } catch (e) { return; }
            if (famineBodyFreeze(agent, 'mobility')) return;
            const STONY_MOBILITY = /stone|deepslate|andesite|diorite|granite|tuff|_ore$|obsidian|cobble/;
            const hasPick = () => bot.inventory.items().some(it => /_pickaxe$/.test(it.name));
            const normalEdibleHeld = () => {
                try { return bot.inventory.items().some(i => i && i.name && NORMAL_FOOD_RE.test(i.name)); }
                catch (e) { return false; }
            };
            const noRegenSafeAirHold = () => {
                const nowHold = Date.now();
                if (!(bot.health < 14 && bot.food < 18) || normalEdibleHeld()) return null;
                const prepLow = Math.max(0, (bot._prepLowHpNoFoodUntil || 0) - nowHold);
                const prepSurface = Math.max(0, (bot._prepNoFoodSurfaceBackoffUntil || 0) - nowHold);
                const isNight = (() => { try { const t = bot.time && bot.time.timeOfDay; return t >= 12000 && t <= 23500; } catch (e) { return false; } })();
                const skill = bot._currentSkill || '';
                const survivalSkill = /prepNether|feedUp|consume|auto_eat/i.test(skill);
                const bodyBudgetHold = bot.health <= 8 && bot.food <= 6;
                if (!bodyBudgetHold && !prepLow && !prepSurface && !isNight && !survivalSkill) return null;
                const p = bot.entity.position;
                const feet = bot.blockAt(p) || { name: 'air' };
                const head = bot.blockAt(p.offset(0, 1, 0)) || { name: 'air' };
                if (feet.boundingBox === 'block' || head.boundingBox === 'block') return null;
                if (/water|lava|fire/.test(feet.name || '') || /water|lava|fire/.test(head.name || '')) return null;
                if (!bot.entity.onGround && bot.entity.velocity && bot.entity.velocity.y < -0.25) return null;
                const hostile = Object.values(bot.entities || {}).some(e =>
                    e && e !== bot.entity && e.position && mc.isHostile(e) &&
                    e.position.distanceTo(p) < (/creeper/i.test(e.name || '') ? 5.5 : 4.25));
                if (hostile) return null;
                return { prepLow, prepSurface, isNight, skill, bodyBudgetHold, pos: p };
            };
            const heldIsPick = () => !!(bot.heldItem && /_pickaxe$/.test(bot.heldItem.name));
            const plannedNoPickStone = () => Date.now() < (bot._mobilityPlannedNoPickStoneUntil || 0);
            const invCounts = () => {
                try {
                    const out = {};
                    for (const it of bot.inventory.items()) out[it.name] = (out[it.name] || 0) + it.count;
                    return out;
                } catch (e) { return {}; }
            };
            const reachableCraftingTable = () => {
                try {
                    const c = invCounts();
                    if ((c.crafting_table || 0) > 0) return true;
                    const near = world.getNearestBlock(bot, 'crafting_table', 4);
                    return !!(near && bot.entity.position.distanceTo(near.position) <= 4.5);
                } catch (e) {
                    return false;
                }
            };
            const hasTableMaterials = (c) => Object.keys(c || {}).some(n => /_planks$/.test(n) && c[n] >= 4);
            const emergencyPickBlocked = (why, reason, extra = '') => {
                const now = Date.now();
                bot._emergencyPickBlockedUntil = now + 10000;
                if (now - (bot._lastEmergencyPickBlockedLogAt || 0) > 10000) {
                    bot._lastEmergencyPickBlockedLogAt = now;
                    try {
                        fs.appendFileSync('bots/_supervisor/progress.txt',
                            `[${new Date().toISOString()}] [mobility] emergency pick blocked (${why}): ${reason}${extra ? ' ' + extra : ''}\n`);
                    } catch (e) {}
                }
                return false;
            };
            const ensureEmergencyPick = async (why = '') => {
                if (hasPick()) return true;
                if (Date.now() < (bot._emergencyPickBlockedUntil || 0)) return false;
                const c = invCounts();
                const plankName = Object.keys(c).find(n => /_planks$/.test(n) && c[n] >= 3);
                let recipe = null;
                if ((c.cobblestone || 0) >= 3 && (c.stick || 0) >= 2) recipe = 'stone_pickaxe';
                else if (plankName && (c.stick || 0) >= 2) recipe = 'wooden_pickaxe';
                if (!recipe) return false;
                if (!reachableCraftingTable()) {
                    if (!hasTableMaterials(c)) {
                        return emergencyPickBlocked(why, `${recipe} needs reachable crafting_table`, `cobble=${c.cobblestone || 0} stick=${c.stick || 0} table=${c.crafting_table || 0}`);
                    }
                    try {
                        const madeTable = await (skills.craftRecipeLocal || skills.craftRecipe)(bot, 'crafting_table', 1);
                        if (madeTable === false || !reachableCraftingTable()) {
                            return emergencyPickBlocked(why, `${recipe} cannot place/reach crafting_table`, `planks=${plankName ? c[plankName] : 0}`);
                        }
                    } catch (e) {
                        return emergencyPickBlocked(why, `crafting_table prep failed: ${e && e.message ? e.message : String(e)}`);
                    }
                }
                try {
                    fs.appendFileSync('bots/_supervisor/progress.txt',
                        `[${new Date().toISOString()}] [mobility] emergency pick craft (${why}): ${recipe}\n`);
                } catch (e) {}
                try {
                    const craftLocal = skills.craftRecipeLocal || skills.craftRecipe;
                    const ok = await Promise.race([
                        craftLocal(bot, recipe, 1),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('emergency-pick-timeout')), 12000)),
                    ]);
                    if (ok === false) emergencyPickBlocked(why, `${recipe} craft returned false`);
                } catch (e) {
                    try {
                        fs.appendFileSync('bots/_supervisor/progress.txt',
                            `[${new Date().toISOString()}] [mobility] emergency pick failed (${why}): ${e && e.message ? e.message : String(e)}\n`);
                    } catch (_) {}
                    try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
                    try { bot.clearControlStates(); } catch (_) {}
                }
                return hasPick();
            };
            const ensurePickForStone = async (block, why = '') => {
                if (!block || !STONY_MOBILITY.test(block.name || '')) return true;
                if (!hasPick()) await ensureEmergencyPick(why);
                if (!hasPick()) return plannedNoPickStone();
                if (heldIsPick()) return true;
                const pick = bot.inventory.items().find(it => /_pickaxe$/.test(it.name));
                try { if (pick) await skills.equip(bot, pick.name); } catch (e) {}
                await new Promise(r => setTimeout(r, 80));
                if (heldIsPick()) return true;
                try { await bot.tool.equipForBlock(block); } catch (e) {}
                await new Promise(r => setTimeout(r, 80));
                if (heldIsPick()) return true;
                try {
                    fs.appendFileSync('bots/_supervisor/progress.txt',
                        `[${new Date().toISOString()}] [mobility] stone dig blocked (${why}): ${block.name} @${block.position.x},${block.position.y},${block.position.z} held=${bot.heldItem ? bot.heldItem.name : 'empty'}\n`);
                } catch (e) {}
                return false;
            };
            const guardedDig = async (block, why = '') => {
                if (!block) return false;
                const owner = `mobility:${why || 'dig'}`;
                const acquire = async () => {
                    const t0 = Date.now();
                    while (Date.now() - t0 < 900) {
                        const busy = bot.targetDigBlock || (bot._bodyDigLockUntil && Date.now() < bot._bodyDigLockUntil);
                        if (!busy || bot._bodyDigLockOwner === owner) {
                            bot._bodyDigLockOwner = owner;
                            bot._bodyDigLockUntil = Date.now() + 6000;
                            return true;
                        }
                        await new Promise(r => setTimeout(r, 80));
                    }
                    try {
                        fs.appendFileSync('bots/_supervisor/progress.txt',
                            `[${new Date().toISOString()}] [mobility] dig slot busy (${why}) target=${block.name}@${block.position.x},${block.position.y},${block.position.z} heldBy=${bot._bodyDigLockOwner || 'targetDigBlock'}\n`);
                    } catch (e) {}
                    return false;
                };
                if (!(await acquire())) return false;
                try {
                    for (let n = 0; n < 2; n++) {
                        const fresh = bot.blockAt(block.position);
                        if (!fresh || fresh.boundingBox !== 'block') return true;
                        if (!(await ensurePickForStone(fresh, why))) return false;
                        if (!STONY_MOBILITY.test(fresh.name || '')) { try { await bot.tool.equipForBlock(fresh); } catch (e) {} }
                        try { bot.clearControlStates(); } catch (e) {}
                        try { await bot.lookAt(fresh.position.offset(0.5, 0.5, 0.5), true); } catch (e) {}
                        try {
                            await Promise.race([
                                bot.dig(fresh, true),
                                new Promise((_, rej) => setTimeout(() => rej(new Error('dig-timeout')), 5000)),
                            ]);
                            return true;
                        } catch (e) {
                            try { bot.stopDigging(); } catch (_) {}
                            try {
                                fs.appendFileSync('bots/_supervisor/progress.txt',
                                    `[${new Date().toISOString()}] [mobility] dig retry ${n} (${why}) ${fresh.name}@${fresh.position.x},${fresh.position.y},${fresh.position.z}: ${e && e.message ? e.message : String(e)}\n`);
                            } catch (_) {}
                            await new Promise(r => setTimeout(r, 140));
                        }
                    }
                    return false;
                } finally {
                    if (bot._bodyDigLockOwner === owner) {
                        bot._bodyDigLockOwner = null;
                        bot._bodyDigLockUntil = 0;
                    }
                }
            };
            // ── reactions ──
            if (st === 'ENTOMBED') {
                // instant dig-out, reflex priority — no stagnation timer, no material
                // gate (entombed = the gate's exception BY DEFINITION). Head toward the
                // anchor; one 2-cell column per execute burst, state re-evaluated next tick.
                execute(this, agent, async () => {
                    const tableHold = tableRecoveryHold(bot);
                    if (tableHold) {
                        try {
                            bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null);
                            bot.pathfinder && bot.pathfinder.stop && bot.pathfinder.stop();
                            bot.clearControlStates();
                        } catch (e) {}
                        if (Date.now() - (bot._lastEntombedTableRecoveryGateAt || 0) > 15000) {
                            bot._lastEntombedTableRecoveryGateAt = Date.now();
                            const p = bot.entity.position.floored();
                            try {
                                fs.appendFileSync('bots/_supervisor/progress.txt',
                                    `[${new Date().toISOString()}] [mobility] ENTOMBED table recovery hold pos=${p.x},${p.y},${p.z} raw16=${tableHold.raw} layered16=${tableHold.layered} nearest=${Number.isFinite(tableHold.nearest) ? tableHold.nearest.toFixed(1) : '-'} day=${!tableHold.isNight} — hold shaft while prepNether owns surface recovery\n`);
                            } catch (e) {}
                        }
                        try { bot._mobility = { ...(bot._mobility || {}), state: 'ENTOMBED', since: this.stateSince }; } catch (e) {}
                        return;
                    }
                    const noRegenHold = noRegenSafeAirHold();
                    if (noRegenHold) {
                        try {
                            if (!/feedUp|surfaceUp|consume|auto_eat/i.test(bot._currentSkill || '')) {
                                bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null);
                                bot.pathfinder && bot.pathfinder.stop && bot.pathfinder.stop();
                                bot.clearControlStates();
                            }
                        } catch (e) {}
                        if (Date.now() - (bot._lastEntombedNoRegenGateAt || 0) > 15000) {
                            bot._lastEntombedNoRegenGateAt = Date.now();
                            try {
                                const p = noRegenHold.pos.floored();
                                fs.appendFileSync('bots/_supervisor/progress.txt',
                                    `[${new Date().toISOString()}] [mobility] ENTOMBED no-regen safe-air gate food=${bot.food} hp=${Math.round(bot.health || 0)} prepLow=${Math.ceil(noRegenHold.prepLow / 1000)}s surface=${Math.ceil(noRegenHold.prepSurface / 1000)}s night=${noRegenHold.isNight} pos=${p.x},${p.y},${p.z} skill=${noRegenHold.skill || '-'} — hold air pocket, no blind dig\n`);
                            } catch (e) {}
                        }
                        try { bot._mobility = { ...(bot._mobility || {}), state: 'ENTOMBED', since: this.stateSince }; } catch (e) {}
                        return;
                    }
                    say(agent, 'Entombed — digging out!');
                    let bx = 96, bz = -34;
                    try { const bj = JSON.parse(fs.readFileSync('bots/_supervisor/bed.json', 'utf8')); if (typeof bj.x === 'number') { bx = bj.x; bz = bj.z; } } catch (e) {}
                    // ghost-bed guard: 距床>60(缰绳外)=床大概率已无效(死276后 bed.json 还是
                    // 崖壁区老坐标,挖出方向被幽灵床带偏) → spawn_pos 兜底(真锚)
                    try { if (Math.hypot(bx - bot.entity.position.x, bz - bot.entity.position.z) > 60) { const sj = JSON.parse(fs.readFileSync('bots/_supervisor/spawn_pos.json', 'utf8')); if (typeof sj.x === 'number') { bx = sj.x; bz = sj.z; } } } catch (e) {}
                    const me = bot.entity.position;
                    const sx = Math.abs(bx - me.x) > Math.abs(bz - me.z) ? Math.sign(bx - me.x) || 1 : 0;
                    const sz = sx === 0 ? Math.sign(bz - me.z) || 1 : 0;
                    const m2 = me.floored();
                    for (const c of [m2.offset(sx, 1, sz), m2.offset(sx, 0, sz)]) {
                        const b = bot.blockAt(c);
                        if (b && b.boundingBox === 'block' && !/bedrock|water|lava/.test(b.name)) {
                            await guardedDig(b, 'ENTOMBED');
                        }
                    }
                    try { await bot.lookAt(m2.offset(sx + 0.5, 1.6, sz + 0.5), true); } catch (e) {}
                    bot.setControlState('forward', true);
                    await new Promise(r => setTimeout(r, 600));
                    try { bot.clearControlStates(); } catch (e) {}
                });
            } else if (st === 'MAROONED') {
                // ★ENGINEERED MARCH — locally free but every pathfind dead-ends (shattered
                // cliff/lake terrain): stop asking the planner, BUILD the road. Locked
                // heading toward the anchor; per segment: clear the 2-high cell ahead
                // (material-gated: no-pick never bare-hands stone), bridge a gap
                // (place into the NEIGHBOR cell at foot height, body-clearance checked,
                // no self-place race), step in. ~6 cells per burst, state re-evaluated
                // between bursts; >20 blocks of net displacement re-anchors to FREE.
                execute(this, agent, async () => {
                    const noEdible = !bot.inventory.items().some(i => FAMINE_FOOD_RE.test(i.name || ''));
                    if (bot.food <= 6 && noEdible) {
                        try { bot.clearControlStates(); } catch (e) {}
                        try {
                            fs.appendFileSync('bots/_supervisor/progress.txt',
                                `[${new Date().toISOString()}] [mobility] MAROONED famine gate food=${bot.food} hp=${Math.round(bot.health || 0)} — release to feedUp, no road dig\n`);
                        } catch (e) {}
                        this.lastState = 'FREE';
                        this.stateSince = Date.now();
                        this.regAnchor = bot.entity.position.clone();
                        this.regAt = Date.now();
                        this.maroonedAt = 0;
                        bot._marchDir = null;
                        bot._marchFails = 0;
                        bot._maroonedMarchOrigin = null;
                        try { bot._mobility = { ...(bot._mobility || {}), state: 'FREE', since: this.stateSince }; } catch (e) {}
                        return;
                    }
                    say(agent, 'Marooned — engineering a road out.');
                    try { if (!bot._maroonedMarchOrigin) bot._maroonedMarchOrigin = bot.entity.position.clone(); } catch (e) {}
                    // ★LOCKED MARCH DIRECTION (用户实拍"左挖一下右挖一下像无头苍蝇": 旧版每
                    // burst 重算方向,而"距锚<25反向"的翻转边界正好骑在 bot 的徘徊半径上 —
                    // 每轮翻一次=方向振荡。修: 方向第一次算好就挂 bot._marchDir 锁死,全程
                    // 不重算;只有该方向连续2个burst位移<2格(真走不动)才右转90°。)
                    if (!bot._marchDir) {
                        // ★MARCH TOWARD A TREE first (宏观钟摆机理: "距床<25反向开拓"把行军
                        // 派进东侧迷宫,>25又派回——25格边界两侧反复横跳;而锚区整体是寻路孤岛
                        // (树全在崖顶,11棵拉黑,任务层在哪都 noPath 累积),MAROONED 必然复发,
                        // 行军成了无目的钟摆。人类被困+缺木头不会盲目开拓——朝看得见的树修路。
                        // 拉黑树="寻路不可达",行军不用寻路,修路恰恰可达。y差>6的崖顶冠不追
                        // (水平行军够不着),无低位树才回退朝床/背床。)
                        const me0 = bot.entity.position;
                        let ux = null, uz = null;
                        try {
                            const logIds = Object.values(bot.registry.blocksByName)
                                .filter(b => /_log$/.test(b.name)).map(b => b.id);
                            const hits = bot.findBlocks({ matching: logIds, maxDistance: 64, count: 8 });
                            const reachable = (hits || []).filter(p => Math.abs(p.y - me0.y) <= 6)
                                .sort((a, b) => me0.distanceTo(a) - me0.distanceTo(b));
                            if (reachable.length) {
                                ux = reachable[0].x - me0.x; uz = reachable[0].z - me0.z;
                                say(agent, `March target: log @${reachable[0].x},${reachable[0].y},${reachable[0].z}`);
                            }
                        } catch (e) {}
                        if (ux === null) {
                            let bx = 96, bz = -34;
                            try { const bj = JSON.parse(fs.readFileSync('bots/_supervisor/bed.json', 'utf8')); if (typeof bj.x === 'number') { bx = bj.x; bz = bj.z; } } catch (e) {}
                            // ghost-bed guard: 距床>60=床大概率已无效(死276后 bed.json 还是崖壁区
                            // 老坐标,行军被幽灵床带偏朝东远离 spawn 的树) → spawn_pos 兜底
                            try { if (Math.hypot(bx - me0.x, bz - me0.z) > 60) { const sj = JSON.parse(fs.readFileSync('bots/_supervisor/spawn_pos.json', 'utf8')); if (typeof sj.x === 'number') { bx = sj.x; bz = sj.z; } } } catch (e) {}
                            const dHome = Math.hypot(bx - me0.x, bz - me0.z);
                            ux = (bx - me0.x); uz = (bz - me0.z);
                            if (dHome < 25) { ux = -ux; uz = -uz; }
                        }
                        const sx0 = Math.abs(ux) > Math.abs(uz) ? Math.sign(ux) || 1 : 0;
                        bot._marchDir = [sx0, sx0 === 0 ? Math.sign(uz) || 1 : 0];
                        bot._marchFails = 0;
                    }
                    const [sx, sz] = bot._marchDir;
                    const _mStart = bot.entity.position.clone();
                    const _origin = bot._maroonedMarchOrigin || _mStart;
                    const _foodTight = bot.food <= 10 && noEdible;
                    const _maxSeg = _foodTight ? 2 : 6;
                    const FILLR = /^dirt$|cobblestone|cobbled|granite|andesite|diorite|^stone$|tuff|gravel|_planks$|_log$/;
                    const canMarchDig = (b) => b
                        && b.boundingBox === 'block'
                        && !/bedrock|water|lava/.test(b.name)
                        && (hasPick() || !STONY_MOBILITY.test(b.name));
                    for (let seg = 0; seg < _maxSeg; seg++) {
                        if (bot.interrupt_code || bot.health <= 0) break;
                        const m2 = bot.entity.position.floored();
                        let stoneBlocked = null;
                        // clear the 2-high cell ahead
                        for (const c of [m2.offset(sx, 1, sz), m2.offset(sx, 0, sz)]) {
                            const b = bot.blockAt(c);
                            if (b && b.boundingBox === 'block' && !/bedrock|water|lava/.test(b.name)) {
                                if (!canMarchDig(b)) { stoneBlocked = b; break; }
                                await guardedDig(b, 'MAROONED');
                            }
                        }
                        if (stoneBlocked) {
                            if (!hasPick() && await ensureEmergencyPick('MAROONED-gate')) {
                                stoneBlocked = null;
                                continue;
                            }
                            try { bot.clearControlStates(); } catch (e) {}
                            try { bot._maroonedNoPickBlockedAt = Date.now(); } catch (e) {}
                            const nearbyLog = (() => {
                                try {
                                    const names = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'];
                                    for (const n of names) {
                                        const id = bot.registry && bot.registry.blocksByName[n] ? bot.registry.blocksByName[n].id : null;
                                        if (id == null) continue;
                                        const hits = bot.findBlocks({ matching: id, maxDistance: 16, count: 1 }) || [];
                                        if (hits.length) return { name: n, pos: hits[0] };
                                    }
                                } catch (e) {}
                                return null;
                            })();
                            if (!hasPick() && nearbyLog) {
                                try {
                                    fs.appendFileSync('bots/_supervisor/progress.txt',
                                        `[${new Date().toISOString()}] [mobility] MAROONED no-pick stone gate but ${nearbyLog.name} nearby @${nearbyLog.pos.x},${nearbyLog.pos.y},${nearbyLog.pos.z} — handoff to chopWood\n`);
                                } catch (e) {}
                                try { bot._maroonedWoodHandoffUntil = Date.now() + 120000; } catch (e) {}
                                try { bot._mobility = { ...(bot._mobility || {}), state: 'FREE', since: Date.now() }; } catch (e) {}
                                this.lastState = 'FREE';
                                this.regAnchor = bot.entity.position.clone();
                                this.regAt = Date.now();
                                this.maroonedAt = 0;
                                bot._marchDir = null;
                                bot._marchFails = 0;
                                break;
                            }
                            try {
                                fs.appendFileSync('bots/_supervisor/progress.txt',
                                    `[${new Date().toISOString()}] [mobility] MAROONED no-pick stone gate: ${stoneBlocked.name} @${stoneBlocked.position.x},${stoneBlocked.position.y},${stoneBlocked.position.z}\n`);
                            } catch (e) {}
                            bot._marchDir = [-sz, sx];
                            bot._marchFails = 0;
                            await new Promise(r => setTimeout(r, 1200));
                            break;
                        }
                        // bridge: require a confirmed safe landing before walking. The old
                        // code checked for floor within 3, attempted a bridge if absent, but
                        // walked even when placement failed; on cliff-top MAROONED marches
                        // that became a fatal fall path.
                        const safeLandingAhead = () => {
                            for (let dd = 1; dd <= 2; dd++) {
                                const fb = bot.blockAt(m2.offset(sx, -dd, sz));
                                if (fb && /water|lava/.test(fb.name || '')) return false;
                                if (fb && fb.boundingBox === 'block') return true;
                            }
                            return false;
                        };
                        let floorOK = safeLandingAhead();
                        if (!floorOK) {
                            const fill = bot.inventory.items().find(it => FILLR.test(it.name));
                            const bp = bot.entity.position;
                            let placedBridge = false;
                            if (fill && Math.hypot(bp.x - (m2.x + sx + 0.5), bp.z - (m2.z + sz + 0.5)) >= 0.85) {
                                let ref = bot.blockAt(m2.offset(sx, -1, sz)), face = Vec3 ? new Vec3(0, 1, 0) : null;
                                if (!(ref && ref.boundingBox === 'block')) { ref = bot.blockAt(m2.offset(0, -1, 0)); face = Vec3 ? new Vec3(sx, 0, sz) : null; }
                                if (ref && ref.boundingBox === 'block' && face) {
                                    try { await bot.equip(fill, 'hand'); } catch (e) {}
                                    try { await bot.placeBlock(ref, face); placedBridge = true; } catch (e) {}
                                }
                            }
                            await new Promise(r => setTimeout(r, 120));
                            floorOK = placedBridge && safeLandingAhead();
                        }
                        if (!floorOK) {
                            try {
                                fs.appendFileSync('bots/_supervisor/progress.txt',
                                    `[${new Date().toISOString()}] [mobility] MAROONED ledge veto dir=${sx},${sz} at ${m2.x},${m2.y},${m2.z} — rotate, no blind step\n`);
                            } catch (e) {}
                            bot._marchDir = [-sz, sx];
                            bot._marchFails = 0;
                            break;
                        }
                        try { await bot.lookAt(m2.offset(sx + 0.5, 1.6, sz + 0.5), true); } catch (e) {}
                        bot.setControlState('forward', true);
                        await new Promise(r => setTimeout(r, 260));
                        try { bot.clearControlStates(); } catch (e) {}
                    }
                    // heading review: rotate 90° only after 2 consecutive dead bursts
                    const burstMoved = bot.entity.position.distanceTo(_mStart);
                    const originMoved = bot.entity.position.distanceTo(_origin);
                    const releaseDist = _foodTight ? 10 : 22;
                    if (originMoved >= releaseDist) {
                        try {
                            fs.appendFileSync('bots/_supervisor/progress.txt',
                                `[${new Date().toISOString()}] [mobility] MAROONED release: moved ${originMoved.toFixed(1)}b from march origin food=${bot.food} maxSeg=${_maxSeg} — re-anchor FREE\n`);
                        } catch (e) {}
                        this.lastState = 'FREE';
                        this.stateSince = Date.now();
                        this.regAnchor = bot.entity.position.clone();
                        this.regAt = Date.now();
                        this.maroonedAt = 0;
                        bot._marchDir = null;
                        bot._marchFails = 0;
                        bot._maroonedMarchOrigin = null;
                        try { bot._mobility = { ...(bot._mobility || {}), state: 'FREE', since: this.stateSince }; } catch (e) {}
                        return;
                    }
                    if (burstMoved < 2) {
                        bot._marchFails = (bot._marchFails || 0) + 1;
                        if (bot._marchFails >= 2) { bot._marchDir = [-sz, sx]; bot._marchFails = 0; }   // rotate 90°
                    } else bot._marchFails = 0;
                });
            } else if (st === 'POCKET' && now - this.stateSince > 30000) {
                // stuck in a roofless pit >60s: dig a step-out toward the anchor side
                execute(this, agent, async () => {
                    const noRegenHold = noRegenSafeAirHold();
                    if (noRegenHold) {
                        try {
                            if (!/feedUp|surfaceUp|consume|auto_eat/i.test(bot._currentSkill || '')) {
                                bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null);
                                bot.pathfinder && bot.pathfinder.stop && bot.pathfinder.stop();
                                bot.clearControlStates();
                            }
                        } catch (e) {}
                        if (Date.now() - (bot._lastPocketNoRegenGateAt || 0) > 15000) {
                            bot._lastPocketNoRegenGateAt = Date.now();
                            try {
                                const p = noRegenHold.pos.floored();
                                fs.appendFileSync('bots/_supervisor/progress.txt',
                                    `[${new Date().toISOString()}] [mobility] POCKET no-regen gate food=${bot.food} hp=${Math.round(bot.health || 0)} bodyBudget=${!!noRegenHold.bodyBudgetHold} prepLow=${Math.ceil(noRegenHold.prepLow / 1000)}s surface=${Math.ceil(noRegenHold.prepSurface / 1000)}s night=${noRegenHold.isNight} pos=${p.x},${p.y},${p.z} skill=${bot._currentSkill || '-'} — hold, no step-out dig\n`);
                            } catch (e) {}
                        }
                        this.stateSince = Date.now();
                        try { bot._mobility = { ...(bot._mobility || {}), state: 'POCKET', since: this.stateSince }; } catch (e) {}
                        return;
                    }
                    const noEdible = !bot.inventory.items().some(i => FAMINE_FOOD_RE.test(i.name || ''));
                    const isNight = (() => { try { const t = bot.time && bot.time.timeOfDay; return t >= 13000 && t <= 23000; } catch (e) { return false; } })();
                    const actionableHostileNear = (() => {
                        try {
                            const me = bot.entity.position;
                            const hostile = /zombie|skeleton|creeper|spider|witch|drowned|husk|stray|pillager|cave_spider/i;
                            return Object.values(bot.entities || {}).some(e => {
                                if (!(e && e.position && e.name && hostile.test(e.name))) return false;
                                const d = e.position.distanceTo(me);
                                const dy = Math.abs(e.position.y - me.y);
                                return d <= 12 && dy <= 4;
                            });
                        } catch (e) {
                            return false;
                        }
                    })();
                    if (!isNight && bot.food <= 6 && noEdible && !actionableHostileNear) {
                        try { bot.clearControlStates(); } catch (e) {}
                        try {
                            fs.appendFileSync('bots/_supervisor/progress.txt',
                                `[${new Date().toISOString()}] [mobility] POCKET low-food daylight gate food=${bot.food} hp=${Math.round(bot.health || 0)} — hold pocket, no step-out dig without food signal\n`);
                        } catch (e) {}
                        this.stateSince = Date.now();
                        try { bot._mobility = { ...(bot._mobility || {}), state: 'POCKET', since: this.stateSince }; } catch (e) {}
                        return;
                    }
                    if (isNight && bot.food <= 6 && noEdible) {
                        try { bot.clearControlStates(); } catch (e) {}
                        try {
                            fs.appendFileSync('bots/_supervisor/progress.txt',
                                `[${new Date().toISOString()}] [mobility] POCKET famine-night gate food=${bot.food} hp=${Math.round(bot.health || 0)} — hold bunker, no step-out dig\n`);
                        } catch (e) {}
                        this.stateSince = Date.now();
                        try { bot._mobility = { ...(bot._mobility || {}), state: 'POCKET', since: this.stateSince }; } catch (e) {}
                        return;
                    }
                    say(agent, 'Pocketed — carving a step out.');
                    const m2 = bot.entity.position.floored();
                    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                        const b1 = bot.blockAt(m2.offset(dx, 1, dz));
                        if (b1 && b1.boundingBox === 'block' && !/bedrock|water|lava/.test(b1.name)) {
                            if (!hasPick() && STONY_MOBILITY.test(b1.name)) {
                                try { bot._pocketNoPickBlockedAt = Date.now(); } catch (e) {}
                                try {
                                    fs.appendFileSync('bots/_supervisor/progress.txt',
                                        `[${new Date().toISOString()}] [mobility] POCKET no-pick stone gate: ${b1.name} @${b1.position.x},${b1.position.y},${b1.position.z}\n`);
                                } catch (e) {}
                                continue;
                            }
                            await guardedDig(b1, 'POCKET');
                            break;
                        }
                    }
                });
            }
        }
    },
    {
        name: 'mine_motion_audit',
        description: 'Telemetry: wraps dig/placeBlock with structured operation logs for cave movement debugging.',
        interrupts: [],
        on: true,
        active: false,
        always: true,
        update: async function (agent) {
            const bot = agent.bot;
            const AUDIT_VERSION = 3;
            if (!bot || (bot._mineMotionAuditPatched && (bot._mineMotionAuditVersion || 1) >= AUDIT_VERSION)) return;
            bot._mineMotionAuditPatched = true;
            bot._mineMotionAuditVersion = AUDIT_VERSION;
            bot._mineMotionSeq = bot._mineMotionSeq || 0;
            const file = 'bots/_supervisor/mine_motion.jsonl';
            const posObj = (p) => p ? ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }) : null;
            const exactPos = () => {
                const p = bot.entity && bot.entity.position;
                return p ? { x: Number(p.x.toFixed(3)), y: Number(p.y.toFixed(3)), z: Number(p.z.toFixed(3)) } : null;
            };
            const blockObj = (b) => b ? ({
                name: b.name,
                position: posObj(b.position),
                boundingBox: b.boundingBox,
            }) : null;
            const blockAt = (p) => {
                try { return blockObj(bot.blockAt(p)); } catch (e) { return null; }
            };
            const envSnap = () => {
                const m = bot.entity && bot.entity.position && bot.entity.position.floored();
                if (!m) return [];
                const cells = [];
                for (const dy of [-1, 0, 1, 2]) {
                    for (const dz of [-1, 0, 1]) {
                        for (const dx of [-1, 0, 1]) {
                            const b = bot.blockAt(m.offset(dx, dy, dz));
                            cells.push({ d: [dx, dy, dz], n: b ? b.name : 'unknown', bb: b ? b.boundingBox : '?' });
                        }
                    }
                }
                return cells;
            };
            const supportObj = () => {
                try {
                    const m = bot.entity && bot.entity.position && bot.entity.position.floored();
                    if (!m) return { stable: false, block: null };
                    const b = bot.blockAt(m.offset(0, -1, 0));
                    const bad = b && /water|lava|fire|cactus|magma/.test(b.name || '');
                    return { stable: !!(b && b.boundingBox === 'block' && !bad), block: blockObj(b) };
                } catch (e) {
                    return { stable: false, block: null, error: e.message };
                }
            };
            const write = (event, data = {}) => {
                try {
                    fs.appendFileSync(file, JSON.stringify({
                        ts: new Date().toISOString(),
                        event,
                        seq: data.seq,
                        pos: exactPos(),
                        foot: blockAt(bot.entity.position),
                        head: blockAt(bot.entity.position.offset(0, 1, 0)),
                        above: blockAt(bot.entity.position.offset(0, 2, 0)),
                        held: bot.heldItem ? bot.heldItem.name : 'empty',
                        hp: Math.round(bot.health || 0),
                        food: bot.food,
                        skill: bot._currentSkill || null,
                        mob: bot._mobility ? bot._mobility.state : null,
                        data,
                    }) + '\n');
                } catch (e) {}
            };
            const stony = /stone|deepslate|andesite|diorite|granite|tuff|_ore$|obsidian|cobble/;
            const heldIsPick = () => !!(bot.heldItem && /_pickaxe$/.test(bot.heldItem.name));
            const pickItem = () => bot.inventory.items().find(it => /_pickaxe$/.test(it.name));
            const delay = (ms) => new Promise(r => setTimeout(r, ms));
            const isStonyBlock = (block) => !!(block && stony.test(block.name || ''));
            const itemName = (item) => typeof item === 'string' ? item : (item && item.name);
            const isWaterBlock = (block) => !!(block && /^(flowing_)?water$/.test(block.name || ''));
            const inWaterNow = () => isWaterBlock(bot.blockAt(bot.entity.position))
                || isWaterBlock(bot.blockAt(bot.entity.position.offset(0, 1, 0)));
            const activeStonyDig = () => {
                const d = bot._mineMotionActiveDig;
                if (!d || !d.stony) return null;
                if (Date.now() - d.startedAt > 15000) { bot._mineMotionActiveDig = null; return null; }
                return d;
            };
            const waitForStonyDig = async (event, seq, data = {}) => {
                let d = activeStonyDig();
                if (!d) return true;
                write(event + '.deferred', { seq, activeDig: d, ...data });
                const until = Date.now() + 9000;
                while ((d = activeStonyDig()) && Date.now() < until) await delay(50);
                if (!activeStonyDig()) return true;
                write(event + '.blocked', { seq, activeDig: activeStonyDig(), ...data });
                return false;
            };
            const ensurePickForDig = async (block, seq) => {
                if (!block || !stony.test(block.name || '')) return true;
                if (!pickItem()) return Date.now() < (bot._plannedNoPickStoneUntil || 0);
                if (heldIsPick()) return true;
                try { await bot.equip(pickItem(), 'hand'); } catch (e) {}
                await new Promise(r => setTimeout(r, 80));
                if (heldIsPick()) return true;
                try { await bot.tool.equipForBlock(block); } catch (e) {}
                await new Promise(r => setTimeout(r, 80));
                if (heldIsPick()) return true;
                write('dig.blocked', { seq, target: blockObj(block), reason: 'stony-without-held-pick' });
                return false;
            };
            const originalDig = bot.dig.bind(bot);
            bot.dig = async (block, ...args) => {
                const seq = ++bot._mineMotionSeq;
                const startedAt = Date.now();
                const support = supportObj();
                write('dig.begin', { seq, target: blockObj(block), args, support, env: envSnap() });
                if (!support.stable) {
                    write('dig.unsupported_before', { seq, target: blockObj(block), args, support, env: envSnap() });
                }
                if (!(await ensurePickForDig(block, seq))) {
                    const err = new Error(`stone dig blocked without held pick: ${block ? block.name : 'unknown'}`);
                    write('dig.end', { seq, ok: false, ms: Date.now() - startedAt, target: blockObj(block), error: err.message, env: envSnap() });
                    throw err;
                }
                bot._mineMotionActiveDig = { seq, stony: isStonyBlock(block), target: blockObj(block), startedAt };
                try {
                    const result = await originalDig(block, ...args);
                    write('dig.end', { seq, ok: true, ms: Date.now() - startedAt, target: blockObj(block), env: envSnap() });
                    return result;
                } catch (e) {
                    write('dig.end', { seq, ok: false, ms: Date.now() - startedAt, target: blockObj(block), error: e.message, env: envSnap() });
                    throw e;
                } finally {
                    if (bot._mineMotionActiveDig && bot._mineMotionActiveDig.seq === seq) bot._mineMotionActiveDig = null;
                }
            };
            const originalEquip = bot.equip.bind(bot);
            bot.equip = async (item, destination, ...args) => {
                const name = itemName(item);
                const hand = !destination || destination === 'hand';
                if (hand && name && !/_pickaxe$/.test(name) && activeStonyDig()) {
                    const seq = ++bot._mineMotionSeq;
                    if (!(await waitForStonyDig('equip', seq, { item: name, destination }))) {
                        throw new Error(`equip ${name} blocked during stony dig`);
                    }
                }
                return await originalEquip(item, destination, ...args);
            };
            const originalPlaceBlock = bot.placeBlock.bind(bot);
            bot.placeBlock = async (referenceBlock, faceVector, ...args) => {
                const seq = ++bot._mineMotionSeq;
                const startedAt = Date.now();
                const placeAt = referenceBlock && referenceBlock.position && faceVector
                    ? referenceBlock.position.offset(faceVector.x, faceVector.y, faceVector.z)
                    : null;
                write('place.begin', {
                    seq,
                    reference: blockObj(referenceBlock),
                    face: faceVector ? { x: faceVector.x, y: faceVector.y, z: faceVector.z } : null,
                    placeAt: posObj(placeAt),
                    args,
                    env: envSnap(),
                });
                if (inWaterNow()) {
                    const err = new Error('place blocked while swimming');
                    write('place.blocked', {
                        seq,
                        reason: 'in-water',
                        placeAt: posObj(placeAt),
                        placeBlock: blockObj(placeAt ? bot.blockAt(placeAt) : null),
                        env: envSnap(),
                    });
                    write('place.end', { seq, ok: false, ms: Date.now() - startedAt, placeAt: posObj(placeAt), error: err.message, env: envSnap() });
                    throw err;
                }
                if (!(await waitForStonyDig('place', seq, { placeAt: posObj(placeAt) }))) {
                    const err = new Error('place blocked during stony dig');
                    write('place.end', { seq, ok: false, ms: Date.now() - startedAt, placeAt: posObj(placeAt), error: err.message, env: envSnap() });
                    throw err;
                }
                try {
                    const result = await originalPlaceBlock(referenceBlock, faceVector, ...args);
                    write('place.end', { seq, ok: true, ms: Date.now() - startedAt, placeAt: posObj(placeAt), env: envSnap() });
                    return result;
                } catch (e) {
                    write('place.end', { seq, ok: false, ms: Date.now() - startedAt, placeAt: posObj(placeAt), error: e.message, env: envSnap() });
                    throw e;
                }
            };
            write('audit.installed', {});
        }
    },
    {
        name: 'act_trace',
        description: 'Telemetry: 1Hz dump of control states + current action — the missing "what keys is it pressing" feed.',
        interrupts: [],
        on: true,
        active: false,
        always: true,   // pure observer
        lastW: 0, sz: 0,
        update: async function (agent) {
            // ★监控系统自身的盲区修复 (用户: "你的监控与纠错系统也存在系统问题"——
            // bot 原地蹦跶 8 小时,我用死后黑匣子猜了 4 个机理全错,因为根本看不见
            // "它正在按什么键、哪个 action 在按"。这是行为心电图: 1Hz 落盘控制状态/
            // 当前动作/寻路状态/挖掘目标,任何"反复做 X"的怪行为直接读出主使者。)
            const bot = agent.bot;
            const now = Date.now();
            if (now - this.lastW < 1000) return;
            this.lastW = now;
            try {
                const cs = bot.controlState || {};
                const p = bot.entity.position;
                const line = JSON.stringify({
                    t: new Date().toISOString().slice(11, 19),
                    pos: [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)],
                    g: bot.entity.onGround ? 1 : 0,
                    ctrl: ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint'].filter(k => cs[k]).join(',') || '-',
                    act: (agent.actions && agent.actions.currentActionLabel) || '-',
                    path: (bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving()) ? 1 : 0,
                    dig: (bot.targetDigBlock && bot.targetDigBlock.name) || '-',
                }) + '\n';
                if (this.sz === 0) { try { this.sz = fs.statSync('bots/_supervisor/act_trace.jsonl').size; } catch (e) { this.sz = 1; } }
                if (this.sz > 10 * 1024 * 1024) { try { fs.renameSync('bots/_supervisor/act_trace.jsonl', 'bots/_supervisor/act_trace.jsonl.1'); } catch (e) {} this.sz = 1; }
                fs.appendFileSync('bots/_supervisor/act_trace.jsonl', line);
                this.sz += line.length;
            } catch (e) {}
        }
    },
    {
        name: 'bare_stone_alarm',
        description: 'Alert the supervisor the moment the bot digs stone bare-handed.',
        interrupts: [],
        on: true,
        active: false,
        always: true,   // pure observer
        lastAlert: 0,
        update: async function (agent) {
            // 用户实拍怒斥"你见过哪个人类玩家这样挖石头的?" — bare-hand stone digging is
            // 5-10x slower AND drops nothing, so it's ALWAYS a planning bug upstream
            // (lost pick + material-blind dig call). Alert instantly via ALERTS.txt (the
            // [ALERT] monitor tails it) so the supervisor sees the state within seconds,
            // with position + target so the offending code path can be hunted down.
            const bot = agent.bot;
            const tgt = bot.targetDigBlock;
            if (!tgt || !tgt.name) return;
            const held = bot.heldItem;
            if (held && /_pickaxe$/.test(held.name)) return;
            if (!/stone|deepslate|andesite|diorite|granite|tuff|_ore$|obsidian|cobble/.test(tgt.name)) return;
            if (bot._plannedNoPickStoneUntil && Date.now() < bot._plannedNoPickStoneUntil) return;
            // REGIONAL dedupe: a legit NOPICK climb chews stone for many minutes in one
            // area — per-block 30s dedupe pushed 5+ alerts per climb (pure noise once
            // the supervisor knows). One alert per ~16-block region per 10 minutes; a
            // NEW region still alerts immediately (that's the signal that matters).
            const rk = `${Math.round(tgt.position.x / 16)},${Math.round(tgt.position.z / 16)}`;
            if (!this.regions) this.regions = {};
            if (this.regions[rk] && Date.now() - this.regions[rk] < 600000) return;
            this.regions[rk] = Date.now();
            this.lastAlert = Date.now();
            try { bot.interrupt_code = true; } catch (e) {}
            try { bot._chopGen = (bot._chopGen || 0) + 1; } catch (e) {}
            try { bot._supervisorCancelAt = Date.now(); } catch (e) {}
            try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
            try { bot.clearControlStates(); } catch (e) {}
            try {
                const p = bot.entity.position;
                fs.appendFileSync('ALERTS.txt',
                    `[${new Date().toISOString()}] BARE-HAND STONE DIG: ${tgt.name} @${tgt.position.x},${tgt.position.y},${tgt.position.z} held=${held ? held.name : 'empty'} botY=${Math.floor(p.y)}\n`);
            } catch (e) {}
        }
    },
    {
        name: 'tool_keeper',
        description: 'Watch held tool durability every few seconds; craft a spare BEFORE it snaps.',
        // 'all': same scheduler trap as the combat blackbox — with interrupts:[] this mode
        // NEVER ran while a sticky skill was executing (the agent is never idle), so both
        // pickaxes ground to dust mid-dig with 200 cobblestone in the bag (01:34, deaths
        // stayed 261 but kit hit zero). It must be allowed to interrupt: a 2s craft pause
        // every ~250 dig-uses is exactly what a human does mid-mining.
        interrupts: ['all'],
        on: true,
        active: false,
        last_check: 0,
        update: async function (agent) {
            // ★人类的耐久感是 TICK 级反射,不是任务边界策略 (用户怒斥"连看耐久度都没有"——
            // 备镐规则确实写过,但挂在 prepNether 边界,镐总在边界之间的长挖掘里磨断,检查
            // 永远慢半拍,且查时常没料。人类每挥几下瞄一眼耐久条 → 放①层,5s一查,磨损>80%
            // 且无健康同类备件 → 用随身料(圆石+棍+手持工作台)当场补造,2秒换不死一把镐)。
            const bot = agent.bot;
            if (bot.health <= 10 && bot.food < 18) return;
            if (Date.now() - this.last_check < 5000) return;
            this.last_check = Date.now();
            const held = bot.heldItem;
            if (!held || !/_pickaxe$|_axe$|_shovel$/.test(held.name)) return;
            const max = held.maxDurability || 0;
            const used = (typeof held.durabilityUsed === 'number') ? held.durabilityUsed : 0;
            if (!max || used / max < 0.8) return;
            const cls = held.name.split('_').pop();   // pickaxe / axe / shovel
            const healthySpare = bot.inventory.items().some(i =>
                i.slot !== held.slot && i.name.endsWith('_' + cls)
                && (!i.maxDurability || ((typeof i.durabilityUsed === 'number' ? i.durabilityUsed : 0) / i.maxDurability) < 0.5));
            if (healthySpare) return;
            const c = {};
            for (const it of bot.inventory.items()) c[it.name] = (c[it.name] || 0) + it.count;
            const stone = (c.cobblestone || 0) + (c.cobbled_deepslate || 0) + (c.blackstone || 0);
            if (stone >= 3 && (c.stick || 0) >= 2) {
                execute(this, agent, async () => {
                    say(agent, `${held.name} at ${Math.round(used / max * 100)}% wear — crafting a spare before it snaps.`);
                    // crafting needs a table: if none in the bag, build one from planks
                    // (and planks from logs) first — the mid-dig rebuild case after a
                    // death wipe is exactly when the bag has no table.
                    try {
                        if (!c.crafting_table) {
                            const planks = Object.entries(c).reduce((s, [n, v]) => s + (n.endsWith('_planks') ? v : 0), 0);
                            const logs = Object.entries(c).reduce((s, [n, v]) => s + (/_log$/.test(n) ? v : 0), 0);
                            if (planks < 4 && logs >= 1) { try { await skills.craftRecipe(bot, 'oak_planks', 1); } catch (e) {} }
                            try { await skills.craftRecipe(bot, 'crafting_table', 1); } catch (e) {}
                        }
                        await skills.craftRecipe(bot, 'stone_' + cls, 1);
                    } catch (e) {}
                });
            }
        }
    },
    {
        name: 'hunting',
        description: 'Hunt nearby animals when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        update: async function (agent) {
            const huntable = world.getNearestEntityWhere(agent.bot, entity => mc.isHuntable(entity), 8);
            if (huntable && await world.isClearPath(agent.bot, huntable)) {
                execute(this, agent, async () => {
                    say(agent, `Hunting ${huntable.name}!`);
                    await skills.attackEntity(agent.bot, huntable);
                });
            }
        }
    },
    {
        name: 'auto_eat',
        description: 'Eat food when hungry to keep health regenerating.',
        // 'all': third member of the scheduler-trap family (threat_radar, tool_keeper) —
        // with interrupts:[] this never ran while a sticky skill executed, so the bot
        // starved to food=0 WITH food in the bag. Hunger-bled hp was the shared root
        // cause of deaths #260 (6.8hp vs zombie) and #262 (7hp vs suffocation): regen
        // stops below food 18, so every scratch becomes permanent. Eating is a 1.6s
        // pause — a human eats mid-mining without thinking about it.
        interrupts: ['all'],
        on: true,
        active: false,
        last_eat: 0,
        update: async function (agent) {
            const bot = agent.bot;
            if (bot.food <= 17 && Date.now() - this.last_eat > 8000) {
                let food = bot.inventory.items().find(i => /cooked_|_bread|^bread$|apple|carrot|potato|beef|porkchop|chicken|mutton|cod|salmon|melon_slice|sweet_berries|_stew|rabbit|baked_/.test(i.name));
                // EMERGENCY TIER — rotten flesh / raw meats / spider eye. The hp3/food0
                // deadlock (post-#267): feedUp found no animals all day, but the bot HAD
                // killed zombies whose flesh it refused to eat because the regex above
                // doesn't match it. A human at food<=6 eats rotten flesh without blinking
                // (80% hunger-effect chance, ~zero real danger; it's the classic MC
                // famine food). Raw meat/fish are even safer. Only at food<=6 so we never
                // pick junk over real food.
                if (!food && bot.food <= 6) {
                    food = bot.inventory.items().find(i => /rotten_flesh|^beef$|^porkchop$|^chicken$|^mutton$|^rabbit$|^cod$|^salmon$|spider_eye/.test(i.name));
                }
                if (food) {
                    this.last_eat = Date.now();
                    execute(this, agent, async () => { try { await skills.consume(bot, food.name); } catch (e) {} });
                }
            }
        }
    },
    {
        name: 'item_collecting',
        description: 'Collect nearby items when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,

        wait: 2, // number of seconds to wait after noticing an item to pick it up
        prev_item: null,
        noticed_at: -1,
        update: async function (agent) {
            let item = world.getNearestEntityWhere(agent.bot, entity => entity.name === 'item', 8);
            let empty_inv_slots = agent.bot.inventory.emptySlotCount();
            if (item && item !== this.prev_item && await world.isClearPath(agent.bot, item) && empty_inv_slots > 1) {
                if (this.noticed_at === -1) {
                    this.noticed_at = Date.now();
                }
                if (Date.now() - this.noticed_at > this.wait * 1000) {
                    say(agent, `Picking up item!`);
                    this.prev_item = item;
                    execute(this, agent, async () => {
                        await skills.pickupNearbyItems(agent.bot);
                    });
                    this.noticed_at = -1;
                }
            }
            else {
                this.noticed_at = -1;
            }
        }
    },
    {
        name: 'torch_placing',
        description: 'Place torches when idle and there are no torches nearby.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        cooldown: 5,
        last_place: Date.now(),
        update: function (agent) {
            if (world.shouldPlaceTorch(agent.bot)) {
                if (Date.now() - this.last_place < this.cooldown * 1000) return;
                execute(this, agent, async () => {
                    const pos = agent.bot.entity.position;
                    await skills.placeBlock(agent.bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
                });
                this.last_place = Date.now();
            }
        }
    },
    {
        name: 'elbow_room',
        description: 'Move away from nearby players when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        distance: 0.5,
        update: async function (agent) {
            const player = world.getNearestEntityWhere(agent.bot, entity => entity.type === 'player', this.distance);
            if (player) {
                execute(this, agent, async () => {
                    // wait a random amount of time to avoid identical movements with other bots
                    const wait_time = Math.random() * 1000;
                    await new Promise(resolve => setTimeout(resolve, wait_time));
                    if (player.position.distanceTo(agent.bot.entity.position) < this.distance) {
                        await skills.moveAwayFromEntity(agent.bot, player, this.distance);
                    }
                });
            }
        }
    },
    {
        name: 'idle_staring',
        description: 'Animation to look around at entities when idle.',
        interrupts: [],
        on: true,
        active: false,

        staring: false,
        last_entity: null,
        next_change: 0,
        update: function (agent) {
            const entity = agent.bot.nearestEntity();
            let entity_in_view = entity && entity.position.distanceTo(agent.bot.entity.position) < 10 && entity.name !== 'enderman';
            if (entity_in_view && entity !== this.last_entity) {
                this.staring = true;
                this.last_entity = entity;
                this.next_change = Date.now() + Math.random() * 1000 + 4000;
            }
            if (entity_in_view && this.staring) {
                let isbaby = entity.type !== 'player' && entity.metadata[16];
                let height = isbaby ? entity.height/2 : entity.height;
                agent.bot.lookAt(entity.position.offset(0, height, 0));
            }
            if (!entity_in_view)
                this.last_entity = null;
            if (Date.now() > this.next_change) {
                // look in random direction
                this.staring = Math.random() < 0.3;
                if (!this.staring) {
                    const yaw = Math.random() * Math.PI * 2;
                    const pitch = (Math.random() * Math.PI/2) - Math.PI/4;
                    agent.bot.look(yaw, pitch, false);
                }
                this.next_change = Date.now() + Math.random() * 10000 + 2000;
            }
        }
    },
    {
        name: 'cheat',
        description: 'Use cheats to instantly place blocks and teleport.',
        interrupts: [],
        on: false,
        active: false,
        update: function (agent) { /* do nothing */ }
    }
];

async function execute(mode, agent, func, timeout=-1) {
    if (agent.self_prompter.isActive())
        agent.self_prompter.stopLoop();
    let interrupted_action = agent.actions.currentActionLabel;
    mode.active = true;
    let code_return = await agent.actions.runAction(`mode:${mode.name}`, async () => {
        await func();
    }, { timeout });
    mode.active = false;
    
    // Only log mode completion for non-interrupted actions or when there's meaningful output
    if (!code_return.interrupted) {
        const outputPreview = code_return.message ? code_return.message.substring(0, 100) : '';
        console.log(`Mode ${mode.name} finished: ${outputPreview}`);
    }

    let should_reprompt = 
        interrupted_action && // it interrupted a previous action
        !agent.actions.resume_func && // there is no resume function
        !agent.self_prompter.isActive() && // self prompting is not on
        !code_return.interrupted; // this mode action was not interrupted by something else

    if (should_reprompt) {
        // auto prompt to respond to the interruption
        let role = convoManager.inConversation() ? agent.last_sender : 'system';
        let logs = agent.bot.modes.flushBehaviorLog();
        agent.handleMessage(role, `(AUTO MESSAGE)Your previous action '${interrupted_action}' was interrupted by ${mode.name}.
        Your behavior log: ${logs}\nRespond accordingly.`);
    }
}

let _agent = null;
const modes_map = {};
for (let mode of modes_list) {
    modes_map[mode.name] = mode;
}

class ModeController {
    /*
    SECURITY WARNING:
    ModesController must be reference isolated. Do not store references to external objects like `agent`.
    This object is accessible by LLM generated code, so any stored references are also accessible.
    This can be used to expose sensitive information by malicious prompters.
    */
    constructor() {
        this.behavior_log = '';
    }

    exists(mode_name) {
        return modes_map[mode_name] != null;
    }

    setOn(mode_name, on) {
        modes_map[mode_name].on = on;
    }

    isOn(mode_name) {
        return modes_map[mode_name].on;
    }

    pause(mode_name) {
        modes_map[mode_name].paused = true;
    }

    unpause(mode_name) {
        const mode = modes_map[mode_name];
        //if  unpause func is defined and mode is currently paused
        if (mode.unpause && mode.paused) {
            mode.unpause();
        }
        mode.paused = false;
    }

    unPauseAll() {
        for (let mode of modes_list) {
            if (mode.paused) console.log(`Unpausing mode ${mode.name}`);
            this.unpause(mode.name);
        }
    }

    getMiniDocs() { // no descriptions
        let res = 'Agent Modes:';
        for (let mode of modes_list) {
            let on = mode.on ? 'ON' : 'OFF';
            res += `\n- ${mode.name}(${on})`;
        }
        return res;
    }

    getDocs() {
        let res = 'Agent Modes:';
        for (let mode of modes_list) {
            let on = mode.on ? 'ON' : 'OFF';
            res += `\n- ${mode.name}(${on}): ${mode.description}`;
        }
        return res;
    }

    async update() {
        if (_agent.isIdle()) {
            this.unPauseAll();
        }
        // always-on observers (e.g. threat_radar) run every tick regardless of what the
        // agent is executing — they only record, never act, so they bypass the
        // idle/interruptible gate and the active-mode break below. Without this, a
        // sticky skill keeps the agent non-idle ~100% of the time and the combat
        // blackbox only catches stray frames between skills.
        for (let mode of modes_list) {
            if (mode.always && mode.on && !mode.active) {
                try { await mode.update(_agent); } catch (e) {}
            }
        }
        for (let mode of modes_list) {
            if (mode.always) continue;
            let interruptible = mode.interrupts.some(i => i === 'all') || mode.interrupts.some(i => i === _agent.actions.currentActionLabel);
            if (mode.on && !mode.paused && !mode.active && (_agent.isIdle() || interruptible)) {
                await mode.update(_agent);
            }
            if (mode.active) break;
        }
    }

    flushBehaviorLog() {
        const log = this.behavior_log;
        this.behavior_log = '';
        return log;
    }

    getJson() {
        let res = {};
        for (let mode of modes_list) {
            res[mode.name] = mode.on;
        }
        return res;
    }

    loadJson(json) {
        for (let mode of modes_list) {
            if (json[mode.name] != undefined) {
                mode.on = json[mode.name];
            }
        }
    }
}

export function initModes(agent) {
    _agent = agent;
    // the mode controller is added to the bot object so it is accessible from anywhere the bot is used
    agent.bot.modes = new ModeController();
    if (agent.task) {
        agent.bot.restrict_to_inventory = agent.task.restrict_to_inventory;
    }
    let modes_json = agent.prompter.getInitModes();
    if (modes_json) {
        agent.bot.modes.loadJson(modes_json);
    }
}
