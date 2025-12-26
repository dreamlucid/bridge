// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const mediasoup = require('mediasoup')

const Logger = require('../../../lib/Logger')
const logger = new Logger({ name: 'CasparNetworkPlugin' })

/**
 * Mediasoup Bridge - Bridges RTP stream to WebRTC using mediasoup
 *
 * Pipeline: SRT → FFmpeg (SRT to RTP) → PlainTransport → Router → WebRTCTransport → Browser
 *
 * This implementation uses mediasoup's PlainTransport to accept RTP packets directly from FFmpeg.
 * FFmpeg converts the SRT stream to RTP, which is then forwarded to mediasoup's PlainTransport.
 */
class MediasoupBridge {
  constructor (options = {}) {
    this.width = options.width || 1920
    this.height = options.height || 1080
    this.frameRate = options.frameRate || 30

    // WebRTC port range configuration
    // For testing: Use a small fixed range for easier firewall configuration
    // Each transport needs at least 2 ports (UDP + TCP), but mediasoup may need to try multiple ports
    // Using 5 ports gives enough room for allocation attempts while keeping firewall rules simple
    // Can be overridden via environment variables or options
    this.rtcMinPort = options.rtcMinPort || parseInt(process.env.WEBRTC_MIN_PORT || '10000', 10)
    this.rtcMaxPort = options.rtcMaxPort || parseInt(process.env.WEBRTC_MAX_PORT || '10004', 10) // Small range: 5 ports (allows for retries)

    this.worker = null
    this.router = null
    this.plainTransport = null
    this.producer = null
    this.webrtcTransports = new Map() // Map<streamId, WebRTCTransport>
    this.consumers = new Map() // Map<streamId, Consumer>
    this.tuplePromise = null
    this.tupleResolved = false

    this.isActive = false
    this.publicIpCache = null // Cache for public IP to avoid repeated queries
    this.publicIpPromise = null // Promise for ongoing public IP query
  }

