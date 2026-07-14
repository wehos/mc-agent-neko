/* global process */
import { Worker } from 'node:worker_threads';
import path from 'node:path';

const TELEMETRY_FILES = [
  'mine_motion.jsonl',
  'act_trace.jsonl',
  'motion_quality.jsonl',
  'combat_log.jsonl',
  'mine_dbg.log',
  'framework-shadow.log'
];
const RUNTIME_LOG_FILES = [
  ...TELEMETRY_FILES,
  'events.log',
  'vitals.jsonl',
  'death_log.jsonl',
  'disconnects.jsonl'
];

const enabled = /^(?:1|true|yes)$/i.test(process.env.MC_TELEMETRY || '');
// 64 MiB leaves comfortable room below the user's 100 MB distribution/runtime
// ceiling for the rolling frame buffer and small state/config files.
const totalBudget = Math.min(64, Math.max(8, Number(process.env.MC_RUNTIME_LOG_MAX_MB) || 64)) * 1024 * 1024;
const perFileBudget = Math.min(8, Math.max(1, Number(process.env.MC_TELEMETRY_FILE_MAX_MB) || 8)) * 1024 * 1024;

const telemetryWorker = new Worker(new URL('./telemetry_worker.cjs', import.meta.url), {
  workerData: {
    directory: path.resolve(process.cwd(), 'bots', '_supervisor'),
    enabled,
    totalBudget,
    perFileBudget,
    allowed: TELEMETRY_FILES,
    managed: RUNTIME_LOG_FILES
  }
});
telemetryWorker.unref();
telemetryWorker.on('error', (error) => {
  // Telemetry must never take the bot down. Keep this on stdout: log files are
  // precisely what may be unhealthy when this path fails.
  console.warn(`[telemetry-worker] ${error.message}`);
});

export const telemetryEnabled = enabled;

export function appendTelemetry (file, value, { json = typeof value !== 'string' } = {}) {
  if (!enabled || !TELEMETRY_FILES.includes(file)) return false;
  try {
    telemetryWorker.postMessage({ type: 'append', file, value, json });
    return true;
  } catch {
    return false;
  }
}

export function pruneRuntimeLogs () {
  try { telemetryWorker.postMessage({ type: 'prune' }); } catch { /* worker is best-effort */ }
}
