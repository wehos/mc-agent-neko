// Regression coverage for workstation placement failures observed on 2026-07-14.
// Run: node test/placement_recovery.sim.test.mjs
import assert from 'node:assert/strict';
import { placeBlockNearby } from '../src/agent/library/skills.js';
import smeltSafe from '../bots/_supervisor/skills/smeltSafe.js';
import makePlatform from '../bots/_supervisor/skills/makePlatform.js';
import { addsExecutionConstraint } from '../src/agent/admin_mission.js';

async function testMissingItemDoesNotPrepareTerrain() {
    let touchedWorld = false;
    const bot = {
        output: '',
        inventory: { findInventoryItem: () => null },
        game: { gameMode: 'survival' },
        restrict_to_inventory: true,
        blockAt() { touchedWorld = true; throw new Error('terrain must not be inspected'); },
    };
    const ok = await placeBlockNearby(bot, 'furnace');
    assert.equal(ok, false);
    assert.equal(touchedWorld, false);
    assert.match(bot.output, /no blocks were cleared/);
}

async function testSmeltCraftFailureStopsBeforePlacement() {
    let placementCalls = 0;
    let smeltCalls = 0;
    const logs = [];
    const ctx = {
        world: {
            getNearestBlock: () => null,
            getInventoryCounts: () => ({ raw_iron: 19 }),
        },
        skills: {
            craftRecipeLocal: async () => false,
            placeBlockNearby: async () => { placementCalls++; return true; },
            smeltItem: async () => { smeltCalls++; return true; },
        },
        log: (_bot, message) => logs.push(message),
    };
    const ok = await smeltSafe({ interrupt_code: false }, ctx, 'raw_iron', 19);
    assert.equal(ok, false);
    assert.equal(placementCalls, 0);
    assert.equal(smeltCalls, 0);
    assert.match(logs.join('\n'), /placement skipped/);
}

async function testSmeltPlacementIsBoundedAndStationary() {
    let receivedOpts = null;
    let smeltCalls = 0;
    const ctx = {
        world: {
            getNearestBlock: () => null,
            getInventoryCounts: () => ({ furnace: 1, raw_iron: 3 }),
        },
        skills: {
            craftRecipeLocal: async () => { throw new Error('already has furnace'); },
            placeBlockNearby: async (_bot, _name, opts) => { receivedOpts = opts; return false; },
            smeltItem: async () => { smeltCalls++; return true; },
        },
        log: () => {},
    };
    const ok = await smeltSafe({ interrupt_code: false }, ctx, 'raw_iron', 3);
    assert.equal(ok, false);
    assert.deepEqual(receivedOpts, { maxTries: 1, relocate: false, pillar: false, positioning: false, maxDigBlocks: 2 });
    assert.equal(smeltCalls, 0);
}

async function testObservedFurnaceWinsOverPlacementTimeout() {
    let furnaceLookups = 0;
    let smeltCalls = 0;
    const furnace = { position: { x: 1, y: 2, z: 3 } };
    const ctx = {
        world: {
            getNearestBlock: () => (++furnaceLookups === 1 ? null : furnace),
            getInventoryCounts: () => ({ furnace: 1, raw_iron: 3 }),
        },
        skills: {
            craftRecipeLocal: async () => { throw new Error('already has furnace'); },
            placeBlockNearby: async () => false,
            smeltItem: async () => { smeltCalls++; return true; },
        },
        log: () => {},
    };
    const ok = await smeltSafe({ interrupt_code: false }, ctx, 'raw_iron', 3);
    assert.equal(ok, true);
    assert.equal(smeltCalls, 1);
}

async function testMakePlatformRequiresExplicitAdminApproval() {
    const chats = [];
    const logs = [];
    const bot = { _adminMission: { active: true }, chat: message => chats.push(message) };
    const ctx = { skills: { wait: async () => true }, log: (_bot, message) => logs.push(message) };
    assert.equal(await makePlatform(bot, ctx, 'dirt'), false);
    assert.deepEqual(chats, []);
    assert.match(logs.join('\n'), /refused during an admin mission/);

    assert.equal(await makePlatform(bot, ctx, 'dirt', { allowDestructive: true }), true);
    assert.equal(chats.length, 2);
    assert.match(chats[0], /^\/fill /);
}

function testConstraintRefinementsBypassDuplicateThrottle() {
    const current = 'Place a furnace and smelt the raw iron';
    assert.equal(addsExecutionConstraint(current, '原地放熔炉，不要乱跑'), true);
    assert.equal(addsExecutionConstraint(current, 'Place it without digging or clearing'), true);
    assert.equal(addsExecutionConstraint(current, 'Place it at coordinates -7 45 11'), true);
    assert.equal(addsExecutionConstraint(current, 'Please place the furnace and smelt the iron'), false);
}

await testMissingItemDoesNotPrepareTerrain();
await testSmeltCraftFailureStopsBeforePlacement();
await testSmeltPlacementIsBoundedAndStationary();
await testObservedFurnaceWinsOverPlacementTimeout();
await testMakePlatformRequiresExplicitAdminApproval();
testConstraintRefinementsBypassDuplicateThrottle();
console.log('placement_recovery.sim: all checks passed');
process.exit(0);
