// Simulation test for world.getNearestFreeSpace (src/agent/library/world.js).
//
// Regression guard for the 2026-07-08 "工作台放置被身体挡住 → 卡退" chain:
//   findBlocks returns the bot's OWN feet cell (distance 0) as the nearest 'air',
//   so getNearestFreeSpace handed placeBlock the bot's body position → placeBlock
//   refused ("target intersects bot body") → craftRecipe kept craftingTable=null →
//   bot.craft(recipe,n,null) threw → 15s no-stop → reconnectNow('action-refused-stop').
//
// The fix: exclude the bot's own two occupied cells (feet + head), and return null
// (not implicit undefined) when nothing qualifies so callers exit cleanly.
//
// Run:  node test/getNearestFreeSpace.sim.test.mjs
import Vec3 from 'vec3';
import { getNearestFreeSpace } from '../src/agent/library/world.js';

const key = (v) => `${Math.floor(v.x)},${Math.floor(v.y)},${Math.floor(v.z)}`;
const AIR = () => ({ name: 'air', boundingBox: 'empty', drops: [], diggable: false });
const STONE = () => ({ name: 'stone', boundingBox: 'block', drops: [1], diggable: true });

// ── Minimal voxel bot: only findBlocks + blockAt + entity.position are used ────
function makeBot({ start, cells }) {
    const world = new Map();
    for (const [k, b] of Object.entries(cells)) world.set(k, b);

    return {
        entity: { position: start.clone() },
        blockAt(v) {
            const b = world.get(key(v));
            if (b) return { ...b, position: v.floored ? v.floored() : v };
            return { ...AIR(), position: v };
        },
        // Faithful stand-in for prismarine findBlocks: match over the populated
        // region, honor maxDistance, return positions sorted nearest-first, capped.
        findBlocks({ matching, maxDistance, count }) {
            const origin = this.entity.position.floored();
            const out = [];
            for (const [k, b] of world) {
                const [x, y, z] = k.split(',').map(Number);
                const v = new Vec3(x, y, z);
                if (origin.distanceTo(v) > maxDistance) continue;
                if (matching(b)) out.push(v);
            }
            out.sort((a, b) => origin.distanceTo(a) - origin.distanceTo(b));
            return out.slice(0, count);
        },
        _world: world,
    };
}

// Build a solid box around the feet column, leaving `openSides` of the four
// horizontal neighbours as a valid free space (air over solid diggable ground).
function pocket({ openSides }) {
    const F = new Vec3(0, 64, 0);          // feet
    const cells = {};
    // Ground plane y=63 (solid, diggable, drops) across a 3x3 footprint.
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) cells[key(F.offset(dx, -1, dz))] = STONE();
    // Feet + head cells the bot occupies are air.
    cells[key(F)] = AIR();
    cells[key(F.offset(0, 1, 0))] = AIR();
    // Four horizontal neighbours at feet level: solid walls by default.
    const neigh = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let i = 0; i < neigh.length; i++) {
        const [dx, dz] = neigh[i];
        const open = i < openSides;
        cells[key(F.offset(dx, 0, dz))] = open ? AIR() : STONE();
        // wall cell above the neighbour too, so only the intended opening exists
        cells[key(F.offset(dx, 1, dz))] = open ? AIR() : STONE();
    }
    return { bot: makeBot({ start: F, cells }), feet: F };
}

let failures = 0;
const check = (name, cond, detail = '') => {
    if (cond) { console.log(`  ✅ ${name}`); }
    else { console.log(`  ❌ ${name} ${detail}`); failures++; }
};

// ── Test 1: constrained pocket with ONE open side → returns that open cell, NEVER the body ──
{
    console.log('Test 1: 1-open-side pocket (the MAROONED/constrained case)');
    const { bot, feet } = pocket({ openSides: 1 });
    const pos = getNearestFreeSpace(bot, 1, 6);
    const head = feet.offset(0, 1, 0);
    check('returns a position', !!pos, `got ${pos}`);
    check('does NOT return the bot feet cell', pos && key(pos) !== key(feet), `got ${pos && key(pos)}`);
    check('does NOT return the bot head cell', pos && key(pos) !== key(head), `got ${pos && key(pos)}`);
    // openSides:1 opens neigh[0] = [1,0] → the only valid free cell is (1,64,0).
    check('returns the open neighbour (1,64,0)', pos && key(pos) === '1,64,0', `got ${pos && key(pos)}`);
}

// ── Test 2: fully walled in (0 open sides) → returns null (clean caller exit, not undefined) ──
{
    console.log('Test 2: fully-walled pocket → null');
    const { bot } = pocket({ openSides: 0 });
    const pos = getNearestFreeSpace(bot, 1, 6);
    check('returns null (not undefined)', pos === null, `got ${JSON.stringify(pos)}`);
}

// ── Test 3: open ground → still returns a usable non-body cell ──
{
    console.log('Test 3: open ground');
    const { bot, feet } = pocket({ openSides: 4 });
    const pos = getNearestFreeSpace(bot, 1, 6);
    check('returns a position', !!pos);
    check('not the body cell', pos && key(pos) !== key(feet) && key(pos) !== key(feet.offset(0, 1, 0)));
    const below = bot.blockAt(pos.offset(0, -1, 0));
    check('chosen cell has solid diggable support below', below && below.boundingBox === 'block' && below.diggable);
}

console.log('');
if (failures) { console.log(`FAILED: ${failures} assertion(s)`); process.exit(1); }
console.log('ALL PASSED');
