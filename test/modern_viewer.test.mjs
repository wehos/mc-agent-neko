import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { io } from 'socket.io-client';
import { Vec3 } from 'vec3';
import settings from '../src/agent/settings.js';
import { addBrowserViewer } from '../src/agent/vision/browser_viewer.js';
import { cachedViewerSkills, watchViewerSkills } from '../src/agent/vision/viewer_skills_cache.js';
import { startModernViewer } from '../src/agent/vision/modern/host.mjs';
import { loadViewerSelfSkin } from '../src/agent/vision/viewer_self_skin.js';

const require = createRequire(import.meta.url);
const sha256 = value => createHash('sha256').update(value).digest('hex');
// Transparent 64x64 PNG fixture, independent of any user's avatar or filesystem.
const skinPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAABmJLR0QA/wD/AP+gvaeTAAAAJ0lEQVR4nO3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAAAAAAAAAAIB3A0BAAAGP8slRAAAAAElFTkSuQmCC', 'base64');
function fakeBot() {
    return Object.assign(new EventEmitter(), {
        username: 'viewer_fixture', version: '1.20.6',
        registry: require('minecraft-data')('1.20.6'),
        _client: Object.assign(new EventEmitter(), { state: 'play' }),
        world: Object.assign(new EventEmitter(), { getColumn: () => null, getColumnAt: () => null }),
        entity: { id: 1, name: 'player', position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0),
            yaw: 0, pitch: 0, metadata: [], equipment: [], effects: {}, onGround: true },
        game: { dimension: 'overworld', minY: -64, height: 384 },
        inventory: Object.assign(new EventEmitter(), { slots: Array(46).fill(null), hotbarStart: 36 }),
        time: { timeOfDay: 0, age: 0 }, entities: {}, players: {}, experience: {},
        health: 20, food: 20, oxygenLevel: 20, quickBarSlot: 0,
        blockAt: () => null,
        chat() { assert.fail('watching must not send game chat'); },
    });
}
async function assets(t) {
    const temp = path.resolve(tmpdir());
    const root = await mkdtemp(path.join(temp, 'mc-modern-viewer-test-'));
    assert.equal(path.dirname(root), temp);
    t.after(() => rm(root, { recursive: true, force: true }));
    const browser = '// minimal browser fixture';
    const files = {
        'dist/modern-viewer.js': browser,
        'public/asset-source.json': JSON.stringify({ minecraftVersion: '1.20.6', clientJarSha256: 'fixture' }),
        'viewer-client.json': JSON.stringify({ minecraftVersion: '1.20.6', clientJarSha256: 'fixture',
            browserBundleSha256: sha256(browser) }),
        'public/mesher.js': '', 'public/mesherWasm.js': '', 'public/threeWorker.js': '',
        'public/blocksStates/1.20.6.json': '{}', 'public/textures/1.20.6.png': '',
        'render-assets/blockStatesModels.json': '{}', 'render-assets/blocksAtlases.json': '{}',
        'render-assets/itemsAtlases.json': '{}', 'render-assets/painting-records.json': '[]',
        'public/fonts/1.20.6/unifont.zip': Buffer.from([0x50, 0x4b, 3, 4]),
    };
    for (const [relative, value] of Object.entries(files)) {
        const file = path.join(root, relative);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, value);
    }
    return root;
}
async function availablePort() {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}
function connect(t, base, socketPath = '/socket.io/', busy = false) {
    const socket = io(base, { path: socketPath, transports: ['websocket'], reconnection: false,
        extraHeaders: { Origin: base } });
    t.after(() => socket.close());
    const ready = busy ? 'viewerBusy' : 'avatarState';
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`No ${ready} from ${base}${socketPath}`)), 4000);
        socket.once('connect_error', error => { clearTimeout(timer); reject(error); });
        socket.once(ready, value => { clearTimeout(timer); resolve({ socket, value }); });
    });
}

function contentEvent(socket, name, predicate = () => true) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.off(name, receive); reject(new Error(`Missing ${name}`)); }, 2000);
        function receive(value) {
            if (!predicate(value)) return;
            clearTimeout(timer); socket.off(name, receive); resolve(value);
        }
        socket.on(name, receive);
    });
}

