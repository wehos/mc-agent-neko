// Retired: low health must never trigger a deliberate death/reset action.
export default async function digReset() {
    return { ran: false, retired: true, reason: 'low-health reflex retired' };
}
