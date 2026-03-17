# CasparCG Network Plugin (caspar-network) - Implementation Plan

## Overview

This document outlines the plan for creating a new Bridge plugin called `caspar-network` that manages FFmpeg AMCP commands for SRT streams. The plugin will provide a web-based UI for controlling SRT input streams and outputs on different CasparCG layers, with live stream preview capabilities.

## Goals

1. **Manage SRT Input Streams**: Control PLAY commands for SRT streams on different CasparCG layers
2. **Manage SRT Output Streams**: Control ADD STREAM commands to add multiple outputs for layers
3. **Track Stream Status**: Monitor and track the status of active streams
4. **Live Stream Preview**: Display live stream previews in the web UI (channel-based; see below)
5. **UI Management**: Provide intuitive views for adding, configuring, and removing streams

### Preview vs Output Streams (Channel-Based Preview)

- **Output streams** (`streams.outputs`, Output Streams widget): Used for third-party encoders. Users add SRT outputs with custom ports and encoding; these are **not** used for the in-UI preview.
- **Preview**: One preview per channel, on a **dedicated SRT port** and **tracked separately** from outputs. Preview is started/stopped via a button in the Stream Preview widget. No human input is required for the preview SRT command: it is **preconfigured** (default port, default encoding). The preview stream uses a reserved stream index (e.g. 999) and a default port (e.g. 6010 for channel 1, 6010+1 for channel 2, etc.) so it does not clash with user-defined outputs.

## Architecture Overview

The plugin will follow Bridge's plugin architecture:
- **Backend (Node.js)**: Handles AMCP command execution, state management, and stream tracking
- **Frontend (React)**: Provides UI widgets for stream management and preview
- **Shared State**: Uses Bridge's shared context to sync stream configurations across clients

## Plugin Structure

```
plugins/caspar-network/
├── package.json              # Plugin manifest
├── index.js                  # Main entry point (backend)
├── webpack.config.js         # Optional webpack config if needed
├── lib/                      # Backend logic
│   ├── AMCP.js              # AMCP command builders for SRT streams
│   ├── StreamManager.js     # Manages stream lifecycle and tracking
│   ├── commands.js          # Bridge command handlers
│   └── paths.js             # State path constants
└── app/                      # Frontend React application
    ├── index.jsx            # React entry point
    ├── App.jsx              # Main app component with routing
    ├── sharedContext.js     # Shared state context provider
    ├── style.css            # Plugin styles
    ├── components/          # Reusable components
    │   ├── StreamInputForm/
    │   ├── StreamOutputForm/
    │   ├── StreamPreview/
    │   ├── StreamList/
    │   └── StreamStatus/
    └── views/               # Main views
        ├── StreamManager.jsx    # Main stream management view
        ├── StreamInputs.jsx     # Input streams view
        ├── StreamOutputs.jsx    # Output streams view
        └── Settings.jsx          # Plugin settings
```

## Implementation Details

### 1. Backend Implementation

#### 1.1 Plugin Entry Point (`index.js`)

**Responsibilities:**
- Initialize the plugin
- Register widgets
- Set up default state
- Register commands

**Key Functions:**
```javascript
exports.activate = async () => {
  // Initialize widget HTML
  const htmlPath = await initWidget()
  
  // Initialize default settings
  await initSettings()
  
  // Register widgets
  bridge.widgets.registerWidget({
    id: 'bridge.plugins.caspar-network.manager',
    name: 'Network Stream Manager',
    uri: `${htmlPath}?path=manager`,
    description: 'Manage SRT input and output streams',
    supportsFloat: true
  })
  
  bridge.widgets.registerWidget({
    id: 'bridge.plugins.caspar-network.preview',
    name: 'Stream Preview',
    uri: `${htmlPath}?path=preview`,
    description: 'Preview active streams',
    supportsFloat: true
  })
}
```

#### 1.2 AMCP Command Builders (`lib/AMCP.js`)

**Purpose:** Build AMCP command strings for SRT streams

**Functions to implement:**

```javascript
/**
 * Build PLAY command for SRT input stream
 * @param {Number} channel - CasparCG channel
 * @param {Number} layer - CasparCG layer
 * @param {String} srtUrl - SRT URL (e.g., "srt://localhost:9000?mode=caller&latency=2000&transtype=live")
 * @param {Boolean} loop - Whether to loop the stream
 * @returns {String} AMCP command string
 */
exports.playSrtStream = (channel, layer, srtUrl, loop = false) => {
  const layerStr = layer != null ? `${channel}-${layer}` : `${channel}`
  const loopStr = loop ? ' LOOP' : ''
  return `PLAY ${layerStr} "${srtUrl}"${loopStr}`
}

/**
 * Build ADD STREAM command for SRT output
 * @param {Number} channel - CasparCG channel
 * @param {String} srtUrl - SRT listener URL
 * @param {Object} encodingOptions - Encoding parameters
 * @returns {String} AMCP command string
 */
exports.addStream = (channel, srtUrl, encodingOptions = {}) => {
  const {
    format = 'mpegts',
    codec = 'h264_nvenc',
    preset = 'p4',
    tune = 'll',
    bitrate = '6000k',
    maxrate = '6000k',
    bufsize = '12000k',
    gop = 50,
    keyintMin = 50,
    audio = false
  } = encodingOptions
  
  let cmd = `ADD ${channel} STREAM "${srtUrl}"`
  cmd += ` -format ${format}`
  cmd += ` -codec:v ${codec}`
  cmd += ` -preset:v ${preset}`
  cmd += ` -tune:v ${tune}`
  cmd += ` -b:v ${bitrate}`
  cmd += ` -maxrate:v ${maxrate}`
  cmd += ` -bufsize:v ${bufsize}`
  cmd += ` -g:v ${gop}`
  cmd += ` -keyint_min:v ${keyintMin}`
  if (!audio) {
    cmd += ` -an`
  }
  
  return cmd
}

/**
 * Build REMOVE STREAM command
 * @param {Number} channel - CasparCG channel
 * @param {Number} streamIndex - Stream index to remove
 * @returns {String} AMCP command string
 */
exports.removeStream = (channel, streamIndex) => {
  return `REMOVE ${channel} STREAM ${streamIndex}`
}
```

#### 1.3 Stream Manager (`lib/StreamManager.js`)

**Purpose:** Track active streams, manage their lifecycle, and maintain state

**Key Features:**
- Track active input streams (channel-layer pairs)
- Track active output streams (channel-stream index pairs)
- Store stream configurations
- Monitor stream status
- Handle stream errors

