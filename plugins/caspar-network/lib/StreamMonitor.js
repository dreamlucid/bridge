// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const bridge = require('bridge')
const manifest = require('../package.json')
const paths = require('./paths')
const AMCP = require('./AMCP')
const { extractStreamIndexFromInfo } = require('./streamHelpers')

const Logger = require('../../../lib/Logger')
const logger = new Logger({ name: 'CasparNetworkPlugin' })

/**
 * Monitor stream status by polling CasparCG servers
 */
class StreamMonitor {
  constructor () {
    this.intervals = new Map()
    this.isMonitoring = false
    this.pollInterval = 5000 // 5 seconds
  }

  /**
   * Check if monitoring is currently running
   * @returns {Boolean}
   */
  isRunning () {
    return this.isMonitoring
  }

  /**
   * Start monitoring all active streams
   */
  start () {
    if (this.isMonitoring) {
      return
    }

    this.isMonitoring = true
    logger.debug('Starting stream monitoring')

    // Poll every interval
    const intervalId = setInterval(() => {
      this.checkAllStreams()
    }, this.pollInterval)

    this.intervals.set('main', intervalId)
  }

  /**
   * Stop monitoring
   */
  stop () {
    if (!this.isMonitoring) {
      return
    }

    this.isMonitoring = false
    logger.debug('Stopping stream monitoring')

    for (const intervalId of this.intervals.values()) {
      clearInterval(intervalId)
    }
    this.intervals.clear()
  }

  /**
   * Check status of all streams
   */
  async checkAllStreams () {
    try {
      const streams = await bridge.state.get(paths.STATE_STREAMS_PATH) || { inputs: [], outputs: [] }

      // Check input streams
      for (const stream of (streams.inputs || [])) {
        if (stream.status === 'active') {
          await this.checkInputStream(stream)
        }
      }

      // Check output streams
      for (const stream of (streams.outputs || [])) {
        if (stream.status === 'active') {
          await this.checkOutputStream(stream)
        }
      }
    } catch (err) {
      logger.warn('Error checking streams:', err)
    }
  }

  /**
   * Check status of an input stream
   * @param { Object } stream - Stream configuration
   */
  async checkInputStream (stream) {
    try {
      // Query CasparCG for layer info
      const infoCommand = AMCP.info({ channel: stream.channel, layer: stream.layer })
      const response = await bridge.commands.executeCommand('caspar.sendString', stream.serverId, infoCommand)

      // logger.debug('Stream check response', { streamId: stream.id, response })

      // Check if response is valid - code can be string or number, accept 200 and 201 as success
      const responseCode = typeof response?.code === 'string' ? parseInt(response.code, 10) : response?.code
      const isValidResponse = response && (responseCode === 200 || responseCode === 201)

      if (isValidResponse) {
        // Parse response data to check if layer is actually playing
        // Response data can be an array of strings or a single string
        let responseData = ''
        if (Array.isArray(response.data)) {
          responseData = response.data.join('\n')
        } else if (response.data) {
          responseData = response.data.toString()
        }

        // logger.debug('Stream check response data', { streamId: stream.id, responseData })

        // Check if the layer is in a playing state
        // CasparCG INFO response typically includes layer status
        // If the layer is not playing or shows an error, mark as error
        const upperData = responseData.toUpperCase()
        if (upperData.includes('STOPPED') || upperData.includes('ERROR') || upperData.includes('FAILED')) {
          await this.handleStreamError(stream.id, 'input', 'Layer is stopped or has an error')
        } else if (upperData.includes('PLAYING') || upperData.includes('PAUSED') || upperData.includes('SRT') || responseData.length > 0) {
          // Layer is playing or has content, which is good
          // SRT streams might not explicitly say "PLAYING" but if we get valid data, it's likely active
          // If it was in error state, clear it
          const streams = await bridge.state.get(paths.STATE_STREAMS_PATH) || { inputs: [], outputs: [] }
          const inputStream = streams.inputs?.find(s => s.id === stream.id)
          if (inputStream && inputStream.status === 'error') {
            await this.updateStreamStatus(stream.id, 'input', 'active', null)
          }
        } else {
          // Got a valid response but couldn't determine state - log for debugging
          logger.debug('Stream check: valid response but unclear state', { streamId: stream.id, responseData })
        }
      } else {
        // Invalid response - log details for debugging
        logger.warn('Stream check failed - invalid response', {
          streamId: stream.id,
          responseCode: response?.code,
          responseType: typeof response?.code,
          hasResponse: !!response
        })
        await this.handleStreamError(stream.id, 'input', `Stream check failed - invalid response from CasparCG (code: ${response?.code || 'none'})`)
      }
    } catch (err) {
      // Connection error or stream stopped
      logger.warn('Stream check exception', { streamId: stream.id, error: err.message, stack: err.stack })
      await this.handleStreamError(stream.id, 'input', err.message || 'Stream check failed')
    }
  }

