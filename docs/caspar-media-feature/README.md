# Caspar media plugin

## Goals

- **Library** — Fork of the Caspar AMCP-based library viewer (`cls` / `tls`) in `plugins/caspar-media`, so you can extend it (e.g. delete) without editing the upstream Caspar plugin.
- **Upload** — Write files into the same Linux directories CasparCG and media-scanner use, as declared in `casparcg.config` (`<paths>`).
- Keep uploads **simple**: direct filesystem writes on the machine where Bridge runs.
- Align path resolution with media-scanner’s rules so uploaded files appear after refresh and in media-scanner’s watcher on the media root.

## Non-goals (MVP)

- Uploading to remote Caspar hosts without a shared filesystem (SFTP, agents, etc.).
- Automatic Caspar `LOAD` / AMCP refresh after upload.
- Modifying `plugins/caspar` — the stock Caspar library widget remains available for custom layouts.

## Relationship to other components

| Component | Role |
|-----------|------|
| **Caspar plugin** | Provides AMCP (`caspar.sendCommand`) and server list in state (`bridge-plugin-caspar`). |
| **Caspar media plugin** | **Library** widget lists via the same AMCP commands; **upload** writes to resolved `media` / `template` / `font` roots. |
| **media-scanner** | Reads `casparcg.config`, watches the media root. No upload API. |

## Deployment assumption

Bridge must run where those paths are **reachable** (same host or bind-mounted paths as Caspar/media-scanner). See [ARCHITECTURE.md](./ARCHITECTURE.md) for security notes.

## User workflow

1. Open **Settings → Caspar media** and set the absolute path to `casparcg.config`, then save.
2. Use **Caspar media library** to browse (and later extend) and **Caspar media upload** to add files.
3. Workspaces that used the old **Media upload** plugin migrate settings automatically on first load (see ARCHITECTURE).

## Documentation index

- [ARCHITECTURE.md](./ARCHITECTURE.md) — flows, HTTP contract, state keys, migration.
- [CONFIG.md](./CONFIG.md) — XML path mapping and examples.
