// Hot-reloadable STRATEGY skill: deposit IRREPLACEABLE valuables (and spare gear) into
// the HOME chest so a death doesn't wipe the accumulated investment. This is the gear
// generalization of diamondBank.
//
// ★ Respects the user's "家是一体的" rule: the bank chest is ANCHORED to home (the bed),
// never scattered. Anchor priority: bed.json (the home center we set) → chest.json (the
// existing diamondBank). If NEITHER exists we DO NOT drop a random chest in the wild —
// we defer (a wild chest is exactly the litter we're avoiding); banking waits until we
// have a home/bed. Full re-arm-after-death value also needs the bed (so respawn lands at
// the chest) — until then this still protects valuables from being lost on death.
//
// Trigger (caller decides): have valuables + near home + safe (not mid-fight).
// Invoked via: {"skill":"bankGear"} or customSkill(bot,'bankGear')
// ctx = { skills, world, mc, Vec3, log }
import fs from 'fs';
import path from 'path';
const SUP = path.resolve(process.cwd(), 'bots', '_supervisor');
const PROG = path.join(SUP, 'progress.txt');
const BEDF = path.join(SUP, 'bed.json');
const CHESTF = path.join(SUP, 'chest.json');
const BANKF = path.join(SUP, 'bank.json');
const SPAWNF = path.join(SUP, 'spawn_pos.json');
const prog = (s) => { try { fs.appendFileSync(PROG, `[${new Date().toISOString()}] ${s}\n`); } catch (e) {} };
// Valid world-spawn fallback anchor: present, numeric, and not the (0,0) sentinel.
const validSpawn = (sp) => sp && typeof sp.x === 'number' && typeof sp.z === 'number' && !(sp.x === 0 && sp.z === 0);

