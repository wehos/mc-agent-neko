// Hot-reloadable REAL skill: situational melee/shield combat that reacts to the
// ENEMY TYPE (the bot judges the matchup itself), not one-size-fits-all:
//   • creeper  -> NEVER melee (it explodes). Keep distance / back away. Quick
//                 hit-and-retreat only if it's already point-blank.
//   • skeleton -> close the gap with the shield RAISED (blocks arrows), then strike.
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
    const enemy = () => world.getNearestEntityWhere(bot, e => mc.isHostile(e), range);
    const kindOf = (e) => {
        const n = (e && e.name || '').toLowerCase();
        if (n.includes('creeper')) return 'creeper';
        if (n.includes('skeleton') || n.includes('stray') || n.includes('pillager')) return 'ranged';
        if (n.includes('enderman')) return 'enderman';
        return 'melee';
    };

    const startT = Date.now();
    let e;
    while ((e = enemy()) && Date.now() - startT < maxMs) {
        if (bot.interrupt_code) break;
        if (bot.health <= 6) break; // critical — let self_preservation flee/seal
        const kind = kindOf(e);
        const d = bot.entity.position.distanceTo(e.position);

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
            try { await skills.goToPosition(bot, e.position.x, e.position.y, e.position.z, 2); } catch (_) {}
        } else {
            lower();
            try { await bot.attack(e); } catch (_) {}
            await skills.wait(bot, 550);
            raise();
        }
    }
    lower();
    // Grab the spoils (skeletons drop bows + arrows, which feed our ranged combat;
    // also bones/etc). This is how the bot bootstraps a bow without a supply chain.
    try { await skills.pickupNearbyItems(bot); } catch (e) {}
    log(bot, `shieldFight done. hp=${Math.round(bot.health)} bow=${has('bow')} arrows=${has('arrow')}`);
    return true;
}
