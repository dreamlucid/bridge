// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

import React, { useEffect, useRef, useState } from 'react'
import * as mediasoupClient from 'mediasoup-client'
import bridge from 'bridge'

import './style.css'

/**
 * StreamPreview component for displaying WebRTC video streams using mediasoup (low-latency real-time preview)
 * @param {Object} props
 * @param {string} props.streamId - Stream ID
 * @param {boolean} [props.autoPlay=true] - Auto-play the video
 * @param {boolean} [props.controls=true] - Show video controls
 * @param {boolean} [props.muted=true] - Mute video by default
 */
export const StreamPreview = ({ streamId, autoPlay = true, controls = true, muted = true }) => {
  const videoRef = useRef(null)
  const deviceRef = useRef(null)
  const transportRef = useRef(null)
  const consumerRef = useRef(null)
  const wsRef = useRef(null)
  const trackTimeoutRef = useRef(null)
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
        // signalingPath is like: /api/v1/webrtc?streamId=...
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const host = window.location.host
        const finalSignalingUrl = `${protocol}//${host}${signalingPath}`

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
      // Store transport connection promise resolver (accessible in onmessage)
      let transportConnectResolver = null
      let transportConnectRejecter = null

      try {
        // Create mediasoup Device
        const device = new mediasoupClient.Device()
        deviceRef.current = device

        // Connect to signaling server
        const ws = new WebSocket(signalingUrl)
        wsRef.current = ws

        ws.onopen = async () => {
          setStatus('signaling')
          try {
            // Step 1: Get router RTP capabilities
            ws.send(JSON.stringify({
              type: 'getRouterRtpCapabilities'
            }))
          } catch (err) {
            console.error('Error in WebSocket onopen:', err)
            setError('Failed to initialize connection')
            setLoading(false)
            setStatus('error')
          }
        }

        ws.onmessage = async (event) => {
          try {
            const data = JSON.parse(event.data)

            if (data.type === 'error') {
              console.error('Server error:', data.message)
              setError(data.message || 'Server error')
              setLoading(false)
              setStatus('error')
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
              // Step 4: Create receive transport
              const transport = device.createRecvTransport(data.data)
              transportRef.current = transport

              transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
                try {
                  // Step 5: Connect transport
                  // Set up promise to wait for connection confirmation
                  const connectPromise = new Promise((resolve, reject) => {
                    transportConnectResolver = resolve
                    transportConnectRejecter = reject
                  })

                  ws.send(JSON.stringify({
                    type: 'connectWebRtcTransport',
                    streamId,
                    dtlsParameters
                  }))

                  // Wait for connection confirmation (handled in onmessage)
                  await connectPromise
                  callback()
                } catch (err) {
                  if (transportConnectRejecter) {
                    transportConnectRejecter(err)
                    transportConnectResolver = null
                    transportConnectRejecter = null
                  }
                  errback(err)
                }
              })

              transport.on('connectionstatechange', (state) => {
                console.log('Transport connection state:', state)
                setStatus(state)
                if (state === 'failed' || state === 'disconnected') {
                  setError(`Transport ${state}`)
                  setLoading(false)
                } else if (state === 'connected') {
                  // Step 6: Create consumer after transport is connected
                  ws.send(JSON.stringify({
                    type: 'createConsumer',
                    streamId,
                    transportId: data.data.id,
                    rtpCapabilities: device.rtpCapabilities
                  }))
                }
              })

              // Handle transport errors
              transport.on('error', (error) => {
                console.error('Transport error:', error)
                setError('Transport error: ' + (error.message || 'Unknown error'))
                setLoading(false)
                setStatus('error')
              })
            } else if (data.type === 'webRtcTransportConnected') {
              // Transport connected - resolve the connect promise
              if (transportConnectResolver) {
                transportConnectResolver()
                transportConnectResolver = null
                transportConnectRejecter = null
              } else {
                console.log('Transport connected (no resolver set)')
              }
            } else if (data.type === 'consumerCreated') {
              // Step 7: Consume the stream
              try {
                const consumer = await transportRef.current.consume({
                  id: data.data.id,
                  producerId: data.data.producerId,
                  kind: data.data.kind,
                  rtpParameters: data.data.rtpParameters
                })

                consumerRef.current = consumer

                // Create MediaStream from consumer track
                const stream = new MediaStream([consumer.track])

                if (videoRef.current) {
                  videoRef.current.srcObject = stream
                  
                  // Clear the timeout since we've set srcObject
                  if (trackTimeoutRef.current) {
                    clearTimeout(trackTimeoutRef.current)
                    trackTimeoutRef.current = null
                  }

                  setStatus('connected')
                  setLoading(false)

                  if (autoPlay) {
                    videoRef.current.play().catch(err => {
                      console.error('Error playing video:', err)
                      setError('Autoplay blocked. Click play to start.')
                      setLoading(false)
                    })
                  }

                  // Monitor track state to detect if video actually starts
                  consumer.track.onmute = () => {
                    console.log('Consumer track muted')
                  }

                  consumer.track.onunmute = () => {
                    console.log('Consumer track unmuted')
                  }
                }

                // Handle consumer events
                consumer.on('transportclose', () => {
                  console.log('Consumer transport closed')
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

        ws.onclose = () => {
          setStatus('disconnected')
          cleanup()
        }

        // Add timeout to detect if connection never establishes
        trackTimeoutRef.current = setTimeout(() => {
          if (isMounted && loading && !videoRef.current?.srcObject) {
            console.warn('No video received within 15 seconds')
            setError('No video received. The stream may not be available.')
            setLoading(false)
          }
        }, 15000)
      } catch (err) {
        console.error('Mediasoup connection error:', err)
        setError(err.message || 'Failed to connect')
        setLoading(false)
        setStatus('error')
      }
    }

    function cleanup () {
      if (trackTimeoutRef.current) {
        clearTimeout(trackTimeoutRef.current)
        trackTimeoutRef.current = null
      }
      if (consumerRef.current) {
        consumerRef.current.close()
        consumerRef.current = null
      }
      if (transportRef.current) {
        transportRef.current.close()
        transportRef.current = null
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
