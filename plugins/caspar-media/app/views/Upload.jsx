import React from 'react'

import { SharedContext } from '../sharedContext'

const MAX_BYTES = 2 * 1024 * 1024 * 1024
const CHUNK_THRESHOLD = 50 * 1024 * 1024
const CHUNK_SIZE = 8 * 1024 * 1024

const TARGETS = [
  { value: 'media', label: 'Media' },
  { value: 'template', label: 'Template' },
  { value: 'font', label: 'Font' }
]

/**
 * @param {string} url
 * @param {FormData} formData
 * @param {(n: number) => void} onProgress 0..1
 * @param {AbortSignal} [signal]
 */
function postFormWithProgress (url, formData, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    function onAbort () {
      xhr.abort()
    }
    if (signal) {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      signal.addEventListener('abort', onAbort)
    }
    xhr.open('POST', url)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(e.loaded / e.total)
      }
    }
    xhr.onload = () => {
      if (signal) {
        signal.removeEventListener('abort', onAbort)
      }
      const text = xhr.responseText || ''
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(text))
        } catch {
          resolve({ raw: text })
        }
      } else {
        let detail = text
        try {
          const j = JSON.parse(text)
          detail = j.description || j.message || text
        } catch (_) {}
        reject(new Error(`${xhr.status} ${detail}`))
      }
    }
    xhr.onerror = () => {
      if (signal) {
        signal.removeEventListener('abort', onAbort)
      }
      reject(new Error('Network error'))
    }
    xhr.onabort = () => {
      if (signal) {
        signal.removeEventListener('abort', onAbort)
      }
      reject(new DOMException('Aborted', 'AbortError'))
    }
    xhr.send(formData)
  })
}

