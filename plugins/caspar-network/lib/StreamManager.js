// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const uuid = require('uuid')

/**
   * @typedef {{
   *   id: String,
   *   serverId: String,
   *   channel: Number,
   *   layer: Number,
   *   srtUrl: String,
   *   loop: Boolean,
   *   status: 'active' | 'stopped' | 'error',
   *   createdAt: Number,
   *   lastError: String | null,
   *   previewStreamId: String | null,  // ID of the preview output stream
   *   previewStreamIndex: Number | null  // Stream index of the preview output stream
   * }} InputStream

 * @typedef {{
 *   id: String,
 *   serverId: String,
 *   channel: Number,
 *   streamIndex: Number | null,
 *   srtUrl: String,
 *   encodingOptions: Object,
 *   status: 'active' | 'stopped' | 'error',
 *   createdAt: Number,
 *   lastError: String | null
 * }} OutputStream
 */

/**
 * Manages the lifecycle and state of SRT streams
 */
class StreamManager {
  constructor () {
    /**
     * @type { Map.<String, InputStream> }
     */
    this.inputStreams = new Map()

    /**
     * @type { Map.<String, OutputStream> }
     */
    this.outputStreams = new Map()
  }

  /**
   * Add an input stream
   * @param { String } serverId - CasparCG server ID
   * @param { Number } channel - Channel number
   * @param { Number } layer - Layer number
   * @param { String } srtUrl - SRT URL
   * @param { Boolean } loop - Loop flag
   * @returns { String } Stream ID
   */
  addInputStream (serverId, channel, layer, srtUrl, loop = false) {
    const id = uuid.v4()
    const stream = {
      id,
      serverId,
      channel,
      layer,
      srtUrl,
      loop,
      status: 'stopped',
      createdAt: Date.now(),
      lastError: null,
      previewStreamId: null,
      previewStreamIndex: null
    }

    this.inputStreams.set(id, stream)
    return id
  }

  /**
   * Set preview stream info for an input stream
   * @param { String } streamId - Stream ID
   * @param { String } previewStreamId - Preview output stream ID
   * @param { Number } previewStreamIndex - Preview output stream index
   */
  setInputStreamPreviewStream (streamId, previewStreamId, previewStreamIndex) {
    const stream = this.inputStreams.get(streamId)
    if (stream) {
      stream.previewStreamId = previewStreamId
      stream.previewStreamIndex = previewStreamIndex
    }
  }

  /**
   * Remove an input stream
   * @param { String } streamId - Stream ID
   * @returns { Boolean } True if stream was found and removed
   */
  removeInputStream (streamId) {
    return this.inputStreams.delete(streamId)
  }

  /**
   * Get an input stream by ID
   * @param { String } streamId - Stream ID
   * @returns { InputStream | undefined }
   */
  getInputStream (streamId) {
    return this.inputStreams.get(streamId)
  }

  /**
   * Get all input streams
   * @returns { InputStream[] }
   */
  getAllInputStreams () {
    return Array.from(this.inputStreams.values())
  }

  /**
   * Update input stream status
   * @param { String } streamId - Stream ID
   * @param { 'active' | 'stopped' | 'error' } status - New status
   * @param { String | null } error - Error message if status is 'error'
   */
  updateInputStreamStatus (streamId, status, error = null) {
    const stream = this.inputStreams.get(streamId)
    if (stream) {
      stream.status = status
      if (error) {
        stream.lastError = error
      } else if (status !== 'error') {
        stream.lastError = null
      }
    }
  }

  /**
   * Add an output stream
   * @param { String } serverId - CasparCG server ID
   * @param { Number } channel - Channel number
   * @param { String } srtUrl - SRT listener URL
   * @param { Object } encodingOptions - Encoding parameters
   * @returns { String } Stream ID
   */
  addOutputStream (serverId, channel, srtUrl, encodingOptions = {}) {
    const id = uuid.v4()
    const stream = {
      id,
      serverId,
      channel,
      streamIndex: null, // Will be set after ADD command succeeds
      srtUrl,
      encodingOptions,
      status: 'stopped',
      createdAt: Date.now(),
      lastError: null
    }

    this.outputStreams.set(id, stream)
    return id
  }

  /**
   * Remove an output stream
   * @param { String } streamId - Stream ID
   * @returns { Boolean } True if stream was found and removed
   */
  removeOutputStream (streamId) {
    return this.outputStreams.delete(streamId)
  }

  /**
   * Get an output stream by ID
   * @param { String } streamId - Stream ID
   * @returns { OutputStream | undefined }
   */
  getOutputStream (streamId) {
    return this.outputStreams.get(streamId)
  }

  /**
   * Get all output streams
   * @returns { OutputStream[] }
   */
  getAllOutputStreams () {
    return Array.from(this.outputStreams.values())
  }

  /**
   * Update output stream status
   * @param { String } streamId - Stream ID
   * @param { 'active' | 'stopped' | 'error' } status - New status
   * @param { String | null } error - Error message if status is 'error'
   */
  updateOutputStreamStatus (streamId, status, error = null) {
    const stream = this.outputStreams.get(streamId)
    if (stream) {
      stream.status = status
      if (error) {
        stream.lastError = error
      } else if (status !== 'error') {
        stream.lastError = null
      }
    }
  }

  /**
   * Set the stream index for an output stream
   * (returned by CasparCG after ADD command)
   * @param { String } streamId - Stream ID
   * @param { Number } streamIndex - Stream index from CasparCG
   */
  setOutputStreamIndex (streamId, streamIndex) {
    const stream = this.outputStreams.get(streamId)
    if (stream) {
      stream.streamIndex = streamIndex
    }
  }

  /**
   * Get all streams (inputs and outputs)
   * @returns { { inputs: InputStream[], outputs: OutputStream[] } }
   */
  getAllStreams () {
    return {
      inputs: this.getAllInputStreams(),
      outputs: this.getAllOutputStreams()
    }
  }
}

module.exports = StreamManager
