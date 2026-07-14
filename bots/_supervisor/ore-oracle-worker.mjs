import fs from 'fs';
import path from 'path';
import { parentPort } from 'worker_threads';
import anvilPkg from 'prismarine-provider-anvil';
import minecraftData from 'minecraft-data';
import {
    MAX_SCAN_CHUNK_RADIUS,
    MIN_SCAN_CHUNK_RADIUS,
    ORACLE_DATA_TTL_MS,
    filterClearedEntries,
} from './oracle_shared.mjs';

const CACHE_TTL_MS = 5 * 60 * 1000;
const QUOTA = { diamonds: 16, iron: 24, gold: 16, coal: 16, copper: 16 };
const PROGRESS_RADII = new Set([2, 4, 8, MIN_SCAN_CHUNK_RADIUS]);
const chunkCache = new Map();
let cacheWorldId = null;

function regionFileFor(cx, cz) { return `r.${cx >> 5}.${cz >> 5}.mca`; }

async function fileSignature(file) {
    try {
        const st = await fs.promises.stat(file);
        return `${st.mtimeMs}:${st.size}`;
    } catch (e) {
        return null;
    }
}

function buildRegistry(version) {
    const mcData = minecraftData(version) || minecraftData('1.21.1');
    const oreFamilies = {
        diamonds: ['diamond_ore', 'deepslate_diamond_ore'],
        iron: ['iron_ore', 'deepslate_iron_ore'],
        gold: ['gold_ore', 'deepslate_gold_ore'],
        coal: ['coal_ore', 'deepslate_coal_ore'],
        copper: ['copper_ore', 'deepslate_copper_ore'],
        water: ['water'],
    };
    const surfaceFamilies = {
        wood: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'],
        village: ['bell', 'composter', 'hay_block'],
    };
    const stateFamily = new Map();
    const surfaceFamily = new Map();
    const allStates = new Set();
    const add = (families, target) => {
        for (const [family, names] of Object.entries(families)) {
            for (const name of names) {
                const block = mcData.blocksByName[name];
                if (!block) continue;
                for (let sid = block.minStateId; sid <= block.maxStateId; sid++) {
                    target.set(sid, family);
                    allStates.add(sid);
                }
            }
        }
    };
    add(oreFamilies, stateFamily);
    add(surfaceFamilies, surfaceFamily);
    return { mcData, oreFamilies, surfaceFamilies, stateFamily, surfaceFamily, allStates };
}

function chunkNearCleared(cx, cz, cleared) {
    const wx = cx * 16 + 8;
    const wz = cz * 16 + 8;
    return cleared.some((c) => Math.hypot((c.x || 0) - wx, (c.z || 0) - wz) <= ((c.r || 12) + 16));
}

function dropCleared(list, family, cleared) {
    return list.filter((ore) => !cleared.some((c) => c.ore === family
        && Math.hypot((c.x || 0) - ore.x, (c.y || 0) - ore.y, (c.z || 0) - ore.z) <= (c.r || 12)));
}

function scanChunk(chunk, cx, cz, registry) {
    const ores = { diamonds: [], iron: [], gold: [], coal: [], copper: [], water: [], wood: [], village: [] };
    let skippedSections = 0;
    const sectionHasTarget = (sectionY) => {
        try {
            const sections = chunk.sections;
            if (!Array.isArray(sections)) return true;
            const index = sectionY - (chunk.minY ? chunk.minY / 16 : -4);
            const section = sections[index];
            const palette = section && (section.palette || (section.data && section.data.palette));
            if (!palette) return true;
            const values = Array.isArray(palette) ? palette : (typeof palette.values === 'function' ? palette.values() : null);
            if (!values) return true;
            for (const value of values) {
                const sid = typeof value === 'number' ? value : value && value.stateId;
                if (registry.allStates.has(sid)) return true;
            }
            return false;
        } catch (e) {
            return true;
        }
    };
    for (let sectionY = -4; sectionY <= 7; sectionY++) {
        if (!sectionHasTarget(sectionY)) { skippedSections++; continue; }
        const yLo = Math.max(sectionY * 16, -60);
        const yHi = Math.min(sectionY * 16 + 15, 127);
        for (let y = yLo; y <= yHi; y++) {
            for (let lx = 0; lx < 16; lx++) {
                for (let lz = 0; lz < 16; lz++) {
                    let stateId;
                    try { stateId = chunk.getBlockStateId({ x: lx, y, z: lz }); } catch (e) { continue; }
                    const x = cx * 16 + lx;
                    const z = cz * 16 + lz;
                    const oreFamily = registry.stateFamily.get(stateId);
                    if (oreFamily) {
                        if (y > 95) continue;
                        if (oreFamily === 'water' && (y < 58 || y > 70 || ores.water.length >= 32)) continue;
                        ores[oreFamily].push({ x, y, z });
                        continue;
                    }
                    const surfaceFamily = registry.surfaceFamily.get(stateId);
                    if (surfaceFamily === 'wood') {
                        if (y >= 58 && y <= 120 && ores.wood.length < 48) ores.wood.push({ x, y, z });
                    } else if (surfaceFamily === 'village') {
                        if (y >= 55 && y <= 110 && ores.village.length < 8) ores.village.push({ x, y, z });
                    }
                }
            }
        }
    }
    return { ores, skippedSections };
}

