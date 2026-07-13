import fs from 'fs';
import path from 'path';
import { cosineSimilarity } from '../../utils/math.js';
import { getSkillDocs } from './index.js';
import { wordOverlapScore } from '../../utils/text.js';

// Directory of hot-reloadable custom skills the supervisor drops in at runtime.
// getSkillDocs()/getRelevantSkillDocs only surface the `skills.*`/`world.*` PRIMITIVES,
// so the coding model never knew these tested procedures (realNetherPortal, chopWood, …)
// existed and kept hand-rolling them from scratch inside !newAction (live incident:
// a "build nether portal" admin mission re-derived realNetherPortal's temp-support +
// top-face-light idioms over ~48 min instead of just calling it). This manifest is
// appended to $CODE_DOCS so the model prefers `skills.customSkill(bot,'<name>')`.
const _CUSTOM_SKILLS_DIR = path.resolve(process.cwd(), 'bots', '_supervisor', 'skills');
// Kept out of the catalog AND out of the !runSkill allowlist (the two share this filter):
//   • pure diagnostics/tests, cheat helpers, and prepNether — the user RETIRED prepNether
//     (docs/…, memory) but its file carries no RETIRED banner to auto-detect.
//   • ★2026-07-13 hardening: the skills dir has grown a batch of human-only ONE-SHOT
//     dev/cheat/test/reset/kernel helpers that must NEVER be fired by the autonomous LLM
//     (now trivially reachable via !runSkill). None carry a RETIRED/DISABLED/cheat-give
//     banner, so name-list them here:
//       - kernelDriver: the live TOP-LEVEL dispatcher — invoking it nested grabs the
//         _skillRunning lock and corrupts dispatch. Catastrophic to run as a child skill.
//       - devGive / giveBed / devTool: cheat item/bed grants + dev tool-firing harness
//         (a cheat undermines the organic-bootstrap goal; devTool fires arbitrary v2 tools).
//       - forceReset / digReset: DELIBERATE death-resets — the LLM must not self-kill.
//       - mockSeal / installMotionAudit: test rigs (mockSeal /fills a solid box around her).
//       - verifyMove / verifyWalk: locomotion probes explicitly marked "NOT a mission skill".
//       - freeBot: emergency un-trap that also resurrects the deprecated missionNether sticky.
//     (Borderline base/emergency skills — sealBedBunker, relocateToPlains, declutterInv —
//      are LEFT runnable on purpose; move them here if they misfire.)
//   BOUNDARY (be honest about what this gate is): it gates the !runSkill command and the
//   LLM-facing catalog — the low-effort, advertised path. It is NOT enforced inside
//   skills.customSkill itself, deliberately: ws_server.js:685 and framework/kernel.js:591
//   launch the sticky top-level dispatcher (kernelDriver) and its children THROUGH customSkill,
//   so a name-check there would kill live dispatch. !newAction code is arbitrary JS anyway
//   (could dynamic-import the file directly) — its real boundary is allow_insecure_coding.
const _CUSTOM_SKILLS_BLOCKLIST = new Set([
    'diagBusy', 'crafttest', 'botstate', 'giveKit', 'prepNether',
    'kernelDriver', 'devGive', 'giveBed', 'devTool', 'forceReset', 'digReset',
    'mockSeal', 'installMotionAudit', 'verifyMove', 'verifyWalk', 'freeBot',
]);
const _CUSTOM_SKILLS_TTL_MS = 300000;   // re-scan at most every 5 min (files are added rarely; hot-reload-friendly)

// Split a function's raw parameter string on TOP-LEVEL commas only, so a default value that
// itself contains commas (e.g. `opts = { a, b }`) stays in one piece. String-aware like its
// companion _readBalanced — a default like `sep = ','` or `mark = ')'` must not corrupt the
// depth counter or split inside the literal. Used to peel the fixed (bot, ctx) prefix off a
// custom skill's signature and keep the rest for the catalog.
function _splitParams(s) {
    const str = String(s);
    const out = [];
    let depth = 0, inStr = null, cur = '';
    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (inStr) {
            cur += ch;
            if (ch === '\\') { cur += str[i + 1] ?? ''; i++; continue; }
            if (ch === inStr) inStr = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; cur += ch; continue; }
        if (ch === '(' || ch === '{' || ch === '[') depth++;
        else if (ch === ')' || ch === '}' || ch === ']') depth--;
        if (ch === ',' && depth === 0) { out.push(cur); cur = ''; }
        else cur += ch;
    }
    if (cur.trim() !== '') out.push(cur);
    return out;
}

