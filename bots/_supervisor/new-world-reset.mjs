// new-world-reset.mjs — detect a world switch and wipe stale world-tied state.
//
// WHY: the user plays on a LAN world hosted by the Fabric client. When they open a NEW
// world, every cached coordinate the bot holds — landmarks.json (bed/village/wood/chest,
// PERSISTED across agent restart), bed.json, chest.json, oracle-ores.json, the LLM's
// base/death memory — still points at the OLD world, so the bot walks to a bed / bank /
// diamond vein that no longer exists ("头几分钟朝旧坐标白跑"). This detects the switch by
// the SAME signal ore-oracle uses to follow the world (the region folder whose .mca files
// have the newest mtime under ORE_SAVES = the world currently being played) and, on a REAL
// change, clears every world-tied file so the bot starts the new world with a clean slate.
//
// ORDERING (why two modes): landmarks.json is reloaded on agent boot, so a RUNNING agent
// would just rewrite it from memory after a delete. The wipe is therefore split so the
// watchdog can sequence kill → clear → relaunch:
//   node new-world-reset.mjs detect   → exit 10 (+ "WORLD_CHANGED …") when the world changed;
//                                        exit 0 otherwise. First run records a baseline, no wipe.
//                                        Side-effect-free w.r.t. the wipe (never deletes here).
//   node new-world-reset.mjs clear    → delete the stale files + blank the memory field, then
//                                        record the new world id. Run by the watchdog AFTER the
//                                        agent is killed, so nothing rewrites the files.
//
// Guards: can't resolve the saves folder (E: drive momentarily gone) → do nothing. Re-entering
// the SAME world → same folder path → no change → no wipe.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));               // bots/_supervisor
const SAVES_ROOT = process.env.ORE_SAVES || 'E:/MC/.minecraft/versions/1.21.4-Fabric 0.19.3/saves';
const WID = path.join(HERE, 'world-id.json');
const MODE = String(process.argv[2] || 'detect').toLowerCase();

// The current world = the region dir whose newest .mca mtime is the latest of all saves.
// Returns { region, mt } (mt = that newest mtime in ms) or null. (Mirrors ore-oracle.mjs
// resolveRegion — kept in lockstep so the two agree on "which world".)
function newestWorldRegion() {
    try {
        let best = null, bestMt = 0;
        for (const w of fs.readdirSync(SAVES_ROOT)) {
            const r = path.join(SAVES_ROOT, w, 'region');
            let dir; try { dir = fs.readdirSync(r); } catch (e) { continue; }
            for (const f of dir) {
                if (!f.endsWith('.mca')) continue;
                let mt; try { mt = fs.statSync(path.join(r, f)).mtimeMs; } catch (e) { continue; }
                if (mt > bestMt) { bestMt = mt; best = r; }
            }
        }
        return best ? { region: best, mt: bestMt } : null;
    } catch (e) { return null; }
}

// ★2026-07-08 掉线加固 (world-flip 去抖): 旧版只认"全 saves 里 .mca 最新 mtime 的 region" = 当前世界,
//   无任何新鲜度/去抖闸 → LAN 世界刚开、还没 autosave 落 .mca 的空窗里, 全局最新会退回"上一次玩过的旧
//   世界", 于是把正常的世界加载误判成"换世界" → kill + 清 landmarks/oracle/记忆 + 重启; 世界一 autosave
//   又翻回来, 反复横跳把状态清光 (实录 23:03 (5)->(4)->wipe、23:13 (4)->(5)->wipe, 每次 ~60s)。两道闸根治:
//   ① 新鲜度: 候选世界的最新 .mca 必须在 FRESH_MS 内被写过 (=真的有人在玩) 才可能是"当前世界"; 陈旧世界
//      永远当不成当前世界 → 直接挡掉"退回旧世界"的误判 (本次事故的主因)。
//   ② 去抖: 同一个"新候选"要连续 CONFIRM 次 detect (watchdog ~30s/次) 命中才真正切换, 过滤加载空窗的抖动。
//   真·换世界仍会触发 (新世界 autosave 后新鲜 + 连续命中), 只是晚 ~1-6min; 远胜每次加载都清空状态。
const FRESH_MS = 15 * 60 * 1000;   // .mca 15min 内没写过 = 该世界没人在玩 (远大于 MC 默认 5min autosave)
const CONFIRM = 2;                 // 连续 N 次 detect 命中同一新候选才切 (~30s/次 → ~60s 确认窗)

const readState = () => { try { return JSON.parse(fs.readFileSync(WID, 'utf8')) || {}; } catch (e) { return {}; } };
const writeState = (o) => { try { fs.writeFileSync(WID, JSON.stringify({ ts: Date.now(), ...o })); } catch (e) {} };

const curInfo = newestWorldRegion();
if (!curInfo) process.exit(0);                       // saves unreadable → never treat as a change
const cur = curInfo.region;
const curAgeMs = Date.now() - curInfo.mt;
const curFresh = curAgeMs <= FRESH_MS;               // is the candidate world actively being played?

