// SPDX-FileCopyrightText: 2025 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const DIController = require('../shared/DIController')

function apiErrorMessage (body, fallback) {
  if (!body || typeof body !== 'object') {
    return fallback
  }
  return body.description || body.message || fallback
}

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
      const error = await response.json().catch(() => ({}))
      throw new Error(apiErrorMessage(error, 'Failed to save workspace'))
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
      const error = await response.json().catch(() => ({}))
      throw new Error(apiErrorMessage(error, 'Failed to list workspaces'))
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
      const error = await response.json().catch(() => ({}))
      throw new Error(apiErrorMessage(error, 'Failed to open workspace'))
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
      const error = await response.json().catch(() => ({}))
      throw new Error(apiErrorMessage(error, 'Failed to rename workspace'))
    }

    return response.json()
  }

  /**
   * Import a .bridge file into the server workspaces directory
   * @param { File } file
   * @returns { Promise.<{ filePath: String, filename: String, title: String }> }
   */
  async upload (file) {
    if (!file || typeof file !== 'object') {
      throw new Error('A file is required')
    }
    const form = new FormData()
    form.append('file', file)
    const response = await fetch('/api/v1/workspaces/upload', {
      method: 'POST',
      body: form
    })
    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      throw new Error(apiErrorMessage(error, 'Failed to import workspace'))
    }
    return response.json()
  }

  /**
   * Delete a saved workspace file (must be under the server workspaces directory)
   * @param { String } filePath
   * @returns { Promise.<{ success: Boolean }> }
   */
  async remove (filePath) {
    const response = await fetch('/api/v1/workspaces/delete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ filePath })
    })
    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      throw new Error(apiErrorMessage(error, 'Failed to delete workspace'))
    }
    return response.json()
  }

  /**
   * Download the current workspace (.bridge) via the browser
   */
  download () {
    const workspaceId = window.APP?.workspace
    if (!workspaceId) {
      throw new Error('No workspace ID available')
    }
    window.location.href = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/download`
  }
}

DIController.main.register('Workspace', Workspace, [
  'Transport'
])

module.exports = Workspace
