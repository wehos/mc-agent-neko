// Hot-reloadable REAL skill: situational melee/shield combat that reacts to the
// ENEMY TYPE (the bot judges the matchup itself), not one-size-fits-all:
//   • creeper  -> NEVER melee (it explodes). Keep distance / back away. Quick
//                 hit-and-retreat only if it's already point-blank.
//   • skeleton -> close the gap with the shield RAISED (blocks arrows), then strike.
//   • witch    -> RUSH with shield DOWN (splash potions ignore shields; raising one
//                 halves move speed) + stop-loss: hp<10 → sprint out to >20b.
//   • zombie/spider/other -> approach and melee, shield up between swings.
//   • enderman -> disengage (don't provoke; looking at it aggroes — just move off).
// Invoked via: {"skill":"shieldFight",[range]}  ctx = { skills, world, mc, Vec3, log }
export default async function shieldFight(bot, ctx, range = 14, maxMs = 14000) {
    const { skills, world, mc, log } = ctx;
    const has = (n) => world.getInventoryCounts(bot)[n] || 0;

    for (const s of ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'netherite_axe', 'diamond_axe', 'iron_axe']) {
        if (has(s)) { await skills.equip(bot, s).catch(() => {}); break; }
    }
    const shieldItem = bot.inventory.items().find(i => i.name === 'shield');
    if (shieldItem && (!bot.inventory.slots[45] || bot.inventory.slots[45].name !== 'shield')) {
        try { await bot.equip(shieldItem, 'off-hand'); } catch (e) {}
    }
    const haveShield = () => bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield';
    const raise = () => { try { if (haveShield()) bot.activateItem(true); } catch (e) {} };
    const lower = () => { try { bot.deactivateItem(); } catch (e) {} };
    // ★C360 (modes.js FUTILE-FIGHT 断路器同步豁免): 黑名单里的打不动怪(bot._futileMobIds,
    // id→expiry)不选为目标 — mode 层不 engage 它, 这里也不能替别的怪进来时把它捞回来。
    const notFutile = (e) => {
        const m = bot._futileMobIds;
        return !(m instanceof Map) || !e || e.id == null || !((m.get(e.id) || 0) > Date.now());
    };
    const enemy = () => world.getNearestEntityWhere(bot, e => mc.isHostile(e) && notFutile(e), range);
    const kindOf = (e) => {
        const n = (e && e.name || '').toLowerCase();
        if (n.includes('creeper')) return 'creeper';
        if (n.includes('witch')) return 'witch';
        if (n.includes('skeleton') || n.includes('stray') || n.includes('pillager')) return 'ranged';
        if (n.includes('enderman')) return 'enderman';
        return 'melee';
    };

    const startT = Date.now();
    let e;
    // ★C353 (T-0063, worker-combat 06-27): UNREACHABLE-RANGED bailout. When the bot is boxed in a
    // closed pocket, a skeleton on the far side of the wall sits at a FIXED distance the bot can never
    // change — it can't close (path blocked → goToPosition returns instantly) AND can't damage it
    // (every swing hits the wall). The loop spins whiffing forever, the mob's HP never drops, and
    // self_defense.active starves mobility's POCKET escape → the three-way interlock the overseer
    // traced (06-27: skeleton d=0.4 @wall, 'Fighting skeleton!' ×10/3s, hp5 food0). Detect a ranged
    // target whose HP we're NOT bringing down: sample its health each loop; if a ranged mob survives
    // ≥4s of engagement with no HP loss (and we never killed/swapped it), it's unreachable behind a
    // wall — break and release the body so mobility's dig-out + the kernel's GET_FOOD take over.
    // Reachable skeletons die (HP drops → reset) or get replaced (new target → reset); melee mobs are
    // untouched (kind !== 'ranged'). Falls back to distance-stall when HP isn't exposed.
    let rangedSince = 0, rangedId = null, rangedHp0 = null, prevD = Infinity, stalls = 0, fledWitch = false;
    while ((e = enemy()) && Date.now() - startT < maxMs) {
        if (bot.interrupt_code) break;
        const kind = kindOf(e);
        const d = bot.entity.position.distanceTo(e.position);
        // ★WITCH (2026-07-02 16:15-16:19Z 三连死, 同一只 id 349335): 盾挡不住喷溅药水的
        // 范围效果, 举盾走路还减速50% → 旧 melee 分支半速蹭近被风筝 (d 全程 1.8~5.4 震荡
        // 47s 无输出, 女巫瞬回II把偶尔一刀全洗回来), 毒tick 1dmg/1.25s 磨穿血线; hp<=6
        // break 后 mode 层 pointBlank 例外又立刻 re-engage → ENGAGE/DISENGAGE 空转至死。
        // 新打法: (a) 血线止损 hp<10 → sprint 拉到 >20b (女巫索敌16b不远追), 等毒效过掉,
        // flee 加 8s race 上界保 10s stop 预算 (仿 C347); (b) 贴脸压制: 全程不举盾保机动,
        // d>3 全速关距离, 贴身按剑冷却连打 (女巫换喝回血药有硬直窗口, 持续 dps 压得过瞬回)。
        if (kind === 'witch') {
            lower();
            if (bot.health < 10) {
                log(bot, `shieldFight: witch stop-loss (hp=${Math.round(bot.health)} d=${d.toFixed(1)}) — sprint out of throw range, let potions wear off.`);
                try { bot.setControlState('sprint', true); } catch (_) {}
                try {
                    await Promise.race([
                        skills.moveAwayFromEntity(bot, e, 24),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('witch-flee-timeout')), 8000)),
                    ]);
                } catch (_) { try { bot.pathfinder.stop(); } catch (e2) {} }
                try { bot.setControlState('sprint', false); } catch (_) {}
                fledWitch = true;   // don't walk back for drops — the witch is standing on them
                break;
            }
            try { await bot.lookAt(e.position.offset(0, (e.height || 1.9) * 0.85, 0)); } catch (_) {}
            if (d > 3) {
                try { bot.setControlState('sprint', true); await skills.goToPosition(bot, e.position.x, e.position.y, e.position.z, 2); } catch (_) {}
            } else {
                try { await bot.attack(e); } catch (_) {}
                await skills.wait(bot, 550);   // sword cooldown; shield STAYS down — chase the backpedal at full speed
            }
            continue;
        }
        if (bot.health <= 6) break; // critical — let self_preservation flee/seal
        // ★石棺扩展 (2026-07-03 00:19 实锤 @99,10,204: 困 1x1 石棺, 洞外 spider@d=4.1 —
        // melee 不在此检测里 → shield-rush goToPosition noPath 秒回 → 空转 ×150/s 直到
        // maxMs, self_defense 又立刻 re-engage = mobility/脱困永饿死): 同一"打不动就放手"
        // 判据对 melee 一样成立 — 隔墙 spider/zombie 的 HP 同样纹丝不动. 检测范围 ranged
        // → ranged+melee; creeper/witch/enderman 各有自己的 continue 分支, 不经过这里.
        if (kind === 'ranged' || kind === 'melee') {
            const eh = (typeof e.health === 'number') ? e.health : null;
            if (e.id !== rangedId) { rangedId = e.id; rangedSince = Date.now(); rangedHp0 = eh; prevD = d; stalls = 0; }
            else {
                // HP-based: same mob, no HP drop for ≥4s ⇒ we're not hurting it (wall in the way).
                const hpStuck = (eh !== null && rangedHp0 !== null) ? (eh >= rangedHp0 - 0.01) : true;
                if (!hpStuck) { rangedHp0 = eh; rangedSince = Date.now(); }      // landed a hit → reset clock
                // distance fallback (HP unexposed): can't close the gap either.
                if (d >= prevD - 0.5) stalls++; else { stalls = 0; }
                prevD = d;
                if (Date.now() - rangedSince > 4000 && (hpStuck || stalls >= 6)) {
                    log(bot, `shieldFight: ${kind} target unreachable (d=${d.toFixed(1)} hpStuck=${hpStuck}) — disengaging, yield to escape/food.`);
                    break;
                }
            }
        } else { rangedId = null; rangedSince = 0; rangedHp0 = null; prevD = Infinity; stalls = 0; }

        // RANGED FIRST: if we have a bow + arrows and the threat is at distance,
        // SHOOT it. This is the clean kill for a creeper (drop it before it can ever
        // reach blast range) and lets us out-trade skeletons. Bow/arrows are picked
        // up from the skeletons we kill, so this capability grows over time.
        const hasBow = has('bow') > 0 && has('arrow') > 0;
        if (hasBow && d > 4.5 && (kind === 'creeper' || kind === 'ranged')) {
            lower();
            try { await skills.equip(bot, 'bow'); } catch (_) {}
            try {
                const aim = () => bot.lookAt(e.position.offset(0, (e.height || 1.8) * 0.45, 0));
                await aim();
                bot.activateItem();            // draw the bow
                await skills.wait(bot, 1100);  // charge to full power
                await aim();                   // re-aim at the (moved) target
                bot.deactivateItem();          // release
            } catch (_) {}
            for (const s of ['diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword']) { if (has(s)) { await skills.equip(bot, s).catch(() => {}); break; } }
            continue;
        }

        if (kind === 'creeper') {
            // SPECIAL anti-creeper measure: never sit in melee. (1) Drop a 2-high
            // block WALL in the gap toward it — blocks its approach and absorbs the
            // blast. (2) Knock it back (resets its fuse + shoves it ~3 blocks).
            // (3) SPRINT clear. Wall + knockback + run is the no-bow creeper counter.
            lower();
            const wall = ['cobblestone', 'cobbled_deepslate', 'dirt', 'tuff', 'andesite', 'stone', 'granite', 'diorite'].find(n => has(n) > 0);
            if (wall && d < 5) {
                const p = bot.entity.position.floored();
                const dir = e.position.minus(bot.entity.position);
                const ux = Math.abs(dir.x) >= Math.abs(dir.z) ? Math.sign(dir.x) : 0;
                const uz = ux === 0 ? Math.sign(dir.z) : 0;
                for (const dy of [0, 1]) { try { await skills.placeBlock(bot, wall, p.x + ux, p.y + dy, p.z + uz, 'bottom', true); } catch (_) {} }
            }
            if (d < 4) { try { await bot.attack(e); } catch (_) {} }
            try { bot.setControlState('sprint', true); await skills.moveAwayFromEntity(bot, e, 12); } catch (_) {}
            try { bot.setControlState('sprint', false); } catch (_) {}
            continue;
        }
        if (kind === 'enderman') {
            // Don't provoke (don't lookAt — that aggroes); just leave.
            try { await skills.moveAwayFromEntity(bot, e, 10); } catch (_) {}
            continue;
        }

        // ranged (skeleton) or melee: shield-rush.
        try { await bot.lookAt(e.position.offset(0, e.height ? e.height * 0.85 : 1.4, 0)); } catch (_) {}
        if (d > 3.2) {
            raise(); // close under guard (blocks skeleton arrows)
            // ★spin cap (石棺实锤: noPath 秒回 → 裸 continue = ~150 次寻路/s 烧 CPU 且把
            // path 遥测刷爆): 寻路 <400ms 就失败/返回 = 根本没路可走, 歇 250ms 再试 —
            // 4s 的 unreachable 时钟(上方)照走, 只是不再空转风暴. 正常追击(寻路 >400ms)零影响.
            const _rushT0 = Date.now();
            try { await skills.goToPosition(bot, e.position.x, e.position.y, e.position.z, 2); } catch (_) {}
            if (Date.now() - _rushT0 < 400) { try { await skills.wait(bot, 250); } catch (_) {} }
        } else {
            lower();
            try { await bot.attack(e); } catch (_) {}
            await skills.wait(bot, 550);
            raise();
        }
    }
    lower();
    try { bot.setControlState('sprint', false); } catch (_) {}
    // Grab the spoils (skeletons drop bows + arrows, which feed our ranged combat;
    // also bones/etc). This is how the bot bootstraps a bow without a supply chain.
    // (Skipped after a witch stop-loss flee — walking back to the drops = walking back into throw range.)
    if (!fledWitch) { try { await skills.pickupNearbyItems(bot); } catch (e) {} }
    log(bot, `shieldFight done. hp=${Math.round(bot.health)} bow=${has('bow')} arrows=${has('arrow')}`);
    return true;
}
