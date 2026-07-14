// giveBed — one-shot, user-sanctioned keystone for the T-0043 night-respawn death loop
// (2026-06-21, claude-A). The ROOT of the entire night-death-loop family is that the bot
// has NO BED: this biome has no sheep and the spider-string→wool bootstrap never completes,
// so setBed (called every safe window by prepNether.tryHome) can't plant a respawn anchor —
// and the bot keeps respawning on the bare exposed surface at night (#109-#118: respawn →
// swarmed → die → respawn). A bed is the textbook root fix: it (1) relocates the respawn to
// a chosen safe spot AND (2) lets the bot SLEEP THROUGH the night = zero night exposure. The
// server grants /give (forceReset's /kill works), so a bed is the minimal keystone keepInventory
// then preserves across deaths. Unlike devGive this does NOT touch /time (so a live night-test
// of the shelter reflexes keeps running) and does NOT re-give armor/food (already stocked).
// setBed (setBed.js:84 firstMatch(/_bed$/)) consumes an existing bed directly → place → set
// spawn → sleep. Dispatched ONE-SHOT via inbox {"skill":"giveBed"} so sticky stays missionNether.
import fs from 'fs';
import path from 'path';

export default async function giveBed(bot, ctx) {
    const { log } = ctx;
    // Restore sticky to missionNether FIRST (devGive pattern): this skill is dispatched via
    // sticky_skill.json={skill:giveBed}+cancel_skill (the only path that releases missionNether's
    // run_skill lock); restoring sticky here means the next ~8s tick resumes the right loop.
    const STICKY = path.resolve(process.cwd(), 'bots', '_supervisor', 'sticky_skill.json');
    try { fs.writeFileSync(STICKY, JSON.stringify({ skill: 'missionNether', args: [] })); log(bot, 'giveBed: sticky restored → missionNether.'); }
    catch (e) { log(bot, `giveBed: sticky restore err ${e && e.message || e}`); }
    // a swarm always sets interrupt_code → the /give chat would be skipped (the devGive lesson);
    // clear it so the command actually lands.
    try { bot.interrupt_code = false; } catch (e) {}
    const bedCount = () => { try { return bot.inventory.items().filter(i => /_bed$/.test(i.name || '')).reduce((s, i) => s + i.count, 0); } catch (e) { return 0; } };
    const before = bedCount();
    // ★ROOT of the silent give-fail: the inventory was FULL (36/36) — /give of a NEW item type
    // (white_bed) has no free slot so it drops at the feet and despawns (ok=true, but bed never
    // lands). /give of an EXISTING stack (cooked_beef) topped up its slot, which is why those
    // worked and this didn't. Free a slot first by tossing a junk stack the bot can't use yet
    // (raw_copper — no smelting path; then any other low-value filler) so the bed has somewhere
    // to go. (Also unblocks pickups/tool-craft that the full bag was silently starving.)
    const freeSlot = () => { try { return bot.inventory.emptySlotCount(); } catch (e) { return 1; } };
    if (freeSlot() < 1) {
        const JUNK = [/^raw_copper$/, /^red_sand$/, /terracotta$/, /^granite$/, /^andesite$/, /^diorite$/, /^cobblestone$/];
        for (const re of JUNK) {
            if (freeSlot() >= 1) break;
            const it = bot.inventory.items().find(i => re.test(i.name || ''));
            if (it) { try { await bot.tossStack(it); log(bot, `giveBed: tossed junk ${it.name} x${it.count} to free a slot`); await new Promise(r => setTimeout(r, 400)); } catch (e) { log(bot, `giveBed toss err ${e && e.message || e}`); } }
        }
    }
    // ★RETRY (the first dispatch fired right at reconnect → the bot wasn't fully in-world yet →
    // the /give chat was dropped, beds stayed 0). /give @s white_bed (a valid item — she held
    // white_bed:2 earlier today) up to 5×, re-checking the bag between tries; stop the instant a
    // bed lands. 2 beds: one to place + a spare (placed blocks aren't kept by keepInventory).
    let after = before;
    for (let i = 0; i < 5 && after < 1; i++) {
        try { bot.interrupt_code = false; } catch (e) {}
        try { bot.chat('/give @s white_bed 2'); log(bot, `giveBed: /give @s white_bed 2 (try ${i + 1})`); }
        catch (e) { log(bot, `giveBed chat err ${e && e.message || e}`); }
        try { await new Promise(r => setTimeout(r, 1600)); } catch (e) {}
        after = bedCount();
    }
    log(bot, `giveBed: done — beds ${before}→${after} (server ${after > before ? 'GRANTED' : 'REFUSED'} /give). prepNether.tryHome→setBed will plant + set spawn + sleep.`);
    return true;
}
