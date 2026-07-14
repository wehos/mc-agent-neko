'use strict';
/* global require, Buffer */

const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');

const directory = workerData.directory;
const enabled = workerData.enabled;
const totalBudget = workerData.totalBudget;
const perFileBudget = workerData.perFileBudget;
const allowed = new Set(workerData.allowed);
const runtimePattern = /\.(?:jsonl|log|txt)(?:\..+)?$/i;
const isArchived = (name) => /\.(?:jsonl|log|txt)\./i.test(name);
let queue = Promise.resolve();

async function statOrNull (file) {
  try { return await fs.stat(file); } catch { return null; }
}

async function trimTail (file, bytes) {
  const stat = await statOrNull(file);
  if (!stat || stat.size <= bytes) return;
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, stat.size - bytes);
    await fs.writeFile(`${file}.trim`, buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
  await fs.rename(`${file}.trim`, file);
}

async function runtimeFiles () {
  await fs.mkdir(directory, { recursive: true });
  const names = await fs.readdir(directory);
  const entries = [];
  for (const name of names) {
    if (!runtimePattern.test(name)) continue;
    const file = path.join(directory, name);
    const stat = await statOrNull(file);
    if (stat?.isFile()) entries.push({ name, file, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  return entries;
}

async function enforceBudget () {
  let entries = await runtimeFiles();
  for (const entry of entries) {
    if (entry.size > perFileBudget) await trimTail(entry.file, perFileBudget);
  }

  entries = await runtimeFiles();
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= totalBudget) return;

  // Old generations are expendable first. Active logs retain their newest tail.
  const old = entries.filter((entry) => isArchived(entry.name)).sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of old) {
    if (total <= totalBudget) break;
    try { await fs.unlink(entry.file); total -= entry.size; } catch { /* another writer may have rotated it */ }
  }

  if (total <= totalBudget) return;
  const active = (await runtimeFiles()).filter((entry) => !isArchived(entry.name)).sort((a, b) => b.size - a.size);
  for (const entry of active) {
    if (total <= totalBudget) break;
    const need = total - totalBudget;
    const keep = Math.max(0, entry.size - need);
    await trimTail(entry.file, keep);
    total -= Math.min(need, entry.size);
  }
}

async function append (message) {
  if (!enabled || !allowed.has(message.file)) return;
  const target = path.join(directory, message.file);
  const current = await statOrNull(target);
  if (current && current.size >= perFileBudget) {
    const old = `${target}.1`;
    try { await fs.unlink(old); } catch { /* first rotation has no previous generation */ }
    await fs.rename(target, old);
  }
  const line = message.json ? `${JSON.stringify(message.value)}\n` : String(message.value);
  await fs.appendFile(target, line);
  await enforceBudget();
}

function schedule (fn) {
  queue = queue.then(fn, fn).catch(() => {});
}

parentPort.on('message', (message) => {
  if (message?.type === 'append') schedule(() => append(message));
  if (message?.type === 'prune') schedule(enforceBudget);
});

schedule(enforceBudget);
const sweep = setInterval(() => schedule(enforceBudget), 5000);
sweep.unref();
