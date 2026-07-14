// Hot-reloadable REAL skill: the missing DUSK_GO_BED executor (2026-07-02 checkpoint #12:
// the kind used to dispatch prepNether, whose night decision-layer early-returns BY DESIGN
// — kernel counted the yield as failure, 3-struck it into 5-min cooldowns all night, and
// with a usable village bed 2.5 BLOCKS AWAY the bot kited zombies in the open instead.
// Sleeping skips the night entirely = doubled daylight windows, which the food chain is
// starving for). ★C331 note: bed-USE was designed as the go_to_bed_sleep instinct's job;
// this skill is the kernel-driven twin for when the kind is committed — the instinct's
// test yields to a committed DUSK_GO_BED (modes.js) so the two never double-handle.
//
// Return contract: truthy {slept:true} after a confirmed sleep (or already-day wake);
// truthy {placed:true,slept:false} when this run PLACED a pack bed (real world delta —
// zero-progress false would mis-strike it; next run with no delta returns honest false);
// false when it genuinely cannot act (no bed known/found/carried, unreachable, hostiles
// block vanilla sleep, sleep throws) so the kernel's 3-strike cooldown falls through to
// the NIGHT_DIG_ONE/NIGHT_SEAL shelter fallbacks. No module-level state.
// Invoked via: {"skill":"goBedSleep"}  ctx = { skills, world, mc, Vec3, log }
import fs from 'fs';
import path from 'path';
const PROG = path.resolve(process.cwd(), 'bots', '_supervisor', 'progress.txt');

