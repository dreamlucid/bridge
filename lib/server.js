// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const url = require('node:url')
const path = require('node:path')

const express = require('express')

const UserDefaults = require('./UserDefaults')
const WorkspaceRegistry = require('./WorkspaceRegistry')

const HttpError = require('./error/HttpError')

const template = require('../app/template')

const network = require('./network')
const platform = require('./platform')
const apiRoutes = require('./routes')
const config = require('./config')

const assets = require('../assets.json')
const pkg = require('../package.json')

const random = require('./security/random')

const Logger = require('./Logger')
const logger = new Logger({ name: 'server' })

const WebSocket = require('ws')

// Create WebRTC signaling WebSocket server in main thread
// This allows server.js to handle upgrades directly
// The plugin will register message handlers with this server
const webrtcSignalingWss = new WebSocket.Server({
  noServer: true,
  perMessageDeflate: false
})

// Store message handlers by streamId
// Format: Map<streamId, (ws, streamId, message) => Promise<void>>
const webrtcMessageHandlers = new Map()

/**
 * Send a message to a WebRTC signaling WebSocket
 * Called by the plugin to send responses to the client
 * @param {string} streamId - Stream ID
 * @param {string} wsId - WebSocket connection ID
 * @param {Object} message - Message to send
 */
function sendWebRTCMessage (streamId, wsId, message) {
  const handler = webrtcMessageHandlers.get(streamId)
  logger.debug('sendWebRTCMessage called', {
    streamId,
    wsId,
    hasHandler: !!handler,
    handlerWsId: handler?.wsId,
    handlerHasWs: !!(handler && handler.ws),
    wsReadyState: handler?.ws?.readyState
  })
  if (handler && handler.ws && handler.wsId === wsId) {
    if (handler.ws.readyState === 1) { // WebSocket.OPEN
      handler.ws.send(JSON.stringify(message))
      logger.debug('WebRTC message sent', { streamId, wsId, messageType: message.type })
    } else {
      logger.warn('WebSocket not open', { streamId, wsId, readyState: handler.ws.readyState })
    }
  } else {
    logger.warn('WebSocket not found for stream', {
      streamId,
      wsId,
      hasHandler: !!handler,
      handlerWsId: handler?.wsId,
      handlerHasWs: !!(handler && handler.ws)
    })
  }
}

// Register command to send WebRTC messages from plugin (worker thread) to main thread.
// This allows the plugin to send responses back to clients.
//
// IMPORTANT: Check the live SCommands registry (hasCommand), not a side Set of workspace
// ids. WorkspaceRegistry.add() can replace a workspace object with a new instance that
// keeps the same id (e.g. defaultworkspace.bridge loaded from init-node and again from
// /workspaces/new). The old instance may have had _internal.sendWebRTCMessage registered
// while the new one does not — a Set keyed only by id would skip re-registration forever
// and break preview after refresh / reconnect (No such command "_internal.sendWebRTCMessage").
function registerWebRTCSendCommand (workspace) {
  if (!workspace?.api?.commands) {
    logger.warn('Cannot register _internal.sendWebRTCMessage: workspace API unavailable', {
      workspaceId: workspace?.id
    })
    return
  }

  if (workspace.api.commands.hasCommand('_internal.sendWebRTCMessage')) {
    return
  }

  try {
    workspace.api.commands.registerCommand('_internal.sendWebRTCMessage', (...args) => {
      // Handle both cases: with and without transaction ID
      // When called from plugin via bridge.commands.executeCommand, it might add transaction
      let streamId, wsId, message
      if (args.length === 3) {
        [streamId, wsId, message] = args
      } else if (args.length === 4) {
        // Transaction ID was prepended
        [, streamId, wsId, message] = args
      } else {
        logger.error('Invalid arguments to _internal.sendWebRTCMessage', { args })
        return
      }
      sendWebRTCMessage(streamId, wsId, message)
    })
    logger.debug('Registered _internal.sendWebRTCMessage command for workspace', { workspaceId: workspace.id })
  } catch (err) {
    logger.warn('Could not register _internal.sendWebRTCMessage command', {
      workspaceId: workspace.id,
      error: err.message,
      stack: err.stack
    })
  }
}

// Export for use by plugins
exports.webrtcSignalingWss = webrtcSignalingWss
exports.sendWebRTCMessage = sendWebRTCMessage
exports.registerWebRTCSendCommand = registerWebRTCSendCommand

