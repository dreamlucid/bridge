// SPDX-FileCopyrightText: 2022 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const path = require('path')

const electron = require('electron')

const platform = require('./platform')

/**
 * The base path for
 * application data,
 *
 * this includes but is
 * not limited to plugins
 * and settings
 *
 * @type { String }
 */
const appData = (function () {
  // Use environment variable if provided
  if (process.env.APP_DATA_BASE_PATH) {
    return path.join(__dirname, process.env.APP_DATA_BASE_PATH)
  }

  // Use Electron's userData path if running in Electron
  if (platform.isElectron()) {
    return electron.app.getPath('userData')
  }

  // Default fallback path for Node.js (non-Electron) environments
  // This defaults to ../data relative to lib/ directory (project root/data)
  return path.join(__dirname, '../data')
})()

exports.appData = appData

/**
 * The base path for plugins
 * @type { String }
 */
const plugins = path.join(appData, '/plugins')
exports.plugins = plugins

/**
 * The base path for
 * internal plugins
 * @type { String }
 */
const internalPlugins = path.join(__dirname, '../plugins')
exports.internalPlugins = internalPlugins

/**
 * The base path for temporary files
 * that will be removed when the
 * application cleans its state
 * @type { String }
 */
const temp = path.join(appData, '/temp')
exports.temp = temp

/**
 * The user defaults file for storing
 * user specific settings
 * @type { String }
 */
const userDefaults = path.join(appData, '/UserDefaults.json')
exports.userDefaults = userDefaults
