// overseer-snapshot — the ONE command the overseer (a claude session) runs to get data.
//
// 防幻觉的物理实现: the overseer reads NOTHING else — no tail/cat/grep of the black box (that is
// where fabrication creeps in). This script does deterministic semantic pre-processing (label /
// aggregate / freshness) and emits ONE id-tagged JSON so every conclusion can cite an evidence id.
//
// FOUR ZONES (now vs history kept explicitly separate, per overseer.md):
//   now       — current single value: reuse sentinel.json + world_model.json, each tagged `stale`.
//   history   — past aggregate portrait: the 6-metric registry (指标→异常对照表). Each metric is
//               an OBJECT {id,label,value,evidence,change,source}; adding a metric = adding one entry.
//   tickets   — summary counts + active list (recentlyChanged flags the review focus).
//   watchlist — last run's watchlist (留观清单), echoed back for mandatory re-review.
//
// Persists overseer-prev.json (last metric values + ts) so `change` is a real delta, not a guess.
// Principle: measure DEVIATION FROM BASELINE, not absolute level (chronic states = botwatch's job).
//
// Run: node bots/_supervisor/overseer-snapshot.mjs   →   prints the snapshot JSON to stdout.

import fs from 'fs';
import path from 'path';
import http from 'http';
import { DIR, rd, rj, readJsonl, eventsTail, latestFrame, chunkKey, now, TICKET_PORT } from './bb-readers.mjs';

const T = now();
const PREV = rj('overseer-prev.json') || { ts: 0, metrics: {} };
const WATCH = rj('overseer-watchlist.json') || { items: [] };

const round = (x, d = 2) => { const p = 10 ** d; return Math.round(x * p) / p; };
const pct = (a, b) => (b > 0 ? round(a / b, 3) : 0);
const staleOf = (obj, maxSec) => !obj || !obj.ts ? true : (T - obj.ts) / 1000 > maxSec;
const prevOf = (id) => (PREV.metrics && PREV.metrics[id]) || null;

// ── recent vitals window (shared by several metrics): last N samples + its real time span ──
const VITALS = readJsonl('vitals.jsonl', 4000);                       // last ≤4000 samples
const VSPAN_MIN = VITALS.length >= 2 ? round((VITALS[VITALS.length - 1].ts - VITALS[0].ts) / 60000, 1) : 0;
const DEATHS = readJsonl('death_log.jsonl');                          // all deaths
const recentDeaths = DEATHS.filter(d => { const ts = Date.parse(d.ts); return isFinite(ts) && (T - ts) <= 24 * 3600 * 1000; });

