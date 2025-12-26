// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const PreviewBridge = require('./preview/PreviewBridge')

const Logger = require('../../../lib/Logger')
const logger = new Logger({ name: 'CasparNetworkPlugin' })

/**
 * Manages WebRTC preview streams for SRT output streams
 * Uses PreviewBridge which follows mediasoup-demo broadcaster pattern
 * Pipeline: SRT → FFmpeg (SRT to RTP) → PreviewBridge (RTP to WebRTC) → Browser
 */
class WebRTCPreviewManager {
  constructor () {
    /** @type {Map<string, PreviewBridge>} */
    this.activePreviews = new Map()
  }

  /**
   * Start WebRTC preview for an SRT output stream
   * @param {string} streamId - Stream ID
   * @param {string} srtUrl - SRT URL to connect to
   * @returns {Promise<{bridge: PreviewBridge}>}
   */
  async startPreview (streamId, srtUrl) {
    // Check if preview already exists
    if (this.activePreviews.has(streamId)) {
      const existing = this.activePreviews.get(streamId)
      logger.debug('Preview already exists for stream', { streamId })
      return {
        bridge: existing
      }
    }

    logger.debug('Starting WebRTC preview', { streamId, srtUrl })

    // Create PreviewBridge instance
    // Use larger port range by default (100 ports) to avoid port exhaustion
    const bridge = new PreviewBridge({
      rtcMinPort: parseInt(process.env.WEBRTC_MIN_PORT || '10000', 10),
      rtcMaxPort: parseInt(process.env.WEBRTC_MAX_PORT || '10099', 10)
    })

    // Initialize mediasoup
    await bridge.initialize()

    // Start preview (this creates PlainTransports, Producers, then starts FFmpeg)
    await bridge.startPreview(streamId, srtUrl)

    // Store preview
    this.activePreviews.set(streamId, bridge)

    logger.debug('WebRTC preview started', { streamId })

    return {
      bridge
    }
  }

  /**
   * Stop WebRTC preview for a stream
   * @param {string} streamId - Stream ID
   */
  async stopPreview (streamId) {
    const bridge = this.activePreviews.get(streamId)
    if (!bridge) {
      logger.warn('Preview not found for stream', { streamId })
      return
    }

    logger.debug('Stopping WebRTC preview', { streamId })

    // Stop preview (stops FFmpeg and cleans up)
    await bridge.stopPreview(streamId)

    // Remove from active previews
    this.activePreviews.delete(streamId)

    logger.debug('WebRTC preview stopped', { streamId })
  }

  /**
   * Get preview bridge for a stream
   * @param {string} streamId - Stream ID
   * @returns {PreviewBridge|null}
   */
  getPreviewBridge (streamId) {
    const bridge = this.activePreviews.get(streamId)
    return bridge || null
  }

  /**
   * Check if preview is active for a stream
   * @param {string} streamId - Stream ID
   * @returns {boolean}
   */
  isPreviewActive (streamId) {
    return this.activePreviews.has(streamId)
  }

  /**
   * Stop all active previews
   */
  async stopAll () {
    const streamIds = Array.from(this.activePreviews.keys())
    for (const streamId of streamIds) {
      await this.stopPreview(streamId)
    }
  }
}

module.exports = WebRTCPreviewManager
