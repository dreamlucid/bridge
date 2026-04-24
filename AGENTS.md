# Agent instructions (Bridge)

This file orients autonomous coding agents on **Bridge**: playout control software (CasparCG-focused, OSC-capable), implemented as **Node.js + Express**, optional **Electron**, **React** UI, and a **plugin** model.

Use it together with user/chat instructions and any `.cursor/rules/` rules in this repo.

---

## Read first

| Topic | Location |
|--------|-----------|
| Product overview | [`README.md`](README.md) |
| Full docs index | [`docs/README.md`](docs/README.md) |
| Directory layout | [`docs/structure.md`](docs/structure.md) |
| Processes, IPC, shared state | [`docs/architecture.md`](docs/architecture.md) |
| Plugin development | [`docs/plugins/README.md`](docs/plugins/README.md) |
| API reference | [`docs/api/README.md`](docs/api/README.md) |

Before changing behavior in a plugin, read that plugin’s `README.md` under `plugins/<name>/`.

---

## Referencing app architecture (docs)

Use the docs in **dependency order**: start at the index, then core architecture, then feature-specific pages and code.

### Core (always relevant)

1. **[`docs/README.md`](docs/README.md)** — Entry point: bundled plugins list, links to plugin guide, API, internals, build, terminology (workspace, item, type, tab, widget, plugin).
2. **[`docs/architecture.md`](docs/architecture.md)** — **Authoritative** for process split (Node vs browser), why HTTP/WebSocket IPC is required, shared context (“shared state”), websocket sync, and the high-level context shape (`_connections`, `_userDefaults`, etc.). Cite this when explaining cross-client behavior or server vs Electron.
3. **[`docs/structure.md`](docs/structure.md)** — Physical layout of `lib/`, `app/`, `api/`, `plugins/`, build outputs. Use when deciding *where* a change belongs.
4. **[`docs/types.md`](docs/types.md)** — Item/type model when changing plugins that define or consume types.

When the canonical doc describes behavior that must match implementation, **cross-check code**: e.g. deep merge is implemented in [`shared/merge.js`](shared/merge.js); reference both the doc and that file in reviews.

### Feature- and plugin-specific architecture

These go **deeper than** `docs/architecture.md` for their area. Prefer them over guessing when working in the same feature:

| Area | Doc | When to use |
|------|-----|----------------|
| Caspar **network** plugin (SRT, AMCP, preview pipeline) | [`docs/CASPAR_NETWORK_PLUGIN_ARCHITECTURE.md`](docs/CASPAR_NETWORK_PLUGIN_ARCHITECTURE.md) | Plugin layout, preview vs output streams, backend/frontend split under `plugins/caspar-network/`. |
| Caspar **media** (upload, library, workspace paths) | [`docs/caspar-media-feature/ARCHITECTURE.md`](docs/caspar-media-feature/ARCHITECTURE.md), [`docs/caspar-media-feature/CONFIG.md`](docs/caspar-media-feature/CONFIG.md) | HTTP routes, multer/chunked upload, `resolvedRoots`, iframe workspace id (`state._id`). |
| Workspaces | [`docs/workspaces/README.md`](docs/workspaces/README.md) | Workspace-specific flows. |

**How to refer in PRs and agent summaries**

- Link the **doc path** (e.g. `docs/architecture.md#the-shared-state`) plus the **primary code paths** you changed.
- If docs are wrong vs code, **fix the doc or the code** in the same change set when scope allows; otherwise call out the drift explicitly.

---

## Fancode fork–specific guidance

This fork tracks **Fancode** product work on top of upstream Bridge patterns. There is no separate “Fancode” string in-repo; treat **git branch naming** (e.g. `fancode-main`) and team conventions as the source of truth for release vs upstream sync.

### Where Fancode-specific work usually lands

- **`plugins/caspar-network/`** — Primary area for streaming/network extensions: AMCP/SRT, WebRTC preview, **mediasoup**. Key implementation files include:
  - [`plugins/caspar-network/lib/MediasoupBridge.js`](plugins/caspar-network/lib/MediasoupBridge.js) — RTP → WebRTC via mediasoup `PlainTransport` + FFmpeg.
  - [`plugins/caspar-network/lib/preview/PreviewBridge.js`](plugins/caspar-network/lib/preview/PreviewBridge.js), [`WebRTCPreviewManager.js`](plugins/caspar-network/lib/WebRTCPreviewManager.js), [`WebRTCSignalingServer.js`](plugins/caspar-network/lib/WebRTCSignalingServer.js) — Preview/signaling stack (mediasoup-demo-style patterns).
  - Plugin entry and commands: [`plugins/caspar-network/index.js`](plugins/caspar-network/index.js), [`plugins/caspar-network/lib/commands.js`](plugins/caspar-network/lib/commands.js).