**State Structure:**
```javascript
{
  plugins: {
    'bridge-plugin-caspar-network': {
      streams: {
        inputs: [
          {
            id: 'uuid',
            serverId: 'server-id',
            channel: 1,
            layer: 10,
            srtUrl: 'srt://localhost:9000?mode=caller&latency=2000&transtype=live',
            loop: true,
            status: 'active' | 'stopped' | 'error',
            createdAt: timestamp,
            lastError: null
          }
        ],
        outputs: [
          {
            id: 'uuid',
            serverId: 'server-id',
            channel: 1,
            streamIndex: 0,
            srtUrl: 'srt://0.0.0.0:6000?mode=listener&latency=2000&transtype=live',
            encodingOptions: { ... },
            status: 'active' | 'stopped' | 'error',
            createdAt: timestamp,
            lastError: null
          }
        ]
      }
    }
  }
}
```

#### 1.4 Commands (`lib/commands.js`)

**Purpose:** Register Bridge commands for stream management

**Commands to implement:**

```javascript
/**
 * Add an SRT input stream
 * @param {String} serverId - CasparCG server ID
 * @param {Number} channel - Channel number
 * @param {Number} layer - Layer number
 * @param {String} srtUrl - SRT URL
 * @param {Boolean} loop - Loop flag
 * @returns {Promise<String>} Stream ID
 */
async function addInputStream(serverId, channel, layer, srtUrl, loop) {
  // Build AMCP command
  // Send command via caspar.sendString
  // Track stream in state
  // Return stream ID
}

/**
 * Remove an SRT input stream
 * @param {String} streamId - Stream ID
 * @returns {Promise}
 */
async function removeInputStream(streamId) {
  // Get stream config from state
  // Send REMOVE command
  // Remove from state
}

/**
 * Add an SRT output stream
 * @param {String} serverId - CasparCG server ID
 * @param {Number} channel - Channel number
 * @param {String} srtUrl - SRT listener URL
 * @param {Object} encodingOptions - Encoding parameters
 * @returns {Promise<String>} Stream ID
 */
async function addOutputStream(serverId, channel, srtUrl, encodingOptions) {
  // Build AMCP command
  // Send command via caspar.sendString
  // Track stream in state
  // Return stream ID
}

/**
 * Remove an SRT output stream
 * @param {String} streamId - Stream ID
 * @returns {Promise}
 */
async function removeOutputStream(streamId) {
  // Get stream config from state
  // Send REMOVE STREAM command
  // Remove from state
}

/**
 * List all active streams
 * @returns {Promise<Object>} Object with inputs and outputs arrays
 */
async function listStreams() {
  // Get streams from state
  // Return formatted list
}

/**
 * Get stream status
 * @param {String} streamId - Stream ID
 * @returns {Promise<Object>} Stream status
 */
async function getStreamStatus(streamId) {
  // Query CasparCG server for stream status
  // Return status object
}
```

### 2. Frontend Implementation

#### 2.1 Main App Component (`app/App.jsx`)

**Purpose:** Route to different views based on URL parameter

```javascript
export default function App() {
  const [view, setView] = React.useState()
  
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    setView(params.get('path'))
  }, [])
  
  return (
    <SharedContext.Provider>
      {view === 'manager' && <StreamManager />}
      {view === 'inputs' && <StreamInputs />}
      {view === 'outputs' && <StreamOutputs />}
      {view === 'preview' && <StreamPreview />}
      {view === 'settings' && <Settings />}
    </SharedContext.Provider>
  )
}
```

#### 2.2 Stream Manager View (`app/views/StreamManager.jsx`)

**Purpose:** Main dashboard for managing all streams

**Features:**
- Tabs or sections for Input Streams and Output Streams
- Summary cards showing active stream counts
- Quick actions (add stream, stop all, etc.)
- Links to detailed views

#### 2.3 Stream Inputs View (`app/views/StreamInputs.jsx`)

**Purpose:** Manage SRT input streams

**Features:**
- List of active input streams
- Form to add new input stream:
  - Server selector
  - Channel input
  - Layer input
  - SRT URL input
  - Loop checkbox
- Actions per stream:
  - Start/Stop
  - Edit configuration
  - Remove
  - Preview
- Stream status indicators

**Form Fields:**
- Server: Dropdown (uses `caspar.listServers`)
- Channel: Number input
- Layer: Number input
- SRT URL: Text input with validation
- Loop: Checkbox

#### 2.4 Stream Outputs View (`app/views/StreamOutputs.jsx`)

**Purpose:** Manage SRT output streams

**Features:**
- List of active output streams
- Form to add new output stream:
  - Server selector
  - Channel input
  - SRT listener URL
  - Encoding options (advanced/collapsible):
    - Format (mpegts)
    - Video codec (h264_nvenc, h264, etc.)
    - Preset
    - Tune
    - Bitrate
    - Maxrate
    - Buffersize
    - GOP size
    - Keyframe interval min
    - Audio enabled
- Actions per stream:
  - Start/Stop
  - Edit configuration
  - Remove
  - Preview

#### 2.5 Stream Preview Component (`app/components/StreamPreview/`)

**Purpose:** Display live stream preview. Preview is **channel-based** (one preview per channel), uses a dedicated SRT port and dedicated state (`streams.channelPreviews`), and is **not** tied to the output streams widget. The Preview view lists channels (from input streams), each with a Start/Stop Preview button; starting preview sends ADD STREAM with preconfigured port/encoding and starts the WebRTC bridge for that channel.

**Implementation Options:**

**Option 1: HTML5 Video Element with HLS/DASH Proxy**
- Pros: Native browser support, good performance
- Cons: Requires transcoding SRT to HLS/DASH
- Implementation: Use a backend proxy that converts SRT to HLS/DASH

**Option 2: WebRTC**
- Pros: Low latency, native browser support
- Cons: Requires WebRTC server/gateway
- Implementation: Use a WebRTC gateway (e.g., Janus, Kurento)

**Option 3: Canvas-based Player (via FFmpeg.wasm)**
- Pros: No server needed, works in browser
- Cons: High CPU usage, may not support all codecs
- Implementation: Use ffmpeg.wasm to decode stream in browser

**Option 4: CasparCG Thumbnail/Preview API**
- Pros: Uses existing CasparCG infrastructure
- Cons: May have latency, limited to what CasparCG provides
- Implementation: Query CasparCG for preview frames

**Recommended Approach: Hybrid**

