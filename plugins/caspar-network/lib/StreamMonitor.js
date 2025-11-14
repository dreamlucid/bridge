// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const bridge = require('bridge')
const manifest = require('../package.json')
const paths = require('./paths')
const AMCP = require('./AMCP')

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

      // If we get a response, the stream is likely active
      // If there's an error, mark as error
      if (response && response.code === 200) {
        // Stream appears to be active
        // Could parse response to get more details
      } else {
        // Stream might have stopped
        await this.handleStreamError(stream.id, 'input', 'Stream check failed')
      }
    } catch (err) {
      // Connection error or stream stopped
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

      if (response && (response.code === 200 || response.code === 201)) {
        // Stream appears to be active
        // Update status if it was in error state
        if (stream.status === 'error') {
          await this.updateStreamStatus(stream.id, 'output', 'active', null)
        }
      } else {
        await this.handleStreamError(stream.id, 'output', 'Stream check failed - no response from server')
      }
    } catch (err) {
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
