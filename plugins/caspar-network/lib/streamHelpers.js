// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

/**
 * @type { import('../../api').Api }
 */
const bridge = require('bridge')

const manifest = require('../package.json')
const paths = require('./paths')
const AMCP = require('./AMCP')

const { XMLParser } = require('fast-xml-parser')
const Logger = require('../../../lib/Logger')
const logger = new Logger({ name: 'CasparNetworkPlugin' })

// Get singleton stream manager instance
const streamManager = require('./streamManagerInstance')

/**
 * Get stream configuration from state
 * @param { String } streamId - Stream ID
 * @returns { Promise<Object | null> }
 */
async function getStreamConfig (streamId) {
  const streams = await bridge.state.get(paths.STATE_STREAMS_PATH) || { inputs: [], outputs: [] }

  const inputStream = streams.inputs?.find(s => s.id === streamId)
  if (inputStream) {
    return { type: 'input', ...inputStream }
  }

  const outputStream = streams.outputs?.find(s => s.id === streamId)
  if (outputStream) {
    return { type: 'output', ...outputStream }
  }

  return null
}

/**
 * Sync stream manager with state
 */
async function syncStreamManagerWithState () {
  const streams = await bridge.state.get(paths.STATE_STREAMS_PATH) || { inputs: [], outputs: [], channelPreviews: [] }

  // Clear current streams
  streamManager.inputStreams.clear()
  streamManager.outputStreams.clear()
  streamManager.channelPreviews.clear()

  // Rebuild from state
  if (streams.inputs) {
    streams.inputs.forEach(stream => {
      streamManager.inputStreams.set(stream.id, stream)
    })
  }

  if (streams.outputs) {
    streams.outputs.forEach(stream => {
      streamManager.outputStreams.set(stream.id, stream)
    })
  }

  if (streams.channelPreviews && Array.isArray(streams.channelPreviews)) {
    streams.channelPreviews.forEach(entry => {
      streamManager.channelPreviews.set(entry.channelKey, entry)
    })
  }
}

/**
 * Extract stream index from CasparCG ADD STREAM response
 * Format: "202 ADD {channel} STREAM {index} OK" or "202 ADD {channel} STREAM OK"
 * @param { String | Array } responseData - Response data from ADD command
 * @param { Number } channel - Channel number for validation
 * @returns { Number | null } Stream index if found
 */
function extractStreamIndexFromAddResponse (responseData, channel) {
  if (!responseData) {
    return null
  }

  // Handle both array and string responses
  let dataStr = ''
  if (Array.isArray(responseData)) {
    // Join array elements, handling both single-line and multi-line responses
    dataStr = responseData.join(' ').trim()
  } else {
    dataStr = responseData.toString().trim()
  }
  // Pattern 1: "202 ADD 1 STREAM 0 OK" - stream index is the number after STREAM
  // Pattern 2: "202 ADD 1 STREAM OK" - no index in response, might need to query
  // Pattern 3: "ADD 1 STREAM 0" - without status code prefix
  // Pattern 4: Response might be in data array as separate elements

  // Try to match: ADD {channel} STREAM {index}
  // Be flexible with whitespace
  const patterns = [
    new RegExp(`ADD\\s+${channel}\\s+STREAM\\s+(\\d+)`, 'i'),
    new RegExp(`ADD\\s+${channel}\\s+STREAM\\s+OK`, 'i'), // No index in response
    /ADD\s+STREAM\s+(\d+)/i,
    /STREAM\s+(\d+)/i,
    // Also try to find just a number after STREAM anywhere
    /STREAM[^\d]*(\d+)/i
  ]

  for (const pattern of patterns) {
    const match = dataStr.match(pattern)
    if (match && match[1]) {
      const streamIndex = parseInt(match[1], 10)
      if (!isNaN(streamIndex)) {
        logger.debug('Extracted stream index from ADD response', { channel, streamIndex, responseData: dataStr })
        return streamIndex
      }
    }
  }

  logger.debug('Could not extract stream index from ADD response', { channel, responseData: dataStr, dataType: typeof responseData })
  return null
}

/**
 * Extract stream index from CasparCG INFO response
 * @param { String | Array } responseData - Response data from INFO command
 * @param { String } srtUrl - SRT URL to match (optional, for validation)
 * @returns { Number | null } Stream index if found
 */
