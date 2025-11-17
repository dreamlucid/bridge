import React from 'react'
import { Modal } from '../Modal'
import { Icon } from '../Icon'
import * as api from '../../api'
import './style.css'

export function WorkspaceManager ({ open, onClose = () => {} }) {
  const [workspaces, setWorkspaces] = React.useState([])
  const [loading, setLoading] = React.useState(false)
  const [renamingId, setRenamingId] = React.useState(null)
  const [renameValue, setRenameValue] = React.useState('')
  const [error, setError] = React.useState(null)

  // Load workspaces when modal opens
  React.useEffect(() => {
    if (!open) {
      return
    }
    loadWorkspaces()
  }, [open])

  async function loadWorkspaces () {
    setLoading(true)
    setError(null)
    try {
      const bridge = await api.load()
      const list = await bridge.workspace.list()
      setWorkspaces(list)
    } catch (err) {
      setError(err.message || 'Failed to load workspaces')
      console.error('Failed to load workspaces:', err)
    } finally {
      setLoading(false)
    }
  }

  async function handleOpenWorkspace (filePath) {
    try {
      const bridge = await api.load()
      await bridge.workspace.open(filePath)
      // The open method will redirect, so we don't need to close the modal
    } catch (err) {
      setError(err.message || 'Failed to open workspace')
      console.error('Failed to open workspace:', err)
    }
  }

  async function handleRename (workspace, newName) {
    if (!newName || newName.trim().length === 0) {
      setRenamingId(null)
      return
    }

    try {
      const bridge = await api.load()
      await bridge.workspace.rename(newName.trim())
      setRenamingId(null)
      setRenameValue('')
      // Reload the list to show updated name
      await loadWorkspaces()
      // Show success message
      bridge.messages.createTextMessage({
        text: `Workspace renamed to "${newName.trim()}"`,
        duration: 2000
      })
    } catch (err) {
      setError(err.message || 'Failed to rename workspace')
      console.error('Failed to rename workspace:', err)
    }
  }

  function startRename (workspace) {
    setRenamingId(workspace.filePath)
    setRenameValue(workspace.title)
  }

  function cancelRename () {
    setRenamingId(null)
    setRenameValue('')
  }

  function formatDate (timestamp) {
    const date = new Date(timestamp)
    const now = new Date()
    const diffMs = now - date
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) {
      return 'Just now'
    } else if (diffMins < 60) {
      return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`
    } else if (diffHours < 24) {
      return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`
    } else if (diffDays < 7) {
      return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`
    } else {
      return date.toLocaleDateString()
    }
  }

  return (
    <Modal open={open} onClose={onClose} size='medium'>
      <div className='WorkspaceManager'>
        <div className='WorkspaceManager-header'>
          <h1>Workspaces</h1>
          <button className='WorkspaceManager-close' onClick={onClose}>
            <Icon name='close' />
          </button>
        </div>

        {error && (
          <div className='WorkspaceManager-error'>
            {error}
          </div>
        )}

        <div className='WorkspaceManager-content'>
          {loading ? (
            <div className='WorkspaceManager-loading'>Loading workspaces...</div>
          ) : workspaces.length === 0 ? (
            <div className='WorkspaceManager-empty'>No saved workspaces found</div>
          ) : (
            <div className='WorkspaceManager-list'>
              {workspaces.map((workspace) => (
                <div key={workspace.filePath} className='WorkspaceManager-item'>
                  {renamingId === workspace.filePath ? (
                    <div className='WorkspaceManager-rename'>
                      <input
                        type='text'
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            handleRename(workspace, renameValue)
                          } else if (e.key === 'Escape') {
                            cancelRename()
                          }
                        }}
                        autoFocus
                        className='WorkspaceManager-renameInput'
                      />
                      <button
                        className='WorkspaceManager-renameButton'
                        onClick={() => handleRename(workspace, renameValue)}
                      >
                        Save
                      </button>
                      <button
                        className='WorkspaceManager-renameButton'
                        onClick={cancelRename}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <>
                      <div
                        className='WorkspaceManager-itemContent'
                        onClick={() => handleOpenWorkspace(workspace.filePath)}
                      >
                        <div className='WorkspaceManager-itemTitle'>{workspace.title}</div>
                        <div className='WorkspaceManager-itemMeta'>
                          {formatDate(workspace.modified)}
                        </div>
                      </div>
                      <button
                        className='WorkspaceManager-itemAction'
                        onClick={() => startRename(workspace)}
                        title='Rename workspace'
                      >
                        <Icon name='edit' />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

