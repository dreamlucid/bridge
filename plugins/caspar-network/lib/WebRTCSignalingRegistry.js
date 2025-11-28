// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

/**
 * Simple registry to store WebRTC signaling server instance
 * Uses process object to work across worker threads
 * This is a POC approach - in production, you'd want a cleaner plugin registry
 */

const Logger = require('../../../lib/Logger')
const logger = new Logger({ name: 'CasparNetworkPlugin' })

// Use process object to share across worker threads (process is shared, global is not)
// Initialize the registry if it doesn't exist (might be initialized in main thread or worker thread)
if (!process.__bridge_webrtc_signaling_registry) {
  process.__bridge_webrtc_signaling_registry = {
    signalingServer: null
  }
  logger.debug('Initialized WebRTC signaling registry in process object')
} else {
  logger.debug('WebRTC signaling registry already exists in process object')
}

class WebRTCSignalingRegistry {
  setSignalingServer (server) {
    process.__bridge_webrtc_signaling_registry.signalingServer = server
    logger.debug('WebRTC signaling server registered in process registry', {
      hasServer: !!server,
      hasWss: !!(server && server.wss)
    })
  }

  getSignalingServer () {
    const server = process.__bridge_webrtc_signaling_registry.signalingServer
    logger.debug('Getting WebRTC signaling server from process registry', {
      hasServer: !!server,
      hasWss: !!(server && server.wss)
    })
    return server
  }
}

// Export singleton instance
module.exports = new WebRTCSignalingRegistry()
