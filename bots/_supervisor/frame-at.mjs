#!/usr/bin/env node
// frame-at — find the black-box frame nearest a given time, so any agent can reconstruct
// "what did 04:52 look like" AFTER the fact (the flight-recorder filmstrip lives in frames/,
// written by bridge.mjs every FRAME_EVERY_MS, pruned to a rolling FRAME_RETAIN_MS window).
//
//   node bots/_supervisor/frame-at.mjs 04:52            # HH:MM[:SS] — interpreted as UTC (matches events.log)
//   node bots/_supervisor/frame-at.mjs 04:52:30
//   node bots/_supervisor/frame-at.mjs 2026-06-20T04:52:00Z
//   node bots/_supervisor/frame-at.mjs 1781929953557    # raw unix ms
//   node bots/_supervisor/frame-at.mjs now              # latest frame
//   node bots/_supervisor/frame-at.mjs 04:52 --window 90   # list ALL frames within ±90s
//
// Prints the absolute path(s) (Read it with the image tool). events.log timestamps are UTC
// ISO, so HH:MM:SS here is parsed as UTC to line up with the logs you're cross-referencing.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FRAMES_DIR = path.join(DIR, 'frames');

const args = process.argv.slice(2);
const spec = args[0];
const windowIdx = args.indexOf('--window');
const windowS = windowIdx >= 0 ? parseInt(args[windowIdx + 1], 10) : null;

if (!spec) { console.error('usage: frame-at.mjs <HH:MM[:SS] | ISO | unix-ms | now> [--window <sec>]'); process.exit(1); }

function targetMs(s) {
    if (s === 'now') return Date.now();
    if (/^\d{13}$/.test(s)) return parseInt(s, 10);              // unix ms
    if (/^\d{10}$/.test(s)) return parseInt(s, 10) * 1000;       // unix seconds
    const hm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
    if (hm) {                                                     // HH:MM[:SS] → today UTC
        const d = new Date();
        return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), +hm[1], +hm[2], +(hm[3] || 0));
    }
    const t = Date.parse(s);                                     // ISO / anything Date.parse groks
    if (!Number.isNaN(t)) return t;
    return null;
}

const tgt = targetMs(spec);
if (tgt == null) { console.error(`could not parse time: "${spec}"`); process.exit(1); }

let frames;
try {
    frames = fs.readdirSync(FRAMES_DIR)
        .map(f => { const m = /^(\d{10,})\.jpg$/.exec(f); return m ? { f, ms: parseInt(m[1], 10) } : null; })
        .filter(Boolean)
        .sort((a, b) => a.ms - b.ms);
} catch (e) { console.error(`no frames/ dir (${e.message}) — is the black box enabled? (NEKO_AGENT_SCREENSHOT_INTERVAL_MS>0)`); process.exit(2); }

if (!frames.length) { console.error('frames/ is empty — screenshots are likely OFF (camera not initialized). Restart agent with NEKO_AGENT_SCREENSHOT_INTERVAL_MS=15000.'); process.exit(2); }

const iso = (ms) => new Date(ms).toISOString().slice(11, 19);
const span = `[${iso(frames[0].ms)}..${iso(frames[frames.length - 1].ms)} UTC, ${frames.length} frames]`;

if (windowS != null) {
    const lo = tgt - windowS * 1000, hi = tgt + windowS * 1000;
    const hits = frames.filter(x => x.ms >= lo && x.ms <= hi);
    console.error(`${hits.length} frame(s) within ±${windowS}s of ${iso(tgt)} UTC ${span}:`);
    for (const x of hits) console.log(`${path.join(FRAMES_DIR, x.f)}   (${iso(x.ms)} UTC, ${((x.ms - tgt) / 1000).toFixed(1)}s)`);
    process.exit(0);
}

let best = frames[0];
for (const x of frames) if (Math.abs(x.ms - tgt) < Math.abs(best.ms - tgt)) best = x;
const deltaS = (best.ms - tgt) / 1000;
console.error(`nearest frame to ${iso(tgt)} UTC ${span}:  Δ${deltaS.toFixed(1)}s`);
if (Math.abs(deltaS) > 60) console.error(`⚠️ nearest frame is ${Math.abs(deltaS).toFixed(0)}s away — that moment may predate the retention window or screenshots were off then.`);
console.log(path.join(FRAMES_DIR, best.f));
