// Hot-reloadable REAL skill: secure FOOD and restore health before a dangerous
// dive. The bot kept dying in deep caves because it sat at ~10 HP with no food to
// regen (food < 18 = no regen), so any skeleton arrow / zombie hit was lethal.
// feedUp hunts nearby animals with a weapon, eats the meat (raw is fine in a
// pinch), and repeats until food + health are topped up. Run this at the SURFACE
// (where animals are) before descending. Invoked via: {"skill":"feedUp",[18]}
// ctx = { skills, world, mc, Vec3, log }
const FOOD_RE = /cooked_|_bread|^bread$|^apple$|golden_apple|carrot|potato|^beef$|porkchop|^chicken$|^mutton$|^cod$|^salmon$|melon_slice|sweet_berries|_stew|^rabbit$|baked_/;

export default async function feedUp(bot, ctx, targetFood = 18) {
    const { skills, world, mc, log } = ctx;
    const has = (n) => world.getInventoryCounts(bot)[n] || 0;
    const eat = async () => {
        const f = bot.inventory.items().find(i => FOOD_RE.test(i.name) && i.name !== 'rotten_flesh');
        if (f && bot.food < 20) { try { await skills.consume(bot, f.name); return true; } catch (e) {} }
        return false;
    };

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
    const HOSTILE = /zombie|skeleton|creeper|spider|witch|enderman|drowned|husk|phantom|slime|pillager|vindicator|stray|bogged/i;
    const RANGED = /skeleton|stray|pillager|witch/i;
    // C34 同款可达性过滤: 近战怪隔≥5格高差物理够不到,不算威胁(荫蔽怪窝里 10格内
    // "常驻怪"让守卫永远 break,feedUp 的觅食分支全部饿死)
    const hostileNear = (r = 10) => !!world.getNearestEntityWhere(bot, e =>
        (e.type === 'hostile' || e.type === 'mob') && HOSTILE.test(e.name || (e.displayName || ''))
        && (RANGED.test(e.name || '') || Math.abs(e.position.y - bot.entity.position.y) < 5), r);
    // ★PlanC 短程拾取(置于 roam 守卫之前): 白天烧怪掉的腐肉/熟肉 5 分钟 despawn,
    // 等"周围干净"再捡就没了。拾取≤16格且无6格内可达威胁=低风险快进快出,
    // 与 roam-hunt 风险不同级,单独放行。
    const fetchFoodDrop = async () => {
        try {
            const FOOD_DROP = /rotten_flesh|beef|porkchop|chicken|mutton|rabbit|cod|salmon|bread|apple|carrot|potato|melon/i;
            const drop = world.getNearestEntityWhere(bot, e =>
                e && e.name === 'item'
                && FOOD_DROP.test(((e.getDroppedItem && e.getDroppedItem()) || {}).name || ''), 16);
            if (!drop || !drop.position) return false;
            if (hostileNear(6)) return false;
            log(bot, `feedUp: PlanC — food drop ${Math.round(drop.position.distanceTo(bot.entity.position))}b away, fetching`);
            try { await skills.goToPosition(bot, drop.position.x, drop.position.y, drop.position.z, 1); } catch (e) {}
            try { await skills.pickupNearbyItems(bot); } catch (e) {}
            if (bot.food <= 6) {
                const junk = bot.inventory.items().find(i => /rotten_flesh|^beef$|^porkchop$|^chicken$|^mutton$/.test(i.name));
                if (junk) { try { await skills.consume(bot, junk.name); } catch (e) {} }
            }
            return true;
        } catch (e) { return false; }
    };

    // 失败目标拉黑 (空挥根治三件套之三): attackEntity 对不可达目标现在会快速返回 false,
    // 但循环若重选同一只,10次×超时窗=几分钟连续空挥(用户实拍场景)。拉黑已失败的实体id。
    const failedIds = new Set();
    let tries = 0;
    while ((bot.food < targetFood || bot.health < 18) && tries++ < 10) {
        if (bot.interrupt_code) { try { bot.interrupt_code = false; } catch (e) {} }
        // Low HP alone must NOT block hunting: passive animals (cow/sheep/chicken) can't
        // fight back, and at food=0 hunting is the ONLY path back to regen — a blanket
        // hp<8 bail locked a daytime hp3 bot at no-regen forever. Bail only when low HP
        // is COMBINED with an actual threat nearby (that's the hunt-into-death case).
        if (bot.health < 8 && hostileNear(16)) { log(bot, `feedUp: HP critical (${Math.round(bot.health)}) + hostile near — bailing to survival modes.`); break; }
        // Eat anything we already hold first (safe, in place).
        if (await eat()) { await skills.wait(bot, 1200); continue; }
        // No held food. PlanC short fetch FIRST (低险快进快出,守卫前放行——烧怪掉落
        // 5分钟 despawn,等不起), then the roam guard.
        if (await fetchFoodDrop()) { await eat(); await skills.wait(bot, 600); continue; }
        // Getting more means roaming to hunt — do NOT do that at night or
        // with a hostile nearby (that's exactly how it walked into a 5-HP death). Bail
        // and let the dive/shelter logic proceed at whatever HP we have.
        if (isNight() || hostileNear()) { log(bot, 'feedUp: night or hostile nearby — not roam-hunting; stopping.'); break; }
        const animal = world.getNearestEntityWhere(bot, e => mc.isHuntable(e) && !failedIds.has(e.id), 32);
        if (!animal) {
            // ★PlanB — no animals (the hp3/food0 all-day famine post-#267: feedUp came back
            // empty 4 times and the bot faced a second starving night). A human forages:
            // 1) MELONS — this is a jungle world, wild melon blocks are the staple here.
            //    Break one → melon slices (regex food, safe).
            // 2) SWEET BERRIES — bush poke, if any.
            // 3) EMERGENCY: at food<=6 eat rotten flesh / raw meat we're carrying (80%
            //    hunger-effect, ~zero real danger — the classic famine food).
            let foraged = false;
            try {
                const melon = world.getNearestBlock(bot, 'melon', 32);
                if (melon) {
                    log(bot, 'feedUp: no animals — foraging a wild melon');
                    try { foraged = await skills.collectBlock(bot, 'melon', 1); } catch (e) {}
                    if (foraged) { await eat(); await skills.wait(bot, 600); continue; }
                }
            } catch (e) {}
            try {
                const bush = world.getNearestBlock(bot, 'sweet_berry_bush', 32);
                if (bush) {
                    log(bot, 'feedUp: foraging sweet berries');
                    try { await skills.goToPosition(bot, bush.position.x, bush.position.y, bush.position.z, 1); await bot.activateBlock(bush); foraged = true; } catch (e) {}
                    if (foraged) { await eat(); await skills.wait(bot, 600); continue; }
                }
            } catch (e) {}
            if (bot.food <= 6) {
                const junk = bot.inventory.items().find(i => /rotten_flesh|^beef$|^porkchop$|^chicken$|^mutton$|^rabbit$|^cod$|^salmon$/.test(i.name));
                if (junk) {
                    log(bot, `feedUp: famine — eating ${junk.name} (emergency tier)`);
                    try { await skills.consume(bot, junk.name); } catch (e) {}
                    await skills.wait(bot, 600); continue;
                }
            }
            // ★PlanC — 捡地表食物掉落物 (hp6/food0 死水局: 这片破碎崖壁无动物无瓜无浆果,
            // PlanA/B 全空,食物死结锁死作业线(hp≤6 危殆bail)。但白天阳光烧怪,腐肉/鸡肉
            // 散落地表——白送的紧急口粮,人类必捡。找 24格内 item 实体里名字匹配食物的,
            // 走过去捡(pickupNearbyItems),交给上面的紧急档吃掉。)
            try {
                const FOOD_DROP = /rotten_flesh|beef|porkchop|chicken|mutton|rabbit|cod|salmon|bread|apple|carrot|potato|melon/i;
                const drop = world.getNearestEntityWhere(bot, e =>
                    e && e.name === 'item' && e.metadata && JSON.stringify(e.metadata).length < 4000
                    && FOOD_DROP.test(((e.getDroppedItem && e.getDroppedItem()) || {}).name || ''), 24);
                if (drop && drop.position) {
                    log(bot, `feedUp: PlanC — food drop spotted ${Math.round(drop.position.distanceTo(bot.entity.position))}b away, fetching`);
                    try { await skills.goToPosition(bot, drop.position.x, drop.position.y, drop.position.z, 1); } catch (e) {}
                    try { await skills.pickupNearbyItems(bot); } catch (e) {}
                    await eat();
                    if (bot.food <= 6) {
                        const junk2 = bot.inventory.items().find(i => /rotten_flesh|^beef$|^porkchop$|^chicken$/.test(i.name));
                        if (junk2) { try { await skills.consume(bot, junk2.name); } catch (e) {} }
                    }
                    await skills.wait(bot, 600); continue;
                }
            } catch (e) {}
            log(bot, 'feedUp: no animals, no forage, no drops, nothing edible held — cannot get food here');
            break;
        }
        let killed = false;
        try { killed = await skills.attackEntity(bot, animal); } catch (e) {}
        if (!killed) failedIds.add(animal.id);   // 够不到/打不死 → 本次调用内不再选它
        try { await skills.pickupNearbyItems(bot); } catch (e) {}
        await eat();
        await skills.wait(bot, 600);
    }
    log(bot, `feedUp done: hp=${Math.round(bot.health)} food=${bot.food}`);
    return bot.food >= targetFood || bot.health >= 18;
}
