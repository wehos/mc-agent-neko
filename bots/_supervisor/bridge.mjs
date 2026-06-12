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
    if (data.type === 'skill_result' && !String(data.error || '').startsWith('busy')) {
        setTimeout(sendStickySkill, 8000);
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

function sendStickySkill() {
    let o; try { o = JSON.parse(fs.readFileSync(STICKY, 'utf8')); } catch { return; }
    if (!o || !o.skill) return;
    if (!(connected && ws && ws.readyState === ws.OPEN)) return;
    ws.send(JSON.stringify({ type: 'run_skill', skill: o.skill, args: o.args || [] }));
    logEvent({ type: 'sent_sticky_skill', skill: o.skill, args: o.args || [] });
    writeStatus();
}

function connect() {
    ws = new WebSocket(URL);
    ws.on('open', () => {
        connected = true; logEvent({ type: 'bridge_connected' }); writeStatus();
        // Re-arm the supervised skill a few seconds after connect (give the freshly
        // (re)started agent time to finish spawning) so a death-restart can't leave the
        // LLM brain driving the bot back into the mobs that killed it.
        setTimeout(sendStickySkill, 3500);
    });
    ws.on('message', handle);
    ws.on('close', () => { connected = false; logEvent({ type: 'bridge_disconnected' }); writeStatus(); setTimeout(connect, 3000); });
    ws.on('error', (e) => { logEvent({ type: 'bridge_error', error: String(e.message || e) }); });
}

connect();
setInterval(relayInbox, 1000);
setInterval(writeStatus, 5000);
logEvent({ type: 'bridge_started', url: URL });
console.log(`[bridge] started, connecting to ${URL}; frame=${FRAME}`);
