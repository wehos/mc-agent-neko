// sentinel (filename kept as botwatch.mjs so watchdog/ensure-stack keep-alive still find it).
//
// WHY THIS REWRITE (C284): the old botwatch judged "is the bot OK?" from LAGGING, motion-based
// signals — POSITION-STALL (pos unchanged >6min) and PROGRESS-FROZEN (progress.txt last line
// unchanged >6min). Both are defeated by the bot's OWN anti-stuck machinery: when missionNether
// is marooned it self-kicks → cancels → restarts → logs "missionNether START" / "supervisor
// cancel received" / "standing down: MAROONED" on rotation, and jitters position >2 blocks while
// road-building. So the progress LINE keeps changing and position keeps moving — the lagging
// detectors stay GREEN while the bot spends 30+ min making ZERO real progress (observed
// 2026-06-20: 277 identical "standing down: MAROONED" lines + 5 self-reported "Pinned 15min+"
// kicks, no pickaxe, no crafting table, NOT ONE ticket filed).
//
// THE FIX — judge by OUTCOME and by the world model's OWN omniscient state, not by motion:
//   • read world_model.json (mobility.state / kit.picks / commitment / threat) — the bot already
//     KNOWS it's MAROONED with picks=0 on a BOOTSTRAP_KIT commitment; we just have to read it.
//   • read vitals.inv — the achievement vector (pick tier, table, wood, food, ore, armor).
//   • a NO-REAL-PROGRESS detector: achievement vector flat AND ≤2 distinct chunks visited for
//     >8min ⇒ stalled, no matter how much the skill churns. Churn-proof by construction.
//   • the bot's self-reports ("Pinned 15min+", "STUCK-ZONE") are the highest-precision stuck
//     signal there is — fire on them directly.
//
// 宁缺毋滥 (precision over recall): every STATE detector must persist for fireMs before it files,
// and must stay cleared for clearMs before it auto-resolves — symmetric debounce kills flicker.
// 完成后再次验证 (close-loop): when a fired condition CLEARS, the sentinel auto-comments the
// ticket with a live snapshot and bumps it to `verifying` — the detector that raised it also
// confirms it cleared, so no stale "open" tickets for already-self-healed problems.
//
// It also writes sentinel.json every tick: a single fused omniscient+visual digest (world model
// + vitals + active detectors + newest frame) so ANY agent / fresh session reads ONE file to
// see the cross-checked live picture instead of guessing from a single log. ACTIVELY VERIFY
// from this, do not passively trust one log line.
//
// Run: node bots/_supervisor/botwatch.mjs [heartbeatSec]

import fs from 'fs';
import path from 'path';
import http from 'http';
// shared black-box read layer (paths/parse/omniscient-fuse) — same readers overseer-snapshot uses,
// so field names + staleness semantics can never drift between the two consumers.
import { DIR, TICKET_PORT, now, rd, rj, latestFrame, eventsTail, readState } from './bb-readers.mjs';

const POLL_MS = 15000;
const HEARTBEAT_SEC = parseInt(process.argv[2] || '1800', 10);
const LOW_HP = 8, LOW_FOOD = 5, STALE_SEC = 90;

