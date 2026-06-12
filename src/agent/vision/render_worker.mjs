// render_worker.mjs — ISOLATED prismarine-viewer renderer (child process).
//
// WHY THIS EXISTS
// ---------------
// The screenshot renderer is built on prismarine-viewer → node-canvas-webgl →
// headless-gl (`gl`) + node-canvas. headless-gl on Windows faults intermittently
// under sustained GL command submission: roughly once every ~30–60 min of 0.5–2 Hz
// rendering the native layer throws an ACCESS VIOLATION. On Windows that surfaces as
// the node process exiting with code 4294967295 (== -1) and NO JS stack — it is a
// NATIVE crash, so NO JavaScript try/catch can intercept it. (Confirmed from the
// crash-*-agent.log archive: 19 crashes with "exited with code 4294967295", not
// correlated with JS heap size → not an OOM, an intrinsic native fault.)
//
// As long as the renderer runs IN-PROCESS with the mineflayer agent, that native
// fault kills the whole bot. The only robust fix is to run the GL/canvas stack in a
// THROWAWAY child process: when it faults, only this worker dies; the parent agent
// stays online and respawns the worker.
//
// PROTOCOL (parent ⇄ this worker, via process.send / process.on('message'))
//   parent → worker:
//     { t:'setVersion', version }                 once, before chunks
//     { t:'loadChunk',  x, z, chunk }             chunk JSON from WorldView
//     { t:'unloadChunk', x, z }
//     { t:'entity', e }                           entity upsert/delete
//     { t:'blockUpdate', pos, stateId }
//     { t:'render', id, pos:{x,y,z}, yaw, pitch } request a frame
//   worker → parent:
//     { t:'ready' }                               renderer constructed OK
//     { t:'frame', id, jpeg }                     jpeg as base64 string (+ id echo)
//     { t:'error', id?, error }                   render/encode failure (JS-level)
//
// A native fault needs no message — the process just exits and the parent notices.

import { Viewer } from 'prismarine-viewer/viewer/lib/viewer.js';
import { getBufferFromStream } from 'prismarine-viewer/viewer/lib/simpleUtils.js';
import THREE from 'three';
import { createCanvas } from 'node-canvas-webgl/lib/index.js';
import { Vec3 } from 'vec3';
import { EventEmitter } from 'events';
import worker_threads from 'worker_threads';

// prismarine-viewer's chunk mesher expects a global Worker (browser API shim),
// and its entity code (Entity.js: `/* global THREE */`) expects a global THREE.
// Exposing THREE here lets entity meshes (mobs/players) actually render instead of
// throwing "THREE is not defined" per entity — strictly better than the old
// in-process path, which never set it and silently dropped all entity meshes.
global.Worker = worker_threads.Worker;
global.THREE = THREE;

const WIDTH = parseInt(process.env.NEKO_RENDER_WIDTH || '800', 10);
const HEIGHT = parseInt(process.env.NEKO_RENDER_HEIGHT || '512', 10);
const JPEG_QUALITY = parseInt(process.env.NEKO_RENDER_JPEG_QUALITY || '50', 10);

const canvas = createCanvas(WIDTH, HEIGHT);
const renderer = new THREE.WebGLRenderer({ canvas });
const viewer = new Viewer(renderer);

// Local emitter mirrors the parent-side WorldView's event stream. The Viewer wires
// itself onto these exactly as it would for the in-process / web-client path.
const emitter = new EventEmitter();
viewer.listen(emitter);

let rendering = false;

async function renderFrame(msg) {
    const { id, pos, yaw, pitch } = msg;
    // Set the camera directly (no TWEEN) so a one-shot capture is not chasing a
    // 50ms interpolation that never gets a follow-up frame.
    viewer.camera.position.set(pos.x, pos.y + (viewer.playerHeight || 1.6), pos.z);
    viewer.camera.rotation.set(pitch, yaw, 0, 'ZYX');
    viewer.update();
    renderer.render(viewer.scene, viewer.camera);

    const stream = canvas.createJPEGStream({ bufsize: 4096, quality: JPEG_QUALITY, progressive: false });
    const buf = await getBufferFromStream(stream);
    process.send({ t: 'frame', id, jpeg: buf.toString('base64') });
}

process.on('message', async (msg) => {
    try {
        switch (msg && msg.t) {
            case 'setVersion':
                viewer.setVersion(msg.version);
                break;
            case 'loadChunk':
                viewer.addColumn(msg.x, msg.z, msg.chunk);
                break;
            case 'unloadChunk':
                viewer.removeColumn(msg.x, msg.z);
                break;
            case 'entity':
                viewer.updateEntity(msg.e);
                break;
            case 'blockUpdate':
                viewer.setBlockStateId(new Vec3(msg.pos.x, msg.pos.y, msg.pos.z), msg.stateId);
                break;
            case 'render':
                if (rendering) {
                    // Drop overlapping requests; parent also gates, this is belt-and-braces.
                    process.send({ t: 'error', id: msg.id, error: 'busy' });
                    return;
                }
                rendering = true;
                try {
                    await renderFrame(msg);
                } finally {
                    rendering = false;
                }
                break;
            default:
                break;
        }
    } catch (err) {
        // JS-level failure — report it but keep the worker alive. (Native faults do
        // not reach here; they take the process down, which the parent handles.)
        try { process.send({ t: 'error', id: msg && msg.id, error: String(err && err.message || err) }); } catch { /* parent gone */ }
    }
});

process.send({ t: 'ready' });
