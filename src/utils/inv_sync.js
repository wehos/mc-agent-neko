// ★INV-DESYNC 根修 (2026-07-03, 当日第 3 次发作后): 'Event updateSlot:0 did not fire
// within timeout of 20000ms' ×99 风暴 / 25min 冻结 / reclaim-craft 连败的病灶。
//
// 机制: 1.17+ 无 transaction 包, mineflayer clickWindow 点合成格后死等服务器的
// 结果格回显 (inventory.js waitForWindowUpdate → once(...,'updateSlot:0'), 20s);
// putAway 同理。一旦客户端与服务器的"当前打开容器"失步 (被打断的 bot.craft 留下
// 幽灵容器态), vanilla handleContainerClick 因 containerId 不匹配【静默丢弃】后续
// 所有点击 → 回显永不来, 每次点击烧满 20s; 且本地预测 (acceptClick 在等待前已落账)
// 与服务器真值分叉 → "KIT 见 coal=63 / NEED 见 have 0" 双重视界。重启能治=状态病。
//
// 修法 (超时不再只 fail):
//  1) close_window 复位服务器容器态 — vanilla handleContainerClose 不校验 id,
//     无条件把 containerMenu 收回 inventoryMenu → 治幽灵容器;
//  2) 发 stateId 故意过期(-1) 的 no-op 点击 (slot -999 + 空 cursor = 丢空手, 无副作用)
//     → 服务器 stateId 不匹配 → broadcastFullState → 整包 window_items → 全量重同步,
//     顺带刷新 mineflayer 内部 stateId (inventory.js:35 监听 window_items);
//  3) 无容器窗口的操作 (reclaim 的 moveSlotItem 等) 在重同步确认后按【软成功】吞掉
//     — 本地预测已落账, 重同步后本地即服务器真值, 流程可继续; 有容器窗口时我们关了
//     它, 在飞的 craft 序列槽位号已失效, 必须原样抛出让上层快速重试 (状态已治好)。
//  4) 失步计数: 60s 内 >=5 次 → progress.txt 记 ★INV-DESYNC (只软恢复, 不自杀进程)。
import fs from 'fs';

const TIMEOUT_RE = /updateSlot:\d+ did not fire within timeout/;
const prog = (s) => {
    try { fs.appendFileSync('bots/_supervisor/progress.txt', `[${new Date().toISOString()}] [inv-sync] ${s}\n`); } catch (e) {}
};

// 全量重同步: 复位服务器容器态 + 逼服务器整包重发背包。resolve(true)=收到整包确认。
async function resync(bot) {
    if (bot._invResyncing) return bot._invResyncing; // 并发超时共享同一次重同步
    bot._invResyncing = (async () => {
        try {
            if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
            else bot._client.write('close_window', { windowId: 0 });
        } catch (e) {}
        if (!bot.supportFeature('stateIdUsed')) return false; // <=1.16 走 transaction 路径, 到不了这
        const confirmed = new Promise((res) => {
            const on = () => { clearTimeout(t); res(true); };
            const t = setTimeout(() => { bot.off('setWindowItems:0', on); res(false); }, 5000);
            bot.once('setWindowItems:0', on); // window_items 整包到达的标志 (inventory.js:759)
        });
        try {
            const Item = (await import('prismarine-item')).default(bot.registry);
            bot._client.write('window_click', {
                windowId: 0, stateId: -1, slot: -999, mouseButton: 0, mode: 0,
                changedSlots: [], cursorItem: Item.toNotch(null),
            });
        } catch (e) { return false; }
        return confirmed;
    })().finally(() => { bot._invResyncing = null; });
    return bot._invResyncing;
}

function noteDesync(bot, where) {
    const now = Date.now();
    bot._invDesyncTs = (bot._invDesyncTs || []).filter(ts => now - ts < 60_000);
    bot._invDesyncTs.push(now);
    if (bot._invDesyncTs.length >= 5) {
        prog(`★INV-DESYNC ${where}: ${bot._invDesyncTs.length} 次 updateSlot 超时/60s — 已软恢复(closeWindow+整包重同步); 若仍持续建议重启进程`);
        bot._invDesyncTs = [];
    }
}

function wrap(bot, method) {
    const orig = bot[method].bind(bot);
    bot[method] = async (...args) => {
        try { return await orig(...args); }
        catch (err) {
            if (!TIMEOUT_RE.test(String(err && err.message))) throw err;
            const hadWindow = !!bot.currentWindow; // 记录在 resync 关窗之前
            noteDesync(bot, `${method}(${args[0]})`);
            const ok = await resync(bot).catch(() => false);
            prog(`${method}(${args[0]}) updateSlot 超时 → 重同步${ok ? '确认' : '失败'}${ok && !hadWindow ? ', 按软成功继续' : ', 原样抛出'}`);
            if (ok && !hadWindow) return; // 软成功: 无窗口操作, 本地已是服务器真值
            throw err;
        }
    };
}

export function installInvSync(bot) {
    // spawn 时插件已注入完毕 (clickWindow/putAway 就位); once=重生不重复包装
    bot.once('spawn', () => {
        try { wrap(bot, 'clickWindow'); wrap(bot, 'putAway'); }
        catch (e) { console.warn('[inv-sync] install failed:', e.message); }
    });
}
