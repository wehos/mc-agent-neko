/* global setImmediate */
import { Worker } from 'node:worker_threads';
import Vec3 from 'vec3';

const SNAPSHOT_SLICE_MS = 8;
const SECTIONS_PER_BATCH = 8;
const SCAN_TIMEOUT_MS = 120_000;
const CANCELLATION_POLL_MS = 10;

let worker = null;
let nextJobId = 1;
let nextBatchId = 1;
const waiters = new Map();
let queue = Promise.resolve();

class BlockScanCancelledError extends Error {
  constructor () {
    super('Block scan cancelled because the bot was superseded');
    this.name = 'BlockScanCancelledError';
  }
}

function createWorker () {
  const instance = new Worker(new URL('./block_scan_worker.cjs', import.meta.url));
  instance.on('message', (message) => {
    const key = message.type === 'ack' || (message.type === 'error' && message.batchId != null)
      ? `batch:${message.batchId}`
      : `job:${message.jobId}`;
    const waiter = waiters.get(key);
    if (!waiter) return;
    if (message.type === 'error') waiter.reject(new Error(message.error));
    else waiter.resolve(message);
    waiters.delete(key);
  });
  const failAll = (error) => {
    for (const waiter of waiters.values()) waiter.reject(error);
    waiters.clear();
    if (worker === instance) worker = null;
  };
  instance.on('error', failAll);
  instance.on('exit', (code) => {
    if (code !== 0) failAll(new Error(`Block scan worker exited with code ${code}`));
    else if (worker === instance) worker = null;
  });
  instance.unref();
  return instance;
}

function getWorker () {
  if (!worker) worker = createWorker();
  return worker;
}

function waitFor (key, timeoutMs = SCAN_TIMEOUT_MS, isCancelled = null) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let cancellationTimer = null;
    const cleanup = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(cancellationTimer);
      waiters.delete(key);
    };
    const waiter = {
      resolve: (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      reject: (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
    };
    const checkCancellation = () => {
      if (isCancelled?.()) {
        waiter.reject(new BlockScanCancelledError());
        return;
      }
      cancellationTimer = setTimeout(checkCancellation, CANCELLATION_POLL_MS);
      cancellationTimer.unref?.();
    };
    const timeoutTimer = setTimeout(() => {
      waiter.reject(new Error(`Timed out waiting for block scan worker (${key})`));
    }, timeoutMs);
    timeoutTimer.unref?.();
    waiters.set(key, waiter);
    if (isCancelled) checkCancellation();
  });
}

async function sendAndWait (message, bot) {
  const batchId = nextBatchId++;
  const promise = waitFor(`batch:${batchId}`, SCAN_TIMEOUT_MS, () => bot?._disposed === true);
  getWorker().postMessage({ ...message, batchId });
  await promise;
}

function throwIfDisposed (bot) {
  if (bot?._disposed) throw new BlockScanCancelledError();
}

function statesForTypes (bot, typeIds) {
  const states = new Set();
  const byId = bot.registry?.blocks || {};
  for (const typeId of typeIds) {
    const block = byId[typeId] || Object.values(bot.registry?.blocksByName || {}).find((entry) => entry.id === typeId);
    if (!block) continue;
    const min = Number.isFinite(block.minStateId) ? block.minStateId : typeId;
    const max = Number.isFinite(block.maxStateId) ? block.maxStateId : min;
    for (let state = min; state <= max; state++) states.add(state);
  }
  return [...states];
}

function matchingStateIds (bot, matching) {
  if (typeof matching === 'number') return statesForTypes(bot, [matching]);
  if (Array.isArray(matching)) return statesForTypes(bot, matching.filter(Number.isFinite));
  if (typeof matching !== 'function') throw new TypeError('Block scan matching must be a block id, id array, or predicate');

  const states = [];
  for (const block of Object.values(bot.registry?.blocksByName || {})) {
    const min = Number.isFinite(block.minStateId) ? block.minStateId : block.id;
    const max = Number.isFinite(block.maxStateId) ? block.maxStateId : min;
    for (let state = min; state <= max; state++) {
      try {
        // Mineflayer exposes the legacy metadata value as the state offset for
        // levelled blocks (water/lava). Reconstruct block-state properties with
        // prismarine-block's mixed-radix ordering so property predicates also
        // remain exact without creating live Block objects on the main thread.
        const metadata = state - min;
        let stateData = metadata;
        const properties = {};
        for (let index = (block.states || []).length - 1; index >= 0; index--) {
          const property = block.states[index];
          const raw = stateData % property.num_values;
          properties[property.name] = property.type === 'bool'
            ? !raw
            : (property.values ? property.values[raw] : raw);
          stateData = Math.floor(stateData / property.num_values);
        }
        if (matching({ ...block, type: block.id, metadata, getProperties: () => properties })) states.push(state);
      } catch { /* predicate is not compatible with a registry-only block */ }
    }
  }
  return states;
}

