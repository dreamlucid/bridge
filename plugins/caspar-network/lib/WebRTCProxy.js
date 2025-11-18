// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const { spawn } = require('child_process')
const { WebSocketServer } = require('ws')
const http = require('http')
const net = require('net')
const crypto = require('crypto')

const Logger = require('../../../lib/Logger')
const logger = new Logger({ name: 'CasparNetworkPlugin' })

/**
 * Manages WebRTC proxy processes for SRT streams
 * Provides low-latency real-time preview using WebRTC
 */
class WebRTCProxy {
  constructor () {
    /** @type {Map<string, {process: any, ws: any, srtUrl: string, port: number}>} */
    this.activeProxies = new Map()
    this.wss = null
    this.server = null
    this.port = 0 // Will be set when server starts
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
            codecs: []
          }
        }
      } else if (currentMLine && line.startsWith('a=mid:')) {
        currentMLine.mid = line.substring(6)
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

        // Add to active MIDs for BUNDLE
        activeMids.push(offerMLine.mid)

        answerLines.push(`m=video ${videoPort} RTP/SAVPF ${usePayloadType}`)
        answerLines.push('c=IN IP4 127.0.0.1')
        answerLines.push('a=rtcp:9 IN IP4 0.0.0.0')
        answerLines.push('a=ice-ufrag:4x5b')
        answerLines.push('a=ice-pwd:4x5b4x5b4x5b4x5b4x5b4x')
        answerLines.push('a=ice-options:trickle')
        answerLines.push('a=fingerprint:sha-256 ' + dtlsFingerprint.split(' ')[1])
        answerLines.push('a=setup:actpass')
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
   */
  async handleSignalingMessage (streamId, data) {
    const proxy = this.activeProxies.get(streamId)
    if (!proxy || !proxy.ws) {
      logger.warn('Signaling message for unknown stream or no WebSocket', { streamId })
      return
    }

    switch (data.type) {
      case 'offer':
        // Client sent an offer, we need to create an answer based on the SDP file
        logger.debug('Received WebRTC offer', { streamId })

        try {
          const fs = require('fs')

          // Parse client offer
          const clientOffer = data.offer || data
          const offerSDP = typeof clientOffer === 'string' ? clientOffer : clientOffer.sdp

          // Read FFmpeg SDP if available
          let ffmpegSDP = null
          if (fs.existsSync(proxy.sdpPath)) {
            ffmpegSDP = fs.readFileSync(proxy.sdpPath, 'utf8')
            logger.debug('Using FFmpeg SDP for answer', { streamId, sdpPath: proxy.sdpPath })
          } else {
            logger.warn('SDP file not found, creating answer without FFmpeg codec info', { streamId, sdpPath: proxy.sdpPath })
          }

          // Create WebRTC-compatible answer SDP matching offer structure
          const answerSDP = this.createWebRTCAnswerSDP(offerSDP, ffmpegSDP, proxy.port)

          logger.debug('Sending WebRTC answer', { streamId })

          const answer = {
            type: 'answer',
            sdp: answerSDP
          }

          proxy.ws.send(JSON.stringify({
            type: 'answer',
            answer
          }))
        } catch (err) {
          logger.error('Error handling offer', { streamId, error: err.message, stack: err.stack })
        }
        break
      case 'ice-candidate':
        // Store ICE candidate for later use (if needed)
        logger.debug('Received ICE candidate', { streamId })
        // In a full implementation, we'd forward this to FFmpeg or handle it
        break
      default:
        logger.warn('Unknown signaling message type', { streamId, type: data.type })
    }
  }

  /**
   * Start WebRTC proxy for a stream
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
      // Server is now guaranteed to be listening (or port is set)
    }

    // Generate a unique port for RTP (WebRTC uses RTP internally)
    const portHash = streamId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
    const rtpPort = 50000 + (portHash % 1000)

    // Use RTP output - more reliable and widely supported
    // We'll handle WebRTC signaling separately
    return this.startRTPProxy(streamId, srtUrl, {}, rtpPort)
  }

  /**
   * Start RTP proxy and handle WebRTC signaling
   * FFmpeg outputs to RTP, and we handle WebRTC signaling via WebSocket
   */
  async startRTPProxy (streamId, srtUrl, options, rtpPort) {
    const {
      videoCodec = 'h264_nvenc', // Default to NVIDIA GPU encoder
      audioCodec = 'libopus', // Reserved for future use (RTP muxer currently only supports video)
      videoBitrate = '2000k',
      audioBitrate = '128k', // Reserved for future use (RTP muxer currently only supports video)
      hasAudio = true, // Tracked for metadata, but RTP muxer only supports video
      preset = 'p4', // NVIDIA encoder preset (p1-p7, p4 = medium quality)
      tune = 'll', // Low latency tuning for NVIDIA encoder
      gop = 30 // GOP size
    } = options

    // Note: RTP muxer only supports one stream (video only)
    // audioCodec and audioBitrate are kept for API compatibility but not currently used
    // eslint-disable-next-line no-unused-vars
    const _audioCodec = audioCodec
    // eslint-disable-next-line no-unused-vars
    const _audioBitrate = audioBitrate

    // Use RTP output with SDP file for WebRTC
    // FFmpeg will generate an SDP file that describes the RTP stream
    const sdpPath = require('path').join(require('os').tmpdir(), `bridge-caspar-network-webrtc-${streamId}.sdp`)

    // Generate separate ports for video and audio (RTP requires separate ports)
    // Video uses the base port, audio uses base port + 1
    const videoPort = rtpPort
    const audioPort = rtpPort + 1

    // Build FFmpeg arguments
    const ffmpegArgs = [
      // Input flags for low latency and SRT connection
      '-fflags', '+genpts',
      '-flags', '+low_delay',
      '-strict', 'experimental',
      // SRT-specific options for better connection handling
      '-analyzeduration', '1000000', // 1 second to analyze input
      '-probesize', '1000000', // 1 MB probe size
      // Enable verbose logging to debug connection issues
      '-loglevel', 'info',
      // SRT input - connection options are in the SRT URL itself
      '-i', srtUrl,

      // Stream mapping - RTP muxer only supports one stream (video only)
      // Always map only the video stream to avoid RTP muxer errors
      '-map', '0:v:0',

      // Video encoding settings
      '-pix_fmt', 'yuv420p',
      '-c:v', videoCodec,
      // GPU encoder parameters (for h264_nvenc)
      ...(videoCodec === 'h264_nvenc' || videoCodec === 'hevc_nvenc'
        ? [
            '-preset:v', preset, // NVIDIA encoder preset
            '-tune:v', tune, // Low latency tuning
            '-rc:v', 'vbr', // Variable bitrate mode
            '-rc-lookahead:v', '0', // Disable lookahead for low latency
            '-spatial-aq:v', '0', // Disable spatial AQ for low latency
            '-temporal-aq:v', '0' // Disable temporal AQ for low latency
          ]
        : videoCodec.startsWith('libvpx')
          ? [
              '-deadline', 'realtime', // VP8/VP9 realtime encoding
              '-cpu-used', '8' // VP8/VP9 speed setting
            ]
          : []), // Other codecs use default settings
      '-b:v', videoBitrate,
      '-maxrate', videoBitrate,
      '-bufsize', `${parseInt(videoBitrate) * 2}k`,
      '-g', gop.toString(),

      // Audio encoding (only if audio is present)
      // Note: RTP muxer only supports one stream, so we disable audio for RTP output
      // If audio is needed in the future, we'd need separate RTP outputs or a different muxer
      '-an', // Always disable audio for RTP (RTP muxer limitation)

      // RTP output format
      '-f', 'rtp',
      '-sdp_file', sdpPath,

      // RTP output URL - FFmpeg RTP muxer only supports one stream (video only)
      `rtp://127.0.0.1:${videoPort}`
    ]

    logger.debug('Starting FFmpeg RTP proxy for WebRTC', {
      streamId,
      videoPort,
      audioPort: hasAudio ? audioPort : 'disabled',
      sdpPath,
      ffmpegArgs: ffmpegArgs.join(' '),
      hasAudio
    })

    // Register proxy early so WebSocket connections can find it
    // This prevents race conditions where WebSocket connects before proxy is registered
    const proxyInfo = {
      process: null, // Will be set after spawn
      ws: null,
      srtUrl,
      port: videoPort,
      audioPort: hasAudio ? audioPort : null,
      sdpPath,
      useWebRTC: false,
      hasAudio
    }
    this.activeProxies.set(streamId, proxyInfo)

    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs)

    // Update proxy info with the process
    proxyInfo.process = ffmpegProcess

    // Wait for SDP file to be generated (with timeout)
    const fs = require('fs')
    let sdpReady = false
    const maxWaitTime = 20000 // 5 seconds
    const checkInterval = 100 // Check every 100ms
    const startTime = Date.now()

    while (!sdpReady && (Date.now() - startTime) < maxWaitTime) {
      if (fs.existsSync(sdpPath)) {
        sdpReady = true
        logger.debug('SDP file generated', { streamId, sdpPath })
        break
      }
      await new Promise(resolve => setTimeout(resolve, checkInterval))
    }

    if (!sdpReady) {
      logger.warn('SDP file not generated within timeout', { streamId, sdpPath, timeout: maxWaitTime })
    }

    // Collect all stderr output for better debugging
    let stderrBuffer = ''
    ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString()
      stderrBuffer += output

      // Log important FFmpeg messages
      if (output.includes('Stream mapping') || output.includes('Press [q]')) {
        logger.debug('FFmpeg RTP info', { streamId, output: output.substring(0, 300) })
      }
      // Log SRT connection messages
      if (output.includes('SRT') || output.includes('srt://') || output.includes('Connection')) {
        logger.debug('FFmpeg SRT connection', { streamId, output: output.substring(0, 500) })
      }
      // Log errors and warnings
      if (output.includes('error') || output.includes('Error') || output.includes('failed') ||
          output.includes('Failed') || output.includes('warning') || output.includes('Warning')) {
        logger.warn('FFmpeg RTP error/warning', { streamId, output: output.substring(0, 500) })
      }
      // Log "no data" messages which indicate connection issues
      if (output.includes('without any data') || output.includes('No data') ||
          output.includes('Connection refused') || output.includes('Connection timed out')) {
        logger.error('FFmpeg connection issue', { streamId, output: output.substring(0, 500) })
      }
    })

    ffmpegProcess.on('error', (err) => {
      logger.error('FFmpeg RTP process error', { streamId, error: err.message })
      this.stopProxy(streamId)
    })

    ffmpegProcess.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) {
        // Log full stderr output on error for debugging
        // Get the last 3000 chars to capture more context
        const errorOutput = stderrBuffer.length > 0
          ? stderrBuffer.substring(Math.max(0, stderrBuffer.length - 3000))
          : 'No stderr output captured'
        // Log the full error output (up to 2000 chars) for better debugging
        logger.error('FFmpeg RTP process exited with error', {
          streamId,
          code,
          signal,
          srtUrl,
          videoPort,
          errorOutput: errorOutput.substring(0, 2000), // Increased to 2000 chars
          // Also log the full command for debugging
          ffmpegCommand: ffmpegArgs.join(' ')
        })
        // Clean up the proxy on error
        this.stopProxy(streamId)
      } else if (code === 0) {
        logger.debug('FFmpeg RTP process exited normally', { streamId })
      }
    })

    const signalingUrl = `ws://127.0.0.1:${this.port}?streamId=${streamId}`
    logger.info('RTP proxy started for WebRTC', {
      streamId,
      signalingUrl,
      videoPort,
      audioPort: hasAudio ? audioPort : 'disabled',
      sdpPath,
      hasAudio
    })
    return signalingUrl
  }

  /**
   * Stop WebRTC proxy for a stream
   * @param {string} streamId - Stream ID
   */
  stopProxy (streamId) {
    const proxy = this.activeProxies.get(streamId)
    if (!proxy) {
      return
    }

    logger.debug('Stopping WebRTC proxy', streamId)

    // Close WebSocket connection
    if (proxy.ws) {
      try {
        proxy.ws.close()
      } catch (err) {
        logger.warn('Error closing WebSocket', { streamId, error: err.message })
      }
    }

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
  stopAll () {
    for (const streamId of this.activeProxies.keys()) {
      this.stopProxy(streamId)
    }
  }

  /**
   * Stop signaling server
   */
  stopSignalingServer () {
    if (this.wss) {
      this.wss.close()
      this.wss = null
    }
    if (this.server) {
      this.server.close()
      this.server = null
    }
    this.port = 0
    logger.debug('WebRTC signaling server stopped')
  }
}

module.exports = WebRTCProxy
