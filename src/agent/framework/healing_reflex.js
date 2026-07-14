/**
 * The only absolute-HP reflexes that remain: consume healing resources already
 * carried by the bot. These helpers are pure so the retirement boundary can be
 * regression-tested without a live Minecraft client.
 */

export function shouldAutoEat({ health = 20, food = 20, foodInstincts = false } = {}) {
    if (!Number.isFinite(health) || health <= 0 || !Number.isFinite(food)) return false;
    if (health < 20 && food < 18) return true; // unblock vanilla regeneration
    return !!foodInstincts && food <= 17;
}

function potionText(item) {
    try {
        return JSON.stringify({
            name: item && item.name,
            displayName: item && item.displayName,
            nbt: item && item.nbt,
            components: item && item.components,
            componentMap: item && item.componentMap,
        }).toLowerCase();
    } catch (e) {
        return '';
    }
}

/** Return instant_health/regeneration for a drinkable healing potion, else null. */
export function healingPotionEffect(item) {
    if (!item || item.name !== 'potion') return null;
    const text = potionText(item);
    // Reject harmful/custom variants before accepting broad effect names.
    if (/harming|instant_damage|poison|wither/.test(text)) return null;
    if (/healing|instant_health/.test(text)) return 'instant_health';
    if (/regeneration/.test(text)) return 'regeneration';
    return null;
}

export function chooseHealingPotion(items = []) {
    const candidates = items
        .map(item => ({ item, effect: healingPotionEffect(item) }))
        .filter(x => x.effect);
    return (candidates.find(x => x.effect === 'instant_health') || candidates[0] || {}).item || null;
}
