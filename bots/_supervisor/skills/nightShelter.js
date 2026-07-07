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
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // ★SURFACE WALL-BOX ("seal" / 封箱) DISABLED — 2026-07-07 (see docs/shelter-mechanism-disabled.md)
    //   The user gave up on the surface seal after 4+ documented remediation rounds: it kept
    //   leaving the bot standing OUTSIDE its own walls. Root cause: skills.placeBlock() path-
    //   navigates the bot to reach each target face, so by the time the ring is finished the bot
    //   has drifted off the anchor and the walls enclose an empty spot next to it (exactly the
    //   screenshot the user sent). PHASE 1.5 ("self-inside 复核补墙") was the last attempt to fix
    //   it and STILL wasn't enough. Decision (user 2026-07-07): "允许挖三填一，不允许封箱" —
    //   KEEP the dig-down pocket (挖三填一 / mode 'dig_one'), KILL the surface box.
    //
    //   When disabled, mode 'seal' places NO blocks: it stops moving and falls straight to the
    //   PHASE 2 hold loop (stand in place, eat if hungry, bail on any hit/hostile so the always-on
    //   self-defense reflex + surviveNow's RELOCATE/DEATH take over). keepInventory is ON, so a
    //   death here is cheap. This is the accepted tradeoff for never rebuilding the broken box.
    //   NOTE the decision layer (modes.js computeNightPlan) still emits SEAL_FORT on purpose — see
    //   that comment: SEAL_FORT@91 must keep out-ranking daytime BOOTSTRAP_KIT@90 (so a pickless
    //   bot HOLDS at night instead of wandering to chop wood in the dark) and keeps the unstuck-
    //   suppression gate (modes.js ~2650) recognizing the hold. Only the *building* is removed.
    //
    //   Escape hatch (restore the old wall-box): set env NEKO_ENABLE_SEAL_SHELTER=1 before launch.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    const SURFACE_SEAL_DISABLED = process.env.NEKO_ENABLE_SEAL_SHELTER !== '1';
    // ★材料优先级 (用户令 2026-07-07: 泥土 > 石头 > 其他): dirt 优先(便宜/可再生/不占镐料·建材),
    // 石系其次; 从不含木板 (木料是 recraft/工具的命脉, 不拿来砌墙)。
    const FILLER = ['dirt', 'coarse_dirt', 'cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'tuff', 'andesite', 'granite', 'diorite'];
    const filler = () => FILLER.find(n => (world.getInventoryCounts(bot)[n] || 0) > 0);
    // modes.js refreshes bot._world every ~2s; phase 'day' is exactly what isGoalDone
    // uses to release NIGHT_DIG_ONE/NIGHT_SEAL, so skill and proposer share one truth.
    const isDay = () => { try { return !!(bot._world && bot._world.time && bot._world.time.phase === 'day'); } catch (e) { return false; } };

    if (mode !== 'dig_one') mode = 'seal'; // only two modes; junk args behave as the safe default

    // ★P0-2 夜间黑洞诚实化 (2026-07-04 取证: 'sealed 0, 2 still open' ×1986 条零进度合法 hold,
    // 观测面无法区分"真封顶坚守"和"漏风空转")。契约旗 bot._nightSealedUntil (时间戳 — 评审修正:
    // 原布尔 bot._nightSealed 有两个致命伤: ① surfaceUp 读的是另一面旗 _nightSealingUntil, 契约
    // 根本没接上; ② 无 TTL — maxMs 切片到期"保旗"后若整夜不再被派发, 旗 stale-true 挂一整天,
    // 白天真石棺场景会被它压住 C362 逃生 = 重造 y16 石棺 14h 活锁)。语义: Date.now() <
    // bot._nightSealedUntil = 封顶几何完成且本技能仍在 hold (hold 循环每轮滚动续期; 未封/被拆/
    // 拖出/黎明 → 置 0; 停止续期后 ≤10s 自动过期)。消费方 surfaceUp 的 C362 石棺排除按此旗名
    // 读取 (与 prepNether.js 夜庇护封顶段的 bot._nightSealingUntil 并联, 两旗任一活着都算夜封顶)。
    // 返回值契约不变 — hold 型技能活着=价值, 简单 false 会被 3-strike 冷却把整夜保护关掉。
    const SEAL_TTL_MS = 10000; // hold 循环 2s/轮 → 10s 容忍派发切片间隙, 又短到不会压住白天逃生
    let sealedNow = false;     // 本次派发内的封顶几何状态 (hold 循环据此滚动续期)
    const setSealed = (v) => { sealedNow = !!v; try { bot._nightSealedUntil = v ? Date.now() + SEAL_TTL_MS : 0; } catch (e) {} };

    // ── ENTRY gate (checked once, per red line — not re-checked mid-build) ──
    if (isDay()) { setSealed(false); return true; } // night already over (黎明=拆旗), nothing to shelter from
    setSealed(false); // 建造开始前先摘旗 — 只有下方真封成才重新立起

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
            else { setSealed(true); log(bot, 'nightShelter: 挖三填一 pocket sealed.'); }
        }
    }
    if (mode === 'seal') {
      if (SURFACE_SEAL_DISABLED) {
        // ★封箱已禁用 (docs/shelter-mechanism-disabled.md): 不砌任何墙。但 seal 禁用后 "dig_one 不可行" 的
        //   地形不再有保命落点(直落裸 hold = 露天挨打死循环, 对有镐 bot 一样成立)。★G1(2026-07-07 用户令):
        //   ① 就地试挖三填一(digOneCapOne 徒手可挖 dirt/grass/sand/gravel, 自带 gravity/aquifer/y≤16 守卫);
        //   ② 就地不成 → 扫最近"可挖软土地带" relocate 过去再挖(用户令: 寻找最近可挖地带);
        //   ③ 扫不到(石台孤岛/含水层遍布)→ 老实 no-op hold(物理下限, 交 surviveNow/死亡出口)。绝不砌 wall-ring。
        const SOFT_FLOOR = /^(dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium|sand|red_sand|gravel|clay|mud|moss_block|dirt_path|farmland)$/;
        const softFloorUnder = (fx, fy, fz) => { try { const b = bot.blockAt(new Vec3(fx, fy - 1, fz)); return !!(b && SOFT_FLOOR.test(b.name || '')); } catch (e) { return false; } };
        let dug = false;
        if (!isDay() && !bot.interrupt_code && bot.health > 0) {
            dug = await skills.digOneCapOne(bot).catch(() => false);   // ① 就地挖三填一
            if (!dug && !bot.interrupt_code && bot.health > 0) {
                // ② relocate: 由近及远环扫可站+脚下软土地带 (≤5b, 命中即停; bot 本已露天, 短途走位比裸站安全)
                const here = bot.entity.position.floored();
                let best = null;
                outer:
                for (let r = 1; r <= 5; r++) {
                    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
                        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;   // 只扫第 r 环
                        const cx = here.x + dx, cz = here.z + dz;
                        for (const dy of [0, -1, 1]) {
                            const fy = here.y + dy;
                            const feet = bot.blockAt(new Vec3(cx, fy, cz));
                            const head = bot.blockAt(new Vec3(cx, fy + 1, cz));
                            if (feet && feet.boundingBox === 'empty' && head && head.boundingBox === 'empty' && softFloorUnder(cx, fy, cz)) { best = { x: cx, y: fy, z: cz }; break outer; }
                        }
                    }
                }
                if (best) {
                    log(bot, `nightShelter: 硬地/不可挖 → relocate 最近可挖软土 (${best.x},${best.y},${best.z}) 再挖三填一 (用户令).`);
                    try { await skills.goToPosition(bot, best.x, best.y, best.z, 1); } catch (e) {}
                    if (!bot.interrupt_code && bot.health > 0) dug = await skills.digOneCapOne(bot).catch(() => false);
                }
            }
        }
        if (dug) {
            setSealed(true);
            log(bot, 'nightShelter: 挖三填一 pocket sealed — seal 禁用后的保命落点 (非砌墙).');
        } else {
            try { bot.pathfinder && bot.pathfinder.stop && bot.pathfinder.stop(); } catch (e) {}
            try { bot.clearControlStates(); } catch (e) {}
            setSealed(false);
            log(bot, 'nightShelter: 封箱禁用 + dig_one 不可行(硬地/无软土可迁) — 原地 hold, 受威胁即让位反射/re-decide.');
        }
      } else {
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
            setSealed(true); // dig_one 兜底成功 = 口袋封成
            openLeft = 0;
        }
        setSealed(openLeft === 0);
        // ★取证注: 07-03/04 夜里 'sealed 0, 2 still open' 的几何根因不是放置失败, 是
        // 自封守卫按设计给 PICKLESS bot 留最后一个 2 格出口 (mob=FREE pick=false ×1986 条)
        // — 合法的活命 hold, 但必须在观测面上与真封顶区分开。
        if (openLeft > 0) log(bot, `[nightShelter] HOLD(unsealed) open=${openLeft} guardSkip=${guardSkipped} pick=${hasPick()} filler=${filler() || 'none'} — 漏风坚守 (守卫留门/缺料), 非真封顶.`);
      } // end else (SURFACE_SEAL_DISABLED off → original seal-in-place build)
    }

    // ── PHASE 1.5: ★SELF-INSIDE 强制 (用户令 2026-07-07 "强制要求自己在里面" + 实拍 bot 站在半拉
    //    堡垒【外面】): 上面 seal/dig_one 以进场落点为中心围墙, 但 placeBlock 为够到目标格会把 bot
    //    挪开 (它会走到能触到目标面的位置) → 墙围在旧格, bot 站到了外面。这里以 bot 的【当前】落点
    //    为中心复核围合: 4 向脚/头出口 + 顶仍开的就补上, 保证 bot 一定在盒子里。沿用同样守卫:
    //    ENTOMBED/SEALED 跳过 (本就出不去, 别加深棺材); 无镐时不封死最后一个水平出口 (避免自埋, 敌
    //    近由下方 hold 循环的 hostileClose 逃生舱负责)。先停步/清控, 免得补墙时又被 placeBlock 挪出。
    try { bot.pathfinder && bot.pathfinder.stop && bot.pathfinder.stop(); } catch (e) {}
    try { bot.clearControlStates(); } catch (e) {}
    // ★封箱已禁用时整段 PHASE 1.5 跳过 (docs/shelter-mechanism-disabled.md): 这里 RING2 会围着 bot
    //   【当前】落点砌墙 — 正是"站外面"补救逻辑, 本身也在砌那个盒子。seal 关掉后它无对象且只会重建
    //   被禁的墙, 所以只在 seal 启用时才跑。dig_one 挖成的口袋已被地形围合, 不需要它补墙。
    if (!SURFACE_SEAL_DISABLED) {
        const _hasPick = () => { try { return bot.inventory.items().some(i => /_pickaxe$/.test(i.name || '')); } catch (e) { return false; } };
        const _mobSt = () => { try { return (bot._mobility && bot._mobility.state) || ''; } catch (e) { return ''; } };
        const q = bot.entity.position.floored();
        // a horizontal direction is an OPEN exit only if BOTH the feet cell AND the head cell are non-solid
        const _openExits = () => {
            let n = 0;
            for (const [ex, ez] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const fb = bot.blockAt(new Vec3(q.x + ex, q.y, q.z + ez));
                const hb = bot.blockAt(new Vec3(q.x + ex, q.y + 1, q.z + ez));
                if (!(fb && fb.boundingBox === 'block') && !(hb && hb.boundingBox === 'block')) n++;
            }
            return n;
        };
        if (!/ENTOMBED|SEALED/.test(_mobSt())) {
            const RING2 = [
                [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
                [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1],
                [0, 2, 0],
            ];
            let fixed = 0;
            for (const [dx, dy, dz] of RING2) {
                if (bot.interrupt_code || bot.health <= 0) break;
                const c = new Vec3(q.x + dx, q.y + dy, q.z + dz);
                const b = bot.blockAt(c);
                if (b && b.boundingBox === 'block') continue;               // already walled by terrain / earlier seal
                if (!_hasPick() && dy < 2 && _openExits() <= 1) continue;   // pickless: keep the last exit open (no self-entomb)
                const f = filler();
                if (!f) continue;                                          // out of dirt/stone — nothing to close it with
                await skills.placeBlock(bot, f, c.x, c.y, c.z, 'bottom', true).catch(() => {});
                const after = bot.blockAt(c);
                if (after && after.boundingBox === 'block') fixed++;
            }
            if (fixed > 0) {
                setSealed(_openExits() === 0);
                log(bot, `nightShelter: ★self-inside 复核补墙 ${fixed} 格 @${q.x},${q.y},${q.z} exits=${_openExits()} — 把 bot 关进盒子 (非站外面).`);
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
        if (bot.interrupt_code || bot.health <= 0) { setSealed(false); break; } // 反射接管/死亡 — 口袋不再罩着我们, 摘旗
        if (bot.entity.position.distanceTo(holdAnchor) > 2) {
            setSealed(false); // 被拖出口袋 = 拆封
            log(bot, 'nightShelter: dragged >2b out of the sealed pocket (unstuck/instinct/knockback — motion log path.goal names the culprit) — shelter void, re-decide.');
            return false;
        }
        // ★G3: 已封成的口袋(sealedNow)遇隔墙的怪【未掉血】应继续 hold(封顶本就该扛), 不再一见怪就 return false
        //   → kernel 3-strike → 锁 5min 空转(sleep-path 审计的次级死环)。判据: 真掉血【总是】退; 仅未封成的裸 hold
        //   遇怪近 4b 才早退交反射(裸站不是庇护, 该让 surviveNow/reflex 接管)。
        if (bot.health < lastHp - 0.5 || (!sealedNow && hostileClose(4))) {
            setSealed(false);
            log(bot, `nightShelter: ${bot.health < lastHp - 0.5 ? 'taking hits in the "shelter"' : 'unsealed hold + hostile<4'} (hp ${Math.round(bot.health)}/${Math.round(lastHp)}, sealed=${sealedNow}) — re-decide.`);
            return false;
        }
        lastHp = bot.health;
        if (sealedNow) setSealed(true); // 滚动续期 — 旗只在"仍封着+仍在 hold"时活着 (TTL 防 stale-true 挂到白天)
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
    if (isDay() || isDayDirect()) setSealed(false); // 黎明摘旗 — 白天不存在"夜封顶"状态; maxMs 夜内切片到期不摘 — TTL 10s 内 kernel 重派即续上, 若被高优 kind 接管不再派发则旗自行过期 (不 stale)
    return true; // sheltered the night slice we were dispatched for (commitment holds till day)
}
