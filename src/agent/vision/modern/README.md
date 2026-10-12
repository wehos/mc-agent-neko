# Modern viewer host

`host.mjs` is bundled from Cortico's MIT-licensed Mineflayer viewer and the
shared renderer's original content bridge and asset server. `source.json`
records both source revisions, separate inputs and the combined SHA-256. It receives the existing bot;
it does not start Cortico, another game login or an LLM. The host speech and
livestream overlay is removed by the importer; Minecraft audio remains available.

See [portable setup, resource generation and maintenance](../../../../docs/modern-viewer.md).

The browser frontend and offline build tools come from the separate
[mc-visual-console project by jcs130](https://github.com/jcs130/mc-visual-console).
`renderer-source.json` pins its compatible source revision and tree;
`RENDERER_LICENSE` preserves that project's MIT notice. The host's `source.json`
and `LICENSE` retain Cortico's own provenance and copyright notice.

The content bridge observes original particles, map pixels and native
TextDisplay entities from that connection, including Chinese font resources.
Both Socket.IO paths share its state and cleanup. No second bot, model request
or server command is added. Cortico's separate speech overlay remains removed.

The shared Agent bridge observes that player's routes, controls and sent
operations, and accepts explicit public markers via `bot.emit('viewer:agent',
update, acknowledgement)`. Viewer publishing stays denied. It is disposed after
the legacy packet observers so the existing connection's writer is restored.

The separately generated Minecraft 1.20.6 browser assets are runtime data.
Set `viewer_type` to `modern` and `modern_viewer_assets_dir` to their root, which
must contain `viewer-client.json`, `dist/`, `public/` and `render-assets/`.
Set `modern_viewer_lan_address` and `modern_viewer_lan_prefix` to expose the
picture on the local subnet. Viewer access is read-only; agent control stays
on its existing local WebSocket. First, third and dungeon views use one port.

`modern_viewer_max_sessions` controls simultaneous viewing connections across
all views, local tabs, plugin iframes and LAN devices (default 8, integer 1-16).
Each open page consumes one connection. The upstream limit of two could reject
a LAN viewer when two local previews were already open. Capture keeps its own
separate limit of one. `/healthz` reports current and maximum viewing counts.

With the agent running and four free viewing slots, check concurrent streaming
and slot reuse without sending game actions:

```powershell
node scripts/verify-modern-viewer-sessions.mjs http://127.0.0.1:3000
```

Sound is optional: `public/sounds/registry.json`, audio files and their manifest
must be exported from the matching vanilla client. Numbered packet audio is
disabled when the matching registry is missing.
