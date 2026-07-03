// Hot-reloadable REAL skill: the missing NIGHT_DIG_ONE@92 / NIGHT_SEAL@91 dispatch
// target. Two modes selected by the first arg (world_model passes ['dig_one'] or ['seal']):
//   'dig_one' -> 挖三填一 cap shelter: dig ONE block down + cap the head + patch only the
//                open sides (skills.digOneCapOne — reuses digDown's water/lava/gravity
//                guards). Downgrades to 'seal' when the dig is unsafe (gravity column,
//                y<=16, aquifer) — digOneCapOne itself refuses those.
//   'seal'    -> bunker in place: fill every open cell of the feet ring, head ring and
//                ceiling around the bot (shelter.js ring geometry, boundingBox test).
// Then HOLD sealed (eating if hungry) until day / interrupt / maxMs.
//
// Per-dispatch maxMs=120s: the NIGHT_* commitment is sticky until isGoalDone releases it
// (w.time.phase==='day'), so the kernel simply re-dispatches; re-entry is cheap (already
// sealed → phase 1 places nothing) and the 2s-cycle churn is avoided while every held
// second stays interruptible.
//
// Red lines honored: ENTRY condition (already day) checked ONCE at the gate; the hold
// loop checks bot.interrupt_code AND bot.health<=0 EVERY iteration; zero module-level
// state; no infinite retry (out-of-blocks + can't-dig → return false, kernel cooldown
// spaces out genuinely impossible dispatches).
// Invoked via: {"skill":"nightShelter",["dig_one"]}  ctx = { skills, world, mc, Vec3, log }
export default async function nightShelter(bot, ctx, mode = 'seal', opts = {}) {
    const { skills, world, Vec3, log } = ctx;
    const maxMs = (opts && opts.maxMs) || 120000;
    const t0 = Date.now();
    const FILLER = ['cobblestone', 'cobbled_deepslate', 'dirt', 'tuff', 'andesite', 'stone', 'granite', 'diorite'];
    const filler = () => FILLER.find(n => (world.getInventoryCounts(bot)[n] || 0) > 0);
    // modes.js refreshes bot._world every ~2s; phase 'day' is exactly what isGoalDone
    // uses to release NIGHT_DIG_ONE/NIGHT_SEAL, so skill and proposer share one truth.
    const isDay = () => { try { return !!(bot._world && bot._world.time && bot._world.time.phase === 'day'); } catch (e) { return false; } };

    if (mode !== 'dig_one') mode = 'seal'; // only two modes; junk args behave as the safe default

    // ── ENTRY gate (checked once, per red line — not re-checked mid-build) ──
    if (isDay()) return true; // night already over, nothing to shelter from

    // ── PHASE 1: build the shelter ──
    if (mode === 'dig_one') {
        // ★undiggable-under-feet guard (live 2026-07-02 04:33: bot stood ON its own furnace,
        // PICKLESS — furnace is pick-tier, ~17.5s bare-hand vs the ~3-5s per-dig budget, so
        // digOneCapOne's digDown(1) cycled held items (stick/planks/dandelion/egg/beef...)
        // all night, each swap RESETTING break progress — visible as "switching tools,
        // furnace never breaks"). Utility blocks are ALSO the bot's own infrastructure —
        // never shelter-dig them even with a pick. digTime check is fail-open (try/catch).
        const below = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
        const utilityRe = /furnace|crafting_table|chest|barrel|smoker|blast_furnace|bed$/;
        let tooHard = false;
        try { tooHard = below ? below.digTime(bot.heldItem ? bot.heldItem.type : null, false, false, false) > 4500 : false; } catch (e) {}
        if (below && (utilityRe.test(below.name || '') || tooHard)) {
            log(bot, `nightShelter: block under feet is ${below.name} (${utilityRe.test(below.name || '') ? 'own utility block' : 'undiggable within budget'}) — skip dig_one, seal instead.`);
            mode = 'seal';
        } else {
            const ok = await skills.digOneCapOne(bot).catch(() => false);
            if (!ok) { log(bot, 'nightShelter: dig_one refused/failed (gravity/depth/aquifer guard) — downgrading to seal.'); mode = 'seal'; }
            else log(bot, 'nightShelter: 挖三填一 pocket sealed.');
        }
    }
    if (mode === 'seal') {
        const p = bot.entity.position.floored();
        // feet ring (y), head ring (y+1), ceiling (y+2) — shelter.js geometry.
        const RING = [
            [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
            [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1],
            [0, 2, 0],
        ];
        // ★自封守卫 (2026-07-02 23:34 实锤: bot 已 'Stuck in mobility-contained' 仍
        // Placed cobblestone@99,12,203 把自己封进 1x1 石棺, 镐随后挖坏 → ENTOMBED 无镐
        // 空转 30min+). 两条规则:
        //   a) mobility 已判 ENTOMBED/SEALED → 本来就出不去, 再垒块只会加深棺材; 全跳过.
        //   b) 无镐时不放"会把水平出口清零"的那一块 — 封口块全是 pick-tier(cobble),
        //      无镐 bot 封死自己 = 只能靠 ~7.5s/块 的徒手豁免爬回来; 留一个出口, 敌对
        //      靠近由下方 hold 循环的 hostileClose(4) 逃生舱负责. 有镐者原逻辑不变.
        const hasPick = () => { try { return bot.inventory.items().some(i => /_pickaxe$/.test(i.name || '')); } catch (e) { return false; } };
        const mobSt = () => { try { return (bot._mobility && bot._mobility.state) || ''; } catch (e) { return ''; } };
        // 把候选块视作实心后, bot 还剩几个水平出口 (mobility exits 的简化版: 脚/头两格全空 = 出口)
        const exitsAfterPlace = (cand) => {
            try {
                const m = bot.entity.position.floored();
                const solidAt = (x, y, z) => {
                    if (cand && cand.x === x && cand.y === y && cand.z === z) return true;
                    const b = bot.blockAt(new Vec3(x, y, z));
                    return !!(b && b.boundingBox === 'block');
                };
                let n = 0;
                for (const [ex, ez] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    if (!solidAt(m.x + ex, m.y, m.z + ez) && !solidAt(m.x + ex, m.y + 1, m.z + ez)) n++;
                }
                return n;
            } catch (e) { return 1; } // fail-open: 猜还有出口, 照常封 (守卫失效不比现状差)
        };
        let placed = 0, openLeft = 0, guardSkipped = 0;
        for (const [dx, dy, dz] of RING) {
            if (bot.interrupt_code || bot.health <= 0) return false;
            const c = new Vec3(p.x + dx, p.y + dy, p.z + dz);
            const b = bot.blockAt(c);
            if (b && b.boundingBox === 'block') continue; // solid terrain already walls this cell
            if (/ENTOMBED|SEALED/.test(mobSt())) {
                guardSkipped++; openLeft++;
                continue;
            }
            if (!hasPick() && dy < 2 && exitsAfterPlace(c) === 0) {
                guardSkipped++; openLeft++;
                continue;
            }
            const f = filler();
            if (!f) { openLeft++; continue; }
            await skills.placeBlock(bot, f, c.x, c.y, c.z, 'bottom', true).catch(() => {});
            const after = bot.blockAt(c);
            if (after && after.boundingBox === 'block') placed++;
            else openLeft++;
        }
        if (guardSkipped > 0) log(bot, `nightShelter: 自封守卫 skipped ${guardSkipped} cell(s) (mob=${mobSt() || '-'} pick=${hasPick()}) — refusing to entomb a pickless/contained bot.`);
        log(bot, `nightShelter: sealed ${placed} cell(s), ${openLeft} still open, filler left=${filler() || 'none'}.`);
        // Holes remain and the block bag is empty → last resort is the dig-one pocket
        // (it needs ~1 cap block at most and digOneCapOne re-checks its own safety).
        if (openLeft > 0 && !filler()) {
            if (!(await skills.digOneCapOne(bot).catch(() => false))) {
                log(bot, 'nightShelter: no filler and cannot dig — exposed');
                return false;
            }
        }
    }

    // ── PHASE 2: hold until day (EVERY iteration checks interrupt + death, red line) ──
    // ★hold-loop escape hatches (postmortem 2026-07-02 05:41 death: while this loop held,
    // a detached go_to_bed_sleep instinct DRAGGED the bot out of the freshly sealed pocket
    // onto the night surface next to two zombies, and — with the kernel's inline dispatch
    // starving every mode — the bot stood in this silent wait loop taking hits until
    // health<=0 was the only exit that fired. The loop now also exits on: (a) position
    // drift >2b (the pocket no longer contains us — whatever moved us, re-decide), (b) a
    // fresh hit or a hostile within 4b (holding still while being punched is not shelter),
    // (c) isDay read DIRECTLY from bot.time (bot._world is refreshed by the same mode loop
    // an inline kernel dispatch starves — trusting it here could hold past dawn forever).
    const holdAnchor = bot.entity.position.clone();
    const hpAtHold = bot.health;
    const isDayDirect = () => { try { const t = bot.time.timeOfDay; return t < 12800 || t > 23000; } catch (e) { return isDay(); } };
    const hostileClose = (r) => { try { return Object.values(bot.entities || {}).some(e => e && e !== bot.entity && e.position && ctx.mc.isHostile(e) && e.position.distanceTo(bot.entity.position) < r); } catch (e) { return false; } };
    let lastHp = hpAtHold;
    while (!isDay() && !isDayDirect() && Date.now() - t0 < maxMs) {
        if (bot.interrupt_code || bot.health <= 0) break;
        if (bot.entity.position.distanceTo(holdAnchor) > 2) {
            log(bot, 'nightShelter: dragged >2b out of the sealed pocket (unstuck/instinct/knockback — motion log path.goal names the culprit) — shelter void, re-decide.');
            return false;
        }
        if (bot.health < lastHp - 0.5 || hostileClose(4)) {
            log(bot, `nightShelter: taking hits in the "shelter" (hp ${Math.round(bot.health)}/${Math.round(lastHp)}, hostile<4=${hostileClose(4)}) — seal failed, re-decide.`);
            return false;
        }
        lastHp = bot.health;
        if (bot.food != null && bot.food < 12) {
            let f = bot.inventory.items().find(i =>
                /^(cooked_|bread$|apple$|baked_|carrot$|potato$)/.test(i.name) || /cooked_/.test(i.name));
            // ★night-ration fallback (task #9, food=9-pinned-all-night death 06:34Z): raw RED
            // meat is effect-free in vanilla — a famine night in the pocket eats raw
            // beef/porkchop/mutton/rabbit rather than sitting at no-regen hunger. Raw
            // chicken / rotten_flesh stay excluded (Hunger effect mid-night is worse).
            if (!f && bot.food < 8) f = bot.inventory.items().find(i => /^(beef|porkchop|mutton|rabbit)$/.test(i.name));
            if (f) await skills.consume(bot, f.name).catch(() => {});
        }
        await skills.wait(bot, 2000);
    }
    return true; // sheltered the night slice we were dispatched for (commitment holds till day)
}
