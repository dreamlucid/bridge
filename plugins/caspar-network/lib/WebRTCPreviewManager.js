// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const MediasoupBridge = require('./MediasoupBridge')

const Logger = require('../../../lib/Logger')
const logger = new Logger({ name: 'CasparNetworkPlugin' })

/**
 * Manages WebRTC preview streams for SRT output streams
 * Pipeline: SRT → FFmpeg (SRT to RTP) → MediasoupBridge (RTP to WebRTC) → Browser
 */
class WebRTCPreviewManager {
  constructor () {
    /** @type {Map<string, {bridge: MediasoupBridge, ffmpegProcess: any, rtpPort: number, sdpPath: string}>} */
    this.activePreviews = new Map()
    this.nextRtpPort = 10000 // Starting port for RTP streams
    this.sdpDir = path.join(os.tmpdir(), 'bridge-webrtc-sdp')
    // Ensure SDP directory exists
    fs.mkdirSync(this.sdpDir, { recursive: true })
  }

  /**
   * Start WebRTC preview for an SRT output stream
   * @param {string} streamId - Stream ID
   * @param {string} srtUrl - SRT URL to connect to
   * @returns {Promise<{rtpPort: number, bridge: MediasoupBridge}>}
   */
  async startPreview (streamId, srtUrl) {
    // Check if preview already exists
    if (this.activePreviews.has(streamId)) {
      const existing = this.activePreviews.get(streamId)
      logger.debug('Preview already exists for stream', { streamId })
      return {
        rtpPort: existing.rtpPort,
        bridge: existing.bridge
      }
    }

    logger.debug('Starting WebRTC preview', { streamId, srtUrl })

    // Allocate RTP port
    const rtpPort = this.nextRtpPort++

    // Create MediasoupBridge instance
    const bridge = new MediasoupBridge({
      width: 1920,
      height: 1080,
      frameRate: 30
    })

    // Initialize mediasoup
    await bridge.initialize()

    // Create PlainTransport to receive RTP packets
    const transportInfo = await bridge.createPlainTransport(rtpPort)

    // Create Producer
    await bridge.createProducer()

    // Generate SDP file path for this stream
    const sdpPath = path.join(this.sdpDir, `${streamId}.sdp`)

    // Start FFmpeg to convert SRT to RTP
    const ffmpegProcess = this.startFFmpegSRTToRTP(srtUrl, transportInfo.rtpIp, transportInfo.rtpPort, transportInfo.rtcpPort, sdpPath)

    // Store preview info
    this.activePreviews.set(streamId, {
      bridge,
      ffmpegProcess,
      rtpPort: transportInfo.rtpPort,
      sdpPath,
      srtUrl
    })

    logger.info('WebRTC preview started', {
      streamId,
      rtpPort: transportInfo.rtpPort,
      rtcpPort: transportInfo.rtcpPort
    })

    return {
      rtpPort: transportInfo.rtpPort,
      bridge
    }
  }

  /**
   * Start FFmpeg process to convert SRT to RTP
   * @param {string} srtUrl - SRT URL to connect to
   * @param {string} rtpIp - RTP destination IP
   * @param {number} rtpPort - RTP destination port
   * @param {number} rtcpPort - RTCP destination port
   * @param {string} sdpPath - Path to write SDP file
   * @returns {any} FFmpeg process
   */
  startFFmpegSRTToRTP (srtUrl, rtpIp, rtpPort, rtcpPort, sdpPath) {
    // FFmpeg command to convert SRT to RTP
    // Input: SRT stream
    // Output: RTP stream to mediasoup PlainTransport
    // Note: FFmpeg's RTP muxer requires an SDP file to be written
    // FFmpeg RTP muxer only supports ONE stream
    // Since we're using mediasoup for WebRTC preview, we'll output only video
    // Audio can be handled separately if needed, but for preview video-only is sufficient
    const ffmpegArgs = [
      '-fflags', '+genpts',
      '-flags', '+low_delay',
      '-strict', 'experimental',
      '-i', srtUrl,
      '-map', '0:v:0', // Map only the first video stream
      '-c:v', 'copy', // Copy video codec (assumes H.264)
      '-f', 'rtp',
      '-sdp_file', sdpPath, // Write SDP file (required by FFmpeg RTP muxer, must come before output URL)
      `rtp://${rtpIp}:${rtpPort}?rtcpport=${rtcpPort}`
    ]

    logger.debug('Starting FFmpeg SRT to RTP', {
      srtUrl,
      rtpIp,
      rtpPort,
      rtcpPort,
      sdpPath,
      command: `ffmpeg ${ffmpegArgs.join(' ')}`
    })

    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs)

