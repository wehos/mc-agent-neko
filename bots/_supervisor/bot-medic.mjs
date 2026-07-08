// bot-medic.mjs — DETACHED survival medic (runs independent of any Claude session / scheduled-tasks MCP).
// Every CHECK_MS reads vitals.json + progress.txt and, when the bot is DEGRADED in a way it cannot
// self-recover from, writes survival commands to cheat.txt (the bot's DEV CHEAT CHANNEL, modes.js:2564,
// executes each line via bot.chat within ~1s, no side effects). Crutches (low-risk, T-0069 cheat-supply
// reality), NOT real fixes — the proper fixes (no-op spins / isBootstrapDone / night-survival / resource
// -floor石棺) are tracked as tickets for verified-window work. Survives session recycle.
//
// Triggers (throttled to one apply / THROTTLE_MS):
//   ENTOMBED-pickless石棺  (mob ENTOMBED/POCKET + progress 'emergency pick blocked'/'needs reachable
//                           crafting_table') → /give iron_pickaxe + crafting_table  (so dig-out fires)
//   unarmored             (vitals.armor < 4 pieces, bot has been dying)            → /item replace armor
//   famine                (hp<10 + food<14 + no edible in inv)                     → instant_health + beef
//   keepInventory always re-asserted.
//
// Launch detached (survives logout/session-end), mirroring watchdog.ps1:
//   Start-Process node -ArgumentList 'bots/_supervisor/bot-medic.mjs' -WorkingDirectory <proj> -WindowStyle Hidden
import fs from 'fs';
import path from 'path';

const PROJ = 'C:/Users/wehos/Project/mc-agent-upstream-sync';
const SUP = path.join(PROJ, 'bots', '_supervisor');
const CHEAT = path.join(SUP, 'cheat.txt');
const VITALS = path.join(SUP, 'vitals.json');
const PROGRESS = path.join(SUP, 'progress.txt');
const LOG = path.join(SUP, 'medic.log');
const CHECK_MS = 120000;     // check every 2 min
const THROTTLE_MS = 90000;   // at most one cheat-apply per 90s

const ARMOR = [
  '/item replace entity @s armor.head with iron_helmet',
  '/item replace entity @s armor.chest with iron_chestplate',
  '/item replace entity @s armor.legs with iron_leggings',
  '/item replace entity @s armor.feet with iron_boots',
];
// ★FIX3 (worker-sync 0701): a pickless-stuck bot with a FULL inventory silently eats the /give
// (full-inv trap, see memory full-inv-silent-give-trap) — the pick crutch lands nowhere and the bot
// stays stuck (live: picklessNoRecover fired but picks stayed NONE, inv=38 types full). Clear pure
// junk (flowers/saplings/seeds/dye — NOT food/armor/ore/tools) BEFORE the pick+table give so it fits.
const JUNK = ['oak_sapling', 'peony', 'lilac', 'white_tulip', 'dandelion', 'pink_tulip', 'oxeye_daisy',
  'orange_tulip', 'azure_bluet', 'wheat_seeds', 'lily_of_the_valley', 'red_tulip', 'sunflower', 'allium',
  'bone_meal', 'poppy', 'cornflower', 'blue_orchid', 'spider_eye', 'kelp'].map(j => `/clear @s minecraft:${j}`);
// ★FIX7 (worker-frozen 0701): MINING JUNK declutter — THE net-stall root. A full inventory (36 slots)
// silently drops every NEW pickup on the ground, incl. raw_iron from mined iron_ore → the bot mines at
// the iron-dense depth (y17) yet raw_iron stays STUCK (live: cobble 109 / dirt 118 / diorite 49 / granite
// 43 / gravel / rotten_flesh filled all 36 slots, raw_iron frozen at 2 for >1h, tier never advanced).
// The declutterInv skill isn't keeping up. Clear the worthless mining spoil (dirt / stone-variants /
// gravel / rotten_flesh + the flower JUNK) when the pack is near-full, so ore drops can be picked up.
// Keep: cobblestone/deepslate (tools), coal (fuel), ores, iron, tools, food, wood, redstone, torch.
const MINING_JUNK = ['dirt', 'diorite', 'granite', 'andesite', 'gravel', 'rotten_flesh', 'tuff',
  'oak_sapling', 'dead_bush', 'egg', 'flint', 'string', 'oak_button', 'seagrass', 'sand']
  .map(j => `/clear @s minecraft:${j}`).concat(JUNK);

