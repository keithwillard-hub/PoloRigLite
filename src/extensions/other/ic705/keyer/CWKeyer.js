/*
 * CW Keyer engine: macro expansion, send buffer management, 30-char chunking, pacing.
 * Ported from CWKeyer.swift.
 *
 * The IC-705 handles Morse encoding internally via CI-V 0x17. This keyer focuses on
 * message composition, macro expansion, and send buffer management.
 */

import { EventEmitter } from '../protocol/EventEmitter'
import { interpolate } from './CWTemplateEngine'

// --- Morse Timing ---

const ELEMENT_COUNTS = {
  A: 5, B: 9, C: 11, D: 7, E: 1, F: 9, G: 9, H: 7, I: 3, J: 13,
  K: 9, L: 9, M: 7, N: 5, O: 11, P: 11, Q: 13, R: 7, S: 5, T: 3,
  U: 7, V: 9, W: 9, X: 11, Y: 13, Z: 11,
  0: 19, 1: 17, 2: 15, 3: 13, 4: 11, 5: 9, 6: 11, 7: 13, 8: 15, 9: 17,
  '/': 13, '?': 15, '.': 17, ',': 19, '=': 13, '-': 15,
  '(': 15, ')': 17, "'": 19, ':': 17, '+': 13, '"': 15, '@': 17
}

/**
 * Estimate transmission duration in seconds.
 */
export function estimateDuration (text, wpm) {
  if (!wpm || wpm <= 0) return 0
  const ditMs = 1200.0 / wpm
  let totalElements = 0
  let prevWasSpace = false

  for (const char of text.toUpperCase()) {
    if (char === ' ') {
      totalElements += 4
      prevWasSpace = true
    } else if (ELEMENT_COUNTS[char] !== undefined) {
      if (!prevWasSpace && totalElements > 0) {
        totalElements += 3
      }
      totalElements += ELEMENT_COUNTS[char]
      prevWasSpace = false
    }
  }

  return (totalElements * ditMs) / 1000.0
}

// --- Send Buffer Entry Types ---
export const EntryType = {
  TEXT: 'text',
  SPEED_CHANGE: 'speedChange',
  DELAY: 'delay',
  SERIAL_NUMBER: 'serialNumber'
}

// --- Default Memories ---
export const DEFAULT_MEMORIES = [
  { label: 'CQ', content: 'CQ CQ CQ DE $mycall $mycall K' },
  { label: 'Reply', content: '$callsign DE $mycall UR RST $rst $rst K' },
  { label: 'Serial', content: 'NR {SERIAL} {SERIAL}' },
  { label: '73', content: '$callsign TU 73 DE $mycall SK' },
  { label: 'AGN?', content: '$callsign AGN?' },
  { label: 'QRZ?', content: 'QRZ? DE $mycall K' }
]

/**
 * CW Keyer with macro expansion, chunking, and paced delivery.
 *
 * Events:
 *   sendingStarted
 *   sendingEnded
 *   chunkSent(chunk, wpm)
 *   sendCW(text, callback)  — callback(success) must be called when CW send completes
 *   setSpeed(wpm)
 */
export class CWKeyer extends EventEmitter {
  constructor () {
    super()
    this.sendBuffer = []
    this.isSending = false
    this._serialNumber = 1
    this.cutNumbersEnabled = false
    this._cancelled = false
    this._processingTimeout = null
  }

  get serialNumber () { return this._serialNumber }
  set serialNumber (val) { this._serialNumber = val }

  // --- Macro Expansion ---

  expandMacros (template, context) {
    const entries = []
    let remaining = template

    while (remaining.length > 0) {
      const braceIdx = remaining.indexOf('{')
      if (braceIdx === -1) {
        entries.push({ type: EntryType.TEXT, value: remaining })
        break
      }

      if (braceIdx > 0) {
        entries.push({ type: EntryType.TEXT, value: remaining.slice(0, braceIdx) })
      }

      const closeIdx = remaining.indexOf('}', braceIdx)
      if (closeIdx === -1) {
        entries.push({ type: EntryType.TEXT, value: remaining.slice(braceIdx) })
        break
      }

      const macroContent = remaining.slice(braceIdx + 1, closeIdx)
      remaining = remaining.slice(closeIdx + 1)
      entries.push(...this._expandSingleMacro(macroContent, context))
    }

    return entries
  }

