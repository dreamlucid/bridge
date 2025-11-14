// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const bridge = require('bridge')
const manifest = require('../package.json')
const paths = require('./paths')

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
    const ffmpegArgs = [
      '-i', srtUrl,
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

    logger.debug('Starting FFmpeg HLS proxy', { streamId, srtUrl, hlsDir })

    // Spawn FFmpeg process
    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs)

    // Handle process errors
    ffmpegProcess.on('error', (err) => {
      logger.error('FFmpeg process error', err)
      this.stopProxy(streamId)
    })

    // Log FFmpeg output for debugging
    ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString()
      if (output.includes('error') || output.includes('Error')) {
        logger.warn('FFmpeg output', output)
      }
    })

    // Wait for manifest file to be created
    const manifestUrl = await this.waitForManifest(manifestPath, streamId)

    // Store proxy info
    this.activeProxies.set(streamId, {
      process: ffmpegProcess,
      hlsDir,
      manifestUrl,
      srtUrl
    })

    logger.debug('HLS proxy started', { streamId, manifestUrl })
    return manifestUrl
  }

  /**
   * Wait for HLS manifest file to be created and serve it
   * @param {string} manifestPath - Path to manifest file
   * @param {string} streamId - Stream ID
   * @returns {Promise<string>} Manifest URL
   */
  async waitForManifest (manifestPath, streamId) {
    return new Promise((resolve, reject) => {
      const maxAttempts = 30
      let attempts = 0

      const checkManifest = () => {
        if (fs.existsSync(manifestPath)) {
          // Serve the manifest file directly
          // Note: For HLS to work fully, segments also need to be accessible
          // This implementation serves the manifest; segment serving would need
          // additional HTTP routes or a different approach
          bridge.server.serveFile(manifestPath).then(manifestUrl => {
            resolve(manifestUrl)
          }).catch(reject)
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