test('host rejects invalid viewing limits and mismatched browser assets', async t => {
    for (const maxSessions of [0, 17, 1.5]) {
        await assert.rejects(startModernViewer(fakeBot(), { maxSessions }), /maxSessions/);
    }
    const root = await assets(t);
    await writeFile(path.join(root, 'dist/modern-viewer.js'), '// changed after manifest generation');
    await assert.rejects(startModernViewer(fakeBot(), { port: 3000, assetsDir: root }), /资源不完整/);
});

test('modern host streams both views over local and LAN connections and reuses slots', { timeout: 15000 }, async t => {
    const root = await assets(t);
    const port = await availablePort();
    Object.assign(settings, { render_bot_view: true, viewer_type: 'modern', viewer_port: port,
        modern_viewer_assets_dir: root, modern_viewer_max_sessions: 3,
        modern_viewer_lan_address: '127.0.0.2', modern_viewer_lan_prefix: 8 });
    const bot = fakeBot();
    await addBrowserViewer(bot);
    t.after(() => bot.viewer.close());
    const base = `http://127.0.0.1:${port}`;
    const lan = `http://127.0.0.2:${port}`;
    assert.equal(bot.viewer.info.lan_url, lan + '/');
    assert.deepEqual(bot.viewer.info.views, ['first', 'third', 'dungeon']);
    for (const route of ['/', '/third/', '/dungeon/']) {
        const response = await fetch(base + route);
        assert.equal(response.status, 200);
        assert.doesNotMatch(await response.text(), /<iframe[^>]+corti-speech-bubble/);
    }
    const a = await connect(t, base);
    await connect(t, base, '/third/socket.io/');
    await connect(t, lan);
    assert.equal(a.value.health, 20);
    const health = async () => (await fetch(base + '/healthz')).json();
    assert.equal((await health()).viewers, 3);
    assert.equal((await health()).gameOnline, true);
    bot._client.ended = true;
    assert.equal((await health()).ok, true, 'HTTP rendering can remain available after game disconnect');
    assert.equal((await health()).gameOnline, false);
    bot._client.ended = false;
    const rejected = await connect(t, base, '/socket.io/', true);
    assert.equal(rejected.value.maximum, 3);
    const message = once(a.socket, 'gameMessage');
    bot.emit('message', { toString: () => 'hello from another player' }, 'chat');
    assert.equal((await message)[0].text, 'hello from another player');
    a.socket.close();
    for (let attempt = 0; (await health()).viewers === 3 && attempt < 20; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    await connect(t, lan, '/third/socket.io/');
    assert.equal((await health()).viewers, 3);
    assert.equal((await fetch(lan + '/capture-lease')).status, 403);
});

test('both viewer paths preserve native main-hand and offhand use for OBS', { timeout: 5000 }, async t => {
    const root = await assets(t), bot = fakeBot(), port = await availablePort();
    bot._client.write = () => assert.fail('watching item use must not send game packets');
    bot.entity.metadata[8] = 3;
    const handle = await startModernViewer(bot, { port, assetsDir: root });
    t.after(() => handle.close());
    const clients = await Promise.all(['/socket.io/', '/third/socket.io/'].map(socketPath =>
        connect(t, handle.url, socketPath)));
    const check = (frames, usingHeldItem, usingOffhand) => {
        for (const frame of frames) {
            assert.equal(frame.usingHeldItem, usingHeldItem);
            assert.equal(frame.usingOffhand, usingOffhand);
        }
    };
    check(clients.map(client => client.value), true, true);
    for (const [metadata, nativeUse, usingHeldItem, usingOffhand] of [
        [1, false, true, false], [0, true, true, false], [0, false, false, false],
    ]) {
        bot.entity.metadata[8] = metadata;
        bot.usingHeldItem = nativeUse;
        const frames = await Promise.all(clients.map(({ socket }) => contentEvent(socket, 'avatarState')));
        check(frames, usingHeldItem, usingOffhand);
    }
});

test('vendored host matches its recorded source hash', async () => {
    const metadata = JSON.parse(await readFile(new URL('../src/agent/vision/modern/source.json', import.meta.url)));
    const host = await readFile(new URL('../src/agent/vision/modern/host.mjs', import.meta.url));
    assert.equal(sha256(host), metadata.bundleSha256);
});

test('both viewer paths retain the actual unavailable YSM reason and accept later model state', async t => {
    const root = await assets(t), bot = fakeBot();
    const uuid = '00000000-0000-3000-8000-000000000001';
    bot._client.uuid = uuid;
    const port = await availablePort();
    const handle = await startModernViewer(bot, { port, assetsDir: root });
    t.after(() => handle.close());
    const clients = await Promise.all(['/socket.io/', '/third/socket.io/'].map(socketPath => connect(t, `http://127.0.0.1:${port}`, socketPath)));
    const row = { schemaVersion: 1, source: 'freesia_worker', type: 'state',
        epoch: '00000000-0000-4000-8000-000000000001', playerUuid: uuid,
        ysmVersion: '2.4.1', protocolVersion: '2.4.0',
        jarSha256: 'ec51cfae84d219a45fac5098a31bfe980bcb7c2d8b413e8fffbd05a411a85680' };
    const emit = value => bot._client.emit('custom_payload', { channel: 'mcagent:appearance', data: Buffer.from(JSON.stringify(value)) });
    const unavailable = clients.map(({socket}) => contentEvent(socket, 'appearanceState'));
    emit({ ...row, available: false, reason: 'YSM_WORKER_STATE_UNAVAILABLE' });
    for (const value of await Promise.all(unavailable)) {
        assert.equal(value.available, false);
        assert.equal(value.renderReason, 'YSM_WORKER_STATE_UNAVAILABLE');
        assert.equal(value.renderAvailable, false);
    }
    const recovery = clients.map(({socket}) => contentEvent(socket, 'appearanceState'));
    emit({ ...row, available: true, entityId: bot.entity.id, mandatory: false,
        modelId: 'alex', texture: 'gsl', animation: 'idle', webReason: 'YSM_SOURCE_NOT_REGISTERED' });
    for (const value of await Promise.all(recovery)) {
        assert.equal(value.available, true);
        assert.equal(value.modelId, 'alex');
        assert.equal(value.renderReason, 'YSM_SOURCE_NOT_REGISTERED');
    }
});

test('login mana and abilities received before viewer startup reach local and LAN viewers', async t => {
    const root = await assets(t), port = await availablePort(), bot = fakeBot();
    const value = { schemaVersion: 1, mana: { current: 26, max: 26 },
        abilities: Array.from({ length: 9 }, (_, i) => ({ id: `mycli:ability_${i}`,
            name: `Ability ${i}`, level: 1, cooldownMs: 8000, cooldownRemainingMs: 0 })) };
    watchViewerSkills(bot);
    t.after(() => bot.emit('end'));
    bot._client.emit('custom_payload', { channel: 'mcagent:state', data: Buffer.from(JSON.stringify(value)) });
    const observedAt = cachedViewerSkills(bot).observedAt;
    Object.assign(settings, { render_bot_view: true, viewer_type: 'modern', viewer_port: port,
        modern_viewer_assets_dir: root, modern_viewer_max_sessions: 4,
        modern_viewer_lan_address: '127.0.0.2', modern_viewer_lan_prefix: 8 });
    await addBrowserViewer(bot);
    t.after(() => bot.viewer.close());
    for (const [base, socketPath] of [[`http://127.0.0.1:${port}`, '/socket.io/'],
        [`http://127.0.0.2:${port}`, '/third/socket.io/']]) {
        const socket = io(base, { path: socketPath, transports: ['websocket'], reconnection: false });
        t.after(() => socket.close());
        const state = await contentEvent(socket, 'skillsState');
        assert.deepEqual(state.mana, { current: 26, max: 26 });
        assert.equal(state.abilities.length, 9);
        assert.equal(state.observedAt, observedAt, 'replaying a login packet cannot make its reading fresh');
        assert.equal(state.stale, true, 'the renderer must label a cached reading as last known');
        assert.ok(state.abilities.every(ability => ability.cooldownRemainingMs === null),
            'a login-only snapshot cannot prove current cooldown readiness');
        socket.close();
    }
    const catalogueSocket = io(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false });
    t.after(() => catalogueSocket.close());
    await contentEvent(catalogueSocket, 'skillsState');
    const enriched = contentEvent(catalogueSocket, 'skillsState');
    bot.emit('message', { toString: () => '探索咏唱：跃步(mycli:ability_0,3魔力/8秒)' }, 'system');
    const catalogueState = await enriched;
    assert.equal(catalogueState.abilities[0].manaCost, 3);
    assert.equal(catalogueState.observedAt, observedAt,
        'receiving a spell catalogue must not freshen a cached mana reading');
    assert.equal(catalogueState.stale, true);
    catalogueSocket.close();
    bot._client.emit('custom_payload', { channel: 'mcagent:state',
        data: Buffer.from(JSON.stringify({ ...value, mana: { current: 13, max: 26 } })) });
    const late = io(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false });
    t.after(() => late.close());
    const live = await contentEvent(late, 'skillsState');
    assert.deepEqual(live.mana, { current: 13, max: 26 });
    assert.notEqual(live.observedAt, observedAt);
    assert.notEqual(live.stale, true);
});

