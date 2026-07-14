// Simulation test for the in-place atomic pillarUp (src/agent/library/skills.js).
//
// It drives the REAL skills.pillarUp with two injected seams:
//   opts.placeUnder — a simulated one-block MLG place against a voxel world
//   opts.sleep      — instant (no real waiting) but still drives water "sink"
// so the loop logic (in-place, until-blocks-run-out, water-settle, ceiling,
// target Y, interrupt) is exercised end-to-end without a live Minecraft server.
//
// Run:  node test/pillarup.sim.test.mjs
import Vec3 from 'vec3';
import { isPlankBlock, pillarUp, placeBlockUnderFeet } from '../src/agent/library/skills.js';

const key = (v) => `${Math.floor(v.x)},${Math.floor(v.y)},${Math.floor(v.z)}`;
const SOLID = (name) => ({ name, boundingBox: 'block' });
const WATER = () => ({ name: 'water', boundingBox: 'empty' });

// ── Simulated bot + voxel world ──────────────────────────────────────────────
function makeBot({ start, floorY, blocks = { dirt: 20 }, fill = 'air', ceilingY = null }) {
    const world = new Map();          // "x,y,z" -> { name, boundingBox }
    const setBlock = (x, y, z, b) => world.set(key(new Vec3(x, y, z)), b);

    // Bedrock-ish floor directly under the start column.
    const sx = Math.floor(start.x), sz = Math.floor(start.z);
    setBlock(sx, floorY, sz, SOLID('stone'));
    // Optional water fill between floor and the bot's starting feet.
    if (fill === 'water') {
        for (let y = floorY + 1; y < Math.floor(start.y) + 8; y++) setBlock(sx, y, sz, WATER());
    }
    // Optional ceiling.
    if (ceilingY != null) setBlock(sx, ceilingY, sz, SOLID('stone'));

    const items = Object.entries(blocks).map(([name, count]) => ({ name, count }));

    const bot = {
        output: '',
        interrupt_code: false,
        entity: { position: start.clone(), height: 1.8 },
        inventory: { items: () => items.filter((i) => i.count > 0) },
        clearControlStates() {},
        setControlState() {},
        pathfinder: { setGoal() {} },
        blockAt(v) {
            const b = world.get(key(v));
            if (b) return { ...b, position: v.floored ? v.floored() : v };
            return { name: fill === 'water' ? 'air' : 'air', boundingBox: 'empty', position: v };
        },
        _world: world,
        _items: items,
        _setBlock: setBlock,
    };
    return bot;
}

// A faithful stand-in for placeBlockUnderFeet: needs a SOLID block under the feet
// cell, consumes one held block, caps the feet cell, and lifts the bot onto it.
function makeSimPlace({ trace }) {
    return async function simPlace(bot, name /*, opts */) {
        const feet = bot.entity.position.floored();
        const ref = bot.blockAt(feet.offset(0, -1, 0));
        if (!ref || ref.boundingBox !== 'block') return false; // no support → real primitive fails too
        const item = bot._items.find((i) => i.name === name && i.count > 0);
        if (!item) return false;
        item.count -= 1;
        bot._setBlock(feet.x, feet.y, feet.z, SOLID(name)); // block placed in the feet cell
        bot.entity.position = new Vec3(feet.x + 0.5, feet.y + 1, feet.z + 0.5); // stand on it
        if (trace) trace(`  placed ${name} @${feet.x},${feet.y},${feet.z} → y=${bot.entity.position.y} (left ${item.count} ${name})`);
        return true;
    };
}

// Water sink: while the bot's feet-1 cell isn't solid, each sleep drops it ~1
// block toward the floor (buoyancy releasing), mimicking settleOntoFooting's job.
function makeSimSleep(bot) {
    return async function simSleep(/* ms */) {
        const feet = bot.entity.position.floored();
        const below = bot.blockAt(feet.offset(0, -1, 0));
        if (!below || below.boundingBox !== 'block') {
            const down = new Vec3(bot.entity.position.x, Math.max(bot.entity.position.y - 1, -64), bot.entity.position.z);
            bot.entity.position = down;
        }
    };
}

// ── Assertion helpers ────────────────────────────────────────────────────────
let failures = 0;
function check(label, cond, detail = '') {
    const tag = cond ? 'PASS' : 'FAIL';
    if (!cond) failures++;
    console.log(`  [${tag}] ${label}${detail ? ' — ' + detail : ''}`);
}
const dirtLeft = (bot) => (bot._items.find((i) => i.name === 'dirt')?.count ?? 0);
const y = (bot) => Math.floor(bot.entity.position.y);

// ── Scenario A: dry pit, no target → pillar IN PLACE until dirt runs out ──────
async function scenarioA() {
    console.log('\n=== Scenario A: dry pit, 20 dirt, no target → pillar until dirt gone ===');
    const bot = makeBot({ start: new Vec3(10.5, 64, 10.5), floorY: 63, blocks: { dirt: 20 } });
    const trace = (s) => console.log(s);
    const startX = bot.entity.position.x, startZ = bot.entity.position.z;
    const ret = await pillarUp(bot, null, { placeUnder: makeSimPlace({ trace }), sleep: makeSimSleep(bot) });
    console.log(bot.output.trimEnd());
    check('returned true (job done)', ret === true, `ret=${ret}`);
    check('climbed exactly 20 blocks (64→84)', y(bot) === 84, `finalY=${y(bot)}`);
    check('dirt fully exhausted', dirtLeft(bot) === 0, `dirt=${dirtLeft(bot)}`);
    check('stayed IN PLACE (x,z unchanged)', bot.entity.position.x === startX && bot.entity.position.z === startZ,
        `x=${bot.entity.position.x} z=${bot.entity.position.z}`);
}

