// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

/**
 * @type { import('../../api').Api }
 */
const bridge = require('bridge')

const streamManager = require('../streamManagerInstance')
const webRTCPreviewManager = require('../webRTCPreviewManagerInstance')

const Logger = require('../../../../lib/Logger')
const logger = new Logger({ name: 'CasparNetworkPlugin' })

/**
 * Start WebRTC proxy for a stream preview (low-latency real-time preview)
 * @param { String } streamId - Stream ID
 * @returns { Promise<String> } WebRTC signaling URL path
 */
async function startPreview (streamId) {
  logger.debug('Starting preview', { streamId })

  // Get output stream
  const stream = streamManager.getOutputStream(streamId)
  if (!stream) {
    throw new Error('Output stream not found')
  }

  // Check if stream is active
  if (stream.status !== 'active') {
    throw new Error('Stream is not active. Please start the stream first.')
  }

  // Check if stream has an SRT URL
  if (!stream.srtUrl) {
    throw new Error('Stream does not have an SRT URL configured')
  }

  // Parse SRT URL to get the connection URL
  // The stream.srtUrl is the listener URL (srt://0.0.0.0:6000?mode=listener...)
  // We need to connect to it as a caller
  let srtConnectionUrl = stream.srtUrl
  try {
    // Convert listener URL to caller URL
    const url = new URL(srtConnectionUrl.replace('srt://', 'http://'))
    const host = url.hostname === '0.0.0.0' ? '127.0.0.1' : url.hostname
    const port = url.port || '6000'
    const params = url.searchParams
    params.set('mode', 'caller') // Change to caller mode
    srtConnectionUrl = `srt://${host}:${port}?${params.toString()}`
    logger.debug('Converted SRT URL for FFmpeg connection', {
      streamId,
      originalUrl: stream.srtUrl,
      connectionUrl: srtConnectionUrl
    })
  } catch (err) {
    logger.warn('Could not parse SRT URL, using as-is', {
      streamId,
      srtUrl: stream.srtUrl,
      error: err.message
    })
  }

  // Start WebRTC preview
  logger.debug('Starting WebRTC preview with SRT URL', {
    streamId,
    srtUrl: srtConnectionUrl,
    streamStatus: stream.status
  })
  await webRTCPreviewManager.startPreview(streamId, srtConnectionUrl)

  // Register message handler with main thread's WebSocket server
  // Access the signaling server from the plugin's main module
  // Since we're in lib/commands/, we need to go up two levels to get to the plugin root
  const webRTCSignalingServer = require('../../index').webRTCSignalingServer
  webRTCSignalingServer.registerStreamHandler(streamId)

  // Get workspace ID from state (if available)
  // The client will add it to the URL, but we can include it here for convenience
  let workspaceId = null
  try {
    const state = await bridge.state.get()
    workspaceId = state?._id
  } catch (err) {
    // Ignore - workspace ID is optional
  }

  // Return signaling URL path (relative path, client will construct full URL)
  // Include workspace ID if available
  let signalingPath = `/api/v1/webrtc?streamId=${encodeURIComponent(streamId)}`
  if (workspaceId) {
    signalingPath += `&workspace=${encodeURIComponent(workspaceId)}`
  }
  logger.debug('Preview started', { streamId, workspaceId, signalingPath })
  return signalingPath
}

/**
 * Stop WebRTC proxy for a stream preview
 * @param { String } streamId - Stream ID
 * @returns { Promise<void> }
 */
async function stopPreview (streamId) {
  logger.debug('Stopping preview', { streamId })

  // Unregister message handler
  // Access the signaling server from the plugin's main module
  const webRTCSignalingServer = require('../../index').webRTCSignalingServer
  webRTCSignalingServer.unregisterStreamHandler(streamId)

  await webRTCPreviewManager.stopPreview(streamId)

  logger.debug('Preview stopped', { streamId })
}

/**
 * Get preview URL for a stream
 * @param { String } streamId - Stream ID
 * @returns { Promise<String|null> } WebRTC signaling URL path or null
 */
async function getPreviewUrl (streamId) {
  const isActive = webRTCPreviewManager.isPreviewActive(streamId)
  if (!isActive) {
    return null
  }

  return `/api/v1/webrtc?streamId=${encodeURIComponent(streamId)}`
}

module.exports = {
  startPreview,
  stopPreview,
  getPreviewUrl
}