function columnIntersects (chunkX, chunkZ, center, radius) {
  const minX = chunkX * 16;
  const minZ = chunkZ * 16;
  const dx = center.x < minX ? minX - center.x : center.x > minX + 15 ? center.x - (minX + 15) : 0;
  const dz = center.z < minZ ? minZ - center.z : center.z > minZ + 15 ? center.z - (minZ + 15) : 0;
  return dx * dx + dz * dz <= radius * radius;
}

function yieldImmediate () {
  return new Promise((resolve) => setImmediate(resolve));
}

async function scanOnce (bot, options) {
  if (!bot?.world?.getColumns || !bot?.entity?.position || bot._disposed) return [];
  const rawCenter = options.point || bot.entity.position;
  const center = { x: Math.floor(rawCenter.x), y: Math.floor(rawCenter.y), z: Math.floor(rawCenter.z) };
  const radius = Math.max(0, Number(options.maxDistance) || 0);
  const count = Math.max(1, Number(options.count) || 1);
  const stateIds = matchingStateIds(bot, options.matching);
  if (!stateIds.length) return [];

  const jobId = nextJobId++;
  const activeWorker = getWorker();
  activeWorker.ref();
  let batch = [];
  let sliceStarted = performance.now();
  try {
    throwIfDisposed(bot);
    await sendAndWait({
      type: 'start', jobId, version: bot.version,
      center: { x: center.x, y: center.y, z: center.z },
      radius, count, stateIds
    }, bot);
    for (const entry of bot.world.getColumns()) {
      throwIfDisposed(bot);
      // prismarine-world exposes chunk coordinates as strings from its map keys.
      const chunkX = Number(entry.chunkX ?? entry.x);
      const chunkZ = Number(entry.chunkZ ?? entry.z);
      const column = entry.column || entry;
      if (!Number.isFinite(chunkX) || !Number.isFinite(chunkZ) || !columnIntersects(chunkX, chunkZ, center, radius)) continue;
      const minY = Number.isFinite(column.minY) ? column.minY : 0;
      for (let index = 0; index < (column.sections || []).length; index++) {
        throwIfDisposed(bot);
        const section = column.sections[index];
        if (!section?.toJson) continue;
        const y = minY + index * 16;
        if (y > center.y + radius || y + 15 < center.y - radius) continue;
        const json = section.toJson();
        throwIfDisposed(bot);
        batch.push({ x: chunkX * 16, y, z: chunkZ * 16, json });
        if (batch.length >= SECTIONS_PER_BATCH) {
          await sendAndWait({ type: 'batch', jobId, sections: batch }, bot);
          batch = [];
        }
        if (performance.now() - sliceStarted >= SNAPSHOT_SLICE_MS) {
          await yieldImmediate();
          throwIfDisposed(bot);
          sliceStarted = performance.now();
        }
      }
    }
    if (batch.length) await sendAndWait({ type: 'batch', jobId, sections: batch }, bot);
    throwIfDisposed(bot);
    const resultPromise = waitFor(`job:${jobId}`, SCAN_TIMEOUT_MS, () => bot?._disposed === true);
    activeWorker.postMessage({ type: 'finish', jobId });
    const result = await resultPromise;
    throwIfDisposed(bot);
    const blocks = [];
    for (const position of result.positions) {
      throwIfDisposed(bot);
      const block = bot.blockAt(new Vec3(position.x, position.y, position.z));
      if (!block) continue;
      if (typeof options.matching === 'function' && !options.matching(block)) continue;
      blocks.push(block);
    }
    return blocks;
  } catch (error) {
    try { activeWorker.postMessage({ type: 'cancel', jobId }); } catch { /* worker already failed */ }
    if (error instanceof BlockScanCancelledError) return [];
    throw error;
  } finally {
    activeWorker.unref();
  }
}

export function findBlocksOffThread (bot, options) {
  const task = queue.then(() => scanOnce(bot, options));
  queue = task.catch(() => {});
  return task;
}