// ── ticket-server I/O (never throws; if server down, detection just no-ops) ───────────────
// POST a ticket; resolves to the ticket id (created OR merged-by-dedupKey) or null.
function postTicket(t) {
    return new Promise((resolve) => {
        try {
            if (t.evidence && !t.evidence.frames) { const fr = latestFrame(); if (fr) t.evidence.frames = [fr]; }
            const data = JSON.stringify({ source: 'auto', actor: 'sentinel', ...t });
            const req = http.request({ host: '127.0.0.1', port: TICKET_PORT, path: '/api/tickets', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
                let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)?.ticket?.id || null); } catch { resolve(null); } });
            });
            req.on('error', () => resolve(null));
            req.write(data); req.end();
        } catch { resolve(null); }
    });
}
function apiPost(p, body) {
    return new Promise((resolve) => {
        try {
            const data = JSON.stringify({ actor: 'sentinel', ...body });
            const req = http.request({ host: '127.0.0.1', port: TICKET_PORT, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => { res.on('data', () => {}); res.on('end', resolve); });
            req.on('error', resolve); req.write(data); req.end();
        } catch { resolve(); }
    });
}
// ── NO-REAL-PROGRESS tracker (achievement vector flat AND ≤2 chunks for >fire) ────────────
let lastAch = null, lastAchAt = now();
const chunksSinceAch = new Set();
function progressStaleMs(s, t) {
    if (s.ach !== lastAch) { lastAch = s.ach; lastAchAt = t; chunksSinceAch.clear(); }
    chunksSinceAch.add(s.chunk);
    return { staleMs: t - lastAchAt, chunks: chunksSinceAch.size };
}
// ── FROZEN-ALIVE tracker (T-0058, [monitoring-multi-signal]): a 'frozen data + live writer' hang —
//    the broadcast loop keeps stamping a FRESH vitals.ts while the bot's real state is dead-pinned
//    (pos+hp unchanged, events.log silent). STALE_SEC (ts age) + watchdog (process alive) both pass.
//    Track how long pos+hp have been identical, plus events.log silence age. ──
let _frozenKey = null, _frozenSince = now();
function frozenAliveMs(s, t) {
    const key = s.v ? `${s.v.x},${s.v.y},${s.v.z}|${s.hp}` : null;
    if (key !== _frozenKey) { _frozenKey = key; _frozenSince = t; }
    let eventsAgeS = 1e9;
    try { eventsAgeS = (t - fs.statSync(path.join(DIR, 'events.log')).mtimeMs) / 1000; } catch {}
    return { frozenMs: key ? (t - _frozenSince) : 0, eventsAgeS };
}

// ── WEDGE / FALSE-HOLD tracker (T-0062, screenshot-confirmed 2026-06-21 [validation-not-mock]):
//    the bot self-reports "Covered night hold staying sealed" / mob=POCKET while ACTUALLY wedged in
//    a useless dug niche, pinned 18min, LOSING hp to falls/mobs. FROZEN-ALIVE misses it (events keep
//    flowing so its events-silent gate never trips); NO-PROGRESS clears on micro-oscillation; the
//    "covered"=1-block-above self-report masks it. The tell a LEGIT safe hold CANNOT fake: HP DROP
//    while pinned (a real shelter takes zero damage). Track pos-pinned time (pos-only key so an hp
//    change doesn't reset it, unlike frozenAlive's pos+hp key) + max-hp-during-pin → hpDrop. ──
let _wedgeKey = null, _wedgeSince = now(), _wedgeHpMax = 0;
function wedgePinnedMs(s, t) {
    // ~3-block cell so micro-jitter (bobbing in a niche / edge-wedge) still counts as pinned
    const key = s.v ? `${Math.round(s.v.x / 3)},${Math.round(s.v.y / 3)},${Math.round(s.v.z / 3)}` : null;
    if (key !== _wedgeKey) { _wedgeKey = key; _wedgeSince = t; _wedgeHpMax = s.hp || 0; }
    else if ((s.hp || 0) > _wedgeHpMax) _wedgeHpMax = s.hp;   // track the peak so falls/hits show as a drop
    return { pinnedMs: key ? (t - _wedgeSince) : 0, hpDrop: Math.max(0, _wedgeHpMax - (s.hp || 0)) };
}

// ── SURVIVAL-CHURN tracker (T-0073): a HEALTHY + FREE bot stuck in a survival-reflex loop
//    (kiting mobs / circling a canyon / digging in pits all night) MAKING NO TIER PROGRESS.
//    Slips the existing trio: no-progress wants chunks<=2 (it MOVES → chunks>2), mobility-stuck
//    wants MAROONED (it's FREE), staleMin clears on giveKit pickup micro-bumps. The robust tell:
//    pickTier FLAT (a tier can't be faked by an item pickup) for a long window WHILE the recent
//    event log is REFLEX/combat/flee-DOMINATED (not skill-driven productive work) and hp is healthy
//    (≥14 → not the LOWHP emergency, which owns its own flag). Track continuous time the churn holds;
//    a tier advance (real progress) OR dropping out of the churn condition resets it.
//    Thresholds (reflexLines≥8 of last-80 events, 15min) are tunable if it over/under-fires.
const _REFLEX_RE = /Fighting|Outmatched|digging in|kit(e|ing)|running from|flee|getting out|Drowning|dig(ging)? out|escaping|MLG|clutch|swim|heading for air/i;
let _churnTier = null, _churnSince = now();
function survivalChurnMs(s, t) {
    const reflexLines = (s.events || []).filter(l => _REFLEX_RE.test(l)).length;
    const churning = (s.hp != null && s.hp >= 14)
        && !/MAROONED|ENTOMB|POCKET/i.test(s.mob || '')
        && reflexLines >= 8;
    const tier = churning ? (s.pickTier || 'none') : null;
    if (tier !== _churnTier) { _churnTier = tier; _churnSince = t; }   // tier advance OR churn-off → reset
    return { churnMs: (churning && _churnTier != null) ? (t - _churnSince) : 0, reflexLines };
}

// ── generic STATE-detector engine: debounce on (fire) AND off (clear+auto-verify) ─────────
// Each detector: { key, type, severity, dedupKey, label, fireMs, clearMs, active(s), ticket(s,durMs) }
const D = [
    {
        key: 'frozen-alive', type: 'stuck', severity: 'critical', dedupKey: 'frozen-alive-hang', label: 'FROZEN-ALIVE',
        fireMs: 0, clearMs: 30000,   // frozenMs IS the timer; clear 30s after pos/hp/events resume
        // ★T-0058 ([monitoring-multi-signal]): the 'frozen data + live writer' hang. The broadcast loop
        // keeps stamping a FRESH vitals.ts (so STALE_SEC age-check AND the watchdog's process-alive check
        // both pass) while the bot's REAL state is dead-pinned: pos+hp unchanged AND events.log silent
        // (live 02:34: hp fell 19→0 in water then froze, ts fresh 8s, death_log NOT incrementing, pos
        // pinned 66,58,64 for 190s+ — both sentinels blind). NEVER trust a single fresh ts. This runs only
        // when vitals IS fresh (the else branch), so it catches exactly the writer-outlived-the-loop case.
        // Legit night-holds keep EMITTING events (table-recovery / Pocketed every 2-15s) → events.log stays
        // fresh → they don't trip this (宁缺毋滥, no T-0027-style false-fire on a healthy sealed hold).
        active: (s) => !!(s._frozen && s._frozen.frozenMs >= 2 * 60000 && s._frozen.eventsAgeS >= 120),
        ticket: (s, dur) => ({
            type: 'stuck', severity: 'critical', dedupKey: 'frozen-alive-hang',
            title: `冻结假活 ${Math.round(dur / 60000)}min — pos/hp死钉+events静默,vitals ts仍刷新 @${s.v ? s.v.x + ',' + s.v.y + ',' + s.v.z : '?'} hp=${s.hp}`.slice(0, 140),
            detail: `'冻结数据+活写入器'hang: vitals.ts新鲜(${s.ageS}s)但 pos=${s.v ? s.v.x + ',' + s.v.y + ',' + s.v.z : '?'}+hp=${s.hp} 已 ${Math.round(s._frozen.frozenMs / 60000)}min 完全不变,events.log 静默 ${Math.round(s._frozen.eventsAgeS)}s,deaths=${s.deaths}(未涨=死亡未注册/未重生)。写入器还在stamp新ts但bot loop冻死→STALE_SEC+watchdog进程存活全盲。须 watchdog kick/重连bridge恢复。skill=${s.skill} mob=${s.mob}.`.slice(0, 240),
            evidence: { pos: s.v ? [s.v.x, s.v.y, s.v.z] : null, vitals: { hp: s.hp, food: s.food, skill: s.skill }, frozenMin: Math.round(s._frozen.frozenMs / 60000), eventsAgeS: Math.round(s._frozen.eventsAgeS), deaths: s.deaths, mobility: s.mob, progressTail: s.progTail },
        }),
    },
    {
        key: 'false-hold', type: 'stuck', severity: 'high', dedupKey: 'false-hold-wedge', label: 'FALSE-HOLD',
        fireMs: 0, clearMs: 45000,
        // ★T-0062 (用户截图实证 2026-06-21, [validation-not-mock]/[monitoring-multi-signal]): bot 自报
        // "Covered night hold staying sealed"/mob=POCKET 但实际楔在挖坏的废坑里, pos 钉死 18min 且持续
        // 被 falls/怪掉血。FROZEN-ALIVE 漏(events 在刷,其 events-silent 门不 trip)、NO-PROGRESS 被微动
        // 清、"covered"(头顶1块)自报骗过监控。真安全 hold 学不来的破绽=钉死期间掉血(真庇护零伤害)。
        // fire: pinned>=10min AND (hpDrop>=3 OR pinned>=20min), 不管 events/covered。frame 自动附 → 必看。
        active: (s) => !!(s._wedge && s._wedge.pinnedMs >= 10 * 60000
            && (s._wedge.hpDrop >= 3 || s._wedge.pinnedMs >= 20 * 60000)
            && !/sleep|^bed$/i.test(s.skill || '')),
        ticket: (s, dur) => ({
            type: 'stuck', severity: 'high', dedupKey: 'false-hold-wedge',
            title: `假庇护/楔死 ${Math.round(s._wedge.pinnedMs / 60000)}min — 自报covered/hold但pos钉死@${s.v ? s.v.x + ',' + s.v.y + ',' + s.v.z : '?'}且掉血${s._wedge.hpDrop}`.slice(0, 140),
            detail: `bot自报"covered night hold"/mob=${s.mob}但实际楔在原地${Math.round(s._wedge.pinnedMs / 60000)}min、hold期间掉血${s._wedge.hpDrop}(真安全hold零伤害=假庇护/楔坑,#FROZEN漏因events在刷/#NO-PROGRESS被微动清)。★必看附帧(frames/)核实geometry,别信log自报"covered"。skill=${s.skill} hp=${s.hp} food=${s.food} stale=${Math.round((s._stale ? s._stale.staleMs : 0) / 60000)}min.`.slice(0, 240),
            evidence: { pos: s.v ? [s.v.x, s.v.y, s.v.z] : null, pinnedMin: Math.round(s._wedge.pinnedMs / 60000), hpDrop: s._wedge.hpDrop, vitals: { hp: s.hp, food: s.food, skill: s.skill }, mobility: s.mob, progressTail: s.progTail },
        }),
    },
    {
        key: 'no-progress', type: 'idle', severity: 'high', dedupKey: 'no-progress', label: 'NO-PROGRESS',
        fireMs: 0, clearMs: 60000,   // staleness IS the timer; clear after 60s of real progress
        // ★C340 (T-0072) RETIRED — DISABLED (active→false). This staleMin-based catch-all was
        // SUPERSEDED by the overseer's `progress_velocity` metric (catches NET tier regression that
        // staleMin missed — a micro-increment kept clearing staleMin while the bot net-stagnated, the
        // 6.7h Sisyphus) + the T-0060 headline umbrella that tracks the stall. Left running it kept
        // SPAWNING DUP idle tickets each stall (T-0026→T-0070→…, dedupKey misses once the prior is
        // verified/closed → fresh dup) → board pollution. The specific stall owners still fire
        // (frozen-alive / false-hold / mobility-stuck / bootstrap-deadlock / self-pin-kick), so no
        // real-time coverage is lost. Re-enable (restore the old active()) ONLY if an owner-less
        // real-time stall is shown to slip past both progress_velocity AND the specific detectors.
        // (Kept the definition for context/reversibility per 宁缺毋滥; just gated off.)
        active: (s) => false,
        ticket: (s, dur) => ({
            type: 'idle', severity: 'high', dedupKey: 'no-progress',
            title: `零真实进展 ${Math.round(dur / 60000)}min — 成果向量未变 (skill=${s.skill})`.slice(0, 140),
            detail: `成果向量 [${s.ach}] 已 ${Math.round(s._stale.staleMs / 60000)}min 未推进, 仅 ${s._stale.chunks} 个区块; skill 在churn但无产出. mob=${s.mob} hp=${s.hp} food=${s.food} commit=${s.commitment ? s.commitment.kind : '-'}`.slice(0, 240),
            evidence: { pos: s.v ? [s.v.x, s.v.y, s.v.z] : null, vitals: { hp: s.hp, food: s.food, skill: s.skill }, ach: s.ach, mobility: s.mob, commitment: s.commitment, progressTail: s.progTail },
        }),
    },
    {
        // ★C338 (T-0073) SURVIVAL-CHURN: the gap left by no-progress(C337)/mobility-stuck/staleMin —
        // a HEALTHY + FREE bot churning in a survival-reflex loop (kite/circle/dig) all night with NO
        // tier advance. pickTier-flat is the giveKit-proof progress signal; reflex-dominated recent log
        // is the "thrashing not working" signal. See survivalChurnMs() for the tracker rationale.
        key: 'survival-churn', type: 'idle', severity: 'high', dedupKey: 'survival-churn', label: 'SURVIVAL-CHURN',
        fireMs: 0, clearMs: 90000,   // the 15min accumulation IS the timer; clear after 90s out of churn
        active: (s) => s._churn && s._churn.churnMs >= 15 * 60000,
        ticket: (s, dur) => ({
            type: 'idle', severity: 'high', dedupKey: 'survival-churn',
            title: `求生反射churn主导 ${Math.round(dur / 60000)}min — 满血/FREE打转无tier进展 (skill=${s.skill})`.slice(0, 140),
            detail: `hp=${s.hp} mob=${s.mob} 困在反射loop(kite/dig/flee, 近80事件中${s._churn.reflexLines}条反射), pickTier=${s.pickTier}已${Math.round(dur / 60000)}min未推进. 漏在no-progress(在移动chunks>2)/mobility-stuck(FREE非MAROONED)/staleMin(giveKit拾取微增清零)三者缝隙. progTail=${s.progTail}`.slice(0, 240),
            evidence: { pos: s.v ? [s.v.x, s.v.y, s.v.z] : null, vitals: { hp: s.hp, food: s.food, skill: s.skill }, mobility: s.mob, pickTier: s.pickTier, reflexLines: s._churn.reflexLines, churnMin: Math.round(dur / 60000), events: (s.events || []).filter(l => _REFLEX_RE.test(l)).slice(-6), progressTail: s.progTail },
        }),
    },
    {
        key: 'mobility-stuck', type: 'stuck', severity: 'high', dedupKey: 'mobility-stuck', label: 'MOBILITY',
        fireMs: 6 * 60000, clearMs: 45000,
        // ★宁缺毋滥: a bot that intentionally SEALED itself for the night (real roof + no threat) reads
        // ENTOMBED but is CORRECTLY sheltering, not stuck — don't false-fire on a legit night-hold (live
        // 2026-06-20: "sealed night hold" hp20/food20 covered, T-0027 false-fired). Real stuck = no safe
        // shelter: daytime, OR exposed (no real cover), OR under actionable threat.
        active: (s) => /MAROONED|ENTOMB|POCKET/i.test(s.mob || '')
            && !(s.wm && s.wm.time && !s.wm.time.isDay && s.wm.cover && s.wm.cover.coverReal && (!s.threat || (s.threat.actionable | 0) === 0)),
        ticket: (s, dur) => ({
            type: 'stuck', severity: 'high', dedupKey: 'mobility-stuck',
            title: `移动受困 ${s.mob} ${Math.round(dur / 60000)}min @${s.v ? s.v.x + ',' + s.v.y + ',' + s.v.z : '?'}`.slice(0, 140),
            detail: `world_model.mobility=${s.mob} 持续 ${Math.round(dur / 60000)}min; skill=${s.skill} picks=${s.picks} hasTablePath=${s.wm && s.wm.kit ? s.wm.kit.hasTablePath : '?'} hp=${s.hp} food=${s.food}`.slice(0, 240),
            evidence: { pos: s.v ? [s.v.x, s.v.y, s.v.z] : null, vitals: { hp: s.hp, food: s.food, skill: s.skill }, mobility: s.wm ? s.wm.mobility : null, commitment: s.commitment, progressTail: s.progTail },
        }),
    },
    {
        key: 'bootstrap-deadlock', type: 'stuck', severity: 'critical', dedupKey: 'bootstrap-deadlock', label: 'BOOTSTRAP',
        fireMs: 5 * 60000, clearMs: 60000,
        // resource-floor lock: 0 usable picks AND no pickaxe in inventory. The deadlock is about
        // PICKS — having a crafting_table in inventory does NOT mean bootstrap is done (live
        // 2026-06-20: bot acquired a table but still couldn't craft the pickaxe — table-not-placed
        // bug — and pillared into the sky; clearing on table-presence was a false "resolved"). Only
        // clear when a real pickaxe exists. (brief no-pick during crafting is normal; 5min = real.)
        active: (s) => s.picks === 0 && !s.has(/_pickaxe$/),
        ticket: (s, dur) => {
            const cobble = s.count(/cobblestone|cobbled_deepslate/), planks = s.count(/_planks$/), logs = s.count(/_log$/), sap = s.count(/_sapling$/);
            return {
                type: 'stuck', severity: 'critical', dedupKey: 'bootstrap-deadlock',
                title: `资源底线死锁 ${Math.round(dur / 60000)}min — 无镐无台造不出镐`.slice(0, 140),
                detail: `picks=0, 背包无 pickaxe 且无 crafting_table (疑似挖了工作台没捡走/镐断没补). 可重建料: cobble=${cobble} planks=${planks} logs=${logs} sapling=${sap}. commit=${s.commitment ? s.commitment.kind + '/' + s.commitment.skill : '-'} @${s.v ? s.v.x + ',' + s.v.y + ',' + s.v.z : '?'}`.slice(0, 240),
                evidence: { pos: s.v ? [s.v.x, s.v.y, s.v.z] : null, vitals: { hp: s.hp, food: s.food, skill: s.skill }, kit: s.wm ? s.wm.kit : null, commitment: s.commitment, progressTail: s.progTail },
            };
        },
    },
    {
        key: 'false-shelter', type: 'shelter', severity: 'high', dedupKey: 'false-shelter', label: 'FALSE-SHELTER',
        fireMs: 3 * 60000, clearMs: 60000,
        // ★防漏单 (T-0040): the SILENT night near-miss — bot is night-sheltering (prepNether/bunker
        // intent or contained mobility) but the roof is NOT actually sealed (wm.cover.coverReal===false).
        // If no mob happens to come, NOTHING fires: no death, no seal-fail event, and mobility-stuck
        // explicitly EXCLUDES this (it only fires on coverReal===TRUE legit holds) → the unsealed-shelter
        // risk goes fully undetected (user's founding complaint: "把自己放碉堡里没封顶,没怪来=无声近失").
        // Precision guards: night strictly known (isDay===false), cover strictly known-unsealed
        // (coverReal===false, not just missing), shelter intent, holding ≥1min, and NO actionable threat
        // (an active threat is already owned by seal-fail/death/combat — this is the silent case only).
        active: (s) => !!(s.wm && s.wm.time && s.wm.time.isDay === false
            && s.wm.cover && s.wm.cover.coverReal === false
            && (/prepNether|shelter|bunker|sleep|bed/i.test(s.skill || '') || /POCKET|ENC|ENTOMB|MAROON/i.test(s.mob || ''))
            && (s._stale ? s._stale.staleMs >= 60000 : false)
            && (s.threat ? (s.threat.actionable | 0) === 0 : true)),
        ticket: (s, dur) => ({
            type: 'shelter', severity: 'high', dedupKey: 'false-shelter',
            title: `夜间庇护未封顶(无声近失) ${Math.round(dur / 60000)}min — coverReal=false @${s.v ? s.v.x + ',' + s.v.y + ',' + s.v.z : '?'}`.slice(0, 140),
            detail: `夜间(isDay=false)+庇护意图(skill=${s.skill} mob=${s.mob})但世界模型 cover.coverReal=false=顶未真封,持续${Math.round(dur / 60000)}min且无actionable怪→恰好没怪来则无死亡/无seal-fail事件/mobility-stuck也豁免=旧检测器全漏(本检测器专补此洞)。hp=${s.hp} food=${s.food} picks=${s.picks}. 须查为何没封顶(无料?placeBlock无参考面?digDown失败?见 T-0037/T-0001 seal机理).`.slice(0, 240),
            evidence: { pos: s.v ? [s.v.x, s.v.y, s.v.z] : null, vitals: { hp: s.hp, food: s.food, skill: s.skill }, cover: s.wm ? s.wm.cover : null, time: s.wm ? s.wm.time : null, threat: s.threat, progressTail: s.progTail },
        }),
    },
];

// per-detector runtime state
const ST = {};
const flagsOut = [];
async function runDetector(d, s, t) {
    const st = ST[d.key] || (ST[d.key] = { activeSince: 0, inactiveSince: 0, ticketId: null, lastBumpAt: 0 });
    if (d.active(s)) {
        st.inactiveSince = 0;
        if (!st.activeSince) st.activeSince = t;
        const dur = t - st.activeSince;
        if (!st.ticketId && dur >= d.fireMs) {
            st.ticketId = await postTicket(d.ticket(s, dur)); st.lastBumpAt = t;
            flagsOut.push(`★${d.label}→${st.ticketId || '?'}`);
        } else if (st.ticketId && t - st.lastBumpAt > 120000) {
            await postTicket(d.ticket(s, dur)); st.lastBumpAt = t;   // refresh evidence, bump occurrences
        }
    } else {
        if (st.activeSince && !st.inactiveSince) st.inactiveSince = t;
        if (st.ticketId && st.inactiveSince && t - st.inactiveSince >= d.clearMs) {
            // CLOSE-LOOP: the raising detector confirms the condition cleared → auto-verify.
            const snap = `auto-verify: ${d.label} 已清除 (持续 ${Math.round((st.inactiveSince - st.activeSince) / 60000)}min 后恢复). 现状 mob=${s.mob} picks=${s.picks} ach=[${s.ach}] hp=${s.hp} food=${s.food} skill=${s.skill}`;
            await apiPost(`/api/tickets/${st.ticketId}/comment`, { note: snap.slice(0, 480) });
            await apiPost(`/api/tickets/${st.ticketId}/update`, { status: 'verifying', resolution: `sentinel auto-cleared (${d.key})`, note: 'condition no longer holds' });
            flagsOut.push(`✓${d.label}cleared→verifying ${st.ticketId}`);
            st.ticketId = null; st.activeSince = 0; st.inactiveSince = 0;
        } else if (!st.ticketId) { st.activeSince = 0; st.inactiveSince = 0; }
    }
}

// ── edge detectors (events, not states): fire on appearance, dedup by server ──────────────
let seenEventTs = 0;   // ms of newest events.log line already processed
function edgeDetectors(s, t) {
    // self-reported stuck — the bot's OWN watchdog screaming. highest precision.
    for (const ln of s.events) {
        const m = ln.match(/^\[([^\]]+)\]/); const lt = m ? Date.parse(m[1]) : 0;
        if (!lt || lt <= seenEventTs) continue;
        if (/Pinned 15min\+|STUCK-ZONE|kicking the stack/.test(ln)) {
            postTicket({
                type: 'stuck', severity: 'high', dedupKey: 'self-pin-kick',
                title: `bot 自报卡死 — ${(ln.match(/"(?:reason|message)":"([^"]+)"/) || [, ln])[1]}`.slice(0, 140),
                detail: `world_model 自身的反卡死机制触发 (15min+ pin / stuck-zone). skill=${s.skill} mob=${s.mob} picks=${s.picks} @${s.v ? s.v.x + ',' + s.v.y + ',' + s.v.z : '?'}`.slice(0, 240),
                evidence: { pos: s.v ? [s.v.x, s.v.y, s.v.z] : null, vitals: { hp: s.hp, food: s.food, skill: s.skill }, line: ln.slice(0, 200), progressTail: s.progTail },
            });
            flagsOut.push('★PINKICK');
        }
    }
    // advance the cursor to newest line ts
    for (const ln of s.events) { const m = ln.match(/^\[([^\]]+)\]/); const lt = m ? Date.parse(m[1]) : 0; if (lt > seenEventTs) seenEventTs = lt; }
}

