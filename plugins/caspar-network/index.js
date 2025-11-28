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
const WebRTCSignalingServer = require('./lib/WebRTCSignalingServer')
const signalingRegistry = require('./lib/WebRTCSignalingRegistry')
const fileBasedRegistry = require('./lib/FileBasedRegistry')

// Import commands to register them
require('./lib/commands')

// Create singleton stream monitor
const streamMonitor = new StreamMonitor()

// Create singleton stream proxy (HLS - kept for backward compatibility)
const streamProxy = new StreamProxy()

// Create WebRTC signaling server
const webRTCSignalingServer = new WebRTCSignalingServer()

// Register signaling server in registry so server.js can access it
// Uses process object which is shared across worker threads
signalingRegistry.setSignalingServer(webRTCSignalingServer)

// Export for use in commands
exports.streamMonitor = streamMonitor
exports.streamProxy = streamProxy
exports.webRTCSignalingServer = webRTCSignalingServer

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
            codec: 'h264_vaapi', // Default to VAAPI (available in custom FFmpeg build)
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

  // Initialize WebRTC signaling server
  // The server upgrade handler in lib/server.js will handle WebSocket upgrades
  // We need to initialize the WebSocket server here
  try {
    // Initialize the WebSocket server (noServer: true means we handle upgrades manually)
    // The actual server instance will be accessed via the upgrade handler in server.js
    webRTCSignalingServer.initialize()

    // Re-register the signaling server after initialization to ensure wss is set
    // This ensures the server.js can access the fully initialized server with wss
    signalingRegistry.setSignalingServer(webRTCSignalingServer)
    // Also register in file-based registry for cross-thread access
    fileBasedRegistry.setSignalingServer(webRTCSignalingServer)

    logger.debug('WebRTC signaling server initialized and registered', {
      hasServer: !!webRTCSignalingServer,
      hasWss: !!webRTCSignalingServer.wss
    })
  } catch (err) {
    logger.warn('Could not initialize WebRTC signaling server', { error: err.message })
  }

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
