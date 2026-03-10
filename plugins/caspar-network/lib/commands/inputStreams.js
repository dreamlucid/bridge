// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

/**
 * @type { import('../../api').Api }
 */
const bridge = require('bridge')

const manifest = require('../../package.json')
const paths = require('../paths')
const AMCP = require('../AMCP')

const Logger = require('../../../../lib/Logger')
const logger = new Logger({ name: 'CasparNetworkPlugin' })

const streamManager = require('../streamManagerInstance')

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
    codec: 'h264_vaapi', // Default to VAAPI (available in custom FFmpeg build)
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
  // Use index 0 as default for auto-created streams
  const outputStreamId = streamManager.addOutputStream(serverId, channel, 0, outputSrtUrl, defaultEncodingOptions)
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

  logger.debug('Input stream added with automatic output stream', {
    streamId,
    outputStreamId,
    channel,
    layer,
    srtUrl,
    outputSrtUrl
  })
  return streamId
}

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
      if (channelOutputs[0].status === 'active' && channelOutputs[0].index != null) {
        try {
          const amcpCommand = AMCP.removeStream(channelOutputs[0].channel, channelOutputs[0].index)
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

    logger.debug('Input stream started successfully', { streamId, channel: stream.channel, layer: stream.layer, srtUrl: stream.srtUrl })

    // Schedule a delayed check to verify the SRT connection actually succeeded
    // CasparCG accepts the command immediately, but the SRT connection happens asynchronously
    // Wait a few seconds then check if the connection actually succeeded
    setTimeout(async () => {
      try {
        const pluginIndex = require('../../index')
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

/**
 * Reload an SRT input stream by removing and re-adding it (same config), then starting it.
 * @param { String } streamId - Stream ID
 * @returns { Promise<String> } New stream ID after reload
 */
async function reloadInputStream (streamId) {
  logger.debug('Reloading input stream', streamId)

  const stream = streamManager.getInputStream(streamId)
  if (!stream) {
    throw new Error('Input stream not found')
  }

  const { serverId, channel, layer, srtUrl, loop } = stream

  await removeInputStream(streamId)
  const newStreamId = await addInputStream(serverId, channel, layer, srtUrl, loop)
  await startInputStream(newStreamId)

  logger.debug('Input stream reloaded', { oldStreamId: streamId, newStreamId })
  return newStreamId
}

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

module.exports = {
  addInputStream,
  removeInputStream,
  reloadInputStream,
  startInputStream,
  stopInputStream
}
