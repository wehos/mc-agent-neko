// N.E.K.O. overseer — god's-eye risk engine + LLM tactical advisor.
//
// A background loop that sees MORE than the bot's in-the-moment reflexes do:
// it fuses the threat radar (radar.json, 5s snapshots from the threat_radar
// mode), vitals trend (vitals.jsonl), the combat blackbox tail, the death
// heat-map (death_log.jsonl) and time-of-day into a single risk score +
// directive, written to advisory.json. The strategy layer (missionNether)
// reads advisory.json each loop and obeys high-risk directives BEFORE doing
// any task work. So the chain stays fully autonomous: overseer judges, the
// bot's own skill code acts — no human-written game state anywhere.
//
// Two tiers:
//   rules  — every 10s, free, deterministic (swarm/no-weapon, dusk exposure,
//            death-zone proximity, hp/food, engagement state)
//   LLM    — only when risk is high (>=60, min 90s apart) or on a slow 6min
//            strategic cadence; gpt-4o-mini, ~200 tokens, can override the
//            rules directive and adds a one-line tactical hint for the log.
//
// Run: node bots/_supervisor/overseer.mjs   (watchdog keeps it alive)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..', '..');
const F = (n) => path.join(DIR, n);
const ADVISORY = F('advisory.json');
const LOG = F('overseer.log');

