/*
 * CI-V protocol constants, frame building, and BCD codec for Icom IC-705.
 * Ported from CIVConstants.swift and CIVController.swift.
 */

// --- Addresses ---
export const RADIO_ADDRESS = 0xA4
export const CONTROLLER_ADDRESS = 0xE0
export const PREAMBLE = 0xFE
export const TERMINATOR = 0xFD
export const ACK = 0xFB
export const NAK = 0xFA

// --- Command Codes ---
export const Command = {
  readFrequency: 0x03,
  readMode: 0x04,
  setFrequency: 0x05,
  setMode: 0x06,
  setLevel: 0x14,
  function: 0x16,
  sendCW: 0x17,
  cwSpeedSub: 0x0C,
  cwPitchSub: 0x09,
  rfPowerSub: 0x0A,
  breakInSub: 0x47
}

// --- Operating Modes ---
export const Mode = {
  0x00: 'LSB',
  0x01: 'USB',
  0x02: 'AM',
  0x03: 'CW',
  0x04: 'RTTY',
  0x05: 'FM',
  0x07: 'CW-R',
  0x08: 'RTTY-R'
}

export const ModeValues = {
  LSB: 0x00,
  USB: 0x01,
  AM: 0x02,
  CW: 0x03,
  RTTY: 0x04,
  FM: 0x05,
  'CW-R': 0x07,
  'RTTY-R': 0x08
}

// --- CW Speed ---
export const CW_SPEED_MIN = 6
export const CW_SPEED_MAX = 48

/**
 * Convert WPM to the 0-255 BCD-encoded value the radio expects.
 * IC-705 maps 6 WPM -> 0x0000 and 48 WPM -> 0x0255 (BCD).
 * @returns {[number, number]} [highByte, lowBCDByte]
 */
export function wpmToValue (wpm) {
  const clamped = Math.min(Math.max(wpm, CW_SPEED_MIN), CW_SPEED_MAX)
  const raw = Math.round((clamped - CW_SPEED_MIN) / (CW_SPEED_MAX - CW_SPEED_MIN) * 255)
  const high = Math.floor(raw / 100)
  const lowTens = Math.floor((raw % 100) / 10)
  const lowOnes = raw % 10
  return [high, (lowTens << 4) | lowOnes]
}

/**
 * Convert BCD-encoded speed value back to WPM.
 * @param {number} high - high byte (hundreds digit)
 * @param {number} low - low byte (BCD tens/ones)
 * @returns {number} WPM
 */
export function valueToWpm (high, low) {
  const bcdValue = high * 100 + ((low >> 4) & 0x0F) * 10 + (low & 0x0F)
  return Math.round(bcdValue / 255 * (CW_SPEED_MAX - CW_SPEED_MIN)) + CW_SPEED_MIN
}

// --- BCD Frequency Codec ---

/**
 * Decode 5 BCD bytes (LSB first) to Hz.
 * @param {number[]|Uint8Array} bytes - 5 BCD bytes
 * @returns {number|null} frequency in Hz, or null if invalid
 */
export function parseFrequencyHz (bytes) {
  if (!bytes || bytes.length < 5) return null
  let hz = 0
  let multiplier = 1
  for (let i = 0; i < 5; i++) {
    const lowNibble = bytes[i] & 0x0F
    const highNibble = (bytes[i] >> 4) & 0x0F
    if (lowNibble > 9 || highNibble > 9) return null
    hz += lowNibble * multiplier
    multiplier *= 10
    hz += highNibble * multiplier
    multiplier *= 10
  }
  return hz
}

/**
 * Encode Hz to 5 BCD bytes (LSB first).
 * @param {number} hz
 * @returns {number[]}
 */
export function frequencyToBytes (hz) {
  let remaining = hz
  const bytes = []
  for (let i = 0; i < 5; i++) {
    const lowDigit = remaining % 10
    remaining = Math.floor(remaining / 10)
    const highDigit = remaining % 10
    remaining = Math.floor(remaining / 10)
    bytes.push((highDigit << 4) | lowDigit)
  }
  return bytes
}

/**
 * Format Hz as readable string.
 */
export function formatMHz (hz) {
  if (hz >= 1_000_000_000) {
    return (hz / 1_000_000_000).toFixed(3) + ' GHz'
  } else if (hz >= 1_000_000) {
    return (hz / 1_000_000).toFixed(3) + ' MHz'
  } else {
    return (hz / 1_000).toFixed(3) + ' kHz'
  }
}

/**
 * Format Hz as short kHz string for CW macros.
 */
export function formatKHz (hz) {
  return String(Math.floor(hz / 1000))
}

// --- Frame Building ---

/**
 * Build a complete CI-V frame: FE FE <to> <from> <cmd> [sub] [data...] FD
 */
export function buildFrame (command, subCommand, data) {
  const parts = [PREAMBLE, PREAMBLE, RADIO_ADDRESS, CONTROLLER_ADDRESS, command]
  if (subCommand !== undefined && subCommand !== null) {
    parts.push(subCommand)
  }
  if (data) {
    for (const b of data) parts.push(b)
  }
  parts.push(TERMINATOR)
  return new Uint8Array(parts)
}

// --- Convenience Builders ---

export function buildReadFrequency () {
  return buildFrame(Command.readFrequency)
}

export function buildReadMode () {
  return buildFrame(Command.readMode)
}

export function buildReadCWSpeed () {
  return buildFrame(Command.setLevel, Command.cwSpeedSub)
}

export function buildSetFrequency (hz) {
  return buildFrame(Command.setFrequency, null, frequencyToBytes(hz))
}

export function buildSetCWSpeed (wpm) {
  const [high, low] = wpmToValue(wpm)
  return buildFrame(Command.setLevel, Command.cwSpeedSub, [high, low])
}

export function buildSendCW (text) {
  const upper = text.toUpperCase()
  const bytes = []
  for (let i = 0; i < Math.min(upper.length, 30); i++) {
    bytes.push(upper.charCodeAt(i))
  }
  return buildFrame(Command.sendCW, null, bytes)
}

export function buildStopCW () {
  return buildFrame(Command.sendCW, null, [0xFF])
}

// --- Response Parser ---

/**
 * Parse a CI-V response frame.
 * @param {Uint8Array} data - raw CI-V frame
 * @returns {{ command: number, subCommand?: number, payload: Uint8Array, isAck: boolean, isNak: boolean, source: number, destination: number }|null}
 */
export function parseCIVResponse (data) {
  if (!data || data.length < 6) return null
  if (data[0] !== PREAMBLE || data[1] !== PREAMBLE) return null
  if (data[data.length - 1] !== TERMINATOR) return null

  const destination = data[2]
  const source = data[3]
  const command = data[4]

  return {
    destination,
    source,
    command,
    payload: data.slice(5, data.length - 1),
    isAck: command === ACK,
    isNak: command === NAK
  }
}
