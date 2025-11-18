// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

/**
 * @type { import('../../api').Api }
 */
const bridge = require('bridge')

const manifest = require('../package.json')
const paths = require('./paths')
const AMCP = require('./AMCP')
const StreamManager = require('./StreamManager')

const Logger = require('../../../lib/Logger')
const logger = new Logger({ name: 'CasparNetworkPlugin' })

// Create singleton stream manager instance
const streamManager = new StreamManager()

/**
 * Get stream configuration from state
 * @param { String } streamId - Stream ID
 * @returns { Promise<Object | null> }
 */
async function getStreamConfig (streamId) {
  const streams = await bridge.state.get(paths.STATE_STREAMS_PATH) || { inputs: [], outputs: [] }

  const inputStream = streams.inputs?.find(s => s.id === streamId)
  if (inputStream) {
    return { type: 'input', ...inputStream }
  }

  const outputStream = streams.outputs?.find(s => s.id === streamId)
  if (outputStream) {
    return { type: 'output', ...outputStream }
  }

  return null
}

/**
 * Sync stream manager with state
 */
async function syncStreamManagerWithState () {
  const streams = await bridge.state.get(paths.STATE_STREAMS_PATH) || { inputs: [], outputs: [] }

  // Clear current streams
  streamManager.inputStreams.clear()
  streamManager.outputStreams.clear()

  // Rebuild from state
  if (streams.inputs) {
    streams.inputs.forEach(stream => {
      streamManager.inputStreams.set(stream.id, stream)
    })
  }

  if (streams.outputs) {
    streams.outputs.forEach(stream => {
      streamManager.outputStreams.set(stream.id, stream)
    })
  }
}

/**
 * Add an SRT input stream
 * @param { String } serverId - CasparCG server ID
 * @param { Number } channel - Channel number
 * @param { Number } layer - Layer number
 * @param { String } srtUrl - SRT URL
 * @param { Boolean } loop - Loop flag
 * @returns { Promise<String> } Stream ID
 */
async function addInputStream (serverId, channel, layer, srtUrl, loop = false) {
  logger.debug('Adding input stream', { serverId, channel, layer, srtUrl, loop })

  // Validate parameters
  if (!serverId || channel == null || layer == null || !srtUrl) {
    throw new Error('Missing required parameters: serverId, channel, layer, srtUrl')
  }

  // Validate SRT URL format
  if (!srtUrl.startsWith('srt://')) {
    throw new Error('SRT URL must start with srt://')
  }

  // Validate URL structure (basic check)
  try {
    const url = new URL(srtUrl.replace('srt://', 'http://')) // Use http:// for URL parsing
    if (!url.hostname || !url.port) {
      throw new Error('SRT URL must include hostname and port')
    }
  } catch (err) {
    throw new Error(`Invalid SRT URL format: ${err.message}`)
  }

  // Validate channel and layer
  if (channel < 1) {
    throw new Error('Channel must be >= 1')
  }
  if (layer < 0) {
    throw new Error('Layer must be >= 0')
  }

  // Add to stream manager
  const streamId = streamManager.addInputStream(serverId, channel, layer, srtUrl, loop)
  const stream = streamManager.getInputStream(streamId)

  // Get default encoding options from settings
  const settings = await bridge.state.get(paths.STATE_SETTINGS_PATH) || {}
  const defaultEncodingOptions = settings.defaultEncodingOptions || {
    format: 'mpegts',
    codec: 'h264_nvenc',
    preset: 'p4',
    tune: 'll',
    bitrate: '6000k',
    maxrate: '6000k',
    bufsize: '12000k',
    gop: 50,
    keyintMin: 50,
    audio: false
  }

  // Generate SRT listener URL for output stream
  // Parse input URL to extract parameters
  let outputSrtUrl = 'srt://0.0.0.0:6000?mode=listener&latency=2000&transtype=live'
  try {
    const inputUrl = new URL(srtUrl.replace('srt://', 'http://'))
    const latency = inputUrl.searchParams.get('latency') || '2000'
    const transtype = inputUrl.searchParams.get('transtype') || 'live'

    // Use port 6000 by default, or try to derive from input port
    let outputPort = '6000'
    if (inputUrl.port) {
      // Try to use a different port (e.g., input port + 1000, or use 6000)
      const inputPort = parseInt(inputUrl.port, 10)
      if (inputPort && inputPort < 9000) {
        outputPort = (inputPort + 1000).toString()
      }
    }

    outputSrtUrl = `srt://0.0.0.0:${outputPort}?mode=listener&latency=${latency}&transtype=${transtype}`
  } catch (err) {
    logger.warn('Could not parse input SRT URL, using default output URL', { srtUrl, error: err.message })
  }

  // Automatically create a corresponding output stream
  const outputStreamId = streamManager.addOutputStream(serverId, channel, outputSrtUrl, defaultEncodingOptions)
  const outputStream = streamManager.getOutputStream(outputStreamId)

  // Save both input and output streams to state
  bridge.state.apply({
    plugins: {
      [manifest.name]: {
        streams: {
          inputs: { $push: [stream] },
          outputs: { $push: [outputStream] }
        }
      }
    }
  })

  logger.info('Input stream added with automatic output stream', {
    streamId,
    outputStreamId,
    channel,
    layer,
    srtUrl,
    outputSrtUrl
  })
  return streamId
}
exports.addInputStream = addInputStream
bridge.commands.registerCommand('caspar-network.addInputStream', addInputStream)

