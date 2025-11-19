// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, nonstandard } = require('wrtc')
const Logger = require('../../../lib/Logger')
const logger = new Logger({ name: 'CasparNetworkPlugin' })
const RTPParser = require('./RTPParser')
const H264Depacketizer = require('./H264Depacketizer')
const H264Decoder = require('./H264Decoder')

/**
 * Bridges RTP packets from FFmpeg to WebRTC tracks
 * Uses server-side RTCPeerConnection to handle WebRTC negotiation
 */
class WebRTCBridge {
  constructor (rtpPort, streamId, ffmpegSDP, options = {}) {
    this.rtpPort = rtpPort
    this.streamId = streamId
    this.ffmpegSDP = ffmpegSDP
    this.width = options.width || 1920 // Default to 1920x1080
    this.height = options.height || 1080
    this.pc = null
    this.videoSource = null
    this.videoTrack = null
    this.h264Decoder = null
    this.isInitialized = false
    this.rtpParser = new RTPParser()
    this.h264Depacketizer = new H264Depacketizer()
    this.onAnswer = null // Callback when answer is created: (answerSDP) => {}
  }

  /**
   * Initialize the WebRTC bridge
   * Note: This creates a PeerConnection but we need to handle RTP input separately
   */
  async initialize () {
    if (this.isInitialized) {
      logger.warn('WebRTCBridge already initialized', { streamId: this.streamId })
      return
    }

    try {
      // Create RTCPeerConnection with configuration
      this.pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' }
        ]
      })

      // Set up event handlers
      this.pc.onicecandidate = (event) => {
        if (event.candidate) {
          logger.debug('ICE candidate generated', {
            streamId: this.streamId,
            candidate: event.candidate.candidate
          })
          // ICE candidates will be handled by the signaling layer
        }
      }

      this.pc.oniceconnectionstatechange = () => {
        logger.debug('ICE connection state changed', {
          streamId: this.streamId,
          state: this.pc.iceConnectionState
        })
      }

      this.pc.onconnectionstatechange = () => {
        logger.debug('Connection state changed', {
          streamId: this.streamId,
          state: this.pc.connectionState
        })
      }

      // Create video source using non-standard API
      // This allows us to feed raw video frames to WebRTC
      this.videoSource = new nonstandard.RTCVideoSource()
      this.videoTrack = this.videoSource.createTrack()

      // Add track to peer connection
      this.pc.addTrack(this.videoTrack)

      // Create H.264 decoder to convert NAL units to raw frames
      this.h264Decoder = new H264Decoder(this.width, this.height, this.streamId)

      // Set up decoder frame callback to feed frames to video source
      this.h264Decoder.setFrameCallback((frame, timestamp) => {
        this.feedFrame(frame, timestamp)
      })

      // Set up H.264 depacketizer callback to feed NAL units to decoder
      this.h264Depacketizer.setNALCallback((nalUnit, timestamp) => {
        if (this.h264Decoder) {
          this.h264Decoder.feedNALUnit(nalUnit)
        }
      })

      // Start the decoder
      this.h264Decoder.start()

      this.isInitialized = true
      logger.info('WebRTCBridge initialized', {
        streamId: this.streamId,
        rtpPort: this.rtpPort
      })
    } catch (err) {
      logger.error('Error initializing WebRTCBridge', {
        streamId: this.streamId,
        error: err.message,
        stack: err.stack
      })
      throw err
    }
  }

  /**
   * Create WebRTC answer from browser's offer
   * @param {string} offerSDP - Browser's offer SDP
   * @returns {Promise<string>} Answer SDP
   */
  async createAnswer (offerSDP) {
    if (!this.pc) {
      throw new Error('WebRTCBridge not initialized')
    }

    try {
      // Set remote description (browser's offer)
      const offer = new RTCSessionDescription({
        type: 'offer',
        sdp: offerSDP
      })

      await this.pc.setRemoteDescription(offer)
      logger.debug('Set remote description (offer)', { streamId: this.streamId })

      // Create answer
      const answer = await this.pc.createAnswer()
      await this.pc.setLocalDescription(answer)

      logger.debug('Created answer SDP', {
        streamId: this.streamId,
        answerType: answer.type
      })

      // Return answer SDP
      return answer.sdp
    } catch (err) {
      logger.error('Error creating answer', {
        streamId: this.streamId,
        error: err.message,
        stack: err.stack
      })
      throw err
    }
  }

  /**
   * Add ICE candidate from browser
   * @param {Object} candidate - ICE candidate object
   */
  async addIceCandidate (candidate) {
    if (!this.pc) {
      logger.warn('Cannot add ICE candidate: PeerConnection not initialized', {
        streamId: this.streamId
      })
      return
    }

    try {
      const iceCandidate = new RTCIceCandidate(candidate)
      await this.pc.addIceCandidate(iceCandidate)
      logger.debug('Added ICE candidate', { streamId: this.streamId })
    } catch (err) {
      logger.warn('Error adding ICE candidate', {
        streamId: this.streamId,
        error: err.message
      })
    }
  }

  /**
   * Close the WebRTC bridge
   */
  async close () {
    // Stop H.264 decoder
    if (this.h264Decoder) {
      this.h264Decoder.stop()
      this.h264Decoder = null
    }

    if (this.videoTrack) {
      this.videoTrack.stop()
      this.videoTrack = null
    }

    if (this.videoSource) {
      // RTCVideoSource doesn't have a close method, just stop the track
      this.videoSource = null
    }

    if (this.pc) {
      this.pc.close()
      this.pc = null
    }

    this.h264Depacketizer.reset()
    this.rtpParser.reset()

    this.isInitialized = false
    logger.info('WebRTCBridge closed', { streamId: this.streamId })
  }

  /**
   * Process RTP packet and feed to WebRTC
   * @param {Buffer} rtpPacket - Raw RTP packet
   */
  processRTPPacket (rtpPacket) {
    if (!this.isInitialized) {
      return
    }

    // Parse RTP packet
    const rtp = this.rtpParser.parse(rtpPacket)
    if (!rtp) {
      return
    }

    // Process H.264 payload
    this.h264Depacketizer.processPayload(rtp.payload, rtp.timestamp, rtp.marker)
  }

  /**
   * Feed raw video frame to video source
   * @param {Buffer} frame - Raw YUV420p frame
   * @param {number} timestamp - Frame timestamp
   */
  feedFrame (frame, timestamp) {
    if (!this.videoSource || !this.isInitialized) {
      return
    }

    try {
      // Create VideoFrame object for RTCVideoSource
      // Note: wrtc's RTCVideoSource expects a specific format
      // We need to create a frame object with width, height, and data
      const frameObj = {
        width: this.width,
        height: this.height,
        data: frame
      }

      // Feed frame to video source
      // Note: The exact API might vary depending on wrtc version
      // Some versions use onFrame(), others might use different methods
      if (this.videoSource.onFrame) {
        this.videoSource.onFrame(frameObj)
      } else {
        // Try alternative API if onFrame doesn't exist
        logger.warn('RTCVideoSource.onFrame not available, trying alternative', {
          streamId: this.streamId
        })
      }

      logger.debug('Frame fed to video source', {
        streamId: this.streamId,
        width: this.width,
        height: this.height,
        frameSize: frame.length,
        timestamp
      })
    } catch (err) {
      logger.error('Error feeding frame to video source', {
        streamId: this.streamId,
        error: err.message,
        stack: err.stack
      })
    }
  }

  /**
   * Get connection state
   */
  getState () {
    if (!this.pc) {
      return { initialized: false }
    }

    return {
      initialized: this.isInitialized,
      iceConnectionState: this.pc.iceConnectionState,
      connectionState: this.pc.connectionState,
      signalingState: this.pc.signalingState,
      rtpStats: this.rtpParser.getStats(),
      h264Stats: this.h264Depacketizer.getStats(),
      decoderStats: this.h264Decoder ? this.h264Decoder.getStats() : null
    }
  }
}

module.exports = WebRTCBridge
