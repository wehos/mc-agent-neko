import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/** Optional local skin for the connected bot only; never overrides other players. */
export async function loadViewerSelfSkin(filename, model = 'slim') {
    if (!filename) return null;
    if (!['slim', 'classic'].includes(model)) throw new Error('Invalid viewer self skin model');
    if ((await stat(filename)).size > 128 * 1024) throw new Error('Viewer self skin exceeds 128 KiB');
    const bytes = await readFile(filename);
    if (bytes.length < 33 || bytes.length > 128 * 1024 ||
        !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(16) !== 64 ||
        bytes.readUInt32BE(20) !== 64) throw new Error('Viewer self skin must be a 64×64 PNG');
    const hash = createHash('sha256').update(bytes).digest('hex');
    // Shared renderer deliberately accepts only same-origin, hashed head-texture URLs.
    return { bytes, entity: { skinUrl: `/head-texture/${hash}.png`, skinModel: model } };
}
