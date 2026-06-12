// Diagnostic: report whether an Ender Dragon entity still exists, and list
// nearby notable entities + the bot's dimension/position.
export default async function dragonStatus(bot, ctx) {
    const { log } = ctx;
    const ents = Object.values(bot.entities).filter(Boolean);
    const dragons = ents.filter(e =>
        e.name === 'ender_dragon' ||
        e.entityType === 'minecraft:ender_dragon' ||
        (e.displayName || '').toLowerCase().includes('dragon') ||
        (e.type === 'mob' && (e.kind || '').toLowerCase().includes('dragon')));
    const names = {};
    for (const e of ents) { const n = e.name || e.displayName || e.entityType || 'unknown'; names[n] = (names[n] || 0) + 1; }
    const p = bot.entity.position;
    log(bot, `DIM=${bot.game.dimension} POS=${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)} DRAGONS=${dragons.length} ENTITIES=${JSON.stringify(names)}`);
    return dragons.length;
}
