// SPDX-FileCopyrightText: 2025
//
// SPDX-License-Identifier: MIT

const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')

const multer = require('multer')
const express = require('express')

const HttpError = require('../error/HttpError')
const WorkspaceRegistry = require('../WorkspaceRegistry')

const PLUGIN_STATE_KEY = 'bridge-plugin-caspar-media'
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
const CHUNK_SIZE_BYTES = 8 * 1024 * 1024
const SESSION_TTL_MS = 24 * 60 * 60 * 1000

/** @type {Map<string, object>} */
const chunkSessions = new Map()

const upload = multer({
  storage: multer.diskStorage({
    destination (_req, _file, cb) {
      cb(null, os.tmpdir())
    },
    filename (_req, file, cb) {
      const safe = (file.originalname || 'upload').replace(/[^\w.\-()+ ]/g, '_')
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${safe}`)
    }
  }),
  limits: { fileSize: MAX_FILE_BYTES }
})

const rawChunkParser = express.raw({
  type: 'application/octet-stream',
  limit: CHUNK_SIZE_BYTES + 1024 * 1024
})

/**
 * @param {string} rel
 * @returns {string[]}
 */
function safeRelativeSegments (rel) {
  if (!rel || typeof rel !== 'string') {
    return []
  }
  return rel
    .split(/[/\\]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => s !== '.' && s !== '..')
}

function getWorkspaceRoots (workspaceId) {
  const workspace = WorkspaceRegistry.getInstance().get(workspaceId)
  if (!workspace) {
    return { error: new HttpError('Workspace not found', 'ERR_WORKSPACE_NOT_FOUND', 404) }
  }
  const settings = workspace.state.data.plugins?.[PLUGIN_STATE_KEY]?.settings
  if (!settings || typeof settings !== 'object') {
    return {
      error: new HttpError(
        'Caspar media is not set up for this workspace: no plugin settings. The media library talks to Caspar over the network; delete and upload need local paths from casparcg.config on the Bridge server. Open Settings → Caspar CG → Caspar media, set the config file path, and save.',
        'ERR_CASPAR_MEDIA_NOT_CONFIGURED',
        400
      )
    }
  }
  const roots = settings.resolvedRoots
  if (!roots || typeof roots !== 'object') {
    const parseBit = settings.parseError
      ? ` Parse error: ${settings.parseError}`
      : ''
    return {
      error: new HttpError(
        `Caspar media has no resolved library paths (casparcg.config was not saved successfully or paths are missing).${parseBit} Open Settings → Caspar CG → Caspar media, fix the config path, and save.`,
        'ERR_CASPAR_MEDIA_NOT_CONFIGURED',
        400
      )
    }
  }
  return { workspace, roots }
}

function assertTargetRoot (roots, target) {
  if (!['media', 'template', 'font'].includes(target)) {
    return { error: new HttpError('Invalid target (media|template|font)', 'ERR_INVALID_TARGET', 400) }
  }
  const root = roots[target]
  if (!root || typeof root !== 'string') {
    return { error: new HttpError(`Target "${target}" is not available`, 'ERR_TARGET_UNAVAILABLE', 400) }
  }
  return { rootResolved: path.resolve(root) }
}

/**
 * Whether Caspar logical path `norm` refers to relative file path `rel` (POSIX slashes).
 * Caspar CLS/TLS casing often differs from the filesystem; match case-insensitively.
 * @param {string} rel
 * @param {string} norm
 */
function relativePathMatchesDeleteLogical (rel, norm) {
  const r = rel.replace(/\\/g, '/')
  const n = norm.replace(/\\/g, '/')
  if (r.toLowerCase() === n.toLowerCase()) {
    return true
  }
  const rl = r.toLowerCase()
  const nl = n.toLowerCase()
  return rl.startsWith(nl + '.')
}

/**
 * Files under root matching Caspar logical name (exact rel, or rel.ext; case-insensitive)
 * @param {string} rootResolved
 * @param {string} logicalPath posix-style, no leading slash
 * @returns {string[]}
 */
function findDeleteMatches (rootResolved, logicalPath) {
  const norm = String(logicalPath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '')
  if (!norm || norm.includes('..')) {
    return []
  }
  const matches = []
  function walk (dir) {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        walk(full)
      } else if (ent.isFile()) {
        let rel
        try {
          rel = path.relative(rootResolved, full).replace(/\\/g, '/')
        } catch {
          continue
        }
        if (relativePathMatchesDeleteLogical(rel, norm)) {
          matches.push(full)
        }
      }
    }
  }
  walk(rootResolved)
  return matches
}

function cleanupExpiredChunkSessions () {
  const now = Date.now()
  for (const [id, s] of chunkSessions) {
    if (now - s.createdAt > SESSION_TTL_MS) {
      chunkSessions.delete(id)
      fs.promises.unlink(s.partPath).catch(() => {})
    }
  }
}

function registerCasparMediaRoutes (router) {
  router.post(
    '/workspaces/:workspace/caspar-media/upload',
    upload.single('file'),
    async (req, res, next) => {
      try {
        const workspaceId = req.params.workspace
        const { error, roots } = getWorkspaceRoots(workspaceId)
        if (error) {
          return next(error)
        }

        const target = (req.body?.target || '').trim()
        const { error: tErr, rootResolved } = assertTargetRoot(roots, target)
        if (tErr) {
          return next(tErr)
        }

        if (!req.file) {
          return next(new HttpError('Missing file field', 'ERR_MISSING_FILE', 400))
        }

        const segments = safeRelativeSegments(req.body?.relativePath)
        const baseName = path.basename(req.file.originalname || req.file.filename || 'file')

        if (!baseName || baseName === '.' || baseName === '..') {
          await fs.promises.unlink(req.file.path).catch(() => {})
          return next(new HttpError('Invalid file name', 'ERR_INVALID_FILENAME', 400))
        }

        const destDir = path.resolve(rootResolved, ...segments)
        if (destDir !== rootResolved && !destDir.startsWith(rootResolved + path.sep)) {
          await fs.promises.unlink(req.file.path).catch(() => {})
          return next(new HttpError('Path escapes media root', 'ERR_PATH_ESCAPE', 400))
        }

        const destPath = path.resolve(destDir, baseName)
        if (destPath !== rootResolved && !destPath.startsWith(rootResolved + path.sep)) {
          await fs.promises.unlink(req.file.path).catch(() => {})
          return next(new HttpError('Path escapes media root', 'ERR_PATH_ESCAPE', 400))
        }

        await fs.promises.mkdir(destDir, { recursive: true })
        await fs.promises.rename(req.file.path, destPath)

        res.json({ success: true, path: destPath })
      } catch (err) {
        if (req.file?.path) {
          await fs.promises.unlink(req.file.path).catch(() => {})
        }
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return next(new HttpError('File too large', 'ERR_FILE_TOO_LARGE', 413))
          }
          return next(new HttpError(err.message, 'ERR_UPLOAD', 400))
        }
        next(err)
      }
    }
  )

  router.post(
    '/workspaces/:workspace/caspar-media/delete',
    async (req, res, next) => {
      try {
        const workspaceId = req.params.workspace
        const { error, roots } = getWorkspaceRoots(workspaceId)
        if (error) {
          return next(error)
        }

        const target = (req.body?.target || '').trim()
        const { error: tErr, rootResolved } = assertTargetRoot(roots, target)
        if (tErr) {
          return next(tErr)
        }

        const logicalName = (req.body?.logicalName || req.body?.relativePath || '').trim()
        if (!logicalName) {
          return next(new HttpError('Missing logicalName or relativePath', 'ERR_MISSING_PATH', 400))
        }

        const matches = findDeleteMatches(rootResolved, logicalName)
        if (matches.length === 0) {
          return next(new HttpError('No matching file under library root', 'ERR_DELETE_NOT_FOUND', 404))
        }
        if (matches.length > 1) {
          return next(new HttpError(
            `Ambiguous: ${matches.length} files match "${logicalName}"; remove duplicates or delete from disk manually`,
            'ERR_DELETE_AMBIGUOUS',
            409
          ))
        }

        await fs.promises.unlink(matches[0])
        res.json({ success: true, path: matches[0] })
      } catch (err) {
        next(err)
      }
    }
  )

  router.post(
    '/workspaces/:workspace/caspar-media/upload/init',
    async (req, res, next) => {
      try {
        cleanupExpiredChunkSessions()
        const workspaceId = req.params.workspace
        const { error, roots } = getWorkspaceRoots(workspaceId)
        if (error) {
          return next(error)
        }

        const target = (req.body?.target || '').trim()
        const { error: tErr, rootResolved } = assertTargetRoot(roots, target)
        if (tErr) {
          return next(tErr)
        }

        const fileName = path.basename((req.body?.fileName || '').trim() || 'upload')
        const fileSize = Number(req.body?.fileSize)
        if (!fileName || fileName === '.' || fileName === '..') {
          return next(new HttpError('Invalid fileName', 'ERR_INVALID_FILENAME', 400))
        }
        if (!Number.isFinite(fileSize) || fileSize < 1 || fileSize > MAX_FILE_BYTES) {
          return next(new HttpError('Invalid fileSize', 'ERR_INVALID_SIZE', 400))
        }

        const segments = safeRelativeSegments(req.body?.relativePath || '')
        const destDir = path.resolve(rootResolved, ...segments)
        if (destDir !== rootResolved && !destDir.startsWith(rootResolved + path.sep)) {
          return next(new HttpError('Path escapes media root', 'ERR_PATH_ESCAPE', 400))
        }
        const destPath = path.resolve(destDir, fileName)
        if (destPath !== rootResolved && !destPath.startsWith(rootResolved + path.sep)) {
          return next(new HttpError('Path escapes media root', 'ERR_PATH_ESCAPE', 400))
        }

        const uploadId = crypto.randomBytes(24).toString('hex')
        const partPath = path.join(os.tmpdir(), `bridge-caspar-media-${uploadId}.part`)
        await fs.promises.writeFile(partPath, Buffer.alloc(0))

        chunkSessions.set(uploadId, {
          workspaceId,
          target,
          rootResolved,
          segments,
          fileName,
          fileSize,
          partPath,
          destPath,
          receivedBytes: 0,
          createdAt: Date.now()
        })

        res.json({ uploadId, chunkSize: CHUNK_SIZE_BYTES })
      } catch (err) {
        next(err)
      }
    }
  )

  router.get(
    '/workspaces/:workspace/caspar-media/upload/status',
    async (req, res, next) => {
      try {
        const workspaceId = req.params.workspace
        const uploadId = (req.query.uploadId || '').trim()
        const session = chunkSessions.get(uploadId)
        if (!session) {
          return next(new HttpError('Unknown or expired uploadId', 'ERR_UPLOAD_SESSION', 404))
        }
        if (session.workspaceId !== workspaceId) {
          return next(new HttpError('Upload does not belong to this workspace', 'ERR_UPLOAD_WORKSPACE', 403))
        }
        if (session.receivedBytes < session.fileSize) {
          const aligned = Math.floor(session.receivedBytes / CHUNK_SIZE_BYTES) * CHUNK_SIZE_BYTES
          if (aligned !== session.receivedBytes) {
            await fs.promises.truncate(session.partPath, aligned)
            session.receivedBytes = aligned
          }
        }
        res.json({
          receivedBytes: session.receivedBytes,
          fileSize: session.fileSize,
          chunkSize: CHUNK_SIZE_BYTES
        })
      } catch (err) {
        next(err)
      }
    }
  )

  router.post(
    '/workspaces/:workspace/caspar-media/upload/chunk',
    rawChunkParser,
    async (req, res, next) => {
      try {
        const workspaceId = req.params.workspace
        const uploadId = (req.query.uploadId || '').trim()
        const chunkIndex = parseInt(req.query.chunkIndex, 10)
        const session = chunkSessions.get(uploadId)
        if (!session) {
          return next(new HttpError('Unknown or expired uploadId', 'ERR_UPLOAD_SESSION', 404))
        }
        if (session.workspaceId !== workspaceId) {
          return next(new HttpError('Upload does not belong to this workspace', 'ERR_UPLOAD_WORKSPACE', 403))
        }
        if (!Number.isFinite(chunkIndex) || chunkIndex < 0) {
          return next(new HttpError('Invalid chunkIndex', 'ERR_CHUNK_INDEX', 400))
        }

        const expectedOffset = chunkIndex * CHUNK_SIZE_BYTES
        if (session.receivedBytes !== expectedOffset) {
          return next(new HttpError(
            `Chunk out of sequence: expected offset ${session.receivedBytes}, got chunk ${chunkIndex}`,
            'ERR_CHUNK_ORDER',
            409
          ))
        }

        const buf = req.body instanceof Buffer ? req.body : Buffer.from(req.body || [])
        if (buf.length === 0) {
          return next(new HttpError('Empty chunk', 'ERR_EMPTY_CHUNK', 400))
        }
        if (session.receivedBytes + buf.length > session.fileSize) {
          return next(new HttpError('Chunk exceeds declared file size', 'ERR_CHUNK_OVERFLOW', 400))
        }

        await fs.promises.appendFile(session.partPath, buf)
        session.receivedBytes += buf.length

        res.json({ success: true, receivedBytes: session.receivedBytes })
      } catch (err) {
        next(err)
      }
    }
  )

  router.post(
    '/workspaces/:workspace/caspar-media/upload/cancel',
    async (req, res, next) => {
      try {
        const workspaceId = req.params.workspace
        const uploadId = (req.body?.uploadId || '').trim()
        const session = chunkSessions.get(uploadId)
        if (session && session.workspaceId !== workspaceId) {
          return next(new HttpError('Upload does not belong to this workspace', 'ERR_UPLOAD_WORKSPACE', 403))
        }
        if (session) {
          chunkSessions.delete(uploadId)
          await fs.promises.unlink(session.partPath).catch(() => {})
        }
        res.json({ success: true })
      } catch (err) {
        next(err)
      }
    }
  )

  router.post(
    '/workspaces/:workspace/caspar-media/upload/complete',
    async (req, res, next) => {
      try {
        const workspaceId = req.params.workspace
        const uploadId = (req.body?.uploadId || '').trim()
        const session = chunkSessions.get(uploadId)
        if (!session) {
          return next(new HttpError('Unknown or expired uploadId', 'ERR_UPLOAD_SESSION', 404))
        }
        if (session.workspaceId !== workspaceId) {
          return next(new HttpError('Upload does not belong to this workspace', 'ERR_UPLOAD_WORKSPACE', 403))
        }
        if (session.receivedBytes !== session.fileSize) {
          return next(new HttpError(
            `Incomplete upload: ${session.receivedBytes} of ${session.fileSize} bytes`,
            'ERR_INCOMPLETE',
            400
          ))
        }

        const destDir = path.dirname(session.destPath)
        await fs.promises.mkdir(destDir, { recursive: true })
        await fs.promises.rename(session.partPath, session.destPath)
        chunkSessions.delete(uploadId)

        res.json({ success: true, path: session.destPath })
      } catch (err) {
        next(err)
      }
    }
  )
}

module.exports = {
  registerCasparMediaRoutes,
  PLUGIN_STATE_KEY,
  MAX_FILE_BYTES,
  CHUNK_SIZE_BYTES
}