// Read from an opening bracket at `openIdx` to its MATCHING close, bracket-balanced and
// string-aware (so parens inside a default value like `= new Set()` or a string `= ')'`
// don't end it early). Returns the inner text, or null if unbalanced. str[openIdx] must be '('.
function _readBalanced(str, openIdx) {
    let depth = 0, inStr = null;
    const start = openIdx + 1;
    for (let i = openIdx; i < str.length; i++) {
        const ch = str[i];
        if (inStr) {
            if (ch === '\\') { i++; continue; }   // skip escaped char
            if (ch === inStr) inStr = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
        if (ch === '(' || ch === '{' || ch === '[') depth++;
        else if (ch === ')' || ch === '}' || ch === ']') {
            if (--depth === 0) return str.slice(start, i);
        }
    }
    return null;   // unbalanced — bail rather than emit a malformed signature
}

// Extract a custom skill's call params = everything AFTER the fixed (bot, ctx), as an array of
// raw param strings (e.g. ['length = 24', 'targetY = null']). Handles the inline default export
// (function or arrow) and the indirect `export default NAME;` form. Uses a balanced scan (not a
// `[^)]*` regex) so paren-containing defaults (e.g. `_active = new Set()`) don't truncate the
// signature. Returns [] for a no-arg skill, or null if it can't be parsed.
function _extractSkillParams(head) {
    let m = /export\s+default\s+(?:async\s+)?function\s*[A-Za-z0-9_$]*\s*\(/.exec(head)
         || /export\s+default\s+(?:async\s+)?\(/.exec(head);
    if (!m) {
        const dm = /export\s+default\s+([A-Za-z0-9_$]+)\s*;?/.exec(head);
        // '$' is legal in the identifier charset but is a regex metachar — escape it, or the
        // built pattern silently never matches (mid-pattern end-anchor).
        if (dm) m = new RegExp('function\\s+' + dm[1].replace(/\$/g, '\\$') + '\\s*\\(').exec(head);
    }
    if (!m) return null;
    const openIdx = m.index + m[0].length - 1;   // the '(' the match ends on
    const inner = _readBalanced(head, openIdx);
    if (inner == null) return null;
    return _splitParams(inner).slice(2).map(s => s.trim()).filter(Boolean);
}

// Derive one catalog/allowlist entry from a skill file's text, or null to exclude it
// (RETIRED/DISABLED banner, cheat-give marker). Shared by the sync and async scan paths so
// the filter semantics can't fork.
//   name/purpose — catalog line;  sig — visible params joined (internal `_`-prefixed params
//   are hidden: they are recursion/memo tokens, never caller-facing — advertising them invites
//   crashes like a string landing in achieve's `_active` Set);  params/paramNames — the visible
//   param strings and their bare names, used by !runSkill to map key=val onto positional slots;
//   takesObject — lone param defaulting to an object literal (opts={...});  trailingObject —
//   last of several params defaults to an object literal (mixed sig like chopWood(count, opts));
//   hasRest — signature uses ...rest (disable arg-count trimming).
function _parseSkillEntry(name, head) {
    // Walk the PRE-CODE region: everything (comments `//` and `/* */`, blanks, import lines)
    // before the first real code line. Two products:
    //   • bannerText — ALL comment text in that region. Retirement banners may sit BELOW the
    //     import block (natural style, seen live) or in a /* */ block, so banner detection
    //     covers the whole pre-code region — but NOT the function body: an inline note about a
    //     sub-mechanism (nightShelter.js:26 "SURFACE WALL-BOX ... DISABLED") must not retire
    //     the whole ACTIVE skill. Case-SENSITIVE \bRETIRED\b|\bDISABLED\b — a doc-filename
    //     like "hp-instincts-disabled.md" in an active header (surviveNow) must not match.
    //   • descBlock — the first contiguous `//` block (the description), which may sit after
    //     imports (escapePlan.js used to scan as '(no description)').
    const preCodeComments = [];
    const descBlock = [];
    let descDone = false;
    let inBlock = false;   // inside /* */
    for (const rawLine of head.split('\n').slice(0, 120)) {
        let t = rawLine.trim();
        if (inBlock) {
            const end = t.indexOf('*/');
            if (end < 0) { preCodeComments.push(t); continue; }
            preCodeComments.push(t.slice(0, end));
            inBlock = false;
            t = t.slice(end + 2).trim();
            if (!t) continue;
        }
        if (t.startsWith('//')) {
            const text = t.replace(/^\/\/+\s?/, '');
            preCodeComments.push(text);
            if (!descDone) descBlock.push(text);
            continue;
        }
        if (t.startsWith('/*')) {
            if (descBlock.length) descDone = true;
            const end = t.indexOf('*/', 2);
            if (end >= 0) { preCodeComments.push(t.slice(2, end)); }
            else { preCodeComments.push(t.slice(2)); inBlock = true; }
            continue;
        }
        if (t === '') { if (descBlock.length) descDone = true; continue; }
        if (/^(import\s|export\s*\{|const\s.+=\s*require\s*\()/.test(t)) {
            if (descBlock.length) descDone = true;
            continue;
        }
        break;   // first real code line — the banner/description region ends here
    }
    const bannerText = preCodeComments.join(' ');
    if (/\bRETIRED\b|\bDISABLED\b/.test(bannerText) || /退役/.test(bannerText)) return null;
    const blob = descBlock.join(' ');
    if (/cheat[- ]give/i.test(blob)) return null;
    // First sentence-ish, trimmed to keep the catalog cheap on tokens.
    let purpose = blob.replace(/\s+/g, ' ').trim();
    const cut = purpose.search(/[.。]/);
    if (cut > 20) purpose = purpose.slice(0, cut);
    if (purpose.length > 140) purpose = purpose.slice(0, 137) + '…';
    if (!purpose) purpose = '(no description)';

    let allParams = null;
    try { allParams = _extractSkillParams(head); } catch (e) { allParams = null; }
    if (allParams == null)
        return { name, purpose, sig: null, params: null, paramNames: null, takesObject: false, trailingObject: false, hasRest: false };
    const params = allParams.filter(p => !p.startsWith('_'));   // hide internal params
    const paramNames = params.map(p => p.split('=')[0].trim());
    const objDefault = p => /=\s*\{/.test(p);
    return {
        name, purpose,
        sig: params.join(', '),
        params, paramNames,
        takesObject: params.length === 1 && objDefault(params[0]),
        trailingObject: params.length >= 2 && objDefault(params[params.length - 1]),
        hasRest: allParams.some(p => p.startsWith('...')),
    };
}

export class SkillLibrary {
    constructor(agent,embedding_model) {
        this.agent = agent;
        this.embedding_model = embedding_model;
        this.skill_docs_embeddings = {};
        this.skill_docs = null;
        // ★ pillarUp pinned: the "挖点泥土垫起来继续挖木头 / 垫高够到上方方块" admin primitive.
        // Live incident 2026-07-09: embedding retrieval didn't rank pillarUp into the top-5
        // relevant docs for that task, so the coder never saw it and hand-rolled a dirt-dig
        // routine that walked DOWNHILL (y 68→64), then falsely reported "垫高后仍无法够到足够木头"
        // without ever towering. Force-showing it keeps the tested MLG-tower in the coder's
        // vocabulary for any pillar/reach-above task.
        this.always_show_skills = ['skills.placeBlock', 'skills.wait', 'skills.breakBlockAt', 'skills.pillarUp']
    }
    async initSkillLibrary() {
        const skillDocs = getSkillDocs();
        this.skill_docs = skillDocs;
        if (this.embedding_model) {
            try {
                const embeddingPromises = skillDocs.map((doc) => {
                    return (async () => {
                        let func_name_desc = doc.split('\n').slice(0, 2).join('');
                        this.skill_docs_embeddings[doc] = await this.embedding_model.embed(func_name_desc);
                    })();
                });
                await Promise.all(embeddingPromises);
            } catch (error) {
                console.warn('Error with embedding model, using word-overlap instead.');
                this.embedding_model = null;
            }
        }
        this.always_show_skills_docs = {};
        for (const skillName of this.always_show_skills) {
            this.always_show_skills_docs[skillName] = this.skill_docs.find(doc => doc.includes(skillName));
        }
    }

    async getAllSkillDocs() {
        return this.skill_docs;
    }

    // Single source of truth for "which custom skills exist and what they do". Scans
    // _CUSTOM_SKILLS_DIR, applies the shared allowlist (blocklist + RETIRED/DISABLED/退役/
    // cheat-give marker via _parseSkillEntry), and returns the survivors sorted by name.
    // getCustomSkillManifest() (the LLM-facing catalog) and getRunnableSkillNames()/
    // getRunnableSkillEntry() (the !runSkill allowlist) ALL derive from this, so "what the
    // LLM is shown == what it can run" can never drift. NEVER throws; a scan failure degrades
    // to the last good result, then [].
    // Freshness model: the FIRST scan is synchronous (startup — the prompt being built needs
    // content now); after that, a TTL-expired call returns the STALE cache immediately and
    // refreshes in the background via fs.promises. getCommandDocs() puts this on the
    // every-turn conversing-prompt path, and the event loop is shared with the bot's physics
    // tick — a synchronous ~1.2MB re-read burst there is exactly what the sync-fs 收口 pass
    // (760bb32) removed, so steady-state must never block on fs.
    // NOTE (bounded staleness): adding a RETIRED/DISABLED banner to a skill takes up to
    // _CUSTOM_SKILLS_TTL_MS (+1 stale serve) to stop it being advertised AND runnable. That's
    // acceptable for soft retirement of a strategy skill (self-heals in minutes); for anything
    // that must be un-runnable IMMEDIATELY, use _CUSTOM_SKILLS_BLOCKLIST — applied fresh in
    // every scan, though editing it needs an agent restart (src is not hot-reloaded), so for
    // live ops a banner in the skill file is usually the FASTER lever.
    _scanCustomSkills() {
        const now = Date.now();
        const fresh = this._customSkillScan != null
            && (now - (this._customSkillScanAt || 0)) < _CUSTOM_SKILLS_TTL_MS;
        if (fresh) return this._customSkillScan;
        if (this._customSkillScan != null) {           // stale: serve it, refresh off-loop
            this._refreshCustomSkillsAsync();
            return this._customSkillScan;
        }
        // First scan (no cache yet): synchronous, one-time, on the startup path.
        let entries = [];
        try {
            const files = fs.readdirSync(_CUSTOM_SKILLS_DIR).filter(f => f.endsWith('.js'));
            for (const f of files) {
                const name = f.slice(0, -3);
                if (_CUSTOM_SKILLS_BLOCKLIST.has(name)) continue;
                let head = '';
                try { head = fs.readFileSync(path.join(_CUSTOM_SKILLS_DIR, f), 'utf8'); } catch (e) { continue; }
                const entry = _parseSkillEntry(name, head);
                if (entry) entries.push(entry);
            }
            entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        } catch (e) {
            entries = [];   // dir unreadable — cache the empty result too, so the TTL still
        }                   // bounds retry frequency instead of every call re-hitting fs
        this._customSkillScan = entries;
        this._customSkillScanAt = now;
        return entries;
    }

    // Background rescan (fs.promises — no event-loop stall). Stamps the timestamp on success
    // AND failure so a persistently-failing dir is retried at most once per TTL, and keeps the
    // last good entries on failure. Fire-and-forget; concurrent kicks are coalesced.
    _refreshCustomSkillsAsync() {
        if (this._customSkillRefreshing) return;
        this._customSkillRefreshing = true;
        (async () => {
            try {
                const files = (await fs.promises.readdir(_CUSTOM_SKILLS_DIR)).filter(f => f.endsWith('.js'));
                const entries = [];
                for (const f of files) {
                    const name = f.slice(0, -3);
                    if (_CUSTOM_SKILLS_BLOCKLIST.has(name)) continue;
                    let head = '';
                    try { head = await fs.promises.readFile(path.join(_CUSTOM_SKILLS_DIR, f), 'utf8'); } catch (e) { continue; }
                    const entry = _parseSkillEntry(name, head);
                    if (entry) entries.push(entry);
                }
                entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
                this._customSkillScan = entries;
            } catch (e) {
                // keep last good entries
            } finally {
                this._customSkillScanAt = Date.now();
                this._customSkillRefreshing = false;
            }
        })();
    }

    // Build a compact catalog of the runtime custom skills so the model calls the tested
    // procedure instead of re-writing it. One line each: name(signature) — purpose. The header
    // is CONTEXT-SPECIFIC: 'command' (default; $COMMAND_DOCS via getCommandDocs) teaches the
    // !runSkill chat form, 'code' ($CODE_DOCS via prompter) teaches ONLY the
    // skills.customSkill(...) code form — the coding model has no ! commands, and teaching it
    // one produced command-syntax inside generated JS. The 'code' header also scopes customSkill
    // to the skills LISTED here: the blocklisted dev/cheat/kernel names must not be advertised
    // as callable-by-name (customSkill itself stays ungated — ws_server:685/kernel:591 launch
    // the sticky dispatcher through it, so a hard blocklist there would kill live dispatch; the
    // real boundary for arbitrary code is allow_insecure_coding).
    getCustomSkillManifest(context = 'command') {
        const entries = this._scanCustomSkills();   // never throws; TTL-cached
        if (!entries.length) return '';
        const line = e => {
            const shape = e.sig == null ? '' : `(${e.sig})`;   // null sig → omit parens (unknown, not no-arg)
            return `- ${e.name}${shape}: ${e.purpose}`;
        };
        const header = context === 'code'
            ? '\nCUSTOM SKILLS — tested, hot-reloaded procedures available to your code. STRONGLY PREFER '
                + 'calling one of these over hand-writing equivalent logic:\n'
                + "    await skills.customSkill(bot, '<name>', ...args)\n"
                + 'Each line shows the args signature after the fixed (bot, ctx). Only the skills listed '
                + 'here are sanctioned — do not invoke other names.\n'
            : '\nCUSTOM SKILLS — tested, hot-reloaded procedures. STRONGLY PREFER these over writing '
                + 'code with !newAction. Each line shows the call signature. Run one with:\n'
                + '    !runSkill("<name>", "<args>")\n'
                + 'Encoding for <args> (never JSON, never quotes inside): no params → "". RECOMMENDED: '
                + '"key=val;key=val" — keys are matched to the signature\'s param names, and unmatched keys '
                + 'go into the trailing opts={} param when the signature has one (e.g. "targetY=-54", '
                + '"ore=iron", "count=8;needLogs=32"). Or positional values in order: "24,-54".\n';
        return header + entries.map(line).join('\n') + '\n';
    }

    // Allowlist of custom skills that !runSkill may invoke — exactly the set the LLM is shown
    // in getCustomSkillManifest() (same _scanCustomSkills filter), so "advertised == runnable"
    // holds by construction. Returns a Set of bare names (no .js). Never throws — the
    // guarantee lives in _scanCustomSkills.
    getRunnableSkillNames() {
        return new Set(this._scanCustomSkills().map(e => e.name));
    }

    // Full catalog entry ({name, purpose, sig, params, paramNames, takesObject, trailingObject,
    // hasRest}) for one runnable skill, or null if the name isn't runnable. !runSkill uses it to
    // validate the name and decode args against the real signature. Treat as READ-ONLY — the
    // entry object is the shared cache. Never throws.
    getRunnableSkillEntry(name) {
        return this._scanCustomSkills().find(x => x.name === name) || null;
    }

    async getRelevantSkillDocs(message, select_num) {
        if(!message) // use filler message if none is provided
            message = '(no message)';
        let skill_doc_similarities = [];

        // when the embedding model is unavailable (or fails below), fall back to
        // word-overlap over the raw doc texts — skill_docs_embeddings may be
        // empty or partial in that case, so it can't be used as the doc list.
        const wordOverlapRank = () => (this.skill_docs || [])
            .map(doc_key => ({
                doc_key,
                similarity_score: wordOverlapScore(message, doc_key)
            }))
            .sort((a, b) => b.similarity_score - a.similarity_score);

        if (select_num === -1) {
            skill_doc_similarities = (this.skill_docs || [])
            .map(doc_key => ({
                doc_key,
                similarity_score: 0
            }));
        }
        else if (!this.embedding_model) {
            skill_doc_similarities = wordOverlapRank();
        }
        else {
            let latest_message_embedding = null;
            try {
                latest_message_embedding = await this.embedding_model.embed(message);
            } catch (error) {
                // embed is time-bounded; a timeout/network failure must not fail
                // the prompt — degrade to word-overlap for this call.
                console.warn('Embedding failed at runtime, using word-overlap for this query:', error.message);
            }
            if (latest_message_embedding === null) {
                skill_doc_similarities = wordOverlapRank();
            }
            else {
                skill_doc_similarities = Object.keys(this.skill_docs_embeddings)
                .map(doc_key => ({
                    doc_key,
                    similarity_score: cosineSimilarity(latest_message_embedding, this.skill_docs_embeddings[doc_key])
                }))
                .sort((a, b) => b.similarity_score - a.similarity_score);
            }
        }

        let length = skill_doc_similarities.length;
        if (select_num === -1 || select_num > length) {
            select_num = length;
        }
        // Get initial docs from similarity scores
        let selected_docs = new Set(skill_doc_similarities.slice(0, select_num).map(doc => doc.doc_key));
        
        // Add always show docs
        Object.values(this.always_show_skills_docs).forEach(doc => {
            if (doc) {
                selected_docs.add(doc);
            }
        });
        
        let relevant_skill_docs = '#### RELEVANT CODE DOCS ###\nThe following functions are available to use:\n';
        relevant_skill_docs += Array.from(selected_docs).join('\n### ');

        console.log('Selected skill docs:', Array.from(selected_docs).map(doc => {
            const first_line_break = doc.indexOf('\n');
            return first_line_break > 0 ? doc.substring(0, first_line_break) : doc;
        }));
        return relevant_skill_docs;
    }
}
