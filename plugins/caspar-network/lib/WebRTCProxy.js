// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const { spawn } = require('child_process')
const { WebSocketServer } = require('ws')
const http = require('http')
const net = require('net')
const crypto = require('crypto')

const { exec } = require('child_process')
const { promisify } = require('util')
const execAsync = promisify(exec)

const Logger = require('../../../lib/Logger')
const logger = new Logger({ name: 'CasparNetworkPlugin' })
const WHIPServer = require('./WHIPServer')
const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = require('wrtc')
const { FFMPEG_WEBRTC_PATH } = require('./paths')

/**
 * Manages WebRTC proxy processes for SRT streams
 * Provides low-latency real-time preview using WebRTC
 */
class WebRTCProxy {
  constructor () {
    /** @type {Map<string, {process: any, ws: any, srtUrl: string, browserPC: RTCPeerConnection | null}>} */
    this.activeProxies = new Map()
    this.wss = null
    this.server = null
    this.port = 0 // Will be set when server starts
    this.whipServer = new WHIPServer(8080) // WHIP server for FFmpeg
    this.whipPort = 0 // Will be set when WHIP server starts
  }

  /**
   * Check if a port is available
   * @param {number} port - Port to check
   * @returns {Promise<boolean>} True if port is available
   */
  async isPortAvailable (port) {
    return new Promise((resolve) => {
      const tester = net.createServer()
        .once('error', (err) => {
          // If port is in use, it's not available
          // For other errors, we'll assume port is not available to be safe
          // Error is expected when checking port availability, so we don't log it
          if (err.code === 'EADDRINUSE') {
            resolve(false)
          } else {
            // Other errors also mean port is not available
            resolve(false)
          }
        })
        .once('listening', () => {
          // Port is available if we can listen on it
          tester.once('close', () => resolve(true))
            .close()
        })
        .listen(port, '0.0.0.0')
    })
  }

  /**
   * Start WebSocket signaling server for WebRTC
   * Idempotent: will not create or start if server is already running
   */
  async startSignalingServer (port = 5545) {
    // Check if server is already running and listening
    if (this.server && this.server.listening && this.wss) {
      logger.debug('WebRTC signaling server already running', { port: this.port })
      return this.port
    }

    // If server exists but not listening, clean it up first
    if (this.server && !this.server.listening) {
      logger.debug('Cleaning up non-listening server before restart')
      if (this.wss) {
        this.wss.close()
        this.wss = null
      }
      this.server.removeAllListeners() // Remove all event listeners
      this.server.close()
      this.server = null
    }

    // Check if port is available before attempting to listen
    const portAvailable = await this.isPortAvailable(port)
    if (!portAvailable) {
      logger.warn('Port is already in use, server may already be running from previous instance', { port })
      // Return the port anyway - the server might be from a previous instance
      // that will be cleaned up, or it might be a different process
      this.port = port
      return port
    }

    this.server = http.createServer()
    this.wss = new WebSocketServer({ server: this.server })

    // Handle server errors (e.g., port already in use)
    // This MUST be set up before calling listen() to catch EADDRINUSE errors
    // Use 'once' to ensure it's handled, but also set up a regular handler as backup
    let listenError = null
    const errorHandler = (err) => {
      if (err.code === 'EADDRINUSE') {
        logger.warn('Port already in use during listen, server may already be running', {
          port,
          error: err.message
        })
        listenError = err
        // Clean up the failed server instance
        if (this.server) {
          this.server.removeAllListeners()
          this.server.close(() => {
            this.server = null
            this.wss = null
          })
        }
        // Don't throw - the port might be in use from a previous process that hasn't fully closed
        // The server will remain unavailable, but the app won't crash
      } else {
        logger.error('Server error', { port, error: err.message })
        listenError = err
      }
    }

    // Set up error handler BEFORE listen() - critical for catching EADDRINUSE
    this.server.once('error', errorHandler)
    this.server.on('error', errorHandler)

    // Set up WebSocket connection handler before listening
    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url, 'http://localhost')
      const streamId = url.searchParams.get('streamId')

      if (!streamId) {
        logger.warn('WebSocket connection without streamId')
        ws.close()
        return
      }

      logger.debug('WebRTC client connected', { streamId })

      // Store WebSocket connection
      const proxy = this.activeProxies.get(streamId)
      if (proxy) {
        proxy.ws = ws
      }

