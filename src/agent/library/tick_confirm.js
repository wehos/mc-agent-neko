// Helpers that turn fire-and-forget mineflayer packet sends into
// "confirmed by observable state change" operations.
//
// Many mineflayer methods (bot.useOn, bot.activateBlock, bot.activateItem,
// bot.activateEntity, the held-slot side of bot.equip, bot.placeBlock)
// resolve as soon as the packet is queued to the network — not when the
// server has finished applying the action. Issuing a follow-up packet
// (e.g. use_entity right after a held-slot change) before the server has
// processed the previous one is the most common cause of "the command ran
// but nothing happened in-world": leash-on-sheep, eat-after-equip,
// place-on-just-broken-block, etc.
//
// These helpers wrap the call with: poll an observable confirmation,
// retry with a short backoff on tick races, and report a classified
// failure (`prerequisite` / `tick_race` / `unknown`) so the caller can
// decide whether to surface the error or re-plan.

const TICK_MS = 50;          // 1 server tick at 20 TPS
const DEFAULT_POLL_INTERVAL = TICK_MS;
const DEFAULT_CONFIRM_TIMEOUT = 600;   // up to ~12 ticks
const DEFAULT_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 200;
const POST_EQUIP_SETTLE_MS = 100;      // 2 ticks for the server to register the held slot

export async function sleepMs(ms) {
    if (ms <= 0) return;
    await new Promise(r => setTimeout(r, ms));
}

export async function waitForCondition(predicate, opts = {}) {
    const {
        timeout = DEFAULT_CONFIRM_TIMEOUT,
        interval = DEFAULT_POLL_INTERVAL,
        bot = null,
    } = opts;
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (bot && bot.interrupt_code) return false;
        let v = false;
        try { v = await predicate(); } catch (_) { v = false; }
        if (v) return true;
        await sleepMs(interval);
    }
    return false;
}

// Run an operation with confirm-and-retry semantics.
//
// `prerequisite` (optional, async () => {ok, reason}): checked once before
//   any retries. A failing prerequisite is non-retryable and surfaces as
//   error_class='prerequisite'.
// `operation` (async () => void): the action to attempt. Errors thrown by
//   it are treated as tick-races (retryable) — the most common case is a
//   "place_block" throwing because the build-off block was occupied for a
//   tick by a transient entity.
// `confirm` (async () => boolean): observable post-condition. If absent
//   the operation is assumed successful as soon as it returns.
//
// Returns: { ok, error_class?, reason?, attempts }.
export async function withRetry(operation, opts = {}) {
    const {
        confirm,
        prerequisite,
        retries = DEFAULT_RETRIES,
        backoffMs = DEFAULT_BACKOFF_MS,
        confirmTimeoutMs = DEFAULT_CONFIRM_TIMEOUT,
        bot = null,
        label = 'operation',
    } = opts;

    if (prerequisite) {
        const pre = await prerequisite();
        if (pre && pre.ok === false) {
            return { ok: false, error_class: 'prerequisite', reason: pre.reason || `${label} prerequisite not met`, attempts: 0 };
        }
    }

    let lastErr = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
        if (bot && bot.interrupt_code) {
            return { ok: false, error_class: 'interrupted', reason: 'interrupted', attempts: attempt - 1 };
        }
        try {
            await operation();
            lastErr = null;
        } catch (e) {
            lastErr = e;
        }

        if (!confirm) {
            if (!lastErr) return { ok: true, attempts: attempt };
        } else {
            const ok = await waitForCondition(confirm, { timeout: confirmTimeoutMs, bot });
            if (ok) return { ok: true, attempts: attempt };
        }

        if (attempt < retries) {
            await sleepMs(backoffMs);
        }
    }

    return {
        ok: false,
        error_class: lastErr ? 'unknown' : 'tick_race',
        reason: lastErr ? (lastErr.message || lastErr.toString()) : `${label} not confirmed after ${retries} attempts`,
        attempts: retries,
    };
}

