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
        if (!wanted.has(section.get({ x, y, z }))) continue;
        job.matches.push({ x: wx, y: wy, z: wz, d2 });
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
        count: message.count,
        wanted: new Set(message.stateIds),
        matches: []
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
      job.matches.sort((a, b) => a.d2 - b.d2);
      const positions = job.matches.slice(0, job.count).map(({ x, y, z }) => ({ x, y, z }));
      jobs.delete(jobId);
      parentPort.postMessage({ type: 'result', jobId, positions });
      return;
    }

    if (type === 'cancel') jobs.delete(jobId);
  } catch (error) {
    jobs.delete(jobId);
    parentPort.postMessage({ type: 'error', jobId, batchId: message.batchId, error: error && error.stack ? error.stack : String(error) });
  }
});
