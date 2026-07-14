// ORACLE DAEMON — 全知侦察常驻进程 (2026-07-05 用户授权信息级全图挂).
// 每 30s 读 vitals.json 的 bot 位置/维度 → RCON 只读 /execute positioned … run locate
// 动态查询当前维度关键结构 → 滚动写 oracle.json (modes.js 挂载为 bot._world.oracle,
// 提案层/技能层统一消费). 红线: 只读命令 (locate/seed), 零状态改变.
// watchdog.ps1 保活 (与 bridge/ticket-server 同款). 日志: oracle-daemon.log.
import net from 'net';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ORACLE_DATA_TTL_MS, atomicWriteJson, readJson, worldIdForRegion } from './oracle_shared.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const VITALS = path.join(DIR, 'vitals.json');
const OUT = path.join(DIR, 'oracle.json');
const WORLD_STATE = path.join(DIR, 'world-id.json');
const LOG = path.join(DIR, 'oracle-daemon.log');
const HOST = process.env.RCON_HOST || '127.0.0.1';
const PORT = parseInt(process.env.RCON_PORT || '25575', 10);
const PASS = process.env.RCON_PASSWORD || 'neko-ops-2026';
const POLL_MS = 30000;
const REQUERY_DIST = 64;   // bot 移动超过此距离才重查 (locate 是服务器侧重操作)

