// TEMP diagnostic (hot-reloadable, safe to delete): snapshot the busy-state that is
// muting the kernel. Invoked via ws run_skill; returns a plain object. Also schedules
// a one-shot 3s-later append of bot._currentSkill to progress.txt — by then customSkill
// has RESTORED the pre-call value, i.e. the skill name that is stuck holding ms.busy.
import fs from 'fs';
import path from 'path';
const PROG = path.resolve(process.cwd(), 'bots', '_supervisor', 'progress.txt');
export default async function diagBusy(bot, ctx) {
    const agent = bot._agent || null;
    const now = Date.now();
    const snap = {
        gameTimeOfDay: (() => { try { return bot.time && bot.time.timeOfDay; } catch (e) { return null; } })(),
        dimension: (() => { try { return String(bot.game.dimension); } catch (e) { return null; } })(),
        pos: (() => { try { const p = bot.entity.position; return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`; } catch (e) { return null; } })(),
        hp: bot.health, food: bot.food,
        actionsExecuting: !!(agent && agent.actions && agent.actions.executing),
        actionLabel: (agent && agent.actions && (agent.actions.currentActionLabel ?? agent.actions.currentActionName ?? null)) || null,
        supervisedSkill: !!(agent && agent.supervised_skill),
        interruptCode: !!bot.interrupt_code,
        supervisorCancelAgoMs: bot._supervisorCancelAt ? now - bot._supervisorCancelAt : null,
        kernelHeartbeatAgoMs: bot._kernelDriverActive ? now - bot._kernelDriverActive : null,
        pathfinderGoal: (() => { try { return bot.pathfinder && bot.pathfinder.goal ? bot.pathfinder.goal.constructor.name : null; } catch (e) { return null; } })(),
        pathfinderMoving: (() => { try { return !!(bot.pathfinder && bot.pathfinder.isMoving()); } catch (e) { return null; } })(),
        controlStates: (() => { try { return ['forward','back','left','right','jump','sneak','sprint'].filter(c => bot.getControlState(c)); } catch (e) { return []; } })(),
        commitment: (() => { try { return bot._commitment ? `${bot._commitment.kind}@${bot._commitment.priority}` : null; } catch (e) { return null; } })(),
        kindCooldowns: (() => { try { const o = {}; const c = bot._kindCooldownUntil || {}; for (const k of Object.keys(c)) { const left = c[k] - now; if (left > 0) o[k] = Math.round(left / 1000) + 's'; } return o; } catch (e) { return null; } })(),
    };
    setTimeout(() => {
        try { fs.appendFileSync(PROG, `[${new Date().toISOString()}] [diagBusy+3s] restored bot._currentSkill=${JSON.stringify(bot._currentSkill)} actionsExecuting=${!!(agent && agent.actions && agent.actions.executing)} supervised=${!!(agent && agent.supervised_skill)}\n`); } catch (e) {}
    }, 3000);
    return snap;
}
