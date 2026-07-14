import assert from 'node:assert/strict';
import test from 'node:test';
import Vec3 from 'vec3';

import { CameraProc } from '../src/agent/vision/camera_proc.js';
import { cameraEyeHeight, cameraLookDirection, cameraReleaseStep, resolveCollisionAwareCamera } from '../src/agent/vision/camera_position.js';

const key = (x, y, z) => `${x},${y},${z}`;
const fullBlock = { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };

function makeWorld(blocks = []) {
    const world = new Map(blocks.map(([x, y, z]) => [key(x, y, z), fullBlock]));
    return (x, y, z) => world.get(key(x, y, z)) || { name: 'air', boundingBox: 'empty', shapes: [] };
}

function makeCameraProc({ position, yaw, pitch, blocks }) {
    const camera = Object.create(CameraProc.prototype);
    const getBlock = makeWorld(blocks);
    let renderMessage = null;
    camera.bot = {
        entity: { position, yaw, pitch, eyeHeight: 1.6, height: 1.8 },
        blockAt: (pos) => getBlock(pos.x, pos.y, pos.z),
    };
    camera.worldView = { updatePosition: async () => {} };
    camera.childReady = true;
    camera._destroyed = false;
    camera._pending = new Map();
    camera._nextId = 1;
    camera._cameraBackoff = 0;
    camera.child = {
        send(message) {
            renderMessage = message;
            camera._onChildMessage({ t: 'frame', id: message.id, jpeg: 'frame' });
        },
    };
    return { camera, renderMessage: () => renderMessage };
}

test('open space keeps the true eye position', () => {
    const eye = { x: 0.5, y: 1.6, z: 0.5 };
    const camera = resolveCollisionAwareCamera({ eye, yaw: 0, pitch: 0, getBlock: makeWorld() });
    assert.deepEqual(camera.position, eye);
    assert.equal(camera.backoff, 0);
});

test('compact entity poses lower the nominal eye before collision checks', () => {
    assert.equal(cameraEyeHeight(1.62, 1.8), 1.62);
    assert.equal(cameraEyeHeight(1.27, 1.5), 1.27);
    assert.equal(cameraEyeHeight(undefined, 0.6), 0.4);
});

test('release speed follows elapsed time instead of screenshot frame count', () => {
    assert.equal(cameraReleaseStep(undefined, 1000), 0.08);
    assert.ok(Math.abs(cameraReleaseStep(1000, 1200) - 0.048) < 1e-12);
    assert.equal(cameraReleaseStep(1000, 11000), 0.48);
});

test('a near wall pulls the camera backward along the current view', () => {
    const eye = { x: 0.94, y: 1.6, z: 0.5 };
    const camera = resolveCollisionAwareCamera({
        eye,
        yaw: -Math.PI / 2, // look east, toward x=1 wall
        pitch: 0,
        getBlock: makeWorld([[1, 1, 0]]),
    });
    assert.ok(camera.backoff > 0);
    assert.ok(camera.position.x < eye.x);
    assert.equal(camera.position.y, eye.y);
});

test('mining upward backs away from a ceiling instead of entering it', () => {
    const eye = { x: 0.5, y: 1.94, z: 0.5 };
    const camera = resolveCollisionAwareCamera({
        eye,
        yaw: 0,
        pitch: Math.PI / 2,
        getBlock: makeWorld([[0, 2, 0]]),
    });
    assert.ok(camera.backoff > 0);
    assert.ok(camera.position.y < eye.y);
});

test('camera releases toward the eye after the obstacle disappears', () => {
    const eye = { x: 0.5, y: 1.6, z: 0.5 };
    const camera = resolveCollisionAwareCamera({
        eye,
        yaw: 0,
        pitch: 0,
        previousBackoff: 0.24,
        getBlock: makeWorld(),
    });
    assert.ok(camera.backoff > 0);
    assert.ok(camera.backoff < 0.24);
    assert.equal(camera.requiredBackoff, 0);
});

test('stale backoff is abandoned if turning would put it into a rear wall', () => {
    const eye = { x: 0.94, y: 1.6, z: 0.5 };
    const camera = resolveCollisionAwareCamera({
        eye,
        yaw: Math.PI / 2, // look west; old backoff would move east into the wall
        pitch: 0,
        previousBackoff: 0.24,
        getBlock: makeWorld([[1, 1, 0]]),
    });
    assert.equal(camera.backoff, 0);
    assert.deepEqual(camera.position, eye);
});

test('fully blocked spring arm skips the frame instead of exposing an x-ray view', () => {
    const eye = { x: 0.5, y: 1.6, z: 0.5 };
    const blocks = [];
    for (let z = 0; z <= 1; z++) blocks.push([0, 1, z]);
    const camera = resolveCollisionAwareCamera({ eye, yaw: 0, pitch: 0, getBlock: makeWorld(blocks) });
    assert.equal(camera, null);
});

test('unavailable collision data is treated as blocked', () => {
    const eye = { x: 0.5, y: 1.6, z: 0.5 };
    const camera = resolveCollisionAwareCamera({ eye, yaw: 0, pitch: 0, getBlock: () => null });
    assert.equal(camera, null);
});

test('CameraProc sends the worker an already adjusted absolute camera position', async () => {
    const fixture = makeCameraProc({
        position: new Vec3(0.94, 0, 0.5),
        yaw: -Math.PI / 2,
        pitch: 0,
        blocks: [[1, 1, 0]],
    });
    assert.equal(await fixture.camera.capture(), 'frame');
    const message = fixture.renderMessage();
    assert.equal(message.t, 'render');
    assert.ok(message.cameraPos.x < fixture.camera.bot.entity.position.x);
    assert.equal('pos' in message, false);
});

test('CameraProc does not ask the worker to render when every backoff is blocked', async () => {
    const fixture = makeCameraProc({
        position: new Vec3(0.5, 0, 0.5),
        yaw: 0,
        pitch: 0,
        blocks: [[0, 1, 0], [0, 1, 1]],
    });
    assert.equal(await fixture.camera.capture(), null);
    assert.equal(fixture.renderMessage(), null);
});

test('look direction matches prismarine-viewer cardinal rotations', () => {
    assert.deepEqual(cameraLookDirection(0, 0), { x: -0, y: 0, z: -1 });
    const east = cameraLookDirection(-Math.PI / 2, 0);
    assert.ok(Math.abs(east.x - 1) < 1e-12);
    assert.ok(Math.abs(east.z) < 1e-12);
});
