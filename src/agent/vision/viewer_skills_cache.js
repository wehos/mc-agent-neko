// Keep the existing connection's latest bounded state packet while viewer
// assets load. The host remains responsible for strict schema validation.
const caches = new WeakMap();
const CHANNEL = 'mcagent:state';

export function watchViewerSkills(bot) {
    if (caches.has(bot)) return;
    const client = bot._client;
    if (!client?.on) return;
    const entry = { client, packet: null };
    const receive = packet => {
        if (packet?.channel !== CHANNEL || !(packet.data instanceof Uint8Array)
            || packet.data.byteLength < 1 || packet.data.byteLength > 65536) return;
        entry.packet = { channel: CHANNEL, data: Buffer.from(packet.data), observedAt: Date.now() };
    };
    const close = () => {
        client.off('custom_payload', receive);
        bot.off('end', close);
        caches.delete(bot);
        entry.packet = null;
    };
    client.on('custom_payload', receive);
    bot.once('end', close);
    caches.set(bot, entry);
}

export function cachedViewerSkills(bot) {
    const entry = caches.get(bot);
    if (!entry?.packet || entry.client !== bot._client || entry.client.ended) return null;
    return { ...entry.packet, data: Buffer.from(entry.packet.data) };
}
