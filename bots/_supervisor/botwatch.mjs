// botwatch — the monitor the old one should have been. The first version watched only death
// count (a LAGGING signal — fires after the bot is already dead) and skill-name (INVARIANT
// through a livelock), so a 36-minute zero-progress stall passed completely silently. This
// watches the signals that actually precede trouble, above all POSITION-STALL — the live
// livelock/soft-lock detector that was missing.
//
// Emits one stdout line (= one Monitor notification) ONLY on a real event or the heartbeat:
//   ★DEATH     death count rose
//   ★STALL     position unchanged (<=2 blocks) for > STALL_SEC — the livelock signal
//   ★FROZEN    progress.txt last line unchanged for > STALL_SEC (skill looping in place)
//   ★LOWHP     hp crossed <= 8 (transition)
//   ★LOWFOOD   food crossed <= 5 (transition)
//   ★STALE     vitals stopped updating (agent down) (transition)
//   skill:X    supervised skill changed
//   (heartbeat) every HEARTBEAT_SEC so silence always means "fresh & unchanged", not "dead monitor"
//
// Run: node bots/_supervisor/botwatch.mjs

import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const POLL_MS = 20000;
const STALL_SEC = 360;        // 6 min unmoved / progress-frozen => livelock alert
const HEARTBEAT_SEC = parseInt(process.argv[2] || '1800', 10);  // 0/huge disables; pass arg to override
const LOW_HP = 8, LOW_FOOD = 5, STALE_SEC = 90;
const TICKET_PORT = parseInt(process.env.TICKET_PORT || '48920', 10);

// Fire-and-forget POST to the ticket-server. Auto-tickets carry a dedupKey so an ONGOING
// problem (death loop, pacing, seal-fail thrash) is ONE ticket that bumps occurrences, not
// hundreds. Never throws — if the server is down, detection just no-ops (botwatch survives).
// newest black-box frame path (so a ticket carries a visual of the moment it fired)
function latestFrame() {
    try {
        const d = path.join(DIR, 'frames');
        const fs2 = fs.readdirSync(d).filter(f => /^\d{10,}\.jpg$/.test(f)).sort();
        const f = fs2[fs2.length - 1];
        return f ? path.join('bots', '_supervisor', 'frames', f) : null;
    } catch { return null; }
}
function postTicket(t) {
    try {
        if (t.evidence && !t.evidence.frames) { const fr = latestFrame(); if (fr) t.evidence.frames = [fr]; }
        const data = JSON.stringify({ source: 'auto', actor: 'botwatch', ...t });
        const req = http.request({ host: '127.0.0.1', port: TICKET_PORT, path: '/api/tickets', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => { res.on('data', () => {}); res.on('end', () => {}); });
        req.on('error', () => {});
        req.write(data); req.end();
    } catch {}
}
// recent tail of events.log (for seal-fail / death-cause enrichment)
function eventsTail(maxLines = 60) {
    try { const L = (rd('events.log') || '').trim().split(/\n/); return L.slice(-maxLines); } catch { return []; }
}
let lastSealFailTicketAt = 0;

const rd = (n) => { try { return fs.readFileSync(path.join(DIR, n), 'utf8'); } catch { return null; } };
const now = () => Date.now();

let lastDeaths = -1;
let lastPos = null, lastMoveAt = now();
let lastProg = null, lastProgAt = now();
let lastSkill = null;
let stallAlerted = false, frozenAlerted = false;
let lowHp = false, lowFood = false, stale = false;
let lastEmit = 0;

function readState() {
    let deaths = lastDeaths;
    try { deaths = (rd('death_log.jsonl') || '').trim().split(/\n/).filter(Boolean).length; } catch {}
    let v = null;
    try { v = JSON.parse(rd('vitals.json')); } catch {}
    let prog = '';
    try { const L = (rd('progress.txt') || '').trim().split(/\n/); prog = (L[L.length - 1] || '').replace(/^\[[^\]]*\]\s*/, '').slice(0, 90); } catch {}
    return { deaths, v, prog };
}

