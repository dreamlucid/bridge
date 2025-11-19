/* eslint-disable quotes */
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
 * @param { Number } index - Stream index
 * @param { String } srtUrl - SRT listener URL
 * @param { Object } encodingOptions - Encoding parameters
 * @returns { String } AMCP command string
 */
exports.addStream = (channel, index, srtUrl, encodingOptions = {}) => {
  const {
    format = 'mpegts',
    codec = 'h264_vaapi', // Default to VAAPI (available in custom FFmpeg build)
    preset = 'p4',
    tune = 'll',
    bitrate = '6000k',
    maxrate = '6000k',
    bufsize = '12000k',
    gop = 50,
    keyintMin = 50,
    audio = false
  } = encodingOptions

  let cmd = `ADD ${channel}-${index} STREAM "${srtUrl}"`
  cmd += ` -format ${format}`
  cmd += ` -codec:v ${codec}`

  // Encoder-specific options (syntax varies by encoder)
  if (codec === 'h264_nvenc' || codec === 'hevc_nvenc') {
    // NVIDIA encoder - use without :v suffix for newer FFmpeg
    cmd += ` -preset ${preset}`
    cmd += ` -tune ${tune}`
    cmd += ` -rc vbr`
  } else if (codec === 'h264_vaapi' || codec === 'hevc_vaapi') {
    // VAAPI encoder - different options
    cmd += ` -rc_mode VBR`
    cmd += ` -quality 4`
    cmd += ` -async_depth 4`
  } else if (codec === 'h264_v4l2m2m') {
    // V4L2 encoder - minimal options
    cmd += ` -num_capture_buffers 4`
  } else if (codec === 'libx264') {
    // CPU encoder
    cmd += ` -preset ultrafast`
    cmd += ` -tune zerolatency`
  } else {
    // Generic fallback - try old syntax for compatibility
    cmd += ` -preset:v ${preset}`
    if (tune) {
      cmd += ` -tune:v ${tune}`
    }
  }

  // Common options (work for all encoders)
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
 * @param { Number } index - Stream index to remove
 * @returns { String } AMCP command string
 */
exports.removeStream = (channel, index) => {
  return `REMOVE ${channel}-${index}`
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
