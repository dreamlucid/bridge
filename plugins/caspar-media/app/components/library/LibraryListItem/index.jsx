import React from 'react'
import bridge from 'bridge'

import './style.css'

import { SharedContext } from '../../../sharedContext'
import * as asset from '../../../utils/asset.cjs'

const DEFAULT_VALUES = {
  [asset.type.still]: {
    channel: 1,
    layer: 10
  },
  [asset.type.movie]: {
    channel: 1,
    layer: 10
  },
  [asset.type.audio]: {
    channel: 1,
    layer: 30
  },
  [asset.type.template]: {
    channel: 1,
    layer: 20
  }
}

const ITEM_CONSTRUCTORS = [
  {
    if: item => [asset.type.still, asset.type.movie, asset.type.audio].includes(item.type),
    fn: item => {
      return {
        type: 'bridge.caspar.media',
        data: {
          name: item.name,
          caspar: {
            server: item?._filter?.serverId,
            target: item.name,
            ...(DEFAULT_VALUES[item.type] || {})
          },
          duration: asset.calculateDurationMs(item)
        }
      }
    }
  },
  {
    if: item => asset.type.template === item.type,
    fn: item => {
      return {
        type: 'bridge.caspar.template',
        data: {
          name: item.name,
          caspar: {
            server: item?._filter?.serverId,
            target: item.name,
            ...(DEFAULT_VALUES[item.type] || {})
          }
        }
      }
    }
  }
]

function constructPlayableItemInit (libraryAsset) {
  for (const constructor of ITEM_CONSTRUCTORS) {
    if (constructor.if(libraryAsset)) {
      return constructor.fn(libraryAsset)
    }
  }
}

const canDeleteFromDisk = item =>
  item.type === asset.type.template ||
  [asset.type.still, asset.type.movie, asset.type.audio].includes(item.type)

function deleteTargetForItem (item) {
  return item.type === asset.type.template ? 'template' : 'media'
}

/**
 * @param {{ item: import('../../../utils/asset.cjs').LibraryAsset, onLibraryRefresh?: () => void }} arg0
 */
export const LibraryListItem = ({ item = {}, onLibraryRefresh = () => {} }) => {
  const [state] = React.useContext(SharedContext)
  const [deleting, setDeleting] = React.useState(false)

  const workspaceId = React.useMemo(() => {
    if (state?._id) {
      return state._id
    }
    if (typeof window !== 'undefined' && window.APP?.workspace) {
      return window.APP.workspace
    }
    return undefined
  }, [state?._id])

  async function handleDragStart (e) {
    const data = constructPlayableItemInit(item)
    if (!data) {
      return
    }
    e.dataTransfer.setData('bridge/item', JSON.stringify(data))
    e.stopPropagation()
  }

  async function handleDoubleClick () {
    const data = constructPlayableItemInit(item)
    if (!data) {
      return
    }
    const itemId = await bridge.items.createItem(data.type, data.data)
    bridge.commands.executeCommand('rundown.appendItem', 'RUNDOWN_ROOT', itemId)
  }

  async function handleDelete (e) {
    e.preventDefault()
    e.stopPropagation()
    if (!canDeleteFromDisk(item)) {
      return
    }
    if (!workspaceId) {
      window.alert('No workspace id; cannot delete.')
      return
    }
    if (!window.confirm(`Delete from disk (library root): ${item.name}?`)) {
      return
    }
    setDeleting(true)
    try {
      const res = await fetch(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/caspar-media/delete`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            target: deleteTargetForItem(item),
            logicalName: item.name
          })
        }
      )
      const text = await res.text()
      if (!res.ok) {
        let detail = text
        try {
          const j = JSON.parse(text)
          detail = j.description || detail
        } catch (_) {}
        window.alert(`Delete failed: ${res.status} ${detail}`)
        return
      }
      onLibraryRefresh()
    } catch (err) {
      window.alert(err?.message || String(err))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <li
      className='LibraryListItem'
      onDragStart={e => handleDragStart(e)}
      onDoubleClick={handleDoubleClick}
      draggable={!!constructPlayableItemInit(item)}
    >
      <div className='LibraryListItem-name LibraryListItem-col' title={item?.name}>
        {item?.name}
      </div>
      <div className='LibraryListItem-actions'>
        <div className='LibraryListItem-col LibraryListItem-metadata'>
          {item?.type}
        </div>
        {
          canDeleteFromDisk(item) &&
            (
              <button
                type='button'
                className='Button Button--small LibraryListItem-delete'
                disabled={deleting}
                onClick={handleDelete}
              >
                Delete
              </button>
            )
        }
      </div>
    </li>
  )
}
