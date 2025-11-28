// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const mediasoup = require('mediasoup')
const RTPParser = require('./RTPParser')
const H264Depacketizer = require('./H264Depacketizer')

const Logger = require('../../../lib/Logger')
const logger = new Logger({ name: 'CasparNetworkPlugin' })

/**
 * Mediasoup Bridge - Bridges RTP stream to WebRTC using mediasoup
 *
 * Pipeline: RTP Packets → Parser → Depacketizer → PlainTransport → Router → WebRTCTransport → Browser
 *
 * This implementation uses mediasoup's PlainTransport to accept RTP packets directly,
 * solving the frame pushing limitation of the `wrtc` package.
 */
class MediasoupBridge {
  constructor (options = {}) {
    this.width = options.width || 1920
    this.height = options.height || 1080
    this.frameRate = options.frameRate || 30

    this.worker = null
    this.router = null
    this.plainTransport = null
    this.producer = null
    this.webrtcTransports = new Map() // Map<streamId, WebRTCTransport>
    this.consumers = new Map() // Map<streamId, Consumer>

    this.rtpParser = new RTPParser()
    this.depacketizer = new H264Depacketizer()

    this.isActive = false
  }

  /**
   * Initialize mediasoup worker and router
   * @returns {Promise<void>}
   */
  async initialize () {
    if (this.worker) {
      throw new Error('MediasoupBridge is already initialized')
    }

    // Create mediasoup worker
    this.worker = await mediasoup.createWorker({
      logLevel: 'warn',
      logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp']
    })

    this.worker.on('died', () => {
      logger.error('MediasoupBridge: Worker died, exiting')
      process.exit(1)
    })

    // Create router with H.264 codec support
    this.router = await this.worker.createRouter({
      mediaCodecs: [
        {
          kind: 'video',
          mimeType: 'video/H264',
          clockRate: 90000,
          parameters: {
            'packetization-mode': 1,
            'profile-level-id': '42e01f', // Baseline profile
            'level-asymmetry-allowed': 1
          }
        }
      ]
    })

    logger.debug('MediasoupBridge: Initialized', {
      routerId: this.router.id
    })
  }

  /**
   * Create PlainTransport to receive RTP packets
   * @param {number} rtpPort - Port where RTP packets are being sent (from RTPReceiver)
   * @returns {Promise<Object>} Transport info with RTP/RTCP addresses
   */
  async createPlainTransport (rtpPort) {
    if (!this.router) {
      throw new Error('Router not initialized. Call initialize() first.')
    }

    // Create PlainTransport to receive RTP packets
    // We'll send RTP packets to this transport from our RTPReceiver
    // comedia: true allows mediasoup to automatically detect remote address from incoming packets
    this.plainTransport = await this.router.createPlainTransport({
      listenIp: { ip: '127.0.0.1', announcedIp: null },
      rtcpMux: false,
      comedia: true // Auto-detect remote address from incoming packets
    })

    logger.debug('MediasoupBridge: PlainTransport created', {
      rtpIp: this.plainTransport.tuple.localIp,
      rtpPort: this.plainTransport.tuple.localPort,
      rtcpIp: this.plainTransport.rtcpTuple?.localIp,
      rtcpPort: this.plainTransport.rtcpTuple?.localPort
    })

    // Set up PlainTransport event handlers for debugging
    this.plainTransport.on('tuple', (tuple) => {
      logger.info('MediasoupBridge: PlainTransport tuple updated (RTP packets detected)', {
        localIp: tuple.localIp,
        localPort: tuple.localPort,
        remoteIp: tuple.remoteIp,
        remotePort: tuple.remotePort,
        protocol: tuple.protocol
      })
    })

    this.plainTransport.on('rtcptuple', (rtcpTuple) => {
      logger.info('MediasoupBridge: PlainTransport RTCP tuple updated', {
        localIp: rtcpTuple.localIp,
        localPort: rtcpTuple.localPort,
        remoteIp: rtcpTuple.remoteIp,
        remotePort: rtcpTuple.remotePort,
        protocol: rtcpTuple.protocol
      })
    })

    this.plainTransport.on('producerclose', () => {
      logger.warn('MediasoupBridge: PlainTransport producer closed')
    })

    // Monitor PlainTransport stats to see if packets are being received
    this.plainTransportStatsInterval = setInterval(async () => {
      try {
        const stats = await this.plainTransport.getStats()
        logger.debug('MediasoupBridge: PlainTransport stats', {
          stats
        })
        // Check if transport is receiving packets
        if (stats && Array.isArray(stats)) {
          const transportStats = stats.find(s => s.type === 'transport')
          if (transportStats) {
            const bytesReceived = transportStats.bytesReceived || 0
            const packetsReceived = transportStats.packetsReceived || 0
            if (bytesReceived === 0 && packetsReceived === 0) {
              logger.warn('MediasoupBridge: PlainTransport not receiving any packets', {
                stats: transportStats
              })
            } else {
              logger.debug('MediasoupBridge: PlainTransport receiving packets', {
                bytesReceived,
                packetsReceived
              })
            }
          }
        }
      } catch (err) {
        logger.warn('MediasoupBridge: Error getting PlainTransport stats', { error: err.message })
      }
    }, 5000) // Every 5 seconds

    // PlainTransport listens on a port and receives RTP packets via UDP
    // We'll configure RTPReceiver to forward packets directly to this port
    // No need for intermediate socket - RTPReceiver will send directly to PlainTransport

    return {
      rtpIp: this.plainTransport.tuple.localIp,
      rtpPort: this.plainTransport.tuple.localPort,
      rtcpIp: this.plainTransport.rtcpTuple?.localIp || this.plainTransport.tuple.localIp,
      rtcpPort: this.plainTransport.rtcpTuple?.localPort || (this.plainTransport.tuple.localPort + 1)
    }
  }

