// SPDX-FileCopyrightText: 2025 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const DIController = require('../shared/DIController')

class Workspace {
  #props

  constructor (props) {
    this.#props = props
  }

  /**
   * Save the workspace to the default data directory
   * @param { String } filename Optional filename to save as
   * @returns { Promise.<{ success: Boolean, filePath: String, filename: String }> }
   */
  async save (filename) {
    const workspaceId = window.APP?.workspace
    if (!workspaceId) {
      throw new Error('No workspace ID available')
    }

    const response = await fetch(`/api/v1/workspaces/${workspaceId}/save`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ filename })
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Failed to save workspace' }))
      throw new Error(error.message || 'Failed to save workspace')
    }

    return response.json()
  }

  /**
   * List all saved workspaces
   * @returns { Promise.<Array.<{ filePath: String, filename: String, title: String, modified: Number }>> }
   */
  async list () {
    const response = await fetch('/api/v1/workspaces/list')

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Failed to list workspaces' }))
      throw new Error(error.message || 'Failed to list workspaces')
    }

    return response.json()
  }

  /**
   * Open a workspace from a file path
   * @param { String } filePath The file path of the workspace to open
   * @returns { Promise.<{ success: Boolean, workspaceId: String, redirectUrl: String }> }
   */
  async open (filePath) {
    const response = await fetch('/api/v1/workspaces/open', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ filePath })
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Failed to open workspace' }))
      throw new Error(error.message || 'Failed to open workspace')
    }

    const result = await response.json()

    // Redirect to the new workspace
    if (result.redirectUrl) {
      window.location.href = result.redirectUrl
    }

    return result
  }

  /**
   * Rename the current workspace
   * @param { String } name The new name for the workspace
   * @returns { Promise.<{ success: Boolean, filePath: String, filename: String, name: String }> }
   */
  async rename (name) {
    const workspaceId = window.APP?.workspace
    if (!workspaceId) {
      throw new Error('No workspace ID available')
    }

    const response = await fetch(`/api/v1/workspaces/${workspaceId}/rename`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name })
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Failed to rename workspace' }))
      throw new Error(error.message || 'Failed to rename workspace')
    }

    return response.json()
  }
}

DIController.main.register('Workspace', Workspace, [
  'Transport'
])

module.exports = Workspace

