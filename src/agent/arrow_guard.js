// ★2026-07-09 用户令 "外挂级精准挡箭 (毫秒级定向举盾)":
//   shieldFight 的举盾是"逼近途中粗放举 + 贴脸放下砍", 会漏箭 (见 modes/shieldFight 注释):
//     ①冲锋 sprint 抵消盾格 ②贴脸 550ms 攻击窗盾落下 ③装盾失败静默。
//   本模块是独立于 modes/skill 的【反射层】: 挂在 bot 的 physicsTick (每游戏刻 ~20/s = 50ms),
//   逐箭做弹道预测, 命中航线上的箭一出现就【瞬时定向 + 举盾】。因为盾在副手、剑在主手, 举盾期间
//   仍能挥剑, 所以它只接管"盾+朝向+sprint", 不抢攻击 —— 与 shieldFight/self_defense 共存。
//
//   协作契约 (两个挂在 bot 上的标志):
//     • bot._arrowBlockUntil : 本模块正在挡箭的截止时刻。shieldFight 读它 → 挡箭窗内不放盾/不 sprint。
//     • bot._drawingBow      : shieldFight 拉弓期间置位。本模块读它 → 拉弓时完全让手 (deactivateItem
//                              是全局的, 会掐断拉弓), 不碰 activate/deactivate。
//
//   核心算法 (每 tick, 单位: 方块 / 方块每刻):
//     箭速用【逐刻位置差】自测 (服务器飞行中多半只发相对位移不刷 velocity, 直接读 entity.velocity 会僵在
//     出膛初速)。对每支箭解最近接近点 t* = -(rel·relVel)/(relVel·relVel), t*≥0 且脱靶距 < HIT_R 且
//     t* ≤ LEAD_TICKS ⇒ 判定来袭。相对速度扣掉自身速度 (relVel = 箭速 - 我速)。

const LEAD_TICKS = 12;    // 命中还剩 ≤12 刻 (~600ms) 就举盾 — 覆盖网络延迟+举盾生效, 早举无害
const HIT_RADIUS = 1.15;  // 脱靶容差 (玩家宽 0.6 + 箭判定 + 余量): 航线穿过这个球才算会中
const HOLD_MS = 260;      // 最后一次来袭后再多举一会, 吃连射的下一箭 (骷髅/小白连发)
const EQUIP_THROTTLE_MS = 3000; // 副手没盾时补装的节流

const ARROW_NAMES = new Set(['arrow', 'spectral_arrow']);

