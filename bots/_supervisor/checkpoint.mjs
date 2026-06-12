// Long-running monitor over a PERSISTENT WebSocket to the agent (port 48909).
// agent.log is block-buffered (stdout redirect) so it lags minutes — useless for
// timely death/progress detection. Instead we go to the source:
//   - poll query_inventory every 20s  -> real-time key-item milestones + death proxy
//   - print live 'log'/'skill_result'/'error' frames the agent pushes
//   - 60s PULSE summarising deaths / latest milestone / key items
// Each console.log line is one Monitor event.
import WebSocket from 'ws';

const URL = process.env.NEKO_WS_URL || 'ws://localhost:48909';
const KEYS = ['stone_pickaxe', 'iron_pickaxe', 'iron_ingot', 'iron_chestplate', 'shield', 'diamond', 'diamond_pickaxe', 'raw_iron', 'furnace'];
const TOOLS = ['iron_pickaxe', 'stone_pickaxe', 'iron_chestplate', 'shield', 'diamond'];

let ws = null;
let lastInv = null;
let deaths = 0;
let lastMile = '';
let seen = new Set();           // milestone items already announced
let lastTotal = 0;
let lastDeathTs = 0;            // de-dup: one death fires both a wipe AND a respawn log
function flagDeath(why) {
    const now = Date.now();
    if (now - lastDeathTs < 30000) return; // same death, already counted
    lastDeathTs = now; deaths++;
    console.log(`[${ts()}] 💀 DEATH(${deaths}): ${why}`);
}

function ts() { return new Date().toTimeString().slice(0, 8); }
function total(inv) { return Object.values(inv).reduce((a, b) => a + b, 0); }
function keyStr(inv) { return KEYS.filter(k => inv[k]).map(k => `${k}=${inv[k]}`).join(' ') || '(no key items yet)'; }

function onInventory(inv) {
    // milestone: a key item appeared for the first time
    for (const k of KEYS) {
        if (inv[k] && !seen.has(k)) { seen.add(k); lastMile = `got ${k} x${inv[k]}`; console.log(`[${ts()}] ✅ MILESTONE: ${lastMile}`); }
    }
    // death proxy: near-total inventory wipe (death drops everything). The old
    // "lost a tool" gate missed the death that left only dirt because no tracked tool
    // was in the pack at the time. A wipe from a sizable pack to almost nothing is a
    // reliable death signal on its own.
    if (lastInv && lastTotal >= 8 && total(inv) <= 3) flagDeath(`inventory wiped ${lastTotal}->${total(inv)} items`);
    lastInv = inv; lastTotal = total(inv);
}

let wasConnected = false; // only log connect/disconnect TRANSITIONS, not every 3s retry
function connect() {
    ws = new WebSocket(URL);
    ws.on('open', () => { if (!wasConnected) console.log(`[${ts()}] ▸ monitor WS connected`); wasConnected = true; ws.send(JSON.stringify({ type: 'query_inventory' })); });
    ws.on('message', (d) => {
        let m; try { m = JSON.parse(d.toString()); } catch { return; }
        if (m.type === 'inventory') { onInventory(m.inventory || {}); }
        else if (m.type === 'skill_result') { console.log(`[${ts()}] ▸ skill_result ${m.skill} ok=${m.ok}${m.error ? ' err=' + String(m.error).slice(0, 160) : ''}`); }
        else if (m.type === 'log') {
            const t = String(m.message || '').trim();
            if (t) {
                // mindcraft's post-death autopilot heads back to the death point — a
                // reliable death signal even when we miss the inventory-wipe frame.
                if (/last_death_position|goToRememberedPlace|respawn|i died|have died/i.test(t)) flagDeath(`respawn signal: ${t.slice(0, 80)}`);
                lastMile = t.slice(0, 140); console.log(`[${ts()}] log: ${lastMile}`);
            }
        }
        else if (m.type === 'error') { console.log(`[${ts()}] ⚠ error: ${String(m.message || '').slice(0, 180)}`); }
        else if (m.type === 'agent_status' && m.status && typeof m.status.health === 'number' && m.status.health <= 0) flagDeath('health 0');
    });
    ws.on('close', () => { if (wasConnected) console.log(`[${ts()}] ▸ WS lost (agent restart?), reconnecting...`); wasConnected = false; setTimeout(connect, 3000); });
    ws.on('error', () => {}); // suppress; 'close' fires right after and handles state
}

connect();
// poll inventory every 20s
setInterval(() => { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'query_inventory' })); } catch {} }, 20000);
// slow heartbeat pulse (milestones/deaths push immediately, so this is just a keep-alive)
setInterval(() => { console.log(`[${ts()}] PULSE deaths=${deaths} | ${lastInv ? keyStr(lastInv) : 'inv=?'} | last:${lastMile || '-'}`); }, 180000);
