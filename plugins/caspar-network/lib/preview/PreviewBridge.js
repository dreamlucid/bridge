// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const mediasoup = require('mediasoup')
const FFmpegClient = require('./FFmpegClient')
const Logger = require('../../../../lib/Logger')
const logger = new Logger({ name: 'CasparNetworkPlugin:PreviewBridge' })

/**
 * Preview Bridge - Bridges SRT stream to WebRTC using mediasoup (video only)
 * Following mediasoup-demo broadcaster pattern:
 * 1. Create PlainTransport for video
 * 2. Create Producer on PlainTransport
 * 3. Start FFmpeg to send RTP to PlainTransport
 * 4. Create WebRTC transports for browser clients
 * 5. Create Consumers to forward media to WebRTC transports
 */
class PreviewBridge {
  constructor (options = {}) {
    // Default to a larger port range (100 ports) to avoid port exhaustion
    // Each WebRTC transport needs multiple ports, so a small range can be exhausted quickly
    // Can be overridden via environment variables or options
    this.rtcMinPort = options.rtcMinPort || parseInt(process.env.WEBRTC_MIN_PORT || '10000', 10)
    this.rtcMaxPort = options.rtcMaxPort || parseInt(process.env.WEBRTC_MAX_PORT || '10099', 10)

    this.worker = null
    this.router = null
    this.videoPlainTransport = null
    this.videoProducer = null
    this.webrtcTransports = new Map() // Map<streamId, WebRTCTransport>
    this.consumers = new Map() // Map<streamId, Consumer>
    this.ffmpegClient = new FFmpegClient()

    this.isActive = false
    this.publicIpCache = null
    this.publicIpPromise = null
    this.ffmpegReady = false // Flag to track if FFmpeg is sending data
    this.ffmpegReadyPromise = null // Promise that resolves when FFmpeg is ready
    this.ffmpegReadyResolve = null
  }

  /**
   * Initialize mediasoup worker and router
   * @returns {Promise<void>}
   */
  async initialize () {
    if (this.worker) {
      throw new Error('PreviewBridge is already initialized')
    }

    // Create mediasoup worker
    this.worker = await mediasoup.createWorker({
      logLevel: 'warn',
      logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
      rtcMinPort: this.rtcMinPort,
      rtcMaxPort: this.rtcMaxPort
    })

    const portRangeSize = this.rtcMaxPort - this.rtcMinPort + 1
    logger.info('PreviewBridge: Worker created with WebRTC port range', {
      rtcMinPort: this.rtcMinPort,
      rtcMaxPort: this.rtcMaxPort,
      portRangeSize,
      note: 'Ensure firewall allows UDP and TCP traffic on this port range for remote access',
      firewallRule: `Allow UDP and TCP on ports ${this.rtcMinPort}-${this.rtcMaxPort} (${portRangeSize} ports)`
    })

    this.worker.on('died', () => {
      logger.error('PreviewBridge: Worker died, exiting')
      process.exit(1)
    })

    // Create router with video codec support only (video-only preview)
    this.router = await this.worker.createRouter({
      mediaCodecs: [
        {
          kind: 'video',
          mimeType: 'video/VP8',
          clockRate: 90000,
          rtcpFeedback: [
            { type: 'nack' },
            { type: 'nack', parameter: 'pli' },
            { type: 'ccm', parameter: 'fir' }
          ]
        },
        {
          kind: 'video',
          mimeType: 'video/H264',
          clockRate: 90000,
          parameters: {
            'packetization-mode': 1,
            'profile-level-id': '42e01f',
            'level-asymmetry-allowed': 1
          },
          rtcpFeedback: [
            { type: 'nack' },
            { type: 'nack', parameter: 'pli' },
            { type: 'ccm', parameter: 'fir' }
          ]
        }
      ]
    })

    logger.debug('PreviewBridge: Initialized', {
      routerId: this.router.id
    })
  }