  /**
   * Create Producer from PlainTransport
   * This represents our RTP video stream
   * @param {Object} rtpParameters - RTP parameters for the stream
   * @returns {Promise<void>}
   */
  async createProducer (rtpParameters) {
    if (!this.plainTransport) {
      throw new Error('PlainTransport not created. Call createPlainTransport() first.')
    }

    // Create Producer from PlainTransport
    // This tells mediasoup about our RTP stream
    // With comedia: true, mediasoup accepts packets from any remote address
    // The SSRC in encodings is required by mediasoup and will be matched to incoming RTP packets
    // Note: FFmpeg generates its own SSRC, but mediasoup should match it when packets arrive
    this.producer = await this.plainTransport.produce({
      kind: 'video',
      rtpParameters: rtpParameters || {
        codecs: [
          {
            mimeType: 'video/H264',
            clockRate: 90000,
            payloadType: 96,
            rtcpFeedback: [
              { type: 'goog-remb' },
              { type: 'transport-cc' },
              { type: 'ccm', parameter: 'fir' },
              { type: 'nack' },
              { type: 'nack', parameter: 'pli' }
            ],
            parameters: {
              'packetization-mode': 1,
              'profile-level-id': '42e01f'
            }
          }
        ],
        headerExtensions: [
          {
            uri: 'urn:ietf:params:rtp-hdrext:sdes:mid',
            id: 1
          },
          {
            uri: 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id',
            id: 2
          },
          {
            uri: 'urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id',
            id: 3
          }
        ],
        encodings: [
          {
            // SSRC is required by mediasoup even with comedia: true
            // With comedia mode, mediasoup will match this SSRC to the actual SSRC from incoming RTP packets
            // Using a placeholder value - will be matched to actual SSRC from FFmpeg's RTP stream
            ssrc: 11111111,
            maxBitrate: 2000000
          }
        ],
        rtcp: {
          cname: 'stream-preview',
          reducedSize: true
        }
      }
    })

    logger.debug('MediasoupBridge: Producer created', {
      producerId: this.producer.id,
      kind: this.producer.kind,
      rtpParameters: this.producer.rtpParameters
    })

    // Set up Producer event handlers for debugging
    this.producer.on('transportclose', () => {
      logger.warn('MediasoupBridge: Producer transport closed')
    })

    this.producer.on('score', (score) => {
      logger.debug('MediasoupBridge: Producer score updated', {
        producerId: this.producer.id,
        score
      })
    })

    // Monitor Producer stats periodically to track if packets are being received
    this.producerStatsInterval = setInterval(async () => {
      try {
        const stats = await this.producer.getStats()
        logger.debug('MediasoupBridge: Producer stats', {
          producerId: this.producer.id,
          stats
        })
        // Check if Producer is receiving packets
        if (stats && Array.isArray(stats)) {
          const videoStats = stats.find(s => s.type === 'outbound-rtp' || s.type === 'media-source')
          if (videoStats) {
            const bytesReceived = videoStats.bytesReceived || videoStats.bytes || 0
            const packetsReceived = videoStats.packetsReceived || videoStats.packets || 0
            if (bytesReceived === 0 && packetsReceived === 0) {
              logger.warn('MediasoupBridge: Producer not receiving any packets', {
                producerId: this.producer.id,
                stats: videoStats
              })
            } else {
              logger.debug('MediasoupBridge: Producer receiving packets', {
                producerId: this.producer.id,
                bytesReceived,
                packetsReceived
              })
            }
          }
        }
      } catch (err) {
        logger.warn('MediasoupBridge: Error getting Producer stats', { error: err.message })
      }
    }, 5000) // Every 5 seconds

    this.isActive = true
  }

