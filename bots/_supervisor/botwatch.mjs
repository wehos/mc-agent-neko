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
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const POLL_MS = 20000;
const STALL_SEC = 360;        // 6 min unmoved / progress-frozen => livelock alert
const HEARTBEAT_SEC = 600;    // 10 min forced "still here" line
const LOW_HP = 8, LOW_FOOD = 5, STALE_SEC = 90;

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
        if (lastDeaths >= 0 && deaths > lastDeaths) flags.push(`★DEATH+${deaths - lastDeaths}`);

        // POSITION STALL — the livelock detector
        const pos = { x: v.x, z: v.z };
        if (!lastPos || Math.abs(pos.x - lastPos.x) > 2 || Math.abs(pos.z - lastPos.z) > 2) {
            lastPos = pos; lastMoveAt = t; stallAlerted = false;
        } else {
            const stalledS = Math.round((t - lastMoveAt) / 1000);
            if (stalledS > STALL_SEC && !stallAlerted) { stallAlerted = true; flags.push(`★STALL ${Math.round(stalledS / 60)}min @${v.x},${v.y},${v.z}`); }
        }

        // PROGRESS FROZEN — same last progress line for too long (skill looping in place)
        if (prog !== lastProg) { lastProg = prog; lastProgAt = t; frozenAlerted = false; }
        else {
            const frozenS = Math.round((t - lastProgAt) / 1000);
            if (frozenS > STALL_SEC && !frozenAlerted) { frozenAlerted = true; flags.push(`★FROZEN ${Math.round(frozenS / 60)}min: "${prog}"`); }
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
