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
const { extractStreamIndexFromAddResponse, extractStreamIndexFromInfo, getStreamIndexFromCasparCG } = require('../streamHelpers')

/**
 * Add an SRT output stream
 * @param { String } serverId - CasparCG server ID
 * @param { Number } channel - Channel number
 * @param { Number } index - Stream index
 * @param { String } srtUrl - SRT listener URL
 * @param { Object } encodingOptions - Encoding parameters
 * @returns { Promise<String> } Stream ID
 */
async function addOutputStream (serverId, channel, index, srtUrl, encodingOptions = {}) {
  logger.debug('Adding output stream', { serverId, channel, index, srtUrl, encodingOptions })

  // Validate parameters
  if (!serverId || channel == null || index == null || !srtUrl) {
    throw new Error('Missing required parameters: serverId, channel, index, srtUrl')
  }

  // Add to stream manager
  const streamId = streamManager.addOutputStream(serverId, channel, index, srtUrl, encodingOptions)
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
  if (stream.status === 'active' && stream.index != null) {
    try {
      const amcpCommand = AMCP.removeStream(stream.channel, stream.index)
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

/**
 * Reload an SRT output stream by removing and re-adding it (same config), then starting it.
 * @param { String } streamId - Stream ID
 * @returns { Promise<String> } New stream ID after reload
 */
async function reloadOutputStream (streamId) {
  logger.debug('Reloading output stream', streamId)

  const stream = streamManager.getOutputStream(streamId)
  if (!stream) {
    throw new Error('Output stream not found')
  }

  const { serverId, channel, index, srtUrl, encodingOptions } = stream

  await removeOutputStream(streamId)
  const newStreamId = await addOutputStream(serverId, channel, index, srtUrl, encodingOptions)
  await startOutputStream(newStreamId)

  logger.debug('Output stream reloaded', { oldStreamId: streamId, newStreamId })
  return newStreamId
}

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
  const amcpCommand = AMCP.addStream(stream.channel, stream.index, stream.srtUrl, stream.encodingOptions)

  try {
    // Send command to CasparCG
    const response = await bridge.commands.executeCommand('caspar.sendString', stream.serverId, amcpCommand)

    // Log the full response for debugging
    logger.debug('ADD STREAM response', {
      streamId,
      code: response?.code,
      data: response?.data,
      responseType: typeof response?.data,
      isArray: Array.isArray(response?.data)
    })

    // Check response for errors first
    // Note: 202 is success for ADD commands, 200/201 for INFO
    const responseCode = typeof response?.code === 'string' ? parseInt(response.code, 10) : response?.code
    if (response && responseCode >= 400) {
      const errorMsg = response.data?.toString() || `CasparCG returned error code ${responseCode}`
      logger.error('CasparCG error response', { streamId, code: responseCode, data: response.data })
      streamManager.updateOutputStreamStatus(streamId, 'error', errorMsg)
      throw new Error(errorMsg)
    }

    // Check if command succeeded (200, 201, or 202 are success codes)
    if (response && responseCode !== 200 && responseCode !== 201 && responseCode !== 202) {
      // eslint-disable-next-line no-unused-vars
      const errorMsg = `Unexpected response code: ${responseCode}`
      logger.warn('Unexpected CasparCG response code', { streamId, code: responseCode, data: response.data })
    }

    // Parse stream index from ADD response
    // CasparCG returns: "202 ADD 1 STREAM 0 OK" or "202 ADD 1 STREAM OK"
    let streamIndex = null
    if (response && response.data) {
      // Try to extract stream index from ADD response (different format than INFO)
      streamIndex = extractStreamIndexFromAddResponse(response.data, stream.channel)
      if (streamIndex != null) {
        streamManager.setOutputStreamIndex(streamId, streamIndex)
        logger.debug('Extracted stream index from ADD response', { streamId, streamIndex })
      } else {
        // If not found in ADD response, try INFO response format as fallback
        streamIndex = extractStreamIndexFromInfo(response.data, stream.srtUrl)
        if (streamIndex != null) {
          streamManager.setOutputStreamIndex(streamId, streamIndex)
          logger.debug('Extracted stream index using INFO format', { streamId, streamIndex })
        }
      }
    }

    // If stream index was not found in the response, try querying CasparCG for it
    if (streamIndex == null) {
      logger.debug('Stream index not found in ADD response, querying CasparCG INFO', { streamId })
      // Wait a short moment for CasparCG to register the stream
      await new Promise(resolve => setTimeout(resolve, 500))
      streamIndex = await getStreamIndexFromCasparCG(stream)
      if (streamIndex == null) {
        logger.warn('Could not determine stream index after starting stream. Stream may still be starting.', {
          streamId,
          responseCode,
          responseData: response?.data
        })
        // Don't fail - the stream might still be starting, we'll try to get the index later
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

  // Use the index that was set when the stream was added
  if (stream.index == null) {
    logger.warn('Stream index not available, cannot stop stream', { streamId })
    // Update local state to stopped without sending command
    streamManager.updateOutputStreamStatus(streamId, 'stopped')
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
    return
  }

  // Build AMCP command
  const amcpCommand = AMCP.removeStream(stream.channel, stream.index)

  try {
    // Send command to CasparCG
    await bridge.commands.executeCommand('caspar.sendString', stream.serverId, amcpCommand)

    // Update status
    streamManager.updateOutputStreamStatus(streamId, 'stopped')

    // Update state
    const currentStreams = await bridge.state.get(paths.STATE_STREAMS_PATH) || { inputs: [], outputs: [] }
    const updatedOutputs = (currentStreams.outputs || []).map(s => {
      if (s.id === streamId) {
        return { ...s, status: 'stopped', streamIndex: null, lastError: null }
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

module.exports = {
  addOutputStream,
  removeOutputStream,
  reloadOutputStream,
  startOutputStream,
  stopOutputStream
}