    // Handle process errors
    ffmpegProcess.on('error', (err) => {
      logger.error('FFmpeg process error', { error: err.message, srtUrl })
    })

    // Log FFmpeg output for debugging
    let ffmpegErrorOutput = ''
    let ffmpegStdoutOutput = ''
    
    ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString()
      ffmpegErrorOutput += output
      // Log errors and important info
      if (output.includes('error') || output.includes('Error') || output.includes('Failed') || output.includes('Invalid')) {
        logger.warn('FFmpeg stderr', { output: output.trim(), srtUrl })
      }
      // Log connection info
      if (output.includes('Connection') || output.includes('SRT') || output.includes('srt://') || output.includes('Input #0')) {
        logger.debug('FFmpeg connection info', { output: output.trim(), srtUrl })
      }
    })

    ffmpegProcess.stdout.on('data', (data) => {
      const output = data.toString()
      ffmpegStdoutOutput += output
      logger.debug('FFmpeg stdout', { output: output.trim(), srtUrl })
    })

    ffmpegProcess.on('exit', (code, signal) => {
      if (code !== 0 && code !== null && code !== 255 && signal !== 'SIGTERM' && signal !== 'SIGINT') {
        // Log full error output for debugging
        const fullOutput = (ffmpegErrorOutput + ffmpegStdoutOutput).trim()
        logger.error('FFmpeg process exited with error', {
          code,
          signal,
          output: fullOutput.length > 2000 ? fullOutput.substring(0, 2000) + '...' : fullOutput,
          srtUrl,
          rtpIp,
          rtpPort,
          rtcpPort,
          sdpPath
        })
      } else {
        logger.debug('FFmpeg process exited normally', { code, signal, srtUrl })
      }
    })

    return ffmpegProcess
  }

  /**
   * Stop WebRTC preview for a stream
   * @param {string} streamId - Stream ID
   */
  async stopPreview (streamId) {
    const preview = this.activePreviews.get(streamId)
    if (!preview) {
      logger.warn('Preview not found for stream', { streamId })
      return
    }

    logger.debug('Stopping WebRTC preview', { streamId })

    // Stop FFmpeg process
    if (preview.ffmpegProcess && !preview.ffmpegProcess.killed) {
      preview.ffmpegProcess.kill('SIGTERM')
    }

    // Clean up SDP file
    if (preview.sdpPath && fs.existsSync(preview.sdpPath)) {
      try {
        fs.unlinkSync(preview.sdpPath)
      } catch (err) {
        logger.warn('Could not delete SDP file', { streamId, sdpPath: preview.sdpPath, error: err.message })
      }
    }

    // Stop mediasoup bridge
    try {
      await preview.bridge.stop()
    } catch (err) {
      logger.error('Error stopping mediasoup bridge', { streamId, error: err.message })
    }

    // Remove from active previews
    this.activePreviews.delete(streamId)

    logger.info('WebRTC preview stopped', { streamId })
  }

  /**
   * Get preview bridge for a stream
   * @param {string} streamId - Stream ID
   * @returns {MediasoupBridge|null}
   */
  getPreviewBridge (streamId) {
    const preview = this.activePreviews.get(streamId)
    return preview ? preview.bridge : null
  }

  /**
   * Check if preview is active for a stream
   * @param {string} streamId - Stream ID
   * @returns {boolean}
   */
  isPreviewActive (streamId) {
    return this.activePreviews.has(streamId)
  }

  /**
   * Stop all active previews
   */
  async stopAll () {
    const streamIds = Array.from(this.activePreviews.keys())
    for (const streamId of streamIds) {
      await this.stopPreview(streamId)
    }
  }
}

module.exports = WebRTCPreviewManager