// ══════════════════════════════════════════════════════════════════════════════════════════
// ZONE: now — current single value (reuse sentinel + world_model, tag staleness per source)
// ══════════════════════════════════════════════════════════════════════════════════════════
function zoneNow() {
    const s = rj('sentinel.json');
    const wm = rj('world_model.json');
    return {
        sentinel: s ? {
            stale: staleOf(s, 90), ageS: round((T - s.ts) / 1000, 0),
            pos: s.pos, hp: s.hp, food: s.food, skill: s.skill, mobility: s.mobility,
            picks: s.picks, pickTier: s.pickTier, commitment: s.commitment, threat: s.threat,
            realProgress: s.realProgress, activeDetectors: s.activeDetectors, frame: s.frame,
        } : { stale: true, missing: 'sentinel.json' },
        world_model: wm ? {
            stale: staleOf(wm, 90), ageS: round((T - wm.ts) / 1000, 0),
            time: wm.time, pos: wm.pos, mobility: wm.mobility, vitals: wm.vitals, threat: wm.threat,
            kit: wm.kit, cover: wm.cover, surfaceGate: wm.surfaceGate,
            recommendation: wm.recommendation, commitment: wm.commitment,
        } : { stale: true, missing: 'world_model.json' },
    };
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// ZONE: history — 6-metric registry. Each compute() returns {value, evidence, change}.
// Add a metric ⇒ add one entry. id/label/source documented inline; status mirrors overseer.md.
// ══════════════════════════════════════════════════════════════════════════════════════════
const METRICS = [
    {
        id: 'staleMin', label: '成果链停滞 (staleMin)', source: 'sentinel.json#realProgress',
        // botwatch already computes this; the snapshot only surfaces it (no recompute).
        compute() {
            const s = rj('sentinel.json'); const rp = (s && s.realProgress) || null;
            if (!rp) return { value: null, evidence: { missing: 'sentinel.realProgress' }, change: null };
            const p = prevOf('staleMin');
            return {
                value: { staleMin: rp.staleMin, chunks: rp.chunks, ach: rp.ach, skill: s.skill },
                evidence: { ach: rp.ach, staleMin: rp.staleMin, chunks: rp.chunks, pos: s.pos, mobility: s.mobility },
                change: p ? { staleMin: rp.staleMin - (p.staleMin ?? 0), achChanged: p.ach !== rp.ach } : 'first-run',
            };
        },
    },
    {
        id: 'resident_chunks', label: '常驻区块分布 (鲁棒版 stuck)', source: 'vitals.jsonl',
        // long-confined to one chunk = robust stuck (defeats micro-jitter that fools single-pos).
        compute() {
            if (!VITALS.length) return { value: null, evidence: { missing: 'vitals.jsonl' }, change: null };
            const freq = {};
            for (const v of VITALS) { if (v.x == null || v.z == null) continue; const k = chunkKey(v.x, v.z); freq[k] = (freq[k] || 0) + 1; }
            const total = Object.values(freq).reduce((a, b) => a + b, 0);
            const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 5)
                .map(([chunk, n]) => ({ chunk, n, pct: pct(n, total) }));
            const topPct = top[0] ? top[0].pct : 0;
            const last = VITALS[VITALS.length - 1];
            // 偏离信号: dominated by one chunk over a non-trivial span ⇒ likely stuck.
            const stuck = topPct >= 0.8 && VSPAN_MIN >= 8;
            const p = prevOf('resident_chunks');
            return {
                value: { topChunk: top[0] ? top[0].chunk : null, topPct, stuck, distinct: Object.keys(freq).length, samples: total, spanMin: VSPAN_MIN },
                evidence: { top, spanMin: VSPAN_MIN, lastPos: [last.x, last.y, last.z] },
                change: p ? { topPctDelta: round(topPct - (p.topPct ?? 0), 3), topChunkMoved: p.topChunk !== (top[0] && top[0].chunk) } : 'first-run',
            };
        },
    },
    {
        id: 'death_breakdown', label: '死因×装备×时段 (看相对变化)', source: 'death_log.jsonl',
        // 占比突升 / 冒出新死法 = 行为模式变了 / 装备链断. 测变化, 不测绝对值 (裸装死是慢性病).
        compute() {
            if (!DEATHS.length) return { value: null, evidence: { note: 'no deaths logged' }, change: 'none' };
            const win = recentDeaths.length ? recentDeaths : DEATHS.slice(-30);
            const byCause = {}; let noArmor = 0, emptyHand = 0, night = 0;
            for (const d of win) {
                const c = d.cause || 'unknown'; byCause[c] = (byCause[c] || 0) + 1;
                const g = d.gear || {};
                if ((g.armorCount | 0) === 0) noArmor++;
                if (!g.sword && !g.axe) emptyHand++;
                if (d.isNight) night++;
            }
            const n = win.length;
            const topCauses = Object.entries(byCause).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([cause, c]) => ({ cause, n: c, pct: pct(c, n) }));
            const p = prevOf('death_breakdown');
            const prevCauses = p && p.causes ? p.causes : {};
            const newCauses = Object.keys(byCause).filter(c => !(c in prevCauses));    // 冒出的新死法
            return {
                value: { window: n, total: DEATHS.length, noArmorPct: pct(noArmor, n), emptyHandPct: pct(emptyHand, n), nightPct: pct(night, n), causes: byCause },
                evidence: { topCauses, windowDesc: recentDeaths.length ? 'last 24h' : 'last 30 deaths', noArmor, emptyHand, night, n },
                change: p ? { totalDelta: DEATHS.length - (p.total ?? 0), newCauses, noArmorPctDelta: round(pct(noArmor, n) - (p.noArmorPct ?? 0), 3) } : 'first-run',
            };
        },
    },
    {
        id: 'death_hotspot', label: '死亡热点 (密度÷停留密度)', source: 'death_log.jsonl + vitals.jsonl',
        // "死得比在那待的时长该有的多" = 危险地形; 消除 "常驻地 = 热点" 的废话.
        compute() {
            if (!DEATHS.length) return { value: null, evidence: { note: 'no deaths logged' }, change: 'none' };
            const deathBy = {};
            for (const d of DEATHS) { if (d.x == null || d.z == null) continue; const k = chunkKey(d.x, d.z); deathBy[k] = (deathBy[k] || 0) + 1; }
            // residence density from vitals window (fraction of time spent per chunk)
            const resBy = {}; let resTotal = 0;
            for (const v of VITALS) { if (v.x == null || v.z == null) continue; const k = chunkKey(v.x, v.z); resBy[k] = (resBy[k] || 0) + 1; resTotal++; }
            const hot = Object.entries(deathBy).map(([chunk, deaths]) => {
                const resFrac = resTotal ? (resBy[chunk] || 0) / resTotal : 0;
                // ratio = deaths normalized by how much time was spent there (+ floor so unseen chunks aren't ∞)
                const ratio = round(deaths / Math.max(resFrac, 0.01), 1);
                return { chunk, deaths, residencePct: round(resFrac, 3), ratio };
            }).sort((a, b) => b.ratio - a.ratio).slice(0, 5);
            const p = prevOf('death_hotspot');
            return {
                value: { worst: hot[0] || null, hotspots: hot.length },
                evidence: { top: hot, resWindowSamples: resTotal },
                change: p ? { worstChunkMoved: (p.worst && p.worst.chunk) !== (hot[0] && hot[0].chunk) } : 'first-run',
            };
        },
    },
    {
        id: 'vitality_struggle', label: '濒死挣扎 (将死未死)', source: 'vitals.jsonl',
        // 长期挣扎/反复濒死又不死不进展 = 出事前兆 (death 只记死了的; 这抓将死未死).
        compute() {
            if (!VITALS.length) return { value: null, evidence: { missing: 'vitals.jsonl' }, change: null };
            let lowHp = 0, lowFood = 0, nearDeathEpisodes = 0, inNearDeath = false;
            for (const v of VITALS) {
                if (v.hp != null && v.hp <= 8) lowHp++;
                if (v.food != null && v.food <= 5) lowFood++;
                if (v.hp != null && v.hp <= 4) { if (!inNearDeath) { nearDeathEpisodes++; inNearDeath = true; } } else if (v.hp != null && v.hp >= 8) inNearDeath = false;
            }
            const n = VITALS.length;
            const p = prevOf('vitality_struggle');
            return {
                value: { lowHpPct: pct(lowHp, n), lowFoodPct: pct(lowFood, n), nearDeathEpisodes, samples: n, spanMin: VSPAN_MIN },
                evidence: { lowHp, lowFood, nearDeathEpisodes, spanMin: VSPAN_MIN, n },
                change: p ? { nearDeathDelta: nearDeathEpisodes - (p.nearDeathEpisodes ?? 0), lowHpPctDelta: round(pct(lowHp, n) - (p.lowHpPct ?? 0), 3) } : 'first-run',
            };
        },
    },
    {
        id: 'repeat_loop', label: '忙碌假活 (高频重复)', source: 'events.log',
        // 在动但无效 = 忙碌假活 (自踢重启假活 / reflex wedged / craft loop / 日志刷屏); 比 staleMin 更早.
        compute() {
            const lines = eventsTail(600);
            if (!lines.length) return { value: null, evidence: { missing: 'events.log' }, change: null };
            const freq = {};
            for (const ln of lines) {
                // normalize: drop leading timestamp + collapse numbers/coords so identical actions group.
                const norm = ln.replace(/^\[[^\]]*\]\s*/, '').replace(/-?\d+(\.\d+)?/g, '#').replace(/\s+/g, ' ').trim().slice(0, 120);
                if (!norm) continue; freq[norm] = (freq[norm] || 0) + 1;
            }
            const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([line, n]) => ({ line, n }));
            const n = lines.length;
            const topN = top[0] ? top[0].n : 0;
            const p = prevOf('repeat_loop');
            return {
                value: { topLine: top[0] ? top[0].line : null, topCount: topN, topPct: pct(topN, n), distinct: Object.keys(freq).length, windowLines: n },
                evidence: { top, windowLines: n },
                change: p ? { topCountDelta: topN - (p.topCount ?? 0), sameTopLine: p.topLine === (top[0] && top[0].line) } : 'first-run',
            };
        },
    },
    {
        id: 'progress_velocity', label: '进度速度 / tier停滞 (治水踏步)', source: 'sentinel#ach + progress.txt',
        // ★区别于 staleMin(成果向量微增即清零, 被 w:0→2 这种微动骗过): 追踪里程碑 TIER 是否在
        // 小时级真推进。bot 可以原地刷微动但 tier 卡 p:stone 数小时 = 净进度 0 = 治水踏步(用户:
        // "进度不增长本身就是罪")。也测 mission/prep 重启 thrash(反复放弃重来而非坚持累积)。
        compute() {
            const s = rj('sentinel.json'); const ach = (s && s.realProgress && s.realProgress.ach) || '';
            const TIER = { none: 0, wood: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 };
            const pm = ach.match(/p:(\w+)/); const tier = pm ? pm[1] : 'none';
            const tierRank = TIER[tier] ?? 0;
            const hasTable = /t:1/.test(ach);
            const recent = (rd('progress.txt') || '').trim().split(/\n/).slice(-400);
            const restarts = recent.filter(l => /prepNether START|missionNether START/.test(l)).length;
            const p = prevOf('progress_velocity');
            // 持久化 bestRank + 自何时未推进(stuck 计时); tier 真推进才重置 sinceTs。
            const bestRank = Math.max((p && p.bestRank) ?? 0, tierRank);
            const advanced = tierRank > ((p && p.bestRank) ?? -1);
            const sinceTs = advanced ? T : ((p && p.sinceTs) || T);
            const stuckH = round((T - sinceTs) / 3600000, 2);
            // ★tier 回落: 当前 rank < 历史最佳 = reset-loop 咬了(iron→stone), 立即报, 不等 stuckHours.
            const regressed = tierRank < bestRank;
            // 治水踏步: tier 长期没推进(主信号) AND 任务在 thrash(辅证, 区别于"在踏实grind下个tier")
            const treadingWater = stuckH >= 1.5 && restarts >= 10;
            return {
                value: { tier, tierRank, bestRank, hasTable, sinceTs, stuckHours: stuckH, restarts400: restarts, treadingWater, regressed, ach },
                evidence: { tier, bestRank, stuckHours: stuckH, restartsIn400Lines: restarts, ach, signal: regressed ? `★tier从rank${bestRank}回落到${tier}(rank${tierRank})=reset-loop咬了, 突破没hold住` : (treadingWater ? `tier卡${tier} ${stuckH}h + 任务thrash(${restarts}重启/400行)=净进度≈0` : '') },
                change: p ? { tierAdvanced: advanced, stuckHoursDelta: round(stuckH - ((p && p.stuckHours) ?? 0), 2) } : 'first-run',
            };
        },
    },
];