  /**
   * Process RTP packet and forward to PlainTransport
   * @param {Object} rtpPacket - Parsed RTP packet from RTPParser
   */
  processRTPPacket (rtpPacket) {
    // This method is currently not used - RTPReceiver forwards packets directly
    // to PlainTransport via UDP. This method is kept for potential future use
    // if we need to process packets before forwarding.
    if (!this.plainTransport || !this.isActive) {
      // Early return if transport is not ready
    }
  }

  /**
   * Create WebRTC transport for a browser client
   * @param {string} streamId - Stream ID
   * @param {Object} options - Transport options
   * @returns {Promise<Object>} Transport info for client
   */
  async createWebRTCTransport (streamId, options = {}) {
    if (!this.router) {
      throw new Error('Router not initialized')
    }

    const {
      listenIps = [{ ip: '0.0.0.0', announcedIp: null }], // Listen on all interfaces
      enableUdp = true,
      enableTcp = true,
      preferUdp = true
    } = options

    // Create WebRTC transport for browser client
    const transport = await this.router.createWebRtcTransport({
      listenIps,
      enableUdp,
      enableTcp,
      preferUdp,
      initialAvailableOutgoingBitrate: 1000000,
      enableSctp: false
    })

    this.webrtcTransports.set(streamId, transport)

    // Set up transport event handlers for debugging
    transport.on('icestatechange', (iceState) => {
      logger.debug('MediasoupBridge: WebRTC transport ICE state changed', {
        streamId,
        transportId: transport.id,
        iceState
      })
    })

    transport.on('iceselectedtuplechange', (tuple) => {
      logger.debug('MediasoupBridge: WebRTC transport ICE selected tuple changed', {
        streamId,
        transportId: transport.id,
        tuple
      })
    })

    transport.on('dtlsstatechange', (dtlsState) => {
      logger.debug('MediasoupBridge: WebRTC transport DTLS state changed', {
        streamId,
        transportId: transport.id,
        dtlsState
      })
    })

    transport.on('connect', () => {
      logger.debug('MediasoupBridge: WebRTC transport connected', {
        streamId,
        transportId: transport.id
      })
    })

    transport.on('close', () => {
      logger.debug('MediasoupBridge: WebRTC transport closed', {
        streamId,
        transportId: transport.id
      })
    })

    logger.debug('MediasoupBridge: WebRTC transport created', {
      streamId,
      transportId: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    })

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    }
  }

  /**
   * Create Consumer for a WebRTC transport
   * This connects the browser client to our Producer
   * @param {string} streamId - Stream ID
   * @param {string} transportId - WebRTC transport ID
   * @param {Object} rtpCapabilities - Client RTP capabilities
   * @returns {Promise<Object>} Consumer parameters
   */
  async createConsumer (streamId, transportId, rtpCapabilities) {
    if (!this.producer) {
      throw new Error('Producer not created. Call createProducer() first.')
    }

    const transport = this.webrtcTransports.get(streamId)
    if (!transport || transport.id !== transportId) {
      throw new Error('WebRTC transport not found')
    }

    // Check if router can consume
    if (!this.router.canConsume({ producerId: this.producer.id, rtpCapabilities })) {
      logger.error('MediasoupBridge: Cannot consume producer', {
        streamId,
        producerId: this.producer.id,
        producerKind: this.producer.kind,
        producerPaused: this.producer.paused,
        routerRtpCapabilities: this.router.rtpCapabilities,
        clientRtpCapabilities: rtpCapabilities
      })
      throw new Error('Cannot consume producer with given RTP capabilities')
    }

    // Log Producer stats before creating Consumer
    try {
      const producerStats = await this.producer.getStats()
      logger.debug('MediasoupBridge: Producer stats before Consumer creation', {
        streamId,
        producerId: this.producer.id,
        stats: producerStats
      })
      // Check if Producer is receiving packets
      if (producerStats && Array.isArray(producerStats)) {
        const videoStats = producerStats.find(s => s.type === 'outbound-rtp' || s.type === 'media-source')
        if (videoStats) {
          const bytesReceived = videoStats.bytesReceived || videoStats.bytes || 0
          const packetsReceived = videoStats.packetsReceived || videoStats.packets || 0
          if (bytesReceived === 0 && packetsReceived === 0) {
            logger.warn('MediasoupBridge: Producer has not received any packets yet when creating Consumer', {
              streamId,
              producerId: this.producer.id
            })
          } else {
            logger.info('MediasoupBridge: Producer is receiving packets, creating Consumer', {
              streamId,
              producerId: this.producer.id,
              bytesReceived,
              packetsReceived
            })
          }
        }
      }
    } catch (err) {
      logger.warn('MediasoupBridge: Could not get Producer stats', { error: err.message })
    }

    // Create Consumer
    const consumer = await transport.consume({
      producerId: this.producer.id,
      rtpCapabilities,
      paused: false
    })

    this.consumers.set(streamId, consumer)

    logger.debug('MediasoupBridge: Consumer created', {
      streamId,
      consumerId: consumer.id,
      kind: consumer.kind,
      producerId: consumer.producerId,
      type: consumer.type,
      paused: consumer.paused
    })

    // Set up Consumer event handlers for debugging
    consumer.on('transportclose', () => {
      logger.debug('MediasoupBridge: Consumer transport closed', { streamId, consumerId: consumer.id })
    })

    consumer.on('producerclose', () => {
      logger.warn('MediasoupBridge: Consumer producer closed', { streamId, consumerId: consumer.id })
    })

    // Log Consumer stats after creation
    try {
      const consumerStats = await consumer.getStats()
      logger.debug('MediasoupBridge: Consumer stats after creation', {
        streamId,
        consumerId: consumer.id,
        stats: consumerStats
      })
    } catch (err) {
      logger.warn('MediasoupBridge: Could not get Consumer stats', { error: err.message })
    }

    return {
      id: consumer.id,
      producerId: consumer.producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      type: consumer.type,
      consumerPaused: consumer.paused
    }
  }

  /**
   * Connect WebRTC transport (after client provides DTLS parameters)
   * @param {string} streamId - Stream ID
   * @param {Object} dtlsParameters - Client DTLS parameters
   * @returns {Promise<void>}
   */
  async connectWebRTCTransport (streamId, dtlsParameters) {
    const transport = this.webrtcTransports.get(streamId)
    if (!transport) {
      throw new Error('WebRTC transport not found')
    }

    logger.debug('MediasoupBridge: Connecting WebRTC transport', {
      streamId,
      transportId: transport.id,
      dtlsRole: dtlsParameters.role
    })

    try {
      await transport.connect({ dtlsParameters })
      logger.debug('MediasoupBridge: WebRTC transport connected successfully', {
        streamId,
        transportId: transport.id
      })
    } catch (error) {
      logger.error('MediasoupBridge: Error connecting WebRTC transport', {
        streamId,
        transportId: transport.id,
        error: error.message,
        stack: error.stack
      })
      throw error
    }
  }

  /**
   * Get router RTP capabilities for client
   * @returns {Object} RTP capabilities
   */
  getRtpCapabilities () {
    if (!this.router) {
      throw new Error('Router not initialized')
    }

    return this.router.rtpCapabilities
  }

  /**
   * Stop and cleanup
   * @returns {Promise<void>}
   */
  async stop () {
    // Stop PlainTransport stats monitoring
    if (this.plainTransportStatsInterval) {
      clearInterval(this.plainTransportStatsInterval)
      this.plainTransportStatsInterval = null
    }

    // Stop Producer stats monitoring
    if (this.producerStatsInterval) {
      clearInterval(this.producerStatsInterval)
      this.producerStatsInterval = null
    }

    // Close consumers
    for (const [, consumer] of this.consumers.entries()) {
      consumer.close()
    }
    this.consumers.clear()

    // Close WebRTC transports
    for (const [, transport] of this.webrtcTransports.entries()) {
      transport.close()
    }
    this.webrtcTransports.clear()

    // Close producer
    if (this.producer) {
      this.producer.close()
      this.producer = null
    }

    // Close PlainTransport
    if (this.plainTransport) {
      this.plainTransport.close()
      this.plainTransport = null
    }

    // Close router
    if (this.router) {
      this.router.close()
      this.router = null
    }

    // Close worker
    if (this.worker) {
      this.worker.close()
      this.worker = null
    }

    this.isActive = false
    this.depacketizer.reset()
    this.rtpParser.resetStats()

    logger.debug('MediasoupBridge: Stopped')
  }

  /**
   * Get statistics
   * @returns {Object} Statistics
   */
  getStats () {
    return {
      rtp: this.rtpParser.getStats(),
      depacketizer: this.depacketizer.getStats(),
      mediasoup: {
        workerAlive: this.worker !== null,
        routerActive: this.router !== null,
        plainTransportActive: this.plainTransport !== null,
        producerActive: this.producer !== null,
        webrtcTransports: this.webrtcTransports.size,
        consumers: this.consumers.size,
        isActive: this.isActive
      }
    }
  }
}

module.exports = MediasoupBridge