  /**
   * Check status of an output stream
   * @param { Object } stream - Stream configuration
   */
  async checkOutputStream (stream) {
    try {
      // Query CasparCG for channel info to see if stream is still active
      const infoCommand = AMCP.info({ channel: stream.channel })
      const response = await bridge.commands.executeCommand('caspar.sendString', stream.serverId, infoCommand)

      // logger.debug('Output stream check response', { streamId: stream.id, response })

      // Check if response is valid - code can be string or number, accept 200 and 201 as success
      const responseCode = typeof response?.code === 'string' ? parseInt(response.code, 10) : response?.code
      const isValidResponse = response && (responseCode === 200 || responseCode === 201)

      if (isValidResponse) {
        // Parse response data to check if stream is actually active
        // Response data can be an array of strings or a single string
        let responseData = ''
        if (Array.isArray(response.data)) {
          responseData = response.data.join('\n')
        } else if (response.data) {
          responseData = response.data.toString()
        }

        // logger.debug('Output stream check response data', { streamId: stream.id, responseData })

        // Check if the stream is active in the response
        // CasparCG INFO response includes stream information
        const upperData = responseData.toUpperCase()

        // If we have a stream index, check if it's mentioned in the response
        if (stream.streamIndex != null) {
          // First, try to extract stream index using the proper extraction function
          // This handles XML responses with port_500, index="500", etc.
          const foundStreamIndex = extractStreamIndexFromInfo(response.data, stream.srtUrl)

          // Also check if the stream index appears in the response in various formats
          // This handles cases where URL matching might be too strict
          const streamIndexStr = stream.streamIndex.toString()
          const streamIndexPatterns = [
            // XML port format: port_500, port-500, port500
            new RegExp(`port[_-]?${streamIndexStr}`, 'i'),
            // XML attribute format: index="500" or index='500'
            new RegExp(`index\\s*=\\s*["']?${streamIndexStr}["']?`, 'i'),
            // Text format: STREAM 500, STREAM: 500, STREAM 500:
            new RegExp(`STREAM[\\s:]+${streamIndexStr}`, 'i'),
            // Direct number match (with word boundaries to avoid partial matches)
            new RegExp(`\\b${streamIndexStr}\\b`)
          ]

          const streamIndexFound = foundStreamIndex === stream.streamIndex ||
            streamIndexPatterns.some(pattern => pattern.test(responseData))

          if (streamIndexFound) {
            // Stream is found in response, it's active
            // If it was in error state, clear it
            const streams = await bridge.state.get(paths.STATE_STREAMS_PATH) || { inputs: [], outputs: [] }
            const outputStream = streams.outputs?.find(s => s.id === stream.id)
            if (outputStream && outputStream.status === 'error') {
              await this.updateStreamStatus(stream.id, 'output', 'active', null)
            }
          } else if (upperData.includes('ERROR') || upperData.includes('FAILED')) {
            // Stream has an error
            await this.handleStreamError(stream.id, 'output', 'Stream has an error in CasparCG response')
          } else {
            // Stream index not found but response is valid - might be stopped
            // Log with more details for debugging
            logger.debug('Output stream check: stream index not found in response', {
              streamId: stream.id,
              streamIndex: stream.streamIndex,
              foundStreamIndex,
              responseData: responseData.substring(0, 500) // Log first 500 chars for debugging
            })
          }
        } else {
          // No stream index yet, but we got a valid response
          // If response contains stream-related info, consider it potentially active
          if (upperData.includes('STREAM') || responseData.length > 0) {
            // Valid response with stream info
            const streams = await bridge.state.get(paths.STATE_STREAMS_PATH) || { inputs: [], outputs: [] }
            const outputStream = streams.outputs?.find(s => s.id === stream.id)
            if (outputStream && outputStream.status === 'error') {
              await this.updateStreamStatus(stream.id, 'output', 'active', null)
            }
          }
        }
      } else {
        // Invalid response - log details for debugging
        logger.warn('Output stream check failed - invalid response', {
          streamId: stream.id,
          responseCode: response?.code,
          responseType: typeof response?.code,
          hasResponse: !!response
        })
        // Only mark as error if it was previously active
        if (stream.status === 'active') {
          await this.handleStreamError(stream.id, 'output', `Stream check failed - invalid response from CasparCG (code: ${response?.code || 'none'})`)
        }
      }
    } catch (err) {
      // Connection error or stream stopped
      logger.warn('Output stream check exception', { streamId: stream.id, error: err.message, stack: err.stack })
      // Only mark as error if it was previously active
      if (stream.status === 'active') {
        await this.handleStreamError(stream.id, 'output', err.message || 'Stream check failed')
      }
    }
  }

