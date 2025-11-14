// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

/**
 * @type { import('../../api').Api }
 */
const bridge = require('bridge')

const manifest = require('./package.json')
const paths = require('./lib/paths')

const Logger = require('../../lib/Logger')
const logger = new Logger({ name: 'CasparNetworkPlugin' })

const StreamMonitor = require('./lib/StreamMonitor')
const StreamProxy = require('./lib/StreamProxy')

// Import commands to register them
require('./lib/commands')

// Create singleton stream monitor
const streamMonitor = new StreamMonitor()

// Create singleton stream proxy
const streamProxy = new StreamProxy()

// Export for use in commands
exports.streamMonitor = streamMonitor
exports.streamProxy = streamProxy

/**
 * Initialize default settings if not set
 */
async function initSettings () {
  const settings = await bridge.state.get(paths.STATE_SETTINGS_PATH)
  if (settings !== undefined) {
    return
  }

  bridge.state.apply({
    plugins: {
      [manifest.name]: {
        settings: {
          defaultEncodingOptions: {
            format: 'mpegts',
            codec: 'h264_nvenc',
            preset: 'p4',
            tune: 'll',
            bitrate: '6000k',
            maxrate: '6000k',
            bufsize: '12000k',
            gop: 50,
            keyintMin: 50,
            audio: false
          },
          previewEnabled: true,
          previewQuality: 'medium'
        }
      }
    }
  })
}

/**
 * Initialize default streams state if not set
 */
async function initStreams () {
  const streams = await bridge.state.get(paths.STATE_STREAMS_PATH)
  if (streams !== undefined) {
    return
  }

  bridge.state.apply({
    plugins: {
      [manifest.name]: {
        streams: {
          inputs: [],
          outputs: []
        }
      }
    }
  })
}

/**
 * Initialize widget HTML
 */
async function initWidget () {
  const assets = require('../../assets.json')
  const cssPath = `${assets.hash}.${manifest.name}.bundle.css`
  const jsPath = `${assets.hash}.${manifest.name}.bundle.js`

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Caspar Network</title>
        <base href="/" />
        <link rel="stylesheet" href="${bridge.server.uris.STYLE_RESET}" />
        <link rel="stylesheet" href="${cssPath}" />
        <script src="${jsPath}" defer></script>
        <script>
          window.PLUGIN = ${JSON.stringify(
            {
              name: manifest.name
            }
          )}
        </script>
      </head>
      <body>
        <div id="root"></div>
      </body>
    </html>
  `
  return await bridge.server.serveString(html)
}

/**
 * Activate the plugin and bootstrap its contributions
 */
exports.activate = async () => {
  logger.debug('Activating caspar-network plugin')

  const htmlPath = await initWidget()

  // Initialize default settings and streams
  await initSettings()
  await initStreams()

  // Start stream monitoring
  streamMonitor.start()

  // Register widgets
  bridge.widgets.registerWidget({
    id: 'bridge.plugins.caspar-network.inputs',
    name: 'SRT Input Streams',
    uri: `${htmlPath}?path=inputs`,
    description: 'Manage SRT input streams',
    supportsFloat: true
  })

  bridge.widgets.registerWidget({
    id: 'bridge.plugins.caspar-network.outputs',
    name: 'SRT Output Streams',
    uri: `${htmlPath}?path=outputs`,
    description: 'Manage SRT output streams',
    supportsFloat: true
  })

  bridge.widgets.registerWidget({
    id: 'bridge.plugins.caspar-network.preview',
    name: 'Stream Preview',
    uri: `${htmlPath}?path=preview`,
    description: 'Preview active SRT streams',
    supportsFloat: true
  })

  logger.debug('Caspar-network plugin activated')
}
