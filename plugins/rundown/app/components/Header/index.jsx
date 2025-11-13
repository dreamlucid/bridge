import React from 'react'
import bridge from 'bridge'

import './style.css'

import { Icon } from '../../../../../app/components/Icon'
import { ContextMenu } from '../../../../../app/components/ContextMenu'

import { ContextAddMenu } from '../ContextAddMenu'

import * as config from '../../config'
import * as fileUtils from '../../utils/file'

export function Header () {
  const [rundownInfo, setRundownInfo] = React.useState()
  const [contextPos, setContextPos] = React.useState()
  const [isExporting, setIsExporting] = React.useState(false)
  const [isImporting, setIsImporting] = React.useState(false)
  const fileInputRef = React.useRef()

  function handleCreateOnClick (e) {
    e.preventDefault()
    setContextPos([e.pageX, e.pageY])
  }

  /**
   * Add a new item to the
   * end of the rundown
   */
  async function handleAdd (newItemId) {
    bridge.commands.executeCommand('rundown.appendItem', rundownInfo?.id, newItemId)
  }

  /**
   * Load the main rundown
   * in the widget
   */
  function handleLoadMainRundown () {
    window.WIDGET_UPDATE({
      'rundown.id': config.DEFAULT_RUNDOWN_ID
    })
  }

  /**
   * Export the current rundown to a JSON file
   */
  async function handleExport () {
    if (isExporting) {
      return
    }

    setIsExporting(true)
    try {
      const rundownId = rundownInfo?.id || config.DEFAULT_RUNDOWN_ID
      const jsonString = await bridge.commands.executeCommand('rundown.exportRundown', rundownId)

      if (!jsonString) {
        throw new Error('Export returned empty data')
      }

      const filename = `rundown-${rundownInfo?.name || 'export'}-${Date.now()}.json`
      fileUtils.downloadJson(jsonString, filename)

      // Show success message
      window.alert(`Rundown exported successfully!\n\nFile: ${filename}`)
    } catch (error) {
      const errorMessage = error?.message || 'Unknown error occurred'
      window.alert(`Export failed:\n\n${errorMessage}\n\nPlease try again or contact support if the problem persists.`)
    } finally {
      setIsExporting(false)
    }
  }

  /**
   * Trigger the file input to select a file for import
   */
  function handleImport () {
    fileInputRef.current?.click()
  }

  /**
   * Handle file selection and import
   */
  async function handleFileChange (e) {
    const file = e.target.files?.[0]
    if (!file) {
      return
    }

    if (isImporting) {
      e.target.value = ''
      return
    }

    setIsImporting(true)
    try {
      // Read and parse the file
      const items = await fileUtils.readJsonFile(file)

      if (!items || !Array.isArray(items)) {
        throw new Error('Invalid file format: Expected an array of items')
      }

      if (items.length === 0) {
        throw new Error('The file contains no items to import')
      }

      const rundownId = rundownInfo?.id || config.DEFAULT_RUNDOWN_ID

      // Show confirmation dialog for merge vs replace
      const shouldClear = window.confirm(
        'Import Options:\n\n' +
        `File: ${file.name}\n` +
        `Items to import: ${items.length}\n\n` +
        'OK = Replace all items (clear existing)\n' +
        'Cancel = Add to existing items (merge)'
      )

      // Perform the import
      await bridge.commands.executeCommand('rundown.importRundown', rundownId, items, {
        clearExisting: shouldClear
      })

      // Show success message
      const action = shouldClear ? 'replaced' : 'added'
      window.alert(`Import successful!\n\n${items.length} item(s) ${action} to the rundown.`)

      // Reset file input
      e.target.value = ''
    } catch (error) {
      const errorMessage = error?.message || 'Unknown error occurred'
      let userMessage = `Import failed:\n\n${errorMessage}`

      // Provide more helpful messages for common errors
      if (errorMessage.includes('Validation failed')) {
        userMessage += '\n\nThe file may be corrupted or in an incompatible format.'
      } else if (errorMessage.includes('Invalid file type')) {
        userMessage += '\n\nPlease select a valid JSON file.'
      } else if (errorMessage.includes('Invalid JSON')) {
        userMessage += '\n\nThe file is not valid JSON. Please check the file format.'
      }

      userMessage += '\n\nPlease try again or contact support if the problem persists.'

      window.alert(userMessage)

      // Reset file input even on error
      e.target.value = ''
    } finally {
      setIsImporting(false)
    }
  }

  /*
  Setup the rundownInfo-state containing
  the id and name of the current rundown item
  in order to display the path
  */
  React.useEffect(() => {
    async function setup () {
      const id = window.WIDGET_DATA?.['rundown.id'] || config.DEFAULT_RUNDOWN_ID

      const itemData = await (async function () {
        if (id === config.DEFAULT_RUNDOWN_ID) {
          return {}
        }
        const item = await bridge.items.getItem(id)
        return item?.data
      })()

      /*
      Load the main rundown if the
      current rundown cannot be found,

      otherwise the rundown may still
      try to display a group that has
      been removed
      */
      if (!itemData) {
        handleLoadMainRundown()
        return
      }

      setRundownInfo({ id, name: itemData.name })
    }
    setup()
  }, [])

  return (
    <>
      {
        contextPos
          ? (
            <ContextMenu x={contextPos[0]} y={contextPos[1]} onClose={() => setContextPos(undefined)}>
              <ContextAddMenu onAdd={newItemId => handleAdd(newItemId)} />
            </ContextMenu>
            )
          : <></>
      }
      <header className='Header'>
        <div className='Header-section'>
          <button className='Button Button--small Button--ghost Header-addBtn' onClick={e => handleCreateOnClick(e)}>
            <Icon name='add' /> Add
          </button>
          <button
            className='Button Button--small Button--ghost Header-addBtn'
            onClick={handleExport}
            disabled={isExporting || isImporting}
          >
            {isExporting ? 'Exporting...' : 'Export'}
          </button>
          <button
            className='Button Button--small Button--ghost Header-addBtn'
            onClick={handleImport}
            disabled={isExporting || isImporting}
          >
            {isImporting ? 'Importing...' : 'Import'}
          </button>
          <input
            ref={fileInputRef}
            type='file'
            accept='.json,application/json'
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
        </div>
        <div className='Header-section'>
          <div className='Header-path'>
            <span className='Header-pathPart' onClick={() => handleLoadMainRundown()}>Main rundown</span>
            {
              rundownInfo?.name &&
              <span className='Header-pathPart'> / {rundownInfo?.name}</span>
            }
          </div>
        </div>
      </header>
    </>
  )
}
