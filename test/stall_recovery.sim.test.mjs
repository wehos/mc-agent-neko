import assert from 'node:assert/strict';
import test from 'node:test';
import Vec3 from 'vec3';
import {
    STALL_INTENT,
    beginStallIntent,
    classifyStallSnapshot,
    endStallIntent,
    observeStallContext,
    recoveryMovedEnough,
} from '../src/agent/stall_recovery.js';
import { createSafeShaftDetour, digDown, planShaftDetours } from '../src/agent/library/skills.js';

function idleAgent(mobility = 'FREE') {
    const bot = {
        _mobility: { state: mobility },
        entity: { position: new Vec3(0.5, 10, 0.5) },
        pathfinder: { isMoving: () => false },
        getControlState: () => false,
    };
    return { bot, actions: { executing: false, currentActionLabel: '' } };
}

test('an idle stopped bot is a HOLD even when mobility still says ENTOMBED', () => {
    const context = observeStallContext(idleAgent('ENTOMBED'), 1000);
    assert.equal(context.intent, STALL_INTENT.HOLD);
    assert.equal(context.watchMovement, false);
});

test('digging wins over pathing and is left to the dig watchdog', () => {
    const classified = classifyStallSnapshot({
        digging: true,
        pathing: true,
        actionExecuting: true,
        actionLabel: 'mineOres',
    }, 1000);
    assert.equal(classified.intent, STALL_INTENT.DIG);
});

test('only real movement demand is watched by the generic stall detector', () => {
    const agent = idleAgent('FREE');
    agent.actions.executing = true;
    agent.actions.currentActionLabel = 'collectBlocks';
    agent.bot.pathfinder.isMoving = () => true;
    agent.bot._lastPathGoalAt = 123;
    const context = observeStallContext(agent, 1000);
    assert.equal(context.intent, STALL_INTENT.MOVE);
    assert.equal(context.watchMovement, true);
    assert.equal(context.recovery, 'cancel-and-replan');
});

test('stationary skill work and open-window interactions do not become movement stalls', () => {
    const agent = idleAgent('FREE');
    agent.actions.executing = true;
    agent.actions.currentActionLabel = 'collectBlocks';
    let context = observeStallContext(agent, 1000);
    assert.equal(context.intent, STALL_INTENT.WORK);
    assert.equal(context.watchMovement, false);

    agent.bot.currentWindow = { type: 'furnace' };
    context = observeStallContext(agent, 1001);
    assert.equal(context.intent, STALL_INTENT.INTERACT);
    assert.equal(context.watchMovement, false);
});

test('intent leases nest and restore the parent operation', () => {
    const bot = {};
    const dig = beginStallIntent(bot, STALL_INTENT.DIG, 'digDown', { now: 1000 });
    const move = beginStallIntent(bot, STALL_INTENT.MOVE, 'shaft-detour', { now: 1001 });
    assert.equal(bot._stallIntent.owner, 'shaft-detour');
    assert.equal(endStallIntent(bot, move), true);
    assert.equal(bot._stallIntent.owner, 'digDown');
    assert.equal(endStallIntent(bot, dig), true);
    assert.equal(bot._stallIntent, null);
});

test('recovery success requires real displacement', () => {
    const start = new Vec3(0, 0, 0);
    assert.equal(recoveryMovedEnough(start, new Vec3(0.2, 0, 0.2)), false);
    assert.equal(recoveryMovedEnough(start, new Vec3(1.6, 0, 0)), true);
});

function shaftWorld({ hostileEast = false, waterWest = false } = {}) {
    const overrides = new Map();
    const key = position => `${position.x},${position.y},${position.z}`;
    const blockAt = position => {
        const stored = overrides.get(key(position));
        if (stored) return stored;
        const name = waterWest && position.x === -1 && position.y === 10 && position.z === 1 ? 'water' : 'stone';
        return { name, position: position.clone(), boundingBox: name === 'water' ? 'empty' : 'block' };
    };
    const bot = {
        interrupt_code: false,
        entity: { position: new Vec3(0.5, 10, 0.5) },
        entities: hostileEast ? { 2: { name: 'zombie', type: 'mob', position: new Vec3(4, 10, 0.5) } } : {},
        blockAt,
        lookAt: async () => {},
        setControlState: () => {},
    };
    return { bot, overrides, key };
}

test('shaft detour planning prefers tunnelling away from a visible hostile', () => {
    const { bot } = shaftWorld({ hostileEast: true });
    const plans = planShaftDetours(bot);
    assert.ok(plans.length > 0);
    assert.deepEqual([plans[0].dx, plans[0].dz], [-1, 0]);
});

test('shaft detour keeps the dangerous floor sealed and moves laterally', async () => {
    const { bot, overrides, key } = shaftWorld();
    const startFloor = new Vec3(0, 9, 0);
    const result = await createSafeShaftDetour(bot, {
        dig: block => {
            overrides.set(key(block.position), { name: 'air', position: block.position.clone(), boundingBox: 'empty' });
            return true;
        },
        step: candidate => {
            bot.entity.position = new Vec3(0.5 + candidate.dx, 10, 0.5 + candidate.dz);
        },
    });
    assert.equal(result.moved, true);
    assert.equal(bot.blockAt(startFloor).name, 'stone');
    assert.equal(bot._stallIntent, null);
});

test('digDown reports a dangerous drop and delegates before breaking the shaft floor', async () => {
    const start = new Vec3(0.5, 10, 0.5);
    let detours = 0;
    const bot = {
        output: '',
        interrupt_code: false,
        entity: { position: start.clone() },
        blockAt(position) {
            const p = position.floored();
            if (p.x === 0 && p.z === 0 && p.y === 9) return { name: 'stone', position: p, boundingBox: 'block' };
            return { name: 'air', position: p, boundingBox: 'empty' };
        },
    };
    const ok = await digDown(bot, 1, {
        detour: () => {
            detours++;
            bot.entity.position = start.offset(1, 0, 0);
            return { moved: true, distance: 1, dx: 1, dz: 0 };
        },
    });
    assert.equal(ok, false);
    assert.equal(detours, 1);
    assert.equal(bot._lastDigDownOutcome.reason, 'dangerous-drop');
    assert.equal(bot._lastDigDownOutcome.dug, 0);
    assert.equal(bot._lastDigDownOutcome.detour.moved, true);
    assert.equal(bot._stallIntent, null);
});
