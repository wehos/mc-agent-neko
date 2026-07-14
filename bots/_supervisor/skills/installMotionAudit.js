import { appendTelemetry } from '../../../src/utils/telemetry.js';

export default async function installMotionAudit(bot) {
    if (!bot || !bot.entity) return { ok: false, reason: 'no-bot' };
    const AUDIT_VERSION = 3;
    if (bot._mineMotionAuditPatched && (bot._mineMotionAuditVersion || 1) >= AUDIT_VERSION) return { ok: true, already: true, version: bot._mineMotionAuditVersion || 1 };

    bot._mineMotionAuditPatched = true;
    bot._mineMotionAuditVersion = AUDIT_VERSION;
    bot._mineMotionSeq = bot._mineMotionSeq || 0;
    const posObj = (p) => p ? ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }) : null;
    const exactPos = () => {
        const p = bot.entity && bot.entity.position;
        return p ? { x: Number(p.x.toFixed(3)), y: Number(p.y.toFixed(3)), z: Number(p.z.toFixed(3)) } : null;
    };
    const blockObj = (b) => b ? ({
        name: b.name,
        position: posObj(b.position),
        boundingBox: b.boundingBox,
    }) : null;
    const blockAt = (p) => {
        try { return blockObj(bot.blockAt(p)); } catch (e) { return null; }
    };
    const envSnap = () => {
        const m = bot.entity && bot.entity.position && bot.entity.position.floored();
        if (!m) return [];
        const cells = [];
        for (const dy of [-1, 0, 1, 2]) {
            for (const dz of [-1, 0, 1]) {
                for (const dx of [-1, 0, 1]) {
                    const b = bot.blockAt(m.offset(dx, dy, dz));
                    cells.push({ d: [dx, dy, dz], n: b ? b.name : 'unknown', bb: b ? b.boundingBox : '?' });
                }
            }
        }
        return cells;
    };
    const write = (event, data = {}) => {
        try {
            appendTelemetry('mine_motion.jsonl', {
                ts: new Date().toISOString(),
                event,
                seq: data.seq,
                pos: exactPos(),
                foot: blockAt(bot.entity.position),
                head: blockAt(bot.entity.position.offset(0, 1, 0)),
                above: blockAt(bot.entity.position.offset(0, 2, 0)),
                held: bot.heldItem ? bot.heldItem.name : 'empty',
                hp: Math.round(bot.health || 0),
                food: bot.food,
                skill: bot._currentSkill || null,
                mob: bot._mobility ? bot._mobility.state : null,
                data,
            });
        } catch (e) {}
    };
    const stony = /stone|deepslate|andesite|diorite|granite|tuff|_ore$|obsidian|cobble/;
    const heldIsPick = () => !!(bot.heldItem && /_pickaxe$/.test(bot.heldItem.name));
    const pickItem = () => bot.inventory.items().find(it => /_pickaxe$/.test(it.name));
    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    const isStonyBlock = (block) => !!(block && stony.test(block.name || ''));
    const itemName = (item) => typeof item === 'string' ? item : (item && item.name);
    const isWaterBlock = (block) => !!(block && /^(flowing_)?water$/.test(block.name || ''));
    const inWaterNow = () => isWaterBlock(bot.blockAt(bot.entity.position))
        || isWaterBlock(bot.blockAt(bot.entity.position.offset(0, 1, 0)));
    const activeStonyDig = () => {
        const d = bot._mineMotionActiveDig;
        if (!d || !d.stony) return null;
        if (Date.now() - d.startedAt > 15000) { bot._mineMotionActiveDig = null; return null; }
        return d;
    };
    const activeBodyMove = () => {
        if (!bot._bodyMoveLockUntil || Date.now() >= bot._bodyMoveLockUntil) return null;
        return { owner: bot._bodyMoveLockOwner || 'unknown', until: bot._bodyMoveLockUntil };
    };
    const waitForBodyMove = async (event, seq, data = {}) => {
        let m = activeBodyMove();
        if (!m) return true;
        write(event + '.deferred', { seq, activeMove: m, ...data });
        const until = Date.now() + 3200;
        while ((m = activeBodyMove()) && Date.now() < until) await delay(50);
        if (!activeBodyMove()) return true;
        write(event + '.blocked', { seq, activeMove: activeBodyMove(), ...data });
        return false;
    };
    const waitForStonyDig = async (event, seq, data = {}) => {
        let d = activeStonyDig();
        if (!d) return true;
        write(event + '.deferred', { seq, activeDig: d, ...data });
        const until = Date.now() + 9000;
        while ((d = activeStonyDig()) && Date.now() < until) await delay(50);
        if (!activeStonyDig()) return true;
        write(event + '.blocked', { seq, activeDig: activeStonyDig(), ...data });
        return false;
    };
    const ensurePickForDig = async (block, seq) => {
        if (!block || !stony.test(block.name || '')) return true;
        if (!pickItem()) return Date.now() < (bot._plannedNoPickStoneUntil || 0);
        if (heldIsPick()) return true;
        try { await bot.equip(pickItem(), 'hand'); } catch (e) {}
        await new Promise(r => setTimeout(r, 80));
        if (heldIsPick()) return true;
        try { await bot.tool.equipForBlock(block); } catch (e) {}
        await new Promise(r => setTimeout(r, 80));
        if (heldIsPick()) return true;
        write('dig.blocked', { seq, target: blockObj(block), reason: 'stony-without-held-pick' });
        return false;
    };

    const originalDig = bot.dig.bind(bot);
    bot.dig = async (block, ...args) => {
        const seq = ++bot._mineMotionSeq;
        const startedAt = Date.now();
        write('dig.begin', { seq, target: blockObj(block), args, env: envSnap() });
        if (!(await waitForBodyMove('dig', seq, { target: blockObj(block) }))) {
            const err = new Error('dig blocked during body move');
            write('dig.end', { seq, ok: false, ms: Date.now() - startedAt, target: blockObj(block), error: err.message, env: envSnap() });
            throw err;
        }
        if (!(await ensurePickForDig(block, seq))) {
            const err = new Error(`stone dig blocked without held pick: ${block ? block.name : 'unknown'}`);
            write('dig.end', { seq, ok: false, ms: Date.now() - startedAt, target: blockObj(block), error: err.message, env: envSnap() });
            throw err;
        }
        bot._mineMotionActiveDig = { seq, stony: isStonyBlock(block), target: blockObj(block), startedAt };
        try {
            const result = await originalDig(block, ...args);
            write('dig.end', { seq, ok: true, ms: Date.now() - startedAt, target: blockObj(block), env: envSnap() });
            return result;
        } catch (e) {
            write('dig.end', { seq, ok: false, ms: Date.now() - startedAt, target: blockObj(block), error: e.message, env: envSnap() });
            throw e;
        } finally {
            if (bot._mineMotionActiveDig && bot._mineMotionActiveDig.seq === seq) bot._mineMotionActiveDig = null;
        }
    };

    const originalEquip = bot.equip.bind(bot);
    bot.equip = async (item, destination, ...args) => {
        const name = itemName(item);
        const hand = !destination || destination === 'hand';
        if (hand && name && !/_pickaxe$/.test(name) && activeStonyDig()) {
            const seq = ++bot._mineMotionSeq;
            if (!(await waitForStonyDig('equip', seq, { item: name, destination }))) {
                throw new Error(`equip ${name} blocked during stony dig`);
            }
        }
        return await originalEquip(item, destination, ...args);
    };

    const originalPlaceBlock = bot.placeBlock.bind(bot);
    bot.placeBlock = async (referenceBlock, faceVector, ...args) => {
        const seq = ++bot._mineMotionSeq;
        const startedAt = Date.now();
        const placeAt = referenceBlock && referenceBlock.position && faceVector
            ? referenceBlock.position.offset(faceVector.x, faceVector.y, faceVector.z)
            : null;
        write('place.begin', {
            seq,
            reference: blockObj(referenceBlock),
            face: faceVector ? { x: faceVector.x, y: faceVector.y, z: faceVector.z } : null,
            placeAt: posObj(placeAt),
            args,
            env: envSnap(),
        });
        if (inWaterNow()) {
            const err = new Error('place blocked while swimming');
            write('place.blocked', {
                seq,
                reason: 'in-water',
                placeAt: posObj(placeAt),
                placeBlock: blockObj(placeAt ? bot.blockAt(placeAt) : null),
                env: envSnap(),
            });
            write('place.end', { seq, ok: false, ms: Date.now() - startedAt, placeAt: posObj(placeAt), error: err.message, env: envSnap() });
            throw err;
        }
        if (!(await waitForBodyMove('place', seq, { placeAt: posObj(placeAt) }))) {
            const err = new Error('place blocked during body move');
            write('place.end', { seq, ok: false, ms: Date.now() - startedAt, placeAt: posObj(placeAt), error: err.message, env: envSnap() });
            throw err;
        }
        if (!(await waitForStonyDig('place', seq, { placeAt: posObj(placeAt) }))) {
            const err = new Error('place blocked during stony dig');
            write('place.end', { seq, ok: false, ms: Date.now() - startedAt, placeAt: posObj(placeAt), error: err.message, env: envSnap() });
            throw err;
        }
        try {
            const result = await originalPlaceBlock(referenceBlock, faceVector, ...args);
            write('place.end', { seq, ok: true, ms: Date.now() - startedAt, placeAt: posObj(placeAt), env: envSnap() });
            return result;
        } catch (e) {
            write('place.end', { seq, ok: false, ms: Date.now() - startedAt, placeAt: posObj(placeAt), error: e.message, env: envSnap() });
            throw e;
        }
    };

    write('audit.installed', { source: 'installMotionAudit' });
    return { ok: true };
}
