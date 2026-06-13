// arbiterCheck — one-shot, READ-ONLY: build the WorldModel from current live telemetry, run
// the Arbiter once, print the decision + the key worldModel fields, and exit. No loop, no
// control, no background process to manage. Used to validate Arbiter-vs-live before wiring the
// control-runner: does the Arbiter's mode match what the bot SHOULD be doing right now?
//
// Run: node bots/_supervisor/core/arbiterCheck.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildWorldModel } from './worldModel.mjs';
import { arbitrate } from './arbiter.mjs';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (n) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, n), 'utf8')); } catch { return null; } };

const vitals = rd('vitals.json');
if (!vitals) { console.log('no vitals.json'); process.exit(1); }
const now = Date.now();
const wm = buildWorldModel({ vitals, advisory: rd('advisory.json'), radar: rd('radar.json'), now, stalledMs: 0 });
const dec = arbitrate(wm, null);

console.log(JSON.stringify({
    pos: wm.pos, hp: wm.hp, food: wm.food, night: wm.isNight,
    mobility: wm.mobility, defense: wm.defense,
    threat: wm.threat, paralysis: wm.paralysis, insideDeathZone: wm.insideDeathZone,
    actualSkill: vitals.skill || null,
    ARBITER: dec.mode, reason: dec.reason,
}, null, 2));
