// Renderer liveness and an online Minecraft body are separate health signals.
export function gameOnline(bot) {
    return !!(bot?.entity?.position && !bot._poisoned
        && bot._client?.state === 'play' && !bot._client.ended);
}