1. **Primary**: Use HTML5 video with HLS/DASH proxy
   - Create a backend endpoint that proxies SRT streams
   - Convert SRT to HLS using FFmpeg
   - Serve HLS manifest and segments via HTTP
   - Use hls.js library for playback

2. **Fallback**: Use CasparCG thumbnail API for static previews
   - For streams that can't be converted in real-time
   - Show periodic thumbnail updates

**Implementation:**

```javascript
// Backend: lib/StreamProxy.js
// Create HTTP endpoint that proxies SRT to HLS
// Use FFmpeg to transcode: srt://... -> hls://...

// Frontend: app/components/StreamPreview/index.jsx
import Hls from 'hls.js'

export const StreamPreview = ({ streamId, streamUrl }) => {
  const videoRef = React.useRef()
  const [error, setError] = React.useState(null)
  
  React.useEffect(() => {
    if (!streamUrl) return
    
    const video = videoRef.current
    if (!video) return
    
    // If HLS is supported natively
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = streamUrl
    } else if (Hls.isSupported()) {
      // Use hls.js for HLS playback
      const hls = new Hls()
      hls.loadSource(streamUrl)
      hls.attachMedia(video)
      hls.on(Hls.Events.ERROR, (event, data) => {
        setError(data)
      })
      return () => {
        hls.destroy()
      }
    } else {
      setError('HLS not supported in this browser')
    }
  }, [streamUrl])
  
  return (
    <div className="StreamPreview">
      <video
        ref={videoRef}
        controls
        autoPlay
        muted
        playsInline
      />
      {error && <div className="error">{error.message}</div>}
    </div>
  )
}
```

**Backend Proxy Implementation:**

```javascript
// lib/StreamProxy.js
const express = require('express')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

const router = express.Router()

// Create HLS proxy for SRT stream
router.get('/hls/:streamId', (req, res) => {
  const streamId = req.params.streamId
  const stream = getStreamConfig(streamId)
  
  // Create HLS output directory
  const hlsDir = path.join(__dirname, '../../data/temp/hls', streamId)
  fs.mkdirSync(hlsDir, { recursive: true })
  
  // FFmpeg command to convert SRT to HLS
  const ffmpeg = spawn('ffmpeg', [
    '-i', stream.srtUrl,
    '-c:v', 'libx264',
    '-c:a', 'aac',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '3',
    '-hls_flags', 'delete_segments',
    path.join(hlsDir, 'playlist.m3u8')
  ])
  
  // Serve HLS manifest
  res.sendFile(path.join(hlsDir, 'playlist.m3u8'))
})

// Serve HLS segments
router.get('/hls/:streamId/:segment', (req, res) => {
  const streamId = req.params.streamId
  const segment = req.params.segment
  const hlsDir = path.join(__dirname, '../../data/temp/hls', streamId)
  res.sendFile(path.join(hlsDir, segment))
})
```

#### 2.5.2 Channel-Based Preview (Current Implementation)

Preview is **decoupled from output streams**. Output streams are for third-party encoders only; preview uses its own SRT port and state.

- **State**: `streams.channelPreviews` — array of `{ channelKey, serverId, channel, streamIndex, srtUrl, encodingOptions, status }`. Keyed by `channelKey` (e.g. `serverId-channel`). One preview per channel.
- **Settings** (preconfigured, no user input required for preview):
  - `previewDefaultPort` (e.g. 6010): base port; channel 1 = base, channel 2 = base+1, etc.
  - `previewDefaultSrtParams`: e.g. `mode=listener&latency=2000&transtype=live`
  - `previewEncodingOptions`: encoding for the preview ADD STREAM (e.g. lower bitrate than main outputs)
  - `previewStreamIndex`: reserved index (e.g. 999) so preview does not clash with user output indices
- **Commands** (`lib/commands/channelPreview.js`):
  - `caspar-network.startChannelPreview(serverId, channel)`: ADD STREAM with preconfigured URL, start WebRTC bridge, return signaling path
  - `caspar-network.stopChannelPreview(serverId, channel)`: REMOVE STREAM, stop WebRTC bridge
  - `caspar-network.listChannelPreviews()`: list active channel previews
  - `caspar-network.listPreviewableChannels()`: unique serverId+channel from input streams (for UI dropdown)
- **StreamManager**: `channelPreviews` Map, `setChannelPreview`, `getChannelPreview`, `removeChannelPreview`, `getAllChannelPreviews`, `StreamManager.channelKey(serverId, channel)`.
- **UI**: Stream Preview view lists channels from `listPreviewableChannels()`; each row has Start Preview / Stop Preview and, when active, the WebRTC video component. No output stream selection.

#### 2.5.1 WebRTC Preview Implementation (Low-Latency Option)

**Purpose:** Provide sub-second latency stream preview using WebRTC

**Architecture Overview:**

```
SRT Stream → FFmpeg (SRT to WebRTC) → WebRTC Signaling Server → Browser (WebRTC Client)
```

**Key Components:**

1. **WebRTC Signaling Server**: Handles offer/answer exchange and ICE candidates
2. **FFmpeg WebRTC Converter**: Converts SRT streams to WebRTC format
3. **Browser WebRTC Client**: Receives and displays WebRTC stream

**Implementation Approach:**

**Option A: FFmpeg with WHIP (WebRTC-HTTP Ingestion Protocol)**

FFmpeg 6.0+ supports WebRTC via WHIP, which simplifies the implementation:

