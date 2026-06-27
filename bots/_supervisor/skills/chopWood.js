// Hot-reloadable REAL skill: gather logs robustly, even in awkward terrain
// (jungle/hills) where the default collectBlocks keeps failing pathfinding.
// Strategy: unstick to open ground first, then repeatedly find the nearest
// reachable log of ANY tree type and collect one at a time, re-positioning
// when a target can't be reached. No cheats. Invoked via:
//   !newAction("await skills.customSkill(bot, 'chopWood', 8)")
// ctx = { skills, world, mc, Vec3, log }
import fs from 'fs';
import path from 'path';
const _CHOP_PROG = path.resolve(process.cwd(), 'bots', '_supervisor', 'progress.txt');
const _MINE_MOTION = path.resolve(process.cwd(), 'bots', '_supervisor', 'mine_motion.jsonl');
const _dbg = (s) => { try { fs.appendFileSync(_CHOP_PROG, `[${new Date().toISOString()}] [chopDBG] ${s}\n`); } catch (e) {} };
// ★UNREACHABLE-TREE BLACKLIST (module-level → survives the achieve-loop's repeated re-ENTER of
// chopWood within one process). Root cause of a ~40min bootstrap deadlock: 40-block scan finds ONE
// lone log (e.g. oak_log@8.3b across water / on a ledge) that the pathfinder can NEVER reach;
// world.getNearestBlock keeps returning that SAME tree, collectBlock fails (total never rises),
// moveAway 12-32b can't escape it (still the only tree in range) → chopWood returns 0 logs →
// achieve re-enters "chop for planks" forever. Fix: on a failed collect, blacklist that tree's
// coords; skip blacklisted trees when picking the target so we fall through to the NEXT-nearest
// tree, or (if it was the only one) to the moveAway-relocate path that escapes the barren zone.
// Entries expire (terrain doesn't change, but a transient fail — e.g. a creeper interrupt — should
// be retryable later) so we never permanently abandon a tree that was only briefly unreachable.
const _unreach = new Map();   // "x,y,z" -> expiry ms
const _colFails = new Map();  // "x,z" 树柱 -> 累计失败次数 (惯犯计罪单位=树,不是单块原木)
const _colBlock = new Map();  // "x,z" 树柱 -> 整树拉黑过期 ms
const _UNREACH_TTL = 120000;  // 2 min (首犯)
// ★惯犯树重刑v2 (v1按单块计数的机理漏洞: 一棵树十几块原木,bot轮着试每块都算"初犯"
// 120s,树永远凑不满惯犯 — 实测同一棵山顶树刷了一小时): 计罪单位=树柱(x,z)。同柱
// 失败≥2次 → 整树拉黑10分钟,给绕路/换林子留出真正的时间窗。
const _colKey = (k) => { const p = k.split(','); return p[0] + ',' + p[2]; };
const _ttlFor = (k) => {
    const ck = _colKey(k);
    const n = (_colFails.get(ck) || 0) + 1;
    _colFails.set(ck, n);
    if (n >= 2) { _colBlock.set(ck, Date.now() + 600000); return 600000; }
    return _UNREACH_TTL;
};
const _blk = (k) => {
    const ce = _colBlock.get(_colKey(k));
    if (ce && ce > Date.now()) return true;            // 整树在服刑
    const e = _unreach.get(k);
    if (e && e > Date.now()) return true;
    if (e) _unreach.delete(k);
    return false;
};
export default async function chopWood(bot, ctx, count = 8, opts = {}) {
    const { skills, world, log, Vec3, mc } = ctx;
    // ★跨热加载持久化 (实锤: customSkill每次调用重新import本模块,模块级Map全清零 —
    // 拉黑/树柱计罪从来没跨调用存活过,同一棵树每次调用都重新当"初犯"): 状态挂bot对象。
    const _unreach = (bot._chopUnreach = bot._chopUnreach || new Map());
    const _colFails = (bot._chopColFails = bot._chopColFails || new Map());
    const _colBlock = (bot._chopColBlock = bot._chopColBlock || new Map());
    const _ttlFor = (k) => {
        const ck = _colKey(k);
        const n = (_colFails.get(ck) || 0) + 1;
        _colFails.set(ck, n);
        if (n >= 2) { _colBlock.set(ck, Date.now() + 600000); return 600000; }
        return _UNREACH_TTL;
    };
    const _blk = (k) => {
        const ce = _colBlock.get(_colKey(k));
        if (ce && ce > Date.now()) return true;
        const e = _unreach.get(k);
        if (e && e > Date.now()) return true;
        if (e) _unreach.delete(k);
        return false;
    };
    _dbg(`ENTER count=${count} y=${Math.floor(bot.entity.position.y)} pos=${Math.floor(bot.entity.position.x)},${Math.floor(bot.entity.position.z)}`);
    const LOGS = ['jungle_log', 'oak_log', 'birch_log', 'spruce_log',
                  'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'];
    const total = () => LOGS.reduce((s, t) => s + (world.getInventoryCounts(bot)[t] || 0), 0);
    const _opts = opts && typeof opts === 'object' ? opts : {};
    const _planksEq = () => {
        const c = world.getInventoryCounts(bot);
        return Object.keys(c).filter(k => /_planks$/.test(k)).reduce((s, k) => s + (c[k] || 0), 0)
            + LOGS.reduce((s, k) => s + (c[k] || 0), 0) * 4;
    };
    const _foodHeld = () => bot.inventory.items().some(i => /beef|porkchop|chicken|mutton|rabbit|cod|salmon|bread|apple|berries|potato|carrot|melon|cookie|pumpkin_pie|beetroot|mushroom_stew|rabbit_stew|suspicious_stew/i.test(i.name || '') && i.name !== 'rotten_flesh');
    const _hostileNear = (r = 16) => {
        try {
            return Object.values(bot.entities).some(e => e && e.position && mc && mc.isHostile && mc.isHostile(e) && e.position.distanceTo(bot.entity.position) < r);
        } catch (e) { return true; }
    };
    const _criticalForageAllowed = () => {
        const t = bot.time.timeOfDay;
        return !!_opts.allowCriticalForage
            && (bot.health > 4 || (_opts.criticalForageLocalOnly && bot.health >= 4))
            && bot.food <= 2
            && !_foodHeld()
            && !(t >= 13000 && t <= 23000)
            && !_hostileNear(16);
    };
    const _needsFoodYield = () => bot.food <= 8 && !_foodHeld() && !_criticalForageAllowed();
    const _lowHpHostileYield = () => bot.health <= 14 && _hostileNear(12) && !_criticalForageAllowed();
    const _motion = (event, data = {}) => {
        try {
            const p = bot.entity.position;
            const fp = p.floored();
            const blk = (pos) => {
                const b = bot.blockAt(pos);
                return b ? { name: b.name, bb: b.boundingBox, pos: { x: b.position.x, y: b.position.y, z: b.position.z } } : null;
            };
            const env = [];
            for (const dy of [-1, 0, 1, 2]) {
                for (const dz of [-1, 0, 1]) {
                    for (const dx of [-1, 0, 1]) {
                        const b = bot.blockAt(fp.offset(dx, dy, dz));
                        env.push({ d: [dx, dy, dz], n: b ? b.name : 'unknown', bb: b ? b.boundingBox : '?' });
                    }
                }
            }
            fs.appendFileSync(_MINE_MOTION, JSON.stringify({
                ts: new Date().toISOString(),
                event,
                pos: { x: Number(p.x.toFixed(3)), y: Number(p.y.toFixed(3)), z: Number(p.z.toFixed(3)) },
                cell: { x: fp.x, y: fp.y, z: fp.z },
                held: bot.heldItem ? bot.heldItem.name : 'empty',
                hp: Math.round(bot.health || 0),
                food: bot.food,
                foot: blk(p),
                head: blk(p.offset(0, 1, 0)),
                above: blk(p.offset(0, 2, 0)),
                env,
                data,
            }) + '\n');
        } catch (e) {}
    };
    const _placeConfirmed = async (blockName, target, label) => {
        _motion('chopWood.place.begin', { label, blockName, target: { x: target.x, y: target.y, z: target.z } });
        const ok = await skills.placeBlock(bot, blockName, target.x, target.y, target.z, 'bottom', true).catch(e => {
            _dbg(`${label} place ERR(${target.x},${target.y},${target.z}): ${String(e.message).slice(0, 70)}`);
            return false;
        });
        const placed = bot.blockAt(target);
        const confirmed = !!ok && placed && placed.boundingBox === 'block';
        _motion('chopWood.place.end', { label, ok: !!ok, confirmed, placed: placed ? placed.name : null, target: { x: target.x, y: target.y, z: target.z } });
        return confirmed;
    };
    const STONY_BLOCK = /stone|deepslate|andesite|diorite|granite|tuff|_ore$|obsidian|cobble/;
    const hasPick = () => bot.inventory.items().some(it => /_pickaxe$/.test(it.name));
    const heldIsPick = () => !!(bot.heldItem && /_pickaxe$/.test(bot.heldItem.name));
    const plannedNoPickStone = () => Date.now() < (bot._plannedNoPickStoneUntil || 0);
    const ensurePickForStone = async (block, why = '') => {
        if (!block || !STONY_BLOCK.test(block.name || '')) return true;
        if (!hasPick()) return plannedNoPickStone();
        if (heldIsPick()) return true;
        const pick = bot.inventory.items().find(it => /_pickaxe$/.test(it.name));
        try { if (pick) await bot.equip(pick, 'hand'); } catch (e) {}
        await new Promise(r => setTimeout(r, 80));
        if (heldIsPick()) return true;
        try { await bot.tool.equipForBlock(block); } catch (e) {}
        await new Promise(r => setTimeout(r, 80));
        if (heldIsPick()) return true;
        _dbg(`stone dig blocked: no pick actually held for ${block.name}${why ? ' ' + why : ''} held=${bot.heldItem ? bot.heldItem.name : 'empty'}`);
        return false;
    };
    const guardedDig = async (block, why = '') => {
        if (!block) return false;
        // ★C339 (T-0064): no x-ray TRUNK reach. Don't chop a LOG/WOOD block we can NEITHER stand next
        // to NOR see — that's reaching THROUGH leaf canopy to a trunk a human couldn't (the tree analog
        // of the mining x-ray guard, skills.js:815 / branchMine canSeeBlock). Only gates LOGS: leaf /
        // dirt / navigation digs are NOT logs → unaffected, so the legit human way (clear the
        // intervening leaves to open a path/sightline, THEN chop) still works. Adjacent logs (≤2.2b,
        // genuinely reachable) pass even if canSeeBlock flickers; only distant+occluded logs are skipped.
        if (/_log$|_wood$/.test(block.name || '')) {
            try {
                const d = bot.entity.position.offset(0, 1.6, 0).distanceTo(block.position.offset(0.5, 0.5, 0.5));
                const see = (() => { try { return bot.canSeeBlock(block); } catch (e) { return true; } })();
                if (d > 2.2 && !see) {
                    _motion('dig.xray_skip', { target: `${block.name}@${block.position.x},${block.position.y},${block.position.z}`, dist: +d.toFixed(1), why });
                    return false;
                }
            } catch (e) {}
        }
        const owner = `chopWood:${why || 'dig'}`;
        const acquire = async () => {
            const t0 = Date.now();
            while (Date.now() - t0 < 900) {
                const busy = bot.targetDigBlock || (bot._bodyDigLockUntil && Date.now() < bot._bodyDigLockUntil);
                if (!busy || bot._bodyDigLockOwner === owner) {
                    bot._bodyDigLockOwner = owner;
                    bot._bodyDigLockUntil = Date.now() + 6000;
                    return true;
                }
                await new Promise(r => setTimeout(r, 80));
            }
            _motion('dig.slot.busy', { owner, target: `${block.name}@${block.position.x},${block.position.y},${block.position.z}`, heldBy: bot._bodyDigLockOwner || 'targetDigBlock' });
            return false;
        };
        if (!(await acquire())) return false;
        try {
            for (let n = 0; n < 2; n++) {
                const fresh = bot.blockAt(block.position);
                if (!fresh || fresh.boundingBox !== 'block') return true;
                if (!(await ensurePickForStone(fresh, why))) return false;
                if (!STONY_BLOCK.test(fresh.name || '')) { try { await bot.tool.equipForBlock(fresh); } catch (e) {} }
                try { bot.clearControlStates(); } catch (e) {}
                try { await bot.lookAt(fresh.position.offset(0.5, 0.5, 0.5), true); } catch (e) {}
                try {
                    await Promise.race([
                        bot.dig(fresh, true),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('dig-timeout')), 5000)),
                    ]);
                    return true;
                } catch (e) {
                    try { bot.stopDigging(); } catch (_) {}
                    _motion('dig.retry', {
                        owner,
                        attempt: n,
                        target: `${fresh.name}@${fresh.position.x},${fresh.position.y},${fresh.position.z}`,
                        error: e && e.message ? e.message : String(e),
                    });
                    await new Promise(r => setTimeout(r, 140));
                }
            }
            return false;
        } finally {
            if (bot._bodyDigLockOwner === owner) {
                bot._bodyDigLockOwner = null;
                bot._bodyDigLockUntil = 0;
            }
        }
    };

    // Equip an axe if we have one (faster, still works barehanded).
    // ★Tool for wood: AXE if we have one, else BARE HAND — NEVER a sword (chops wood slowly +
    // burns the combat-durability we need). Unequip a held sword when axe-less. (用户: 别拿木剑砍树)
    let _axed = false;
    for (const axe of ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe', 'golden_axe']) {
        if (world.getInventoryCounts(bot)[axe]) { await skills.equip(bot, axe).catch(() => {}); _axed = true; break; }
    }
    if (!_axed) { try { if (bot.heldItem && /_sword$/.test(bot.heldItem.name)) await bot.unequip('hand'); } catch (e) {} }
    // chopWood owns movement while it is carving/approaching a tree. item_collecting
    // can otherwise yank the body sideways mid-stair, turning a deliberate climb into
    // a downhill detour; dropped logs are swept explicitly by this skill instead.
    try { for (const m of ['item_collecting', 'idle_staring', 'unstuck']) if (bot.modes && bot.modes.exists(m)) bot.modes.setOn(m, false); } catch (e) {}

    // Climb out of a SEALED pit / underground box by DIGGING a vertical shaft up.
    // goToSurface only PATHFINDS (walks) — it can't break through a dirt ceiling, so
    // a bot boxed in at y~47 (leftover from a prior mining session) never escapes and
    // the whole tech-tree bootstrap deadlocks for lack of wood. Here we open headroom
    // (dig the block above the head) then pillarUp one, repeating to daylight. Dug dirt
    // drops dirt, which refills the pillar scaffold, so it's self-sustaining through
    // soil. Never opens a water/lava ceiling. Falls back to goToSurface if it stalls.
    const UP_OPEN = new Set(['air', 'cave_air', 'void_air']);
    const NO_DIG_UP = new Set(['water', 'flowing_water', 'lava', 'flowing_lava']);
    // ★机械对位原语 (用户现场实测纠正: 垫柱卡住的真因=没站格子正中,跳起来卡在邻格边缘。
    // 原则: 精密操作前必须机械化对位 — 潜行碎步挪到方块正中(潜行防滑出边缘),视线对准,
    // 误差<0.15格才动手。不在漂移站位上赌时序。)
    const _centerOnBlock = async () => {
        const me = bot.entity.position;
        const cx = Math.floor(me.x) + 0.5, cz = Math.floor(me.z) + 0.5;
        if (Math.hypot(me.x - cx, me.z - cz) < 0.15) return true;
        try { await bot.lookAt(new Vec3(cx, me.y + 1.6, cz), true); } catch (e) {}
        const t0 = Date.now();
        bot.setControlState('sneak', true);
        bot.setControlState('forward', true);
        while (Date.now() - t0 < 1000) {
            const m2 = bot.entity.position;
            if (Math.hypot(m2.x - cx, m2.z - cz) < 0.12) break;
            try { await bot.lookAt(new Vec3(cx, m2.y + 1.6, cz), true); } catch (e) {}
            await new Promise(r => setTimeout(r, 60));
        }
        bot.clearControlStates();
        const m3 = bot.entity.position;
        return Math.hypot(m3.x - cx, m3.z - cz) < 0.18;
    };
    const _ascendStep = async (dx, dz, label = 'ascend-step', attempts = 3) => {
        const stepCenter = (cell) => cell.offset(dx + 0.5, 1.15, dz + 0.5);
        const openForBody = (b) => !b || b.boundingBox !== 'block' || UP_OPEN.has(b.name || '');
        const describeBlock = (b) => b ? `${b.name}@${b.position.x},${b.position.y},${b.position.z}` : 'unknown';
        const mustHaveSolidStep = /stair/.test(label);
        const moveOwner = `chopWood:${label}:ascend`;
        const acquireMove = () => {
            const busy = bot._bodyMoveLockUntil && Date.now() < bot._bodyMoveLockUntil && bot._bodyMoveLockOwner !== moveOwner;
            if (busy) {
                _motion('ascend.move_lock.busy', { label, dir: [dx, dz], heldBy: bot._bodyMoveLockOwner || 'unknown' });
                return false;
            }
            bot._bodyMoveLockOwner = moveOwner;
            bot._bodyMoveLockUntil = Date.now() + 3400;
            return true;
        };
        const releaseMove = () => {
            if (bot._bodyMoveLockOwner === moveOwner) {
                bot._bodyMoveLockOwner = null;
                bot._bodyMoveLockUntil = 0;
            }
        };
        const runupPrep = async (cell, attempt) => {
            const p0 = bot.entity.position.clone();
            const target = stepCenter(cell);
            _motion('ascend.runup.begin', {
                label, attempt, dir: [dx, dz],
                targetCell: { x: cell.x + dx, y: cell.y, z: cell.z + dz },
            });
            try {
                try { await bot.lookAt(target, true); } catch (e) {}
                bot.setControlState('sprint', false);
                bot.setControlState('jump', false);
                bot.setControlState('sneak', true);
                bot.setControlState('back', true);
                const t0 = Date.now();
                while (Date.now() - t0 < 320) {
                    const p = bot.entity.position;
                    if (Math.floor(p.x) !== cell.x || Math.floor(p.z) !== cell.z || Math.floor(p.y) !== cell.y) break;
                    await new Promise(r => setTimeout(r, 40));
                }
            } finally {
                try { bot.clearControlStates(); } catch (e) {}
            }
            await new Promise(r => setTimeout(r, 90));
            const p1 = bot.entity.position.clone();
            _motion('ascend.runup.end', {
                label, attempt, dir: [dx, dz],
                start: { x: Number(p0.x.toFixed(3)), y: Number(p0.y.toFixed(3)), z: Number(p0.z.toFixed(3)) },
                end: { x: Number(p1.x.toFixed(3)), y: Number(p1.y.toFixed(3)), z: Number(p1.z.toFixed(3)) },
            });
        };
        const recoverRunupCenter = async (attempt, reason) => {
            const p0 = bot.entity.position.clone();
            _motion('ascend.recenter.begin', {
                label, attempt, dir: [dx, dz], reason,
                start: { x: Number(p0.x.toFixed(3)), y: Number(p0.y.toFixed(3)), z: Number(p0.z.toFixed(3)) },
            });
            try { bot.clearControlStates(); } catch (e) {}
            try { await _centerOnBlock(); } catch (e) {}
            const p1 = bot.entity.position.clone();
            const c = p1.floored();
            const ok = Math.hypot(p1.x - (c.x + 0.5), p1.z - (c.z + 0.5)) < 0.22;
            _motion('ascend.recenter.end', {
                label, attempt, dir: [dx, dz], reason, ok,
                end: { x: Number(p1.x.toFixed(3)), y: Number(p1.y.toFixed(3)), z: Number(p1.z.toFixed(3)) },
            });
            return ok;
        };
        const blocked = (cell) => {
            const targetCell = cell.offset(dx, 0, dz);
            const step = bot.blockAt(targetCell);
            const targetFoot = bot.blockAt(targetCell.offset(0, 1, 0));
            const targetHead = bot.blockAt(targetCell.offset(0, 2, 0));
            const ownOverhead = bot.blockAt(cell.offset(0, 2, 0));
            if (!step || step.boundingBox !== 'block') {
                return mustHaveSolidStep ? { reason: 'no-step', step, targetFoot, targetHead, ownOverhead, targetCell } : null;
            }
            if (!openForBody(targetFoot)) return { reason: 'target-foot-blocked', step, targetFoot, targetHead, ownOverhead, targetCell };
            if (!openForBody(targetHead)) return { reason: 'target-head-blocked', step, targetFoot, targetHead, ownOverhead, targetCell };
            if (!openForBody(ownOverhead)) return { reason: 'own-overhead-blocked', step, targetFoot, targetHead, ownOverhead, targetCell };
            return null;
        };
        const failKey = () => {
            const p = bot.entity.position.floored();
            return `${label}:${dx},${dz}:${p.x},${p.y},${p.z}`;
        };
        const rememberFailure = () => {
            const key = failKey();
            const last = bot._chopAscendFail && bot._chopAscendFail.key === key ? bot._chopAscendFail.n : 0;
            bot._chopAscendFail = { key, n: last + 1, ts: Date.now() };
            return bot._chopAscendFail.n;
        };
        const clearFailure = () => { try { bot._chopAscendFail = null; } catch (e) {} };
        const clearAscendBlocker = async (pre, stage) => {
            if (!pre || _needsFoodYield()) return false;
            const blocker = pre.reason === 'target-foot-blocked' ? pre.targetFoot
                : (pre.reason === 'target-head-blocked' ? pre.targetHead
                : (pre.reason === 'own-overhead-blocked' ? pre.ownOverhead : null));
            if (!blocker || blocker.boundingBox !== 'block' || /water|lava/.test(blocker.name || '')) return false;
            _motion('ascend.clear_blocker.begin', {
                label, stage, dir: [dx, dz], reason: pre.reason,
                blocker: describeBlock(blocker),
                targetCell: { x: pre.targetCell.x, y: pre.targetCell.y, z: pre.targetCell.z },
            });
            const ok = await guardedDig(blocker, `${label}-${pre.reason}`);
            _motion('ascend.clear_blocker.end', {
                label, stage, dir: [dx, dz], reason: pre.reason, ok,
                blocker: describeBlock(blocker),
            });
            if (ok) await new Promise(r => setTimeout(r, 80));
            return ok;
        };
        {
            const cell = bot.entity.position.floored();
            const pre = blocked(cell);
            if (pre) {
                if (await clearAscendBlocker(pre, 'pre')) {
                    _dbg(`${label} cleared blocker dir=${dx},${dz} reason=${pre.reason}`);
                } else {
                const n = rememberFailure();
                _motion('ascend.blocked', {
                    label, dir: [dx, dz], reason: pre.reason, repeats: n,
                    targetCell: { x: pre.targetCell.x, y: pre.targetCell.y, z: pre.targetCell.z },
                    step: describeBlock(pre.step),
                    targetFoot: describeBlock(pre.targetFoot),
                    targetHead: describeBlock(pre.targetHead),
                    ownOverhead: describeBlock(pre.ownOverhead),
                });
                _dbg(`${label} blocked dir=${dx},${dz} reason=${pre.reason} repeat=${n}`);
                return false;
                }
            }
        }
        for (let attempt = 0; attempt < attempts; attempt++) {
            if (!acquireMove()) return false;
            try {
                try { bot.clearControlStates(); } catch (e) {}
                if (attempt === 0) await _centerOnBlock();
                else await runupPrep(bot.entity.position.floored(), attempt);
                const start = bot.entity.position.clone();
                const cell = start.floored();
                const targetCell = cell.offset(dx, 0, dz);
                const pre = blocked(cell);
                if (pre) {
                    if (await clearAscendBlocker(pre, `attempt-${attempt}`)) {
                        _dbg(`${label} cleared blocker dir=${dx},${dz} reason=${pre.reason} attempt=${attempt}`);
                    } else {
                    const n = rememberFailure();
                    _motion('ascend.blocked', {
                        label, attempt, dir: [dx, dz], reason: pre.reason, repeats: n,
                        targetCell: { x: pre.targetCell.x, y: pre.targetCell.y, z: pre.targetCell.z },
                        step: describeBlock(pre.step),
                        targetFoot: describeBlock(pre.targetFoot),
                        targetHead: describeBlock(pre.targetHead),
                        ownOverhead: describeBlock(pre.ownOverhead),
                    });
                    _dbg(`${label} blocked dir=${dx},${dz} reason=${pre.reason} repeat=${n}`);
                    return false;
                    }
                }
                _motion('ascend.begin', { label, attempt, dir: [dx, dz], targetCell: { x: targetCell.x, y: targetCell.y, z: targetCell.z } });
                try { await bot.lookAt(stepCenter(cell), true); } catch (e) {}
                let maxY = start.y;
                bot.setControlState('sprint', false);
                bot.setControlState('forward', true);
                bot.setControlState('jump', true);
                const t0 = Date.now();
                const pressMs = attempt === 0 ? 760 : 980;
                while (Date.now() - t0 < pressMs) {
                    if (bot.entity.position.y > maxY) maxY = bot.entity.position.y;
                    const p = bot.entity.position;
                    const near = Math.hypot(p.x - (targetCell.x + 0.5), p.z - (targetCell.z + 0.5)) < 1.0;
                    if ((Math.floor(p.y) > cell.y || p.y > start.y + 0.72) && near) break;
                    await new Promise(r => setTimeout(r, 40));
                }
                bot.setControlState('jump', false);
                await new Promise(r => setTimeout(r, attempt === 0 ? 180 : 240));
                try { bot.clearControlStates(); } catch (e) {}
                const end = bot.entity.position.clone();
                const rose = Math.floor(end.y) > cell.y || end.y > start.y + 0.72;
                const targetDist = Math.hypot(end.x - (targetCell.x + 0.5), end.z - (targetCell.z + 0.5));
                if (rose && targetDist > (attempt === 0 ? 0.85 : 1.05)) {
                    try { await bot.lookAt(stepCenter(cell), true); } catch (e) {}
                    bot.setControlState('sprint', false);
                    bot.setControlState('forward', true);
                    await new Promise(r => setTimeout(r, attempt === 0 ? 360 : 560));
                    try { bot.clearControlStates(); } catch (e) {}
                }
                const end2 = bot.entity.position.clone();
                const targetDist2 = Math.hypot(end2.x - (targetCell.x + 0.5), end2.z - (targetCell.z + 0.5));
                const settledInTarget = Math.floor(end2.x) === targetCell.x && Math.floor(end2.z) === targetCell.z;
                const climbOk = rose && settledInTarget && targetDist2 <= 0.88;
                const slippedDown = Math.floor(end2.y) < cell.y || end2.y < start.y - 0.35;
                _motion('ascend.end', {
                    label, attempt, dir: [dx, dz], ok: climbOk,
                    start: { x: Number(start.x.toFixed(3)), y: Number(start.y.toFixed(3)), z: Number(start.z.toFixed(3)) },
                    end: { x: Number(end2.x.toFixed(3)), y: Number(end2.y.toFixed(3)), z: Number(end2.z.toFixed(3)) },
                    maxRise: Number((maxY - start.y).toFixed(3)),
                    targetDist: Number(targetDist2.toFixed(3)),
                    settledInTarget,
                });
                if (climbOk) { clearFailure(); return true; }
                if (slippedDown) {
                    const repeats = rememberFailure();
                    _motion('ascend.edge_slip', {
                        label, attempt, dir: [dx, dz], repeats,
                        start: { x: Number(start.x.toFixed(3)), y: Number(start.y.toFixed(3)), z: Number(start.z.toFixed(3)) },
                        end: { x: Number(end2.x.toFixed(3)), y: Number(end2.y.toFixed(3)), z: Number(end2.z.toFixed(3)) },
                        targetDist: Number(targetDist2.toFixed(3)),
                    });
                    _dbg(`${label} edge-slip dir=${dx},${dz} y=${start.y.toFixed(2)}→${end2.y.toFixed(2)} repeat=${repeats} — rotate/abort this heading`);
                    try { await bot.lookAt(stepCenter(cell), true); } catch (e) {}
                    bot.setControlState('sneak', true);
                    bot.setControlState('back', true);
                    await new Promise(r => setTimeout(r, 220));
                    try { bot.clearControlStates(); } catch (e) {}
                    return false;
                }
                if (rose && !climbOk) {
                    const repeats = rememberFailure();
                    _motion('ascend.edge_miss', {
                        label, attempt, dir: [dx, dz], repeats, settledInTarget,
                        start: { x: Number(start.x.toFixed(3)), y: Number(start.y.toFixed(3)), z: Number(start.z.toFixed(3)) },
                        end: { x: Number(end2.x.toFixed(3)), y: Number(end2.y.toFixed(3)), z: Number(end2.z.toFixed(3)) },
                        targetCell: { x: targetCell.x, y: targetCell.y, z: targetCell.z },
                        targetDist: Number(targetDist2.toFixed(3)),
                    });
                    _dbg(`${label} edge-miss dir=${dx},${dz} dist=${targetDist2.toFixed(2)} settled=${settledInTarget} repeat=${repeats} — back out and retry/rotate`);
                }
                // Common failure: the hitbox rides the stair edge but never pops up. Back
                // away from the target (look at the step, press BACK), then mechanically
                // recenter on the current cell before the next run-up. A short timed back
                // press alone can leave the bot at x/z ~= .70, so the next attempt starts
                // from the same edge and repeats the miss.
                try { await bot.lookAt(stepCenter(cell), true); } catch (e) {}
                bot.setControlState('back', true);
                bot.setControlState('sneak', true);
                await new Promise(r => setTimeout(r, 300));
                try { bot.clearControlStates(); } catch (e) {}
                await recoverRunupCenter(attempt, rose ? 'edge-miss' : 'no-rise');
            } finally {
                releaseMove();
            }
        }
        const repeats = rememberFailure();
        _motion('ascend.failed', { label, dir: [dx, dz], repeats });
        _dbg(`${label} failed dir=${dx},${dz} y=${Math.floor(bot.entity.position.y)}`);
        return false;
    };
    const digToSurface = async () => {
        // ★备用镐自愈 (in-skill, NOT boundary-dependent): the orchestrator's kit checks run
        // at goal/try boundaries, but a long chopWood loop can hold the stack for 20+ min —
        // exactly when picks wear out (saw all 3 snap mid-climb, then 12min/9-block
        // bare-hand crawling). Self-heal HERE with what we carry: sticks (2x2 inventory
        // craft, no table) + stone_pickaxe x2 (craftRecipe places our held table). A human
        // never climbs stone bare-handed when 3 cobble + 2 sticks are in the bag.
        try {
            const _c0 = world.getInventoryCounts(bot);
            const _havePick = bot.inventory.items().some(it => /_pickaxe$/.test(it.name));
            const _planksEq = Object.keys(_c0).filter(k => k.endsWith('_planks')).reduce((s, k) => s + _c0[k], 0)
                + Object.keys(_c0).filter(k => k.endsWith('_log')).reduce((s, k) => s + _c0[k], 0) * 4;
            if (!_havePick && (_c0['cobblestone'] || 0) >= 6 && ((_c0['stick'] || 0) >= 4 || _planksEq >= 4)) {
                _dbg(`★NOPICK self-heal: crafting sticks + 2 stone pickaxes from stock (cob=${_c0['cobblestone']} planksEq=${_planksEq})`);
                if ((_c0['stick'] || 0) < 4) { try { await skills.craftRecipe(bot, 'stick', 1); } catch (e) { _dbg(`stick craft err ${e.message}`); } }
                for (let _t = 0; _t < 2; _t++) { try { await skills.craftRecipe(bot, 'stone_pickaxe', 1); } catch (e) { _dbg(`pick craft err ${e.message}`); break; } }
                _dbg(`self-heal result: picks=${bot.inventory.items().filter(it => /_pickaxe$/.test(it.name)).length}`);
            }
        } catch (e) {}
        { const _ic = world.getInventoryCounts(bot); _dbg(`digToSurface START y=${Math.floor(bot.entity.position.y)} pick=${bot.inventory.items().some(it => /pickaxe/.test(it.name))} cob=${_ic['cobblestone'] || 0} dirt=${_ic['dirt'] || 0}`); }
        const _trueSurfaceNow = () => {
            const py = Math.floor(bot.entity.position.y);
            let sky = true;
            try {
                const m = bot.entity.position.floored();
                for (let dd = 2; dd <= 36; dd++) {
                    const b = bot.blockAt(m.offset(0, dd, 0));
                    if (b && b.boundingBox === 'block') { sky = false; break; }
                }
            } catch (e) { sky = false; }
            return py >= 60 && sky && !(bot._mobility && bot._mobility.enclosed);
        };
        {
            const _noPick = !bot.inventory.items().some(it => /_pickaxe$/.test(it.name));
            const _blockedUntil = bot._chopNoPickSurfaceBlockedUntil || 0;
            if (_noPick && !_trueSurfaceNow() && Date.now() < _blockedUntil) {
                _dbg(`digToSurface NOPICK boxed cooldown (${Math.ceil((_blockedUntil - Date.now()) / 1000)}s) — yield to mobility/surfaceUp`);
                return false;
            }
        }
        // ★深层断镐陷阱 (#23实锤: 铁镐断在y-60+木头耗尽=做不了新镐,徒手啃深板岩7s+/块,
        // 120格=数小时): NOPICK且在深层时,先让寻路器试走天然洞穴通道上去(零挖掘),
        // 比硬啃快几个数量级。120s timebox,爬到y>40就算成功;失败再回硬啃路线。
        {
            const _noPick = !bot.inventory.items().some(it => /_pickaxe$/.test(it.name));
            if (_noPick && bot.entity.position.y < 45) {   // 45 (原20): y36徒手13min爬4格实测,蜂窝区洞穴互通,寻路通道值得先试
                _dbg(`digToSurface NOPICK-deep → trying cave-route pathfind first (goToSurface)`);
                try {
                    await Promise.race([
                        skills.goToSurface(bot),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('cave-route timeout')), 120000)),
                    ]);
                } catch (e) { try { bot.pathfinder.stop(); } catch (_) {} try { bot.clearControlStates(); } catch (_) {} }
                const _ynow = Math.floor(bot.entity.position.y);
                _dbg(`cave-route result y=${_ynow}`);
                if (_ynow >= 55) return true;
            }
        }
        {
            const _noPick = !bot.inventory.items().some(it => /_pickaxe$/.test(it.name));
            const _lowResources = bot.health <= 8 || bot.food <= 8;
            if (_noPick && _lowResources && !_trueSurfaceNow()) {
                const _targetY = Math.max(82, Math.floor(bot.entity.position.y) + 12);
                _dbg(`digToSurface NOPICK-low-resource → surfaceUp natural-route target=${_targetY}`);
                try {
                    await Promise.race([
                        skills.customSkill ? skills.customSkill(bot, 'surfaceUp', _targetY) : skills.goToSurface(bot),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('surfaceUp timeout')), 90000)),
                    ]);
                } catch (e) {
                    try { bot.pathfinder.stop(); } catch (_) {}
                    try { bot.clearControlStates(); } catch (_) {}
                    _dbg(`surfaceUp natural-route result err=${e.message}`);
                }
                if (_trueSurfaceNow()) { _dbg(`digToSurface DONE via surfaceUp y=${Math.floor(bot.entity.position.y)}`); return true; }
            }
        }
        {
            const _noPick = !bot.inventory.items().some(it => /_pickaxe$/.test(it.name));
            if (_noPick && !_trueSurfaceNow() && Date.now() > (bot._chopNoPickSurfaceUpCooldownUntil || 0)) {
                const _targetY = Math.max(82, Math.floor(bot.entity.position.y) + 14);
                bot._chopNoPickSurfaceUpCooldownUntil = Date.now() + 60000;
                _dbg(`digToSurface NOPICK boxed → one surfaceUp/headroom attempt target=${_targetY}`);
                try {
                    await Promise.race([
                        skills.customSkill ? skills.customSkill(bot, 'surfaceUp', _targetY) : skills.goToSurface(bot),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('surfaceUp boxed timeout')), 45000)),
                    ]);
                } catch (e) {
                    try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
                    try { bot.clearControlStates(); } catch (_) {}
                    _dbg(`surfaceUp boxed result err=${e.message}`);
                }
                if (_trueSurfaceNow()) { _dbg(`digToSurface DONE via boxed surfaceUp y=${Math.floor(bot.entity.position.y)}`); return true; }
            }
        }
        let _lastY = -999, _stuck = 0;
        for (let i = 0; i < 100; i++) {
            // ★IMMORTAL-LOOP FIX: blanket-clearing interrupt_code every iteration made this
            // loop UNKILLABLE — a death couldn't stop it, the orphaned instance kept digging
            // while the respawn's NEW chopWood started a second climb, and the two loops
            // fought each other at bedrock for 20+ min (interleaved "surf i=48/76/52/80").
            // Honor the death/stop signals; clear only the flee-interrupts we're meant to
            // survive (and only when not dying).
            if (bot.death_abort || bot.health <= 0) { _dbg(`digToSurface ABORT (death) at i=${i} y=${Math.floor(bot.entity.position.y)}`); return false; }
            if (bot._chopGen !== _gen) { _dbg(`digToSurface YIELD (superseded gen${_gen}→${bot._chopGen}) at i=${i}`); return false; }
            // ★危殆让位 (hp0.6事件: 爬升穿过雷区芯被怪缠上,hp掉到0.6还在一步步往上凿 —
            // 残血时唯一正业是活下来): hp≤6 → 停止爬升,把控制还给编排层的生存路径。
            if (bot.health <= 4 && !_criticalForageAllowed()) { _dbg(`digToSurface BAIL (critical hp ${bot.health.toFixed(1)}) at i=${i} — yield to survival`); return false; }   // 6→4 同 chopWood bail线(死水局解锁)
            if (_lowHpHostileYield()) {
                _motion('chopWood.low_hp_hostile_yield', { where: 'digToSurface', iter: i, y: Math.floor(bot.entity.position.y), hp: Math.round(bot.health || 0), food: bot.food });
                _dbg(`digToSurface BAIL (hp=${bot.health.toFixed(1)} + hostile near) at i=${i} — yield to survival`);
                try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
                try { bot.clearControlStates(); } catch (e) {}
                return false;
            }
            if (_needsFoodYield()) {
                _motion('chopWood.low_food_yield', { where: 'digToSurface', iter: i, y: Math.floor(bot.entity.position.y) });
                _dbg(`digToSurface BAIL (food=${bot.food}, no edible) at i=${i} — yield to feedUp`);
                try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
                try { bot.clearControlStates(); } catch (e) {}
                return false;
            }
            try { bot.interrupt_code = false; } catch (e) {}
            const py = Math.floor(bot.entity.position.y);
            if (py > _lastY) { _stuck = 0; _lastY = py; } else _stuck++;
            // ★STUCK-BREAKER: pillar can fail at a specific spot (complex stone ceiling) even WITH
            // pick+filler — saw it dead-loop 100 iters frozen at y46. Don't die on one spot: bore
            // ONE block sideways with the pick to relocate to a fresh shaft, then resume climbing.
            if (_stuck >= 8) {
                const [ddx, ddz] = [[1, 0], [0, 1], [-1, 0], [0, -1]][i % 4];
                const mm = bot.entity.position.floored();
                // ★AQUIFER PROBE before boring (death 210 = the EXACT 200 replay via a new
                // hole: the bore checked the dug cell itself for water but NOT what's BEHIND
                // it — punched through an aquifer wall, flooded the sealed shaft, drowned with
                // 8 blocks of ceiling). Probe one cell deeper + above each dug cell; if ANY is
                // liquid, rotate to the next direction instead.
                let wetBehind = false;
                for (const probe of [mm.offset(ddx * 2, 0, ddz * 2), mm.offset(ddx * 2, 1, ddz * 2), mm.offset(ddx, 2, ddz)]) {
                    const pb2 = bot.blockAt(probe);
                    if (pb2 && /water|lava/.test(pb2.name || '')) { wetBehind = true; break; }
                }
                if (wetBehind) { _dbg(`surf STUCK y=${py} → stair d=${ddx},${ddz} ABORTED (liquid behind wall) — rotating`); _stuck = 6; continue; }
                // ★阶梯上行 (实拍: 垫柱顶到厚岩层天花板,低净空跳跃放块成功率骤降,旧的
                // "平移钻孔"换了位置头顶还是岩层=死循环): STUCK 自救改为凿台阶上行 —
                // 挖 [前+1(踏步), 前+2(净空), own head] 然后走跳上台阶。零放块依赖,
                // 任何天花板下都保证 +1 格,是 pinned 楼梯同款已验证原语。
                _dbg(`surf STUCK y=${py} → 阶梯上行 d=${ddx},${ddz}`);
                let _blockedByNoPickStone = false;
                const _pickForStuck = () => bot.inventory.items().some(it => /_pickaxe$/.test(it.name));
                const _STONY_STUCK = /stone|deepslate|andesite|diorite|granite|tuff|_ore$|obsidian|cobble/;
                let _plannedStoneStair = 0;
                for (const c of [mm.offset(ddx, 1, ddz), mm.offset(ddx, 2, ddz), mm.offset(0, 2, 0)]) {
                    const b = bot.blockAt(c);
                    if (b && !UP_OPEN.has(b.name) && !NO_DIG_UP.has(b.name)) {
                        if (!_pickForStuck() && _STONY_STUCK.test(b.name)) {
                            if (py >= 80 && bot.food <= 2 && _plannedStoneStair < 3) {
                                _plannedStoneStair++;
                                _dbg(`surf STUCK planned no-pick stone stair ${_plannedStoneStair}/3 y=${py} name=${b.name}`);
                                try { bot._plannedNoPickStoneUntil = Date.now() + 15000; } catch (e) {}
                            } else { _blockedByNoPickStone = true; break; }
                        }
                        await guardedDig(b, 'surf-stuck');
                    }
                }
                if (_blockedByNoPickStone) { _dbg(`surf STUCK y=${py} → no-pick stone gate, yielding instead of punching`); return false; }
                await _ascendStep(ddx, ddz, 'surf-stuck-stair');
                _stuck = 0; _lastY = -999;
                continue;
            }
            if (i % 4 === 0) {
                // ★空手碎石是禁忌 (human taboo): punching stone is 5-10x slower AND drops
                // nothing. We can't always avoid it (true bootstrap deadlock has no choice),
                // but it must NEVER be silent — shout it so the patrol sees the state.
                const _hasPick = bot.inventory.items().some(it => /_pickaxe$/.test(it.name));
                _dbg(`surf i=${i} y=${py}${_hasPick ? '' : ' ★NOPICK — climbing bare-handed (prefer dirt/gravel route)'}`);
            }
            // ★真地表判定 (16:49 死循环破案: 旧条件 y≥64 是老世界的地表线——重生区真地表
            // y82,y64 只是个有天窗的洞,DONE→chopWood找不到树→再调→再DONE,在 y64 永动。
            // 三条件: y≥60 + 头顶整列见天 + enclosed=false(C32 全景列探测,周围也开)。
            // 单用 enclosed 不行: 1格天窗就翻 false(对夜门保守正确,对出地表过松)。
            // 状态机未建时退回 y≥70 旧线。)
            let _surfaced;
            if (bot._mobility && typeof bot._mobility.enclosed === 'boolean') {
                let _skyAbove = true;
                for (let _dd = 2; _dd <= 36; _dd++) { const _cb = bot.blockAt(bot.entity.position.floored().offset(0, _dd, 0)); if (_cb && _cb.boundingBox === 'block') { _skyAbove = false; break; } }
                _surfaced = py >= 60 && _skyAbove && !bot._mobility.enclosed;
            } else _surfaced = py >= 70;
            if (_surfaced) { _dbg(`digToSurface DONE y=${py} (true surface: sky above + not enclosed)`); return true; }
            // ★徒手禁撸石 (用户实拍怒斥"你见过哪个人类玩家这样挖石头的?"): bare hands on
            // stone = 7.5s/block AND drops nothing — pure waste. The old "prefer dirt/
            // gravel route" was a LOG LINE with no implementation; every dig call below
            // was material-blind. Now: without a pickaxe only dirt-class blocks are
            // diggable; stone walls mean "find another way" (stair directions get a
            // strict all-dirt pass first), not "punch for a minute per block".
            const _pickIn = hasPick;
            const _digOK = (b) => !!b && (_pickIn() || plannedNoPickStone() || !STONY_BLOCK.test(b.name));
            const headUp = bot.blockAt(bot.entity.position.offset(0, 2, 0));
            if (headUp && NO_DIG_UP.has(headUp.name)) { try { await skills.goToSurface(bot); } catch (e) {} return Math.floor(bot.entity.position.y) >= 62; }
            if (headUp && !UP_OPEN.has(headUp.name) && _digOK(headUp)) await guardedDig(headUp, 'head-up');
            const before = Math.floor(bot.entity.position.y);
            // ★Manual MLG pillar — skills.pillarUp FAILED to lift us despite filler (chopDBG:
            // dirt=21 yet it fell through to the unstable staircase). Do it by hand reliably:
            // clear the head, equip filler, jump, and place a block under our feet at the apex.
            // Vertical rise that CANNOT fall back (unlike raw stair-climbing in cave terrain).
            const _fill = bot.inventory.items().find(it => /dirt|cobblestone|cobbled|granite|andesite|diorite|^stone$|tuff|gravel|^sand$|red_sand|sandstone|terracotta|_planks$|_log$/.test(it.name));   // ★C280 +red_sand/terracotta (badlands)
            // ★STAIR-PLACE first (deterministic +1, proven in LEASH; the self-pillar
            // below is a hitbox race that mostly loses — saw y oscillate 60↔62 for 5min
            // with 22 dirt in the bag). Place into an ADJACENT cell at foot height
            // (with body-clearance check) and step up; fall through to the old pillar
            // only when no neighbor qualifies.
            if (_fill) {
                try {
                    const scD = bot.entity.position.floored();
                    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                        const openD = (b) => !b || b.boundingBox !== 'block';
                        if (!openD(bot.blockAt(scD.offset(dx, 0, dz)))) continue;
                        if (!openD(bot.blockAt(scD.offset(dx, 1, dz)))) continue;
                        if (!openD(bot.blockAt(scD.offset(dx, 2, dz)))) continue;
                        const bp = bot.entity.position;
                        if (Math.hypot(bp.x - (scD.x + dx + 0.5), bp.z - (scD.z + dz + 0.5)) < 0.85) continue;
                        const targetD = scD.offset(dx, 0, dz);
                        if (!(await _placeConfirmed(_fill.name, targetD, `surf-stair-place ${dx},${dz}`))) continue;
                        await _ascendStep(dx, dz, 'surf-stair-place');
                        if (bot.entity.position.floored().y > scD.y) _dbg(`surf stair-step +1 → y=${Math.floor(bot.entity.position.y)}`);
                        break;
                    }
                } catch (e) {}
            }
            if (_fill && Math.floor(bot.entity.position.y) <= before) {
                const _h = bot.blockAt(bot.entity.position.offset(0, 2, 0));
                if (_h && !UP_OPEN.has(_h.name) && !NO_DIG_UP.has(_h.name) && _digOK(_h)) await guardedDig(_h, 'pillar-head');
                await _centerOnBlock();   // ★对中再跳 (不对中=跳起卡邻格边缘,实拍十跳九空)
                try { await bot.equip(_fill, 'hand'); } catch (e) {}
                const _ref = bot.blockAt(bot.entity.position.offset(0, -1, 0));
                try { await bot.lookAt(bot.entity.position.offset(0, -1, 0), true); } catch (e) {}   // 视线对准脚下放置面
                // ★PLACE-WINDOW FIX (same hidden bug as the LEASH pillar): the fixed 380ms
                // wait sampled AFTER the jump apex — by place time the bot's hitbox had sunk
                // back into the target cell and the server rejected every placement
                // ("blockUpdate did not fire"). The cell is vacated only while y > start+1.01
                // (~200ms around apex): poll and place inside that window. This is why manual
                // MLG pillaring "worked" only via the staircase fallback all along.
                try {
                    if (skills.placeBlockUnderFeet) await skills.placeBlockUnderFeet(bot, _fill.name, { retries: 1, settleMs: 150 });
                    else {
                        bot.setControlState('jump', true);
                        const _tJ = Date.now();
                        let _pl = false;
                        while (Date.now() - _tJ < 700 && !_pl) {
                            if (bot.entity.position.y > before + 1.01) {
                                try { if (_ref && Vec3) { await bot.placeBlock(_ref, new Vec3(0, 1, 0)); _pl = true; } } catch (e) {}
                            }
                            if (!_pl) await new Promise(r => setTimeout(r, 30));
                        }
                    }
                } finally {
                    bot.setControlState('jump', false);
                }
                await new Promise(r => setTimeout(r, 150));
                // ANTI-SUFFOCATION: if a solid block ended up at head level (entombed), dig free at once.
                try {
                    const _head = bot.blockAt(bot.entity.position.offset(0, 1, 0));
                    if (_head && _head.boundingBox === 'block' && !NO_DIG_UP.has(_head.name)) await guardedDig(_head, 'anti-suffocation');
                } catch (e) {}
            }
            if (Math.floor(bot.entity.position.y) <= before) {
                // ★pillarUp didn't lift us → we're NAKED with NO filler in a STONE pocket: digging
                // stone barehanded drops NOTHING, so there's never cap material and pillaring is
                // impossible. This is the bootstrap deadlock (saw 50min stuck in a stone hole, 0
                // logs: no pickaxe→can't get filler→can't pillar→can't surface→no wood→no pickaxe).
                // BREAK IT with a STAIRCASE: carve the 2-high space one step ahead-and-up and walk
                // onto the stair left below. Needs ZERO blocks — just time. Rotate direction each
                // pass so one unbreakable face (bedrock/unreachable) can't stall us.
                // RAW-climb the stair — do NOT goToPosition: chopDBG showed the pathfinder stalled
                // ~110s on the half-dug step and even fell the bot DOWN (y28→25) chasing it. Pick a
                // side with a SOLID step to stand on, clear the 2-high space above that step + our
                // own head, then physically walk+jump onto it. Zero filler needed.
                let rose = false;
                // two passes normally; low-resource no-pick famine must not relax into
                // punching stone, because that burns minutes and drops nothing.
                const _allowRelaxedStone = _pickIn() || plannedNoPickStone();
                for (const relax of (_allowRelaxedStone ? [false, true] : [false])) {
                    for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
                        const m = bot.entity.position.floored();
                        const under = bot.blockAt(m.offset(dx, 0, dz));
                        if (!under || under.boundingBox !== 'block') continue;   // need a stair to climb onto
                        const cells = [m.offset(dx, 1, dz), m.offset(dx, 2, dz), m.offset(0, 2, 0)];
                        if (!relax && cells.some(c => { const b = bot.blockAt(c); return b && !UP_OPEN.has(b.name) && !_digOK(b); })) continue;
                        let clear = true;
                        for (const c of cells) {
                            const b = bot.blockAt(c);
                            if (b && !UP_OPEN.has(b.name) && !NO_DIG_UP.has(b.name)) {
                                if (!(relax || _digOK(b))) { clear = false; break; }
                                if (!(await guardedDig(b, 'raw-stair'))) { clear = false; break; }
                                await new Promise(r => setTimeout(r, 80));
                                const after = bot.blockAt(c);
                                if (after && !UP_OPEN.has(after.name)) { clear = false; break; }
                            }
                        }
                        if (!clear) {
                            _motion('raw-stair.blocked', { dir: [dx, dz], relax, y: Math.floor(bot.entity.position.y) });
                            continue;
                        }
                        await _ascendStep(dx, dz, 'raw-stair');
                        if (Math.floor(bot.entity.position.y) > before) { rose = true; break; }
                    }
                    if (rose) break;
                }
                if (!rose) {
                    _dbg(`raw-stair no viable climb from y=${before} pick=${_pickIn()} food=${bot.food} hp=${bot.health.toFixed(1)} — yield`);
                    if (!_pickIn()) {
                        bot._chopNoPickSurfaceBlockedUntil = Date.now() + 30000;
                        _motion('chopWood.no_pick_surface_blocked', {
                            y: before,
                            food: bot.food,
                            hp: Math.round(bot.health || 0),
                            mobility: bot._mobility ? bot._mobility.state : null,
                            enclosed: !!(bot._mobility && bot._mobility.enclosed),
                        });
                    }
                    return false;
                }
            }
        }
        _dbg(`digToSurface END y=${Math.floor(bot.entity.position.y)}`);
        return Math.floor(bot.entity.position.y) >= 62;
    };

    // ★GENERATION TOKEN (orphan killer): every Promise.race timeout up the stack
    // (achieve's 90s wood-buffer box, the 45s chop box) ABANDONS the loser without
    // cancelling it — the abandoned chopWood keeps digging in the background and the
    // next invocation then runs INTERLEAVED with it (saw "surf i=16/96" dual climbs
    // fighting at bedrock for 20+ min, twice). New instance bumps the generation;
    // every loop in THIS file yields the moment it's superseded.
    bot._chopGen = (bot._chopGen || 0) + 1;
    const _gen = bot._chopGen;
    // ★走格子扫荡 (用户实拍×2: 挖了树不捡 — item_collecting 模式在 achieve 期间是被禁用的,
    // 所以掉落必须由我们显式走过去踩格子捡): walk onto each dropped item entity within r.
    const _isDropEntity = (e) => e && e.position && (
        e.name === 'item' || e.objectType === 'Item' || e.displayName === 'Item' || /item/i.test(e.name || '')
    );
    // ★C299 THE wood-famine root cause (live 2026-06-20): inventory was 36/36 FULL of mesa junk
    // (red_sand×474=8 slots, terracotta×100s, sand) → the server CANNOT deposit a picked-up log into
    // a full inventory → bot dug 6-log columns, stood h0.4b ON the drops (near=dy0.0/h0.4), total
    // stayed 0 FOREVER and it blacklisted every tree (blk 8→28). All of C297(aim)/C298(reach) is moot
    // if there's no slot to put the log in. When full, toss the bulkiest low-value bulk junk to free
    // slots. Whitelisted KEEP-set never tossed (tools/food/wood/saplings/ores/utility).
    // ★C309-A (claude-A, T-0041): the mesa-tuned junk list missed the bot's ACTUAL hoard in other
    // biomes — inv 36/36 FULL of raw_copper×192(3 slots)+lapis×44+dripstone×24+... so "no droppable
    // junk" fired and she could NEVER free a slot for the keystone log (iron-tier blocked forever:
    // she had furnace+iron×2+2 stone picks, just needed 1 log→table→stick; no chest to bank either).
    // Add the non-bootstrap bulk she actually carries. KEEP dirt (sapling planting / T-0030) + cobble
    // (filler/seal) + iron/coal + food/tools/wood/saplings — only toss what's useless for the
    // survival→iron→diamond path (copper has no tools, lapis is far-future enchant, dripstone is decor).
    const _JUNK_RE = /terracotta$|^red_sand$|^sand$|^clay_ball$|^cactus$|^gravel$|^granite$|^diorite$|^andesite$|^tuff$|^ink_sac$|^raw_copper$|^copper_ingot$|^lapis_lazuli$|^pointed_dripstone$|^dripstone_block$|^raw_gold$|^amethyst_shard$|^calcite$/;
    const _emptySlots = () => { try { return typeof bot.inventory.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : 9; } catch (e) { return 9; } };
    const _ensureInvRoom = async (want = 5) => {
        try {
            if (_emptySlots() >= want) return true;
            // Free MULTIPLE slots, not one: a single freed slot is instantly re-filled by jungle leaf-drops
            // (saplings/sticks) or by re-walking over the very junk we tossed → logs never win a slot
            // (live: "free now 1" then next call FULL again, total stuck 0). Toss bulk junk until we hold
            // a healthy buffer of empties so logs have somewhere to go. ★C299b
            let tossed = 0;
            for (let g = 0; g < 8 && _emptySlots() < want; g++) {
                const junk = bot.inventory.items().filter(it => _JUNK_RE.test(it.name || '')).sort((a, b) => b.count - a.count);
                if (!junk.length) break;
                const d = junk[0];
                // tossStack(item) drops THIS exact slot — robust vs bot.toss(type,...) which searches by
                // type and throws "Can't find X in slots" when the stack sits in the hotbar range. ★C299
                try { await bot.tossStack(d); tossed += d.count; } catch (e) { _dbg(`★C299 toss fail: ${e.message}`); break; }
            }
            if (tossed > 0) _dbg(`★C299 inv near-full → tossed ${tossed} junk to free slots for logs (empty now ${_emptySlots()})`);
            // ★C321 (T-0055): second tier — when there's NO _JUNK_RE junk left but the inv is STILL
            // full and voiding the bootstrap-critical wood pickup, TRIM the excess of over-hoarded
            // BULK stackables above a generous keep-cap. Live root: 377 cobblestone(6 slots)+157 coal+
            // 107 sandstone+60 dirt filled the bag, so every chopped log landed unstorable → total
            // stayed 0 → trees got mis-blacklisted "unreachable, 树柱fails" (the failure is PICKUP, not
            // reachability — that's why migrate-to-trees still couldn't bootstrap). A human with 377
            // cobble drops 250 to grab the log they need. NEVER touches tools/armor/food/wood/sapling/
            // seeds — only bulk building/fuel/dirt the bot demonstrably over-hoards.
            if (_emptySlots() < want) {
                const _BULK_CAP = { cobblestone: 128, cobbled_deepslate: 128, stone: 64, coal: 64, charcoal: 64, sandstone: 48, red_sandstone: 48, sand: 48, red_sand: 48, gravel: 48, dirt: 64, netherrack: 64, torch: 64, sugar_cane: 16 };
                for (const it of bot.inventory.items().slice().sort((a, b) => b.count - a.count)) {
                    if (_emptySlots() >= want) break;
                    const cap = _BULK_CAP[it.name];
                    if (cap == null || it.count <= cap) continue;
                    const drop = it.count - cap;
                    try { await bot.toss(it.type, null, drop); tossed += drop; _dbg(`★C321 inv-full no-junk → trimmed ${drop} ${it.name} (kept ${cap}) for log slots (empty now ${_emptySlots()})`); }
                    catch (e) { _dbg(`★C321 trim ${it.name} fail: ${e.message}`); }
                }
            }
            if (tossed === 0 && _emptySlots() === 0) _dbg(`★C299/C321 inv FULL — no junk and no over-cap bulk to trim, can't make room for logs`);
            return _emptySlots() > 0;
        } catch (e) { _dbg(`★C299 inv-room check fail: ${e.message}`); return false; }
    };
    // ★C298 returns {seen,reached} so direct-chop can report WHY total stayed 0 (drops not
    // spawned/seen vs seen-but-unreachable). Re-scans each pass: a felled trunk column drops logs
    // over several ticks and they settle a beat after the dig — a single up-front snapshot missed
    // the late-landing logs (jungle live 2026-06-20: dug 6 logs, total stayed 0 every pass).
    const _sweepDrops = async (r = 8, maxN = 6) => {
        let seen = 0, reached = 0, _nearDrop = '';
        try {
            for (let pass = 0; pass < maxN; pass++) {
                if (bot.interrupt_code || bot.death_abort || bot._chopGen !== _gen) break;
                // ★C299c don't chase the junk we just tossed for room — sweep walks the bot over its own
                // discarded red_sand and vanilla auto-collects it right back (live: red_sand 346→381, a
                // toss↔re-pickup loop that re-fills the very slots C299 freed). Skip drops whose name is
                // KNOWN junk; keep unknown-name drops (might be a log whose name didn't resolve).
                const _dropNm = (e) => { try { const di = e.getDroppedItem && e.getDroppedItem(); return di && di.name ? di.name : ''; } catch (x) { return ''; } };
                const items = Object.values(bot.entities)
                    .filter(e => _isDropEntity(e) && e.position.distanceTo(bot.entity.position) < r && !_JUNK_RE.test(_dropNm(e)))
                    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
                if (!items.length) break;
                seen = Math.max(seen, items.length);
                const it = items[0];
                if (pass === 0) {   // ★C298 record nearest-drop geometry + name: dy>1⇒leaf canopy; big h⇒gap; name=log vs sapling/stick tells log-fell-away from inv/desync
                    const _me = bot.entity.position;
                    let _nm = ''; try { const _di = it.getDroppedItem && it.getDroppedItem(); _nm = _di && _di.name ? _di.name : ''; } catch (e) {}
                    _nearDrop = `${_nm || '?'} dy${(it.position.y - _me.y).toFixed(1)}/h${Math.hypot(it.position.x - _me.x, it.position.z - _me.z).toFixed(1)}`;
                }
                try { await skills.goToPosition(bot, it.position.x, it.position.y, it.position.z, 0); } catch (e) {}
                // ★C298 goToPosition silently fails to ARRIVE the last 1-3 blocks in jungle (leaf-blocked
                // paths / drop sits on a +1-2 rise) → the bot never physically stands on the drop → the
                // SERVER never auto-collects it (vanilla pickup is hitbox-overlap, independent of the
                // item_collecting mode chopWood disables at L220) → dug N logs but total=0 for minutes
                // (live jungle 2026-06-20). RAW-walk onto the tile to bypass the pathfinder verdict,
                // exactly like raw-approach does for the trunk itself.
                // ★C303 park on the drop's HORIZONTAL column, not by 3D distance: a drop above/below the
                // bot (dy≥1 ⇒ leaf canopy or a dug pit, e.g. C300's harvested dirt 2 below) has a 3D
                // distance that can NEVER fall under 0.7 (the vertical gap alone exceeds it), so the old
                // exit test was unsatisfiable → the bot walked the full 1.5s and OVERSHOT straight past
                // the drop's column, never settling over it. Stop when horizontally aligned (h<0.4) so we
                // park directly over/under it and either auto-collect (same level/±1) or fall onto it.
                const _hd = () => { const p = it.position, m = bot.entity.position; return Math.hypot(p.x - m.x, p.z - m.z); };
                if (it.isValid && _hd() > 0.6) {
                    try {
                        await bot.lookAt(it.position.offset(0, 0.1, 0), true);
                        const _up = it.position.y - bot.entity.position.y > 0.6;
                        bot.setControlState('forward', true);
                        if (_up) bot.setControlState('jump', true);
                        const t0 = Date.now();
                        while (Date.now() - t0 < 1500 && it.isValid && _hd() > 0.4) await new Promise(rr => setTimeout(rr, 100));
                        bot.clearControlStates();
                    } catch (e) { try { bot.clearControlStates(); } catch (_) {} }
                }
                // ★C298b FUNNEL-DIG: jungle drops rest ON the leaf canopy ABOVE the bot (leaves are solid,
                // items don't fall through) — raw-walk can't climb onto leaves, so seen=N reached=0 forever
                // (live 2026-06-20: seen climbed 2→14, total=0, blk exploded 16→28). Dig the block the drop
                // is sitting on so it FALLS toward the ground where we can walk onto it; repeat next pass.
                if (it.isValid && (it.position.y - bot.entity.position.y) > 0.6) {
                    try {
                        const under = bot.blockAt(it.position.offset(0, -0.4, 0).floored());
                        const reach = bot.entity.position.offset(0, 1.6, 0).distanceTo(it.position);
                        if (under && /_leaves$|_log$|_wood$/.test(under.name || '') && reach <= 4.8) {
                            await bot.lookAt(under.position.offset(0.5, 0.5, 0.5), true);
                            try { await bot.tool.equipForBlock(under); } catch (e) {}
                            if (bot.heldItem && /_sword$/.test(bot.heldItem.name)) { try { await bot.unequip('hand'); } catch (e) {} }
                            await bot.dig(under);
                        }
                    } catch (e) {}
                }
                if (!it.isValid) reached++;   // entity gone = collected (or despawned/out-of-range)
                await new Promise(rr => setTimeout(rr, 200));   // settle for server-side auto-pickup
            }
        } catch (e) {}
        return { seen, reached, near: _nearDrop };
    };
    const _skyAboveHere = () => {
        try {
            const m = bot.entity.position.floored();
            for (let dy = 2; dy <= 36; dy++) {
                const b = bot.blockAt(m.offset(0, dy, 0));
                if (b && b.boundingBox === 'block') return false;
            }
            return true;
        } catch (e) { return false; }
    };
    const _highOpenSurface = () => {
        try {
            const y = Math.floor(bot.entity.position.y);
            if (y < 70) return false;
            if (bot._mobility && bot._mobility.enclosed) return false;
            if (_skyAboveHere()) return true;
            // Leaf canopies and steep hills often make the strict sky probe false even
            // though the bot is already on open overworld terrain. In that case a hard
            // leash raw-walks it back through cliffs/shafts and recreates the stair-edge
            // stall. FREE + healthy + high means "local tree search", not mine escape.
            if (bot._mobility && bot._mobility.state === 'FREE' && bot.food >= 8 && bot.health >= 10) return true;
        } catch (e) {}
        return false;
    };
    const _maroonedLocalHarvest = async (iter) => {
        const freshHandoff = Date.now() < (bot._maroonedWoodHandoffUntil || 0);
        const marooned = !!(bot._mobility && bot._mobility.state === 'MAROONED');
        if (!freshHandoff && !marooned) return false;
        if (bot.health <= 6 || bot.food <= 4 || _hostileNear(12)) {
            _dbg(`MAROONED local harvest skip hp=${bot.health.toFixed(1)} food=${bot.food} hostile=${_hostileNear(12)}`);
            return false;
        }
        try {
            const t = bot.time.timeOfDay;
            if (t >= 13000 && t <= 23000 && bot.entity.position.y >= 50 && !(bot._mobility && bot._mobility.enclosed)) {
                _dbg(`MAROONED local harvest skip night exposed`);
                return false;
            }
        } catch (e) {}
        const eye = () => bot.entity.position.offset(0, 1.6, 0);
        const keyOf = (p) => `${p.x},${p.y},${p.z}`;
        const logCandidates = () => {
            const out = [];
            for (const n of LOGS) {
                try {
                    const id = bot.registry && bot.registry.blocksByName[n] ? bot.registry.blocksByName[n].id : null;
                    if (id == null) continue;
                    for (const p of (bot.findBlocks({ matching: id, maxDistance: 7, count: 16 }) || [])) {
                        const b = bot.blockAt(p);
                        if (!b || !/_log$|_wood$/.test(b.name || '')) continue;
                        const d = eye().distanceTo(b.position.offset(0.5, 0.5, 0.5));
                        if (d > 5.1 || Math.abs(b.position.y - bot.entity.position.y) > 5) continue;
                        out.push({ b, d, key: keyOf(b.position) });
                    }
                } catch (e) {}
            }
            return out.sort((a, b) => a.d - b.d);
        };
        let cand = logCandidates()[0];
        let leafDug = 0;
        if (!cand) {
            try {
                const leafIds = Object.values(bot.registry.blocksByName)
                    .filter(b => /_leaves$/.test(b.name)).map(b => b.id);
                const leaves = bot.findBlocks({ matching: leafIds, maxDistance: 4, count: 10 }) || [];
                for (const p of leaves) {
                    if (leafDug >= 4) break;
                    const b = bot.blockAt(p);
                    if (!b || !/_leaves$/.test(b.name || '')) continue;
                    if (eye().distanceTo(b.position.offset(0.5, 0.5, 0.5)) > 4.8) continue;
                    _motion('chopWood.marooned_local.leaf.begin', {
                        iter, block: `${b.name}@${b.position.x},${b.position.y},${b.position.z}`,
                    });
                    if (await guardedDig(b, 'marooned-local-leaf')) leafDug++;
                    await new Promise(r => setTimeout(r, 90));
                }
            } catch (e) {}
            cand = logCandidates()[0];
        }
        if (!cand) {
            _dbg(`chopWood BAIL (MAROONED) at iter${iter} — no in-reach local log (leafDug=${leafDug})`);
            return false;
        }
        try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
        try { bot.clearControlStates(); } catch (e) {}
        const before = total();
        const fillerForCatch = () => bot.inventory.items().find(it => /^(dirt|grass_block|cobblestone|cobbled_deepslate|granite|andesite|diorite|tuff|gravel)$/.test(it.name || ''));
        const makeCatchLedge = async (lb) => {
            if (!lb || !lb.position || !fillerForCatch()) return false;
            const below = lb.position.offset(0, -1, 0);
            const bBelow = bot.blockAt(below);
            if (bBelow && bBelow.boundingBox === 'block') return true;
            const candidates = [
                lb.position.offset(0, -1, 0),
                lb.position.offset(1, -1, 0),
                lb.position.offset(-1, -1, 0),
                lb.position.offset(0, -1, 1),
                lb.position.offset(0, -1, -1),
            ];
            for (const target of candidates) {
                const cur = bot.blockAt(target);
                if (cur && cur.boundingBox === 'block') return true;
                const fill = fillerForCatch();
                if (!fill) return false;
                try {
                    if (target.distanceTo(bot.entity.position) > 5.2) continue;
                    if (await _placeConfirmed(fill.name, target, 'marooned-catch-ledge')) return true;
                } catch (e) {}
            }
            return false;
        };
        _motion('chopWood.marooned_local.begin', {
            iter,
            state: bot._mobility ? bot._mobility.state : null,
            freshHandoff,
            target: `${cand.b.name}@${cand.b.position.x},${cand.b.position.y},${cand.b.position.z}`,
            dist: Number(cand.d.toFixed(2)),
            ignoredBlacklist: _blk(cand.key),
        });
        let dug = 0;
        try {
            const bp = cand.b.position;
            let lowDy = 0;
            while (lowDy > -4) {
                const b2 = bot.blockAt(bp.offset(0, lowDy - 1, 0));
                if (b2 && /_log$|_wood$/.test(b2.name || '')) lowDy--;
                else break;
            }
            for (let dy = lowDy; dy <= 8; dy++) {
                if (bot.interrupt_code || bot.death_abort || bot._chopGen !== _gen) break;
                const lb = bot.blockAt(bp.offset(0, dy, 0));
                if (!lb || !/_log$|_wood$/.test(lb.name || '')) { if (dy > 0) break; else continue; }
                const reach = eye().distanceTo(lb.position.offset(0.5, 0.5, 0.5));
                if (reach > 5.1) break;
                _motion('chopWood.marooned_local.log.begin', {
                    iter, block: `${lb.name}@${lb.position.x},${lb.position.y},${lb.position.z}`,
                    reach: Number(reach.toFixed(2)),
                });
                await makeCatchLedge(lb);
                if (await guardedDig(lb, 'marooned-local-log')) {
                    dug++;
                    const k = keyOf(lb.position);
                    _unreach.delete(k);
                    _colBlock.delete(_colKey(k));
                } else break;
                await new Promise(r => setTimeout(r, 120));
            }
            await _sweepDrops(8, 6);
            await new Promise(r => setTimeout(r, 300));
            await _sweepDrops(5, 3);
        } catch (e) { _dbg(`MAROONED local harvest fail: ${e.message}`); }
        _motion('chopWood.marooned_local.end', {
            iter, dug, before, after: total(), leafDug,
            state: bot._mobility ? bot._mobility.state : null,
        });
        if (total() > before) {
            _dbg(`MAROONED local canopy harvest: dug ${dug} logs leaf=${leafDug} total ${before}→${total()}`);
            bot._maroonedWoodHandoffUntil = Date.now() + 45000;
            return true;
        }
        if (dug > 0) {
            _dbg(`MAROONED local canopy NO-PICKUP: dug ${dug} logs but total ${before}→${total()} — drops likely fell off ledge; treating as failure`);
            return false;
        }
        _dbg(`chopWood BAIL (MAROONED) at iter${iter} — local log reachable but no dig progress`);
        return false;
    };
    // ★C279 WOOD-DESERT SELF-SUFFICIENCY (用户 no-reroll: bot 必须在任何世界能 bootstrap):
    // 当 reachable 范围内 NO natural tree (badlands/mesa: 树只长在够不到的台地顶,
    // blk=N 全黑名单, reachable nearest=NONE forever → 饿死式漫游) 但背包里揣着 sapling,
    // 就地种树自产木,不再漫游到饿死。sapling 拒绝 sand/red_sand/terracotta → 先垫一块 dirt,
    // 种下,再用骨粉催熟 (bone→bone_meal 无需工作台) 让它秒长成树。下一 iter 扫到树就砍。
    const _trySaplingGrow = async () => {
        try {
            if (total() > 0) return false;                                   // already have logs
            const items = bot.inventory.items();
            if (items.some(i => /_planks$/.test(i.name) && i.count >= 4)) return false;
            const sap = items.find(i => /_sapling$/.test(i.name || ''));
            if (!sap) return false;
            if (Date.now() < (bot._saplingGrowUntil || 0)) return false;
            const me = bot.entity.position.floored();
            const skyOpen = (cell) => {
                for (let d = 1; d <= 6; d++) { const b = bot.blockAt(cell.offset(0, d, 0)); if (b && b.boundingBox === 'block') return false; }
                return true;
            };
            const PLANTABLE = /grass_block|^dirt$|coarse_dirt|podzol|mycelium|rooted_dirt|moss_block|^mud$|farmland/;
            const isAir = (b) => !b || b.name === 'air';
            // nearest reachable ground cell: solid floor, open cell, sky clearance, not our own body
            const _hasDirt = () => bot.inventory.items().some(i => /^dirt$|^coarse_dirt$/.test(i.name || ''));
            const findSpot = () => {
                const ring = [];
                for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) ring.push([dx, dz]);
                ring.sort((a, b) => (Math.abs(a[0]) + Math.abs(a[1])) - (Math.abs(b[0]) + Math.abs(b[1])));
                for (const [dx, dz] of ring) {
                    for (const dy of [0, 1, -1]) {
                        const air = me.offset(dx, dy, dz);
                        if (air.equals(me) || air.equals(me.offset(0, 1, 0))) continue;   // can't place in our own body
                        const ground = air.offset(0, -1, 0);
                        const gb = bot.blockAt(ground), ab = bot.blockAt(air);
                        if (!gb || gb.boundingBox !== 'block') continue;                  // need solid floor
                        if (!isAir(ab) || !skyOpen(air)) continue;                        // open cell + clearance
                        if (air.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position) > 4.2) continue;
                        const needDirt = !PLANTABLE.test(gb.name || '');
                        if (needDirt && !_hasDirt()) continue;
                        return { air, ground, needDirt };
                    }
                }
                return null;
            };
            // ★C300 badlands no-dirt gap (T-0030): mesa surface = red_sand/terracotta (NOT plantable) and
            // carried dirt can be 0 → no spot ever qualifies → sapling-grow always fails → bot camps a
            // treeless plateau forever (nearest=NONE, deaths climb). The OLD code only checked inventory
            // for dirt and gave up. Before giving up, HARVEST a nearby plantable block (grass_block→dirt /
            // dirt / coarse_dirt — common at the badlands/plateau/forest edge) within arm's reach to obtain
            // soil, then re-scan. If none is reachable (pure mesa) it returns false → existing relocate runs.
            const _harvestDirtNearby = async () => {
                try {
                    const SOIL = /grass_block|^dirt$|^coarse_dirt$|rooted_dirt|podzol/;
                    let best = null, bd = Infinity;
                    for (let dx = -4; dx <= 4; dx++) for (let dy = -3; dy <= 2; dy++) for (let dz = -4; dz <= 4; dz++) {
                        const b = bot.blockAt(me.offset(dx, dy, dz));
                        if (!b || !SOIL.test(b.name || '')) continue;
                        const d = bot.entity.position.offset(0, 1.6, 0).distanceTo(b.position.offset(0.5, 0.5, 0.5));
                        if (d <= 4.6 && d < bd) { bd = d; best = b; }
                    }
                    if (!best) return false;
                    const _dirtCt = () => bot.inventory.items().reduce((s, i) => s + (/^dirt$|^coarse_dirt$/.test(i.name || '') ? i.count : 0), 0);
                    const had = _dirtCt();
                    _dbg(`★C300 no plantable ground + dirt=0 → harvesting ${best.name}@${best.position.x},${best.position.y},${best.position.z} (${bd.toFixed(1)}b) for sapling soil`);
                    // ★C303 walk ADJACENT to the soil block before digging — digging at 2-4b range drops the
                    // dirt where the bot isn't standing, and the at-range sweep failed to collect it (live
                    // 15:07: "dirt harvest FAILED — drop not collected"). Standing next to it = drop at feet.
                    if (bd > 2.0) { try { await skills.goToPosition(bot, best.position.x, best.position.y, best.position.z, 1); } catch (e) {} }
                    try { await bot.tool.equipForBlock(best); } catch (e) {}
                    if (bot.heldItem && /_sword$/.test(bot.heldItem.name)) { try { await bot.unequip('hand'); } catch (e) {} }
                    try { await bot.dig(best); } catch (e) { return false; }
                    await _sweepDrops(5, 4);
                    const got = _dirtCt() > had;
                    _dbg(`★C300 dirt harvest ${got ? 'OK' : 'FAILED (drop not collected)'} — dirt now ${_dirtCt()}`);
                    return got;
                } catch (e) { _dbg(`★C300 dirt harvest err: ${String(e.message).slice(0, 50)}`); return false; }
            };
            let spot = findSpot();
            if (!spot && !_hasDirt() && await _harvestDirtNearby()) spot = findSpot();
            if (!spot) { bot._saplingGrowUntil = Date.now() + 20000; return false; }
            _dbg(`sapling-grow: planting ${sap.name} @${spot.air.x},${spot.air.y},${spot.air.z} needDirt=${spot.needDirt} (no reachable natural tree)`);
            try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
            try { bot.clearControlStates(); } catch (_) {}
            // 1) ensure plantable ground — drop a dirt block into the cell, plant one above it
            if (spot.needDirt) {
                const _dirtItem = bot.inventory.items().find(i => /^dirt$|^coarse_dirt$/.test(i.name || ''));   // ★C300 place whichever soil we carry/harvested
                if (!await _placeConfirmed(_dirtItem ? _dirtItem.name : 'dirt', spot.air, 'sapling-dirt')) { bot._saplingGrowUntil = Date.now() + 20000; return false; }
                spot.ground = spot.air; spot.air = spot.air.offset(0, 1, 0);
                if (!isAir(bot.blockAt(spot.air)) || !skyOpen(spot.air)) { bot._saplingGrowUntil = Date.now() + 20000; return false; }
            }
            // 2) plant the sapling (confirm by NAME — sapling boundingBox is 'empty', not 'block')
            try { await bot.equip(sap, 'hand'); } catch (e) {}
            try { await skills.placeBlock(bot, sap.name, spot.air.x, spot.air.y, spot.air.z, 'bottom', true); }
            catch (e) { _dbg(`sapling place err: ${String(e.message).slice(0, 60)}`); }
            const pb = bot.blockAt(spot.air);
            if (!(pb && /_sapling$/.test(pb.name || ''))) { bot._saplingGrowUntil = Date.now() + 20000; return false; }
            _dbg(`sapling planted @${spot.air.x},${spot.air.y},${spot.air.z}`);
            // 3) bonemeal to grow now — craft bone→bone_meal (no table) if we have none
            const getBoneMeal = () => bot.inventory.items().find(i => i.name === 'bone_meal');
            if (!getBoneMeal()) {
                const bone = bot.inventory.items().find(i => i.name === 'bone');
                if (bone) {
                    try {
                        const bmId = bot.registry.itemsByName.bone_meal && bot.registry.itemsByName.bone_meal.id;
                        const rec = bmId != null ? (bot.recipesFor(bmId, null, 1, null) || [])[0] : null;
                        if (rec) await bot.craft(rec, bone.count, null);
                    } catch (e) { _dbg(`bone→meal craft err: ${String(e.message).slice(0, 50)}`); }
                }
            }
            let grew = false;
            for (let k = 0; k < 8; k++) {
                const bm = getBoneMeal();
                const sb = bot.blockAt(spot.air);
                if (sb && /_log$/.test(sb.name || '')) { grew = true; break; }
                if (!bm || !sb || !/_sapling$/.test(sb.name || '')) break;
                try { await bot.equip(bm, 'hand'); } catch (e) {}
                try { await bot.lookAt(spot.air.offset(0.5, 0.5, 0.5), true); await bot.activateBlock(sb); }
                catch (e) { _dbg(`bonemeal err: ${String(e.message).slice(0, 50)}`); }
                await new Promise(r => setTimeout(r, 240));
                const after = bot.blockAt(spot.air);
                if (after && /_log$/.test(after.name || '')) { grew = true; break; }
            }
            bot._saplingGrowUntil = Date.now() + (grew ? 4000 : 30000);
            _dbg(`sapling-grow done: grew=${grew} (re-scanning for tree)`);
            return true;
        } catch (e) { _dbg(`sapling-grow fail: ${String(e.message).slice(0, 60)}`); bot._saplingGrowUntil = Date.now() + 30000; return false; }
    };
    const target = total() + count;
    let stale = 0, surfaced = 0;
    let _stairDir = null;   // LOCKED dig-out direction (set on first pinned stall, reused all call)
    let _stoneAborts = 0;   // NOPICK-FAMINE: stone-face aborts this call; ≥4 = all headings stone → bare-hand climb
    // ★缰绳锚点 (220复盘: v1锚在bed.json,但那是幽灵床坐标 — 床丢了文件还在,圈心错位80格
    // → -157,112 算出来"在圈内",缰绳没绷). 锚 = bed.json(家应该在的位置) ,半径收紧80。
    let _ax = 0, _az = 0, _pulledHome = false;
    try { const bj = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'bed.json'), 'utf8')); if (typeof bj.x === 'number') { _ax = bj.x; _az = bj.z; } } catch (e) {}
    // ghost-bed guard (C39 同款,第三处): 死276后 bed.json 还是崖壁区老床(96,-34),缰绳
    // 回拉会把 bot 拉回被诅咒地形 → 距床>60 用 spawn_pos(真锚,且 spawn 高地有树)
    try { if (Math.hypot(_ax - bot.entity.position.x, _az - bot.entity.position.z) > 60) { const sj = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'spawn_pos.json'), 'utf8')); if (typeof sj.x === 'number') { _ax = sj.x; _az = sj.z; } } } catch (e) {}
    for (let i = 0; i < count * 5 && total() < target; i++) {
        // honor death/stop — an immortal chop loop orphans across respawn and fights the
        // replacement instance (same class as the digToSurface dual-loop wedge)
        if (bot.death_abort || bot.health <= 0) { _dbg(`chopWood ABORT (death) at iter${i}`); return total(); }
        if (bot._chopGen !== _gen) { _dbg(`chopWood YIELD (superseded gen${_gen}→${bot._chopGen}) at iter${i}`); return total(); }
        await _ensureInvRoom();   // ★C299 free a slot BEFORE chopping — a full inventory silently voids every pickup (logs land, can't be stored, total stays 0)
        if (!_opts.needLogs && !_opts.allowCriticalForage && _planksEq() >= 8) {
            _motion('chopWood.wood_eq_satisfied', { where: 'mainLoop', iter: i, logs: total(), planksEq: _planksEq(), target });
            _dbg(`chopWood BAIL (woodEq=${_planksEq()} already enough, logs=${total()}/${target}) — no optional tree route`);
            return total();
        }
        if (Date.now() < (bot._maroonedWoodHandoffUntil || 0)) {
            if (await _maroonedLocalHarvest(i)) { stale = 0; continue; }
        }
        // ★MAROONED 让位 (打转终极一环,act_trace实拍: mobility行军把bot从x112修路推进到
        // x123,20秒后vitals又回x112 — chopWood的LEASH远征/unstick/moveAway与行军拔河。
        // missionNether的STAND-DOWN只在它的iter开头查,而chopWood一进来就是分钟级控制流,
        // 检查形同虚设): 被困态=行军独占身体,砍树循环整体让位,状态机宣布FREE再回来。
        if (bot._mobility && bot._mobility.state === 'MAROONED') {
            if (await _maroonedLocalHarvest(i)) { stale = 0; continue; }
            _dbg(`chopWood BAIL (MAROONED) at iter${i} — march owns movement`);
            return total();
        }
        // ★危殆让位 (hp0.6事件: bot 半血都不到还在雷区里推进爬升找树,overseer 的 evac 警报
        // 发了2分钟没有消费点 — 人类残血绝不继续作业): hp≤6 → 立即归还控制,编排层
        // (prepNether/missionNether) 持有生存路径(蹲坑/进食/evac/advisory消费)。
        // bail线 6→4 (hp6/food0 死水局: 保命线锁死回血路径——hp6 不作业就永远 hp6,
        // 每夜赌命。木头→工具→武器→猎食 才是回血链,hp5-6 的低险作业收益>风险)
        if (bot.health <= 4 && !_criticalForageAllowed()) { _dbg(`chopWood BAIL (critical hp ${bot.health.toFixed(1)}) at iter${i} — yield to survival`); return total(); }
        if (bot.health <= 4) { _dbg(`chopWood CRITICAL-FORAGE allowed hp=${bot.health.toFixed(1)} food=${bot.food} hostiles=0 daylight — controlled forage instead of starvation deadlock`); }
        if (_lowHpHostileYield()) {
            _motion('chopWood.low_hp_hostile_yield', { where: 'mainLoop', iter: i, logs: total(), target, hp: Math.round(bot.health || 0), food: bot.food });
            _dbg(`chopWood BAIL (hp=${bot.health.toFixed(1)} + hostile near) at iter${i} — yield to survival`);
            try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
            try { bot.clearControlStates(); } catch (e) {}
            return total();
        }
        if (_needsFoodYield()) {
            _motion('chopWood.low_food_yield', { where: 'mainLoop', iter: i, logs: total(), target });
            _dbg(`chopWood LOW-FOOD BAIL food=${bot.food}, no edible at iter${i} — feedUp owns the next move`);
            try { bot.pathfinder && bot.pathfinder.stop(); } catch (e) {}
            try { bot.clearControlStates(); } catch (e) {}
            return total();
        }
        // ★夜不猎树 (219: 白天开始的砍树跑过黄昏继续夜猎,黄昏漫游路上被蜘蛛逮住 — chopWood
        // 自己没有夜晚意识,外层夜门只拦"新发起"的砍树): exposed surface + night → bail,
        // the orchestrator's hold owns the night; the hunt resumes at dawn.
        try {
            const _t = bot.time.timeOfDay;
            // enclosed(封闭地穴,mobility状态机全知判定)豁免夜门: 全实心包围里夜=昼,
            // 凿崖/挖隧道不必因为天黑停手(用户指点,与 sp.shouldNightShelter 同款豁免)
            if (_t >= 13000 && _t <= 23000 && bot.entity.position.y >= 50 && !(bot._mobility && bot._mobility.enclosed)) {
                await _sweepDrops(6, 4);   // 撤退前先把脚边掉落捡完 — 别给世界留垃圾
                _dbg(`chopWood NIGHT-BAIL at iter${i} (night+exposed, hold owns it)`);
                return total();
            }
        } catch (e) {}
        // ★漫游缰绳 (218/219: 搬迁升级12/22/32无限漂移,两次死在130-170格外的远游路上 — 越远
        // 离庇护越远,夜变/怪窝风险放大): anchor = bed.json(家床) else 世界出生点. 超过120格
        // 不再继续外漂,转头向锚点方向走30格再继续找树.
        // ★死亡热图避区 (240: 12,-40 杀人井第三次得手,这次是砍树过境跌入 — 避区检查原本
        // 只在采矿循环): 身处"16格内3+死"雷区 → 背质心撤24格再找树。与 achieve 同款。
        try {
            const dl2 = fs.readFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'death_log.jsonl'), 'utf8').trim().split('\n').slice(-50);
            const meD = bot.entity.position;
            let ndD = 0, cxD = 0, czD = 0;
            for (const ln of dl2) { try { const r = JSON.parse(ln); if (typeof r.x === 'number' && Math.hypot(r.x - meD.x, r.z - meD.z) < 16) { ndD++; cxD += r.x; czD += r.z; } } catch (e) {} }
            if (ndD >= 3) {
                cxD /= ndD; czD /= ndD;
                const dD = Math.hypot(meD.x - cxD, meD.z - czD) || 1;
                if (_opts.criticalForageLocalOnly) {
                    _dbg(`★DEATH-ZONE (${ndD}死/16格内) — critical local forage: no relocation, only reachable drops/leaves`);
                } else {
                    _dbg(`★DEATH-ZONE (${ndD}死/16格内) — 背质心撤24格再找树`);
                    try { await skills.goToPosition(bot, Math.round(meD.x + (meD.x - cxD) / dD * 24), null, Math.round(meD.z + (meD.z - czD) / dD * 24), 3); } catch (e) {}
                }
            }
        } catch (e) {}
        try {
            const me0 = bot.entity.position;
            const distHome = Math.hypot(me0.x - _ax, me0.z - _az);
            // leash trigger widens with tree famine (must match the candidate-ring
            // extension below, or the hard pull cancels the wider roam immediately)
            // ★C269 TREE-DESERT widen (新世界 plains 夜1 实证: 出生点稀树, chopDBG nearest=NONE
            // 持续 → _chopUnreach 恒 0 → famine-widen(≥8 够不着) 永不触发 → leash 80 把逐级远征
            // (16→56b+锁定朝向冲刺) 硬拉回锚点 → 绕圈, 0 木, 夜里手无寸铁链死(deaths 1-3)。机理 gap=
            // "一棵树都没有(nearest=NONE)" 不触发放宽,只有"找到够不着的树" 触发。keepInventory 下
            // 远征廉价: 无木 bootstrap + 已多次 relocate 仍无树(树荒) → 放宽 leash 让果断远征真能走到
            // 远处森林(用户#1=砍谨慎/果断执行)。)
            const _noWoodBootstrap = (() => {
                try {
                    const items = bot.inventory.items();
                    const logs = items.filter(i => /_log$/.test(i.name || '')).reduce((s, i) => s + i.count, 0);
                    const planks = items.filter(i => /_planks$/.test(i.name || '')).reduce((s, i) => s + i.count, 0);
                    return logs === 0 && planks < 4;
                } catch (e) { return false; }
            })();
            // ★C275-fix: `stale` RESETS every chopWood invocation, so requiring stale>=2
            // here meant a fresh re-entry that starts already >80b out (after the bot drifted
            // toward distant trees across calls) sees stale=0 → _treeDesert=false → _pullR=80 →
            // HARD-PULLED back at 80b, never reaching plateau/forest trees (wooded_badlands river
            // valley: chopDBG nearest=NONE total=0, leash yanks at 90b every call). For a no-wood
            // bootstrap bot, widening is ALWAYS correct (keepInventory makes expedition cheap —
            // C269's own rationale). Drop the per-call stale gate; widen whenever we have no wood.
            const _treeDesert = _noWoodBootstrap;
            const _pullR = _treeDesert ? 256 : ((bot._chopUnreach && bot._chopUnreach.size >= 8) ? 160 : 80);
            if (distHome > _pullR && !_pulledHome) {
                if (_criticalForageAllowed()) {
                    _pulledHome = true;
                    _dbg(`chopWood LEASH SKIP: critical forage y=${Math.floor(bot.entity.position.y)} dist=${Math.round(distHome)} — food rescue must not raw-walk/coffin back to anchor`);
                } else if (_highOpenSurface()) {
                    _pulledHome = true;
                    _dbg(`chopWood LEASH SKIP: high/free surface y=${Math.floor(bot.entity.position.y)} dist=${Math.round(distHome)} — don't raw-walk back into mine/shaft`);
                } else {
                // ★一次性硬回拉 (v2的40格软拉被各种中断打成了越拉越远115→168,20min零木头):
                // 圈外直接全程走回锚点附近,90s timebox,本次调用只拉一次 — 拉完树自然可见。
                _pulledHome = true;
                _dbg(`chopWood LEASH: ${Math.round(distHome)}格离锚(${_ax},${_az}) — 硬回拉至锚点`);
                try {
                    await Promise.race([
                        skills.goToPosition(bot, _ax, null, _az, 8),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('leash-timeout')), 90000)),
                    ]);
                } catch (e) { try { bot.pathfinder.stop(); } catch (_) {} try { bot.clearControlStates(); } catch (_) {} }
                // ★raw-walk fallback (the cliff-pendulum: pathfinder NoPaths instantly on
                // cliff terrain — worse now that bare-hand dig-costs price out tunnel
                // routes — so the "hard pull" did NOTHING and the bot sat in a barren
                // cliff pocket for a day: 8 trees blacklisted, no food, no progress).
                // If the pull didn't actually move us, sprint-walk toward the anchor in a
                // short probed hop; repeated chopWood calls inch us home through terrain
                // the planner refuses.
                try {
                    const me9 = bot.entity.position;
                    if (Math.hypot(me9.x - _ax, me9.z - _az) > distHome - 6) {
                        let vx = _ax - me9.x, vz = _az - me9.z;
                        const L9 = Math.hypot(vx, vz) || 1; vx /= L9; vz /= L9;
                        // hole probe: no floor within 4 below the next 2 cells → don't blind-march
                        const holey9 = [[vx * 1.2, vz * 1.2], [vx * 2.2, vz * 2.2]].some(([fx, fz]) => {
                            for (let dd = 0; dd <= 4; dd++) {
                                const fb = bot.blockAt(me9.offset(fx, -dd, fz));
                                if (fb && (fb.boundingBox === 'block' || /water/.test(fb.name || ''))) return false;
                            }
                            return true;
                        });
                        if (!holey9) {
                            _dbg(`LEASH raw-walk fallback toward anchor (pathfinder refused)`);
                            try { await bot.lookAt(me9.offset(vx * 8, 1.6, vz * 8), true); } catch (e) {}
                            bot.setControlState('forward', true); bot.setControlState('sprint', true); bot.setControlState('jump', true);
                            await new Promise(r => setTimeout(r, 5000));
                            try { bot.clearControlStates(); } catch (_) {}
                            // ★WALLED IN (the cliff-alcove deadlock: raw walk fired twice and
                            // moved ZERO blocks — anchor side is a 15-block stone face, and
                            // the material gate rightly refuses bare-hand chewing): a human
                            // with 19 blocks in the bag just PILLARS over the lip. Rise 3
                            // with carried filler (jump-place under feet, apex-gated like
                            // digToSurface's MLG pillar), then next call's raw walk crests.
                            if (bot.entity.position.distanceTo(me9) < 2) {
                                // ESCAPE PASS 1 — any open side. The raw walk only tried the
                                // ANCHOR heading; but we WALKED into this alcove, so a doorway
                                // exists on some other side. Find a 2-high opening with floor
                                // and step out — leaving the coffin beats beelining the anchor.
                                let escaped = false;
                                for (const [ex, ez] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                                    const m0 = bot.entity.position.floored();
                                    const open = (b) => !b || b.boundingBox !== 'block';
                                    if (!open(bot.blockAt(m0.offset(ex, 0, ez))) || !open(bot.blockAt(m0.offset(ex, 1, ez)))) continue;
                                    // floor within 7: a 4-6 block drop costs 1-4 hp — at hp10 that
                                    // beats staying entombed (the alcove's only open side is a ledge,
                                    // and the strict 4-block probe rejected the ONLY exit for a day).
                                    let floor9 = false;
                                    for (let dd = 1; dd <= 7; dd++) { const fb = bot.blockAt(m0.offset(ex, -dd, ez)); if (fb && (fb.boundingBox === 'block' || /water/.test(fb.name || ''))) { floor9 = true; break; } }
                                    if (!floor9) continue;
                                    try { await bot.lookAt(m0.offset(ex + 0.5, 1.6, ez + 0.5), true); } catch (e) {}
                                    bot.setControlState('forward', true); bot.setControlState('sprint', true); bot.setControlState('jump', true);
                                    await new Promise(r => setTimeout(r, 2500));
                                    try { bot.clearControlStates(); } catch (_) {}
                                    if (bot.entity.position.floored().distanceTo(m0) >= 1.5) { escaped = true; _dbg(`LEASH escaped alcove via ${ex},${ez}`); break; }
                                }
                                // ESCAPE PASS 2a — STAIR-PLACE (deterministic, replaces the racy
                                // self-pillar as primary): placing a block in the cell you occupy
                                // is a race against the server's hitbox check — apex +1.20 and a
                                // ±0.2 centering gate STILL got "blockUpdate did not fire" (0.2 +
                                // 0.3 half-width = exactly on the cell border). Instead place a
                                // block in an ADJACENT cell at foot height (no body conflict ever),
                                // then step up onto it: +1 per round, zero races.
                                if (!escaped) {
                                    const sc0 = bot.entity.position.floored();
                                    const fillS = bot.inventory.items().find(it => /^dirt$|cobblestone|cobbled|granite|andesite|diorite|^stone$|tuff|gravel|_planks$|_log$/.test(it.name));
                                    if (fillS) {
                                        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                                            const open = (b) => !b || b.boundingBox !== 'block';
                                            if (!open(bot.blockAt(sc0.offset(dx, 0, dz)))) continue;   // need air at foot height to place into
                                            if (!open(bot.blockAt(sc0.offset(dx, 1, dz)))) continue;   // body space after stepping up
                                            if (!open(bot.blockAt(sc0.offset(dx, 2, dz)))) continue;   // head space after stepping up
                                            // ★BODY-CLEARANCE (death #271: the open() checks see BLOCKS,
                                            // not the bot's own hitbox — straddling the cell border got the
                                            // block placed INTO the body → suffocation, and bare-hand
                                            // cobble digging (7.5s) loses to suffocation damage (~6s at
                                            // hp10). Never place into a cell our hitbox is within 0.85 of.)
                                            {
                                                const bp = bot.entity.position;
                                                if (Math.hypot(bp.x - (sc0.x + dx + 0.5), bp.z - (sc0.z + dz + 0.5)) < 0.85) continue;
                                            }
                                            const targetS = sc0.offset(dx, 0, dz);
                                            if (!(await _placeConfirmed(fillS.name, targetS, `leash-stair-place ${dx},${dz}`))) continue;
                                            await _ascendStep(dx, dz, 'leash-stair-place');
                                            const nowF = bot.entity.position.floored();
                                            _dbg(`LEASH stair-step (${dx},${dz}): y ${sc0.y}→${nowF.y}`);
                                            if (nowF.y > sc0.y) { escaped = true; }   // rose a level — re-run LEASH next call from up there
                                            break;
                                        }
                                    }
                                }
                                // ESCAPE PASS 2b — legacy self-pillar (kept as fallback when no
                                // adjacent cell qualifies; the racy place rarely lands but costs little).
                                if (!escaped) {
                                    _dbg(`LEASH walled-in → pillar up 3 with carried blocks`);
                                    for (let pu = 0; pu < 3; pu++) {
                                        const fillL = bot.inventory.items().find(it => /^dirt$|cobblestone|cobbled|granite|andesite|diorite|^stone$|tuff|gravel|_planks$|_log$/.test(it.name));
                                        if (!fillL) break;
                                        const yb = bot.entity.position.y;
                                        const hL = bot.blockAt(bot.entity.position.offset(0, 2, 0));
                                        if (hL && hL.boundingBox === 'block') {
                                            // ESCAPE PASS 3 — true coffin (walls + overhang +
                                            // material gate refusing stone). Last resort: chew ONE
                                            // ceiling block bare-handed per call. Slow (~60s) and it
                                            // fires the BARE-HAND alarm — which is correct: the
                                            // supervisor SHOULD see a coffin escape in progress.
                                            _dbg(`LEASH coffin: overhang above — bare-hand chewing 1 ceiling block (last resort)`);
                                            if (!hasPick() && STONY_BLOCK.test(hL.name || '')) {
                                                try { bot._plannedNoPickStoneUntil = Date.now() + 15000; } catch (e) {}
                                            }
                                            await guardedDig(hL, 'leash-coffin');
                                            // ★continue, NOT break (the alcove perpetual-motion machine,
                                            // exposed by act_trace: pillar jumps only reached +0.4 —
                                            // capped by the very ceiling block we'd chewed earlier,
                                            // because bunkerDown RE-CAPS that same cell every night/mob
                                            // pass and the old break exited before jumping. Chew → jump
                                            // → place in ONE round, before anything re-caps it.)
                                            continue;
                                        }
                                        try { await _centerOnBlock(); } catch (e) {}
                                        // ★centering check (why C22 still failed here: jump apex was
                                        // +0.74, never reaching the +1.01 vacate line — the alcove wall
                                        // blocks the centering shuffle, the off-center hitbox clips the
                                        // NEIGHBOR cell's overhang at y+2 and the jump caps early). If
                                        // we couldn't center, don't waste the jump: chew ONE overhang
                                        // ring block instead, then retry next round with headroom.
                                        {
                                            const pc = bot.entity.position;
                                            const offC = Math.hypot(((pc.x % 1) + 1) % 1 - 0.5, ((pc.z % 1) + 1) % 1 - 0.5);
                                            if (offC > 0.2) {   // aligned with the 0.2 place gate — no dead zone between thresholds
                                                const m1 = pc.floored();
                                                for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                                                    const ob = bot.blockAt(m1.offset(ox, 2, oz));
                                                    if (ob && ob.boundingBox === 'block' && !/water|lava/.test(ob.name)) {
                                                        _dbg(`LEASH pillar: off-center (${offC.toFixed(2)}) → chewing overhang ${ob.name}@${ox},2,${oz}`);
                                                        if (!hasPick() && STONY_BLOCK.test(ob.name || '')) {
                                                            try { bot._plannedNoPickStoneUntil = Date.now() + 15000; } catch (e) {}
                                                        }
                                                        await guardedDig(ob, 'leash-overhang');
                                                        break;   // one per round — stay inside the breaker window
                                                    }
                                                }
                                            }
                                        }
                                        try { await bot.equip(fillL, 'hand'); } catch (e) {}
                                        const refL = bot.blockAt(bot.entity.position.offset(0, -1, 0));
                                        try { await bot.lookAt(bot.entity.position.offset(0, -1, 0), true); } catch (e) {}
                                        // ★PLACE-WINDOW FIX (the long-hidden pillar bug, finally caught by
                                        // the ERR log: "blockUpdate (x,65,z) did not fire" = the SERVER
                                        // REJECTED the place because the bot's own hitbox still occupied
                                        // the target cell). A jump peaks at +1.25 around ~290ms; the old
                                        // fixed 380ms wait checked AFTER the apex, when the body had sunk
                                        // back into the cell. The cell is only fully vacated while
                                        // y > start+1.01 — a ~200ms window. Poll for it and place THEN.
                                        let placedL = false, hi = yb, perr = '';
                                        const tJ = Date.now();
                                        const standCell = bot.entity.position.floored();
                                        if (skills.placeBlockUnderFeet) {
                                            placedL = await skills.placeBlockUnderFeet(bot, fillL.name, { retries: 1, settleMs: 160 }).catch(e => { perr = e.message; return false; });
                                            hi = Math.max(hi, bot.entity.position.y);
                                        } else {
                                            bot.setControlState('jump', true);
                                            while (Date.now() - tJ < 700 && !placedL) {
                                                const cp = bot.entity.position, cy = cp.y;
                                                if (cy > hi) hi = cy;
                                                // ★HITBOX-CENTERED check (the FINAL piece: apex cleared +1.17
                                                // yet the server still refused — at x=40.7 the 0.6-wide hitbox
                                                // straddles cells 40 AND 41, so the target cell was never fully
                                                // vacated. Only place when we're within 0.2 of the cell center
                                                // at the moment of placement.)
                                                const ctr = Math.abs(cp.x - (standCell.x + 0.5)) < 0.2 && Math.abs(cp.z - (standCell.z + 0.5)) < 0.2;
                                                if (cy > yb + 1.01 && ctr) {
                                                    try { if (refL && Vec3) { await bot.placeBlock(refL, new Vec3(0, 1, 0)); placedL = true; } } catch (e) { perr = e.message; }
                                                }
                                                if (!placedL) await new Promise(r => setTimeout(r, 30));
                                            }
                                        }
                                        bot.setControlState('jump', false);
                                        await new Promise(r => setTimeout(r, 200));
                                        _dbg(`LEASH pillar pu=${pu}: placed=${placedL} apex=+${(hi - yb).toFixed(2)} nowY=${bot.entity.position.y.toFixed(1)}${perr ? ' ERR=' + perr.slice(0, 60) : ''}`);
                                    }
                                }
                            }
                        } else {
                            _dbg(`LEASH raw-walk ABORT (hole ahead toward anchor)`);
                        }
                    }
                } catch (e) {} finally { try { bot.clearControlStates(); } catch (_) {} }
                }
            }
        } catch (e) {}
        const before = total();
        // Find nearest log of any type — but consider MULTIPLE candidates per type and SKIP any
        // tree on the unreachable-blacklist, so a lone unreachable trunk doesn't trap us: we fall
        // through to the next-nearest reachable tree (or to relocate if all nearby are blacklisted).
        // bot.findBlocks returns many coords (getNearestBlock returns only the single closest, which
        // is exactly what kept handing us back the same unreachable tree every pass).
        let nearest = null, ndist = Infinity, nearestAnyDist = Infinity, nearestAnyDy = 0;   // nearestAny = closest detected tree INCLUDING blacklisted (cost model: don't plant a sapling when a real tree is right here)
        // ★TREE-FAMINE leash extension: with 8+ trees blacklisted (all unreachable
        // jungle canopies), an 80-block leash re-scans the same dead orchard forever —
        // the whole rebuild is gated on ONE log. Famine (blacklist≥8) temporarily
        // widens the visible ring to 160; first successful chop shrinks it back (the
        // blacklist empties as TTLs expire after we leave the area).
        const _leashR = _unreach.size >= 8 ? 160 : 80;
        let riskySkipped = 0;
        // ★C297 TRUNK-BASE targeting (用户实拍根因: 雨林高树 — findBlocks 返回的"最近 log"常是树冠高处
        // 那截 (dy>5) → riskyTree 判 high-tree 跳过 → 拉黑 → 误当够不到 → 退化乱转/种苗,而那棵树的树干
        // 基部就在地面、完全可达,只是瞄错了目标). 修复: 对每个候选 log,沿其 x,z 列向下扫到最低的连续
        // log = 树干基部,用基部的距离/落差/可达性来判定与导航,而不是检测到的树冠 log. 这样雨林高树变可达,
        // sapling fallback 根本不触发. mesa 高原仍正确跳过 — 那里整列都在台顶,基部 y 也高、落差仍 >5.
        const _isLog = (b) => b && /(_log|_wood|_stem)$/.test(b.name || '');
        const _trunkBase = (p) => {
            try {
                const bx = Math.floor(p.x), bz = Math.floor(p.z);
                let by = Math.floor(p.y);
                for (let k = 0; k < 40; k++) {
                    if (_isLog(bot.blockAt(new Vec3(bx, by - 1, bz)))) { by--; continue; }
                    break;
                }
                return new Vec3(bx + 0.5, by, bz + 0.5);
            } catch (e) { return p; }
        };
        const riskyTree = (p, d) => {
            if (_criticalForageAllowed()) return '';
            const dy = p.y - bot.entity.position.y;
            if (d > 4.8 && dy > 5) return 'high-tree';
            if (d > 4.8) {
                for (let ox = -2; ox <= 2; ox++) {
                    for (let oz = -2; oz <= 2; oz++) {
                        for (let oy = -2; oy <= 1; oy++) {
                            const b = bot.blockAt(new Vec3(Math.floor(p.x) + ox, Math.floor(p.y) + oy, Math.floor(p.z) + oz));
                            if (b && /water|lava/.test(b.name || '')) return 'water-edge';
                        }
                    }
                }
            }
            return '';
        };
        for (const t of LOGS) {
            const id = bot.registry && bot.registry.blocksByName[t] ? bot.registry.blocksByName[t].id : null;
            let cands = [];
            if (id != null) { try { cands = bot.findBlocks({ matching: id, maxDistance: 40, count: 16 }) || []; } catch (e) { cands = []; } }
            if (!cands.length) { const b = world.getNearestBlock(bot, t, 40); if (b) cands = [b.position]; }  // fallback
            for (const p of cands) {
                const base = _trunkBase(p);                    // ★C297 resolve to trunk base (ground), not the detected canopy log
                const key = `${Math.floor(base.x)},${Math.floor(base.y)},${Math.floor(base.z)}`;
                if (Math.hypot(base.x - _ax, base.z - _az) > _leashR) continue;   // 缰绳源头过滤(树荒时放宽)
                const d = bot.entity.position.distanceTo(base);
                if (d < nearestAnyDist) { nearestAnyDist = d; nearestAnyDy = base.y - bot.entity.position.y; }   // closest tree even if blacklisted — feeds the cost model below
                if (_blk(key)) continue;                       // skip blacklisted unreachable tree
                if (_opts.criticalForageLocalOnly && (d > 10.5 || (base.y - bot.entity.position.y) > 5)) continue;
                const risk = riskyTree(base, d);
                if (risk) { riskySkipped++; continue; }
                if (d < ndist) { ndist = d; nearest = { b: bot.blockAt(base), t, key, drop: Math.round(p.y - base.y) }; }   // drop = how far the canopy log was lowered to its base (★C297 evidence)
            }
        }
        _dbg(`iter${i} y=${Math.floor(bot.entity.position.y)} nearest=${nearest ? nearest.t + '@' + ndist.toFixed(1) + 'b' + (nearest.drop > 1 ? `↓${nearest.drop}(★C297base)` : '') : 'NONE'} total=${total()} stale=${stale} surfaced=${surfaced} blk=${_unreach.size} riskySkip=${riskySkipped}`);
        // ★C342 (T-0055, composes with C339): a CLOSE trunk we can't SEE is leaf-occluded — C339 now
        // (rightly) refuses to x-ray-chop it, but the HUMAN fix is to CLEAR the intervening leaves, not
        // give up → blacklist. Dig the nearest reachable occluding leaf (leaves are NOT gated by C339)
        // until the trunk is visible, THEN the normal approach/chop passes the gate. Bounded (≤6 leaves,
        // only when trunk ≤5.5b + occluded) so it can't loop. This closes the dense-jungle reach residual.
        if (nearest && nearest.b && nearest.b.position && ndist <= 5.5) {
            try {
                const _tk = nearest.b;
                const _see = () => { try { return bot.canSeeBlock(_tk); } catch (e) { return true; } };
                if (!_see()) {
                    const _eye = () => bot.entity.position.offset(0, 1.6, 0);
                    let _cleared = 0;
                    for (let pass = 0; pass < 6 && !_see(); pass++) {
                        let best = null, bestD = 1e9;
                        const tp = _tk.position;
                        for (let dx = -3; dx <= 3; dx++) for (let dy = -1; dy <= 4; dy++) for (let dz = -3; dz <= 3; dz++) {
                            const lb = bot.blockAt(tp.offset(dx, dy, dz));
                            if (!lb || !/_leaves$/.test(lb.name || '')) continue;
                            const dR = _eye().distanceTo(lb.position.offset(0.5, 0.5, 0.5));
                            if (dR > 4.4) continue;                 // must be in genuine reach to dig (no x-ray)
                            if (dR < bestD) { bestD = dR; best = lb; }
                        }
                        if (!best) break;                            // no reachable occluding leaf from here → let approach/climb handle it
                        if (!(await guardedDig(best, 'clear-occluding-leaf'))) break;
                        _cleared++;
                    }
                    if (_cleared) _dbg(`★C342 cleared ${_cleared} occluding leaf(s) → trunk ${nearest.t}@${ndist.toFixed(1)}b ${_see() ? 'now VISIBLE (chop can proceed)' : 'still occluded (approach/climb next)'}`);
                }
            } catch (e) {}
        }
        // ★C295: GROW OWN TREE when natural trees are SEEN but all UNREACHABLE. The C279 sapling-grow
        // (1574) only fired on nearest=NONE (truly barren); but a wooded_badlands/mesa surrounds the
        // bot with trees on plateau TOPS it can't climb pickless — each blacklists on 树柱fails, nearest
        // is never null, so it thrashed forever chasing unclimbable trees and NEVER grew its own (live
        // 2026-06-20: pickless in wooded_badlands, oak_log@23b but 树柱fails×∞, 0 logs all day, deaths
        // 53→92). When ≥4 trees are confirmed unreachable and we carry a sapling, grow our OWN reachable
        // tree NOW (≤cooldown) instead of chasing plateau trees. _trySaplingGrow self-guards on a
        // plantable sky-open spot, so it no-ops cleanly if the ground/cover won't allow it.
        // ★C296 COST MODEL (用户实拍: 雨林里全是树却到处乱转种树苗=荒谬,缺成本模型). C295 种苗本为
        // mesa 高原(树在够不到的台顶,落差大)兜底;但雨林里树近在咫尺、落差小,只因树冠/藤蔓寻路失败被
        // 拉黑→误当"够不到"→退化到最慢的种苗+乱转. 判别: 最近的树(含拉黑)在 ≤16 格且落差 dy≤5 = 森林,
        // 不是 mesa → 种苗是错的成本(海量真树就在旁边,该去够). 此时不种,清掉近处拉黑让下一拍重试硬够.
        const _forestNear = nearestAnyDist <= 16 && nearestAnyDy <= 5;
        if (total() === 0 && _unreach.size >= 4 && _forestNear && !nearest) {
            if (Date.now() - (bot._chopForestUnblkAt || 0) > 20000) {
                bot._chopForestUnblkAt = Date.now();
                let _cleared = 0;
                for (const k of [..._unreach.keys()]) {
                    const c = k.split(',').map(Number);
                    if (Math.hypot(c[0] - bot.entity.position.x, c[2] - bot.entity.position.z) <= 16) { _unreach.delete(k); _cleared++; }
                }
                _dbg(`★C296 forest (nearest tree @${nearestAnyDist.toFixed(1)}b dy${nearestAnyDy.toFixed(0)}) — NOT planting sapling amid real trees; cleared ${_cleared} close blacklist entries to retry reaching them`);
            }
        } else if (total() === 0 && _unreach.size >= 4 && !_forestNear && Date.now() >= (bot._saplingGrowUntil || 0)
            && bot.inventory.items().some(it => /_sapling$/.test(it.name || ''))) {
            _dbg(`★C295 ${_unreach.size} natural trees unreachable (sparse/high — nearest @${nearestAnyDist === Infinity ? '∞' : nearestAnyDist.toFixed(1)}b dy${nearestAnyDy.toFixed(0)}) + carrying sapling → grow OWN reachable tree`);
            if (await _trySaplingGrow()) { stale = 0; continue; }
        }
        if (_opts.criticalForageLocalOnly && !nearest) {
            _motion('chopWood.critical_local_no_tree', {
                iter: i,
                y: Math.floor(bot.entity.position.y),
                hp: Math.round(bot.health || 0),
                food: bot.food,
                total: total(),
            });
            _dbg(`critical local forage: no reachable local tree; yield without surfacing/roam`);
            try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
            try { bot.clearControlStates(); } catch (_) {}
            return total();
        }
        // ★UNDERGROUND + no REACHABLE tree → SURFACE FIRST (fixes the y28 deadlock). The 40-block
        // scan picks up trees on the SURFACE (e.g. oak_log@38b while at y28), so `nearest` is
        // non-null and the OLD `if(!nearest)` surface-check never fired — the bot just kept failing
        // to path to a tree it can't reach through dozens of blocks of rock (total=0 forever). If
        // we're underground and the nearest log is FAR (>8b → almost surely up top) or we've already
        // stalled on it, dig UP to daylight instead of futilely chasing it.
        const _yNow = Math.floor(bot.entity.position.y);
        let _skyAboveNow = true;
        try {
            const _mNow = bot.entity.position.floored();
            for (let _dd = 2; _dd <= 36; _dd++) {
                const _cb = bot.blockAt(_mNow.offset(0, _dd, 0));
                if (_cb && _cb.boundingBox === 'block') { _skyAboveNow = false; break; }
            }
        } catch (e) { _skyAboveNow = false; }
        const _enclosedNow = !!(bot._mobility && bot._mobility.enclosed);
        const _highSurfaceLike = _highOpenSurface();
        const _notSurface = !_highSurfaceLike && (_yNow < 58 || _enclosedNow || !_skyAboveNow);
        const _nearHighTree = nearest && nearest.b && nearest.b.position
            && ndist <= 12 && (nearest.b.position.y - bot.entity.position.y) >= 4;
        if (!_opts.criticalForageLocalOnly && _nearHighTree && surfaced < 4) {
            const ty = Math.max(Math.floor(bot.entity.position.y) + 4, Math.floor(nearest.b.position.y) - 1);
            _dbg(`near-high-tree y=${_yNow} enclosed=${_enclosedNow} sky=${_skyAboveNow} highSurface=${_highSurfaceLike} tree=${nearest.t}@+${Math.round(nearest.b.position.y - bot.entity.position.y)}y/${ndist.toFixed(1)}b — surface/climb before collectBlock (try ${surfaced + 1})`);
            surfaced++;
            try {
                await Promise.race([
                    skills.customSkill(bot, 'surfaceUp', ty),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('near-high-tree surfaceUp timeout')), 45000)),
                ]);
            }
            catch (e) {
                _dbg(`near-high-tree surfaceUp failed/timeout: ${e.message} — stop body and defer tree`);
                try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
                try { bot.clearControlStates(); } catch (_) {}
                if (nearest && nearest.key) {
                    const _ttl = _ttlFor(nearest.key);
                    _unreach.set(nearest.key, Date.now() + Math.max(_ttl, 120000));
                    _dbg(`blacklist ${nearest.t}@${nearest.key} (surfaceUp-timeout, ttl ${Math.max(_ttl, 120000) / 1000}s)`);
                }
                try { await digToSurface(); } catch (e2) {}
                return total();
            }
            continue;
        } else if (!_opts.criticalForageLocalOnly && _notSurface && surfaced < 4 && (!nearest || ndist > 12 || stale >= 2)) {
            _dbg(`not-surface y=${_yNow} enclosed=${_enclosedNow} sky=${_skyAboveNow} highSurface=${_highSurfaceLike} tree=${nearest ? ndist.toFixed(1) + 'b' : 'none'} unreachable → surfacing (try ${surfaced + 1})`);
            log(bot, `Not on true surface (y=${_yNow}, enclosed=${_enclosedNow}, sky=${_skyAboveNow}, highSurface=${_highSurfaceLike}), no reachable tree — digging up to the surface.`);
            surfaced++;
            let _surfOk = false;
            try { _surfOk = await digToSurface(); } catch (e) { try { await skills.goToSurface(bot); } catch (e2) {} }
            if (!_surfOk && !bot.inventory.items().some(it => /_pickaxe$/.test(it.name)) && Date.now() < (bot._chopNoPickSurfaceBlockedUntil || 0)) {
                _dbg(`surfacing hard-failed in no-pick stone box — return control to mobility`);
                return false;
            }
            if (!_surfOk && bot.food <= 2 && !bot.inventory.items().some(it => /_pickaxe$/.test(it.name))) {
                _dbg(`surfacing hard-failed under famine (food=${bot.food}, no pick) — return control`);
                return false;
            }
            continue;
        }
        if (!nearest) {
            // No trees in range. If we're UNDERGROUND (the bot mines diamonds at
            // y~-50, where there are obviously no trees), shuffling sideways is
            // futile — climb to the surface first. This is what stranded the bot
            // with "3 diamonds but no wood for sticks" deep underground, unable to
            // craft the diamond pickaxe. goToSurface pathfinds up (pillarUp fallback
            // for sheer shafts). Try it a couple of times before giving up.
            if (surfaced < 3 && (Math.floor(bot.entity.position.y) < 62 || _enclosedNow || !_skyAboveNow)) {
                log(bot, `No logs nearby and not on true surface (y=${Math.floor(bot.entity.position.y)}, enclosed=${_enclosedNow}, sky=${_skyAboveNow}) — digging a shaft up to the surface for trees.`);
                surfaced++;
                let _surfOk = false;
                try { _surfOk = await digToSurface(); } catch (e) { log(bot, `digToSurface failed: ${e.message}`); try { await skills.goToSurface(bot); } catch (e2) {} }
                if (!_surfOk && !bot.inventory.items().some(it => /_pickaxe$/.test(it.name)) && Date.now() < (bot._chopNoPickSurfaceBlockedUntil || 0)) {
                    _dbg(`no-log surfacing hard-failed in no-pick stone box — return control to mobility`);
                    return false;
                }
                if (!_surfOk && bot.food <= 2 && !bot.inventory.items().some(it => /_pickaxe$/.test(it.name))) {
                    _dbg(`no-log surfacing hard-failed under famine (food=${bot.food}, no pick) — return control`);
                    return false;
                }
                continue;
            }
            // ★On the surface with NO reachable natural tree → grow our own from a carried
            // sapling BEFORE roaming off to starve (badlands/mesa: only unreachable plateau
            // trees, blk=N). Plants dirt+sapling+bonemeal; on success re-scan finds the tree.
            if (await _trySaplingGrow()) { stale = 0; continue; }
            // No trees in 40-block range and we're at/near the surface — we're in a BARREN
            // or WATER zone (the water-edge spawn: 1hr stuck here, 0 logs). A flat 12-block
            // moveAway never escapes a big water body, and moveAway often can't even path
            // across deep water → the bot wandered in place forever. ESCALATE distance hard
            // (16→28→40→56) AND, if moveAway couldn't actually move us (pinned in water),
            // raw-swim/sprint a committed heading to physically cover ground and break out.
            stale++;
            const dist = stale <= 1 ? 16 : (stale <= 2 ? 28 : (stale <= 3 ? 40 : 56));
            log(bot, `No logs within 40 blocks (x${stale}) — relocating ${dist} blocks to escape the barren/water zone...`);
            const _p0 = bot.entity.position.clone();
            await skills.moveAway(bot, dist).catch(() => {});
            if (bot.entity.position.distanceTo(_p0) < 4) {
                // moveAway made no headway (deep water / pinned) — force a raw traverse.
                // ★LOCKED EXPEDITION HEADING (the quadrant rotation walked N/E/S/W in
                // turn = a plus-sign with ZERO net displacement; the bot orbited the
                // same barren lakeshore for hours). Lock one heading on the bot object
                // (persists across hot-reloads), march it 6s per attempt, and only
                // rotate 90° when THAT heading provably stalls. Cumulative calls walk
                // a straight line out of any famine zone.
                try {
                    if (typeof bot._chopExpYaw !== 'number') bot._chopExpYaw = Math.random() * Math.PI * 2;
                    const yaw = bot._chopExpYaw;
                    const _e0 = bot.entity.position.clone();
                    await bot.look(yaw, 0, true);
                    bot.setControlState('forward', true); bot.setControlState('sprint', true); bot.setControlState('jump', true);
                    await new Promise(r => setTimeout(r, 6000));
                    bot.clearControlStates();
                    if (bot.entity.position.distanceTo(_e0) < 4) bot._chopExpYaw = (yaw + Math.PI / 2) % (Math.PI * 2);   // heading blocked — rotate
                } catch (e) { try { bot.clearControlStates(); } catch (_) {} }
            }
            if (stale >= 8) break; continue;
        }
        // Collect one log of that type (collectBlock pathfinds + digs + picks up).
        // TIMEBOX it: collectBlock can HANG indefinitely pathfinding to a tree it can't
        // reach (trunk on a ledge across water, behind vines), which froze chopWood for
        // minutes inside a single call — the escalating relocate below never ran because
        // the loop never iterated. Race against a timeout; on hang, stop the pathfinder
        // so the next pass can relocate to a reachable grove.
        try {
            // ★veinFollow=true → chop the WHOLE connected tree (flood-fill all connected logs)
            // and pick up every drop, instead of one bottom log then wandering off (用户: "只挖
            // 第一层就走"). harvestConnectedVein walks to + digs + pickupNearbyItems each log.
            // Longer timeout (45s) since a full tree is many logs.
            await Promise.race([
                skills.collectBlock(bot, nearest.t, 1, null, true),
                new Promise((_, rej) => setTimeout(() => rej(new Error('chop-timeout')), 45000)),
            ]);
        } catch (e) {
            try { bot.pathfinder.stop(); } catch (_) {}
            try { bot.clearControlStates(); } catch (_) {}
        }
        if (total() <= before) {
            // ★生走逼近 (黑名单膨胀到33条的根源: 6.8格外平地树被寻路否决,直砍臂展只有
            // 4.5格,差2格就判死刑): 树在12格内 → 不问寻路,探明前方无坑无水后朝它生走
            // 1.5秒,把距离走进臂展再直砍。人类不会因为"导航说不行"放弃走向眼前的树。
            if (nearest && nearest.b && nearest.b.position) {
                const _tD = () => bot.entity.position.distanceTo(nearest.b.position.offset(0.5, 0.5, 0.5));
                if (_tD() > 4.5 && _tD() <= 12 && Math.abs(nearest.b.position.y - bot.entity.position.y) <= 5) {
                    try {
                        const meW = bot.entity.position;
                        const dxW = nearest.b.position.x + 0.5 - meW.x, dzW = nearest.b.position.z + 0.5 - meW.z;
                        const lW = Math.hypot(dxW, dzW) || 1;
                        const uxW = dxW / lW, uzW = dzW / lW;
                        let unsafe = false;   // 前方两格探坑/探水 (与盲冲探针同款)
                        for (const m of [1.2, 2.4]) {
                            let floor = false;
                            for (let dd = 0; dd <= 3; dd++) {
                                const fb = bot.blockAt(meW.offset(uxW * m, -dd, uzW * m));
                                if (fb && /water|lava/.test(fb.name || '')) { unsafe = true; break; }
                                if (fb && fb.boundingBox === 'block') { floor = true; break; }
                            }
                            if (!floor) unsafe = true;
                            if (unsafe) break;
                        }
                        if (!unsafe) {
                            try { await bot.lookAt(nearest.b.position.offset(0.5, 0.5, 0.5), true); } catch (e) {}
                            // ★C270: tree on higher ground (plains/hills, +Ny) → jump while walking so we
                            // CLIMB the slope/step up to it. The flat sprint stalled at ~6.8b on a small hill
                            // (oak@y82, bot@y78) → blacklist → 0 wood, naked night death (new-world dawn1).
                            // A human walks AND jumps up to a tree on a rise; don't abandon a tree in sight.
                            const _climb = (nearest.b.position.y - meW.y) > 0.5;
                            bot.setControlState('forward', true); bot.setControlState('sprint', true);
                            if (_climb) bot.setControlState('jump', true);
                            const tW = Date.now();
                            while (Date.now() - tW < 2500 && _tD() > 4.2) await new Promise(r => setTimeout(r, 150));
                            bot.clearControlStates();
                            _dbg(`raw-approach: ${_tD().toFixed(1)}b after walk${_climb ? ' (jump-climb)' : ''} (was >4.5)`);
                        }
                    } catch (e) { try { bot.clearControlStates(); } catch (_) {} }
                }
            }
            // ★贴脸直砍 (the bootstrap killer: logs 1.6-6 blocks away verdicted
            // "unreachable" — collectBlock's scan predicate lets the pathfinder's
            // safeToBreak veto waterside/edge trees wholesale, so it returns in 0.2s
            // with nothing and we blacklisted tree after tree, naked, at night).
            // A human standing at a tree just chops it: if the log is in ARM'S REACH,
            // bypass the pathfinder verdict entirely — equip, dig, grab drops.
            if (nearest && nearest.b && nearest.b.position
                && bot.entity.position.distanceTo(nearest.b.position.offset(0.5, 0.5, 0.5)) <= 4.5) {
                try {
                    // ★整柱砍 (用户实拍: 直砍v1只挖一根就走→满地浮空半棵树): walk the trunk
                    // COLUMN — drop to the lowest log at this x,z, then dig upward through
                    // every in-reach log. Sweep the drops by stepping on them afterward.
                    const bp = nearest.b.position;
                    let lowDy = 0;
                    while (lowDy > -4) { const b2 = bot.blockAt(bp.offset(0, lowDy - 1, 0)); if (b2 && /_log$|_wood$/.test(b2.name)) lowDy--; else break; }
                    let dug = 0;
                    for (let dy = lowDy; dy <= 8; dy++) {
                        if (bot.interrupt_code || bot.death_abort || bot._chopGen !== _gen) break;
                        const lb = bot.blockAt(bp.offset(0, dy, 0));
                        if (!lb || !/_log$|_wood$/.test(lb.name)) { if (dy > 0) break; else continue; }
                        if (bot.entity.position.offset(0, 1.6, 0).distanceTo(lb.position.offset(0.5, 0.5, 0.5)) > 4.8) break;   // out of arm's reach — stop, don't leave a swing-at-air loop
                        try { await bot.tool.equipForBlock(lb); } catch (e) {}
                        if (bot.heldItem && /_sword$/.test(bot.heldItem.name)) { try { await bot.unequip('hand'); } catch (e) {} }
                        try { await bot.dig(lb); dug++; } catch (e) { break; }
                    }
                    const _sw = await _sweepDrops(8, 6);   // 踩格子捡掉落 — pickupNearbyItems 不够可靠
                    if (dug > 0) _dbg(`direct-chop: dug ${dug} logs (full column) total=${total()} sweep[seen=${_sw.seen} reached=${_sw.reached} near=${_sw.near || '-'}]`);   // ★C298 seen=0→drops not spawning/falling away; seen>0 reached=0→unreachable (dy>1=on leaf canopy above; big h=across gap)
                } catch (e) { _dbg(`direct-chop fail: ${e.message}`); }
                if (total() > before) { stale = 0; continue; }   // it worked — no blacklist
            }
            // ★C323 (T-0055): elevated/terrace tree the flat raw-approach can't climb to (live:
            // bot y65 → oak_log@y68-69 on a 3-block mesa terrace, 12-16b; collectBlock pathfind +
            // 2.5s flat sprint can't scale a multi-block terrace →棵棵 blacklist "unreachable",
            // migrate-to-trees still can't bootstrap). Use the now-capable goToPosition (C319
            // destructive scaffolding pillars up the terrace, C320 partial follows toward the
            // trunk) to GET to the tree base, then loop to direct-chop from there. Timeboxed (can't
            // hang); once per tree per 30s so it can't spin. This is the reachability core of T-0055
            // (C321 only fixed the inv-full sub-cause).
            if (nearest && nearest.b && nearest.b.position && total() <= before) {
                const tb = nearest.b.position;
                const _td0 = bot.entity.position.distanceTo(tb.offset(0.5, 0.5, 0.5));
                const _ck = _colKey(nearest.key);
                const _tried = (bot._chopGotoTriedAt = bot._chopGotoTriedAt || new Map());
                if (_td0 > 12 && _td0 <= 32 && (!_tried.get(_ck) || Date.now() - _tried.get(_ck) > 30000)) {   // ★C323 window 12<d≤32: far plateau trees only. Lower bound 12 (was 4.5) — live a 6.5b elevated tree got DISPLACED to 21.6b by the goToPosition climb (routed around/down a plateau); leave 4.5-12b trees to raw-approach, don't let C323 push the bot AWAY from a near tree.
                    _tried.set(_ck, Date.now());
                    _dbg(`★C323 elevated/far tree @${nearest.key} d=${_td0.toFixed(1)} — goToPosition climb (C319/C320-capable) before blacklist`);
                    try { await Promise.race([skills.goToPosition(bot, tb.x, tb.y, tb.z, 2), new Promise((_, rej) => setTimeout(() => rej(new Error('c323-goto-timeout')), 18000))]); }
                    catch (e) { try { bot.pathfinder.stop(); } catch (_) {} try { bot.clearControlStates(); } catch (_) {} }
                    const _td1 = bot.entity.position.distanceTo(tb.offset(0.5, 0.5, 0.5));
                    if (_td1 < _td0 - 1.5) { _dbg(`★C323 closed ${_td0.toFixed(1)}→${_td1.toFixed(1)}b — retry chop, no blacklist`); stale = Math.max(0, stale - 1); continue; }
                    _dbg(`★C323 no closer (${_td0.toFixed(1)}→${_td1.toFixed(1)}b) — fall through to blacklist (genuinely unreachable)`);
                }
            }
            // No progress this pass. The killer case: weaponless after a death, a
            // skeleton arrows the bot from a ledge it can't path to, and small shuffles
            // keep us in range / in the same water-edge trap (chopWood spun 7 min at 1
            // log here). ESCALATE the relocation distance hard (12 -> 22 -> 32) to break
            // the attacker's line-of-sight/pursuit and reach a different, reachable
            // grove on open ground. Give up sooner so achieveLoop re-enters fresh.
            stale++;
            if (_opts.criticalForageLocalOnly) {
                _dbg(`critical local forage: nearest ${nearest ? nearest.t + '@' + ndist.toFixed(1) + 'b' : 'NONE'} made no progress; yield without relocation/stair`);
                try { bot.pathfinder && bot.pathfinder.stop(); } catch (_) {}
                try { bot.clearControlStates(); } catch (_) {}
                return total();
            }
            // Blacklist this exact tree: it didn't yield a log this pass (unreachable across
            // water / on a ledge, or a mob kept interrupting). Next iter skips it and picks the
            // next-nearest reachable tree instead of handing us back the same trap. Expires in 2min.
            const _deferHighTreeBlacklist = nearest && nearest.b && nearest.b.position
                && (nearest.b.position.y - bot.entity.position.y) >= 6 && stale <= 6;
            let _blacklistedThisPass = false;
            if (nearest && nearest.key) {
                if (_deferHighTreeBlacklist) {
                    _dbg(`defer blacklist ${nearest.t}@${nearest.key} (high tree +${Math.round(nearest.b.position.y - bot.entity.position.y)}y; climb first)`);
                } else {
                    const _ttl = _ttlFor(nearest.key);
                    _unreach.set(nearest.key, Date.now() + _ttl);
                    _dbg(`blacklist ${nearest.t}@${nearest.key} (unreachable, ttl ${_ttl / 1000}s, 树柱fails=${_colFails.get(_colKey(nearest.key))})`);
                    _blacklistedThisPass = true;
                }
            }
            if (_blacklistedThisPass) {
                _stairDir = null;
                stale = 0;
                try { await skills.wait(bot, 200); } catch (e) {}
                continue;
            }
            const dist = stale <= 1 ? 12 : (stale === 2 ? 22 : 32);
            log(bot, `chop stalled (x${stale}) — relocating ${dist} blocks to escape pin/terrain.`);
            const _p0 = bot.entity.position.clone();
            await skills.moveAway(bot, dist).catch(() => {});
            // ★PINNED-IN-PLACE breaker: the real-world trap here is a bot in a low pocket (y66)
            // ringed by trees up a steep hillside (y74-77) it can't path up to — every tree blacklists
            // as unreachable but moveAway makes NO headway (walls/water/cliff pin it), so it never
            // reaches the !nearest raw-traverse path and spins in place forever. If moveAway didn't
            // actually move us, force a committed sprint+jump traverse (rotate heading each stall) to
            // physically break out of the pocket toward flatter, reachable groves. Same primitive the
            // !nearest barren-zone path uses — applied here so a tree-RINGED pin escapes too.
            // ★高树触发补充 (同一棵山顶树16min拉黑循环: 树高+8格,寻路上不去但moveAway能
            // 小挪=永不算"被困"→楼梯永不触发): 目标树高于我8格且连败2轮 → 也走楼梯,
            // 主动凿上山,不必等到被困。
            const _highTree = nearest && nearest.b && nearest.b.position
                && (nearest.b.position.y - bot.entity.position.y) >= 8 && stale >= 2;
            if (bot.entity.position.distanceTo(_p0) < 4 || _highTree) {
                // ★PINNED & WALK-BLOCKED: forced sprint+jump (walk-only) was proven useless here —
                // ENTER pos sat at 18,-39 for 27min while the bot was boxed in a y66 pocket ringed by
                // trees up a y73-77 hillside it couldn't path or walk up. Walking just face-plants the
                // wall. So DIG OUT: carve a staircase TOWARD the nearest (just-failed) tree — clear the
                // foot+head block ahead, the step above (so it becomes a stair), and our own head — then
                // step+jump up. Repeated across stalls this tunnels through the wall and climbs the slope
                // until the hilltop tree is finally reachable. Pure digging, no filler needed (works
                // barehanded; equipForBlock picks the best tool). Never digs water/lava.
                // LOCK the dig-out heading on the FIRST pinned stall and reuse it every stall this
                // call. Earlier each stall re-aimed at whatever tree was nearest → the heading
                // ping-ponged (-1,-1 ↔ 1,-1) so we chipped one diagonal step at each of several
                // directions and y crept up only ~1 block per 30min. A LOCKED heading drives a single
                // consistent staircase up the slope so y climbs steadily to the hilltop trees.
                const tgt = (nearest && nearest.b) ? nearest.b.position : null;
                let dx, dz;
                if (_stairDir) { [dx, dz] = _stairDir; }
                else if (tgt) {
                    const rx = Math.round(tgt.x) - Math.floor(bot.entity.position.x);
                    const rz = Math.round(tgt.z) - Math.floor(bot.entity.position.z);
                    if (Math.abs(rx) >= Math.abs(rz)) { dx = Math.sign(rx) || 1; dz = 0; }
                    else { dx = 0; dz = Math.sign(rz) || 1; }
                    _stairDir = [dx, dz];
                }
                else { [dx, dz] = [[1, 0], [0, 1], [-1, 0], [0, -1]][stale % 4]; _stairDir = [dx, dz]; }
                _dbg(`pinned → dig-staircase dir=${dx},${dz} (locked)${tgt ? ' tgt=' + Math.round(tgt.x) + ',' + Math.round(tgt.y) + ',' + Math.round(tgt.z) : ''}`);
                bot._climbingAt = Date.now();   // 凿崖心跳: mobility 看到它就不判 MAROONED(爬山=有目的工程,不是被困;否则行军90s插队把凿崖斩在半路——FREE窗口2min<凿崖启动3-4min,结构性饿死)
                try {
                    // ★CLIMB LOOP (凿崖不积累的根修,16:02 对账: 旧版每 stall 凿一格,chopWood
                    // 重入位置漂移(tgt 114↔122),5次accepted y 纹丝不动。改: 一次进入连续凿,
                    // 每轮重算位置+刷新心跳,退出条件=登顶(tgt.y-2)/4轮零爬升/危殆/打断。)
                    let _lastCY = Math.floor(bot.entity.position.y), _flatRounds = 0;
                    const _climbMax = tgt ? 40 : 3;
                    for (let _climb = 0; _climb < _climbMax; _climb++) {
                    if (bot.death_abort || bot.health <= 4 || bot.interrupt_code || _needsFoodYield()) {
                        if (_needsFoodYield()) _dbg(`pinned-stair LOW-FOOD BAIL food=${bot.food}, no edible — stop climb`);
                        break;
                    }
                    if (tgt && bot.entity.position.y >= tgt.y - 2) { _dbg(`climb DONE y=${Math.floor(bot.entity.position.y)} (tgt y${Math.round(tgt.y)})`); break; }
                    bot._climbingAt = Date.now();
                    const m = bot.entity.position.floored();
                    // ★徒手禁撸石 here too (the SECOND material-blind dig path the alarm
                    // caught, 05:01): bare-handed, stone in the staircase line means
                    // re-aim the locked heading at a dirt face — not minutes of fruitless
                    // punching per block. With a pick, dig anything as before.
                    const _pick2 = bot.inventory.items().some(it => /_pickaxe$/.test(it.name));
                    const _STONY2 = /stone|deepslate|andesite|diorite|granite|tuff|_ore$|obsidian|cobble/;
                    // ★STAIR vs TUNNEL cell 选择 (16:09 STALL 破案: 旧 cells2 把前方脚位
                    // (dx,0,dz) 也挖了——"凿台阶"被挖成水平隧道,forward+jump 走平地,y 永不
                    // 涨(climb STALL 4平轮×N)。人类凿崖上行: 保留前方脚位当台阶,只挖它上面
                    // 头位+头上+自己头顶,跳上去站高1格。前方脚位本来就空(平地/坑)才用旧
                    // 隧道模式穿墙。)
                    const _stepB = bot.blockAt(m.offset(dx, 0, dz));
                    const cells2 = (_stepB && _stepB.boundingBox === 'block')
                        ? [m.offset(dx, 1, dz), m.offset(dx, 2, dz), m.offset(0, 2, 0)]
                        : [m.offset(dx, 0, dz), m.offset(dx, 1, dz), m.offset(dx, 2, dz), m.offset(0, 2, 0)];
                    if (!_pick2 && cells2.some(c => { const b = bot.blockAt(c); return b && b.boundingBox === 'block' && _STONY2.test(b.name); })) {
                        // ★NOPICK-FAMINE 破例 (死结实拍: 树全在y87-92崖顶,bot y63,四方向
                        // 阶梯路线全是石面→轮一圈全ABORT→树全拉黑→"上崖要凿石→凿石要镐→
                        // 做镐要木→木在崖顶"闭环锁死。这个门的本意是"换方向找土面",全石
                        // 地形没有土面可找——徒手凿石10s/块×~50块≈9分钟买下整条科技树,
                        // 比死结强无限。轮完4方向(确认无土面)才放开,优先土面的策略保留。)
                        _stoneAborts++;
                        // famine flag 挂 bot 跨调用持久 (bug实拍: 计数器是本函数局部量,
                        // missionNether 每 iter 重新调 chopWood → 每次到 4/4 就归零重数,
                        // 永远轮不到第5次。4/4=本轮已确认四方向全石,arm 10分钟持久豁免)
                        const _famine = bot._nopickFamineAt && (Date.now() - bot._nopickFamineAt < 600000);
                        if (_stoneAborts <= 4 && !_famine) {
                            if (_stoneAborts === 4) { bot._nopickFamineAt = Date.now(); _dbg(`NOPICK-FAMINE armed (4/4 headings stone) — bare-hand climb unlocked for 10min`); }
                            const [ndx, ndz] = [[1, 0], [0, 1], [-1, 0], [0, -1]][(stale + 1) % 4];
                            _dbg(`pinned-stair ABORT (stone face, no pick, d=${dx},${dz}) → re-lock dir=${ndx},${ndz} (${_stoneAborts}/4 before bare-hand)`);
                            _stairDir = [ndx, ndz];
                            throw new Error('stone-no-pick');
                        }
                        _dbg(`pinned-stair NOPICK-FAMINE: all headings stone, no pick, no wood — bare-hand climb accepted (d=${dx},${dz})`);
                        try { bot._plannedNoPickStoneUntil = Date.now() + 15000; } catch (e) {}
                    }
                    // foot+head ahead (tunnel through wall), step-up block ahead (make a stair), own head (avoid entomb)
                    for (const c of cells2) {
                        const b = bot.blockAt(c);
                        if (b && b.boundingBox === 'block' && !/water|lava/.test(b.name)) await guardedDig(b, 'pinned-stair');
                    }
                    // Face the LOCKED dig direction (not the shifting nearest tree) so forward-walk
                    // climbs the staircase we just carved, keeping the heading consistent.
                    // ★HOLE PROBE before the blind march (deaths 216+217: IDENTICAL coords
                    // x12,z-40 falling to y-34 — the forced traverse marched into the same
                    // open 1x1 shaft twice, ~30min apart; raw setControlState walking has no
                    // pathfinder hole-avoidance). If the next 1-2 cells have no floor within
                    // 4 blocks, rotate the locked heading instead of stepping in.
                    {
                        const mp = bot.entity.position;
                        const holey = (cells) => cells.some(([fx, fz]) => {
                            for (let dd = 0; dd <= 4; dd++) {
                                const fb = bot.blockAt(mp.offset(fx, -dd, fz));
                                if (fb && (fb.boundingBox === 'block' || /water/.test(fb.name || ''))) return false;
                            }
                            return true;
                        });
                        if (holey([[dx * 1.2, dz * 1.2], [dx * 2.2, dz * 2.2]])) {
                            const [ndx, ndz] = [[1, 0], [0, 1], [-1, 0], [0, -1]][(stale + 1) % 4];
                            _dbg(`pinned-march ABORT (open shaft ahead d=${dx},${dz}) → re-lock dir=${ndx},${ndz}`);
                            _stairDir = [ndx, ndz];
                            throw new Error('hole-ahead');   // caught below; clearControlStates, next stall marches new dir
                        }
                    }
                    const climbed = await _ascendStep(dx, dz, 'pinned-stair-climb');
                    if (!climbed && bot._chopAscendFail && bot._chopAscendFail.n >= 2) {
                        const [ndx, ndz] = [[1, 0], [0, 1], [-1, 0], [0, -1]][(stale + bot._chopAscendFail.n) % 4];
                        _dbg(`pinned-stair rotate after ascend fail n=${bot._chopAscendFail.n}: ${dx},${dz} → ${ndx},${ndz}`);
                        _stairDir = [ndx, ndz];
                        break;
                    }
                    const _yNow = Math.floor(bot.entity.position.y);
                    if (_yNow > _lastCY) { _flatRounds = 0; _lastCY = _yNow; }
                    else if (++_flatRounds >= 4) { _dbg(`climb STALL (4 flat rounds at y=${_yNow}) — exit loop`); break; }
                    }   // end CLIMB LOOP
                } catch (e) { try { bot.clearControlStates(); } catch (_) {} }
            }
            if (stale >= 5) { log(bot, 'Stuck with no progress, stopping.'); break; }
        } else {
            stale = 0;
        }
    }
    log(bot, `chopWood done: logs=${total()} (wanted +${count}).`);
    return total();
}
