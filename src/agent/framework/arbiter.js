/**
 * Framework v2 — 身体所有权仲裁器 (Phase 1, 用户签核设计 2026-07-03).
 * 设计稿: bots/_supervisor/arbitration-design.md — 必读; 本文件严格照稿实现。
 *
 * 问题: 身体 (pathfinder goal / control states / dig) 是全局共享资源, 无仲裁抢占
 * 一天贡献 ≥6 死 + 3 个大死锁 (C345-B stop 脉冲连杀溺水营救 7 次; 反射 8s 抢 goal
 * 夜爬 8min 走 3y; mobility 反射独占身体饿死 SURFACE_RESCUE)。
 *
 * 架构 (用户指令, 不是层级制, 不写 if 山):
 *  1. 邻接矩阵 bots/_supervisor/arbitration.json — 胜负规则是成对的 (holder vs
 *     claimant), 允许局部例外, 不强求全序。支持家族通配 (`kernel:*` / `mode:*`)。
 *  2. LLM 终裁仅冲突时: 矩阵查无此对 → 异步问 agent 配置模型 (prompter.chat_model
 *     单发, 4s 超时); persist:true 的裁决沉淀写回矩阵 = 学习闭环, 同对下次零成本。
 *  3. 生死底线是唯一硬编码地板: claimant vital (oxygen<=8 / hp<=4 且掉血中 / 着火)
 *     秒抢 — 不等 LLM, 也不查矩阵 (设计稿 §3: "地板, 不是阶梯……其余一切走矩阵/LLM"
 *     = vital 根本不进矩阵/LLM 系统)。若矩阵能压地板, 一条坏的 LLM persist 规则就会
 *     把溺水营救永久制度性压死。封顶水牢例外 (drowning 让位 ENTOMBED dig) 不受影响:
 *     它在 self_preservation 内部自让 (modes.js:1419), 根本不发起 claim。
 *  4. 所有权令牌 bot._bodyOwner = { name, kind, since } — kernel 派发/mode execute
 *     置与释, 只释放自己的 (owner-tag 语义, 沿 ws-mutex 先例)。
 *
 * 红线 (照稿):
 *  - 无模块级可变状态 — 缓存全部挂 bot._arb + 文件。
 *  - LLM 问询绝不阻塞 tick — resolve 同步返回, 未命中即 'pending' (现状保持 =
 *    holder 保留), askLLM 在后台跑。
 *  - 任何异常 → 行为退化为"现状" (holder 保留), 永不抛出。
 *  - 每次裁决可观测: progress.txt `[arbiter] holder=X claimant=Y → winner (source)`
 *    + arbitration.json 的 log 数组 (kernel-out 冲刷教训: 可观测性优先; 但同对同
 *    verdict 10s 限频, 反射 300ms 一拍, 不限频就是日志风暴)。
 */

import fs from 'fs';
import path from 'path';
import { withTimeout } from '../../utils/timeout.js';

const ARB_FILE = path.resolve(process.cwd(), 'bots', '_supervisor', 'arbitration.json');
const PROGRESS_FILE = path.resolve(process.cwd(), 'bots', '_supervisor', 'progress.txt');

const LLM_TIMEOUT_MS = 4000;      // 终裁超时 — 超时回退 holder (最小惊讶)
const LLM_VERDICT_TTL_MS = 120000; // 非 persist 裁决的短期缓存 (一次冲突事件的量级)
const LLM_FALLBACK_TTL_MS = 30000; // 超时/解析失败的负缓存 — API 挂了别每拍捶
const DOC_CACHE_MS = 15000;        // 矩阵文件缓存 (监工可热改文件, 15s 内生效)
const LOG_DEDUP_MS = 10000;        // 同对同 verdict 的日志限频
const LOG_MAX_ENTRIES = 300;       // arbitration.json log 数组封顶

/** bot 挂载的仲裁器状态 (红线: 无模块级可变状态)。 */
function st(bot) {
    if (!bot) return null;
    if (!bot._arb) bot._arb = { doc: null, docAt: 0, verdicts: {}, asking: {}, logAt: {} };
    return bot._arb;
}

// ── 所有权令牌 ───────────────────────────────────────────────────────────────

/** 置身体所有权令牌 (kernel 派发 / mode execute 时调)。 */
export function setBodyOwner(bot, name, kind) {
    try { bot._bodyOwner = { name, kind, since: Date.now() }; } catch (e) {}
}

/** 释放令牌 — 只释放自己的 (owner-tag 语义: 后来者覆写过则这里是 no-op)。 */
export function releaseBodyOwner(bot, name) {
    try {
        if (bot._bodyOwner && bot._bodyOwner.name === name) bot._bodyOwner = null;
    } catch (e) {}
}