  _expandSingleMacro (macro, context) {
    const upper = macro.toUpperCase()

    if (upper === 'CALL') return [{ type: EntryType.TEXT, value: (context.callsign || '').toUpperCase() }]
    if (upper === 'MYCALL') return [{ type: EntryType.TEXT, value: (context.myCallsign || '').toUpperCase() }]
    if (upper === 'SERIAL') return [{ type: EntryType.SERIAL_NUMBER }]
    if (upper === 'CUT') return [{ type: EntryType.TEXT, value: this.formatSerialNumber(this._serialNumber, true) }]
    if (upper === 'RST') return [{ type: EntryType.TEXT, value: context.defaultRST || '599' }]
    if (upper === 'FREQ') return [{ type: EntryType.TEXT, value: String(Math.floor((context.frequencyHz || 0) / 1000)) }]

    if (upper.startsWith('SPEED:')) {
      const wpm = parseInt(upper.slice(6), 10)
      if (!isNaN(wpm)) return [{ type: EntryType.SPEED_CHANGE, value: wpm }]
    }

    if (upper.startsWith('DELAY:')) {
      const sec = parseFloat(upper.slice(6))
      if (!isNaN(sec)) return [{ type: EntryType.DELAY, value: sec }]
    }

    // Unknown macro — pass through as literal
    return [{ type: EntryType.TEXT, value: `{${macro}}` }]
  }

  // --- Serial Number ---

  formatSerialNumber (number, useCutNumbers = false) {
    const formatted = String(number).padStart(3, '0')
    if (!useCutNumbers) return formatted
    return formatted.replace(/0/g, 'T').replace(/9/g, 'N')
  }

  // --- Send ---

  sendTemplate (template, context) {
    const entries = this.expandMacros(template, context)
    this.send(entries, context.cwSpeed || 20)
  }

  sendInterpolatedTemplate (template, variables, context) {
    const interpolated = interpolate(template, variables)
    this.sendTemplate(interpolated, context)
  }

  send (entries, wpm) {
    this.sendBuffer.push(...entries)
    if (!this.isSending) {
      this.isSending = true
      this._cancelled = false
      this.emit('sendingStarted')
      this._processNext(wpm)
    }
  }

  cancelSend () {
    this._cancelled = true
    this.sendBuffer = []
    if (this._processingTimeout) {
      clearTimeout(this._processingTimeout)
      this._processingTimeout = null
    }
    this.isSending = false
    this.emit('sendingEnded')
  }

  // --- Buffer Processing ---

  _processNext (wpm) {
    if (this._cancelled || this.sendBuffer.length === 0) {
      this.isSending = false
      this.emit('sendingEnded')
      return
    }

    const entry = this.sendBuffer.shift()

    switch (entry.type) {
      case EntryType.TEXT:
        this._sendTextInChunks(entry.value, wpm)
        break

      case EntryType.SPEED_CHANGE:
        wpm = entry.value
        this.emit('setSpeed', wpm)
        this._processNext(wpm)
        break

      case EntryType.DELAY:
        this._processingTimeout = setTimeout(() => this._processNext(wpm), entry.value * 1000)
        break

      case EntryType.SERIAL_NUMBER: {
        const num = this._serialNumber
        const text = this.formatSerialNumber(num, this.cutNumbersEnabled)
        this._serialNumber = num + 1
        this._sendTextInChunks(text, wpm)
        break
      }
    }
  }

  _sendTextInChunks (text, wpm) {
    const chunks = []
    for (let i = 0; i < text.length; i += 30) {
      chunks.push(text.slice(i, i + 30))
    }
    this._sendChunkSequence(chunks, 0, wpm)
  }

  _sendChunkSequence (chunks, index, wpm) {
    if (this._cancelled || index >= chunks.length) {
      this._processNext(wpm)
      return
    }

    const chunk = chunks[index]

    // Emit sendCW with a completion callback — the listener must call it
    this.emit('sendCW', chunk, (success) => {
      if (!success || this._cancelled) {
        // Abort on failure
        this.sendBuffer = []
        if (this._processingTimeout) {
          clearTimeout(this._processingTimeout)
          this._processingTimeout = null
        }
        this.isSending = false
        this.emit('sendingEnded')
        return
      }

      this.emit('chunkSent', chunk, wpm)

      const duration = estimateDuration(chunk, wpm)
      const pacedDuration = duration * 1.12 // 12% safety margin

      this._processingTimeout = setTimeout(
        () => this._sendChunkSequence(chunks, index + 1, wpm),
        pacedDuration * 1000
      )
    })
  }
}
