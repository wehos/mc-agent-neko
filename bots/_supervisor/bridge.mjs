// N.E.K.O. supervisor bridge.
// Plays the role of the N.E.K.O. plugin: connects to the mc-agent WebSocket
// (ws://localhost:48909), records the visual feed + event stream to disk, and
// relays tasks the supervisor appends to inbox.jsonl back to the agent.
//
//   frame.jpg      latest screenshot (overwritten ~1/s) — Read this to see the world
//   frames/        timestamped filmstrip (one every FRAME_EVERY_MS)
//   events.log     one line per non-screenshot event (logs, task_finished, errors)
//   inbox.jsonl    append {"task":"...","task_id":"..."} or a bare string to send a task
//   status.json    connection + counters snapshot
//
// Run: node bots/_supervisor/bridge.mjs
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.NEKO_WS_URL || 'ws://localhost:48909';
const FRAME = path.join(DIR, 'frame.jpg');
const FRAMES_DIR = path.join(DIR, 'frames');
const EVENTS = path.join(DIR, 'events.log');
const INBOX = path.join(DIR, 'inbox.jsonl');
const STATUS = path.join(DIR, 'status.json');
// STICKY supervised skill: if this file exists, re-send it as run_skill on every
// (re)connect. WHY: a bot DEATH restarts the agent, which RESETS the supervised lock
// and lets the LLM brain resume — its default post-death move is
// !goToRememberedPlace(last_death_position), which walks the bot straight back into the
// mobs that just killed it, fueling an unbreakable death spiral. Auto-re-arming the
// supervised skill on reconnect snatches control back from the LLM within seconds, so
// the survival modes (night-shelter etc.) drive instead of the suicidal walk-back.
// Write {"skill":"achieveLoop","args":[...]} to arm; delete the file to stop.
const STICKY = path.join(DIR, 'sticky_skill.json');
const FRAME_EVERY_MS = 15000; // filmstrip cadence
// Hard-state telemetry from the agent's vitals broadcast (15s cadence):
//   vitals.json   latest snapshot (overwritten) — watchdog/patrol read this
//   vitals.jsonl  history for trend analysis (rotated at 20MB)
const VITALS = path.join(DIR, 'vitals.json');
const VITALS_LOG = path.join(DIR, 'vitals.jsonl');

fs.mkdirSync(FRAMES_DIR, { recursive: true });
if (!fs.existsSync(INBOX)) fs.writeFileSync(INBOX, '');

let ws = null;
let connected = false;
let frameCount = 0;
let lastFrameSaved = 0;
let lastEvent = null;
let inboxOffset = fs.statSync(INBOX).size; // only relay lines appended after startup

// Rotate a log file once it exceeds maxBytes (keep one .1 generation). Without
// this, kiting-spam alone grew events.log past 10MB in days — unbounded on a
// 24h+ unattended run.
let _rotCheck = 0;
function rotateIfBig(file, maxBytes) {
    try {
        if (fs.statSync(file).size > maxBytes) {
            const old = file + '.1';
            if (fs.existsSync(old)) fs.unlinkSync(old);
            fs.renameSync(file, old);
        }
    } catch (e) { /* missing file etc. — ignore */ }
}

function logEvent(obj) {
    lastEvent = obj;
    const line = `[${new Date().toISOString()}] ${JSON.stringify(obj)}\n`;
    if (++_rotCheck % 200 === 0) rotateIfBig(EVENTS, 30 * 1024 * 1024);
    fs.appendFileSync(EVENTS, line);
}

function writeStatus() {
    fs.writeFileSync(STATUS, JSON.stringify({
        connected, frameCount, ts: Date.now(),
        url: URL, lastEvent,
    }, null, 2));
}

function handle(msg) {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }
    if (data.type === 'screenshot') {
        try {
            const buf = Buffer.from(data.image, 'base64');
            fs.writeFileSync(FRAME, buf);
            frameCount++;
            const now = Date.now();
            if (now - lastFrameSaved >= FRAME_EVERY_MS) {
                lastFrameSaved = now;
                fs.writeFileSync(path.join(FRAMES_DIR, `${now}.jpg`), buf);
            }
        } catch (e) { /* ignore bad frame */ }
        return;
    }
    if (data.type === 'vitals') {
        // Hard metrics for the watchdog's stuck-detection. Latest snapshot is
        // overwritten (cheap to read every watchdog tick); history appended for
        // trend analysis. Deliberately NOT logEvent'd — 15s cadence would bloat
        // events.log with noise.
        try { fs.writeFileSync(VITALS, JSON.stringify(data)); } catch (e) {}
        try {
            if (_rotCheck++ % 100 === 0) rotateIfBig(VITALS_LOG, 20 * 1024 * 1024);
            fs.appendFileSync(VITALS_LOG, JSON.stringify(data) + '\n');
        } catch (e) {}
        return;
    }
    // Record everything else verbatim (trim huge inventory blobs are fine, keep them).
    logEvent(data);
    writeStatus();
    // STICKY LOOP: re-arm the sticky skill whenever a supervised skill RETURNS (not just
    // on reconnect). Without this, a sticky skill that finishes/throws leaves the bot
    // idle until the next WS blip — an autonomy hole on 24h unattended runs. The agent's
    // run_skill re-entry guard rejects the re-arm if something is already running.
    // MUST skip the busy-rejection results themselves: a rejection is also a
    // skill_result, so re-arming on it loops reject→re-arm→reject every 8s forever.
    if (data.type === 'skill_result') {
        skillActive = false; lastSkillEndAt = Date.now();
        if (!String(data.error || '').startsWith('busy')) setTimeout(sendStickySkill, 8000);
    }
}

