// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const Logger = require('../../../lib/Logger')
const logger = new Logger({ name: 'CasparNetworkPlugin' })

/**
 * Manages HLS proxy processes for SRT streams
 */
class StreamProxy {
  constructor () {
    /** @type {Map<string, {process: any, hlsDir: string, manifestUrl: string}>} */
    this.activeProxies = new Map()
    this.baseDir = path.join(os.tmpdir(), 'bridge-caspar-network-hls')
  }

  /**
   * Start HLS proxy for a stream
   * @param {string} streamId - Stream ID
   * @param {string} srtUrl - SRT URL to proxy
   * @param {Object} options - Proxy options
   * @returns {Promise<string>} HLS manifest URL
   */
  async startProxy (streamId, srtUrl, options = {}) {
    // Check if proxy already exists
    if (this.activeProxies.has(streamId)) {
      const existing = this.activeProxies.get(streamId)
      return existing.manifestUrl
    }

    const {
      hlsTime = 2,
      hlsListSize = 3,
      videoCodec = 'libx264',
      audioCodec = 'aac',
      videoBitrate = '2000k',
      audioBitrate = '128k'
    } = options

    // Create HLS output directory
    const hlsDir = path.join(this.baseDir, streamId)
    fs.mkdirSync(hlsDir, { recursive: true })

    const manifestPath = path.join(hlsDir, 'playlist.m3u8')

    // Build FFmpeg command
    // Note: We use hls_base_url to help with segment paths, but we'll rewrite them anyway
    const ffmpegArgs = [
      // Add SRT connection options for better reliability
      '-fflags', '+genpts', // Generate presentation timestamps
      '-flags', '+low_delay', // Low latency mode
      '-strict', 'experimental',
      '-i', srtUrl,
      // Convert pixel format from yuv444p to yuv420p for better compatibility with libx264
      '-pix_fmt', 'yuv420p',
      '-c:v', videoCodec,
      '-preset', 'veryfast',
      '-tune', 'zerolatency',
      '-b:v', videoBitrate,
      '-maxrate', videoBitrate,
      '-bufsize', `${parseInt(videoBitrate) * 2}k`,
      '-g', '30',
      '-c:a', audioCodec,
      '-b:a', audioBitrate,
      '-f', 'hls',
      '-hls_time', hlsTime.toString(),
      '-hls_list_size', hlsListSize.toString(),
      '-hls_flags', 'delete_segments+append_list',
      '-hls_segment_filename', path.join(hlsDir, 'segment_%03d.ts'),
      manifestPath
    ]

    logger.debug('FFmpeg command', { args: ffmpegArgs.join(' ') })

    logger.debug('Starting FFmpeg HLS proxy', { streamId, srtUrl, hlsDir })

    // Spawn FFmpeg process
    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs)

    // Handle process errors
    ffmpegProcess.on('error', (err) => {
      logger.error('FFmpeg process error', err)
      this.stopProxy(streamId)
    })

