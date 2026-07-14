// Hot-reloadable TOP-LEVEL EXECUTOR (framework-v2 Stage0). kernelDriver is the new
// sticky skill that becomes the SINGLE dispatch source — it holds the ws_server
// _skillRunning lock and is the only thing that fires child skills. It does NOT
// decide anything: the decision layer (modes.js proposeTasks + world_model
// commitGoal, run every 2s with NO LLM and NO kernel) writes bot._commitment =
// { kind, skill, args, since }, and this driver just translates that commitment
// into a customSkill child dispatch.
//
//   state                                       → action
//   supervisor cancel / interrupt               → reset + return (release the lock)
//   in the nether                               → hold near portal, light netherrack mining
//   obsidian>=10 + flint_and_steel              → realNetherPortal (build + light + walk in)
//   reflex busy (ENTOMBED/POCKET/.../threat)    → short wait, let the instinct layer act first
//   bot._commitment.skill changed               → customSkill(skill, ...args)
//   otherwise                                   → wait, re-poll the commitment
//
// SAFETY: this NEVER re-implements survival reflexes (those live in modes.js instinct
// and run untouched), and it NEVER deletes missionNether (kept as a rollback anchor).
// kernel stays observe-only; nothing here ever calls the LLM.
//
// Invoked via: {"skill":"kernelDriver","args":[]}
// ctx = { skills, world, mc, Vec3, log }
import fs from 'fs';
import path from 'path';
const PROG = path.resolve(process.cwd(), 'bots', '_supervisor', 'progress.txt');
const prog = (s) => { try { fs.appendFileSync(PROG, `[${new Date().toISOString()}] [kernel] ${s}\n`); } catch (e) {} };

