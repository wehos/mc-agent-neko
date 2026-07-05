// mineOres — oracle 制导矿石远征 (2026-07-06 用户令: "oracle视角挖铁应该非常快, 1h 怎么可能")
// ore-oracle 已把 iron/coal 与 diamonds 一并扫出 (bot._world.oracleOres.{iron,coal});
// 本技能泛化 mineDiamonds 的直奔模式: 地表走到目标柱 → mineDown 密封下潜到矿层 →
// collectBlock 脉络跟采(x-ray 64 格) → 采空则 branchMine 刷新暴露面 / 换 oracle 下一候选。
// 铁掉 raw_iron, 煤掉 coal — 进度按掉落物库存增量计(delta 口径, 最高契约)。
// 返回契约: 增量>0 → {ore,gained}; 零增量 → false (interrupt 解卷时 kernel 不罚)。
import fs from 'fs';
import path from 'path';

const PROG = path.resolve(process.cwd(), 'bots', '_supervisor', 'progress.txt');
function prog(line) {
    try { fs.appendFileSync(PROG, `[${new Date().toISOString()}] [mineOres] ${line}\n`); } catch (e) {}
}

// 掉落物口径: 矿石块可能被 silk/直采差异影响, 但本栈无 silk — raw_x/coal 即掉落
const DROP_OF = { iron: /^raw_iron$/, coal: /^coal$/, gold: /^raw_gold$/, copper: /^raw_copper$/, diamonds: /^diamond$/ };
// 采集所需镐级: 铁需石镐+, 煤任意镐
const PICK_FOR = { iron: /(stone|iron|diamond|netherite)_pickaxe$/, gold: /(iron|diamond|netherite)_pickaxe$/, coal: /_pickaxe$/, copper: /(stone|iron|diamond|netherite)_pickaxe$/, diamonds: /(iron|diamond|netherite)_pickaxe$/ };
// collectBlock 的 blockType 词干 (skills.js:945 oreDrops 映射 _ore/deepslate 变体)
const COLLECT_KEY = { iron: 'iron', coal: 'coal', gold: 'gold', copper: 'copper', diamonds: 'diamond' };

