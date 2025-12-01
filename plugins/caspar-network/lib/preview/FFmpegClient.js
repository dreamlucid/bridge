// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const { spawn } = require('child_process')
const Logger = require('../../../../lib/Logger')
const logger = new Logger({ name: 'CasparNetworkPlugin:FFmpegClient' })

/**
 * FFmpeg client for sending media to mediasoup PlainTransport
 * Based on mediasoup-demo broadcaster pattern
 */
class FFmpegClient {
  constructor () {
    this.processes = new Map() // Map<streamId, ChildProcess>
    this.closed = false
  }

  /**
   * Send SRT stream to mediasoup PlainTransport via RTP (video only)
   * Following broadcaster demo pattern: creates producers first, then sends RTP
   * Uses hardware acceleration (NVDEC/NVENC) when available, falls back to software
   * @param {Object} options
   * @param {string} options.streamId - Stream ID
   * @param {string} options.srtUrl - SRT input URL
   * @param {Object} options.videoTransport - Video PlainTransport info { ip, port, rtcpPort }
   * @param {number} options.videoSsrc - Video SSRC
   * @param {number} options.videoPt - Video payload type
   * @param {boolean} options.useHardware - Use hardware acceleration (default: true)
   * @returns {Promise<void>}
   */
  async sendSRTStream ({
    streamId,
    srtUrl,
    videoTransport,
    videoSsrc,
    videoPt,
    useHardware = true
  }) {
    if (this.closed) {
      throw new Error('FFmpegClient is closed')
    }

    if (this.processes.has(streamId)) {
      logger.warn('FFmpeg process already exists for stream', { streamId })
      return
    }

    logger.debug('sendSRTStream() (video only)', {
      streamId,
      srtUrl,
      videoTransport,
      videoSsrc,
      videoPt,
      useHardware
    })

    // Build FFmpeg command for video-only RTP stream
    // Use hardware acceleration (NVDEC/NVENC) when available
    const cmd = 'ffmpeg'
    const args = []

    // Hardware acceleration options MUST come BEFORE the input (-i) option
    if (useHardware) {
      // Use NVDEC (NVIDIA hardware decoder) for decoding
      // Note: We use hwaccel cuda for decoding, but let FFmpeg handle format conversion
      // to avoid filter chain issues. NVENC can work with both CUDA and system memory frames.
      args.push(
        '-hwaccel', 'cuda', // Use CUDA hardware acceleration for decoding
        '-hwaccel_output_format', 'nv12' // Convert to NV12 (NVENC-compatible format)
      )
    }

    // SRT input options for better reliability
    args.push(
      '-fflags', '+genpts', // Generate presentation timestamps
      '-flags', '+low_delay', // Low latency mode
      '-strict', 'experimental',
      '-re', // Read input at native frame rate (for live streams)
      '-v', 'info',
      // SRT connection timeout and retry settings
      '-timeout', '5000000', // 5 second timeout in microseconds
      '-i', srtUrl
    )

    // Map video stream
    args.push('-map', '0:v:0')

    // Video encoding: Use NVENC if hardware is enabled, otherwise copy or use software
    // IMPORTANT: RTP parameters must match the producer's RTP parameters exactly
    // Producer expects: packetization-mode=1, profile-level-id=42e01f (Baseline profile, Level 3.1)
    if (useHardware) {
      // Use NVENC for hardware encoding with low latency settings
      // When using -hwaccel cuda, FFmpeg will automatically convert CUDA frames for NVENC
      // Force Baseline profile to match producer RTP parameters
      // Note: NVENC doesn't support -level parameter directly, it auto-detects based on resolution/bitrate
      args.push(
        '-c:v', 'h264_nvenc', // NVIDIA hardware H.264 encoder
        '-preset', 'p4', // Medium quality preset (p1-p7, p1=fastest, p7=slowest)
        '-tune', 'll', // Low latency tuning
        '-rc', 'vbr', // Variable bitrate
        '-b:v', '6000k', // Video bitrate
        '-maxrate', '6000k', // Maximum bitrate
        '-bufsize', '12000k', // Buffer size
        '-g', '50', // GOP size
        '-keyint_min', '50', // Minimum keyframe interval
        '-profile:v', 'baseline' // Baseline profile (matches producer: profile-level-id=42e01f)
        // Note: Level is auto-detected by NVENC based on resolution/bitrate
        // Note: packetization-mode=1 is set via RTP muxer, not encoder
      )
    } else {
      // Fallback: copy codec (assumes H.264 from SRT stream)
      args.push('-c:v', 'copy')
    }

    // Use tee muxer to send video to RTP endpoint with specific SSRC and payload type
    // Add RTP-specific options to ensure proper packetization
    // packetization-mode=1 means single NAL unit mode (required for WebRTC)
    const rtpUrl = `rtp://${videoTransport.ip}:${videoTransport.port}?rtcpport=${videoTransport.rtcpPort || ''}&pkt_size=1200`
    args.push(
      '-f', 'tee',
      `[select=v:f=rtp:ssrc=${videoSsrc}:payload_type=${videoPt}]${rtpUrl}`
    )

    logger.debug('Spawning FFmpeg process', {
      streamId,
      command: `${cmd} ${args.join(' ')}`
    })

    const abortController = new AbortController()
    const subprocess = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: abortController.signal
    })

    this.processes.set(streamId, { subprocess, abortController })

    // Handle stdout
    subprocess.stdout.setEncoding('utf8')
    subprocess.stdout.on('data', (data) => {
      if (data) {
        logger.debug('FFmpeg stdout', {
          streamId,
          output: data.toString().trim()
        })
      }
    })

    // Handle stderr (FFmpeg sends all output to stderr)
    let stderrBuffer = ''
    subprocess.stderr.setEncoding('utf8')
    subprocess.stderr.on('data', (data) => {
      if (data) {
        stderrBuffer += data.toString()
        const output = data.toString().trim()

        // Check for hardware acceleration errors
        if (output.includes('Unknown encoder') && output.includes('nvenc')) {
          logger.error('NVENC encoder not available - hardware acceleration failed', {
            streamId,
            output: output.substring(0, 500)
          })
        } else if (output.includes('Cannot load') && output.includes('cuda')) {
          logger.error('CUDA/NVDEC not available - hardware acceleration failed', {
            streamId,
            output: output.substring(0, 500)
          })
        } else if (output.includes('Operation not permitted') ||
            output.includes('Input/output error') ||
            output.includes('Connection refused') ||
            output.includes('No route to host')) {
          logger.error('FFmpeg SRT connection error', {
            streamId,
            srtUrl,
            output: output.substring(0, 500) // Limit log size
          })
        } else if (output.includes('error') || output.includes('Error') || output.includes('Failed')) {
          logger.warn('FFmpeg stderr', { streamId, output: output.substring(0, 500) })
        } else if (output.includes('Stream #0') || output.includes('Input #0') || output.includes('Output #0')) {
          // Log stream info at info level
          logger.info('FFmpeg stream info', { streamId, output: output.substring(0, 200) })
        } else if (output.includes('frame=') || output.includes('fps=') || output.includes('bitrate=')) {
          // Log encoding progress
          logger.info('FFmpeg encoding progress', { streamId, output: output.substring(0, 200) })
        } else if (output.includes('NVIDIA') || output.includes('nvenc') || output.includes('cuda')) {
          // Log hardware acceleration info
          logger.info('FFmpeg hardware acceleration info', { streamId, output: output.substring(0, 200) })
        } else {
          logger.debug('FFmpeg stderr', { streamId, output: output.substring(0, 200) })
        }
      }
    })

    // Handle process events
    subprocess.on('error', (error) => {
      if (error.name === 'AbortError') {
        logger.debug('FFmpeg process aborted', { streamId })
      } else {
        logger.error('FFmpeg process error', {
          streamId,
          error: error.message
        })
      }
    })

    subprocess.on('close', (code, signal) => {
      logger.debug('FFmpeg process closed', {
        streamId,
        code,
        signal
      })
      this.processes.delete(streamId)

      if (code !== 0 && code !== null && signal !== 'SIGTERM' && signal !== 'SIGINT') {
        logger.error('FFmpeg process exited with error', {
          streamId,
          code,
          signal,
          srtUrl,
          lastStderr: stderrBuffer.substring(stderrBuffer.length - 1000) // Last 1000 chars of stderr
        })
      }
    })

    // Wait for process to start (or fail)
    return new Promise((resolve, reject) => {
      subprocess.on('error', (error) => {
        if (error.name !== 'AbortError') {
          this.processes.delete(streamId)
          reject(error)
        }
      })

      // Give FFmpeg a moment to start
      setTimeout(() => {
        if (subprocess.killed || subprocess.exitCode !== null) {
          reject(new Error('FFmpeg process failed to start'))
        } else {
          logger.info('FFmpeg process started successfully', { streamId })
          resolve()
        }
      }, 1000)
    })
  }

  /**
   * Stop FFmpeg process for a stream
   * @param {string} streamId - Stream ID
   */
  async stopStream (streamId) {
    const processInfo = this.processes.get(streamId)
    if (!processInfo) {
      logger.warn('No FFmpeg process found for stream', { streamId })
      return
    }

    logger.debug('Stopping FFmpeg process', { streamId })
    processInfo.abortController.abort()

    return new Promise((resolve) => {
      processInfo.subprocess.on('close', () => {
        this.processes.delete(streamId)
        resolve()
      })

      // Force kill if it doesn't close gracefully
      setTimeout(() => {
        if (!processInfo.subprocess.killed) {
          processInfo.subprocess.kill('SIGKILL')
        }
        resolve()
      }, 5000)
    })
  }

  /**
   * Close all FFmpeg processes
   */
  async close () {
    if (this.closed) {
      return
    }

    this.closed = true

    const streamIds = Array.from(this.processes.keys())
    const promises = streamIds.map(streamId => this.stopStream(streamId))

    await Promise.all(promises)

    logger.debug('FFmpegClient closed')
  }
}

module.exports = FFmpegClient
