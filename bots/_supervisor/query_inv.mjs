// One-shot: ask the agent for a fresh inventory snapshot and print it.
import WebSocket from 'ws';
const ws = new WebSocket(process.env.NEKO_WS_URL || 'ws://localhost:48909');
const done = (o) => { console.log(JSON.stringify(o)); try { ws.close(); } catch {} process.exit(0); };
const t = setTimeout(() => done({ error: 'timeout' }), 6000);
ws.on('open', () => ws.send(JSON.stringify({ type: 'query_inventory' })));
ws.on('message', (d) => {
    let m; try { m = JSON.parse(d.toString()); } catch { return; }
    if (m.type === 'inventory') { clearTimeout(t); done({ inventory: m.inventory }); }
});
ws.on('error', (e) => done({ error: String(e.message || e) }));
