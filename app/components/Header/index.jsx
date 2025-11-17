import React from 'react'

import { SharedContext } from '../../sharedContext'
import { LocalContext } from '../../localContext'

import { Role } from '../Role'
import { Modal } from '../Modal'
import { Palette } from '../Palette'
import { Sharing } from '../Sharing'
import { Preferences } from '../Preferences'
import { WorkspaceManager } from '../WorkspaceManager'

import { Icon } from '../Icon'

import * as api from '../../api'

import './style.css'

const DEFAULT_TITLE = 'Unnamed'

function isMacOS () {
  return window.APP.platform === 'darwin'
}

function isElectron () {
  return window.navigator.userAgent.includes('Bridge')
}

function handleReload () {
  window.location.reload()
}

async function handleMaximize () {
  if (!isElectron()) {
    return
  }
  const bridge = await api.load()
  bridge.commands.executeCommand('window.toggleMaximize')
}

export function Header ({ title = DEFAULT_TITLE, features }) {
  const [shared, applyShared] = React.useContext(SharedContext)
  const [local] = React.useContext(LocalContext)

  const [paletteIsOpen, setPaletteIsOpen] = React.useState(false)
  const [sharingOpen, setSharingOpen] = React.useState(false)
  const [prefsOpen, setPrefsOpen] = React.useState(false)
  const [roleOpen, setRoleOpen] = React.useState(false)
  const [workspaceManagerOpen, setWorkspaceManagerOpen] = React.useState(false)

  const connectionCount = Object.keys(shared?._connections || {}).length
  const isEditingLayout = shared?._connections?.[local?.id]?.isEditingLayout
  const role = shared?._connections?.[local.id]?.role

  /**
   * Save the workspace
   * Only available in web UI mode (not Electron)
   */
  const handleSave = React.useCallback(async () => {
    if (isElectron()) {
      // In Electron, save is handled by the menu
      return
    }

    try {
      const bridge = await api.load()
      const result = await bridge.workspace.save()
      // Show success message
      bridge.messages.createTextMessage({
        text: `Workspace saved: ${result.filename}`,
        duration: 2000
      })
    } catch (err) {
      console.error('Failed to save workspace:', err)
      // Show error message
      const bridge = await api.load()
      bridge.messages.createTextMessage({
        text: `Failed to save workspace: ${err.message}`,
        duration: 3000
      })
    }
  }, [])

  /*
  Listen for shortcuts
  to open the palette and save
  */
  React.useEffect(() => {
    function onShortcut (shortcut) {
      switch (shortcut) {
        case 'openPalette':
          setPaletteIsOpen(true)
          break
        case 'save':
          if (!isElectron()) {
            handleSave()
          }
          break
      }
    }

    async function setup () {
      const bridge = await api.load()
      bridge.events.on('shortcut', onShortcut)
    }
    setup()

    return () => {
      async function teardown () {
        const bridge = await api.load()
        bridge.events.off('shortcut', onShortcut)
      }
      teardown()
    }
  }, [handleSave])

  /**
   * Close the palette
   */
  function handlePaletteClose () {
    setPaletteIsOpen(false)
  }

  /**
   * Open the palette
   */
  function handlePaletteOpen () {
    setPaletteIsOpen(true)
  }

  function featureShown (feature) {
    if (!Array.isArray(features)) {
      return true
    }
    return features.includes(feature)
  }

  /**
   * Set the `isEditingLayout` toggle on
   * this client's object in the shared state
   * @param { Boolean } isEditing
   */
  function handleEdit (isEditing) {
    applyShared({
      _connections: {
        [local.id]: {
          isEditingLayout: isEditing
        }
      }
    })
  }

  return (
    <>
      <Modal open={prefsOpen} onClose={() => setPrefsOpen(false)}>
        <Preferences onClose={() => setPrefsOpen(false)} />
      </Modal>
      <Palette open={paletteIsOpen} onClose={() => handlePaletteClose()} />
      <WorkspaceManager open={workspaceManagerOpen} onClose={() => setWorkspaceManagerOpen(false)} />
      <header className={`Header ${isMacOS() && isElectron() ? 'hasLeftMargin' : ''}`} onDoubleClick={() => handleMaximize()}>
        <div className='Header-title'>
          { featureShown('title') && title }
          {
            shared?._hasUnsavedChanges &&
            <div className='Header-unsavedDot' />
          }
        </div>
        <div className='Header-center'></div>
        <div className='Header-block'>
          {
            featureShown('role') &&
            (
              <div className='Header-actionSection'>
                <button className={`Header-button Header-roleBtn ${role === 1 ? 'is-main' : ''}`} onClick={() => setRoleOpen(true)}>
                  {role === 1 ? 'Main' : 'Satellite'}
                </button>
                <Role currentRole={role} open={roleOpen} onClose={() => setRoleOpen(false)} />
              </div>
            )
          }
          {
            featureShown('sharing') &&
            (
              <div className='Header-actionSection'>
                <button className='Header-button Header-sharingBtn' onClick={() => setSharingOpen(true)}>
                  <Icon name='person' />
                  {connectionCount || 0}
                </button>
                <Sharing open={sharingOpen} onClose={() => setSharingOpen(false)} />
              </div>
            )
          }
          {
            featureShown('palette') &&
            (
              <button className='Header-button Header-editBtn' onClick={() => handlePaletteOpen()} title='Open palette'>
                <Icon name='search' />
              </button>
            )
          }
          {
            featureShown('reload') &&
            (
              <button className='Header-button Header-editBtn' onClick={() => handleReload()} title='Reload'>
                <Icon name='reload' />
              </button>
            )
          }
          {
            featureShown('editLayout') &&
            (
              <button className={`Header-button Header-editBtn ${isEditingLayout ? 'is-active' : ''}`} onClick={() => handleEdit(!isEditingLayout)} title='Edit layout'>
                <Icon name='edit' color={isEditingLayout ? 'var(--base-color--accent1)' : 'var(--base-color)'} />
              </button>
            )
          }
          {
            featureShown('save') && !isElectron() &&
            (
              <button
                className='Header-button Header-saveBtn'
                onClick={() => handleSave()}
                title='Save workspace (Ctrl+S / Cmd+S)'
                disabled={!shared?._hasUnsavedChanges}
              >
                <Icon name='edit' />
              </button>
            )
          }
          {
            featureShown('workspaces') && !isElectron() &&
            (
              <button
                className='Header-button Header-workspacesBtn'
                onClick={() => setWorkspaceManagerOpen(true)}
                title='Manage workspaces'
              >
                <Icon name='widget' />
              </button>
            )
          }
          {
            featureShown('preferences') &&
            (
              <button className='Header-button Header-preferencesBtn' onClick={() => setPrefsOpen(true)} title='Preferences'>
                <Icon name='preferences' />
              </button>
            )
          }
        </div>
      </header>
    </>
  )
}
