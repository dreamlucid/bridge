// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const Logger = require('../../../../lib/Logger')
const logger = new Logger({ name: 'CasparNetworkPlugin' })

const { getStreamConfig } = require('../streamHelpers')

/**
 * Start WebRTC proxy for a stream preview (low-latency real-time preview)
 * @param { String } streamId - Stream ID
 * @returns { Promise<String> } WebRTC signaling URL
 */
async function startPreview (streamId) {
  logger.debug('Starting WebRTC preview for stream', streamId)

  const stream = await getStreamConfig(streamId)
  if (!stream) {
    throw new Error('Stream not found')
  }

  // Get the singleton WebRTC proxy instance from index.js
  const pluginIndex = require('../../index')
  const webrtcProxy = pluginIndex.webrtcProxy

  let previewSrtUrl = null

  if (stream.type === 'input') {
    // Preview is only available for output streams
    // Input streams should only show status information from CasparCG
    throw new Error('Preview is not available for input streams. Please use an output stream for preview functionality.')
  } else if (stream.type === 'output') {
    // For output streams, use the existing output SRT URL
    // The output stream is in listener mode, so we connect as caller
    // Replace mode=listener with mode=caller, or add mode=caller if not present
    if (stream.srtUrl.includes('mode=listener')) {
      previewSrtUrl = stream.srtUrl.replace('mode=listener', 'mode=caller')
    } else if (stream.srtUrl.includes('?')) {
      previewSrtUrl = stream.srtUrl + '&mode=caller'
    } else {
      previewSrtUrl = stream.srtUrl + '?mode=caller&latency=500&transtype=live'
    }
    logger.debug('Using output stream SRT URL for preview', { streamId, previewSrtUrl })
  } else {
    throw new Error('Unknown stream type')
  }

  if (!previewSrtUrl) {
    throw new Error('Preview SRT URL not available')
  }

  // Start WebRTC proxy (low-latency real-time preview)
  // Note: Preview streams are created without audio (audio: false), so we disable audio encoding
  // Codec will be auto-detected (prefers GPU encoders like h264_vaapi, h264_nvenc, etc.)
  // Don't specify videoCodec - let it auto-detect the best available encoder
  const signalingUrl = await webrtcProxy.startProxy(streamId, previewSrtUrl, {
    // videoCodec: undefined - will be auto-detected by detectAvailableCodec()
    audioCodec: 'libopus',
    videoBitrate: '2000k',
    audioBitrate: '128k',
    preset: 'p4', // Used for NVIDIA encoder if available
    tune: 'll', // Used for NVIDIA encoder if available
    gop: 30, // GOP size
    hasAudio: false // Preview streams don't have audio
  })

  logger.debug('WebRTC preview started', { streamId, signalingUrl, previewSrtUrl })
  return signalingUrl
}

/**
 * Stop WebRTC proxy for a stream preview
 * @param { String } streamId - Stream ID
 * @returns { Promise<void> }
 */
async function stopPreview (streamId) {
  logger.debug('Stopping WebRTC preview for stream', streamId)

  // Get the singleton WebRTC proxy instance from index.js
  const pluginIndex = require('../../index')
  const webrtcProxy = pluginIndex.webrtcProxy

  webrtcProxy.stopProxy(streamId)
  logger.debug('WebRTC preview stopped', streamId)
}

/**
 * Get preview URL for a stream
 * @param { String } streamId - Stream ID
 * @returns { Promise<String|null> } WebRTC signaling URL or null
 */
async function getPreviewUrl (streamId) {
  const pluginIndex = require('../../index')
  const webrtcProxy = pluginIndex.webrtcProxy

  const proxyInfo = webrtcProxy.getProxy(streamId)
  if (proxyInfo) {
    // If using Bridge server integration (port = 0), use relative path
    if (webrtcProxy.port === 0) {
      return `/api/v1/webrtc-signaling?streamId=${streamId}`
    } else if (webrtcProxy.port) {
      return `ws://127.0.0.1:${webrtcProxy.port}?streamId=${streamId}`
    }
  }
  return null
}

module.exports = {
  startPreview,
  stopPreview,
  getPreviewUrl
}
