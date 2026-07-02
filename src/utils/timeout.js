// Startup must never block on a network call that stalls without erroring
// (observed: DNS-poisoned api.openai.com hangs the embeddings request forever,
// so Agent.start() never reaches MC login). Bound such calls so a stall
// becomes a rejection that existing catch->fallback paths already handle.
export const EMBED_TIMEOUT_MS = 8000;

export function withTimeout(promise, ms = EMBED_TIMEOUT_MS, label = 'operation') {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    // Promise.race attaches handlers to both promises, so if the timeout wins
    // and the original promise rejects later, that rejection is still handled
    // (never an unhandledRejection). finally() stops the timer from keeping
    // the event loop alive after a fast settle.
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
