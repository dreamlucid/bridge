// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

/**
 * Channel-based preview: one preview per channel on a dedicated SRT port,
 * tracked separately from output streams (which are for third-party encoders).
 *
 * @type { import('../../api').Api }
 */
const bridge = require('bridge')

const manifest = require('../../package.json')
const paths = require('../paths')
const AMCP = require('../AMCP')
const StreamManager = require('../StreamManager')
const streamManager = require('../streamManagerInstance')
const webRTCPreviewManager = require('../webRTCPreviewManagerInstance')

const Logger = require('../../../../lib/Logger')
const logger = new Logger({ name: 'CasparNetworkPlugin' })

/** In-flight start per channelKey so we never send ADD STREAM twice for the same channel */
const startInFlight = new Map()

/**
 * Get preview settings from plugin state (default port, encoding, stream index)
 * @returns { Promise<{ port: number, srtParams: string, encodingOptions: object, streamIndex: number }> }
 */
async function getPreviewSettings () {
  const settings = await bridge.state.get(paths.STATE_SETTINGS_PATH) || {}
  const port = settings.previewDefaultPort != null ? Number(settings.previewDefaultPort) : 6010
  const srtParams = settings.previewDefaultSrtParams || 'mode=listener&latency=2000&transtype=live'
  // Default to h264_nvenc (GPU) for preview for faster encoding; fallback to libx264 when VAAPI is set (CasparCG pipeline issues)
  let encodingOptions = settings.previewEncodingOptions || {
    format: 'mpegts',
    codec: 'h264_nvenc',
    preset: 'p4',
    tune: 'll',
    bitrate: '2500k',
    maxrate: '2500k',
    bufsize: '5000k',
    gop: 50,
    keyintMin: 50,
    audio: false
  }
  // VAAPI often causes "Impossible to convert" in CasparCG; use libx264 when VAAPI is set so preview still works
  if (encodingOptions.codec === 'h264_vaapi' || encodingOptions.codec === 'hevc_vaapi') {
    encodingOptions = { ...encodingOptions, codec: 'libx264', preset: 'ultrafast', tune: 'zerolatency' }
  }
  const streamIndex = settings.previewStreamIndex != null ? Number(settings.previewStreamIndex) : 999
  return { port, srtParams, encodingOptions, streamIndex }
}

/**
 * Build SRT listener URL for preview (preconfigured, no user input)
 * @param { number } port - Port number
 * @param { string } srtParams - Query params (mode=listener&...)
 * @returns { string }
 */
function buildPreviewSrtUrl (port, srtParams) {
  return `srt://0.0.0.0:${port}?${srtParams}`
}

/**
 * Convert listener SRT URL to caller URL for FFmpeg connection
 * @param { string } listenerUrl - srt://0.0.0.0:PORT?...
 * @returns { string }
 */
function listenerToCallerUrl (listenerUrl) {
  try {
    const url = new URL(listenerUrl.replace('srt://', 'http://'))
    const host = url.hostname === '0.0.0.0' ? '127.0.0.1' : url.hostname
    const port = url.port || '6010'
    const params = url.searchParams
    params.set('mode', 'caller')
    return `srt://${host}:${port}?${params.toString()}`
  } catch (err) {
    logger.warn('Could not parse SRT URL for caller', { listenerUrl, error: err.message })
    return listenerUrl
  }
}

/**
 * Persist channel previews to state
 * @param { Object[] } list - Array of channel preview entries
 */
async function persistChannelPreviewsToState (list) {
  bridge.state.apply({
    plugins: {
      [manifest.name]: {
        streams: {
          channelPreviews: { $replace: list }
        }
      }
    }
  })
}

/**
 * Start channel preview: ADD STREAM on a dedicated preview port, then start WebRTC bridge.
 * One preview per channel; preconfigured command/port. Does not use output streams.
 *
 * @param { string } serverId - CasparCG server ID
 * @param { number } channel - Channel number
 * @returns { Promise<string> } WebRTC signaling path (streamId in URL is channelKey)
 */