  /**
   * Start preview for an SRT stream
   * Following broadcaster demo pattern: create transports and producers first, then start FFmpeg
   * @param {string} streamId - Stream ID
   * @param {string} srtUrl - SRT input URL
   * @returns {Promise<void>}
   */
  async startPreview (streamId, srtUrl) {
    if (!this.router) {
      throw new Error('Router not initialized. Call initialize() first.')
    }

    logger.info('Starting preview (video only)', { streamId, srtUrl })

    // Step 1: Create PlainTransport for video only
    const videoPlainTransport = await this.router.createPlainTransport({
      listenIp: { ip: '127.0.0.1', announcedIp: null },
      rtcpMux: false,
      comedia: true // Auto-detect remote address from incoming packets
    })

    this.videoPlainTransport = videoPlainTransport

    logger.info('PlainTransport created', {
      streamId,
      video: {
        ip: videoPlainTransport.tuple.localIp,
        port: videoPlainTransport.tuple.localPort,
        rtcpPort: videoPlainTransport.rtcpTuple?.localPort,
        protocol: videoPlainTransport.tuple.protocol
      }
    })

    // Monitor PlainTransport RTCP tuple
    videoPlainTransport.on('rtcptuple', (rtcpTuple) => {
      logger.info('PlainTransport RTCP tuple updated', {
        streamId,
        localIp: rtcpTuple.localIp,
        localPort: rtcpTuple.localPort,
        remoteIp: rtcpTuple.remoteIp,
        remotePort: rtcpTuple.remotePort,
        protocol: rtcpTuple.protocol
      })
    })

    // Step 2: Define SSRC and payload type for video
    const videoSsrc = 2222
    const videoPt = 102

    // Step 3: Create Producer BEFORE starting FFmpeg (following broadcaster demo pattern)
    // Use H.264 for video (matching SRT stream codec)
    const videoProducer = await videoPlainTransport.produce({
      kind: 'video',
      rtpParameters: {
        codecs: [
          {
            mimeType: 'video/H264',
            payloadType: videoPt,
            clockRate: 90000,
            rtcpFeedback: [
              { type: 'nack' },
              { type: 'nack', parameter: 'pli' },
              { type: 'ccm', parameter: 'fir' }
            ],
            parameters: {
              'packetization-mode': 1,
              'profile-level-id': '42e01f'
            }
          }
        ],
        encodings: [{ ssrc: videoSsrc }]
      }
    })

    this.videoProducer = videoProducer

    logger.info('Video Producer created', {
      streamId,
      videoProducerId: videoProducer.id,
      kind: videoProducer.kind,
      rtpParameters: {
        codecs: videoProducer.rtpParameters.codecs,
        encodings: videoProducer.rtpParameters.encodings,
        headerExtensions: videoProducer.rtpParameters.headerExtensions
      }
    })

    // Monitor producer events
    videoProducer.on('transportclose', () => {
      logger.warn('Video producer transport closed', { streamId, producerId: videoProducer.id })
    })

    videoProducer.on('score', (score) => {
      logger.debug('Video producer score', { streamId, producerId: videoProducer.id, score })
    })

    // Monitor PlainTransport for when FFmpeg starts sending packets
    // The tuple event fires when the first packet is received
    // Create a promise that resolves when FFmpeg is ready
    this.ffmpegReady = false
    this.ffmpegReadyPromise = new Promise((resolve, reject) => {
      this.ffmpegReadyResolve = resolve
      // Timeout after 10 seconds - if FFmpeg doesn't start, reject
      setTimeout(() => {
        if (!this.ffmpegReady) {
          reject(new Error('FFmpeg failed to start sending data within 10 seconds'))
        }
      }, 10000)
    })

    videoPlainTransport.on('tuple', (tuple) => {
      logger.info('PlainTransport tuple updated', {
        streamId,
        localIp: tuple.localIp,
        localPort: tuple.localPort,
        remoteIp: tuple.remoteIp,
        remotePort: tuple.remotePort,
        protocol: tuple.protocol
      })

      if (!this.ffmpegReady && tuple.remoteIp) {
        this.ffmpegReady = true
        logger.info('FFmpeg started sending RTP packets to PlainTransport', {
          streamId,
          localPort: tuple.localPort,
          remoteIp: tuple.remoteIp,
          remotePort: tuple.remotePort
        })

        // Resolve the readiness promise
        if (this.ffmpegReadyResolve) {
          this.ffmpegReadyResolve()
          this.ffmpegReadyResolve = null
        }

        // Check stats shortly after FFmpeg starts sending
        setTimeout(async () => {
          try {
            const transportStats = await videoPlainTransport.getStats()
            const transportReport = Array.from(transportStats.entries())
              .find(([id, report]) => report.type === 'transport')?.[1]

            if (transportReport) {
              const bytesReceived = transportReport.bytesReceived || 0
              const packetsReceived = transportReport.packetsReceived || 0
              logger.info('PlainTransport packet reception (after FFmpeg started)', {
                streamId,
                bytesReceived,
                packetsReceived,
                rtpBytesReceived: transportReport.rtpBytesReceived || 0,
                rtpRecvBitrate: transportReport.rtpRecvBitrate || 0
              })

              if (bytesReceived === 0 && packetsReceived === 0) {
                logger.error('PlainTransport still not receiving packets even after FFmpeg started!', {
                  streamId,
                  tuple: {
                    localIp: tuple.localIp,
                    localPort: tuple.localPort,
                    remoteIp: tuple.remoteIp,
                    remotePort: tuple.remotePort
                  }
                })
              }
            }
          } catch (err) {
            logger.warn('Failed to get PlainTransport stats after FFmpeg started', { streamId, error: err.message })
          }
        }, 1000)
      }
    })

    // Check PlainTransport stats periodically to monitor data flow
    // Start checking after a delay to give FFmpeg time to start
    setTimeout(async () => {
      try {
        const transportStats = await videoPlainTransport.getStats()
        const statsArray = Array.from(transportStats.entries()).map(([id, report]) => ({
          id,
          type: report.type,
          ...Object.fromEntries(
            Object.entries(report).filter(([key]) => !['type', 'id', 'timestamp'].includes(key))
          )
        }))

        logger.info('PlainTransport statistics (after 3s)', {
          streamId,
          tuple: {
            localIp: videoPlainTransport.tuple.localIp,
            localPort: videoPlainTransport.tuple.localPort,
            remoteIp: videoPlainTransport.tuple.remoteIp,
            remotePort: videoPlainTransport.tuple.remotePort
          },
          stats: statsArray
        })

        // Check if transport is receiving packets
        const transportReport = statsArray.find(s => s.type === 'transport')
        if (transportReport) {
          const bytesReceived = transportReport.bytesReceived || 0
          const packetsReceived = transportReport.packetsReceived || 0
          logger.info('PlainTransport packet reception (3s check)', {
            streamId,
            bytesReceived,
            packetsReceived,
            hasRemoteAddress: !!videoPlainTransport.tuple.remoteIp
          })

          if (bytesReceived === 0 && packetsReceived === 0 && !videoPlainTransport.tuple.remoteIp) {
            logger.warn('PlainTransport not receiving packets yet - FFmpeg may still be starting', {
              streamId,
              expectedPort: videoPlainTransport.tuple.localPort
            })
          }
        }
      } catch (err) {
        logger.warn('Failed to get PlainTransport stats', { streamId, error: err.message })
      }
    }, 3000)

    // Check again after 8 seconds (should definitely have data by then)
    setTimeout(async () => {
      try {
        const transportStats = await videoPlainTransport.getStats()
        const transportReport = Array.from(transportStats.entries())
          .find(([id, report]) => report.type === 'transport')?.[1]

        if (transportReport) {
          const bytesReceived = transportReport.bytesReceived || 0
          const packetsReceived = transportReport.packetsReceived || 0
          logger.info('PlainTransport stats check (after 8s)', {
            streamId,
            bytesReceived,
            packetsReceived,
            rtpBytesReceived: transportReport.rtpBytesReceived || 0,
            rtpRecvBitrate: transportReport.rtpRecvBitrate || 0,
            remoteIp: videoPlainTransport.tuple.remoteIp,
            remotePort: videoPlainTransport.tuple.remotePort
          })

          if (bytesReceived === 0 && packetsReceived === 0) {
            logger.error('PlainTransport still not receiving any RTP packets after 8 seconds!', {
              streamId,
              ffmpegTarget: {
                ip: videoPlainTransport.tuple.localIp,
                port: videoPlainTransport.tuple.localPort
              }
            })
          }
        }
      } catch (err) {
        logger.warn('Failed to get PlainTransport stats after 8s', { streamId, error: err.message })
      }
    }, 8000)

    // Monitor producer events
    videoProducer.on('transportclose', () => {
      logger.warn('Video producer transport closed', { streamId, producerId: videoProducer.id })
    })

    videoProducer.on('score', (score) => {
      logger.debug('Video producer score', { streamId, producerId: videoProducer.id, score })
    })

    // Check producer stats after a delay to see if data is flowing
    setTimeout(async () => {
      try {
        const stats = await videoProducer.getStats()
        const statsArray = Array.from(stats.entries()).map(([id, report]) => ({
          id,
          type: report.type,
          timestamp: report.timestamp,
          ...Object.fromEntries(
            Object.entries(report).filter(([key]) => !['type', 'id', 'timestamp'].includes(key))
          )
        }))

        logger.info('Video producer statistics (after 2s)', {
          streamId,
          producerId: videoProducer.id,
          kind: videoProducer.kind,
          paused: videoProducer.paused,
          stats: statsArray
        })

        // Check if producer is sending data
        const transportStats = statsArray.find(s => s.type === 'transport')
        const outboundRtpStats = statsArray.find(s => s.type === 'outbound-rtp')

        if (outboundRtpStats) {
          logger.info('Producer outbound RTP stats', {
            streamId,
            bytesSent: outboundRtpStats.bytesSent || 0,
            packetsSent: outboundRtpStats.packetsSent || 0,
            framesEncoded: outboundRtpStats.framesEncoded || 0,
            framesSent: outboundRtpStats.framesSent || 0
          })

          if (!outboundRtpStats.packetsSent || outboundRtpStats.packetsSent === 0) {
            logger.error('Producer is not sending any packets!', {
              streamId,
              producerId: videoProducer.id,
              transportStats
            })
          }
        } else {
          logger.warn('No outbound-rtp stats found for producer', {
            streamId,
            producerId: videoProducer.id,
            availableStats: statsArray.map(s => s.type)
          })
        }
      } catch (err) {
        logger.warn('Failed to get producer stats after delay', { streamId, error: err.message })
      }
    }, 2000)

    // Check again after 5 seconds
    setTimeout(async () => {
      try {
        const stats = await videoProducer.getStats()
        const outboundRtpStats = Array.from(stats.entries())
          .find(([id, report]) => report.type === 'outbound-rtp')?.[1]

        if (outboundRtpStats) {
          logger.info('Producer stats check (after 5s)', {
            streamId,
            producerId: videoProducer.id,
            bytesSent: outboundRtpStats.bytesSent || 0,
            packetsSent: outboundRtpStats.packetsSent || 0,
            framesEncoded: outboundRtpStats.framesEncoded || 0
          })
        }
      } catch (err) {
        logger.warn('Failed to get producer stats after 5s', { streamId, error: err.message })
      }
    }, 5000)

    // Step 4: Start FFmpeg to send RTP to PlainTransport (video only)
    // Use hardware acceleration (NVENC/NVDEC) by default
    await this.ffmpegClient.sendSRTStream({
      streamId,
      srtUrl,
      videoTransport: {
        ip: videoPlainTransport.tuple.localIp,
        port: videoPlainTransport.tuple.localPort,
        rtcpPort: videoPlainTransport.rtcpTuple?.localPort
      },
      videoSsrc,
      videoPt,
      useHardware: true // Enable hardware acceleration
    })

    this.isActive = true

    logger.info('Preview started successfully', { streamId })
  }

