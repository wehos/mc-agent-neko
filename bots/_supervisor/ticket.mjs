#!/usr/bin/env node
// ticket — CLI over the resident ticket-server (localhost:48920). This is how an agent
// (a Claude subagent I spawn, OR a human's brand-new Claude session) gets up to speed and
// claims work WITHOUT colliding: every claim is serialized by the single-writer server, so
// "who owns T-0007" is consistent across every session.
//
// FRESH-SESSION ONBOARDING — a new agent runs ONE command and is ready:
//     node bots/_supervisor/ticket.mjs onboard
//
// Common:
//     ticket.mjs list [status]                 # default: active (open/claimed/in_progress/...)
//     ticket.mjs next                          # the top unclaimed ticket to work on
//     ticket.mjs show T-0007
//     ticket.mjs claim T-0007 --as claude-B    # atomic; fails if someone else holds it
//     ticket.mjs mine --as claude-B
//     ticket.mjs create --type seal-fail --sev high --title "..." [--detail "..."]
//     ticket.mjs update T-0007 --status fixed --note "C282 ..." [--commit <sha>]
//     ticket.mjs comment T-0007 "tried X, root cause is Y"
//
// Identity: pass --as <tag>, or set env TICKET_ACTOR. Pick a stable, UNIQUE tag per session
// (e.g. claude-A / claude-B / user) so claims don't clash.

import http from 'http';

const PORT = parseInt(process.env.TICKET_PORT || '48920', 10);
const HOST = '127.0.0.1';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = {};
const pos = [];
for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); if (argv[i + 1] && !argv[i + 1].startsWith('--')) { flags[k] = argv[++i]; } else flags[k] = true; }
    else pos.push(a);
}
const actor = flags.as || process.env.TICKET_ACTOR || 'claude';

function req(method, p, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const r = http.request({ host: HOST, port: PORT, path: p, method, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
            (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ code: res.statusCode, body: JSON.parse(d || '{}') }); } catch { resolve({ code: res.statusCode, body: d }); } }); });
        r.on('error', (e) => reject(e));
        if (data) r.write(data);
        r.end();
    });
}

const sevIcon = { critical: '🔴', high: '🟠', med: '🟡', low: '⚪' };
function line(t) {
    const who = t.claimedBy ? ` 👤${t.claimedBy}` : '';
    const occ = t.occurrences > 1 ? ` ×${t.occurrences}` : '';
    return `${t.id}  ${sevIcon[t.severity] || '·'} ${t.status.padEnd(11)} ${t.type.padEnd(13)} ${t.title}${occ}${who}`;
}

async function main() {
    try {
        if (!cmd || cmd === 'help') {
            console.log('ticket.mjs — commands: onboard | list [status] | next | show <id> | claim <id> --as X | mine --as X | create ... | update <id> --status S | comment <id> "..."');
            return;
        }
        if (cmd === 'onboard') {
            const sum = (await req('GET', '/api/summary')).body;
            const active = (await req('GET', '/api/tickets?status=open-ish')).body;
            const unclaimed = active.filter(t => !t.claimedBy);
            console.log('═══ Neko ticket system — you are now onboarded ═══');
            console.log(`server: http://localhost:${PORT}  (web UI for humans at /)`);
            console.log(`totals: ${JSON.stringify(sum.byStatus)}`);
            console.log(`\nACTIVE tickets (${active.length}); UNCLAIMED (${unclaimed.length}):`);
            for (const t of active) console.log('  ' + line(t));
            console.log('\nTo take work:  node bots/_supervisor/ticket.mjs claim <id> --as <your-unique-tag>');
            console.log('Pick a UNIQUE tag (claude-A / claude-B / user) so claims don\'t collide across sessions.');
            console.log('Read docs/parallel-tickets.md for the full pipeline + deploy gate rules.');
            return;
        }
        if (cmd === 'list') {
            const status = pos[0] || 'open-ish';
            const ts = (await req('GET', `/api/tickets?status=${encodeURIComponent(status)}`)).body;
            if (!Array.isArray(ts)) return console.log(ts);
            console.log(`${ts.length} ticket(s) [${status}]:`);
            for (const t of ts) console.log('  ' + line(t));
            return;
        }
        if (cmd === 'next') {
            const ts = (await req('GET', '/api/tickets?status=open-ish')).body;
            const t = (Array.isArray(ts) ? ts : []).find(x => !x.claimedBy);
            if (!t) return console.log('no unclaimed active tickets 🎉');
            console.log('next up:\n  ' + line(t) + `\n  claim it: node bots/_supervisor/ticket.mjs claim ${t.id} --as <tag>`);
            return;
        }
        if (cmd === 'show') {
            const t = (await req('GET', `/api/tickets/${pos[0]}`)).body;
            console.log(JSON.stringify(t, null, 2));
            return;
        }
        if (cmd === 'mine') {
            const ts = (await req('GET', `/api/tickets?claimedBy=${encodeURIComponent(actor)}`)).body;
            console.log(`${(ts || []).length} ticket(s) owned by ${actor}:`);
            for (const t of ts) console.log('  ' + line(t));
            return;
        }
        if (cmd === 'claim') {
            const r = await req('POST', `/api/tickets/${pos[0]}/claim`, { actor });
            if (r.code === 409) { console.log(`✗ already claimed by ${r.body.claimedBy} — pick another (run: ticket.mjs next)`); process.exitCode = 1; return; }
            console.log(`✓ ${pos[0]} claimed by ${actor}`);
            return;
        }
        if (cmd === 'release') { await req('POST', `/api/tickets/${pos[0]}/release`, { actor }); console.log(`released ${pos[0]}`); return; }
        if (cmd === 'comment') { await req('POST', `/api/tickets/${pos[0]}/comment`, { actor, note: pos.slice(1).join(' ') }); console.log('commented'); return; }
        if (cmd === 'create') {
            const r = await req('POST', '/api/tickets', { source: 'manual', actor, type: flags.type, severity: flags.sev || flags.severity, title: flags.title || pos.join(' '), detail: flags.detail || '' });
            console.log(`created ${r.body.ticket ? r.body.ticket.id : '?'}${r.body.merged ? ' (merged into existing)' : ''}`);
            return;
        }
        if (cmd === 'update') {
            const resolution = (flags.commit || flags.prediction) ? { commit: flags.commit || null, prediction: flags.prediction || null } : undefined;
            await req('POST', `/api/tickets/${pos[0]}/update`, { actor, status: flags.status, note: flags.note, severity: flags.sev, resolution });
            console.log(`updated ${pos[0]}${flags.status ? ' → ' + flags.status : ''}`);
            return;
        }
        console.log('unknown command:', cmd);
    } catch (e) {
        console.error(`✗ ticket-server unreachable on :${PORT} (${e.message}). Start it: node bots/_supervisor/ticket-server.mjs`);
        process.exitCode = 2;
    }
}
main();
