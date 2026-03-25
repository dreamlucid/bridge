// SPDX-FileCopyrightText: 2025
//
// SPDX-License-Identifier: MIT

/**
 * @type { import('../../../api').Api }
 */
const bridge = require('bridge')

const paths = require('./paths')
const { parseCasparPaths } = require('./parseCasparPaths')

const Logger = require('../../../lib/Logger')
const logger = new Logger({ name: 'CasparMediaPlugin' })

/**
 * @param {{ casparConfigPath: string }} opts
 */
async function saveSettings (opts) {
  const casparConfigPath = (opts && opts.casparConfigPath) ? String(opts.casparConfigPath).trim() : ''
  if (!casparConfigPath) {
    throw new Error('casparConfigPath is required')
  }

  try {
    const { resolvedRoots, absConfigPath } = await parseCasparPaths(casparConfigPath)
    bridge.state.apply({
      plugins: {
        [paths.PLUGIN_STATE_KEY]: {
          /*
          Use $replace so null fields (e.g. parseError) do not go through
          deep merge — typeof null === "object" breaks mergeDeep upstream.
          */
          settings: {
            $replace: {
              casparConfigPath: absConfigPath,
              resolvedRoots,
              parseError: null,
              lastParsedAt: Date.now()
            }
          }
        }
      }
    })
    return { resolvedRoots, casparConfigPath: absConfigPath }
  } catch (err) {
    logger.warn('Failed to parse casparcg.config', err)
    bridge.state.apply({
      plugins: {
        [paths.PLUGIN_STATE_KEY]: {
          settings: {
            $replace: {
              casparConfigPath,
              resolvedRoots: null,
              parseError: err.message || String(err),
              lastParsedAt: null
            }
          }
        }
      }
    })
    throw err
  }
}

async function refreshPaths () {
  const current = await bridge.state.get(paths.STATE_SETTINGS_PATH) || {}
  const casparConfigPath = current.casparConfigPath
  if (!casparConfigPath) {
    throw new Error('No casparConfigPath in settings; save settings first')
  }
  return saveSettings({ casparConfigPath })
}

bridge.commands.registerCommand('casparMedia.saveSettings', saveSettings)
bridge.commands.registerCommand('casparMedia.refreshPaths', refreshPaths)
