// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const webRTCPreviewManager = require('./webRTCPreviewManagerInstance')

const Logger = require('../../../lib/Logger')
const logger = new Logger({ name: 'CasparNetworkPlugin' })

/**
 * WebRTC Signaling Server for mediasoup
 * Registers message handlers with the main thread's WebSocket server
 * The actual WebSocket server is created in lib/server.js (main thread)
 */
class WebRTCSignalingServer {
  constructor () {
    this.registeredHandlers = new Map() // Track registered handlers
  }

  /**
   * Initialize and register message handlers with main thread's WebSocket server
   * Note: The WebSocket server is created in lib/server.js (main thread)
   * This registers handlers that will process messages
   */
  initialize () {
    // The WebSocket server is created in server.js
    // We just need to register handlers when previews start
    logger.debug('WebRTC signaling server ready (handlers will be registered per stream)')
  }

  /**
   * Register a message handler for a stream
   * This is called when a preview starts
   * Note: Registration is now handled automatically by server.js
   * This method is kept for compatibility but does nothing
   * @param {string} streamId - Stream ID
   */
  registerStreamHandler (streamId) {
    // Registration is now automatic - server.js routes messages via commands
    logger.debug('WebRTC stream handler will be registered automatically when connection is established', { streamId })
  }

  /**
   * Unregister a message handler for a stream
   * Note: Unregistration is now handled automatically by server.js
   * @param {string} streamId - Stream ID
   */
  unregisterStreamHandler (streamId) {
    // Unregistration is now automatic - handled by server.js on connection close
    logger.debug('WebRTC stream handler will be unregistered automatically', { streamId })
  }

  /**
   * Handle signaling messages from client
   * This is called by server.js via command system
   * @param {string} streamId - Stream ID
   * @param {Object} message - Signaling message
   * @param {string} wsId - WebSocket connection ID
   * @param {Function} sendResponse - Function to send response: (response) => void
   */
  async handleMessage (streamId, message, wsId, sendResponse) {
    // Get preview bridge for this stream
    const bridge = webRTCPreviewManager.getPreviewBridge(streamId)
    if (!bridge) {
      logger.error('No preview bridge found for stream', { streamId })
      sendResponse({
        type: 'error',
        message: 'Preview not started for this stream. Please start preview first.'
      })
      return
    }
    const { type } = message

    switch (type) {
      case 'getRouterRtpCapabilities': {
        // Send router RTP capabilities to client
        const rtpCapabilities = bridge.getRtpCapabilities()
        sendResponse({
          type: 'routerRtpCapabilities',
          data: rtpCapabilities
        })
        break
      }

      case 'createWebRtcTransport': {
        // Create WebRTC transport for client
        try {
          const transportInfo = await bridge.createWebRTCTransport(streamId)
          sendResponse({
            type: 'webRtcTransportCreated',
            data: transportInfo
          })
        } catch (err) {
          logger.error('Error creating WebRTC transport', {
            streamId,
            error: err.message
          })
          sendResponse({
            type: 'error',
            message: 'Failed to create WebRTC transport: ' + err.message
          })
        }
        break
      }

      case 'connectWebRtcTransport': {
        // Connect WebRTC transport with client DTLS parameters
        try {
          logger.debug('WebRTCSignalingServer: Received connectWebRtcTransport message', {
            streamId,
            hasDtlsParameters: !!message.dtlsParameters,
            dtlsRole: message.dtlsParameters?.role,
            dtlsFingerprintsCount: message.dtlsParameters?.fingerprints?.length
          })
          const { dtlsParameters } = message
          if (!dtlsParameters) {
            throw new Error('DTLS parameters missing')
          }
          await bridge.connectWebRTCTransport(streamId, dtlsParameters)
          logger.debug('WebRTCSignalingServer: WebRTC transport connected successfully', { streamId })
          sendResponse({
            type: 'webRtcTransportConnected'
          })
        } catch (err) {
          logger.error('WebRTCSignalingServer: Error connecting WebRTC transport', {
            streamId,
            error: err.message,
            stack: err.stack
          })
          sendResponse({
            type: 'error',
            message: 'Failed to connect WebRTC transport: ' + err.message
          })
        }
        break
      }

      case 'createConsumer': {
        // Create consumer for client
        try {
          logger.debug('Creating Consumer for client', {
            streamId,
            transportId: message.transportId,
            hasRtpCapabilities: !!message.rtpCapabilities
          })
          const { transportId, rtpCapabilities } = message
          const consumerInfo = await bridge.createConsumer(streamId, transportId, rtpCapabilities)
          logger.debug('Consumer created successfully', {
            streamId,
            consumerId: consumerInfo.id,
            producerId: consumerInfo.producerId,
            kind: consumerInfo.kind
          })
          sendResponse({
            type: 'consumerCreated',
            data: consumerInfo
          })
        } catch (err) {
          logger.error('Error creating consumer', {
            streamId,
            error: err.message,
            stack: err.stack
          })
          sendResponse({
            type: 'error',
            message: 'Failed to create consumer: ' + err.message
          })
        }
        break
      }

      default:
        logger.warn('Unknown WebRTC signaling message type', {
          streamId,
          type
        })
        sendResponse({
          type: 'error',
          message: `Unknown message type: ${type}`
        })
    }
  }

  /**
   * Close WebSocket server
   */
  close () {
    if (this.wss) {
      this.wss.close()
      this.wss = null
    }
  }
}

module.exports = WebRTCSignalingServer
