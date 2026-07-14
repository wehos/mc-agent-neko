import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/agent/agent.js', import.meta.url), 'utf8');

test('reconnect success is emitted only from the confirmed spawn path', () => {
  const marker = 'Bot reconnected successfully';
  assert.equal(source.split(marker).length - 1, 1);
  const spawnStart = source.indexOf("bot.once('spawn'");
  const spawnEnd = source.indexOf('// Bot event handlers', spawnStart);
  const success = source.indexOf(marker);
  assert.ok(success > spawnStart && success < spawnEnd);
});

test('stale bot events are generation-guarded and disposed', () => {
  assert.match(source, /handleBotDisconnection\(reason, sourceBot = this\.bot\)/);
  assert.match(source, /sourceBot !== this\.bot \|\| sourceBot\?\._disposed/);
  assert.match(source, /_disposeDeadBot\(deadBot\)/);
  assert.match(source, /deadBot\._client\?\.socket\?\.destroy/);
  assert.match(source, /deadBot\.removeAllListeners/);
});
