import React from 'react'
import bridge from 'bridge'

import { LibraryHeader } from '../components/library/LibraryHeader'
import { LibraryList } from '../components/library/LibraryList'

import * as asset from '../utils/asset.cjs'

const STATUS = Object.freeze({
  idle: 0,
  list: 1,
  loading: 2,
  error: 3
})

const NO_SERVER_ID = '__none'

export const MediaLibrary = () => {
  const [status, setStatus] = React.useState(STATUS.idle)
  const [items, setItems] = React.useState()

  const [filter, setFilter] = React.useState({})

  const lastFetchFilterRef = React.useRef(null)

  const bumpRefresh = React.useCallback(() => {
    setFilter(f => ({ ...f, refresh: Date.now() }))
  }, [])

  React.useEffect(() => {
    async function exec () {
      setItems([])

      if (!filter.serverId || filter.serverId === NO_SERVER_ID) {
        setStatus(STATUS.idle)
        return
      }

      const prev = lastFetchFilterRef.current
      if (
        prev &&
        prev.serverId === filter.serverId &&
        prev.refresh === filter.refresh
      ) {
        return
      }

      setStatus(STATUS.loading)

      try {
        const res = await Promise.all([
          bridge.commands.executeCommand('caspar.sendCommand', filter.serverId, 'cls'),
          bridge.commands.executeCommand('caspar.sendCommand', filter.serverId, 'tls')
        ])

        const parsedMediaAssets = (res?.[0]?.data || [])
          .map(asset.parseMediaAsset)

        const parsedTemplateAssets = (res?.[1]?.data || [])
          .map(asset.parseTemplateAsset)

        const sortedAssets = [...parsedMediaAssets, ...parsedTemplateAssets]
          .sort((a, b) => String(a.name || '').localeCompare(b.name || ''))

        setItems(sortedAssets)
        setStatus(STATUS.list)
        lastFetchFilterRef.current = {
          serverId: filter.serverId,
          refresh: filter.refresh
        }
      } catch (_) {
        setStatus(STATUS.error)
      }
    }
    exec()
  }, [filter?.serverId, filter?.refresh])

  const filteredItems = React.useMemo(() => {
    const query = (filter?.query || '').toLowerCase()
    return (items || [])
      .filter(item => {
        return `${item.name || ''}`.toLowerCase()
          .indexOf(query) >= 0
      })
      .map(item => ({
        ...item,
        _filter: filter
      }))
  }, [items, filter])

  return (
    <div className='View--flex'>
      <LibraryHeader onChange={filter => setFilter(filter)} />
      {
        status === STATUS.idle &&
        (
          <div className='View--center'>
            <div className='u-textAlign--center'>
              Select a server<br />
              to load the library
            </div>
          </div>
        )
      }
      {
        status === STATUS.error &&
        <div className='Warning' />
      }
      {
        status === STATUS.loading &&
        <div className='Loader' />
      }
      {
        status === STATUS.list &&
        <LibraryList items={filteredItems} onLibraryRefresh={bumpRefresh} />
      }
    </div>
  )
}
