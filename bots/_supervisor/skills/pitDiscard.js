// pitDiscard — thin manual/LLM entry to skills.smartDiscard (2026-07-14, 坑弃引擎验收钩子).
// Throw an item away FOR GOOD: finds low ground in the 8 neighbour columns (or digs a 1-2 deep
// pocket), aims the toss INTO the hole, tags the drops so instincts don't chase them, steps back
// out of the server's pickup sphere, then verifies past the 2s pickup delay and reports honestly.
// Usage: !runSkill("pitDiscard", "item=cobblestone;num=16")  (num=-1 → all of the item).
// Forensics go through log(): pre/post counts + where the drops actually settled.
export default async function pitDiscard(bot, ctx, item = 'dirt', num = -1) {
    const { skills, log } = ctx;
    if (typeof skills.smartDiscard !== 'function') {
        log(bot, `pitDiscard: skills.smartDiscard unavailable — main process is running a pre-restart skills.js. Restart to deploy it.`);
        return false;
    }
    const haveOf = (n) => { try { return bot.inventory.items().reduce((s, i) => s + (i.name === n ? i.count : 0), 0); } catch (e) { return 0; } };
    // 'auto' (or an absent named item) → pick the biggest bulk-junk stack the bot currently holds,
    // so the acceptance test doesn't fight the live inventory churn of an actively-playing bot.
    const JUNK_RE = /^(cobblestone|cobbled_deepslate|dirt|gravel|sand|red_sand|andesite|diorite|granite|tuff|stone|netherrack|deepslate|coal)$/;
    if (item === 'auto' || haveOf(item) === 0) {
        let best = null;
        try { for (const it of bot.inventory.items()) { if (JUNK_RE.test(it.name) && (!best || it.count > best.count)) best = it; } } catch (e) {}
        if (best) { item = best.name; }
    }
    const pre = haveOf(item);
    const feet = bot.entity.position.floored();
    log(bot, `pitDiscard: start — ${item} x${pre} in bag, feet @${feet}.`);
    if (pre === 0) { log(bot, `pitDiscard: no discardable junk to test with.`); return { ok: false, reason: 'no junk in bag' }; }

    const posBefore = bot.entity.position.clone();
    if (typeof bot.output !== 'string') bot.output = '';
    const out0 = bot.output.length;
    let ok = false;
    try { ok = await skills.smartDiscard(bot, { name: item, num }); }
    catch (e) { log(bot, `pitDiscard: smartDiscard err ${e && e.message || e}`); }
    // capture smartDiscard's own log lines (log() → bot.output) to see which PATH it took
    const sdLines = bot.output.slice(out0).split('\n').filter(l => /smartDiscard/.test(l)).map(l => l.trim());
    const path = sdLines.some(l => /pit @/.test(l)) ? 'pit'
        : sdLines.some(l => /walk-away|no step-in pit/.test(l)) ? 'fallback' : 'unknown';
    const moved = +posBefore.distanceTo(bot.entity.position).toFixed(2);

    const post = haveOf(item);
    // where did the drops actually settle? (forensics: in-pit = BELOW feet level, dy<0). Report the
    // structured dy list AS THE RETURN VALUE so the WS skill_result surfaces it directly (log() only
    // appends to bot.output, which isn't flushed to a file).
    const feetY = bot.entity.position.y;
    const drops = [];
    try {
        for (const en of Object.values(bot.entities)) {
            if (!en || en.name !== 'item' || !en.position) continue;
            if (en.position.distanceTo(bot.entity.position) > 6) continue;
            let dname = null; try { const it = en.getDroppedItem && en.getDroppedItem(); dname = it && it.name; } catch (e) {}
            drops.push({ name: dname, dy: +(en.position.y - feetY).toFixed(2), pos: [Math.floor(en.position.x), Math.floor(en.position.y), Math.floor(en.position.z)] });
        }
    } catch (e) {}
    const belowFeet = drops.filter(d => d.dy < -0.4).length;
    const summary = { ok, item, pre, post, removed: pre - post, target: num === -1 ? 'all' : num, path, moved, feetY: +feetY.toFixed(2), drops, dropsBelowFeet: belowFeet, sd: sdLines.slice(-4) };
    log(bot, `pitDiscard: ${ok ? '✅' : '✖'} ${item} ${pre}→${post} path=${path} moved=${moved} (${belowFeet}/${drops.length} drops below feet)`);
    return summary;
}
