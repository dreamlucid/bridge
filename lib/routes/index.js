// SPDX-FileCopyrightText: 2022 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const { Router } = require('express')
const router = new Router()
const path = require('path')
const fs = require('fs')

const HttpError = require('../error/HttpError')
const StaticFileRegistry = require('../StaticFileRegistry')

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

module.exports = router