// ── Scenario B: flooded water column → settle then pillar until dirt gone ─────
async function scenarioB() {
    console.log('\n=== Scenario B: water column, floating, 12 dirt → settle + pillar until dirt gone ===');
    // Floor at y=50, water y=51..(58+), bot floating at y=56 (feet-1 is water, not solid).
    const bot = makeBot({ start: new Vec3(-3.5, 56, 7.5), floorY: 50, blocks: { dirt: 12 }, fill: 'water' });
    const trace = (s) => console.log(s);
    const ret = await pillarUp(bot, null, { placeUnder: makeSimPlace({ trace }), sleep: makeSimSleep(bot) });
    console.log(bot.output.trimEnd());
    check('returned true (job done)', ret === true, `ret=${ret}`);
    check('dirt fully exhausted', dirtLeft(bot) === 0, `dirt=${dirtLeft(bot)}`);
    check('ended above the water floor', y(bot) > 50, `finalY=${y(bot)}`);
    check('climbed 12 blocks from the footing it settled onto', y(bot) === 51 + 12,
        `finalY=${y(bot)} (settled to y=51, +12)`);
}

// ── Scenario C: explicit target Y → stop exactly at target, keep leftover dirt ─
async function scenarioC() {
    console.log('\n=== Scenario C: target y=69 from y=64 with 30 dirt → stop at target ===');
    const bot = makeBot({ start: new Vec3(0.5, 64, 0.5), floorY: 63, blocks: { dirt: 30 } });
    const ret = await pillarUp(bot, 69, { placeUnder: makeSimPlace({}), sleep: makeSimSleep(bot) });
    console.log(bot.output.trimEnd());
    check('returned true (reached target)', ret === true, `ret=${ret}`);
    check('stopped exactly at y=69', y(bot) === 69, `finalY=${y(bot)}`);
    check('consumed exactly 5 dirt (25 left)', dirtLeft(bot) === 25, `dirt=${dirtLeft(bot)}`);
}

// ── Scenario D: ceiling right overhead → can't pillar, stops immediately ──────
async function scenarioD() {
    console.log('\n=== Scenario D: solid ceiling at feet+1 → cannot pillar higher ===');
    // Bot at y=64, ceiling block at y=65 (the head cell) → headOpen() false.
    const bot = makeBot({ start: new Vec3(5.5, 64, 5.5), floorY: 63, blocks: { dirt: 10 }, ceilingY: 65 });
    const ret = await pillarUp(bot, null, { placeUnder: makeSimPlace({}), sleep: makeSimSleep(bot) });
    console.log(bot.output.trimEnd());
    check('did not rise (blocked by ceiling)', y(bot) === 64, `finalY=${y(bot)}`);
    check('did not waste blocks', dirtLeft(bot) === 10, `dirt=${dirtLeft(bot)}`);
    check('reported failure (placed 0, target given=none → placed>0 false)', ret === false, `ret=${ret}`);
}

// ── Scenario E: fresh admin interrupt preempts mid-pillar ─────────────────────
async function scenarioE() {
    console.log('\n=== Scenario E: bot.interrupt_code flips true after 5 blocks → stops ===');
    const bot = makeBot({ start: new Vec3(2.5, 64, 2.5), floorY: 63, blocks: { dirt: 40 } });
    let placedCount = 0;
    const simPlace = makeSimPlace({});
    const wrapped = async (b, n, o) => {
        const r = await simPlace(b, n, o);
        if (r && ++placedCount >= 5) b.interrupt_code = true; // new admin command arrives
        return r;
    };
    const ret = await pillarUp(bot, null, { placeUnder: wrapped, sleep: makeSimSleep(bot) });
    console.log(bot.output.trimEnd());
    check('stopped promptly on interrupt (~5 blocks up)', y(bot) === 69, `finalY=${y(bot)}`);
    check('did NOT drain the whole stack', dirtLeft(bot) === 35, `dirt=${dirtLeft(bot)}`);
    check('still reports true (it climbed)', ret === true, `ret=${ret}`);
}

// ── Scenario F: planks-only inventory → pillar refuses without consuming ──────
async function scenarioF() {
    console.log('\n=== Scenario F: planks only → refuse under-foot filler ===');
    const bot = makeBot({ start: new Vec3(0.5, 64, 0.5), floorY: 63, blocks: { oak_planks: 12 } });
    let placeCalls = 0;
    const ret = await pillarUp(bot, 66, {
        placeUnder: async () => { placeCalls++; return true; },
        sleep: makeSimSleep(bot),
    });
    check('returned false (no permitted scaffold)', ret === false, `ret=${ret}`);
    check('never called the placement primitive', placeCalls === 0, `calls=${placeCalls}`);
    check('kept all oak planks', bot._items[0].count === 12, `oak_planks=${bot._items[0].count}`);
    check('recognized bamboo planks too', isPlankBlock('bamboo_planks') === true);
}

// ── Scenario G: direct primitive call cannot bypass the policy ────────────────
async function scenarioG() {
    console.log('\n=== Scenario G: direct under-foot oak_planks call → hard reject ===');
    const bot = makeBot({ start: new Vec3(0.5, 64, 0.5), floorY: 63, blocks: { oak_planks: 1 } });
    const ret = await placeBlockUnderFeet(bot, 'oak_planks');
    check('direct under-foot placement returned false', ret === false, `ret=${ret}`);
    check('direct call kept the plank', bot._items[0].count === 1, `oak_planks=${bot._items[0].count}`);
}

(async () => {
    await scenarioA();
    await scenarioB();
    await scenarioC();
    await scenarioD();
    await scenarioE();
    await scenarioF();
    await scenarioG();
    console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
})();