const log = (s) => { try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${s}\n`); } catch (e) {} };
const readJSON = (p) => { try { let s = fs.readFileSync(p, 'utf8'); if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1); return JSON.parse(s); } catch (e) { return null; } };
const progTail = (n) => { try { return fs.readFileSync(PROGRESS, 'utf8').trim().split('\n').slice(-n).join('\n'); } catch (e) { return ''; } };
// ★FIX5 (worker-sync 0701): rapid DROWNING loop — bot wanders into a big water body, the SWIM reflex
// fails to exit, drowns, respawns on land, wanders back in → 3+ drownings in 5min (live 11:00). Count
// recent drownings from death_log; >=2 in 5min = loop → water_breathing crutch (stops the drowning,
// gives time to swim out; mirrors the famine instant_health crutch). Real fix = SWIM-exit reflex (T-0091/49).
const recentDrownings = () => { try { return fs.readFileSync(path.join(SUP, 'death_log.jsonl'), 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(o => o && (Date.now() - new Date(o.t || o.ts).getTime() < 300000) && /drown/i.test(o.cause || o.reason || '')).length; } catch (e) { return 0; } };
const cheatEmpty = () => { try { return fs.readFileSync(CHEAT, 'utf8').trim().length === 0; } catch (e) { return true; } };
const writeCheat = (lines) => { try { fs.writeFileSync(CHEAT, lines.join('\n') + '\n'); log('APPLIED: ' + lines.filter(c => c !== '/gamerule keepInventory true').join(' | ')); } catch (e) { log('cheat write err ' + e.message); } };

// ★2026-07-09 用户令 HP/食物本能熔断: 两个熔断器默认 OFF (值≠'1' 即 inert); 置 '1' 恢复原行为。
const _foodOn = () => process.env.MC_FOOD_INSTINCTS === '1';
const _hpOn   = () => process.env.MC_HP_INSTINCTS   === '1';

let lastApply = 0;
let lastSpawnSet = 0;

function tick() {
  const v = readJSON(VITALS);
  if (!v || typeof v.ts !== 'number') { log('no/invalid vitals'); return; }
  const age = Date.now() - v.ts;
  if (age > 120000) { log(`vitals stale ${Math.round(age / 1000)}s — bot down/crashed (watchdog handles restart), skip crutch`); return; }
  const inv = v.inv || {};
  const prog = progTail(8);
  const hp = v.hp, food = v.food;
  const armorN = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'].filter(a => ('' + v.armor).includes(a)).length;
  const hasPick = ((inv.iron_pickaxe || 0) + (inv.diamond_pickaxe || 0) + (inv.netherite_pickaxe || 0) + (inv.stone_pickaxe || 0)) > 0;
  const edible = Object.keys(inv).some(k => /cooked_|_bread|^bread$|^apple$|carrot|potato|^beef$|porkchop|^chicken$|^mutton$|^cod$|^salmon$|melon_slice|sweet_berries|_stew|^rabbit$|baked_/.test(k) && k !== 'rotten_flesh');
  const entombed = /ENTOMBED|POCKET|SEALED/.test('' + v.mob);
  const pickBlocked = /emergency pick blocked|needs reachable crafting_table|石棺/.test(prog);
  // ★FIX (worker-sync 0701): the regex above MISSED a real pickless石棺 — bot stuck in a vertical
  // stone pocket @y61, pickless, progress spamming 'surfaceUp gained 0.0y' (trying to dig up to reach
  // wood but ZERO vertical progress = no pick to break stone) for ~40min, medic never fired (the
  // progress wording 'no local wood/table/logs' didn't match). 'surfaceUp gained 0.0' + pickless is
  // DEFINITIVELY a石棺 regardless of the momentary mob field (it cycles POCKET/SEALED/?/FREE), so
  // trigger the pick crutch on it directly.
  const vertStuck = /surfaceUp gained 0\.0|gained 0\.0y/.test(prog);
  const entombedPickless = ((entombed && pickBlocked) || vertStuck) && !hasPick;
  // ★FIX2 (worker-sync 0701): a SECOND pickless-stuck the vertStuck/entombed triggers missed — bot
  // pickless with cobble+sticks but NO crafting_table AND no wood to make one (planks<4, no logs) →
  // can't craft ANY pick; mob=FREE (not entombed), no 'surfaceUp 0.0' spam. Live: stuck ~10min @-55,68
  // wood-tier, cobble=140/sticks=5/table=0/planks=0, stuckTerrain migrate didn't relocate it, medic
  // never fired. Trigger the pick+table crutch directly, gated to a MID-GAME bot (has armor OR cobble)
  // so a fresh-spawn bootstrap (which should chop its own wood) is left untouched.
  const woodPlanksN = Object.entries(inv).filter(([k]) => /_planks$/.test(k)).reduce((s, [, n]) => s + n, 0);
  const woodLogsN = Object.entries(inv).filter(([k]) => /_log$/.test(k)).reduce((s, [, n]) => s + n, 0);
  const cobbleN = (inv.cobblestone || 0) + (inv.cobbled_deepslate || 0);
  const canMakeTable = (inv.crafting_table || 0) > 0 || woodPlanksN >= 4 || woodLogsN >= 1;
  const picklessNoRecover = !hasPick && !canMakeTable && (armorN >= 1 || cobbleN >= 3);
  // ★FIX4 (worker-sync 0701): FREE-wedge — bot physically wedged at an edge/ledge, mob=FREE, progress
  // spamming 'edge_unstick ... jump-fail' (jump-to-escape fails). The MARCH WEDGE BREAKER (modes.js
  // reflex_watchdog) only fires for CONTAINED states (ENTOMBED/SEALED), so a FREE physical wedge
  // persists (live: ~2h @36.3,60 edge_unstick jump-fail loop, even watchdog restarts returned it).
  // Detect the persistent jump-fail loop + surface (y>=40, avoid a deep tp into lava) → tp-nudge to
  // break the wedge. progTail(8) with >=2 jump-fails = persistent (a normal edge-jump is one-off).
  const jumpFails = (prog.match(/jump-fail/g) || []).length;
  const freeWedge = jumpFails >= 2 && (v.y || 0) >= 40;
  // ★FIX6 (worker-frozen 0701): SWIM water-edge wedge — bot in water (mob SWIM) jump-failing to climb
  // onto land (edge_unstick jump-fail loop). migrate reflex-INTERRUPTS at leg 2 in water (can't escape),
  // edge_unstick can't step up, and the frozen-pin fix's escape can't extract it either → it DROWNS →
  // respawns at spawn (no bed, GET_BED@44 deferred) → walks back → drowns = a slow death-reset loop that
  // caps tier progress (live: deaths 47→50 in 40min, raw_iron kept resetting). Crutch: water_breathing
  // (don't drown while extracting) + a surface tp-nudge to clear the edge. Real fix = SWIM-exit reflex (T-0091/49).
  const inSwim = /SWIM/.test('' + v.mob);
  const swimWedge = inSwim && jumpFails >= 1;

  if (Date.now() - lastApply < THROTTLE_MS) return;

  const cmds = ['/gamerule keepInventory true'];
  let act = false;
  if (entombedPickless || picklessNoRecover) { cmds.push(...JUNK, '/give @s iron_pickaxe 1', '/give @s crafting_table 2'); act = true; log(`TRIGGER pickless-stuck ${entombedPickless ? 'entombed/vertStuck' : 'no-table-no-wood'} mob=${v.mob} cobble=${cobbleN} table=${inv.crafting_table || 0} (clear junk first)`); }
  if (armorN < 4) { cmds.push(...ARMOR); act = true; log(`TRIGGER unarmored ${armorN}/4`); }
  // ★deepslate-stranded (worker-frozen 0701): the bot reached deepslate/diamond depth with an iron pick,
  // it BROKE (durability), and there's no raw_iron/ingot to re-craft — a stone pick can't mine deepslate,
  // and deepslate iron ore needs iron+, so it's a chicken-and-egg strand right at the diamond band (live:
  // y-2, iron_pickaxe=0, raw_iron=0, commit fell to GET_BED wool-wander). The existing pickless crutch
  // MISSES it (the bot HAS a stone pick → hasPick=true). It earned iron-tier; restore the broken tool (2
  // spares to avoid an immediate re-strand) so it can actually mine deepslate/diamonds. NOT a tier jump.
  const ironPickN = (inv.iron_pickaxe || 0) + (inv.diamond_pickaxe || 0) + (inv.netherite_pickaxe || 0);
  // Give an iron pick at depth whenever the bot lacks one — stranded (no wood/material to re-craft) OR
  // the smelt+craft STALLS (has raw_iron but can't finish the craft while deep — live: stone-tier 9min
  // with raw_iron 41, never crafted). A stone pick can't mine deepslate, so no iron pick at depth = the
  // whole diamond phase is dead. The old `!canRecraftIron` gate wrongly deferred when raw_iron>=3, but
  // raw_iron ≠ a finished pick when the craft won't complete. Fire on: deep + no iron pick + armored.
  const deepslateStranded = (typeof v.y === 'number' && v.y < 50) && ironPickN === 0 && armorN >= 1;   // ★y<25→<50 (worker-frozen 0701): bot burns iron picks mining the whole y0-50 band (not just deepslate) → goes pickless @y44 above the old <25 gate → craft-reliability then leaves it stuck wood-tier. Auto-supply across the mining band as a craft-stall fallback (fires only after ~2min pickless, so a successful re-craft still beats it).
  if (deepslateStranded) { cmds.push('/give @s iron_pickaxe 2'); act = true; log(`TRIGGER deep-no-iron-pick iron_pickaxe x2 @y${v.y} (stone pick cant mine deepslate; craft stalled/stranded, raw_iron=${inv.raw_iron || 0})`); }
  // ★table-maintenance (worker-frozen 0701): sufficientForUnderground (modes.js:4730) requires a carried
  // crafting TABLE (to re-craft a pick if it snaps underground). Without one the surfaceGate HOLDS with
  // "kit insufficient (picks)" and blocks ALL descent — so an iron-tier bot with 2 durable picks + 53
  // raw_iron gets stuck surface-wandering / wheat-farming instead of mining diamonds (live: 30min NO-NET-
  // PROGRESS, commit=OPP_WHEAT_FARM, GET_DIAMOND never proposed). The bot is wood-starved near deepslate
  // (no logs → can't make a table). Keep it table+wood stocked so sufficientForUnderground stays true and
  // GET_DIAMOND engages. Real fix = decision-layer stocks wood BEFORE descending (attended).
  if ((inv.crafting_table || 0) < 1 && armorN >= 1 && ironPickN >= 1) { cmds.push('/give @s crafting_table 2', '/give @s oak_planks 12', '/give @s stick 8'); act = true; log(`TRIGGER table-maintenance (no table + iron-tier) → carriedTable so surfaceGate allows descent for diamonds`); }
  // ★2026-07-09 用户令 HP/食物本能熔断: FAMINE 作弊补给 (instant_health+beef) 是饥饿驱动的低血/低饱行为; MIXED hp+food, 双闸全 OFF 时 inert, 任一/双闸开恢复。
  if ((_hpOn() || _foodOn()) && hp < 10 && food < 18 && !edible) { cmds.push('/effect give @s minecraft:instant_health 1 10', '/effect give @s minecraft:saturation 1 5', '/give @s cooked_beef 32'); act = true; log(`TRIGGER famine hp=${hp} food=${food}`); }   // ★food<14→<18 (worker-frozen 0701): MC regen needs food≥18 — a bot at hp8/food14-17 is stuck LOW-HP not regening (live: hp8/food14 pinned 14min, stall building), the old food<14 gate missed the 14-17 no-regen zone. Heal+feed so it can regen and resume.
  if (freeWedge) { cmds.push('/tp @s ~14 ~5 ~14'); act = true; log(`TRIGGER FREE-wedge tp-unwedge y=${v.y} jumpFails=${jumpFails}`); }
  if (swimWedge) { cmds.push('/effect give @s minecraft:water_breathing 800 1', '/tp @s ~5 ~4 ~5'); act = true; log(`TRIGGER swim-wedge mob=${v.mob} jumpFails=${jumpFails} y=${v.y} — water_breathing + surface tp-nudge`); }
  const drowningLoop = recentDrownings() >= 1;   // ★lowered 2→1 (worker-frozen 0701): with no bed, even ONE drowning resets the bot to spawn (costly progress-reset) — react on the first drowning, not the second
  if (drowningLoop) { cmds.push('/effect give @s minecraft:water_breathing 600 1'); act = true; log(`TRIGGER drowning water_breathing (${recentDrownings()} drownings/5min)`); }
  // ★FIX8 deep-mining survival (worker-frozen 0701): after iron-tier the #1 death source is DEEP-MINING
  // cave hazards — creeper point-blank (instant ~20dmg, the medic's 120s tick can't react to an instant
  // kill), fall into ravine/cave, lava. keepInventory preserves iron-tier but every death RESETS to the
  // water-heavy spawn (spawn-gravity, the spawnpoint crutch can't fire — the bot has no safe surface
  // moment), capping diamond progress (live: deaths 55→59 in ~47min ≈6/h, causes fall/creeper/zombie).
  // The proper fix (mineDown/branchMine fall-guards + torch-placement to stop cave-mob spawns + cave-mob
  // avoidance) is a dedicated attended session. Bridge it: while DEEP (y<45), keep Resistance II (~40%
  // less damage → survive a point-blank creeper at full hp, halve fall damage) + fire_resistance (lava).
  // Re-applied each 120s tick (duration 300s so it never lapses mid-mine). Surface unaffected.
  // Fire DEEP (y<45: creeper/fall/lava) OR at NIGHT (any depth: mob swarm). Live: 3-death spiral when a
  // night swarm (3 hostiles) caught the bot HELD at the surface (surfaceGate hold) — the y<45 gate left it
  // unprotected up top. Night resistance bridges that until it descends (table fix) or shelters (attended).
  const isNightNow = (typeof v.tod === 'number' && v.tod >= 12800 && v.tod <= 23200);
  if ((typeof v.y === 'number' && v.y < 45) || isNightNow) {
    cmds.push('/effect give @s minecraft:resistance 300 2', '/effect give @s minecraft:fire_resistance 300 0');
    act = true; log(`survival resistance III + fire_res @y${v.y} ${isNightNow ? 'NIGHT(swarm bridge)' : 'deep(creeper/fall/lava)'}`);
  }
  // ★inv-full declutter (worker-frozen 0701): THE net-stall root — a full 36-slot pack silently drops
  // every new pickup (incl. raw_iron from mined iron_ore) on the ground → the bot mines the iron-dense
  // band yet raw_iron never grows and tier never advances (live: 36/36 types full of dirt/cobble/stone-
  // variants, raw_iron frozen at 2 for >1h). Clear the worthless mining spoil when near-full so ore
  // stays pickup-able. Real fix = declutterInv running aggressively mid-mine (attended).
  const invTypes = Object.keys(inv).length;
  if (invTypes >= 33) { cmds.push(...MINING_JUNK); act = true; log(`TRIGGER inv-full declutter (${invTypes}/36 types) — clear mining spoil so iron_ore pickup works`); }
  // ★spawnpoint crutch (worker-frozen 0701): break SPAWN-GRAVITY. The bot has no bed → every death
  // respawns it at the water-heavy world-spawn (0,73), and its home-anchor (bot.spawnPoint, used by
  // prepNether/bankGear) keeps pulling it back there, where it dies again (night mobs / hazards) = a
  // death-reset loop that net-stalls tier progress (live: deaths 46→54, raw_iron kept resetting to 2).
  // When the bot is safe on DRY OPEN surface in DAYLIGHT and FAR (>120b) from the bad spawn center,
  // move the respawn + home-anchor HERE so deaths land at the drier outlying WORK area, not the water
  // spawn. Hard-gated (dry/day/safe/far/surface) so it never sets a hazardous or water-spawn point.
  // Real fix = the bot establishing a proper relocated home+bed (attended).
  const distSpawn = Math.hypot(v.x || 0, v.z || 0);
  const dryDaySafe = !/SWIM|ENTOMBED|POCKET|MAROONED|SEALED/.test('' + v.mob) && (v.y || 0) >= 58
    && (typeof v.tod === 'number' && v.tod < 11500) && hp >= 16 && (v.hostiles || 0) === 0;
  if (dryDaySafe && distSpawn > 40 && Date.now() - lastSpawnSet > 240000) {   // ★dist 120→40 (worker-frozen 0701): the bot's mining area sits only ~40-50b from spawn, so >120 never fired and the spawn-gravity death-reset persisted (deaths 55→57 to night/water at spawn). 40b lets it anchor at the drier work-area surface.
    cmds.push('/spawnpoint @s'); act = true; lastSpawnSet = Date.now();
    log(`spawnpoint → ~${Math.round(v.x)},${Math.round(v.y)},${Math.round(v.z)} (dist ${Math.round(distSpawn)}b from spawn) — break spawn-gravity`);
  }

  if (act && cheatEmpty()) { writeCheat(cmds); lastApply = Date.now(); }
  else if (act) { log('crutch needed but cheat.txt has pending cmds, defer'); }
}

log(`bot-medic START (pid ${process.pid}) check=${CHECK_MS / 1000}s`);
tick();
setInterval(tick, CHECK_MS);
