// camera_proc.js — parent-side supervisor for the ISOLATED screenshot renderer.
//
// Drop-in replacement for the in-process `Camera` render path used by the
// WebSocket screenshot loop. It keeps the live mineflayer `bot` + the
// prismarine-viewer `WorldView` IN this (the agent) process — the WorldView only
// touches plain JS/chunk data, never GL — and forwards the WorldView's event stream
// to a child process (render_worker.mjs) that owns the fragile headless-gl + canvas
// stack.
//
// WHY: headless-gl faults natively (~hourly) and takes down whatever process it runs
// in. By isolating it in a throwaway child, a fault kills only the child; this
// supervisor detects the exit, respawns the worker, and re-seeds it from the
// WorldView's currently-loaded chunks. The agent/bot never goes offline.
//
// See render_worker.mjs for the full IPC protocol and root-cause writeup.

import { WorldView } from 'prismarine-viewer/viewer/lib/worldView.js';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { Vec3 } from 'vec3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, 'render_worker.mjs');

export class CameraProc extends EventEmitter {
    constructor(bot, fp) {
        super();
        this.bot = bot;
        this.fp = fp; // kept for API parity (unused: frames go over WS, not disk)
        this.viewDistance = 6;
        this.width = parseInt(process.env.NEKO_RENDER_WIDTH || '800', 10);
        this.height = parseInt(process.env.NEKO_RENDER_HEIGHT || '512', 10);

        this.worldView = null;
        this.child = null;
        this.childReady = false;
        this.versionSent = false;
        this._pending = new Map(); // render id -> {resolve, reject, timer}
        this._nextId = 1;
        this._destroyed = false;
        this._restartTimer = null;
        this._restartCount = 0;

        // Buffer chunk JSON locally so a respawned worker can be re-seeded without
        // waiting for the bot to walk into fresh chunks. Keyed "x,z".
        this._chunks = new Map();

        // Truncate render.err once per agent process — the worker's stdout/stderr is
        // redirected here (see _spawnWorker) instead of inherited into agent.err.
        this._renderLog = path.join(process.cwd(), 'render.err');
        try { fs.writeFileSync(this._renderLog, ''); } catch (e) { /* ignore */ }

        this._init();
    }

    async _init() {
        // Wait for the bot to be spawned with a valid position (mirrors old Camera).
        if (!this.bot.entity || !this.bot.entity.position ||
            !this._valid(this.bot.entity.position.x)) {
            setTimeout(() => this._init(), 2000);
            return;
        }
        const p = this.bot.entity.position;
        const center = new Vec3(p.x, p.y + (this.bot.entity.height || 1.62), p.z);

        // WorldView lives HERE (no GL) and is the single source of chunk/entity events.
        const worldView = new WorldView(this.bot.world, this.viewDistance, center);
        this.worldView = worldView;

        // Capture the serialized event stream and (a) forward to the worker, (b) cache
        // chunks so we can re-seed a respawned worker.
        worldView.on('loadChunk', ({ x, z, chunk }) => {
            this._chunks.set(`${x},${z}`, { x, z, chunk });
            this._toChild({ t: 'loadChunk', x, z, chunk });
        });
        worldView.on('unloadChunk', ({ x, z }) => {
            this._chunks.delete(`${x},${z}`);
            this._toChild({ t: 'unloadChunk', x, z });
        });
        worldView.on('entity', (e) => this._toChild({ t: 'entity', e }));
        worldView.on('blockUpdate', ({ pos, stateId }) => this._toChild({ t: 'blockUpdate', pos, stateId }));

        worldView.listenToBot(this.bot);
        await worldView.init(center);

        this._spawnWorker();
        this.emit('ready');
    }