export default async function mineOres(bot, ctx, opts = {}) {
    const { skills, world } = ctx;
    const ore = String((opts && opts.ore) || 'iron');
    const count = Number(opts && opts.count) > 0 ? Number(opts.count) : 8;
    const maxMs = Number(opts && opts.maxMs) > 0 ? Number(opts.maxMs) : 300000;
    const yMax = Number.isFinite(opts && opts.yMax) ? opts.yMax : Infinity;   // 夜挖只收地下带目标
    const deadline = Date.now() + maxMs;
    const dropRe = DROP_OF[ore] || new RegExp(`^raw_${ore}$`);
    const pickRe = PICK_FOR[ore] || /_pickaxe$/;
    const collectKey = COLLECT_KEY[ore] || ore;
    const cnt = () => {
        try {
            const c = world.getInventoryCounts(bot);
            return Object.keys(c).reduce((s, k) => s + (dropRe.test(k) ? c[k] : 0), 0);
        } catch (e) { return 0; }
    };
    const hasPick = () => { try { return bot.inventory.items().some(i => pickRe.test(i.name || '')); } catch (e) { return false; } };

    if (!bot || !bot.entity) return false;
    if (!hasPick()) { prog(`ABORT ore=${ore} — 无合格镐(需 ${pickRe}), 失败让 TOOL_UPKEEP 先修`); return false; }
    if (bot.armorManager) try { await bot.armorManager.equipAll(); } catch (e) {}
    const g0 = cnt();

    // oracle 目标 (新鲜 <10min, 平距 <250)
    const oracleList = () => {
        try {
            const oo = bot._world && bot._world.oracleOres;
            if (!(oo && Date.now() - (oo.ts || 0) < 600000)) return [];
            // 夜挖(yMax 有限)优先扫描器的地下带分层名单 (top-24 山面铁过滤后可能为空)
            if (yMax !== Infinity && ore === 'iron' && Array.isArray(oo.ironDeep) && oo.ironDeep.length) return oo.ironDeep;
            if (Array.isArray(oo[ore]) && oo[ore].length) {
                return yMax === Infinity ? oo[ore] : oo[ore].filter(c => c && c.y <= yMax);
            }
        } catch (e) {}
        return [];
    };
    const list0 = oracleList();
    const tgt = (() => {
        const c0 = list0[0];
        if (!c0) return null;
        const p0 = bot.entity.position;
        return Math.hypot(c0.x - p0.x, c0.z - p0.z) < 250 ? c0 : null;
    })();
    prog(`START ore=${ore} need=${count} have=${g0} oracle=${tgt ? `${tgt.x},${tgt.y},${tgt.z}(库存告示${list0.length})` : 'none(盲挖回退)'} pos=${bot.entity.position.floored()} hp=${Math.round(bot.health)} food=${bot.food}`);

    if (tgt) {
        const dxz = Math.hypot(tgt.x - bot.entity.position.x, tgt.z - bot.entity.position.z);
        if (dxz > 8 && !bot.interrupt_code) {
            await Promise.race([
                skills.goToPosition(bot, tgt.x, null, tgt.z, 6),
                new Promise((_, rej) => setTimeout(() => rej(new Error('oracle-walk-timeout')), 90000)),
            ]).catch(() => { try { bot.pathfinder.stop(); } catch (e) {} try { bot.clearControlStates(); } catch (e) {} });
        }
        // 垂直逼近: 高差 >6 用 mineDown 密封下潜到矿层 y-1 (够近则 collectBlock 自己挖过去);
        // 预算余量 <60s 不再开潜 (评审: 嵌套 mineDown 自带多分钟循环, deadline 只兜 collect 环)
        if (bot.entity.position.y - tgt.y > 6 && !bot.interrupt_code && !bot.death_abort
            && deadline - Date.now() > 60000) {
            try { await skills.customSkill(bot, 'mineDown', { targetY: Math.max(tgt.y - 1, -58) }); } catch (e) {}
        }
    } else {
        // ★评审 P2: 无可用 oracle 目标(缺失/陈旧/真距超闸)时不能在地表平采 —
        //   回退到被替代者的行为: 密封楼梯下潜到矿带, 与旧 mineDown 路径等价。
        const band = ore === 'coal' ? 40 : (ore === 'diamonds' ? -52 : 14);
        if (bot.entity.position.y - band > 6 && !bot.interrupt_code && deadline - Date.now() > 60000) {
            prog(`无 oracle 目标 — 盲挖回退: mineDown 下潜 y${band}`);
            try { await skills.customSkill(bot, 'mineDown', { targetY: band }); } catch (e) {}
        }
    }

    let rounds = 0;
    while (cnt() - g0 < count && Date.now() < deadline && rounds++ < 12) {
        if (bot.interrupt_code || bot.death_abort || bot.health <= 0) break;
        if (!hasPick()) { prog(`镐没了(r${rounds}) — 停`); break; }
        // 背包临满 → 先清囊 (replenishKit ⓪ 同款 CAPS 白名单; 首战实录: 890 件杂物 0s 收工
        // 三振整个 kind) — 倒不出 2 槽才真收工。永不碰工具/食物/矿物/木/羊毛。
        const emptyN = () => { try { return bot.inventory.emptySlotCount(); } catch (e) { return 9; } };
        if (emptyN() <= 1) {
            const CAPS = { cobblestone: 128, dirt: 64, gravel: 8, andesite: 0, diorite: 0, granite: 0, tuff: 0, flint: 4, rotten_flesh: 8, netherrack: 0, cobbled_deepslate: 64, sand: 0, sandstone: 0, coal: 128, feather: 4, dandelion: 0, azure_bluet: 0, lily_pad: 0, brown_mushroom: 2, egg: 1 };
            let tossed = 0;
            try {
                const haveOf = (n) => bot.inventory.items().reduce((s, i) => s + (i.name === n ? i.count : 0), 0);
                for (const it of bot.inventory.items()) {
                    if (emptyN() >= 3) break;
                    const cap = CAPS[it.name];
                    if (cap == null) continue;
                    const have = haveOf(it.name);
                    if (have <= cap) continue;
                    const drop = Math.min(it.count, have - cap);
                    try { await bot.toss(it.type, null, drop); tossed += drop; } catch (e) {}
                }
            } catch (e) {}
            prog(`r${rounds}: 清囊 tossed=${tossed} → empty=${emptyN()}`);
            if (emptyN() <= 1) { prog(`r${rounds}: 清囊后仍满 — 收工`); break; }
        }
        const before = cnt();
        try { await skills.collectBlock(bot, collectKey, Math.max(1, Math.min(4, count - (cnt() - g0)))); } catch (e) {}
        if (cnt() > before) continue;
        // x-ray 64 格内采空 → oracle 下一候选换点; 候选就在脚下(<4b, 单候选自旋)或无候选则支道刷新
        const list = oracleList();
        const nxt = list.length ? list[rounds % list.length] : null;
        const nxtDist = nxt ? Math.hypot(nxt.x - bot.entity.position.x, nxt.z - bot.entity.position.z) : Infinity;
        if (nxt && nxtDist >= 4 && nxtDist < 250) {
            prog(`r${rounds}: 本区采空 → oracle 换点 ${nxt.x},${nxt.y},${nxt.z}`);
            await Promise.race([
                skills.goToPosition(bot, nxt.x, nxt.y, nxt.z, 3),
                new Promise((_, rej) => setTimeout(() => rej(new Error('hop-timeout')), 60000)),
            ]).catch(() => { try { bot.pathfinder.stop(); } catch (e) {} try { bot.clearControlStates(); } catch (e) {} });
        } else {
            try { await skills.customSkill(bot, 'branchMine', 12); } catch (e) {}
        }
    }
    const gained = cnt() - g0;
    prog(`DONE ore=${ore} gained=${gained}/${count} rounds=${rounds} y=${Math.floor(bot.entity.position.y)} hp=${Math.round(bot.health)} 用时${Math.round((maxMs - (deadline - Date.now())) / 1000)}s`);
    return gained > 0 ? { ore, gained } : false;
}
