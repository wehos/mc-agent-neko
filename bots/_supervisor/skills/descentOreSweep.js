// Bounded live-world ore sweep for descent skills. This deliberately scans only
// already-loaded blocks around the bot, yields while scanning, and mines one exposed
// vein per call. It never consults the save oracle or forces chunk loading.

const AIR = new Set(['air', 'cave_air', 'void_air']);
const FLUID = /^(?:water|flowing_water|lava|flowing_lava)$/;
const SIDES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const FAMILY_PRIORITY = Object.freeze({
    diamonds: 100,
    iron: 90,
    emerald: 85,
    gold: 75,
    lapis: 65,
    redstone: 55,
    coal: 45,
    copper: 20,
});

export function descentOreFamily(name) {
    const normalized = String(name || '').replace(/^deepslate_/, '');
    if (normalized === 'diamond_ore') return 'diamonds';
    if (normalized === 'emerald_ore') return 'emerald';
    if (normalized === 'iron_ore') return 'iron';
    if (normalized === 'gold_ore') return 'gold';
    if (normalized === 'lapis_ore') return 'lapis';
    if (normalized === 'redstone_ore') return 'redstone';
    if (normalized === 'coal_ore') return 'coal';
    if (normalized === 'copper_ore') return 'copper';
    return null;
}

function adjacentBlocks(bot, Vec3, position) {
    return SIDES.map(([dx, dy, dz]) => {
        try { return bot.blockAt(new Vec3(position.x + dx, position.y + dy, position.z + dz)); }
        catch (e) { return null; }
    });
}

function exposedAndDry(bot, Vec3, block) {
    const adjacent = adjacentBlocks(bot, Vec3, block.position);
    if (adjacent.some((value) => value && FLUID.test(value.name || ''))) return false;
    return adjacent.some((value) => !value || AIR.has(value.name));
}

function harvestableWithInventory(bot, block) {
    try {
        if (block.canHarvest(null)) return true;
        return bot.inventory.items().some((item) => block.canHarvest(item.type));
    } catch (e) { return false; }
}

function visible(bot, block) {
    try { return typeof bot.canSeeBlock !== 'function' || bot.canSeeBlock(block); }
    catch (e) { return false; }
}

const yieldEventLoop = () => new Promise((resolve) => setImmediate(resolve));

