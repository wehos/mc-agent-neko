import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import Vec3 from 'vec3';
import {
    MIN_SCAN_CHUNK_RADIUS,
    ORACLE_CLEARED_TTL_MS,
    ORACLE_DATA_TTL_MS,
    filterClearedEntries,
    oracleSnapshotFresh,
    worldIdForRegion,
} from '../oracle_shared.mjs';
import {
    arrivedAtOracleTarget,
    liveOracleTargetState,
    targetCleared,
} from '../skills/oracleGuard.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const HAS_ANVIL = (() => { try { require.resolve('prismarine-provider-anvil'); return true; } catch (e) { return false; } })();

test('oracle snapshot TTL is fail-closed and world-scoped', () => {
    const now = 1_000_000;
    const live = { ts: now - 1000, expiresAt: now + 1000, worldId: 'world-a' };
    assert.equal(oracleSnapshotFresh(live, now, 'world-a'), true);
    assert.equal(oracleSnapshotFresh(live, now, 'world-b'), false);
    assert.equal(oracleSnapshotFresh({ ts: now - ORACLE_DATA_TTL_MS - 1 }, now), false);
    assert.equal(oracleSnapshotFresh({ ts: now, expiresAt: now }, now), false);
});

test('cleared targets expire and never cross a world generation', () => {
    const now = 2_000_000;
    const entries = [
        { ore: 'diamonds', x: 1, y: -50, z: 1, ts: now, expiresAt: now + 1000, worldId: 'a' },
        { ore: 'iron', x: 2, y: 20, z: 2, ts: now - ORACLE_CLEARED_TTL_MS - 1, worldId: 'a' },
        { ore: 'gold', x: 3, y: 10, z: 3, ts: now, expiresAt: now + 1000, worldId: 'b' },
    ];
    const filtered = filterClearedEntries(entries, { now, worldId: 'a' });
    assert.deepEqual(filtered.map((entry) => entry.ore), ['diamonds']);
    assert.equal(targetCleared({ x: 1, y: -50, z: 1 }, 'diamond', filtered), true);
});

test('live validation requires real 3D arrival and checks the exact block', () => {
    const blocks = new Map([
        ['10,-50,10', { name: 'deepslate_diamond_ore' }],
        ['11,-50,10', { name: 'deepslate' }],
        ['12,-50,10', { name: 'copper_ore' }],
        ['13,-50,10', { name: 'oak_log' }],
        ['14,-50,10', { name: 'water' }],
        ['15,-50,10', { name: 'bell' }],
    ]);
    const bot = {
        entity: { position: new Vec3(10, -49, 10) },
        blockAt(pos) { return blocks.get(`${pos.x},${pos.y},${pos.z}`) || null; },
    };
    assert.equal(arrivedAtOracleTarget(bot, { x: 10, y: -50, z: 10 }), true);
    assert.equal(liveOracleTargetState(bot, Vec3, { x: 10, y: -50, z: 10 }, 'diamonds'), 'present');
    assert.equal(liveOracleTargetState(bot, Vec3, { x: 11, y: -50, z: 10 }, 'diamonds'), 'absent');
    assert.equal(liveOracleTargetState(bot, Vec3, { x: 12, y: -50, z: 10 }, 'copper'), 'present');
    assert.equal(liveOracleTargetState(bot, Vec3, { x: 13, y: -50, z: 10 }, 'wood'), 'present');
    assert.equal(liveOracleTargetState(bot, Vec3, { x: 14, y: -50, z: 10 }, 'water'), 'present');
    assert.equal(liveOracleTargetState(bot, Vec3, { x: 15, y: -50, z: 10 }, 'village'), 'present');
    bot.entity.position = new Vec3(10, 70, 10);
    assert.equal(arrivedAtOracleTarget(bot, { x: 10, y: -50, z: 10 }), false, 'same X/Z is not arrival');
    assert.equal(liveOracleTargetState(bot, Vec3, { x: 10, y: -50, z: 10 }, 'diamonds'), 'too-far');
});

