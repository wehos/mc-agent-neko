const DEFAULTS = Object.freeze({
    cameraRadius: 0.035,
    frontClearance: 0.08,
    probeStep: 0.02,
    backoffStep: 0.04,
    maxBackoff: 0.48,
    releaseStep: 0.08,
});

export const DEFAULT_CAMERA_EYE_HEIGHT = 1.6;

export function cameraEyeHeight(reportedEyeHeight, entityHeight) {
    // Mineflayer owns this value and updates it on crouch/uncrouch.
    if (Number.isFinite(reportedEyeHeight) && reportedEyeHeight > 0) return reportedEyeHeight;
    if (!Number.isFinite(entityHeight) || entityHeight <= 0) return DEFAULT_CAMERA_EYE_HEIGHT;
    // Fallback for lightweight bots/tests that only expose entity.height.
    return Math.min(DEFAULT_CAMERA_EYE_HEIGHT, Math.max(0.4, entityHeight - 0.2));
}

export function cameraReleaseStep(previousResolvedAt, now = Date.now()) {
    if (!Number.isFinite(previousResolvedAt) || previousResolvedAt <= 0) return DEFAULTS.releaseStep;
    const elapsedSeconds = Math.max(0, now - previousResolvedAt) / 1000;
    return Math.min(
        DEFAULTS.maxBackoff,
        Math.max(DEFAULTS.backoffStep, elapsedSeconds * 0.24),
    );
}

/**
 * Match prismarine-viewer's camera rotation: the camera looks down local -Z and
 * applies Euler(pitch, yaw, 0, 'ZYX').
 */
export function cameraLookDirection(yaw, pitch) {
    const cosPitch = Math.cos(pitch);
    return {
        x: -Math.sin(yaw) * cosPitch,
        y: Math.sin(pitch),
        z: -Math.cos(yaw) * cosPitch,
    };
}

function offset(point, direction, distance) {
    return {
        x: point.x + direction.x * distance,
        y: point.y + direction.y * distance,
        z: point.z + direction.z * distance,
    };
}

function shapeBoxes(block) {
    if (!block) return [];
    if (Array.isArray(block.shapes) && block.shapes.length > 0) return block.shapes;
    // Some lightweight/simulated block objects only expose boundingBox.
    return block.boundingBox === 'block' ? [[0, 0, 0, 1, 1, 1]] : [];
}

function sphereTouchesBox(point, radius, box) {
    let distanceSquared = 0;
    for (const [value, min, max] of [
        [point.x, box[0], box[3]],
        [point.y, box[1], box[4]],
        [point.z, box[2], box[5]],
    ]) {
        if (value < min) distanceSquared += (min - value) ** 2;
        else if (value > max) distanceSquared += (value - max) ** 2;
    }
    return distanceSquared <= radius ** 2;
}

function sphereTouchesWorld(point, radius, getBlock) {
    const minX = Math.floor(point.x - radius);
    const maxX = Math.floor(point.x + radius);
    const minY = Math.floor(point.y - radius);
    const maxY = Math.floor(point.y + radius);
    const minZ = Math.floor(point.z - radius);
    const maxZ = Math.floor(point.z + radius);

    for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
            for (let z = minZ; z <= maxZ; z++) {
                let block = null;
                try { block = getBlock(x, y, z); } catch { /* handled conservatively below */ }
                // The live chunk around the bot should always be available. If it
                // is not, do not risk rendering through stale worker geometry.
                if (!block) return true;
                for (const shape of shapeBoxes(block)) {
                    const worldBox = [
                        x + shape[0], y + shape[1], z + shape[2],
                        x + shape[3], y + shape[4], z + shape[5],
                    ];
                    if (sphereTouchesBox(point, radius, worldBox)) return true;
                }
            }
        }
    }
    return false;
}

function positionIsClear(position, look, getBlock, options) {
    // Protect the camera origin itself, then sweep a short capsule in front of
    // it. The capsule is wider than the 0.01 near-plane corners at 75 degrees,
    // so a wall cannot disappear merely because the near plane crossed its face.
    for (let distance = 0; distance <= options.frontClearance + 1e-9; distance += options.probeStep) {
        if (sphereTouchesWorld(offset(position, look, distance), options.cameraRadius, getBlock)) {
            return false;
        }
    }
    return true;
}

/**
 * Find the closest collision-free camera position along the view's backward
 * axis. Increasing backoff happens immediately; release is rate-limited so the
 * image does not pop while still returning to the true eye position.
 *
 * Returns null when no short safe backoff exists. Callers should skip that frame
 * instead of rendering from inside a solid block and exposing the surrounding map.
 */
export function resolveCollisionAwareCamera({
    eye,
    yaw,
    pitch,
    getBlock,
    previousBackoff = 0,
    ...overrides
}) {
    if (!eye || typeof getBlock !== 'function') return null;
    const options = { ...DEFAULTS, ...overrides };
    const look = cameraLookDirection(yaw, pitch);
    const backward = { x: -look.x, y: -look.y, z: -look.z };
    const blockCache = new Map();
    const getCachedBlock = (x, y, z) => {
        const key = `${x},${y},${z}`;
        if (!blockCache.has(key)) blockCache.set(key, getBlock(x, y, z));
        return blockCache.get(key);
    };
    const safeAt = (backoff) => {
        const position = offset(eye, backward, backoff);
        return positionIsClear(position, look, getCachedBlock, options) ? position : null;
    };

    let requiredBackoff = null;
    let requiredPosition = null;
    const steps = Math.ceil(options.maxBackoff / options.backoffStep);
    for (let i = 0; i <= steps; i++) {
        const backoff = Math.min(i * options.backoffStep, options.maxBackoff);
        const position = safeAt(backoff);
        if (position) {
            requiredBackoff = backoff;
            requiredPosition = position;
            break;
        }
    }
    if (requiredBackoff === null) return null;

    const prior = Number.isFinite(previousBackoff)
        ? Math.max(0, Math.min(previousBackoff, options.maxBackoff))
        : 0;
    if (prior > requiredBackoff) {
        const easedBackoff = Math.max(requiredBackoff, prior - options.releaseStep);
        const easedPosition = safeAt(easedBackoff);
        if (easedPosition) {
            return { position: easedPosition, backoff: easedBackoff, requiredBackoff };
        }
    }

    return { position: requiredPosition, backoff: requiredBackoff, requiredBackoff };
}