export default async function kernelDriver(bot, ctx) {
    const { skills, world } = ctx;
    const has = (n) => { try { return world.getInventoryCounts(bot)[n] || 0; } catch (e) { return 0; } };
    const wait = (ms) => skills.wait(bot, ms);
    const inNether = () => { try { return /nether/.test(bot.game.dimension); } catch (e) { return false; } };

    // Reflex-busy gate: if the ① instinct layer (modes.js) is mid-rescue — a mobility
    // trap (ENTOMBED/POCKET/MAROONED/SEALED/SWIM) or enclosed, or an actionable threat
    // while low on hp — DON'T dispatch a strategic child on top of it. Yield with a short
    // wait so self_preservation / mobility / self_defense can run first, then re-poll.
    // ★T-0101/T-0083 FROZEN-ALIVE 互锁破除 (worker-frozen): 纯饥饿僵局判据——低血纯因 food 见底(<=2)
    //   不回血,且无 LETHAL 环境急症(贴脸 creeper<4.5 / 正在挨打 / hp 极危<=4 / swarm 围殴贴脸)。
    //   此时低血 hold 是死锁不是避险,reflexBusy 必须让位给决策层派 GET_FOOD/villageHarvest 去觅食。
    //   与 world_model.js isFamineStall(w) 同口径(决策层那端已破 HOLD@95 与 villageClose 否决)。
    const famineStall = () => {
        try {
            const w = bot._world; if (!w) return false;
            const t = w.threat || {}, v = w.vitals || {};
            const creeperLethal = Number.isFinite(t.creeperDist) && t.creeperDist < 4.5;
            const swarmPin = (t.actionable || 0) >= 2;   // 用 actionable(可达威胁)非 raw closest(墙外够不到的怪不算 LETHAL)
            const lethal = creeperLethal || !!t.takingDamage || (v.hp ?? bot.health ?? 20) <= 4 || swarmPin;
            const food = (v.food != null) ? v.food : (bot.food != null ? bot.food : 20);
            const hp = (v.hp != null) ? v.hp : (bot.health != null ? bot.health : 20);
            return !lethal && food <= 2 && hp < 10 && !v.canRegen;
        } catch (e) { return false; }
    };
    const reflexBusy = () => {
        try {
            // ★饥饿觅食解锁: 纯饥饿僵局(非 LETHAL)时,绝不让 reflex 门把觅食派发卡死。决策层此刻
            //   committed 到 GET_FOOD/OPENING_VILLAGE(去 village@近 收割/觅食),必须放行去执行,否则
            //   bot 在封箱里饿死(9h 实锤)。觅食 skill 自带 hostileNear/hp gate,不会无脑冲怪堆。
            //   注意 POCKET 等 mobility 门也放行——封箱(enclosed)常被建模为 POCKET,但那不是真被卡死
            //   的窄缝(coverReal 安全),让位只会空等;觅食派发会带 bot 走出去(走出后 POCKET 自然解除)。
            if (famineStall()) return false;
            const m = bot._mobility && bot._mobility.state;
            if (m && /ENTOMBED|POCKET|MAROONED|SEALED|SWIM/.test(String(m))) return true;
            // ★FROZEN-ALIVE FIX (live -24,50,-31 pin ~6min): the passive `enclosed` flag (a ceiling
            // overhead) is NOT a reason to defer — a bot mining/sheltering underground is "enclosed"
            // BY DEFINITION. When mobility has already released to FREE (state not a rescue state)
            // but enclosed is still set, deferring here = deadlock: mobility thinks it's FREE (won't
            // act), kernelDriver yields forever (won't dispatch), bot stands frozen while botwatch
            // STUCK-ZONE-cancels every 5min to no effect. Only the ACTIVE rescue STATES above warrant
            // yielding; once they clear, the strategic layer MUST dispatch (mine/surface out). So the
            // standalone enclosed check is removed.
            const w = bot._world;
            if (w && w.threat && w.threat.actionable && (bot.health || 20) < 10) return true;
        } catch (e) {}
        return false;
    };

    prog('==== kernelDriver START (sticky executor — sole dispatch source) ====');
    let lastSkill = null;
    // ★task-queue Phase C: bot._commitment carries a stable .id (the queue HEAD task id) when
    //   commitQueue runs LIVE (taskqLive). A second dispatch trigger on c.id catches a HEAD swap to a
    //   DIFFERENT task that happens to reuse the SAME skill (two ore veins, two nightShelter modes) —
    //   skill alone wouldn't change so kernelDriver would miss it. In Phase A/B commitGoal writes no
    //   .id (undefined) → these checks are inert (undefined===undefined), fully backward-compatible.
    let lastId = null;
    // ★NO-OP-SPIN ESCAPE state (worker-frozen 0701, T-0110). kernelDriver has no progress check —
    // a committed skill that returns fast doing NOTHING (prepNether no-op when wood unreachable /
    // no wool for GET_BED; mineDown abort near water) is re-dispatched every 1.5s forever = frozen-
    // alive (live 45min @88,66 coastal, oscillating BOOTSTRAP_KIT↔GET_BED, both prepNether no-ops).
    // We anchor pos+inv when a skill first commits and, if the SAME skill churns 90s+ with <8b net
    // move AND no inventory gain AND it's not a legit night-hold / active combat, force ONE migrate
    // (day) / nightShelter-seal (night) to escape the bad spot. Cooldown-gated against thrash. This
    // catches the whole CLASS of no-op spins (any skill), unlike a per-proposal decision-layer fix.
    let noopSkill = null, noopAnchor = null, noopAnchorAt = 0, noopAnchorSig = 0, noopLastEscapeAt = 0;
    // Progress signal = ONLY goal-relevant resources (ore / metal / logs / gems) — NOT dirt/cobble/
    // sand/gravel, which a stuck mineDown scrapes up while churning in place (live: held=dirt, inv
    // 24k→27k creeping, yet ZERO net descent or iron). A total-count sig would false-re-anchor on
    // that junk and the escape would never fire. Re-anchor also on real DESCENT or a >8b horizontal
    // hop (both are genuine progress); digging junk sideways at a bad spot is none of these.
    const noopOreSig = () => { try { const inv = world.getInventoryCounts(bot) || {}; let s = (inv.raw_iron || 0) * 10 + (inv.iron_ore || 0) * 10 + (inv.iron_ingot || 0) * 10 + (inv.diamond || 0) * 30 + (inv.coal || 0) * 2 + (inv.raw_copper || 0) * 2 + (inv.raw_gold || 0) * 5 + (inv.redstone || 0) + (inv.lapis_lazuli || 0); for (const k in inv) if (/_log$/.test(k)) s += (inv[k] || 0) * 4; return s; } catch (e) { return 0; } };
    for (let iter = 0; iter < 5000; iter++) {
        // ★STAGE-GATE HEARTBEAT: stamp that kernelDriver is the LIVE dispatcher. legacy night/dispatch
        // owners (prepNether.nightOwnedByDecisionLayer) check this fresh stamp to decide whether to yield —
        // so they ONLY yield once the cutover is real (kernelDriver actually running as sticky), not the
        // instant bot._world.nightPlan merely exists (true in Stage-0 shadow, before cutover).
        bot._kernelDriverActive = Date.now();
        // ① cancel handshake — release the run_skill lock the moment the supervisor
        //    cancels or an interrupt is posted (mirrors missionNether 353-358).
        if (bot._supervisorCancelAt && Date.now() - bot._supervisorCancelAt < 30000) {
            prog('supervisor cancel received — returning to release run_skill lock');
            try { bot.interrupt_code = false; bot._supervisorCancelAt = 0; } catch (e) {}
            return { cancelled: true };
        }
        if (bot.interrupt_code) { try { bot.interrupt_code = false; } catch (e) {} await wait(2500); }

        // ② in the nether — WIN STATE. Hold near the portal; mine a little netherrack on
        //    a slow cadence so the watchdog's pos+inv STUCK detector stays fed (mirrors
        //    missionNether 1021-1036). Don't wander (ghasts/piglins).
        if (inNether()) {
            try {
                const rack = world.getNearestBlock(bot, 'netherrack', 6);
                if (rack && has('netherrack') < 64) await skills.collectBlock(bot, 'netherrack', 1);
            } catch (e) {}
            await wait(20000);
            continue;
        }

        // ③ kitted for a portal — build + light + walk through (mirrors missionNether
        //    1039-1055). The dedicated realNetherPortal child handles the rest.
        if (has('obsidian') >= 10 && has('flint_and_steel') >= 1) {
            prog(`kitted (obsidian=${has('obsidian')} f&s=${has('flint_and_steel')}) → realNetherPortal`);
            let r = null;
            try { r = await skills.customSkill(bot, 'realNetherPortal'); }
            catch (e) { prog(`realNetherPortal threw: ${e.message}`); }
            if (r && r.entered) { lastSkill = null; continue; }   // next iter detects nether
            await wait(8000);
            lastSkill = null;
            continue;
        }

        // ④ read the commitment the decision layer wrote (modes.js every 2s; now carries
        //    args). Empty → nothing committed yet, wait and re-poll.
        const c = bot._commitment;
        if (!c || !c.skill) { await wait(1500); continue; }

        // Defer to the reflex layer if it's mid-rescue — short wait so ① runs first.
        if (reflexBusy()) { await wait(800); continue; }

        // Dispatch only on a skill change (avoid stomping a still-running child). The
        // commitment's args are forwarded positionally, matching customSkill's
        // (bot, ctx, ...args) child signature — nightShelter needs args like 'dig_one'
        // / 'seal', mineDown needs { targetY: 12 }.
        if (c.skill !== lastSkill || (c.id != null && c.id !== lastId)) {
            lastSkill = c.skill;
            lastId = (c.id != null) ? c.id : null;
            const args = Array.isArray(c.args) ? c.args : (c.args != null ? [c.args] : []);
            const startKind = c.kind;
            const startId = (c.id != null) ? c.id : null;
            prog(`dispatch → ${c.skill} (kind=${c.kind || '?'}${c.id ? ' id=' + c.id : ''}) args=${JSON.stringify(args)}`);
            // ★T-0081 INTERRUPT PATH (was entirely missing): while the child runs, watch the
            // commitment the decision layer keeps re-writing. If it FLIPS to a different kind — a
            // dusk/night plan dethroning a stale daytime task (migrate blocking through dusk), or
            // an emergency HOLD — raise interrupt_code so the child (migrate/mineDown/… all honor
            // it) bails promptly and we re-dispatch the NEW goal, instead of blocking to completion
            // and running the wrong task into the night. The loop-top consumes the interrupt.
            const _watch = setInterval(() => {
                try {
                    const nc = bot._commitment;
                    if (!nc) return;
                    const kindFlip = nc.kind && nc.kind !== startKind;
                    const idFlip = (nc.id != null && startId != null && nc.id !== startId);   // Phase C: head swapped (maybe same skill)
                    if (kindFlip || idFlip) {
                        prog(`commitment flipped ${startKind || '?'}${startId ? '/' + startId : ''}→${nc.kind}${nc.id ? '/' + nc.id : ''} mid-child → interrupt ${c.skill} to re-dispatch`);
                        bot.interrupt_code = true;
                    }
                } catch (e) {}
            }, 1000);
            try {
                await skills.customSkill(bot, c.skill, ...args);
            } catch (e) {
                prog(`child ${c.skill} threw: ${e.message}`);
            } finally {
                clearInterval(_watch);
            }
            // Child returned (done / cancelled / errored) — reset so the same commitment
            // re-dispatches on the next loop, and a changed commitment dispatches fresh.
            lastSkill = null;
            lastId = null;
            // ★NO-OP-SPIN ESCAPE (T-0110): compare this dispatch's outcome to the anchor. Genuine
            // progress — a >8b HORIZONTAL hop, real DESCENT (>4b down toward iron), or an ORE/log
            // gain — re-anchors; a churning no-op (junk-only inv creep, no descent, no relocation)
            // accumulates toward the escape.
            try {
                const p = bot.entity && bot.entity.position;
                if (p) {
                    const sig = noopOreSig();
                    if (noopSkill !== c.skill || !noopAnchor) {
                        noopSkill = c.skill; noopAnchor = { x: p.x, y: p.y, z: p.z }; noopAnchorAt = Date.now(); noopAnchorSig = sig;
                    } else {
                        const horiz = Math.hypot(p.x - noopAnchor.x, p.z - noopAnchor.z);
                        const descended = (noopAnchor.y - p.y) > 4;   // net drop toward iron = real progress
                        if (horiz > 8 || descended || sig > noopAnchorSig) {
                            noopAnchor = { x: p.x, y: p.y, z: p.z }; noopAnchorAt = Date.now(); noopAnchorSig = sig;
                        } else if (Date.now() - noopAnchorAt > 90000 && Date.now() - noopLastEscapeAt > 120000) {
                            const w = bot._world || {};
                            const isDay = !(w.time && w.time.isDay === false);
                            const legitNightHold = !isDay && w.cover && w.cover.coverReal === true && (!w.threat || (w.threat.actionable || 0) === 0);
                            const inCombat = w.threat && ((w.threat.actionable || 0) > 0 || w.threat.takingDamage === true);
                            // ★DEPTH GATE (T-0110 refine — live death: escape fired on a barren branchMine
                            // @y18 → migrate marched UP through terrain → SUFFOCATION @y52 + lost the shaft +
                            // respawned at spawn). At mid/deep the bot is actively mining; a barren branchMine
                            // stretch is NORMAL and migrate would path dangerously upward. Down here mineDown
                            // owns relocation (branchMine stallRounds → returns → GO_UNDERGROUND re-dispatches a
                            // fresh branch). Only escape at/near the surface, where a true no-op-pin (coastal
                            // prepNether / mineDown-can't-descend) needs a horizontal migrate.
                            const db = w.pos && w.pos.depthBand;
                            const deepMining = db === 'mid' || db === 'deep';
                            if (!legitNightHold && !inCombat && !deepMining) {
                                prog(`★NO-OP-SPIN escape: ${c.skill} churned ${Math.round((Date.now() - noopAnchorAt) / 1000)}s (no >8b hop / no descent / no ore) @${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)} → force ${isDay ? 'migrate(escape bad spot)' : 'nightShelter seal'}`);
                                noopLastEscapeAt = Date.now();
                                noopSkill = null; noopAnchor = null;
                                try {
                                    if (isDay) await skills.customSkill(bot, 'migrate', { force: true, maxBlocks: 128, cooldownMin: 0, settleScore: 6 });
                                    else await skills.customSkill(bot, 'nightShelter', 'seal');
                                } catch (e) { prog(`NO-OP-SPIN escape skill threw: ${e.message}`); }
                                await wait(1500);
                                continue;
                            }
                        }
                    }
                }
            } catch (e) {}
            // ★ANTI-HOT-SPIN (live 18:17:30: nightShelter('seal') returns true INSTANTLY when the
            // roof is already covered → this loop re-dispatched it every ~2ms and burned the whole
            // 5000-iter cap in seconds → 'loop exhausted' → bridge respawn churn). Throttle the
            // re-dispatch: for a fast-returning hold (sealed bunker) this paces the re-check to ~1.5s
            // AND keeps the loop-top heartbeat fresh (so prepNether stays yielded); for a long
            // continuous child (a full mineDown shaft) the 1.5s is negligible overhead.
            await wait(1500);
        } else {
            await wait(1500);
        }
    }
    prog('kernelDriver loop exhausted (5000 iters) — returning');
    return { exhausted: true };
}
