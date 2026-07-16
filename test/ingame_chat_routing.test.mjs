import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import rootSettings from '../settings.js';

const PLAYER = 'Wehos_nya';
const CHAT_JSON = { translate: 'chat.type.text' };

function loadAgentRoute() {
    const agentUrl = new URL('../src/agent/agent.js', import.meta.url);
    const source = readFileSync(agentUrl, 'utf8')
        .replace(/^import .*;\r?\n/gm, '')
        .replace('export class Agent', 'class Agent');
    const forwarded = [];
    const context = vm.createContext({
        console,
        setTimeout,
        clearTimeout,
        process: { env: { MC_INGAME_CHAT_FLUSH_MS: '1' } },
        settings: { chat_command_prefix: '@neko', chat_whitelist: [] },
        wsServer: { forwardIngameChat: batch => forwarded.push(batch) },
    });
    new vm.Script(`${source}\nglobalThis.TestAgent = Agent;`, {
        filename: agentUrl.pathname,
    }).runInContext(context);
    return { Agent: context.TestAgent, forwarded };
}

function makeAgent() {
    const { Agent, forwarded } = loadAgentRoute();
    const submissions = [];
    const agent = Object.create(Agent.prototype);
    agent.name = 'Neko';
    agent.bot = {
        username: 'Neko',
        players: { [PLAYER]: { username: PLAYER } },
    };
    agent._missionEnabled = true;
    agent.adminMission = { submit: mission => submissions.push(mission) };
    agent.respondFunc = () => assert.fail('adminMission should own prefixed commands');
    return { agent, submissions, forwarded };
}

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

test('the configured in-game admin prefix is @neko', () => {
    assert.equal(rootSettings.chat_command_prefix, '@neko');
    const spec = JSON.parse(readFileSync(new URL('../src/mindcraft/public/settings_spec.json', import.meta.url), 'utf8'));
    assert.equal(spec.chat_command_prefix.default, '@neko');
});

test('@neko chat is submitted as a highest-priority admin mission', () => {
    const { agent, submissions } = makeAgent();

    agent._routeIngameChat(PLAYER, '  @neko build a shelter', CHAT_JSON, []);

    assert.deepEqual(plain(submissions), [{
        text: 'build a shelter',
        taskId: null,
        origin: 'chat',
    }]);
    assert.equal(agent._chatFwdBuf, undefined);
});

test('legacy /neko text is treated as a slash command and ignored', () => {
    const { agent, submissions } = makeAgent();

    agent._routeIngameChat(PLAYER, '/neko build a shelter', CHAT_JSON, []);

    assert.deepEqual(submissions, []);
    assert.equal(agent._chatFwdBuf, undefined);
});

test('ordinary player chat is batched and forwarded as an ingame_chat websocket frame', async () => {
    const { agent, submissions, forwarded } = makeAgent();

    agent._routeIngameChat(PLAYER, 'hello Neko', CHAT_JSON, []);
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.deepEqual(submissions, []);
    assert.deepEqual(plain(forwarded), [[{ player: PLAYER, text: 'hello Neko' }]]);

    const wsSource = readFileSync(new URL('../src/websocket/ws_server.js', import.meta.url), 'utf8');
    assert.match(wsSource, /type:\s*['"]ingame_chat['"]/);
    assert.match(wsSource, /messages:\s*batch/);
});
