import React from 'react'
import bridge from 'bridge'

import { SharedContext } from '../sharedContext'
// Preview is only available for output streams, not input streams

export const StreamInputs = () => {
  const [state] = React.useContext(SharedContext)
  const [servers, setServers] = React.useState([])
  const [streams, setStreams] = React.useState([])
  const [formData, setFormData] = React.useState({
    serverId: '',
    channel: '',
    layer: '',
    srtUrl: '',
    loop: false
  })
  const [errors, setErrors] = React.useState({})
  const [loading, setLoading] = React.useState(false)
  const [reloadingId, setReloadingId] = React.useState(null)

  const pluginName = window.PLUGIN?.name || 'bridge-plugin-caspar-network'

  // Load servers and streams
  React.useEffect(() => {
    async function loadData () {
      try {
        const serverList = await bridge.commands.executeCommand('caspar.listServers', true)
        setServers(serverList || [])

        const streamList = await bridge.commands.executeCommand('caspar-network.listStreams')
        setStreams(streamList?.inputs || [])
      } catch (err) {
        console.error('Error loading data:', err)
      }
    }
    loadData()

    // Listen for state changes
    const streamsData = state?.plugins?.[pluginName]?.streams
    if (streamsData) {
      setStreams(streamsData.inputs || [])
    }
  }, [state, pluginName])

  // Update streams when state changes
  React.useEffect(() => {
    const streamsData = state?.plugins?.[pluginName]?.streams
    if (streamsData) {
      setStreams(streamsData.inputs || [])
    }
  }, [state, pluginName])

  function handleInputChange (key, value) {
    setFormData(prev => ({
      ...prev,
      [key]: value
    }))
    // Clear error for this field
    if (errors[key]) {
      setErrors(prev => {
        const newErrors = { ...prev }
        delete newErrors[key]
        return newErrors
      })
    }
  }

  function validateForm () {
    const newErrors = {}
    if (!formData.serverId) {
      newErrors.serverId = 'Server is required'
    }
    if (!formData.channel || isNaN(formData.channel) || parseInt(formData.channel) < 1) {
      newErrors.channel = 'Valid channel number is required'
    }
    if (!formData.layer || isNaN(formData.layer) || parseInt(formData.layer) < 0) {
      newErrors.layer = 'Valid layer number is required'
    }
    if (!formData.srtUrl || !formData.srtUrl.trim()) {
      newErrors.srtUrl = 'SRT URL is required'
    } else if (!formData.srtUrl.startsWith('srt://')) {
      newErrors.srtUrl = 'SRT URL must start with srt://'
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  async function handleAdd () {
    if (!validateForm()) {
      return
    }

    setLoading(true)
    try {
      await bridge.commands.executeCommand(
        'caspar-network.addInputStream',
        formData.serverId,
        parseInt(formData.channel),
        parseInt(formData.layer),
        formData.srtUrl.trim(),
        formData.loop
      )
      // Reset form
      setFormData({
        serverId: '',
        channel: '',
        layer: '',
        srtUrl: '',
        loop: false
      })
      setErrors({})
    } catch (err) {
      console.error('Error adding stream:', err)
      setErrors({ submit: err.message || 'Failed to add stream' })
    } finally {
      setLoading(false)
    }
  }

  async function handleStart (streamId) {
    try {
      await bridge.commands.executeCommand('caspar-network.startInputStream', streamId)
    } catch (err) {
      console.error('Error starting stream:', err)
    }
  }

  async function handleStop (streamId) {
    try {
      await bridge.commands.executeCommand('caspar-network.stopInputStream', streamId)
    } catch (err) {
      console.error('Error stopping stream:', err)
    }
  }

  async function handleRemove (streamId) {
    if (!confirm('Are you sure you want to remove this stream?')) {
      return
    }
    try {
      await bridge.commands.executeCommand('caspar-network.removeInputStream', streamId)
    } catch (err) {
      console.error('Error removing stream:', err)
    }
  }

  async function handleRefresh (streamId) {
    try {
      await bridge.commands.executeCommand('caspar-network.refreshStreamStatus', streamId)
    } catch (err) {
      console.error('Error refreshing stream status:', err)
    }
  }

  async function handleRefreshAll () {
    try {
      for (const stream of streams) {
        await bridge.commands.executeCommand('caspar-network.refreshStreamStatus', stream.id)
      }
    } catch (err) {
      console.error('Error refreshing streams:', err)
    }
  }

  async function handleReload (streamId) {
    setReloadingId(streamId)
    try {
      await bridge.commands.executeCommand('caspar-network.reloadInputStream', streamId)
    } catch (err) {
      console.error('Error reloading stream:', err)
    } finally {
      setReloadingId(null)
    }
  }

  function getStatusClass (status) {
    switch (status) {
      case 'active':
        return 'StreamList-item-status--active'
      case 'error':
        return 'StreamList-item-status--error'
      default:
        return 'StreamList-item-status--stopped'
    }
  }

  function getServerName (serverId) {
    const server = servers.find(s => s.id === serverId)
    return server ? server.name : serverId
  }

  return (
    <div className='StreamManager u-scroll--y'>
      <div className='StreamManager-content'>
        <div className='StreamManager-header'>
          <h1 className='StreamManager-title'>SRT Input Streams</h1>
        </div>

        <div className='StreamForm'>
        <h2 className='StreamForm-title'>Add Input Stream</h2>
        <div className='StreamForm-field'>
          <label className='StreamForm-label'>Server</label>
          <select
            className='StreamForm-input'
            value={formData.serverId}
            onChange={e => handleInputChange('serverId', e.target.value)}
          >
            <option value=''>Select a server</option>
            {servers.map(server => (
              <option key={server.id} value={server.id}>
                {server.name || server.id}
              </option>
            ))}
          </select>
          {errors.serverId && <div className='StreamForm-error'>{errors.serverId}</div>}
        </div>

        <div className='StreamForm-field'>
          <div className='StreamForm-row'>
            <div>
              <label className='StreamForm-label'>Channel</label>
              <input
                type='number'
                className='StreamForm-input StreamForm-input--small'
                value={formData.channel}
                onChange={e => handleInputChange('channel', e.target.value)}
                placeholder='1'
                min='1'
              />
              {errors.channel && <div className='StreamForm-error'>{errors.channel}</div>}
            </div>
            <div>
              <label className='StreamForm-label'>Layer</label>
              <input
                type='number'
                className='StreamForm-input StreamForm-input--small'
                value={formData.layer}
                onChange={e => handleInputChange('layer', e.target.value)}
                placeholder='10'
                min='0'
              />
              {errors.layer && <div className='StreamForm-error'>{errors.layer}</div>}
            </div>
          </div>
        </div>

        <div className='StreamForm-field'>
          <label className='StreamForm-label'>SRT URL</label>
          <input
            type='text'
            className='StreamForm-input'
            value={formData.srtUrl}
            onChange={e => handleInputChange('srtUrl', e.target.value)}
            placeholder='srt://localhost:9000?mode=caller&latency=2000&transtype=live'
          />
          {errors.srtUrl && <div className='StreamForm-error'>{errors.srtUrl}</div>}
        </div>

        <div className='StreamForm-field'>
          <div className='StreamForm-checkbox'>
            <input
              type='checkbox'
              id='loop'
              checked={formData.loop}
              onChange={e => handleInputChange('loop', e.target.checked)}
            />
            <label htmlFor='loop'>Loop stream</label>
          </div>
        </div>

        {errors.submit && <div className='StreamForm-error'>{errors.submit}</div>}

        <button
          className='Button'
          onClick={handleAdd}
          disabled={loading}
        >
          {loading ? 'Adding...' : 'Add Stream'}
        </button>

        <div className='StreamList'>
        <div className='StreamList-header'>
          <h2 className='StreamManager-title' style={{ margin: 0 }}>Active Input Streams ({streams.length})</h2>
          {streams.length > 0 && (
            <button className='Button Button--ghost' onClick={handleRefreshAll}>
              Refresh All
            </button>
          )}
        </div>
        {streams.length === 0
          ? (
              <div style={{ padding: '8px', fontSize: '12px', color: 'var(--base-color--grey1)' }}>No input streams configured</div>
            )
          : (
              streams.map(stream => (
                <div key={stream.id} className='StreamList-item'>
                  <div className='StreamList-item-header'>
                    <div className='StreamList-item-title'>
                      Channel {stream.channel}, Layer {stream.layer}
                    </div>
                    <div className={`StreamList-item-status ${getStatusClass(stream.status)}`}>
                      {stream.status.toUpperCase()}
                    </div>
                  </div>
                  <div className='StreamList-item-details'>
                    <div><strong>Server:</strong> {getServerName(stream.serverId)}</div>
                    <div><strong>URL:</strong> <span style={{ wordBreak: 'break-all' }}>{stream.srtUrl}</span></div>
                    <div><strong>Loop:</strong> {stream.loop ? 'Yes' : 'No'}</div>
                    {stream.lastError && (
                      <div style={{ color: 'var(--base-color--alert)', marginTop: '4px' }}>
                        <strong>Error:</strong> {stream.lastError}
                      </div>
                    )}
                  </div>
                  {/* Preview is only available for output streams */}
                  {/* Input streams only show status information from CasparCG */}
                  <div className='StreamList-item-actions'>
                    {stream.status === 'active'
                      ? (
                          <button className='Button Button--ghost' onClick={() => handleStop(stream.id)}>
                            Stop
                          </button>
                        )
                      : (
                          <button className='Button Button--ghost' onClick={() => handleStart(stream.id)}>
                            Start
                          </button>
                        )}
                    <button
                      className='Button Button--ghost'
                      onClick={() => handleReload(stream.id)}
                      disabled={reloadingId === stream.id}
                      title='Remove and re-add this stream with the same config, then start it'
                    >
                      {reloadingId === stream.id ? 'Reloading...' : 'Reload'}
                    </button>
                    <button className='Button Button--ghost' onClick={() => handleRefresh(stream.id)}>
                      Refresh
                    </button>
                    <button className='Button Button--ghost' onClick={() => handleRemove(stream.id)}>
                      Remove
                    </button>
                  </div>
                </div>
              ))
            )}
        </div>
      </div>
      </div>
    </div>
  )
}