// ── death / seal-fail / hp / food (kept; transition-edged) ────────────────────────────────
let lastDeaths = -1, lowHp = false, lowFood = false, lastSealAt = 0, lastSkill = null;
async function classicDetectors(s, t) {
    if (lastDeaths >= 0 && s.deaths > lastDeaths) {
        const dl = [...s.events].reverse().find(l => /阵亡/.test(l)) || '';
        const cause = (dl.match(/"kind":"(\w+)"/) || [])[1] || (rj('death_log.jsonl') ? '' : '');
        await postTicket({
            type: 'death', severity: 'critical', dedupKey: 'death-loop',
            title: `bot 连续死亡 (${s.deaths} 次)${cause ? ' — ' + cause : ''}`,
            detail: dl.replace(/^\[[^\]]*\]\s*/, '').slice(0, 240),
            evidence: { pos: s.v ? [s.v.x, s.v.y, s.v.z] : null, vitals: { hp: s.hp, food: s.food, skill: s.skill }, events: s.events.filter(l => /阵亡|告急|Outmatched|seal/.test(l)).slice(-6), progressTail: s.progTail },
        });
        flagsOut.push(`★DEATH+${s.deaths - lastDeaths}`);
    }
    lastDeaths = s.deaths;

    // ★宁缺毋滥: only DANGEROUS seal-fails count. The benign variant "Can't seal here, no mobs —
    // standing down, skill-layer dig-in owns it" is the seal reflex CORRECTLY deferring (daytime /
    // no mobs / already covered) — not a threat. Counting it was a false-positive factory (live
    // 2026-06-20: ×11 benign at spawn, tod=day, cover.overhead=true, 0 hostiles → bogus seal-fail
    // tickets T-0001/T-0015). Real seal-fail = can't seal WHILE exposed to mobs; the death detector
    // backstops if one actually kills her. Cross-check vitals: never fire in clear daylight.
    const isDanger = (l) => /Can't seal here/.test(l) && !/no mobs|standing down/.test(l);
    const dayClear = s.wm && s.wm.time && s.wm.time.isDay && (s.threat ? (s.threat.actionable | 0) === 0 : true);
    const sealFails = dayClear ? 0 : s.events.filter(isDanger).length;
    if (sealFails >= 4 && t - lastSealAt > 300000) {
        lastSealAt = t;
        await postTicket({
            type: 'seal-fail', severity: 'critical', dedupKey: 'seal-fail',
            title: `封顶反复失败 (${sealFails}× Can't seal in window)`,
            detail: `夜里站着不封顶易被怪杀 @${s.v ? s.v.x + ',' + s.v.y + ',' + s.v.z : '?'} hp=${s.hp} food=${s.food}`,
            evidence: { pos: s.v ? [s.v.x, s.v.y, s.v.z] : null, vitals: { hp: s.hp, food: s.food, skill: s.skill }, events: s.events.filter(l => /seal|Outmatched|阵亡/.test(l)).slice(-6), progressTail: s.progTail },
        });
        flagsOut.push(`★SEALFAIL×${sealFails}`);
    }

    if (s.hp != null) { if (s.hp <= LOW_HP) { if (!lowHp) { lowHp = true; flagsOut.push(`★LOWHP=${s.hp}`); } } else if (lowHp && s.hp >= LOW_HP + 4) lowHp = false; }
    if (s.food != null) { if (s.food <= LOW_FOOD) { if (!lowFood) { lowFood = true; flagsOut.push(`★LOWFOOD=${s.food}`); } } else if (lowFood && s.food >= LOW_FOOD + 4) lowFood = false; }
    if (s.skill !== lastSkill) { if (lastSkill !== null) flagsOut.push(`skill:${lastSkill}->${s.skill || '-'}`); lastSkill = s.skill; }
}