  /**
   * Create WebRTC transport for a browser client
   * Waits for FFmpeg to be ready (sending data) before creating transport
   * @param {string} streamId - Stream ID (for tracking)
   * @param {Object} options - Transport options
   * @returns {Promise<Object>} Transport info for client
   */
  async createWebRTCTransport (streamId, options = {}) {
    if (!this.router) {
      throw new Error('Router not initialized')
    }

    // Wait for FFmpeg to be ready (sending data) before creating WebRTC transport
    // This ensures the producer has data to forward to consumers
    if (!this.ffmpegReady && this.ffmpegReadyPromise) {
      logger.info('Waiting for FFmpeg to start sending data before creating WebRTC transport', { streamId })
      try {
        await this.ffmpegReadyPromise
        logger.info('FFmpeg is ready, creating WebRTC transport', { streamId })
      } catch (err) {
        logger.error('FFmpeg failed to start, but creating WebRTC transport anyway', {
          streamId,
          error: err.message
        })
        // Continue anyway - the transport can be created, but consumer won't receive data until FFmpeg starts
      }
    } else if (this.ffmpegReady) {
      logger.debug('FFmpeg already ready, creating WebRTC transport', { streamId })
    } else {
      logger.warn('FFmpeg readiness promise not available, creating WebRTC transport anyway', { streamId })
    }

    const { getFirstIPv4Address, getPublicIPAddress } = require('../../../../lib/network')
    let publicIp = process.env.PUBLIC_IP || process.env.WEBRTC_PUBLIC_IP || options.publicIp

    if (!publicIp) {
      if (this.publicIpCache !== null) {
        publicIp = this.publicIpCache
      } else if (this.publicIpPromise) {
        publicIp = await this.publicIpPromise
      } else {
        this.publicIpPromise = getPublicIPAddress({ timeout: 3000 })
          .then(ip => {
            this.publicIpCache = ip
            this.publicIpPromise = null
            return ip
          })
          .catch(() => {
            this.publicIpCache = null
            this.publicIpPromise = null
            return null
          })

        try {
          publicIp = await Promise.race([
            this.publicIpPromise,
            new Promise(resolve => setTimeout(() => resolve(null), 1000))
          ])
        } catch (err) {
          // Ignore
        }
      }
    }

    const localIp = getFirstIPv4Address() || '127.0.0.1'
    const serverIp = publicIp || localIp

    const transport = await this.router.createWebRtcTransport({
      listenIps: [{ ip: '0.0.0.0', announcedIp: serverIp }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 1000000,
      enableSctp: false
    })

    this.webrtcTransports.set(streamId, transport)

    logger.info('WebRTC transport created', {
      streamId,
      transportId: transport.id
    })

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    }
  }

