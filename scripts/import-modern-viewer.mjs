import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';

const sourceRoot = path.resolve(process.argv[2] || '');
const rendererRoot = path.resolve(process.argv[3] || '');
if (!process.argv[2] || !process.argv[3]) {
    throw new Error('Usage: node scripts/import-modern-viewer.mjs <Cortico checkout> <mc-visual-console checkout>');
}
const rendererDirectory = 'packages/modern-viewer/renderer-src';
const rendererHost = path.join(rendererRoot, rendererDirectory, 'host');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
git(sourceRoot, 'diff', '--quiet', 'HEAD', '--', 'src/worlds/minecraft');
git(rendererRoot, 'diff', '--quiet', 'HEAD', '--', rendererDirectory);
const rendererSource = {
    repository: 'https://github.com/jcs130/mc-visual-console',
    revision: git(rendererRoot, 'rev-parse', 'HEAD'), directory: rendererDirectory,
    gitTree: git(rendererRoot, 'rev-parse', `HEAD:${rendererDirectory}`),
    minecraftVersion: '1.20.6', socketProtocol: `${rendererDirectory}/SOCKET_PROTOCOL.md`,
    license: 'MIT', licenseFile: 'RENDERER_LICENSE',
};
function replaceOnce(source, before, after, label) {
    if (source.split(before).length !== 2) throw new Error(`Upstream ${label} changed; review the importer.`);
    return source.replace(before, after);
}
const destination = path.resolve('src/agent/vision/modern');
const sourceRequire = createRequire(path.join(sourceRoot, 'package.json'));
const { build } = sourceRequire('esbuild');
const entry = path.join(sourceRoot, 'src/worlds/minecraft/modern-viewer.ts');
await mkdir(destination, { recursive: true });

