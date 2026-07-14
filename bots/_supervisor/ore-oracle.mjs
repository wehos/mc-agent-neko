// ORE ORACLE scheduler. All region IO and block scanning runs in a dedicated worker;
// this coordinator only resolves the active world, enforces generations/TTL, and
// atomically publishes staged snapshots while the worker expands to full coverage.
// It never shares the websocket process.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import {
    ORACLE_DATA_TTL_MS,
    WORLD_FRESH_MS,
    atomicWriteJson,
    filterClearedEntries,
    newestWorldRegion,
    readJson,
    regionInfo,
    sameRegion,
    worldIdForRegion,
} from './oracle_shared.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const VITALS = path.join(DIR, 'vitals.json');
const OUT = path.join(DIR, 'oracle-ores.json');
const STRUCTURE_OUT = path.join(DIR, 'oracle.json');
const CLEARED = path.join(DIR, 'ore-cleared.json');
const WORLD_STATE = path.join(DIR, 'world-id.json');
const PENDING_WORLD = path.join(DIR, 'oracle-world-pending.json');
const LOG = path.join(DIR, 'ore-oracle.log');
const SAVES_ROOT = process.env.ORE_SAVES || 'E:/MC/.minecraft/versions/1.21.4-Fabric 0.19.3/saves';
const LEGACY_REGION = 'C:/Users/Administrator/mc-server/world/region';
const POLL_MS = Math.max(15000, Number(process.env.ORE_POLL_MS) || 30000);
const COLD_RETRY_MS = 5000;
const WORKER_TIMEOUT_MS = Math.max(30000, Number(process.env.ORE_SCAN_TIMEOUT_MS) || 180000);

const log = async (message) => {
    try { await fs.promises.appendFile(LOG, `[${new Date().toISOString()}] ${message}\n`); } catch (e) {}
};

let worker = null;
let requestSeq = 0;
let inFlight = null;
let generation = 0;
let activeRegion = null;
let coldCandidate = null;
let coldCandidateHits = 0;
let timer = null;
let retrySoon = false;

function ensureWorker() {
    if (worker) return worker;
    const created = new Worker(new URL('./ore-oracle-worker.mjs', import.meta.url));
    worker = created;
    created.on('error', (error) => { log(`worker error: ${error && (error.stack || error.message) || error}`); });
    created.on('exit', (code) => {
        if (code !== 0) log(`worker exit code=${code}`);
        if (worker === created) worker = null;
        if (inFlight && inFlight.worker === created) {
            clearTimeout(inFlight.timeout);
            inFlight.reject(new Error(`oracle worker exited (${code})`));
            inFlight = null;
        }
    });
    created.on('message', (message) => {
        if (!inFlight || inFlight.worker !== created || !message || message.requestId !== inFlight.requestId) return;
        const pending = inFlight;
        if (message.type === 'progress') {
            pending.progressChain = pending.progressChain
                .then(() => pending.onProgress && pending.onProgress(message.snapshot))
                .catch((error) => log(`progress publish error: ${error && (error.stack || error.message) || error}`));
            return;
        }
        inFlight = null;
        clearTimeout(pending.timeout);
        if (message.type === 'result') {
            pending.progressChain.then(() => pending.resolve(message.snapshot));
        } else {
            pending.progressChain.then(() => pending.reject(new Error(message.error || 'oracle worker error')));
        }
    });
    return worker;
}

function scanInWorker(payload, onProgress = null) {
    if (inFlight) return Promise.reject(new Error('oracle scan already running'));
    const requestId = ++requestSeq;
    return new Promise((resolve, reject) => {
        const activeWorker = ensureWorker();
        const timeout = setTimeout(() => {
            if (!inFlight || inFlight.requestId !== requestId) return;
            const timedOutWorker = inFlight.worker;
            inFlight = null;
            try { if (timedOutWorker) timedOutWorker.terminate().catch(() => {}); } catch (e) {}
            if (worker === timedOutWorker) worker = null;
            reject(new Error(`oracle worker timeout after ${WORKER_TIMEOUT_MS}ms`));
        }, WORKER_TIMEOUT_MS);
        inFlight = { requestId, resolve, reject, timeout, worker: activeWorker, onProgress, progressChain: Promise.resolve() };
        activeWorker.postMessage({ type: 'scan', requestId, payload });
    });
}

async function confirmedRegion() {
    if (process.env.ORE_REGION) {
        const explicit = await regionInfo(process.env.ORE_REGION);
        if (explicit) return explicit;
        await log(`ORE_REGION invalid: ${process.env.ORE_REGION}`);
    }

    // world-id.json is written only after new-world-reset's freshness + debounce gate.
    // A different fresh newest candidate means a world transition is in progress: do
    // not keep publishing the old confirmed world while waiting for the reset daemon.
    const worldState = await readJson(WORLD_STATE, null);
    const confirmed = worldState && worldState.region ? await regionInfo(worldState.region) : null;
    const candidate = await newestWorldRegion(SAVES_ROOT) || await regionInfo(LEGACY_REGION);
    const candidateFresh = !!candidate && Date.now() - candidate.newestMtime <= WORLD_FRESH_MS;
    if (confirmed && Date.now() - confirmed.newestMtime <= WORLD_FRESH_MS
        && (!candidateFresh || sameRegion(confirmed.region, candidate.region))) {
            coldCandidate = null;
            coldCandidateHits = 0;
            return confirmed;
    }
    if (!candidateFresh) return null;
    if (sameRegion(coldCandidate, candidate.region)) coldCandidateHits++;
    else { coldCandidate = candidate.region; coldCandidateHits = 1; }
    // Cold start without world-id: require two independent observations. The scheduler
    // retries in 5s, so safety costs seconds rather than the old 1-6 minute blind window.
    return coldCandidateHits >= 2 ? candidate : null;
}