/** 当前身体持有者 — bot._bodyOwner 优先; ws/watchdog 等只置 supervised_skill 不置
 *  令牌的旧路径, 从 owner-tag 合成家族名 (`ws:*`), Phase 2 给它们补真令牌。 */
export function currentOwner(agent) {
    try {
        const bot = agent && agent.bot;
        if (bot && bot._bodyOwner && bot._bodyOwner.name) return bot._bodyOwner;
        const tag = agent && agent.supervised_skill;
        if (tag) return { name: `${tag}:*`, kind: 'skill', since: 0 };
    } catch (e) {}
    return null;
}

// ── 生死地板 ─────────────────────────────────────────────────────────────────

/** 唯一硬编码地板: oxygen<=8 / hp<=4 且掉血中 / 着火。其余一切走矩阵/LLM。 */
export function vitalNow(bot) {
    try {
        if (bot.oxygenLevel !== undefined && bot.oxygenLevel <= 8) return true;
        if ((bot.health ?? 20) <= 4 && Date.now() - (bot.lastDamageTime || 0) < 4000) return true;
        if (bot.entity) {
            if (bot.entity.onFire) return true;
            const p = bot.entity.position;
            const feet = bot.blockAt(p) || {};
            const head = bot.blockAt(p.offset(0, 1, 0)) || {};
            if (/fire|lava/.test(feet.name || '') || /fire|lava/.test(head.name || '')) return true;
        }
    } catch (e) {}
    return false;
}

// ── 矩阵持久化 (原子 tmp+rename, BOM-safe — egPatch 先例 skills.js:4626) ──────

/** 读全文档 {matrix, log, ...} — BOM-safe; 缺文件 = 空; 解析失败退 bot 缓存。 */
export function loadMatrix(bot) {
    const s = st(bot);
    if (s && s.doc && Date.now() - s.docAt < DOC_CACHE_MS) return s.doc;
    let doc = { matrix: {}, log: [] };
    try {
        let raw = fs.readFileSync(ARB_FILE, 'utf8');
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);   // strip UTF-8 BOM (C251 教训)
        const j = JSON.parse(raw);
        if (j && typeof j === 'object') {
            doc = Object.assign({}, j);
            if (!doc.matrix || typeof doc.matrix !== 'object') doc.matrix = {};
            if (!Array.isArray(doc.log)) doc.log = [];
        }
    } catch (e) {
        if (s && s.doc) doc = s.doc;   // 读失败保缓存 — 别让瞬时 IO 错清空学到的规则
    }
    if (s) { s.doc = doc; s.docAt = Date.now(); }
    return doc;
}

/** 原子写回 (tmp+rename — watchdog 中途 kill 不留撕裂 JSON)。log 封顶截尾。 */
export function saveMatrix(bot, doc) {
    try {
        if (Array.isArray(doc.log) && doc.log.length > LOG_MAX_ENTRIES)
            doc.log = doc.log.slice(-LOG_MAX_ENTRIES);
        const tmp = ARB_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
        fs.renameSync(tmp, ARB_FILE);
        const s = st(bot);
        if (s) { s.doc = doc; s.docAt = Date.now(); }
    } catch (e) {}
}

/** 家族通配键: 'kernel:nightShelter' → 'kernel:*'。 */
function famKey(name) {
    const n = String(name || '');
    const i = n.indexOf(':');
    return i > 0 ? n.slice(0, i) + ':*' : n;
}

/** 成对直查: 精确行/列 → 家族列 → 家族行 (精确优先 = 局部例外压过通配)。 */
function lookupMatrix(matrix, holderName, claimantName) {
    const rows = [holderName, famKey(holderName)];
    const cols = [claimantName, famKey(claimantName)];
    for (const r of rows) {
        const row = matrix[r];
        if (!row || typeof row !== 'object') continue;
        for (const c of cols) {
            const v = row[c];
            if (v === 'holder' || v === 'claimant') return { verdict: v, rule: `${r} vs ${c}` };
        }
    }
    return null;
}

// ── 可观测性 ─────────────────────────────────────────────────────────────────

/** 裁决落账: progress.txt 一行 + doc.log 一条。force=true (LLM 裁决这类单发事件)
 *  绕过限频; 常规路径同对同 verdict 10s 一条, 防反射每拍 300ms 的日志风暴。 */
