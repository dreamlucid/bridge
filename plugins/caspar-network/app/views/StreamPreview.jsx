import React from 'react'
import bridge from 'bridge'

import { SharedContext } from '../sharedContext'
import { StreamPreview as StreamPreviewComponent } from '../components/StreamPreview'

/**
 * Stream Preview view: one preview per channel.
 * Preview uses a dedicated SRT port and is tracked separately from output streams (outputs are for third-party encoders).
 * Channels are listed from input streams; each has a Start/Stop Preview button.
 */
export const StreamPreview = () => {
  const [state] = React.useContext(SharedContext)
  const [channels, setChannels] = React.useState([])
  const [activePreviews, setActivePreviews] = React.useState([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(null)

  const pluginName = window.PLUGIN?.name || 'bridge-plugin-caspar-network'

  // Load previewable channels (unique serverId+channel from input streams) and active channel previews
  React.useEffect(() => {
    async function load () {
      try {
        setLoading(true)
        setError(null)
        const [channelList, previewList] = await Promise.all([
          bridge.commands.executeCommand('caspar-network.listPreviewableChannels'),
          bridge.commands.executeCommand('caspar-network.listChannelPreviews')
        ])
        setChannels(channelList || [])
        setActivePreviews(previewList || [])
      } catch (err) {
        console.error('Error loading preview data:', err)
        setError(err.message || 'Failed to load')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  // Sync active previews from shared state
  React.useEffect(() => {
    const channelPreviews = state?.plugins?.[pluginName]?.streams?.channelPreviews
    if (Array.isArray(channelPreviews)) {
      setActivePreviews(channelPreviews)
    }
  }, [state, pluginName])

  async function handleStartPreview (serverId, channel) {
    try {
      await bridge.commands.executeCommand('caspar-network.startChannelPreview', serverId, channel)
      const list = await bridge.commands.executeCommand('caspar-network.listChannelPreviews')
      setActivePreviews(list || [])
    } catch (err) {
      console.error('Error starting preview:', err)
    }
  }

  async function handleStopPreview (serverId, channel) {
    try {
      await bridge.commands.executeCommand('caspar-network.stopChannelPreview', serverId, channel)
      const list = await bridge.commands.executeCommand('caspar-network.listChannelPreviews')
      setActivePreviews(list || [])
    } catch (err) {
      console.error('Error stopping preview:', err)
    }
  }

  function isPreviewActive (serverId, channel) {
    return activePreviews.some(p => p.serverId === serverId && p.channel === channel)
  }

  if (loading) {
    return (
      <div className='StreamManager u-scroll--y'>
        <div className='StreamManager-content'>
          <div className='StreamManager-header'>
            <h1 className='StreamManager-title'>Stream Preview</h1>
          </div>
          <div className='StreamList-item' style={{ padding: '12px' }}>
            <div style={{ color: 'var(--base-color--grey1)' }}>Loading...</div>
          </div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className='StreamManager u-scroll--y'>
        <div className='StreamManager-content'>
          <div className='StreamManager-header'>
            <h1 className='StreamManager-title'>Stream Preview</h1>
          </div>
          <div className='StreamList-item' style={{ padding: '12px', color: 'var(--base-color--error)' }}>
            {error}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className='StreamManager u-scroll--y'>
      <div className='StreamManager-content'>
        <div className='StreamManager-header'>
          <h1 className='StreamManager-title'>Stream Preview</h1>
          <p className='StreamManager-description' style={{ fontSize: '12px', color: 'var(--base-color--grey1)', marginTop: '4px' }}>
            One preview per channel on a dedicated SRT port (not the output streams). Start/stop with the button below.
          </p>
        </div>

        {channels.length === 0
          ? (
              <div className='StreamList-item' style={{ padding: '12px' }}>
                <div style={{ color: 'var(--base-color--grey1)', fontSize: '12px' }}>
                  No channels available. Add an input stream to see channels for preview.
                </div>
              </div>
            )
          : (
              <div className='StreamList'>
                {channels.map(({ serverId, channel }) => {
                  const active = isPreviewActive(serverId, channel)
                  return (
                    <div key={`${serverId}-${channel}`} className='StreamList-item' style={{ padding: '12px' }}>
                      <div className='StreamList-item-header' style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                        <div className='StreamList-item-title'>
                          Channel: {serverId} / {channel}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          {active
                            ? (
                                <button
                                  type='button'
                                  className='StreamForm-button StreamForm-button--danger'
                                  onClick={() => handleStopPreview(serverId, channel)}
                                >
                                  Stop Preview
                                </button>
                              )
                            : (
                                <button
                                  type='button'
                                  className='StreamForm-button StreamForm-button--primary'
                                  onClick={() => handleStartPreview(serverId, channel)}
                                >
                                  Start Preview
                                </button>
                              )}
                        </div>
                      </div>
                      {active && (
                        <div className='StreamList-item-preview' style={{ marginTop: '12px' }}>
                          <StreamPreviewComponent serverId={serverId} channel={channel} />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
      </div>
    </div>
  )
}
