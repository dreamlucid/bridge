// SPDX-FileCopyrightText: 2025 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

/**
 * Download JSON data as a file
 * @param { String | Object } data The JSON data to download (string or object)
 * @param { String } filename The name of the file to download (default: 'rundown-export.json')
 * @returns { void }
 */
export function downloadJson (data, filename = 'rundown-export.json') {
  const jsonString = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  const blob = new Blob([jsonString], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

/**
 * Read and parse a JSON file
 * @param { File } file The file to read
 * @param { Object } options Options for file reading
 * @param { Number } options.maxSize Maximum file size in bytes (default: 10MB)
 * @returns { Promise.<Object | Array> } A promise that resolves to the parsed JSON
 */
export function readJsonFile (file, options = {}) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error('No file provided'))
      return
    }

    // Validate file type
    if (file.type !== 'application/json' && !file.name.endsWith('.json')) {
      reject(new Error('Invalid file type. Please select a JSON file.'))
      return
    }

    // Validate file size (default: 10MB)
    const maxSize = options.maxSize || 10 * 1024 * 1024 // 10MB
    if (file.size > maxSize) {
      const maxSizeMB = (maxSize / (1024 * 1024)).toFixed(1)
      const fileSizeMB = (file.size / (1024 * 1024)).toFixed(1)
      reject(new Error(`File is too large (${fileSizeMB}MB). Maximum size is ${maxSizeMB}MB.`))
      return
    }

    // Validate minimum file size (empty files)
    if (file.size === 0) {
      reject(new Error('The selected file is empty.'))
      return
    }

    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const json = JSON.parse(e.target.result)
        resolve(json)
      } catch (error) {
        reject(new Error('Invalid JSON file: ' + error.message))
      }
    }
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsText(file)
  })
}
