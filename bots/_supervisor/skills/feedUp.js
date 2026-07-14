// Hot-reloadable REAL skill: secure FOOD and restore health before a dangerous
// dive. The bot kept dying in deep caves because it sat at ~10 HP with no food to
// regen (food < 18 = no regen), so any skeleton arrow / zombie hit was lethal.
// feedUp hunts nearby animals with a weapon, eats the meat (raw is fine in a
// pinch), and repeats until food + health are topped up. Run this at the SURFACE
// (where animals are) before descending. Invoked via: {"skill":"feedUp",[18]}
// ctx = { skills, world, mc, Vec3, log }
import fs from 'fs';
import path from 'path';
import mfp from 'mineflayer-pathfinder';

const { Movements, goals } = mfp;

const FOOD_RE = /cooked_|_bread|^bread$|^apple$|golden_apple|carrot|potato|^beef$|porkchop|^chicken$|^mutton$|^cod$|^salmon$|melon_slice|sweet_berries|_stew|^rabbit$|baked_/;
const FOOD_DROP_RE = /rotten_flesh|beef|porkchop|chicken|mutton|rabbit|cod|salmon|bread|apple|carrot|potato|melon/i;
const SPAWNF = path.resolve(process.cwd(), 'bots', '_supervisor', 'spawn_pos.json');
const PROG = path.resolve(process.cwd(), 'bots', '_supervisor', 'progress.txt');
const MINE_MOTION = path.resolve(process.cwd(), 'bots', '_supervisor', 'mine_motion.jsonl');   // ★fix 2026-07-09: was a bare cwd-relative string, unlike sibling skills — resolve it like PROG
const prog = (s) => { try { fs.appendFileSync(PROG, `[${new Date().toISOString()}] ${s}\n`); } catch (e) {} };