/**
 * Remove an SRT input stream
 * @param { String } streamId - Stream ID
 * @returns { Promise<void> }
 */
async function removeInputStream (streamId) {
  logger.debug('Removing input stream', streamId)

  const stream = streamManager.getInputStream(streamId)
  if (!stream) {
    throw new Error('Input stream not found')
  }

  // Stop the stream if it's active
  if (stream.status === 'active') {
    try {
      const amcpCommand = AMCP.stop(stream.channel, stream.layer)
      await bridge.commands.executeCommand('caspar.sendString', stream.serverId, amcpCommand)
    } catch (err) {
      logger.warn('Error stopping stream before removal', err)
    }
  }

  // Find and remove associated output stream if it exists
  // Output streams created automatically for input streams are on the same channel
  const currentStreams = await bridge.state.get(paths.STATE_STREAMS_PATH) || { inputs: [], outputs: [] }
  const inputStream = currentStreams.inputs?.find(s => s.id === streamId)

  // Remove associated output stream (if it was auto-created for this input)
  // We identify it by matching channel and checking if it's the only output for this channel
  // This is a simple heuristic - in a more complex system, we'd track the relationship explicitly
  let outputsToKeep = currentStreams.outputs || []
  if (inputStream) {
    // Find output streams on the same channel
    const channelOutputs = (currentStreams.outputs || []).filter(s =>
      s.serverId === inputStream.serverId && s.channel === inputStream.channel
    )

    // If there's exactly one output stream for this channel, it's likely the auto-created one
    // Remove it when removing the input stream
    if (channelOutputs.length === 1) {
      const autoOutputId = channelOutputs[0].id
      // Stop the output stream if it's active
      if (channelOutputs[0].status === 'active' && channelOutputs[0].streamIndex != null) {
        try {
          const amcpCommand = AMCP.removeStream(channelOutputs[0].channel, channelOutputs[0].streamIndex)
          await bridge.commands.executeCommand('caspar.sendString', channelOutputs[0].serverId, amcpCommand)
        } catch (err) {
          logger.warn('Error stopping associated output stream before removal', err)
        }
      }
      streamManager.removeOutputStream(autoOutputId)
      outputsToKeep = (currentStreams.outputs || []).filter(s => s.id !== autoOutputId)
      logger.debug('Removed associated output stream', { inputStreamId: streamId, outputStreamId: autoOutputId })
    }
  }

  // Remove from stream manager
  streamManager.removeInputStream(streamId)

  // Remove from state
  const newInputs = (currentStreams.inputs || []).filter(s => s.id !== streamId)

  bridge.state.apply({
    plugins: {
      [manifest.name]: {
        streams: {
          inputs: { $replace: newInputs },
          outputs: { $replace: outputsToKeep }
        }
      }
    }
  })

  logger.debug('Input stream removed', streamId)
}
exports.removeInputStream = removeInputStream
bridge.commands.registerCommand('caspar-network.removeInputStream', removeInputStream)

/**
 * Start an SRT input stream
 * @param { String } streamId - Stream ID
 * @returns { Promise<void> }
 */
