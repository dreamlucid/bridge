# CasparCG Network Plugin

A Bridge plugin for managing SRT input and output streams for CasparCG.

## Features

- **SRT Input Streams**: Control PLAY commands for SRT streams on different CasparCG layers
- **SRT Output Streams**: Control ADD STREAM commands to add multiple outputs for layers
- **Stream Tracking**: Monitor and track the status of active streams
- **State Management**: Streams are synced across all connected clients

## Commands

### Input Streams

- `caspar-network.addInputStream(serverId, channel, layer, srtUrl, loop)` - Add a new input stream
- `caspar-network.removeInputStream(streamId)` - Remove an input stream
- `caspar-network.startInputStream(streamId)` - Start an input stream
- `caspar-network.stopInputStream(streamId)` - Stop an input stream

### Output Streams

- `caspar-network.addOutputStream(serverId, channel, index, srtUrl, encodingOptions)` - Add a new output stream
- `caspar-network.removeOutputStream(streamId)` - Remove an output stream
- `caspar-network.startOutputStream(streamId)` - Start an output stream
- `caspar-network.stopOutputStream(streamId)` - Stop an output stream

### Utility

- `caspar-network.listStreams()` - List all active streams
- `caspar-network.getStreamStatus(streamId)` - Get status of a specific stream

## State Structure

Streams are stored in the shared state under:

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
      },
      settings: {
        defaultEncodingOptions: { ... },
        previewEnabled: true,
        previewQuality: 'medium'
      }
    }
  }
}
```

## Dependencies

- `bridge` - Bridge API (provided at runtime)
- `uuid` - For generating stream IDs

## Requirements

- Bridge plugin system
- CasparCG plugin (for server connections)
- CasparCG server with SRT support

## Example Usage

```javascript
const bridge = require('bridge')

// Add an input stream
const inputStreamId = await bridge.commands.executeCommand(
  'caspar-network.addInputStream',
  'server-id',
  1,  // channel
  10, // layer
  'srt://localhost:9000?mode=caller&latency=2000&transtype=live',
  true // loop
)

// Start the stream
await bridge.commands.executeCommand('caspar-network.startInputStream', inputStreamId)

// Add an output stream
const outputStreamId = await bridge.commands.executeCommand(
  'caspar-network.addOutputStream',
  'server-id',
  1, // channel
  'srt://0.0.0.0:6000?mode=listener&latency=2000&transtype=live',
  {
    codec: 'h264_nvenc',
    bitrate: '6000k',
    // ... other encoding options
  }
)

// Start the output stream
await bridge.commands.executeCommand('caspar-network.startOutputStream', outputStreamId)
```

## Status

This plugin is currently in Phase 1 (Core Backend) implementation. UI components and preview features will be added in subsequent phases.

