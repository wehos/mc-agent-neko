// Hot-reloadable REAL skill: locate the stronghold and activate the End portal
// 100% LEGIT — zero server commands (the old version used /fill /setblock /give;
// all gone). Pipeline, phase-aware and resumable via persisted endgame.json:
//   PHASE 1 LOCATE  — throw an eye of ender, track the spawned eye_of_ender
//                     entity's flight vector; two throws from spots ~120 blocks
//                     apart triangulate the stronghold (single-bearing walk mode
//                     when eyes are scarce).
//   PHASE 2 TRAVEL  — overland legs (<=48 per goToPosition call) to the estimate.
//   PHASE 3 VERIFY+DIG — re-throw on arrival; when the eye hovers/drops (xz
//                     displacement < 8) we are above it -> strongholdKnown; dig
//                     down with the safe sealed-staircase mineDown, then corridor-
//                     hop stone-brick masonry until end_portal_frame blocks appear.
//   PHASE 4 ACTIVATE — break the silverfish spawner, then fill every empty frame
//                     by hand: hold ender_eye, activateBlock(frame), verify the
//                     eye=true blockstate. Approach frames from OUTSIDE the ring
//                     (lava pool under the portal interior).
//   PHASE 5 ENTER   — walk onto an end_portal block and poll for the dimension
//                     swap. Returns {entered:true} once in the End.
// Eyes are conserved: full 2-throw triangulation only with >=10 eyes (keep >=8
// for the frames); re-throws stop at a reserve of 2; running dry persists
// framesEmpty so the proposer reopens the CRAFT_EYES/resupply loop.
// Livelock breakers: a hover conclusion needs >=4 tracked eye samples (a lost
// eye is INCONCLUSIVE, never "we are above it"); 3 zero-evidence dig searches
// wipe strongholdKnown/Est so PHASE 1 re-triangulates; 3 activate dispatches
// with no framesEmpty drop wipe portalRoom and return false (kernel cooldown).
// Return discipline (tightened, kernel-return audit 2026-07-02): truthy ONLY when
// REAL progress happened THIS dispatch — actual displacement, a frame filled, or a
// genuinely NEW persisted milestone. Every zero-progress exit (wedged travel, stale
// re-arrival, zero-fill activate pass, re-finding the room the breaker just wiped)
// returns false so the kernel's 3-strike/5-min cooldown can actually engage — all
// cross-call state lives in bot._endgame + endgame.json, never module scope
// (hot-reload safe).
// Invoked via: {"skill":"setupEndPortal","args":[{"maxMs":480000}]}
// ctx = { skills, world, mc, Vec3, log }
import fs from 'fs';
import path from 'path';

const PROG_F = path.resolve(process.cwd(), 'bots', '_supervisor', 'progress.txt');
const TRIANGULATE_MIN_EYES = 10; // full 2-throw mode only when we can spare them (keep >=8 for frames)
const EYE_THROW_FLOOR = 2;       // never throw the last eyes — they are frame fuel
const EYE_SAMPLES = 6;           // eye flight samples, 300ms apart (~1.8s window)
const EYE_MIN_SAMPLES = 4;       // ★hover conclusion needs >=4 valid samples — losing the eye after 1-2
const EYE_MIN_SAMPLE_MS = 1100;  //  samples leaves last≈first → phantom "above stronghold" (irreversible)
const HOVER_DISP = 8;            // xz displacement below this => eye hovered/dropped => we are above the stronghold
const DIG_FAIL_MAX = 3;          // zero-evidence dig searches before strongholdKnown/Est are wiped for re-triangulation
const WATER_LEG_MAX = 7;         // travelTo: cumulative legs ended in water → open-ocean route, abort (migrate C222 lesson)
const NO_FILL_MAX = 3;           // activate dispatches with no framesEmpty drop before portalRoom is wiped
const STONE_BRICK_RE = /^(stone_bricks|cracked_stone_bricks|mossy_stone_bricks|stone_brick_stairs|stone_brick_slab|infested_stone_bricks)$/;