test('login state received during asynchronous asset startup is replayed at listener readiness', async t => {
    const root = await assets(t), port = await availablePort(), bot = fakeBot();
    let packet = null, lookups = 0;
    const started = startModernViewer(bot, { port, assetsDir: root,
        getInitialSkillsPacket: () => { lookups++; return packet; } });
    const observedAt = Date.now() - 5000;
    packet = { channel: 'mcagent:state', observedAt,
        data: Buffer.from('{"schemaVersion":1,"mana":{"current":26,"max":26},"abilities":[{"id":"blink","name":"跃步"}]}') };
    const handle = await started;
    t.after(() => handle.close());
    const socket = io(handle.url, { transports: ['websocket'], reconnection: false });
    t.after(() => socket.close());
    const state = await contentEvent(socket, 'skillsState');
    assert.equal(lookups, 1);
    assert.equal(state.observedAt, observedAt);
    assert.equal(state.mana.current, 26);
    assert.equal(state.abilities[0].id, 'blink');
});

test('invalid early skill schemas do not prevent startup or suppress later real packets', async t => {
    const root = await assets(t), port = await availablePort(), bot = fakeBot();
    const handle = await startModernViewer(bot, { port, assetsDir: root,
        initialSkillsPacket: { channel: 'mcagent:state', observedAt: Date.now(),
            data: Buffer.from('{"schemaVersion":99,"mana":{"current":26,"max":26}}') } });
    t.after(() => handle.close());
    const socket = io(handle.url, { transports: ['websocket'], reconnection: false });
    t.after(() => socket.close());
    const states = []; socket.on('skillsState', value => states.push(value));
    await contentEvent(socket, 'avatarState');
    assert.deepEqual(states, []);
    const updated = contentEvent(socket, 'skillsState');
    bot._client.emit('custom_payload', { channel: 'mcagent:state',
        data: Buffer.from('{"schemaVersion":1,"mana":{"current":12,"max":26},"abilities":[]}') });
    assert.equal((await updated).mana.current, 12);
});