const result = await build({
    absWorkingDir: sourceRoot,
    entryPoints: [path.relative(sourceRoot, entry)], outfile: path.join(destination, 'host.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node22',
    packages: 'external', metafile: true, legalComments: 'eof',
    plugins: [{
        name: 'neko-without-stream-overlay',
        setup(build) {
            build.onResolve({ filter: /^neko-shared-viewer\/content$/ }, () => ({
                path: path.join(rendererHost, 'viewer-content.mjs'),
            }));
            build.onResolve({ filter: /^neko-shared-viewer\/(appearance|observer|agent)$/ }, args => ({
                path: path.join(rendererHost, `viewer-${args.path.split('/').at(-1)}.mjs`),
            }));
            build.onResolve({ filter: /^neko-local-viewer\/self-skin$/ }, () => ({
                path: path.resolve('src/agent/vision/viewer_self_skin.js'),
            }));
            build.onResolve({ filter: /^\.\/viewer-asset-server\.ts$/ }, () => ({
                path: path.join(rendererHost, 'viewer-asset-server.mjs'),
            }));
            build.onLoad({ filter: /[\\/]viewer-state\.ts$/ }, async ({ path: filename }) => {
                const source = (await readFile(filename, 'utf8')).replace(/\r\n/g, '\n');
                return { contents: replaceOnce(source,
                    '    abilities, observedAt: Date.now() };',
                    '    abilities, observedAt: previous?.observedAt ?? Date.now() };',
                    'catalogue preserves prior mana observation time'),
                    loader: 'ts', resolveDir: path.dirname(filename) };
            });
            build.onLoad({ filter: /[\\/]modern-viewer\.ts$/ }, async ({ path: filename }) => {
                let source = (await readFile(filename, 'utf8')).replace(/\r\n/g, '\n');
                const speechSetup = / {2}const speechBubbleScript = await readFile\([\s\S]*? {2}const speechRelay = new ViewerSpeechRelay\([^;]+;/;
                if (!speechSetup.test(source)) throw new Error('Upstream speech setup changed; review the importer.');
                if (!source.includes('res.end(page); return;')) throw new Error('Upstream page output changed; review the importer.');
                const viewerStart = 'export async function startModernViewer(bot: mineflayer.Bot, options: ModernViewerOptions): Promise<ModernViewerHandle> {';
                if (!source.includes('const MAX_SESSIONS = 2;') || !source.includes(viewerStart)) {
                    throw new Error('Upstream viewer session configuration changed; review the importer.');
                }
                source = source.replace(/import \{ ViewerSpeechRelay \} from '[^']+';\r?\n/, '')
                    .replace('const MAX_SESSIONS = 2;', '')
                    .replace(viewerStart, `${viewerStart}
  const MAX_SESSIONS = options.maxSessions ?? 8;
  if (!Number.isInteger(MAX_SESSIONS) || MAX_SESSIONS < 1 || MAX_SESSIONS > 16) {
    throw new Error('modern viewer: maxSessions must be an integer from 1 to 16');
  }`)
                    .replace(speechSetup, "  const speakerScript = '';\n  const speechRelay = { handle: async () => false, close() {} };")
                    .replace(/'<iframe class="corti-speech-bubble"[^\n]+<\/iframe>',/, "'',")
                    .replace("'<script src=\"/speech-bubble.js\" defer></script>'", "''")
                    // Generated asset pages can contain the same overlay already.
                    .replace('res.end(page); return;', String.raw`res.end(page
                      .replace(/<iframe\b[^>]*\bid=["']corti-speech-bubble["'][^>]*>[\s\S]*?<\/iframe>/gi, '')
                      .replace(/<script\b[^>]*\bsrc=["']\/speech-bubble\.js["'][^>]*>[\s\S]*?<\/script>/gi, '')); return;`);
                source = "import { createViewerContentBridge } from 'neko-shared-viewer/content';\n" + source;
                source = "import { createViewerAppearanceBridge } from 'neko-shared-viewer/appearance';\n" + source;
                source = "import { createViewerObserverBridge } from 'neko-shared-viewer/observer';\n" + source;
                source = "import { createViewerAgentBridge } from 'neko-shared-viewer/agent';\n" + source;
                source = "import { loadViewerSelfSkin } from 'neko-local-viewer/self-skin';\n" + source;
                source = replaceOnce(source, '  const viewerSockets = new Set<Socket>();',
                    `  const selfSkin = await loadViewerSelfSkin(options.selfSkinPath, options.selfSkinModel ?? 'slim');
  const presentOwnEntity = () => ({ ...ownEntity(bot), ...(selfSkin?.entity ?? {}) });
  const content = createViewerContentBridge(bot);
  const appearance = createViewerAppearanceBridge(bot);
  // Spectator registration is explicit; normal own-bot viewing stays passive.
  const observer = options.observerState === true ? createViewerObserverBridge(bot) : null;
  const agentVisuals = createViewerAgentBridge(bot, {
    getViewerSession: () => observer?.snapshot()?.viewerSession ?? null,
  });
  const disposeContent = () => { agentVisuals.dispose(); observer?.dispose(); appearance.dispose(); content.dispose(); };
  const viewerSockets = new Set<Socket>();`, 'content lifecycle');
                source = replaceOnce(source, "    socket.emit('version', bot.version);",
                    "    socket.emit('version', bot.version);\n    content.subscribeSocket(socket);\n    socket.once('disconnect', appearance.subscribeSocket(socket));\n    observer?.subscribeSocket(socket);\n    agentVisuals.subscribeSocket(socket);", 'content subscription');
                source = replaceOnce(source, '    first.close(); third.close();\n    throw error;',
                    '    disposeContent();\n    first.close(); third.close();\n    throw error;', 'failed-start cleanup');
                // The legacy packet observers wrap the Agent observer installed
                // above. Unwind them first so closing restores the original writer.
                source = replaceOnce(source, '      stopArmAnimation();\n      for (const stop of [...sessions]) stop();',
                    '      stopArmAnimation();\n      disposeContent();\n      for (const stop of [...sessions]) stop();', 'content shutdown');
                source = replaceOnce(source, "      if (pathname === '/healthz') {", `      if (selfSkin && pathname === selfSkin.entity.skinUrl) {
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache' });
        res.end(selfSkin.bytes); return;
      }
      if (pathname === '/healthz') {`, 'local own skin route');
                source = replaceOnce(source, "        socket.emit('avatarState', avatarState(bot, ++sequence, shieldRaised));",
                    "        socket.emit('avatarState', { ...avatarState(bot, ++sequence, shieldRaised), entity: presentOwnEntity() });", 'avatar own skin');
                source = replaceOnce(source, "socket.emit(view === 'third' ? 'entityMoved' : 'playerEntity', ownEntity(bot));",
                    "socket.emit(view === 'third' ? 'entityMoved' : 'playerEntity', presentOwnEntity());", 'moving own skin');
                source = replaceOnce(source, "socket.emit(view === 'third' ? 'entity' : 'playerEntity', ownEntity(bot));",
                    "socket.emit(view === 'third' ? 'entity' : 'playerEntity', presentOwnEntity());", 'initial own skin');
                source = replaceOnce(source, "  protocol.on('world_particles', onParticle);", '', 'legacy particle registration');
                source = replaceOnce(source, "      protocol.off('world_particles', onParticle);", '', 'legacy particle cleanup');
                source = replaceOnce(source, '  let agentStateSeen = false;', `  let agentStateSeen = false;
  const initialSkills = options.getInitialSkillsPacket?.() ?? options.initialSkillsPacket;
  if (initialSkills?.channel === VIEWER_STATE_CHANNEL
      && Number.isFinite(initialSkills.observedAt) && initialSkills.observedAt > 0
      && initialSkills.observedAt <= Date.now() + 30000) {
    const parsed = parseSkillsPayload(initialSkills.channel, initialSkills.data);
    if (parsed) {
      latestSkills = { ...mergeViewerSkillState(null, parsed, initialSkills.channel, false),
        observedAt: initialSkills.observedAt, stale: true,
        // A login snapshot cannot prove present cooldown readiness.
        abilities: parsed.abilities.map(ability => ({ ...ability, cooldownRemainingMs: null })) };
      agentManaSeen = true;
      agentStateSeen = true;
    }
  }`, 'early login skills replay');
                source = replaceOnce(source, '    usingHeldItem: bot.usingHeldItem === true,',
                    `    usingHeldItem: bot.usingHeldItem === true || (Number((entity.metadata as unknown[] | undefined)?.[8]) & 1) !== 0,
    usingOffhand: (Number((entity.metadata as unknown[] | undefined)?.[8]) & 2) !== 0,`,
                    'native main-hand and offhand use for OBS');
                return { contents: source, loader: 'ts', resolveDir: path.dirname(filename) };
            });
        },
    }],
});
await copyFile(path.join(sourceRoot, 'LICENSE'), path.join(destination, 'LICENSE'));
await copyFile(path.join(rendererRoot, 'LICENSE'), path.join(destination, 'RENDERER_LICENSE'));
let bundle = await readFile(path.join(destination, 'host.mjs'), 'utf8');
const healthPayload = '{ ok: !closed, version: bot.version, ...sessionSlots.status() }';
if (!bundle.includes(healthPayload)) throw new Error('Upstream health response changed; review the importer.');
bundle = bundle.replace('import { Vec3 as Vec33 } from "vec3";',
    'import { Vec3 as Vec33 } from "vec3";\nimport { gameOnline } from "../game_health.js";')
    .replace(healthPayload, '{ ok: !closed, gameOnline: gameOnline(bot), version: bot.version, ...sessionSlots.status() }');
if (!bundle.includes('import { gameOnline }')) throw new Error('Upstream imports changed; review the importer.');
await writeFile(path.join(destination, 'host.mjs'), bundle);
function inputsFrom(root) {
    return Object.keys(result.metafile.inputs).map(file => path.relative(root, path.resolve(sourceRoot, file)))
        .filter(file => file && !file.startsWith('..') && !path.isAbsolute(file))
        .map(file => file.replaceAll('\\', '/'));
}
await writeFile(path.join(destination, 'source.json'), JSON.stringify({
    repository: 'https://github.com/jcs130/Cortico',
    revision: git(sourceRoot, 'rev-parse', 'HEAD'),
    entry: 'src/worlds/minecraft/modern-viewer.ts',
    bundleSha256: createHash('sha256').update(bundle).digest('hex'),
    inputs: inputsFrom(sourceRoot),
    localInputs: ['src/agent/vision/viewer_self_skin.js', 'src/agent/vision/game_health.js'],
    renderer: { ...rendererSource, inputs: inputsFrom(rendererRoot) },
    changes: ['Remove the host speech and livestream overlay; retain game rendering and sound.',
        'Make concurrent viewing configurable (default 8, range 1-16); keep the separate capture limit.',
        'Report Minecraft connection health separately from the renderer HTTP listener.',
        'Observe original particle, map and TextDisplay packets through the shared renderer bridge; remove the duplicate legacy particle path.',
        'Serve original font ZIP resources through the shared bounded asset server.',
        'Use the shared appearance/asset bridge; observer registration remains opt-in for spectator consumers.',
        'Optionally serve a validated local 64x64 PNG for the own bot; preserve server skins for other players.',
        'Replay same-connection login mana and abilities through the strict parser, retaining the original timestamp and marking cached cooldowns unknown.',
        'Preserve prior mana observation time when enriching abilities from a server spell catalogue.',
        'Forward native main-hand and offhand item-use flags to the OBS hand renderer.',
        'Relay same-player routes, inputs and explicit public markers through the shared Agent bridge; viewer publishing is denied by default.'],
}, null, 2) + '\n');
await writeFile(path.join(destination, 'renderer-source.json'), JSON.stringify(rendererSource, null, 2) + '\n');
console.log(`Imported modern viewer host (${bundle.length} bytes).`);