export default async function setupEndPortal(bot, ctx, opts = {}) {
    const { skills, world, Vec3, log } = ctx;
    const maxMs = (opts && opts.maxMs) || 480000;
    const t0 = Date.now();
    const budget = () => Date.now() - t0 < maxMs;
    const has = (n) => world.getInventoryCounts(bot)[n] || 0;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms)); // sub-second waits only — >=1s waits use skills.wait (interrupt-aware)
    const prog = (s) => { try { fs.appendFileSync(PROG_F, `[${new Date().toISOString()}] [endportal] ${s}\n`); } catch (e) {} };
    const stop = () => !!bot.interrupt_code || bot.health <= 0;
    const dimNow = () => { try { return String(bot.game.dimension || ''); } catch (e) { return ''; } };
    const inEnd = () => /end/.test(dimNow());
    // ★DAWN ALIGN (kernel-return audit 2026-07-02): upper bound was 23500, but modes.js
    // flips phase to 'dawn' at tod>=23000 and computeNightPlan returns NONE for dawn — so
    // NO night plan exists to dethrone committed GO_END, and every {night:true} yield in
    // [23000,23500) was a hot zero-progress truthy re-dispatch loop (~25s each dawn) that
    // also reset the kernel failure counter. Match the proposer's boundary: dawn is
    // actionable day — throw/travel instead of yielding to a proposer with nothing to say.
    const isNight = () => { try { const t = bot.time.timeOfDay % 24000; return t >= 13000 && t < 23000; } catch (e) { return false; } };

    // ── endgame.json state: the ONE shared store (skills.egRead/egPatch — BOM-safe
    //    read, file∪cache∪patch merge, atomic tmp+rename write). Local copies removed:
    //    the cache-forever egRead here could silently revert external/file-only keys. ──
    const egRead = () => skills.egRead(bot);
    const egPatch = (patch) => skills.egPatch(bot, patch);

    let progressed = false; // any persisted/real progress this dispatch → truthy return

    if (inEnd()) { prog('already in the End'); return { entered: true, already: true }; }
    if (/nether/.test(dimNow())) { log(bot, 'setupEndPortal: in the nether — go back to the overworld first.'); return false; }

    // ── THROW-EYE primitive: throw, track the eye_of_ender entity, return the
    //    normalized xz bearing + raw displacement; recover the ~80% drop. ──
    const throwEye = async () => {
        if (has('ender_eye') < 1) return null;
        const eq = await skills.equip(bot, 'ender_eye');
        if (!eq) return null;
        try { await bot.look(bot.entity.yaw, 0.25, true); } catch (e) {} // slightly UP (mineflayer: +pitch = up)
        const p0 = bot.entity.position.clone();
        const before = new Set();
        for (const e of Object.values(bot.entities || {})) { if (e && /eye_of_ender/.test(e.name || '')) before.add(e.id); }
        try { bot.activateItem(); } catch (e) { prog(`activateItem err: ${e && e.message || e}`); return null; }
        let eye = null;
        for (let i = 0; i < 10 && !eye; i++) {
            await sleep(100);
            eye = Object.values(bot.entities || {}).find(e => e && /eye_of_ender/.test(e.name || '') && !before.has(e.id));
        }
        if (!eye || !eye.position) {
            prog('threw an eye but never saw the entity — waiting for the drop');
            await skills.wait(bot, 2500);
            try { await skills.pickupNearbyItems(bot); } catch (e) {}
            return null;
        }
        const first = eye.position.clone();
        let last = first.clone();
        let samples = 0;                 // valid position reads — the hover conclusion's evidence base
        const sampleT0 = Date.now();
        for (let i = 0; i < EYE_SAMPLES; i++) {
            if (stop()) break;
            await sleep(300);
            const cur = bot.entities && bot.entities[eye.id];
            if (!cur || !cur.position) break;
            last = cur.position.clone();
            samples++;
        }
        const sampledMs = Date.now() - sampleT0;
        const dxr = last.x - first.x, dzr = last.z - first.z;
        const disp = Math.hypot(dxr, dzr);
        // let the eye finish (~3s total), walk under its endpoint, grab the ~80% drop
        if (!stop()) {
            await skills.wait(bot, 1200);
            try { await skills.goToPosition(bot, last.x, bot.entity.position.y, last.z, 2); } catch (e) {}
            try { await skills.pickupNearbyItems(bot); } catch (e) {}
        }
        prog(`eye thrown from ${Math.round(p0.x)},${Math.round(p0.z)} bearing=(${(dxr / (disp || 1)).toFixed(2)},${(dzr / (disp || 1)).toFixed(2)}) disp=${disp.toFixed(1)} samples=${samples}/${EYE_SAMPLES} eyesLeft=${has('ender_eye')}`);
        // ★MIN-SAMPLE guard: entity-tracking loss (or a mid-sample interrupt) after 1-2
        // samples leaves last≈first → disp<HOVER_DISP falsely reads as "hovering above the
        // stronghold" and persists an IRREVERSIBLE phantom strongholdKnown. A small disp is
        // only trustworthy after >=EYE_MIN_SAMPLES valid reads spanning real flight time;
        // a truncated track with small disp is INCONCLUSIVE → count it like a failed throw.
        // (A large disp survives — the bearing is real even if the track cut off early.)
        if (disp < HOVER_DISP && (samples < EYE_MIN_SAMPLES || sampledMs < EYE_MIN_SAMPLE_MS)) {
            prog(`eye track truncated (${samples} samples, ${sampledMs}ms) with disp=${disp.toFixed(1)} — INCONCLUSIVE, not a hover`);
            return null;
        }
        if (disp < 0.05) return { x: p0.x, z: p0.z, dx: 0, dz: 0, disp: 0 };
        return { x: p0.x, z: p0.z, dx: dxr / disp, dz: dzr / disp, disp };
    };

    // ── Overland travel in <=48-block legs; interrupt/night/vitals/budget checked per leg. ──
    // ★HARDENING-LITE (migrate.js C222/C263 lessons, not the full hop-march): (a) CUMULATIVE
    // water-leg counter — swimming advances >2 blocks/leg so the old loop happily crossed
    // open ocean until the budget died; too many wet leg-ends → 'water' → caller returns
    // false (kernel cooldown, don't drown mid-sea). (b) per-leg hp/food gate → 'vitals' →
    // caller returns false so the survival chain (GET_FOOD/HOLD) takes the body over.
    const inWater = () => {
        try {
            if (typeof bot.oxygenLevel === 'number' && bot.oxygenLevel < 20) return true;
            const p = bot.entity.position.floored();
            for (const dy of [0, 1]) { const b = bot.blockAt(p.offset(0, dy, 0)); if (b && /water/.test(b.name || '')) return true; }
        } catch (e) {}
        return false;
    };
    const travelTo = async (tx, tz, closeEnough) => {
        let stuck = 0;
        let waterLegs = 0; // cumulative — NOT reset on dry legs' progress (a straight ocean march "progresses" every leg)
        let lastPos = bot.entity.position.clone();
        while (budget()) {
            if (stop()) return 'interrupted';
            if (bot.health < 8 || bot.food < 6) { prog(`travel vitals bail hp=${Math.round(bot.health)} food=${bot.food}`); return 'vitals'; }
            const p = bot.entity.position;
            const dx = tx - p.x, dz = tz - p.z;
            const d = Math.hypot(dx, dz);
            if (d <= closeEnough) return 'arrived';
            if (isNight()) return 'night';
            const leg = Math.min(48, d);
            try { await skills.goToPosition(bot, p.x + (dx / d) * leg, p.y, p.z + (dz / d) * leg, 4); } catch (e) {}
            if (inWater()) {
                waterLegs++;
                if (waterLegs >= WATER_LEG_MAX) { prog(`travel aborted: ${waterLegs} legs ended in water — open-ocean route, not swimming it`); return 'water'; }
            }
            const np = bot.entity.position;
            if (np.distanceTo(lastPos) < 2) {
                stuck++;
                if (stuck >= 3) return 'stuck';
                const px = -dz / d, pz = dx / d; // sidestep 8 blocks perpendicular, then retry
                try { await skills.goToPosition(bot, np.x + px * 8, np.y, np.z + pz * 8, 2); } catch (e) {}
            } else { stuck = 0; progressed = true; }
            lastPos = bot.entity.position.clone();
        }
        return 'budget';
    };

    const markAboveStronghold = () => {
        egPatch({ strongholdKnown: true, strongholdEst: { x: Math.round(bot.entity.position.x), z: Math.round(bot.entity.position.z) } });
        progressed = true;
        prog(`★ eye hovered/dropped — we are ABOVE the stronghold at ${Math.round(bot.entity.position.x)},${Math.round(bot.entity.position.z)}`);
        log(bot, 'Eye of ender dropped here — stronghold is below us.');
    };

    let eg = egRead();
    log(bot, `[setupEndPortal] start dim=${dimNow()} eyes=${has('ender_eye')} est=${eg.strongholdEst ? `${eg.strongholdEst.x},${eg.strongholdEst.z}` : 'none'} known=${!!eg.strongholdKnown} room=${!!eg.portalRoom} ready=${!!eg.endPortalReady} budget=${Math.round(maxMs / 1000)}s`);

    // ─────────────────────────── PHASE 1: LOCATE ───────────────────────────
    if (!eg.strongholdEst && !eg.strongholdKnown && !eg.portalRoom && !eg.endPortalReady) {
        if (has('ender_eye') < 1) { log(bot, 'setupEndPortal: no eyes of ender — craft eyes first.'); return false; }
        if (has('ender_eye') >= TRIANGULATE_MIN_EYES) {
            // Full mode: two throws from spots ~120 apart, intersect the bearings.
            let tries = 0;
            while (!egRead().strongholdEst && !egRead().strongholdKnown && tries++ < 3 && budget()) {
                if (stop()) return progressed ? { phase: 'locate', interrupted: true } : false;
                if (has('ender_eye') <= EYE_THROW_FLOOR + 1) break; // conserve — fall to single-bearing/resupply
                if (isNight()) { prog('night before throw A — yield WITHOUT burning an eye'); return { phase: 'locate', night: true }; } // ★night gate BEFORE every throw
                const A = await throwEye();
                if (!A) break;
                progressed = true;
                if (A.disp < HOVER_DISP) { markAboveStronghold(); break; }
                const r1 = await travelTo(A.x + (-A.dz) * 120, A.z + A.dx * 120, 24); // perpendicular to bearing A
                if (r1 === 'interrupted') return { phase: 'locate', interrupted: true };
                if (r1 === 'night') { prog('night during locate — yield to the night chain'); return { phase: 'locate', night: true }; }
                if (r1 === 'water' || r1 === 'vitals') return false; // ocean route / survival bail → kernel cooldown
                // Wedged mid-triangulation: throwing B from (almost) the same spot yields a
                // near-parallel bearing → the retry walk wedges again → up to ~7 eyes torched
                // in ONE dispatch before the single-bearing loop's wedge bail fired. Same
                // treatment as there: false → kernel cooldown (kernel-return audit 2026-07-02).
                if (r1 === 'stuck') { prog('triangulation travel A wedged 3x — false → kernel cooldown'); return false; }
                if (r1 === 'budget') break;
                if (stop()) return { phase: 'locate', interrupted: true };
                if (has('ender_eye') <= EYE_THROW_FLOOR) break;
                if (isNight()) return { phase: 'locate', night: true }; // ★night gate BEFORE every throw
                const B = await throwEye();
                if (!B) break;
                if (B.disp < HOVER_DISP) { markAboveStronghold(); break; }
                // Solve A + t·u = B + s·v in 2D. denom == sin(angle between bearings).
                const denom = A.dx * B.dz - A.dz * B.dx;
                if (Math.abs(denom) < 0.17) { // < ~10° (or near-180°): ill-conditioned intersection
                    prog(`bearings near-parallel (|sin|=${Math.abs(denom).toFixed(3)}) — walking 150 along bearing, retrying`);
                    const r2 = await travelTo(bot.entity.position.x + B.dx * 150, bot.entity.position.z + B.dz * 150, 24);
                    if (r2 === 'interrupted') return { phase: 'locate', interrupted: true };
                    if (r2 === 'night') return { phase: 'locate', night: true };
                    if (r2 === 'water' || r2 === 'vitals') return false;
                    if (r2 === 'stuck') { prog('near-parallel retry walk wedged 3x — false → kernel cooldown'); return false; } // see r1 (audit 2026-07-02)
                    continue;
                }
                const t = ((B.x - A.x) * B.dz - (B.z - A.z) * B.dx) / denom;
                const est = { x: Math.round(A.x + t * A.dx), z: Math.round(A.z + t * A.dz) };
                const dEst = Math.hypot(est.x - bot.entity.position.x, est.z - bot.entity.position.z);
                if (t <= 0 || dEst > 3500) {
                    prog(`triangulation rejected (t=${t.toFixed(1)} dist=${Math.round(dEst)}) — walking 150 along bearing, retrying`);
                    const r3 = await travelTo(bot.entity.position.x + B.dx * 150, bot.entity.position.z + B.dz * 150, 24);
                    if (r3 === 'interrupted') return { phase: 'locate', interrupted: true };
                    if (r3 === 'night') return { phase: 'locate', night: true };
                    if (r3 === 'water' || r3 === 'vitals') return false;
                    if (r3 === 'stuck') { prog('rejected-triangulation retry walk wedged 3x — false → kernel cooldown'); return false; } // see r1 (audit 2026-07-02)
                    continue;
                }
                egPatch({ strongholdEst: est });
                prog(`★ stronghold triangulated at ~${est.x},${est.z} (${Math.round(dEst)} blocks away)`);
                log(bot, `Stronghold triangulated: ~${est.x},${est.z} (${Math.round(dEst)} blocks).`);
            }
        }
        // Single-bearing walk mode: one throw, walk 150 along the bearing, repeat.
        while (!egRead().strongholdEst && !egRead().strongholdKnown && budget()) {
            if (stop()) return progressed ? { phase: 'locate', interrupted: true } : false;
            if (has('ender_eye') <= EYE_THROW_FLOOR) {
                log(bot, `setupEndPortal: eye reserve reached (${has('ender_eye')}) mid-locate — need a resupply run.`);
                return false; // cannot act → kernel cooldown frees the body for CRAFT_EYES/resupply
            }
            if (isNight()) { prog('night before single-bearing throw — yield WITHOUT burning an eye'); return { phase: 'locate', night: true }; } // ★night gate BEFORE every throw
            const T = await throwEye();
            if (!T) return progressed ? { phase: 'locate', throwFail: true } : false;
            progressed = true;
            if (T.disp < HOVER_DISP) { markAboveStronghold(); break; }
            const r = await travelTo(T.x + T.dx * 150, T.z + T.dz * 150, 24);
            if (r === 'interrupted') return { phase: 'locate', interrupted: true };
            if (r === 'night') return { phase: 'locate', night: true };
            if (r === 'water' || r === 'vitals') return false; // ocean route / survival bail → kernel cooldown
            // ★WEDGE = FAILURE (kernel-return audit 2026-07-02): {phase:'locate',stuck:true}
            // was truthy, so a physically wedged bot (3 legs <2 blocks) reset the kernel's
            // failure counter on every ~2s re-dispatch — and each re-dispatch burned one ender
            // eye from the SAME spot (throwing needs no movement, the drop is unreachable,
            // nothing persisted) until the EYE_THROW_FLOOR finally starved it. A wedge won't
            // clear in 2s: return false like 'water'/'vitals' so the 3-strike/5-min cooldown
            // spaces the retries and frees the body for the unstuck/survival chains.
            if (r === 'stuck') { prog('single-bearing travel stuck 3x — wedged, false → kernel cooldown'); return false; }
            if (r === 'budget') break;
        }
        eg = egRead();
        if (!eg.strongholdEst && !eg.strongholdKnown) return progressed ? { phase: 'locate', budget: !budget() } : false;
    }

    // ────────────── PHASE 2+3: TRAVEL, VERTICAL TEST, DIG, SEARCH ──────────────
    eg = egRead();
    if (!eg.portalRoom && !eg.endPortalReady) {
        if (eg.strongholdEst) {
            const dEst = Math.hypot(eg.strongholdEst.x - bot.entity.position.x, eg.strongholdEst.z - bot.entity.position.z);
            if (dEst > 32) {
                prog(`traveling to stronghold estimate ${eg.strongholdEst.x},${eg.strongholdEst.z} (${Math.round(dEst)} away)`);
                const r = await travelTo(eg.strongholdEst.x, eg.strongholdEst.z, 32);
                if (r === 'interrupted') return { phase: 'travel', interrupted: true };
                if (r === 'night') return { phase: 'travel', night: true };
                if (r === 'water' || r === 'vitals') return false; // ocean route / survival bail → kernel cooldown
                if (r === 'budget') return progressed ? { phase: 'travel', budget: true } : false;
                if (r === 'stuck') { prog('travel to estimate stuck 3x'); return progressed ? { phase: 'travel', stuck: true } : false; }
            }
        }
        // Vertical test: confirm we are ABOVE the stronghold before the dig.
        if (!egRead().strongholdKnown) {
            let hops = 0;
            while (!egRead().strongholdKnown && hops++ < 6 && budget()) {
                if (stop()) return progressed ? { phase: 'verify', interrupted: true } : false;
                if (has('ender_eye') < 1) {
                    log(bot, 'setupEndPortal: OUT OF EYES at the dig site — resupply loop reopens.');
                    return false; // eyesShort>0 already reopens CRAFT_EYES — no speculative framesEmpty write needed
                }
                if (isNight()) return { phase: 'verify', night: true }; // ★night gate BEFORE every throw — no eye burned
                const T = await throwEye();
                if (!T) return progressed ? { phase: 'verify', throwFail: true } : false;
                progressed = true;
                if (T.disp < HOVER_DISP) { markAboveStronghold(); break; }
                const r = await travelTo(T.x + T.dx * 60, T.z + T.dz * 60, 16);
                if (r === 'interrupted') return { phase: 'verify', interrupted: true };
                if (r === 'night') return { phase: 'verify', night: true };
                if (r === 'water' || r === 'vitals') return false; // ocean route / survival bail → kernel cooldown
                // Fourth leg of the wedged-travel family (kernel-return audit 2026-07-02, same as
                // r1/r2/r3 + single-bearing): unhandled 'stuck' fell through to the next hop, which
                // re-threw from the SAME wedged spot (same bearing, no hover) — up to 6 eyes per
                // dispatch (this loop has no THROW_FLOOR, only <1) and a truthy return via the
                // throw's progressed=true. Wedge = failure → kernel cooldown.
                if (r === 'stuck') { prog('verify hop travel wedged 3x — false → kernel cooldown'); return false; }
            }
            if (!egRead().strongholdKnown) return progressed ? { phase: 'verify', budget: !budget() } : false;
        }
        // Dig down to stronghold depth with the safe sealed staircase.
        if (stop()) return progressed ? { phase: 'descend', interrupted: true } : false;
        if (Math.floor(bot.entity.position.y) > 33 && budget()) {
            prog(`descending y=${Math.floor(bot.entity.position.y)} → 30 via mineDown (sealed staircase)`);
            try { await skills.customSkill(bot, 'mineDown', { targetY: 30, steps: 60 }); } catch (e) { prog(`mineDown threw: ${e && e.message || e}`); }
            progressed = true;
        }
        // Search: end_portal_frame directly, else corridor-hop stone-brick masonry.
        // ★PHANTOM-STRONGHOLD RECOVERY: strongholdKnown was irreversible — a false hover
        // conclusion (see throwEye's min-sample guard) marked a random spot and every GO_END
        // dispatch dug the same empty hole forever, with NO code path ever clearing it.
        // Persist a dig-failure counter: a search that exhausts with ZERO frame/masonry
        // evidence strikes it; at DIG_FAIL_MAX wipe strongholdKnown/Est so PHASE 1 can
        // re-triangulate instead of trusting the phantom mark.
        const digFailed = () => {
            const fails = (egRead().strongholdDigFails || 0) + 1;
            if (fails >= DIG_FAIL_MAX) {
                egPatch({ strongholdDigFails: 0, strongholdKnown: false, strongholdEst: null });
                prog(`★ dig-search failed ${fails}x with ZERO evidence — phantom stronghold; wiping strongholdKnown/Est for re-triangulation`);
                log(bot, 'setupEndPortal: no stronghold evidence after repeated digs — re-triangulating from scratch.');
            } else {
                egPatch({ strongholdDigFails: fails });
                prog(`dig-search found zero frames/masonry (dig fail ${fails}/${DIG_FAIL_MAX})`);
            }
            return false; // cannot act here → kernel cooldown spaces out retries
        };
        let lastSb = null, noProg = 0, sawEvidence = false, passesDone = 0;
        for (let pass = 0; pass < 6 && budget(); pass++) {
            passesDone = pass + 1;
            if (stop()) return progressed ? { phase: 'search', interrupted: true } : false;
            const _f = await world.getNearestBlocksWhereAsync(bot, (b) => b && b.name === 'end_portal_frame', 100, 1);
            const f = (_f && _f.length) ? _f[0] : null;
            if (f) {
                sawEvidence = true;
                // ★RE-FIND ≠ PROGRESS (kernel-return audit 2026-07-02): after the unfillable-
                // frame breaker wiped portalRoom, this findBlock instantly re-found the SAME
                // room the bot was still standing in and the unconditional progressed=true made
                // the re-record a truthy "milestone" every cycle — one leg of the 3-truthy/
                // 1-false livelock that kept the kernel cooldown unreachable. Re-finding a frame
                // of the room the breaker just wiped (xz<=16, |dy|<=8 — a stronghold has ONE
                // portal room) is stale state, not progress; a genuinely NEW room clears the marker.
                const w = egRead().portalRoomWiped;
                const sameWiped = !!w && Math.hypot(w.x - f.position.x, w.z - f.position.z) <= 16 && Math.abs(w.y - f.position.y) <= 8;
                egPatch({ portalRoom: { x: f.position.x, y: f.position.y, z: f.position.z }, strongholdDigFails: 0, ...(sameWiped ? {} : { portalRoomWiped: null }) });
                if (!sameWiped) progressed = true;
                prog(`★ PORTAL ROOM ${sameWiped ? 're-found (same room the no-fill breaker wiped — NOT progress)' : 'found'} — frame at ${f.position.x},${f.position.y},${f.position.z}`);
                log(bot, `End portal frames found at ${f.position.x},${f.position.y},${f.position.z}!`);
                break;
            }
            const _sb = await world.getNearestBlocksWhereAsync(bot, (b) => b && STONE_BRICK_RE.test(b.name || ''), 64, 1);
            const sb = (_sb && _sb.length) ? _sb[0] : null;
            if (sb) sawEvidence = true; // any masonry sighting = real stronghold, not a phantom mark
            if (sb && (!lastSb || sb.position.distanceTo(lastSb) > 8)) {
                lastSb = sb.position.clone();
                noProg = 0;
                progressed = true;
                if (egRead().strongholdDigFails) egPatch({ strongholdDigFails: 0 }); // evidence — reset the phantom strikes
                prog(`corridor-hop to stronghold masonry at ${sb.position.x},${sb.position.y},${sb.position.z}`);
                try { await skills.goToPosition(bot, sb.position.x, sb.position.y + 1, sb.position.z, 2); } catch (e) {}
            } else {
                noProg++;
                if (noProg >= 3) {
                    prog('no frames and no NEW stone bricks for 3 passes — search dead-ended here');
                    log(bot, 'setupEndPortal: stronghold search stalled — cooling off, will retry.');
                    if (!sawEvidence) return digFailed(); // zero evidence the whole search → phantom strike
                    return false; // dead end → let the kernel cooldown space out retries
                }
                try { await skills.customSkill(bot, 'branchMine', 16); } catch (e) {}
            }
        }
        if (!egRead().portalRoom) {
            if (!sawEvidence && passesDone >= 6) return digFailed(); // all passes burned, zero evidence
            return progressed ? { phase: 'search', budget: !budget() } : false;
        }
    }

    // ──────────────────────── PHASE 4: FILL THE FRAMES ────────────────────────
    eg = egRead();
    const frameFilled = (b) => { try { const p = b && b.getProperties && b.getProperties(); return !!p && (p.eye === true || p.eye === 'true'); } catch (e) { return false; } };
    const scanFrames = () => { try { return bot.findBlocks({ matching: (b) => b && b.name === 'end_portal_frame', maxDistance: 16, count: 12 }) || []; } catch (e) { return []; } };
    const emptyFrames = (list) => list.filter(fp => { const b = bot.blockAt(fp); return b && b.name === 'end_portal_frame' && !frameFilled(b); });

    // Shared "get back to the room" helper (death/restart resume for phases 4+5).
    const gotoRoom = async (pr) => {
        if (Math.hypot(pr.x - bot.entity.position.x, pr.z - bot.entity.position.z) > 48) {
            const r = await travelTo(pr.x, pr.z, 32);
            if (r === 'interrupted' || r === 'night' || r === 'budget' || r === 'water' || r === 'vitals') return r;
        }
        if (Math.floor(bot.entity.position.y) > pr.y + 12 && budget()) {
            try { await skills.customSkill(bot, 'mineDown', { targetY: pr.y + 2, steps: 80 }); } catch (e) {}
        }
        for (let i = 0; i < 3; i++) {
            if (stop()) return 'interrupted';
            if (bot.entity.position.distanceTo(new Vec3(pr.x, pr.y, pr.z)) <= 6) return 'arrived';
            try { await skills.goToPosition(bot, pr.x, pr.y, pr.z, 4); } catch (e) {}
        }
        return bot.entity.position.distanceTo(new Vec3(pr.x, pr.y, pr.z)) <= 8 ? 'arrived' : 'far';
    };

    if (eg.portalRoom && !eg.endPortalReady) {
        // ★ARRIVAL ≠ PROGRESS (kernel-return audit 2026-07-02): progressed=true used to be
        // set unconditionally on 'arrived', but gotoRoom's distanceTo<=6 check passes with
        // ZERO movement on every re-dispatch while standing in the room — the canonical
        // stale-state truthy that fed the zero-fill return below and kept the kernel
        // failure counter at 0 forever. Progress = actual displacement this dispatch
        // (entry snapshot; travelTo already flags its own real legs — the snapshot also
        // catches gotoRoom's internal goToPosition/mineDown movement travelTo can't see).
        const roomP0 = bot.entity.position.clone();
        const gr = await gotoRoom(eg.portalRoom);
        if (bot.entity.position.distanceTo(roomP0) > 8) progressed = true;
        if (gr === 'interrupted') return progressed ? { phase: 'activate', interrupted: true } : false;
        if (gr === 'night') return { phase: 'activate', night: true };
        if (gr === 'water' || gr === 'vitals') return false; // ocean route / survival bail → kernel cooldown
        if (gr !== 'arrived') return progressed ? { phase: 'activate', approach: gr } : false;
        if (stop()) return { phase: 'activate', interrupted: true };

        // Kill the silverfish spawner first — filling frames in a swarm is a death loop.
        const _sp = await world.getNearestBlocksWhereAsync(bot, (b) => b && b.name === 'spawner', 12, 1);
        const sp = (_sp && _sp.length) ? _sp[0] : null;
        if (sp) {
            prog(`breaking spawner at ${sp.position.x},${sp.position.y},${sp.position.z}`);
            try { await skills.breakBlockAt(bot, sp.position.x, sp.position.y, sp.position.z); } catch (e) {}
        }

        let frames = scanFrames();
        if (frames.length === 0) {
            // No-infinite-retry red line: a stale portalRoom (e.g. bad data) would spin a
            // truthy 2s re-dispatch loop forever. Strike-count on the bot object; after 5
            // arrivals with zero frames, drop the record and fall back to the search phase.
            bot._epfNoFrames = (bot._epfNoFrames || 0) + 1;
            if (bot._epfNoFrames >= 5) {
                bot._epfNoFrames = 0;
                egPatch({ portalRoom: null });
                prog('no frames at recorded portalRoom after 5 visits — clearing stale portalRoom, re-searching');
                return false;
            }
            prog(`portalRoom recorded but no frames within 16 — rescanning next dispatch (strike ${bot._epfNoFrames}/5)`);
            // Same family as the zero-fill return below: standing at the room with no frames
            // and no movement is a zero-progress exit — false unless real travel happened this
            // dispatch (kernel-return audit 2026-07-02). The 5-strike wipe above still runs.
            return progressed ? { phase: 'activate', framesNotLoaded: true } : false;
        }
        bot._epfNoFrames = 0;
        const cx = frames.reduce((s, p) => s + p.x, 0) / frames.length;
        const cz = frames.reduce((s, p) => s + p.z, 0) / frames.length;
        const empties = emptyFrames(frames);
        egPatch({ framesEmpty: empties.length });
        prog(`frames seen=${frames.length} empty=${empties.length} eyes=${has('ender_eye')}`);

        for (const fp of empties) {
            if (stop()) return { phase: 'activate', interrupted: true };
            if (!budget()) break;
            if (has('ender_eye') < 1) {
                const left = emptyFrames(scanFrames()).length;
                egPatch({ framesEmpty: left });
                log(bot, `setupEndPortal: OUT OF EYES with ${left} frames still empty — resupply loop reopens.`);
                return false;
            }
            // Approach from OUTSIDE the ring — never path across the portal interior (lava below).
            let ux = fp.x + 0.5 - cx, uz = fp.z + 0.5 - cz;
            const um = Math.hypot(ux, uz) || 1; ux /= um; uz /= um;
            try { await skills.goToPosition(bot, fp.x + 0.5 + ux * 2, fp.y, fp.z + 0.5 + uz * 2, 1); } catch (e) {}
            let ok = false;
            for (let tr = 0; tr < 3 && !ok; tr++) {
                if (stop()) return { phase: 'activate', interrupted: true };
                const b = bot.blockAt(fp);
                if (!b || b.name !== 'end_portal_frame') break;
                if (frameFilled(b)) { ok = true; break; }
                try { await skills.equip(bot, 'ender_eye'); } catch (e) {}
                try { await bot.lookAt(fp.offset(0.5, 0.6, 0.5), true); } catch (e) {}
                try { await bot.activateBlock(b); } catch (e) { prog(`activateBlock err: ${e && e.message || e}`); }
                await sleep(400);
                ok = frameFilled(bot.blockAt(fp));
            }
            if (ok) { progressed = true; prog(`frame filled at ${fp.x},${fp.y},${fp.z} (eyes left ${has('ender_eye')})`); }
            else prog(`frame at ${fp.x},${fp.y},${fp.z} would not take an eye after 3 tries`);
        }

        // Verify: all 12 filled, or (authoritative) end_portal blocks appeared.
        frames = scanFrames();
        const emptyLeft = emptyFrames(frames).length;
        const _portalBlock = await world.getNearestBlocksWhereAsync(bot, (b) => b && b.name === 'end_portal', 16, 1);
        const portalBlock = (_portalBlock && _portalBlock.length) ? _portalBlock[0] : null;
        if ((frames.length >= 12 && emptyLeft === 0) || portalBlock) {
            bot._epfNoFill = null; // frames done — clear the unfillable-frame strikes
            egPatch({ endPortalReady: true, framesEmpty: 0 });
            prog('★ END PORTAL ACTIVE (12 eyes, zero commands)');
            log(bot, '★ END PORTAL ACTIVE — every frame filled by hand, zero commands.');
        } else {
            const emptyRec = emptyLeft > 0 ? emptyLeft : Math.max(1, 12 - frames.length);
            egPatch({ framesEmpty: emptyRec });
            prog(`portal NOT complete: seen=${frames.length} emptyLeft=${emptyLeft} eyes=${has('ender_eye')}`);
            // ★UNFILLABLE-FRAME BREAKER: strike consecutive activate dispatches whose empty
            // count did not DROP; at NO_FILL_MAX wipe portalRoom (forces a fresh room scan +
            // approach geometry) and return false. Any real fill (emptyRec drop) resets it.
            // (kernel-return audit 2026-07-02: this breaker alone could NEVER engage the kernel
            // cooldown — 'arrived' forced progressed=true so strikes 0-2 returned truthy, and
            // the wipe let the next dispatch's search findBlock instantly re-find the same room
            // the bot was standing in with strikes reset via prev=null: a permanent 3-truthy/
            // 1-false cycle vs the kernel's 3-CONSECUTIVE-failure limit. Fixed at both ends:
            // progressed is now displacement/fill-gated above, and the wiped coords persist in
            // endgame.json so the search-phase re-find is not counted as progress.)
            const prev = bot._epfNoFill; // {left, strikes} — bot._* survives hot-reload, wiped on restart (fine)
            const strikes = (prev && emptyRec >= prev.left) ? prev.strikes + 1 : 0;
            bot._epfNoFill = { left: emptyRec, strikes };
            if (strikes >= NO_FILL_MAX) {
                bot._epfNoFill = null;
                egPatch({ portalRoom: null, portalRoomWiped: { x: eg.portalRoom.x, y: eg.portalRoom.y, z: eg.portalRoom.z } });
                prog(`framesEmpty stuck at ${emptyRec} for ${strikes} activate dispatches — wiping portalRoom (coords persisted so the re-find is not "progress"), rescanning after cooldown`);
                log(bot, 'setupEndPortal: frames will not fill from here — cooling off and re-scanning the room.');
                return false;
            }
            // Truthy now requires REAL progress this dispatch (a frame filled, real approach
            // travel, or a genuinely NEW room found upstream) — a standing-still zero-fill
            // dispatch returns false so the kernel's 3-strike/5-min cooldown finally works.
            return progressed ? { phase: 'activate', framesEmpty: emptyLeft } : false;
        }
    }

    // ───────────────────────── PHASE 5: WALK INTO THE END ─────────────────────────
    eg = egRead();
    if (eg.endPortalReady && !inEnd()) {
        if (eg.portalRoom && bot.entity.position.distanceTo(new Vec3(eg.portalRoom.x, eg.portalRoom.y, eg.portalRoom.z)) > 16) {
            const gr = await gotoRoom(eg.portalRoom);
            if (gr === 'interrupted') return progressed ? { phase: 'enter', interrupted: true } : false;
            if (gr === 'night') return { phase: 'enter', night: true };
            if (gr === 'water' || gr === 'vitals') return false; // ocean route / survival bail → kernel cooldown
            if (gr !== 'arrived') return progressed ? { phase: 'enter', approach: gr } : false;
        }
        const _pb = await world.getNearestBlocksWhereAsync(bot, (b) => b && b.name === 'end_portal', 16, 1);
        const pb = (_pb && _pb.length) ? _pb[0] : null;
        if (!pb) { prog('endPortalReady but no end_portal block within 16 — repositioning next dispatch'); return progressed ? { phase: 'enter', portalNotSeen: true } : false; }
        prog(`stepping into the End portal at ${pb.position.x},${pb.position.y},${pb.position.z}`);
        try { await skills.goToPosition(bot, pb.position.x, pb.position.y + 1, pb.position.z, 1); } catch (e) {}
        try { await bot.lookAt(pb.position.offset(0.5, 0.5, 0.5), true); } catch (e) {}
        try { bot.setControlState('forward', true); } catch (e) {}
        await skills.wait(bot, 1200);
        try { bot.clearControlStates(); } catch (e) {}
        for (let i = 0; i < 30; i++) {
            if (inEnd() || stop()) break;
            await sleep(500);
        }
        if (inEnd()) {
            // (endEntered flag dropped — it was written but read nowhere; dimension is the truth)
            prog('★★★ ENTERED THE END — legit tech tree, zero commands ★★★');
            log(bot, 'WE ARE IN THE END. Dragon time.');
            return { entered: true };
        }
        if (stop()) return { phase: 'enter', interrupted: true };
        // One nudge: walk directly onto the portal block column.
        try { await skills.goToPosition(bot, pb.position.x + 0.5, pb.position.y + 1, pb.position.z + 0.5, 0); } catch (e) {}
        await skills.wait(bot, 1500);
        if (inEnd()) { prog('★★★ ENTERED THE END (nudge) ★★★'); return { entered: true }; }
        prog('stood at the portal but no dimension swap yet');
        return progressed ? { phase: 'enter', entered: false } : false;
    }

    return progressed ? { phase: 'partial' } : false;
}