```javascript
// lib/WebRTCStream.js
const { spawn } = require('child_process')
const express = require('express')
const { WebSocketServer } = require('ws')

class WebRTCStreamManager {
  constructor() {
    this.activeStreams = new Map()
    this.wss = null
  }

  /**
   * Start WebRTC signaling server
   */
  startSignalingServer(port = 8888) {
    const wss = new WebSocketServer({ port })
    
    wss.on('connection', (ws) => {
      ws.on('message', async (message) => {
        const data = JSON.parse(message)
        
        switch (data.type) {
          case 'offer':
            // Handle WebRTC offer from client
            await this.handleOffer(ws, data)
            break
          case 'ice-candidate':
            // Forward ICE candidate
            await this.handleIceCandidate(ws, data)
            break
        }
      })
    })
    
    this.wss = wss
    return wss
  }

  /**
   * Start WebRTC stream from SRT source
   */
  async startWebRTCStream(streamId, srtUrl) {
    // FFmpeg command using WHIP or direct WebRTC output
    // Note: This requires FFmpeg 6.0+ with WebRTC support
    
    const ffmpegArgs = [
      '-i', srtUrl,                    // Input SRT stream
      '-c:v', 'libvpx-vp9',           // VP9 codec (good for WebRTC)
      '-deadline', 'realtime',         // Low latency encoding
      '-cpu-used', '8',                // Fast encoding
      '-b:v', '2M',                    // Bitrate
      '-maxrate', '2M',
      '-bufsize', '4M',
      '-g', '30',                      // GOP size
      '-c:a', 'libopus',              // Opus audio codec
      '-f', 'rtp',                     // RTP output format
      'rtp://127.0.0.1:5004'           // Local RTP endpoint
    ]

    const ffmpeg = spawn('ffmpeg', ffmpegArgs)
    
    // Store process reference
    this.activeStreams.set(streamId, {
      process: ffmpeg,
      srtUrl,
      createdAt: Date.now()
    })

    ffmpeg.stderr.on('data', (data) => {
      console.log(`FFmpeg: ${data}`)
    })

    ffmpeg.on('close', (code) => {
      console.log(`FFmpeg process exited with code ${code}`)
      this.activeStreams.delete(streamId)
    })

    return streamId
  }

  /**
   * Stop WebRTC stream
   */
  stopWebRTCStream(streamId) {
    const stream = this.activeStreams.get(streamId)
    if (stream && stream.process) {
      stream.process.kill()
      this.activeStreams.delete(streamId)
    }
  }
}
```

**Option B: Using Simple-Peer Library (Simpler Implementation)**

For a simpler approach, use `simple-peer` library with a Node.js signaling server:

```javascript
// lib/WebRTCSignaling.js
const { WebSocketServer } = require('ws')
const { spawn } = require('child_process')

class WebRTCSignalingServer {
  constructor() {
    this.peers = new Map()
    this.streams = new Map()
  }

  start(port = 8888) {
    const wss = new WebSocketServer({ port })
    
    wss.on('connection', (ws, req) => {
      const streamId = new URL(req.url, 'http://localhost').searchParams.get('streamId')
      
      if (!streamId) {
        ws.close()
        return
      }

      ws.on('message', async (message) => {
        const data = JSON.parse(message)
        await this.handleMessage(ws, streamId, data)
      })

      ws.on('close', () => {
        this.peers.delete(streamId)
      })

      this.peers.set(streamId, ws)
    })

    return wss
  }

  async handleMessage(ws, streamId, data) {
    switch (data.type) {
      case 'offer':
        // Start FFmpeg WebRTC stream and create answer
        await this.createAnswer(streamId, data.offer)
        break
      case 'ice-candidate':
        // Forward ICE candidate to other peer
        this.forwardIceCandidate(streamId, data.candidate)
        break
    }
  }

  async createAnswer(streamId, offer) {
    // Use FFmpeg to create WebRTC answer
    // This is complex - may need a WebRTC library like node-webrtc
    // Or use a media server like Janus
  }
}
```

**Option C: Using Janus WebRTC Server (Recommended for Production)**

Janus is a popular WebRTC server that handles signaling and media processing:

```javascript
// lib/JanusGateway.js
const axios = require('axios')

class JanusGateway {
  constructor(janusUrl = 'http://localhost:8088/janus') {
    this.janusUrl = janusUrl
    this.sessions = new Map()
  }

  /**
   * Create a Janus session
   */
  async createSession() {
    const response = await axios.post(`${this.janusUrl}`, {
      janus: 'create',
      transaction: this.generateTransaction()
    })
    return response.data.data.id
  }

  /**
   * Attach to streaming plugin
   */
  async attachStreamingPlugin(sessionId) {
    const response = await axios.post(`${this.janusUrl}/${sessionId}`, {
      janus: 'attach',
      plugin: 'janus.plugin.streaming',
      transaction: this.generateTransaction()
    })
    return response.data.data.id
  }

  /**
   * Create stream from SRT source
   */
  async createStream(sessionId, handleId, srtUrl) {
    const response = await axios.post(`${this.janusUrl}/${sessionId}/${handleId}`, {
      janus: 'message',
      transaction: this.generateTransaction(),
      body: {
        request: 'create',
        type: 'rtp',
        name: 'srt-stream',
        video: true,
        audio: true,
        videoport: 5004,
        videopt: 96,
        videocodec: 'vp8',
        audioport: 5006,
        audiopt: 111,
        audiocodec: 'opus'
      }
    })
    
    // Start FFmpeg to stream SRT to Janus RTP endpoint
    this.startFFmpegToJanus(srtUrl, response.data.data.id)
    
    return response.data
  }

  startFFmpegToJanus(srtUrl, streamId) {
    const ffmpeg = spawn('ffmpeg', [
      '-i', srtUrl,
      '-c:v', 'libvpx',
      '-deadline', 'realtime',
      '-cpu-used', '8',
      '-b:v', '2M',
      '-c:a', 'libopus',
      '-f', 'rtp',
      `rtp://127.0.0.1:5004`
    ])
    
    return ffmpeg
  }
}
```

**Frontend WebRTC Client Implementation:**

```javascript
// app/components/StreamPreview/WebRTCPreview.jsx
import React, { useRef, useEffect, useState } from 'react'
import SimplePeer from 'simple-peer'

