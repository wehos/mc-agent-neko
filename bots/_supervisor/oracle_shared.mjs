import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const ORACLE_DATA_TTL_MS = 2 * 60 * 1000;
export const ORACLE_CLEARED_TTL_MS = 20 * 60 * 1000;
export const WORLD_FRESH_MS = 15 * 60 * 1000;
export const MIN_SCAN_CHUNK_RADIUS = 16; // full +/-256 block square around the bot
export const MAX_SCAN_CHUNK_RADIUS = 24;

export function normalizeRegion(region) {
    return path.resolve(String(region || '')).replace(/\\/g, '/').toLowerCase();
}

export function worldIdForRegion(region) {
    return crypto.createHash('sha256').update(normalizeRegion(region)).digest('hex').slice(0, 16);
}

export function oracleSnapshotFresh(snapshot, now = Date.now(), expectedWorldId = null) {
    if (!snapshot || !Number.isFinite(snapshot.ts)) return false;
    const expiresAt = Number.isFinite(snapshot.expiresAt)
        ? snapshot.expiresAt
        : snapshot.ts + ORACLE_DATA_TTL_MS;
    if (now >= expiresAt) return false;
    if (expectedWorldId && snapshot.worldId !== expectedWorldId) return false;
    return true;
}

export function clearedEntryFresh(entry, now = Date.now(), expectedWorldId = null) {
    if (!entry || !Number.isFinite(entry.ts)) return false;
    const expiresAt = Number.isFinite(entry.expiresAt)
        ? entry.expiresAt
        : entry.ts + ORACLE_CLEARED_TTL_MS;
    if (now >= expiresAt) return false;
    if (expectedWorldId && entry.worldId !== expectedWorldId) return false;
    return true;
}

export function filterClearedEntries(entries, { now = Date.now(), worldId = null } = {}) {
    return (Array.isArray(entries) ? entries : []).filter((entry) => clearedEntryFresh(entry, now, worldId));
}

export async function readJson(file, fallback = null) {
    try {
        let raw = await fs.promises.readFile(file, 'utf8');
        if (raw && raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
        return JSON.parse(raw);
    } catch (e) {
        return fallback;
    }
}

export async function atomicWriteJson(file, value) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(value), 'utf8');
    await fs.promises.rename(tmp, file);
}

export async function regionInfo(region) {
    try {
        const names = await fs.promises.readdir(region);
        let newestMtime = 0;
        let count = 0;
        for (const name of names) {
            if (!name.endsWith('.mca')) continue;
            try {
                const st = await fs.promises.stat(path.join(region, name));
                count++;
                if (st.mtimeMs > newestMtime) newestMtime = st.mtimeMs;
            } catch (e) {}
        }
        return count ? { region: path.resolve(region), newestMtime, count } : null;
    } catch (e) {
        return null;
    }
}

export async function newestWorldRegion(savesRoot) {
    let worlds;
    try { worlds = await fs.promises.readdir(savesRoot); } catch (e) { return null; }
    let best = null;
    for (const world of worlds) {
        const info = await regionInfo(path.join(savesRoot, world, 'region'));
        if (info && (!best || info.newestMtime > best.newestMtime)) best = info;
    }
    return best;
}

export function sameRegion(a, b) {
    return !!a && !!b && normalizeRegion(a) === normalizeRegion(b);
}