function relayInbox() {
    let size;
    try { size = fs.statSync(INBOX).size; } catch { return; }
    if (size <= inboxOffset) { if (size < inboxOffset) inboxOffset = 0; return; }
    const fd = fs.openSync(INBOX, 'r');
    const buf = Buffer.alloc(size - inboxOffset);
    fs.readSync(fd, buf, 0, buf.length, inboxOffset);
    fs.closeSync(fd);
    inboxOffset = size;
    for (const raw of buf.toString('utf8').split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        let o;
        try { o = JSON.parse(line); } catch { o = line; }
        const online = connected && ws && ws.readyState === ws.OPEN;
        // Raw typed control frame. This is the real-time trigger path for supervisor
        // interrupts such as cancel_skill: watchdog/monitor appends one JSON line, and
        // bridge relays it on the next 1s inbox tick.
        if (o && typeof o === 'object' && o.type) {
            if (online) {
                ws.send(JSON.stringify(o));
                logEvent({ type: 'sent_control', control: o.type, reason: o.reason || null });
                writeStatus();
            } else { logEvent({ type: 'send_failed_offline', control: o.type }); }
            continue;
        }
        // Direct skill execution (bypasses the LLM coder): {"skill":"name","args":[...]}
        if (o && typeof o === 'object' && o.skill) {
            if (online) {
                ws.send(JSON.stringify({ type: 'run_skill', skill: o.skill, args: o.args || [] }));
                skillActive = true;
                logEvent({ type: 'sent_skill', skill: o.skill, args: o.args || [] });
                writeStatus();
            } else { logEvent({ type: 'send_failed_offline', skill: o.skill }); }
            continue;
        }
        // Otherwise treat as a chat/task injection.
        const task = (typeof o === 'string') ? o : (o && o.task);
        if (!task) continue;
        const taskId = (o && o.task_id) || randomUUID();
        if (online) {
            ws.send(JSON.stringify({ type: 'task', task, task_id: taskId }));
            logEvent({ type: 'sent_task', task, task_id: taskId });
            writeStatus();
        } else {
            logEvent({ type: 'send_failed_offline', task });
        }
    }
}

// ★BOM-SAFE JSON read (root-cause of the 2026-06-18 dead-sticky livelock): PowerShell's
// Out-File/Set-Content writes UTF-8 *with* a BOM (ef bb bf). Node's JSON.parse chokes on
// the leading BOM char ("Unexpected token '﻿'"), so when sticky_skill.json was last rewritten
// from a PS session, sendStickySkill threw at the parse and SILENTLY returned every tick —
// the bot got zero supervised-skill dispatches for 90+min after a respawn (dead-idle at
// the death-zone spawn, watchdog restart-looping to no effect). Strip a leading BOM before
// parsing, and LOG a real parse failure instead of swallowing it, so this can never go
// silent again. Used by every disk-JSON read that a PS command might have written.
function readJsonFile(file) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // strip UTF-8/UTF-16 BOM
    try { return JSON.parse(raw); }
    catch (e) { logEvent({ type: 'json_parse_error', file: path.basename(file), error: String(e && e.message || e) }); return null; }
}

function sendStickySkill() {
    const o = readJsonFile(STICKY);
    if (!o || !o.skill) return;
    if (!(connected && ws && ws.readyState === ws.OPEN)) return;
    ws.send(JSON.stringify({ type: 'run_skill', skill: o.skill, args: o.args || [] }));
    skillActive = true;
    logEvent({ type: 'sent_sticky_skill', skill: o.skill, args: o.args || [] });
    writeStatus();
}

