import * as skills from './library/skills.js';
import * as world from './library/world.js';
import * as mc from '../utils/mcdata.js';
import settings from './settings.js'
import convoManager from './conversation.js';
import fs from 'fs';
import Vec3 from 'vec3';

async function say(agent, message) {
    agent.bot.modes.behavior_log += message + '\n';
    if (agent.shut_up || !settings.narrate_behavior) return;
    agent.openChat(message);
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
                if (covered && !this.nearbyHostiles(bot).some(e => e.position && e.position.distanceTo(pC) < 6)) {
                    // DWELL, don't fast-return: an instant return re-fires the mode every
                    // ~300ms ("Nightfall securing" spam round 3) and the interrupt storm
                    // starves every other system. We're sheltered — sit 5s per pass.
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
                    try { bot.setControlState('jump', true); } catch (e) {}
                    await new Promise(r => setTimeout(r, 260));
                    const pp = bot.entity.position.floored();
                    try { await skills.placeBlock(bot, fb, pp.x, pp.y - 1, pp.z, 'top', true); } catch (e) {}
                    try { bot.setControlState('jump', false); } catch (e) {}
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
                await skills.wait(bot, 3000);
            }
        },
        update: async function (agent) {
            const bot = agent.bot;
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
                                const p0 = bot.entity.position.floored();
                                bot.setControlState('forward', false);
                                bot.setControlState('jump', true);
                                await new Promise(r => setTimeout(r, 280));
                                try { await skills.placeBlock(bot, f, p0.x, p0.y, p0.z, 'bottom', true); } catch (e) {}
                                bot.setControlState('jump', false);
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
            else if (this.nearestCreeper(bot)) {
                // ===== CREEPER REFLEX (highest-priority hostile response) =============
                // A creeper is the ONE mob you must never bunker or melee beside: stopping
                // to dig a shelter (or trading blows) lets it close to ~3 blocks, fuse, and
                // detonate — which is exactly how we kept dying ("blown up by Creeper"). The
                // night-shelter / flee branches below would do precisely the wrong thing, so
                // this preempts them. The ONLY correct reflex is to put DISTANCE between us:
                // sprint directly away from the creeper until it's >9 blocks (fuse resets and
                // it stops tracking). No digging, no fighting — just back off. Watchdog
                // discipline: honor a real interrupt/death so we never refuse stop (churn).
                const cr0 = this.nearestCreeper(bot);
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
                        try { await bot.lookAt(me.offset(dx * 4, 0, dz * 4), true); } catch (e) {}
                        const fwd = bot.entity.position.offset(dx, 0, dz).floored();
                        let dropAhead = 0; for (let d = 0; d <= 4; d++) { const b = bot.blockAt(fwd.offset(0, -d, 0)); if (b && b.boundingBox === 'block') break; dropAhead = d; }
                        const ledge = dropAhead > 3;                     // don't sprint off a cliff
                        bot.setControlState('forward', true);
                        bot.setControlState('sprint', !ledge);
                        bot.setControlState('jump', !ledge);
                        await new Promise(r => setTimeout(r, 160));
                        if (i % 10 === 9) { try { say(agent, 'Kiting creeper+swarm till dawn…'); } catch (e) {} } // agent.err heartbeat (watchdog alive-signal)
                    }
                    try { bot.clearControlStates(); } catch (e) {}
                });
            }
            else if (this.shouldNightShelter(bot)) {
                say(agent, 'Nightfall — securing till dawn (proactive, before mobs swarm).');
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
        update: async function (agent) {
            if (agent.isIdle()) { 
                this.prev_location = null;
                this.stuck_time = 0;
                return; // don't get stuck when idle
            }
            const bot = agent.bot;
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
                    const tP = (bot.time && bot.time.timeOfDay) || 0;
                    if (tP >= 12000 && tP <= 23500) {
                        for (let dyP = 1; dyP <= 3; dyP++) {
                            const bP = bot.blockAt(bot.entity.position.offset(0, dyP, 0));
                            if (bP && bP.boundingBox === 'block') { nightBunker = true; break; }
                        }
                    }
                    if (!nightBunker) {
                        this.pinKick = now;
                        say(agent, 'Pinned 15min+ — kicking the stack (forced interrupt).');
                        try { bot.interrupt_code = true; } catch (e) {}
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
                                for (let dyB = 1; dyB <= 3; dyB++) {
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
                    if (st === 'MAROONED' && this.lastState !== 'MAROONED') this.maroonedAt = now;
                }
                if (st !== this.lastState) {
                    this.lastState = st; this.stateSince = now;
                    if (st !== 'MAROONED') { bot._marchDir = null; bot._marchFails = 0; }   // fresh heading next entrapment
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
            // ── reactions ──
            if (st === 'ENTOMBED') {
                // instant dig-out, reflex priority — no stagnation timer, no material
                // gate (entombed = the gate's exception BY DEFINITION). Head toward the
                // anchor; one 2-cell column per execute burst, state re-evaluated next tick.
                execute(this, agent, async () => {
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
                            try { await bot.tool.equipForBlock(b); } catch (e) {}
                            try { await bot.dig(b); } catch (e) {}
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
                // (dig, no material gate — MAROONED is an exception state), bridge a gap
                // (place into the NEIGHBOR cell at foot height, body-clearance checked,
                // no self-place race), step in. ~6 cells per burst, state re-evaluated
                // between bursts; >20 blocks of net displacement re-anchors to FREE.
                execute(this, agent, async () => {
                    say(agent, 'Marooned — engineering a road out.');
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
                    const FILLR = /^dirt$|cobblestone|cobbled|granite|andesite|diorite|^stone$|tuff|gravel|_planks$|_log$/;
                    for (let seg = 0; seg < 6; seg++) {
                        if (bot.interrupt_code || bot.health <= 0) break;
                        const m2 = bot.entity.position.floored();
                        // clear the 2-high cell ahead
                        for (const c of [m2.offset(sx, 1, sz), m2.offset(sx, 0, sz)]) {
                            const b = bot.blockAt(c);
                            if (b && b.boundingBox === 'block' && !/bedrock|water|lava/.test(b.name)) {
                                try { await bot.tool.equipForBlock(b); } catch (e) {}
                                try { await bot.dig(b); } catch (e) {}
                            }
                        }
                        // bridge: no floor within 3 below the cell ahead → place a block at
                        // its foot level (neighbor-cell place, no race; body-clearance check)
                        let floorOK = false;
                        for (let dd = 1; dd <= 3; dd++) { const fb = bot.blockAt(m2.offset(sx, -dd, sz)); if (fb && fb.boundingBox === 'block') { floorOK = true; break; } }
                        if (!floorOK) {
                            const fill = bot.inventory.items().find(it => FILLR.test(it.name));
                            const bp = bot.entity.position;
                            if (fill && Math.hypot(bp.x - (m2.x + sx + 0.5), bp.z - (m2.z + sz + 0.5)) >= 0.85) {
                                let ref = bot.blockAt(m2.offset(sx, -1, sz)), face = Vec3 ? new Vec3(0, 1, 0) : null;
                                if (!(ref && ref.boundingBox === 'block')) { ref = bot.blockAt(m2.offset(0, -1, 0)); face = Vec3 ? new Vec3(sx, 0, sz) : null; }
                                if (ref && ref.boundingBox === 'block' && face) {
                                    try { await bot.equip(fill, 'hand'); } catch (e) {}
                                    try { await bot.placeBlock(ref, face); } catch (e) {}
                                }
                            }
                        }
                        try { await bot.lookAt(m2.offset(sx + 0.5, 1.6, sz + 0.5), true); } catch (e) {}
                        bot.setControlState('forward', true);
                        await new Promise(r => setTimeout(r, 700));
                        try { bot.clearControlStates(); } catch (e) {}
                    }
                    // heading review: rotate 90° only after 2 consecutive dead bursts
                    if (bot.entity.position.distanceTo(_mStart) < 2) {
                        bot._marchFails = (bot._marchFails || 0) + 1;
                        if (bot._marchFails >= 2) { bot._marchDir = [-sz, sx]; bot._marchFails = 0; }   // rotate 90°
                    } else bot._marchFails = 0;
                });
            } else if (st === 'POCKET' && now - this.stateSince > 30000) {
                // stuck in a roofless pit >60s: dig a step-out toward the anchor side
                execute(this, agent, async () => {
                    say(agent, 'Pocketed — carving a step out.');
                    const m2 = bot.entity.position.floored();
                    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                        const b1 = bot.blockAt(m2.offset(dx, 1, dz));
                        if (b1 && b1.boundingBox === 'block' && !/bedrock|water|lava/.test(b1.name)) {
                            try { await bot.tool.equipForBlock(b1); } catch (e) {}
                            try { await bot.dig(b1); } catch (e) {}
                            break;
                        }
                    }
                });
            }
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
            // REGIONAL dedupe: a legit NOPICK climb chews stone for many minutes in one
            // area — per-block 30s dedupe pushed 5+ alerts per climb (pure noise once
            // the supervisor knows). One alert per ~16-block region per 10 minutes; a
            // NEW region still alerts immediately (that's the signal that matters).
            const rk = `${Math.round(tgt.position.x / 16)},${Math.round(tgt.position.z / 16)}`;
            if (!this.regions) this.regions = {};
            if (this.regions[rk] && Date.now() - this.regions[rk] < 600000) return;
            this.regions[rk] = Date.now();
            this.lastAlert = Date.now();
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