export const WebRTCPreview = ({ streamId, signalingUrl }) => {
  const videoRef = useRef(null)
  const peerRef = useRef(null)
  const wsRef = useRef(null)
  const [error, setError] = useState(null)
  const [status, setStatus] = useState('disconnected')

  useEffect(() => {
    if (!streamId || !signalingUrl) return

    // Connect to signaling server
    const ws = new WebSocket(`${signalingUrl}?streamId=${streamId}`)
    wsRef.current = ws

    ws.onopen = () => {
      setStatus('connecting')
      initiateWebRTC(ws)
    }

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data)
      handleSignalingMessage(data)
    }

    ws.onerror = (err) => {
      setError('WebSocket connection error')
      setStatus('error')
    }

    ws.onclose = () => {
      setStatus('disconnected')
      cleanup()
    }

    return () => {
      cleanup()
    }
  }, [streamId, signalingUrl])

  const initiateWebRTC = (ws) => {
    // Create WebRTC peer as receiver
    const peer = new SimplePeer({
      initiator: false,
      trickle: false,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      }
    })

    peerRef.current = peer

    peer.on('signal', (data) => {
      // Send offer/answer to signaling server
      ws.send(JSON.stringify({
        type: 'signal',
        data: data
      }))
    })

    peer.on('stream', (stream) => {
      // Attach stream to video element
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        setStatus('connected')
      }
    })

    peer.on('error', (err) => {
      setError(`WebRTC error: ${err.message}`)
      setStatus('error')
    })

    peer.on('close', () => {
      setStatus('disconnected')
    })
  }

  const handleSignalingMessage = (data) => {
    if (peerRef.current && data.type === 'signal') {
      peerRef.current.signal(data.data)
    } else if (data.type === 'ice-candidate') {
      peerRef.current.addIceCandidate(data.candidate)
    }
  }

  const cleanup = () => {
    if (peerRef.current) {
      peerRef.current.destroy()
      peerRef.current = null
    }
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    if (videoRef.current && videoRef.current.srcObject) {
      videoRef.current.srcObject.getTracks().forEach(track => track.stop())
      videoRef.current.srcObject = null
    }
  }

  return (
    <div className="WebRTCPreview">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        controls
        style={{ width: '100%', height: 'auto' }}
      />
      <div className="status">
        Status: {status}
        {error && <div className="error">{error}</div>}
      </div>
    </div>
  )
}
```

**Alternative: Using RTCPeerConnection Directly (More Control)**

```javascript
// app/components/StreamPreview/WebRTCPreview.jsx (Alternative)
import React, { useRef, useEffect, useState } from 'react'

export const WebRTCPreview = ({ streamId, signalingUrl }) => {
  const videoRef = useRef(null)
  const pcRef = useRef(null)
  const wsRef = useRef(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!streamId || !signalingUrl) return

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }
      ]
    })

    pcRef.current = pc

    // Handle incoming stream
    pc.ontrack = (event) => {
      if (videoRef.current) {
        videoRef.current.srcObject = event.streams[0]
      }
    }

    pc.onicecandidate = (event) => {
      if (event.candidate && wsRef.current) {
        wsRef.current.send(JSON.stringify({
          type: 'ice-candidate',
          candidate: event.candidate
        }))
      }
    }

    // Connect to signaling server
    const ws = new WebSocket(`${signalingUrl}?streamId=${streamId}`)
    wsRef.current = ws

    ws.onmessage = async (event) => {
      const data = JSON.parse(event.data)

      if (data.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer))
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        ws.send(JSON.stringify({
          type: 'answer',
          answer: answer
        }))
      } else if (data.type === 'ice-candidate') {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate))
      }
    }

    return () => {
      pc.close()
      ws.close()
    }
  }, [streamId, signalingUrl])

  return (
    <div className="WebRTCPreview">
      <video ref={videoRef} autoPlay playsInline muted controls />
      {error && <div className="error">{error}</div>}
    </div>
  )
}
```

**Backend Command Integration:**

```javascript
// lib/commands.js - Add WebRTC commands

/**
 * Start WebRTC preview for a stream
 * @param {String} streamId - Stream ID
 * @returns {Promise<Object>} WebRTC connection info
 */
async function startWebRTCPreview(streamId) {
  const stream = getStreamConfig(streamId)
  if (!stream) {
    throw new Error('Stream not found')
  }

  // Start WebRTC stream conversion
  const webrtcManager = require('./WebRTCStream')
  await webrtcManager.startWebRTCStream(streamId, stream.srtUrl)

  return {
    streamId,
    signalingUrl: `ws://localhost:8888`,
    status: 'starting'
  }
}

bridge.commands.registerCommand('caspar-network.startWebRTCPreview', startWebRTCPreview)

/**
 * Stop WebRTC preview
 * @param {String} streamId - Stream ID
 */
async function stopWebRTCPreview(streamId) {
  const webrtcManager = require('./WebRTCStream')
  webrtcManager.stopWebRTCStream(streamId)
}

bridge.commands.registerCommand('caspar-network.stopWebRTCPreview', stopWebRTCPreview)
```

**Dependencies:**

```json
{
  "dependencies": {
    "ws": "^8.14.2",
    "simple-peer": "^9.11.1",
    "axios": "^1.6.0"
  }
}
```

**Configuration:**

Add WebRTC settings to plugin configuration:

```javascript
{
  plugins: {
    'bridge-plugin-caspar-network': {
      settings: {
        webrtc: {
          enabled: true,
          signalingPort: 8888,
          useJanus: false,  // Set to true to use Janus server
          janusUrl: 'http://localhost:8088/janus',
          stunServers: [
            'stun:stun.l.google.com:19302'
          ],
          turnServers: []  // Optional TURN servers for NAT traversal
        }
      }
    }
  }
}
```

**Advantages of WebRTC:**

1. **Low Latency**: Sub-second latency (typically 200-500ms)
2. **Native Browser Support**: No plugins required
3. **Adaptive Bitrate**: Automatically adjusts to network conditions
4. **Encryption**: Built-in SRTP encryption
5. **P2P Capable**: Can work peer-to-peer in some scenarios

**Disadvantages:**

1. **Complexity**: More complex than HLS implementation
2. **Server Requirements**: Needs signaling server and potentially media server
3. **NAT Traversal**: May require STUN/TURN servers
4. **Browser Compatibility**: Some older browsers may not support all features

**Recommended Implementation Strategy:**

1. **Phase 1**: Implement HLS preview (simpler, works immediately)
2. **Phase 2**: Add WebRTC as optional low-latency option
3. **Phase 3**: Allow users to choose preview method per stream
4. **Phase 4**: Auto-select best method based on network conditions

#### 2.6 Shared Context (`app/sharedContext.js`)

**Purpose:** Provide access to shared state

```javascript
import React from 'react'
import bridge from 'bridge'

export const SharedContext = React.createContext()

export const Provider = ({ children }) => {
  const [state, setState] = React.useState()
  
  React.useEffect(() => {
    async function initState() {
      const state = await bridge.state.get()
      setState(state)
    }
    initState()
  }, [])
  
  React.useEffect(() => {
    function onStateChange(state) {
      setState({ ...state })
    }
    bridge.events.on('state.change', onStateChange)
    return () => bridge.events.off('state.change', onStateChange)
  }, [])
  
  return (
    <SharedContext.Provider value={[state, bridge.state.apply]}>
      {children}
    </SharedContext.Provider>
  )
}
```

### 3. State Management

#### 3.1 State Paths (`lib/paths.js`)

```javascript
const manifest = require('../package.json')

