import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    chooseHealingPotion,
    healingPotionEffect,
    shouldAutoEat,
} from '../src/agent/framework/healing_reflex.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('carried food heals independently of proactive food instincts', () => {
    assert.equal(shouldAutoEat({ health: 19, food: 17, foodInstincts: false }), true);
    assert.equal(shouldAutoEat({ health: 20, food: 17, foodInstincts: false }), false);
    assert.equal(shouldAutoEat({ health: 20, food: 17, foodInstincts: true }), true);
    assert.equal(shouldAutoEat({ health: 0, food: 0, foodInstincts: true }), false);
});

test('only drinkable healing/regeneration potions are selected', () => {
    const regen = { name: 'potion', components: { potion_contents: { potion: 'minecraft:long_regeneration' } } };
    const healing = { name: 'potion', nbt: { value: { Potion: { value: 'minecraft:strong_healing' } } } };
    const harming = { name: 'potion', nbt: { value: { Potion: { value: 'minecraft:harming' } } } };
    const splash = { name: 'splash_potion', nbt: { value: { Potion: { value: 'minecraft:healing' } } } };

    assert.equal(healingPotionEffect(regen), 'regeneration');
    assert.equal(healingPotionEffect(healing), 'instant_health');
    assert.equal(healingPotionEffect(harming), null);
    assert.equal(healingPotionEffect(splash), null);
    assert.equal(chooseHealingPotion([regen, harming, healing]), healing);
});

test('retired low-health routes cannot be restored by an old switch', () => {
    const files = [
        'src/agent/framework/contracts.js',
        'src/agent/framework/kernel.js',
        'src/agent/framework/arbiter.js',
        'src/agent/framework/world_model.js',
        'src/agent/modes.js',
        'bots/_supervisor/skills/kernelDriver.js',
        'bots/_supervisor/skills/prepNether.js',
        'bots/_supervisor/skills/missionNether.js',
        'bots/_supervisor/skills/feedUp.js',
        'bots/_supervisor/skills/migrate.js',
        'bots/_supervisor/skills/forageExplore.js',
        'watchdog.ps1',
        'start-neko.ps1',
        'start-neko-direct.bat',
    ];
    const combined = files.map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
    assert.doesNotMatch(combined, /MC_HP_INSTINCTS|hpInstinctsEnabled|surviveNowEnabled|gateHp|abortHp/);
    assert.doesNotMatch(combined, /_surviveNowUntil|SURVIVE_NOW|_grayZoneSignal|kernel:surviveNow/);

    for (const skill of ['surviveNow.js', 'digReset.js']) {
        const source = fs.readFileSync(path.join(root, 'bots/_supervisor/skills', skill), 'utf8');
        assert.match(source, /retired: true/);
    }
});

test('supervisor skills contain no positive absolute-health action gate', () => {
    const dir = path.join(root, 'bots/_supervisor/skills');
    const offenders = [];
    for (const name of fs.readdirSync(dir).filter(name => /\.js$/.test(name))) {
        const lines = fs.readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/);
        lines.forEach((line, index) => {
            if (/^\s*\/\//.test(line) || /hp0\s*-\s*bot\.health/.test(line)) return;
            if (/bot\.health\s*(?:<=|<|>=|>)\s*[1-9]/.test(line)) offenders.push(`${name}:${index + 1}`);
        });
    }
    assert.deepEqual(offenders, []);
});

test('core routing has no positive absolute-health gate outside carried healing', () => {
    const files = [
        'src/agent/framework/arbiter.js',
        'src/agent/framework/kernel.js',
        'src/agent/framework/world_model.js',
        'src/agent/framework/instinct.js',
    ];
    const offenders = [];
    for (const file of files) {
        const source = fs.readFileSync(path.join(root, file), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
        source.split(/\r?\n/).forEach((line, index) => {
            if (/\b(?:bot\.)?health\s*(?:<=|<|>=|>)\s*[1-9]/.test(line)) {
                offenders.push(`${file}:${index + 1}`);
            }
        });
    }
    assert.deepEqual(offenders, []);
});