  /**
   * Update stream status
   * @param { String } streamId - Stream ID
   * @param { String } type - 'input' or 'output'
   * @param { String } status - New status
   * @param { String | null } errorMsg - Error message if status is 'error'
   */
  async updateStreamStatus (streamId, type, status, errorMsg) {
    const streams = await bridge.state.get(paths.STATE_STREAMS_PATH) || { inputs: [], outputs: [] }
    const streamArray = type === 'input' ? streams.inputs : streams.outputs

    const updatedArray = streamArray.map(s => {
      if (s.id === streamId) {
        return {
          ...s,
          status,
          lastError: errorMsg || (status !== 'error' ? null : s.lastError)
        }
      }
      return s
    })

    bridge.state.apply({
      plugins: {
        [manifest.name]: {
          streams: {
            [type === 'input' ? 'inputs' : 'outputs']: { $replace: updatedArray }
          }
        }
      }
    })
  }

  /**
   * Handle stream error by updating status
   * @param { String } streamId - Stream ID
   * @param { String } type - 'input' or 'output'
   * @param { String } errorMsg - Error message
   */
  async handleStreamError (streamId, type, errorMsg) {
    const streams = await bridge.state.get(paths.STATE_STREAMS_PATH) || { inputs: [], outputs: [] }
    const streamArray = type === 'input' ? streams.inputs : streams.outputs
    const stream = streamArray?.find(s => s.id === streamId)

    if (!stream || stream.status !== 'active') {
      return
    }

    await this.updateStreamStatus(streamId, type, 'error', errorMsg)
    logger.warn(`Stream ${streamId} error:`, errorMsg)
  }

  /**
   * Refresh status of a specific stream
   * @param { String } streamId - Stream ID
   * @returns { Promise<Object> } Updated stream status
   */
  async refreshStreamStatus (streamId) {
    const streams = await bridge.state.get(paths.STATE_STREAMS_PATH) || { inputs: [], outputs: [] }

    const inputStream = streams.inputs?.find(s => s.id === streamId)
    if (inputStream) {
      await this.checkInputStream(inputStream)
      // Get updated stream from state
      const updatedStreams = await bridge.state.get(paths.STATE_STREAMS_PATH) || { inputs: [], outputs: [] }
      const updated = updatedStreams.inputs?.find(s => s.id === streamId)
      return { type: 'input', ...updated }
    }

    const outputStream = streams.outputs?.find(s => s.id === streamId)
    if (outputStream) {
      await this.checkOutputStream(outputStream)
      // Get updated stream from state
      const updatedStreams = await bridge.state.get(paths.STATE_STREAMS_PATH) || { inputs: [], outputs: [] }
      const updated = updatedStreams.outputs?.find(s => s.id === streamId)
      return { type: 'output', ...updated }
    }

    throw new Error('Stream not found')
  }
}

module.exports = StreamMonitor
