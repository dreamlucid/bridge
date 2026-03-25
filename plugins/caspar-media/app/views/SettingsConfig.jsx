import React from 'react'
import bridge from 'bridge'

import { SharedContext } from '../sharedContext'

export const SettingsConfig = () => {
  const [state] = React.useContext(SharedContext)
  const name = window.PLUGIN?.name
  const settings = state?.plugins?.[name]?.settings || {}
  const [pathInput, setPathInput] = React.useState(settings.casparConfigPath || '')
  const [busy, setBusy] = React.useState(false)
  const [msg, setMsg] = React.useState('')

  React.useEffect(() => {
    setPathInput(settings.casparConfigPath || '')
  }, [settings.casparConfigPath])

  async function handleSave (e) {
    e.preventDefault()
    setBusy(true)
    setMsg('')
    try {
      await bridge.commands.executeCommand('casparMedia.saveSettings', {
        casparConfigPath: pathInput.trim()
      })
      setMsg('Saved and paths updated.')
    } catch (err) {
      setMsg(err?.message || String(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleRefresh () {
    setBusy(true)
    setMsg('')
    try {
      await bridge.commands.executeCommand('casparMedia.refreshPaths')
      setMsg('Paths refreshed.')
    } catch (err) {
      setMsg(err?.message || String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className='MediaUpload'>
      <form onSubmit={handleSave}>
        <div className='MediaUpload-field'>
          <label htmlFor='caspar-config'>casparcg.config (absolute path)</label>
          <input
            id='caspar-config'
            type='text'
            value={pathInput}
            onChange={e => setPathInput(e.target.value)}
            placeholder='/opt/caspar/casparcg.config'
            disabled={busy}
          />
        </div>
        <button className='Button' type='submit' disabled={busy}>Save</button>
        {' '}
        <button className='Button' type='button' disabled={busy} onClick={handleRefresh}>Refresh paths</button>
      </form>
      {settings.parseError
        ? (
          <p className='MediaUpload-msg MediaUpload-msg--error'>
            Parse error: {settings.parseError}
          </p>
          )
        : null}
      {settings.resolvedRoots
        ? (
          <div className='MediaUpload-msg'>
            <div><strong>Media:</strong> {settings.resolvedRoots.media}</div>
            <div><strong>Template:</strong> {settings.resolvedRoots.template}</div>
            {settings.resolvedRoots.font
              ? <div><strong>Font:</strong> {settings.resolvedRoots.font}</div>
              : null}
          </div>
          )
        : null}
      {msg
        ? <p className={'MediaUpload-msg' + (msg.includes('error') || settings.parseError ? ' MediaUpload-msg--error' : '')}>{msg}</p>
        : null}
    </div>
  )
}
