// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const fs = require('fs')
const path = require('path')
const os = require('os')

const Logger = require('../../../lib/Logger')
const logger = new Logger({ name: 'CasparNetworkPlugin' })

/**
 * File-based registry for WebRTC signaling server
 * This works across worker threads by using a file as shared storage
 */
class FileBasedRegistry {
  constructor () {
    this.registryPath = path.join(os.tmpdir(), 'bridge-webrtc-signaling-registry.json')
  }

  setSignalingServer (server) {
    try {
      // Store server metadata (we can't serialize the actual server object)
      // Instead, we'll use a flag to indicate the server is ready
      const data = {
        initialized: true,
        hasWss: !!(server && server.wss),
        timestamp: Date.now()
      }
      fs.writeFileSync(this.registryPath, JSON.stringify(data), 'utf8')
      logger.debug('WebRTC signaling server registered in file registry', data)
    } catch (err) {
      logger.error('Error writing to file registry', { error: err.message })
    }
  }

  getSignalingServerInfo () {
    try {
      if (fs.existsSync(this.registryPath)) {
        const data = JSON.parse(fs.readFileSync(this.registryPath, 'utf8'))
        return data
      }
    } catch (err) {
      logger.debug('Error reading file registry', { error: err.message })
    }
    return null
  }

  isReady () {
    const info = this.getSignalingServerInfo()
    return info && info.initialized && info.hasWss
  }
}

module.exports = new FileBasedRegistry()


