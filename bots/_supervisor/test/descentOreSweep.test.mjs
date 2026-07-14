import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Vec3 from 'vec3';
import {
    collectExposedOresDuringDescent,
    collectLiveOreBlock,
    descentOreFamily,
} from '../skills/descentOreSweep.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const key = (p) => `${p.x},${p.y},${p.z}`;
const makeWorld = ({ ores, solids = [], fluids = [], toolTypes = [3] }) => {
    const blocks = new Map();
    const mk = (name, position) => ({
        name,
        position,
        boundingBox: name === 'air' ? 'empty' : 'block',
        canHarvest(type) {
            if (/diamond|gold|redstone|emerald/.test(name)) return type === 3;
            if (/iron|lapis|copper/.test(name)) return type === 2 || type === 3;
            return type != null;
        },
    });
    for (const [name, p] of ores) blocks.set(key(p), mk(name, p));
    for (const p of solids) blocks.set(key(p), mk('stone', p));
    for (const [name, p] of fluids) blocks.set(key(p), mk(name, p));
    const mined = [];
    const bot = {
        entity: { position: new Vec3(0.5, 64, 0.5) },
        health: 20,
        interrupt_code: false,
        inventory: { items: () => toolTypes.map((type) => ({ type, name: type === 3 ? 'iron_pickaxe' : 'stone_pickaxe' })) },
        blockAt(position) { return blocks.get(key(position)) || mk('air', new Vec3(position.x, position.y, position.z)); },
        canSeeBlock: () => true,
    };
    const skills = {
        async breakBlockAt(_bot, x, y, z) {
            const p = new Vec3(x, y, z);
            mined.push(blocks.get(key(p)).name);
            blocks.delete(key(p));
            return true;
        },
        async pickupNearbyItems() {},
    };
    return { bot, ctx: { skills, Vec3 }, mined };
};

test('descent ore family normalizes deepslate variants', () => {
    assert.equal(descentOreFamily('deepslate_diamond_ore'), 'diamonds');
    assert.equal(descentOreFamily('iron_ore'), 'iron');
    assert.equal(descentOreFamily('stone'), null);
});

test('descent sweep prioritizes exposed diamond and follows its vein', async () => {
    const world = makeWorld({ ores: [
        ['iron_ore', new Vec3(1, 64, 0)],
        ['diamond_ore', new Vec3(0, 63, 1)],
        ['diamond_ore', new Vec3(0, 63, 2)],
    ] });
    const result = await collectExposedOresDuringDescent(world.bot, world.ctx);
    assert.equal(result.family, 'diamonds');
    assert.equal(result.mined, 2);
    assert.deepEqual(world.mined, ['diamond_ore', 'diamond_ore']);
});

test('explicit live target can drive a bounded approach without oracle data', async () => {
    const target = new Vec3(6, 64, 0);
    const world = makeWorld({ ores: [['diamond_ore', target]] });
    world.ctx.skills.goToPosition = async (bot) => { bot.entity.position = new Vec3(4.5, 64, 0.5); };
    const block = world.bot.blockAt(target);
    const result = await collectLiveOreBlock(world.bot, world.ctx, block, {
        expectedFamily: 'diamonds', approach: true, maxApproachDistance: 10, budgetMs: 2000,
    });
    assert.equal(result.mined, 1);
    assert.deepEqual(world.mined, ['diamond_ore']);
});

test('descent sweep refuses hidden, fluid-plugging, and wrong-tool diamond ore', async () => {
    const hidden = new Vec3(1, 64, 0);
    const hiddenSides = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
        .map(([x, y, z]) => hidden.offset(x, y, z));
    const buried = makeWorld({ ores: [['diamond_ore', hidden]], solids: hiddenSides });
    assert.equal((await collectExposedOresDuringDescent(buried.bot, buried.ctx)).mined, 0);

    const wetOre = new Vec3(1, 64, 0);
    const wet = makeWorld({ ores: [['diamond_ore', wetOre]], fluids: [['water', wetOre.offset(0, 0, 1)]] });
    assert.equal((await collectExposedOresDuringDescent(wet.bot, wet.ctx)).mined, 0);

    const wrongTool = makeWorld({ ores: [['diamond_ore', new Vec3(1, 64, 0)]], toolTypes: [2] });
    assert.equal((await collectExposedOresDuringDescent(wrongTool.bot, wrongTool.ctx)).mined, 0);
});

test('descent paths and general ore mining invoke bounded live-world collection', () => {
    const skillsDir = path.join(HERE, '..', 'skills');
    const mineDown = fs.readFileSync(path.join(skillsDir, 'mineDown.js'), 'utf8');
    const mineDiamonds = fs.readFileSync(path.join(skillsDir, 'mineDiamonds.js'), 'utf8');
    const mineOres = fs.readFileSync(path.join(skillsDir, 'mineOres.js'), 'utf8');
    assert.match(mineDown, /collectExposedOresDuringDescent\(bot, ctx\)/);
    assert.match(mineDiamonds, /collectExposedOresDuringDescent\(bot, ctx\)/);
    assert.match(mineOres, /LIVE-FIRST/);
    assert.match(mineOres, /collectLiveOreBlock\(bot, ctx, block/);
});
