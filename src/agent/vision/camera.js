import { Viewer } from 'prismarine-viewer/viewer/lib/viewer.js';
import { WorldView } from 'prismarine-viewer/viewer/lib/worldView.js';
import { getBufferFromStream } from 'prismarine-viewer/viewer/lib/simpleUtils.js';

import THREE from 'three';
import { createCanvas } from 'node-canvas-webgl/lib/index.js';
import fs from 'fs/promises';
import { Vec3 } from 'vec3';
import { EventEmitter } from 'events';
import { cameraEyeHeight, cameraReleaseStep, resolveCollisionAwareCamera } from './camera_position.js';

import worker_threads from 'worker_threads';
global.Worker = worker_threads.Worker;


export class Camera extends EventEmitter {
    constructor (bot, fp) {
        super();
        this.bot = bot;
        this.fp = fp;
        this.viewDistance = 6; // Reduced from 12 to save memory
        this.width = 800;
        this.height = 512;
        this.canvas = createCanvas(this.width, this.height);
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas });
        this.viewer = new Viewer(this.renderer);
        this.captureCount = 0;
        this._cameraBackoff = 0;
        this._cameraResolvedAt = Date.now();
        this._init().then(() => {
            this.emit('ready');
        })
    }
  
    async _init () {
        // Wait for bot to be properly spawned before initializing camera
        if (!this.bot.entity || !this.bot.entity.position) {
            console.warn('Bot not properly spawned, delaying camera initialization...');
            // Retry after 2 seconds
            setTimeout(() => this._init(), 2000);
            return;
        }
        
        const botPos = this.bot.entity.position;
        
        // Validate bot position data
        if (!this.isValidNumber(botPos.x) || !this.isValidNumber(botPos.y) || !this.isValidNumber(botPos.z)) {
            console.warn('Bot position data invalid, delaying camera initialization...');
            // Retry after 2 seconds
            setTimeout(() => this._init(), 2000);
            return;
        }
        
        const center = new Vec3(
            botPos.x,
            botPos.y + cameraEyeHeight(this.bot.entity.eyeHeight, this.bot.entity.height),
            botPos.z,
        );
        this.viewer.setVersion(this.bot.version);
        // Load world
        const worldView = new WorldView(this.bot.world, this.viewDistance, center);
        this.viewer.listen(worldView);
        worldView.listenToBot(this.bot);
        await worldView.init(center);
        this.worldView = worldView;
    }
  
    async capture() {
        // Safety check: bot.entity is null when dead
        if (!this.bot.entity || !this.bot.entity.position) {
            console.warn('🚨 Cannot capture: bot.entity is null (bot may be dead or not spawned)');
            return null;
        }
        
        const pos = this.bot.entity.position;
        const yaw = this.bot.entity.yaw || 0;
        const pitch = this.bot.entity.pitch || 0;

        const eyeHeight = cameraEyeHeight(this.bot.entity.eyeHeight, this.bot.entity.height);
        const center = new Vec3(pos.x, pos.y + eyeHeight, pos.z);
        
        // Validate position data to prevent NaN errors
        if (!this.isValidNumber(center.x) || !this.isValidNumber(center.y) || !this.isValidNumber(center.z) ||
            !this.isValidNumber(yaw) || !this.isValidNumber(pitch)) {
            console.error('❌ Invalid bot position data in camera capture:');
            console.error('   Position:', { x: center.x, y: center.y, z: center.z });
            console.error('   Orientation:', { yaw, pitch });
            console.error('   Eye height:', eyeHeight);
            return null;
        }

        await this.worldView.updatePosition(center);
        const resolvedAt = Date.now();
        const camera = resolveCollisionAwareCamera({
            eye: { x: center.x, y: center.y, z: center.z },
            yaw,
            pitch,
            previousBackoff: this._cameraBackoff,
            releaseStep: cameraReleaseStep(this._cameraResolvedAt, resolvedAt),
            getBlock: (x, y, z) => this.bot.blockAt(new Vec3(x, y, z), false),
        });
        if (!camera) return null;
        this._cameraBackoff = camera.backoff;
        this._cameraResolvedAt = resolvedAt;
        this.viewer.camera.position.set(camera.position.x, camera.position.y, camera.position.z);
        this.viewer.camera.rotation.set(pitch, yaw, 0, 'ZYX');
        this.viewer.update();
        this.renderer.render(this.viewer.scene, this.viewer.camera);

        const imageStream = this.canvas.createJPEGStream({
            bufsize: 4096,
            quality: 100,
            progressive: false
        });
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `screenshot_${timestamp}`;

        const buf = await getBufferFromStream(imageStream);
        await this._ensureScreenshotDirectory();
        await fs.writeFile(`${this.fp}/${filename}.jpg`, buf);
        console.log('saved', filename);
        return filename;
    }

    // Helper method to validate numeric values and prevent NaN
    isValidNumber(value) {
        return typeof value === 'number' && !isNaN(value) && isFinite(value);
    }

    async _ensureScreenshotDirectory() {
        let stats;
        try {
            stats = await fs.stat(this.fp);
        } catch (e) {
            if (!stats?.isDirectory()) {
                await fs.mkdir(this.fp);
            }
        }
    }

    /**
     * Clean up resources to prevent memory leaks.
     * Call this periodically or when the camera is no longer needed.
     */
    cleanup() {
        try {
            // Dispose of WorldView listeners
            if (this.worldView) {
                this.worldView.removeListenersFromBot(this.bot);
                this.worldView = null;
            }
            
            // Dispose of THREE.js resources
            if (this.viewer && this.viewer.scene) {
                this.viewer.scene.traverse((object) => {
                    if (object.geometry) {
                        object.geometry.dispose();
                    }
                    if (object.material) {
                        if (Array.isArray(object.material)) {
                            object.material.forEach(m => m.dispose());
                        } else {
                            object.material.dispose();
                        }
                    }
                });
            }
            
            // Dispose of renderer
            if (this.renderer) {
                this.renderer.dispose();
            }
            
            console.log('Camera resources cleaned up');
        } catch (err) {
            console.warn('Error cleaning up camera:', err.message);
        }
    }

    /**
     * Trigger garbage collection if available (requires --expose-gc flag)
     */
    static triggerGC() {
        if (global.gc) {
            global.gc();
            console.log('Manual GC triggered');
        }
    }
}
  
