import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import Vec3 from 'vec3';
import { findBlocksOffThread } from '../src/utils/block_scan.js';

const require = createRequire(import.meta.url);
const version = '1.20.4';
const data = require('minecraft-data')(version);
const Chunk = require('prismarine-chunk')(version);

function fakeBotWith (placements) {
  const air = data.blocksByName.air.defaultState;
  const section = new Chunk.section({ singleValue: air });
  for (const { x, y, z, state } of placements) section.set({ x, y, z }, state);
  const bot = {
    version,
    registry: data,
    entity: { position: new Vec3(0, 0, 0) },
    world: { getColumns: () => [{ chunkX: '0', chunkZ: '0', column: { minY: 0, sections: [section] } }] }
  };
  bot.blockAt = (position) => {
    const state = section.get({ x: position.x & 15, y: position.y & 15, z: position.z & 15 });
    const definition = data.blocksByStateId[state];
    let stateData = state - definition.minStateId;
    const properties = {};
    for (let index = (definition.states || []).length - 1; index >= 0; index--) {
      const property = definition.states[index];
      const raw = stateData % property.num_values;
      properties[property.name] = property.type === 'bool' ? !raw : (property.values ? property.values[raw] : raw);
      stateData = Math.floor(stateData / property.num_values);
    }
    return {
      ...definition,
      type: definition.id,
      metadata: state - definition.minStateId,
      position: new Vec3(position.x, position.y, position.z),
      getProperties: () => properties
    };
  };
  return bot;
}

test('block scan worker returns nearest matching blocks', async () => {
  const stone = data.blocksByName.stone.defaultState;
  const bot = fakeBotWith([
    { x: 7, y: 2, z: 0, state: stone },
    { x: 2, y: 1, z: 0, state: stone }
  ]);
  const blocks = await findBlocksOffThread(bot, {
    matching: data.blocksByName.stone.id,
    maxDistance: 16,
    count: 2
  });
  assert.deepEqual(blocks.map((block) => block.position.toString()), ['(2, 1, 0)', '(7, 2, 0)']);
});

test('metadata predicates are resolved in the worker before applying count', async () => {
  const lava = data.blocksByName.lava;
  const bot = fakeBotWith([
    { x: 1, y: 0, z: 0, state: lava.minStateId + 1 },
    { x: 4, y: 0, z: 0, state: lava.minStateId }
  ]);
  const blocks = await findBlocksOffThread(bot, {
    matching: (block) => block.name === 'lava' && block.metadata === 0,
    maxDistance: 16,
    count: 1
  });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].position.x, 4);
});

test('block-state property predicates select the correct worker-side state', async () => {
  const wheat = data.blocksByName.wheat;
  const bot = fakeBotWith([
    { x: 1, y: 0, z: 0, state: wheat.minStateId + 2 },
    { x: 5, y: 0, z: 0, state: wheat.minStateId + 7 }
  ]);
  const blocks = await findBlocksOffThread(bot, {
    matching: (block) => block.name === 'wheat' && Number(block.getProperties().age) >= 7,
    maxDistance: 16,
    count: 1
  });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].position.x, 5);
});

test('source contains no literal high-radius synchronous findBlocks calls', () => {
  const roots = ['src', path.join('bots', '_supervisor', 'skills')];
  const offenders = [];
  const visit = (entry) => {
    for (const dirent of fs.readdirSync(entry, { withFileTypes: true })) {
      const file = path.join(entry, dirent.name);
      if (dirent.isDirectory()) visit(file);
      else if (dirent.name.endsWith('.js')) {
        const source = fs.readFileSync(file, 'utf8');
        const re = /bot\.findBlocks\s*\(\s*\{[\s\S]{0,300}?maxDistance\s*:\s*(\d+)/g;
        for (const match of source.matchAll(re)) {
          if (Number(match[1]) >= 64) offenders.push(`${file}:${match[1]}`);
        }
      }
    }
  };
  for (const root of roots) visit(root);
  assert.deepEqual(offenders, []);
});