const log = (m) => { try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${m}\n`); } catch (e) {} };

// ── 单命令 RCON 会话 (auth → cmd → close), 8s 超时 ──
function rcon(cmd) {
    return new Promise((resolve) => {
        const done = (v) => { try { sock.destroy(); } catch (e) {} resolve(v); };
        const packet = (id, type, body) => {
            const b = Buffer.from(body, 'utf8');
            const buf = Buffer.alloc(14 + b.length);
            buf.writeInt32LE(10 + b.length, 0); buf.writeInt32LE(id, 4); buf.writeInt32LE(type, 8);
            b.copy(buf, 12); return buf;
        };
        const sock = net.createConnection({ host: HOST, port: PORT });
        let buf = Buffer.alloc(0), authed = false;
        sock.setTimeout(8000, () => done(null));
        sock.on('connect', () => sock.write(packet(1, 3, PASS)));
        sock.on('error', () => done(null));
        sock.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            while (buf.length >= 4) {
                const len = buf.readInt32LE(0);
                if (buf.length < 4 + len) break;
                const id = buf.readInt32LE(4);
                const body = buf.toString('utf8', 12, 4 + len - 2);
                buf = buf.subarray(4 + len);
                if (!authed) {
                    if (id === -1) return done(null);
                    authed = true; sock.write(packet(2, 2, cmd));
                } else return done(body);
            }
        });
    });
}

// structure: "… is at [352, ~, 144] (380 blocks away)"; biome: "… is at [-72, 79, -48] (135 blocks away)"
const parseLocate = (s) => {
    if (!s) return null;
    const m = s.match(/\[(-?\d+), (?:~|-?\d+), (-?\d+)\]\s*\((\d+) blocks/);
    return m ? { x: +m[1], z: +m[2], dist: +m[3] } : null;
};

// 维度 → 查询集 (key → {t: structure|biome, id})。stronghold 全局静态只查一次。
const QUERIES = {
    overworld: {
        village: { t: 'structure', id: '#minecraft:village' },
        ruined_portal: { t: 'structure', id: 'minecraft:ruined_portal' },
        shipwreck: { t: 'structure', id: 'minecraft:shipwreck' },
        forest: { t: 'biome', id: '#minecraft:is_forest' },   // ★木源定向 (chopWood ORACLE march 消费)
    },
    the_nether: {
        fortress: { t: 'structure', id: 'minecraft:fortress' },
        bastion: { t: 'structure', id: 'minecraft:bastion_remnant' },
        ruined_portal_nether: { t: 'structure', id: 'minecraft:ruined_portal_nether' },
    },
    the_end: {},
};

let staticData = null;      // {seed, stronghold} — 启动时查一次
let lastQueryPos = null;    // {dim,x,z} 上次实际发查询的位置
let lastNearest = {};       // 上次查询结果 (bot 没大动时沿用)
let activeWorldId = null;
let activeWorldRegion = null;

async function initStatic() {
    const seedRaw = await rcon('seed');
    const seed = seedRaw ? (seedRaw.match(/\[(-?\d+)\]/) || [])[1] || null : null;
    const shRaw = await rcon('locate structure minecraft:stronghold');
    const stronghold = parseLocate(shRaw);
    staticData = { seed, stronghold };
    log(`static init: seed=${seed} stronghold=${JSON.stringify(stronghold)}`);
}

async function cycle() {
    const vit = await readJson(VITALS, null);
    if (!vit || !Number.isFinite(vit.x)) return;
    const worldState = await readJson(WORLD_STATE, null);
    const nextRegion = worldState && worldState.region || null;
    const nextWorldId = nextRegion ? worldIdForRegion(nextRegion) : null;
    if (nextWorldId && nextWorldId !== activeWorldId) {
        // New-world boundary: never carry static seed/stronghold or nearest results across it.
        activeWorldId = nextWorldId;
        activeWorldRegion = nextRegion;
        staticData = null;
        lastQueryPos = null;
        lastNearest = {};
        try { await fs.promises.rm(OUT, { force: true }); } catch (e) {}
        log(`world generation changed -> ${activeWorldId}; oracle cache reset`);
    }
    const dim = String(vit.dim || 'overworld').replace('minecraft:', '');
    const qs = QUERIES[dim] || {};
    if (!staticData) await initStatic();
    if (staticData && staticData.seed == null) staticData = null;   // RCON 没通, 下轮重试

    const moved = !lastQueryPos || lastQueryPos.dim !== dim
        || Math.hypot(vit.x - lastQueryPos.x, vit.z - lastQueryPos.z) > REQUERY_DIST;
    if (moved && Object.keys(qs).length) {
        const nearest = {};
        for (const [key, q] of Object.entries(qs)) {
            // ★2026-07-05 预审 P0: RCON 命令源恒在主世界 — 不加 `execute in <dim>` 的话
            // 下界 fortress/bastion 查询 100% 'Could not find' → oracle.nearest.fortress 恒 null,
            // 全知层下界侧从未可用。in 子句让查询在 bot 所在维度执行。
            const raw = await rcon(`execute in minecraft:${dim} positioned ${Math.round(vit.x)} ${Math.round(vit.y)} ${Math.round(vit.z)} run locate ${q.t} ${q.id}`);
            nearest[key] = parseLocate(raw);
        }
        lastNearest = nearest;
        lastQueryPos = { dim, x: vit.x, z: vit.z };
        log(`requery @${Math.round(vit.x)},${Math.round(vit.z)} ${dim}: ${JSON.stringify(nearest)}`);
    } else if (lastNearest) {
        // bot 没大动: 只重算 dist (直线, 2D) 保持新鲜度
        for (const k of Object.keys(lastNearest)) {
            const v = lastNearest[k];
            if (v) v.dist = Math.round(Math.hypot(v.x - vit.x, v.z - vit.z));
        }
    }
    const ts = Date.now();
    const out = {
        ts,
        expiresAt: ts + Math.min(ORACLE_DATA_TTL_MS, 90000),
        worldId: activeWorldId,
        worldRegion: activeWorldRegion,
        dim,
        botPos: { x: Math.round(vit.x), y: Math.round(vit.y), z: Math.round(vit.z) },
        nearest: lastNearest,
        static: staticData || {},
        _comment: 'oracle-daemon 滚动全知情报. 只读来源(/seed /locate). bot._world.oracle 消费.',
    };
    try { await atomicWriteJson(OUT, out); } catch (e) {}
}

log(`oracle-daemon started (pid ${process.pid}, rcon ${HOST}:${PORT})`);
await cycle().catch((e) => log('cycle failed: ' + e.message));
setInterval(() => { cycle().catch((e) => log('cycle failed: ' + e.message)); }, POLL_MS);