function extractStreamIndexFromInfo (responseData, srtUrl = null) {
  if (!responseData) {
    return null
  }

  const dataStr = Array.isArray(responseData) ? responseData.join('\n') : responseData.toString()

  // First, try to parse as XML if it looks like XML
  if (dataStr.trim().startsWith('<?xml') || dataStr.trim().startsWith('<')) {
    try {
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        textNodeName: '#text',
        parseAttributeValue: true,
        trimValues: true
      })

      const parsed = parser.parse(dataStr)

      // Navigate to channel.output.port structure
      // The XML structure is: <channel><output><port><port_123012>...</port_123012></port></output></channel>
      const channel = parsed.channel
      if (channel && channel.output && channel.output.port) {
        const port = channel.output.port

        // The port element contains dynamically named children like port_123012
        // We need to find the one that matches our SRT URL
        const portKeys = Object.keys(port)
        for (const portKey of portKeys) {
          // Extract stream index from port name (e.g., "port_123012" -> 123012)
          const portIndexMatch = portKey.match(/^port[_-]?(\d+)$/i)
          if (portIndexMatch) {
            const portData = port[portKey]

            // Check if this port contains the matching SRT URL
            if (srtUrl) {
              const path = portData?.file?.path || portData?.path

              if (path) {
                // Normalize both URLs for comparison
                // XML parser should decode &amp; to &, but handle both cases
                const normalizedPath = path.replace(/&amp;/g, '&')
                const normalizedSrtUrl = srtUrl.replace(/&amp;/g, '&')

                // Compare base URLs (before query params) and optionally full URLs
                const pathBase = normalizedPath.split('?')[0]
                const srtUrlBase = normalizedSrtUrl.split('?')[0]

                // Match if base URLs match (host:port) or full URLs match
                if (pathBase === srtUrlBase || normalizedPath === normalizedSrtUrl || pathBase.includes(srtUrlBase) || srtUrlBase.includes(pathBase)) {
                  const streamIndex = parseInt(portIndexMatch[1], 10)
                  logger.debug('Extracted stream index from XML INFO response', {
                    streamIndex,
                    portKey,
                    srtUrl: normalizedSrtUrl,
                    path: normalizedPath
                  })
                  return streamIndex
                }
              }
            } else {
              // No SRT URL provided, return first port index found
              const streamIndex = parseInt(portIndexMatch[1], 10)
              logger.debug('Extracted stream index from XML INFO response (no URL validation)', {
                streamIndex,
                portKey
              })
              return streamIndex
            }
          }
        }
      }

      // Also check for direct stream elements in the XML
      // Some CasparCG versions might have <stream index="..."> elements
      if (channel && channel.stream) {
        const streams = Array.isArray(channel.stream) ? channel.stream : [channel.stream]
        for (const stream of streams) {
          if (stream['@_index'] !== undefined) {
            const streamIndex = parseInt(stream['@_index'], 10)
            if (srtUrl) {
              // Validate with SRT URL if provided
              const path = stream.path || stream.file?.path
              if (path) {
                // Normalize both URLs for comparison
                const normalizedPath = path.replace(/&amp;/g, '&')
                const normalizedSrtUrl = srtUrl.replace(/&amp;/g, '&')
                const pathBase = normalizedPath.split('?')[0]
                const srtUrlBase = normalizedSrtUrl.split('?')[0]

                if (pathBase === srtUrlBase || normalizedPath === normalizedSrtUrl || pathBase.includes(srtUrlBase) || srtUrlBase.includes(pathBase)) {
                  logger.debug('Extracted stream index from XML stream element', { streamIndex, srtUrl: normalizedSrtUrl, path: normalizedPath })
                  return streamIndex
                }
              }
            } else {
              return streamIndex
            }
          }
        }
      }
    } catch (err) {
      logger.debug('Failed to parse XML response, falling back to regex patterns', {
        error: err.message,
        responseData: dataStr.substring(0, 200)
      })
      // Fall through to regex patterns below
    }
  }

  // Fallback: Try regex patterns for non-XML or malformed XML responses
  // Pattern 1: "STREAM 0" or "STREAM: 0" or "STREAM 0:"
  const match = dataStr.match(/STREAM[:\s]+(\d+)/i)
  if (match) {
    const streamIndex = parseInt(match[1], 10)
    // If we have an SRT URL, try to validate by checking if the URL appears near the stream index
    if (srtUrl) {
      // Extract host/port from SRT URL for matching
      try {
        const urlMatch = srtUrl.match(/srt:\/\/([^?]+)/)
        if (urlMatch) {
          const urlPart = urlMatch[1]
          // Check if this URL part appears in the response near the stream index
          const streamSection = dataStr.substring(Math.max(0, match.index - 500), match.index + 500)
          if (streamSection.includes(urlPart)) {
            return streamIndex
          }
        }
      } catch (err) {
        // If URL parsing fails, just return the first match
        logger.debug('Could not parse SRT URL for validation', { srtUrl, error: err.message })
      }
    }
    return streamIndex
  }

  logger.debug('Could not extract stream index from INFO response', { responseData: dataStr.substring(0, 500), dataType: typeof responseData })
  return null
}

/**
 * Get stream index from CasparCG by querying channel info
 * @param { Object } stream - Stream configuration
 * @returns { Promise<Number | null> } Stream index if found
 */
async function getStreamIndexFromCasparCG (stream) {
  try {
    // Query CasparCG for channel info
    const infoCommand = AMCP.info({ channel: stream.channel })
    const response = await bridge.commands.executeCommand('caspar.sendString', stream.serverId, infoCommand)

    const responseCode = typeof response?.code === 'string' ? parseInt(response.code, 10) : response?.code
    if (response && (responseCode === 200 || responseCode === 201) && response.data) {
      const streamIndex = extractStreamIndexFromInfo(response.data, stream.srtUrl)
      if (streamIndex != null) {
        logger.debug('Retrieved stream index from CasparCG INFO', { streamId: stream.id, streamIndex })
        // Update the stream with the found index
        streamManager.setOutputStreamIndex(stream.id, streamIndex)
        // Also update state
        const currentStreams = await bridge.state.get(paths.STATE_STREAMS_PATH) || { inputs: [], outputs: [] }
        const updatedOutputs = (currentStreams.outputs || []).map(s => {
          if (s.id === stream.id) {
            return { ...s, streamIndex }
          }
          return s
        })
        bridge.state.apply({
          plugins: {
            [manifest.name]: {
              streams: {
                outputs: { $replace: updatedOutputs }
              }
            }
          }
        })
        return streamIndex
      }
    }
    return null
  } catch (err) {
    logger.warn('Error querying CasparCG for stream index', { streamId: stream.id, error: err.message })
    return null
  }
}

module.exports = {
  getStreamConfig,
  syncStreamManagerWithState,
  extractStreamIndexFromAddResponse,
  extractStreamIndexFromInfo,
  getStreamIndexFromCasparCG
}
