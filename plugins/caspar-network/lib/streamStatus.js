// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const streamManager = require('./streamManagerInstance')
const { syncStreamManagerWithState, getStreamConfig } = require('./streamHelpers')

/**
 * List all active streams
 * @returns { Promise<Object> } Object with inputs and outputs arrays
 */
async function listStreams () {
  await syncStreamManagerWithState()
  return streamManager.getAllStreams()
}

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

module.exports = {
  listStreams,
  getStreamStatus,
  refreshStreamStatus
}