  /**
   * Connect WebRTC transport
   * @param {string} streamId - Stream ID
   * @param {Object} dtlsParameters - Client DTLS parameters
   * @returns {Promise<void>}
   */
  async connectWebRTCTransport (streamId, dtlsParameters) {
    const transport = this.webrtcTransports.get(streamId)
    if (!transport) {
      throw new Error('WebRTC transport not found')
    }

    await transport.connect({ dtlsParameters })

    logger.info('WebRTC transport connected', {
      streamId,
      transportId: transport.id
    })
  }

  /**
   * Create Consumer for a WebRTC transport
   * @param {string} streamId - Stream ID
   * @param {string} transportId - WebRTC transport ID
   * @param {Object} rtpCapabilities - Client RTP capabilities
   * @returns {Promise<Object>} Consumer parameters
   */
  async createConsumer (streamId, transportId, rtpCapabilities) {
    // Use video producer (video-only preview)
    const producer = this.videoProducer
    if (!producer) {
      throw new Error('Producer not created. Call startPreview() first.')
    }

    const transport = this.webrtcTransports.get(streamId)
    if (!transport || transport.id !== transportId) {
      throw new Error('WebRTC transport not found')
    }

    logger.info('Creating consumer', {
      streamId,
      transportId: transport.id,
      producerId: producer.id,
      transportState: {
        connectionState: transport.connectionState,
        iceState: transport.iceState,
        dtlsState: transport.dtlsState
      }
    })

    // Check if router can consume
    if (!this.router.canConsume({ producerId: producer.id, rtpCapabilities })) {
      logger.error('Cannot consume producer', {
        streamId,
        producerId: producer.id,
        producerKind: producer.kind,
        routerRtpCapabilities: this.router.rtpCapabilities,
        clientRtpCapabilities: rtpCapabilities
      })
      throw new Error('Cannot consume producer with given RTP capabilities')
    }

    // For receive transports, the transport might not be fully connected yet
    // But we can still create the consumer - mediasoup will handle the connection
    // Create Consumer (paused initially, following demo pattern)
    const consumer = await transport.consume({
      producerId: producer.id,
      rtpCapabilities,
      paused: true // Start paused, resume after client is ready
    })

    this.consumers.set(streamId, consumer)

    logger.info('Consumer created successfully', {
      streamId,
      consumerId: consumer.id,
      kind: consumer.kind,
      producerId: consumer.producerId,
      paused: consumer.paused,
      rtpParameters: {
        codecs: consumer.rtpParameters.codecs,
        headerExtensions: consumer.rtpParameters.headerExtensions,
        encodings: consumer.rtpParameters.encodings
      },
      transportState: {
        connectionState: transport.connectionState,
        iceState: transport.iceState,
        dtlsState: transport.dtlsState
      }
    })

    // Log producer RTP parameters for comparison
    logger.info('Producer RTP parameters (for comparison)', {
      streamId,
      producerId: producer.id,
      rtpParameters: {
        codecs: producer.rtpParameters.codecs,
        headerExtensions: producer.rtpParameters.headerExtensions,
        encodings: producer.rtpParameters.encodings
      }
    })

    // Check producer stats before resuming consumer
    try {
      const producerStats = await producer.getStats()
      logger.info('Producer statistics before consumer resume', {
        streamId,
        producerId: producer.id,
        stats: Array.from(producerStats.entries()).map(([id, report]) => ({
          id,
          type: report.type,
          timestamp: report.timestamp,
          ...Object.fromEntries(
            Object.entries(report).filter(([key]) => !['type', 'id', 'timestamp'].includes(key))
          )
        }))
      })
    } catch (err) {
      logger.warn('Failed to get producer stats', { streamId, error: err.message })
    }

    // Resume consumer immediately (for preview, we want it active)
    await consumer.resume()

    logger.info('Consumer resumed', {
      streamId,
      consumerId: consumer.id,
      paused: consumer.paused
    })

    // Check consumer stats after resume
    try {
      const consumerStats = await consumer.getStats()
      const statsArray = Array.from(consumerStats.entries()).map(([id, report]) => ({
        id,
        type: report.type,
        timestamp: report.timestamp,
        ...Object.fromEntries(
          Object.entries(report).filter(([key]) => !['type', 'id', 'timestamp'].includes(key))
        )
      }))

      logger.info('Consumer statistics after resume', {
        streamId,
        consumerId: consumer.id,
        stats: statsArray
      })

      // Check for inbound RTP stats to see if frames are being decoded
      const inboundRtpStats = statsArray.find(s => s.type === 'inbound-rtp')
      if (inboundRtpStats) {
        logger.info('Consumer inbound RTP stats', {
          streamId,
          consumerId: consumer.id,
          bytesReceived: inboundRtpStats.bytesReceived || 0,
          packetsReceived: inboundRtpStats.packetsReceived || 0,
          framesDecoded: inboundRtpStats.framesDecoded || 0,
          framesDropped: inboundRtpStats.framesDropped || 0,
          keyFramesDecoded: inboundRtpStats.keyFramesDecoded || 0,
          mimeType: inboundRtpStats.mimeType,
          payloadType: inboundRtpStats.payloadType
        })

        if (inboundRtpStats.framesDecoded === 0 && inboundRtpStats.packetsReceived > 0) {
          logger.error('Consumer receiving packets but not decoding frames!', {
            streamId,
            consumerId: consumer.id,
            packetsReceived: inboundRtpStats.packetsReceived,
            framesDecoded: inboundRtpStats.framesDecoded,
            mimeType: inboundRtpStats.mimeType,
            payloadType: inboundRtpStats.payloadType,
            consumerCodec: consumer.rtpParameters.codecs?.[0],
            producerCodec: producer.rtpParameters.codecs?.[0]
          })
        }
      }
    } catch (err) {
      logger.warn('Failed to get consumer stats', { streamId, error: err.message })
    }

    return {
      id: consumer.id,
      producerId: consumer.producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      type: consumer.type
    }
  }

