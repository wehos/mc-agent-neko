// ticket-server — the resident, single-writer ticket store for parallel problem-handling
// on ONE Minecraft session. The bot is a single control lane; this server makes the
// OBSERVE→DIAGNOSE→FIX pipeline parallelizable by turning problems into durable, claimable
// tickets that multiple agents (Claude subagents, OR a human's fresh Claude session) can
// see and divide without colliding.
//
// WHY a server (not just files): cross-session claim sync needs a SINGLE WRITER so two
// agents can't claim the same ticket. Every mutation goes through this one process →
// no races. Tickets are also persisted to tickets/<id>.json so state survives a restart.
//
// Storage : bots/_supervisor/tickets/<id>.json  (source of truth = this server's in-mem
//           index, mirrored to disk on every write; reloaded on boot)
// API     : GET  /api/tickets?status=&type=&claimedBy=&dedupKey=
//           GET  /api/tickets/:id
//           POST /api/tickets                      {source,type,severity,title,detail,dedupKey,evidence}
//           POST /api/tickets/:id/claim            {actor}             (409 if already claimed)
//           POST /api/tickets/:id/release          {actor}
//           POST /api/tickets/:id/update           {actor,status?,note?,resolution?}
//           POST /api/tickets/:id/comment          {actor,note}
//           GET  /api/summary
//           GET  /health
//           GET  /                                 human web UI (view / create / claim / close)
//
// Run     : node bots/_supervisor/ticket-server.mjs   (port 48920, override with TICKET_PORT)

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const TICKETS_DIR = path.join(DIR, 'tickets');
const SEQ_FILE = path.join(TICKETS_DIR, '.seq');
const PORT = parseInt(process.env.TICKET_PORT || '48920', 10);

const STATUSES = ['open', 'claimed', 'in_progress', 'fixed', 'verifying', 'closed', 'wontfix'];
const OPEN_STATUSES = new Set(['open', 'claimed', 'in_progress', 'fixed', 'verifying']);   // not terminal

if (!fs.existsSync(TICKETS_DIR)) fs.mkdirSync(TICKETS_DIR, { recursive: true });

// ── in-memory index (source of truth), mirrored to disk ──────────────────────────────
const tickets = new Map();   // id -> ticket
let seq = 0;

function loadAll() {
    try { seq = parseInt(fs.readFileSync(SEQ_FILE, 'utf8'), 10) || 0; } catch { seq = 0; }
    for (const f of fs.readdirSync(TICKETS_DIR)) {
        if (!f.endsWith('.json')) continue;
        try {
            const t = JSON.parse(fs.readFileSync(path.join(TICKETS_DIR, f), 'utf8'));
            if (t && t.id) tickets.set(t.id, t);
            const n = parseInt(String(t.id).replace(/^T-/, ''), 10);
            if (n > seq) seq = n;
        } catch (e) { console.error('load fail', f, e.message); }
    }
    console.log(`[ticket-server] loaded ${tickets.size} tickets, seq=${seq}`);
}

function persist(t) {
    try { fs.writeFileSync(path.join(TICKETS_DIR, `${t.id}.json`), JSON.stringify(t, null, 2)); } catch (e) { console.error('persist fail', t.id, e.message); }
}
function bumpSeq() { seq += 1; try { fs.writeFileSync(SEQ_FILE, String(seq)); } catch {} return seq; }
const nowIso = () => new Date().toISOString();

function newTicket(body) {
    const id = `T-${String(bumpSeq()).padStart(4, '0')}`;
    const t = {
        id,
        createdAt: nowIso(), updatedAt: nowIso(),
        source: body.source === 'manual' ? 'manual' : 'auto',
        type: body.type || 'misc',
        severity: ['critical', 'high', 'med', 'low'].includes(body.severity) ? body.severity : 'med',
        title: (body.title || body.type || 'untitled').slice(0, 140),
        detail: body.detail || '',
        dedupKey: body.dedupKey || null,
        occurrences: 1,
        evidence: body.evidence || {},
        status: 'open',
        claimedBy: null, claimedAt: null,
        resolution: null,
        history: [{ ts: nowIso(), actor: body.actor || body.source || 'system', action: 'created', note: body.title || '' }],
    };
    tickets.set(id, t); persist(t);
    return t;
}