  /**
   * Initialize mediasoup worker and router
   * @returns {Promise<void>}
   */
  async initialize () {
    if (this.worker) {
      throw new Error('MediasoupBridge is already initialized')
    }

    // Create mediasoup worker with fixed port range for WebRTC
    // This allows firewall rules to be configured for a specific port range
    this.worker = await mediasoup.createWorker({
      logLevel: 'warn',
      logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
      rtcMinPort: this.rtcMinPort,
      rtcMaxPort: this.rtcMaxPort
    })

    const portRangeSize = this.rtcMaxPort - this.rtcMinPort + 1
    logger.debug('MediasoupBridge: Worker created with WebRTC port range', {
      rtcMinPort: this.rtcMinPort,
      rtcMaxPort: this.rtcMaxPort,
      portRangeSize,
      note: 'Ensure firewall allows UDP and TCP traffic on this port range',
      firewallRule: `Allow UDP and TCP on ports ${this.rtcMinPort}-${this.rtcMaxPort} (${portRangeSize} ports)`,
      gcpCommand: `gcloud compute firewall-rules create allow-webrtc --allow tcp:${this.rtcMinPort}-${this.rtcMaxPort},udp:${this.rtcMinPort}-${this.rtcMaxPort} --source-ranges 0.0.0.0/0 --description "WebRTC ports for mediasoup"`,
      gcpUpdateCommand: `gcloud compute firewall-rules update allow-iap-ssh --allow tcp:22,tcp:5544,tcp:5545,tcp:8080,tcp:8888,tcp:8889,tcp:8189,tcp:${this.rtcMinPort}-${this.rtcMaxPort},udp:6000,udp:7000,udp:8000,udp:9000,udp:6010,udp:6020,udp:6030,udp:9001,udp:9002,udp:8889,udp:8189,udp:${this.rtcMinPort}-${this.rtcMaxPort}`
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
    // Store tuple event promise for waiting
    this.tuplePromise = new Promise((resolve) => {
      this.plainTransport.on('tuple', (tuple) => {
        logger.debug('MediasoupBridge: PlainTransport tuple updated (RTP packets detected)', {
          localIp: tuple.localIp,
          localPort: tuple.localPort,
          remoteIp: tuple.remoteIp,
          remotePort: tuple.remotePort,
          protocol: tuple.protocol
        })
        // Resolve once we have the tuple (packets are arriving)
        if (!this.tupleResolved) {
          this.tupleResolved = true
          resolve(tuple)
        }
      })
    })

    this.plainTransport.on('rtcptuple', (rtcpTuple) => {
      logger.debug('MediasoupBridge: PlainTransport RTCP tuple updated', {
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
    const finalRtpParameters = rtpParameters || {
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

    logger.debug('MediasoupBridge: Creating Producer with RTP parameters', {
      hasCustomParams: !!rtpParameters,
      ssrc: finalRtpParameters.encodings?.[0]?.ssrc,
      payloadType: finalRtpParameters.codecs?.[0]?.payloadType,
      mimeType: finalRtpParameters.codecs?.[0]?.mimeType
    })

    this.producer = await this.plainTransport.produce({
      kind: 'video',
      rtpParameters: finalRtpParameters
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
          stats,
          statsLength: stats?.length,
          statsTypes: stats?.map(s => s.type)
        })
        // Check if Producer is receiving packets
        if (stats && Array.isArray(stats)) {
          // Look for various stat types that might indicate packet reception
          const videoStats = stats.find(s =>
            s.type === 'outbound-rtp' ||
            s.type === 'media-source' ||
            s.type === 'inbound-rtp' ||
            s.type === 'track'
          )
          if (videoStats) {
            // For inbound-rtp stats, use byteCount and packetCount
            // For other stat types, use bytesReceived/packetsReceived
            const bytesReceived = videoStats.byteCount || videoStats.bytesReceived || videoStats.bytes || 0
            const packetsReceived = videoStats.packetCount || videoStats.packetsReceived || videoStats.packets || 0
            const framesReceived = videoStats.framesReceived || 0
            const bitrate = videoStats.bitrate || 0
            if (bytesReceived === 0 && packetsReceived === 0 && framesReceived === 0) {
              logger.warn('MediasoupBridge: Producer not receiving any packets', {
                producerId: this.producer.id,
                stats: videoStats,
                allStats: stats
              })
            } else {
              logger.debug('MediasoupBridge: Producer receiving packets', {
                producerId: this.producer.id,
                bytesReceived,
                packetsReceived,
                framesReceived,
                bitrate,
                statType: videoStats.type,
                ssrc: videoStats.ssrc
              })
            }
          } else {
            // Log all stats to see what we're getting
            logger.debug('MediasoupBridge: Producer stats (no video stats found)', {
              producerId: this.producer.id,
              allStats: stats
            })
          }
        } else {
          logger.warn('MediasoupBridge: Producer stats is not an array', {
            producerId: this.producer.id,
            statsType: typeof stats,
            stats
          })
        }
      } catch (err) {
        logger.warn('MediasoupBridge: Error getting Producer stats', { error: err.message })
      }
    }, 5000) // Every 5 seconds

    this.isActive = true
  }

  /**
   * Process RTP packet and forward to PlainTransport
   * @param {Object} rtpPacket - Parsed RTP packet
   * @deprecated This method is not used - FFmpeg sends RTP packets directly to PlainTransport via UDP
   */
  processRTPPacket (rtpPacket) {
    // This method is currently not used - FFmpeg forwards packets directly
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
      listenIps,
      enableUdp = true,
      enableTcp = true,
      preferUdp = true
    } = options

    // Get the server's IP address for ICE candidates
    // Using 0.0.0.0 creates invalid candidates, so we need a real IP
    // Priority: 1. Environment variable PUBLIC_IP or WEBRTC_PUBLIC_IP
    //           2. Options.publicIp
    //           3. Auto-detected public IP (cached)
    //           4. Detected local IP
    const { getFirstIPv4Address, getPublicIPAddress } = require('../../../lib/network')
    let publicIp = process.env.PUBLIC_IP || process.env.WEBRTC_PUBLIC_IP || options.publicIp

    // If no public IP is configured, try to auto-detect it (with caching)
    if (!publicIp) {
      if (this.publicIpCache !== null) {
        // Use cached value
        publicIp = this.publicIpCache
      } else if (this.publicIpPromise) {
        // Wait for ongoing query
        publicIp = await this.publicIpPromise
      } else {
        // Start new query (non-blocking, will use local IP for now)
        this.publicIpPromise = getPublicIPAddress({ timeout: 3000 })
          .then(ip => {
            this.publicIpCache = ip
            this.publicIpPromise = null
            logger.debug('MediasoupBridge: Public IP auto-detected', { publicIp: ip })
            return ip
          })
          .catch(err => {
            logger.debug('MediasoupBridge: Failed to auto-detect public IP', { error: err.message })
            this.publicIpCache = null // Cache null to avoid repeated failed queries
            this.publicIpPromise = null
            return null
          })

        // Try to get it synchronously if possible, but don't wait too long
        try {
          publicIp = await Promise.race([
            this.publicIpPromise,
            new Promise(resolve => setTimeout(() => resolve(null), 1000)) // 1 second timeout
          ])
        } catch (err) {
          // Ignore errors, will use local IP
        }
      }
    }

    const localIp = getFirstIPv4Address() || '127.0.0.1'
    const serverIp = publicIp || localIp

    // Warn if using a private IP and no public IP is configured
    if (!publicIp && (serverIp.startsWith('10.') || serverIp.startsWith('172.') || serverIp.startsWith('192.168.') || serverIp.startsWith('12.'))) {
      logger.warn('MediasoupBridge: Using private IP for WebRTC transport. Clients on different networks may not be able to connect.', {
        streamId,
        serverIp,
        suggestion: 'Set PUBLIC_IP or WEBRTC_PUBLIC_IP environment variable, or pass publicIp in options'
      })
    }

    logger.debug('MediasoupBridge: Creating WebRTC transport with IP configuration', {
      streamId,
      serverIp,
      isPublicIp: !!publicIp,
      localIp,
      listenIpsProvided: !!listenIps && listenIps.length > 0
    })

    // Create WebRTC transport for browser client
    // Use the server's IP address and set announcedIp to ensure valid ICE candidates
    // Note: If serverIp is a private IP (like 12.0.0.12), clients on different networks won't be able to connect
    // In production, you may need to use the public IP or configure STUN/TURN servers
    const transport = await this.router.createWebRtcTransport({
      listenIps: listenIps && listenIps.length > 0
        ? listenIps
        : [{ ip: '0.0.0.0', announcedIp: serverIp }],
      enableUdp,
      enableTcp,
      preferUdp,
      initialAvailableOutgoingBitrate: 1000000,
      enableSctp: false
      // Add ICE servers for NAT traversal (optional, but recommended for production)
      // iceServers: [
      //   { urls: 'stun:stun.l.google.com:19302' }
      // ]
    })

    // Extract ports from ICE candidates to verify they're in the configured range
    const candidatePorts = transport.iceCandidates?.map(c => c.port) || []
    const portsInRange = candidatePorts.every(port => port >= this.rtcMinPort && port <= this.rtcMaxPort)

    // Generate firewall rule command for easy copy-paste
    const uniquePorts = [...new Set(candidatePorts)].sort((a, b) => a - b)
    const firewallCommand = `gcloud compute firewall-rules create allow-webrtc-${streamId.substring(0, 8)} --allow tcp:${uniquePorts.join(',tcp:')},udp:${uniquePorts.join(',udp:')} --source-ranges 0.0.0.0/0 --description "WebRTC ports for stream ${streamId}"`

    logger.debug('MediasoupBridge: WebRTC transport created with ICE candidates', {
      streamId,
      transportId: transport.id,
      iceCandidatesCount: transport.iceCandidates?.length || 0,
      iceCandidates: transport.iceCandidates?.map(c => ({
        ip: c.ip,
        port: c.port,
        protocol: c.protocol,
        type: c.type,
        address: c.address
      })) || [],
      configuredPortRange: {
        min: this.rtcMinPort,
        max: this.rtcMaxPort
      },
      actualPorts: candidatePorts,
      uniquePorts,
      portsInRange,
      firewallNote: portsInRange
        ? `All ports (${uniquePorts.join(', ')}) are in configured range ${this.rtcMinPort}-${this.rtcMaxPort}. Ensure firewall allows UDP/TCP on these ports.`
        : `WARNING: Some ports are outside configured range ${this.rtcMinPort}-${this.rtcMaxPort}. Check firewall rules.`,
      firewallCommand,
      gcpFirewallNote: 'If using GCP with targetTags, ensure your instance has the required tag, or create a rule without targetTags'
    })

    this.webrtcTransports.set(streamId, transport)

    // Set up transport event handlers for debugging
    transport.on('icestatechange', (iceState) => {
      logger.debug('MediasoupBridge: WebRTC transport ICE state changed', {
        streamId,
        transportId: transport.id,
        iceState,
        currentDtlsState: transport.dtlsState,
        iceConnectionState: transport.iceConnectionState,
        hasIceSelectedTuple: !!transport.iceSelectedTuple,
        iceSelectedTuple: transport.iceSelectedTuple
          ? {
              localIp: transport.iceSelectedTuple.localIp,
              localPort: transport.iceSelectedTuple.localPort,
              remoteIp: transport.iceSelectedTuple.remoteIp,
              remotePort: transport.iceSelectedTuple.remotePort,
              protocol: transport.iceSelectedTuple.protocol
            }
          : null,
        note: 'ICE state progression: new -> checking -> connected -> completed (or failed if connectivity fails)'
      })

      // Log specific state transitions with diagnostics
      if (iceState === 'checking') {
        logger.debug('MediasoupBridge: ICE connectivity checks started', {
          streamId,
          transportId: transport.id,
          note: 'Client should be attempting to connect to server ICE candidates. If this state persists, check firewall rules.'
        })
      } else if (iceState === 'connected' || iceState === 'completed') {
        logger.debug('MediasoupBridge: ICE connection established!', {
          streamId,
          transportId: transport.id,
          iceState,
          hasIceSelectedTuple: !!transport.iceSelectedTuple,
          iceSelectedTuple: transport.iceSelectedTuple
        })
      } else if (iceState === 'failed') {
        logger.error('MediasoupBridge: ICE connection failed!', {
          streamId,
          transportId: transport.id,
          possibleCauses: [
            'Firewall blocking required ports',
            'Client cannot reach server at announced IP (34.14.131.146)',
            'Network connectivity issues',
            'NAT traversal failed'
          ],
          recommendation: 'Check firewall rules and verify ports are accessible. Test with: nc -zv 34.14.131.146 <port>'
        })
      }
    })

    transport.on('iceselectedtuplechange', (tuple) => {
      logger.debug('MediasoupBridge: WebRTC transport ICE selected tuple changed', {
        streamId,
        transportId: transport.id,
        tuple: tuple
          ? {
              localIp: tuple.localIp,
              localPort: tuple.localPort,
              remoteIp: tuple.remoteIp,
              remotePort: tuple.remotePort,
              protocol: tuple.protocol
            }
          : null,
        iceState: transport.iceState,
        dtlsState: transport.dtlsState
      })
    })

    transport.on('dtlsstatechange', (dtlsState) => {
      logger.debug('MediasoupBridge: WebRTC transport DTLS state changed', {
        streamId,
        transportId: transport.id,
        dtlsState,
        currentIceState: transport.iceState,
        iceConnectionState: transport.iceConnectionState,
        hasIceSelectedTuple: !!transport.iceSelectedTuple
      })
      if (dtlsState === 'connected') {
        logger.debug('MediasoupBridge: WebRTC transport DTLS connected!', {
          streamId,
          transportId: transport.id
        })
      } else if (dtlsState === 'failed') {
        logger.error('MediasoupBridge: WebRTC transport DTLS failed!', {
          streamId,
          transportId: transport.id
        })
      }
    })

    transport.on('connectionstatechange', (connectionState) => {
      logger.debug('MediasoupBridge: WebRTC transport connection state changed', {
        streamId,
        transportId: transport.id,
        connectionState,
        iceState: transport.iceState,
        dtlsState: transport.dtlsState,
        hasIceSelectedTuple: !!transport.iceSelectedTuple,
        iceSelectedTuple: transport.iceSelectedTuple
          ? {
              localIp: transport.iceSelectedTuple.localIp,
              localPort: transport.iceSelectedTuple.localPort,
              remoteIp: transport.iceSelectedTuple.remoteIp,
              remotePort: transport.iceSelectedTuple.remotePort,
              protocol: transport.iceSelectedTuple.protocol
            }
          : null
      })

      // Log detailed diagnostics when connection fails
      if (connectionState === 'failed' || connectionState === 'disconnected') {
        logger.error('MediasoupBridge: WebRTC transport connection failed!', {
          streamId,
          transportId: transport.id,
          connectionState,
          iceState: transport.iceState,
          dtlsState: transport.dtlsState,
          hasIceSelectedTuple: !!transport.iceSelectedTuple,
          iceSelectedTuple: transport.iceSelectedTuple,
          diagnostic: 'Connection failed during ICE/DTLS handshake',
          possibleCauses: [
            'Firewall blocking UDP/TCP ports on the server',
            'Client cannot reach server at announced IP (34.14.131.146)',
            'NAT traversal failed - symmetric NAT preventing connection',
            'DTLS handshake failed - encryption negotiation failed',
            'Network connectivity issues between client and server'
          ],
          recommendations: [
            `Ensure firewall allows UDP and TCP traffic on port range ${this.rtcMinPort}-${this.rtcMaxPort}`,
            'Verify server firewall rule is applied and ports are accessible',
            'Check if client and server can reach each other',
            'For production, configure STUN/TURN servers for NAT traversal'
          ],
          configuredPortRange: {
            min: this.rtcMinPort,
            max: this.rtcMaxPort
          }
        })
      }
    })

    // Log initial state
    logger.debug('MediasoupBridge: WebRTC transport event handlers registered', {
      streamId,
      transportId: transport.id,
      initialIceState: transport.iceState,
      initialDtlsState: transport.dtlsState,
      initialConnectionState: transport.connectionState,
      iceCandidatesCount: transport.iceCandidates?.length || 0
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
      iceCandidatesCount: transport.iceCandidates?.length || 0,
      dtlsParameters: transport.dtlsParameters,
      iceCandidates: transport.iceCandidates
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
            logger.debug('MediasoupBridge: Producer is receiving packets, creating Consumer', {
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

    // Check transport state before creating Consumer
    const transportStateBefore = {
      connectionState: transport.connectionState,
      iceState: transport.iceState,
      dtlsState: transport.dtlsState,
      iceConnectionState: transport.iceConnectionState,
      hasIceSelectedTuple: !!transport.iceSelectedTuple
    }

    logger.debug('MediasoupBridge: Transport state before creating Consumer', {
      streamId,
      transportId: transport.id,
      ...transportStateBefore
    })

    // Warn if transport is not fully connected
    if (transport.iceState !== 'connected' && transport.iceState !== 'completed') {
      logger.warn('MediasoupBridge: Transport ICE state is not connected - Consumer may not be able to send data', {
        streamId,
        transportId: transport.id,
        iceState: transport.iceState,
        dtlsState: transport.dtlsState,
        connectionState: transport.connectionState,
        iceConnectionState: transport.iceConnectionState,
        hasIceSelectedTuple: !!transport.iceSelectedTuple,
        note: 'The Consumer will be created but may not send data until the transport is fully connected. This usually indicates firewall/NAT issues preventing ICE connectivity.'
      })
    }

    // Also check DTLS state
    if (transport.dtlsState !== 'connected') {
      logger.warn('MediasoupBridge: Transport DTLS state is not connected', {
        streamId,
        transportId: transport.id,
        dtlsState: transport.dtlsState,
        iceState: transport.iceState,
        connectionState: transport.connectionState,
        note: 'DTLS handshake must complete before media can flow'
      })
    }

    // Wait for transport to be fully connected before creating Consumer
    // This ensures the Consumer is properly initialized and can send data
    const isTransportReady = () => {
      const iceReady = transport.iceState === 'connected' || transport.iceState === 'completed'
      const dtlsReady = transport.dtlsState === 'connected'
      return iceReady && dtlsReady
    }

    if (!isTransportReady()) {
      logger.debug('MediasoupBridge: Waiting for transport to be fully connected before creating Consumer', {
        streamId,
        transportId: transport.id,
        currentIceState: transport.iceState,
        currentDtlsState: transport.dtlsState,
        timeout: '10 seconds'
      })

      // Wait up to 10 seconds for transport to be ready
      const maxWaitTime = 10000 // 10 seconds
      const checkInterval = 100 // Check every 100ms
      const startTime = Date.now()

      while (!isTransportReady() && (Date.now() - startTime) < maxWaitTime) {
        await new Promise(resolve => setTimeout(resolve, checkInterval))
      }

      if (!isTransportReady()) {
        logger.warn('MediasoupBridge: Transport did not become ready within timeout, creating Consumer anyway', {
          streamId,
          transportId: transport.id,
          iceState: transport.iceState,
          dtlsState: transport.dtlsState,
          waitTime: Date.now() - startTime
        })
      } else {
        logger.debug('MediasoupBridge: Transport is now ready, creating Consumer', {
          streamId,
          transportId: transport.id,
          iceState: transport.iceState,
          dtlsState: transport.dtlsState,
          waitTime: Date.now() - startTime
        })
      }
    }

    // Create Consumer
    const consumer = await transport.consume({
      producerId: this.producer.id,
      rtpCapabilities,
      paused: false
    })

    this.consumers.set(streamId, consumer)

    // Log transport state immediately after Consumer creation
    const transportStateAfter = {
      connectionState: transport.connectionState,
      iceState: transport.iceState,
      dtlsState: transport.dtlsState,
      iceConnectionState: transport.iceConnectionState,
      hasIceSelectedTuple: !!transport.iceSelectedTuple,
      iceSelectedTuple: transport.iceSelectedTuple
        ? {
            localIp: transport.iceSelectedTuple.localIp,
            localPort: transport.iceSelectedTuple.localPort,
            remoteIp: transport.iceSelectedTuple.remoteIp,
            remotePort: transport.iceSelectedTuple.remotePort,
            protocol: transport.iceSelectedTuple.protocol
          }
        : null
    }

    logger.debug('MediasoupBridge: Consumer created', {
      streamId,
      consumerId: consumer.id,
      kind: consumer.kind,
      producerId: consumer.producerId,
      type: consumer.type,
      paused: consumer.paused,
      transportStateBefore,
      transportStateAfter,
      warning: (transport.iceState !== 'connected' && transport.iceState !== 'completed') || transport.dtlsState !== 'connected'
        ? 'Transport is not fully connected - Consumer may not be able to send data. Check firewall rules and ICE/DTLS state.'
        : null
    })

    // Set up Consumer event handlers for debugging
    consumer.on('transportclose', () => {
      logger.warn('MediasoupBridge: Consumer transport closed', { streamId, consumerId: consumer.id })
    })

    consumer.on('producerclose', () => {
      logger.warn('MediasoupBridge: Consumer producer closed', { streamId, consumerId: consumer.id })
    })

    // Monitor Consumer stats periodically to track data flow
    const consumerStatsInterval = setInterval(async () => {
      try {
        // First check if the transport is connected
        const transportStats = await transport.getStats()
        const transportStatsObj = transportStats.find(s => s.type === 'webrtc-transport')

        logger.debug('MediasoupBridge: WebRTC transport stats', {
          streamId,
          transportId: transport.id,
          connectionState: transport.connectionState,
          iceState: transport.iceState,
          dtlsState: transport.dtlsState,
          iceConnectionState: transport.iceConnectionState,
          hasIceSelectedTuple: !!transport.iceSelectedTuple,
          bytesReceived: transportStatsObj?.bytesReceived || 0,
          bytesSent: transportStatsObj?.bytesSent || 0,
          rtpBytesReceived: transportStatsObj?.rtpBytesReceived || 0,
          rtpBytesSent: transportStatsObj?.rtpBytesSent || 0
        })

        const consumerStats = await consumer.getStats()
        if (consumerStats && Array.isArray(consumerStats)) {
          const outboundRtpStats = consumerStats.find(s => s.type === 'outbound-rtp')
          if (outboundRtpStats) {
            const bytesSent = outboundRtpStats.byteCount || outboundRtpStats.bytesSent || 0
            const packetsSent = outboundRtpStats.packetCount || outboundRtpStats.packetsSent || 0
            const bitrate = outboundRtpStats.bitrate || 0
            if (bytesSent > 0 || packetsSent > 0) {
              logger.debug('MediasoupBridge: Consumer sending data', {
                streamId,
                consumerId: consumer.id,
                bytesSent,
                packetsSent,
                bitrate
              })
            } else {
              // Check Producer stats to see if it's still receiving data
              try {
                const producerStats = await this.producer.getStats()
                if (producerStats && Array.isArray(producerStats)) {
                  const inboundRtpStats = producerStats.find(s => s.type === 'inbound-rtp')
                  if (inboundRtpStats) {
                    const producerByteCount = inboundRtpStats.byteCount || 0
                    const producerPacketCount = inboundRtpStats.packetCount || 0
                    logger.warn('MediasoupBridge: Consumer not sending any data', {
                      streamId,
                      consumerId: consumer.id,
                      producerId: consumer.producerId,
                      producerPaused: this.producer?.paused,
                      producerByteCount,
                      producerPacketCount,
                      producerReceivingData: producerByteCount > 0 || producerPacketCount > 0,
                      transportState: {
                        connectionState: transport.connectionState,
                        iceState: transport.iceState,
                        dtlsState: transport.dtlsState,
                        iceConnectionState: transport.iceConnectionState,
                        hasIceSelectedTuple: !!transport.iceSelectedTuple,
                        iceSelectedTuple: transport.iceSelectedTuple
                          ? {
                              localIp: transport.iceSelectedTuple.localIp,
                              localPort: transport.iceSelectedTuple.localPort,
                              remoteIp: transport.iceSelectedTuple.remoteIp,
                              remotePort: transport.iceSelectedTuple.remotePort,
                              protocol: transport.iceSelectedTuple.protocol
                            }
                          : null
                      },
                      diagnostic: 'Producer is receiving data but Consumer is not sending. This usually means the WebRTC transport is not fully connected (ICE/DTLS handshake incomplete).',
                      possibleCauses: [
                        'Firewall blocking required ports',
                        'ICE handshake not completed (check server logs for ICE state)',
                        'DTLS handshake not completed (check server logs for DTLS state)',
                        'Client cannot reach server at announced IP'
                      ]
                    })
                  } else {
                    logger.warn('MediasoupBridge: Consumer not sending any data (no Producer inbound-rtp stats)', {
                      streamId,
                      consumerId: consumer.id,
                      producerId: consumer.producerId,
                      producerPaused: this.producer?.paused
                    })
                  }
                }
              } catch (err) {
                logger.warn('MediasoupBridge: Consumer not sending any data (could not check Producer stats)', {
                  streamId,
                  consumerId: consumer.id,
                  producerId: consumer.producerId,
                  producerPaused: this.producer?.paused,
                  error: err.message
                })
              }
            }
          }
        }
      } catch (err) {
        logger.warn('MediasoupBridge: Could not get Consumer stats', { error: err.message })
      }
    }, 5000) // Check every 5 seconds

    // Clear interval after 60 seconds
    setTimeout(() => {
      clearInterval(consumerStatsInterval)
    }, 60000)

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
      dtlsRole: dtlsParameters.role,
      dtlsFingerprintsCount: dtlsParameters.fingerprints?.length,
      currentIceState: transport.iceState,
      currentDtlsState: transport.dtlsState
    })

    try {
      await transport.connect({ dtlsParameters })

      // Check transport state after connection attempt
      logger.debug('MediasoupBridge: WebRTC transport connect() called successfully', {
        streamId,
        transportId: transport.id,
        iceStateAfterConnect: transport.iceState,
        dtlsStateAfterConnect: transport.dtlsState
      })

      // Monitor state changes to see if connection progresses
      setTimeout(async () => {
        const stats = await transport.getStats()
        const transportStats = stats.find(s => s.type === 'webrtc-transport')
        logger.debug('MediasoupBridge: WebRTC transport state 2 seconds after connect()', {
          streamId,
          transportId: transport.id,
          iceState: transport.iceState,
          dtlsState: transport.dtlsState,
          iceConnectionState: transport.iceConnectionState,
          connectionState: transport.connectionState,
          hasIceSelectedTuple: !!transport.iceSelectedTuple,
          iceSelectedTuple: transport.iceSelectedTuple
            ? {
                localIp: transport.iceSelectedTuple.localIp,
                localPort: transport.iceSelectedTuple.localPort,
                remoteIp: transport.iceSelectedTuple.remoteIp,
                remotePort: transport.iceSelectedTuple.remotePort,
                protocol: transport.iceSelectedTuple.protocol
              }
            : null,
          bytesReceived: transportStats?.bytesReceived || 0,
          bytesSent: transportStats?.bytesSent || 0,
          rtpBytesReceived: transportStats?.rtpBytesReceived || 0,
          rtpBytesSent: transportStats?.rtpBytesSent || 0,
          stats
        })

        // If still in 'new' state, provide diagnostic information
        if (transport.iceState === 'new' && transport.dtlsState === 'new') {
          const firstCandidate = transport.iceCandidates?.[0]
          logger.warn('MediasoupBridge: WebRTC transport still in initial state - connection may be blocked', {
            streamId,
            transportId: transport.id,
            serverIp: firstCandidate?.ip || 'unknown',
            iceCandidates: transport.iceCandidates?.map(c => ({
              ip: c.ip,
              port: c.port,
              protocol: c.protocol,
              type: c.type
            })) || [],
            diagnostic: 'The ICE handshake has not started. This usually means:',
            possibleCauses: [
              'Firewall is blocking UDP/TCP ports on the server',
              'Client cannot reach the server at the announced IP',
              'NAT traversal is required (STUN/TURN servers may be needed)',
              'Network connectivity issues between client and server'
            ],
            recommendations: [
              `Ensure firewall allows UDP and TCP traffic on port range ${this.rtcMinPort}-${this.rtcMaxPort}`,
              'If using GCP, add firewall rule: gcloud compute firewall-rules create allow-webrtc --allow udp,tcp --source-ranges 0.0.0.0/0 --ports ' + `${this.rtcMinPort}-${this.rtcMaxPort}`,
              'For production, configure STUN/TURN servers for NAT traversal',
              `Port range is configured via WEBRTC_MIN_PORT and WEBRTC_MAX_PORT environment variables (current: ${this.rtcMinPort}-${this.rtcMaxPort})`
            ],
            configuredPortRange: {
              min: this.rtcMinPort,
              max: this.rtcMaxPort,
              size: this.rtcMaxPort - this.rtcMinPort + 1
            }
          })
        }
      }, 2000)
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

    logger.debug('MediasoupBridge: Stopped')
  }

  /**
   * Get statistics
   * @returns {Object} Statistics
   */
  getStats () {
    return {
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