/*
These constants depend on the UserDefaults-state and
MUST be declared AFTER initialization as UserDefaults
would otherwise be blank
*/
const HTTP_PORT = UserDefaults.data.httpPort || config.defaults.HTTP_PORT
const HTTP_BIND_ADDR = UserDefaults.data.httpBindToAll ? '0.0.0.0' : 'localhost'

const app = express()

app.disable('x-powered-by')
app.use(express.json())
app.use(express.static(path.join(__dirname, '../public')))
app.use(express.static(path.join(__dirname, '../dist')))

/**
 * A reference to
 * the main http server
 * @type { HttpError.Server }
 */
const server = app.listen(HTTP_PORT, HTTP_BIND_ADDR, () => {
  logger.info('Listening on port', HTTP_PORT)
})

;(function () {
  if (process.env.NODE_ENV === 'development') {
    /*
     Allow any origin to access the API
     if running in development mode
     */
    logger.info('Access-Control-Allow-Origin=*')
    logger.info('Access-Control-Allow-Headers=*')
    logger.info('Access-Control-Allow-Methods=*')
    app.use((req, res, next) => {
      res.set('Access-Control-Allow-Origin', '*')
      res.set('Access-Control-Allow-Headers', '*')
      res.set('Access-Control-Allow-Methods', '*')
      next()
    })
  }
})()

/*
Forward websocket requests
to the socket handler
*/
server.on('upgrade', (req, sock, head) => {
  /*
  Parse the url to get a clean
  pathname and Workspace id
  */
  const _url = new url.URL(req.url, 'http://localhost')

  // Handle WebRTC signaling for caspar-network plugin
  if (_url.pathname === '/api/v1/webrtc') {
    const streamId = _url.searchParams.get('streamId')
    if (!streamId) {
      logger.warn('WebRTC signaling request without streamId')
      sock.end()
      return
    }

    // Get workspace to route messages via commands
    const workspaceId = _url.searchParams.get('workspace')
    const WorkspaceRegistry = require('./WorkspaceRegistry')
    const workspace = workspaceId ? WorkspaceRegistry.getInstance().get(workspaceId) : WorkspaceRegistry.getInstance().list()[0]

    if (!workspace) {
      logger.warn('No workspace found for WebRTC signaling')
      sock.end()
      return
    }

    // Register the send command for this workspace if not already registered
    registerWebRTCSendCommand(workspace)

    // Handle WebSocket upgrade using the main thread's WebSocket server
    webrtcSignalingWss.handleUpgrade(req, sock, head, (ws) => {
      // Store WebSocket connection for this stream
      // We'll route messages to the plugin via commands
      const wsId = `webrtc-${streamId}-${Date.now()}`
      const handler = { ws, workspace, wsId }
      webrtcMessageHandlers.set(streamId, handler)
      logger.debug('WebRTC handler stored', {
        streamId,
        wsId,
        mapSize: webrtcMessageHandlers.size,
        storedHandler: {
          hasWs: !!handler.ws,
          wsId: handler.wsId,
          wsReadyState: handler.ws.readyState
        }
      })

      // Set up message handling - route to plugin via command
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString())
          logger.debug('WebRTC message received', { streamId, messageType: message.type, wsId })
          // Route message to plugin via command system
          // This executes in the plugin's worker thread context
          // Note: executeCommand is synchronous, but the handler can be async
          // Pass arguments explicitly to ensure correct order
          workspace.api.commands.executeCommand('caspar-network.handleWebRTCMessage', streamId, message, wsId)
        } catch (err) {
          logger.error('Error handling WebRTC signaling message', {
            streamId,
            error: err.message,
            stack: err.stack
          })
          ws.send(JSON.stringify({
            type: 'error',
            message: err.message || 'Unknown error'
          }))
        }
      })

      ws.on('close', () => {
        logger.debug('WebRTC signaling connection closed', { streamId })
        webrtcMessageHandlers.delete(streamId)
      })

      ws.on('error', (err) => {
        logger.error('WebRTC signaling WebSocket error', {
          streamId,
          error: err.message
        })
        webrtcMessageHandlers.delete(streamId)
      })

      logger.debug('WebRTC signaling connection established', { streamId, wsId })
    })
    return
  }
  // Handle regular workspace WebSocket connections
  if (_url.pathname !== '/api/v1/ws') return

  /*
  The search params are reused
  within WorkspaceSockets
  */
  req.searchParams = _url.searchParams

  const workspaceId = _url.searchParams.get('workspace')
  const workspace = WorkspaceRegistry.getInstance().get(workspaceId)

  if (!workspace) {
    logger.warn('Closed websocket connection to a non existing workspace')
    sock.end()
    return
  }

  workspace.sockets.upgrade(req, sock, head)
})