async function startChannelPreview (serverId, channel) {
  const channelKey = StreamManager.channelKey(serverId, channel)
  logger.debug('Starting channel preview', { serverId, channel, channelKey })

  // Serialize start per channel: wait for any in-flight start to finish so we never ADD STREAM twice
  if (startInFlight.has(channelKey)) {
    try {
      await startInFlight.get(channelKey)
    } catch (_) { /* ignore */ }
    return startChannelPreview(serverId, channel)
  }

  const existing = streamManager.getChannelPreview(channelKey)

  // Already fully active: return existing signaling path (no ADD STREAM)
  if (existing && existing.status === 'active' && webRTCPreviewManager.isPreviewActive(channelKey)) {
    let path = `/api/v1/webrtc?streamId=${encodeURIComponent(channelKey)}`
    try {
      const state = await bridge.state.get()
      if (state?._id) {
        path += `&workspace=${encodeURIComponent(state._id)}`
      }
    } catch (_) { /* ignore */ }
    logger.debug('Channel preview already active', { channelKey })
    return path
  }

  // If we already have an entry (e.g. concurrent call or retry after WebRTC failed), stream is already on CasparCG — do NOT send ADD STREAM again
  const streamAlreadyAdded = !!existing
  let srtUrl
  let streamIndex
  let srtConnectionUrl

  if (streamAlreadyAdded) {
    srtUrl = existing.srtUrl
    streamIndex = existing.streamIndex
    srtConnectionUrl = listenerToCallerUrl(srtUrl)
    logger.debug('Reusing existing preview stream (no ADD STREAM)', { channelKey })
  } else {
    const { port: basePort, srtParams, encodingOptions: encOpts, streamIndex: idx } = await getPreviewSettings()
    const port = basePort + (channel - 1)
    srtUrl = buildPreviewSrtUrl(port, srtParams)
    streamIndex = idx
    const amcpCommand = AMCP.addStream(channel, streamIndex, srtUrl, encOpts)
    const response = await bridge.commands.executeCommand('caspar.sendString', serverId, amcpCommand)
    const responseCode = typeof response?.code === 'string' ? parseInt(response.code, 10) : response?.code
    if (response && responseCode >= 400) {
      const errorMsg = response.data?.toString() || `CasparCG error ${responseCode}`
      logger.error('CasparCG ADD STREAM failed for preview', { channelKey, code: responseCode })
      throw new Error(errorMsg)
    }

    streamManager.setChannelPreview(serverId, channel, streamIndex, srtUrl, encOpts)
    const list = streamManager.getAllChannelPreviews()
    await persistChannelPreviewsToState(list)
    srtConnectionUrl = listenerToCallerUrl(srtUrl)
  }

  const startPromise = (async () => {
    try {
      return await runStartChannelPreview(serverId, channel, channelKey, streamAlreadyAdded, srtUrl, streamIndex, srtConnectionUrl)
    } finally {
      startInFlight.delete(channelKey)
    }
  })()
  startInFlight.set(channelKey, startPromise)
  return startPromise
}