    _spawnWorker() {
        if (this._destroyed) return;
        this.childReady = false;
        this.versionSent = false;

        // stdio: redirect the worker's stdout+stderr to a SEPARATE render.err file, NOT
        // inherited into the agent's stderr. prismarine-viewer spams "Unknown entity type:
        // glow_squid ... will not be rendered" every frame; inheriting that into agent.err
        // (a) bloats the log and (b) PARALYZES the watchdog's freeze/wedge detection — both
        // key off agent.err mtime, so the spam keeps it forever "fresh" and a truly hung
        // skill is never caught (saw setBed hang 15min undetected). Crash/native-fault
        // diagnostics are preserved in render.err. 'ipc' for the message channel.
        let outFd = 'ignore';
        try { outFd = fs.openSync(this._renderLog, 'a'); } catch (e) { outFd = 'ignore'; }
        const child = fork(WORKER_PATH, [], {
            stdio: ['ignore', outFd, outFd, 'ipc'],
            env: process.env,
        });
        this.child = child;

        child.on('message', (msg) => this._onChildMessage(msg));

        child.on('exit', (code, signal) => {
            try { if (typeof outFd === 'number') fs.closeSync(outFd); } catch (e) { /* ignore */ }
            const wasNativeFault = code !== 0 && code !== null;
            console.warn(`📷 render worker exited (code=${code}, signal=${signal})` +
                (wasNativeFault ? ' — likely headless-gl native fault; respawning (agent stays up)' : ''));
            this.childReady = false;
            // Fail any in-flight render so the screenshot loop's promise doesn't hang.
            for (const [, p] of this._pending) {
                clearTimeout(p.timer);
                p.reject(new Error('render worker exited'));
            }
            this._pending.clear();
            if (this._destroyed) return;
            // Backoff: 1s, then grows, capped at 10s, to avoid hot-looping if the
            // worker dies during construction (e.g. GL can't init at all).
            this._restartCount++;
            const delay = Math.min(1000 * this._restartCount, 10000);
            this._restartTimer = setTimeout(() => this._spawnWorker(), delay);
        });

        child.on('error', (err) => {
            console.warn('📷 render worker process error:', err && err.message || err);
        });
    }

    _onChildMessage(msg) {
        if (!msg) return;
        if (msg.t === 'ready') {
            this.childReady = true;
            this._restartCount = 0;
            // Seed the freshly-(re)started worker: version first, then every chunk
            // currently loaded, so it can render immediately without waiting for moves.
            if (this.bot.version) {
                this.child.send({ t: 'setVersion', version: this.bot.version });
                this.versionSent = true;
            }
            for (const { x, z, chunk } of this._chunks.values()) {
                this.child.send({ t: 'loadChunk', x, z, chunk });
            }
            return;
        }
        if (msg.t === 'frame') {
            const p = this._pending.get(msg.id);
            if (p) {
                clearTimeout(p.timer);
                this._pending.delete(msg.id);
                p.resolve(msg.jpeg); // base64 jpeg
            }
            return;
        }
        if (msg.t === 'error') {
            if (msg.id != null) {
                const p = this._pending.get(msg.id);
                if (p) {
                    clearTimeout(p.timer);
                    this._pending.delete(msg.id);
                    p.reject(new Error(msg.error || 'render error'));
                }
            }
            return;
        }
    }

    _toChild(payload) {
        if (this.child && this.childReady && this.child.connected) {
            try { this.child.send(payload); } catch { /* worker died mid-send; exit handler will respawn */ }
        }
    }

    /**
     * Capture one frame. Returns a base64 JPEG string, or null on
     * skip/failure (never throws — the caller's loop should keep running).
     */
    async capture() {
        if (this._destroyed) return null;
        if (!this.bot.entity || !this.bot.entity.position) return null; // dead/not spawned
        if (!this.child || !this.childReady) return null; // worker (re)starting

        const pos = this.bot.entity.position;
        const height = this.bot.entity.height || 1.62;
        const yaw = this.bot.entity.yaw || 0;
        const pitch = this.bot.entity.pitch || 0;
        if (!this._valid(pos.x) || !this._valid(pos.y) || !this._valid(pos.z) ||
            !this._valid(yaw) || !this._valid(pitch)) {
            return null;
        }

        const center = pos.offset(0, height, 0);
        // Keep the parent-side WorldView following the bot — this drives the
        // loadChunk/unloadChunk stream that keeps the worker's world current.
        try { await this.worldView.updatePosition(center); } catch { /* non-fatal */ }

        const id = this._nextId++;
        const reqPos = { x: pos.x, y: pos.y, z: pos.z };
        return await new Promise((resolve) => {
            const timer = setTimeout(() => {
                this._pending.delete(id);
                resolve(null); // worker stuck/slow — skip this frame, don't wedge the loop
            }, 5000);
            this._pending.set(id, {
                resolve: (jpeg) => resolve(jpeg),
                reject: () => resolve(null),
                timer,
            });
            try {
                this.child.send({ t: 'render', id, pos: reqPos, yaw, pitch });
            } catch {
                clearTimeout(timer);
                this._pending.delete(id);
                resolve(null);
            }
        });
    }

    _valid(v) { return typeof v === 'number' && !isNaN(v) && isFinite(v); }

    cleanup() {
        this._destroyed = true;
        if (this._restartTimer) clearTimeout(this._restartTimer);
        try { if (this.worldView) this.worldView.removeListenersFromBot(this.bot); } catch { /* ignore */ }
        for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(new Error('cleanup')); }
        this._pending.clear();
        if (this.child) {
            try { this.child.kill(); } catch { /* ignore */ }
            this.child = null;
        }
    }
}
