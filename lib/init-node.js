// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const fs = require('node:fs')
const path = require('node:path')

const paths = require('./paths')
const UserDefaults = require('./UserDefaults')
const WorkspaceRegistry = require('./WorkspaceRegistry')
const ProjectFile = require('./ProjectFile')

const Logger = require('./Logger')
const logger = new Logger({ name: 'init-node' })

/**
* The minimum threshold after creation
* that a workspace can be teared down,
* assuming no connections
* @type { Number }
*/
const WORKSPACE_TEARDOWN_MIN_THRESHOLD_MS = 20000

/*
Write the user defaults-state to disk
before the process exits
*/
function writeUserDeafults () {
  logger.debug('Writing user defaults to disk')
  fs.writeFileSync(paths.userDefaults, JSON.stringify(UserDefaults.data))
}

process.on('exit', () => writeUserDeafults())

process.on('SIGTERM', () => {
  writeUserDeafults()
  process.exit(0)
})

process.on('SIGINT', () => {
  writeUserDeafults()
  process.exit(0)
})

/*
Setup listeners for new workspaces
in order to remove any dangling
references
*/
WorkspaceRegistry.getInstance().on('add', async workspace => {
  const creationTimeStamp = Date.now()

  function conditionalTeardownWorkspaces () {
    /*
    Make sure that we've given clients
    a timeframe to connect before
    terminating the workspace
    */
    if (Date.now() - creationTimeStamp < WORKSPACE_TEARDOWN_MIN_THRESHOLD_MS) {
      return
    }

    if (Object.keys(workspace?.state?.data?._connections || {}).length > 0) {
      return
    }

    /*
    Don't tear down workspaces that have been saved to disk
    (they have a _filePath), as they should persist across restarts
    */
    if (workspace?.state?.data?._filePath) {
      return
    }

    logger.debug('Tearing down workspace', workspace.id)
    WorkspaceRegistry.getInstance().delete(workspace.id)
    workspace.teardown()
  }

  workspace.on('cleanup', async () => {
    conditionalTeardownWorkspaces()
  })
})

/**
 * Load defaultworkspace.bridge on startup if it exists
 * This ensures the workspace ID persists across restarts
 * Only runs in Node.js mode (not Electron)
 */
;(async function () {
  const defaultWorkspacePath = path.join(paths.workspaces, 'defaultworkspace.bridge')

  try {
    if (fs.existsSync(defaultWorkspacePath)) {
      logger.debug('Loading defaultworkspace.bridge')
      const workspace = await ProjectFile.main.readWorkspace(defaultWorkspacePath)
      if (workspace) {
        // Do not replace an already-live workspace with the same id — that would
        // drop in-memory command registrations (e.g. WebRTC preview reply path).
        const existing = WorkspaceRegistry.getInstance().get(workspace.id)
        if (existing) {
          logger.debug('defaultworkspace already in registry, skipping reload', workspace.id)
          return
        }
        workspace.state.apply({ _filePath: defaultWorkspacePath })
        WorkspaceRegistry.getInstance().add(workspace)
        logger.debug('Loaded defaultworkspace with id', workspace.id)
      }
    }
  } catch (err) {
    logger.warn('Failed to load defaultworkspace.bridge', err)
  }
})()