test('local skin is bounded and sent only as the own avatar, without game packets', async t => {
    const root = await assets(t), filename = path.join(root, 'own-skin.png');
    await writeFile(filename, skinPng);
    const skin = await loadViewerSelfSkin(filename);
    assert.match(skin.entity.skinUrl, /^\/head-texture\/[0-9a-f]{64}\.png$/,
        'the shared renderer rejects skin URLs outside its trusted hashed route');
    const port = await availablePort(), bot = fakeBot();
    bot._client.write = () => assert.fail('passive own-bot viewing cannot write game packets');
    const handle = await startModernViewer(bot, { port, assetsDir: root, selfSkinPath: filename });
    t.after(() => handle.close());
    const base = `http://127.0.0.1:${port}`;
    const first = await connect(t, base);
    const third = await connect(t, base, '/third/socket.io/');
    for (const { value } of [first, third]) {
        assert.equal(value.entity.skinUrl, skin.entity.skinUrl);
        assert.equal(value.entity.skinModel, 'slim');
    }
    assert.deepEqual(Buffer.from(await (await fetch(base + skin.entity.skinUrl)).arrayBuffer()), skin.bytes);
    await handle.close();
    assert.equal(bot._client.listenerCount('custom_payload'), 0, 'shared bridge listeners must be released');
});