- **Other bundled plugins** (`plugins/caspar`, `plugins/caspar-media`, etc.) — Only when the feature is owned by that plugin; follow its `README.md` and any doc under `docs/`.

### Practices for fork-only or divergent changes

1. **Prefer plugin-local changes** — Keeps merges from upstream tractable and matches Bridge’s extension model.
2. **State keys and API surface** — Follow existing Bridge plugin state paths (e.g. under `plugins['bridge-plugin-caspar-network']` / manifest id from `package.json`). Avoid ad-hoc globals in `lib/` unless the behavior is truly cross-plugin server infrastructure.
3. **Document divergence** — In commit messages or PR description, note **what differs from stock Bridge** and why (operational requirement, infra, or product). Link [`docs/CASPAR_NETWORK_PLUGIN_ARCHITECTURE.md`](docs/CASPAR_NETWORK_PLUGIN_ARCHITECTURE.md) when changing documented behavior.
4. **Upstream sync** — When backporting or preparing contributions upstream, isolate commits and minimize unrelated formatting churn in shared files (`lib/server`, `shared/merge.js`, core `app/`) unless required by the feature.
5. **IPC and deployment** — Fancode deployments may be server-heavy; respect **WebSocket/HTTP-only IPC** (see `docs/architecture.md`) so features work outside Electron.

---

## Repository map (short)

- **`lib/`** — Node/backend: server, init, platform helpers.
- **`app/`** — Frontend: React components, views, hooks, utils.
- **`api/`** — Plugin API split for **browser** vs **node** contexts.
- **`shared/`** — Cross-process code (e.g. state merge utilities).
- **`plugins/`** — Bundled first-party plugins only (not third-party installs).
- **`examples/`** — Sample plugins (good patterns for new work).
- **`docs/`** — Human documentation; prefer updating when behavior is user-facing.
- **`scripts/`** — Build and tooling scripts.

Build artifacts: **`dist/`**, **`bin/`** — do not treat as source of truth; regenerate via build scripts.

---

## Agentic workflow

1. **Clarify scope** — Infer the user’s goal from the thread. Prefer fixing root causes over symptoms. Keep changes limited to what was asked.
2. **Locate the right layer** — Server/plugin logic (`lib/`, `plugins/`), UI (`app/`), shared contracts (`api/`, `shared/`), or docs (`docs/`).
3. **Match existing style** — ESLint uses **JavaScript Standard Style** (`npm run lint`). Follow patterns in neighboring files (naming, error handling, logging).
4. **Preserve licensing** — Source files often use SPDX headers (`SPDX-License-Identifier: MIT`); keep or add them consistently when creating new files if the rest of the tree does.
5. **Verify** — After substantive edits:
   - `npm run lint`
   - `npm test` (uses Jest with `.env.test` via dotenvx; ensure env is available in CI/local as expected)
6. **Report** — Summarize what changed, why, and how you verified it. Point to important paths or docs for reviewers.

---

## Commands (from `package.json`)

| Command | Use |
|---------|-----|
| `npm run lint` / `npm run lint:fix` | Static analysis |
| `npm test` | Lint + Jest |
| `npm run start` / `npm run start:dev` | Run Bridge (info vs debug log level) |
| `npm run nodemon` | Dev server with nodemon + inspect |
| `npm run build` / `npm run build:dev` | Webpack production / development bundles |

---

## Conventions for agents

- **Plugins** — Extend via the plugin API; see examples under `examples/` and bundled plugins under `plugins/`. Do not commit unrelated third-party plugins into `plugins/`.
- **IPC** — Prefer WebSockets / HTTP as documented; do not assume Electron-only channels for features that must work in server mode.
- **State** — Shared context and merge behavior are central; see `docs/architecture.md` before altering sync or merge semantics.
- **Security** — Be cautious with network surfaces, file uploads, and plugin boundaries; see [`README.md`](README.md) security section.

---

## When stuck

1. Search `docs/` for the feature or term.
2. Find a similar feature in `plugins/` or `examples/` and mirror its structure.
3. If a change spans API and UI, trace both `api/node` / `api/browser` and `app/` consumers.

---

## Relation to Cursor rules

- **`AGENTS.md`** (this file): repo-wide orientation and workflow for any agent.
- **`.cursor/rules/*.mdc`**: scoped, enforceable rules (globs, always-on). Add or edit those for repeated project-specific policies; keep this file high-level and stable.