export default async function bankGear(bot, ctx) {
    const { skills, world, log } = ctx;
    const has = (n) => world.getInventoryCounts(bot)[n] || 0;
    const HOSTILE = /zombie|skeleton|creeper|spider|witch|enderman|drowned|husk|stray|phantom|slime|piglin|silverfish|cave_spider|pillager|vindicator/i;
    const hostilesNear = (r = 12) => Object.values(bot.entities).filter(e => e && e.position && e.name && HOSTILE.test(e.name) && e.position.distanceTo(bot.entity.position) < r).length;

    // 1) HOME ANCHOR (bed-centric). bed.json → chest.json → world spawn fallback.
    //    With no bed (this jungle has no sheep → bed.json never lands), anchor the bank at
    //    the world spawn point: a naked respawn always lands there, so the recovery chest is
    //    reachable. Only if even spawnPoint is missing/(0,0) do we defer (never scatter wild).
    let anchor = null, src = null;
    try { const b = JSON.parse(fs.readFileSync(BEDF, 'utf8')); if (typeof b.x === 'number') { anchor = b; src = 'bed'; } } catch (e) {}
    if (!anchor) { try { const c = JSON.parse(fs.readFileSync(CHESTF, 'utf8')); if (typeof c.x === 'number') { anchor = c; src = 'chest'; } } catch (e) {} }
    // spawn_pos.json = the bot's *actual* recorded respawn coordinate (written by agent.js
    // monitorRespawn). On this LAN server bot.spawnPoint is the (0,0) sentinel, so this is the
    // only reliable spawn anchor. No (0,0) filter: it's a measured position, trust it as-is.
    if (!anchor) { try { const s = JSON.parse(fs.readFileSync(SPAWNF, 'utf8')); if (typeof s.x === 'number') { anchor = { x: s.x, y: s.y, z: s.z }; src = 'respawn'; } } catch (e) {} }
    if (!anchor && validSpawn(bot.spawnPoint)) { anchor = { x: bot.spawnPoint.x, y: bot.spawnPoint.y, z: bot.spawnPoint.z }; src = 'spawn'; }
    // DIAGNOSTIC: log the actual spawnPoint so progress.txt reveals whether it's a real
    // world spawn or the (0,0) sentinel (which would invalidate the spawn-anchored bank).
    try { const sp = bot.spawnPoint; prog(`bankGear: bot.spawnPoint=${sp ? `${sp.x},${sp.y},${sp.z}` : 'null'} anchorSrc=${src || 'none'}`); } catch (e) {}
    if (!anchor) { prog('bankGear: no home/bed/spawn anchor — skip (won\'t scatter a wild chest; build home first)'); return false; }

    // 2) What to bank: irreplaceable raw valuables + SPARE gear (keep 1 of each tool/armor
    //    we use; never strip what we're relying on). Equipped armor is not in these counts.
    const inv = world.getInventoryCounts(bot);
    const RAW = /^diamond$|^emerald$|^gold_ingot$|^raw_gold$|^netherite_|^ancient_debris$|^diamond_block$|^lapis_lazuli$/;
    const GEAR = /^(diamond|iron|netherite)_(sword|pickaxe|axe|shovel|hoe|helmet|chestplate|leggings|boots)$|^shield$/;
    // ★环1: LOW-TIER bot also banks — store SPARE materials + low-tier weapons/tools so a
    // perpetually-wooden/stone bot's bank actually has goods (death recovery can then craft
    // tools instead of respawning empty). Keep enough of each for self-use; bank the surplus.
    // [regex, keep] — bank (count - keep) when count > keep; keep=0 banks all.
    const MAT = [
        [/_planks$/, 8],
        [/_log$/, 8],
        [/^cobblestone$/, 16],
        [/^coal$/, 4],
        [/^iron_ingot$/, 2],
        [/^raw_iron$/, 0],   // raw_iron: bank all (smelt from the bank later)
        [/^stick$/, 4],
        [/^torch$/, 8],
    ];
    // Low-tier weapons/tools (wooden/stone/golden swords/picks/axes/shovels): bank spares,
    // keep one. The high-tier GEAR regex above already covers diamond/iron/netherite.
    const LOWTOOL = /^(wooden|stone|golden)_(sword|pickaxe|axe|shovel)$/;
    const plan = [];
    for (const n of Object.keys(inv)) {
        if (RAW.test(n)) { plan.push([n, -1]); continue; }                 // bank all raw valuables
        if (GEAR.test(n) && inv[n] > 1) { plan.push([n, inv[n] - 1]); continue; } // hi-tier spares, keep one
        if (LOWTOOL.test(n) && inv[n] > 1) { plan.push([n, inv[n] - 1]); continue; } // low-tier spares, keep one
        const m = MAT.find(([re]) => re.test(n));
        if (m) { const surplus = inv[n] - m[1]; if (surplus > 0) plan.push([n, surplus]); } // bank surplus material
    }
    if (plan.length === 0) { prog('bankGear: nothing valuable to bank'); return false; }
    if (hostilesNear(12) > 0) { prog(`bankGear: unsafe (mobs=${hostilesNear(12)}) — defer`); return false; }

    // 3) Go to home, ensure a chest there (place ONE at the anchor if missing — this is the
    //    home chest, not litter), deposit.
    try { await skills.goToPosition(bot, anchor.x, anchor.y, anchor.z, 2); } catch (e) {}
    let chest = await world.getNearestBlockAsync(bot, 'chest', 6);
    if (!chest) {
        if (has('chest') < 1) { try { await skills.craftRecipe(bot, 'chest', 1); } catch (e) {} }
        if (has('chest') > 0) { try { await skills.placeBlockNearby(bot, 'chest'); } catch (e) {} chest = await world.getNearestBlockAsync(bot, 'chest', 6); }
    }
    if (!chest) { prog('bankGear: no chest at home and could not place one — defer'); return false; }

    // Persist the bank chest location so bankRecover (death recovery) can find it on a
    // naked respawn even when no bed exists.
    try { const p = chest.position; fs.writeFileSync(BANKF, JSON.stringify({ x: p.x, y: p.y, z: p.z, t: Date.now() })); } catch (e) {}

    let banked = [];
    for (const [n, count] of plan) {
        if (bot.interrupt_code) break;
        // ★kernel-contract audit 2026-07-02: putInChest returns false WITHOUT throwing (item
        // lookup miss, no chest) and THROWS on a full chest (container.deposit) — only count a
        // deposit when it reports true, so `banked` is a real progress record, not a wish list.
        try { const ok = await skills.putInChest(bot, n, count); if (ok) banked.push(`${n}x${count === -1 ? 'all' : count}`); } catch (e) { prog(`bankGear: put ${n} err ${e.message}`); }
    }
    prog(`bankGear: deposited [${banked.join(' ')}] @home(${src})`);
    log(bot, `Banked valuables at home: ${banked.join(', ')}`);
    // ★bank manifest (checkpoint #3, 2026-07-02: 13 banked ingots stranded across three
    // checkpoints — bankRecover's opportunistic top-up can't know WHAT is banked, so its
    // fetch radius had to stay tiny and never fired). Snapshot the chest contents after
    // every deposit; the recover side reads it to justify a longer fetch only when the
    // manifest PROVES the metal is there. Best-effort (one extra open at the chest).
    try {
        const c2 = await bot.openContainer(chest);
        const items = {};
        for (const it of c2.containerItems()) if (it && it.name) items[it.name] = (items[it.name] || 0) + it.count;
        try { await c2.close(); } catch (e) {}
        fs.writeFileSync(path.join(SUP, 'bank_manifest.json'),
            JSON.stringify({ x: chest.position.x, y: chest.position.y, z: chest.position.z, t: Date.now(), items }, null, 2));
    } catch (e) {}
    // ★kernel-contract audit 2026-07-02: a bare `return true` here was reachable with ZERO
    // deposits (full home chest → every put throws & is swallowed above; or interrupt before
    // the first put). Kernel counts FAILED iff threw/false/{failed:true} (kernel.js ~296), and
    // isGoalDone(BANK_GEAR) = diamondsOnHand<1 || !packNearlyFull (world_model.js ~1010) stays
    // false while the diamonds never leave the full pack — so the stale truthy reset the
    // 3-strike counter every ~2s and BANK_GEAR@58 hot-livelocked above GET_BED@50 / tier@45-47 /
    // endgame@52-53. Truthy ONLY when THIS dispatch moved items into the chest; a futile run
    // fails so 3 strikes trip the 5-min kind cooldown and release the commitment, and an
    // interrupt-before-first-put unwinds as non-success (kernel's cancel window exempts it
    // from striking).
    return banked.length > 0 ? true : { failed: true, reason: 'bank run deposited nothing (chest full / puts failed / interrupted)' };
}