// Equip helper that waits for the server to register the new held slot.
//
// `bot.equip(item, 'hand')` synchronously flips `bot.quickBarSlot` locally
// and sends a `held_item_slot` packet. Any follow-up action that the
// server resolves against its own state (use_entity, block_place,
// activateItem) will misfire if it arrives before the server processes
// that packet. We:
//   1. call bot.equip,
//   2. settle ~2 ticks,
//   3. verify bot.heldItem matches,
//   4. on mismatch, retry by clicking the slot directly.
//
// For non-hand destinations (armor / off-hand) bot.equip already awaits a
// window-click ACK, so we just verify the slot afterwards.
export async function equipConfirmed(bot, itemName, destination = 'hand', opts = {}) {
    const {
        retries = DEFAULT_RETRIES,
        backoffMs = DEFAULT_BACKOFF_MS,
        settleMs = POST_EQUIP_SETTLE_MS,
        confirmTimeoutMs = DEFAULT_CONFIRM_TIMEOUT,
    } = opts;

    // ★EAT-VOID 手部锁 (2026-07-04 07:42 x10 实录: auto_eat 开吃后, 猎杀/工具反射经此咽喉点
    // 换手装剑 → mineflayer 在 heldItemChanged 上把 eatingTask 静默 resolve, 鸡肉在手 food 钉 0):
    // 进食窗内 (skills.consume 置 bot._eatingUntil, ≤2.6s 自过期) 的 hand 换装请求等窗口收尾,
    // 装的就是正在吃的食物则放行; 甲/副手目的地不受影响。饿死是确定性死亡, 让两拍剑击可收回。
    if (destination === 'hand') {
        while (bot._eatingUntil && Date.now() < bot._eatingUntil && itemName !== bot._eatingItem) {
            await sleepMs(100);
        }
    }

    const findItem = () => bot.inventory.slots.find(s => s && s.name === itemName);

    const armorSlotsByDest = { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 };

    const confirm = () => {
        if (destination === 'hand') {
            return Promise.resolve(bot.heldItem && bot.heldItem.name === itemName);
        }
        const slotIdx = armorSlotsByDest[destination];
        if (slotIdx == null) return Promise.resolve(true); // unknown destination, skip
        const s = bot.inventory.slots[slotIdx];
        return Promise.resolve(!!s && s.name === itemName);
    };

    const prerequisite = () => {
        const item = findItem();
        if (!item) return Promise.resolve({ ok: false, reason: `no ${itemName} in inventory` });
        return Promise.resolve({ ok: true });
    };

    return await withRetry(async () => {
        const item = findItem();
        if (!item) throw new Error(`no ${itemName} in inventory`);
        await bot.equip(item, destination);
        await sleepMs(settleMs);
    }, { prerequisite, confirm, retries, backoffMs, confirmTimeoutMs, bot, label: `equip(${itemName})` });
}

// Wrap bot.useOn(entity) with a state confirmation. The caller supplies
// `confirm` because the observable side-effect is action-specific: lead
// → inventory.lead count decreases; bucket on cow → milk_bucket appears;
// shears on sheep → wool item drops; etc. If no `confirm` is given we
// just settle one tick.
export async function useOnEntityConfirmed(bot, entity, opts = {}) {
    const {
        confirm,
        retries = DEFAULT_RETRIES,
        backoffMs = DEFAULT_BACKOFF_MS,
        confirmTimeoutMs = DEFAULT_CONFIRM_TIMEOUT,
        prerequisite,
    } = opts;

    return await withRetry(async () => {
        // re-lookAt before each retry: target entity may have moved
        try {
            await bot.lookAt(entity.position.offset(0, entity.height ? entity.height * 0.5 : 0.5, 0), false);
        } catch (_) {
            // lookAt can throw if the entity despawned between retries — keep going,
            // the use_entity packet will fail-soft on the server side too.
        }
        bot.useOn(entity);
    }, { prerequisite, confirm, retries, backoffMs, confirmTimeoutMs, bot, label: 'useOn' });
}

// bot.placeBlock(refBlock, faceVec) sends the place packet; the server may
// reject (block already there, in-range entity, anti-cheat). Confirm by
// reading bot.blockAt(targetPos).name.
export async function placeBlockConfirmed(bot, refBlock, faceVec, targetPos, expectedName, opts = {}) {
    const {
        retries = DEFAULT_RETRIES,
        backoffMs = DEFAULT_BACKOFF_MS,
        confirmTimeoutMs = DEFAULT_CONFIRM_TIMEOUT,
    } = opts;

    const confirm = () => {
        const b = bot.blockAt(targetPos);
        if (!b) return Promise.resolve(false);
        const n = b.name;
        if (n === expectedName) return Promise.resolve(true);
        if (expectedName === 'dirt' && n === 'grass_block') return Promise.resolve(true);
        return Promise.resolve(false);
    };

    return await withRetry(async () => {
        await bot.placeBlock(refBlock, faceVec);
    }, { confirm, retries, backoffMs, confirmTimeoutMs, bot, label: `placeBlock(${expectedName})` });
}

// bot.activateBlock(block) — same fire-and-forget pattern. Caller supplies
// a `confirm` (e.g. door _properties.open flips, farmland appears after
// tilling). If none, we just settle one tick.
export async function activateBlockConfirmed(bot, block, opts = {}) {
    const {
        confirm,
        retries = DEFAULT_RETRIES,
        backoffMs = DEFAULT_BACKOFF_MS,
        confirmTimeoutMs = DEFAULT_CONFIRM_TIMEOUT,
    } = opts;

    return await withRetry(async () => {
        await bot.activateBlock(block);
    }, { confirm, retries, backoffMs, confirmTimeoutMs, bot, label: 'activateBlock' });
}

// bot.activateItem() — used for buckets / bows / consumables. Caller
// supplies confirm.
export async function activateItemConfirmed(bot, opts = {}) {
    const {
        confirm,
        retries = DEFAULT_RETRIES,
        backoffMs = DEFAULT_BACKOFF_MS,
        confirmTimeoutMs = DEFAULT_CONFIRM_TIMEOUT,
        offHand = false,
    } = opts;

    return await withRetry(async () => {
        bot.activateItem(offHand);
    }, { confirm, retries, backoffMs, confirmTimeoutMs, bot, label: 'activateItem' });
}

// Return an inventory snapshot suitable for delta checks. Cheaper than
// world.getInventoryCounts because we only stash the item we care about.
export function snapshotItemCount(bot, itemName) {
    let total = 0;
    for (const slot of bot.inventory.slots) {
        if (slot && slot.name === itemName) total += slot.count;
    }
    return total;
}
