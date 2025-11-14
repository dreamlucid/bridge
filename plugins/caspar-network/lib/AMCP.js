// SPDX-FileCopyrightText: 2024 Sveriges Television AB
//
// SPDX-License-Identifier: MIT

/**
 * Build PLAY command for SRT input stream
 * @param { Number } channel - CasparCG channel
 * @param { Number } layer - CasparCG layer
 * @param { String } srtUrl - SRT URL (e.g., 'srt://localhost:9000?mode=caller&latency=2000&transtype=live')
 * @param { Boolean } loop - Whether to loop the stream
 * @returns { String } AMCP command string
 */
exports.playSrtStream = (channel, layer, srtUrl, loop = false) => {
  const layerStr = layer != null ? `${channel}-${layer}` : `${channel}`
  const loopStr = loop ? ' LOOP' : ''
  return `PLAY ${layerStr} "${srtUrl}"${loopStr}`
}

/**
 * Build ADD STREAM command for SRT output
 * @param { Number } channel - CasparCG channel
 * @param { String } srtUrl - SRT listener URL
 * @param { Object } encodingOptions - Encoding parameters
 * @returns { String } AMCP command string
 */
exports.addStream = (channel, srtUrl, encodingOptions = {}) => {
  const {
    format = 'mpegts',
    codec = 'h264_nvenc',
    preset = 'p4',
    tune = 'll',
    bitrate = '6000k',
    maxrate = '6000k',
    bufsize = '12000k',
    gop = 50,
    keyintMin = 50,
    audio = false
  } = encodingOptions

  let cmd = `ADD ${channel} STREAM "${srtUrl}"`
  cmd += ` -format ${format}`
  cmd += ` -codec:v ${codec}`
  cmd += ` -preset:v ${preset}`
  cmd += ` -tune:v ${tune}`
  cmd += ` -b:v ${bitrate}`
  cmd += ` -maxrate:v ${maxrate}`
  cmd += ` -bufsize:v ${bufsize}`
  cmd += ` -g:v ${gop}`
  cmd += ` -keyint_min:v ${keyintMin}`
  if (!audio) {
    cmd += ' -an'
  }

  return cmd
}

/**
 * Build REMOVE STREAM command
 * @param { Number } channel - CasparCG channel
 * @param { Number } streamIndex - Stream index to remove
 * @returns { String } AMCP command string
 */
exports.removeStream = (channel, streamIndex) => {
  return `REMOVE ${channel} STREAM ${streamIndex}`
}

/**
 * Build STOP command for a layer
 * @param { Number } channel - CasparCG channel
 * @param { Number } layer - CasparCG layer
 * @returns { String } AMCP command string
 */
exports.stop = (channel, layer) => {
  const layerStr = layer != null ? `${channel}-${layer}` : `${channel}`
  return `STOP ${layerStr}`
}

/**
 * Build INFO command to query channel/layer status
 * @param { Object } opts - Options with channel and optional layer
 * @returns { String } AMCP command string
 */
exports.info = (opts = {}) => {
  if (opts.channel == null) {
    return 'INFO'
  }
  if (opts.layer == null) {
    return `INFO ${opts.channel}`
  }
  return `INFO ${opts.channel}-${opts.layer}`
}
