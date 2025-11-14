import React from 'react'

import * as SharedContext from './sharedContext'

import { StreamInputs } from './views/StreamInputs'
import { StreamOutputs } from './views/StreamOutputs'
import { StreamPreview } from './views/StreamPreview'

export default function App () {
  const [view, setView] = React.useState(null)
  const [error, setError] = React.useState(null)

  React.useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      const path = params.get('path')
      console.log('Caspar Network Plugin: View path from URL:', path)
      setView(path)
    } catch (err) {
      console.error('Error parsing URL:', err)
      setError(err.message)
    }
  }, [])

  if (error) {
    return (
      <div style={{ padding: '20px', color: 'red' }}>
        <p>Error: {error}</p>
      </div>
    )
  }

  return (
    <SharedContext.Provider>
      {
        (function () {
          switch (view) {
            case 'inputs':
              return <StreamInputs />
            case 'outputs':
              return <StreamOutputs />
            case 'preview':
              return <StreamPreview />
            default:
              return (
                <div style={{ padding: '20px' }}>
                  <p>No view selected. Path: {view || 'null'}</p>
                  <p>Available views: inputs, outputs, preview</p>
                  <p>Current URL: {window.location.href}</p>
                  <p>Search params: {window.location.search}</p>
                </div>
              )
          }
        })()
      }
    </SharedContext.Provider>
  )
}