// ── RECONNECT: bounded exponential backoff + de-duplicated logging ────────────────
// WHY: the agent process (the 48909 WS server) is cycled by the watchdog on a ~25min
// STUCK-ZONE timer whenever the bot livelocks in place. Each cycle drops this client's
// socket; the OLD code retried on a FIXED 3s and logged BOTH bridge_error AND
// bridge_disconnected per failed attempt, so one restart gap wrote ~6 disconnect/error
// pairs — and a prolonged outage (e.g. watchdog itself down) spammed events.log forever
// at 20 lines/min with no diagnostic value. Now: backoff caps the retry rate, the cause
// is unpacked from the AggregateError, and only a REAL disconnect (a live socket that
// dropped) logs bridge_disconnected — failed reconnect attempts no longer masquerade as
// disconnects, so the disconnect count finally means "agent went down" 1:1.
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 8000;   // tight cap: common case is a ~15-25s restart gap, so
                                 // stay snappy — reconnect within 8s of the port returning.
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer = null;
let wasConnected = false;        // true only after a live OPEN — gates the disconnect log
let outageErrLogged = false;     // log the first error of each outage, then throttle
let lastErrLog = 0;
// ★ sticky idle tracking (idle-watchdog below): skillActive=true between a run_skill send
// and its skill_result. A busy-rejection clears it (the skill never actually started).
let skillActive = false;
let lastSkillEndAt = 0;

function scheduleReconnect() {
    if (reconnectTimer) return;  // one retry per attempt even if error+close both fire
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

// Node's happy-eyeballs resolves localhost to BOTH ::1 and 127.0.0.1, tries both, and
// when both are refused (the normal agent-restart gap) wraps them in an AggregateError
// whose .message is the bare word "AggregateError" — hiding ECONNREFUSED. Unpack the
// nested .errors / .cause / .code so the log distinguishes an expected restart gap
// (ECONNREFUSED) from a genuine fault (anything else).
function describeErr(e) {
    if (!e) return 'unknown';
    const parts = [];
    if (e.code) parts.push(e.code);
    if (Array.isArray(e.errors)) {
        for (const sub of e.errors) parts.push((sub && (sub.code || sub.message)) || String(sub));
    } else if (e.cause) {
        parts.push(e.cause.code || e.cause.message || String(e.cause));
    }
    const base = String(e.message || e);
    return parts.length ? `${base} [${[...new Set(parts)].join(',')}]` : base;
}

function connect() {
    ws = new WebSocket(URL);
    ws.on('open', () => {
        connected = true; wasConnected = true;
        reconnectDelay = RECONNECT_MIN_MS;   // reset backoff on every success
        outageErrLogged = false;
        logEvent({ type: 'bridge_connected' }); writeStatus();
        // Re-arm the supervised skill a few seconds after connect (give the freshly
        // (re)started agent time to finish spawning) so a death-restart can't leave the
        // LLM brain driving the bot back into the mobs that killed it.
        setTimeout(sendStickySkill, 3500);
    });
    ws.on('message', handle);
    ws.on('close', () => {
        // A failed reconnect ATTEMPT also emits 'close' (right after 'error'). Only a
        // socket that was actually live counts as a disconnect — otherwise every retry
        // would log a phantom bridge_disconnected (the old storm).
        if (wasConnected) { logEvent({ type: 'bridge_disconnected' }); }
        connected = false; wasConnected = false; writeStatus();
        scheduleReconnect();
    });
    ws.on('error', (e) => {
        const now = Date.now();
        if (!outageErrLogged || now - lastErrLog >= 30000) {
            outageErrLogged = true; lastErrLog = now;
            logEvent({ type: 'bridge_error', error: describeErr(e), nextRetryMs: reconnectDelay });
        }
    });
}

connect();
setInterval(relayInbox, 1000);
setInterval(writeStatus, 5000);
// ★ STICKY IDLE-WATCHDOG: the 8s re-arm after a skill_result is one-shot and is SKIPPED on a
// busy-rejection — so when that re-arm raced a momentary autonomous-mode action (e.g. dusk
// bunkerDown) and got busy-rejected, the bot sat with NO supervised skill until the next WS
// blip (live 2026-06-18: missionNether idle ~1h after a STUCK-ZONE cancel, "running":null).
// Re-arm whenever idle (no skill active) for >40s; a lost re-arm now self-heals within ~30s.
// Busy-rejections during this are harmless — they just clear skillActive and we retry later.
setInterval(() => {
    if (!(connected && ws && ws.readyState === ws.OPEN)) return;
    if (skillActive) return;
    if (Date.now() - lastSkillEndAt < 40000) return;
    logEvent({ type: 'sticky_idle_rearm', idleMs: Date.now() - lastSkillEndAt });
    sendStickySkill();
}, 30000);
logEvent({ type: 'bridge_started', url: URL });
console.log(`[bridge] started, connecting to ${URL}; frame=${FRAME}`);
