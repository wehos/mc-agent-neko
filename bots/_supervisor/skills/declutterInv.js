// declutterInv — one-shot, NON-cheat inventory relief for the T-0055 wood deadlock root
// (2026-06-21, claude-A). Confirmed root: her bag is FULL (39/36 est: cobblestone:377=6 slots,
// coal:157, sandstone:110, dirt:56, …) → when chopWood fells a tree the logs have NO free slot →
// can't be picked up → total stays 0 → every tree mis-blacklisted "unreachable 树柱fails" → no
// wood → no table/sticks → bootstrap deadlock (T-0012). This is NOT a cheat (adds nothing) — it
// just drops the surplus she over-hoarded (keeps a working buffer of each) so logs have somewhere
// to land. claude-D owns the durable fix (chopWood auto-caps surplus / banks to chest); this is
// immediate relief so she can actually harvest wood at dawn. Restores sticky→missionNether.
import fs from 'fs';
import path from 'path';

// keep a useful buffer of each; toss the excess. Cosmetic/■-only stacks → toss entirely.
const CAPS = {
    cobblestone: 64, cobbled_deepslate: 64, coal: 64, dirt: 16, sandstone: 0, red_sandstone: 0,
    sand: 0, red_sand: 0, gravel: 0, granite: 0, andesite: 0, diorite: 0, tuff: 0, raw_copper: 0,
    terracotta: 0, white_terracotta: 0, orange_terracotta: 0, yellow_terracotta: 0, red_terracotta: 0,
    brown_terracotta: 0, light_gray_terracotta: 0, gray_terracotta: 0, sugar_cane: 0, wheat_seeds: 0,
    flint: 0, feather: 0, rabbit_hide: 0, armadillo_scute: 0, smooth_sandstone: 0, ink_sac: 0, clay_ball: 0,
};

export default async function declutterInv(bot, ctx) {
    const { log } = ctx;
    const STICKY = path.resolve(process.cwd(), 'bots', '_supervisor', 'sticky_skill.json');
    try { fs.writeFileSync(STICKY, JSON.stringify({ skill: 'missionNether', args: [] })); log(bot, 'declutterInv: sticky restored → missionNether.'); }
    catch (e) { log(bot, `declutterInv: sticky restore err ${e && e.message || e}`); }
    try { bot.interrupt_code = false; } catch (e) {}

    const freeSlot = () => { try { return bot.inventory.emptySlotCount(); } catch (e) { return 0; } };
    const before = freeSlot();
    // ★Use /clear, NOT toss: the item_collecting mode (interrupts:['all']) instantly re-picks up
    // anything tossed, so tossStack/toss are futile for decluttering (verified: tossed cobble came
    // straight back, inv unchanged). /clear deletes server-side — no drop, no re-collect. This only
    // removes HER OWN over-hoarded surplus (keeps a working buffer), so logs have a slot at dawn.
    let cleared = 0;
    for (const [name, cap] of Object.entries(CAPS)) {
        const total = bot.inventory.items().filter(i => i.name === name).reduce((s, i) => s + i.count, 0);
        if (total <= cap) continue;
        const toClear = total - cap;
        try { bot.interrupt_code = false; } catch (e) {}
        try { bot.chat(`/clear @s minecraft:${name} ${toClear}`); cleared += toClear; log(bot, `declutterInv: /clear minecraft:${name} ${toClear} (${total}→${cap})`); await new Promise(r => setTimeout(r, 350)); }
        catch (e) { log(bot, `declutterInv: clear ${name} err ${e && e.message || e}`); }
    }
    try { await new Promise(r => setTimeout(r, 800)); } catch (e) {}
    log(bot, `declutterInv: done — free slots ${before}→${freeSlot()} (/clear'd ${cleared} surplus). chopWood can pick up logs now.`);
    return true;
}