function zoneHistory() {
    const out = {};
    for (const m of METRICS) {
        let r; try { r = m.compute(); } catch (e) { r = { value: null, evidence: { error: String(e && e.message) }, change: null }; }
        out[m.id] = { id: m.id, label: m.label, source: m.source, ...r };
    }
    return out;
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// ZONE: tickets — summary + active list (recentlyChanged = updated since last snapshot)
// ══════════════════════════════════════════════════════════════════════════════════════════
const OPEN_STATUSES = new Set(['open', 'claimed', 'in_progress', 'fixed', 'verifying']);
function fetchTickets() {
    return new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: TICKET_PORT, path: '/api/tickets', method: 'GET' }, (res) => {
            let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
        });
        req.on('error', () => resolve(null)); req.end();
    });
}
function zoneTickets(arr) {
    if (!Array.isArray(arr)) return { error: 'ticket-server unreachable', summary: null, active: [] };
    const summary = { total: arr.length, byStatus: {}, byType: {}, bySeverity: {} };
    for (const t of arr) {
        summary.byStatus[t.status] = (summary.byStatus[t.status] || 0) + 1;
        summary.byType[t.type] = (summary.byType[t.type] || 0) + 1;
        summary.bySeverity[t.severity] = (summary.bySeverity[t.severity] || 0) + 1;
    }
    const active = arr.filter(t => OPEN_STATUSES.has(t.status)).map(t => ({
        id: t.id, status: t.status, type: t.type, severity: t.severity, title: t.title,
        occurrences: t.occurrences, claimedBy: t.claimedBy || null, updatedAt: t.updatedAt,
        recentlyChanged: Date.parse(t.updatedAt) > (PREV.ts || 0),    // changed since last overseer run
    }));
    return { summary, active };
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// assemble + persist
// ══════════════════════════════════════════════════════════════════════════════════════════
(async () => {
    const history = zoneHistory();
    const tickets = zoneTickets(await fetchTickets());
    const snapshot = {
        meta: { ts: T, iso: new Date(T).toISOString(), sincePrevMin: PREV.ts ? round((T - PREV.ts) / 60000, 1) : null, frame: latestFrame() },
        now: zoneNow(),
        history,
        tickets,
        watchlist: WATCH.items || [],
    };

    // persist current metric values → overseer-prev.json (so next run's `change` is a real delta).
    const metricsPrev = {};
    for (const id in history) metricsPrev[id] = history[id].value;
    try { fs.writeFileSync(path.join(DIR, 'overseer-prev.json'), JSON.stringify({ ts: T, metrics: metricsPrev }, null, 2)); } catch {}

    process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
})();
