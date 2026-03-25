// SPDX-FileCopyrightText: 2025
//
// SPDX-License-Identifier: MIT

const fs = require('fs').promises
const fsSync = require('fs')
const path = require('path')
const xml2js = require('xml2js')

/**
 * Parse casparcg.config <paths> the same way media-scanner merges XML (see media-scanner src/config.ts).
 * @param {string} configPath Absolute or relative path to casparcg.config
 * @returns {Promise<{ resolvedRoots: { media: string, template: string, font?: string }, absConfigPath: string }>}
 */
async function parseCasparPaths (configPath) {
  const absConfigPath = path.resolve(configPath)
  await fs.access(absConfigPath)
  const raw = await fs.readFile(absConfigPath, 'utf8')
  const result = await xml2js.parseStringPromise(raw)
  const pathsNode = result?.configuration?.paths?.[0]
  if (!pathsNode || typeof pathsNode !== 'object') {
    throw new Error('casparcg.config: missing or empty <paths>')
  }

  const baseDir = path.dirname(absConfigPath)
  /** @type {Record<string, string>} */
  const merged = {}

  for (const key of Object.keys(pathsNode)) {
    const shortKey = key.split('-')[0]
    const cell = pathsNode[key]
    if (!Array.isArray(cell) || cell.length === 0) {
      continue
    }
    const raw = cell[0]
    const val = typeof raw === 'string'
      ? raw
      : (raw && typeof raw === 'object' && typeof raw._ === 'string' ? raw._ : '')
    if (typeof val !== 'string' || !val.trim()) {
      continue
    }
    const trimmed = val.trim()
    const resolved = path.isAbsolute(trimmed)
      ? path.normalize(trimmed)
      : path.normalize(path.resolve(baseDir, trimmed))
    merged[shortKey] = resolved
  }

  if (!merged.media || !merged.template) {
    throw new Error('casparcg.config must define media-path and template-path')
  }

  for (const k of ['media', 'template']) {
    const p = merged[k]
    if (!fsSync.existsSync(p) || !fsSync.statSync(p).isDirectory()) {
      throw new Error(`${k} path is not an existing directory: ${p}`)
    }
  }

  /** @type {{ media: string, template: string, font?: string }} */
  const resolvedRoots = {
    media: merged.media,
    template: merged.template
  }

  if (merged.font) {
    if (fsSync.existsSync(merged.font) && fsSync.statSync(merged.font).isDirectory()) {
      resolvedRoots.font = merged.font
    }
  } else {
    const defaultFont = path.normalize(path.join(baseDir, 'font'))
    if (fsSync.existsSync(defaultFont) && fsSync.statSync(defaultFont).isDirectory()) {
      resolvedRoots.font = defaultFont
    }
  }

  return { resolvedRoots, absConfigPath }
}

module.exports = { parseCasparPaths }
