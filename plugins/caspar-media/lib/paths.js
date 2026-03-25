// SPDX-FileCopyrightText: 2025
//
// SPDX-License-Identifier: MIT

const manifest = require('../package.json')

exports.PLUGIN_STATE_KEY = manifest.name
exports.STATE_SETTINGS_PATH = `plugins.${manifest.name}.settings`
