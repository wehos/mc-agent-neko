import assert from 'node:assert/strict';
import test from 'node:test';
import Vec3 from 'vec3';
import {
    collectDropItemName,
    collectOreBlockTypes,
    harvestConnectedVein,
} from '../src/agent/library/skills.js';

const key = (p) => `${p.x},${p.y},${p.z}`;
const ore = (name, position) => ({ name, position, boundingBox: 'block' });

function makeVein(entries) {
    const blocks = new Map(entries.map(([name, position]) => [key(position), ore(name, position)]));
    const bot = {
        interrupt_code: false,
        blockAt(position) {
            return blocks.get(key(position)) || { name: 'air', position, boundingBox: 'empty' };
        },
    };
    return { bot, blocks };
}

test('exact ore block names count their real inventory drops', () => {
    assert.equal(collectDropItemName('coal_ore'), 'coal');
    assert.equal(collectDropItemName('deepslate_coal_ore'), 'coal');
    assert.equal(collectDropItemName('diamond_ore'), 'diamond');
    assert.equal(collectDropItemName('deepslate_diamond_ore'), 'diamond');
    assert.equal(collectDropItemName('iron_ore'), 'raw_iron');
    assert.equal(collectDropItemName('deepslate_lapis_ore'), 'lapis_lazuli');
    assert.deepEqual(collectOreBlockTypes('coal_ore'), ['coal_ore', 'deepslate_coal_ore']);
    assert.deepEqual(collectOreBlockTypes('diamond'), ['diamond_ore', 'deepslate_diamond_ore']);
});

test('vein follow retries a temporarily occluded tail after its neighbour is mined', async () => {
    const start = new Vec3(0, 0, 0); // already-mined seed block
    const tail = new Vec3(-1, -1, -1);
    const opener = new Vec3(-1, -1, 0);
    const world = makeVein([
        ['coal_ore', tail],
        ['coal_ore', opener],
    ]);
    const attempts = new Map();
    const mined = await harvestConnectedVein(world.bot, start, ['coal_ore', 'deepslate_coal_ore'], 64, {
        dig: (block) => {
            attempts.set(key(block.position), (attempts.get(key(block.position)) || 0) + 1);
            if (block.position.equals(tail) && world.blocks.has(key(opener))) return Promise.resolve('occluded');
            world.blocks.delete(key(block.position));
            return Promise.resolve('ok');
        },
    });

    assert.equal(mined, 2);
    assert.equal(attempts.get(key(tail)), 2);
    assert.equal(world.blocks.size, 0);
});

test('vein follow includes a three-axis corner-connected ore block', async () => {
    const start = new Vec3(0, 0, 0);
    const corner = new Vec3(1, 1, 1);
    const world = makeVein([['deepslate_diamond_ore', corner]]);
    const mined = await harvestConnectedVein(world.bot, start, ['diamond_ore', 'deepslate_diamond_ore'], 64, {
        dig: (block) => {
            world.blocks.delete(key(block.position));
            return Promise.resolve('ok');
        },
    });

    assert.equal(mined, 1);
    assert.equal(world.blocks.size, 0);
});

test('vein follow does not retry safety or wrong-tool refusals', async () => {
    const start = new Vec3(0, 0, 0);
    const unsafe = new Vec3(-1, -1, -1);
    const safe = new Vec3(-1, -1, 0);
    const world = makeVein([
        ['diamond_ore', unsafe],
        ['diamond_ore', safe],
    ]);
    let unsafeAttempts = 0;
    const mined = await harvestConnectedVein(world.bot, start, ['diamond_ore', 'deepslate_diamond_ore'], 64, {
        dig: (block) => {
            if (block.position.equals(unsafe)) { unsafeAttempts++; return Promise.resolve('fluidguard'); }
            world.blocks.delete(key(block.position));
            return Promise.resolve('ok');
        },
    });

    assert.equal(mined, 1);
    assert.equal(unsafeAttempts, 1);
    assert.equal(world.blocks.has(key(unsafe)), true);
});
