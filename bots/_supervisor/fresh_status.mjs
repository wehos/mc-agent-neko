import fs from 'fs';
import net from 'net';
import path from 'path';

const root = process.cwd();
const now = Date.now();

const files = [
  ['heartbeat', 'heartbeat.log', 120],
  ['alerts', 'ALERTS.txt', 300],
  ['agentErr', 'agent.err', 120],
  ['watchdog', 'watchdog.log', 180],
  ['vitals', path.join('bots', '_supervisor', 'vitals.json'), 45],
  ['status', path.join('bots', '_supervisor', 'status.json'), 45],
  ['progress', path.join('bots', '_supervisor', 'progress.txt'), 120],
  ['events', path.join('bots', '_supervisor', 'events.log'), 120],
  ['deathLog', path.join('bots', '_supervisor', 'death_log.jsonl'), 300],
  ['radar', path.join('bots', '_supervisor', 'radar.json'), 45],
  ['advisory', path.join('bots', '_supervisor', 'advisory.json'), 45],
];

const ports = [
  ['agentWs', 48909],
  ['mindserver', 8765],
  ['minecraftLan', 55916],
];

function fileState([name, rel, freshSeconds]) {
  const abs = path.resolve(root, rel);
  try {
    const st = fs.statSync(abs);
    const ageSeconds = Math.max(0, Math.round((now - st.mtimeMs) / 1000));
    return {
      name,
      path: rel,
      exists: true,
      ageSeconds,
      freshSeconds,
      fresh: ageSeconds <= freshSeconds,
      mtime: st.mtime.toISOString(),
      bytes: st.size,
    };
  } catch {
    return {
      name,
      path: rel,
      exists: false,
      ageSeconds: null,
      freshSeconds,
      fresh: false,
      mtime: null,
      bytes: 0,
    };
  }
}

function checkPortOnHost(port, host) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(400);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function checkPort(port) {
  for (const host of ['127.0.0.1', '::1']) {
    if (await checkPortOnHost(port, host)) return true;
  }
  return false;
}

function readJson(rel) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(root, rel), 'utf8'));
  } catch {
    return null;
  }
}

function tailLine(rel) {
  try {
    const text = fs.readFileSync(path.resolve(root, rel), 'utf8');
    const lines = text.trimEnd().split(/\r?\n/);
    return lines[lines.length - 1] || '';
  } catch {
    return '';
  }
}

const fileStates = Object.fromEntries(files.map((entry) => {
  const state = fileState(entry);
  return [state.name, state];
}));

const portStates = {};
for (const [name, port] of ports) {
  portStates[name] = { port, open: await checkPort(port) };
}

const live = {
  agentWs: portStates.agentWs.open,
  minecraftLan: portStates.minecraftLan.open,
  vitalsFresh: fileStates.vitals.fresh,
  progressFresh: fileStates.progress.fresh,
  heartbeatFresh: fileStates.heartbeat.fresh,
};

let classification = 'offline';
if (live.agentWs && live.vitalsFresh) classification = 'live';
else if (live.agentWs) classification = 'agent-port-only';
else if (live.minecraftLan) classification = 'minecraft-only';
else if (Object.values(fileStates).some((s) => s.fresh)) classification = 'partial-or-starting';

const vitals = readJson(path.join('bots', '_supervisor', 'vitals.json'));
const status = readJson(path.join('bots', '_supervisor', 'status.json'));

const result = {
  now: new Date(now).toISOString(),
  classification,
  live,
  ports: portStates,
  files: fileStates,
  latest: {
    vitals,
    status,
    heartbeat: tailLine('heartbeat.log'),
    alert: tailLine('ALERTS.txt'),
    progress: tailLine(path.join('bots', '_supervisor', 'progress.txt')),
  },
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const stale = Object.values(fileStates)
    .filter((s) => s.exists && !s.fresh)
    .map((s) => `${s.name}:${s.ageSeconds}s`);
  const fresh = Object.values(fileStates)
    .filter((s) => s.fresh)
    .map((s) => `${s.name}:${s.ageSeconds}s`);
  console.log(`classification=${classification}`);
  console.log(`ports agentWs=${portStates.agentWs.open ? 'open' : 'closed'} mindserver=${portStates.mindserver.open ? 'open' : 'closed'} minecraftLan=${portStates.minecraftLan.open ? 'open' : 'closed'}`);
  console.log(`fresh ${fresh.length ? fresh.join(' ') : 'none'}`);
  console.log(`stale ${stale.length ? stale.join(' ') : 'none'}`);
  if (vitals) {
    const label = fileStates.vitals.fresh ? 'live-vitals' : 'latest-stale-vitals';
    console.log(`${label} age=${fileStates.vitals.ageSeconds}s pos=${vitals.x},${vitals.y},${vitals.z} dim=${vitals.dim} hp=${vitals.hp} food=${vitals.food} skill=${vitals.skill || 'none'} mob=${vitals.mob || '?'}`);
  }
}
