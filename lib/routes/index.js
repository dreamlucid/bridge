// SPDX-FileCopyrightText: 2022 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const { Router } = require('express')
const router = new Router()
const path = require('path')
const fs = require('fs')

const HttpError = require('../error/HttpError')
const StaticFileRegistry = require('../StaticFileRegistry')
const WorkspaceRegistry = require('../WorkspaceRegistry')
const ProjectFile = require('../ProjectFile')
const { registerCasparMediaRoutes } = require('./casparMedia')

registerCasparMediaRoutes(router)

router.get('/serve/:id', (req, res, next) => {
  const stream = StaticFileRegistry.getInstance().createReadStream(req.params.id)
  if (!stream) {
    const err = new HttpError('File not found', 'ERR_NOT_FOUND', '404')
    return next(err)
  }
  stream.pipe(res)
})

// HLS segment serving for caspar-network plugin
// Route: /api/v1/hls/:streamId/:filename
router.get('/hls/:streamId/:filename', (req, res, next) => {
  const { streamId, filename } = req.params
  // Security: Only allow .ts and .m3u8 files
  if (!filename.match(/^[a-zA-Z0-9_-]+\.(ts|m3u8)$/)) {
    const err = new HttpError('Invalid filename', 'ERR_INVALID_FILENAME', '400')
    return next(err)
  }
  // Get the HLS directory from the plugin's StreamProxy
  // Construct the path based on the known structure
  const os = require('os')
  const hlsDir = path.join(os.tmpdir(), 'bridge-caspar-network-hls', streamId)
  const filePath = path.join(hlsDir, filename)

  // Check if file exists
  if (!fs.existsSync(filePath)) {
    const err = new HttpError('File not found', 'ERR_NOT_FOUND', '404')
    return next(err)
  }

  // Set appropriate content type and headers
  if (filename.endsWith('.m3u8')) {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')
    // For HLS manifests, we need to read and serve fresh content
    // since FFmpeg continuously updates it
    try {
      const manifestContent = fs.readFileSync(filePath, 'utf8')
      res.send(manifestContent)
    } catch (err) {
      const httpErr = new HttpError('Error reading manifest', 'ERR_READ_ERROR', '500')
      return next(httpErr)
    }
  } else if (filename.endsWith('.ts')) {
    res.setHeader('Content-Type', 'video/mp2t')
    res.setHeader('Cache-Control', 'public, max-age=3600')
    // Stream the segment file
    const stream = fs.createReadStream(filePath)
    stream.on('error', () => {
      if (!res.headersSent) {
        const httpErr = new HttpError('Error reading segment', 'ERR_READ_ERROR', '500')
        next(httpErr)
      }
    })
    stream.pipe(res)
  }
})

/**
 * Save workspace endpoint
 * POST /api/v1/workspaces/:workspace/save
 * Body: { filename?: string }
 */
router.post('/workspaces/:workspace/save', async (req, res, next) => {
  try {
    const workspaceId = req.params.workspace
    const workspace = WorkspaceRegistry.getInstance().get(workspaceId)
    if (!workspace) {
      return next(new HttpError('Workspace not found', 'ERR_WORKSPACE_NOT_FOUND', 404))
    }

    const { filename } = req.body || {}
    let filePath

    if (filename) {
      filePath = await workspace.api.workspace.saveAs(filename)
    } else {
      // Use existing file path or generate a new one
      filePath = workspace.state.data?._filePath
      if (!filePath) {
        const workspaceName = workspace.state.data?._title || 'Unnamed'
        filePath = await workspace.api.workspace.saveAs(workspaceName)
      } else {
        filePath = await workspace.api.workspace.save(filePath)
      }
    }

    // Return success with file path
    res.json({
      success: true,
      filePath,
      filename: path.basename(filePath)
    })
  } catch (err) {
    next(new HttpError(err.message || 'Failed to save workspace', 'ERR_SAVE_WORKSPACE', 500))
  }
})

/**
 * List all saved workspaces
 * GET /api/v1/workspaces/list
 */