export default async function feedUp(bot, ctx, targetFood = 18) {
    const { skills, world, mc, log } = ctx;
    // ── S4.3 COMMITMENT SUPPRESS (user #1 decision-speed / #5 don't-run-off-hunting):
    //    while the world model has committed to BOOTSTRAP_KIT and food isn't critical,
    //    DON'T go on a hunting/foraging excursion — finish the kit in place. The
    //    commitment (computed in modes.js world_model mode) emergency-preempts to
    //    GET_FOOD when food<=4, so this only fires when it's safe to keep bootstrapping. ──
    try {
        const c = bot._commitment;
        // ★circular-deference fix (checkpoint #16, 14:38Z live): prepNether's HUNGER gate
        // invokes feedUp — which then deferred BECAUSE BOOTSTRAP_KIT (prepNether's own
        // dispatcher) was committed; prepNether read the defer as 'no food found' and the
        // kind 3-struck into cooldown. A nested hunger-gate hunt IS the sanctioned hunt —
        // the committed skill itself asked for it. Call sites stamp bot._hungerGateHunt.
        const nestedHunt = bot._hungerGateHunt && Date.now() - bot._hungerGateHunt < 30000;
        if (c && c.kind === 'BOOTSTRAP_KIT' && (bot.food || 0) > 6 && !nestedHunt) {
            log(bot, `feedUp: ★defer — committed BOOTSTRAP_KIT, food=${bot.food}>6 (suppress hunt, finish kit first)`);
            return { deferred: true, reason: 'bootstrap-commitment' };
        }
    } catch (e) {}
    const has = (n) => world.getInventoryCounts(bot)[n] || 0;
    const eat = async () => {
        const f = bot.inventory.items().find(i => FOOD_RE.test(i.name) && i.name !== 'rotten_flesh');
        // ★EAT-VOID (13:57-14:01 实录): skills.consume 现按 bot.food 差值如实返回真假 —
        // 透传它, 别把"试过吃"当"吃到了"(旧版无脑 return true, void 进食把各 Plan 的
        // 成功分支全骗成 truthy)。
        if (f && bot.food < 20) { try { return !!(await skills.consume(bot, f.name)); } catch (e) {} }
        return false;
    };
    const edibleHeld = () => bot.inventory.items().some(i => FOOD_RE.test(i.name) && i.name !== 'rotten_flesh');
    const droppedItemName = (e) => {
        try {
            const item = e && typeof e.getDroppedItem === 'function' ? e.getDroppedItem() : null;
            if (item && item.name) return item.name;
            if (item && item.displayName) return String(item.displayName).toLowerCase().replace(/\s+/g, '_');
        } catch (err) {}
        return e && (e.displayName || e.name) || 'item';
    };
    const isFoodDrop = (e) => e && e.name === 'item' && FOOD_DROP_RE.test(droppedItemName(e));
    const nearbyDropsSummary = (range = 8, limit = 6) => {
        try {
            return Object.values(bot.entities)
                .filter(e => e && e.name === 'item' && e.position && e.position.distanceTo(bot.entity.position) <= range)
                .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
                .slice(0, limit)
                .map(e => `${droppedItemName(e)}@${Math.round(e.position.distanceTo(bot.entity.position))}`)
                .join(',') || 'none';
        } catch (err) { return 'err'; }
    };
    const emergencyJunk = async (reason = 'emergency') => {
        const noRegenGap = bot.food <= 11 && bot.health <= 8;
        if ((!noRegenGap && (bot.food > 10 || bot.health > 10)) || edibleHeld()) return false;
        const junk = bot.inventory.items().find(i => /rotten_flesh|spider_eye/.test(i.name || ''));
        if (!junk) return false;
        log(bot, `feedUp: ${reason} — eating ${junk.name} at hp=${Math.round(bot.health)} food=${bot.food}`);
        prog(`feedUp: ${reason} — eating ${junk.name} at hp=${Math.round(bot.health)} food=${bot.food}`);
        // ★kernel return contract (audit 2026-07-02, same family as the :1560 fix): skills.consume
        // reports failure by RETURNING false WITHOUT throwing (item missing / equipConfirmed
        // {ok:false} on equip desync), so "didn't throw" ≠ "ate". Discarding the boolean let the
        // ':71 no-regen start' short-circuit return truthy to the kernel with ZERO food gained —
        // GET_FOOD stays committed (isGoalDone needs food>=16), re-dispatches every ~2s, the
        // failure counter resets on each truthy return, and the 3-strike/5-min cooldown never
        // trips: unbreakable hot livelock while starving at no-regen hp. Truthy here = consume's
        // own success boolean AND food actually rose this call; a dry run returns false so feedUp
        // falls through to the main hunt loop and its delta-gated final return.
        const f0 = bot.food;
        let ok = false;
        try { ok = await skills.consume(bot, junk.name); } catch (e) { return false; }
        if (!ok) return false;
        try { await skills.wait(bot, 600); } catch (e) {}
        return bot.food > f0;
    };
    if (await emergencyJunk('no-regen start')) return true;

    // Equip the best weapon we have for hunting.
    for (const w of ['diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'diamond_axe', 'iron_axe', 'stone_axe']) {
        if (has(w)) { await skills.equip(bot, w).catch(() => {}); break; }
    }

    // SAFETY GUARDS. feedUp used to hunt relentlessly until full — chasing animals at
    // dusk/night straight into mobs and grinding itself down to ~5 HP, then dying the
    // moment night-shelter triggered (you can't out-dig a pursuing mob at 5 HP). It is
    // counter-productive for the "heal up before the dive" step to be what gets the bot
    // killed. So: bail the instant HP is critical (let the survival modes shelter), and
    // NEVER initiate a roaming hunt at night or with a hostile nearby — just eat what we
    // already carry; if there's nothing to eat, stop rather than walk into danger.
    const isNight = () => { const t = (bot.time && bot.time.timeOfDay) || 0; return t > 13000 && t < 23000; };
    const isDusk = () => { const t = (bot.time && bot.time.timeOfDay) || 0; return t >= 12000 && t <= 13000; };
    const HOSTILE = /zombie|skeleton|creeper|spider|witch|enderman|drowned|husk|phantom|slime|pillager|vindicator|stray|bogged/i;
    const RANGED = /skeleton|stray|pillager|witch/i;
    // ★2026-07-08 用户令 "对末影人不要过度反应": 末影人是中立怪 — 未被激怒(凝视/攻击)前无害,
    // 却被 HOSTILE 正则当成常驻敌对 → 一只在 8-22b 乱传送的末影人 guard-stop 掉全部觅食(实拍
    // 15:36:42 "feedUp: guard stop hostile=true" → "no food source found" → 60s 空转)。只在【真被
    // 激怒】时才算威胁, 判据用权威信号: 它刚打了我们(末影人只近战, 5格内此刻掉血必是它归因)。
    // sticky ~10s(挂 bot._endThreatUntil, 非模块态 → 热加载存活)防它传送闪烁。self_defense
    // (mcdata.isHostile, 掉血才扩程 5→12)不动 → 被激怒/正在打我们的末影人照样还手。
    // (metadata[17] 早触发信号未经证实, 本版只用掉血判据; 详见校验工作流对抗结论。)
    const endermanIsThreat = (e) => {
        try {
            if (!e || !e.position || !bot.entity) return false;
            let m = bot._endThreatUntil;
            if (!(m instanceof Map)) { m = new Map(); bot._endThreatUntil = m; }
            const now = Date.now();
            if (m.size > 32) { for (const [k, v] of m) { if (v < now) m.delete(k); } }
            if ((now - (bot.lastDamageTime || 0) < 3000) && e.position.distanceTo(bot.entity.position) < 5) m.set(e.id, now + 10000);
            const until = m.get(e.id) || 0;
            if (until <= now) { if (until) m.delete(e.id); return false; }
            return true;
        } catch (err) { return false; }
    };
    // C34 同款可达性过滤: 近战怪隔≥5格高差物理够不到,不算威胁(荫蔽怪窝里 10格内
    // "常驻怪"让守卫永远 break,feedUp 的觅食分支全部饿死)
    const hostileNear = (r = 10) => !!world.getNearestEntityWhere(bot, e => {
        const name = e && (e.name || (e.displayName || ''));
        if (!e || !e.position || !name || !((e.type === 'hostile' || e.type === 'mob') && HOSTILE.test(name))) return false;
        const d = e.position.distanceTo(bot.entity.position);
        const daylightPassiveSpider = /^spider$/i.test(name) && !isNight() && d > 6 && bot.health >= 9 && has('stone_sword');
        if (daylightPassiveSpider) return false;
        if (/^enderman$/i.test(name) && !endermanIsThreat(e)) return false;   // 中立末影人不 guard-stop 觅食(未激怒)
        return RANGED.test(name) || Math.abs(e.position.y - bot.entity.position.y) < 5;
    }, r);
    const motionPos = () => {
        const p = bot.entity && bot.entity.position;
        return p ? { x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3) } : null;
    };
    const blockObj = (b) => b ? ({ name: b.name, position: { x: b.position.x, y: b.position.y, z: b.position.z }, boundingBox: b.boundingBox }) : null;
    const envSnap = () => {
        try {
            const c = bot.entity.position.floored();
            const out = [];
            for (const dy of [-1, 0, 1, 2]) {
                for (const dz of [-1, 0, 1]) {
                    for (const dx of [-1, 0, 1]) {
                        const b = bot.blockAt(c.offset(dx, dy, dz));
                        out.push({ d: [dx, dy, dz], n: b ? b.name : null, bb: b ? b.boundingBox : null });
                    }
                }
            }
            return out;
        } catch (e) { return []; }
    };
    const motion = (event, data = {}) => {
        try {
            const p = bot.entity.position;
            fs.appendFileSync(MINE_MOTION, JSON.stringify({
                ts: new Date().toISOString(),
                event,
                pos: motionPos(),
                foot: blockObj(bot.blockAt(p)),
                head: blockObj(bot.blockAt(p.offset(0, 1, 0))),
                above: blockObj(bot.blockAt(p.offset(0, 2, 0))),
                held: bot.heldItem ? bot.heldItem.name : 'empty',
                hp: Math.round(bot.health || 0),
                food: bot.food,
                skill: bot._currentSkill || null,
                mob: bot._mobility ? bot._mobility.state : null,
                env: envSnap(),
                data,
            }) + '\n');
        } catch (e) {}
    };
    const safeRoamTo = async (x, y, z, range = 3, label = 'roam', opts = {}) => {
        const start = bot.entity.position.clone();
        const hp0 = bot.health;
        const timeoutMs = Math.max(1200, opts.timeoutMs || 10000);
        const seq = (bot._feedUpSafeRoamSeq || 0) + 1;
        bot._feedUpSafeRoamSeq = seq;
        motion('feedUp.safe_roam.begin', {
            seq,
            label,
            target: { x: Math.round(x), y: Math.round(y), z: Math.round(z) },
            range,
            timeoutMs,
        });
        const moves = new Movements(bot);
        // ★own-infra break ban (2026-07-02 05:21Z white_bed dug by pathfinder, skill:null in
        // mine_motion.jsonl): beds/workstations/chests → blocksCantBreak. Moot while
        // canDig=false, but keeps this set safe if the flag ever flips. typeof-guarded for
        // the hot-reload window against a pre-hardenMovements skills.js.
        if (typeof skills.hardenMovements === 'function') { try { skills.hardenMovements(bot, moves); } catch (e) {} }
        moves.canDig = false;
        moves.allowParkour = false;
        moves.allow1by1towers = false;
        moves.maxDropDown = bot.health <= 10 ? 1 : 2;
        moves.liquids.add(mc.getBlockId('water'));
        moves.liquids.add(mc.getBlockId('flowing_water'));
        moves.liquids.add(mc.getBlockId('lava'));
        moves.liquids.add(mc.getBlockId('flowing_lava'));
        let stopWatch = false;
        let error = null;
        try {
            bot.pathfinder.setMovements(moves);
            await Promise.race([
                bot.pathfinder.goto(new goals.GoalNear(Math.round(x), Math.round(y), Math.round(z), range)),
                new Promise((_, rej) => setTimeout(() => rej(new Error('safe-roam-timeout')), timeoutMs)),
                new Promise((_, rej) => {
                    const tick = () => {
                        if (stopWatch) return;
                        if (hp0 - bot.health >= 1) return rej(new Error('safe-roam-hurt'));
                        if (hostileNear(8)) return rej(new Error('safe-roam-hostile'));
                        setTimeout(tick, 150);
                    };
                    setTimeout(tick, 150);
                }),
            ]);
        } catch (e) {
            error = e;
            try { bot.pathfinder.stop(); } catch (_) {}
            try { bot.pathfinder.setGoal(null); } catch (_) {}
            try { bot.clearControlStates(); } catch (_) {}
        } finally {
            stopWatch = true;
            try { bot.pathfinder.setGoal(null); } catch (_) {}
            try { bot.clearControlStates(); } catch (_) {}
        }
        const end = bot.entity.position;
        const hurt = hp0 - bot.health;
        const moved = start.distanceTo(end);
        const targetDist = end.distanceTo({ x, y, z });
        const ok = !error && targetDist <= range + 2;
        motion('feedUp.safe_roam.end', {
            seq,
            label,
            ok,
            error: error ? error.message : null,
            target: { x: Math.round(x), y: Math.round(y), z: Math.round(z) },
            range,
            moved: +moved.toFixed(3),
            targetDist: +targetDist.toFixed(3),
            from: { x: +start.x.toFixed(3), y: +start.y.toFixed(3), z: +start.z.toFixed(3) },
            to: { x: +end.x.toFixed(3), y: +end.y.toFixed(3), z: +end.z.toFixed(3) },
        });
        if (error) {
            // ★mode-contention retry (live 2026-07-02 02:22: three famine roams in a row died
            // to "The goal was changed" within ~1.4s — self_preservation's moveAway steals the
            // pathfinder goal mid-leg while hostiles hover, and the instant give-up left the
            // bot starving 32b from a chicken). The reflex finishes in ~1-3s; wait it out ONCE
            // and re-leg instead of surrendering the whole errand to a 2s dodge. Reflex still
            // wins every individual contention — this only stops one dodge from cancelling the
            // entire famine plan.
            if (/goal was changed/i.test(error.message || '') && !opts._goalStolenRetry && bot.food <= 11) {
                prog(`feedUp: safe ${label} goal stolen by a reflex — waiting it out + one re-leg`);
                await new Promise(r => setTimeout(r, 1800));
                if (!bot.interrupt_code && bot.health > 0) {
                    return await safeRoamTo(x, y, z, range, label, { ...opts, _goalStolenRetry: true });
                }
            }
            log(bot, `feedUp: safe ${label} failed (${error.message}) from ${Math.round(start.x)},${Math.round(start.y)},${Math.round(start.z)} to ${Math.round(x)},${Math.round(y)},${Math.round(z)}`);
            prog(`feedUp: safe ${label} failed (${error.message}) from ${Math.round(start.x)},${Math.round(start.y)},${Math.round(start.z)} to ${Math.round(x)},${Math.round(y)},${Math.round(z)}`);
            return false;
        }
        // ★famine dig-escape (live 2026-07-02 01:22 pit-spin): goto can resolve in ~60ms with
        // moved=0 and NO error when A* has zero expandable nodes — the bot standing in a dug
        // 1-wide pocket (dirt on all sides, solid block over the one open cell) that this
        // function's deliberately conservative Movements (canDig=false, no towers) cannot
        // leave. mobility said FREE (an open cell exists) so the unstuck layer never fired,
        // and a starving full-hp bot spun the GET_FOOD dispatch for minutes with a cow 45b
        // away. ONE retry with digging+towers enabled, famine-gated (food<=10 or explicit
        // opts.digEscape) — hunger outranks the roam conservatism; still time-capped.
        if (!ok && moved < 1 && !opts._digRetry && (bot.food <= 10 || opts.digEscape)) {
            prog(`feedUp: safe ${label} no-path-from-pocket (moved=0) — dig-escape retry food=${bot.food}`);
            const dm = new Movements(bot);            // canDig stays default TRUE on purpose
            // ★own-infra break ban even on the dig-escape retry (2026-07-02 05:21Z white_bed):
            // escaping a famine pocket never requires eating through a bed/chest — the ban
            // only exempts infrastructure, all ordinary escape digging stays allowed.
            if (typeof skills.hardenMovements === 'function') { try { skills.hardenMovements(bot, dm); } catch (e) {} }
            dm.allowParkour = false;
            dm.allow1by1towers = true;                 // climb out of the pocket
            dm.maxDropDown = bot.health <= 10 ? 1 : 2;
            dm.liquids.add(mc.getBlockId('water'));
            dm.liquids.add(mc.getBlockId('flowing_water'));
            dm.liquids.add(mc.getBlockId('lava'));
            dm.liquids.add(mc.getBlockId('flowing_lava'));
            let err2 = null;
            try {
                bot.pathfinder.setMovements(dm);
                await Promise.race([
                    bot.pathfinder.goto(new goals.GoalNear(Math.round(x), Math.round(y), Math.round(z), range)),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('safe-roam-timeout')), timeoutMs)),
                ]);
            } catch (e2) {
                err2 = e2;
                try { bot.pathfinder.stop(); } catch (_) {}
            } finally {
                try { bot.pathfinder.setGoal(null); } catch (_) {}
                try { bot.clearControlStates(); } catch (_) {}
            }
            const end2 = bot.entity.position;
            const moved2 = start.distanceTo(end2);
            const targetDist2 = end2.distanceTo({ x, y, z });
            motion('feedUp.safe_roam.dig_escape', { seq, label, error: err2 ? err2.message : null, moved: +moved2.toFixed(3), targetDist: +targetDist2.toFixed(3) });
            prog(`feedUp: dig-escape ${label} moved=${moved2.toFixed(1)} targetDist=${Math.round(targetDist2)}${err2 ? ` err=${err2.message}` : ''}`);
            return targetDist2 <= range + 2;
        }
        if (hurt >= 1) log(bot, `feedUp: safe ${label} still hurt ${hurt.toFixed(1)}hp, ${Math.round(start.x)},${Math.round(start.y)},${Math.round(start.z)} -> ${Math.round(end.x)},${Math.round(end.y)},${Math.round(end.z)}`);
        if (hurt >= 1) prog(`feedUp: safe ${label} hurt ${hurt.toFixed(1)}hp ${Math.round(start.x)},${Math.round(start.y)},${Math.round(start.z)} -> ${Math.round(end.x)},${Math.round(end.y)},${Math.round(end.z)}`);
        return ok;
    };
    const desperationRoam = async (opts = {}) => {
        // Food<12 is the acquisition window: below this, prepNether has
        // stopped resource work, so feedUp must relocate instead of returning empty.
        // Food=0 is the most obvious case, even if HP is still 7-10. The previous hp<=6 gate
        // stranded a surfaced bot in a no-animals pocket: too healthy to roam, too hungry
        // to resume work, and unable to regenerate. Daylight + no nearby threat is enough.
        // Low HP + food<18 is the same deadlock even when food is 12-17: no natural regen,
        // so a hp5/food13 bot must still relocate for food instead of "having enough buffer".
        const noRegenHurt = bot.health < 14 && bot.food < targetFood;
        if ((bot.food >= 12 && !noRegenHurt) || isNight() || hostileNear(8)) {
            prog(`feedUp: famine roam guard food=${bot.food} hp=${Math.round(bot.health)} noRegen=${noRegenHurt} night=${isNight()} hostile=${hostileNear(8)}`);
            return false;
        }
        const farAnimal = world.getNearestEntityWhere(bot, e => mc.isHuntable(e) && !failedIds.has(e.id), 96);
        if (farAnimal && farAnimal.position) {
            const animalDist = farAnimal.position.distanceTo(bot.entity.position);
            const animalDy = Math.abs(farAnimal.position.y - bot.entity.position.y);
            // ★C259 starvation-floor reach trap: maxAnimalClose SHRANK as food fell (food<=2 -> 32),
            // so at food2 a CONCRETE visible cow@48 became "too costly" and the bot gave up
            // (calorie-floor) and froze at food2 forever — a confirmed 6-min STALL @106,88,-9 with
            // cow@48 AND sweet_berry_bush@47 both in scan, both ignored. The shrink is meant to avoid
            // wasting the last pips on a SPECULATIVE roam, but for a KNOWN target stranding is far
            // worse than spending pips. Keep the low-food reach GENEROUS (>=56) so a seen animal at
            // the critical floor is actually pursued. crawlDyMax likewise relaxed: surfaceUp can strand
            // the bot on a hilltop (y88) above a ground cow (dy~18>12), so allow a bigger downhill crawl.
            const maxAnimalClose = bot.food <= 4 ? 56 : (bot.food <= 6 ? 64 : (bot.food <= 10 ? 72 : 96));
            if (animalDist > maxAnimalClose || animalDy > 10) {
                const crawlDyMax = bot.food <= 4 ? 24 : 12;
                if (bot.food <= 6 && bot.health >= 8 && animalDist <= 96 && animalDy <= crawlDyMax && !edibleHeld()) {
                    const p = bot.entity.position;
                    const dx = farAnimal.position.x - p.x;
                    const dz = farAnimal.position.z - p.z;
                    const flat = Math.hypot(dx, dz) || 1;
                    const step = Math.min(14, Math.max(8, flat - 4));
                    const tx = p.x + dx / flat * step;
                    const tz = p.z + dz / flat * step;
                    const crawlLabel = bot.food <= 1 ? 'starving' : 'low-food';
                    prog(`feedUp: ${crawlLabel} concrete animal crawl ${farAnimal.name || farAnimal.displayName || 'animal'} dist=${Math.round(animalDist)} dy=${Math.round(animalDy)} step=${Math.round(step)} from=${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)} to=${Math.round(tx)},${Math.round(p.y)},${Math.round(tz)}`);
                    const ok = await safeRoamTo(tx, p.y, tz, 4, `${crawlLabel}-animal-crawl`, { timeoutMs: 6500 });
                    if (ok) return true;
                    try {
                        const nextAnimal = world.getNearestEntityWhere(bot, e => mc.isHuntable(e) && !failedIds.has(e.id), 96);
                        const nextDist = nextAnimal && nextAnimal.position ? nextAnimal.position.distanceTo(bot.entity.position) : null;
                        const nextDy = nextAnimal && nextAnimal.position ? Math.abs(nextAnimal.position.y - bot.entity.position.y) : null;
                        if (nextDist != null && nextDist <= 32 && nextDy <= 12) {
                            prog(`feedUp: ${crawlLabel} animal crawl reached hunt window ${nextAnimal.name || nextAnimal.displayName || 'animal'} dist=${Math.round(nextDist)} dy=${Math.round(nextDy)} — continue now`);
                            return true;
                        }
                        const progressNeed = bot.food <= 1 ? 5 : 3;
                        if (nextDist != null && nextDist <= animalDist - progressNeed && !isNight() && !hostileNear(8)) {
                            prog(`feedUp: ${crawlLabel} animal crawl partial progress ${Math.round(animalDist)}->${Math.round(nextDist)} dy=${Math.round(nextDy)} — continue, no cooldown`);
                            return true;
                        }
                        prog(`feedUp: ${crawlLabel} animal crawl no progress dist=${nextDist == null ? 'none' : Math.round(nextDist)} was=${Math.round(animalDist)}`);
                    } catch (e) {}
                    return false;
                }
                prog(`feedUp: famine roam animal skip ${Math.round(animalDist)}b dy=${Math.round(animalDy)} max=${maxAnimalClose} food=${bot.food} hp=${Math.round(bot.health)} — too costly`);
                if (opts.concreteOnly || bot.food <= 10) return false;
            } else {
                log(bot, `feedUp: famine roam — animal ${Math.round(animalDist)}b away, closing distance`);
                prog(`feedUp: famine roam animal ${Math.round(animalDist)}b away dy=${Math.round(animalDy)} max=${maxAnimalClose}`);
                return await safeRoamTo(farAnimal.position.x, farAnimal.position.y, farAnimal.position.z, 4, 'animal-close');
            }
        }
        if (opts.concreteOnly || bot.food <= 10) {
            prog(`feedUp: targeted roam scan ${foodScan()} pos=${Math.round(bot.entity.position.x)},${Math.round(bot.entity.position.y)},${Math.round(bot.entity.position.z)} food=${bot.food} hp=${Math.round(bot.health)} — no concrete/economic target`);
            return false;
        }
        const p = bot.entity.position;
        let tx = p.x + 24, tz = p.z;
        try {
            const s = JSON.parse(fs.readFileSync(SPAWNF, 'utf8'));
            if (typeof s.x === 'number') {
                const dx = s.x - p.x, dz = s.z - p.z;
                const d = Math.hypot(dx, dz) || 1;
                if (d > 10) { tx = p.x + dx / d * 24; tz = p.z + dz / d * 24; }
            }
        } catch (e) {
            const a = ((tries * 137) % 360) * Math.PI / 180;
            tx = p.x + Math.cos(a) * 24; tz = p.z + Math.sin(a) * 24;
        }
        log(bot, `feedUp: famine roam — no food here, relocating to ${Math.round(tx)},${Math.round(tz)}`);
        prog(`feedUp: famine roam relocate to ${Math.round(tx)},${Math.round(tz)} from ${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`);
        try { return await safeRoamTo(Math.round(tx), Math.round(p.y), Math.round(tz), 4, 'relocate'); }
        catch (e) { try { await skills.moveAway(bot, 12); } catch (e2) {} }
        return false;
    };
    const criticalMicroScout = async () => {
        const night = isNight();
        const hostiles = hostileNear(10);
        const cooldown = Math.max(0, (bot._feedUpCriticalMicroScoutCooldownUntil || 0) - Date.now());
        const starvationScout = bot.food <= 1 && bot.health >= 7 && !edibleHeld();
        if ((!starvationScout && bot.health > 6) || bot.food > 2 || night || hostiles || cooldown > 0) {
            if (!bot._lastCriticalMicroScoutGuardAt || Date.now() - bot._lastCriticalMicroScoutGuardAt > 30000) {
                bot._lastCriticalMicroScoutGuardAt = Date.now();
                prog(`feedUp: critical micro-scout guard hp=${Math.round(bot.health)} food=${bot.food} starving=${starvationScout} night=${night} hostiles10=${hostiles} cooldown=${Math.ceil(cooldown / 1000)}s`);
            }
            return false;
        }
        bot._feedUpCriticalMicroScoutCooldownUntil = Date.now() + 45000;
        const p = bot.entity.position;
        const scoutStep = starvationScout ? 6 : 10;
        let tx = p.x + scoutStep, tz = p.z;
        try {
            const s = JSON.parse(fs.readFileSync(SPAWNF, 'utf8'));
            if (typeof s.x === 'number') {
                const dx = s.x - p.x, dz = s.z - p.z;
                const d = Math.hypot(dx, dz) || 1;
                tx = p.x + dx / d * scoutStep;
                tz = p.z + dz / d * scoutStep;
            }
        } catch (e) {
            const a = ((tries * 101 + Math.floor(Date.now() / 45000) * 37) % 360) * Math.PI / 180;
            tx = p.x + Math.cos(a) * scoutStep;
            tz = p.z + Math.sin(a) * scoutStep;
        }
        prog(`feedUp: ${starvationScout ? 'starving' : 'critical'} micro-scout from ${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)} to ${Math.round(tx)},${Math.round(tz)} step=${scoutStep} — safeRoam gated`);
        return await safeRoamTo(Math.round(tx), Math.round(p.y), Math.round(tz), 4, 'critical-micro-scout');
    };
    // ★PlanC 短程拾取(置于 roam 守卫之前): 白天烧怪掉的腐肉/熟肉 5 分钟 despawn,
    // 等"周围干净"再捡就没了。拾取≤16格且无6格内可达威胁=低风险快进快出,
    // 与 roam-hunt 风险不同级,单独放行。
    const fetchFoodDrop = async () => {
        try {
            // ★doomed-drop memo (checkpoint #10 famine root: 97 'pickup attempted' no-ops today
            // at 1.6Hz — this function returned TRUE without verifying the pickup, while
            // pickupNearbyItems silently skipped the drop it had just blacklisted as
            // unreachable (6811eb9). The caller loop re-selected the same doomed drop forever
            // and the whole daylight food window burned on it.)
            const skip = bot._feedUpDropSkip || (bot._feedUpDropSkip = {});
            for (const k of Object.keys(skip)) if (Date.now() - skip[k] > 60000) delete skip[k];
            // Famine widens the net: 16b missed a rotten_flesh drop sitting at 32b while the
            // bot starved at food=6 in a food desert (2026-07-02 12:35Z live). Poison flesh
            // beats an empty hunger bar; the doomed-drop memo below bounds wasted trips.
            const dropR = bot.food <= 6 ? 32 : 16;
            const drop = world.getNearestEntityWhere(bot, e => isFoodDrop(e) && !(e && skip[e.id]), dropR);
            if (!drop || !drop.position) {
                const anyDrop = world.getNearestEntityWhere(bot, e => e && e.name === 'item', 4);
                if (anyDrop && anyDrop.position && (!bot._feedUpNonFoodDropLogAt || Date.now() - bot._feedUpNonFoodDropLogAt > 5000)) {
                    bot._feedUpNonFoodDropLogAt = Date.now();
                    prog(`feedUp: PlanC drop nearby but not food ${nearbyDropsSummary(4)}`);
                }
                return false;
            }
            const dist = drop.position.distanceTo(bot.entity.position);
            if (hostileNear(6) && dist > 2.2) {
                prog(`feedUp: PlanC food drop blocked by close hostile ${droppedItemName(drop)}@${Math.round(dist)}`);
                return false;
            }
            log(bot, `feedUp: PlanC — food drop ${Math.round(drop.position.distanceTo(bot.entity.position))}b away, fetching`);
            const foodCount = () => bot.inventory.items().filter(i => FOOD_RE.test(i.name) || /rotten_flesh/.test(i.name)).reduce((s, i) => s + i.count, 0);
            const before = foodCount();
            // Full pack = the server CANNOT deposit the pickup (the C299 wood-famine class,
            // food edition). During a food errand, one junk stack is worth less than a meal.
            try {
                if (bot.inventory.emptySlotCount() === 0) {
                    const junk = bot.inventory.items().find(i => /^(cobblestone|cobbled_deepslate|dirt|granite|diorite|andesite|tuff|gravel|sand|netherrack)$/.test(i.name));
                    // ★2026-07-14 坑弃: 裸 toss 扔脚底, 2s pickup-delay 一过被服务器原样塞回 = 白腾。
                    // smartDiscard 找低地/挖 1 格坑入弃; verify:false+maxDigs:1 — 饥荒赶路不烧验证时间,
                    // 反正马上要走向食物掉落物 (走开本身就出拾取球)。热重载窗口老 skills.js 退回裸 toss。
                    if (junk && typeof skills.smartDiscard === 'function') {
                        await skills.smartDiscard(bot, { name: junk.name, num: Math.min(junk.count, 32) }, { verify: false, maxDigs: 1 });
                    } else if (junk) { await bot.toss(junk.type, null, Math.min(junk.count, 32)); await skills.wait(bot, 250); }
                }
            } catch (e) {}
            if (dist > 1.6 && !(await safeRoamTo(drop.position.x, drop.position.y, drop.position.z, 2, 'food-drop'))) {
                // Path-doomed counts as doomed too: without the memo an unreachable far drop
                // gets re-courted every loop pass (same shape as the checkpoint #10 1.6Hz spin).
                if (drop.id != null) skip[drop.id] = Date.now();
                return false;
            }
            try { await skills.pickupNearbyItems(bot); } catch (e) {}
            if (foodCount() <= before) {
                // GoalNear r=2 stops BESIDE the drop; vanilla pickup needs cell overlap —
                // finish with a direct walk-ONTO before judging the drop doomed.
                try { await skills.goToPosition(bot, drop.position.x, drop.position.y, drop.position.z, 0); } catch (e) {}
                await skills.wait(bot, 350);
            }
            const gained = foodCount() - before;
            prog(`feedUp: PlanC food drop ${droppedItemName(drop)}@${Math.round(dist)} gained=${gained} held=${bot.inventory.items().map(i => i.name).filter(n => FOOD_RE.test(n) || /rotten_flesh|spider_eye/.test(n)).join(',') || 'none'}`);
            if (gained <= 0) {
                if (drop.id != null) skip[drop.id] = Date.now();   // don't re-court a doomed drop for 60s
                return false;                                       // honest: nothing was fetched
            }
            if (bot.food <= 6) {
                const junk = bot.inventory.items().find(i => /rotten_flesh|^beef$|^porkchop$|^chicken$|^mutton$/.test(i.name));
                if (junk) { try { await skills.consume(bot, junk.name); } catch (e) {} }
            }
            return true;
        } catch (e) { return false; }
    };
    const localFish = async () => {
        try {
            if (isNight() || hostileNear(10)) return false;
            const range = bot.health <= 6 ? 8 : 24;
            const fish = world.getNearestEntityWhere(bot, e => {
                const n = (e && (e.name || e.displayName) || '').toLowerCase();
                return /cod|salmon/.test(n);
            }, range);
            if (!fish || !fish.position) return false;
            prog(`feedUp: local fish ${fish.name || fish.displayName || 'fish'} dist=${Math.round(fish.position.distanceTo(bot.entity.position))}`);
            try {
                await Promise.race([
                    safeRoamTo(fish.position.x, fish.position.y, fish.position.z, 3, 'local-fish'),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('local-fish-timeout')), 7000)),
                ]);
            } catch (e) {
                prog(`feedUp: local fish abort ${e.message}`);
                try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
                try { bot.clearControlStates(); } catch (_) {}
                return false;
            }
            try { await skills.attackEntity(bot, fish); } catch (e) {}
            try { await skills.pickupNearbyItems(bot); } catch (e) {}
            return await eat();
        } catch (e) { return false; }
    };
    const appleLeafSweep = async (maxLeaves = 28, opts = {}) => {
        try {
            const stopFood = opts.stopFood == null ? 2 : opts.stopFood;
            const maxUp = opts.maxUp == null ? 3 : opts.maxUp;
            const maxReach = opts.maxReach == null ? 4.5 : opts.maxReach;
            const directReach = opts.directReach == null ? 4.8 : opts.directReach;
            const base = bot.entity.position.floored();
            const blockLabel = (b) => b ? `${b.name}@${b.position.x},${b.position.y},${b.position.z}` : 'null';
            const badWindowBlock = (b) => !b || /bedrock|water|lava|fire|cactus|magma|campfire/.test(b.name || '');
            const directBreakLeaf = async (fresh) => {
                const dist = fresh.position.distanceTo(bot.entity.position);
                if (dist > directReach) throw new Error(`leaf-direct-out-of-range dist=${dist.toFixed(2)} directReach=${directReach}`);
                try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
                try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (_) {}
                try { bot.clearControlStates(); } catch (_) {}
                await bot.lookAt(fresh.position.offset(0.5, 0.5, 0.5), true);
                try { if (bot.tool && bot.tool.equipForBlock) await bot.tool.equipForBlock(fresh); } catch (_) {}
                const timeoutMs = 4000;
                await Promise.race([
                    bot.dig(fresh, true),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('leaf direct dig timeout')), timeoutMs)),
                ]);
                return true;
            };
            const clearLeafSightWindow = async (leaf) => {
                if (opts.clearWindowOnFail === false || isNight() || hostileNear(10)) return 0;
                const hasPick = bot.inventory.items().some(it => /_pickaxe$/.test(it.name || ''));
                const here = bot.entity.position.floored();
                const dx0 = leaf.position.x + 0.5 - bot.entity.position.x;
                const dz0 = leaf.position.z + 0.5 - bot.entity.position.z;
                const dx = Math.abs(dx0) >= Math.abs(dz0) ? Math.sign(dx0) : 0;
                const dz = dx ? 0 : Math.sign(dz0);
                const candidates = [
                    here.offset(0, 2, 0),
                    here.offset(dx, 0, dz),
                    here.offset(dx, 1, dz),
                    here.offset(dx, 2, dz),
                ];
                const seen = new Set();
                let opened = 0;
                for (const p of candidates) {
                    if (!p || (!dx && !dz && p.y !== here.y + 2)) continue;
                    const key = `${p.x},${p.y},${p.z}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    const b = bot.blockAt(p);
                    if (!b || b.boundingBox !== 'block' || badWindowBlock(b)) continue;
                    if (/^(oak|dark_oak)_leaves$/.test(b.name || '')) continue;
                    const stony = /stone|deepslate|andesite|diorite|granite|tuff|_ore$|obsidian|cobble/.test(b.name || '');
                    if (stony && !hasPick) continue;
                    if (b.position.distanceTo(bot.entity.position) > 4.45) continue;
                    motion('feedUp.leaf_sweep.window.begin', {
                        target: { name: leaf.name, x: leaf.position.x, y: leaf.position.y, z: leaf.position.z },
                        block: blockLabel(b),
                        maxReach,
                    });
                    try {
                        await skills.breakBlockAt(bot, b.position.x, b.position.y, b.position.z);
                        const after = bot.blockAt(p);
                        const ok = !after || after.boundingBox !== 'block';
                        motion('feedUp.leaf_sweep.window.end', { ok, block: blockLabel(b), after: blockLabel(after), maxReach });
                        if (ok) opened++;
                    } catch (e) {
                        motion('feedUp.leaf_sweep.window.end', { ok: false, block: blockLabel(b), error: e.message, maxReach });
                    }
                    if (opened >= 3) break;
                }
                return opened;
            };
            const stepIntoLeafWindow = async (leaf) => {
                if (isNight() || hostileNear(10)) return false;
                const here = bot.entity.position.floored();
                const dx0 = leaf.position.x + 0.5 - bot.entity.position.x;
                const dz0 = leaf.position.z + 0.5 - bot.entity.position.z;
                const dx = Math.abs(dx0) >= Math.abs(dz0) ? Math.sign(dx0) : 0;
                const dz = dx ? 0 : Math.sign(dz0);
                if (!dx && !dz) return false;
                const targetCell = here.offset(dx, 0, dz);
                const foot = bot.blockAt(targetCell);
                const head = bot.blockAt(targetCell.offset(0, 1, 0));
                const floor = bot.blockAt(targetCell.offset(0, -1, 0));
                const openBlock = (b) => !b || b.boundingBox === 'empty' || /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|dead_bush|snow)$/.test(b.name || '');
                if (!openBlock(foot) || !openBlock(head) || !floor || floor.boundingBox !== 'block' || badWindowBlock(floor)) {
                    motion('feedUp.leaf_sweep.window_step.skip', {
                        targetCell: { x: targetCell.x, y: targetCell.y, z: targetCell.z },
                        foot: blockLabel(foot),
                        head: blockLabel(head),
                        floor: blockLabel(floor),
                    });
                    return false;
                }
                const before = bot.entity.position.clone();
                const inTargetCell = () => {
                    const p = bot.entity.position;
                    return Math.floor(p.x) === targetCell.x && Math.floor(p.z) === targetCell.z
                        && Math.hypot(p.x - (targetCell.x + 0.5), p.z - (targetCell.z + 0.5)) <= 0.95;
                };
                const tryAdjacentGoto = async () => {
                    let ok = false;
                    let error = null;
                    try {
                        const moves = new Movements(bot);
                        // ★own-infra break ban (see 2026-07-02 05:21Z white_bed note above).
                        if (typeof skills.hardenMovements === 'function') { try { skills.hardenMovements(bot, moves); } catch (e) {} }
                        moves.canDig = false;
                        moves.allowParkour = false;
                        moves.allow1by1towers = false;
                        moves.maxDropDown = 1;
                        moves.scafoldingBlocks = [];
                        try { moves.liquids.add(mc.getBlockId('water')); } catch (_) {}
                        try { moves.liquids.add(mc.getBlockId('flowing_water')); } catch (_) {}
                        try { moves.liquids.add(mc.getBlockId('lava')); } catch (_) {}
                        try { moves.liquids.add(mc.getBlockId('flowing_lava')); } catch (_) {}
                        bot.pathfinder.setMovements(moves);
                        await Promise.race([
                            bot.pathfinder.goto(new goals.GoalBlock(targetCell.x, targetCell.y, targetCell.z)),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('adjacent-goto-timeout')), 950)),
                        ]);
                        ok = inTargetCell() || bot.entity.position.distanceTo(targetCell.offset(0.5, 0, 0.5)) <= 1.05;
                    } catch (e) {
                        error = e && e.message ? e.message : String(e);
                        try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
                    } finally {
                        try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (_) {}
                        try { bot.clearControlStates(); } catch (_) {}
                    }
                    motion('feedUp.leaf_sweep.window_step.goto', {
                        ok,
                        error,
                        targetCell: { x: targetCell.x, y: targetCell.y, z: targetCell.z },
                        pos: motionPos(),
                    });
                    return ok;
                };
                let clearedForwardTicks = 0;
                let reassertTicks = 0;
                let fallbackTried = false;
                try {
                    try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
                    try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (_) {}
                    bot._bodyMoveLockOwner = 'feedUp:leaf-window-step';
                    bot._bodyMoveLockUntil = Date.now() + 2600;
                    await bot.lookAt(targetCell.offset(0.5, 1.1, 0.5), true);
                    bot.setControlState('sprint', false);
                    bot.setControlState('sneak', false);
                    bot.setControlState('jump', false);
                    bot.setControlState('forward', true);
                    motion('feedUp.leaf_sweep.window_step.begin', {
                        targetCell: { x: targetCell.x, y: targetCell.y, z: targetCell.z },
                        from: motionPos(),
                    });
                    const until = Date.now() + 1200;
                    while (Date.now() < until && !inTargetCell()) {
                        const cs = bot.controlState || {};
                        if (!cs.forward) clearedForwardTicks++;
                        if (Date.now() % 180 < 50) {
                            try { await bot.lookAt(targetCell.offset(0.5, 1.1, 0.5), true); } catch (_) {}
                        }
                        bot.setControlState('sprint', false);
                        bot.setControlState('sneak', false);
                        bot.setControlState('jump', false);
                        bot.setControlState('forward', true);
                        reassertTicks++;
                        if (!fallbackTried && Date.now() > until - 820 && bot.entity.position.distanceTo(before) < 0.08) {
                            fallbackTried = true;
                            try { bot.clearControlStates(); } catch (_) {}
                            if (await tryAdjacentGoto()) break;
                            try { await bot.lookAt(targetCell.offset(0.5, 1.1, 0.5), true); } catch (_) {}
                            bot.setControlState('forward', true);
                        }
                        await skills.wait(bot, 45);
                    }
                } finally {
                    try { bot.clearControlStates(); } catch (_) {}
                    if (bot._bodyMoveLockOwner === 'feedUp:leaf-window-step') {
                        bot._bodyMoveLockOwner = null;
                        bot._bodyMoveLockUntil = 0;
                    }
                }
                const moved = inTargetCell() || bot.entity.position.distanceTo(before) > 0.45;
                motion('feedUp.leaf_sweep.window_step.end', {
                    targetCell: { x: targetCell.x, y: targetCell.y, z: targetCell.z },
                    moved,
                    from: { x: +before.x.toFixed(3), y: +before.y.toFixed(3), z: +before.z.toFixed(3) },
                    to: motionPos(),
                    leafDist: +leaf.position.distanceTo(bot.entity.position).toFixed(3),
                    clearedForwardTicks,
                    reassertTicks,
                    fallbackTried,
                });
                return moved;
            };
            const leaves = [];
            let nearest = null;
            for (let dx = -5; dx <= 5; dx++) {
                for (let dz = -5; dz <= 5; dz++) {
                    for (let dy = 0; dy <= maxUp; dy++) {
                        const b = bot.blockAt(base.offset(dx, dy, dz));
                        if (!b || !/^(oak|dark_oak)_leaves$/.test(b.name || '')) continue;
                        const dist = b.position.distanceTo(bot.entity.position);
                        const relDy = b.position.y - bot.entity.position.y;
                        if (!nearest || dist < nearest.dist) {
                            nearest = { name: b.name, x: b.position.x, y: b.position.y, z: b.position.z, dist, dy: relDy };
                        }
                        if (dist <= maxReach) leaves.push(b);
                    }
                }
            }
            leaves.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
            bot._feedUpLastLeafSweep = {
                at: Date.now(),
                base: { x: base.x, y: base.y, z: base.z },
                reachable: leaves.length,
                broken: 0,
                maxUp,
                maxReach,
                directReach,
                nearest,
            };
            if (!leaves.length) {
                const n = nearest ? `${nearest.name}@${Math.round(nearest.dist)} dy=${Math.round(nearest.dy)} ${nearest.x},${nearest.y},${nearest.z}` : 'none';
                prog(`feedUp: PlanD leaf sweep no reachable leaves maxUp=${maxUp} maxReach=${maxReach} nearest=${n}`);
                motion('feedUp.leaf_sweep.none', {
                    base: { x: base.x, y: base.y, z: base.z },
                    maxUp,
                    maxReach,
                    nearest,
                });
                return false;
            }
            prog(`feedUp: PlanD leaf sweep — breaking up to ${Math.min(maxLeaves, leaves.length)} oak leaves for apples stopFood=${stopFood} maxReach=${maxReach}`);
            motion('feedUp.leaf_sweep.begin', {
                base: { x: base.x, y: base.y, z: base.z },
                maxLeaves,
                selected: Math.min(maxLeaves, leaves.length),
                reachable: leaves.length,
                maxUp,
                maxReach,
                directReach,
                nearest,
            });
            let broken = 0;
            let failed = 0;
            let openedWindows = 0;
            for (const leaf of leaves.slice(0, maxLeaves)) {
                if (isNight() || hostileNear(10) || bot.food > stopFood) break;
                const fresh = bot.blockAt(leaf.position);
                if (!fresh || !/^(oak|dark_oak)_leaves$/.test(fresh.name || '')) continue;
                if (fresh.position.distanceTo(bot.entity.position) > maxReach) continue;
                try {
                    await directBreakLeaf(fresh);
                    broken++;
                } catch (e) {
                    failed++;
                    motion('feedUp.leaf_sweep.dig_failed', {
                        leaf: blockLabel(fresh),
                        error: e.message,
                        dist: +fresh.position.distanceTo(bot.entity.position).toFixed(3),
                        maxReach,
                        directReach,
                    });
                    if (bot.food <= 3 && bot.health <= 8 && openedWindows < 3) {
                        const openedNow = await clearLeafSightWindow(fresh);
                        openedWindows += openedNow;
                        const nearWindow = fresh.position.distanceTo(bot.entity.position) <= directReach + 0.65;
                        if (openedNow > 0 || nearWindow) await stepIntoLeafWindow(fresh);
                        const retry = bot.blockAt(fresh.position);
                        if (retry && /^(oak|dark_oak)_leaves$/.test(retry.name || '') && retry.position.distanceTo(bot.entity.position) <= directReach) {
                            try {
                                await directBreakLeaf(retry);
                                broken++;
                            } catch (e2) {
                                motion('feedUp.leaf_sweep.retry_failed', {
                                    leaf: blockLabel(retry),
                                    error: e2.message,
                                    dist: +retry.position.distanceTo(bot.entity.position).toFixed(3),
                                    maxReach,
                                    directReach,
                                });
                            }
                        }
                    }
                }
                if (broken % 4 === 0) {
                    try { await skills.pickupNearbyItems(bot); } catch (e) {}
                    if (await eat()) return true;
                }
            }
            bot._feedUpLastLeafSweep = {
                at: Date.now(),
                base: { x: base.x, y: base.y, z: base.z },
                reachable: leaves.length,
                broken,
                failed,
                openedWindows,
                maxUp,
                maxReach,
                directReach,
                nearest,
            };
            motion('feedUp.leaf_sweep.end', {
                base: { x: base.x, y: base.y, z: base.z },
                reachable: leaves.length,
                broken,
                failed,
                openedWindows,
                maxUp,
                maxReach,
                directReach,
                nearest,
                food: bot.food,
                hp: Math.round(bot.health),
            });
            try { await skills.pickupNearbyItems(bot); } catch (e) {}
            if (await eat()) return true;
            prog(`feedUp: PlanD leaf sweep drops after pickup ${nearbyDropsSummary(6)} invFood=${bot.inventory.items().map(i => i.name).filter(n => FOOD_RE.test(n) || /rotten_flesh|spider_eye/.test(n)).join(',') || 'none'}`);
            return false;
        } catch (e) {
            prog(`feedUp: PlanD leaf sweep err ${e.message}`);
            return false;
        }
    };
    const nearestAppleLeaves = (radius = 10, maxCount = 10) => {
        const out = [];
        try {
            const base = bot.entity.position.floored();
            const seen = new Set();
            for (let dx = -radius; dx <= radius; dx++) {
                for (let dz = -radius; dz <= radius; dz++) {
                    for (let dy = -2; dy <= 6; dy++) {
                        const b = bot.blockAt(base.offset(dx, dy, dz));
                        if (!b || !/^(oak|dark_oak)_leaves$/.test(b.name || '')) continue;
                        const key = `${b.position.x},${b.position.y},${b.position.z}`;
                        if (seen.has(key)) continue;
                        seen.add(key);
                        const dist = b.position.distanceTo(bot.entity.position);
                        const vdist = Math.abs(b.position.y - bot.entity.position.y);
                        if (dist <= radius + 1 && vdist <= 6) out.push(b);
                    }
                }
            }
            for (const name of ['oak_leaves', 'dark_oak_leaves']) {
                const b = world.getNearestBlock(bot, name, radius + 2);
                if (!b || !b.position) continue;
                const key = `${b.position.x},${b.position.y},${b.position.z}`;
                if (seen.has(key)) continue;
                if (Math.abs(b.position.y - bot.entity.position.y) <= 6) {
                    seen.add(key);
                    out.push(b);
                }
            }
        } catch (e) {}
        out.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
        return out.slice(0, maxCount);
    };
    const emergencyLeafApproach = async (label = 'leaf') => {
        if (bot.food > 2 || edibleHeld() || isNight() || hostileNear(8)) return false;
        const sweepOpts = { stopFood: 10, maxUp: 4, maxReach: 5.05, directReach: 4.8 };
        const leaves = nearestAppleLeaves(10, 8);
        if (!leaves.length) return false;
        const start = bot.entity.position.clone();
        for (const leaf of leaves) {
            const dist = leaf.position.distanceTo(bot.entity.position);
            const dy = leaf.position.y - bot.entity.position.y;
            if (dist <= 4.5) {
                prog(`feedUp: emergency leaf ${label} already reachable ${leaf.name}@${Math.round(dist)} dy=${Math.round(dy)} food=${bot.food}`);
                if (await appleLeafSweep(48, sweepOpts)) return true;
                continue;
            }
            if (dist > 10 || Math.abs(dy) > 6) continue;
            const hereY = Math.round(bot.entity.position.y);
            const candidates = [];
            for (const [dx, dz] of [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2], [3, 0], [-3, 0], [0, 3], [0, -3], [2, 2], [2, -2], [-2, 2], [-2, -2]]) {
                const x = leaf.position.x + dx;
                const z = leaf.position.z + dz;
                const reach = Math.hypot(x - leaf.position.x, z - leaf.position.z, hereY - leaf.position.y);
                const from = Math.hypot(x - bot.entity.position.x, z - bot.entity.position.z);
                if (reach <= 4.4 && from <= 9) candidates.push({ x, y: hereY, z, reach, from });
            }
            candidates.sort((a, b) => a.from - b.from);
            for (const c of candidates.slice(0, 4)) {
                prog(`feedUp: emergency leaf approach ${label} leaf=${leaf.name}@${leaf.position.x},${leaf.position.y},${leaf.position.z} dist=${Math.round(dist)} dy=${Math.round(dy)} candidate=${Math.round(c.x)},${Math.round(c.y)},${Math.round(c.z)} food=${bot.food} hp=${Math.round(bot.health)}`);
                if (await safeRoamTo(c.x, c.y, c.z, 2, 'emergency-leaf', { timeoutMs: 4500 })) {
                    if (await appleLeafSweep(56, sweepOpts)) return true;
                    try { await skills.pickupNearbyItems(bot); } catch (e) {}
                    if (await eat()) return true;
                }
                if (leaf.position.distanceTo(bot.entity.position) <= 4.8) {
                    prog(`feedUp: emergency leaf approach ${label} partial reach nowDist=${Math.round(leaf.position.distanceTo(bot.entity.position))}`);
                    if (await appleLeafSweep(56, sweepOpts)) return true;
                }
                if (bot.health < 8 || bot.food <= 0 || isNight() || hostileNear(8)) return false;
            }
        }
        const end = bot.entity.position;
        prog(`feedUp: emergency leaf approach ${label} exhausted moved=${Math.round(start.distanceTo(end))} food=${bot.food} hp=${Math.round(bot.health)}`);
        return false;
    };
    const localOakLike = (radius = 5, maxDist = 4.8) => {
        try {
            const base = bot.entity.position.floored();
            for (let dx = -radius; dx <= radius; dx++) {
                for (let dz = -radius; dz <= radius; dz++) {
                    for (let dy = -6; dy <= 8; dy++) {
                        const b = bot.blockAt(base.offset(dx, dy, dz));
                        if (!b || !/^(oak|dark_oak)_(log|leaves)$/.test(b.name || '')) continue;
                        if (b.position.distanceTo(bot.entity.position) <= maxDist) return true;
                    }
                }
            }
            for (const name of ['oak_log', 'oak_leaves', 'dark_oak_log', 'dark_oak_leaves']) {
                const b = world.getNearestBlock(bot, name, Math.ceil(maxDist) + 2);
                if (!b || !b.position) continue;
                if (b.position.distanceTo(bot.entity.position) <= maxDist && Math.abs(b.position.y - bot.entity.position.y) <= 8) return true;
            }
        } catch (e) {}
        return false;
    };
    const localOakDecayKick = async (label = 'PlanD') => {
        if (bot.food > 2 || bot.health < 7 || edibleHeld() || isNight() || hostileNear(10)) return false;
        if (Date.now() < (bot._feedUpLocalOakDecayUntil || 0)) return false;
        let best = null;
        try {
            const base = bot.entity.position.floored();
            const underKey = `${base.x},${base.y - 1},${base.z}`;
            for (let dx = -5; dx <= 5; dx++) {
                for (let dz = -5; dz <= 5; dz++) {
                    for (let dy = -1; dy <= 4; dy++) {
                        const b = bot.blockAt(base.offset(dx, dy, dz));
                        if (!b || !/^(oak|dark_oak)_log$/.test(b.name || '')) continue;
                        const key = `${b.position.x},${b.position.y},${b.position.z}`;
                        if (key === underKey) continue;
                        const dist = b.position.distanceTo(bot.entity.position);
                        const relDy = b.position.y - bot.entity.position.y;
                        if (dist > 4.35 || Math.abs(relDy) > 3.5) continue;
                        if (!best || dist < best.dist) best = { block: b, dist, relDy };
                    }
                }
            }
        } catch (e) {}
        if (!best) return false;
        // ★#2 sibling (review-2026-07-06 穿墙挖树): 别 x-ray 隔墙挖 log — >2.2b 且看不见=隔掩体墙, 跳过。
        try {
            if (best.dist > 2.2 && !bot.canSeeBlock(best.block)) {
                motion('feedUp.local_oak_decay.xray_skip', { target: `${best.block.name}@${best.block.position.x},${best.block.position.y},${best.block.position.z}`, dist: +best.dist.toFixed(2) });
                bot._feedUpLocalOakDecayUntil = Date.now() + 45000;   // 别立刻重试同块
                return false;
            }
        } catch (e) {}
        const logBlock = best.block;
        bot._feedUpLocalOakDecayUntil = Date.now() + 45000;
        prog(`feedUp: ${label} local oak decay kick ${logBlock.name}@${logBlock.position.x},${logBlock.position.y},${logBlock.position.z} dist=${best.dist.toFixed(1)} dy=${best.relDy.toFixed(1)} food=${bot.food} hp=${Math.round(bot.health)} — no roam/no climb`);
        motion('feedUp.local_oak_decay.begin', {
            label,
            target: { name: logBlock.name, x: logBlock.position.x, y: logBlock.position.y, z: logBlock.position.z },
            dist: +best.dist.toFixed(3),
            dy: +best.relDy.toFixed(3),
        });
        try {
            try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
            try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (_) {}
            try { bot.clearControlStates(); } catch (_) {}
            await bot.lookAt(logBlock.position.offset(0.5, 0.5, 0.5), true);
            if (bot.heldItem && /_sword$/.test(bot.heldItem.name || '') && !bot.inventory.items().some(i => /_axe$/.test(i.name || ''))) {
                try { await bot.unequip('hand'); } catch (_) {}
            } else {
                try { if (bot.tool && bot.tool.equipForBlock) await bot.tool.equipForBlock(logBlock); } catch (_) {}
            }
            await Promise.race([
                bot.dig(logBlock, true),
                new Promise((_, reject) => setTimeout(() => reject(new Error('local-oak-decay-timeout')), 6500)),
            ]);
            const after = bot.blockAt(logBlock.position);
            motion('feedUp.local_oak_decay.end', {
                label,
                ok: !after || !/^(oak|dark_oak)_log$/.test(after.name || ''),
                after: after ? `${after.name}@${after.position.x},${after.position.y},${after.position.z}` : 'null',
            });
        } catch (e) {
            try { bot.stopDigging(); } catch (_) {}
            motion('feedUp.local_oak_decay.end', { label, ok: false, error: e.message });
            prog(`feedUp: ${label} local oak decay kick failed ${e.message}`);
            return false;
        } finally {
            try { bot.clearControlStates(); } catch (_) {}
        }
        try { await skills.wait(bot, 2500); } catch (e) {}
        try { await skills.pickupNearbyItems(bot); } catch (e) {}
        if (await eat()) return true;
        await appleLeafSweep(40, { stopFood: 10, maxUp: 4, maxReach: 5.05, directReach: 4.8 });
        try { await skills.pickupNearbyItems(bot); } catch (e) {}
        if (await eat()) return true;
        try {
            const base = bot.entity.position.floored();
            const prior = bot._feedUpLastLeafSweep || {};
            bot._feedUpLastLeafSweep = {
                ...prior,
                at: Date.now(),
                base: { x: base.x, y: base.y, z: base.z },
                decayKick: true,
                decayTarget: { name: logBlock.name, x: logBlock.position.x, y: logBlock.position.y, z: logBlock.position.z },
                reachable: prior.reachable || 0,
                broken: prior.broken || 0,
                failed: prior.failed || 0,
                maxUp: 4,
                maxReach: 5.05,
                directReach: 4.8,
                nearest: prior.nearest || null,
            };
        } catch (e) {}
        return false;
    };
    const controlledOakTunnel = async (oak, label = 'oak') => {
        if (!oak || !oak.position || edibleHeld() || isNight() || hostileNear(8)) return false;
        const starvingNoRegen = bot.health <= 8 && bot.food >= 3 && bot.food < 4;
        if (bot.health < 7 || bot.food < (starvingNoRegen ? 3 : 4)) return false;
        if (starvingNoRegen && hostileNear(10)) return false;
        const hasPick = () => bot.inventory.items().some(it => /_pickaxe$/.test(it.name || ''));
        if (!hasPick()) return false;
        const start = bot.entity.position.clone();
        const startDist = oak.position.distanceTo(start);
        const startDy = oak.position.y - start.y;
        const maxDist = starvingNoRegen ? 7.5 : 8.5;
        const maxDy = starvingNoRegen ? 2.5 : 1.5;
        if (startDist > maxDist || Math.abs(startDy) > maxDy) return false;
        const solid = (b) => b && b.boundingBox === 'block';
        const open = (b) => !b || b.boundingBox === 'empty' || /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|dead_bush|snow)$/.test(b.name || '');
        const bad = (b) => b && /bedrock|water|lava|fire|cactus|magma|campfire|berry_bush/.test(b.name || '');
        const blockName = (b) => b ? `${b.name}@${b.position.x},${b.position.y},${b.position.z}` : 'null';
        let attempted = false;
        let dug = 0;
        prog(`feedUp: controlled oak tunnel start ${label} target=${oak.name}@${oak.position.x},${oak.position.y},${oak.position.z} dist=${Math.round(startDist)} dy=${Math.round(startDy)} food=${bot.food} hp=${Math.round(bot.health)} starving=${starvingNoRegen}`);
        motion('feedUp.oak_tunnel.begin', {
            label,
            target: { name: oak.name, x: oak.position.x, y: oak.position.y, z: oak.position.z },
            startDist: +startDist.toFixed(3),
            dy: +startDy.toFixed(3),
            starvingNoRegen,
        });
        for (let step = 0; step < 4; step++) {
            if (edibleHeld() || isNight() || hostileNear(starvingNoRegen ? 10 : 8) || bot.health < 7 || bot.food < (starvingNoRegen ? 3 : 4)) break;
            const sweepReach = starvingNoRegen ? 5.05 : 4.6;
            if (oak.position.distanceTo(bot.entity.position) <= sweepReach) {
                const swept = await appleLeafSweep(56, { stopFood: 17, maxUp: 4, maxReach: sweepReach });
                motion('feedUp.oak_tunnel.sweep', { label, step, swept, dist: +oak.position.distanceTo(bot.entity.position).toFixed(3), maxReach: sweepReach });
                return true;
            }
            const here = bot.entity.position.floored();
            const dx0 = oak.position.x + 0.5 - bot.entity.position.x;
            const dz0 = oak.position.z + 0.5 - bot.entity.position.z;
            const dx = Math.abs(dx0) >= Math.abs(dz0) ? Math.sign(dx0) : 0;
            const dz = dx ? 0 : Math.sign(dz0);
            if (!dx && !dz) break;
            const targetCell = here.offset(dx, 0, dz);
            const foot = bot.blockAt(targetCell);
            const head = bot.blockAt(targetCell.offset(0, 1, 0));
            const floor = bot.blockAt(targetCell.offset(0, -1, 0));
            if (bad(foot) || bad(head) || bad(floor) || !solid(floor)) {
                motion('feedUp.oak_tunnel.stop', {
                    label,
                    step,
                    reason: bad(foot) || bad(head) || bad(floor) ? 'hazard' : 'no-floor',
                    targetCell: { x: targetCell.x, y: targetCell.y, z: targetCell.z },
                    foot: blockName(foot),
                    head: blockName(head),
                    floor: blockName(floor),
                    starvingNoRegen,
                });
                break;
            }
            for (const b of [foot, head]) {
                if (!b || open(b)) continue;
                if (!solid(b) || bad(b)) return attempted;
                const stony = /stone|deepslate|andesite|diorite|granite|tuff|_ore$|obsidian|cobble/.test(b.name || '');
                if (stony && !hasPick()) return attempted;
                attempted = true;
                motion('feedUp.oak_tunnel.dig.begin', {
                    label,
                    step,
                    targetCell: { x: targetCell.x, y: targetCell.y, z: targetCell.z },
                    block: blockName(b),
                    starvingNoRegen,
                });
                try {
                    await skills.breakBlockAt(bot, b.position.x, b.position.y, b.position.z);
                    dug++;
                    motion('feedUp.oak_tunnel.dig.end', { label, step, ok: true, block: blockName(b), dug });
                } catch (e) {
                    motion('feedUp.oak_tunnel.dig.end', { label, step, ok: false, block: blockName(b), error: e.message, dug });
                    return attempted;
                }
            }
            const before = bot.entity.position.clone();
            const inTargetCell = () => {
                const p = bot.entity.position;
                return Math.floor(p.x) === targetCell.x && Math.floor(p.z) === targetCell.z
                    && Math.hypot(p.x - (targetCell.x + 0.5), p.z - (targetCell.z + 0.5)) <= 0.92;
            };
            let pathOk = false;
            try { pathOk = await safeRoamTo(targetCell.x, targetCell.y, targetCell.z, 1, 'oak-tunnel-step', { timeoutMs: 2600 }); } catch (e) {}
            let moved = inTargetCell() || bot.entity.position.distanceTo(before) > 0.45;
            if (pathOk && !moved) {
                motion('feedUp.oak_tunnel.step.edge_miss', {
                    label,
                    step,
                    targetCell: { x: targetCell.x, y: targetCell.y, z: targetCell.z },
                    from: { x: +before.x.toFixed(3), y: +before.y.toFixed(3), z: +before.z.toFixed(3) },
                    to: motionPos(),
                    pathOk,
                    targetDist: +Math.hypot(bot.entity.position.x - (targetCell.x + 0.5), bot.entity.position.z - (targetCell.z + 0.5)).toFixed(3),
                });
            }
            if (!moved) {
                try {
                    try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
                    try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (_) {}
                    bot._bodyMoveLockOwner = 'feedUp:oak-tunnel-step';
                    bot._bodyMoveLockUntil = Date.now() + 2200;
                    await bot.lookAt(targetCell.offset(0.5, 1.1, 0.5), true);
                    bot.setControlState('sprint', false);
                    bot.setControlState('sneak', false);
                    bot.setControlState('jump', false);
                    bot.setControlState('forward', true);
                    motion('feedUp.oak_tunnel.press.begin', {
                        label,
                        step,
                        targetCell: { x: targetCell.x, y: targetCell.y, z: targetCell.z },
                        from: motionPos(),
                        targetDist: +Math.hypot(bot.entity.position.x - (targetCell.x + 0.5), bot.entity.position.z - (targetCell.z + 0.5)).toFixed(3),
                    });
                    const pressUntil = Date.now() + 1500;
                    while (Date.now() < pressUntil && !inTargetCell()) await skills.wait(bot, 45);
                    motion('feedUp.oak_tunnel.press.end', {
                        label,
                        step,
                        targetCell: { x: targetCell.x, y: targetCell.y, z: targetCell.z },
                        ok: inTargetCell(),
                        to: motionPos(),
                        targetDist: +Math.hypot(bot.entity.position.x - (targetCell.x + 0.5), bot.entity.position.z - (targetCell.z + 0.5)).toFixed(3),
                    });
                } finally {
                    try { bot.clearControlStates(); } catch (e) {}
                    if (bot._bodyMoveLockOwner === 'feedUp:oak-tunnel-step') {
                        bot._bodyMoveLockOwner = null;
                        bot._bodyMoveLockUntil = 0;
                    }
                }
                moved = inTargetCell() || bot.entity.position.distanceTo(before) > 0.45;
            }
            attempted = attempted || moved;
            motion('feedUp.oak_tunnel.step.end', {
                label,
                step,
                moved,
                targetCell: { x: targetCell.x, y: targetCell.y, z: targetCell.z },
                from: { x: +before.x.toFixed(3), y: +before.y.toFixed(3), z: +before.z.toFixed(3) },
                to: motionPos(),
                oakDist: +oak.position.distanceTo(bot.entity.position).toFixed(3),
                dug,
            });
            if (!moved) break;
        }
        const finalSweepReach = starvingNoRegen ? 5.05 : 4.8;
        if (oak.position.distanceTo(bot.entity.position) <= finalSweepReach) {
            await appleLeafSweep(56, { stopFood: 17, maxUp: 4, maxReach: finalSweepReach });
            return true;
        }
        prog(`feedUp: controlled oak tunnel end ${label} attempted=${attempted} dug=${dug} dist=${Math.round(oak.position.distanceTo(bot.entity.position))} food=${bot.food} hp=${Math.round(bot.health)}`);
        motion('feedUp.oak_tunnel.end', {
            label,
            attempted,
            dug,
                target: { name: oak.name, x: oak.position.x, y: oak.position.y, z: oak.position.z },
                dist: +oak.position.distanceTo(bot.entity.position).toFixed(3),
                starvingNoRegen,
        });
        return attempted;
    };

    // 失败目标拉黑 (空挥根治三件套之三): attackEntity 对不可达目标现在会快速返回 false,
    // 但循环若重选同一只,10次×超时窗=几分钟连续空挥(用户实拍场景)。拉黑已失败的实体id。
    const failedIds = new Set();
    const foodScan = () => {
        const nearEnt = (label, pred, range) => {
            try {
                const e = world.getNearestEntityWhere(bot, pred, range);
                if (!e || !e.position) return `${label}=none`;
                const name = e.name === 'item' ? droppedItemName(e) : (e.name || e.displayName || 'entity');
                return `${label}=${name}@${Math.round(e.position.distanceTo(bot.entity.position))}`;
            } catch (e) { return `${label}=err`; }
        };
        const nearBlock = (label, name, range) => {
            try {
                const b = world.getNearestBlock(bot, name, range);
                if (!b || !b.position) return `${label}=none`;
                return `${label}=${name}@${Math.round(b.position.distanceTo(bot.entity.position))}`;
            } catch (e) { return `${label}=err`; }
        };
        return [
            nearEnt('animal64', e => mc.isHuntable(e) && !failedIds.has(e.id), 64),
            nearEnt('fish32', e => /cod|salmon/i.test((e && (e.name || e.displayName)) || ''), 32),
            nearEnt('drop32', e => e && e.name === 'item', 32),
            // ★(0714) foodScan 是诊断字符串(仅 prog 日志), 128 同步扫穿会阻塞 ws 且不值得 → 64 同步(比原48大,安全); 真128须异步化留优化
            nearBlock('melon64', 'melon', 64),
            nearBlock('berry64', 'sweet_berry_bush', 64),
            nearBlock('oak64', 'oak_log', 64),
            nearBlock('oakLeaf16', 'oak_leaves', 16),
        ].join(' ');
    };
    const markDryNoFood = (reason) => {
        try {
            if (edibleHeld()) return;
            const p = bot.entity.position.floored();
            const ttl = bot.food <= 5 ? 90000 : 60000;
            const until = Date.now() + ttl;
            const scan = foodScan();
            bot._feedUpDryNoFoodUntil = until;
            bot._feedUpDryNoFood = {
                at: Date.now(),
                until,
                reason,
                x: p.x,
                y: p.y,
                z: p.z,
                food: bot.food,
                hp: Math.round(bot.health),
                scan,
            };
            prog(`feedUp: dry no-food cooldown ${Math.ceil(ttl / 1000)}s reason=${reason} food=${bot.food} hp=${Math.round(bot.health)} scan=${scan}`);
        } catch (e) {}
    };
    const criticalRescueAnimal = async () => {
        if (bot.health > 6 || isNight() || hostileNear(12)) return false;
        const animal = world.getNearestEntityWhere(bot, e => mc.isHuntable(e) && !failedIds.has(e.id), 64);
        if (!animal || !animal.position) return false;
        const dist = animal.position.distanceTo(bot.entity.position);
        prog(`feedUp: critical rescue animal ${animal.name || animal.displayName || 'animal'} dist=${Math.round(dist)} hp=${Math.round(bot.health)} food=${bot.food}`);
        if (!(await safeRoamTo(animal.position.x, animal.position.y, animal.position.z, 3, 'critical-animal'))) {
            failedIds.add(animal.id);
            return false;
        }
        let killed = false;
        try { killed = await skills.attackEntity(bot, animal); } catch (e) {}
        if (!killed) failedIds.add(animal.id);
        try { await skills.pickupNearbyItems(bot); } catch (e) {}
        return await eat();
    };
    const criticalRescueFish = async () => {
        if (bot.health > 6 || isNight() || hostileNear(12)) return false;
        if (Date.now() < (bot._feedUpCriticalFishCooldownUntil || 0)) return false;
        const fish = world.getNearestEntityWhere(bot, e => /cod|salmon/i.test((e && (e.name || e.displayName)) || ''), 32);
        if (!fish || !fish.position) return false;
        const dist = fish.position.distanceTo(bot.entity.position);
        const dy = Math.abs(fish.position.y - bot.entity.position.y);
        if (dy > 7) {
            prog(`feedUp: critical fish skip ${fish.name || fish.displayName || 'fish'} dist=${Math.round(dist)} dy=${Math.round(dy)} — too deep for hp=${Math.round(bot.health)}`);
            bot._feedUpCriticalFishCooldownUntil = Date.now() + 30000;
            return false;
        }
        prog(`feedUp: critical rescue fish ${fish.name || fish.displayName || 'fish'} dist=${Math.round(dist)} hp=${Math.round(bot.health)} food=${bot.food}`);
        if (!(await safeRoamTo(fish.position.x, fish.position.y, fish.position.z, 4, 'critical-fish'))) {
            bot._feedUpCriticalFishCooldownUntil = Date.now() + 60000;
            return false;
        }
        try { await skills.attackEntity(bot, fish); } catch (e) {}
        try { await skills.pickupNearbyItems(bot); } catch (e) {}
        return await eat();
    };
    const criticalOakAppleForage = async () => {
        if (bot.health > 6 || bot.food > 2 || isNight() || hostileNear(10)) return false;
        if (Date.now() < (bot._feedUpCriticalOakCooldownUntil || 0)) return false;
        let oak = null;
        try {
            for (const name of ['oak_leaves', 'dark_oak_leaves']) {
                const b = await world.getNearestBlockAsync(bot, name, 18);
                if (!b || !b.position) continue;
                if (!oak || b.position.distanceTo(bot.entity.position) < oak.position.distanceTo(bot.entity.position)) oak = b;
            }
            for (const name of oak ? [] : ['oak_log', 'dark_oak_log']) {
                const b = await world.getNearestBlockAsync(bot, name, 18);
                if (!b || !b.position) continue;
                if (!oak || b.position.distanceTo(bot.entity.position) < oak.position.distanceTo(bot.entity.position)) oak = b;
            }
        } catch (e) {}
        if (!oak || !oak.position) return false;
        const dist = oak.position.distanceTo(bot.entity.position);
        const dy = Math.abs(oak.position.y - bot.entity.position.y);
        if (dist > 18 || dy > 8) return false;
        bot._feedUpCriticalOakCooldownUntil = Date.now() + 45000;
        prog(`feedUp: critical oak forage ${oak.name}@${Math.round(dist)} dy=${Math.round(dy)} hp=${Math.round(bot.health)} food=${bot.food}`);
        if (dist > 5) {
            if (!(await safeRoamTo(oak.position.x, bot.entity.position.y, oak.position.z, 4, 'critical-oak'))) return false;
        }
        if (await appleLeafSweep(40)) return true;
        try { await skills.pickupNearbyItems(bot); } catch (e) {}
        if (await eat()) return true;
        prog(`feedUp: critical oak forage approached, no apple yet; next loop can local PlanD`);
        return true;
    };
    const targetedOakAppleForage = async () => {
        const noRegenOakPulse = bot.health <= 8 && bot.food < targetFood && !edibleHeld();
        if ((!noRegenOakPulse && bot.food > 10) || edibleHeld() || isNight() || (noRegenOakPulse && isDusk()) || hostileNear(10)) return false;
        if (Date.now() < (bot._feedUpTargetedOakCooldownUntil || 0)) return false;
        let oak = null;
        try {
            for (const name of ['oak_leaves', 'dark_oak_leaves']) {
                const b = await world.getNearestBlockAsync(bot, name, 18);
                if (!b || !b.position) continue;
                if (!oak || b.position.distanceTo(bot.entity.position) < oak.position.distanceTo(bot.entity.position)) oak = b;
            }
            for (const name of oak ? [] : ['oak_log', 'dark_oak_log']) {
                const b = await world.getNearestBlockAsync(bot, name, 18);
                if (!b || !b.position) continue;
                if (!oak || b.position.distanceTo(bot.entity.position) < oak.position.distanceTo(bot.entity.position)) oak = b;
            }
        } catch (e) {}
        if (!oak || !oak.position) return false;
        const dist = oak.position.distanceTo(bot.entity.position);
        const dy = Math.abs(oak.position.y - bot.entity.position.y);
        if (dist > 18 || dy > 8) return false;
        if (noRegenOakPulse && (dist > 12 || dy > 6)) return false;
        if (bot.health <= 12 && bot.food <= 10 && !edibleHeld() && dy > 3) {
            prog(`feedUp: targeted oak forage skip high tree dy=${Math.round(dy)} at food=${bot.food} hp=${Math.round(bot.health)} — no edible/no regen, avoid stair-edge climb`);
            bot._feedUpTargetedOakCooldownUntil = Date.now() + 90000;
            return false;
        }
        const cooldownMs = noRegenOakPulse ? 90000 : (bot.food <= 2 ? 10000 : 45000);
        bot._feedUpTargetedOakCooldownUntil = Date.now() + cooldownMs;
        const sweepStopFood = noRegenOakPulse ? 17 : 10;
        const rememberOakApproachFailed = (reason, nowDist) => {
            try {
                const base = bot.entity.position.floored();
                bot._feedUpLastLeafSweep = {
                    at: Date.now(),
                    base: { x: base.x, y: base.y, z: base.z },
                    reachable: 0,
                    broken: 0,
                    maxUp: noRegenOakPulse ? 4 : 3,
                    nearest: { name: oak.name, x: oak.position.x, y: oak.position.y, z: oak.position.z, dist: nowDist, dy: oak.position.y - bot.entity.position.y },
                    approachFailed: true,
                    reason,
                };
                motion('feedUp.oak_approach.failed', {
                    reason,
                    target: { name: oak.name, x: oak.position.x, y: oak.position.y, z: oak.position.z },
                    nowDist: +nowDist.toFixed(3),
                    noRegen: noRegenOakPulse,
                });
            } catch (e) {}
        };
        prog(`feedUp: targeted oak forage ${oak.name}@${Math.round(dist)} dy=${Math.round(dy)} food=${bot.food} hp=${Math.round(bot.health)} noRegen=${noRegenOakPulse}`);
        if (dist > 5) {
            if (!(await safeRoamTo(oak.position.x, bot.entity.position.y, oak.position.z, 4, 'targeted-oak'))) {
                if (bot.food <= 2 && await emergencyLeafApproach('targeted-oak')) return true;
                const nowDist = oak.position.distanceTo(bot.entity.position);
                if (noRegenOakPulse && nowDist <= 8.5 && await controlledOakTunnel(oak, 'targeted-oak')) return true;
                if (nowDist > 6) {
                    rememberOakApproachFailed('safe-roam-no-progress', nowDist);
                    prog(`feedUp: targeted oak forage failed to approach nowDist=${Math.round(nowDist)}; cooldown=${Math.round(cooldownMs / 1000)}s`);
                    return false;
                }
                prog(`feedUp: targeted oak forage partial approach nowDist=${Math.round(nowDist)}; try local harvest`);
            }
        }
        if (await appleLeafSweep(40, { stopFood: sweepStopFood, maxUp: noRegenOakPulse ? 4 : 3, maxReach: noRegenOakPulse ? 5.05 : 4.5 })) return true;
        if (noRegenOakPulse) {
            const s = bot._feedUpLastLeafSweep && Date.now() - bot._feedUpLastLeafSweep.at < 10000 ? bot._feedUpLastLeafSweep : null;
            const detail = s ? ` reachable=${s.reachable} broken=${s.broken}` : '';
            if (bot.food <= 2 && await localOakDecayKick('targeted-oak')) return true;
            prog(`feedUp: targeted oak forage no-regen pulse stops after bounded leaf sweep${detail} food=${bot.food} hp=${Math.round(bot.health)} — no chop/climb`);
            return false;
        }
        if (bot.health <= 10 && bot.food <= 10 && !edibleHeld()) {
            prog(`feedUp: targeted oak forage skip local chop at no-regen floor food=${bot.food} hp=${Math.round(bot.health)} — leaves swept, avoid non-food climb/chop`);
            return false;
        }
        if (bot.food <= 6 && !edibleHeld()) {
            prog(`feedUp: targeted oak forage skip local chop at low-food floor food=${bot.food} hp=${Math.round(bot.health)} — leaves swept/emergency tried, no edible`);
            return false;
        }
        try {
            prog(`feedUp: targeted oak forage local chop/sweep food=${bot.food} hp=${Math.round(bot.health)}`);
            await Promise.race([
                skills.customSkill(bot, 'chopWood', 1, { allowCriticalForage: true, criticalForageLocalOnly: true }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('targeted-oak-timeout')), 18000)),
            ]);
        } catch (e) {
            prog(`feedUp: targeted oak forage local chop stop: ${e.message}`);
            try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
            try { bot.clearControlStates(); } catch (_) {}
        }
        try { await skills.wait(bot, 1200); } catch (e) {}
        try { await skills.pickupNearbyItems(bot); } catch (e) {}
        if (await eat()) return true;
        if (await appleLeafSweep(40, { stopFood: sweepStopFood })) return true;
        prog(`feedUp: targeted oak forage no apple; cooldown=45s`);
        return true;
    };
    let tries = 0;
    const failedDropIds = new Set();
    prog(`feedUp: START target=${targetFood} food=${bot.food} hp=${Math.round(bot.health)} pos=${Math.round(bot.entity.position.x)},${Math.round(bot.entity.position.y)},${Math.round(bot.entity.position.z)}`);
    const foodAtEntry = bot.food;   // ★kernel return contract: progress = food gained THIS dispatch
    const RATION_RE2 = /^(cooked_\w+|bread|apple|baked_potato|carrot|beef|porkchop|mutton)$/;
    const rationsCount = () => { try { return bot.inventory.items().filter(i => RATION_RE2.test(i.name)).reduce((s, i) => s + i.count, 0); } catch (e) { return 0; } };
    const rationsAtEntry = rationsCount();
    let surfaceTriedThisRun = false; // ★famine surface-first: at most one climb per dispatch
    let emergencyEatVoidStrikes = 0; // ★EAT-VOID: 本次派发内紧急档连续无差进食计数(3 次停打转)
    // ★ration-hunt entry (the last link 11:11Z: GET_FOOD proposes on rations<2 at FULL
    // hunger, but this loop keyed on hunger alone — the body never ran, feedUp honestly
    // returned false, and the takeaway buffer could never fill. Hunt also when carrying
    // fewer than 2 rations; every in-loop guard (night, hostiles, hp) applies unchanged.)
    while ((bot.food < targetFood || bot.health < 18 || rationsCount() < 2) && tries++ < 10) {
        if (bot.interrupt_code) { try { bot.interrupt_code = false; } catch (e) {} }
        // Low HP alone must NOT block hunting: passive animals (cow/sheep/chicken) can't
        // fight back, and at food=0 hunting is the ONLY path back to regen — a blanket
        // hp<8 bail locked a daytime hp3 bot at no-regen forever. Bail only when low HP
        // is COMBINED with an actual threat nearby (that's the hunt-into-death case).
        // ★C310 (T-0047): ALWAYS eat held food FIRST — it's safe, in-place, and the ONLY
        // path back to natural regen. The critical guard below used to `break` BEFORE this
        // line, so a bot at hp<8 with 14 cooked_beef in the bag + a NON-actionable hostile
        // 9.3b away (can't even reach it) starved FROZEN at hp4 forever (live 20:13 用户实拍
        // "原地不动"). Eating ≈1.6s in place can't be punished by a mob that can't reach you;
        // food→18 unlocks natural regen, which unfreezes everything (fight/flee/migrate were
        // ALL hp-gated). The guard now only gates the ROAM/HUNT path below — the actual
        // hunt-into-death case it was written for.
        if (await eat()) { await skills.wait(bot, 1200); continue; }
        // ★deadlock relaxation (live 2026-07-02 08:53: hp4/food7 at y=-29, ENCLOSED, nearest
        // skeleton 25b away through solid stone — hostileNear(16)... registered SOMETHING and
        // this hard-break fired before famine surface-first could climb, so 'low hp needs
        // food' × 'food errands blocked at low hp' deadlocked in a sealed pocket forever.
        // A mob that can't PUNCH you (nothing within 8b) can't punish a sealed staircase
        // climb either — only a genuinely close hostile keeps the hard bail.
        if (bot.health < 8 && hostileNear(8)) {
            log(bot, `feedUp: HP critical (${Math.round(bot.health)}) + hostile in punch range + no held food — bailing roam/hunt to survival modes.`);
            prog(`feedUp: critical guard hp=${Math.round(bot.health)} hostile8=true (no held food in bag to eat in place)`);
            break;
        }
        if (bot.health < 8 && hostileNear(16)) {
            prog(`feedUp: hp critical but nothing in punch range (8b) — allowing surface-first/desperation paths, no roam-hunt`);
        }
        // No held food. PlanC short fetch FIRST (低险快进快出,守卫前放行——烧怪掉落
        // 5分钟 despawn,等不起), then the roam guard.
        if (await fetchFoodDrop()) { await eat(); await skills.wait(bot, 600); continue; }
        // ★C350 wheat→bread (checkpoint #21, 22:25Z live deadlock: 26 wheat in the bag while
        // food=10/hp=7 no-regen locked EVERY work gate — no code path anywhere baked wheat.
        // 3 wheat = 1 bread at any table; craftRecipe finds a placed table in reach or places
        // a carried one). Try BEFORE flesh/roam: it's free food already in the bag.
        if (bot.food < 18) {
            const wheatCt = (world.getInventoryCounts(bot).wheat || 0);
            if (wheatCt >= 3) {
                // C350b (22:43Z: first C350 rounds failed 3x — craftArmor had placed the carried
                // table away at 73,59,229 and the bot migrated out of craftRecipe's reach): if no
                // table is at arm's length but one stands within 24b, WALK to it first. A 20s
                // walk for 8 bread is the best trade on the board at food<18.
                try {
                    if (!await world.getNearestBlockAsync(bot, 'crafting_table', 4)) {
                        // 48b: the C350b maiden run had the table at 28b and starved next to it (24b radius miss)
                        const farTable = await world.getNearestBlockAsync(bot, 'crafting_table', 64);
                        if (farTable) {
                            prog(`feedUp: C350b walking to table @${farTable.position.x},${farTable.position.z} (${Math.round(bot.entity.position.distanceTo(farTable.position))}b) to bake ${wheatCt} wheat`);
                            try { await skills.goToPosition(bot, farTable.position.x, farTable.position.y, farTable.position.z, 2); } catch (e) {}
                        }
                    }
                } catch (e) {}
                const breadBefore = world.getInventoryCounts(bot).bread || 0;
                try { await skills.craftRecipe(bot, 'bread', Math.min(Math.floor(wheatCt / 3), 6)); } catch (e) {}
                const baked = (world.getInventoryCounts(bot).bread || 0) - breadBefore;
                if (baked > 0) {
                    prog(`feedUp: C350 baked wheat→bread x${baked} (had ${wheatCt} wheat idle in the bag)`);
                    await eat(); await skills.wait(bot, 400); continue;
                }
            }
        }
        // ★famine flesh (2026-07-02 food-desert live): eat() skips rotten_flesh BY DESIGN, but
        // at food<=6 with nothing better HELD, poison flesh (4 pts, 80% hunger-poison) beats
        // starving the march/dive gates shut. fetchFoodDrop already eats it post-fetch (:459);
        // this covers flesh that entered the bag any other way (kills, earlier pickups).
        if (bot.food <= 6 && !edibleHeld()) {
            const flesh = bot.inventory.items().find(i => i.name === 'rotten_flesh');
            if (flesh) {
                prog(`feedUp: famine flesh — eating rotten_flesh x1 (food=${bot.food}, nothing better held)`);
                // ★EAT-VOID: 吃到(food 真涨)才 continue; void 就落到猎/觅食, 不在死进食窗打转。
                let ate = false;
                try { ate = await skills.consume(bot, 'rotten_flesh'); } catch (e) {}
                if (ate) { await skills.wait(bot, 400); continue; }
                prog(`feedUp: famine flesh eat VOID food=${bot.food} — continue to hunt/forage instead of spinning`);
            }
        }
        // Getting more means roaming to hunt — do NOT do that at night or
        // with a hostile nearby (that's exactly how it walked into a 5-HP death). Bail
        // and let the dive/shelter logic proceed at whatever HP we have.
        // ★C349 (checkpoint #18 handoff #1, 17:16Z live: food 20→5 while GET_FOOD 3-struck
        // every expiry — 2 skeletons at d6-16 kept tripping the default 10b guard in broad
        // DAYLIGHT with iron_sword+shield in hand). Starving beats a distant skeleton:
        // at famine (food<=6, armed, daytime) only a PUNCH-RANGE hostile stops the forage;
        // normal times keep the cautious 10b guard.
        const _famineArmed = bot.food <= 6 && !isNight()
            && bot.inventory.items().some(i => /_sword$/.test(i.name || ''));
        if (isNight() || hostileNear(_famineArmed ? 5 : 10)) {
            log(bot, 'feedUp: night or hostile nearby — not roam-hunting; stopping.');
            prog(`feedUp: guard stop night=${isNight()} hostile=${hostileNear(_famineArmed ? 5 : 10)} famineArmed=${_famineArmed} food=${bot.food} hp=${Math.round(bot.health)}`);
            break;
        }
        const animal = world.getNearestEntityWhere(bot, e => mc.isHuntable(e) && !failedIds.has(e.id), 32);
        if (!animal) {
            prog(`feedUp: no huntable animal within 32 at ${Math.round(bot.entity.position.x)},${Math.round(bot.entity.position.y)},${Math.round(bot.entity.position.z)} food=${bot.food} hp=${Math.round(bot.health)}`);
            if (await localFish()) { await skills.wait(bot, 600); continue; }
            // ★PlanB — no animals (the hp3/food0 all-day famine post-#267: feedUp came back
            // empty 4 times and the bot faced a second starving night). A human forages:
            // 1) MELONS — this is a jungle world, wild melon blocks are the staple here.
            //    Break one → melon slices (regex food, safe).
            // 2) SWEET BERRIES — bush poke, if any.
            // 3) EMERGENCY: at food<=6 eat rotten flesh / raw meat we're carrying (80%
            //    hunger-effect, ~zero real danger — the classic famine food).
            let foraged = false;
            try {
                const melon = await world.getNearestBlockAsync(bot, 'melon', 64);
                if (melon) {
                    log(bot, 'feedUp: no animals — foraging a wild melon');
                    try { foraged = await skills.collectBlock(bot, 'melon', 1); } catch (e) {}
                    if (foraged) { await eat(); await skills.wait(bot, 600); continue; }
                }
            } catch (e) {}
            try {
                // ★C268: pursuit range (was 32) must cover the SCAN range (berry48=48) or the bot
                // freezes — confirmed food-strand livelock (07:28 @10,81 food4 hp13): scan reported
                // sweet_berry_bush@44 but the 32-range pursuit returned null → "no long roam without
                // a target" → calorie-floor stop → frozen 14s+ with KNOWN food 44b away. The
                // calorie-floor fear (ping-ponging with NO target) does NOT apply when a concrete
                // bush is known: a hungry bot MUST spend pips reaching the only food (daytime/Easy =
                // safe). Widen to 56 when hungry (covers the 48 scan + margin). handoff §8 / memory
                // food-desert-spawn-deadlock.
                const bush = await world.getNearestBlockAsync(bot, 'sweet_berry_bush', 64);
                if (bush) {
                    log(bot, `feedUp: foraging sweet berries @${Math.round(bush.position.distanceTo(bot.entity.position))}b`);
                    try { await skills.goToPosition(bot, bush.position.x, bush.position.y, bush.position.z, 1); await bot.activateBlock(bush); foraged = true; } catch (e) {}
                    if (foraged) { await eat(); await skills.wait(bot, 600); continue; }
                }
            } catch (e) {}
            if (bot.food <= 6) {
                const junk = bot.inventory.items().find(i => /rotten_flesh|^beef$|^porkchop$|^chicken$|^mutton$|^rabbit$|^cod$|^salmon$/.test(i.name));
                // ★EAT-VOID 呼应修 (13:57-14:01 实录: 本分支连报 'eating mutton (emergency tier)'
                // 四分钟 food 恒=6): 旧代码丢弃 consume 的返回值无条件 continue — void 进食
                // (反射偷走 1.6s 进食窗)在这里打转到派发耗尽。现在消费诚实布尔: 吃到才
                // continue; 连续 3 次 void 就不再选这条分支, 放行后续拾取/觅食/roam Plan。
                if (junk && emergencyEatVoidStrikes < 3) {
                    log(bot, `feedUp: famine — eating ${junk.name} (emergency tier)`);
                    let ate = false;
                    try { ate = await skills.consume(bot, junk.name); } catch (e) {}
                    if (ate) { emergencyEatVoidStrikes = 0; await skills.wait(bot, 600); continue; }
                    emergencyEatVoidStrikes++;
                    prog(`feedUp: emergency tier eat VOID x${emergencyEatVoidStrikes} (${junk.name}) food=${bot.food} — fall through to fetch/forage plans`);
                }
            }
            if (await emergencyJunk('no-regen inventory')) continue;
            // ★PlanC — 捡地表食物掉落物 (hp6/food0 死水局: 这片破碎崖壁无动物无瓜无浆果,
            // PlanA/B 全空,食物死结锁死作业线(hp≤6 危殆bail)。但白天阳光烧怪,腐肉/鸡肉
            // 散落地表——白送的紧急口粮,人类必捡。找 24格内 item 实体里名字匹配食物的,
            // 走过去捡(pickupNearbyItems),交给上面的紧急档吃掉。)
            try {
                const drop = world.getNearestEntityWhere(bot, e =>
                    e && e.name === 'item' && !failedDropIds.has(e.id) && isFoodDrop(e), 24);
                if (drop && drop.position) {
                    const dist = drop.position.distanceTo(bot.entity.position);
                    log(bot, `feedUp: PlanC — food drop ${droppedItemName(drop)} spotted ${Math.round(dist)}b away, fetching`);
                    if (hostileNear(6) && dist > 2.2) {
                        prog(`feedUp: PlanC food-drop skip ${droppedItemName(drop)}@${Math.round(dist)} close hostile`);
                        failedDropIds.add(drop.id);
                        continue;
                    }
                    if (dist > 1.6 && !(await safeRoamTo(drop.position.x, drop.position.y, drop.position.z, 2, 'food-drop'))) {
                        failedDropIds.add(drop.id);
                        prog(`feedUp: PlanC food-drop blacklist id=${drop.id || 'unknown'} after failed approach`);
                        continue;
                    }
                    try { await skills.pickupNearbyItems(bot); } catch (e) {}
                    prog(`feedUp: PlanC food-drop pickup attempted ${droppedItemName(drop)}@${Math.round(dist)} drops=${nearbyDropsSummary(4)}`);
                    await eat();
                    if (bot.food <= 6) {
                        const junk2 = bot.inventory.items().find(i => /rotten_flesh|^beef$|^porkchop$|^chicken$/.test(i.name));
                        if (junk2) { try { await skills.consume(bot, junk2.name); } catch (e) {} }
                    }
                    await emergencyJunk('food-drop pickup');
                    await skills.wait(bot, 600); continue;
                }
            } catch (e) {}
            if (bot.food <= 6 && !edibleHeld()) {
                if (await desperationRoam({ concreteOnly: true })) { await skills.wait(bot, 600); continue; }
            }
            // PlanD — oak/apple famine fallback. In animal-free hills, a human
            // punches nearby oak leaves/logs and sweeps drops; low apple odds are
            // still better than burning the last hunger points ping-pong roaming.
            // Only do it in daylight with no close threat, and timebox hard.
            if (bot.food <= 2 && !isNight() && !hostileNear(10)) {
                const hasOak = bot.health <= 8 ? localOakLike(10, 10.5) : ['oak_log', 'oak_leaves', 'dark_oak_log', 'dark_oak_leaves'].some(n => {
                    try { return !!world.getNearestBlock(bot, n, 36); } catch (e) { return false; }
                });
                if (hasOak) {
                    prog(`feedUp: PlanD apple forage — no animals/forage/drops, leaf sweep first at food=${bot.food} hp=${Math.round(bot.health)}`);
                    if (await appleLeafSweep(48, { stopFood: 10, maxUp: 4, maxReach: 5.05, directReach: 4.8 })) {
                        await skills.wait(bot, 600);
                        if (bot.food >= 4 && !edibleHeld()) {
                            prog(`feedUp: PlanD leaf sweep got emergency food=${bot.food}; preserve it, stop roam`);
                            break;
                        }
                        continue;
                    }
                    try { await skills.pickupNearbyItems(bot); } catch (e) {}
                    if (await eat()) {
                        await skills.wait(bot, 600);
                        if (bot.food >= 4 && !edibleHeld()) {
                            prog(`feedUp: PlanD got emergency food=${bot.food}; preserve it, stop roam`);
                            break;
                        }
                        continue;
                    }
                    if (bot.food <= 2 && !edibleHeld()) {
                        if (await emergencyLeafApproach('PlanD')) {
                            await skills.wait(bot, 600);
                            continue;
                        }
                        if (await localOakDecayKick('PlanD')) {
                            await skills.wait(bot, 600);
                            continue;
                        }
                        prog(`feedUp: PlanD skip oak chop at calorie floor food=${bot.food} hp=${Math.round(bot.health)} — no edible after leaf sweep`);
                    } else {
                        prog(`feedUp: PlanD apple forage — try one oak chop at food=${bot.food} hp=${Math.round(bot.health)}`);
                        try {
                            await Promise.race([
                                skills.customSkill(bot, 'chopWood', 1, { allowCriticalForage: true, criticalForageLocalOnly: true }),
                                new Promise((_, rej) => setTimeout(() => rej(new Error('apple-forage-timeout')), 22000)),
                            ]);
                        } catch (e) {
                            prog(`feedUp: PlanD apple forage stop: ${e.message}`);
                            try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
                            try { bot.clearControlStates(); } catch (_) {}
                        }
                        try { await skills.wait(bot, 2200); } catch (e) {}
                        try { await skills.pickupNearbyItems(bot); } catch (e) {}
                        if (await eat()) { await skills.wait(bot, 600); continue; }
                    }
                    const apple = bot.inventory.items().find(i => /apple/.test(i.name || ''));
                    if (apple) {
                        // ★EAT-VOID: 同紧急档 — 吃到才 continue, void 落到 targetedOakAppleForage。
                        let ate = false;
                        try { ate = await skills.consume(bot, apple.name); } catch (e) {}
                        if (ate) { await skills.wait(bot, 600); continue; }
                    }
                }
            }
            if (await targetedOakAppleForage()) { await skills.wait(bot, 600); continue; }
            if (bot.health <= 8) {
                prog(`feedUp: food_scan ${foodScan()} pos=${Math.round(bot.entity.position.x)},${Math.round(bot.entity.position.y)},${Math.round(bot.entity.position.z)} hp=${Math.round(bot.health)} food=${bot.food}`);
                if (await criticalRescueAnimal()) { await skills.wait(bot, 600); continue; }
                if (await criticalRescueFish()) { await skills.wait(bot, 600); continue; }
                if (await criticalOakAppleForage()) { await skills.wait(bot, 600); continue; }
                if (bot.food <= 1 && !edibleHeld() && await desperationRoam({ concreteOnly: true })) { await skills.wait(bot, 600); continue; }
                if (await criticalMicroScout()) { await skills.wait(bot, 600); continue; }
                // ★critical-branch surface-first (live 2026-07-02 08:59: hp4/food7 sealed at
                // y=-29 — the guard relaxation let dispatches REACH this branch, but every
                // local probe is dry 90 blocks below daylight and this break fired before the
                // main-flow surface-first could ever run at hp<=8. Same rule as below: one
                // sealed-staircase climb per dispatch when nothing is in punch range.)
                if (!surfaceTriedThisRun && bot.entity.position.y < 60 && !hostileNear(8)) {
                    surfaceTriedThisRun = true;
                    prog(`feedUp: critical surface-first — hp=${Math.round(bot.health)} food=${bot.food} y=${Math.round(bot.entity.position.y)}, climbing to daylight food`);
                    let up = false;
                    try { up = await skills.customSkill(bot, 'surfaceUp', 63); } catch (e) { prog(`feedUp: surfaceUp threw ${e && e.message || e}`); }
                    if (bot.interrupt_code || bot.health <= 0) break;
                    if (up || bot.entity.position.y >= 60) { await skills.wait(bot, 400); continue; }
                }
                prog(`feedUp: critical local-only stop hp=${Math.round(bot.health)} food=${bot.food} — no long roam`);
                break;
            }
            // ★famine surface-first (live 2026-07-02 01:54: food=0 hp=10 FAMINE freeze @y47):
            // every local probe is dry UNDERGROUND while the only food (animals/berries) lives
            // on the surface — desperationRoam skips it as dy-too-costly and the old code just
            // stopped here, freezing the body at food=0 with GET_FOOD cooldown-suppressed.
            // Surfacing IS the food move: one surfaceUp (the hardened sealed-staircase climb)
            // per dispatch, then rescan from daylight. FORAGE_SURFACE has no proposer push, so
            // nothing above this layer owns the climb.
            if (!surfaceTriedThisRun && bot.food <= 11 && bot.entity.position.y < 60 && !hostileNear(8)) {
                surfaceTriedThisRun = true;
                prog(`feedUp: famine surface-first — underground y=${Math.round(bot.entity.position.y)} with dry local scan, climbing before giving up`);
                let up = false;
                try { up = await skills.customSkill(bot, 'surfaceUp', 63); } catch (e) { prog(`feedUp: surfaceUp threw ${e && e.message || e}`); }
                if (bot.interrupt_code || bot.health <= 0) break;
                if (up || bot.entity.position.y >= 60) { await skills.wait(bot, 400); continue; }   // rescan from the surface
            }
            if (bot.food <= 6 && !edibleHeld()) {
                // Calorie floor: a 24-block "maybe food elsewhere" relocate costs the
                // last hunger pips and repeatedly ping-ponged across the same ridge.
                // If no concrete animal/forage/drop target survived the local probes
                // above, stop and let shelter/tooling logic own the body.
                if (await desperationRoam({ concreteOnly: true })) { await skills.wait(bot, 600); continue; }
                markDryNoFood('calorie-floor');
                prog(`feedUp: calorie-floor stop food=${bot.food} hp=${Math.round(bot.health)} scan=${foodScan()} — no long roam without a target`);
                break;
            }
            if (await desperationRoam()) { await skills.wait(bot, 600); continue; }
            log(bot, 'feedUp: no animals, no forage, no drops, nothing edible held — cannot get food here');
            markDryNoFood('no-food-source');
            prog(`feedUp: no food source found, stop food=${bot.food} hp=${Math.round(bot.health)}`);
            break;
        }
        prog(`feedUp: hunting ${animal.name || animal.displayName || 'animal'} dist=${Math.round(animal.position.distanceTo(bot.entity.position))}`);
        let killed = false;
        try { killed = await skills.attackEntity(bot, animal); } catch (e) {}
        if (!killed) failedIds.add(animal.id);   // 够不到/打不死 → 本次调用内不再选它
        try { await skills.pickupNearbyItems(bot); } catch (e) {}
        await eat();
        await skills.wait(bot, 600);
    }
    log(bot, `feedUp done: hp=${Math.round(bot.health)} food=${bot.food}`);
    // ★kernel return contract (live 2026-07-02 01:21 famine spin): the old
    // `|| bot.health >= 18` disjunct made a FULL-HP starving bot return truthy on ZERO
    // food progress, so the kernel's failure counter reset every ~2s and GET_FOOD
    // re-dispatched the identical no-food-reachable run forever (12+ commits/2min live).
    // Truthy = target reached OR food actually gained this dispatch; a dry run returns
    // false so 3 strikes hand GET_FOOD a cooldown and the chain rotates to other work
    // (feedUp's own 60s dry-cooldown + the village/forage kinds own the retry cadence).
    // ★ration-aware return (the no-delta override's FIRST live trigger, 11:06Z, caught this
    // — and the bug was ours: bc8a152 made isGoalDone demand >=2 carried rations, but this
    // return still said food>=target ⇒ truthy, so a full-hunger zero-ration bot with no
    // animals in range returned truthy every ~2s with zero world delta. Progress = hunger
    // gained OR rations gained; the fully-satisfied end state stays truthy so the final
    // successful run never strikes.)
    return (bot.food >= targetFood && rationsCount() >= 2)
        || bot.food > foodAtEntry || rationsCount() > rationsAtEntry;
}