// ── fused omniscient+visual digest for any agent to read (主动求证, single file) ───────────
function writeDigest(s, t) {
    const active = D.filter(d => ST[d.key] && ST[d.key].activeSince).map(d => ({ key: d.key, sinceMin: Math.round((t - ST[d.key].activeSince) / 60000), ticket: ST[d.key].ticketId }));
    const digest = {
        ts: t, iso: new Date(t).toISOString(),
        pos: s.v ? [s.v.x, s.v.y, s.v.z] : null, hp: s.hp, food: s.food, skill: s.skill,
        mobility: s.mob, picks: s.picks, pickTier: s.pickTier,
        commitment: s.commitment ? `${s.commitment.kind}/${s.commitment.skill}` : null,
        threat: s.threat ? { hostiles: s.threat.hostiles, actionable: s.threat.actionable, nearest: s.threat.closest } : null,
        realProgress: { ach: s.ach, staleMin: Math.round(s._stale.staleMs / 60000), chunks: s._stale.chunks },
        activeDetectors: active, telemetryAgeS: s.ageS,
        frame: latestFrame(),
        note: 'ACTIVELY VERIFY from world_model.json + vitals.json + this frame; do not trust one log line.',
    };
    try { fs.writeFileSync(path.join(DIR, 'sentinel.json'), JSON.stringify(digest, null, 2)); } catch {}
}

