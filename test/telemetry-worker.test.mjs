/* global process, Buffer */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const telemetryUrl = pathToFileURL(path.resolve('src/utils/telemetry.js')).href;

async function inTempDir (fn) {
  const dir = await fs.mkdtemp(path.resolve('.tmp-telemetry-'));
  try { await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

function runTelemetryChild (cwd, body, env = {}) {
  const source = `const telemetry = await import(${JSON.stringify(telemetryUrl)}); ${body}`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      cwd,
      env: { ...process.env, MC_TELEMETRY: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)));
  });
}

test('telemetry is disabled by default', async () => {
  await inTempDir(async (dir) => {
    await runTelemetryChild(dir, `telemetry.appendTelemetry('mine_motion.jsonl', { ok: true }); await new Promise(r => setTimeout(r, 250));`);
    await assert.rejects(fs.stat(path.join(dir, 'bots', '_supervisor', 'mine_motion.jsonl')), { code: 'ENOENT' });
  });
});

test('telemetry worker writes when explicitly enabled', async () => {
  await inTempDir(async (dir) => {
    await runTelemetryChild(dir, `telemetry.appendTelemetry('mine_motion.jsonl', { ok: true }); await new Promise(r => setTimeout(r, 350));`, { MC_TELEMETRY: '1' });
    const text = await fs.readFile(path.join(dir, 'bots', '_supervisor', 'mine_motion.jsonl'), 'utf8');
    assert.deepEqual(JSON.parse(text.trim()), { ok: true });
  });
});

test('startup cleanup trims pre-existing runtime logs off the main thread', async () => {
  await inTempDir(async (dir) => {
    const logs = path.join(dir, 'bots', '_supervisor');
    await fs.mkdir(logs, { recursive: true });
    await fs.writeFile(path.join(logs, 'mine_motion.jsonl'), Buffer.alloc(2 * 1024 * 1024, 120));
    await runTelemetryChild(dir, `await new Promise(r => setTimeout(r, 600));`, { MC_TELEMETRY_FILE_MAX_MB: '1' });
    const stat = await fs.stat(path.join(logs, 'mine_motion.jsonl'));
    assert.ok(stat.size <= 1024 * 1024, `expected <=1MiB, got ${stat.size}`);
  });
});

test('runtime cleanup never truncates the inbox control queue', async () => {
  await inTempDir(async (dir) => {
    const logs = path.join(dir, 'bots', '_supervisor');
    await fs.mkdir(logs, { recursive: true });
    const inboxBytes = 2 * 1024 * 1024;
    await fs.writeFile(path.join(logs, 'inbox.jsonl'), Buffer.alloc(inboxBytes, 113));
    await fs.writeFile(path.join(logs, 'mine_motion.jsonl'), Buffer.alloc(2 * 1024 * 1024, 120));
    await runTelemetryChild(dir, `await new Promise(r => setTimeout(r, 600));`, { MC_TELEMETRY_FILE_MAX_MB: '1' });
    const inbox = await fs.stat(path.join(logs, 'inbox.jsonl'));
    const telemetry = await fs.stat(path.join(logs, 'mine_motion.jsonl'));
    assert.equal(inbox.size, inboxBytes);
    assert.ok(telemetry.size <= 1024 * 1024, `expected telemetry <=1MiB, got ${telemetry.size}`);
  });
});

test('runtime log budget includes rotated and old-world generations', async () => {
  await inTempDir(async (dir) => {
    const logs = path.join(dir, 'bots', '_supervisor');
    await fs.mkdir(logs, { recursive: true });
    for (let i = 0; i < 10; i++) {
      await fs.writeFile(path.join(logs, `death_log.jsonl.${i}.oldworld`), Buffer.alloc(1024 * 1024, 120));
    }
    await runTelemetryChild(dir, `await new Promise(r => setTimeout(r, 700));`, { MC_RUNTIME_LOG_MAX_MB: '8', MC_TELEMETRY_FILE_MAX_MB: '8' });
    const files = await fs.readdir(logs);
    let total = 0;
    for (const file of files) total += (await fs.stat(path.join(logs, file))).size;
    assert.ok(total <= 8 * 1024 * 1024, `expected <=8MiB, got ${total}`);
  });
});