exports.STATE_STREAMS_PATH = `plugins.${manifest.name}.streams`
exports.STATE_SETTINGS_PATH = `plugins.${manifest.name}.settings`
```

#### 3.2 Default State Structure

```javascript
{
  plugins: {
    'bridge-plugin-caspar-network': {
      streams: {
        inputs: [],
        outputs: []
      },
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
        previewQuality: 'medium' // low, medium, high
      }
    }
  }
}
```

### 4. Integration with CasparCG Plugin

The plugin will use the existing CasparCG plugin's infrastructure:

1. **Server Management**: Use `caspar.listServers` to get available servers
2. **Command Execution**: Use `caspar.sendString` to send AMCP commands
3. **Status Monitoring**: Query CasparCG server status via `caspar.sendCommand('info')`

**Dependencies:**
- The plugin assumes the `bridge-plugin-caspar` plugin is installed and active
- Streams are tracked separately but commands are sent through CasparCG plugin

### 5. User Interface Design

#### 5.1 Main Stream Manager Widget

**Layout:**
```
┌─────────────────────────────────────────┐
│  Network Stream Manager                 │
├─────────────────────────────────────────┤
│  [Input Streams] [Output Streams]       │
│                                         │
│  Active Inputs: 3    Active Outputs: 2 │
│                                         │
│  ┌───────────────────────────────────┐  │
│  │ Input Streams                    │  │
│  │                                  │  │
│  │ [+ Add Input Stream]             │  │
│  │                                  │  │
│  │ Channel 1, Layer 10  [●] [✎] [×]│  │
│  │ srt://localhost:9000...          │  │
│  │                                  │  │
│  │ Channel 1, Layer 11  [●] [✎] [×]│  │
│  │ srt://localhost:9001...          │  │
│  └───────────────────────────────────┘  │
│                                         │
│  ┌───────────────────────────────────┐  │
│  │ Output Streams                    │  │
│  │                                  │  │
│  │ [+ Add Output Stream]            │  │
│  │                                  │  │
│  │ Channel 1, Stream 0  [●] [✎] [×]│  │
│  │ srt://0.0.0.0:6000...            │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

#### 5.2 Stream Preview Widget

**Layout:**
```
┌─────────────────────────────────────────┐
│  Stream Preview                         │
├─────────────────────────────────────────┤
│  [Select Stream ▼]                      │
│                                         │
│  ┌───────────────────────────────────┐  │
│  │                                   │  │
│  │                                   │  │
│  │        [Video Preview]            │  │
│  │                                   │  │
│  │                                   │  │
│  └───────────────────────────────────┘  │
│                                         │
│  Status: Active | Latency: 2.1s        │
└─────────────────────────────────────────┘
```

### 6. Error Handling

#### 6.1 Stream Errors

- **Connection Errors**: Display error message, allow retry
- **Invalid URLs**: Validate before sending command
- **Server Unavailable**: Show warning, disable actions
- **Command Failures**: Log error, update stream status

#### 6.2 Preview Errors

- **Stream Unavailable**: Show placeholder or error message
- **Codec Not Supported**: Fallback to thumbnail preview
- **Network Issues**: Show retry option

### 7. Testing Considerations

1. **Unit Tests**: Test AMCP command building
2. **Integration Tests**: Test command execution with mock CasparCG server
3. **UI Tests**: Test form validation and stream management flows
4. **Preview Tests**: Test different stream formats and codecs

### 8. Documentation

1. **Plugin README**: Usage instructions, configuration options
2. **API Documentation**: Command reference
3. **User Guide**: Step-by-step instructions for common tasks

### 9. Future Enhancements

1. **Stream Templates**: Save and reuse common stream configurations
2. **Stream Scheduling**: Schedule streams to start/stop at specific times
3. **Multi-server Support**: Manage streams across multiple CasparCG servers
4. **Stream Analytics**: Track bandwidth, latency, errors
5. **Advanced Preview**: Multiple preview windows, picture-in-picture
6. **Stream Recording**: Record streams to file
7. **WebRTC Support**: ✅ **IMPLEMENTED** - See section 2.5.1 for detailed WebRTC implementation

## Implementation Phases

### Phase 1: Core Backend (Week 1)
- [ ] Create plugin structure
- [ ] Implement AMCP command builders
- [ ] Implement stream manager
- [ ] Register commands
- [ ] Basic state management

### Phase 2: Basic UI (Week 2)
- [ ] Create main app structure
- [ ] Implement stream inputs view
- [ ] Implement stream outputs view
- [ ] Basic form validation
- [ ] Stream list display

### Phase 3: Stream Management (Week 3)
- [ ] Implement add/remove stream functionality
- [ ] Stream status tracking
- [ ] Error handling
- [ ] Integration with CasparCG plugin

### Phase 4: Preview Implementation (Week 4)
- [ ] Research and choose preview approach
- [ ] Implement HLS backend proxy
- [ ] Implement HLS preview component
- [ ] Test with various stream formats

### Phase 5: WebRTC Preview (Week 5)
- [ ] Implement WebRTC signaling server
- [ ] Implement FFmpeg to WebRTC conversion
- [ ] Implement WebRTC client component
- [ ] Add WebRTC configuration options
- [ ] Test low-latency preview
- [ ] Optional: Integrate Janus gateway support

### Phase 6: Polish & Testing (Week 6)
- [ ] UI/UX improvements
- [ ] Error handling refinement
- [ ] Documentation
- [ ] Testing and bug fixes
- [ ] Performance optimization
- [ ] FFmpeg process observability (progress stats, optional CPU/memory; see Observability section)

## Technical Decisions

### 1. Preview Technology Choice

**Decision**: Use HLS proxy approach with FFmpeg
- **Rationale**: 
  - Widely supported in browsers
  - Good balance of latency and compatibility
  - Can leverage existing FFmpeg infrastructure
  - Fallback to thumbnail API if needed

### 2. State Storage

**Decision**: Store in shared state under `plugins.bridge-plugin-caspar-network`
- **Rationale**:
  - Follows Bridge plugin conventions
  - Enables real-time sync across clients
  - Persists with workspace

### 3. Command Execution

**Decision**: Use existing CasparCG plugin's `sendString` command
- **Rationale**:
  - Reuses existing infrastructure
  - Maintains consistency with other CasparCG operations
  - No need to duplicate connection management

## Dependencies

### Backend
- `bridge` (API)
- `uuid` (for generating stream IDs)
- `ws` (for WebRTC signaling server, if using WebRTC)
- `simple-peer` (optional, for simplified WebRTC implementation)
- `axios` (for Janus gateway integration, if using Janus)

