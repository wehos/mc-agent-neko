'use strict';
/* global require */

const { parentPort } = require('node:worker_threads');
const chunkFactories = new Map();
const jobs = new Map();

function chunkFor (version) {
  if (!chunkFactories.has(version)) {
    chunkFactories.set(version, require('prismarine-chunk')(version));
  }
  return chunkFactories.get(version);
}

function sectionStateId (section, position) {
  if (typeof section.get === 'function') return section.get(position);
  if (typeof section.getBlockStateId === 'function') return section.getBlockStateId(position);
  if (typeof section.getBlock === 'function') {
    const block = section.getBlock(position);
    if (typeof block === 'number') return block;
    if (Number.isFinite(block?.stateId)) return block.stateId;
    if (Number.isFinite(block?.type)) return block.type;
  }
  throw new TypeError('Unsupported prismarine-chunk section accessor');
}

function compareMatches (a, b) {
  return a.d2 - b.d2 || a.y - b.y || a.z - b.z || a.x - b.x;
}

function siftUpWorst (matches, start) {
  let index = start;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareMatches(matches[parent], matches[index]) >= 0) break;
    [matches[parent], matches[index]] = [matches[index], matches[parent]];
    index = parent;
  }
}

function siftDownWorst (matches, start) {
  let index = start;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let worst = index;
    if (left < matches.length && compareMatches(matches[left], matches[worst]) > 0) worst = left;
    if (right < matches.length && compareMatches(matches[right], matches[worst]) > 0) worst = right;
    if (worst === index) return;
    [matches[index], matches[worst]] = [matches[worst], matches[index]];
    index = worst;
  }
}

function retainNearest (job, match) {
  if (job.matches.length < job.count) {
    job.matches.push(match);
    siftUpWorst(job.matches, job.matches.length - 1);
  } else if (compareMatches(match, job.matches[0]) < 0) {
    job.matches[0] = match;
    siftDownWorst(job.matches, 0);
  }
  job.peakRetained = Math.max(job.peakRetained, job.matches.length);
}

function scanSection (job, raw) {
  const Chunk = chunkFor(job.version);
  const section = Chunk.section.fromJson(raw.json);
  const wanted = job.wanted;
  const radius2 = job.radius * job.radius;

  for (let y = 0; y < 16; y++) {
    const wy = raw.y + y;
    const dy = wy - job.center.y;
    if (dy * dy > radius2) continue;
    for (let z = 0; z < 16; z++) {
      const wz = raw.z + z;
      const dz = wz - job.center.z;
      for (let x = 0; x < 16; x++) {
        const wx = raw.x + x;
        const dx = wx - job.center.x;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > radius2) continue;
        if (!wanted.has(sectionStateId(section, { x, y, z }))) continue;
        retainNearest(job, { x: wx, y: wy, z: wz, d2 });
      }
    }
  }
}

parentPort.on('message', (message) => {
  const { type, jobId } = message;
  try {
    if (type === 'start') {
      jobs.set(jobId, {
        version: message.version,
        center: message.center,
        radius: message.radius,
        count: Math.max(1, Math.floor(message.count)),
        wanted: new Set(message.stateIds),
        matches: [],
        peakRetained: 0
      });
      parentPort.postMessage({ type: 'ack', jobId, batchId: message.batchId });
      return;
    }

    const job = jobs.get(jobId);
    if (!job) throw new Error(`Unknown block scan job ${jobId}`);

    if (type === 'batch') {
      for (const section of message.sections) scanSection(job, section);
      parentPort.postMessage({ type: 'ack', jobId, batchId: message.batchId });
      return;
    }

    if (type === 'finish') {
      job.matches.sort(compareMatches);
      const positions = job.matches.map(({ x, y, z }) => ({ x, y, z }));
      jobs.delete(jobId);
      parentPort.postMessage({ type: 'result', jobId, positions, peakRetained: job.peakRetained });
      return;
    }

    if (type === 'cancel') jobs.delete(jobId);
  } catch (error) {
    jobs.delete(jobId);
    parentPort.postMessage({ type: 'error', jobId, batchId: message.batchId, error: error && error.stack ? error.stack : String(error) });
  }
});
