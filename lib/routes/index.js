// SPDX-FileCopyrightText: 2022 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const { Router } = require('express')
const router = new Router()
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

const multer = require('multer')

const HttpError = require('../error/HttpError')
const paths = require('../paths')
const StaticFileRegistry = require('../StaticFileRegistry')
const WorkspaceRegistry = require('../WorkspaceRegistry')
const ProjectFile = require('../ProjectFile')
const { registerCasparMediaRoutes } = require('./casparMedia')

const WORKSPACE_UPLOAD_MAX_BYTES = 100 * 1024 * 1024

const workspaceImportUpload = multer({
  storage: multer.diskStorage({
    destination (_req, _file, cb) {
      try {
        if (!fs.existsSync(paths.temp)) {
          fs.mkdirSync(paths.temp, { recursive: true })
        }
        cb(null, paths.temp)
      } catch (err) {
        cb(err)
      }
    },
    filename (_req, file, cb) {
      const safe = (file.originalname || 'upload').replace(/[^\w.\-()+ ]/g, '_')
      cb(null, `ws-import-${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${safe}`)
    }
  }),
  limits: { fileSize: WORKSPACE_UPLOAD_MAX_BYTES },
  fileFilter (_req, file, cb) {
    const name = (file.originalname || '').toLowerCase()
    if (name.endsWith('.bridge')) {
      cb(null, true)
    } else {
      cb(new HttpError('File must be a .bridge workspace', 'ERR_INVALID_FILETYPE', 400))
    }
  }
})

/**
 * @param {string} filePath
 * @returns {string|null} Resolved path if under paths.workspaces, else null
 */
function resolvedPathUnderWorkspaces (filePath) {
  const resolved = path.resolve(filePath)
  const root = path.resolve(paths.workspaces)
  const rel = path.relative(root, resolved)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return null
  }
  return resolved
}

/**
 * @param {string} desiredFullPath
 * @returns {string} Path that does not exist yet
 */
function allocateUniqueWorkspacePath (desiredFullPath) {
  const ext = `.${ProjectFile.extensions.workspace}`
  const dir = path.dirname(desiredFullPath)
  const stem = path.basename(desiredFullPath, ext)
  let candidate = path.join(dir, `${stem}${ext}`)
  let n = 2
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}_${n}${ext}`)
    n += 1
  }
  return candidate
}

/**
 * @param {string} originalname
 * @returns {string} basename like `name.bridge`
 */
function sanitizeImportedWorkspaceBasename (originalname) {
  const ext = `.${ProjectFile.extensions.workspace}`
  const base = path.basename(originalname || `imported${ext}`).replace(/\\/g, '/')
  const stem = base.replace(/\.bridge$/i, '').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/gi, '') || 'imported'
  return `${stem}${ext}`
}

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

function workspaceImportUploadHandler (req, res, next) {
  workspaceImportUpload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(new HttpError('Workspace file too large (max 100 MB)', 'ERR_FILE_TOO_LARGE', 400))
      }
      if (err instanceof HttpError) {
        return next(err)
      }
      return next(new HttpError(err.message || 'Upload failed', 'ERR_UPLOAD_WORKSPACE', 400))
    }
    next()
  })
}

/**
 * Import a workspace file into paths.workspaces
 * POST /api/v1/workspaces/upload
 * Multipart field name: file (.bridge)
 */
router.post('/workspaces/upload', workspaceImportUploadHandler, async (req, res, next) => {
  const tmpPath = req.file?.path
  if (!tmpPath) {
    return next(new HttpError('No file uploaded', 'ERR_NO_FILE', 400))
  }

  async function cleanupTemp () {
    await fs.promises.unlink(tmpPath).catch(() => {})
  }

  try {
    const workspace = await ProjectFile.main.readWorkspace(tmpPath)
    if (!workspace) {
      await cleanupTemp()
      return next(new HttpError('Invalid workspace file (missing state.json or corrupt)', 'ERR_INVALID_WORKSPACE', 400))
    }

    const title = workspace.state?.data?._title || path.basename(req.file.originalname || 'imported', '.bridge')
    const basename = sanitizeImportedWorkspaceBasename(req.file.originalname)

    if (!fs.existsSync(paths.workspaces)) {
      fs.mkdirSync(paths.workspaces, { recursive: true })
    }

    const desiredPath = path.join(paths.workspaces, basename)
    const destPath = allocateUniqueWorkspacePath(desiredPath)

    await fs.promises.copyFile(tmpPath, destPath)
    await cleanupTemp()

    res.json({
      filePath: destPath,
      filename: path.basename(destPath),
      title
    })
  } catch (err) {
    await cleanupTemp()
    next(new HttpError(err.message || 'Failed to import workspace', 'ERR_IMPORT_WORKSPACE', 500))
  }
})

/**
 * Delete a saved workspace file under paths.workspaces
 * POST /api/v1/workspaces/delete
 * Body: { filePath: string }
 */
router.post('/workspaces/delete', async (req, res, next) => {
  try {
    const { filePath } = req.body || {}
    if (!filePath || typeof filePath !== 'string') {
      return next(new HttpError('filePath is required', 'ERR_INVALID_FILEPATH', 400))
    }

    const resolved = resolvedPathUnderWorkspaces(filePath)
    if (!resolved) {
      return next(new HttpError('Path must be under workspaces directory', 'ERR_INVALID_PATH', 400))
    }

    if (!resolved.toLowerCase().endsWith(`.${ProjectFile.extensions.workspace}`)) {
      return next(new HttpError('Not a workspace file', 'ERR_INVALID_FILETYPE', 400))
    }

    if (!fs.existsSync(resolved)) {
      return next(new HttpError('Workspace file not found', 'ERR_FILE_NOT_FOUND', 404))
    }

    const stat = await fs.promises.stat(resolved)
    if (!stat.isFile()) {
      return next(new HttpError('Not a file', 'ERR_INVALID_PATH', 400))
    }

    for (const w of WorkspaceRegistry.getInstance().list()) {
      const fp = w.state?.data?._filePath
      if (fp && path.resolve(fp) === resolved) {
        return next(new HttpError('Workspace is currently open', 'ERR_WORKSPACE_IN_USE', 409))
      }
    }

    await fs.promises.unlink(resolved)
    res.json({ success: true })
  } catch (err) {
    next(new HttpError(err.message || 'Failed to delete workspace', 'ERR_DELETE_WORKSPACE', 500))
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