// auto-tickets dedup: if an OPEN ticket with the same dedupKey exists, bump it instead of
// creating a duplicate (an ongoing seal-fail / pacing loop is ONE ticket, not 200).
function createOrMerge(body) {
    if (body.dedupKey) {
        for (const t of tickets.values()) {
            if (t.dedupKey === body.dedupKey && OPEN_STATUSES.has(t.status)) {
                t.occurrences += 1; t.updatedAt = nowIso();
                if (body.evidence) t.evidence = body.evidence;   // freshest snapshot
                t.history.push({ ts: nowIso(), actor: body.actor || 'detector', action: 'recurred', note: `occurrence #${t.occurrences}` });
                if (t.history.length > 60) t.history = t.history.slice(-60);
                persist(t);
                return { ticket: t, merged: true };
            }
        }
    }
    return { ticket: newTicket(body), merged: false };
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────────────
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((resolve) => {
    let d = ''; req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
});

function listTickets(q) {
    let arr = [...tickets.values()];
    if (q.status) arr = arr.filter(t => t.status === q.status);
    if (q.status === 'open-ish') arr = [...tickets.values()].filter(t => OPEN_STATUSES.has(t.status));
    if (q.type) arr = arr.filter(t => t.type === q.type);
    if (q.claimedBy) arr = arr.filter(t => t.claimedBy === q.claimedBy);
    if (q.dedupKey) arr = arr.filter(t => t.dedupKey === q.dedupKey);
    const sev = { critical: 0, high: 1, med: 2, low: 3 };
    const sts = { open: 0, claimed: 1, in_progress: 2, fixed: 3, verifying: 4, closed: 5, wontfix: 6 };
    arr.sort((a, b) => (sts[a.status] - sts[b.status]) || (sev[a.severity] - sev[b.severity]) || (a.createdAt < b.createdAt ? -1 : 1));
    return arr;
}

function summary() {
    const by = {}; for (const s of STATUSES) by[s] = 0;
    const byType = {};
    for (const t of tickets.values()) { by[t.status] = (by[t.status] || 0) + 1; byType[t.type] = (byType[t.type] || 0) + 1; }
    return { total: tickets.size, byStatus: by, byType };
}

const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    const p = u.pathname;
    try {
        if (p === '/health') return send(res, 200, { ok: true, tickets: tickets.size });
        if (p === '/api/summary') return send(res, 200, summary());

        if (p === '/api/tickets' && req.method === 'GET') {
            return send(res, 200, listTickets(Object.fromEntries(u.searchParams)));
        }
        if (p === '/api/tickets' && req.method === 'POST') {
            const body = await readBody(req);
            if (!body.title && !body.type) return send(res, 400, { error: 'need title or type' });
            const { ticket, merged } = createOrMerge(body);
            return send(res, merged ? 200 : 201, { ticket, merged });
        }
        const m = p.match(/^\/api\/tickets\/(T-\d+)(?:\/(claim|release|update|comment))?$/);
        if (m) {
            const t = tickets.get(m[1]);
            if (!t) return send(res, 404, { error: 'no such ticket' });
            const action = m[2];
            if (!action && req.method === 'GET') return send(res, 200, t);
            const body = await readBody(req);
            const actor = body.actor || 'anon';
            if (action === 'claim') {
                if (t.claimedBy && t.claimedBy !== actor && OPEN_STATUSES.has(t.status))
                    return send(res, 409, { error: 'already claimed', claimedBy: t.claimedBy });
                t.claimedBy = actor; t.claimedAt = nowIso(); if (t.status === 'open') t.status = 'claimed';
                t.updatedAt = nowIso(); t.history.push({ ts: nowIso(), actor, action: 'claimed', note: '' });
                persist(t); return send(res, 200, t);
            }
            if (action === 'release') {
                t.claimedBy = null; t.claimedAt = null; if (t.status === 'claimed') t.status = 'open';
                t.updatedAt = nowIso(); t.history.push({ ts: nowIso(), actor, action: 'released', note: '' });
                persist(t); return send(res, 200, t);
            }
            if (action === 'comment') {
                t.updatedAt = nowIso(); t.history.push({ ts: nowIso(), actor, action: 'comment', note: (body.note || '').slice(0, 500) });
                persist(t); return send(res, 200, t);
            }
            if (action === 'update') {
                if (body.status) {
                    if (!STATUSES.includes(body.status)) return send(res, 400, { error: 'bad status' });
                    t.status = body.status;
                }
                if (body.resolution) t.resolution = body.resolution;
                if (body.severity && ['critical', 'high', 'med', 'low'].includes(body.severity)) t.severity = body.severity;
                t.updatedAt = nowIso();
                t.history.push({ ts: nowIso(), actor, action: 'update', note: body.note || (body.status ? `→${body.status}` : '') });
                persist(t); return send(res, 200, t);
            }
        }
        if (p === '/' || p === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(UI_HTML); }
        return send(res, 404, { error: 'not found' });
    } catch (e) { return send(res, 500, { error: String(e && e.message || e) }); }
});