function logVerdict(bot, holder, claimant, winner, source, why, ctx, force = false) {
    const out = { winner, source, why };
    try {
        const s = st(bot);
        const key = `${holder.name}→${claimant.name}`;
        const last = s && s.logAt[key];
        if (!force && last && last.winner === winner && Date.now() - last.at < LOG_DEDUP_MS) return out;
        if (s) s.logAt[key] = { winner, at: Date.now() };
        const observe = ctx && ctx.enforce === false ? ' [observe]' : '';
        fs.appendFileSync(PROGRESS_FILE,
            `[${new Date().toISOString()}] [arbiter] holder=${holder.name} claimant=${claimant.name} → ${winner} (${source})${observe}${why ? ' — ' + why : ''}\n`);
        const doc = loadMatrix(bot);
        doc.log.push({
            ts: new Date().toISOString(),
            holder: holder.name, claimant: claimant.name,
            ctx: (ctx && ctx.detail) || '', verdict: winner, source,
            persisted: source === 'llm-persist',
        });
        saveMatrix(bot, doc);
    } catch (e) {}
    return out;
}

// ── 裁决核心 ─────────────────────────────────────────────────────────────────

/**
 * 同步裁决 — 绝不阻塞 tick。
 * @param {{name:string, kind?:string, since?:number}} holder   当前身体持有者
 * @param {{name:string, kind?:string, vital?:boolean}} claimant 抢占者
 * @param {{agent?:any, enforce?:boolean, detail?:string}} ctx  enforce:false = 只观测
 *   (Phase 1 的 mode-vs-mode / ws 路径: 记 log 不执法、不问 LLM — 别为不执法的冲突烧钱)
 * @returns {{winner:'holder'|'claimant'|'pending', source:string, why:string}}
 *   pending = 矩阵未命中且 LLM 在路上 — 调用方按 holder 保留处理 (现状保持是安全默认)。
 * 顺序: vital 地板 → 矩阵直查 → (LLM 短期缓存) → pending + 异步 askLLM。
 * 地板最先 (生死底线是"地板, 不是阶梯"): vital claim 不进矩阵/LLM 系统 — 否则一条
 * 坏的 persist 规则 (holder 胜) 会把救命反射制度性压死, 这正是地板要防的死法。
 */
export function resolve(holder, claimant, ctx = {}) {
    try {
        if (!claimant || !claimant.name) return { winner: 'holder', source: 'default', why: 'no claimant' };
        if (!holder || !holder.name) return { winner: 'claimant', source: 'default', why: 'body unowned' };
        const agent = ctx.agent;
        const bot = agent && agent.bot;
        const doc = loadMatrix(bot);
        const pair = `${holder.name}→${claimant.name}`;

        // 1. 生死地板 — 秒抢: 不等 LLM, 不查矩阵 (唯一硬编码规则)
        if (claimant.vital) return logVerdict(bot, holder, claimant, 'claimant', 'floor', 'vital', ctx);

        // 2. 矩阵直查 (永久规则: 种子 + LLM persist 沉淀)
        const hit = lookupMatrix(doc.matrix, holder.name, claimant.name);
        if (hit) return logVerdict(bot, holder, claimant, hit.verdict, 'matrix', hit.rule, ctx);

        // 3. LLM 短期缓存 (persist:false 的裁决 / 超时负缓存)
        const s = st(bot);
        const cached = s && s.verdicts[pair];
        if (cached && Date.now() - cached.at < cached.ttl)
            return logVerdict(bot, holder, claimant, cached.winner, cached.source, cached.why, ctx);

        // 4. 未命中 → pending + 异步终裁 (只为执法路径烧 LLM; in-flight 去重)
        let asking = false;
        if (ctx.enforce !== false && agent && agent.prompter && s) {
            asking = true;
            if (!s.asking[pair] || Date.now() - s.asking[pair] > LLM_TIMEOUT_MS * 2) {
                s.asking[pair] = Date.now();
                askLLM(agent, holder, claimant, ctx);   // fire-and-forget; 内部全吞
            }
        }
        return logVerdict(bot, holder, claimant, 'pending', 'default', asking ? 'awaiting llm' : 'no llm (observe/no prompter)', ctx);
    } catch (e) {
        // 红线: 任何异常退化为"现状" (holder 保留), 永不抛出
        return { winner: 'holder', source: 'default', why: 'arbiter error: ' + ((e && e.message) || e) };
    }
}

