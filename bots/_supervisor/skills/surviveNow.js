// Retired: absolute health is not allowed to seize the body or synthesize a
// recovery plan. Carried food and healing potions are handled by modes.js.
export default async function surviveNow() {
    return { retired: true, reason: 'low-health reflex retired' };
}