app.get('/workspaces/new', (req, res, next) => {
  const paths = require('./paths')
  const ProjectFile = require('./ProjectFile')
  const fs = require('fs')

  // Check if defaultworkspace.bridge exists
  const defaultWorkspacePath = path.join(paths.workspaces, 'defaultworkspace.bridge')

  if (fs.existsSync(defaultWorkspacePath)) {
    // Try to get existing workspace from registry
    ProjectFile.main.readWorkspace(defaultWorkspacePath).then(workspace => {
      if (workspace) {
        // Check if workspace is already in registry
        const existing = WorkspaceRegistry.getInstance().get(workspace.id)
        if (existing) {
          return res.redirect(`/workspaces/${workspace.id}`)
        }

        // Add to registry if not already there
        workspace.state.apply({ _filePath: defaultWorkspacePath })
        WorkspaceRegistry.getInstance().add(workspace)
        return res.redirect(`/workspaces/${workspace.id}`)
      }

      // Fallback to creating new workspace if loading fails
      const id = WorkspaceRegistry.getInstance().create()
      res.redirect(`/workspaces/${id}`)
    }).catch(err => {
      logger.warn('Failed to load defaultworkspace, creating new', err)
      const id = WorkspaceRegistry.getInstance().create()
      res.redirect(`/workspaces/${id}`)
    })
  } else {
    // No default workspace, create a new one
    const id = WorkspaceRegistry.getInstance().create()
    res.redirect(`/workspaces/${id}`)
  }
})

/*
Keep workspaces under /workspaces/:id
in order to not trigger their creation
when going to paths such as /favicon.ico
*/
function handleWorkspaceWidget (req, res, next) {
  const widgetId = req.params.widget

  if (typeof widgetId !== 'string') {
    return next(new Error('Invalid widgetId, must be a string'))
  }

  req.widget = {
    id: widgetId
  }
  return handleWorkspace(req, res, next)
}

/*
Keep workspaces under /workspaces/:id
in order to not trigger their creation
when going to paths such as /favicon.ico
*/
function handleWorkspace (req, res, next) {
  const id = req.params.workspace
  const workspace = WorkspaceRegistry.getInstance().get(id)

  if (!workspace) {
    return next(new HttpError('Workspace not found', 'ERR_WORKSPACE_NOT_FOUND', 404))
  }

  /*
  Set a reference to the Workspace
  to the request object for further
  requests to make use of
  */
  req.workspace = workspace
  next()
}

app.use('/workspaces/:workspace/widgets/:widget', handleWorkspaceWidget)
app.use('/workspaces/:workspace', handleWorkspace)

/*
Redirect all users requesting
the root to a new workspace
*/
app.get('/', (req, res, next) => {
  return res.redirect('/workspaces/new')
})

/*
Attach the main routes
to the Express application
*/
app.use('/api/v1', apiRoutes)

/*
Fallback to responding
with the client app
*/
app.get('*', (req, res, next) => {
  const nonce = random.string(16)
  res.setHeader('Content-Security-Policy', `script-src 'self' 'nonce-${nonce}'`)

  res.send(template({
    env: process.env.NODE_ENV,
    port: HTTP_PORT,
    address: HTTP_BIND_ADDR === '0.0.0.0' && platform.isElectron() ? network.getFirstIPv4Address() : 'localhost',
    version: pkg.version,
    platform: process.platform,
    workspace: req.workspace?.id,
    widget: req.widget?.id,
    hostProtocol: process.env.HOST_PROTOCOL
  }, assets.assets, nonce))
})

app.use((err, req, res, next) => {
  let _err = err
  logger.error(_err.message)
  logger.raw(_err)

  if (!err.status || err.status === 500) {
    _err = new HttpError('Internal server error', 'ERR_INTERNAL_SERVER_ERROR', 500)
  }

  return res
    .status(_err.status)
    .json({
      name: _err.name,
      code: _err.code,
      description: _err.message
    })
})