export default async function goBedSleep(bot, ctx) {
    const { skills, world, Vec3 } = ctx;
    // ctx.log only appends to bot.output, which NOTHING flushes on the kernel dispatch path —
    // checkpoint #13 postmortem: this skill 3-struck twice with literally zero visible lines
    // (looked like a silent bail; was actually diagnostics falling into the void). Write to
    // progress.txt like every other supervisor skill, and keep bot.output as a bonus.
    const log = (b, m) => {
        try { ctx.log(b, m); } catch (e) {}
        try { fs.appendFileSync(PROG, `[${new Date().toISOString()}] ${m}\n`); } catch (e) {}
    };
    try {
        const p = bot.entity.position;
        log(bot, `goBedSleep: START pos=${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)} food=${bot.food} hp=${Math.round(bot.health)}`);
    } catch (e) {}
    const isNightish = () => { try { const t = bot.time.timeOfDay; return t >= 12000 && t <= 23458; } catch (e) { return false; } };
    // ★vanilla 对齐 (P0-2 取证任务 d): 原 hostileNear(9) 以 BOT 为中心 9 格球形, 双重偏严 —
    // vanilla 拒睡判定是以床为中心的盒形 ~8 水平 / 5 垂直 ("monsters nearby")。山坡上 8.5b 外
    // 高处的骷髅会被旧门挡下、vanilla 却允许睡。改为床心盒形, 判不过再由 bot.sleep 的
    // 服务器端真拒绝兜底 (catch 里诚实 false)。
    const hostileNearBed = (bedPos) => {
        try {
            return Object.values(bot.entities || {}).some(e => {
                if (!e || e === bot.entity || !e.position || !ctx.mc.isHostile(e)) return false;
                const dx = Math.abs(e.position.x - (bedPos.x + 0.5));
                const dy = Math.abs(e.position.y - bedPos.y);
                const dz = Math.abs(e.position.z - (bedPos.z + 0.5));
                return dx <= 8 && dz <= 8 && dy <= 5;
            });
        } catch (e) { return false; }
    };
    // ★夜链自愈 (P0-2 取证 2026-07-04: 07-03T11:22 最后一张床被拆 → bed landmark 归零 →
    // bedAffordable 恒假 → DUSK_GO_BED 此后 0 提案, goBedSleep 整整一夜再未被派发)。
    // 睡成/就地放床后立即把 bed landmark 登记回 bot._landmarks(+落盘), 不等 C328 12s 扫描 —
    // 下一个黄昏 computeNightPlan 直接看到床, 夜链闭环。
    const regBedLandmark = (pos) => {
        try {
            if (!bot._landmarks || typeof bot._landmarks !== 'object') return;
            const key = `bed@${pos.x},${pos.y},${pos.z}`;
            const _n = Date.now();
            if (!bot._landmarks[key]) bot._landmarks[key] = { kind: 'bed', x: pos.x, y: pos.y, z: pos.z, ts: _n, seen: _n, meta: null };
            else bot._landmarks[key].seen = _n;
            fs.writeFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'landmarks.json'), JSON.stringify(bot._landmarks));
            log(bot, `goBedSleep: bed landmark 登记 @${key} — DUSK_GO_BED 下个黄昏直接可提案.`);
        } catch (e) {}
    };
    // ★就地放床 (P0-2 候选缺陷 b): 找不到床但背包里有床 → 2x1 平地就地放下再睡, 而不是
    // false 冷却把整夜交给 nightShelter 空转。几何与 setBed.placeBed 同款 (脚/头两格支撑
    // 实心+本体可清空)。
    const placeBedHere = async () => {
        let it = null;
        try { it = (bot.inventory.items() || []).find(i => /_bed$/.test(i.name || '')); } catch (e) {}
        if (!it) return null;
        const base = bot.entity.position.floored();
        const solid = (b) => b && b.boundingBox === 'block';
        // 只认真正可替换的覆盖物: includes('grass'/'snow') 会把实心 grass_block/snow_block 当空位 → 挖坑埋床
        const openish = (b) => b && (b.name === 'air' || b.name === 'cave_air' || /^(short_grass|tall_grass|grass|fern|snow)$/.test(b.name || ''));
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            if (bot.interrupt_code || bot.health <= 0) return null;
            const foot = base.offset(dx, 0, dz), head = base.offset(dx * 2, 0, dz * 2);
            if (!solid(bot.blockAt(foot.offset(0, -1, 0))) || !solid(bot.blockAt(head.offset(0, -1, 0)))) continue;
            if (!openish(bot.blockAt(foot)) || !openish(bot.blockAt(head))) continue;
            try {
                for (const cell of [foot, head]) { const b = bot.blockAt(cell); if (b && b.name !== 'air' && b.name !== 'cave_air') { try { await bot.dig(b); } catch (e) {} } }
                await skills.placeBlock(bot, it.name, foot.x, foot.y, foot.z, 'bottom', true);
            } catch (e) { continue; }
            const _pbd = await world.getNearestBlocksWhereAsync(bot, (b) => b && /_bed$/.test(b.name || ''), 4, 1);
            const placedB = (_pbd && _pbd.length) ? _pbd[0] : null;
            if (placedB) { log(bot, `goBedSleep: 背包床就地放置 @${placedB.position.x},${placedB.position.y},${placedB.position.z} — 不再 false 交给 nightShelter.`); regBedLandmark(placedB.position); return placedB; }
        }
        return null;
    };

    if (!isNightish()) return { slept: false, day: true };   // night already over — commitment releases at day

    // 1) Locate a bed: world-model landmark first (survives chunk unload), then a live scan.
    let placedThisRun = false;   // 本次是否就地放了床 (放床=真实进度, bail 时不按零进度 false 计 strike)
    const bail = (msg) => { log(bot, msg + (placedThisRun ? ' (但本次已放床+登记 landmark = 有进度, 返 truthy)' : '')); return placedThisRun ? { placed: true, slept: false } : false; };
    let tgt = null;
    try { const lm = bot._world && bot._world.landmarks; if (lm && lm.bed && Number.isFinite(lm.bed.x)) tgt = lm.bed; } catch (e) {}
    const _bb0 = await world.getNearestBlocksWhereAsync(bot, (b) => b && /_bed$/.test(b.name || ''), 64, 1);   // ★B定点8→64(0714): 睡觉实时搜床(与goToBed一致); landmark记忆坐标仍先goToPosition过去
    let bedBlock = (_bb0 && _bb0.length) ? _bb0[0] : null;
    if (!bedBlock && tgt) {
        // Walk toward the landmark (bounded — a bed 2.5b away was being ignored all night;
        // one long-ish walk is still cheaper than a night of kiting).
        try { await skills.goToPosition(bot, tgt.x, tgt.y, tgt.z, 2); } catch (e) {}
        // Checkpoint #13: these bails were SILENT — 3 strikes in 16s with zero log lines while
        // self_preservation kept interrupting the walk. Say so; the kernel's interrupt-unwind
        // settle (not a strike) is what keeps this from cooling the kind down.
        if (bot.interrupt_code || bot.health <= 0) { log(bot, `goBedSleep: ${bot.health <= 0 ? 'died' : 'reflex interrupt'} mid-walk to bed landmark — yielding.`); return false; }
        const _bb1 = await world.getNearestBlocksWhereAsync(bot, (b) => b && /_bed$/.test(b.name || ''), 8, 1);
        bedBlock = (_bb1 && _bb1.length) ? _bb1[0] : null;
    }
    if (!bedBlock) {
        // ★stale-landmark hygiene (2026-07-02 12:52Z live: bot STANDING at the remembered bed
        // spot, chunks loaded, no bed within 8b — creeper'd village bed. bed landmarks are
        // "persistent kind" with no freshness check, so the ghost re-selected GO_BED every
        // dusk → 3 strikes + 5-min cooldown, forever). An on-site disproof is the strongest
        // negative evidence there is: drop the landmark; the C328 scan re-adds it the moment
        // a real bed is actually seen.
        try {
            const me = bot.entity.position;
            if (tgt && Math.hypot(tgt.x - me.x, tgt.y - me.y, tgt.z - me.z) <= 10 && bot._landmarks) {
                let dropped = 0;
                for (const k of Object.keys(bot._landmarks)) {
                    const n = bot._landmarks[k];
                    if (n && n.kind === 'bed' && Math.hypot(n.x - tgt.x, n.y - tgt.y, n.z - tgt.z) <= 8) { delete bot._landmarks[k]; dropped++; }
                }
                if (dropped) {
                    try { fs.writeFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'landmarks.json'), JSON.stringify(bot._landmarks)); } catch (e) {}
                    log(bot, `goBedSleep: on-site disproof — dropped ${dropped} ghost bed landmark(s) near ${Math.round(tgt.x)},${Math.round(tgt.z)}; GO_BED yields until a real bed is seen.`);
                }
            }
        } catch (e) {}
        // 候选缺陷 b 修复: 世界里没床 ≠ 没办法睡 — 背包里若有床, 就地放床继续走睡眠链。
        bedBlock = await placeBedHere();
        if (!bedBlock) {
            log(bot, 'goBedSleep: no bed within reach (landmark stale or none) and none in pack — false, shelter chain takes over.');
            return false;
        }
        // 契约注: 本次运行已真实改变世界 (放床+landmark) — 后续即使被敌对/拒睡挡下, 也不能
        // 按"零进度 false"记 strike; bail 返回 {placed:true} truthy, 下一轮零变化再诚实 false。
        placedThisRun = true;
    }

    // ★P0-3(不睡觉根因): 先判 vanilla 拒睡盒(床 8h/5v 内有怪)再寻路。否则 approach 途中被 self_defense
    //   中断, 函数在 145/149 就 return false 记一次"床不可达"假失败, 永远走不到下面 181 的敌对判定 →
    //   床 3b 也睡不成 (用户实拍"不睡觉")。床区有怪时诚实让位(交 FIGHT/挖三填一), 不做注定被打断的
    //   doomed approach。181 行原检查保留做 sleep 前二次兜底(等待期间怪靠近)。
    if (hostileNearBed(bedBlock.position))
        return bail('goBedSleep: hostiles within vanilla bed box (8h/5v) before approach — yield (fight/shelter first).');

    // 2) Close to interaction range.
    if (bot.entity.position.distanceTo(bedBlock.position) > 2.6) {
        try { await skills.goToPosition(bot, bedBlock.position.x, bedBlock.position.y, bedBlock.position.z, 2); } catch (e) {}
        if (bot.interrupt_code || bot.health <= 0) { log(bot, `goBedSleep: ${bot.health <= 0 ? 'died' : 'reflex interrupt'} mid-approach to bed — yielding.`); return false; }
    }
    if (bot.entity.position.distanceTo(bedBlock.position) > 3.2) {
        // 走 bail(): 若本次已就地放床, 这是真实世界增量, 不能按零进度 false 记 strike
        return bail('goBedSleep: bed unreachable (pathing stopped short).');
    }

    // 2.5) ★床区布灯 (2026-07-05 用户令1: 床附近放火把保夜间安全睡眠 — 压出怪率,
    //      让 vanilla 8h/5v 拒睡不再被刷新怪触发)。6b 内无火把且包里有 → 绕床 4 向各试放
    //      1 支 (地面实心+目标格空气, 有界)。失败静默 — 布灯是增益不是前置。
    if (!bot.interrupt_code) {
        try {
            const hasTorchNear = !!bot.findBlock({ matching: (b) => b && /^(torch|wall_torch)$/.test(b.name || ''), maxDistance: 6 });
            const torchItem = bot.inventory.items().find(i => i.name === 'torch');
            if (!hasTorchNear && torchItem) {
                const bp = bedBlock.position;
                let placedT = 0;
                for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
                    if (placedT >= 4 || bot.interrupt_code || bot.health <= 0) break;
                    const gx = bp.x + dx, gz = bp.z + dz;
                    for (let dy = 1; dy >= -1; dy--) {
                        const ground = bot.blockAt(new Vec3(gx, bp.y + dy - 1, gz));
                        const cell = bot.blockAt(new Vec3(gx, bp.y + dy, gz));
                        if (ground && ground.boundingBox === 'block' && cell && (cell.name === 'air' || cell.name === 'cave_air')) {
                            try { await skills.placeBlock(bot, 'torch', gx, bp.y + dy, gz, 'bottom', false); placedT++; } catch (e) {}
                            break;
                        }
                    }
                }
                if (placedT) log(bot, `goBedSleep: 床区布灯 ×${placedT} (用户令: 夜安全睡眠)`);
            }
        } catch (e) {}
    }

    // 3) Vanilla blocks sleep with hostiles within ~8h/5v OF THE BED — don't burn the attempt
    //    (and the kernel strike) on a guaranteed 'monsters nearby'; report honestly instead.
    if (hostileNearBed(bedBlock.position)) return bail('goBedSleep: hostiles within vanilla bed box (8h/5v) — sleep would be refused; yield (fight/shelter first).');

    // 4) Sleep, then hold until day (bot.wake fires automatically at dawn; poll cheaply).
    try {
        await bot.sleep(bedBlock);
    } catch (e) {
        const msg = String(e && e.message || e);
        // ★dusk-sliver wait (2026-07-03 10:22Z live: the WHOLE chain worked — found the bed,
        // walked to it, called sleep — and vanilla refused with 'it's not night' because the
        // dispatch fired in the tod 12000-12542 dusk sliver where goBedSleep proposes but
        // sleep isn't allowed yet. Arriving EARLY at the bed is the best possible state;
        // wait it out (~27s real time) instead of burning a strike.)
        if (/not night/i.test(msg)) {
            log(bot, 'goBedSleep: arrived early (dusk sliver) — waiting at the bed for nightfall.');
            const tw = Date.now();
            let slept = false;
            while (Date.now() - tw < 75000) {
                if (bot.interrupt_code || bot.health <= 0) { log(bot, 'goBedSleep: interrupted while waiting for nightfall — yielding.'); return false; }
                if (hostileNearBed(bedBlock.position)) return bail('goBedSleep: hostiles closed in on the bed box while waiting — yield (fight/shelter first).');
                await skills.wait(bot, 2000);
                try { await bot.sleep(bedBlock); slept = true; break; } catch (e2) {
                    const m2 = String(e2 && e2.message || e2);
                    if (!/not night/i.test(m2)) return bail(`goBedSleep: sleep refused while waiting (${m2}) — yield.`);
                }
            }
            if (!slept) return bail('goBedSleep: night never arrived within 75s — yield.');
        } else {
            return bail(`goBedSleep: sleep refused (${msg}) — yield.`);
        }
    }
    log(bot, 'goBedSleep: sleeping — skipping the night.');
    const t0 = Date.now();
    while (bot.isSleeping && Date.now() - t0 < 60000) {
        if (bot.health <= 0) return false;
        await skills.wait(bot, 1000);
    }
    // ★睡成即锚定 (幻影家收敛): vanilla 睡觉本身就把重生点设到这张床 → bed.json 此刻写的是
    // 已验证的真实床位 ({x,y,z,t} 无 src 字段 = world_model.bedKnown 认可的"真床"格式)。
    // 顺手把 landmark 补登记, 07-03T11:22 那种"床没了 landmark 也没了"的断链下个黄昏不再发生。
    try {
        fs.writeFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'bed.json'),
            JSON.stringify({ x: bedBlock.position.x, y: bedBlock.position.y, z: bedBlock.position.z, t: Date.now() }));
        log(bot, `goBedSleep: slept OK — bed.json 锚定到真实床 @${bedBlock.position.x},${bedBlock.position.y},${bedBlock.position.z}.`);
    } catch (e) {}
    regBedLandmark(bedBlock.position);
    return { slept: true };
}
