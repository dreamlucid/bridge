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

  // Add to stream manager
  const streamId = streamManager.addInputStream(serverId, channel, layer, srtUrl, loop)
  const stream = streamManager.getInputStream(streamId)

  // Save to state
  bridge.state.apply({
    plugins: {
      [manifest.name]: {
        streams: {
          inputs: { $push: [stream] }
        }
      }
    }
  })

  logger.debug('Input stream added', streamId)
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

  // Remove from stream manager
  streamManager.removeInputStream(streamId)

  // Remove from state
  const currentStreams = await bridge.state.get(paths.STATE_STREAMS_PATH) || { inputs: [], outputs: [] }
  const newInputs = (currentStreams.inputs || []).filter(s => s.id !== streamId)

  bridge.state.apply({
    plugins: {
      [manifest.name]: {
        streams: {
          inputs: { $replace: newInputs }
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

  // Build AMCP command
  const amcpCommand = AMCP.playSrtStream(stream.channel, stream.layer, stream.srtUrl, stream.loop)

  try {
    // Send command to CasparCG
    await bridge.commands.executeCommand('caspar.sendString', stream.serverId, amcpCommand)

    // Update status
    streamManager.updateInputStreamStatus(streamId, 'active')

    // Update state
    const currentStreams = await bridge.state.get(paths.STATE_STREAMS_PATH) || { inputs: [], outputs: [] }
    const updatedInputs = (currentStreams.inputs || []).map(s => {
      if (s.id === streamId) {
        return { ...s, status: 'active', lastError: null }
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

    logger.debug('Input stream started', streamId)
  } catch (err) {
    const errorMsg = err.message || 'Unknown error'
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
 * Start HLS proxy for a stream preview
 * @param { String } streamId - Stream ID
 * @returns { Promise<String> } HLS manifest URL
 */
async function startPreview (streamId) {
  logger.debug('Starting preview for stream', streamId)

  const stream = await getStreamConfig(streamId)
  if (!stream) {
    throw new Error('Stream not found')
  }

  // Get the singleton proxy instance from index.js
  const pluginIndex = require('../index')
  const proxy = pluginIndex.streamProxy

  // Start HLS proxy
  const manifestUrl = await proxy.startProxy(streamId, stream.srtUrl, {
    hlsTime: 2,
    hlsListSize: 3,
    videoCodec: 'libx264',
    audioCodec: 'aac',
    videoBitrate: '2000k',
    audioBitrate: '128k'
  })

  logger.debug('Preview started', { streamId, manifestUrl })
  return manifestUrl
}
exports.startPreview = startPreview
bridge.commands.registerCommand('caspar-network.startPreview', startPreview)

/**
 * Stop HLS proxy for a stream preview
 * @param { String } streamId - Stream ID
 * @returns { Promise<void> }
 */
async function stopPreview (streamId) {
  logger.debug('Stopping preview for stream', streamId)

  // Get the singleton proxy instance from index.js
  const pluginIndex = require('../index')
  const proxy = pluginIndex.streamProxy

  proxy.stopProxy(streamId)
  logger.debug('Preview stopped', streamId)
}
exports.stopPreview = stopPreview
bridge.commands.registerCommand('caspar-network.stopPreview', stopPreview)

/**
 * Get preview URL for a stream
 * @param { String } streamId - Stream ID
 * @returns { Promise<String|null> } HLS manifest URL or null
 */
async function getPreviewUrl (streamId) {
  const pluginIndex = require('../index')
  const proxy = pluginIndex.streamProxy

  const proxyInfo = proxy.getProxy(streamId)
  return proxyInfo ? proxyInfo.manifestUrl : null
}
exports.getPreviewUrl = getPreviewUrl
bridge.commands.registerCommand('caspar-network.getPreviewUrl', getPreviewUrl)
