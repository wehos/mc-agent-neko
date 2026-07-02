// Hot-reloadable REAL skill: a persistent DIAMOND BANK (one chest) so mined
// diamonds survive death — death drops only what you're CARRYING, never chest
// contents. This turns "must do one flawless death-free dive for 3 diamonds" into
// "accumulate across dives": deposit each haul, and once the chest holds enough,
// withdraw and craft. The chest position is saved to disk so it persists across
// deaths AND agent restarts. Like a real player banking loot at a base.
// Invoked via: {"skill":"diamondBank",["deposit"|"count"|"withdraw", n]}
// ctx = { skills, world, mc, Vec3, log }
import fs from 'fs';
import path from 'path';
const CHEST_FILE = path.resolve(process.cwd(), 'bots', '_supervisor', 'chest.json');
const readPos = () => { try { return JSON.parse(fs.readFileSync(CHEST_FILE, 'utf8')); } catch (e) { return null; } };
const writePos = (p) => { try { fs.writeFileSync(CHEST_FILE, JSON.stringify(p)); } catch (e) {} };

export default async function diamondBank(bot, ctx, action = 'count', n = 0) {
    const { skills, world, mc, Vec3, log } = ctx;
    const has = (x) => world.getInventoryCounts(bot)[x] || 0;
    const id = mc.getItemId('diamond');

    // Locate our chest: nearby, or pathfind to the saved position.
    let chest = world.getNearestBlock(bot, 'chest', 5);
    if (!chest) {
        const saved = readPos();
        if (saved) {
            try { await skills.goToPosition(bot, saved.x, saved.y, saved.z, 2); } catch (e) {}
            chest = world.getNearestBlock(bot, 'chest', 5);
        }
    }
    // For deposit: if still no chest, make+place one here and remember it.
    if (!chest && action === 'deposit') {
        if (has('chest') < 1) await skills.customSkill(bot, 'achieve', { item: 'chest', count: 1 }).catch(() => {});
        if (has('chest') >= 1) {
            await skills.placeBlockNearby(bot, 'chest').catch(() => {});
            chest = world.getNearestBlock(bot, 'chest', 5);
            if (chest) writePos({ x: chest.position.x, y: chest.position.y, z: chest.position.z });
        }
    }
    // ★'count' = CHEST-ONLY (kernel-contract audit 2026-07-02): the happy path below returns
    // inChest(), and the sole caller (mineDiamonds) adds dia() itself everywhere (`banked+dia()`,
    // `banked>=count` withdraw guard, gained baseline). Returning has('diamond') here DOUBLE-
    // COUNTED held diamonds when the chest was missing/unreachable: phantom-skipped the mining
    // loop and corrupted mineDiamonds' gain gate in both directions (deflation → false on a real
    // descent pickup; transient inflation → truthy on zero progress). No chest = 0 banked.
    if (!chest) { log(bot, 'diamondBank: no chest available'); return action === 'count' ? 0 : false; }

    try {
        const c = await bot.openChest(chest);
        const inChest = () => c.containerItems().filter(it => it.name === 'diamond').reduce((s, it) => s + it.count, 0);
        if (action === 'deposit') {
            const d = has('diamond');
            if (d > 0) { try { await c.deposit(id, null, d); } catch (e) { log(bot, `deposit err: ${e.message}`); } }
        } else if (action === 'withdraw') {
            const take = Math.min(n, inChest());
            if (take > 0) { try { await c.withdraw(id, null, take); } catch (e) { log(bot, `withdraw err: ${e.message}`); } }
        }
        const total = inChest();
        try { c.close(); } catch (e) {}
        log(bot, `diamondBank ${action}: chest=${total} inv=${has('diamond')}`);
        return action === 'count' ? total : true;
    } catch (e) {
        log(bot, `diamondBank open err: ${e.message}`);
        return action === 'count' ? 0 : false;   // ★chest-only semantics, same as the no-chest exit above
    }
}