if (MODE === 'clear') {
    // World-tied caches/state that all self-regenerate in the new world. Deleting is safe:
    // each is rebuilt from live observation / a fresh scan. (Telemetry like death_log.jsonl,
    // progress.txt, heartbeat.log is intentionally NOT touched.)
    const del = [
        'landmarks.json',      // C328 landmark memory (bed/village/wood/chest) — PERSISTS across restart, the main culprit
        'bed.json',            // real placed-bed spawn anchor
        'chest.json',          // diamondBank chest position
        'bank_ghost.json',     // bank bookkeeping
        'spawn_pos.json',      // world spawn cache
        'world_model.json',    // agent live world model (rebuilt each tick)
        'oracle.json',         // structure oracle output (old-world /locate coordinates)
        'oracle-ores.json',    // ore-oracle output (rewritten next scan)
        'oracle-world-pending.json', // cold-start/world-transition fail-closed sentinel
        'ore-cleared.json',    // phantom-ore cleared list (old-world coords)
        'stations.json',       // ★2026-07-08 用户令 #3: 工作台/熔炉注册点 — 跨世界残留 (实测 39 条散布 ±250b/多世界),
                               //   prepNether "prefer station" 会拽 bot 去追一个不在本世界的地下台 → 摔坑/左右横跳。
                               //   世界文件级 world-tied 缓存, 应随世界切换清零; bot 在新世界 craft 时自会重新登记。
        'keepinv.json',        // ★2026-07-09: keepInventory 校验缓存 (surviveNow 故意送死分支的硬前置)。世界级 gamerule,
                               //   新世界可能是 false → 沿用旧世界的 true 会让 bot 在会掉落物品的世界里故意送死。清掉, 下次 spawn 重新查。
    ];
    const removed = [];
    for (const f of del) {
        const p = path.join(HERE, f);
        try { if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); removed.push(f); } } catch (e) {}
    }
    // Wipe the LLM's persisted cognition of the OLD world. history.load() (history.js:113) rehydrates
    // BOTH the summarized `memory` string AND the recent `turns` on agent boot — and load_mem is on so
    // a watchdog relaunch reloads them. The old fix only blanked `memory`, leaving `turns` full of the
    // previous world's inventory/task/coords chatter → the bot "还记得旧世界的道具栏" and parrots stale
    // state (user report 2026-07-09). On a NEW world every turn is noise, so clear turns + self-prompt
    // too. (This is guarded by detect's freshness+debounce, so it only runs on a REAL world switch.)
    const memF = path.join(HERE, '..', 'Neko', 'memory.json');
    try {
        const o = JSON.parse(fs.readFileSync(memF, 'utf8'));
        if (o && typeof o === 'object') {
            o.memory = '';
            o.turns = [];
            o.self_prompt = null;
            o.self_prompting_state = 0;
            o.last_sender = null;
            fs.writeFileSync(memF, JSON.stringify(o));
            removed.push('Neko/memory.json:{memory,turns,self_prompt}');
        }
    } catch (e) {}
    writeState({ region: cur, mt: curInfo.mt });    // record new baseline (pending fields dropped)
    console.log(`CLEARED world=${cur} files=[${removed.join(', ')}]`);
    process.exit(0);
}

// MODE === 'detect' (default): side-effect-free except establishing the first baseline / debounce state.
const st = readState();
const prev = st.region || null;
if (!prev) { writeState({ region: cur, mt: curInfo.mt }); console.log(`INIT baseline world=${cur} (no wipe)`); process.exit(0); }
if (prev === cur) {                                 // still the same world → keep its mtime fresh, drop any pending candidate
    writeState({ region: cur, mt: curInfo.mt });
    process.exit(0);
}
// prev !== cur: a CANDIDATE world change. Apply the two guards before committing (see rationale above).
// ① freshness — never switch TO a world nobody is actively writing (the fresh-LAN-open blind spot).
if (!curFresh) {
    writeState({ region: prev, mt: st.mt });        // hold on prev; a stale candidate never arms the debounce
    console.log(`HOLD prev=${prev} — candidate ${cur} is STALE (${Math.round(curAgeMs / 1000)}s > ${FRESH_MS / 1000}s idle), not a live world`);
    process.exit(0);
}
// ② debounce — require the same fresh candidate across CONFIRM consecutive detect polls.
const pendCount = (st.pendRegion === cur ? (st.pendCount || 1) + 1 : 1);
if (pendCount < CONFIRM) {
    writeState({ region: prev, mt: st.mt, pendRegion: cur, pendCount });
    console.log(`PENDING world change prev=${prev} cur=${cur} (${pendCount}/${CONFIRM}, debounce)`);
    process.exit(0);
}
console.log(`WORLD_CHANGED prev=${prev} cur=${cur}`);
process.exit(10);                                   // watchdog: kill agent → clear → relaunch