      ws.on('message', async (message) => {
        try {
          const data = JSON.parse(message)
          await this.handleSignalingMessage(streamId, data)
        } catch (err) {
          logger.error('Error handling signaling message', { streamId, error: err.message })
        }
      })

      ws.on('close', () => {
        logger.debug('WebRTC client disconnected', { streamId })
        const proxy = this.activeProxies.get(streamId)
        if (proxy && proxy.ws === ws) {
          proxy.ws = null
        }
      })

      ws.on('error', (err) => {
        logger.error('WebSocket error', { streamId, error: err.message })
      })
    })

    // Return a promise that resolves when the server is actually listening
    return new Promise((resolve, reject) => {
      try {
        this.server.listen(port, '0.0.0.0', () => {
          // Only set port if we successfully started listening
          if (this.server && this.server.listening && !listenError) {
            const address = this.server.address()
            this.port = address.port
            logger.info('WebRTC signaling server started', { port: this.port })
            resolve(this.port)
          } else if (listenError) {
            // If there was an error but we're returning the port anyway
            this.port = port
            resolve(port)
          } else {
            this.port = port
            resolve(port)
          }
        })
      } catch (err) {
        // This catch won't catch async errors, but it's good to have
        if (err.code === 'EADDRINUSE') {
          logger.warn('Port already in use (synchronous error)', { port, error: err.message })
          this.server = null
          this.wss = null
          this.port = port
          resolve(port)
        } else {
          reject(err)
        }
      }
    })
  }

  /**
   * Generate DTLS fingerprint for WebRTC
   * Note: This generates a deterministic fingerprint for SDP validation.
   * A full DTLS implementation would require actual certificate handling.
   * @returns {string} DTLS fingerprint in format "SHA-256 <hash>"
   */
  generateDTLSFingerprint () {
    // Generate a deterministic fingerprint for WebRTC SDP validation
    // Since we're bridging RTP (not SRTP), this is mainly for SDP compatibility
    // In a full implementation, this would use an actual DTLS certificate
    const keyPair = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: {
        type: 'spki',
        format: 'der'
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'der'
      }
    })

    // Use the public key's DER encoding to generate fingerprint
    // In a real implementation, this would be the certificate's DER encoding
    const fingerprint = crypto.createHash('sha256').update(keyPair.publicKey).digest('hex')

    // Format as WebRTC expects: uppercase hex with colons
    const formattedFingerprint = fingerprint.match(/.{2}/g).join(':').toUpperCase()

    return `SHA-256 ${formattedFingerprint}`
  }

  /**
   * Parse client offer to extract supported codecs
   * @param {string} offerSDP - Client's offer SDP
   * @returns {Object} Codec information
   */
  parseOfferCodecs (offerSDP) {
    const codecs = []
    const lines = offerSDP.split('\r\n')
    let inVideoSection = false
    let payloadTypes = []

    for (const line of lines) {
      if (line.startsWith('m=video')) {
        inVideoSection = true
        // Extract payload types from media line: m=video PORT PROTO PT1 PT2 ...
        const match = line.match(/m=video \d+ \S+ (.+)/)
        if (match) {
          payloadTypes = match[1].split(' ').filter(pt => pt.trim())
        }
      } else if (line.startsWith('m=')) {
        inVideoSection = false
      } else if (inVideoSection && line.startsWith('a=rtpmap:')) {
        // Parse rtpmap: a=rtpmap:PT CODEC/CLOCKRATE
        const match = line.match(/a=rtpmap:(\d+) (\w+)\/(\d+)/)
        if (match && payloadTypes.includes(match[1])) {
          codecs.push({
            payloadType: match[1],
            codec: match[2],
            clockRate: match[3]
          })
        }
      }
    }

    // Prefer H.264, then VP8, then VP9
    const preferredOrder = ['H264', 'VP8', 'VP9']
    codecs.sort((a, b) => {
      const aIndex = preferredOrder.indexOf(a.codec)
      const bIndex = preferredOrder.indexOf(b.codec)
      if (aIndex === -1 && bIndex === -1) return 0
      if (aIndex === -1) return 1
      if (bIndex === -1) return -1
      return aIndex - bIndex
    })

    return codecs[0] || { payloadType: '96', codec: 'H264', clockRate: '90000' }
  }

  /**
   * Parse offer SDP to extract m-line structure
   * @param {string} offerSDP - Client's offer SDP
   * @returns {Array} Array of m-line info objects
   */
  parseOfferMLines (offerSDP) {
    const lines = offerSDP.split('\r\n')
    const mLines = []
    let currentMLine = null

    for (const line of lines) {
      if (line.startsWith('m=')) {
        // Save previous m-line if exists
        if (currentMLine) {
          mLines.push(currentMLine)
        }

        // Parse m-line: m=<media> <port> <proto> <fmt> ...
        const match = line.match(/m=(audio|video|application) (\d+) (\S+)(.*)/)
        if (match) {
          currentMLine = {
            type: match[1],
            port: parseInt(match[2], 10),
            protocol: match[3],
            formats: match[4].trim().split(' ').filter(f => f),
            mid: null,
            codecs: [],
            setup: null // Will store DTLS setup attribute
          }
        }
      } else if (currentMLine && line.startsWith('a=mid:')) {
        currentMLine.mid = line.substring(6)
      } else if (currentMLine && line.startsWith('a=setup:')) {
        // Extract DTLS setup attribute: a=setup:actpass, a=setup:active, or a=setup:passive
        const setupMatch = line.match(/a=setup:(actpass|active|passive)/)
        if (setupMatch) {
          currentMLine.setup = setupMatch[1]
        }
      } else if (currentMLine && line.startsWith('a=rtpmap:')) {
        // Parse rtpmap to get codec info
        const match = line.match(/a=rtpmap:(\d+) (\w+)\/(\d+)/)
        if (match && currentMLine.formats.includes(match[1])) {
          currentMLine.codecs.push({
            payloadType: match[1],
            codec: match[2],
            clockRate: match[3]
          })
        }
      }
    }

    // Add last m-line
    if (currentMLine) {
      mLines.push(currentMLine)
    }

    // Assign mid indices if not present
    mLines.forEach((mLine, index) => {
      if (!mLine.mid) {
        mLine.mid = index.toString()
      }
    })

    return mLines
  }

  /**
   * Create WebRTC answer SDP matching offer structure
   * @param {string} offerSDP - Client's offer SDP
   * @param {string} ffmpegSDP - FFmpeg's RTP SDP (optional)
   * @param {number} videoPort - RTP port for video
   * @returns {string} WebRTC-compatible answer SDP
   */
  createWebRTCAnswerSDP (offerSDP, ffmpegSDP, videoPort) {
    const answerLines = []
    const dtlsFingerprint = this.generateDTLSFingerprint()

    // Parse offer to get m-line structure
    const offerMLines = this.parseOfferMLines(offerSDP)

    // Parse session-level setup attribute as fallback
    // (media-level setup takes precedence, but session-level can be used as default)
    const offerLines = offerSDP.split('\r\n')
    let sessionSetup = null
    let foundFirstMLine = false
    for (const line of offerLines) {
      if (line.startsWith('m=')) {
        foundFirstMLine = true
      } else if (!foundFirstMLine && line.startsWith('a=setup:')) {
        // Session-level setup (before any m= line)
        const setupMatch = line.match(/a=setup:(actpass|active|passive)/)
        if (setupMatch) {
          sessionSetup = setupMatch[1]
          break
        }
      }
    }

    // Parse FFmpeg SDP for codec info
    let ffmpegPayloadType = null
    let ffmpegCodec = null
    if (ffmpegSDP) {
      const ffmpegLines = ffmpegSDP.split('\r\n')
      for (const line of ffmpegLines) {
        if (line.startsWith('m=video')) {
          const match = line.match(/m=video \d+ RTP\/AVP (\d+)/)
          if (match) {
            ffmpegPayloadType = match[1]
          }
        } else if (line.startsWith('a=rtpmap:') && ffmpegPayloadType && line.includes(ffmpegPayloadType)) {
          const match = line.match(/a=rtpmap:\d+ (H264|VP8|VP9)\/90000/)
          if (match) {
            ffmpegCodec = match[1]
          }
        }
      }
    }

    // Session-level attributes
    answerLines.push('v=0')
    answerLines.push(`o=- ${Date.now()} ${Date.now()} IN IP4 127.0.0.1`)
    answerLines.push('s=FFmpeg WebRTC Bridge')
    answerLines.push('t=0 0')

    // Collect active m-line MIDs for BUNDLE group (only include accepted streams)
    const activeMids = []

    // Create answer m-lines matching offer order
    offerMLines.forEach((offerMLine) => {
      if (offerMLine.type === 'video') {
        // Accept video with our stream
        const videoCodec = offerMLine.codecs.find(c => ['H264', 'VP8', 'VP9'].includes(c.codec)) || offerMLine.codecs[0]
        const useCodec = ffmpegCodec || (videoCodec ? videoCodec.codec : 'H264')
        const usePayloadType = ffmpegPayloadType || (videoCodec ? videoCodec.payloadType : '96')

        // Determine DTLS setup attribute for answer
        // RFC 5763: Answerer must use 'active' or 'passive', not 'actpass'
        // If offer has 'actpass', answer should use 'passive'
        // If offer has 'active', answer should use 'passive'
        // If offer has 'passive', answer should use 'active'
        // Media-level setup takes precedence over session-level
        const offerSetup = offerMLine.setup || sessionSetup
        let setupValue = 'passive' // Default
        if (offerSetup) {
          if (offerSetup === 'actpass' || offerSetup === 'active') {
            setupValue = 'passive'
          } else if (offerSetup === 'passive') {
            setupValue = 'active'
          }
        }

        // Add to active MIDs for BUNDLE
        activeMids.push(offerMLine.mid)

        answerLines.push(`m=video ${videoPort} RTP/SAVPF ${usePayloadType}`)
        answerLines.push('c=IN IP4 127.0.0.1')
        answerLines.push('a=rtcp:9 IN IP4 0.0.0.0')
        answerLines.push('a=ice-ufrag:4x5b')
        answerLines.push('a=ice-pwd:4x5b4x5b4x5b4x5b4x5b4x')
        answerLines.push('a=ice-options:trickle')
        answerLines.push('a=fingerprint:sha-256 ' + dtlsFingerprint.split(' ')[1])
        answerLines.push(`a=setup:${setupValue}`)
        answerLines.push(`a=mid:${offerMLine.mid}`)
        answerLines.push('a=sendonly')
        answerLines.push('a=rtcp-mux')
        answerLines.push(`a=rtpmap:${usePayloadType} ${useCodec}/90000`)

        // Add codec-specific fmtp attributes
        if (useCodec === 'H264') {
          answerLines.push(`a=fmtp:${usePayloadType} level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f`)
        } else if (useCodec === 'VP8') {
          answerLines.push(`a=fmtp:${usePayloadType} max-fr=30;max-fs=3600`)
        } else if (useCodec === 'VP9') {
          answerLines.push(`a=fmtp:${usePayloadType} max-fr=30;max-fs=3600`)
        }

        // Add RTCP feedback attributes
        answerLines.push(`a=rtcp-fb:${usePayloadType} ccm fir`)
        answerLines.push(`a=rtcp-fb:${usePayloadType} nack`)
        answerLines.push(`a=rtcp-fb:${usePayloadType} nack pli`)
        answerLines.push(`a=rtcp-fb:${usePayloadType} goog-remb`)
      } else if (offerMLine.type === 'audio') {
        // Reject audio (port 0) - must include at least one payload type and match offer protocol exactly
        const audioPayloadType = offerMLine.formats.length > 0 ? offerMLine.formats[0] : '0'
        // Use the exact protocol from the offer
        answerLines.push(`m=audio 0 ${offerMLine.protocol} ${audioPayloadType}`)
        answerLines.push('c=IN IP4 0.0.0.0')
        answerLines.push(`a=mid:${offerMLine.mid}`)
        answerLines.push('a=inactive')
        // Do NOT include ICE/DTLS attributes for rejected streams
      } else {
        // Reject other media types (port 0) - must include at least one format
        const format = offerMLine.formats.length > 0 ? offerMLine.formats[0] : '0'
        answerLines.push(`m=${offerMLine.type} 0 ${offerMLine.protocol} ${format}`)
        answerLines.push('c=IN IP4 0.0.0.0')
        answerLines.push(`a=mid:${offerMLine.mid}`)
        answerLines.push('a=inactive')
        // Do NOT include ICE/DTLS attributes for rejected streams
      }
    })

    // Add BUNDLE group and msid-semantic after session description (after "t=0 0")
    // Insert at index 4 (after v=0, o=-, s=, t=0 0)
    if (activeMids.length > 0) {
      answerLines.splice(4, 0, `a=group:BUNDLE ${activeMids.join(' ')}`)
      answerLines.splice(5, 0, 'a=msid-semantic: WMS')
    } else {
      answerLines.splice(4, 0, 'a=msid-semantic: WMS')
    }

    return answerLines.join('\r\n') + '\r\n'
  }

  /**
   * Handle WebRTC signaling messages
   * Bridges browser WebRTC to FFmpeg WHIP stream
   */
  async handleSignalingMessage (streamId, data) {
    const proxy = this.activeProxies.get(streamId)
    if (!proxy || !proxy.ws) {
      logger.warn('Signaling message for unknown stream or no WebSocket', { streamId })
      return
    }

    switch (data.type) {
      case 'offer':
        // Browser sent an offer - create browser PeerConnection and bridge to FFmpeg
        logger.debug('Received WebRTC offer from browser', { streamId })

        try {
          // Parse browser offer
          const clientOffer = data.offer || data
          const offerSDP = typeof clientOffer === 'string' ? clientOffer : clientOffer.sdp

          // Get FFmpeg PeerConnection from WHIP server
          const ffmpegPC = this.whipServer.getFFmpegPeerConnection(streamId)
          if (!ffmpegPC) {
            logger.warn('FFmpeg PeerConnection not ready yet, waiting...', { streamId })
            // Wait a bit for FFmpeg to connect to WHIP server
            await new Promise(resolve => setTimeout(resolve, 1000))
            const retryPC = this.whipServer.getFFmpegPeerConnection(streamId)
            if (!retryPC) {
              throw new Error('FFmpeg has not connected to WHIP server yet')
            }
          }

          // Create browser PeerConnection
          const browserPC = new RTCPeerConnection({
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' }
            ]
          })

          // Bridge will be handled by WHIP server's setBrowserPeerConnection
          // which properly uses transceivers to forward tracks

          // Set up browser PeerConnection event handlers
          browserPC.onicecandidate = (event) => {
            if (event.candidate && proxy.ws) {
              proxy.ws.send(JSON.stringify({
                type: 'ice-candidate',
                candidate: event.candidate
              }))
            }
          }

          browserPC.oniceconnectionstatechange = () => {
            logger.debug('Browser ICE connection state', {
              streamId,
              state: browserPC.iceConnectionState
            })
          }

          browserPC.onconnectionstatechange = () => {
            logger.debug('Browser connection state', {
              streamId,
              state: browserPC.connectionState
            })
          }

          // Store browser PeerConnection
          proxy.browserPC = browserPC

          // Set browser PeerConnection in WHIP server (for track forwarding)
          this.whipServer.setBrowserPeerConnection(streamId, browserPC)

          // Set remote description (browser's offer)
          const offer = new RTCSessionDescription({
            type: 'offer',
            sdp: offerSDP
          })
          await browserPC.setRemoteDescription(offer)

          // Create answer
          const answer = await browserPC.createAnswer()
          await browserPC.setLocalDescription(answer)

          logger.debug('Created answer for browser', { streamId })

          // Send answer to browser
          proxy.ws.send(JSON.stringify({
            type: 'answer',
            answer: {
              type: 'answer',
              sdp: answer.sdp
            }
          }))
        } catch (err) {
          logger.error('Error handling browser offer', {
            streamId,
            error: err.message,
            stack: err.stack
          })
          if (proxy.ws) {
            proxy.ws.send(JSON.stringify({
              type: 'error',
              message: err.message
            }))
          }
        }
        break
      case 'ice-candidate':
        // Forward ICE candidate to browser PeerConnection
        logger.debug('Received ICE candidate from browser', { streamId })
        if (proxy.browserPC && data.candidate) {
          try {
            const candidate = new RTCIceCandidate(data.candidate)
            await proxy.browserPC.addIceCandidate(candidate)
          } catch (err) {
            logger.warn('Error adding ICE candidate to browser PC', {
              streamId,
              error: err.message
            })
          }
        }
        break
      default:
        logger.warn('Unknown signaling message type', { streamId, type: data.type })
    }
  }

  /**
   * Start WebRTC proxy for a stream using WHIP
   * @param {string} streamId - Stream ID
   * @param {string} srtUrl - SRT URL to proxy
   * @param {Object} options - Proxy options
   * @returns {Promise<string>} WebRTC signaling URL
   */
  async startProxy (streamId, srtUrl, options = {}) {
    // Check if proxy already exists
    if (this.activeProxies.has(streamId)) {
      return `ws://127.0.0.1:${this.port}?streamId=${streamId}`
    }

    // Ensure signaling server is running
    if (!this.wss) {
      await this.startSignalingServer()
    }

    // Ensure WHIP server is running
    if (this.whipPort === 0) {
      this.whipPort = await this.whipServer.start()
      logger.info('WHIP server ready', { port: this.whipPort })
    }

    // Start WHIP proxy
    return this.startWHIPProxy(streamId, srtUrl, options)
  }

  /**
   * Detect available video encoder (preferring GPU encoders)
   * @returns {Promise<string>} Codec name
   */
  async detectAvailableCodec () {
    try {
      const { stdout } = await execAsync(`${FFMPEG_WEBRTC_PATH} -hide_banner -encoders 2>&1`)

      // Priority order: GPU encoders first, then CPU
      if (stdout.includes('h264_nvenc')) {
        logger.debug('Detected NVIDIA encoder (h264_nvenc)')
        return 'h264_nvenc'
      }
      if (stdout.includes('h264_vaapi')) {
        logger.debug('Detected VAAPI encoder (h264_vaapi) - GPU acceleration')
        return 'h264_vaapi'
      }
      if (stdout.includes('h264_v4l2m2m')) {
        logger.debug('Detected V4L2 encoder (h264_v4l2m2m) - GPU acceleration')
        return 'h264_v4l2m2m'
      }
      if (stdout.includes('libx264')) {
        logger.debug('Detected CPU encoder (libx264)')
        return 'libx264'
      }

      // Fallback to first available H.264 encoder
      const h264Match = stdout.match(/V[^ ]+ +([a-z0-9_]+h264[a-z0-9_]*)/i)
      if (h264Match) {
        logger.debug(`Using detected H.264 encoder: ${h264Match[1]}`)
        return h264Match[1]
      }

      logger.warn('No H.264 encoder found, using h264_vaapi as default')
      return 'h264_vaapi'
    } catch (err) {
      logger.warn('Error detecting codec, using h264_vaapi as default', { error: err.message })
      return 'h264_vaapi'
    }
  }

  /**
   * Start WHIP proxy - FFmpeg outputs to WHIP, we bridge to browser WebRTC
   * @param {string} streamId - Stream ID
   * @param {string} srtUrl - SRT URL to proxy
   * @param {Object} options - Proxy options
   * @returns {Promise<string>} WebRTC signaling URL
   */
  async startWHIPProxy (streamId, srtUrl, options) {
    // Detect available codec if not specified
    let detectedCodec
    if (options.videoCodec) {
      detectedCodec = options.videoCodec
      logger.debug('Using specified video codec', { streamId, codec: detectedCodec })
    } else {
      detectedCodec = await this.detectAvailableCodec()
      logger.info('Auto-detected video codec', { streamId, codec: detectedCodec })
    }

    const {
      videoCodec = detectedCodec, // Use detected codec or specified one
      audioCodec = 'libopus',
      videoBitrate = '2000k',
      audioBitrate = '128k',
      hasAudio = true,
      preset = 'p4', // NVIDIA encoder preset (p1-p7, p4 = medium quality)
      tune = 'll', // Low latency tuning for NVIDIA encoder
      gop = 30 // GOP size
    } = options

    // WHIP endpoint URL
    const whipUrl = `http://127.0.0.1:${this.whipPort}/whip/${streamId}`

    // Build FFmpeg arguments for WHIP output
    const ffmpegArgs = [
      // Input flags for low latency and SRT connection
      '-fflags', '+genpts',
      '-flags', '+low_delay',
      '-strict', 'experimental',
      // SRT-specific options for better connection handling
      '-analyzeduration', '1000000', // 1 second to analyze input
      '-probesize', '1000000', // 1 MB probe size
      // Hardware acceleration for VAAPI (if using VAAPI encoder) - must be before input
      ...(videoCodec === 'h264_vaapi' || videoCodec === 'hevc_vaapi'
        ? [
            '-hwaccel', 'vaapi', // Enable VAAPI hardware acceleration
            '-hwaccel_output_format', 'vaapi' // Output format for VAAPI
          ]
        : []),
      // Enable verbose logging to debug connection issues
      '-loglevel', 'info',
      // SRT input - connection options are in the SRT URL itself
      '-i', srtUrl,

      // Stream mapping - map video and audio if available
      '-map', '0:v:0',
      ...(hasAudio ? ['-map', '0:a:0'] : []),

      // Video encoding settings
      // Note: VAAPI uses 'vaapi' pixel format, others use 'yuv420p'
      '-pix_fmt', (videoCodec === 'h264_vaapi' || videoCodec === 'hevc_vaapi') ? 'vaapi' : 'yuv420p',
      '-c:v', videoCodec,
      // Encoder-specific parameters
      ...(videoCodec === 'h264_nvenc' || videoCodec === 'hevc_nvenc'
        ? [
            // NVIDIA encoder options (for FFmpeg 4.x compatibility)
            '-preset', preset, // Preset: p1-p7 (p4 = medium quality)
            '-tune', tune, // Tune: ll (low latency)
            '-rc', 'vbr', // Rate control: vbr (variable bitrate)
            '-rc-lookahead', '0', // Disable lookahead for low latency
            '-spatial-aq', '0', // Disable spatial AQ
            '-temporal-aq', '0' // Disable temporal AQ
          ]
        : videoCodec === 'h264_vaapi'
          ? [
              // VAAPI encoder options (Intel/AMD GPU)
              '-rc_mode', 'VBR', // Rate control: VBR (variable bitrate)
              '-quality', '4', // Quality: 1-7 (4 = balanced, higher = faster)
              '-async_depth', '4', // Parallelism for low latency
              '-low_power', '0' // Disable low power mode for better quality
            ]
          : videoCodec === 'h264_v4l2m2m'
            ? [
                // V4L2 encoder options (ARM/Raspberry Pi GPU)
                '-num_capture_buffers', '4' // Buffer count for low latency
              ]
            : videoCodec === 'libx264'
              ? [
                  // CPU encoder options
                  '-preset', 'ultrafast', // Preset: ultrafast for low latency
                  '-tune', 'zerolatency', // Tune: zerolatency
                  '-profile:v', 'baseline' // Profile: baseline for compatibility
                ]
              : videoCodec.startsWith('libvpx')
                ? [
                    // VP8/VP9 encoder options
                    '-deadline', 'realtime', // Realtime encoding
                    '-cpu-used', '8' // Speed setting
                  ]
                : []), // Other codecs use default settings
      '-b:v', videoBitrate,
      '-maxrate', videoBitrate,
      '-bufsize', `${parseInt(videoBitrate) * 2}k`,
      '-g', gop.toString(),

      // Audio encoding (if audio is present)
      ...(hasAudio
        ? [
            '-c:a', audioCodec,
            '-b:a', audioBitrate
          ]
        : ['-an']), // Disable audio if not present

      // WHIP output format
      '-f', 'whip',
      // WHIP endpoint URL
      whipUrl
    ]

    logger.debug('Starting FFmpeg WHIP proxy for WebRTC', {
      streamId,
      whipUrl,
      ffmpegArgs: ffmpegArgs.join(' '),
      hasAudio
    })

    // Register proxy early so WebSocket connections can find it
    // This prevents race conditions where WebSocket connects before proxy is registered
    const proxyInfo = {
      process: null, // Will be set after spawn
      ws: null,
      srtUrl,
      browserPC: null, // Browser PeerConnection (set when browser connects)
      hasAudio
    }
    this.activeProxies.set(streamId, proxyInfo)

    // Use WebRTC-enabled FFmpeg for WebRTC operations
    const ffmpegProcess = spawn(FFMPEG_WEBRTC_PATH, ffmpegArgs)

    // Update proxy info with the process
    proxyInfo.process = ffmpegProcess

    // FFmpeg will connect to WHIP server automatically
    // WHIP server will handle the WebRTC negotiation with FFmpeg
    // We just need to wait for browser to connect and bridge the connections

    // Collect all stderr output for better debugging
    let stderrBuffer = ''
    let ffmpegStreamingStarted = false

    // Set up stderr handler BEFORE waiting for SDP to catch early messages
    ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString()
      stderrBuffer += output

      // Check if FFmpeg has started streaming
      if (!ffmpegStreamingStarted && (output.includes('Stream mapping') || output.includes('Press [q]'))) {
        ffmpegStreamingStarted = true
        logger.debug('FFmpeg started streaming', { streamId })
      }

      // Log important FFmpeg messages
      if (output.includes('Stream mapping') || output.includes('Press [q]')) {
        logger.debug('FFmpeg WHIP info', { streamId, output: output.substring(0, 300) })
      }
      // Log SRT connection messages
      if (output.includes('SRT') || output.includes('srt://') || output.includes('Connection')) {
        logger.debug('FFmpeg SRT connection', { streamId, output: output.substring(0, 500) })
      }
      // Log errors and warnings
      if (output.includes('error') || output.includes('Error') || output.includes('failed') ||
          output.includes('Failed') || output.includes('warning') || output.includes('Warning')) {
        logger.warn('FFmpeg WHIP error/warning', { streamId, output: output.substring(0, 500) })
      }
      // Log "no data" messages which indicate connection issues
      if (output.includes('without any data') || output.includes('No data') ||
          output.includes('Connection refused') || output.includes('Connection timed out')) {
        logger.error('FFmpeg connection issue', { streamId, output: output.substring(0, 500) })
      }
    })

    ffmpegProcess.on('error', (err) => {
      logger.error('FFmpeg WHIP process error', { streamId, error: err.message })
      this.stopProxy(streamId)
    })

    ffmpegProcess.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) {
        // Log full stderr output on error for debugging
        const errorOutput = stderrBuffer.length > 0
          ? stderrBuffer.substring(Math.max(0, stderrBuffer.length - 3000))
          : 'No stderr output captured'
        logger.error('FFmpeg WHIP process exited with error', {
          streamId,
          code,
          signal,
          srtUrl,
          whipUrl,
          errorOutput: errorOutput.substring(0, 2000),
          ffmpegCommand: ffmpegArgs.join(' ')
        })
        // Clean up the proxy on error
        this.stopProxy(streamId)
      } else if (code === 0) {
        logger.debug('FFmpeg WHIP process exited normally', { streamId })
      }
    })

    const signalingUrl = `ws://127.0.0.1:${this.port}?streamId=${streamId}`
    logger.info('WHIP proxy started for WebRTC', {
      streamId,
      signalingUrl,
      whipUrl,
      hasAudio
    })
    return signalingUrl
  }

  /**
   * Stop WebRTC proxy for a stream
   * @param {string} streamId - Stream ID
   */
  async stopProxy (streamId) {
    const proxy = this.activeProxies.get(streamId)
    if (!proxy) {
      return
    }

    logger.debug('Stopping WebRTC proxy', streamId)

    // Close browser PeerConnection
    if (proxy.browserPC) {
      try {
        proxy.browserPC.close()
      } catch (err) {
        logger.warn('Error closing browser PeerConnection', { streamId, error: err.message })
      }
    }

    // Close WebSocket connection
    if (proxy.ws) {
      try {
        proxy.ws.close()
      } catch (err) {
        logger.warn('Error closing WebSocket', { streamId, error: err.message })
      }
    }

    // Remove from WHIP server
    await this.whipServer.removeStream(streamId)

    // Kill FFmpeg process
    if (proxy.process && !proxy.process.killed) {
      proxy.process.kill('SIGTERM')
    }

    this.activeProxies.delete(streamId)
    logger.debug('WebRTC proxy stopped', streamId)
  }

  /**
   * Get proxy info for a stream
   * @param {string} streamId - Stream ID
   * @returns {Object|null} Proxy info or null
   */
  getProxy (streamId) {
    return this.activeProxies.get(streamId) || null
  }

  /**
   * Check if proxy is active for a stream
   * @param {string} streamId - Stream ID
   * @returns {boolean}
   */
  isActive (streamId) {
    return this.activeProxies.has(streamId)
  }

  /**
   * Stop all active proxies
   */
  async stopAll () {
    for (const streamId of this.activeProxies.keys()) {
      await this.stopProxy(streamId)
    }
  }

  /**
   * Stop signaling server and WHIP server
   */
  async stopSignalingServer () {
    if (this.wss) {
      this.wss.close()
      this.wss = null
    }
    if (this.server) {
      this.server.close()
      this.server = null
    }
    await this.whipServer.stop()
    this.port = 0
    this.whipPort = 0
    logger.debug('WebRTC signaling server and WHIP server stopped')
  }
}

module.exports = WebRTCProxy
