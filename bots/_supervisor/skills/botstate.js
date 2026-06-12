// One-shot probe of the bot's physical situation. ctx = { skills, world, mc, Vec3, log }
import fs from 'fs';
import path from 'path';
const PROG = path.resolve(process.cwd(), 'bots', '_supervisor', 'progress.txt');
const prog = (s) => { try { fs.appendFileSync(PROG, `[${new Date().toISOString()}] ${s}\n`); } catch (e) {} };

export default async function botstate(bot, ctx) {
    const p = bot.entity.position;
    const at = bot.blockAt(p);
    const feet = bot.blockAt(p.offset(0, -1, 0));
    const head = bot.blockAt(p.offset(0, 1, 0));
    prog(`STATE pos=${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} hp=${bot.health} food=${bot.food} O2=${bot.oxygenLevel} onGround=${bot.entity.onGround} vel=${bot.entity.velocity.y.toFixed(2)}`);
    prog(`STATE block@feet=${feet && feet.name} block@body=${at && at.name} block@head=${head && head.name} gameMode=${bot.game && bot.game.gameMode} dimension=${bot.game && bot.game.dimension}`);
    prog(`STATE windowOpen=${bot.currentWindow ? bot.currentWindow.type : 'none'} usingHeldItem=${!!bot.usingHeldItem}`);
    return { y: p.y, hp: bot.health, feet: feet && feet.name, body: at && at.name, onGround: bot.entity.onGround };
}