async function startInputStream (streamId) {
  logger.debug('Starting input stream', streamId)

  const stream = streamManager.getInputStream(streamId)
  if (!stream) {
    throw new Error('Input stream not found')
  }

  // Validate SRT URL format
  if (!stream.srtUrl || !stream.srtUrl.startsWith('srt://')) {
    const errorMsg = 'Invalid SRT URL format. Must start with srt://'
    logger.error('Invalid SRT URL', { streamId, srtUrl: stream.srtUrl })
    streamManager.updateInputStreamStatus(streamId, 'error', errorMsg)
    throw new Error(errorMsg)
  }

  // Build AMCP command
  const amcpCommand = AMCP.playSrtStream(stream.channel, stream.layer, stream.srtUrl, stream.loop)
  logger.debug('Sending AMCP command', { serverId: stream.serverId, command: amcpCommand })

  try {
    // Send command to CasparCG
    const response = await bridge.commands.executeCommand('caspar.sendString', stream.serverId, amcpCommand)
    logger.debug('CasparCG response', { streamId, response })

    // Check response for errors
    if (response && response.code && response.code >= 400) {
      const errorMsg = response.data?.toString() || `CasparCG returned error code ${response.code}`
      logger.error('CasparCG error response', { streamId, code: response.code, data: response.data })
      streamManager.updateInputStreamStatus(streamId, 'error', errorMsg)

      // Update state with error
      const currentStreams = await bridge.state.get(paths.STATE_STREAMS_PATH) || { inputs: [], outputs: [] }
      const updatedInputs = (currentStreams.inputs || []).map(s => {
        if (s.id === streamId) {
          return { ...s, status: 'error', lastError: errorMsg }
        }
        return s
      })

      bridge.state.apply({
        plugins: {
          [manifest.name]: {
            streams: {
              inputs: { $replace: updatedInputs }
            }
          }
        }
      })
      throw new Error(errorMsg)
    }

    // Note: Preview functionality is only available for output streams
    // Input streams only show status information from CasparCG

    // Update status
    streamManager.updateInputStreamStatus(streamId, 'active')

    // Update state
    const currentStreams = await bridge.state.get(paths.STATE_STREAMS_PATH) || { inputs: [], outputs: [] }
    const updatedInputs = (currentStreams.inputs || []).map(s => {
      if (s.id === streamId) {
        return {
          ...s,
          status: 'active',
          lastError: null
        }
      }
      return s
    })

    bridge.state.apply({
      plugins: {
        [manifest.name]: {
          streams: {
            inputs: { $replace: updatedInputs }
          }
        }
      }
    })

    logger.info('Input stream started successfully', { streamId, channel: stream.channel, layer: stream.layer, srtUrl: stream.srtUrl })

    // Schedule a delayed check to verify the SRT connection actually succeeded
    // CasparCG accepts the command immediately, but the SRT connection happens asynchronously
    // Wait a few seconds then check if the connection actually succeeded
    setTimeout(async () => {
      try {
        const pluginIndex = require('../index')
        const monitor = pluginIndex.streamMonitor
        await monitor.checkInputStream(stream)
        logger.debug('Delayed connection check completed', { streamId })
      } catch (err) {
        logger.warn('Delayed connection check failed', { streamId, error: err.message })
      }
    }, 5000) // Check after 5 seconds
  } catch (err) {
    const errorMsg = err.message || 'Unknown error'
    logger.error('Error starting input stream', { streamId, error: errorMsg, stack: err.stack })
    streamManager.updateInputStreamStatus(streamId, 'error', errorMsg)

    // Update state with error
    const currentStreams = await bridge.state.get(paths.STATE_STREAMS_PATH) || { inputs: [], outputs: [] }
    const updatedInputs = (currentStreams.inputs || []).map(s => {
      if (s.id === streamId) {
        return { ...s, status: 'error', lastError: errorMsg }
      }
      return s
    })

    bridge.state.apply({
      plugins: {
        [manifest.name]: {
          streams: {
            inputs: { $replace: updatedInputs }
          }
        }
      }
    })

    throw err
  }
}
exports.startInputStream = startInputStream
bridge.commands.registerCommand('caspar-network.startInputStream', startInputStream)

/**
 * Stop an SRT input stream
 * @param { String } streamId - Stream ID
 * @returns { Promise<void> }
 */