router.get('/workspaces/list', async (req, res, next) => {
  try {
    // We need a workspace instance to access the API, but we can use any workspace
    // or create a temporary one. Actually, we can call the command directly.
    // Let's use a simpler approach - call the list method directly
    const paths = require('../paths')
    const fs = require('fs')

    if (!fs.existsSync(paths.workspaces)) {
      return res.json([])
    }

    const files = await fs.promises.readdir(paths.workspaces)
    const workspaceFiles = files.filter(file => file.endsWith(`.${ProjectFile.extensions.workspace}`))

    const workspaces = await Promise.all(
      workspaceFiles.map(async (filename) => {
        const filePath = path.join(paths.workspaces, filename)
        const stats = await fs.promises.stat(filePath)

        // Try to read the workspace to get its title
        let title = filename.replace(`.${ProjectFile.extensions.workspace}`, '')
        try {
          const workspace = await ProjectFile.main.readWorkspace(filePath)
          title = workspace?.state?.data?._title || title
        } catch (err) {
          // Ignore errors reading workspace
        }

        return {
          filePath,
          filename,
          title,
          modified: stats.mtime.getTime()
        }
      })
    )

    // Sort by modified date, most recent first
    workspaces.sort((a, b) => b.modified - a.modified)

    res.json(workspaces)
  } catch (err) {
    next(new HttpError(err.message || 'Failed to list workspaces', 'ERR_LIST_WORKSPACES', 500))
  }
})

/**
 * Open a workspace from a file
 * POST /api/v1/workspaces/open
 * Body: { filePath: string }
 */
router.post('/workspaces/open', async (req, res, next) => {
  try {
    const { filePath } = req.body || {}

    if (!filePath || typeof filePath !== 'string') {
      return next(new HttpError('filePath is required', 'ERR_INVALID_FILEPATH', 400))
    }

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return next(new HttpError('Workspace file not found', 'ERR_FILE_NOT_FOUND', 404))
    }

    // Read and create workspace
    const workspace = await ProjectFile.main.readWorkspace(filePath)
    if (!workspace) {
      return next(new HttpError('Failed to read workspace file', 'ERR_READ_WORKSPACE', 500))
    }

    // Set the file path in the workspace state
    workspace.state.apply({ _filePath: filePath })

    // Add to registry
    WorkspaceRegistry.getInstance().add(workspace)

    res.json({
      success: true,
      workspaceId: workspace.id,
      redirectUrl: `/workspaces/${workspace.id}`
    })
  } catch (err) {
    next(new HttpError(err.message || 'Failed to open workspace', 'ERR_OPEN_WORKSPACE', 500))
  }
})

/**
 * Rename current workspace
 * POST /api/v1/workspaces/:workspace/rename
 * Body: { name: string }
 */
router.post('/workspaces/:workspace/rename', async (req, res, next) => {
  try {
    const workspaceId = req.params.workspace
    const workspace = WorkspaceRegistry.getInstance().get(workspaceId)
    if (!workspace) {
      return next(new HttpError('Workspace not found', 'ERR_WORKSPACE_NOT_FOUND', 404))
    }

    const { name } = req.body || {}
    if (!name || typeof name !== 'string') {
      return next(new HttpError('name is required', 'ERR_INVALID_NAME', 400))
    }

    const newFilePath = await workspace.api.workspace.rename(name)

    res.json({
      success: true,
      filePath: newFilePath,
      filename: path.basename(newFilePath),
      name: name.trim()
    })
  } catch (err) {
    next(new HttpError(err.message || 'Failed to rename workspace', 'ERR_RENAME_WORKSPACE', 500))
  }
})

/**
 * Download workspace endpoint
 * GET /api/v1/workspaces/:workspace/download
 */
router.get('/workspaces/:workspace/download', async (req, res, next) => {
  try {
    const workspaceId = req.params.workspace
    const workspace = WorkspaceRegistry.getInstance().get(workspaceId)
    if (!workspace) {
      return next(new HttpError('Workspace not found', 'ERR_WORKSPACE_NOT_FOUND', 404))
    }

    // Save the workspace first
    let filePath = workspace.state.data?._filePath
    if (!filePath) {
      const workspaceName = workspace.state.data?._title || 'Unnamed'
      filePath = await workspace.api.workspace.saveAs(workspaceName)
    } else {
      filePath = await workspace.api.workspace.save(filePath)
    }

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return next(new HttpError('Workspace file not found', 'ERR_FILE_NOT_FOUND', 404))
    }

    const filename = path.basename(filePath)
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Content-Type', 'application/octet-stream')

    const stream = fs.createReadStream(filePath)
    stream.on('error', () => {
      if (!res.headersSent) {
        next(new HttpError('Error reading workspace file', 'ERR_READ_ERROR', 500))
      }
    })
    stream.pipe(res)
  } catch (err) {
    next(new HttpError(err.message || 'Failed to download workspace', 'ERR_DOWNLOAD_WORKSPACE', 500))
  }
})

module.exports = router
