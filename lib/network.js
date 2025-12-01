const os = require('os')
const https = require('https')
const http = require('http')

/**
 * Get the first IPv4
 * address of the server
 * @returns { String }
 */
function getFirstIPv4Address () {
  const nets = os.networkInterfaces()

  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      const familyV4Value = typeof net.family === 'string' ? 'IPv4' : 4
      if (net.family !== familyV4Value || net.internal) {
        continue
      }
      return net.address
    }
  }
}
exports.getFirstIPv4Address = getFirstIPv4Address

/**
 * Get the public IP address of the server by querying external services
 * @param {Object} options - Options for IP detection
 * @param {number} options.timeout - Timeout in milliseconds (default: 5000)
 * @param {string[]} options.services - List of services to try (default: ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com'])
 * @returns {Promise<string|null>} Public IP address or null if detection fails
 */
async function getPublicIPAddress (options = {}) {
  const {
    timeout = 5000,
    services = [
      'https://api.ipify.org',
      'https://ifconfig.me/ip',
      'https://icanhazip.com'
    ]
  } = options

  // Try each service in order
  for (const serviceUrl of services) {
    try {
      const ip = await queryIPService(serviceUrl, timeout)
      if (ip && isValidIP(ip)) {
        return ip.trim()
      }
    } catch (err) {
      // Continue to next service if this one fails
      continue
    }
  }

  return null
}

/**
 * Query an IP service to get the public IP
 * @param {string} url - Service URL
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<string>} IP address
 */
function queryIPService (url, timeout) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https://')
    const client = isHttps ? https : http
    const parsedUrl = new URL(url)

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname,
      method: 'GET',
      timeout
    }

    const req = client.request(options, (res) => {
      let data = ''

      res.on('data', (chunk) => {
        data += chunk
      })

      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data)
        } else {
          reject(new Error(`HTTP ${res.statusCode}`))
        }
      })
    })

    req.on('error', (err) => {
      reject(err)
    })

    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Request timeout'))
    })

    req.end()
  })
}

/**
 * Validate if a string is a valid IP address
 * @param {string} ip - IP address to validate
 * @returns {boolean} True if valid IP
 */
function isValidIP (ip) {
  // Basic IPv4 validation
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/
  if (!ipv4Regex.test(ip)) {
    return false
  }

  // Check each octet is between 0-255
  const parts = ip.split('.')
  return parts.every(part => {
    const num = parseInt(part, 10)
    return num >= 0 && num <= 255
  })
}

exports.getPublicIPAddress = getPublicIPAddress
