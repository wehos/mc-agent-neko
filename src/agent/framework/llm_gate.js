// llm_gate.js — framework-v2: the SYNCHRONOUS LLM-ask-on-trigger gate (design §4).
//
// Present but DISABLED by default. User constraint (verbatim): "目前先关掉,但是要有这个模块" +
// "LLM全程不出声/纯本能/self-prompt绝不启用". So the DEFAULT path is pure instinct: llmGate()
// returns {proceed:true} INSTANTLY with ZERO LLM calls and ZERO chat output. Only when explicitly
// enabled (decision-config.json llmGate:true + a prompter wired via wireLlm) does it consult the
// model. This module owns ONLY the enable flag + the gate fn + the prompter injection seat; the
// cancellation LEDGER lives in triggers.js (single source of truth) — a cancel verdict delegates to
// triggers.cancelTrigger, this module keeps no second store.
//
// Two call seats (both behind `if (llmGateEnabled())` in callers):
//   SEAT 1: on a trigger firing (before enqueuing the task)
//   SEAT 2: on a task returning to the queue head (reevaluateHead, design §3.4)

import fs from 'fs';
import path from 'path';
import { cancelTrigger, lifecycleKey, getTrigger } from './triggers.js';

const CFG = path.resolve(process.cwd(), 'bots', '_supervisor', 'decision-config.json');

let _enabled = null;        // cached; null = unread
let _prompter = null;       // injected async (task, world, reason) => verdict, wired by the agent boot

/** BOM-safe config read (mirrors world_model.js:76-105 — PowerShell-written JSON can carry a BOM
 *  that makes JSON.parse throw, which a silent catch would balloon into a dead-idle deadlock). */
function readCfg() {
    try { return JSON.parse(fs.readFileSync(CFG, 'utf8').replace(/^﻿/, '')) || {}; }
    catch (e) { return {}; }
}

/** Is the gate ON? Default OFF (pure instinct). Re-reads config cheaply so a flag flip needs no
 *  code redeploy (watchdog-restart picks it up; we also refresh on each call to honour live edits). */
export function llmGateEnabled() {
    try {
        const cfg = readCfg();
        _enabled = !!cfg.llmGate;
    } catch (e) { _enabled = false; }
    return _enabled === true;
}

/** Wire a prompter later WITHOUT touching callers (kept null = stub). The prompter must be a sync-ish
 *  awaitable returning { proceed:boolean, cancel?:boolean, reorderHint?:string }. */
export function wireLlm(prompterFn) { _prompter = (typeof prompterFn === 'function') ? prompterFn : null; }

/** The gate. DISABLED → instant {proceed:true}, no LLM, no output. ENABLED → consult prompter;
 *  a cancel verdict is recorded in the trigger lifecycle ledger (triggers.cancelTrigger) for the
 *  task's CURRENT lifecycle-key, so the cancellation scope matches "this night / this encounter". */
export async function llmGate(task, world, bot, reason) {
    if (!llmGateEnabled() || !_prompter) return { proceed: true };       // ← load-bearing pure-instinct path
    let verdict;
    try { verdict = await _prompter(task, world, reason); }
    catch (e) { return { proceed: true }; }                              // fail-open: never block instinct on LLM error
    if (verdict && verdict.cancel && !verdict.proceed) {
        try {
            const tr = task && task.kind ? getTrigger(task.kind) : null;
            const key = tr ? lifecycleKey(tr, world, bot) : (task && task.trigger && task.trigger.episodeId) || null;
            if (key != null) cancelTrigger(bot, task.kind, key, reason || 'llm-cancel');
        } catch (e) {}
        return { proceed: false, cancel: true };
    }
    return { proceed: verdict ? verdict.proceed !== false : true, reorderHint: verdict && verdict.reorderHint };
}