  /**
   * Get router RTP capabilities
   * @returns {Object} RTP capabilities
   */
  getRtpCapabilities () {
    if (!this.router) {
      throw new Error('Router not initialized')
    }

    return this.router.rtpCapabilities
  }

  /**
   * Stop preview and cleanup
   * @param {string} streamId - Stream ID
   * @returns {Promise<void>}
   */
  async stopPreview (streamId) {
    logger.info('Stopping preview', { streamId })

    // Reset FFmpeg readiness state
    this.ffmpegReady = false
    this.ffmpegReadyPromise = null
    this.ffmpegReadyResolve = null

    // Stop FFmpeg
    await this.ffmpegClient.stopStream(streamId)

    // Close consumers
    const consumer = this.consumers.get(streamId)
    if (consumer) {
      consumer.close()
      this.consumers.delete(streamId)
    }

    // Close WebRTC transport
    const transport = this.webrtcTransports.get(streamId)
    if (transport) {
      transport.close()
      this.webrtcTransports.delete(streamId)
    }

    // Close video producer
    if (this.videoProducer) {
      this.videoProducer.close()
      this.videoProducer = null
    }

    // Close PlainTransport
    if (this.videoPlainTransport) {
      this.videoPlainTransport.close()
      this.videoPlainTransport = null
    }

    this.isActive = false

    logger.info('Preview stopped', { streamId })
  }

  /**
   * Stop and cleanup everything
   * @returns {Promise<void>}
   */
  async stop () {
    // Stop all FFmpeg processes
    await this.ffmpegClient.close()

    // Close all consumers
    for (const [, consumer] of this.consumers.entries()) {
      consumer.close()
    }
    this.consumers.clear()

    // Close all WebRTC transports
    for (const [, transport] of this.webrtcTransports.entries()) {
      transport.close()
    }
    this.webrtcTransports.clear()

    // Close video producer
    if (this.videoProducer) {
      this.videoProducer.close()
      this.videoProducer = null
    }

    // Close PlainTransport
    if (this.videoPlainTransport) {
      this.videoPlainTransport.close()
      this.videoPlainTransport = null
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

    logger.debug('PreviewBridge stopped')
  }
}

module.exports = PreviewBridge
