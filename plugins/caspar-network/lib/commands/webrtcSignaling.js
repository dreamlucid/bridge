// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

/**
 * @type { import('../../api').Api }
 */
const bridge = require('bridge')

const webRTCPreviewManager = require('../webRTCPreviewManagerInstance')

const Logger = require('../../../../lib/Logger')
const logger = new Logger({ name: 'CasparNetworkPlugin' })

/**
 * Get router RTP capabilities for WebRTC signaling
 * @param {string} streamId - Stream ID
 * @returns {Promise<Object>} Router RTP capabilities
 */
async function getRouterRtpCapabilities (streamId) {
  const bridge = webRTCPreviewManager.getPreviewBridge(streamId)
  if (!bridge) {
    throw new Error('Preview not started for this stream')
  }
  return bridge.getRtpCapabilities()
}

/**
 * Create WebRTC transport for WebRTC signaling
 * @param {string} streamId - Stream ID
 * @returns {Promise<Object>} Transport info
 */
async function createWebRtcTransport (streamId) {
  const bridge = webRTCPreviewManager.getPreviewBridge(streamId)
  if (!bridge) {
    throw new Error('Preview not started for this stream')
  }
  return await bridge.createWebRTCTransport(streamId)
}

/**
 * Connect WebRTC transport
 * @param {string} streamId - Stream ID
 * @param {Object} dtlsParameters - DTLS parameters
 * @returns {Promise<void>}
 */
async function connectWebRtcTransport (streamId, dtlsParameters) {
  const bridge = webRTCPreviewManager.getPreviewBridge(streamId)
  if (!bridge) {
    throw new Error('Preview not started for this stream')
  }
  await bridge.connectWebRTCTransport(streamId, dtlsParameters)
}

/**
 * Create consumer for WebRTC signaling
 * @param {string} streamId - Stream ID
 * @param {string} transportId - Transport ID
 * @param {Object} rtpCapabilities - RTP capabilities
 * @returns {Promise<Object>} Consumer info
 */
async function createConsumer (streamId, transportId, rtpCapabilities) {
  const bridge = webRTCPreviewManager.getPreviewBridge(streamId)
  if (!bridge) {
    throw new Error('Preview not started for this stream')
  }
  return await bridge.createConsumer(streamId, transportId, rtpCapabilities)
}

module.exports = {
  getRouterRtpCapabilities,
  createWebRtcTransport,
  connectWebRtcTransport,
  createConsumer
}

