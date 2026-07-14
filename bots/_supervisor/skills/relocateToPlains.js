// relocateToPlains — one-shot, user-authorized ("想重启随时重启/随便折腾") escape from a structural
// death-trap REGION (2026-06-21: deaths 0→8 in a husk DESERT — husks are day-immune so daylight
// doesn't save her, migrate terrain-STALLS (adv=0b) so she can't path out, and her server
// spawnpoint (32,-16) is IN the desert death-cluster → every respawn lands in the husk swarm).
// nav-anchor fixes (C322/C323-A) can't help because the SERVER spawnpoint is the desert. /tp bypasses
// the stalled pathfinder. This scans outward for the nearest DRY, GRASSY (plains/forest = no husks),
// death-free, non-water surface and teleports there, sets it as the server spawnpoint, and beds in.
import fs from 'fs';
import path from 'path';

export default async function relocateToPlains(bot, ctx) {
    const { log, Vec3 } = ctx;
    const STICKY = path.resolve(process.cwd(), 'bots', '_supervisor', 'sticky_skill.json');
    try { fs.writeFileSync(STICKY, JSON.stringify({ skill: 'missionNether', args: [] })); } catch (e) {}
    try { bot.interrupt_code = false; } catch (e) {}

    const me = bot.entity.position;
    const origin = { x: Math.round(me.x), y: Math.round(me.y), z: Math.round(me.z) };   // ★safety: tp back here if no spot found (never strand mid-air)
    const isGrass = (n) => /grass_block|podzol|moss_block|mycelium/.test(n || '');
    const isDry = (b) => b && b.boundingBox === 'block' && !/water|lava/.test(b.name || '');
    const WL = (b) => b && /water|lava/.test(b.name || '');
    // death-free check
    let deaths = [];
    try { deaths = fs.readFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'death_log.jsonl'), 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) {}
    const deathsNear = (x, z, r) => deaths.filter(d => typeof d.x === 'number' && Math.hypot(d.x - x, d.z - z) < r).length;

    // ---- find a grassy dry death-free spot: probe a ring of candidate columns, /tp-hop outward to
    // load chunks the pathfinder can't reach, scanning at each hop. Deserts are finite — step out. ----
    const findGoodSpot = () => {
        try {
            const gdef = bot.registry.blocksByName['grass_block'];
            if (!gdef) return null;
            const hits = bot.findBlocks({ matching: gdef.id, maxDistance: 110, count: 400 }) || [];
            let best = null, bd = -1e9;
            for (const h of hits) {
                const top = bot.blockAt(h.offset(0, 1, 0)), top2 = bot.blockAt(h.offset(0, 2, 0));
                if (!(top && /air|grass|fern|snow|flower/.test(top.name) && top2 && /air|grass|fern|snow|flower/.test(top2.name))) continue;
                // ★stricter (last run landed her in water): require DRY (no water within 8b) AND a solid
                // 5x5 platform of REAL land (≥20/25 solid surface cells — not a 1-block grass island in a lake).
                let wet = false;
                for (let dx = -8; dx <= 8 && !wet; dx++) for (let dz = -8; dz <= 8; dz++) if (WL(bot.blockAt(h.offset(dx, 0, dz))) || WL(bot.blockAt(h.offset(dx, 1, dz))) || WL(bot.blockAt(h.offset(dx, -1, dz)))) { wet = true; break; }
                if (wet) continue;
                let solidCells = 0;
                for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (isDry(bot.blockAt(h.offset(dx, 0, dz)))) solidCells++;
                if (solidCells < 20) continue;   // need a real 5x5 land platform, not an island/edge
                const dn = deathsNear(h.x, h.z, 24);
                const score = -dn * 20 - h.distanceTo(me) * 0.01;   // death-free + closest grassy dry
                if (score > bd) { bd = score; best = h.offset(0, 1, 0); }
            }
            return best;
        } catch (e) { return null; }
    };

    let spot = findGoodSpot();
    // not in render range → hop outward via /tp toward the cardinal least-desert; re-scan each hop.
    // ★bigger reach (1000b found NO real land — region is desert+water): hop out to ~6000b in 8
    // directions so we clear large desert/ocean and actually hit plains/forest. Each hop /tp's to
    // y150 to load the chunk, scans; abort tp's back to origin (never strands).
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
    for (let hop = 0; !spot && hop < 12; hop++) {
        const [dx, dz] = dirs[hop % dirs.length];
        const tx = Math.round(me.x + dx * (700 + hop * 450)), tz = Math.round(me.z + dz * (700 + hop * 450));
        log(bot, `relocateToPlains: no grass in range — /tp hop ${hop + 1} → ${tx},120,${tz} to load+scan`);
        try { bot.chat(`/tp @s ${tx} 120 ${tz}`); } catch (e) {}
        try { await new Promise(r => setTimeout(r, 2500)); } catch (e) {}
        spot = findGoodSpot();
    }

    if (!spot) {
        log(bot, 'relocateToPlains: no grassy dry death-free spot after 8 hops — desert too vast; /tp back to origin (no mid-air strand), manual relocate needed.');
        try { bot.chat(`/tp @s ${origin.x} ${origin.y} ${origin.z}`); } catch (e) {}
        return false;
    }

    // teleport onto the good spot, set spawnpoint there, anchor the supervisor bed.json too.
    try { bot.chat(`/tp @s ${spot.x} ${spot.y} ${spot.z}`); log(bot, `relocateToPlains: /tp → grassy dry spot ${spot.x},${spot.y},${spot.z}`); } catch (e) {}
    try { await new Promise(r => setTimeout(r, 1500)); } catch (e) {}
    try { bot.chat(`/spawnpoint @s ${spot.x} ${spot.y} ${spot.z}`); log(bot, `relocateToPlains: /spawnpoint set @${spot.x},${spot.y},${spot.z} (off the husk desert)`); } catch (e) {}
    try { fs.writeFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'bed.json'), JSON.stringify({ x: spot.x, y: spot.y, z: spot.z, t: Date.now(), src: 'relocateToPlains', score: 99, biome: 'plains', deathsNear: 0 })); } catch (e) {}
    log(bot, `relocateToPlains: done — relocated off desert to ${spot.x},${spot.y},${spot.z}; setBed will plant a bed + sleep here.`);
    return true;
}
