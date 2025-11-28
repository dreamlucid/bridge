import React from 'react'
import bridge from 'bridge'

import { SharedContext } from '../sharedContext'
import { StreamPreview as StreamPreviewComponent } from '../components/StreamPreview'

export const StreamPreview = () => {
  const [state] = React.useContext(SharedContext)
  const [streams, setStreams] = React.useState([])
  const [selectedStreamId, setSelectedStreamId] = React.useState(null)

  const pluginName = window.PLUGIN?.name || 'bridge-plugin-caspar-network'

  // Load streams (only output streams for preview)
  React.useEffect(() => {
    async function loadStreams () {
      try {
        const streamList = await bridge.commands.executeCommand('caspar-network.listStreams')
        // Only show output streams for preview (input streams don't have preview)
        const outputStreams = (streamList?.outputs || []).map(s => ({ ...s, type: 'output' }))
        setStreams(outputStreams)
        // Preview will only start when user explicitly selects a stream from the dropdown
      } catch (err) {
        console.error('Error loading streams:', err)
      }
    }
    loadStreams()

    // Listen for state changes
    const streamsData = state?.plugins?.[pluginName]?.streams
    if (streamsData) {
      // Only show output streams for preview (input streams don't have preview)
      const outputStreams = (streamsData.outputs || []).map(s => ({ ...s, type: 'output' }))
      setStreams(outputStreams)
    }
  }, [state, pluginName, selectedStreamId])

  const selectedStream = streams.find(s => s.id === selectedStreamId)
  const activeStreams = streams.filter(s => s.status === 'active')

  return (
    <div className='StreamManager u-scroll--y'>
      <div className='StreamManager-content'>
        <div className='StreamManager-header'>
          <h1 className='StreamManager-title'>Stream Preview</h1>
        </div>

        <div className='StreamForm'>
          <div className='StreamForm-field'>
            <label className='StreamForm-label'>Select Stream</label>
            <select
              className='StreamForm-input'
              value={selectedStreamId || ''}
              onChange={e => setSelectedStreamId(e.target.value || null)}
            >
              <option value=''>Select a stream...</option>
              {activeStreams.map(stream => (
                <option key={stream.id} value={stream.id}>
                  Output: Channel {stream.channel}, Stream {stream.streamIndex || 'N/A'}
                </option>
              ))}
            </select>
          </div>
        </div>

        {selectedStream && selectedStream.status === 'active'
          ? (
              <div className='StreamList-item' style={{ padding: '12px' }}>
                <div className='StreamList-item-header'>
                  <div className='StreamList-item-title'>
                    Output: Channel {selectedStream.channel}, Stream {selectedStream.streamIndex || 'N/A'}
                  </div>
                  <div className={'StreamList-item-status StreamList-item-status--active'}>
                    ACTIVE
                  </div>
                </div>
                <div className='StreamList-item-preview' style={{ marginTop: '12px' }}>
                  <StreamPreviewComponent streamId={selectedStream.id} />
                </div>
              </div>
            )
          : selectedStreamId
            ? (
                <div className='StreamList-item' style={{ padding: '12px' }}>
                  <div style={{ color: 'var(--base-color--grey1)', fontSize: '12px' }}>
                    Stream is not active. Please start the stream to preview it.
                  </div>
                </div>
              )
            : (
                <div className='StreamList-item' style={{ padding: '12px' }}>
                  <div style={{ color: 'var(--base-color--grey1)', fontSize: '12px' }}>
                    No stream selected. Select an active stream from the dropdown above.
                  </div>
                </div>
              )}
      </div>
    </div>
  )
}