async function stopInputStream (streamId) {
  logger.debug('Stopping input stream', streamId)

  const stream = streamManager.getInputStream(streamId)
  if (!stream) {
    throw new Error('Input stream not found')
  }

  // Note: Preview streams are no longer automatically created for input streams

  // Build AMCP command
  const amcpCommand = AMCP.stop(stream.channel, stream.layer)

  try {
    // Send command to CasparCG
    await bridge.commands.executeCommand('caspar.sendString', stream.serverId, amcpCommand)

    // Update status
    streamManager.updateInputStreamStatus(streamId, 'stopped')

    // Update state
    const currentStreams = await bridge.state.get(paths.STATE_STREAMS_PATH) || { inputs: [], outputs: [] }
    const updatedInputs = (currentStreams.inputs || []).map(s => {
      if (s.id === streamId) {
        return { ...s, status: 'stopped', lastError: null }
      }
      return s
    })

    bridge.state.apply({
      plugins: {
        [manifest.name]: {
          streams: {
            inputs: { $replace: updatedInputs }
          }
        }
      }
    })
    logger.debug('Input stream stopped', streamId)
  } catch (err) {
    const errorMsg = err.message || 'Unknown error'
    streamManager.updateInputStreamStatus(streamId, 'error', errorMsg)
    throw err
  }
}
exports.stopInputStream = stopInputStream
bridge.commands.registerCommand('caspar-network.stopInputStream', stopInputStream)

/**
 * Add an SRT output stream
 * @param { String } serverId - CasparCG server ID
 * @param { Number } channel - Channel number
 * @param { String } srtUrl - SRT listener URL
 * @param { Object } encodingOptions - Encoding parameters
 * @returns { Promise<String> } Stream ID
 */
async function addOutputStream (serverId, channel, srtUrl, encodingOptions = {}) {
  logger.debug('Adding output stream', { serverId, channel, srtUrl, encodingOptions })

  // Validate parameters
  if (!serverId || channel == null || !srtUrl) {
    throw new Error('Missing required parameters: serverId, channel, srtUrl')
  }

  // Add to stream manager
  const streamId = streamManager.addOutputStream(serverId, channel, srtUrl, encodingOptions)
  const stream = streamManager.getOutputStream(streamId)

  // Save to state
  bridge.state.apply({
    plugins: {
      [manifest.name]: {
        streams: {
          outputs: { $push: [stream] }
        }
      }
    }
  })

  logger.debug('Output stream added', streamId)
  return streamId
}
exports.addOutputStream = addOutputStream
bridge.commands.registerCommand('caspar-network.addOutputStream', addOutputStream)

/**
 * Remove an SRT output stream
 * @param { String } streamId - Stream ID
 * @returns { Promise<void> }
 */
async function removeOutputStream (streamId) {
  logger.debug('Removing output stream', streamId)

  const stream = streamManager.getOutputStream(streamId)
  if (!stream) {
    throw new Error('Output stream not found')
  }

  // Stop the stream if it's active
  if (stream.status === 'active' && stream.streamIndex != null) {
    try {
      const amcpCommand = AMCP.removeStream(stream.channel, stream.streamIndex)
      await bridge.commands.executeCommand('caspar.sendString', stream.serverId, amcpCommand)
    } catch (err) {
      logger.warn('Error removing stream before deletion', err)
    }
  }

  // Remove from stream manager
  streamManager.removeOutputStream(streamId)

  // Remove from state
  const currentStreams = await bridge.state.get(paths.STATE_STREAMS_PATH) || { inputs: [], outputs: [] }
  const newOutputs = (currentStreams.outputs || []).filter(s => s.id !== streamId)

  bridge.state.apply({
    plugins: {
      [manifest.name]: {
        streams: {
          outputs: { $replace: newOutputs }
        }
      }
    }
  })

  logger.debug('Output stream removed', streamId)
}
exports.removeOutputStream = removeOutputStream
bridge.commands.registerCommand('caspar-network.removeOutputStream', removeOutputStream)

/**
 * Start an SRT output stream
 * @param { String } streamId - Stream ID
 * @returns { Promise<void> }
 */
