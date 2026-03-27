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
   * Encode with NVIDIA NVENC always. Optional CUDA decode (NVDEC) when useHardware is true.
   * @param {Object} options
   * @param {string} options.streamId - Stream ID
   * @param {string} options.srtUrl - SRT input URL
   * @param {Object} options.videoTransport - Video PlainTransport info { ip, port, rtcpPort }
   * @param {number} options.videoSsrc - Video SSRC
   * @param {number} options.videoPt - Video payload type
   * @param {boolean} options.useHardware - Request CUDA hardware decode before -i (default: true). Encode stays NVENC.
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

    // Build FFmpeg command for video-only RTP stream (encode: always h264_nvenc)
    const cmd = 'ffmpeg'
    const args = []

    // Hardware acceleration options MUST come BEFORE the input (-i) option
    if (useHardware) {
      // CUDA decode only — do not pin -hwaccel_output_format to nv12/cuda, or decoded frames
      // stay on-GPU and break -vf scale (and hwdownload fails when FFmpeg uses sw decode
      // "h264 (native)", which still happens with -hwaccel cuda in some streams/setups).
      args.push('-hwaccel', 'cuda')
    }

    // SRT input options for minimal end-to-end delay (server and client on same machine)
    // Equivalent to ffplay: -fflags nobuffer -flags low_delay -analyzeduration 0 -probesize 32
    // -re is omitted so we read as fast as the stream delivers (no artificial throttling)
    args.push(
      '-fflags', '+nobuffer', // Minimize input buffering (same as ffplay -fflags nobuffer)
      '-flags', '+low_delay', // Low latency demux/decoder
      '-analyzeduration', '0', // No demux analysis delay (start immediately)
      '-probesize', '32', // Minimal probe so decoding starts ASAP
      '-strict', 'experimental',
      '-v', 'info',
      '-timeout', '5000000', // 5 second timeout in microseconds
      '-i', srtUrl
    )

    // Map video stream
    args.push('-map', '0:v:0')

    // Preview: 360p height (required — NVENC always re-encodes, never stream copy)
    args.push('-vf', 'scale=-2:360')

    // Video encoding: always NVIDIA NVENC (no -c:v copy fallback)
    // IMPORTANT: RTP parameters must match the producer's RTP parameters exactly
    // Producer expects: packetization-mode=1, profile-level-id=42e01f (Baseline profile, Level 3.1)
    // ~800k VBR suits 360p preview
    args.push(
      '-c:v', 'h264_nvenc',
      '-preset', 'p4', // Medium quality preset (p1-p7, p1=fastest, p7=slowest)
      '-tune', 'll', // Low latency tuning
      '-rc', 'vbr', // Variable bitrate
      '-b:v', '800k',
      '-maxrate', '800k',
      '-bufsize', '1600k', // ~2× maxrate
      '-g', '50',
      '-keyint_min', '50',
      '-profile:v', 'baseline' // matches producer: profile-level-id=42e01f
    )

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
          // Log stream info at debug level
          logger.debug('FFmpeg stream info', { streamId, output: output.substring(0, 200) })
        } else if (output.includes('frame=') || output.includes('fps=') || output.includes('bitrate=')) {
          // Log encoding progress at debug level
          logger.debug('FFmpeg encoding progress', { streamId, output: output.substring(0, 200) })
        } else if (output.includes('NVIDIA') || output.includes('nvenc') || output.includes('cuda')) {
          // Log hardware acceleration info at debug level
          logger.debug('FFmpeg hardware acceleration info', { streamId, output: output.substring(0, 200) })
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
          logger.debug('FFmpeg process started successfully', { streamId })
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
