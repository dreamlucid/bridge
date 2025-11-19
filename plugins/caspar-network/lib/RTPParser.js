// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const Logger = require('../../../lib/Logger')
const logger = new Logger({ name: 'CasparNetworkPlugin' })

/**
 * Parses RTP packets and extracts payload
 * RTP packet structure (RFC 3550):
 *  0                   1                   2                   3
 *  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |V=2|P|X|  CC   |M|     PT      |       sequence number         |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |                           timestamp                             |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |           synchronization source (SSRC) identifier              |
 * +=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+
 * |            contributing source (CSRC) identifiers               |
 * |                             ....                                |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 */
class RTPParser {
  constructor () {
    this.lastSequenceNumber = null
    this.packetsReceived = 0
    this.packetsLost = 0
  }

  /**
   * Parse RTP packet
   * @param {Buffer} packet - Raw RTP packet
   * @returns {Object|null} Parsed RTP packet info or null if invalid
   */
  parse (packet) {
    if (packet.length < 12) {
      logger.warn('RTP packet too short', { length: packet.length })
      return null
    }

    try {
      // Parse RTP header (first 12 bytes are fixed header)
      const version = (packet[0] >> 6) & 0x03
      if (version !== 2) {
        logger.warn('Invalid RTP version', { version })
        return null
      }

      const padding = (packet[0] >> 5) & 0x01
      const extension = (packet[0] >> 4) & 0x01
      const csrcCount = packet[0] & 0x0F
      const marker = (packet[1] >> 7) & 0x01
      const payloadType = packet[1] & 0x7F

      // Sequence number (16 bits)
      const sequenceNumber = packet.readUInt16BE(2)

      // Timestamp (32 bits)
      const timestamp = packet.readUInt32BE(4)

      // SSRC (32 bits)
      const ssrc = packet.readUInt32BE(8)

      // Calculate header length
      // Fixed header: 12 bytes
      // CSRC list: csrcCount * 4 bytes
      // Extension header: variable (if extension bit is set)
      let headerLength = 12 + (csrcCount * 4)

      // Handle extension header
      if (extension) {
        if (packet.length < headerLength + 4) {
          logger.warn('RTP packet too short for extension header', { length: packet.length, headerLength })
          return null
        }
        // Extension header: 2 bytes length + variable data
        const extensionLength = packet.readUInt16BE(headerLength + 2) * 4
        headerLength += 4 + extensionLength
      }

      // Extract payload
      const payload = packet.slice(headerLength)

      // Track sequence numbers for loss detection
      if (this.lastSequenceNumber !== null) {
        const expected = (this.lastSequenceNumber + 1) % 65536
        if (sequenceNumber !== expected) {
          const lost = (sequenceNumber - expected + 65536) % 65536
          this.packetsLost += lost
          if (lost > 0) {
            logger.debug('RTP packets lost', {
              expected,
              received: sequenceNumber,
              lost,
              totalLost: this.packetsLost
            })
          }
        }
      }
      this.lastSequenceNumber = sequenceNumber
      this.packetsReceived++

      return {
        version,
        padding,
        extension,
        csrcCount,
        marker,
        payloadType,
        sequenceNumber,
        timestamp,
        ssrc,
        headerLength,
        payload,
        payloadLength: payload.length
      }
    } catch (err) {
      logger.error('Error parsing RTP packet', { error: err.message })
      return null
    }
  }

  /**
   * Get statistics
   */
  getStats () {
    return {
      packetsReceived: this.packetsReceived,
      packetsLost: this.packetsLost,
      lastSequenceNumber: this.lastSequenceNumber,
      lossRate: this.packetsReceived > 0
        ? (this.packetsLost / (this.packetsReceived + this.packetsLost)) * 100
        : 0
    }
  }

  /**
   * Reset statistics
   */
  reset () {
    this.lastSequenceNumber = null
    this.packetsReceived = 0
    this.packetsLost = 0
  }
}

module.exports = RTPParser