test('local skin rejects wrong dimensions and oversized files', async t => {
    const root = await assets(t), file = path.join(root, 'bad-skin.png');
    await writeFile(file, Buffer.alloc(128 * 1024 + 1));
    await assert.rejects(loadViewerSelfSkin(file), /128 KiB/);
    const wrong = Buffer.from(skinPng);
    wrong.writeUInt32BE(128, 16); await writeFile(file, wrong);
    await assert.rejects(loadViewerSelfSkin(file), /64×64 PNG/);
});

test('both views receive same-connection maps, native particles and private text, then release observers', { timeout: 12000 }, async t => {
    const root = await assets(t), port = await availablePort(), bot = fakeBot();
    bot._client.write = () => assert.fail('viewer content must not write protocol packets');
    const handle = await startModernViewer(bot, { port, assetsDir: root, maxSessions: 3 });
    t.after(() => handle.close());
    const base = `http://127.0.0.1:${port}`;
    const first = (await connect(t, base)).socket;
    const third = (await connect(t, base, '/third/socket.io/')).socket;
    const mapReplies = [first, third].map(socket => contentEvent(socket, 'mapPixels'));
    bot._client.emit('map', { itemDamage: 7, scale: 0, locked: false, columns: 1, rows: 1,
        x: 0, y: 0, data: Buffer.from([12]) });
    for (const reply of await Promise.all(mapReplies)) {
        assert.equal(reply.mapId, 7); assert.equal(reply.epoch, 0);
        assert.equal(reply.data[0], 12);
        if (reply.snapshot) {
            assert.equal(reply.data.length, 128 * 128);
            assert.equal(reply.coverage[0] & 1, 1, 'coalesced replay must retain actual pixel coverage');
        } else assert.equal(reply.data.length, 1);
    }
    const textReplies = [first, third].map(socket => contentEvent(socket, 'textDisplay',
        value => value.runs?.some(run => run.text === '观察夹具气泡')));
    bot._client.emit('spawn_entity', { entityId: 70, type: bot.registry.entitiesByName.text_display.id,
        x: 1, y: 67, z: 0, yaw: 0, pitch: 0 });
    bot._client.emit('entity_metadata', { entityId: 70, metadata: [{ key: 23,
        value: { type: 'compound', value: { text: { type: 'string', value: '观察夹具气泡' } } } }] });
    for (const reply of await Promise.all(textReplies)) assert.equal(reply.id, 70);
    const deleted = [first, third].map(socket => contentEvent(socket, 'textDisplay', value => value.delete));
    bot._client.emit('entity_destroy', { entityIds: [70] });
    for (const reply of await Promise.all(deleted)) assert.equal(reply.id, 70);
    const legacyParticles = [];
    first.on('presentationEvent', value => { if (value.kind === 'particle') legacyParticles.push(value); });
    const batches = [first, third].map(socket => contentEvent(socket, 'particleBatch'));
    bot._client.emit('world_particles', { longDistance: false, x: 1, y: 65, z: 0,
        offsetX: 0, offsetY: 0, offsetZ: 0, velocityOffset: 0, amount: 1,
        particle: { type: 'flame' } });
    for (const reply of await Promise.all(batches)) {
        assert.equal(reply.events.length, 1); assert.equal(reply.events[0].name, 'flame');
    }
    assert.deepEqual(legacyParticles, [], 'raw particles must have a single rendering path');
    const resets = [first, third].map(socket => contentEvent(socket, 'contentReset'));
    bot.emit('respawn');
    for (const reply of await Promise.all(resets)) assert.equal(reply.epoch, 1);
    const font = await fetch(base + '/fonts/1.20.6/unifont.zip');
    assert.equal(font.status, 200); assert.equal(font.headers.get('content-type'), 'application/zip');
    assert.deepEqual(Buffer.from(await font.arrayBuffer()), Buffer.from([0x50, 0x4b, 3, 4]));
    await handle.close();
    for (const event of ['map', 'world_particles', 'entity_metadata', 'entity_destroy']) {
        assert.equal(bot._client.listenerCount(event), 0, `${event} observer leaked`);
    }
});