/** 紧凑冲突快照 — 双方是谁 + vitals + 最近相关裁决, 喂给终裁 LLM。 */
function conflictSnapshot(bot, holder, claimant, ctx) {
    const v = {};
    try {
        v.hp = Math.round(bot.health ?? -1);
        v.food = bot.food ?? -1;
        v.oxygen = bot.oxygenLevel ?? 20;
        v.lastDamageAgoS = Math.round((Date.now() - (bot.lastDamageTime || 0)) / 1000);
        const p = bot.entity && bot.entity.position;
        if (p) {
            v.y = Math.floor(p.y);
            const feet = bot.blockAt(p) || {};
            const head = bot.blockAt(p.offset(0, 1, 0)) || {};
            v.inWater = /water/.test(feet.name || '') || /water/.test(head.name || '');
        }
        if (bot._mobility && bot._mobility.state) v.mobility = bot._mobility.state;
        let nearest = null;
        for (const e of Object.values(bot.entities || {})) {
            if (!e || e === bot.entity || !e.position || !e.name) continue;
            if (!/zombie|skeleton|creeper|spider|drowned|witch|pillager|stray|husk|enderman|blaze|ghast|piglin|slime|phantom/i.test(e.name)) continue;
            const d = e.position.distanceTo(p);
            if (nearest === null || d < nearest) nearest = d;
        }
        v.nearestHostile = nearest === null ? 'none' : Math.round(nearest * 10) / 10;
    } catch (e) {}
    let recent = [];
    try {
        const doc = loadMatrix(bot);
        recent = doc.log
            .filter(l => l.holder === holder.name || l.claimant === claimant.name || l.holder === claimant.name || l.claimant === holder.name)
            .slice(-3);
    } catch (e) {}
    return { vitals: v, recent, detail: (ctx && ctx.detail) || '' };
}

/**
 * LLM 终裁 (异步, 4s 超时) → {winner, persist, why}。
 * persist:true → 写矩阵成为永久规则 (学习闭环)。超时/解析失败 → holder (现状保持),
 * 负缓存 30s 防 API 挂掉时每拍重问。全程吞异常。
 * 直接走 prompter.chat_model.sendRequest — 单发、无 promptConvo 的 cooldown 排队/
 * 幻觉重试 (仲裁等不起会话冷却)。
 */
export async function askLLM(agent, holder, claimant, ctx = {}) {
    const bot = agent && agent.bot;
    const pair = `${holder.name}→${claimant.name}`;
    let winner = 'holder', persist = false, why = 'llm timeout/parse — 回退 holder', source = 'llm-fallback';
    try {
        const snap = conflictSnapshot(bot, holder, claimant, ctx);
        const sys = 'You are the BODY ARBITER of a Minecraft survival bot. Exactly one activity may control the body (pathfinder/dig/controls). '
            + 'HOLDER currently controls it; CLAIMANT wants to seize it. Decide who keeps the body RIGHT NOW, optimizing survival first, then task progress. '
            + 'Reply ONLY with JSON: {"winner": "holder"|"claimant", "persist": true|false, "why": "one sentence"}. '
            + 'Set persist=true ONLY if this pairing should ALWAYS resolve this way regardless of situation (it becomes a permanent rule).';
        const user = JSON.stringify({
            holder: { name: holder.name, kind: holder.kind || '', heldForS: holder.since ? Math.round((Date.now() - holder.since) / 1000) : null },
            claimant: { name: claimant.name, kind: claimant.kind || '', vital: !!claimant.vital },
            conflict: snap.detail, vitals: snap.vitals, recentVerdicts: snap.recent,
        });
        const raw = await withTimeout(
            agent.prompter.chat_model.sendRequest([{ role: 'user', content: user }], sys),
            LLM_TIMEOUT_MS, 'arbiter llm');
        const m = String(raw).match(/\{[\s\S]*\}/);
        if (m) {
            const j = JSON.parse(m[0]);
            if (j.winner === 'holder' || j.winner === 'claimant') {
                winner = j.winner;
                persist = !!j.persist;
                why = String(j.why || '').slice(0, 200);
                source = 'llm';
            }
        }
    } catch (e) { /* 超时/网络/解析 → 保持 fallback 值 */ }
    try {
        const s = st(bot);
        if (s) {
            s.verdicts[pair] = {
                winner, why, source,
                at: Date.now(),
                ttl: source === 'llm' ? LLM_VERDICT_TTL_MS : LLM_FALLBACK_TTL_MS,
            };
            delete s.asking[pair];
        }
        if (persist) {
            const doc = loadMatrix(bot);
            if (!doc.matrix[holder.name] || typeof doc.matrix[holder.name] !== 'object') doc.matrix[holder.name] = {};
            doc.matrix[holder.name][claimant.name] = winner;
            saveMatrix(bot, doc);
        }
        logVerdict(bot, holder, claimant, winner, persist ? 'llm-persist' : source, why, ctx, true);
    } catch (e) {}
    return { winner, persist, why };
}
