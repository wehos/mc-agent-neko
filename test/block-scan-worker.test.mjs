import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import Vec3 from 'vec3';
import { findBlocksOffThread } from '../src/utils/block_scan.js';

const require = createRequire(import.meta.url);
const version = '1.20.4';
const data = require('minecraft-data')(version);
const Chunk = require('prismarine-chunk')(version);

function fakeBotWith (placements, botVersion = version) {
  const botData = require('minecraft-data')(botVersion);
  const BotChunk = require('prismarine-chunk')(botVersion);
  const air = botData.blocksByName.air.defaultState;
  const section = new BotChunk.section({ singleValue: air });
  const setState = section.set?.bind(section) || section.setBlock.bind(section);
  const getState = section.get?.bind(section) || section.getBlock.bind(section);
  for (const { x, y, z, state } of placements) setState({ x, y, z }, state);
  const bot = {
    version: botVersion,
    registry: botData,
    entity: { position: new Vec3(0, 0, 0) },
    world: { getColumns: () => [{ chunkX: '0', chunkZ: '0', column: { minY: 0, sections: [section] } }] }
  };
  bot.blockAt = (position) => {
    const state = getState({ x: position.x & 15, y: position.y & 15, z: position.z & 15 });
    const definition = botData.blocksByStateId[state];
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

async function postAndWait (worker, message) {
  const replyPromise = once(worker, 'message');
  worker.postMessage(message);
  const [reply] = await replyPromise;
  if (reply.type === 'error') throw new Error(reply.error);
  return reply;
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

test('live-only predicates can reject a nearer candidate without hiding a farther match', async () => {
  const stone = data.blocksByName.stone.defaultState;
  const bot = fakeBotWith([
    { x: 1, y: 0, z: 0, state: stone },
    { x: 6, y: 4, z: 0, state: stone }
  ]);
  const blocks = await findBlocksOffThread(bot, {
    matching: (block) => block.name === 'stone' && block.position?.y >= 4,
    maxDistance: 16,
    count: 1
  });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].position.toString(), '(6, 4, 0)');
  const directBlocks = await findBlocksOffThread(bot, {
    matching: (block) => block.name === 'stone' && block.position.y >= 4,
    maxDistance: 16,
    count: 1
  });
  assert.equal(directBlocks[0].position.toString(), '(6, 4, 0)');
});

test('worker bounds retained matches to the requested count', async (t) => {
  const worker = new Worker(new URL('../src/utils/block_scan_worker.cjs', import.meta.url));
  t.after(() => worker.terminate());
  const stone = data.blocksByName.stone.defaultState;
  const section = new Chunk.section({ singleValue: stone });
  const jobId = 991;
  await postAndWait(worker, {
    type: 'start', jobId, batchId: 1, version,
    center: { x: 8, y: 8, z: 8 }, radius: 32, count: 3,
    stateIds: [stone]
  });
  await postAndWait(worker, {
    type: 'batch', jobId, batchId: 2,
    sections: [{ x: 0, y: 0, z: 0, json: section.toJson() }]
  });
  const result = await postAndWait(worker, { type: 'finish', jobId });
  assert.equal(result.positions.length, 3);
  assert.equal(result.peakRetained, 3);
});

test('worker supports pre-1.18 getBlock section accessors', async () => {
  for (const oldVersion of ['1.12.2', '1.16.5', '1.17.1']) {
    const oldData = require('minecraft-data')(oldVersion);
    const stone = oldData.blocksByName.stone.defaultState;
    const bot = fakeBotWith([{ x: 3, y: 2, z: 1, state: stone }], oldVersion);
    const blocks = await findBlocksOffThread(bot, {
      matching: oldData.blocksByName.stone.id,
      maxDistance: 16,
      count: 1
    });
    assert.equal(blocks.length, 1, oldVersion);
    assert.equal(blocks[0].position.toString(), '(3, 2, 1)', oldVersion);
  }
});

test('superseded bot releases the shared scan queue', async () => {
  const stone = data.blocksByName.stone.defaultState;
  const staleBot = fakeBotWith([{ x: 2, y: 1, z: 0, state: stone }]);
  const sourceSection = staleBot.world.getColumns()[0].column.sections[0];
  const json = sourceSection.toJson();
  let snapshots = 0;
  staleBot.world.getColumns = () => [{
    chunkX: '0', chunkZ: '0',
    column: {
      minY: 0,
      sections: Array.from({ length: 16 }, () => ({
        toJson: () => {
          snapshots++;
          staleBot._disposed = true;
          return json;
        }
      }))
    }
  }];
  const activeBot = fakeBotWith([{ x: 4, y: 1, z: 0, state: stone }]);

  const staleScan = findBlocksOffThread(staleBot, { matching: data.blocksByName.stone.id, maxDistance: 256, count: 1 });
  const activeScan = findBlocksOffThread(activeBot, { matching: data.blocksByName.stone.id, maxDistance: 16, count: 1 });
  const [staleBlocks, activeBlocks] = await Promise.all([staleScan, activeScan]);

  assert.deepEqual(staleBlocks, []);
  assert.equal(snapshots, 1);
  assert.equal(activeBlocks[0].position.x, 4);
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