async function startOutputStream (streamId) {
  logger.debug('Starting output stream', streamId)

  const stream = streamManager.getOutputStream(streamId)
  if (!stream) {
    throw new Error('Output stream not found')
  }

  // Build AMCP command
  const amcpCommand = AMCP.addStream(stream.channel, stream.srtUrl, stream.encodingOptions)

  try {
    // Send command to CasparCG
    const response = await bridge.commands.executeCommand('caspar.sendString', stream.serverId, amcpCommand)

    // Parse stream index from response if available
    // CasparCG returns: "202 ADD 1 STREAM OK" or similar
    // The stream index might be in the response data
    let streamIndex = null
    if (response && response.data) {
      // Try to extract stream index from response
      // This may need adjustment based on actual CasparCG response format
      const match = response.data.toString().match(/STREAM\s+(\d+)/)
      if (match) {
        streamIndex = parseInt(match[1], 10)
        streamManager.setOutputStreamIndex(streamId, streamIndex)
      }
    }

    // Update status
    streamManager.updateOutputStreamStatus(streamId, 'active')

    // Update state
    const currentStreams = await bridge.state.get(paths.STATE_STREAMS_PATH) || { inputs: [], outputs: [] }
    const updatedOutputs = (currentStreams.outputs || []).map(s => {
      if (s.id === streamId) {
        return { ...s, status: 'active', streamIndex, lastError: null }
      }
      return s
    })

    bridge.state.apply({
      plugins: {
        [manifest.name]: {
          streams: {
            outputs: { $replace: updatedOutputs }
          }
        }
      }
    })

    logger.debug('Output stream started', streamId, 'streamIndex:', streamIndex)
  } catch (err) {
    const errorMsg = err.message || 'Unknown error'
    streamManager.updateOutputStreamStatus(streamId, 'error', errorMsg)

    // Update state with error
    const currentStreams = await bridge.state.get(paths.STATE_STREAMS_PATH) || { inputs: [], outputs: [] }
    const updatedOutputs = (currentStreams.outputs || []).map(s => {
      if (s.id === streamId) {
        return { ...s, status: 'error', lastError: errorMsg }
      }
      return s
    })

    bridge.state.apply({
      plugins: {
        [manifest.name]: {
          streams: {
            outputs: { $replace: updatedOutputs }
          }
        }
      }
    })

    throw err
  }
}
exports.startOutputStream = startOutputStream
bridge.commands.registerCommand('caspar-network.startOutputStream', startOutputStream)

/**
 * Stop an SRT output stream
 * @param { String } streamId - Stream ID
 * @returns { Promise<void> }
 */
async function stopOutputStream (streamId) {
  logger.debug('Stopping output stream', streamId)

  const stream = streamManager.getOutputStream(streamId)
  if (!stream) {
    throw new Error('Output stream not found')
  }

  if (stream.streamIndex == null) {
    throw new Error('Stream index not available, cannot stop stream')
  }

  // Build AMCP command
  const amcpCommand = AMCP.removeStream(stream.channel, stream.streamIndex)

  try {
    // Send command to CasparCG
    await bridge.commands.executeCommand('caspar.sendString', stream.serverId, amcpCommand)

    // Update status
    streamManager.updateOutputStreamStatus(streamId, 'stopped')

    // Update state
    const currentStreams = await bridge.state.get(paths.STATE_STREAMS_PATH) || { inputs: [], outputs: [] }
    const updatedOutputs = (currentStreams.outputs || []).map(s => {
      if (s.id === streamId) {
        return { ...s, status: 'stopped', lastError: null }
      }
      return s
    })

    bridge.state.apply({
      plugins: {
        [manifest.name]: {
          streams: {
            outputs: { $replace: updatedOutputs }
          }
        }
      }
    })

    logger.debug('Output stream stopped', streamId)
  } catch (err) {
    const errorMsg = err.message || 'Unknown error'
    streamManager.updateOutputStreamStatus(streamId, 'error', errorMsg)
    throw err
  }
}
exports.stopOutputStream = stopOutputStream
bridge.commands.registerCommand('caspar-network.stopOutputStream', stopOutputStream)

/**
 * List all active streams
 * @returns { Promise<Object> } Object with inputs and outputs arrays
 */
async function listStreams () {
  await syncStreamManagerWithState()
  return streamManager.getAllStreams()
}
exports.listStreams = listStreams
bridge.commands.registerCommand('caspar-network.listStreams', listStreams)

/**
 * Get stream status
 * @param { String } streamId - Stream ID
 * @returns { Promise<Object> } Stream status
 */
async function getStreamStatus (streamId) {
  const stream = await getStreamConfig(streamId)
  if (!stream) {
    throw new Error('Stream not found')
  }

  return {
    id: stream.id,
    type: stream.type,
    status: stream.status,
    lastError: stream.lastError,
    createdAt: stream.createdAt
  }
}
exports.getStreamStatus = getStreamStatus
bridge.commands.registerCommand('caspar-network.getStreamStatus', getStreamStatus)

/**
 * Refresh stream status by querying CasparCG
 * @param { String } streamId - Stream ID
 * @returns { Promise<Object> } Updated stream status
 */
