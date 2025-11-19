// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const manifest = require('../package.json')

exports.STATE_STREAMS_PATH = `plugins.${manifest.name}.streams`
exports.STATE_SETTINGS_PATH = `plugins.${manifest.name}.settings`

// FFmpeg paths
// Use system FFmpeg (/usr/bin/ffmpeg) for general operations
// Use WebRTC-enabled FFmpeg (/usr/local/bin/ffmpeg) for WebRTC operations
exports.FFMPEG_PATH = 'ffmpeg' // Default: uses system FFmpeg via alias
exports.FFMPEG_WEBRTC_PATH = '/usr/local/bin/ffmpeg' // WebRTC-enabled build
