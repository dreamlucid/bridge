// SPDX-FileCopyrightText: 2022 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

/**
 * @typedef {{
 *  $id: String,
 *  name: String
 * }} TypeSpecification See lib/schemas/type.schema.json for complete spec
 */

const Validator = require('../Validator')
const MissingTypeError = require('../error/MissingTypeError')

const DIController = require('../../shared/DIController')
const DIBase = require('../../shared/DIBase')

class STypes extends DIBase {
  constructor (...args) {
    super(...args)
    this.#setup()
  }

  #setup () {
    this.props.SCommands.registerAsyncCommand('types.removeType', this.removeType.bind(this))
    this.props.SCommands.registerAsyncCommand('types.registerType', this.registerType.bind(this))
  }

  /**
   * Register a type by
   * its specification
   * @param { TypeSpecification } specification A type specification
   * @returns { Promise.<Boolean> }
   */
  registerType (specification) {
    const validate = Validator.getTypeValidator()
    const isValid = validate(specification)

    if (!isValid) {
      throw Validator.getFirstError(validate)
    }

    /*
    Check if a type with the same id already exists
    to prevent unnecessary re-registrations and state changes.
    If it exists, skip registration to avoid triggering state changes
    on every keystroke when typing in settings.
    */
    const existingType = this.props.Workspace.state.data._types?.[specification.id]
    if (existingType) {
      // Type already exists, skip registration to prevent duplicate state changes
      return true
    }

    this.props.SState.applyState({
      _types: {
        [specification.id]: {
          ...specification
        }
      }
    })
    return true
  }

  /**
   * Remove a type declaration
   * @param { String } id The id of the type to remove
   * @returns { Promise.<Boolean> }
   */
  removeType (id) {
    if (!this.props.Workspace.state.data._types?.[id]) {
      throw new MissingTypeError()
    }
    this.props.SState.applyState({
      _types: {
        [id]: { $delete: true }
      }
    })
    return true
  }
}

DIController.main.register('STypes', STypes, [
  'Workspace',
  'SCommands',
  'SState'
])
