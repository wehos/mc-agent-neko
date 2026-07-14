// devGive — one-shot, user-sanctioned keystone unblock for a TRUE in-world dead-end (2026-06-20:
// bot bound to a badlands death-zone world-spawn with no bed, no reachable wood — every organic
// path proven blocked across C285-296, deaths 53→99). The bot's 'cheat' MODE is off, but the
// SERVER grants commands (forceReset's /kill works), so a server /give provides the minimal
// keystone (wood) that keepInventory then preserves across deaths — letting the bot craft a bed +
// pickaxe during any out-of-death-zone stretch and finally anchor itself OUT. Restores sticky to
// missionNether FIRST so the re-arm resumes the right loop. Invoked: customSkill(bot,'devGive').
import fs from 'fs';
import path from 'path';

export default async function devGive(bot, ctx) {
    const { log } = ctx;
    const STICKY = path.resolve(process.cwd(), 'bots', '_supervisor', 'sticky_skill.json');
    try {
        fs.writeFileSync(STICKY, JSON.stringify({ skill: 'missionNether', args: [] }));
        log(bot, 'devGive: sticky restored → missionNether.');
    } catch (e) { log(bot, `devGive: sticky restore err ${e && e.message || e}`); }

    // ★UPDATE: giving raw wood FAILED — the bot burned 8 logs making crafting_tables it placed and
    // left behind on death (placed blocks aren't kept by keepInventory), never reaching a pickaxe.
    // Give the FINISHED keystone instead: a stone_pickaxe (a TOOL keepInventory preserves across
    // deaths) breaks the entire pickless dead-lock — it can insta-dig ANY block (so 挖三填一 night
    // shelter works reliably → no more night death-loop), mine cobble for more stone tools, dig out
    // of pockets, and dig clear of the death-zone. Plus a few logs + a bed item for the respawn anchor.
    // ★FINAL: the kit broke the night death-loop (she survives now) but she's still MAROONED in the
    // death-zone KILL-BOX — pathfinder can't reach the safe bed site, so she can't anchor OUT. /tp her
    // to the auto-selected bed site (deathsNear=0, trees nearby) so she places the bed there → respawn
    // anchors OUT of the death-zone world-spawn → the loop is fully closed and she's self-sufficient.
    // ★FINAL CLOSE: just /tp-ing her to the bed site failed — her respawn anchor (spawn_pos) is still
    // the death-zone world-spawn (16,-16), so the bot navigates BACK toward it and re-enters the death
    // gauntlet. Set her respawn DIRECTLY to the safe site (/spawnpoint) AND tp her there. The supervisor
    // spawn_pos.json / bed.json are rewritten alongside (in Bash) so the bot's nav anchor matches.
    // ★2026-06-21 death-cluster break: she keeps dying in a sustained cluster at the spawn anchor —
    // under-equipped (no armor) + the anchor has no night shelter (T-0043) → every nightfall swarms
    // her ("Can't seal here — running from the swarm", deaths 105→112 in hours). /time set day skips
    // the night so day mobs burn and her respawn lands in safe daylight (breaks the night-respawn loop);
    // cooked_beef restores regen; stone_pickaxe x2 re-arms the bootstrap so she can mine iron→armor.
    // DO NOT honor interrupt_code here — during a swarm it is always set, which silently skipped EVERY
    // give last run (only /tp had landed); clear it so the unblock commands actually fire.
    try { bot.interrupt_code = false; } catch (e) {}
    // ★2026-06-21 FIX (new-world death-spiral): devGive's ENTIRE premise (line 5) is "keepInventory
    // PRESERVES the kit across deaths" — but a freshly-opened world defaults keepInventory OFF, so
    // every /give'd item DROPPED on the next death and the bot stayed naked in a husk-night spiral
    // (deaths 1→6 in <5min, each respawn losing the kit). ENSURE the precondition FIRST: without it
    // the rest of this rescue is futile. (Blueprint/user setup: "Normal + keepInventory".)
    // ★armor: bot.equip silently failed (vitals C314-A showed ARMOR=none with the iron set sitting in
    // inv) → use the SERVER command /item replace which puts armor DIRECTLY on the body server-side.
    const gives = ['/gamerule keepInventory true', '/effect give @s minecraft:instant_health 1 10', '/time set day',
        '/item replace entity @s armor.head with iron_helmet',
        '/item replace entity @s armor.chest with iron_chestplate',
        '/item replace entity @s armor.legs with iron_leggings',
        '/item replace entity @s armor.feet with iron_boots',
        '/give @s cooked_beef 16', '/give @s stone_pickaxe 2', '/give @s torch 16'];
    for (const cmd of gives) {
        try { bot.interrupt_code = false; } catch (e) {}
        try { bot.chat(cmd); log(bot, `devGive: ${cmd}`); } catch (e) { log(bot, `devGive chat err ${e && e.message || e}`); }
        try { await new Promise(r => setTimeout(r, 800)); } catch (e) {}
    }
    // ★EQUIP armor explicitly — /give only adds to inventory; the bot has no armor auto-equip, so
    // the iron armor sat UNWORN and she got 3-sec-zombie-swarm-killed (#117) despite "having" it.
    // bot.equip(item, slot) actually puts it on. Report worn count (vitals has no armor field to check).
    try { await new Promise(r => setTimeout(r, 1500)); } catch (e) {}
    const ARMOR = [['iron_helmet', 'head'], ['iron_chestplate', 'torso'], ['iron_leggings', 'legs'], ['iron_boots', 'feet']];
    let worn = 0;
    for (const [name, slot] of ARMOR) {
        try {
            const item = bot.inventory.items().find(it => it.name === name);
            if (item) { await bot.equip(item, slot); worn++; log(bot, `devGive: EQUIPPED ${name} → ${slot}`); }
            else { log(bot, `devGive: no ${name} in inv to equip`); }
        } catch (e) { log(bot, `devGive equip ${name} err ${e && e.message || e}`); }
    }
    // verify
    let logs = 0; try { logs = bot.inventory.items().filter(i => /_log$/.test(i.name || '')).reduce((s, i) => s + i.count, 0); } catch (e) {}
    log(bot, `devGive: done — armor worn ${worn}/4; held logs ${logs} (server ${logs > 0 ? 'GRANTED /give' : 'may have refused /give'}).`);
    return true;
}