// ── minimal human web UI (view / create / claim / close) ──────────────────────────────
const UI_HTML = `<!doctype html><meta charset=utf-8><title>Neko Tickets</title>
<style>
 body{font:13px system-ui,monospace;margin:0;background:#0f1115;color:#cdd3de}
 header{padding:10px 16px;background:#171a21;position:sticky;top:0;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
 h1{font-size:15px;margin:0}
 .sum span{margin-right:10px;opacity:.8}
 main{padding:12px 16px}
 .t{border:1px solid #2a2f3a;border-radius:6px;padding:8px 10px;margin:6px 0;background:#13161c}
 .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
 .id{font-weight:bold}
 .b{padding:1px 6px;border-radius:4px;font-size:11px}
 .critical{background:#5a1620;color:#ff8a9b}.high{background:#5a3a16;color:#ffc27a}.med{background:#1d3a5a;color:#7abaff}.low{background:#27303a;color:#9aa6b6}
 .open{background:#1a4a2a;color:#86e0a0}.claimed{background:#4a4416;color:#e6d77a}.in_progress{background:#16404a;color:#7ad6e0}
 .fixed{background:#2a2f3a;color:#cdd3de}.verifying{background:#3a2a5a;color:#c49aff}.closed,.wontfix{opacity:.5}
 .det{opacity:.85;margin-top:4px;white-space:pre-wrap;font-size:12px}
 button,select,input,textarea{background:#1d2230;color:#cdd3de;border:1px solid #2a2f3a;border-radius:4px;padding:4px 8px;font:inherit}
 button{cursor:pointer}button:hover{background:#27304a}
 form{margin:0}
 .new{border:1px dashed #3a4252;padding:10px;border-radius:6px;margin-bottom:12px}
 .new input,.new textarea{width:100%;box-sizing:border-box;margin:3px 0}
 .meta{opacity:.6;font-size:11px}
</style>
<header>
 <h1>🎫 Neko Tickets</h1>
 <div class=sum id=sum></div>
 <span style=flex:1></span>
 <label>filter <select id=f onchange=load()>
   <option value=open-ish>open (active)</option><option value=open>open</option>
   <option value=claimed>claimed</option><option value=in_progress>in_progress</option>
   <option value=fixed>fixed</option><option value=verifying>verifying</option>
   <option value=closed>closed</option><option value="">all</option></select></label>
 <button onclick=load()>↻</button>
</header>
<main>
 <div class=new>
  <b>+ New ticket (manual)</b>
  <input id=nt placeholder="title (one-line symptom)">
  <div class=row>
   <select id=ntype><option>pacing</option><option>idle</option><option>stuck</option><option>seal-fail</option><option>death</option><option>food-spiral</option><option>gate-interlock</option><option>terrain</option><option>misc</option></select>
   <select id=nsev><option>high</option><option>critical</option><option>med</option><option>low</option></select>
   <button onclick=create()>create</button>
  </div>
  <textarea id=ndetail rows=2 placeholder="detail / where / what you saw (optional)"></textarea>
 </div>
 <div id=list></div>
</main>
<script>
const A=async(u,m,b)=>(await fetch(u,{method:m||'GET',headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined})).json();
async function load(){
 const f=document.getElementById('f').value;
 const s=await A('/api/summary');
 document.getElementById('sum').innerHTML=Object.entries(s.byStatus).filter(([k,v])=>v).map(([k,v])=>'<span>'+k+':'+v+'</span>').join('');
 const ts=await A('/api/tickets?status='+f);
 document.getElementById('list').innerHTML=ts.map(card).join('')||'<i>none</i>';
}
function card(t){
 const ev=t.evidence||{};
 const evs=ev.pos?('pos='+ev.pos.join(',')) : '';
 return '<div class=t><div class=row>'
  +'<span class=id>'+t.id+'</span>'
  +'<span class="b '+t.severity+'">'+t.severity+'</span>'
  +'<span class="b '+t.status+'">'+t.status+'</span>'
  +'<span class="b" style="background:#222">'+t.type+'</span>'
  +'<b>'+esc(t.title)+'</b>'
  +(t.occurrences>1?'<span class=meta>×'+t.occurrences+'</span>':'')
  +'<span style=flex:1></span>'
  +(t.claimedBy?'<span class=meta>👤 '+esc(t.claimedBy)+'</span>':'')
  +'</div>'
  +(t.detail?'<div class=det>'+esc(t.detail)+'</div>':'')
  +(evs?'<div class=meta>'+evs+(ev.progressTail?(' | '+esc(ev.progressTail)):'')+'</div>':'')
  +'<div class=row style=margin-top:6px>'
  +'<input style=width:120px placeholder=actor id=act_'+t.id+' value=user>'
  +'<button onclick="claim(\\''+t.id+'\\')">claim</button>'
  +sel(t.id,t.status)
  +'<span class=meta>'+t.updatedAt.slice(11,19)+'</span>'
  +'</div></div>';
}
function sel(id,cur){return '<select onchange="upd(\\''+id+'\\',this.value)">'
 +['(set status)','open','claimed','in_progress','fixed','verifying','closed','wontfix'].map(s=>'<option'+(s===cur?' selected':'')+'>'+s+'</option>').join('')+'</select>';}
const actor=id=>document.getElementById('act_'+id).value||'user';
async function claim(id){await A('/api/tickets/'+id+'/claim','POST',{actor:actor(id)});load();}
async function upd(id,s){if(s.startsWith('('))return;await A('/api/tickets/'+id+'/update','POST',{actor:actor(id),status:s});load();}
async function create(){const title=document.getElementById('nt').value.trim();if(!title)return;
 await A('/api/tickets','POST',{source:'manual',actor:'user',title,type:document.getElementById('ntype').value,severity:document.getElementById('nsev').value,detail:document.getElementById('ndetail').value});
 document.getElementById('nt').value='';document.getElementById('ndetail').value='';load();}
function esc(s){return String(s).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}
load();setInterval(load,5000);
</script>`;

loadAll();
server.listen(PORT, '127.0.0.1', () => console.log(`[ticket-server] listening http://localhost:${PORT}  (${tickets.size} tickets)`));