export function installArrowGuard(agent) {
    const bot = agent.bot;
    if (!bot || bot._arrowGuardInstalled) return;
    bot._arrowGuardInstalled = true;

    const myEpoch = bot._instanceEpoch || 0;
    const track = new Map();   // arrowId -> { x,y,z } 上一刻位置 (自测速度用)
    let blocking = false;      // 我是否已发出举盾 (只在上升沿发, 别每刻重发)
    let holdUntil = 0;         // 挡箭姿态保持到此刻 (吸收连射)
    let lastEquipTry = 0;
    let dbgLast = 0, dbgBlocks = 0;

    const hasShieldAnywhere = () =>
        (bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield') ||
        bot.inventory.items().some(i => i.name === 'shield');
    const shieldInOffhand = () => !!(bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield');

    const onTick = () => {
        // 尸体/换代守卫: 重连后旧实例的残留监听不该再动手 (幽灵栈问题)。
        if (bot._poisoned || (bot._instanceEpoch || 0) !== myEpoch) { cleanup(); return; }
        if (bot.interrupt_code) return;
        let me;
        try { me = bot.entity && bot.entity.position; } catch (_) { me = null; }
        if (!me) return;

        // 拉弓时彻底让手 (deactivateItem 会掐断拉弓) —— 见协作契约。
        if (bot._drawingBow) { blocking = false; return; }

        const now = Date.now();
        // 便宜的早退: 身上完全没盾就不干活 (每刻只做一次 inventory 扫描, 可接受)。
        if (!hasShieldAnywhere()) { if (blocking) { blocking = false; } return; }

        const eyeY = 1.62;
        const torso = { x: me.x, y: me.y + 1.0, z: me.z };  // 瞄躯干中心做命中判定
        let myVel = { x: 0, y: 0, z: 0 };
        try { const v = bot.entity.velocity; if (v) myVel = { x: v.x, y: v.y, z: v.z }; } catch (_) {}

        // ── 扫描全部箭, 逐支做弹道预测, 记住"最早命中"的那支 ──
        let best = null; // { t, ax, ay, az }
        const seen = new Set();
        const ents = bot.entities;
        for (const id in ents) {
            const e = ents[id];
            if (!e || !e.position || !ARROW_NAMES.has(e.name)) continue;
            seen.add(e.id);
            const p = e.position;
            const prev = track.get(e.id);
            track.set(e.id, { x: p.x, y: p.y, z: p.z });
            // 自测速度 = 本刻位置 - 上刻位置 (方块/刻)。首见无上一刻 → 退回出膛初速。
            let vx, vy, vz;
            if (prev) { vx = p.x - prev.x; vy = p.y - prev.y; vz = p.z - prev.z; }
            else if (e.velocity) { vx = e.velocity.x; vy = e.velocity.y; vz = e.velocity.z; }
            else continue; // 首见且无初速 — 下一刻 (~50ms) 就能算, 箭还在飞
            // 相对速度 (扣掉自身移动)
            const rvx = vx - myVel.x, rvy = vy - myVel.y, rvz = vz - myVel.z;
            const speed2 = rvx * rvx + rvy * rvy + rvz * rvz;
            if (speed2 < 0.02) continue; // 已插地/几乎静止的箭
            // rel = 箭 - 躯干
            const rx = p.x - torso.x, ry = p.y - torso.y, rz = p.z - torso.z;
            const rel_dot_v = rx * rvx + ry * rvy + rz * rvz;
            if (rel_dot_v >= 0) continue; // 在远离 → 不会命中
            const t = -rel_dot_v / speed2; // 到最近接近点的刻数
            if (t < 0 || t > LEAD_TICKS) continue;
            // 最近接近点脱靶距
            const cx = rx + rvx * t, cy = ry + rvy * t, cz = rz + rvz * t;
            const miss2 = cx * cx + cy * cy + cz * cz;
            if (miss2 > HIT_RADIUS * HIT_RADIUS) continue;
            if (!best || t < best.t) best = { t, ax: p.x, ay: p.y, az: p.z };
        }
        // 清理已消失箭的轨迹缓存
        if (track.size > seen.size) for (const id of track.keys()) if (!seen.has(id)) track.delete(id);

        const incoming = !!best;
        if (incoming) holdUntil = now + HOLD_MS;
        const wantBlock = incoming || now < holdUntil;

        if (wantBlock) {
            bot._arrowBlockUntil = Math.max(bot._arrowBlockUntil || 0, now + HOLD_MS); // 通知 shieldFight 别放盾/别冲刺
            // sprint 会取消盾格 — 挡箭窗内强制熄火 (shieldFight 也会读 _arrowBlockUntil 自觉不冲)
            try { if (bot.getControlState && bot.getControlState('sprint')) bot.setControlState('sprint', false); } catch (_) {}
            // 副手补盾 (节流): 拿在主手/背包的盾先塞副手, 才能一边砍一边挡
            if (!shieldInOffhand() && now - lastEquipTry > EQUIP_THROTTLE_MS) {
                lastEquipTry = now;
                const sh = bot.inventory.items().find(i => i.name === 'shield');
                if (sh) { bot.equip(sh, 'off-hand').catch(() => {}); }
            }
            // 毫秒级定向: 直接强制 yaw/pitch 对准来袭箭当前位置 (force=true 即时, 不走平滑瞄准)
            if (best) {
                const dx = best.ax - me.x, dy = best.ay - (me.y + eyeY), dz = best.az - me.z;
                const yaw = Math.atan2(-dx, -dz);
                const pitch = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));
                try { bot.look(yaw, pitch, true); } catch (_) {}
            }
            // 举盾 (只在上升沿发, 副手就位时): activateItem(true) = 副手
            if (!blocking && shieldInOffhand()) {
                try { bot.activateItem(true); blocking = true; dbgBlocks++; } catch (_) {}
            }
        } else if (blocking) {
            // 威胁过去 + 保持窗到期 → 放盾, 把手交还 shieldFight/攻击节奏
            try { bot.deactivateItem(); } catch (_) {}
            blocking = false;
        }

        // 稀疏取证 (10s 一行, 有挡箭动作才打) — 事后能核对"到底挡没挡"
        if (dbgBlocks && now - dbgLast > 10000) {
            dbgLast = now;
            const n = dbgBlocks; dbgBlocks = 0;
            try {
                agent && agent.name; // noop guard
                import('fs').then(fs => {
                    try { fs.appendFileSync('bots/_supervisor/progress.txt',
                        `[${new Date().toISOString()}] [arrow_guard] raised shield to intercept ${n} arrow-threat tick(s) in last 10s (offhand=${shieldInOffhand()})\n`); } catch (_) {}
                }).catch(() => {});
            } catch (_) {}
        }
    };

    const cleanup = () => {
        try { bot.removeListener('physicsTick', onTick); } catch (_) {}
        try { if (blocking) bot.deactivateItem(); } catch (_) {}
    };

    bot.on('physicsTick', onTick);
    bot.once('end', cleanup);
    try { console.log(`🛡 arrow_guard installed (epoch ${myEpoch}) — per-tick ballistic shield interception`); } catch (_) {}
}