    // Log FFmpeg output for debugging
    let ffmpegErrorOutput = ''
    ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString()
      ffmpegErrorOutput += output
      // Log errors and important info
      if (output.includes('error') || output.includes('Error') || output.includes('Failed')) {
        logger.warn('FFmpeg error output', output)
      }
      // Log connection info
      if (output.includes('Connection') || output.includes('SRT') || output.includes('srt://')) {
        logger.debug('FFmpeg connection info', output.trim())
      }
    })

    ffmpegProcess.on('exit', (code, signal) => {
      // Signal 15 (SIGTERM) is normal termination (we killed it)
      // Signal 2 (SIGINT) is also normal (Ctrl+C)
      // Exit code 0 is success
      // Exit code 255 might be normal termination in some cases
      if (code !== 0 && code !== null && code !== 255 && signal !== 'SIGTERM' && signal !== 'SIGINT') {
        logger.error('FFmpeg process exited with error', { code, signal, output: ffmpegErrorOutput })
        // Update proxy status if needed
        if (this.activeProxies.has(streamId)) {
          const proxy = this.activeProxies.get(streamId)
          proxy.error = `FFmpeg exited with code ${code}${signal ? ` (signal: ${signal})` : ''}`
        }
      } else if (code === 255 && !ffmpegErrorOutput.includes('Exiting normally')) {
        // Exit code 255 with error output is likely an error
        logger.warn('FFmpeg process exited with code 255', { signal, output: ffmpegErrorOutput.substring(0, 500) })
      } else {
        logger.debug('FFmpeg process exited normally', { code, signal })
      }
    })

    // Store proxy info early so waitForManifest can access it
    const proxyInfo = {
      process: ffmpegProcess,
      hlsDir,
      manifestUrl: null, // Will be set after manifest is ready
      srtUrl,
      manifestWatcher: null
    }
    this.activeProxies.set(streamId, proxyInfo)

    // Wait for manifest file to be created
    const manifestUrl = await this.waitForManifest(manifestPath, streamId)

    // Update proxy info with manifest URL
    proxyInfo.manifestUrl = manifestUrl

    logger.debug('HLS proxy started', { streamId, manifestUrl })
    return manifestUrl
  }

  /**
   * Rewrite manifest file with absolute segment URLs
   * @param {string} manifestPath - Path to manifest file
   * @param {string} streamId - Stream ID
   */
  rewriteManifest (manifestPath, streamId) {
    try {
      if (!fs.existsSync(manifestPath)) {
        return
      }

      // Read the manifest file
      let manifestContent = fs.readFileSync(manifestPath, 'utf8')

      // Rewrite segment URLs to use absolute paths via our API route
      // FFmpeg typically writes segments as: segment_000.ts, segment_001.ts, etc.
      // Replace relative segment paths with absolute API paths
      manifestContent = manifestContent.replace(
        /^(segment_\d+\.ts)$/gm,
        `/api/v1/hls/${streamId}/$1`
      )

      // Also handle any other relative .ts file paths that might exist
      // This catches patterns like: file.ts or any other .ts filename
      manifestContent = manifestContent.replace(
        /^([^/\n#]+\.ts)$/gm,
        (match) => {
          // Only replace if it's not already an absolute URL
          if (!match.startsWith('/') && !match.startsWith('http')) {
            return `/api/v1/hls/${streamId}/${match}`
          }
          return match
        }
      )

      // Write the updated manifest back
      fs.writeFileSync(manifestPath, manifestContent, 'utf8')
    } catch (err) {
      logger.warn('Error rewriting manifest', { streamId, error: err.message })
    }
  }

  /**
   * Wait for HLS manifest file to be created and rewrite it with absolute URLs
   * @param {string} manifestPath - Path to manifest file
   * @param {string} streamId - Stream ID
   * @returns {Promise<string>} Manifest URL
   */
  async waitForManifest (manifestPath, streamId) {
    return new Promise((resolve, reject) => {
      const maxAttempts = 30
      let attempts = 0

      const checkManifest = () => {
        // Check if FFmpeg process is still running
        const proxy = this.activeProxies.get(streamId)
        if (proxy && proxy.process && proxy.process.killed) {
          reject(new Error('FFmpeg process was killed before manifest was created'))
          return
        }

        if (fs.existsSync(manifestPath)) {
          try {
            // Wait a bit more to ensure manifest has content
            setTimeout(() => {
              try {
                // Rewrite the manifest with absolute URLs
                this.rewriteManifest(manifestPath, streamId)
                // Set up a file watcher to continuously rewrite the manifest
                // as FFmpeg updates it with new segments
                const watchInterval = setInterval(() => {
                  if (fs.existsSync(manifestPath) && this.activeProxies.has(streamId)) {
                    const proxy = this.activeProxies.get(streamId)
                    // Only rewrite if process is still running
                    if (proxy && proxy.process && !proxy.process.killed) {
                      this.rewriteManifest(manifestPath, streamId)
                    } else {
                      clearInterval(watchInterval)
                    }
                  } else {
                    clearInterval(watchInterval)
                  }
                }, 1000) // Rewrite every second

                // Store the interval so we can clear it when stopping
                if (proxy) {
                  proxy.manifestWatcher = watchInterval
                }

                // Return the API route URL for the manifest
                const manifestUrl = `/api/v1/hls/${streamId}/playlist.m3u8`
                resolve(manifestUrl)
              } catch (err) {
                logger.error('Error processing manifest', err)
                reject(err)
              }
            }, 500) // Wait 500ms for manifest to have content
          } catch (err) {
            logger.error('Error processing manifest', err)
            reject(err)
          }
          return
        }

        attempts++
        if (attempts >= maxAttempts) {
          reject(new Error('Timeout waiting for HLS manifest'))
          return
        }

        setTimeout(checkManifest, 500)
      }

      checkManifest()
    })
  }

  /**
   * Stop HLS proxy for a stream
   * @param {string} streamId - Stream ID
   */
  stopProxy (streamId) {
    const proxy = this.activeProxies.get(streamId)
    if (!proxy) {
      return
    }

    logger.debug('Stopping HLS proxy', streamId)

    // Clear manifest watcher interval if it exists
    if (proxy.manifestWatcher) {
      clearInterval(proxy.manifestWatcher)
    }

    // Kill FFmpeg process
    if (proxy.process && !proxy.process.killed) {
      proxy.process.kill('SIGTERM')
    }

    // Clean up HLS directory after a delay
    setTimeout(() => {
      try {
        if (fs.existsSync(proxy.hlsDir)) {
          fs.rmSync(proxy.hlsDir, { recursive: true, force: true })
        }
      } catch (err) {
        logger.warn('Error cleaning up HLS directory', err)
      }
    }, 5000)

    this.activeProxies.delete(streamId)
    logger.debug('HLS proxy stopped', streamId)
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
}

module.exports = StreamProxy
