import path from 'path';
import {
    ORACLE_CLEARED_TTL_MS,
    atomicWriteJson,
    filterClearedEntries,
    oracleSnapshotFresh,
    readJson,
} from '../oracle_shared.mjs';

const CLEARED = path.resolve(process.cwd(), 'bots', '_supervisor', 'ore-cleared.json');
const EXPECTED = {
    diamonds: new Set(['diamond_ore', 'deepslate_diamond_ore']),
    iron: new Set(['iron_ore', 'deepslate_iron_ore']),
    gold: new Set(['gold_ore', 'deepslate_gold_ore']),
    coal: new Set(['coal_ore', 'deepslate_coal_ore']),
    copper: new Set(['copper_ore', 'deepslate_copper_ore']),
    water: new Set(['water', 'flowing_water']),
    wood: new Set(['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log']),
    village: new Set(['bell', 'composter', 'hay_block']),
};

export function oracleFamily(ore) {
    const name = String(ore || '').toLowerCase();
    if (name === 'diamond') return 'diamonds';
    return name;
}

export function freshOracleSnapshot(snapshot, now = Date.now()) {
    return oracleSnapshotFresh(snapshot, now);
}

export function arrivedAtOracleTarget(bot, target, { horizontal = 12, vertical = 8 } = {}) {
    try {
        const p = bot.entity.position;
        return Math.hypot(target.x - p.x, target.z - p.z) <= horizontal
            && Math.abs(target.y - p.y) <= vertical;
    } catch (e) { return false; }
}

// Returns present | absent | unknown | too-far. `absent` is authoritative only after
// the bot is close enough for the target chunk/section to be live in mineflayer.
export function liveOracleTargetState(bot, Vec3, target, ore, maxDistance = 16) {
    try {
        if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y) || !Number.isFinite(target.z)) return 'unknown';
        const p = bot.entity.position;
        if (Math.hypot(target.x - p.x, target.y - p.y, target.z - p.z) > maxDistance) return 'too-far';
        const block = bot.blockAt(new Vec3(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z)));
        if (!block) return 'unknown';
        const expected = EXPECTED[oracleFamily(ore)];
        if (!expected) return 'unknown';
        return expected.has(block.name) ? 'present' : 'absent';
    } catch (e) { return 'unknown'; }
}

export function targetCleared(target, ore, cleared) {
    const family = oracleFamily(ore);
    return (Array.isArray(cleared) ? cleared : []).some((entry) => entry && entry.ore === family
        && Math.hypot(entry.x - target.x, entry.y - target.y, entry.z - target.z) <= (entry.r || 12));
}

export async function loadClearedTargets(worldId) {
    const file = await readJson(CLEARED, { cleared: [] });
    return filterClearedEntries(file && file.cleared, { worldId });
}

export async function markOracleTargetCleared(snapshot, ore, target, reason = 'live-target-absent') {
    if (!snapshot || !snapshot.worldId || !target) return false;
    const now = Date.now();
    const current = await readJson(CLEARED, { cleared: [] });
    const cleared = filterClearedEntries(current && current.cleared, { now, worldId: snapshot.worldId });
    const family = oracleFamily(ore);
    if (!targetCleared(target, family, cleared)) {
        cleared.push({
            ore: family,
            x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z),
            r: 12,
            ts: now,
            expiresAt: now + ORACLE_CLEARED_TTL_MS,
            worldId: snapshot.worldId,
            reason,
        });
    }
    await atomicWriteJson(CLEARED, { ts: now, worldId: snapshot.worldId, cleared: cleared.slice(-256) });
    return true;
}