test('failed listener startup releases the shared content bridge', async t => {
    const root = await assets(t), port = await availablePort();
    const owner = await startModernViewer(fakeBot(), { port, assetsDir: root });
    t.after(() => owner.close());
    const rejected = fakeBot();
    await assert.rejects(startModernViewer(rejected, { port, assetsDir: root }), { code: 'EADDRINUSE' });
    for (const event of ['map', 'world_particles', 'entity_metadata', 'entity_destroy']) {
        assert.equal(rejected._client.listenerCount(event), 0, `${event} observer leaked after bind failure`);
    }
    assert.equal(rejected.listenerCount('viewer:agent'), 0);
    assert.equal(rejected.listenerCount('path_update'), 0);
});

test('Agent visualization binds both views to the action player and keeps viewer publication closed', async t => {
    const root = await assets(t), bot = fakeBot(), port = await availablePort();
    const uuid = '00000000-0000-4000-8000-000000000042';
    bot.player = { uuid };
    bot.controlState = { forward: true, sprint: true };
    const sent = [];
    const originalWrite = bot._client.write = (...packet) => sent.push(packet);
    const handle = await startModernViewer(bot, { port, assetsDir: root });
    t.after(() => handle.close());
    const clients = [];
    for (const socketPath of ['/socket.io/', '/third/socket.io/']) {
        const socket = io(handle.url, { path: socketPath, transports: ['websocket'],
            reconnection: false, autoConnect: false });
        t.after(() => socket.close());
        const initial = contentEvent(socket, 'agentVisualization');
        socket.connect();
        const state = await initial;
        assert.equal(state.available, true);
        assert.deepEqual(state.subject, { playerUuid: uuid, playerName: bot.username, entityId: 1 });
        assert.deepEqual(state.input.controls, ['forward', 'sprint']);
        clients.push(socket);
    }
    const routes = clients.map(socket => contentEvent(socket, 'agentVisualization', state => state.route?.points?.length === 2));
    bot.emit('path_update', { status: 'success', path: [new Vec3(0, 64, 0), new Vec3(2, 64, 0)] });
    for (const state of await Promise.all(routes)) assert.equal(state.route.status, 'moving');
    const operations = clients.map(socket => contentEvent(socket, 'agentVisualization', state => state.input.operations.length));
    bot._client.write('block_dig', { status: 0, location: new Vec3(2, 64, 0) });
    for (const state of await Promise.all(operations)) {
        assert.equal(state.input.operations[0].kind, 'gather');
        assert.deepEqual(state.input.operations[0].target, { x: 2, y: 64, z: 0 });
    }
    const markers = clients.map(socket => contentEvent(socket, 'agentVisualization', state => state.markers.length));
    let receipt;
    bot.emit('viewer:agent', { markers: [{ id: 'tree', kind: 'point', role: 'gather',
        position: { x: 2, y: 64, z: 0 }, label: 'Tree' }] }, value => { receipt = value; });
    assert.equal(receipt.code, 'AGENT_VISUAL_ACCEPTED');
    for (const state of await Promise.all(markers)) assert.equal(state.markers[0].id, 'tree');
    const denied = await new Promise(resolve => clients[0].emit('agentVisualUpdate',
        { intent: { goal: 'viewer cannot override the Agent' } }, resolve));
    assert.equal(denied.code, 'AGENT_VISUAL_PUBLISH_FORBIDDEN');
    assert.equal(sent.length, 1, 'only the explicitly replayed fixture packet was sent');
    await handle.close();
    assert.equal(bot._client.write, originalWrite, 'closing restores the existing protocol writer');
    assert.equal(bot.listenerCount('viewer:agent'), 0);
    assert.equal(bot.listenerCount('path_update'), 0);
});