const log = (s) => {
    try {
        if (fs.existsSync(LOG) && fs.statSync(LOG).size > 10 * 1024 * 1024) {
            try { fs.renameSync(LOG, LOG + '.1'); } catch (e) {}
        }
        fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${s}\n`);
    } catch (e) {}
};

let OPENAI_KEY = null;
try { OPENAI_KEY = JSON.parse(fs.readFileSync(path.join(ROOT, 'keys.json'), 'utf8')).OPENAI_API_KEY || null; } catch (e) {}
const LLM_MODEL = 'gpt-4o-mini';

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
const tail = (p, n) => { try { const a = fs.readFileSync(p, 'utf8').trim().split('\n'); return a.slice(-n); } catch (e) { return []; } };

// ── death heat-map (refreshed only when the line count changes) ──────────────
let deathPts = [], deathLines = -1;
function loadDeaths() {
    const lines = tail(F('death_log.jsonl'), 100000);
    if (lines.length === deathLines) return;
    deathLines = lines.length;
    deathPts = lines.map(l => {
        try { const o = JSON.parse(l); return (typeof o.x === 'number') ? { x: o.x, z: o.z } : null; }
        catch (e) { return null; }
    }).filter(Boolean);
    log(`heat-map reloaded: ${deathPts.length} located deaths`);
}
const deathsNear = (x, z, r) => {
    let n = 0;
    for (const p of deathPts) { const dx = p.x - x, dz = p.z - z; if (dx * dx + dz * dz <= r * r) n++; }
    return n;
};

// densest death cluster = the kill-box (honeycomb spawner area). Deaths #259/261/263/266
// all happened inside one ~30b patch riddled with cave openings — point-level avoidance
// can't stop FALLING IN while passing over it (#266: dropped 18 blocks through the roof
// in one second, creeper-blasted on landing). Recomputed only when the death log grows.
let _dzCache = null, _dzAt = -1;
function dangerZone() {
    if (_dzAt === deathLines) return _dzCache;
    _dzAt = deathLines;
    let best = null, bn = 0;
    for (const p of deathPts) {
        const n = deathsNear(p.x, p.z, 16);
        if (n > bn) { bn = n; best = p; }
    }
    if (!best || bn < 8) { _dzCache = null; return null; }
    const mem = deathPts.filter(q => (q.x - best.x) ** 2 + (q.z - best.z) ** 2 <= 256);
    _dzCache = {
        cx: Math.round(mem.reduce((s, q) => s + q.x, 0) / mem.length),
        cz: Math.round(mem.reduce((s, q) => s + q.z, 0) / mem.length),
        r: 28, n: bn,
    };
    log(`danger zone: center ${_dzCache.cx},${_dzCache.cz} r=28 (${bn} deaths in core)`);
    return _dzCache;
}

// ── rules engine ──────────────────────────────────────────────────────────────
function assess() {
    const v = readJson(F('vitals.json'));
    if (!v || Date.now() - v.ts > 60000) return null;        // bot offline/stale — no advisory
    loadDeaths();

    const inv = v.inv || {};
    const armed = Object.keys(inv).some(n => /_sword$|_axe$/.test(n));
    const radar = readJson(F('radar.json'));                  // layer-1 snapshot; null until that code is live
    const mobs = (radar && Date.now() - radar.ts < 20000) ? (radar.mobs || []) : null;
    const hostiles = mobs ? mobs.length : (v.hostiles || 0);
    const nearest = mobs && mobs.length ? Math.min(...mobs.map(m => m.d)) : null;

    // hostile-count trend over the last ~75s of vitals history
    const hist = tail(F('vitals.jsonl'), 6).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    const avgHostiles = hist.length ? hist.reduce((s, h) => s + (h.hostiles || 0), 0) / hist.length : 0;
    const gathering = hostiles > avgHostiles + 1;

    // engagement state from the blackbox tail
    const cl = tail(F('combat_log.jsonl'), 30);
    let engaged = false;
    for (let i = cl.length - 1; i >= 0; i--) {
        try {
            const o = JSON.parse(cl[i]);
            if (o.ev === 'DISENGAGE') break;
            if (o.ev === 'ENGAGE' || o.ev === 'tick') { engaged = Date.now() - Date.parse(o.t) < 60000; break; }
        } catch (e) {}
    }

    const dz = deathsNear(v.x, v.z, 16);
    const isNight = v.tod >= 12500 && v.tod < 23000;
    const isDusk = v.tod >= 11000 && v.tod < 12500;
    const exposed = v.y >= 60;                                // rough "on the surface"

    let risk = 0; const why = [];
    if (hostiles) { risk += Math.min(40, hostiles * 8); why.push(`${hostiles} hostiles`); }
    if (nearest != null && nearest < 10) { risk += 10; why.push(`nearest ${nearest}b`); }
    if (gathering) { risk += 10; why.push('mobs gathering'); }
    if (engaged) { risk += 25; why.push('ENGAGED'); }
    if (v.hp < 6) { risk += 30; why.push(`hp ${v.hp}`); }
    else if (v.hp < 10) { risk += 20; why.push(`hp ${v.hp}`); }
    else if (v.hp < 14) { risk += 10; why.push(`hp ${v.hp}`); }
    if (v.food < 8) { risk += 10; why.push(`food ${v.food}`); }
    if (!armed && hostiles > 0) { risk += 15; why.push('unarmed'); }
    if (isNight && exposed) { risk += 15; why.push('night+surface'); }
    if (isDusk && exposed) { risk += 15; why.push('dusk+surface'); }
    if (dz >= 3) { risk += 20; why.push(`death-zone(${dz} deaths<16b)`); }
    risk = Math.min(100, risk);

    // directive (priority order). The strategy layer maps these to its own skills.
    let directive = null;
    if (hostiles >= 2 && !armed) directive = 'evac';
    else if (v.hp < 8 && hostiles > 0) directive = 'evac';
    // unarmed + ANY hostile closing inside 10b = disengage now (death #265: one
    // drowned at 2-4b chased the weaponless bot through water for 22s and won —
    // the old >=2-mob gate never fired; with no weapon there is no second option).
    else if (nearest != null && nearest < 10 && !armed) directive = 'evac';
    else if ((isDusk || isNight) && exposed && hostiles === 0) directive = 'shelter_now';
    // hunger-bleed was the shared root cause of deaths #260/#262: below food 18 regen
    // stops, so the bot grinds on at 6-7hp until any scratch kills it. food<=6 in
    // daylight with no contact = drop the task and go eat NOW (feedUp), don't wait for
    // the skill-boundary keepFed check to maybe run. ALSO when critically low on hp
    // with food below the regen line (the hp0.6 incident: food=7 missed the <=6 gate,
    // but at 1hp filling the hunger bar IS the only path back to health).
    // hostile gate: ZERO hostiles proved too strict — mobs loitering at the 24b radar
    // edge blocked eating for an entire day (hp10/food0 stuck at a cliff). A mob 12+
    // blocks away is not a foraging threat; feedUp itself still bails if one closes in.
    else if ((v.food <= 6 || (v.hp < 8 && v.food < 18)) && !isNight && !isDusk
        && (hostiles === 0 || (nearest != null && nearest >= 12))) directive = 'eat_now';
    else if (dz >= 3 && hostiles === 0 && !engaged) directive = 'leave_zone';

    return {
        ts: Date.now(), risk, directive, reason: why.join(', ') || 'calm',
        pos: [v.x, v.y, v.z], hp: v.hp, food: v.food, tod: v.tod,
        hostiles, nearest, armed, deathsNear16: dz, engaged,
        mobs: mobs ? mobs.slice(0, 8) : null,
        dzone: dangerZone(),
        llm: null, src: 'rules',
    };
}

// ── LLM tier ──────────────────────────────────────────────────────────────────
let lastLlmAt = 0;
async function consultLLM(a) {
    if (!OPENAI_KEY) return null;
    const vh = tail(F('vitals.jsonl'), 3).join('\n');
    const ch = tail(F('combat_log.jsonl'), 8).join('\n');
    const prompt =
`You are the tactical overseer for a Minecraft survival bot (MC 1.21). Judge its IMMEDIATE survival situation.
Current assessment by rules engine: risk=${a.risk}/100, directive=${a.directive || 'none'}, reason: ${a.reason}.
Bot: pos=${a.pos.join(',')} hp=${a.hp}/20 food=${a.food}/20 timeOfDay=${a.tod} armed=${a.armed} deaths_within_16b=${a.deathsNear16}.
Radar mobs (name,dist): ${a.mobs ? a.mobs.map(m => `${m.name}@${m.d}b`).join(' ') : 'n/a'}.
Recent vitals:\n${vh}
Combat blackbox tail:\n${ch}
Reply ONLY compact JSON: {"directive":"none|evac|shelter_now|leave_zone|eat_now","hint":"<one tactical sentence, <=140 chars>"}`;
    try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 15000);
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST', signal: ctl.signal,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
            body: JSON.stringify({ model: LLM_MODEL, max_tokens: 200, temperature: 0.2, messages: [{ role: 'user', content: prompt }] }),
        });
        clearTimeout(t);
        if (!res.ok) { log(`LLM http ${res.status}`); return null; }
        const j = await res.json();
        const txt = j.choices?.[0]?.message?.content || '';
        const m = txt.match(/\{[\s\S]*\}/);
        if (!m) return null;
        const out = JSON.parse(m[0]);
        return { directive: ['evac', 'shelter_now', 'leave_zone', 'eat_now'].includes(out.directive) ? out.directive : null, hint: String(out.hint || '').slice(0, 160) };
    } catch (e) { log(`LLM error: ${e.message}`); return null; }
}

// ── main loop ─────────────────────────────────────────────────────────────────
let lastWritten = '';
async function tick() {
    let a;
    try { a = assess(); } catch (e) { log(`assess error: ${e.message}`); return; }
    if (!a) return;

    const now = Date.now();
    const wantLlm = (a.risk >= 60 && now - lastLlmAt > 90000) || (now - lastLlmAt > 360000 && a.risk >= 25);
    if (wantLlm) {
        lastLlmAt = now;
        const l = await consultLLM(a);
        if (l) {
            a.llm = { hint: l.hint, model: LLM_MODEL, at: new Date().toISOString() };
            if (l.directive && l.directive !== a.directive) { a.directive = l.directive; a.src = 'llm'; }
            log(`LLM: directive=${l.directive || 'agree'} hint="${l.hint}"`);
        }
    }

    try { fs.writeFileSync(ADVISORY, JSON.stringify(a)); } catch (e) {}
    const sig = `${a.risk}|${a.directive}|${a.reason}`;
    if (sig !== lastWritten) {
        lastWritten = sig;
        log(`risk=${a.risk} directive=${a.directive || '-'} (${a.reason})${a.llm ? ` | LLM: ${a.llm.hint}` : ''}`);
    }
}

log(`overseer started (LLM ${OPENAI_KEY ? LLM_MODEL : 'DISABLED — no key'})`);
setInterval(() => { tick().catch(e => log(`tick error: ${e.message}`)); }, 10000);