async function refreshStreamStatus (streamId) {
  // Get the singleton monitor instance from index.js
  const pluginIndex = require('../index')
  const monitor = pluginIndex.streamMonitor
  return await monitor.refreshStreamStatus(streamId)
}
exports.refreshStreamStatus = refreshStreamStatus
bridge.commands.registerCommand('caspar-network.refreshStreamStatus', refreshStreamStatus)

/**
 * Start WebRTC proxy for a stream preview (low-latency real-time preview)
 * @param { String } streamId - Stream ID
 * @returns { Promise<String> } WebRTC signaling URL
 */
async function startPreview (streamId) {
  logger.debug('Starting WebRTC preview for stream', streamId)

  const stream = await getStreamConfig(streamId)
  if (!stream) {
    throw new Error('Stream not found')
  }

  // Get the singleton WebRTC proxy instance from index.js
  const pluginIndex = require('../index')
  const webrtcProxy = pluginIndex.webrtcProxy

  let previewSrtUrl = null

  if (stream.type === 'input') {
    // Preview is only available for output streams
    // Input streams should only show status information from CasparCG
    throw new Error('Preview is not available for input streams. Please use an output stream for preview functionality.')
  } else if (stream.type === 'output') {
    // For output streams, use the existing output SRT URL
    // The output stream is in listener mode, so we connect as caller
    // Replace mode=listener with mode=caller, or add mode=caller if not present
    if (stream.srtUrl.includes('mode=listener')) {
      previewSrtUrl = stream.srtUrl.replace('mode=listener', 'mode=caller')
    } else if (stream.srtUrl.includes('?')) {
      previewSrtUrl = stream.srtUrl + '&mode=caller'
    } else {
      previewSrtUrl = stream.srtUrl + '?mode=caller&latency=500&transtype=live'
    }
    logger.debug('Using output stream SRT URL for preview', { streamId, previewSrtUrl })
  } else {
    throw new Error('Unknown stream type')
  }

  if (!previewSrtUrl) {
    throw new Error('Preview SRT URL not available')
  }

  // Start WebRTC proxy (low-latency real-time preview)
  // Note: Preview streams are created without audio (audio: false), so we disable audio encoding
  // Using h264_nvenc (NVIDIA GPU encoder) for hardware acceleration
  const signalingUrl = await webrtcProxy.startProxy(streamId, previewSrtUrl, {
    videoCodec: 'h264_nvenc', // NVIDIA GPU encoder for hardware acceleration
    audioCodec: 'libopus',
    videoBitrate: '2000k',
    audioBitrate: '128k',
    preset: 'p4', // Medium quality preset for NVIDIA encoder
    tune: 'll', // Low latency tuning
    gop: 30, // GOP size
    hasAudio: false // Preview streams don't have audio
  })

  logger.debug('WebRTC preview started', { streamId, signalingUrl, previewSrtUrl })
  return signalingUrl
}
exports.startPreview = startPreview
bridge.commands.registerCommand('caspar-network.startPreview', startPreview)

/**
 * Stop WebRTC proxy for a stream preview
 * @param { String } streamId - Stream ID
 * @returns { Promise<void> }
 */
async function stopPreview (streamId) {
  logger.debug('Stopping WebRTC preview for stream', streamId)

  // Get the singleton WebRTC proxy instance from index.js
  const pluginIndex = require('../index')
  const webrtcProxy = pluginIndex.webrtcProxy

  webrtcProxy.stopProxy(streamId)
  logger.debug('WebRTC preview stopped', streamId)
}
exports.stopPreview = stopPreview
bridge.commands.registerCommand('caspar-network.stopPreview', stopPreview)

/**
 * Get preview URL for a stream
 * @param { String } streamId - Stream ID
 * @returns { Promise<String|null> } WebRTC signaling URL or null
 */
async function getPreviewUrl (streamId) {
  const pluginIndex = require('../index')
  const webrtcProxy = pluginIndex.webrtcProxy

  const proxyInfo = webrtcProxy.getProxy(streamId)
  if (proxyInfo) {
    // If using Bridge server integration (port = 0), use relative path
    if (webrtcProxy.port === 0) {
      return `/api/v1/webrtc-signaling?streamId=${streamId}`
    } else if (webrtcProxy.port) {
      return `ws://127.0.0.1:${webrtcProxy.port}?streamId=${streamId}`
    }
  }
  return null
}
exports.getPreviewUrl = getPreviewUrl
bridge.commands.registerCommand('caspar-network.getPreviewUrl', getPreviewUrl)
