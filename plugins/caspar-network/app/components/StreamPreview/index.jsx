// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

import React, { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'

import './style.css'

/**
 * StreamPreview component for displaying HLS video streams
 * @param {Object} props
 * @param {string} props.streamId - Stream ID
 * @param {boolean} [props.autoPlay=true] - Auto-play the video
 * @param {boolean} [props.controls=true] - Show video controls
 * @param {boolean} [props.muted=true] - Mute video by default
 */
export const StreamPreview = ({ streamId, autoPlay = true, controls = true, muted = true }) => {
  const videoRef = useRef(null)
  const hlsRef = useRef(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [manifestUrl, setManifestUrl] = useState(null)

  useEffect(() => {
    if (!streamId) {
      return
    }

    let isMounted = true

    async function loadPreview () {
      try {
        setLoading(true)
        setError(null)

        // Start HLS proxy and get manifest URL
        const url = await bridge.commands.executeCommand('caspar-network.startPreview', streamId)
        if (!isMounted) return

        setManifestUrl(url)
      } catch (err) {
        if (!isMounted) return
        console.error('Error starting preview:', err)
        setError(err.message || 'Failed to start preview')
        setLoading(false)
      }
    }

    loadPreview()

    return () => {
      isMounted = false
      // Stop preview when component unmounts
      if (streamId) {
        bridge.commands.executeCommand('caspar-network.stopPreview', streamId).catch(err => {
          console.error('Error stopping preview:', err)
        })
      }
    }
  }, [streamId])

  useEffect(() => {
    if (!manifestUrl || !videoRef.current) {
      return
    }

    const video = videoRef.current
    let hls = null

    // Check if HLS is natively supported
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari)
      video.src = manifestUrl
      video.addEventListener('loadedmetadata', () => {
        setLoading(false)
      })
      video.addEventListener('error', (e) => {
        setError('Video playback error')
        setLoading(false)
      })
    } else if (Hls.isSupported()) {
      // Use hls.js for HLS playback
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 90
      })

      hls.loadSource(manifestUrl)
      hls.attachMedia(video)

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (autoPlay) {
          video.play().catch(err => {
            console.error('Error playing video:', err)
            setError('Autoplay blocked. Click play to start.')
            setLoading(false)
          })
        }
        setLoading(false)
      })

      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              setError('Network error. Trying to recover...')
              hls.startLoad()
              break
            case Hls.ErrorTypes.MEDIA_ERROR:
              setError('Media error. Trying to recover...')
              hls.recoverMediaError()
              break
            default:
              setError('Fatal error. Cannot recover.')
              hls.destroy()
              break
          }
        }
      })
    } else {
      setError('HLS playback not supported in this browser')
      setLoading(false)
    }

    hlsRef.current = hls

    return () => {
      if (hls) {
        hls.destroy()
        hlsRef.current = null
      }
    }
  }, [manifestUrl, autoPlay])

  if (error) {
    return (
      <div className='StreamPreview StreamPreview--error'>
        <div className='StreamPreview-error'>{error}</div>
      </div>
    )
  }

  return (
    <div className='StreamPreview'>
      {loading && (
        <div className='StreamPreview-loading'>
          <div className='StreamPreview-spinner' />
          <div>Loading preview...</div>
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
    </div>
  )
}

