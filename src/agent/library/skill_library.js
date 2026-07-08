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
// Kept out of the catalog: pure diagnostics/tests, cheat helpers, and prepNether — which
// the user RETIRED (docs/…, memory) but whose file carries no RETIRED banner to auto-detect.
const _CUSTOM_SKILLS_BLOCKLIST = new Set(['diagBusy', 'crafttest', 'botstate', 'giveKit', 'prepNether']);
const _CUSTOM_SKILLS_TTL_MS = 300000;   // re-scan at most every 5 min (files are added rarely; hot-reload-friendly)

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

    // Build (and cache) a compact catalog of the runtime custom skills so the coding model
    // calls the tested procedure instead of re-writing it. One line each: name — purpose,
    // pulled from the file's leading `//` comment block. RETIRED skills (missionNether/
    // prepNether carry the marker) are excluded so the model can't resurrect them. All fs
    // access is wrapped — a scan failure must degrade to "no catalog", never break coding.
    getCustomSkillManifest() {
        const now = Date.now();
        if (this._customSkillManifest != null && (now - (this._customSkillManifestAt || 0)) < _CUSTOM_SKILLS_TTL_MS)
            return this._customSkillManifest;

        let manifest = '';
        try {
            const files = fs.readdirSync(_CUSTOM_SKILLS_DIR).filter(f => f.endsWith('.js'));
            const entries = [];
            for (const f of files) {
                const name = f.slice(0, -3);
                if (_CUSTOM_SKILLS_BLOCKLIST.has(name)) continue;
                let head = '';
                try { head = fs.readFileSync(path.join(_CUSTOM_SKILLS_DIR, f), 'utf8'); } catch (e) { continue; }
                // Leading contiguous `//` comment block = the file's description.
                const lines = head.split('\n');
                const commentLines = [];
                for (const raw of lines) {
                    const t = raw.trim();
                    if (t.startsWith('//')) { commentLines.push(t.replace(/^\/\/+\s?/, '')); continue; }
                    if (t === '') { if (commentLines.length) break; else continue; }
                    break;   // hit real code — stop
                }
                const blob = commentLines.join(' ');
                // Don't advertise retired/disabled skills. RETIRED/DISABLED are UPPERCASE banners,
                // so match case-SENSITIVE — a bare /disabled/i would wrongly catch a doc-filename
                // reference like "hp-instincts-disabled.md" in an ACTIVE skill's header (surviveNow).
                if (/\bRETIRED\b|\bDISABLED\b/.test(blob) || /退役/.test(blob) || /cheat[- ]give/i.test(blob)) continue;
                // First sentence-ish, trimmed to keep the catalog cheap on tokens.
                let purpose = blob.replace(/\s+/g, ' ').trim();
                const cut = purpose.search(/[.。]/);
                if (cut > 20) purpose = purpose.slice(0, cut);
                if (purpose.length > 140) purpose = purpose.slice(0, 137) + '…';
                if (!purpose) purpose = '(no description)';
                entries.push(`- ${name}: ${purpose}`);
            }
            entries.sort();
            if (entries.length) {
                manifest = '\nCUSTOM SKILLS — tested, hot-reloaded procedures. STRONGLY PREFER calling one of these '
                    + "over hand-writing equivalent logic. Invoke inside your code with:\n"
                    + "    await skills.customSkill(bot, '<name>', ...args)\n"
                    + entries.join('\n') + '\n';
            }
        } catch (e) {
            manifest = this._customSkillManifest || '';   // keep last good catalog on scan failure
        }
        this._customSkillManifest = manifest;
        this._customSkillManifestAt = now;
        return manifest;
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
