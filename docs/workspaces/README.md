# Workspaces

Bridge stores **workspace** documents as `.bridge` files: ZIP archives containing `state.json` (full workspace state, including embedded `id`). They are read and written by [`lib/ProjectFile.js`](../../lib/ProjectFile.js).

## Storage location

- Directory: [`paths.workspaces`](../../lib/paths.js) → `<appData>/workspaces`.
- Default app data (non-Electron): `data/` next to the project (see `APP_DATA_BASE_PATH` / Electron `userData`).

## HTTP API (`/api/v1/workspaces/...`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/list` | Lists `*.bridge` files: `filePath`, `filename`, `title` (from `_title` when readable), `modified`. |
| `POST` | `/open` | Body `{ filePath }`. Loads file, sets `_filePath`, registers in [`WorkspaceRegistry`](../../lib/WorkspaceRegistry.js), returns `{ workspaceId, redirectUrl }`. |
| `POST` | `/upload` | Multipart field **`file`**: valid `.bridge` file. Validates with `readWorkspace`, writes under `paths.workspaces`. If the target name exists, a numeric suffix is added (`_2`, `_3`, …). Returns `{ filePath, filename, title }`. Max size: 100 MB. |
| `POST` | `/delete` | Body `{ filePath }`. Deletes a `.bridge` file **only** if it resolves inside `paths.workspaces`. **409** `ERR_WORKSPACE_IN_USE` if any in-memory registered workspace uses that path. |
| `POST` | `/:workspace/save` | Body optional `{ filename }`. Saves the in-registry workspace. |
| `POST` | `/:workspace/rename` | Body `{ name }`. Renames the in-registry workspace file and updates `_title`. |
| `GET` | `/:workspace/download` | Saves current state, then streams the file as an attachment. **Not wired in the default web UI**; use `fetch` or a direct link with the current `workspace` id. |

### Security notes

- **`open`** accepts any server-readable `filePath`. Intended for trusted operators / local deployments.
- **`delete`** and **`upload`** only affect files under `paths.workspaces` (path traversal rejected).

## Client API ([`api/workspace.js`](../../api/workspace.js))

- `list()`, `open(filePath)`, `save(filename?)`, `rename(name)`, `upload(file)`, `remove(filePath)`, `download()` (triggers browser download for the current workspace).

## UI

- **Header** (web, not Electron): **Save** (`save`), **Workspaces** opens the manager.
- **Workspace manager**: lists saved workspaces, **open** (row click), **rename** (edit button), **import** (file picker), **delete** (trash; confirms first).

### Rename-from-list quirk

The rename API targets the **currently loaded** workspace (`window.APP.workspace`), not necessarily the row you clicked in the manager. Renaming from the list only matches your intent when that row is the workspace you already have open. A future improvement is a `rename-file` API keyed by `filePath` under `paths.workspaces`.

## Lifecycle

- **`GET /workspaces/new`**: Loads `defaultworkspace.bridge` if present, else creates a new workspace and redirects to `/workspaces/:id`.
- In-memory instances live in `WorkspaceRegistry` until the server process ends (or they are replaced when opening another file with the same id—see registry behavior).

## Related code

- Server workspace operations: [`lib/api/SWorkspace.js`](../../lib/api/SWorkspace.js) (`workspace.save`, `saveAs`, `list`, `rename`).
- Routes: [`lib/routes/index.js`](../../lib/routes/index.js).
- UI: [`app/components/WorkspaceManager/index.jsx`](../../app/components/WorkspaceManager/index.jsx), [`app/components/Header/index.jsx`](../../app/components/Header/index.jsx).
