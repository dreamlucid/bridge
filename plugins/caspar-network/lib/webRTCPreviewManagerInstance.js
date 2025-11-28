// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const WebRTCPreviewManager = require('./WebRTCPreviewManager')

// Create singleton WebRTC preview manager instance
const webRTCPreviewManager = new WebRTCPreviewManager()

module.exports = webRTCPreviewManager