async function loadStableChunk(anvil, AnvilCls, region, cx, cz, stats, firstSignature) {
    const file = path.join(region, regionFileFor(cx, cz));
    for (let attempt = 0; attempt < 2; attempt++) {
        const before = attempt === 0 ? firstSignature : await fileSignature(file);
        if (!before) return { chunk: null, signature: null };
        let chunk = null;
        try { chunk = await (attempt === 0 ? anvil : new AnvilCls(region)).load(cx, cz); } catch (e) {}
        const after = await fileSignature(file);
        if (chunk && before === after) return { chunk, signature: after };
        stats.unstableReads++;
    }
    return { chunk: null, signature: null };
}

async function getChunkOres({ anvil, AnvilCls, region, worldId, cx, cz, cleared, stats, registry, signatureCache }) {
    const file = path.join(region, regionFileFor(cx, cz));
    let signature = signatureCache.get(file);
    if (signature === undefined) {
        signature = await fileSignature(file);
        signatureCache.set(file, signature);
    }
    if (!signature) { stats.missingChunks++; return null; }
    const key = `${worldId}:${cx},${cz}`;
    const phantom = chunkNearCleared(cx, cz, cleared);
    const cached = chunkCache.get(key);
    if (cached && !phantom && cached.signature === signature && Date.now() - cached.ts < CACHE_TTL_MS) {
        stats.cacheHits++;
        return cached.ores;
    }
    if (phantom) chunkCache.delete(key);
    const stable = await loadStableChunk(anvil, AnvilCls, region, cx, cz, stats, signature);
    if (!stable.chunk) { stats.missingChunks++; return null; }
    signatureCache.set(file, stable.signature);
    const scanned = scanChunk(stable.chunk, cx, cz, registry);
    stats.scannedChunks++;
    stats.skippedSections += scanned.skippedSections;
    if (!phantom) chunkCache.set(key, { signature: stable.signature, ts: Date.now(), ores: scanned.ores });
    return scanned.ores;
}

function* ringChunks(centerX, centerZ, radius) {
    if (radius === 0) { yield [centerX, centerZ]; return; }
    for (let d = -radius; d <= radius; d++) {
        yield [centerX + d, centerZ - radius];
        yield [centerX + d, centerZ + radius];
    }
    for (let d = -radius + 1; d <= radius - 1; d++) {
        yield [centerX - radius, centerZ + d];
        yield [centerX + radius, centerZ + d];
    }
}