async function runStartChannelPreview (serverId, channel, channelKey, streamAlreadyAdded, srtUrl, streamIndex, srtConnectionUrl) {
  try {
    const maxAttempts = 3
    const retryDelayMs = 2000
    let lastErr = null
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await webRTCPreviewManager.startPreview(channelKey, srtConnectionUrl)
        lastErr = null
        break
      } catch (err) {
        lastErr = err
        logger.warn('Preview start attempt failed', { channelKey, attempt, maxAttempts, error: err.message })
        if (attempt < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, retryDelayMs))
        }
      }
    }
    if (lastErr) {
      // Only remove from CasparCG and state if we added the stream in this call (not when reusing existing)
      if (!streamAlreadyAdded) {
        streamManager.removeChannelPreview(channelKey)
        await persistChannelPreviewsToState(streamManager.getAllChannelPreviews())
        try {
          const amcpCommand = AMCP.removeStream(channel, streamIndex)
          await bridge.commands.executeCommand('caspar.sendString', serverId, amcpCommand)
        } catch (removeErr) {
          logger.warn('Error removing preview stream after start failure', { channelKey, error: removeErr?.message })
        }
      }
      throw lastErr
    }

    const webRTCSignalingServer = require('../../index').webRTCSignalingServer
    webRTCSignalingServer.registerStreamHandler(channelKey)

    let signalingPath = `/api/v1/webrtc?streamId=${encodeURIComponent(channelKey)}`
    try {
      const state = await bridge.state.get()
      if (state?._id) {
        signalingPath += `&workspace=${encodeURIComponent(state._id)}`
      }
    } catch (_) { /* ignore */ }

    logger.debug('Channel preview started', { channelKey, signalingPath })
    return signalingPath
  } catch (err) {
    const errorMsg = err.message || 'Unknown error'
    streamManager.updateChannelPreviewStatus(channelKey, 'error', errorMsg)
    const list = streamManager.getAllChannelPreviews()
    await persistChannelPreviewsToState(list)
    throw err
  }
}

/**
 * Stop channel preview: REMOVE STREAM, stop WebRTC bridge, remove from tracking.
 *
 * @param { string } serverId - CasparCG server ID
 * @param { number } channel - Channel number
 * @returns { Promise<void> }
 */
async function stopChannelPreview (serverId, channel) {
  const channelKey = StreamManager.channelKey(serverId, channel)
  logger.debug('Stopping channel preview', { serverId, channel, channelKey })

  const entry = streamManager.getChannelPreview(channelKey)
  if (!entry) {
    logger.debug('No channel preview to stop', { channelKey })
    return
  }

  const webRTCSignalingServer = require('../../index').webRTCSignalingServer
  webRTCSignalingServer.unregisterStreamHandler(channelKey)
  await webRTCPreviewManager.stopPreview(channelKey)

  if (entry.status === 'active' && entry.streamIndex != null) {
    try {
      const amcpCommand = AMCP.removeStream(entry.channel, entry.streamIndex)
      await bridge.commands.executeCommand('caspar.sendString', entry.serverId, amcpCommand)
    } catch (err) {
      logger.warn('Error sending REMOVE STREAM for preview', { channelKey, error: err.message })
    }
  }

  streamManager.removeChannelPreview(channelKey)
  const list = streamManager.getAllChannelPreviews()
  await persistChannelPreviewsToState(list)

  logger.debug('Channel preview stopped', { channelKey })
}

/**
 * Get WebRTC signaling path for a channel preview if active.
 *
 * @param { string } serverId - CasparCG server ID
 * @param { number } channel - Channel number
 * @returns { Promise<string|null> }
 */
async function getChannelPreviewUrl (serverId, channel) {
  const channelKey = StreamManager.channelKey(serverId, channel)
  if (!webRTCPreviewManager.isPreviewActive(channelKey)) {
    return null
  }
  return `/api/v1/webrtc?streamId=${encodeURIComponent(channelKey)}`
}

/**
 * List active channel previews (for UI).
 *
 * @returns { Promise<Object[]> } Array of { channelKey, serverId, channel, status, ... }
 */
async function listChannelPreviews () {
  return streamManager.getAllChannelPreviews()
}

/**
 * List channels that can have a preview (unique serverId+channel from input streams).
 * Used by the preview widget to show "Start Preview" per channel.
 *
 * @returns { Promise<Object[]> } Array of { serverId, channel } unique pairs
 */
async function listPreviewableChannels () {
  const streams = await bridge.state.get(paths.STATE_STREAMS_PATH) || { inputs: [] }
  const inputs = streams.inputs || []
  const seen = new Set()
  const list = []
  for (const input of inputs) {
    const key = `${input.serverId}-${input.channel}`
    if (seen.has(key)) continue
    seen.add(key)
    list.push({ serverId: input.serverId, channel: input.channel })
  }
  return list
}

module.exports = {
  startChannelPreview,
  stopChannelPreview,
  getChannelPreviewUrl,
  listChannelPreviews,
  listPreviewableChannels
}
