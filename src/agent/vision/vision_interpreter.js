import { Vec3 } from 'vec3';
import fs from 'fs';

// NOTE (local deploy): `Camera` (./camera.js) is LAZY-loaded via dynamic import() in
// _ensureCamera() below, NOT statically imported. camera.js pulls in
// node-canvas-webgl + prismarine-viewer + three + headless-gl, and STATICALLY importing
// that chain crashes Node 22's ESM/CJS loader (ERR_INTERNAL_ASSERTION) at startup even
// though headless-gl is now built. Deferring the import to first use (when the bot is
// in-world and a screenshot is actually requested) avoids the loader bug entirely.
// ★The lazy import only fixes the STARTUP loader crash — the capture-time native crash
// risk of the in-process renderer remains (see the ★RISK note in _ensureCamera below);
// set NEKO_DISABLE_INPROC_VISION=1 to hard-disable in-process vision.

export class VisionInterpreter {
    constructor(agent, allow_vision) {
        this.agent = agent;
        // Vision RE-ENABLED (headless-gl built). The Camera is created lazily on first
        // use via _ensureCamera() so the renderer chain isn't imported at startup.
        this.allow_vision = allow_vision;
        this.fp = './bots/'+agent.name+'/screenshots/';
        this.camera = null;
        this._cameraInit = null;
    }

    // Lazily create the prismarine-viewer Camera and wait until its world view is ready.
    // Uses dynamic import() to keep the headless-gl/prismarine-viewer chain out of the
    // static module graph (see note above).
    async _ensureCamera() {
        // Kill-switch: the IN-PROCESS renderer below can native-crash the agent (see the
        // ★RISK note at the import site). NEKO_DISABLE_INPROC_VISION=1 disables on-demand
        // vision entirely — throw a clear error (the action layer reports command errors)
        // instead of ever constructing Camera in this process.
        if (process.env.NEKO_DISABLE_INPROC_VISION === '1') {
            throw new Error('In-process vision is disabled (NEKO_DISABLE_INPROC_VISION=1); use the ws_server child-process camera feed instead.');
        }
        if (this.camera) return this.camera;
        if (this._cameraInit) return this._cameraInit;
        const init = (async () => {
            // ★RISK (why the old code hard-disabled vision): camera.js runs
            // node-canvas-webgl + THREE.WebGLRenderer over headless-gl IN THIS PROCESS.
            // That renderer has a documented intermittent NATIVE crash (Windows exit -1 /
            // 4294967295, uncatchable by JS) — one bad capture can kill the whole agent
            // (exit → auto-restart → bot offline → AFK death). ws_server isolates the SAME
            // renderer in a child process for exactly this reason (see CameraProc in
            // src/websocket/ws_server.js) — that is the isolation precedent if this ever
            // needs hardening; until then NEKO_DISABLE_INPROC_VISION=1 is the off switch.
            const { Camera } = await import('./camera.js');
            const cam = new Camera(this.agent.bot, this.fp);
            if (!cam.worldView) {
                // 'ready' can legitimately NEVER fire: camera.js emits it from
                // _init().then() with no .catch, so a rejected worldView init swallows the
                // event. Bound the wait — reject (clearing the cache below) so callers get
                // a real error instead of an eternally-pending vision pipeline.
                await new Promise((resolve, reject) => {
                    const tm = setTimeout(() => reject(new Error('Camera init timed out: no ready event within 20s')), 20000);
                    cam.once('ready', () => { clearTimeout(tm); resolve(); });
                });
            }
            this.camera = cam;
            return cam;
        })();
        // Cache the in-flight promise so concurrent callers share one init, but CLEAR the
        // cache on rejection — a permanently-cached rejected/hung promise would poison every
        // later vision call for the process lifetime, when a simple retry often succeeds.
        this._cameraInit = init.catch((err) => {
            this._cameraInit = null;
            throw err;
        });
        return this._cameraInit;
    }

    async lookAtPlayer(player_name, direction) {
        if (!this.allow_vision || !this.agent.prompter.vision_model.sendVisionRequest) {
            return "Vision is disabled. Use other methods to describe the environment.";
        }
        let result = "";
        const bot = this.agent.bot;
        const player = bot.players[player_name]?.entity;
        if (!player) {
            return `Could not find player ${player_name}`;
        }

        await this._ensureCamera();
        let filename;
        if (direction === 'with') {
            await bot.look(player.yaw, player.pitch);
            result = `Looking in the same direction as ${player_name}\n`;
            filename = await this.camera.capture();
        } else {
            await bot.lookAt(new Vec3(player.position.x, player.position.y + player.height, player.position.z));
            result = `Looking at player ${player_name}\n`;
            filename = await this.camera.capture();

        }

        return result + `Image analysis: "${await this.analyzeImage(filename)}"`;
    }

    async lookAtPosition(x, y, z) {
        if (!this.allow_vision || !this.agent.prompter.vision_model.sendVisionRequest) {
            return "Vision is disabled. Use other methods to describe the environment.";
        }
        let result = "";
        const bot = this.agent.bot;
        await bot.lookAt(new Vec3(x, y + 2, z));
        result = `Looking at coordinate ${x}, ${y}, ${z}\n`;

        await this._ensureCamera();
        let filename = await this.camera.capture();

        return result + `Image analysis: "${await this.analyzeImage(filename)}"`;
    }

    getCenterBlockInfo() {
        const bot = this.agent.bot;
        const maxDistance = 128; // Maximum distance to check for blocks
        const targetBlock = bot.blockAtCursor(maxDistance);
        
        if (targetBlock) {
            return `Block at center view: ${targetBlock.name} at (${targetBlock.position.x}, ${targetBlock.position.y}, ${targetBlock.position.z})`;
        } else {
            return "No block in center view";
        }
    }

    async analyzeImage(filename) {
        try {
            const imageBuffer = await fs.promises.readFile(`${this.fp}/${filename}.jpg`);
            const messages = this.agent.history.getHistory();

            const blockInfo = this.getCenterBlockInfo();
            const result = await this.agent.prompter.promptVision(messages, imageBuffer);
            return result + `\n${blockInfo}`;

        } catch (error) {
            console.warn('Error reading image:', error);
            return `Error reading image: ${error.message}`;
        }
    }
} 