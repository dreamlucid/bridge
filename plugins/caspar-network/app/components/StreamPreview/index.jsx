// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

import React, { useEffect, useRef, useState } from 'react'
import bridge from 'bridge'

import './style.css'

/**
 * StreamPreview component for displaying WebRTC video streams (low-latency real-time preview)
 * @param {Object} props
 * @param {string} props.streamId - Stream ID
 * @param {boolean} [props.autoPlay=true] - Auto-play the video
 * @param {boolean} [props.controls=true] - Show video controls
 * @param {boolean} [props.muted=true] - Mute video by default
 */
export const StreamPreview = ({ streamId, autoPlay = true, controls = true, muted = true }) => {
  const videoRef = useRef(null)
  const pcRef = useRef(null)
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

        // Start WebRTC proxy and get signaling URL
        const signalingUrl = await bridge.commands.executeCommand('caspar-network.startPreview', streamId)
        if (!isMounted) return

        // Connect to WebRTC signaling server
        await connectWebRTC(signalingUrl)
      } catch (err) {
        if (!isMounted) return
        console.error('Error starting WebRTC preview:', err)
        setError(err.message || 'Failed to start preview')
        setLoading(false)
        setStatus('error')
      }
    }

    async function connectWebRTC (signalingUrl) {
      try {
        // Create RTCPeerConnection
        const pc = new RTCPeerConnection({
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
          ]
        })

        pcRef.current = pc

        // Handle incoming stream
        pc.ontrack = (event) => {
          console.log('Received track event:', event)
          console.log('Track kind:', event.track.kind)
          console.log('Streams:', event.streams)
          if (videoRef.current && event.streams[0]) {
            videoRef.current.srcObject = event.streams[0]
            setStatus('connected')
            setLoading(false)
            if (autoPlay) {
              videoRef.current.play().catch(err => {
                console.error('Error playing video:', err)
                setError('Autoplay blocked. Click play to start.')
                setLoading(false)
              })
            }
          } else if (event.track) {
            // Handle case where track exists but no stream
            console.log('Track received but no stream, creating MediaStream')
            const stream = new MediaStream([event.track])
            if (videoRef.current) {
              videoRef.current.srcObject = stream
              setStatus('connected')
              setLoading(false)
              if (autoPlay) {
                videoRef.current.play().catch(err => {
                  console.error('Error playing video:', err)
                  setError('Autoplay blocked. Click play to start.')
                  setLoading(false)
                })
              }
            }
          }
        }

        pc.onicecandidate = (event) => {
          if (event.candidate && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
              type: 'ice-candidate',
              candidate: event.candidate
            }))
          }
        }

        pc.oniceconnectionstatechange = () => {
          const state = pc.iceConnectionState
          console.log('ICE connection state changed:', state)
          setStatus(state)
          if (state === 'failed' || state === 'disconnected') {
            setError(`Connection ${state}`)
            setLoading(false)
          } else if (state === 'connected' || state === 'completed') {
            // Connection established, but we still need to wait for tracks
            console.log('ICE connection established, waiting for tracks...')
          }
        }

        pc.onconnectionstatechange = () => {
          const state = pc.connectionState
          console.log('PeerConnection state changed:', state)
          if (state === 'failed' || state === 'disconnected') {
            setError(`PeerConnection ${state}`)
            setLoading(false)
          }
        }

        // Add timeout to detect if tracks never arrive
        trackTimeoutRef.current = setTimeout(() => {
          if (isMounted && loading && !videoRef.current?.srcObject) {
            console.warn('No tracks received within 10 seconds')
            setError('No video track received. The stream may not be available.')
            setLoading(false)
          }
        }, 10000)

        pc.onerror = (err) => {
          console.error('WebRTC error:', err)
          setError('WebRTC connection error')
          setLoading(false)
          setStatus('error')
        }

        // Connect to signaling server
        const ws = new WebSocket(signalingUrl)
        wsRef.current = ws

        ws.onopen = async () => {
          setStatus('signaling')
          // Create offer
          const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
          })

          await pc.setLocalDescription(offer)

          // Send offer to signaling server
          ws.send(JSON.stringify({
            type: 'offer',
            offer
          }))
        }

        ws.onmessage = async (event) => {
          try {
            const data = JSON.parse(event.data)

            if (data.type === 'answer' && pcRef.current) {
              await pcRef.current.setRemoteDescription(new RTCSessionDescription(data.answer))
            } else if (data.type === 'ice-candidate' && pcRef.current) {
              await pcRef.current.addIceCandidate(new RTCIceCandidate(data.candidate))
            }
          } catch (err) {
            console.error('Error handling signaling message:', err)
            setError('Signaling error')
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
      } catch (err) {
        console.error('WebRTC connection error:', err)
        setError(err.message || 'Failed to connect WebRTC')
        setLoading(false)
        setStatus('error')
      }
    }

    function cleanup () {
      if (trackTimeoutRef.current) {
        clearTimeout(trackTimeoutRef.current)
        trackTimeoutRef.current = null
      }
      if (pcRef.current) {
        pcRef.current.close()
        pcRef.current = null
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