### Frontend
- `react` (UI framework)
- `hls.js` (for HLS playback, if using HLS preview)
- `simple-peer` (for WebRTC client, if using WebRTC preview)
- `bridge` (API client)

### Optional
- `ffmpeg` (for stream proxy and WebRTC conversion)
- `janus-gateway` (external WebRTC media server, if using Janus option)

## Configuration

### Plugin Settings

Users can configure:
- Default encoding options for output streams
- Preview quality settings
- Auto-start streams on workspace load
- Stream timeout values

## Security Considerations

1. **SRT URL Validation**: Validate URLs before sending to prevent injection
2. **Server Access**: Ensure users can only access configured servers
3. **Preview Access**: Limit preview access to authorized streams
4. **Resource Limits**: Prevent excessive stream creation

## Observability of FFmpeg Processes

This section outlines options to surface stats from the plugin’s FFmpeg processes (HLS proxy in `StreamProxy.js`, RTP/WebRTC in `FFmpegClient.js`) for monitoring, debugging, and UI.

### Goals

- **Per-stream metrics**: Frame rate, bitrate, speed, dropped/duplicate frames, and optionally process CPU/memory.
- **Where to surface**: Shared state (for UI), logs (for debugging), and optionally an API or metrics endpoint for dashboards.
- **Low overhead**: Avoid flooding state or logs; use configurable update intervals.

### Option 1: FFmpeg `-progress` (recommended for encoding stats)

FFmpeg can write machine-readable progress either to **stderr** (`pipe:2`) or to **per-stream files** in `/tmp`. The file-based approach gives clean separation when adding/removing streams (see below).

**Progress key=value pairs** (one per line, empty line = end of one report):

| Key           | Meaning |
|---------------|--------|
| `frame`       | Frames encoded so far |
| `fps`         | Current frames per second |
| `speed`       | Encoding speed (e.g. `1.23x`) |
| `bitrate`     | Current bitrate string (e.g. `1234.5kbits/s`) |
| `out_time_ms` | Output time in microseconds |
| `out_time`    | Human-readable output time |
| `dup_frames`  | Duplicate frames |
| `drop_frames` | Dropped frames |
| `progress`    | `continue` while running, `end` when done |

Add **`-stats_period <seconds>`** (e.g. `1` or `2`) to control how often progress is emitted. Use **`-nostats`** if you use `pipe:2`, so the human-readable `frame= ...` line is disabled and stderr only has progress key=value lines.

---

#### Option 1a: File-based progress (recommended for clean separation)

Writing progress to **one file per stream in `/tmp`** keeps stats and aggregation clean when you add or remove FFmpeg streams in the network plugin: no mixing with stderr, and each stream’s stats are isolated and easy to delete on teardown.

**Directory layout:**

- Use a dedicated directory under the system temp dir, e.g. **`/tmp/bridge-caspar-network-ffmpeg-progress/`** (or `path.join(os.tmpdir(), 'bridge-caspar-network-ffmpeg-progress')`).
- One file per stream: **`<progressDir>/<streamId>.progress`**.
- Stream IDs are already unique (UUID) and map 1:1 to a single FFmpeg process (HLS proxy or WebRTC/RTP), so one file per process and no cross-talk.

**FFmpeg args:**

- **`-progress <progressDir>/<streamId>.progress`**
- **`-stats_period 1`** (or 2)
- No need for `-nostats` when using a file (progress goes to the file, not stderr).

**Lifecycle:**

1. **Before spawn:** Ensure the progress directory exists (`fs.mkdirSync(progressDir, { recursive: true })`). Do **not** create the progress file yourself; FFmpeg will create it when it starts writing.
2. **While running:** A reader (see below) polls or watches each stream’s file, parses the latest report, and writes into shared state (and/or aggregation).
3. **On stream remove or process exit:** Delete the progress file for that `streamId`: `fs.unlinkSync(progressPath)` (or `fs.promises.unlink`), ignoring `ENOENT`. Optionally remove the directory if it’s empty when the last stream stops.

**Reading the file:**

- FFmpeg may **overwrite** the same file with the latest report or **append** reports; both are common depending on version. To be robust:
  - Read the entire file and parse key=value lines.
  - If the file contains multiple reports (blocks of key=value ending with an empty line), take the **last complete report** (last block before EOF or the final incomplete line).
- Poll on an interval (e.g. every 1–2s, or match `-stats_period`) or use `fs.watch(progressPath)` to react when the file changes. Throttle state updates to avoid flooding the UI.
- If the file is missing (e.g. process not started yet or already exited), treat that stream as “no stats” and clear or leave empty its `ffmpeg` state.

**Aggregation:**

- **Per-stream:** Each `streamId` has exactly one progress file and one entry in shared state (e.g. `streams.inputs[i].ffmpeg` or a map keyed by `streamId`). No mixing between streams.
- **Global / dashboard:** To aggregate across streams, the plugin can read all existing `.progress` files in the progress directory, parse each, and expose a summary (e.g. total frames, sum of bitrates, or list of per-stream stats) via an API route or a single state path. Only files for currently active streams should exist; cleanup on remove keeps the directory accurate.

**Example paths and cleanup:**

```javascript
// In StreamProxy.js / FFmpegClient.js (or a shared helper)
const os = require('os')
const path = require('path')

const PROGRESS_BASE = path.join(os.tmpdir(), 'bridge-caspar-network-ffmpeg-progress')

function getProgressPath(streamId) {
  return path.join(PROGRESS_BASE, `${streamId}.progress`)
}

// Before spawn: ensure dir exists
fs.mkdirSync(PROGRESS_BASE, { recursive: true })

// FFmpeg args
const progressPath = getProgressPath(streamId)
ffmpegArgs.push('-progress', progressPath, '-stats_period', '1')

// On process exit / stopProxy / stopStream: delete this stream’s file
function clearProgressFile(streamId) {
  try {
    fs.unlinkSync(getProgressPath(streamId))
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
}
```

**State shape** (unchanged): same `streams.*.ffmpeg` object as below; the only difference is that the data is filled from the per-stream progress file instead of from stderr.

---

#### Option 1b: Progress on stderr (`pipe:2`)

Use this if you prefer not to use files:

- Add **`-progress pipe:2`** and **`-stats_period 1`** (or 2). Use **`-nostats`** so stderr only has progress key=value lines.
- In the existing `stderr.on('data')` handler, split by newline, parse `key=value`, buffer until an empty line (one report), then publish to shared state.
- Progress is mixed with other FFmpeg log lines unless you filter; separation between streams is only in your in-memory state, not on disk.

