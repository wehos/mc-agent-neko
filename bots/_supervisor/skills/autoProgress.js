// Hot-reloadable ORCHESTRATION skill: drive the whole early-game progression by
// calling the other custom skills in dependency order. Condition-driven and
// RE-ENTRANT: each run checks current inventory and only does the missing
// stages, so calling it repeatedly (via run_skill, bypassing the LLM coder)
// recovers from any mid-stage interruption and keeps pushing toward the target.
// Invoked via: {"skill":"autoProgress","args":["diamond"]}
// target: 'wood' | 'stone' | 'iron' | 'diamond' (default 'diamond')
// ctx = { skills, world, mc, Vec3, log }
import fs from 'fs';
import path from 'path';
const PROG = path.resolve(process.cwd(), 'bots', '_supervisor', 'progress.txt');
const writeProg = (s) => { try { fs.appendFileSync(PROG, `[${new Date().toISOString()}] ${s}\n`); } catch (e) {} };

export default async function autoProgress(bot, ctx, target = 'diamond') {
    const { skills, world, log } = ctx;
    writeProg(`=== autoProgress(${target}) START ===`);
    const C = () => world.getInventoryCounts(bot);
    const has = (n) => (C()[n] || 0);
    const logs = () => Object.keys(C()).filter(k => k.endsWith('_log')).reduce((s, k) => s + C()[k], 0);
    const anyPick = () => has('wooden_pickaxe') || has('stone_pickaxe') || has('iron_pickaxe') || has('diamond_pickaxe');
    const cs = (name, ...a) => skills.customSkill(bot, name, ...a);
    const step = async (label, fn) => {
        writeProg(`START ${label} | inv=${JSON.stringify(C())}`);
        log(bot, `[autoProgress] ${label}`);
        try { await fn(); writeProg(`DONE  ${label} | y=${Math.floor(bot.entity.position.y)}`); }
        catch (e) { writeProg(`ERR   ${label}: ${e.message}`); log(bot, `[autoProgress] ${label} err: ${e.message}`); }
    };

    // 1. WOOD — always keep a buffer so we never softlock (no wood -> no table).
    if (logs() < 6) await step('chop wood', () => cs('chopWood', 12));
    // 2. WOODEN TOOLS (only if we have no pickaxe at all)
    if (!anyPick()) await step('wood tier', () => cs('craftChain', 'wood_tier'));
    if (target === 'wood') { log(bot, `done(wood) inv=${JSON.stringify(C())}`); return C(); }

    // 3. STONE
    if (has('cobblestone') < 20) await step('mine stone', () => skills.collectBlock(bot, 'stone', 18));
    // 4. STONE TOOLS + FURNACE
    if (!has('stone_pickaxe') && !has('iron_pickaxe') && !has('diamond_pickaxe')) await step('stone tier', () => cs('craftChain', 'stone_tier'));
    if (!has('furnace')) await step('furnace', () => cs('craftChain', 'stone_tier'));
    if (target === 'stone') { log(bot, `done(stone) inv=${JSON.stringify(C())}`); return C(); }

    // 4.5 STOCK PICKAXES — one stone pickaxe (132 uses) doesn't survive a deep
    // branch-mine; carry several so we don't end up pickaxe-less underground.
    if (!has('iron_pickaxe') && has('stone_pickaxe') < 3) {
        await step('stock stone pickaxes', async () => {
            for (let i = 0; i < 4 && has('stone_pickaxe') < 3; i++) {
                const before = has('stone_pickaxe');
                await skills.craftRecipe(bot, 'stone_pickaxe', 1).catch(() => {});
                if (has('stone_pickaxe') <= before) break; // no table nearby / out of mats
            }
        });
    }

    // 5. COAL (for fuel/torches) if short
    if (has('coal') < 5) await step('mine coal', () => skills.collectBlock(bot, 'coal_ore', 5));
    // 6. IRON — keep mining until we have enough raw_iron+ingots for a pickaxe
    // (a single branch-mine run often doesn't hit enough ore). Loop, capped.
    if (!has('iron_pickaxe')) {
        let g = 0;
        while ((has('iron_ingot') + has('raw_iron')) < 5 && g++ < 5) {
            // X-ray collect: finds iron ore within 64 blocks (iron generates
            // y0-64, reachable from the surface) and mines straight to it.
            await step(`mine iron ${g}`, () => skills.collectBlock(bot, 'iron', 6));
            if (has('iron_ingot') + has('raw_iron') < 5) await step(`dig down for more iron ${g}`, () => skills.digDown(bot, 8));
        }
    }
    // 7. SMELT raw iron
    if (!has('iron_pickaxe') && has('raw_iron') >= 1) await step('smelt iron', () => cs('smeltSafe', 'raw_iron', has('raw_iron')));
    // 8. IRON TOOLS
    if (!has('iron_pickaxe')) await step('iron tier', () => cs('craftChain', 'iron_tier'));
    if (target === 'iron') { log(bot, `done(iron) inv=${JSON.stringify(C())}`); return C(); }

    // 9. DIAMOND — only with an iron pickaxe; deep staircase mine.
    if (has('iron_pickaxe') && has('diamond') < 3) await step('mine diamond', () => cs('mineDiamonds', 3));

    log(bot, `[autoProgress] done. anyPick=${anyPick()} iron_pick=${has('iron_pickaxe')} diamond=${has('diamond')} logs=${logs()} inv=${JSON.stringify(C())}`);
    return C();
}
