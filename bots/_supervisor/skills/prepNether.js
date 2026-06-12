// Hot-reloadable ORCHESTRATION: gear up to diamond and gather the nether-portal
// prerequisites, self-sufficiently. Drives achieve() for each goal (craftables +
// diamond/obsidian mining), equips armour as it goes. Runs under the supervised
// lock (LLM silenced) via run_skill. This is the staging step before building &
// lighting a nether portal. Invoked via: {"skill":"prepNether"}
// ctx = { skills, world, mc, Vec3, log }
import fs from 'fs';
import path from 'path';
const PROG = path.resolve(process.cwd(), 'bots', '_supervisor', 'progress.txt');
const prog = (s) => { try { fs.appendFileSync(PROG, `[${new Date().toISOString()}] ${s}\n`); } catch (e) {} };

export default async function prepNether(bot, ctx) {
    const { skills, world, log, Vec3 } = ctx;
    const has = (n) => world.getInventoryCounts(bot)[n] || 0;
    const equipArmor = async () => { if (bot.armorManager) { try { await bot.armorManager.equipAll(); } catch (e) {} } };
    // HUMAN RHYTHM + RESOURCE SENSE: night only matters when EXPOSED on the surface. Being
    // UNDERGROUND is safe, and if we're well-supplied (pickaxe + blocks + food) the smart move
    // at night is to be DOWN mining — not idling, not grinding exposed. So we only hole up when
    // we're on the exposed surface AND not equipped to go mine safely. (This fixes the too-rigid
    // "always hide at night" — per the resource-management instinct, a kitted bot spends the
    // night productively underground.)
    const isNightNow = () => { try { const t = bot.time.timeOfDay; return t >= 13000 && t <= 23000; } catch (e) { return false; } };
    // DUSK = sun setting, mobs about to spawn (~12000→13000). Used for a PROACTIVE pre-night
    // securing pass (the user's "入夜前明确提醒") so we never get caught leisurely working when
    // night actually lands.
    const isDuskNow = () => { try { const t = bot.time.timeOfDay; return t >= 12000 && t < 13000; } catch (e) { return false; } };
    // "深处=安全"必须同时无怪: 199死在y54黑隧道(苦力怕背刺1.8格爆) — 深度挡不住已经
    // 刷在隧道里的怪。夜间继续作业的门槛: 真的深(y<50) 且 12格内干净。
    const undergroundSafe = () => { try { return bot.entity.position.y < 50 && hostilesNear(12) === 0; } catch (e) { return bot.entity.position.y < 50; } };
    const canMineSafely = () => {
        const c = world.getInventoryCounts(bot);
        const pick = ['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe', 'golden_pickaxe', 'wooden_pickaxe'].some(p => (c[p] || 0) > 0);
        const blocks = (c.dirt || 0) + (c.cobblestone || 0) + (c.cobbled_deepslate || 0) + (c.stone || 0) + (c.netherrack || 0) >= 8;
        return pick && blocks;   // kitted to dig down & seal a mining tunnel safely
    };
    // ★装备感知 (用户: 有铁剑+盾却被僵尸打死). If we're equipped to WIN a night fight (sword +
    // shield + decent HP), DON'T hole up idle — keep working; modes.self_defense kills mobs with
    // the gear as they come (mirrors modes.shouldNightShelter's canWin). Only the NAKED/weak bot
    // holes up at night. This is the "equipped human works through the night, fights off zombies".
    const canFightNight = () => {
        const c = world.getInventoryCounts(bot);
        const sword = Object.keys(c).some(n => /_sword$/.test(n) && c[n] > 0);
        const shield = (c.shield || 0) > 0;
        return sword && shield && bot.health >= 10;
    };
    // ★SPAWN-PROOF (用户洞察): hostile mobs only spawn in DARKNESS (block light 0). A ring of
    // torches around us lights the area → NO mobs spawn here → no night swarm to fight/flee at
    // all. This is strictly better than passively bunkering/kiting ONCE WE HAVE TORCHES. Bounded
    // (≤6 torches, within reach), skips if <3 torches (early naked nights still rely on the
    // instant-bunker). Lights the immediate ~6-block bubble — enough to hold/work the night safely.
    const spawnProof = async () => {
        if (bot.interrupt_code || has('torch') < 3) return;
        const base = bot.entity.position.floored();
        const offs = [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2], [2, -2], [-2, 2]];
        let placed = 0;
        for (const [dx, dz] of offs) {
            if (has('torch') < 1 || placed >= 6 || bot.interrupt_code) break;
            for (let dy = 1; dy >= -2; dy--) {
                const gp = base.offset(dx, dy - 1, dz), ap = base.offset(dx, dy, dz);
                const g = bot.blockAt(gp), a = bot.blockAt(ap);
                const solid = g && g.boundingBox === 'block' && !/water|lava/.test(g.name || '');
                const open = a && /^(air|cave_air|short_grass|tall_grass|snow)$/.test(a.name || '');
                if (solid && open) {
                    try { await skills.placeBlock(bot, 'torch', ap.x, ap.y, ap.z, 'bottom', true); placed++; } catch (e) {}
                    break;
                }
            }
        }
        if (placed > 0) prog(`prepNether: spawn-proofed with ${placed} torches (no-spawn zone)`);
    };
    const holeUpAtNight = async () => {
        let logged = false, proofed = false;
        // A STALE interrupt (death-abort / finished flee) must not skip the night hold:
        // that exact skip let a naked respawn walk straight into wood-chopping at night
        // beside the zombie that just killed it (death 195 → spiral). Clear it and give
        // modes 800ms — a LIVE fight re-sets interrupt_code within ticks and the hold
        // loop below still yields to it; only the GHOST flag is neutralized here.
        if (isNightNow() && bot.interrupt_code) { try { bot.interrupt_code = false; } catch (e) {} try { await skills.wait(bot, 800); } catch (e) {} }
        // ★夜晚意识 (用户诊断: bot 没夜晚意识,天黑还慢悠悠挖→被偷袭死). TWO proactive changes:
        // (A) DUSK pre-warning + securing BEFORE mobs spawn — don't wait for night to land.
        // (B) At night on the SURFACE, ALWAYS secure (spawn-proof + hole up). The old code let
        //     `canMineSafely()` (有镐+方块) skip holing-up → the bot kept LEISURELY surface-mining
        //     exposed at night and got ambushed. "能挖"≠"地表夜里安全". Only genuinely-deep
        //     (undergroundSafe, y<50) lets work continue — there it's already safe to mine.
        if (isDuskNow() && !undergroundSafe() && !bot.interrupt_code) {
            prog('prepNether: ★DUSK 天黑将至 — 主动收尾转生存(spawn-proof + 准备入夜)');
            try { await spawnProof(); } catch (e) {} proofed = true;
        }
        let dugIn = false;
        while (isNightNow() && !bot.interrupt_code) {
            if (undergroundSafe()) break;   // 真正深处(y<50)=已安全 → 继续作业(不再用 canMineSafely 放行地表暴露作业)
            if (bot._mobility && bot._mobility.enclosed) break;   // ★封闭地穴(状态机全知列探测)=夜昼无别,继续作业(用户指点: y<50 代理判断漏掉 y≥50 的崖体隧道/封闭洞)
            if (canFightNight()) break;     // ★装备齐全(剑+盾+血)→ 不躲,继续干,self_defense 边干边砍怪(对齐 modes)
            if (!proofed) { try { await spawnProof(); } catch (e) {} proofed = true; }   // 先照亮 hold 点 — 无光不刷怪
            if (!logged) { prog('prepNether: ★NIGHT 入夜→优先生存:停止暴露作业,spawn-proof + hole up 到天亮'); logged = true; }
            // ★裸装确定性地堡 (#24 最小版): 干等 modes 来救不够确定 — 自己挖二封一。
            // 徒手挖泥土有掉落,挖出的土正好封顶,零资源自洽(夜税的主根:裸重生地表过夜)。
            // 已有顶盖(coveredAbove)就不重复挖。
            if (!dugIn) {
                dugIn = true;
                try {
                    // ★WATERFRONT VETO (drowned kills x3: #265/#268/#272 — #272 was dragged
                    // off this very dig site by a drowned surfacing 0.8b away at night; the
                    // old check only refused water UNDER our feet, not water BESIDE us,
                    // and a night shoreline is drowned spawning ground). Any surface water
                    // within 8 blocks → walk 12 blocks directly away from it before digging.
                    try {
                        const wb = world.getNearestBlock(bot, 'water', 8);
                        if (wb) {
                            const me = bot.entity.position;
                            let ax = me.x - wb.position.x, az = me.z - wb.position.z;
                            const L = Math.hypot(ax, az) || 1; ax /= L; az /= L;
                            prog(`prepNether: bunker site too close to water (${Math.round(L)}b) — moving 12b inland before digging`);
                            try { await skills.goToPosition(bot, Math.round(me.x + ax * 12), null, Math.round(me.z + az * 12), 2); } catch (e) {}
                        }
                    } catch (e) {}
                    const headCovered = (() => { const h = bot.blockAt(bot.entity.position.offset(0, 2, 0)); return h && h.boundingBox === 'block'; })();
                    if (!headCovered) {
                        await skills.digDown(bot, 2);
                        const seal = bot.inventory.items().find(i => /^(dirt|grass_block|cobblestone|cobbled_deepslate|granite|diorite|andesite|tuff|gravel|netherrack)$/.test(i.name));
                        if (seal) {
                            const top = bot.entity.position.floored().offset(0, 2, 0);
                            try { await skills.placeBlock(bot, seal.name, top.x, top.y, top.z, 'bottom', true); } catch (e) {}
                        }
                        const sealedNow = (() => { const h = bot.blockAt(bot.entity.position.offset(0, 2, 0)); return h && h.boundingBox === 'block'; })();
                        prog(`prepNether: ★dug-in bunker ${sealedNow ? 'SEALED' : 'unsealed(无封顶料,坑里也比地表强)'} y=${Math.floor(bot.entity.position.y)}`);
                    }
                } catch (e) { prog(`prepNether: bunker err ${e.message}`); }
            }
            await skills.wait(bot, 6000);   // idle so self_preservation can dig in / hold the shelter
        }
        // ★黎明出坑警戒 (224: 夜里刷的苦力怕白天不烧,蹲坑口等开门,hp8出坑2.9格起爆):
        // dawn broke — before resuming work, peek for lingering creepers/mobs within 10;
        // wait them out in the hole (up to 60s, they wander off) instead of walking into one.
        if (!isNightNow() && !bot.interrupt_code) {
            for (let w = 0; w < 10; w++) {
                const lingering = hostilesNear(10);
                if (lingering === 0) break;
                if (w === 0) prog(`prepNether: ★dawn-exit hold — ${lingering} mob(s) lingering at the door, waiting them out`);
                await skills.wait(bot, 6000);
            }
        }
    };

    // Order matters: a weapon + body armour first (survival), then the rest of the
    // kit, then portal materials. obsidian last (it's the risky/uncertain one).
    const goals = [
        { item: 'shield', count: 1 },        // FIRST: a shield blocks skeleton arrows + melee — the
                                             // real counter to the "shot by Skeleton" deaths. Cheap
                                             // (6 planks + 1 iron) and self_defense's shieldFight uses it.
        { item: 'diamond_sword', count: 1 },
        { item: 'diamond_chestplate', count: 1 },
        { item: 'diamond_leggings', count: 1 },
        { item: 'diamond_helmet', count: 1 },
        { item: 'diamond_boots', count: 1 },
        { item: 'flint_and_steel', count: 1 },
        { item: 'obsidian', count: 10 }, // 10 = minimal nether portal frame
    ];

    prog(`==== prepNether START | inv diamonds=${has('diamond')} ====`);

    // ---- KILL-BOX EXPULSION (mirror of missionNether's — here because prepNether is
    // hot-reloaded every ~3s call, so this fires immediately without waiting for the
    // sticky missionNether to re-arm with new code). Deaths #259/261/263/266 all fell
    // into one cave-riddled ~30b death cluster; overseer writes its center to
    // advisory.json dzone. Inside it and not in melee → walk straight out first.
    try {
        const a = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'advisory.json'), 'utf8'));
        if (a && a.dzone && Date.now() - a.ts < 45000) {
            const z = a.dzone, p0 = bot.entity.position;
            const d0 = Math.hypot(p0.x - z.cx, p0.z - z.cz);
            const HOSZ = /zombie|skeleton|creeper|spider|witch|drowned|husk|stray|pillager|cave_spider/i;
            const inMelee = Object.values(bot.entities).some(e =>
                e && e.position && e.name && HOSZ.test(e.name) && e.position.distanceTo(p0) < 6);
            if (d0 < z.r && !inMelee) {
                if (p0.y < 55) {
                    // underground in the honeycomb core — vertical first (see missionNether)
                    prog(`★KILL-BOX(prep): underground in cluster (y=${Math.round(p0.y)}) → surfaceUp first`);
                    try { await skills.customSkill(bot, 'surfaceUp'); } catch (e) {}
                } else {
                    const ux = d0 > 0.5 ? (p0.x - z.cx) / d0 : 1, uz = d0 > 0.5 ? (p0.z - z.cz) / d0 : 0;
                    const tx = Math.round(z.cx + ux * (z.r + 16)), tz = Math.round(z.cz + uz * (z.r + 16));
                    prog(`★KILL-BOX(prep): ${Math.round(d0)}b inside death cluster @${z.cx},${z.cz}(${z.n}) → expelling to ${tx},${tz}`);
                    try { await skills.goToPosition(bot, tx, Math.round(p0.y), tz, 3); } catch (e) {}
                }
            }
        }
    } catch (e) {}

    // ---- DEATH RECOVERY (corpse run) ------------------------------------------------
    // On a (re)start triggered by death, rush back to where we died and reclaim the gear
    // we dropped before it despawns (~5 min). Without this, every death resets the grind
    // to naked (the Sisyphus loop in this hostile world). STRICTLY BOUNDED + INTERRUPTIBLE
    // by design: at most a few legs and a hard time cap; the death spot is consumed (file
    // deleted) on the FIRST attempt so a stale corpse is never retried; and it ABORTS the
    // instant a survival mode interrupts us (drowning / flee / new death) — so the recovery
    // can never become its own loop or death-trap.
    const DPOS = path.resolve(process.cwd(), 'bots', '_supervisor', 'death_pos.json');
    // Dropped-item detection. ONLY use e.name === 'item' — accessing the legacy
    // prismarine-entity getters e.objectType / e.entityType / e.displayName triggers a
    // deprecation path (printObjectTypeWarning) that THROWS and crashes the whole agent
    // subprocess (exit 1) → agent_process.js restarts it → ~15s offline → the bot dies in
    // the gap if night/mobs. That spurious-restart churn was the real "death cascade".
    const isItem = (e) => e && e.position && e.name === 'item';
    const isNight = () => { try { const t = bot.time.timeOfDay; return t >= 13000 && t <= 23000; } catch (e) { return false; } };
    const HOSTILE = /zombie|skeleton|creeper|spider|witch|enderman|drowned|husk|stray|phantom|slime|piglin|hoglin|silverfish|cave_spider|pillager|vindicator/i;
    const hostilesNear = (r = 12) => Object.values(bot.entities).filter(e => e && e.position && e.name && HOSTILE.test(e.name) && e.position.distanceTo(bot.entity.position) < r).length;
    const corpseRun = async () => {
        let d; try { d = JSON.parse(fs.readFileSync(DPOS, 'utf8')); } catch (e) { return; }
        if (!d || typeof d.x !== 'number') { try { fs.unlinkSync(DPOS); } catch (e) {} return; }
        const ageS = Math.round((Date.now() - (d.t || 0)) / 1000);
        if (ageS > 270) { try { fs.unlinkSync(DPOS); } catch (e) {} prog(`corpseRun: death ${ageS}s old — gear despawned, skip`); return; }
        if (bot.game && bot.game.dimension && !/overworld/.test(bot.game.dimension)) { try { fs.unlinkSync(DPOS); } catch (e) {} prog('corpseRun: not overworld, skip'); return; }
        // SAFETY GATE — do NOT walk a freshly-respawned (usually naked, no-armor, low-hp)
        // bot back toward its death spot through a night-time mob swarm: that just feeds
        // the death loop (the exact suicide-walk the supervised lock exists to stop). KEEP
        // the death file (don't consume) so a LATER prepNether re-arm can recover once it's
        // safe — daytime, no nearby hostiles, and not critically hurt. The age check above
        // retires the file naturally once the gear would have despawned anyway.
        // Walk back toward the death spot ONLY when it's clearly safe. A freshly-respawned
        // bot is usually naked/low-armor; sending it toward where mobs just killed it —
        // through ANY nearby swarm, day or night — just re-feeds the death cascade (it
        // killed us again at hp1 in daylight). So defer (keep the death file, retry later)
        // unless there are NO hostiles near us right now AND we're not hurt. The age check
        // retires the file once the gear would have despawned anyway.
        if (hostilesNear(16) > 0 || bot.health < 14) {
            prog(`corpseRun: UNSAFE (mobs=${hostilesNear(16)} hp=${Math.round(bot.health)} night=${isNight()}) — defer recovery, establish first`);
            return;
        }
        // 夜不捞尸 (the design note said "daytime only" but the code never gated it —
        // saw a night run toward a skeleton cave for a corpse holding 19 tuff): keep the
        // file, retry at dawn; the 270s age check writes off what expires. Life > loot.
        if (isNight()) {
            prog('corpseRun: night — defer to dawn (life > loot)');
            return;
        }
        // 垃圾尸体不出门 (one day, three junk runs: whole daytime rebuild windows spent
        // hiking for tuff, and the trip itself killed us twice). agent.js marks v=true
        // only for iron+ gear / diamonds / ingot stash; old files without v run as before.
        if (d.v === false) {
            try { fs.unlinkSync(DPOS); } catch (e) {}
            prog('corpseRun: JUNK corpse (no iron+/diamond gear) — skip the trip, re-gather locally');
            return;
        }
        // ★水葬不捞 (202→203 螺旋: 水中死→裸重生跳水捞装备→自己淹死→新水葬,90s一轮):
        // a corpse in/under water is a siren — the dive costs more than the gear. The
        // death record may carry inWater; otherwise probe the (loaded) death cell. Skip
        // AND consume so the siren never re-fires.
        let waterGrave = d.inWater === true;
        if (!waterGrave && Vec3) {
            try {
                const db = bot.blockAt(new Vec3(d.x, d.y, d.z));
                const db1 = bot.blockAt(new Vec3(d.x, d.y + 1, d.z));
                waterGrave = !!((db && /water/.test(db.name || '')) || (db1 && /water/.test(db1.name || '')));
            } catch (e) {}
        }
        if (waterGrave) {
            try { fs.unlinkSync(DPOS); } catch (e) {}
            prog('corpseRun: WATER GRAVE — skip the dive (不为装备淹死自己), gear written off');
            return;
        }
        try { fs.unlinkSync(DPOS); } catch (e) {}              // committing — consume so we never retry a stale corpse
        prog(`corpseRun: -> death @ ${d.x.toFixed(0)},${d.y.toFixed(0)},${d.z.toFixed(0)} age=${ageS}s`);
        const start = Date.now();
        const MAX_LEGS = 5, MAX_MS = 90000;
        const distToDeath = () => Math.hypot(bot.entity.position.x - d.x, bot.entity.position.y - d.y, bot.entity.position.z - d.z);
        for (let leg = 0; leg < MAX_LEGS && (Date.now() - start) < MAX_MS; leg++) {
            if (bot.interrupt_code) { prog('corpseRun: survival mode interrupted — abort'); break; }
            // 途中入夜即弃 (211: 白天出发差140tick入夜,半路天黑涉水被僵尸逮住 — 入口夜门
            // 拦不住旅途夜变): the entry gate checks dawn, the TRIP must too. Life > loot.
            if (isNight()) { prog('corpseRun: night fell MID-TRIP — abandon recovery (life > loot)'); break; }
            try { await skills.goToPosition(bot, d.x, d.y, d.z, 1); } catch (e) { prog(`corpseRun: goto err ${e.message}`); }
            if (bot.interrupt_code) { prog('corpseRun: interrupted after goto — abort'); break; }
            const items = Object.values(bot.entities).filter(e => isItem(e) && e.position.distanceTo(bot.entity.position) < 30);
            if (items.length) {
                // Walk over each dropped stack (mineflayer auto-collects on contact).
                for (const it of items.slice(0, 16)) {
                    if (bot.interrupt_code) break;
                    if ((Date.now() - start) >= MAX_MS) break;
                    try { await skills.goToPosition(bot, it.position.x, it.position.y, it.position.z, 0); } catch (e) {}
                    await skills.wait(bot, 250);
                }
                continue; // re-scan for any stragglers next leg
            }
            // No items in range. Distinguish "arrived, truly nothing here" from "couldn't
            // get there yet" (goto threw / was nudged by a mode) — only the former is done.
            const dist = distToDeath();
            if (dist <= 6) { prog(`corpseRun: arrived (dist=${dist.toFixed(1)}), no items — done`); break; }
            prog(`corpseRun: not arrived (dist=${dist.toFixed(0)}), retry leg ${leg + 1}`);
        }
        try { await equipArmor(); } catch (e) {}
        prog(`corpseRun: done | iron_pick=${has('iron_pickaxe')} sword=${has('diamond_sword') || has('iron_sword') || has('stone_sword')} shield=${has('shield')}`);
    };
    try { await corpseRun(); } catch (e) { prog(`corpseRun threw: ${e.message}`); }

    // ---- DEATH RECOVERY (bank withdraw) --------------------------------------------
    // Breaks the "die → respawn NAKED → die again" spiral when the corpse run fails (the
    // 5-min despawn usually beats us back). On a naked respawn we land at the world spawn
    // point (no bed in this no-sheep jungle), which is exactly where bankGear anchored the
    // bank chest. So: find the bank, withdraw a weapon + tools + armor + food, re-arm. This
    // is the symmetric WITHDRAW to bankGear's deposit. Fully guarded — any failure is logged
    // and swallowed so prepNether's normal grind continues.
    const BANKF = path.resolve(process.cwd(), 'bots', '_supervisor', 'bank.json');
    const BEDF_R = path.resolve(process.cwd(), 'bots', '_supervisor', 'bed.json');  // local: BEDF (below) is in TDZ here
    const SPAWNF_R = path.resolve(process.cwd(), 'bots', '_supervisor', 'spawn_pos.json');
    const validSpawn = (sp) => sp && typeof sp.x === 'number' && typeof sp.z === 'number' && !(sp.x === 0 && sp.z === 0);
    const haveSword = () => { const c = world.getInventoryCounts(bot); return Object.keys(c).some(n => /_sword$/.test(n) && c[n] > 0); };
    const haveAnyArmor = () => { const c = world.getInventoryCounts(bot); return Object.keys(c).some(n => /_(helmet|chestplate|leggings|boots)$/.test(n) && c[n] > 0); };
    const bankRecover = async () => {
        // 1) Locate the bank: bank.json → bed.json → world spawn. None → nothing to recover from.
        let bank = null, src = null;
        try { const b = JSON.parse(fs.readFileSync(BANKF, 'utf8')); if (typeof b.x === 'number') { bank = b; src = 'bank'; } } catch (e) {}
        if (!bank) { try { const b = JSON.parse(fs.readFileSync(BEDF_R, 'utf8')); if (typeof b.x === 'number') { bank = b; src = 'bed'; } } catch (e) {} }
        // spawn_pos.json = actual recorded respawn coord (agent.js). bot.spawnPoint is the
        // (0,0) sentinel on this LAN server, so prefer the measured respawn. No (0,0) filter.
        if (!bank) { try { const s = JSON.parse(fs.readFileSync(SPAWNF_R, 'utf8')); if (typeof s.x === 'number') { bank = { x: s.x, y: s.y, z: s.z }; src = 'respawn'; } } catch (e) {} }
        if (!bank && validSpawn(bot.spawnPoint)) { bank = { x: bot.spawnPoint.x, y: bot.spawnPoint.y, z: bot.spawnPoint.z }; src = 'spawn'; }
        // DIAGNOSTIC: log spawnPoint so progress.txt reveals if it's real or the (0,0) sentinel.
        try { const sp = bot.spawnPoint; prog(`bankRecover: bot.spawnPoint=${sp ? `${sp.x},${sp.y},${sp.z}` : 'null'} bankSrc=${src || 'none'}`); } catch (e) {}
        if (!bank) { prog('bankRecover: no bank/bed/spawn location — skip'); return; }
        // GHOST-BANK GUARD: a recorded bank coord can outlive the chest (never built /
        // blown up / built elsewhere). Death #267 aftermath: naked bot walked 40 blocks
        // of night to (96,64,-34), found NO chest, walked back — pure exposure for zero
        // loot, and it would repeat the trip EVERY respawn. After a "no chest" strike,
        // skip this bank location for an hour (file-persisted; hot-reload safe).
        const GHOSTF = path.resolve(process.cwd(), 'bots', '_supervisor', 'bank_ghost.json');
        try {
            const g = JSON.parse(fs.readFileSync(GHOSTF, 'utf8'));
            if (g && g.x === Math.round(bank.x) && g.z === Math.round(bank.z) && Date.now() - g.t < 3600000) {
                prog('bankRecover: bank marked ghost (no chest there recently) — skip the trip');
                return;
            }
        } catch (e) {}
        // 2) Only bother if we're under-armed (naked respawn). Kitted + safe → skip the detour.
        if (haveSword() && haveAnyArmor() && bot.health >= 14) { prog('bankRecover: already armed (sword+armor, hp ok) — skip'); return; }
        prog(`bankRecover: under-armed (sword=${haveSword()} armor=${haveAnyArmor()} hp=${Math.round(bot.health)}) — withdraw from bank(${src}) @ ${bank.x.toFixed(0)},${bank.y.toFixed(0)},${bank.z.toFixed(0)}`);
        // 3) Walk to the bank.
        try { await skills.goToPosition(bot, bank.x, bank.y, bank.z, 2); } catch (e) { prog(`bankRecover: goto err ${e.message}`); }
        if (bot.interrupt_code) { prog('bankRecover: interrupted en route — abort'); return; }
        // 4) Find the chest and open it.
        let chest = null;
        try { chest = bot.findBlock({ matching: b => b && b.name && b.name.includes('chest'), maxDistance: 6 }); } catch (e) {}
        if (!chest) { try { chest = bot.findBlock({ matching: b => b && b.name && b.name.includes('chest'), maxDistance: 12 }); } catch (e) {} }
        if (!chest) {
            prog('bankRecover: no chest within 12 of bank — marking ghost (skip for 1h)');
            try { fs.writeFileSync(GHOSTF, JSON.stringify({ x: Math.round(bank.x), z: Math.round(bank.z), t: Date.now() })); } catch (e) {}
            return;
        }
        let container = null;
        try { container = await bot.openContainer(chest); } catch (e) { prog(`bankRecover: open err ${e.message}`); return; }
        // 5) Withdraw: best of each gear class + some food. Symmetric to bankGear's deposit().
        const WANT = [
            { re: /_sword$/, n: 1, label: 'sword' },
            { re: /_pickaxe$/, n: 1, label: 'pickaxe' },
            { re: /^shield$/, n: 1, label: 'shield' },
            { re: /_helmet$/, n: 1, label: 'helmet' },
            { re: /_chestplate$/, n: 1, label: 'chestplate' },
            { re: /_leggings$/, n: 1, label: 'leggings' },
            { re: /_boots$/, n: 1, label: 'boots' },
            { re: /^(cooked_beef|cooked_porkchop|cooked_chicken|cooked_mutton|bread|cooked_cod|cooked_salmon|apple)$/, n: 8, label: 'food' },
            // ★环2: also pull MATERIALS so a low-tier respawn can immediately re-craft tools
            // (far better than naked 0-inventory). achieve() later turns these into gear.
            { re: /^cobblestone$/, n: 8, label: 'cobblestone' },
            { re: /_planks$/, n: 8, label: 'planks' },
            { re: /^coal$/, n: 4, label: 'coal' },
            { re: /^stick$/, n: 4, label: 'stick' },
            { re: /^iron_ingot$/, n: 64, label: 'iron_ingot' },  // take all available
            { re: /^raw_iron$/, n: 64, label: 'raw_iron' },      // take all available
        ];
        const took = [];
        try {
            for (const w of WANT) {
                if (bot.interrupt_code) break;
                const inChest = container.containerItems().filter(it => it && w.re.test(it.name));
                if (!inChest.length) continue;
                // Prefer the highest-tier item (netherite > diamond > iron > ...) by stack order.
                const tier = (nm) => nm.startsWith('netherite_') ? 4 : nm.startsWith('diamond_') ? 3 : nm.startsWith('iron_') ? 2 : nm.startsWith('golden_') ? 1 : 0;
                inChest.sort((a, b) => tier(b.name) - tier(a.name));
                let remaining = w.n;
                for (const it of inChest) {
                    if (remaining <= 0 || bot.interrupt_code) break;
                    const grab = Math.min(remaining, it.count);
                    try { await container.withdraw(it.type, null, grab); took.push(`${it.name}x${grab}`); remaining -= grab; } catch (e) { prog(`bankRecover: withdraw ${it.name} err ${e.message}`); }
                }
            }
        } catch (e) { prog(`bankRecover: withdraw loop err ${e.message}`); }
        try { await container.close(); } catch (e) {}
        // 6) Re-arm: equip the best weapon we now have, then armor.
        try { const c = world.getInventoryCounts(bot); const sword = Object.keys(c).find(n => /_sword$/.test(n) && c[n] > 0); if (sword) await skills.equip(bot, sword); } catch (e) {}
        try { await equipArmor(); } catch (e) {}
        prog(`bankRecover: took [${took.join(' ')}] — sword=${haveSword()} armor=${haveAnyArmor()}`);
        if (took.length) log(bot, `Recovered gear from bank: ${took.join(', ')}`);
    };
    try { await bankRecover(); } catch (e) { prog(`bankRecover threw: ${e.message}`); }

    // ---- SURVIVE FIRST: stock building blocks so the shelter reflex can actually build --
    // THE mechanical root of the death loop: a naked respawn carries ~0 blocks, so the
    // self_preservation bunker can neither dig DOWN (water floods at this water-edge spawn)
    // NOR pillar-box UP (needs ~7 blocks) → "Can't seal" → dies, over and over (cantSeal=19,
    // 24 deaths). Fix: the FIRST thing each life, punch a buffer of dirt (free, everywhere on
    // the surface, no tool needed) so the shelter reflexes always have material. "Survive
    // first, grind later" — the human move. Skip once we have enough.
    const buildBlocks = () => { const c = world.getInventoryCounts(bot); return (c.dirt || 0) + (c.cobblestone || 0) + (c.stone || 0) + (c.dirt_path || 0) + Object.keys(c).filter(n => /_planks$|_log$/.test(n)).reduce((s, n) => s + c[n], 0); };
    // NIGHT GATE: sticky re-arm re-enters prepNether every ~8s, and at night this
    // stocking step was DIGGING THE BOT OUT OF ITS OWN SEALED BUNKER to go find dirt
    // (alarm caught it punching its own cobblestone cap at 05:09). Block-stocking is
    // daytime work; at night the bunker IS the survival plan.
    if (buildBlocks() < 14 && !bot.interrupt_code && !isNightNow()) {
        prog(`prepNether: SURVIVE-FIRST — stocking shelter blocks (have ${buildBlocks()})`);
        try { await skills.collectBlock(bot, 'dirt', 18); } catch (e) { prog(`prepNether: stock blocks err ${e.message}`); }
        prog(`prepNether: shelter blocks now ${buildBlocks()}`);
    }

    // ---- ESTABLISH HOME (strategy layer; bed-centric) — TOP PRIORITY ----------------
    // ROOT fix for the night-swarm death loop (creeper→skeleton→zombie keep cycling as the
    // proximate killer because the real problem is being naked at a bad night respawn): a
    // BED relocates our respawn (1.21: right-click sets spawn, day or night) AND lets us
    // sleep through the night. Trying ONCE at startup failed — that lands on a night/unsafe
    // respawn and defers forever. So we keep trying in EVERY SAFE WINDOW during the grind:
    // a daytime lull near sheep actually plants the bed. No-op once home is set; defers fast
    // (cheap) when unsafe / no sheep. setBed self-bootstraps (hunt sheep→wool→craft→place→
    // set spawn). bankGear later anchors the home chest to this bed (家一体化).
    const BEDF = path.resolve(process.cwd(), 'bots', '_supervisor', 'bed.json');
    const homeSet = () => { try { return typeof JSON.parse(fs.readFileSync(BEDF, 'utf8')).x === 'number'; } catch (e) { return false; } };
    const tryHome = async () => {
        // ★家域饱和穿透 (homeSet()短路让搬家重评估永远跑不到): 锚40格内积8+死=家域沦陷,
        // 即使"家已建"也要重新调setBed(其第0步会评估并触发远环搬迁)。
        const homeSaturated = () => {
            try {
                const bj = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'bed.json'), 'utf8'));
                if (typeof bj.x !== 'number') return false;
                const dl = fs.readFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'death_log.jsonl'), 'utf8').trim().split('\n').slice(-60);
                let n = 0;
                for (const l of dl) { try { const r = JSON.parse(l); if (typeof r.x === 'number' && Math.hypot(r.x - bj.x, r.z - bj.z) < 40) n++; } catch (e) {} }
                return n >= 8;
            } catch (e) { return false; }
        };
        if ((homeSet() && !homeSaturated()) || bot.interrupt_code) return;
        if (bot.health < 10) return;                            // too hurt to do anything but survive
        // By DAY we run setBed even with spiders around — this jungle has no sheep, so setBed
        // bootstraps a bed from SPIDER STRING (4 string=1 wool, 2x2), and spiders ARE the
        // string source. setBed's own guards keep it safe (spider-hunt is day+calm gated).
        // Only at NIGHT-with-swarm do we defer (survive first). Fixes the old bug where any
        // hostile within 12 (incl. our string-source spiders) blocked the bed mission forever.
        const nightNow = (() => { try { const t = bot.time.timeOfDay; return t >= 12800 && t <= 23000; } catch (e) { return false; } })();
        if (nightNow && hostilesNear(12) > 0) return;
        prog('prepNether: window — establishing home (setBed)');
        try { await skills.customSkill(bot, 'setBed'); } catch (e) { prog(`prepNether: setBed threw ${e.message}`); }
    };
    await tryHome();

    // ---- ADAPTIVE WATER PREP (learn from fall deaths) -------------------------------
    // agent.js drops prep_water.json when we DIE to a fall. The MLG water-clutch reflex
    // (modes.js) needs a filled bucket as ammo — so once we can spare the iron (have an
    // iron pick / some iron / already a bucket), secure a water_bucket and keep it. Gated
    // so it never derails the early wood/stone grind (early falls are handled by the
    // pathfinder-flee that avoids ledges instead).
    const PWF = path.resolve(process.cwd(), 'bots', '_supervisor', 'prep_water.json');
    let wantWater = false; try { wantWater = !!JSON.parse(fs.readFileSync(PWF, 'utf8')).t; } catch (e) {}
    const canSpareIron = has('iron_pickaxe') > 0 || has('iron_ingot') >= 3 || has('bucket') > 0;
    if (wantWater && has('water_bucket') < 1 && canSpareIron && !bot.interrupt_code) {
        prog('prepNether: fall-death prep — securing a water bucket for MLG clutch');
        try { if (has('bucket') < 1) await skills.customSkill(bot, 'achieve', { item: 'bucket', count: 1 }); } catch (e) {}
        try {
            if (has('bucket') > 0) {
                const water = world.getNearestBlock(bot, 'water', 32);
                if (water) {
                    await skills.goToPosition(bot, water.position.x, water.position.y + 1, water.position.z, 1);
                    const emptyB = bot.inventory.items().find(i => i.name === 'bucket');
                    if (emptyB) { try { await bot.equip(emptyB, 'hand'); } catch (e) {} try { await bot.lookAt(water.position.offset(0.5, 0.5, 0.5), true); } catch (e) {} try { bot.activateItem(); } catch (e) {} }
                    prog(`prepNether: water_bucket=${has('water_bucket')}`);
                }
            }
        } catch (e) { prog(`prepNether: water prep err ${e.message}`); }
    }

    // KIT: keep torches stocked so the torch_placing mode can LIGHT the mines. Dark deep
    // caves spawn the zombies/creepers that swarmed and killed us during diamond mining (the
    // CONFIRMED deep-mining death cause — fall + cave-mob, not lava). We mine plenty of coal;
    // turn some into torches (achieve makes the sticks). Gated on already having coal so it
    // never derails the early grind. (Resource-management kit item — torches → no dark → no
    // cave-mob swarm → survive the diamond mine.)
    const stockTorches = async () => {
        if (bot.interrupt_code || has('torch') >= 12) return;
        if (has('coal') < 1 && has('charcoal') < 1) return;
        prog(`prepNether: KIT — stocking torches to light the mines (torch=${has('torch')} coal=${has('coal')})`);
        try { await skills.customSkill(bot, 'achieve', { item: 'torch', count: 16 }); } catch (e) { prog(`prepNether: torch err ${e.message}`); }
        prog(`prepNether: torches now ${has('torch')}`);
    };

    // ★饿不能扛 (#21 资源管理): food<18 = NO regen, so a long underground grind with no
    // food held turns every hit permanent — the proven "10HP no-food cave death" pattern.
    // Layer-① auto_eat already eats whatever we HOLD; the gap is ACQUISITION mid-grind:
    // hunting-mode only fires when idle (never under the supervised lock) and feedUp was
    // never called by this orchestrator. Policy: hold food >= a snack at all times; when
    // we're out AND truly hungry (≤6), surface and hunt — but only by day (feedUp itself
    // bails on night/hostiles, surfaceUp is the long climb we already know how to do).
    const FOOD_RE2 = /cooked_|_bread|^bread$|^apple$|golden_apple|carrot|potato|^beef$|porkchop|^chicken$|^mutton$|^cod$|^salmon$|melon_slice|sweet_berries|_stew|^rabbit$|baked_/;
    const keepFed = async () => {
        // 维持线必须≥18 (回血阈值): 旧值14让bot吃到14就停 — 永远差4点回不了血,
        // 全天挂着hp1-2的慢性病根(磕碰伤一辈子不愈合)。19留1点余量。
        if (bot.interrupt_code || bot.food >= 19) return;
        const f = bot.inventory.items().find(i => FOOD_RE2.test(i.name) && i.name !== 'rotten_flesh');
        if (f) { prog(`prepNether: KIT — eating ${f.name} (food=${bot.food})`); try { await skills.consume(bot, f.name); } catch (e) {} return; }
        if (bot.food > 6) return;                          // no food held but not desperate — press on
        if (isNightNow()) { prog(`prepNether: ★HUNGRY food=${bot.food}, no food held, night — defer hunt to dawn`); return; }
        prog(`prepNether: ★HUNGRY food=${bot.food}, no food held → surfacing to hunt (feedUp)`);
        try { if (bot.entity.position.y < 55) await skills.customSkill(bot, 'surfaceUp'); } catch (e) { prog(`prepNether: surfaceUp err ${e.message}`); }
        try { await skills.customSkill(bot, 'feedUp', 18); } catch (e) { prog(`prepNether: feedUp err ${e.message}`); }
        prog(`prepNether: hunt done — food=${bot.food} hp=${Math.round(bot.health)}`);
    };

    // ★人类式资源管理 (#21, 用户提出"想想人类玩家怎么做"): humans manage FUTURE consumption,
    // not current possession. The rules encoded here:
    //   1. 备用镐铁律 — a pickaxe is a CONSUMABLE (132 uses for stone tier). Always hold 2
    //      EFFECTIVE picks; a >85%-worn pick is not a pick (durability sense — replace it
    //      BEFORE it snaps mid-swing, cobble is free while mining).
    //   2. 木头是地下的硬通货 — sticks come only from wood and wood only from the surface.
    //      Hold a log/plank buffer at all times; top it up when CHEAP (surface, daytime),
    //      never discover it's gone when EXPENSIVE (deep, pick broken = run is dead — the
    //      exact #23 "surface to craft pickaxe" freeze).
    //   3. 家当自愈 — placed kit (furnace/crafting_table) gets left behind when flows are
    //      interrupted (用户实测: 熔炉熔完落在原地). Replacements from held cobble are nearly
    //      free; walking back never is.
    const PICK_RE = /_pickaxe$/;
    const effectivePicks = () => {
        // count picks with real life left; fall back to raw count if durability is unreadable
        try {
            let n = 0;
            for (const it of bot.inventory.items()) {
                if (!PICK_RE.test(it.name)) continue;
                const max = it.maxDurability || 0;
                const used = (typeof it.durabilityUsed === 'number') ? it.durabilityUsed : 0;
                if (!max || (used / max) < 0.85) n++;
            }
            return n;
        } catch (e) {
            const c = world.getInventoryCounts(bot);
            return ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'].reduce((s, n2) => s + (c[n2] || 0), 0);
        }
    };
    const keepKit = async () => {
        if (bot.interrupt_code) return;
        const c = () => world.getInventoryCounts(bot);
        const cnt = (n) => c()[n] || 0;
        const planksEq = () => Object.keys(c()).filter(k => k.endsWith('_planks')).reduce((s, k) => s + c()[k], 0)
            + Object.keys(c()).filter(k => k.endsWith('_log')).reduce((s, k) => s + c()[k], 0) * 4;
        const onSurface = bot.entity.position.y >= 55;
        // 1) spare picks (durability-aware). craftRecipe places our held table when needed.
        let guard = 0;
        while (effectivePicks() < 2 && cnt('cobblestone') >= 3 && (cnt('stick') >= 2 || planksEq() >= 2) && guard++ < 3) {
            prog(`prepNether: KIT — effective picks ${effectivePicks()}<2 → crafting spare stone_pickaxe`);
            try {
                if (cnt('stick') < 2) { try { await skills.customSkill(bot, 'achieve', { item: 'stick', count: 4 }); } catch (e) {} }
                await skills.craftRecipe(bot, 'stone_pickaxe', 1);
            } catch (e) { prog(`prepNether: spare pick err ${e.message}`); break; }
        }
        // 2) stick buffer (works underground while logs last — planks/sticks need no table)
        if (cnt('stick') < 4 && planksEq() >= 2) {
            try { await skills.customSkill(bot, 'achieve', { item: 'stick', count: 8 }); } catch (e) {}
        }
        // 3) wood buffer — top up ONLY where it's cheap: surface + daylight. 8 planks-worth
        //    covers a full expedition of pick/stick replacements.
        if (planksEq() < 8 && onSurface && !isNightNow()) {
            prog(`prepNether: KIT — wood buffer low (${planksEq()} planks-eq) → chopWood before descending`);
            try { await skills.customSkill(bot, 'chopWood', 3); } catch (e) { prog(`prepNether: wood buffer err ${e.message}`); }
        }
        // 4) placed-kit self-heal — 状态池版 (用户实拍怒斥满地工作台):
        //    a. 顺手收: 状态池里 10 格内的站点,背包又缺这类 → 收回+注销 (路过即清)
        //    b. 造新门控: 池里 24 格内已有登记站点就不再造新的 (achieve 的 placeTable 会走过去用)
        const stF2 = path.resolve(process.cwd(), 'bots', '_supervisor', 'stations.json');
        const stAll = (() => { try { const a = JSON.parse(fs.readFileSync(stF2, 'utf8')); return Array.isArray(a) ? a : []; } catch (e) { return []; } })();
        const stNear = (type, maxD) => { const me = bot.entity.position; let bd = maxD, bs = null; for (const s of stAll) { if (s.type !== type) continue; const dd = Math.hypot(s.x - me.x, s.y - me.y, s.z - me.z); if (dd < bd) { bd = dd; bs = s; } } return bs; };
        for (const ty of ['crafting_table', 'furnace']) {
            const near = stNear(ty, 8);
            // 无条件回收 (40min登记6台0回收的教训: 背包常备一张→"缺了才收"永远不触发,
            // 地上的台子只进池不出池). 路过8格内就收 — 同类堆叠不占格,台子回家才是家当。
            if (near && !bot.interrupt_code) {
                prog(`prepNether: KIT — 顺手收 ${ty} @${near.x},${near.y},${near.z}`);
                try { await skills.goToPosition(bot, near.x, near.y, near.z, 2); } catch (e) {}
                try { await skills.collectBlock(bot, ty, 1); } catch (e) {}
                try {
                    const still = bot.blockAt(new Vec3(near.x, near.y, near.z));
                    if (!still || still.name !== ty) fs.writeFileSync(stF2, JSON.stringify(stAll.filter(s => !(s.type === ty && s.x === near.x && s.y === near.y && s.z === near.z))));
                } catch (e) {}
            }
        }
        if (cnt('crafting_table') === 0 && !stNear('crafting_table', 24)) { try { await skills.customSkill(bot, 'achieve', { item: 'crafting_table', count: 1 }); } catch (e) {} }
        if (cnt('furnace') === 0 && cnt('cobblestone') >= 8 && !stNear('furnace', 24)) { try { await skills.customSkill(bot, 'achieve', { item: 'furnace', count: 1 }); } catch (e) {} }
        // 5) 桶生命周期 (用户: 自主规划何时造桶/何时顺手接水 — MLG 反射没弹药就是摆设):
        //    造桶: 铁器时代确立(有铁镐)且能匀出 3 锭 → 桶是常备 kit,不再只靠摔死后的创伤记忆。
        if (cnt('bucket') === 0 && cnt('water_bucket') === 0 && cnt('iron_pickaxe') > 0 && cnt('iron_ingot') >= 3) {
            prog('prepNether: KIT — iron tier secured → crafting bucket (MLG ammo)');
            try { await skills.customSkill(bot, 'achieve', { item: 'bucket', count: 1 }); } catch (e) {}
        }
        // 6) ★床不过夜 (痛: 辛苦做的床被收进背包,没等到安家窗口就随尸沉进峡谷): a bed in
        //    the BAG is a bed at RISK — re-anchor it NOW, every boundary, regardless of the
        //    day+calm gate (placing takes 2s; setBed handles place+activate+bed.json).
        try {
            const bedItem = bot.inventory.items().find(i => /_bed$/.test(i.name));
            if (bedItem) {
                prog(`prepNether: KIT — bed in bag (${bedItem.name}) → emergency re-anchor via setBed`);
                try { await skills.customSkill(bot, 'setBed'); } catch (e) { prog(`prepNether: re-anchor err ${e.message}`); }
            }
        } catch (e) {}
        //    接水: 空桶在手 + 12 格内有水 + 同层(不为接水下崖) + 白天 → 顺手接满。
        //    "要用时没水,不要时遍地是水" — 路过就接是人类的肌肉记忆。
        if (cnt('bucket') > 0 && cnt('water_bucket') === 0 && !isNightNow()) {
            try {
                const water = world.getNearestBlock(bot, 'water', 12);
                if (water && Math.abs(water.position.y - bot.entity.position.y) <= 4) {
                    prog('prepNether: KIT — 顺手接水 (filling MLG bucket)');
                    await skills.goToPosition(bot, water.position.x, water.position.y + 1, water.position.z, 1);
                    const emptyB = bot.inventory.items().find(i => i.name === 'bucket');
                    if (emptyB) { try { await bot.equip(emptyB, 'hand'); } catch (e) {} try { await bot.lookAt(water.position.offset(0.5, 0.5, 0.5), true); } catch (e) {} try { bot.activateItem(); } catch (e) {} }
                    prog(`prepNether: water_bucket=${cnt('water_bucket')}`);
                }
            } catch (e) {}
        }
    };

    // ★死亡不清零: once we've earned a KEY piece of gear (shield / diamond_sword), bank a
    // copy so a death doesn't reset us to naked (bankRecover withdraws it next life). Gated to
    // fire AT MOST ONCE per prepNether run (banked flag) — banking is a detour, so we don't
    // want it after every goal stalling the grind. bankGear self-guards (anchor/safe/has-spares).
    let banked = false;
    for (const g of goals) {
        await holeUpAtNight();   // work by day, hide by night — don't grind exposed in the dark
        await tryHome();   // keep planting the home bed in any safe window (no-op once set) — top priority
        await stockTorches();   // light the mines before deep diamond runs — kills the cave-mob swarm deaths
        await keepFed();   // food<18=no regen — eat held food / surface-hunt before the next dive
        await keepKit();   // 家当自愈: replace lost furnace/table/pickaxe from cobble stock
        let tries = 0;
        while (has(g.item) < g.count && tries++ < 3) {
            await holeUpAtNight();   // if night fell mid-goal, stop and hole up before continuing
            await tryHome();   // ALSO try the bed on every dawn-surfacing mid-goal — else a long
                               // stuck goal (deep naked trough) starves the bed mission, which
                               // only fired once per goal at the top. Self-gated → cheap no-op.
            await keepFed();   // and keep the hunger floor mid-goal too (a single achieve goal
                               // can grind underground for an hour — between-goal checks miss it)
            if (bot.interrupt_code) try { bot.interrupt_code = false; } catch (e) {}
            prog(`prepNether: need ${g.item} ${has(g.item)}/${g.count} (try ${tries})`);
            try { await skills.customSkill(bot, 'achieve', g); }
            catch (e) { prog(`prepNether: ${g.item} threw ${e.message}`); }
            if (has(g.item) < g.count) await skills.wait(bot, 3000);
        }
        if (/helmet|chestplate|leggings|boots/.test(g.item)) await equipArmor();
        prog(`prepNether: ${g.item} -> ${has(g.item)}/${g.count}`);
        // After a KEY piece lands (shield or the diamond sword), bank a copy once so death
        // doesn't wipe the investment. bankGear no-ops if there's nothing spare/no anchor/unsafe.
        if (!banked && /^(shield|diamond_sword)$/.test(g.item) && has(g.item) >= g.count && !bot.interrupt_code) {
            prog(`prepNether: key gear ${g.item} secured — banking a copy (death-proof)`);
            try { await skills.customSkill(bot, 'bankGear'); banked = true; } catch (e) { prog(`prepNether: bankGear threw ${e.message}`); }
        }
    }
    await equipArmor();
    const summary = goals.map(g => `${g.item}=${has(g.item)}`).join(' ');
    prog(`==== prepNether DONE | ${summary} ====`);
    log(bot, `prepNether done. ${summary}`);
    return goals.every(g => has(g.item) >= g.count);
}
