import React from 'react'

import * as SharedContext from './sharedContext'
import { SettingsConfig } from './views/SettingsConfig'
import { Upload } from './views/Upload'
import { MediaLibrary } from './views/MediaLibrary'

export default function App () {
  const [view, setView] = React.useState()

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    setView(params.get('path'))
  }, [])

  return (
    <SharedContext.Provider>
      {
        (function () {
          switch (view) {
            case 'settings/config':
              return <SettingsConfig />
            case 'upload':
              return <Upload />
            case 'library':
              return <MediaLibrary />
            default:
              return <></>
          }
        })()
      }
    </SharedContext.Provider>
  )
}
