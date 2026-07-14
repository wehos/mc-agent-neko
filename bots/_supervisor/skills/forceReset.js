// One-shot, user-authorized reset of an UNRECOVERABLE stone tomb (2026-06-18: bot sealed
// naked-no-pick at y66 in a solid-stone mountain core, can't self-escape; user said "你可以
// reset我无所谓"). The bot's 'cheat' MODE is off, but the SERVER may still grant the bot
// command permission — so we try a server /kill. If the server forbids it this is a harmless
// no-op. Either outcome, we FIRST restore the sticky skill to missionNether (now carrying the
// C248 recovery-floor fix) so the bot resumes correctly on respawn or when this skill returns.
// Invoked: skills.customSkill(bot,'forceReset').  ctx = { skills, world, mc, Vec3, log }
import fs from 'fs';
import path from 'path';

export default async function forceReset(bot, ctx) {
    const { skills, log } = ctx;
    const STICKY = path.resolve(process.cwd(), 'bots', '_supervisor', 'sticky_skill.json');
    // Restore FIRST: a successful /kill interrupts this skill, so the sticky must already point
    // at missionNether for the respawn re-arm to load the right (C248-fixed) loop.
    try {
        fs.writeFileSync(STICKY, JSON.stringify({ skill: 'missionNether', args: [] }));
        log(bot, 'forceReset: sticky restored → missionNether (C248).');
    } catch (e) { log(bot, `forceReset: sticky restore err ${e && e.message || e}`); }

    const y0 = bot.entity && bot.entity.position ? bot.entity.position.y : null;
    const hp0 = bot.health;
    for (let i = 0; i < 2 && !bot.interrupt_code; i++) {
        try { bot.chat(i === 0 ? '/kill' : '/kill @s'); } catch (e) {}
        await skills.wait(bot, 1500);
        // respawn signature: health jumped back to ~20 or position teleported far (to spawn)
        const hp = bot.health;
        const y = bot.entity && bot.entity.position ? bot.entity.position.y : y0;
        if ((hp0 != null && hp > hp0 + 5) || (y0 != null && Math.abs(y - y0) > 8)) {
            log(bot, `forceReset: reset confirmed (hp ${Math.round(hp0)}→${Math.round(hp)} y ${Math.round(y0)}→${Math.round(y)}).`);
            return true;
        }
    }
    log(bot, 'forceReset: /kill had no effect (server likely forbids commands) — tomb persists, but C248 root fix is live.');
    return true;
}
