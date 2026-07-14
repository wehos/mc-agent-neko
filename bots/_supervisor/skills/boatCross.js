// 渡水技能 (热加载): 就近水面放船 → mount → 客户端权威 vehicle_move 直驶目标岸 →
// dismount + 尝试打掉船回收。核心驾驶逻辑在 skills.boatEscape (src/agent/library/
// skills.js) — modes.js 的深水反射与本技能共用同一实现 (反射内不能 customSkill)。
// 背景: mineflayer 1.21.1 的 bot.moveVehicle 只发 steer_vehicle 桨输入, 原版服务器
// 对 boat 是客户端权威物理 (只认乘客发的 serverbound vehicle_move) — boatEscape 自己
// 逐 tick 发 vehicle_move 当船的物理引擎, 服务器纠正包会把它诚实钳回。
// 用法: skills.customSkill(bot, 'boatCross', { tx: 120, tz: -340 })  (tx/tz = 目标岸坐标)
// 契约: 净水平位移 >16b → {crossed:<dist>}; 否则 false。honor interrupt_code。
// ctx = { skills, world, mc, Vec3, log }
export default async function boatCross(bot, ctx, params = {}) {
    const { skills, world, log } = ctx;
    const tx = Number(params && params.tx), tz = Number(params && params.tz);
    if (!Number.isFinite(tx) || !Number.isFinite(tz)) { log(bot, 'boatCross: need numeric {tx, tz}'); return false; }

    // 1) 没船先兜底造一只 (kit 常备已在 prepNether keepKit; 这里是直接调用时的自给)
    const hasBoat = () => bot.inventory.items().some(i => /(_boat|_raft)$/.test(i.name || ''));
    if (!hasBoat()) {
        const ic = world.getInventoryCounts(bot);
        const plank = Object.keys(ic).filter(k => k.endsWith('_planks') && ic[k] >= 5).sort((a, b) => ic[b] - ic[a])[0];
        if (plank) {
            const boatName = plank === 'bamboo_planks' ? 'bamboo_raft' : plank.replace('_planks', '_boat');
            log(bot, `boatCross: no boat → crafting ${boatName} (5x ${plank})`);
            try { await skills.craftRecipe(bot, boatName, 1); } catch (e) { log(bot, `boatCross: craft err ${e.message}`); }
        }
        if (!hasBoat()) { log(bot, 'boatCross: no boat and cannot craft one (need 5 same-type planks + table)'); return false; }
    }
    if (bot.interrupt_code) return false;

    // 2) 不在水边 → 走到就近水面 (24 格内; boatEscape 自己只在臂展内找放船点)
    const p = bot.entity.position;
    const isWater = (b) => b && (b.name === 'water' || b.name === 'flowing_water');
    const wet = isWater(bot.blockAt(p)) || isWater(bot.blockAt(p.offset(0, -1, 0))) || world.getNearestBlock(bot, 'water', 4);
    if (!wet) {
        const w = await world.getNearestBlockAsync(bot, 'water', 64);
        if (!w) { log(bot, 'boatCross: no water within 64b — nothing to cross'); return false; }
        try { await skills.goToPosition(bot, w.position.x, w.position.y + 1, w.position.z, 2); } catch (e) { log(bot, `boatCross: walk-to-water err ${e.message}`); }
        if (bot.interrupt_code) return false;
    }

    // 3) 放船 + mount + 驶向 (tx,tz) + dismount + 回收 — 全在 boatEscape (含氧气 vital 地板)
    const res = await skills.boatEscape(bot, tx, tz, { tag: 'boatCross' });
    log(bot, res ? `boatCross: crossed ${res.crossed}b toward ${Math.round(tx)},${Math.round(tz)}` : 'boatCross: failed/aborted (see [boat] trace in progress.txt)');
    return res;
}