// ── main loop ─────────────────────────────────────────────────────────────────────────────
let lastEmit = 0;
async function tick() {
    const t = now();
    flagsOut.length = 0;
    const s = readState(t);
    s._stale = progressStaleMs(s, t);
    s._frozen = frozenAliveMs(s, t);   // ★T-0058 'frozen data + live writer' hang tracker
    s._wedge = wedgePinnedMs(s, t);    // ★T-0062 false-hold/wedge tracker (pinned + hp-drop = fake shelter)
    s._churn = survivalChurnMs(s, t);  // ★T-0073 healthy+FREE survival-reflex churn (mobile stall, tier-flat)

    if (!s.v || s.ageS > STALE_SEC) {
        flagsOut.push(`★STALE(vitals ${s.ageS}s old)`);
    } else {
        for (const d of D) await runDetector(d, s, t);
        edgeDetectors(s, t);
        await classicDetectors(s, t);
    }
    writeDigest(s, t);

    const heartbeat = (t - lastEmit) / 1000 >= HEARTBEAT_SEC;
    if (flagsOut.length || heartbeat) {
        const ts = new Date(t).toISOString().slice(11, 19);
        const vit = s.v ? `pos=${s.v.x},${s.v.y},${s.v.z} hp=${s.hp} food=${s.food} skill=${s.skill || '-'} mob=${s.mob || '-'} picks=${s.picks} stale=${Math.round(s._stale.staleMs / 60000)}min/${s._stale.chunks}ch` : 'no-vitals';
        console.log(`[${ts}] deaths=${s.deaths} ${vit}${flagsOut.length ? '  ' + flagsOut.join(' ') : '  (heartbeat)'}`);
        lastEmit = t;
    }
}

console.log(`sentinel: world-model-driven, debounced(fire+clear), close-loop verify. heartbeat ${HEARTBEAT_SEC}s, poll ${POLL_MS / 1000}s, ticket :${TICKET_PORT}`);
tick();
setInterval(() => { tick().catch(e => console.error('tick err', e && e.message)); }, POLL_MS);