async function discardPublished(reason, { allOracle = false } = {}) {
    try { await fs.promises.rm(OUT, { force: true }); } catch (e) {}
    if (allOracle) { try { await fs.promises.rm(STRUCTURE_OUT, { force: true }); } catch (e) {} }
    await log(`snapshot discarded: ${reason}`);
}

async function markWorldPending(reason) {
    const ts = Date.now();
    // Must outlive the longest allowed cold scan; otherwise an old structure daemon
    // could republish during a slow first 256b pass and become visible mid-transition.
    try { await atomicWriteJson(PENDING_WORLD, { ts, expiresAt: ts + WORKER_TIMEOUT_MS + 60000, reason }); } catch (e) {}
}

async function runScan() {
    if (inFlight) return;
    const vit = await readJson(VITALS, null);
    if (!vit || !Number.isFinite(vit.x)) return;
    const dim = String(vit.dim || 'overworld');
    if (/nether|end/.test(dim)) { await discardPublished(`dimension=${dim}`); return; }

    const resolved = await confirmedRegion();
    if (!resolved) {
        await markWorldPending('cold-start/world-transition not confirmed');
        await discardPublished('cold-start/world-transition not confirmed', { allOracle: true });
        retrySoon = true;
        return;
    }
    if (!sameRegion(activeRegion, resolved.region)) {
        activeRegion = resolved.region;
        generation++;
        await markWorldPending(`world generation changed -> ${activeRegion}`);
        await discardPublished(`world generation changed -> ${activeRegion}`, { allOracle: true });
    }
    const committedWorld = await readJson(WORLD_STATE, null);
    if (committedWorld && committedWorld.region && !sameRegion(committedWorld.region, activeRegion)) {
        await markWorldPending('waiting for new-world-reset to commit the new generation');
        await discardPublished('new world candidate not committed yet', { allOracle: true });
        retrySoon = true;
        return;
    }
    const myGeneration = generation;
    const scanRegionMtime = resolved.newestMtime;
    const worldId = worldIdForRegion(activeRegion);
    const clearedFile = await readJson(CLEARED, { cleared: [] });
    const cleared = filterClearedEntries(clearedFile && clearedFile.cleared, { worldId });
    const version = String(vit.version || process.env.ORE_MC_VERSION || '1.21.1');
    const startedAt = Date.now();
    let scanInvalidated = false;
    const publishStage = async (snapshot, phase) => {
        if (scanInvalidated) return false;
        // Every partial result gets the same generation and autosave gates as the final
        // result. A later autosave invalidates and removes any earlier warm snapshot.
        const after = await confirmedRegion();
        if (myGeneration !== generation || !after || !sameRegion(after.region, activeRegion)) {
            scanInvalidated = true;
            retrySoon = true;
            await markWorldPending('worker stage belongs to stale world generation');
            await discardPublished('worker stage belongs to stale world generation', { allOracle: true });
            return false;
        }
        if (after.newestMtime !== scanRegionMtime) {
            scanInvalidated = true;
            retrySoon = true;
            await discardPublished('autosave changed region during staged scan; retry stable snapshot');
            return false;
        }
        const latestRegion = await regionInfo(activeRegion);
        if (!latestRegion || latestRegion.newestMtime !== after.newestMtime) {
            scanInvalidated = true;
            retrySoon = true;
            await discardPublished('region changed while finalizing scan stage; retry fresh');
            return false;
        }
        snapshot.generation = myGeneration;
        snapshot.expiresAt = snapshot.ts + ORACLE_DATA_TTL_MS;
        await atomicWriteJson(OUT, snapshot);
        try { await fs.promises.rm(PENDING_WORLD, { force: true }); } catch (e) {}
        await log(`published ${phase} world=${worldId} gen=${myGeneration} reached=${snapshot.reachedBlocks}b warming=${snapshot.warming} chunks=${snapshot.scannedChunks} cache=${snapshot.cacheHits} unstable=${snapshot.unstableReads} scan=${snapshot.scanMs}ms total=${Date.now() - startedAt}ms`);
        return true;
    };
    const snapshot = await scanInWorker(
        { region: activeRegion, worldId, vit, cleared, version },
        (partial) => publishStage(partial, 'progress'),
    );
    if (!scanInvalidated) await publishStage(snapshot, 'final');
}

function schedule(delay = POLL_MS) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
        retrySoon = false;
        try { await runScan(); } catch (error) { retrySoon = true; await log(`scan error: ${error && (error.stack || error.message) || error}`); }
        schedule(retrySoon ? COLD_RETRY_MS : POLL_MS);
    }, delay);
}

await log(`ore-oracle scheduler started pid=${process.pid} worker=true minCoverage=256b ttl=${ORACLE_DATA_TTL_MS}ms`);
try { await runScan(); } catch (error) { retrySoon = true; await log(`cold scan error: ${error && (error.stack || error.message) || error}`); }
if (process.env.ORE_ONESHOT) {
    if (worker) await worker.terminate();
    process.exit(0);
}
schedule(retrySoon ? COLD_RETRY_MS : POLL_MS);