function tick() {
    const t = now();
    const { deaths, v, prog } = readState();
    const flags = [];

    if (!v) { if (!stale) { stale = true; flags.push('★STALE(no vitals)'); } }
    else {
        const ageS = Math.round((t - v.ts) / 1000);
        // STALE (agent stopped writing telemetry)
        if (ageS > STALE_SEC) { if (!stale) { stale = true; flags.push(`★STALE(vitals ${ageS}s old)`); } }
        else if (stale) { stale = false; flags.push('recovered:live'); }

        // DEATH
        if (lastDeaths >= 0 && deaths > lastDeaths) {
            flags.push(`★DEATH+${deaths - lastDeaths}`);
            const ev = eventsTail(30);
            const deathLine = [...ev].reverse().find(l => /阵亡/.test(l)) || '';
            const cause = (deathLine.match(/"kind":"(\w+)"/) || [])[1] || '';
            postTicket({
                type: 'death', severity: 'critical', dedupKey: 'death-loop',
                title: `bot 连续死亡 (${deaths} 次)${cause ? ' — ' + cause : ''}`,
                detail: deathLine.replace(/^\[[^\]]*\]\s*/, '').slice(0, 240),
                evidence: { pos: [v.x, v.y, v.z], vitals: { hp: v.hp, food: v.food, skill: v.skill }, events: ev.filter(l => /阵亡|告急|Outmatched|seal/.test(l)).slice(-6), progressTail: prog },
            });
        }

        // POSITION STALL — the livelock detector
        const pos = { x: v.x, z: v.z };
        if (!lastPos || Math.abs(pos.x - lastPos.x) > 2 || Math.abs(pos.z - lastPos.z) > 2) {
            lastPos = pos; lastMoveAt = t; stallAlerted = false;
        } else {
            const stalledS = Math.round((t - lastMoveAt) / 1000);
            if (stalledS > STALL_SEC && !stallAlerted) {
                stallAlerted = true; flags.push(`★STALL ${Math.round(stalledS / 60)}min @${v.x},${v.y},${v.z}`);
                postTicket({
                    type: 'stuck', severity: 'high', dedupKey: `stuck:${Math.floor(v.x / 16)},${Math.floor(v.z / 16)}`,
                    title: `位置停滞 ${Math.round(stalledS / 60)}min @${v.x},${v.y},${v.z}`,
                    detail: `skill=${v.skill} hp=${v.hp} food=${v.food} mob=${v.mob || '-'}`,
                    evidence: { pos: [v.x, v.y, v.z], vitals: { hp: v.hp, food: v.food, skill: v.skill }, progressTail: prog },
                });
            }
        }

        // PROGRESS FROZEN — same last progress line for too long (skill looping in place)
        if (prog !== lastProg) { lastProg = prog; lastProgAt = t; frozenAlerted = false; }
        else {
            const frozenS = Math.round((t - lastProgAt) / 1000);
            if (frozenS > STALL_SEC && !frozenAlerted) {
                frozenAlerted = true; flags.push(`★FROZEN ${Math.round(frozenS / 60)}min: "${prog}"`);
                postTicket({
                    type: 'idle', severity: 'high', dedupKey: 'frozen',
                    title: `进度冻结 ${Math.round(frozenS / 60)}min: ${prog}`.slice(0, 140),
                    detail: `skill=${v.skill} @${v.x},${v.y},${v.z} hp=${v.hp} food=${v.food}`,
                    evidence: { pos: [v.x, v.y, v.z], vitals: { hp: v.hp, food: v.food, skill: v.skill }, progressTail: prog },
                });
            }
        }

        // SEAL-FAIL thrash — proactive seal repeatedly stands down (the badlands-night death cause)
        {
            const ev = eventsTail(40);
            const sealFails = ev.filter(l => /Can't seal here/.test(l)).length;
            if (sealFails >= 4 && t - lastSealFailTicketAt > 300000) {
                lastSealFailTicketAt = t; flags.push(`★SEALFAIL ×${sealFails}`);
                postTicket({
                    type: 'seal-fail', severity: 'critical', dedupKey: 'seal-fail',
                    title: `封顶反复失败 (${sealFails}× Can't seal in window)`,
                    detail: `bot 夜里站着不封顶,易被怪杀 @${v.x},${v.y},${v.z} hp=${v.hp} food=${v.food}`,
                    evidence: { pos: [v.x, v.y, v.z], vitals: { hp: v.hp, food: v.food, skill: v.skill }, events: ev.filter(l => /seal|Outmatched|阵亡/.test(l)).slice(-6), progressTail: prog },
                });
            }
        }

        // LOW HP / FOOD transitions
        if (v.hp <= LOW_HP) { if (!lowHp) { lowHp = true; flags.push(`★LOWHP=${v.hp}`); } } else if (lowHp && v.hp >= LOW_HP + 4) { lowHp = false; }
        if (v.food <= LOW_FOOD) { if (!lowFood) { lowFood = true; flags.push(`★LOWFOOD=${v.food}`); } } else if (lowFood && v.food >= LOW_FOOD + 4) { lowFood = false; }

        // skill change
        if (v.skill !== lastSkill) { if (lastSkill !== null) flags.push(`skill:${lastSkill}->${v.skill || '-'}`); lastSkill = v.skill; }
    }
    lastDeaths = deaths;

    const heartbeat = (t - lastEmit) / 1000 >= HEARTBEAT_SEC;
    if (flags.length || heartbeat) {
        const ts = new Date(t).toISOString().slice(11, 19);
        const vit = v ? `pos=${v.x},${v.y},${v.z} hp=${v.hp} food=${v.food} skill=${v.skill || '-'} mob=${v.mob || '-'} tod=${v.tod}` : 'no-vitals';
        console.log(`[${ts}] deaths=${deaths} ${vit}${flags.length ? '  ' + flags.join(' ') : '  (heartbeat)'}`);
        lastEmit = t;
    }
}

console.log(`botwatch: STALL>${STALL_SEC}s, LOWHP<=${LOW_HP}, LOWFOOD<=${LOW_FOOD}, heartbeat ${HEARTBEAT_SEC}s, poll ${POLL_MS / 1000}s`);
tick();
setInterval(tick, POLL_MS);
