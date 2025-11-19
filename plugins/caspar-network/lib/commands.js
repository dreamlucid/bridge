// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

/**
 * @type { import('../../api').Api }
 */
const bridge = require('bridge')

// Create singleton stream manager instance (exported for use in other modules)
const streamManager = require('./streamManagerInstance')

// Import command modules
const inputStreams = require('./commands/inputStreams')
const outputStreams = require('./commands/outputStreams')
const streamStatus = require('./streamStatus')
const preview = require('./commands/preview')

// Register input stream commands
bridge.commands.registerCommand('caspar-network.addInputStream', inputStreams.addInputStream)
bridge.commands.registerCommand('caspar-network.removeInputStream', inputStreams.removeInputStream)
bridge.commands.registerCommand('caspar-network.startInputStream', inputStreams.startInputStream)
bridge.commands.registerCommand('caspar-network.stopInputStream', inputStreams.stopInputStream)

// Register output stream commands
bridge.commands.registerCommand('caspar-network.addOutputStream', outputStreams.addOutputStream)
bridge.commands.registerCommand('caspar-network.removeOutputStream', outputStreams.removeOutputStream)
bridge.commands.registerCommand('caspar-network.startOutputStream', outputStreams.startOutputStream)
bridge.commands.registerCommand('caspar-network.stopOutputStream', outputStreams.stopOutputStream)

// Register stream status commands
bridge.commands.registerCommand('caspar-network.listStreams', streamStatus.listStreams)
bridge.commands.registerCommand('caspar-network.getStreamStatus', streamStatus.getStreamStatus)
bridge.commands.registerCommand('caspar-network.refreshStreamStatus', streamStatus.refreshStreamStatus)

// Register preview commands
bridge.commands.registerCommand('caspar-network.startPreview', preview.startPreview)
bridge.commands.registerCommand('caspar-network.stopPreview', preview.stopPreview)
bridge.commands.registerCommand('caspar-network.getPreviewUrl', preview.getPreviewUrl)

// Export stream manager for use in other modules
exports.streamManager = streamManager

// Export all commands for backward compatibility (if needed)
exports.addInputStream = inputStreams.addInputStream
exports.removeInputStream = inputStreams.removeInputStream
exports.startInputStream = inputStreams.startInputStream
exports.stopInputStream = inputStreams.stopInputStream

exports.addOutputStream = outputStreams.addOutputStream
exports.removeOutputStream = outputStreams.removeOutputStream
exports.startOutputStream = outputStreams.startOutputStream
exports.stopOutputStream = outputStreams.stopOutputStream

exports.listStreams = streamStatus.listStreams
exports.getStreamStatus = streamStatus.getStreamStatus
exports.refreshStreamStatus = streamStatus.refreshStreamStatus

exports.startPreview = preview.startPreview
exports.stopPreview = preview.stopPreview
exports.getPreviewUrl = preview.getPreviewUrl
