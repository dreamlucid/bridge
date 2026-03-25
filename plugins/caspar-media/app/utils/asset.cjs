/**
 * @typedef { 'STILL' | 'MOVIE' | 'AUDIO' | 'TEMPLATE' } LibraryAssetType
 *
 * @typedef {
 *  name: String,
 *  type: LibraryAssetType,
 *  size: String | undefined,
 *  timestamp: String | undefined,
 *  duration: String | undefined,
 *  framerate: String | undefined
 * } LibraryAsset
 */

const DEFAULT_DURATION_MS = 5000

const REX = /"(?<name>.+)"\s{2}(?<type>.+)\s(?<size>.+)\s(?<timestamp>.+)\s(?<duration>.+)\s(?<framerate>.+)/i

const type = Object.freeze({
  still: 'STILL',
  movie: 'MOVIE',
  audio: 'AUDIO',
  template: 'TEMPLATE'
})
exports.type = type

/**
 * Parse a library asset string
 * returned from Caspar as an object
 * @param { String } str
 * @returns { LibraryAsset }
 */
function parseMediaAsset (str) {
  const res = REX.exec(str)
  return {
    ...(res?.groups || {}),
    type: (res?.groups?.type || '').replace(/\s/g, '')
  }
}
exports.parseMediaAsset = parseMediaAsset

/**
 * Parse a library asset string
 * assuming it's a template
 * @param { String } str
 * @returns { LibraryAsset }
 */
function parseTemplateAsset (str) {
  return {
    type: type.template,
    name: str
  }
}
exports.parseTemplateAsset = parseTemplateAsset

/**
 * Calculate the duration in milliseconds from an item
 * based on its framerate and duration in frames
 * @param { any } item
 * @returns { Number }
 */
function calculateDurationMs (item) {
  if (!item) {
    return DEFAULT_DURATION_MS
  }
  if (item.type === 'STILL') {
    return 0
  }
  if (isNaN(Number(item?.duration))) {
    return DEFAULT_DURATION_MS
  }

  if (!item?.framerate) {
    return DEFAULT_DURATION_MS
  }

  const framerate = frameRateFractionToDecimal(item?.framerate)
  if (!framerate) {
    return DEFAULT_DURATION_MS
  }

  return (Math.abs(item?.duration) / framerate) * 1000
}
exports.calculateDurationMs = calculateDurationMs

/**
 * @param {any} fraction
 * @returns decimal value
 */
function frameRateFractionToDecimal (fraction) {
  const [divisorStr, dividendStr] = String(fraction).split('/')

  const divisor = parseInt(divisorStr)
  const dividend = parseInt(dividendStr)

  if (Number.isNaN(divisor) || Number.isNaN(dividend)) {
    return
  }

  if (divisor <= 0) {
    return
  }

  return dividend / divisor
}
