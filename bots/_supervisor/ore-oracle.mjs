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
const CLEARED = path.join(DIR, 'ore-cleared.json');
const LOG = path.join(DIR, 'ore-oracle.log');
const log = (m) => { try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${m}\n`); } catch (e) {} };

// ★2026-07-08 miss-289 根因: 旧硬编码 REGION 'C:/Users/Administrator/mc-server/world/region'
//   已不存在 (世界实为 Fabric client E: 存档) → 289 区块全 miss → oracle 恒空 → mineOres 盲挖送死。
//   改为自动定位: 扫 saves 下所有 region 目录, 取 .mca 最新的那个 (=当前联机世界)。
//   世界名会随 "新的世界 (N)" 递增, 故不写死具体世界名; ORE_REGION 环境变量仍可覆盖。
const SAVES_ROOT = process.env.ORE_SAVES || 'E:/MC/.minecraft/versions/1.21.4-Fabric 0.19.3/saves';
const LEGACY_REGION = 'C:/Users/Administrator/mc-server/world/region';
// region 目录有效 = 存在且至少 1 个 .mca (空目录/失效路径视作无效)。
function regionHasMca(dir) {
    try { return fs.readdirSync(dir).some(f => f.endsWith('.mca')); } catch (e) { return false; }
}
function resolveRegion() {
    // ★2026-07-08: ORE_REGION 只在其"活着"时才信 — 长驻 watchdog 把已失效路径钉进子进程 env
    //   (contracts.js:247 同类坑), 若无脑信 env 则改名/搬盘后永远 miss。校验失败即落到自动定位,
    //   使修复无需重启 watchdog 就在下一次 scan 自愈。
    if (process.env.ORE_REGION) {
        if (regionHasMca(process.env.ORE_REGION)) return process.env.ORE_REGION;
        log(`ORE_REGION 无效(无 .mca): ${process.env.ORE_REGION} → 落自动定位`);
    }
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
        if (best) return best;
    } catch (e) { log('resolveRegion err: ' + (e && e.message || e)); }
    return LEGACY_REGION;
}

const mcData = minecraftData('1.21.1');
// ★2026-07-06 用户令: "oracle视角挖铁应该非常快" — 扫描泛化到铁/煤 (mineOres 直奔坐标;
// 铁曾是盲挖 mineDown 的 1h 级瓶颈)。palette 快路径按并集判段, 逐格再按 stateId 分族。
const ORE_FAMILIES = {
    diamonds: ['diamond_ore', 'deepslate_diamond_ore'],
    iron: ['iron_ore', 'deepslate_iron_ore'],
    // ★2026-07-08 用户令: 主世界金矿 (badlands 地表 gold_ore + 深板岩带 deepslate_gold_ore, y<32)。
    //   此前完全没扫 → mineOres("gold") 无 oracle 坐标只能盲挖。nether_gold_ore 不收 (oracle 只扫主世界)。
    gold: ['gold_ore', 'deepslate_gold_ore'],
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
// ★2026-07-06 幻影矿根因: server autosave 重排 .mca 内部 chunk 偏移表, 长驻实例的
//   旧句柄按过期偏移读出错位数据 (RCON 实证: 铁 y47-50 全幻影=stale 读, 钻石准=紧挨
//   启动的新鲜读)。每次 scan() 重建实例, 句柄/偏移表永远新鲜。

// ★2026-07-08 用户令: 外扩搜矿 — 从起始半径起, 常用矿(钻/铁/金)任一未达库存 quota 就 +STEP 外扩,
//   直到达标或撞 MAX 上限。局部矿富时停在 128b(省 IO), 稀疏时才向外掏, 上限封顶单扫 IO。
const CHUNK_RADIUS = 8;          // 起始半径 ±8 chunks ≈ 128b (不足才外扩)
const MAX_CHUNK_RADIUS = 24;     // 外扩上限 ±24 chunks ≈ 384b (用户令: 单扫 <3s)
const RADIUS_STEP = 4;           // 每次不足 +4 chunks ≈ +64b
const QUOTA = { diamonds: 16, iron: 24, gold: 16 };  // 对齐消费方切片; 达标即停扩 (煤/水到处都是, 不设 quota)
const POLL_MS = 60000;

// ── 每区块缓存 (跨 poll): key "cx,cz" → { mtime, ts, ores }。.mca mtime 未变 & 未过 TTL & 无幻影命中
//    → 复用, 免重读 (autosave 会 bump mtime → 自动刷新, 正合"缓存刷新机制")。严防幻影: 某区块落在
//    ore-cleared 中心内一律强制新鲜重读, 不吃缓存 (用户令: "一旦检测到立即清理缓存")。
const chunkCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;   // 兜底 TTL: mtime 万一不动也 5min 强制重读
const FAM_KEYS = Object.keys(ORE_FAMILIES);
function regionFileFor(cx, cz) { return `r.${cx >> 5}.${cz >> 5}.mca`; }
// 区块 (cx,cz) 是否落在某幻影中心 r 内 (以区块中心近似, 放宽 16b 容差)。
function chunkNearCleared(cx, cz, cleared) {
    if (!cleared.length) return false;
    const wx = cx * 16 + 8, wz = cz * 16 + 8;
    return cleared.some(c => c && Math.hypot((c.x || 0) - wx, (c.z || 0) - wz) <= ((c.r || 48) + 16));
}

// ★幻影铁活锁修 (oracle-phantom-iron-activelock, 2026-07-06): mineOres 走到 oracle 坐标后
//   collectBlock 扫 64b live 零命中会把该邻域中心写入 ore-cleared.json — 磁盘 region 落后于
//   LAN live 世界的幻影铁/煤。出表前滤掉这些中心 r 内候选, oracle 不再把 bot 反复导向已证实
//   为空的鬼坐标。仅 iron/coal (钻石读数准, 且用户令: 钻石路径不动); 2h TTL 自然回收。
function loadCleared() {
    try {
        const cj = JSON.parse(fs.readFileSync(CLEARED, 'utf8'));
        const cutoff = Date.now() - 2 * 3600 * 1000;
        return ((cj && cj.cleared) || []).filter(c => c && (c.ts || 0) > cutoff);
    } catch (e) { return []; }
}
function dropCleared(list, fam, cleared) {
    if (!cleared.length || !Array.isArray(list)) return list;
    return list.filter(o => !cleared.some(c => c && c.ore === fam
        && Math.hypot((c.x || 0) - o.x, (c.y || 0) - o.y, (c.z || 0) - o.z) <= (c.r || 48)));
}

// 单区块矿扫 (纯函数, 结果可缓存)。返回 { ores:{fam:[{x,y,z}..]}, skipped }。
function scanChunkOres(chunk, cx, cz) {
    const ores = { diamonds: [], iron: [], gold: [], coal: [], water: [] };
    let skipped = 0;
    // palette 快路径: section 调色板不含任何目标态 → 整段 4096 格直接跳
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
    for (let secY = -4; secY <= 5; secY++) {          // y -64..95 覆盖钻石带+铁/金/煤主带
        if (!secHasTarget(secY)) { skipped++; continue; }
        const yLo = Math.max(secY * 16, -60), yHi = Math.min(secY * 16 + 15, 95);
        for (let y = yLo; y <= yHi; y++) {
            for (let lx = 0; lx < 16; lx++) {
                for (let lz = 0; lz < 16; lz++) {
                    let sid;
                    try { sid = chunk.getBlockStateId({ x: lx, y, z: lz }); } catch (e) { continue; }
                    const fam = STATE_FAMILY.get(sid);
                    if (!fam) continue;
                    if (fam === 'water') {
                        if (y < WATER_Y_LO || y > WATER_Y_HI || ores.water.length >= 32) continue;  // 每区块封顶 (全局在出表切片)
                    }
                    ores[fam].push({ x: cx * 16 + lx, y, z: cz * 16 + lz });
                }
            }
        }
    }
    return { ores, skipped };
}

// 缓存感知的区块取矿: mtime 未变 & 未过 TTL & 无幻影命中 → 复用; 否则新鲜重读并回填缓存。
async function getChunkOres(anvil, regionDir, cx, cz, cleared, stats) {
    const key = cx + ',' + cz;
    let mtime = 0;
    try { mtime = fs.statSync(path.join(regionDir, regionFileFor(cx, cz))).mtimeMs; } catch (e) {}
    const phantom = chunkNearCleared(cx, cz, cleared);
    const cached = chunkCache.get(key);
    if (cached && !phantom && cached.mtime === mtime && (Date.now() - cached.ts) < CACHE_TTL_MS) {
        stats.cacheHits++;
        return cached.ores;
    }
    if (phantom && cached) chunkCache.delete(key);   // ★幻影命中: 立即清缓存, 强制新鲜重读 (用户令)
    let chunk;
    try { chunk = await anvil.load(cx, cz); } catch (e) { chunk = null; }
    if (!chunk) { stats.missing++; return null; }
    stats.scanned++;
    const { ores, skipped } = scanChunkOres(chunk, cx, cz);
    stats.skippedSecs += skipped;
    if (!phantom) chunkCache.set(key, { mtime, ts: Date.now(), ores });   // 幻影区块不落缓存 → 下扫仍新鲜
    return ores;
}

// Chebyshev 环: r=0 中心块; r≥1 该距离的方形周边 (逐环外扩用, 内圈不重扫)。
function* ringChunks(bcx, bcz, r) {
    if (r === 0) { yield [bcx, bcz]; return; }
    for (let d = -r; d <= r; d++) { yield [bcx + d, bcz - r]; yield [bcx + d, bcz + r]; }
    for (let d = -r + 1; d <= r - 1; d++) { yield [bcx - r, bcz + d]; yield [bcx + r, bcz + d]; }
}

async function scan() {
    let vit;
    try { vit = JSON.parse(fs.readFileSync(VITALS, 'utf8')); } catch (e) { return; }
    if (!vit || !Number.isFinite(vit.x)) return;
    const dim = String(vit.dim || 'overworld');
    if (/nether|end/.test(dim)) return;   // oracle 只扫主世界
    const t0 = Date.now();
    const REGION = resolveRegion();       // 每扫重定位 — bot 换世界(新的世界 N→N+1)也自动跟上
    const anvil = new AnvilCls(REGION);   // 每扫新建 — 防 autosave 偏移表过期(幻影矿根因)
    const bcx = Math.floor(vit.x / 16), bcz = Math.floor(vit.z / 16);
    const found = { diamonds: [], iron: [], gold: [], coal: [], water: [] };
    const cleared = loadCleared();
    const stats = { scanned: 0, missing: 0, skippedSecs: 0, cacheHits: 0 };
    const quotaMet = () => Object.keys(QUOTA).every(f => found[f].length >= QUOTA[f]);
    // 外扩: 先无条件扫满起始半径 (CHUNK_RADIUS), 之后每扩一环查 quota — 常用矿(钻/铁/金)都达标即停。
    let reachedR = 0;
    for (let r = 0; r <= MAX_CHUNK_RADIUS; r += (r < CHUNK_RADIUS ? 1 : RADIUS_STEP)) {
        for (const [cx, cz] of ringChunks(bcx, bcz, r)) {
            const ores = await getChunkOres(anvil, REGION, cx, cz, cleared, stats);
            if (!ores) continue;
            for (const fam of FAM_KEYS) { const dst = found[fam], src = ores[fam]; for (let i = 0; i < src.length; i++) dst.push(src[i]); }
        }
        reachedR = r;
        if (r >= CHUNK_RADIUS && quotaMet()) break;
    }
    // ★幻影活锁修: 滤掉已证实为空的邻域(iron/gold/coal), 切片前做 → 邻域外真矿能补进名单。
    //   钻石读数准 (紧挨启动的新鲜读) 且用户令钻石路径不动 → 不滤钻石。
    if (cleared.length) {
        for (const fam of ['iron', 'gold', 'coal']) {
            const before0 = found[fam].length;
            found[fam] = dropCleared(found[fam], fam, cleared);
            const dropped = before0 - found[fam].length;
            if (dropped) log(`cleared-filter ${fam}: -${dropped} 幻影 (${cleared.filter(c => c.ore === fam).length} 中心)`);
        }
    }
    const byDist = (a, b) => Math.hypot(a.x - vit.x, a.y - vit.y, a.z - vit.z) - Math.hypot(b.x - vit.x, b.y - vit.y, b.z - vit.z);
    for (const fam of FAM_KEYS) found[fam].sort(byDist);
    const out = {
        ts: Date.now(),
        botPos: { x: Math.round(vit.x), y: Math.round(vit.y), z: Math.round(vit.z) },
        scannedChunks: stats.scanned, missingChunks: stats.missing, skippedSections: stats.skippedSecs,
        cacheHits: stats.cacheHits, reachedRadius: reachedR,
        totalFound: found.diamonds.length,   // 兼容旧口径 (mineDiamonds 日志用)
        totals: { diamonds: found.diamonds.length, iron: found.iron.length, gold: found.gold.length, coal: found.coal.length },
        diamonds: found.diamonds.slice(0, 16),
        iron: found.iron.slice(0, 24),
        // 分层: 山顶 bot 的 iron top-24 可能全是山面铁(y60-95), 夜挖(y<=50 地下带)会空手 —
        // 单列地下带最近 16 条 (夜挖/隐蔽作业直接用)
        ironDeep: found.iron.filter(c => c.y <= 50).slice(0, 16),
        gold: found.gold.slice(0, 16),
        coal: found.coal.slice(0, 16),
        water: found.water.slice(0, 8),
    };
    try { fs.writeFileSync(OUT, JSON.stringify(out)); } catch (e) {}
    // cache 防泄漏: bot 走远后旧区块不再被访问, 超上限时按插入序淘汰最旧一批。
    if (chunkCache.size > 4096) { for (const k of chunkCache.keys()) { if (chunkCache.size <= 2048) break; chunkCache.delete(k); } }
    const near = (fam) => { const f = found[fam][0]; return f ? Math.round(Math.hypot(f.x - vit.x, f.y - vit.y, f.z - vit.z)) + 'b@' + f.x + ',' + f.y + ',' + f.z : 'none'; };
    log(`scan ${Date.now() - t0}ms R=${reachedR} chunks=${stats.scanned}(miss ${stats.missing},cache ${stats.cacheHits}) secSkip=${stats.skippedSecs} dia=${found.diamonds.length}(${near('diamonds')}) iron=${found.iron.length}(${near('iron')}) gold=${found.gold.length}(${near('gold')}) coal=${found.coal.length}(${near('coal')})`);
}

log(`ore-oracle started (pid ${process.pid}, region ${resolveRegion()})`);
await scan().catch((e) => log('scan err: ' + (e && e.stack || e)));
if (process.env.ORE_ONESHOT) { log('oneshot done'); process.exit(0); }
setInterval(() => scan().catch((e) => log('scan err: ' + (e && e.message || e))), POLL_MS);
