import React from 'react'
import bridge from 'bridge'

import { SharedContext } from '../sharedContext'
import { StreamPreview } from '../components/StreamPreview'

export const StreamOutputs = () => {
  const [state] = React.useContext(SharedContext)
  const [servers, setServers] = React.useState([])
  const [streams, setStreams] = React.useState([])
  const [formData, setFormData] = React.useState({
    serverId: '',
    channel: '',
    srtUrl: '',
    encodingOptions: {
      format: 'mpegts',
      codec: 'h264_nvenc',
      preset: 'p4',
      tune: 'll',
      bitrate: '6000k',
      maxrate: '6000k',
      bufsize: '12000k',
      gop: 50,
      keyintMin: 50,
      audio: false
    },
    showAdvanced: false
  })
  const [errors, setErrors] = React.useState({})
  const [loading, setLoading] = React.useState(false)

  const pluginName = window.PLUGIN?.name || 'bridge-plugin-caspar-network'

  // Load servers and streams
  React.useEffect(() => {
    async function loadData () {
      try {
        const serverList = await bridge.commands.executeCommand('caspar.listServers', true)
        setServers(serverList || [])

        const streamList = await bridge.commands.executeCommand('caspar-network.listStreams')
        setStreams(streamList?.outputs || [])
      } catch (err) {
        console.error('Error loading data:', err)
      }
    }
    loadData()

    // Load default encoding options from settings
    const settings = state?.plugins?.[pluginName]?.settings
    if (settings?.defaultEncodingOptions) {
      setFormData(prev => ({
        ...prev,
        encodingOptions: { ...prev.encodingOptions, ...settings.defaultEncodingOptions }
      }))
    }
  }, [state, pluginName])

  // Update streams when state changes
  React.useEffect(() => {
    const streamsData = state?.plugins?.[pluginName]?.streams
    if (streamsData) {
      setStreams(streamsData.outputs || [])
    }
  }, [state, pluginName])

  function handleInputChange (key, value) {
    setFormData(prev => ({
      ...prev,
      [key]: value
    }))
    if (errors[key]) {
      setErrors(prev => {
        const newErrors = { ...prev }
        delete newErrors[key]
        return newErrors
      })
    }
  }

  function handleEncodingOptionChange (key, value) {
    setFormData(prev => ({
      ...prev,
      encodingOptions: {
        ...prev.encodingOptions,
        [key]: value
      }
    }))
  }

  function validateForm () {
    const newErrors = {}
    if (!formData.serverId) {
      newErrors.serverId = 'Server is required'
    }
    if (!formData.channel || isNaN(formData.channel) || parseInt(formData.channel) < 1) {
      newErrors.channel = 'Valid channel number is required'
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
        'caspar-network.addOutputStream',
        formData.serverId,
        parseInt(formData.channel),
        formData.srtUrl.trim(),
        formData.encodingOptions
      )
      // Reset form
      setFormData(prev => ({
        serverId: '',
        channel: '',
        srtUrl: '',
        encodingOptions: prev.encodingOptions,
        showAdvanced: false
      }))
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
      await bridge.commands.executeCommand('caspar-network.startOutputStream', streamId)
    } catch (err) {
      console.error('Error starting stream:', err)
    }
  }

  async function handleStop (streamId) {
    try {
      await bridge.commands.executeCommand('caspar-network.stopOutputStream', streamId)
    } catch (err) {
      console.error('Error stopping stream:', err)
    }
  }

  async function handleRemove (streamId) {
    if (!confirm('Are you sure you want to remove this stream?')) {
      return
    }
    try {
      await bridge.commands.executeCommand('caspar-network.removeOutputStream', streamId)
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
          <h1 className='StreamManager-title'>SRT Output Streams</h1>
        </div>

        <div className='StreamForm'>
        <h2 className='StreamForm-title'>Add Output Stream</h2>
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

        <div className='StreamForm-field'>
          <label className='StreamForm-label'>SRT Listener URL</label>
          <input
            type='text'
            className='StreamForm-input'
            value={formData.srtUrl}
            onChange={e => handleInputChange('srtUrl', e.target.value)}
            placeholder='srt://0.0.0.0:6000?mode=listener&latency=2000&transtype=live'
          />
          {errors.srtUrl && <div className='StreamForm-error'>{errors.srtUrl}</div>}
        </div>

        <div className='StreamForm-field'>
          <button
            className='Button Button--ghost'
            onClick={() => handleInputChange('showAdvanced', !formData.showAdvanced)}
          >
            {formData.showAdvanced
              ? 'Hide'
              : 'Show'} Advanced Options
          </button>
        </div>

        {formData.showAdvanced && (
          <>
            <div className='StreamForm-field'>
              <label className='StreamForm-label'>Format</label>
              <input
                type='text'
                className='StreamForm-input'
                value={formData.encodingOptions.format}
                onChange={e => handleEncodingOptionChange('format', e.target.value)}
              />
            </div>

            <div className='StreamForm-field'>
              <label className='StreamForm-label'>Video Codec</label>
              <select
                className='StreamForm-input'
                value={formData.encodingOptions.codec}
                onChange={e => handleEncodingOptionChange('codec', e.target.value)}
              >
                <option value='h264_nvenc'>h264_nvenc</option>
                <option value='h264'>h264</option>
                <option value='libx264'>libx264</option>
              </select>
            </div>

            <div className='StreamForm-field'>
              <div className='StreamForm-row'>
                <div>
                  <label className='StreamForm-label'>Preset</label>
                  <input
                    type='text'
                    className='StreamForm-input StreamForm-input--small'
                    value={formData.encodingOptions.preset}
                    onChange={e => handleEncodingOptionChange('preset', e.target.value)}
                  />
                </div>
                <div>
                  <label className='StreamForm-label'>Tune</label>
                  <input
                    type='text'
                    className='StreamForm-input StreamForm-input--small'
                    value={formData.encodingOptions.tune}
                    onChange={e => handleEncodingOptionChange('tune', e.target.value)}
                  />
                </div>
              </div>
            </div>

            <div className='StreamForm-field'>
              <div className='StreamForm-row'>
                <div>
                  <label className='StreamForm-label'>Bitrate</label>
                  <input
                    type='text'
                    className='StreamForm-input StreamForm-input--small'
                    value={formData.encodingOptions.bitrate}
                    onChange={e => handleEncodingOptionChange('bitrate', e.target.value)}
                  />
                </div>
                <div>
                  <label className='StreamForm-label'>Maxrate</label>
                  <input
                    type='text'
                    className='StreamForm-input StreamForm-input--small'
                    value={formData.encodingOptions.maxrate}
                    onChange={e => handleEncodingOptionChange('maxrate', e.target.value)}
                  />
                </div>
                <div>
                  <label className='StreamForm-label'>Bufsize</label>
                  <input
                    type='text'
                    className='StreamForm-input StreamForm-input--small'
                    value={formData.encodingOptions.bufsize}
                    onChange={e => handleEncodingOptionChange('bufsize', e.target.value)}
                  />
                </div>
              </div>
            </div>

            <div className='StreamForm-field'>
              <div className='StreamForm-row'>
                <div>
                  <label className='StreamForm-label'>GOP</label>
                  <input
                    type='number'
                    className='StreamForm-input StreamForm-input--small'
                    value={formData.encodingOptions.gop}
                    onChange={e => handleEncodingOptionChange('gop', parseInt(e.target.value) || 0)}
                  />
                </div>
                <div>
                  <label className='StreamForm-label'>Keyint Min</label>
                  <input
                    type='number'
                    className='StreamForm-input StreamForm-input--small'
                    value={formData.encodingOptions.keyintMin}
                    onChange={e => handleEncodingOptionChange('keyintMin', parseInt(e.target.value) || 0)}
                  />
                </div>
              </div>
            </div>

            <div className='StreamForm-field'>
              <div className='StreamForm-checkbox'>
                <input
                  type='checkbox'
                  id='audio'
                  checked={formData.encodingOptions.audio}
                  onChange={e => handleEncodingOptionChange('audio', e.target.checked)}
                />
                <label htmlFor='audio'>Enable Audio</label>
              </div>
            </div>
          </>
        )}

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
            <h2 className='StreamManager-title' style={{ margin: 0 }}>Active Output Streams ({streams.length})</h2>
            {streams.length > 0 && (
              <button className='Button Button--ghost' onClick={handleRefreshAll}>
                Refresh All
              </button>
            )}
          </div>
          {streams.length === 0
            ? (
                <div style={{ padding: '8px', fontSize: '12px', color: 'var(--base-color--grey1)' }}>No output streams configured</div>
              )
            : (
              streams.map(stream => (
                <div key={stream.id} className='StreamList-item'>
                  <div className='StreamList-item-header'>
                    <div className='StreamList-item-title'>
                      Channel {stream.channel}
                      {stream.streamIndex != null
                        ? `, Stream ${stream.streamIndex}`
                        : ''}
                    </div>
                    <div className={`StreamList-item-status ${getStatusClass(stream.status)}`}>
                      {stream.status.toUpperCase()}
                    </div>
                  </div>
                  <div className='StreamList-item-details'>
                    <div><strong>Server:</strong> {getServerName(stream.serverId)}</div>
                    <div><strong>URL:</strong> <span style={{ wordBreak: 'break-all' }}>{stream.srtUrl}</span></div>
                    <div><strong>Codec:</strong> {stream.encodingOptions?.codec || 'N/A'}</div>
                    {stream.lastError && (
                      <div style={{ color: 'var(--base-color--alert)', marginTop: '4px' }}>
                        <strong>Error:</strong> {stream.lastError}
                      </div>
                    )}
                  </div>
                  {stream.status === 'active' && (
                    <div className='StreamList-item-preview'>
                      <StreamPreview streamId={stream.id} />
                    </div>
                  )}
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
