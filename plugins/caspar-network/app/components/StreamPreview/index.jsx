// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

import React, { useEffect, useRef, useState } from 'react'
import * as mediasoupClient from 'mediasoup-client'
import bridge from 'bridge'

import './style.css'

/**
 * StreamPreview component for displaying WebRTC video streams using mediasoup (low-latency real-time preview)
 * Refactored to follow mediasoup-demo patterns
 * @param {Object} props
 * @param {string} props.streamId - Stream ID
 * @param {boolean} [props.autoPlay=true] - Auto-play the video
 * @param {boolean} [props.controls=true] - Show video controls
 * @param {boolean} [props.muted=true] - Mute video by default
 */
export const StreamPreview = ({ streamId, autoPlay = true, controls = true, muted = true }) => {
  const videoRef = useRef(null)
  const deviceRef = useRef(null)
  const recvTransportRef = useRef(null)
  const consumerRef = useRef(null)
  const wsRef = useRef(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('disconnected')

  useEffect(() => {
    if (!streamId) {
      return
    }

    let isMounted = true

    async function loadPreview () {
      try {
        setLoading(true)
        setError(null)
        setStatus('connecting')

        // Start WebRTC proxy and get signaling URL (now returns relative path)
        const signalingPath = await bridge.commands.executeCommand('caspar-network.startPreview', streamId)
        if (!isMounted) return

        // Construct full WebSocket URL from relative path using current location
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const host = window.location.host
        let finalSignalingUrl = `${protocol}//${host}${signalingPath}`

        // Add workspace ID if available and not already in URL
        const workspaceId = window.APP?.workspace
        if (workspaceId && !signalingPath.includes('workspace=')) {
          finalSignalingUrl += `&workspace=${encodeURIComponent(workspaceId)}`
        }

        // Connect to WebRTC signaling server using mediasoup
        await connectMediasoup(finalSignalingUrl)
      } catch (err) {
        if (!isMounted) return
        console.error('Error starting WebRTC preview:', err)
        setError(err.message || 'Failed to start preview')
        setLoading(false)
        setStatus('error')
      }
    }

    async function connectMediasoup (signalingUrl) {
      try {
        // Create mediasoup Device using factory (following mediasoup-demo pattern)
        const device = await mediasoupClient.Device.factory()
        deviceRef.current = device

        // Connect to signaling server
        const ws = new WebSocket(signalingUrl)
        wsRef.current = ws

        // Helper function to create consumer
        const createConsumer = () => {
          if (consumerRef.current) {
            console.log('Consumer already created')
            return
          }

          if (!recvTransportRef.current) {
            console.error('Transport not available for creating consumer')
            return
          }

          if (!device.rtpCapabilities) {
            console.error('Device RTP capabilities not available')
            return
          }

          console.log('Creating Consumer', {
            streamId,
            transportId: recvTransportRef.current.id,
            hasRtpCapabilities: !!device.rtpCapabilities,
            transportState: recvTransportRef.current.connectionState
          })
          ws.send(JSON.stringify({
            type: 'createConsumer',
            streamId,
            transportId: recvTransportRef.current.id,
            rtpCapabilities: device.rtpCapabilities
          }))
        }

        ws.onopen = () => {
          console.log('WebSocket connection opened')
          setStatus('signaling')
          // Step 1: Get router RTP capabilities
          ws.send(JSON.stringify({
            type: 'getRouterRtpCapabilities'
          }))
        }

        ws.onmessage = async (event) => {
          try {
            const data = JSON.parse(event.data)
            console.log('WebSocket message received:', data.type, {
              hasData: !!data.data,
              streamId: data.streamId || streamId
            })

            if (data.type === 'error') {
              console.error('Server error:', data.message)
              // If there's a pending connect callback, call errback
              if (recvTransportRef.current?._connectErrback) {
                recvTransportRef.current._connectErrback(new Error(data.message || 'Server error'))
                delete recvTransportRef.current._connectCallback
                delete recvTransportRef.current._connectErrback
              } else {
                setError(data.message || 'Server error')
                setLoading(false)
                setStatus('error')
              }
              return
            }

            if (data.type === 'routerRtpCapabilities') {
              // Step 2: Load device with router RTP capabilities
              await device.load({ routerRtpCapabilities: data.data })
              console.log('Device loaded with router RTP capabilities')

              // Step 3: Create WebRTC transport
              ws.send(JSON.stringify({
                type: 'createWebRtcTransport',
                streamId
              }))
            } else if (data.type === 'webRtcTransportCreated') {
              const {
                id: transportId,
                iceParameters,
                iceCandidates,
                dtlsParameters
              } = data.data

              console.log('WebRTC transport created', { transportId })

              // Step 4: Create receive transport (following mediasoup-demo pattern)
              const recvTransport = device.createRecvTransport({
                id: transportId,
                iceParameters,
                iceCandidates,
                dtlsParameters: {
                  ...dtlsParameters,
                  role: 'auto'
                }
              })
              recvTransportRef.current = recvTransport

              console.log('Receive transport created, setting up event handlers', {
                transportId: recvTransport.id,
                connectionState: recvTransport.connectionState
              })

              // Set up transport connect handler (following mediasoup-demo pattern)
              // For receive transports, this event fires when transport is ready or when first consumer is created
              recvTransport.on('connect', ({ dtlsParameters: dtlsParameters2 }, callback, errback) => {
                console.log('Transport connect event fired', {
                  hasDtlsParameters: !!dtlsParameters2,
                  transportId: recvTransport.id,
                  connectionState: recvTransport.connectionState
                })

                // Send connect request to server
                ws.send(JSON.stringify({
                  type: 'connectWebRtcTransport',
                  streamId,
                  dtlsParameters: dtlsParameters2
                }))

                // Store callback/errback to be called when response arrives
                // The response will be handled in the main onmessage handler
                recvTransport._connectCallback = callback
                recvTransport._connectErrback = errback
              })

              // For receive transports in mediasoup-client, the connect event fires when:
              // 1. Transport is ready (ICE/DTLS negotiation starts), OR
              // 2. When transport.consume() is called for the first time
              // We'll proactively try to create consumer after transport is set up
              // The connect event will fire during this process if needed
              console.log('Scheduling consumer creation', {
                transportId: recvTransport.id,
                wsReadyState: ws.readyState,
                hasRtpCapabilities: !!device.rtpCapabilities
              })

              const consumerTimeout = setTimeout(() => {
                if (!isMounted) {
                  console.log('Component unmounted, skipping consumer creation')
                  return
                }

                if (ws.readyState !== WebSocket.OPEN) {
                  let wsState = 'CLOSED'
                  if (ws.readyState === WebSocket.CONNECTING) {
                    wsState = 'CONNECTING'
                  } else if (ws.readyState === WebSocket.OPEN) {
                    wsState = 'OPEN'
                  } else if (ws.readyState === WebSocket.CLOSING) {
                    wsState = 'CLOSING'
                  }
                  console.error('WebSocket not open, cannot create consumer', {
                    readyState: ws.readyState,
                    wsState
                  })
                  return
                }

                if (!consumerRef.current && recvTransportRef.current) {
                  console.log('Attempting to create consumer', {
                    transportId: recvTransportRef.current.id,
                    transportState: recvTransportRef.current.connectionState,
                    hasRtpCapabilities: !!device.rtpCapabilities,
                    wsReadyState: ws.readyState
                  })
                  try {
                    createConsumer()
                  } catch (err) {
                    console.error('Error in createConsumer:', err)
                    setError('Failed to create consumer: ' + (err.message || 'Unknown error'))
                    setLoading(false)
                  }
                } else {
                  console.log('Skipping consumer creation', {
                    hasConsumer: !!consumerRef.current,
                    hasTransport: !!recvTransportRef.current
                  })
                }
              }, 500)

              // Store timeout for cleanup
              recvTransport._consumerTimeout = consumerTimeout

              // Monitor transport connection state changes
              recvTransport.on('connectionstatechange', (state) => {
                console.log('Transport connection state changed:', state)
                setStatus(state)

                if (state === 'failed' || state === 'disconnected') {
                  console.error(`Transport ${state}`)
                  setError(`Transport ${state} - Check firewall rules and server connectivity`)
                  setLoading(false)
                } else if (state === 'connected') {
                  console.log('Transport connected - attempting to create consumer')
                  // Fallback: Create consumer when transport becomes connected
                  // (in case connect event didn't fire or consumer wasn't created yet)
                  if (!consumerRef.current) {
                    setTimeout(() => {
                      createConsumer()
                    }, 500)
                  }
                }
              })

              // Handle transport errors
              recvTransport.on('error', (error) => {
                console.error('Transport error:', error)
                setError('Transport error: ' + (error.message || 'Unknown error'))
                setLoading(false)
                setStatus('error')
              })
            } else if (data.type === 'webRtcTransportConnected') {
              // Connection confirmed - call the connect callback
              console.log('WebRTC transport connected confirmation received')
              if (recvTransportRef.current?._connectCallback) {
                recvTransportRef.current._connectCallback()
                delete recvTransportRef.current._connectCallback
                delete recvTransportRef.current._connectErrback
                // After transport is connected, create consumer
                setTimeout(() => {
                  createConsumer()
                }, 500)
              }
            } else if (data.type === 'consumerCreated') {
              // Step 7: Consume the stream (following mediasoup-demo pattern)
              try {
                if (!recvTransportRef.current) {
                  throw new Error('Transport not available for consuming')
                }

                const consumer = await recvTransportRef.current.consume({
                  id: data.data.id,
                  producerId: data.data.producerId,
                  kind: data.data.kind,
                  rtpParameters: data.data.rtpParameters
                })

                console.log('Consumer created successfully', {
                  consumerId: consumer.id,
                  kind: consumer.kind,
                  producerId: consumer.producerId,
                  paused: consumer.paused,
                  trackId: consumer.track?.id,
                  trackKind: consumer.track?.kind,
                  trackEnabled: consumer.track?.enabled,
                  trackMuted: consumer.track?.muted,
                  trackReadyState: consumer.track?.readyState,
                  rtpParameters: consumer.rtpParameters
                })

                consumerRef.current = consumer

                // Log track details
                const track = consumer.track
                console.log('Consumer track details', {
                  id: track.id,
                  kind: track.kind,
                  enabled: track.enabled,
                  muted: track.muted,
                  readyState: track.readyState,
                  settings: track.getSettings ? track.getSettings() : 'N/A',
                  constraints: track.getConstraints ? track.getConstraints() : 'N/A'
                })

                // Create MediaStream from consumer track
                const stream = new MediaStream([track])
                console.log('MediaStream created', {
                  id: stream.id,
                  active: stream.active,
                  tracks: stream.getTracks().map(t => ({
                    id: t.id,
                    kind: t.kind,
                    enabled: t.enabled,
                    muted: t.muted,
                    readyState: t.readyState
                  }))
                })

                // Set video srcObject
                if (videoRef.current) {
                  const video = videoRef.current
                  video.srcObject = stream
                  setStatus('connected')
                  setLoading(false)

                  // Add video element event listeners for debugging
                  const logVideoEvent = (eventName) => {
                    const srcObjectInfo = video.srcObject
                      ? {
                          id: video.srcObject.id,
                          active: video.srcObject.active,
                          tracks: video.srcObject.getTracks().map(t => ({
                            id: t.id,
                            kind: t.kind,
                            enabled: t.enabled,
                            muted: t.muted,
                            readyState: t.readyState
                          }))
                        }
                      : null

                    console.log(`Video element event: ${eventName}`, {
                      readyState: video.readyState,
                      paused: video.paused,
                      ended: video.ended,
                      currentTime: video.currentTime,
                      duration: video.duration,
                      videoWidth: video.videoWidth,
                      videoHeight: video.videoHeight,
                      srcObject: srcObjectInfo
                    })
                  }

                  video.addEventListener('loadstart', () => logVideoEvent('loadstart'))
                  video.addEventListener('loadedmetadata', () => logVideoEvent('loadedmetadata'))
                  video.addEventListener('loadeddata', () => logVideoEvent('loadeddata'))
                  video.addEventListener('canplay', () => logVideoEvent('canplay'))
                  video.addEventListener('canplaythrough', () => logVideoEvent('canplaythrough'))
                  video.addEventListener('playing', () => logVideoEvent('playing'))
                  video.addEventListener('play', () => logVideoEvent('play'))
                  video.addEventListener('pause', () => logVideoEvent('pause'))
                  video.addEventListener('ended', () => logVideoEvent('ended'))
                  video.addEventListener('error', (e) => {
                    console.error('Video element error:', {
                      error: e,
                      errorCode: video.error?.code,
                      errorMessage: video.error?.message,
                      readyState: video.readyState
                    })
                  })

                  // Monitor track state changes
                  track.addEventListener('mute', () => {
                    console.warn('Track muted', {
                      trackId: track.id,
                      enabled: track.enabled,
                      muted: track.muted,
                      readyState: track.readyState
                    })
                    // Check if track was muted due to no data
                    setTimeout(async () => {
                      try {
                        const stats = await consumer.getStats()
                        console.warn('Consumer stats when track muted', {
                          consumerId: consumer.id,
                          stats: Array.from(stats.entries()).map(([id, report]) => ({
                            id,
                            type: report.type,
                            ...Object.fromEntries(
                              Object.entries(report).filter(([key]) => !['type', 'id', 'timestamp'].includes(key))
                            )
                          }))
                        })
                      } catch (err) {
                        console.error('Failed to get stats when muted:', err)
                      }
                    }, 1000)
                  })
                  track.addEventListener('unmute', () => {
                    console.log('Track unmuted', {
                      trackId: track.id,
                      enabled: track.enabled,
                      muted: track.muted,
                      readyState: track.readyState
                    })
                  })
                  track.addEventListener('ended', () => {
                    console.warn('Track ended', { trackId: track.id })
                  })

                  // Check consumer statistics periodically
                  const checkStats = async () => {
                    try {
                      const stats = await consumer.getStats()
                      const statsArray = Array.from(stats.entries()).map(([id, report]) => ({
                        id,
                        type: report.type,
                        timestamp: report.timestamp,
                        ...Object.fromEntries(
                          Object.entries(report).filter(([key]) => !['type', 'id', 'timestamp'].includes(key))
                        )
                      }))

                      console.log('Consumer statistics', {
                        consumerId: consumer.id,
                        paused: consumer.paused,
                        trackEnabled: track.enabled,
                        trackMuted: track.muted,
                        trackReadyState: track.readyState,
                        stats: statsArray
                      })

                      // Check if we're receiving any data
                      const inboundRtpStats = statsArray.find(s => s.type === 'inbound-rtp')
                      if (inboundRtpStats) {
                        console.log('Inbound RTP stats', {
                          bytesReceived: inboundRtpStats.bytesReceived || 0,
                          packetsReceived: inboundRtpStats.packetsReceived || 0,
                          framesDecoded: inboundRtpStats.framesDecoded || 0,
                          framesDropped: inboundRtpStats.framesDropped || 0,
                          jitter: inboundRtpStats.jitter || 0
                        })

                        // If no packets received, the producer might not be sending
                        if (!inboundRtpStats.packetsReceived || inboundRtpStats.packetsReceived === 0) {
                          console.error('No packets received from producer!', {
                            consumerId: consumer.id,
                            producerId: consumer.producerId
                          })
                        }
                      } else {
                        console.warn('No inbound-rtp stats found - consumer may not be receiving data')
                      }
                    } catch (err) {
                      console.warn('Failed to get consumer stats:', err)
                    }
                  }

                  // Check stats after a delay to see if data is flowing
                  setTimeout(() => {
                    checkStats()
                    // Check again after 2 seconds
                    setTimeout(checkStats, 2000)
                    // Check again after 5 seconds
                    setTimeout(checkStats, 5000)
                  }, 1000)

                  // Try to play video
                  if (autoPlay) {
                    video.play().then(() => {
                      console.log('Video playback started successfully', {
                        readyState: video.readyState,
                        paused: video.paused,
                        videoWidth: video.videoWidth,
                        videoHeight: video.videoHeight,
                        currentTime: video.currentTime
                      })
                      // Check if video is actually playing after a moment
                      setTimeout(() => {
                        console.log('Video playback check after 1s', {
                          readyState: video.readyState,
                          paused: video.paused,
                          ended: video.ended,
                          currentTime: video.currentTime,
                          videoWidth: video.videoWidth,
                          videoHeight: video.videoHeight,
                          trackEnabled: track.enabled,
                          trackMuted: track.muted,
                          trackReadyState: track.readyState
                        })
                        if (video.videoWidth === 0 && video.videoHeight === 0) {
                          console.warn('Video dimensions are 0x0 - no video data received')
                        }
                      }, 1000)
                    }).catch(err => {
                      console.error('Error playing video:', err)
                      setError('Autoplay blocked. Click play to start.')
                      setLoading(false)
                    })
                  } else {
                    console.log('Autoplay disabled, waiting for user interaction')
                  }
                } else {
                  console.error('Video element ref not available')
                  setError('Video element not available')
                  setLoading(false)
                }

                // Handle consumer events
                consumer.on('transportclose', () => {
                  console.log('Consumer transport closed')
                  setStatus('disconnected')
                  setLoading(false)
                })

                consumer.on('producerclose', () => {
                  console.log('Consumer producer closed')
                  setStatus('disconnected')
                  setLoading(false)
                })

                consumer.track.onended = () => {
                  console.log('Consumer track ended')
                  setStatus('disconnected')
                  setLoading(false)
                }
              } catch (err) {
                console.error('Error consuming stream:', err)
                setError('Failed to consume stream: ' + (err.message || 'Unknown error'))
                setLoading(false)
                setStatus('error')
              }
            }
          } catch (err) {
            console.error('Error handling signaling message:', err)
            setError('Signaling error: ' + (err.message || 'Unknown error'))
            setLoading(false)
          }
        }

        ws.onerror = (err) => {
          console.error('WebSocket error:', err)
          setError('WebSocket connection error')
          setLoading(false)
          setStatus('error')
        }

        ws.onclose = (event) => {
          console.log('WebSocket closed', {
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean
          })
          if (isMounted) {
            setStatus('disconnected')
          }
          cleanup()
        }
      } catch (err) {
        console.error('Mediasoup connection error:', err)
        setError(err.message || 'Failed to connect')
        setLoading(false)
        setStatus('error')
      }
    }

    function cleanup () {
      // Clear any pending timeouts
      if (recvTransportRef.current?._consumerTimeout) {
        clearTimeout(recvTransportRef.current._consumerTimeout)
        delete recvTransportRef.current._consumerTimeout
      }

      if (consumerRef.current) {
        consumerRef.current.close()
        consumerRef.current = null
      }
      if (recvTransportRef.current) {
        recvTransportRef.current.close()
        recvTransportRef.current = null
      }
      if (deviceRef.current) {
        deviceRef.current = null
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

    loadPreview()

    return () => {
      isMounted = false
      cleanup()
      // Stop preview when component unmounts
      if (streamId) {
        bridge.commands.executeCommand('caspar-network.stopPreview', streamId).catch(err => {
          console.error('Error stopping preview:', err)
        })
      }
    }
  }, [streamId, autoPlay])

  if (error) {
    return (
      <div className='StreamPreview StreamPreview--error'>
        <div className='StreamPreview-error'>{error}</div>
        {status && <div className='StreamPreview-status'>Status: {status}</div>}
      </div>
    )
  }

  return (
    <div className='StreamPreview'>
      {loading && (
        <div className='StreamPreview-loading'>
          <div className='StreamPreview-spinner' />
          <div>Connecting to stream... ({status})</div>
        </div>
      )}
      <video
        ref={videoRef}
        className='StreamPreview-video'
        controls={controls}
        autoPlay={autoPlay}
        muted={muted}
        playsInline
      />
      {status !== 'connected' && status !== 'disconnected' && (
        <div className='StreamPreview-status'>Status: {status}</div>
      )}
    </div>
  )
}
