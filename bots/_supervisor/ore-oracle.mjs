// ORE ORACLE — 矿石级全知 (2026-07-05 用户令2: "远征首要目标钻石, 允许全图挂锁定最近钻石")。
// /locate 不支持矿物, 但区块一经生成全深度矿物即落盘 — 离线读服务器 region (.mca) 文件,
// 扫出真·最近钻石坐标 → oracle-ores.json → modes.js 挂 bot._world.oracleOres → mineDiamonds
// 直奔坐标。只读世界文件, 零状态修改。watchdog 保活; palette 快路径跳过无钻 section。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import anvilPkg from 'prismarine-provider-anvil';
import minecraftData from 'minecraft-data';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const VITALS = path.join(DIR, 'vitals.json');
const OUT = path.join(DIR, 'oracle-ores.json');
const LOG = path.join(DIR, 'ore-oracle.log');
const REGION = process.env.ORE_REGION || 'C:/Users/Administrator/mc-server/world/region';
const log = (m) => { try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${m}\n`); } catch (e) {} };

const mcData = minecraftData('1.21.1');
// ★2026-07-06 用户令: "oracle视角挖铁应该非常快" — 扫描泛化到铁/煤 (mineOres 直奔坐标;
// 铁曾是盲挖 mineDown 的 1h 级瓶颈)。palette 快路径按并集判段, 逐格再按 stateId 分族。
const ORE_FAMILIES = {
    diamonds: ['diamond_ore', 'deepslate_diamond_ore'],
    iron: ['iron_ore', 'deepslate_iron_ore'],
    coal: ['coal_ore', 'deepslate_coal_ore'],
    // ★地表水 (2026-07-06): wheatFarm 立田(水化 4 格)与 gatherObsidian 桶浇(32 格内水)
    //   的共同硬前置 — 干旱高地 24b 找水恒空 (tilled=0 实录)。只收 y 58-70 地表带, 上限截断。
    water: ['water'],
};
const WATER_Y_LO = 58, WATER_Y_HI = 70, WATER_CAP = 200;
const TARGET_STATES = new Set();
const STATE_FAMILY = new Map();
for (const [fam, names] of Object.entries(ORE_FAMILIES)) {
    for (const n of names) {
        const b = mcData.blocksByName[n];
        if (!b) continue;
        for (let s = b.minStateId; s <= b.maxStateId; s++) { TARGET_STATES.add(s); STATE_FAMILY.set(s, fam); }
    }
}
const AnvilCls = anvilPkg.Anvil('1.21.1');
const anvil = new AnvilCls(REGION);

const CHUNK_RADIUS = 8;      // ±8 chunks ≈ 128 格半径
const RESCAN_DIST = 48;      // bot 移动超此距离才重扫 (扫描是重操作)
const POLL_MS = 60000;
let lastScan = null;

async function scan() {
    let vit;
    try { vit = JSON.parse(fs.readFileSync(VITALS, 'utf8')); } catch (e) { return; }
    if (!vit || !Number.isFinite(vit.x)) return;
    const dim = String(vit.dim || 'overworld');
    if (/nether|end/.test(dim)) return;   // 钻石只在主世界
    if (lastScan && Math.hypot(vit.x - lastScan.x, vit.z - lastScan.z) < RESCAN_DIST) {
        // ★评审 P3: 驻点采矿 >10min 会让 ts 自过期 → 消费方误判陈旧降级盲挖。跳扫也续 ts
        //   (数据仍有效: bot 没离开扫描原点 48b) — 只改 ts 不重扫。
        try {
            const j = JSON.parse(fs.readFileSync(OUT, 'utf8'));
            j.ts = Date.now();
            fs.writeFileSync(OUT, JSON.stringify(j));
        } catch (e) {}
        return;
    }
    const t0 = Date.now();
    const bcx = Math.floor(vit.x / 16), bcz = Math.floor(vit.z / 16);
    const found = { diamonds: [], iron: [], coal: [], water: [] };
    let scanned = 0, missing = 0, skippedSecs = 0;
    for (let dx = -CHUNK_RADIUS; dx <= CHUNK_RADIUS; dx++) {
        for (let dz = -CHUNK_RADIUS; dz <= CHUNK_RADIUS; dz++) {
            let chunk;
            try { chunk = await anvil.load(bcx + dx, bcz + dz); } catch (e) { chunk = null; }
            if (!chunk) { missing++; continue; }
            scanned++;
            // palette 快路径: section 调色板不含钻石态 → 整段 4096 格直接跳
            const secHasTarget = (secY) => {
                try {
                    const secs = chunk.sections;
                    if (!Array.isArray(secs)) return true;   // 结构未知 → 保守全扫
                    const idx = secY - (chunk.minY ? chunk.minY / 16 : -4);
                    const sec = secs[idx];
                    const pal = sec && (sec.palette || (sec.data && sec.data.palette));
                    if (!pal) return true;
                    const vals = Array.isArray(pal) ? pal : (typeof pal.values === 'function' ? pal.values() : null);
                    if (!vals) return true;
                    for (const v of vals) { const sid = typeof v === 'number' ? v : (v && v.stateId); if (TARGET_STATES.has(sid)) return true; }
                    return false;
                } catch (e) { return true; }
            };
            for (let secY = -4; secY <= 5; secY++) {          // y -64..95 覆盖钻石带+铁/煤主带
                if (!secHasTarget(secY)) { skippedSecs++; continue; }
                const yLo = Math.max(secY * 16, -60), yHi = Math.min(secY * 16 + 15, 95);
                for (let y = yLo; y <= yHi; y++) {
                    for (let lx = 0; lx < 16; lx++) {
                        for (let lz = 0; lz < 16; lz++) {
                            let sid;
                            try { sid = chunk.getBlockStateId({ x: lx, y, z: lz }); } catch (e) { continue; }
                            const fam = STATE_FAMILY.get(sid);
                            if (!fam) continue;
                            if (fam === 'water') {
                                if (y < WATER_Y_LO || y > WATER_Y_HI || found.water.length >= WATER_CAP) continue;
                            }
                            found[fam].push({ x: (bcx + dx) * 16 + lx, y, z: (bcz + dz) * 16 + lz });
                        }
                    }
                }
            }
        }
    }
    const byDist = (a, b) => Math.hypot(a.x - vit.x, a.y - vit.y, a.z - vit.z) - Math.hypot(b.x - vit.x, b.y - vit.y, b.z - vit.z);
    for (const fam of Object.keys(found)) found[fam].sort(byDist);
    const out = {
        ts: Date.now(),
        botPos: { x: Math.round(vit.x), y: Math.round(vit.y), z: Math.round(vit.z) },
        scannedChunks: scanned, missingChunks: missing, skippedSections: skippedSecs,
        totalFound: found.diamonds.length,   // 兼容旧口径 (mineDiamonds 日志用)
        totals: { diamonds: found.diamonds.length, iron: found.iron.length, coal: found.coal.length },
        diamonds: found.diamonds.slice(0, 16),
        iron: found.iron.slice(0, 24),
        // 分层: 山顶 bot 的 iron top-24 可能全是山面铁(y60-95), 夜挖(y<=50 地下带)会空手 —
        // 单列地下带最近 16 条 (夜挖/隐蔽作业直接用)
        ironDeep: found.iron.filter(c => c.y <= 50).slice(0, 16),
        coal: found.coal.slice(0, 16),
        water: found.water.slice(0, 8),
    };
    try { fs.writeFileSync(OUT, JSON.stringify(out)); } catch (e) {}
    lastScan = { x: vit.x, z: vit.z };
    const near = (fam) => { const f = found[fam][0]; return f ? Math.round(Math.hypot(f.x - vit.x, f.y - vit.y, f.z - vit.z)) + 'b@' + f.x + ',' + f.y + ',' + f.z : 'none'; };
    log(`scan ${Date.now() - t0}ms chunks=${scanned}(miss ${missing}) secSkip=${skippedSecs} dia=${found.diamonds.length}(${near('diamonds')}) iron=${found.iron.length}(${near('iron')}) coal=${found.coal.length}(${near('coal')})`);
}

log(`ore-oracle started (pid ${process.pid}, region ${REGION})`);
await scan().catch((e) => log('scan err: ' + (e && e.stack || e)));
if (process.env.ORE_ONESHOT) { log('oneshot done'); process.exit(0); }
setInterval(() => scan().catch((e) => log('scan err: ' + (e && e.message || e))), POLL_MS);