function snapshotFor({ found, liveCleared, stats, vit, worldId, region, version, reachedRadius, startedAt, final }) {
    const visible = Object.fromEntries(Object.entries(found).map(([family, entries]) => [
        family,
        dropCleared(entries, family, liveCleared),
    ]));
    if (visible.wood.length) {
        const roots = new Map();
        for (const wood of visible.wood) {
            const key = `${wood.x},${wood.z}`;
            const current = roots.get(key);
            if (!current || wood.y < current.y) roots.set(key, wood);
        }
        visible.wood = [...roots.values()];
    }
    const distance = (value) => Math.hypot(value.x - vit.x, value.y - vit.y, value.z - vit.z);
    for (const family of Object.keys(visible)) visible[family].sort((a, b) => distance(a) - distance(b));
    const ts = Date.now();
    const coverageComplete = reachedRadius >= MIN_SCAN_CHUNK_RADIUS;
    return {
        ts,
        expiresAt: ts + ORACLE_DATA_TTL_MS,
        worldId,
        worldRegion: region,
        version,
        warming: !coverageComplete,
        extending: coverageComplete && !final,
        coverageComplete,
        botPos: { x: Math.round(vit.x), y: Math.round(vit.y), z: Math.round(vit.z) },
        minCoverageBlocks: MIN_SCAN_CHUNK_RADIUS * 16,
        reachedRadius,
        reachedBlocks: reachedRadius * 16,
        scanMs: ts - startedAt,
        ...stats,
        totalFound: visible.diamonds.length,
        totals: {
            diamonds: visible.diamonds.length,
            iron: visible.iron.length,
            gold: visible.gold.length,
            coal: visible.coal.length,
            copper: visible.copper.length,
            water: visible.water.length,
            wood: visible.wood.length,
            village: visible.village.length,
        },
        diamonds: visible.diamonds.slice(0, 16),
        iron: visible.iron.slice(0, 24),
        ironDeep: visible.iron.filter((ore) => ore.y <= 50).slice(0, 16),
        gold: visible.gold.slice(0, 16),
        coal: visible.coal.slice(0, 16),
        copper: visible.copper.slice(0, 16),
        water: visible.water.slice(0, 8),
        wood: visible.wood.slice(0, 24),
        village: visible.village.slice(0, 8),
    };
}

export async function scanOracle({ region, worldId, vit, cleared = [], version = '1.21.1' }, onProgress = null) {
    const startedAt = Date.now();
    if (cacheWorldId !== worldId) {
        chunkCache.clear();
        cacheWorldId = worldId;
    }
    const registry = buildRegistry(version);
    const AnvilCls = anvilPkg.Anvil(registry.mcData.version.minecraftVersion);
    const anvil = new AnvilCls(region); // fresh once per scan; unstable chunks get a one-off retry instance
    const liveCleared = filterClearedEntries(cleared, { worldId });
    const found = { diamonds: [], iron: [], gold: [], coal: [], copper: [], water: [], wood: [], village: [] };
    const stats = { scannedChunks: 0, missingChunks: 0, skippedSections: 0, cacheHits: 0, unstableReads: 0 };
    const signatureCache = new Map(); // one stat per .mca for cache hits; publish gate detects mid-scan autosaves
    const centerX = Math.floor(vit.x / 16);
    const centerZ = Math.floor(vit.z / 16);
    const quotaMet = () => Object.entries(QUOTA).every(([family, count]) => found[family].length >= count);
    let reachedRadius = 0;
    for (let radius = 0; radius <= MAX_SCAN_CHUNK_RADIUS; radius++) {
        for (const [cx, cz] of ringChunks(centerX, centerZ, radius)) {
            const ores = await getChunkOres({ anvil, AnvilCls, region, worldId, cx, cz, cleared: liveCleared, stats, registry, signatureCache });
            if (!ores) continue;
            for (const family of Object.keys(found)) found[family].push(...(ores[family] || []));
        }
        reachedRadius = radius;
        const finished = radius >= MIN_SCAN_CHUNK_RADIUS && quotaMet();
        if (onProgress && PROGRESS_RADII.has(radius) && !finished) {
            await onProgress(snapshotFor({
                found, liveCleared, stats, vit, worldId, region,
                version: registry.mcData.version.minecraftVersion,
                reachedRadius, startedAt, final: false,
            }));
        }
        if (finished) break;
    }
    if (chunkCache.size > 8192) {
        for (const key of chunkCache.keys()) {
            if (chunkCache.size <= 4096) break;
            chunkCache.delete(key);
        }
    }
    return snapshotFor({
        found, liveCleared, stats, vit, worldId, region,
        version: registry.mcData.version.minecraftVersion,
        reachedRadius, startedAt, final: true,
    });
}

if (parentPort) {
    parentPort.on('message', async (message) => {
        if (!message || message.type !== 'scan') return;
        try {
            const snapshot = await scanOracle(message.payload, (progress) => {
                parentPort.postMessage({ type: 'progress', requestId: message.requestId, snapshot: progress });
            });
            parentPort.postMessage({ type: 'result', requestId: message.requestId, snapshot });
        } catch (error) {
            parentPort.postMessage({ type: 'error', requestId: message.requestId, error: error && (error.stack || error.message) || String(error) });
        }
    });
}