export async function collectLiveOreBlock(bot, ctx, target, {
    expectedFamily = null,
    approach = false,
    maxApproachDistance = 10,
    maxBlocks = 6,
    budgetMs = 4500,
} = {}) {
    const { skills, Vec3 } = ctx;
    if (!target || !target.position || !skills || typeof skills.breakBlockAt !== 'function') {
        return { mined: 0, family: null, reason: 'unavailable' };
    }
    const startedAt = Date.now();
    const targetPos = new Vec3(target.position.x, target.position.y, target.position.z);
    let first = null;
    try { first = bot.blockAt(targetPos); } catch (e) {}
    const family = descentOreFamily(first && first.name);
    if (!family || (expectedFamily && family !== expectedFamily)) return { mined: 0, family, reason: 'target-changed' };
    if (!exposedAndDry(bot, Vec3, first) || !harvestableWithInventory(bot, first)) {
        return { mined: 0, family, reason: 'unsafe-or-wrong-tool' };
    }
    const eyeDistance = () => bot.entity.position.offset(0, 1.62, 0).distanceTo(targetPos.offset(0.5, 0.5, 0.5));
    if (eyeDistance() > 4.6) {
        if (!approach || eyeDistance() > maxApproachDistance || typeof skills.goToPosition !== 'function') {
            return { mined: 0, family, reason: 'too-far' };
        }
        const remaining = Math.max(250, budgetMs - (Date.now() - startedAt));
        let approachTimer = null;
        try {
            await Promise.race([
                skills.goToPosition(bot, targetPos.x, targetPos.y, targetPos.z, 2),
                new Promise((_, reject) => { approachTimer = setTimeout(() => reject(new Error('live-ore-approach-timeout')), remaining); }),
            ]);
        } catch (e) {
            try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
            try { bot.clearControlStates(); } catch (_) {}
            if (typeof skills.isUndergroundMiningWaterSafetyError === 'function'
                && skills.isUndergroundMiningWaterSafetyError(e)) throw e;
            return { mined: 0, family, reason: 'approach-failed' };
        } finally {
            if (approachTimer) clearTimeout(approachTimer);
        }
        try { first = bot.blockAt(targetPos); } catch (e) { first = null; }
        if (!first || descentOreFamily(first.name) !== family) return { mined: 0, family, reason: 'target-changed' };
    }
    if (eyeDistance() > 4.6 || !visible(bot, first) || !exposedAndDry(bot, Vec3, first)) {
        return { mined: 0, family, reason: 'not-live-reachable' };
    }

    const queue = [targetPos];
    const queued = new Set([`${targetPos.x},${targetPos.y},${targetPos.z}`]);
    let mined = 0;
    while (queue.length && mined < maxBlocks && Date.now() - startedAt < budgetMs) {
        if (bot.interrupt_code || bot.health <= 0) break;
        const position = queue.shift();
        let block = null;
        try { block = bot.blockAt(new Vec3(position.x, position.y, position.z)); } catch (e) {}
        if (!block || descentOreFamily(block.name) !== family) continue;
        if (!exposedAndDry(bot, Vec3, block) || !visible(bot, block) || !harvestableWithInventory(bot, block)) continue;
        if (bot.entity.position.offset(0, 1.62, 0).distanceTo(block.position.offset(0.5, 0.5, 0.5)) > 4.6) continue;
        let ok = false;
        try { ok = await skills.breakBlockAt(bot, block.position.x, block.position.y, block.position.z); } catch (e) {}
        if (!ok) continue;
        mined++;
        for (const [dx, dy, dz] of SIDES) {
            const next = new Vec3(position.x + dx, position.y + dy, position.z + dz);
            const key = `${next.x},${next.y},${next.z}`;
            if (queued.has(key)) continue;
            queued.add(key);
            let adjacent = null;
            try { adjacent = bot.blockAt(next); } catch (e) {}
            if (adjacent && descentOreFamily(adjacent.name) === family) queue.push(next);
        }
        await yieldEventLoop();
    }
    if (mined && typeof skills.pickupNearbyItems === 'function') {
        try { await skills.pickupNearbyItems(bot); }
        catch (e) {
            if (typeof skills.isUndergroundMiningWaterSafetyError === 'function'
                && skills.isUndergroundMiningWaterSafetyError(e)) throw e;
        }
    }
    return { mined, family, reason: mined ? 'mined' : 'candidate-not-mined', elapsedMs: Date.now() - startedAt };
}

export async function collectExposedOresDuringDescent(bot, ctx, {
    radius = 3,
    vertical = 2,
    maxBlocks = 6,
    budgetMs = 4500,
    families = null,
} = {}) {
    const { skills, Vec3 } = ctx;
    if (!bot || !bot.entity || !bot.entity.position || !skills || typeof skills.breakBlockAt !== 'function') {
        return { mined: 0, family: null, reason: 'unavailable' };
    }
    const startedAt = Date.now();
    const origin = bot.entity.position.floored();
    const eye = () => bot.entity.position.offset(0, 1.62, 0);
    const candidates = [];
    let probes = 0;
    for (let dy = -vertical; dy <= vertical; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dz = -radius; dz <= radius; dz++) {
                if (++probes % 64 === 0) await yieldEventLoop();
                let block = null;
                try { block = bot.blockAt(new Vec3(origin.x + dx, origin.y + dy, origin.z + dz)); } catch (e) {}
                const family = descentOreFamily(block && block.name);
                if (families && !families.includes(family)) continue;
                if (!family || !block || !exposedAndDry(bot, Vec3, block)) continue;
                if (!harvestableWithInventory(bot, block) || !visible(bot, block)) continue;
                const distance = eye().distanceTo(block.position.offset(0.5, 0.5, 0.5));
                if (distance > 4.6) continue;
                candidates.push({ block, family, distance });
            }
        }
    }
    candidates.sort((a, b) => (FAMILY_PRIORITY[b.family] || 0) - (FAMILY_PRIORITY[a.family] || 0)
        || a.distance - b.distance);
    if (!candidates.length) return { mined: 0, family: null, reason: 'none-safe-exposed' };

    return collectLiveOreBlock(bot, ctx, candidates[0].block, {
        expectedFamily: candidates[0].family,
        maxBlocks,
        budgetMs: Math.max(500, budgetMs - (Date.now() - startedAt)),
    });
}
