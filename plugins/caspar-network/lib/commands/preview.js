// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT
/**
 * Start WebRTC proxy for a stream preview (low-latency real-time preview)
 * @param { String } streamId - Stream ID
 * @returns { Promise<String> } WebRTC signaling URL
 */
async function startPreview (streamId) {
  // TODO: Implement
}

/**
 * Stop WebRTC proxy for a stream preview
 * @param { String } streamId - Stream ID
 * @returns { Promise<void> }
 */
async function stopPreview (streamId) {
  // TODO: Implement
}

/**
 * Get preview URL for a stream
 * @param { String } streamId - Stream ID
 * @returns { Promise<String|null> } WebRTC signaling URL or null
 */
async function getPreviewUrl (streamId) {
  // TODO: Implement
}

module.exports = {
  startPreview,
  stopPreview,
  getPreviewUrl
}
