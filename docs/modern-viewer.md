# Modern browser viewer

Watch the existing Mineflayer bot in first-person (`/`), third-person (`/third/`)
or dungeon 2.5D (`/dungeon/`) view. The picture includes inventory, survival HUD,
received chat, a minimap and the renderer's game effects. It observes the existing
bot; it does not create another Minecraft login or run another LLM.

The integration also relays original server particles, map pixels,
item-frame/held maps and native TextDisplay entities through the same bot
connection. Chinese TextDisplay glyphs use the original version-matched font
assets. Dungeon terrain visibility follows the upstream avatar-occlusion
logic. These rendering features do not add LLM requests or game commands.

The optional modern renderer currently requires **Node.js 22** and **Minecraft
Java 1.20.6**. The default configuration keeps visualization disabled and retains
the Prismarine viewer option. Modern viewer startup failures are logged without
preventing the game agent from initializing.

## Generate the browser resources

The frontend is [jcs130/mc-visual-console](https://github.com/jcs130/mc-visual-console),
an MIT-licensed project with portable browser source and offline resource tools.
The host adapter is included in this repository; generate browser code and
Minecraft resources from the [pinned renderer source](https://github.com/jcs130/mc-visual-console/tree/f579863e64428d270dec0d3ddf89dbeab5d93481/packages/modern-viewer/renderer-src).
Its revision, source tree and license are recorded in
[`renderer-source.json`](../src/agent/vision/modern/renderer-source.json) and
[`RENDERER_LICENSE`](../src/agent/vision/modern/RENDERER_LICENSE).
The pinned runtime source and build tools match the renderer accompanying this
host adapter. The standalone frontend needs no Cortico checkout or service.
The shared repository includes a hash-checked Java 1.20.6 resource pack. The
following commands work in PowerShell or a POSIX shell; replace the output path
with a new directory for your deployment. This prepares the generic preset,
including particle/map resources and the original Chinese font ZIP.

```sh
git clone https://github.com/jcs130/mc-visual-console.git mc-visual-console
git -C mc-visual-console checkout f579863e64428d270dec0d3ddf89dbeab5d93481
cd mc-visual-console
npm ci --prefix packages/modern-viewer/renderer-src
node tools/prepare-viewer-assets.mjs java-1.20.6 "/path/to/viewer-assets-new"
```

The output contains
`viewer-client.json`, `dist/`, `public/` and `render-assets/`; these generated
resources are not committed here. `viewer-assets.json` records the shared pack
manifest and original client JAR hashes; `viewer-client.json` records the browser
bundle and content/font hashes. The host checks that the manifests,
protocol version and generated bundle agree before accepting viewers.
Keep the same Minecraft version, preset and sound choice when updating an
existing deployment. Building the source does not update a previously copied
runtime directory: switch the configured directory, reload the viewer and
browser, and compare the served `/index.js` bytes with the recorded bundle hash.
Keep the previous directory for rollback. The frontend's
[Socket.IO contract](https://github.com/jcs130/mc-visual-console/blob/f579863e64428d270dec0d3ddf89dbeab5d93481/packages/modern-viewer/renderer-src/SOCKET_PROTOCOL.md)
documents the game state consumed by the browser; the bundled adapter supplies
that stream from the existing bot.

For a resource export from your own installed client, follow the upstream
[resource and TextDisplay guide](https://github.com/jcs130/mc-visual-console/blob/f579863e64428d270dec0d3ddf89dbeab5d93481/packages/modern-viewer/renderer-src/docs/text-display-bubbles.md).
A JAR-only block export does not provide the complete launcher font resources.

## Enable local viewing

In `settings.js`, or in the settings file already used by your deployment:

```js
"render_bot_view": true,
"viewer_type": "modern",
"viewer_port": 3000,
"modern_viewer_assets_dir": "/path/to/viewer-assets",
"modern_viewer_lan_address": "",
"modern_viewer_lan_prefix": 24,
"modern_viewer_max_sessions": 8,
```

On Windows, forward slashes work in absolute paths such as
`C:/minecraft/viewer-assets`. Start the agent normally and open
`http://127.0.0.1:3000/dungeon/`. Other viewpoints share the same port; each
additional agent uses the next port. The browser needs WebGL2.

Set `viewer_type` to `prismarine` to use the existing browser renderer instead.
The modern adapter loads its rendering dependencies only when enabled, and the
Prismarine option imports the browser transport without the package's headless
renderer entry point.

## Enable LAN viewing

Set `modern_viewer_lan_address` to the computer's actual LAN IPv4 address, for
example `192.168.1.20`, and set `modern_viewer_lan_prefix` to the subnet prefix
used by that network (usually `24`). Then open
`http://192.168.1.20:3000/dungeon/` from another device. Allow the chosen port in
the host firewall for your private network if required. Update the setting if
DHCP changes the computer's address.

The rendering host binds to loopback; a separate proxy binds to the chosen LAN
address and accepts clients from that subnet. It checks Host and Origin,
forwards the viewer's HTTP and Socket.IO traffic, removes forwarded/control
headers, and blocks capture-lease management from LAN clients. Viewing adds no
remote game-control endpoint. The project's existing agent-control WebSocket is
separate and its binding is unchanged by this feature.

`modern_viewer_max_sessions` is shared by all local/LAN viewing pages and all
viewpoints (default 8, integer 1–16). Each page consumes one slot; closing a page
releases it. Capture retains its separate limit of one. `/healthz` reports the
current and maximum counts. A healthy HTTP response alone does not prove that
the bot is moving or that browser rendering has succeeded.

## OBS browser source and layout

Open `/?obs=1` as an OBS Browser Source above the game capture. The background
is transparent; the original first-person hands and items render alongside the
survival HUD, minimap, skills and received messages. The overlay skips terrain,
sky, entities and player previews. It shares the existing bot's state and
does not create another Minecraft connection.

Use **OBS 布局设置** in the normal page, `/?obs=1&obsEdit=1`, or F8 to edit
28 component groups. Components can be hidden, moved and scaled (0.3–3x).
Settings are saved in that browser. Use **复制布局链接** to transfer them to
OBS, which has its own browser storage. Exported links exclude the editor;
**完成** closes it. Match the browser source dimensions to the game capture.

When deploying through MindServer, update both the persistent settings file
and the owning agent's cached `modern_viewer_assets_dir`. Its existing
`set-agent-settings` interface reconnects that agent; apply it at a healthy,
idle boundary and verify the recovered game stream and served bundle. Updating
only the file can restore an old asset directory on a subsequent reconnect.

Normal viewing also has a compact tool strip, component display menu and H
shortcut for a clean view. OBS has separate preferences, including vertical FOV
and source aspect ratio. Dynamic FOV is shown as unsynchronized unless the
actual source explicitly publishes its current value.

## Agent routes, inputs and public markers

The host attaches the shared Agent bridge once to the existing action player.
It observes actual pathfinder routes, recent positions, control states and sent
interaction packets. Both Socket.IO views receive the same identity-bound
state. An observed outgoing packet means it was sent, not that the operation
completed. The operation pointer is presentation interpolation, not a physical
mouse recording. Missing or disconnected subjects have no invented state.

Trusted in-process integrations can publish a public explanation or markers:

```js
bot.emit('viewer:agent', {
    markers: [{ id: 'tree', kind: 'point', role: 'gather',
        position: { x: 10, y: 64, z: 20 }, label: 'Gather here' }],
}, receipt => console.log(receipt));
```

No model reasoning or conversation history is collected automatically. Viewer
Socket.IO publishing is denied by default; no HTTP upload route or game-control
endpoint is added. See the pinned shared
[Agent visualization contract](https://github.com/jcs130/mc-visual-console/blob/f579863e64428d270dec0d3ddf89dbeab5d93481/packages/modern-viewer/renderer-src/docs/agent-visualization.md)
for limits, expiry, marker shapes and optional image/animation presentations.

## Login state and optional own skin

The modern option passively retains the existing connection's latest
`mcagent:state` packet from bot creation, bounded to 64 KiB. The host reads it
after asynchronous asset loading and applies its strict schema parser. Replayed
mana keeps its original observation time, is marked last-known, and cannot
assert current cooldown readiness. Ended connections release the cache.

Set `modern_viewer_self_skin` to an optional local 64x64 PNG (at most 128 KiB),
with `modern_viewer_self_skin_model` set to `slim` or `classic`. It affects only
this bot's browser avatar and uses a same-origin hashed image URL. It does not
change the Minecraft account skin or another player's appearance.

## Optional game sound

Sound is optional and stays disabled when matching resources are absent. To
include the shared pack's sounds, add `--sounds` to the preparation command.
Alternatively, export your matching launcher cache from the renderer source
directory:

```sh
node tools/export-minecraft-viewer-sounds.mjs "/path/to/versions/1.20.6/1.20.6.json" "/path/to/launcher/assets" "/path/to/viewer-assets"
```

The exporter reads the local launcher cache. The renderer disables numbered
sound events when the matching registry is missing. Browser interaction is
required to allow playback. Cortico-specific speech overlays and host speech
relays are excluded from this adapter; the shared OBS HUD and hand overlay
described above are supported. Native server TextDisplay entities remain
visible; they are a separate game protocol feature.

## Validation and maintenance

The tests need the project's npm dependencies but no Minecraft server, model,
client JAR or GPU. Their synthetic resources exercise the host and socket
transport; they do not validate browser pixels.

```sh
node test/run.mjs test/browser_viewer.test.mjs test/modern_viewer.test.mjs test/viewer_lan_proxy.test.mjs test/viewer_skills_cache.test.mjs test/camera_position.test.mjs
```

With a real agent online and four free viewing slots, check streaming and slot
reuse without sending game actions or model requests:

```sh
node scripts/verify-modern-viewer-sessions.mjs http://127.0.0.1:3000
node scripts/verify-modern-viewer-sessions.mjs http://192.168.1.20:3000
```

The vendored `src/agent/vision/modern/host.mjs` is bundled from MIT-licensed
Cortico sources, plus the shared renderer's content bridge and bounded asset
server. `LICENSE` and `source.json` record Cortico's revision and inputs;
`RENDERER_LICENSE`, `renderer-source.json` and the nested `source.json.renderer`
record the shared source revision, tree and host inputs. The bundle hash covers
the combined result. To rebuild the host, prepare the recorded Cortico checkout:

```sh
git clone https://github.com/jcs130/Cortico.git cortico-viewer-source
git -C cortico-viewer-source checkout f0db612ce5075287330ab3e095ffa449c6e8e71c
cd cortico-viewer-source
pnpm install --frozen-lockfile
```

Then return to this repository's root and run:

```sh
node scripts/import-modern-viewer.mjs "/path/to/cortico-viewer-source" "/path/to/mc-visual-console"
```

Review the source revision and regenerated diff together. The importer removes
the speech/stream overlay and makes viewing slots configurable; it fails if the
expected upstream transformation points have changed. Both source checkouts
must have clean tracked input files. The importer records both pins automatically,
subscribes each accepted viewer to one shared content bridge, and releases it on
close or bind failure. It removes the legacy particle listener to avoid rendering
one packet twice.

When updating either source, check the frontend's Socket.IO contract against the
host, regenerate the host, and rebuild and verify browser assets. Keep source
updates separate from unrelated Cortico gameplay changes. See the
[shared renderer maintenance guide](https://github.com/jcs130/mc-visual-console/blob/f579863e64428d270dec0d3ddf89dbeab5d93481/docs/VIEWER_UPDATES.md).

Map decorations, native particle physics parity, Java pixel parity and arbitrary
modded entity rendering are not claimed. The integration tests use synthetic
protocol packets; real server effects need observation in that server session.
