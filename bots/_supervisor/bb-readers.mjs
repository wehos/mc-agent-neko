// bb-readers — shared black-box read layer.
//
// WHY: botwatch (sentinel) and overseer-snapshot both read the SAME runtime artifacts
// (world_model.json / vitals(.json|.jsonl) / death_log.jsonl / events.log / sentinel.json).
// Keeping the path + parse + omniscient-fuse logic in ONE place means the two consumers can
// never drift on field names or staleness semantics. botwatch imports readState/rd/rj/… from
// here verbatim (no logic change); overseer-snapshot imports the same low-level readers plus
// readJsonl for its history aggregations.
//
// Pure reads only — NO detector/ticket logic lives here. Every reader is crash-proof: a missing
// or half-written file yields null/[] rather than throwing (the bot writes these live).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const DIR = path.dirname(fileURLToPath(import.meta.url));
export const TICKET_PORT = parseInt(process.env.TICKET_PORT || '48920', 10);

export const now = () => Date.now();
export const rd = (n) => { try { return fs.readFileSync(path.join(DIR, n), 'utf8'); } catch { return null; } };
export const rj = (n) => { try { return JSON.parse(rd(n)); } catch { return null; } };

// read a .jsonl, return the last `max` successfully-parsed objects (bad/half lines skipped).
export function readJsonl(n, max = Infinity) {
    const raw = rd(n); if (!raw) return [];
    const lines = raw.trim().split(/\n/);
    const slice = max === Infinity ? lines : lines.slice(-max);
    const out = [];
    for (const ln of slice) { if (!ln) continue; try { out.push(JSON.parse(ln)); } catch {} }
    return out;
}

export function latestFrame() {
    try {
        const fs2 = fs.readdirSync(path.join(DIR, 'frames')).filter(f => /^\d{10,}\.jpg$/.test(f)).sort();
        const f = fs2[fs2.length - 1];
        return f ? path.join('bots', '_supervisor', 'frames', f) : null;
    } catch { return null; }
}

export function eventsTail(maxLines = 80) { const L = (rd('events.log') || '').trim().split(/\n/); return L.slice(-maxLines); }

// ── omniscient state read: fuse world_model + vitals + events + death_log ─────────────────
// Returns the same shape botwatch's detectors consume. `ach` is the bucketed achievement vector:
// buckets only step on MEANINGFUL gains so 1-unit jitter never resets a staleness clock.
export function readState(t = now()) {
    const v = rj('vitals.json');
    const wm = rj('world_model.json');
    let deaths = 0; try { deaths = (rd('death_log.jsonl') || '').trim().split(/\n/).filter(Boolean).length; } catch {}
    let progTail = ''; try { const L = (rd('progress.txt') || '').trim().split(/\n/); progTail = (L[L.length - 1] || '').replace(/^\[[^\]]*\]\s*/, '').slice(0, 100); } catch {}
    const inv = (v && v.inv) || {};
    const has = (re) => Object.keys(inv).some(k => re.test(k));
    const count = (re) => Object.entries(inv).reduce((s, [k, n]) => s + (re.test(k) ? n : 0), 0);

    const ageS = v ? Math.round((t - v.ts) / 1000) : 9999;
    const mob = (wm && wm.mobility && wm.mobility.state) || (v && v.mob) || '';
    const picks = (wm && wm.kit && wm.kit.picks != null) ? wm.kit.picks : (has(/_pickaxe$/) ? 1 : 0);

    const pickTier = (wm && wm.kit && wm.kit.pickTier) || (has(/_pickaxe$/) ? 'have' : 'none');
    const ach = [
        'p:' + pickTier,
        't:' + (has(/crafting_table/) ? 1 : 0),
        'w:' + Math.floor(count(/_log$|_planks$/) / 4),
        'f:' + Math.floor(count(/cooked_|bread|^apple$|carrot|potato|melon_slice|^rabbit$|beef|porkchop|mutton|chicken|cod|salmon|stew/) / 3),
        'o:' + Math.floor(count(/_ingot$|^coal$|diamond|^iron|redstone|lapis|raw_iron|raw_gold/) / 4),
        'a:' + ((wm && wm.vitals && wm.vitals.armor) || 0),
        'l:' + (v ? Math.round((v.level || 0)) : 0),
    ].join('|');

    return {
        t, v, wm, inv, has, count, deaths, progTail, ageS, mob, picks, ach, pickTier,
        chunk: v ? `${Math.floor(v.x / 16)},${Math.floor(v.z / 16)}` : '?',
        hp: v ? v.hp : null, food: v ? v.food : null,
        skill: v ? v.skill : null,
        commitment: (wm && wm.commitment) || null,
        threat: (wm && wm.threat) || null,
        events: eventsTail(80),
    };
}

// chunk key from world x/z (16-block chunks) — shared so resident_chunks / death_hotspot agree.
export const chunkKey = (x, z) => `${Math.floor(x / 16)},${Math.floor(z / 16)}`;