test('scanner guarantees the requested 256 block minimum coverage', () => {
    assert.ok(MIN_SCAN_CHUNK_RADIUS * 16 >= 256);
});

test('scanner executes in a worker and reports full cold-start coverage', { skip: !HAS_ANVIL && 'prismarine-provider-anvil is not installed in this checkout' }, async () => {
    const region = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-empty-region-'));
    const worker = new Worker(new URL('../ore-oracle-worker.mjs', import.meta.url));
    try {
        const progress = [];
        const result = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('worker test timeout')), 10000);
            worker.once('error', (error) => { clearTimeout(timeout); reject(error); });
            worker.on('message', (message) => {
                if (message.type === 'progress') { progress.push(message.snapshot); return; }
                clearTimeout(timeout);
                resolve(message);
            });
            worker.postMessage({
                type: 'scan', requestId: 1,
                payload: { region, worldId: 'cold-world', vit: { x: 0, y: 64, z: 0 }, cleared: [], version: '1.21.1' },
            });
        });
        assert.equal(result.type, 'result');
        assert.ok(result.snapshot.minCoverageBlocks >= 256);
        assert.ok(result.snapshot.reachedBlocks >= 256);
        assert.equal(result.snapshot.worldId, 'cold-world');
        assert.deepEqual(progress.slice(0, 3).map((snapshot) => snapshot.reachedBlocks), [32, 64, 128]);
        assert.ok(progress.slice(0, 3).every((snapshot) => snapshot.warming === true));
    } finally {
        await worker.terminate();
        fs.rmSync(region, { recursive: true, force: true });
    }
});

test('world id is stable per region and changes across worlds', () => {
    assert.equal(worldIdForRegion('C:/saves/world/region'), worldIdForRegion('c:\\saves\\world\\region'));
    assert.notEqual(worldIdForRegion('C:/saves/world-a/region'), worldIdForRegion('C:/saves/world-b/region'));
});

test('new-world clear list drops both oracle outputs', () => {
    const source = fs.readFileSync(path.join(HERE, '..', 'new-world-reset.mjs'), 'utf8');
    assert.match(source, /['"]oracle\.json['"]/);
    assert.match(source, /['"]oracle-ores\.json['"]/);
    assert.match(source, /['"]oracle-world-pending\.json['"]/);
});

test('ore scanner is worker-backed and websocket path has no oracle sync read', () => {
    const scheduler = fs.readFileSync(path.join(HERE, '..', 'ore-oracle.mjs'), 'utf8');
    const modes = fs.readFileSync(path.join(HERE, '..', '..', '..', 'src', 'agent', 'modes.js'), 'utf8');
    assert.match(scheduler, /new Worker\(/);
    const worker = fs.readFileSync(path.join(HERE, '..', 'ore-oracle-worker.mjs'), 'utf8');
    assert.match(worker, /copper_ore/);
    assert.match(worker, /for \(const family of Object\.keys\(found\)\)/);
    assert.match(worker, /PROGRESS_RADII = new Set\(\[2, 4, 8, MIN_SCAN_CHUNK_RADIUS\]\)/);
    assert.match(worker, /type: 'progress'/);
    assert.match(scheduler, /message\.type === 'progress'/);
    assert.match(scheduler, /publishStage\(partial, 'progress'\)/);
    assert.match(scheduler, /after\.newestMtime !== scanRegionMtime/);
    assert.match(scheduler, /oracle-world-pending\.json/);
    assert.match(scheduler, /waiting for new-world-reset to commit the new generation/);
    const oracleBlock = modes.slice(modes.indexOf('// ── ★ORACLE'), modes.indexOf('bot._world = {', modes.indexOf('// ── ★ORACLE')));
    assert.doesNotMatch(oracleBlock, /readFileSync/);
    assert.match(oracleBlock, /readJsonCachedNonBlocking/);
    assert.match(oracleBlock, /_oracleBlocked/);
});
