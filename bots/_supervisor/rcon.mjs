// Minimal RCON client for the local dedicated server (setup/observability ONLY —
// the bot itself must never receive progression help through this channel).
// Usage: node rcon.mjs "<command>"   (reads RCON_PORT/RCON_PASSWORD env, defaults below)
import net from 'net';

const HOST = process.env.RCON_HOST || '127.0.0.1';
const PORT = parseInt(process.env.RCON_PORT || '25575', 10);
const PASS = process.env.RCON_PASSWORD || 'neko-ops-2026';
const cmd = process.argv[2];
if (!cmd) { console.error('usage: node rcon.mjs "<command>"'); process.exit(2); }

function packet(id, type, body) {
    const b = Buffer.from(body, 'utf8');
    const buf = Buffer.alloc(14 + b.length);
    buf.writeInt32LE(10 + b.length, 0);
    buf.writeInt32LE(id, 4);
    buf.writeInt32LE(type, 8);
    b.copy(buf, 12);
    return buf;
}

const sock = net.createConnection({ host: HOST, port: PORT });
let buf = Buffer.alloc(0);
let authed = false;
sock.setTimeout(8000, () => { console.error('rcon timeout'); process.exit(1); });
sock.on('connect', () => sock.write(packet(1, 3, PASS)));
sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4) {
        const len = buf.readInt32LE(0);
        if (buf.length < 4 + len) break;
        const id = buf.readInt32LE(4);
        const body = buf.toString('utf8', 12, 4 + len - 2);
        buf = buf.subarray(4 + len);
        if (!authed) {
            if (id === -1) { console.error('rcon auth failed'); process.exit(1); }
            authed = true;
            sock.write(packet(2, 2, cmd));
        } else {
            console.log(body);
            sock.end();
            process.exit(0);
        }
    }
});
sock.on('error', (e) => { console.error('rcon error:', e.message); process.exit(1); });
