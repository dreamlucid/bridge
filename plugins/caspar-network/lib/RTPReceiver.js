// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const dgram = require('dgram')
const Logger = require('../../../lib/Logger')
const logger = new Logger({ name: 'CasparNetworkPlugin' })

/**
 * Receives RTP packets from FFmpeg and forwards them to WebRTC bridge
 */
class RTPReceiver {
  constructor (port, streamId) {
    this.port = port
    this.streamId = streamId
    this.socket = null
    this.isListening = false
    this.packetCount = 0
    this.onPacket = null // Callback: (packet, rinfo) => {}
  }

  /**
   * Start listening for RTP packets
   * @param {Function} onPacket - Callback when packet is received: (packet, rinfo) => {}
   */
  start (onPacket) {
    if (this.isListening) {
      logger.warn('RTPReceiver already listening', { streamId: this.streamId, port: this.port })
      return
    }

    this.onPacket = onPacket
    this.socket = dgram.createSocket('udp4')

    this.socket.on('message', (msg, rinfo) => {
      this.packetCount++
      if (this.onPacket) {
        this.onPacket(msg, rinfo)
      }
    })

    this.socket.on('error', (err) => {
      logger.error('RTPReceiver socket error', {
        streamId: this.streamId,
        port: this.port,
        error: err.message
      })
    })

    this.socket.on('listening', () => {
      const address = this.socket.address()
      logger.debug('RTPReceiver listening', {
        streamId: this.streamId,
        address: address.address,
        port: address.port
      })
      this.isListening = true
    })

    this.socket.bind(this.port, '127.0.0.1', () => {
      // Socket is now bound and listening
    })

    logger.info('RTPReceiver started', {
      streamId: this.streamId,
      port: this.port
    })
  }

  /**
   * Stop listening for RTP packets
   */
  stop () {
    if (!this.isListening || !this.socket) {
      return
    }

    this.socket.close(() => {
      logger.debug('RTPReceiver stopped', {
        streamId: this.streamId,
        port: this.port,
        totalPackets: this.packetCount
      })
    })

    this.isListening = false
    this.socket = null
    this.onPacket = null
    this.packetCount = 0
  }

  /**
   * Get statistics
   */
  getStats () {
    return {
      isListening: this.isListening,
      port: this.port,
      packetCount: this.packetCount
    }
  }
}

module.exports = RTPReceiver