**State shape suggestion** (for both 1a and 1b): Extend the existing stream state with an optional `ffmpeg` object so the UI can show “live” stats next to each stream:

```javascript
// Example: per-stream FFmpeg stats (updated every stats_period)
streams.inputs[i].ffmpeg = {
  frame: 12345,
  fps: 25.2,
  speed: '1.00',
  bitrate: '2000.0kbits/s',
  drop_frames: 0,
  dup_frames: 0,
  out_time_ms: 493500000,
  progress: 'continue',
  updatedAt: Date.now()
}
```

Use the same shape for HLS proxy (StreamProxy) and WebRTC/RTP (FFmpegClient). For proxies, key by `streamId`; ensure state is cleared when the process exits and, with Option 1a, when you delete the progress file.

### Option 2: Parse the default stderr progress line (no FFmpeg args)

FFmpeg already prints a line like:

```text
frame= 1234 fps= 25 q=28.0 size=    5120kB time=00:00:49.12 bitrate= 853.3kbits/s speed=1.00x
```

You can parse this with a regex in the existing `stderr.on('data')` handler (e.g. in `FFmpegClient.js` you already detect `frame=` / `fps=` for logging). Extract `frame`, `fps`, `bitrate`, `speed`, and optionally `time` and `size`, then write the same kind of `streams.*.ffmpeg` object to state.

**Pros:** No change to FFmpeg command line. **Cons:** Slightly more brittle (format can change with FFmpeg version), and you don’t get `drop_frames`/`dup_frames` or a clean `progress=end`. Good for a quick win; Option 1 is better long-term.

### Option 3: Process-level metrics (CPU, memory)

To see **CPU and memory** per FFmpeg process (not just encoding stats), use the process PID:

- When you spawn FFmpeg, you have `ffmpegProcess.pid`.
- Use a small library such as **`pidusage`** (or similar) to periodically call `pidusage(pid)` and get CPU % and memory. Only call while the process is still running; stop when the process exits.
- Throttle to every 1–2 seconds and merge with the encoding stats (Options 1 or 2) into the same `ffmpeg` object, e.g.:

```javascript
streams.inputs[i].ffmpeg = {
  // ... frame, fps, speed, bitrate, etc. ...
  cpu: 12.5,        // percent
  memory: 156 * 1024 * 1024,  // bytes (e.g. 156 MB)
  memoryRss: 120 * 1024 * 1024,
  elapsed: 45000,   // ms since process start (optional)
  updatedAt: Date.now()
}
```

This helps detect runaway CPU or memory (e.g. after SRT disconnects or misconfiguration).

### Option 4: Expose via API and/or metrics endpoint

- **REST API:** Add a route (e.g. under the existing plugin API) that returns the current `ffmpeg` stats for all active streams (e.g. list of `{ streamId, type: 'hls'|'webrtc', ffmpeg: { ... } }`). Useful for internal dashboards or health checks.
- **Structured logs:** Log a summary (e.g. every N seconds) with streamId, fps, bitrate, speed, drop_frames, cpu, memory so log aggregators can index and alert.
- **Prometheus/OpenMetrics:** If Bridge or your deployment already exposes metrics, consider a small custom collector that reads the in-memory `ffmpeg` stats and exposes gauges (e.g. `ffmpeg_fps{stream_id, type}`). This is optional and depends on your stack.

### Option 5: Reuse mediasoup stats for WebRTC preview

For the WebRTC path, **MediasoupBridge** already fetches producer and PlainTransport stats. Expose those in the same place as FFmpeg stats (e.g. same UI panel or same state path) so operators see:

- **FFmpeg:** frame, fps, speed, bitrate, drop_frames (Options 1–2), CPU/memory (Option 3).
- **Mediasoup:** bytes/packets received, RTP stats, so you can correlate “FFmpeg is sending” with “mediasoup is receiving”.

### Recommended implementation order

1. **Option 1a (file-based)** in both `StreamProxy.js` and `FFmpegClient.js`: use a dedicated `/tmp/bridge-caspar-network-ffmpeg-progress/` directory, one file per `streamId` (`<streamId>.progress`), add `-progress <path>` and `-stats_period 1`. Poll or watch each file, parse the latest report, write into shared state as `ffmpeg`; on stream remove or process exit, delete the progress file so stats stay cleanly separated.
2. **Option 3**: Add `pidusage` (or equivalent) and merge CPU/memory into the same `ffmpeg` object with a 1–2s throttle.
3. **UI**: In StreamStatus or stream list, show a compact “Process” or “Stats” section: fps, speed, bitrate, drop_frames, CPU %, memory.
4. **Option 4**: If needed, add an API route that returns current FFmpeg stats for all streams (and optionally aggregate by reading all `.progress` files in the progress dir); add logging/metrics later if you need dashboards or alerting.

### Summary

| Approach                 | What you get                     | Effort | Notes |
|-------------------------|-----------------------------------|--------|--------|
| **`-progress` file (1a)** | frame, fps, speed, bitrate, drops | Low    | One file per stream in `/tmp`; clean add/remove and aggregation. |
| `-progress pipe:2` (1b)  | Same as 1a                        | Low    | No files; progress mixed with stderr. |
| Parse stderr `frame=`    | Same, minus drop/dup frames       | Low    | No FFmpeg args; good quick win. |
| pidusage                 | CPU %, memory per process         | Low    | Complements encoding stats. |
| Shared state + UI        | Live stats in Bridge UI           | Medium | Reuse existing stream state shape. |
| API / metrics / logs     | Dashboards, alerting              | Optional | After core stats are in state. |

Fixing observability at the **cause** means: (1) getting stats from FFmpeg itself (`-progress` file or pipe, or stderr parse), and (2) attaching process-level metrics (PID) so you can see resource usage and correlate with stream health.


## Performance Considerations

1. **State Updates**: Batch state updates to reduce websocket traffic
2. **Preview Loading**: Lazy load previews, unload when not visible
3. **Stream Monitoring**: Poll status at reasonable intervals (e.g., 5s)
4. **Memory Management**: Clean up FFmpeg processes when streams stop

## Conclusion

This plan provides a comprehensive roadmap for implementing the caspar-network plugin. The plugin will integrate seamlessly with Bridge's architecture and the existing CasparCG plugin, providing users with an intuitive interface for managing SRT streams with live preview capabilities.

