// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const http = require('http')
const { RTCPeerConnection, RTCSessionDescription } = require('wrtc')
const Logger = require('../../../lib/Logger')
const logger = new Logger({ name: 'CasparNetworkPlugin' })

/**
 * WHIP (WebRTC-HTTP Ingest Protocol) Server
 * Receives WHIP offers from FFmpeg and bridges to browser WebRTC
 *
 * Architecture:
 * FFmpeg → WHIP POST → WHIPServer → Server-side PeerConnection (FFmpeg)
 * Browser → WebSocket → WebRTCProxy → Server-side PeerConnection (Browser)
 * WHIPServer bridges the two PeerConnections
 */
class WHIPServer {
  constructor (port = 8080) {
    this.port = port
    this.server = null
    /** @type {Map<string, {ffmpegPC: RTCPeerConnection, browserPC: RTCPeerConnection | null, streamId: string}>} */
    this.activeStreams = new Map()
  }

  /**
   * Start the WHIP HTTP server
   * @returns {Promise<number>} Port number
   */
  async start () {
    if (this.server) {
      logger.debug('WHIP server already running', { port: this.port })
      return this.port
    }

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res)
    })

    return new Promise((resolve, reject) => {
      this.server.listen(this.port, '0.0.0.0', () => {
        const address = this.server.address()
        this.port = address.port
        logger.info('WHIP server started', { port: this.port })
        resolve(this.port)
      })

      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          logger.warn('WHIP server port already in use', { port: this.port })
          // Try to continue anyway - might be from previous instance
          resolve(this.port)
        } else {
          logger.error('WHIP server error', { error: err.message })
          reject(err)
        }
      })
    })
  }

  /**
   * Handle HTTP request
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  async handleRequest (req, res) {
    // Parse URL: /whip/:streamId
    const url = new URL(req.url, `http://${req.headers.host}`)
    const pathParts = url.pathname.split('/').filter(p => p)

    if (pathParts.length !== 2 || pathParts[0] !== 'whip') {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not Found')
      return
    }

    const streamId = pathParts[1]

    if (req.method === 'POST') {
      // FFmpeg sends WHIP offer
      await this.handleWHIPOffer(req, res, streamId)
    } else if (req.method === 'OPTIONS') {
      // CORS preflight
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      })
      res.end()
    } else {
      res.writeHead(405, { 'Content-Type': 'text/plain' })
      res.end('Method Not Allowed')
    }
  }

  /**
   * Handle WHIP offer from FFmpeg
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {string} streamId
   */
  async handleWHIPOffer (req, res, streamId) {
    try {
      // Read offer SDP from request body
      let body = ''
      req.on('data', (chunk) => {
        body += chunk.toString()
      })

      req.on('end', async () => {
        try {
          const offerSDP = body.trim()

          if (!offerSDP) {
            res.writeHead(400, { 'Content-Type': 'text/plain' })
            res.end('Bad Request: No SDP offer')
            return
          }

          logger.debug('Received WHIP offer from FFmpeg', { streamId, sdpLength: offerSDP.length })

          // Create server-side PeerConnection for FFmpeg
          const ffmpegPC = new RTCPeerConnection({
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' }
            ]
          })

          // Set up event handlers
          ffmpegPC.onicecandidate = (event) => {
            if (event.candidate) {
              logger.debug('FFmpeg ICE candidate', { streamId, candidate: event.candidate.candidate })
            }
          }

          ffmpegPC.oniceconnectionstatechange = () => {
            logger.debug('FFmpeg ICE connection state', {
              streamId,
              state: ffmpegPC.iceConnectionState
            })
          }

          ffmpegPC.onconnectionstatechange = () => {
            logger.debug('FFmpeg connection state', {
              streamId,
              state: ffmpegPC.connectionState
            })
          }

          // Handle incoming tracks from FFmpeg
          ffmpegPC.ontrack = (event) => {
            logger.info('Received track from FFmpeg', {
              streamId,
              kind: event.track.kind,
              id: event.track.id
            })

            // Forward track to browser PeerConnection if it exists
            const stream = this.activeStreams.get(streamId)
            if (stream && stream.browserPC) {
              this.forwardTrackToBrowser(streamId, event.track, event.streams)
            }
          }

          // Set remote description (FFmpeg's offer)
          const offer = new RTCSessionDescription({
            type: 'offer',
            sdp: offerSDP
          })

          await ffmpegPC.setRemoteDescription(offer)
          logger.debug('Set remote description for FFmpeg', { streamId })

          // Create answer
          const answer = await ffmpegPC.createAnswer()
          await ffmpegPC.setLocalDescription(answer)

          logger.info('Created WHIP answer for FFmpeg', {
            streamId,
            answerType: answer.type
          })

          // Store PeerConnection for this stream
          this.activeStreams.set(streamId, {
            ffmpegPC,
            browserPC: null, // Will be set when browser connects
            streamId
          })

          // Send answer to FFmpeg (WHIP response)
          res.writeHead(201, {
            'Content-Type': 'application/sdp',
            // eslint-disable-next-line quote-props
            'Location': `/whip/${streamId}`,
            'Access-Control-Allow-Origin': '*'
          })
          res.end(answer.sdp)
        } catch (err) {
          logger.error('Error handling WHIP offer', {
            streamId,
            error: err.message,
            stack: err.stack
          })
          res.writeHead(500, { 'Content-Type': 'text/plain' })
          res.end(`Internal Server Error: ${err.message}`)
        }
      })
    } catch (err) {
      logger.error('Error in WHIP offer handler', {
        streamId,
        error: err.message
      })
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end(`Internal Server Error: ${err.message}`)
    }
  }

  /**
   * Forward a track from FFmpeg to browser
   * @param {string} streamId
   * @param {MediaStreamTrack} track
   * @param {MediaStream[]} streams
   */
  forwardTrackToBrowser (streamId, track, streams) {
    const stream = this.activeStreams.get(streamId)
    if (!stream || !stream.browserPC) {
      return
    }

    try {
      // Create transceiver for the track kind
      const transceiver = stream.browserPC.addTransceiver(track.kind, {
        direction: 'sendrecv'
      })

      // Replace the sender's track with FFmpeg's track
      if (transceiver.sender && transceiver.sender.replaceTrack) {
        transceiver.sender.replaceTrack(track)
        logger.debug('Forwarded track to browser via transceiver', {
          streamId,
          kind: track.kind,
          id: track.id
        })
      } else {
        // Fallback: add track directly
        stream.browserPC.addTrack(track, streams && streams[0])
        logger.debug('Forwarded track to browser directly', {
          streamId,
          kind: track.kind
        })
      }
    } catch (err) {
      logger.warn('Error forwarding track to browser', {
        streamId,
        kind: track.kind,
        error: err.message
      })
    }
  }

  /**
   * Set browser PeerConnection for a stream
   * This bridges FFmpeg's stream to the browser using transceivers
   * @param {string} streamId
   * @param {RTCPeerConnection} browserPC
   */
  setBrowserPeerConnection (streamId, browserPC) {
    const stream = this.activeStreams.get(streamId)
    if (!stream) {
      logger.warn('Cannot set browser PC: stream not found', { streamId })
      return
    }

    stream.browserPC = browserPC

    // Forward any existing tracks from FFmpeg to browser
    const ffmpegPC = stream.ffmpegPC
    if (ffmpegPC && ffmpegPC.getReceivers) {
      const receivers = ffmpegPC.getReceivers()
      receivers.forEach((receiver) => {
        if (receiver.track) {
          this.forwardTrackToBrowser(streamId, receiver.track, [])
        }
      })
    }

    // Update ontrack handler to forward new tracks
    ffmpegPC.ontrack = (event) => {
      if (event.track) {
        this.forwardTrackToBrowser(streamId, event.track, event.streams)
      }
    }

    logger.debug('Set browser PeerConnection for stream', { streamId })
  }

  /**
   * Get FFmpeg PeerConnection for a stream
   * @param {string} streamId
   * @returns {RTCPeerConnection|null}
   */
  getFFmpegPeerConnection (streamId) {
    const stream = this.activeStreams.get(streamId)
    return stream ? stream.ffmpegPC : null
  }

  /**
   * Remove stream and cleanup
   * @param {string} streamId
   */
  async removeStream (streamId) {
    const stream = this.activeStreams.get(streamId)
    if (!stream) {
      return
    }

    logger.debug('Removing WHIP stream', { streamId })

    // Close FFmpeg PeerConnection
    if (stream.ffmpegPC) {
      try {
        stream.ffmpegPC.close()
      } catch (err) {
        logger.warn('Error closing FFmpeg PeerConnection', {
          streamId,
          error: err.message
        })
      }
    }

    // Browser PeerConnection is closed by WebRTCProxy
    // We just remove the reference here

    this.activeStreams.delete(streamId)
    logger.debug('Removed WHIP stream', { streamId })
  }

  /**
   * Stop the WHIP server
   */
  async stop () {
    // Close all streams
    for (const streamId of this.activeStreams.keys()) {
      await this.removeStream(streamId)
    }

    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => {
          this.server = null
          logger.info('WHIP server stopped')
          resolve()
        })
      })
    }
  }

  /**
   * Get server port
   * @returns {number}
   */
  getPort () {
    return this.port
  }

  /**
   * Check if stream exists
   * @param {string} streamId
   * @returns {boolean}
   */
  hasStream (streamId) {
    return this.activeStreams.has(streamId)
  }
}

module.exports = WHIPServer
