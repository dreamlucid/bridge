// SPDX-FileCopyrightText: 2025 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

const path = require('path')
const fs = require('fs')

const DIController = require('../../shared/DIController')
const DIBase = require('../../shared/DIBase')

const ProjectFile = require('../ProjectFile')
const paths = require('../paths')
const Logger = require('../Logger')
const logger = new Logger({ name: 'Workspace api' })

class SWorkspace extends DIBase {
  constructor (...args) {
    super(...args)
    this.#setup()
  }

  #setup () {
    this.props.SCommands.registerAsyncCommand('workspace.save', this.save.bind(this))
    this.props.SCommands.registerAsyncCommand('workspace.saveAs', this.saveAs.bind(this))
    this.props.SCommands.registerAsyncCommand('workspace.list', this.list.bind(this))
    this.props.SCommands.registerAsyncCommand('workspace.rename', this.rename.bind(this))
  }

  /**
   * Save the workspace to a file
   * If no file path is provided, saves to the default workspaces directory
   * @param { String } filePath Optional file path to save to
   * @returns { Promise.<String> } The file path where the workspace was saved
   */
  async save (filePath) {
    const workspace = this.props.Workspace

    // If no file path provided, use the default workspaces directory
    if (!filePath) {
      // Ensure workspaces directory exists
      if (!fs.existsSync(paths.workspaces)) {
        fs.mkdirSync(paths.workspaces, { recursive: true })
      }

      const workspaceName = workspace.state.data?._title || 'Unnamed'
      const sanitizedName = workspaceName.replace(/[^a-z0-9]/gi, '_').toLowerCase()
      const filename = `${sanitizedName}.${ProjectFile.extensions.workspace}`
      filePath = path.join(paths.workspaces, filename)
    }

    // Ensure directory exists
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    // Mark as saved before writing
    workspace.state.markAsSaved()

    // Write the workspace file
    ProjectFile.main.writeWorkspace(filePath, workspace)

    logger.debug('Workspace saved to', filePath)

    // Update the file path in state if it changed
    if (workspace.state.data?._filePath !== filePath) {
      workspace.state.apply({
        _filePath: filePath
      })
    }

    return filePath
  }

  /**
   * Save the workspace with a specific filename
   * This is similar to save but allows specifying just the filename
   * @param { String } filename The filename to save as
   * @returns { Promise.<String> } The full file path where the workspace was saved
   */
  async saveAs (filename) {
    // Ensure workspaces directory exists
    if (!fs.existsSync(paths.workspaces)) {
      fs.mkdirSync(paths.workspaces, { recursive: true })
    }

    // If filename doesn't have extension, add it
    if (!filename.endsWith(`.${ProjectFile.extensions.workspace}`)) {
      filename = `${filename}.${ProjectFile.extensions.workspace}`
    }

    const filePath = path.join(paths.workspaces, filename)
    return this.save(filePath)
  }

  /**
   * List all saved workspace files
   * @returns { Promise.<Array.<{ filePath: String, filename: String, title: String, modified: Number }>> }
   */
  async list () {
    // Ensure workspaces directory exists
    if (!fs.existsSync(paths.workspaces)) {
      return []
    }

    const files = await fs.promises.readdir(paths.workspaces)
    const workspaceFiles = files.filter(file => file.endsWith(`.${ProjectFile.extensions.workspace}`))

    const workspaces = await Promise.all(
      workspaceFiles.map(async (filename) => {
        const filePath = path.join(paths.workspaces, filename)
        const stats = await fs.promises.stat(filePath)

        // Try to read the workspace to get its title
        let title = filename.replace(`.${ProjectFile.extensions.workspace}`, '')
        try {
          const workspace = await ProjectFile.main.readWorkspace(filePath)
          title = workspace?.state?.data?._title || title
        } catch (err) {
          logger.warn('Failed to read workspace for title', filePath, err)
        }

        return {
          filePath,
          filename,
          title,
          modified: stats.mtime.getTime()
        }
      })
    )

    // Sort by modified date, most recent first
    return workspaces.sort((a, b) => b.modified - a.modified)
  }

  /**
   * Rename the workspace
   * Updates both the filename and the _title in the workspace state
   * @param { String } newName The new name for the workspace
   * @returns { Promise.<String> } The new file path
   */
  async rename (newName) {
    const workspace = this.props.Workspace

    if (!newName || typeof newName !== 'string' || newName.trim().length === 0) {
      throw new Error('Workspace name cannot be empty')
    }

    const sanitizedName = newName.trim().replace(/[^a-z0-9]/gi, '_').toLowerCase()
    const filename = `${sanitizedName}.${ProjectFile.extensions.workspace}`

    // Get current file path or generate new one
    const oldFilePath = workspace.state.data?._filePath
    const newFilePath = path.join(paths.workspaces, filename)

    // If workspace was never saved, just update the title
    if (!oldFilePath || !fs.existsSync(oldFilePath)) {
      workspace.state.apply({
        _title: newName.trim()
      })
      return newFilePath
    }

    // If the new filename is the same as the old one, just update the title
    if (oldFilePath === newFilePath) {
      workspace.state.apply({
        _title: newName.trim()
      })
      // Re-save to update the title in the file
      await this.save(newFilePath)
      return newFilePath
    }

    // Rename the file
    if (fs.existsSync(newFilePath)) {
      throw new Error(`A workspace with the name "${newName}" already exists`)
    }

    await fs.promises.rename(oldFilePath, newFilePath)

    // Update state with new file path and title
    workspace.state.apply({
      _filePath: newFilePath,
      _title: newName.trim()
    })

    logger.debug('Workspace renamed from', oldFilePath, 'to', newFilePath)

    return newFilePath
  }
}

DIController.main.register('SWorkspace', SWorkspace, [
  'Workspace',
  'SCommands'
])

module.exports = SWorkspace
