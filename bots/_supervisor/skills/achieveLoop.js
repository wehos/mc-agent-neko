// Hot-reloadable wrapper: run achieve(goal) repeatedly until the goal is met,
// surviving interruptions. WHY: survival modes (self_preservation flee /
// self_defense) interrupt the bot via interrupt_code when a mob attacks — that
// makes the in-flight achieve() bail out of its mining loops and return early.
// As long as the bot FLEES and stays alive (keeping its inventory), re-entering
// achieve continues from the preserved inventory. So we loop: clear the stale
// interrupt, let any flee/regen settle, run achieve again. Net effect: a
// "flee -> resume -> keep progressing" loop instead of dying and restarting from
// nothing. Runs under the supervised lock (LLM stays silent the whole time).
// Invoked via: {"skill":"achieveLoop","args":["diamond_pickaxe", 40]}
// ctx = { skills, world, mc, Vec3, log }
import fs from 'fs';
import path from 'path';
const PROG = path.resolve(process.cwd(), 'bots', '_supervisor', 'progress.txt');
const prog = (s) => { try { fs.appendFileSync(PROG, `[${new Date().toISOString()}] ${s}\n`); } catch (e) {} };

export default async function achieveLoop(bot, ctx, goal, maxTries = 40) {
    const { skills, world, log } = ctx;
    const g = typeof goal === 'string' ? { item: goal, count: 1 } : goal;
    const target = g.item;
    const need = g.count || 1;
    const have = () => (world.getInventoryCounts(bot)[target] || 0);

    // Signature of the whole inventory, to detect "spinning with no progress"
    // (e.g. blocked on something achieve can't fix in this context). If several
    // tries in a row change NOTHING, hammering 40x is pointless — bail early.
    const invSig = () => { const c = world.getInventoryCounts(bot); return Object.keys(c).sort().map(k => `${k}:${c[k]}`).join(','); };
    let stale = 0, lastSig = '';

    prog(`==== achieveLoop(${target} x${need}) START (maxTries ${maxTries}) ====`);
    for (let i = 1; i <= maxTries; i++) {
        if (have() >= need) { prog(`achieveLoop: GOAL MET ${target} (have ${have()})`); return true; }
        // Clear any stale interrupt left by a previous flee/defense so achieve
        // isn't pre-empted the instant it starts.
        try { bot.interrupt_code = false; } catch (e) {}
        prog(`achieveLoop: try ${i}/${maxTries} for ${target} (have ${have()}, hp ${Math.round(bot.health)})`);
        let ok = false;
        try { ok = await skills.customSkill(bot, 'achieve', g); }
        catch (e) { prog(`achieveLoop: achieve threw: ${e.message}`); }
        if (ok && have() >= need) { prog(`achieveLoop: GOAL MET ${target} (have ${have()})`); return true; }
        // No-progress guard: if the inventory is byte-for-byte identical to the
        // previous try, that try did nothing useful. Tolerate a few (transient
        // interrupts/flee), but give up rather than burn all 40 tries spinning.
        const sig = invSig();
        if (sig === lastSig) { stale++; if (stale >= 6) { prog(`achieveLoop: no progress for ${stale} tries — giving up on ${target} (have ${have()})`); return false; } }
        else { stale = 0; lastSig = sig; }
        // If achieve returned without success, pause before retrying a transient failure.
        try { await skills.wait(bot, 2500); } catch (e) {}
    }
    prog(`achieveLoop: gave up on ${target} after ${maxTries} tries (have ${have()})`);
    log(bot, `achieveLoop done. ${target}=${have()}/${need}`);
    return have() >= need;
}