function wait (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export const Upload = () => {
  const [state] = React.useContext(SharedContext)
  const name = window.PLUGIN?.name
  const settings = state?.plugins?.[name]?.settings || {}
  const roots = settings.resolvedRoots

  const [target, setTarget] = React.useState('media')
  const [relativePath, setRelativePath] = React.useState('')
  const [msg, setMsg] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [drag, setDrag] = React.useState(false)
  const [progress, setProgress] = React.useState(0)
  const [progressLabel, setProgressLabel] = React.useState('')
  const [paused, setPaused] = React.useState(false)
  const [chunkState, setChunkState] = React.useState(null)

  const inputRef = React.useRef(null)
  const pausedRef = React.useRef(false)
  const abortRef = React.useRef(null)

  const workspaceId = React.useMemo(() => {
    if (state?._id) {
      return state._id
    }
    if (typeof window !== 'undefined' && window.APP?.workspace) {
      return window.APP.workspace
    }
    return undefined
  }, [state?._id])

  const availableTargets = React.useMemo(() => {
    if (!roots) return []
    return TARGETS.filter(t => roots[t.value])
  }, [roots])

  React.useEffect(() => {
    if (!availableTargets.length) {
      return
    }
    if (!availableTargets.some(t => t.value === target)) {
      setTarget(availableTargets[0].value)
    }
  }, [availableTargets, target])

  React.useEffect(() => {
    pausedRef.current = paused
  }, [paused])

  async function cancelChunkSession (uploadId) {
    if (!uploadId || !workspaceId) {
      return
    }
    try {
      await fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/caspar-media/upload/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId })
      })
    } catch (_) {}
  }

  async function uploadSingleFileXHR (file, baseUrl) {
    const form = new FormData()
    form.append('target', target)
    form.append('relativePath', relativePath.trim())
    form.append('file', file, file.name)
    const ac = new AbortController()
    abortRef.current = ac
    setProgress(0)
    setProgressLabel(file.name)
    try {
      const result = await postFormWithProgress(
        `${baseUrl}/caspar-media/upload`,
        form,
        (p) => setProgress(p),
        ac.signal
      )
      return result
    } finally {
      abortRef.current = null
      setProgress(0)
      setProgressLabel('')
    }
  }

  async function uploadChunked (file, baseUrl) {
    const ac = new AbortController()
    abortRef.current = ac

    const initRes = await fetch(`${baseUrl}/caspar-media/upload/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: file.name,
        fileSize: file.size,
        target,
        relativePath: relativePath.trim()
      }),
      signal: ac.signal
    })
    const initText = await initRes.text()
    if (!initRes.ok) {
      let detail = initText
      try {
        const j = JSON.parse(initText)
        detail = j.description || detail
      } catch (_) {}
      throw new Error(`${initRes.status} ${detail}`)
    }
    const { uploadId, chunkSize } = JSON.parse(initText)

    setChunkState({ uploadId, fileName: file.name, fileSize: file.size })

    let offset = 0
    const status = await fetch(`${baseUrl}/caspar-media/upload/status?uploadId=${encodeURIComponent(uploadId)}`)
    if (status.ok) {
      const st = await status.json()
      offset = st.receivedBytes || 0
    }

    const cs = chunkSize || CHUNK_SIZE

    while (offset < file.size) {
      if (ac.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }
      while (pausedRef.current) {
        await wait(150)
        if (ac.signal.aborted) {
          throw new DOMException('Aborted', 'AbortError')
        }
      }

      const chunkIndex = Math.floor(offset / cs)
      const end = Math.min(offset + cs, file.size)
      const blob = file.slice(offset, end)
      const buf = await blob.arrayBuffer()

      const chunkRes = await fetch(
        `${baseUrl}/caspar-media/upload/chunk?uploadId=${encodeURIComponent(uploadId)}&chunkIndex=${chunkIndex}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: buf,
          signal: ac.signal
        }
      )
      const chunkText = await chunkRes.text()
      if (!chunkRes.ok) {
        let detail = chunkText
        try {
          const j = JSON.parse(chunkText)
          detail = j.description || detail
        } catch (_) {}
        throw new Error(`${chunkRes.status} ${detail}`)
      }

      offset = end
      setProgress(offset / file.size)
      setProgressLabel(file.name)
    }

    const doneRes = await fetch(`${baseUrl}/caspar-media/upload/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId }),
      signal: ac.signal
    })
    const doneText = await doneRes.text()
    if (!doneRes.ok) {
      let detail = doneText
      try {
        const j = JSON.parse(doneText)
        detail = j.description || detail
      } catch (_) {}
      throw new Error(`${doneRes.status} ${detail}`)
    }

    abortRef.current = null
    setChunkState(null)
    setProgress(0)
    setProgressLabel('')
    return JSON.parse(doneText)
  }

  async function uploadFiles (files) {
    if (!workspaceId) {
      setMsg('No workspace id yet (wait for connection) or open a workspace and reload.')
      return
    }
    if (!roots) {
      setMsg('Configure casparcg.config in Settings → Caspar media first.')
      return
    }
    const list = files && files.length ? Array.from(files) : []
    if (!list.length) {
      return
    }

    setBusy(true)
    setMsg('')
    setPaused(false)
    pausedRef.current = false

    const baseUrl = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`
    const errors = []
    const ok = []

    try {
      for (const file of list) {
        if (file.size > MAX_BYTES) {
          errors.push(`${file.name}: exceeds 2 GiB limit`)
          continue
        }
        try {
          let result
          if (file.size >= CHUNK_THRESHOLD) {
            result = await uploadChunked(file, baseUrl)
          } else {
            result = await uploadSingleFileXHR(file, baseUrl)
          }
          ok.push(result?.path || file.name)
        } catch (err) {
          if (err?.name === 'AbortError') {
            errors.push(`${file.name}: cancelled`)
          } else {
            errors.push(`${file.name}: ${err?.message || String(err)}`)
          }
        }
      }

      const parts = []
      if (ok.length) {
        parts.push(`Uploaded: ${ok.length} file(s)\n${ok.join('\n')}`)
      }
      if (errors.length) {
        parts.push(errors.join('\n'))
      }
      setMsg(parts.join('\n\n'))
    } catch (err) {
      setMsg(err?.message || String(err))
    } finally {
      setBusy(false)
      setProgress(0)
      setProgressLabel('')
      setChunkState(null)
      abortRef.current = null
    }
  }

  function onFileInput (e) {
    const files = e.target.files
    uploadFiles(files)
    e.target.value = ''
  }

  function onDrop (e) {
    e.preventDefault()
    setDrag(false)
    uploadFiles(e.dataTransfer.files)
  }

  function handlePauseToggle () {
    setPaused(p => !p)
  }

  function handleCancelUpload () {
    if (abortRef.current) {
      abortRef.current.abort()
    }
    if (chunkState?.uploadId) {
      cancelChunkSession(chunkState.uploadId)
    }
  }

  const showChunkControls = busy && chunkState

  return (
    <div className='MediaUpload'>
      {!roots
        ? (
          <p className='MediaUpload-msg MediaUpload-msg--error'>
            Configure <strong>Settings → Caspar media</strong> with the path to casparcg.config.
          </p>
          )
        : null}

      <div className='MediaUpload-field'>
        <label htmlFor='mu-target'>Destination</label>
        <select
          id='mu-target'
          value={target}
          onChange={e => setTarget(e.target.value)}
          disabled={busy || !availableTargets.length}
        >
          {availableTargets.map(t => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
      </div>

      <div className='MediaUpload-field'>
        <label htmlFor='mu-sub'>Subfolder (optional)</label>
        <input
          id='mu-sub'
          type='text'
          value={relativePath}
          onChange={e => setRelativePath(e.target.value)}
          placeholder="e.g. bumpers (no ..)"
          disabled={busy}
        />
      </div>

      <input
        ref={inputRef}
        type='file'
        multiple
        style={{ display: 'none' }}
        onChange={onFileInput}
        disabled={busy || !roots}
      />

      <button
        className='Button'
        type='button'
        disabled={busy || !roots || !availableTargets.length}
        onClick={() => inputRef.current?.click()}
      >
        Choose files
      </button>

      {showChunkControls
        ? (
          <div className='MediaUpload-field MediaUpload-chunkActions'>
            <button className='Button Button--small' type='button' onClick={handlePauseToggle}>
              {paused ? 'Resume' : 'Pause'}
            </button>
            {' '}
            <button className='Button Button--small' type='button' onClick={handleCancelUpload}>
              Cancel upload
            </button>
          </div>
          )
        : null}

      {(busy && progressLabel)
        ? (
          <div className='MediaUpload-field'>
            <div className='MediaUpload-progressMeta'>{progressLabel} ({(progress * 100).toFixed(0)}%)</div>
            <progress className='MediaUpload-progress' value={progress} max={1} />
          </div>
          )
        : null}

      <div
        className={'MediaUpload-drop' + (drag ? ' MediaUpload-dropActive' : '')}
        onDragOver={e => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        onClick={() => !busy && roots && inputRef.current?.click()}
        role='presentation'
      >
        Drop files here or click
      </div>

      <p className='MediaUpload-hint'>
        Files over {(CHUNK_THRESHOLD / (1024 * 1024)).toFixed(0)} MiB use chunked upload (pause/resume between chunks). Max 2 GiB per file.
      </p>

      {msg
        ? (
          <p
            className={
              'MediaUpload-msg' +
              (msg.includes('Configure') || msg.includes('exceeds') || msg.includes('workspace') || msg.includes('40') || msg.includes('50') || msg.includes('cancelled')
                ? ' MediaUpload-msg--error'
                : ' MediaUpload-msg--ok')
            }
          >
            {msg}
          </p>
          )
        : null}
    </div>
  )
}
