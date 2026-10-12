import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { watchViewerSkills, cachedViewerSkills } from '../src/agent/vision/viewer_skills_cache.js';

const fakeBot = () => Object.assign(new EventEmitter(), { _client: new EventEmitter() });

test('early viewer state is copied, bounded and isolated to its connection', () => {
    const bot = fakeBot(), other = fakeBot();
    bot._client.write = () => assert.fail('caching state cannot send packets');
    watchViewerSkills(bot);
    watchViewerSkills(bot);
    assert.equal(bot._client.listenerCount('custom_payload'), 1);
    const data = Buffer.from('{"schemaVersion":1}');
    bot._client.emit('custom_payload', { channel: 'mcagent:state', data });
    const saved = cachedViewerSkills(bot);
    assert.equal(saved.data.toString(), '{"schemaVersion":1}');
    assert.ok(saved.observedAt <= Date.now());
    data.fill(0);
    saved.data.fill(0);
    assert.equal(cachedViewerSkills(bot).data.toString(), '{"schemaVersion":1}');
    assert.equal(cachedViewerSkills(other), null);
    for (const packet of [null, { channel: 'other', data: Buffer.from('secret') },
        { channel: 'mcagent:state', data: 'not bytes' },
        { channel: 'mcagent:state', data: Buffer.alloc(0) },
        { channel: 'mcagent:state', data: Buffer.alloc(65537) }]) {
        bot._client.emit('custom_payload', packet);
        assert.equal(cachedViewerSkills(bot).data.toString(), '{"schemaVersion":1}');
    }
    bot._client.emit('custom_payload', { channel: 'mcagent:state', data: Uint8Array.of(123, 125) });
    assert.equal(cachedViewerSkills(bot).data.toString(), '{}');
    bot.emit('end');
    assert.equal(cachedViewerSkills(bot), null);
    assert.equal(bot._client.listenerCount('custom_payload'), 0);
    assert.equal(bot.listenerCount('end'), 0);
});

test('ended or replaced protocol clients cannot replay a previous connection', () => {
    const bot = fakeBot();
    watchViewerSkills(bot);
    bot._client.emit('custom_payload', { channel: 'mcagent:state', data: Buffer.from('{}') });
    const previous = bot._client;
    previous.ended = true;
    assert.equal(cachedViewerSkills(bot), null);
    previous.ended = false;
    bot._client = new EventEmitter();
    assert.equal(cachedViewerSkills(bot), null);
    bot.emit('end');
    assert.equal(previous.listenerCount('custom_payload'), 0);
    watchViewerSkills(bot);
    bot._client.emit('custom_payload', { channel: 'mcagent:state', data: Buffer.from('{"new":true}') });
    assert.equal(cachedViewerSkills(bot).data.toString(), '{"new":true}');
    bot.emit('end');
});
