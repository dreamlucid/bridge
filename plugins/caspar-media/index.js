// SPDX-FileCopyrightText: 2025
//
// SPDX-License-Identifier: MIT

/**
 * @type { import('../../api').Api }
 */
const bridge = require('bridge')

const paths = require('./lib/paths')
const assets = require('../../assets.json')
const manifest = require('./package.json')

const Logger = require('../../lib/Logger')
const logger = new Logger({ name: 'CasparMediaPlugin' })

require('./lib/commands')

const LEGACY_PLUGIN_KEY = 'bridge-plugin-media-upload'
const LEGACY_SETTINGS_PATH = `plugins.${LEGACY_PLUGIN_KEY}.settings`

async function migrateLegacyPluginState () {
  if (await bridge.state.get(paths.STATE_SETTINGS_PATH) !== undefined) {
    return
  }
  const legacy = await bridge.state.get(LEGACY_SETTINGS_PATH)
  if (legacy === undefined) {
    return
  }
  logger.debug('Migrating settings from', LEGACY_PLUGIN_KEY, 'to', paths.PLUGIN_STATE_KEY)
  bridge.state.apply({
    plugins: {
      [paths.PLUGIN_STATE_KEY]: {
        settings: { $replace: legacy }
      },
      [LEGACY_PLUGIN_KEY]: { $delete: true }
    }
  })
}

async function initWidget () {
  const cssPath = `${assets.hash}.${manifest.name}.bundle.css`
  const jsPath = `${assets.hash}.${manifest.name}.bundle.js`

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Caspar media</title>
        <base href="/" />
        <link rel="stylesheet" href="${bridge.server.uris.STYLE_RESET}" />
        <link rel="stylesheet" href="${cssPath}" />
        <script src="${jsPath}" defer></script>
        <script>
          window.PLUGIN = ${JSON.stringify({ name: manifest.name })}
        </script>
      </head>
      <body>
        <div id="root"></div>
      </body>
    </html>
  `
  return await bridge.server.serveString(html)
}

async function initSettings () {
  if (await bridge.state.get(paths.STATE_SETTINGS_PATH) !== undefined) {
    return
  }
  bridge.state.apply({
    plugins: {
      [paths.PLUGIN_STATE_KEY]: {
        settings: {
          $replace: {
            casparConfigPath: '',
            resolvedRoots: null,
            parseError: null,
            lastParsedAt: null
          }
        }
      }
    }
  })
}

exports.activate = async () => {
  logger.debug('Activating caspar-media plugin')
  const htmlPath = await initWidget()
  await migrateLegacyPluginState()
  await initSettings()

  bridge.settings.registerSetting({
    title: 'Caspar media',
    group: 'Caspar CG',
    description: 'Path to casparcg.config for library upload targets (media / template / font)',
    inputs: [
      { type: 'frame', uri: `${htmlPath}?path=settings/config` }
    ]
  })

  bridge.widgets.registerWidget({
    id: 'bridge.plugins.caspar-media.library',
    name: 'Caspar media library',
    uri: `${htmlPath}?path=library`,
    description: 'Media and template library for Caspar CG (extended)',
    supportsFloat: true
  })

  bridge.widgets.registerWidget({
    id: 'bridge.plugins.caspar-media.upload',
    name: 'Caspar media upload',
    uri: `${htmlPath}?path=upload`,
    description: 'Upload files into CasparCG media library paths',
    supportsFloat: true
  })
}
