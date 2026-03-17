/*
 * Operation queue for serialized radio operations with typed results.
 * Ported from PersistentRadioSession.swift operation model.
 *
 * Operations: status, cwSpeedWarmup, cwSpeed, sendCW, setCWSpeed, stopCW
 * One active operation at a time; new operations queue behind the current one.
 */

import { TimeoutError, OperationCancelledError } from './RadioError'

/**
 * Estimate the transmission duration of CW text in seconds.
 * Based on Paris standard: 50 units per word at 1 WPM = 60 seconds.
 * @param {string} text - The text to transmit
 * @param {number} wpm - Words per minute (default 20)
 * @returns {number} Duration in seconds
 */
function estimateCWDuration (text, wpm = 20) {
  if (!text || text.length === 0) return 0
  const effectiveWPM = Math.max(1, wpm)

  // Morse timing (in units where 1 dot = 1 unit):
  // Dot = 1, Dash = 3, Intra-character gap = 1, Inter-character gap = 3, Word gap = 7
  const morseUnits = {
    'A': [1, 3], 'B': [3, 1, 1, 1], 'C': [3, 1, 3, 1], 'D': [3, 1, 1], 'E': [1],
    'F': [1, 1, 3, 1], 'G': [3, 3, 1], 'H': [1, 1, 1, 1], 'I': [1, 1], 'J': [1, 3, 3, 3],
    'K': [3, 1, 3], 'L': [1, 3, 1, 1], 'M': [3, 3], 'N': [3, 1], 'O': [3, 3, 3],
    'P': [1, 3, 3, 1], 'Q': [3, 3, 1, 3], 'R': [1, 3, 1], 'S': [1, 1, 1], 'T': [3],
    'U': [1, 1, 3], 'V': [1, 1, 1, 3], 'W': [1, 3, 3], 'X': [3, 1, 1, 3], 'Y': [3, 1, 3, 3],
    'Z': [3, 3, 1, 1], '0': [3, 3, 3, 3, 3], '1': [1, 3, 3, 3, 3], '2': [1, 1, 3, 3, 3],
    '3': [1, 1, 1, 3, 3], '4': [1, 1, 1, 1, 3], '5': [1, 1, 1, 1, 1], '6': [3, 1, 1, 1, 1],
    '7': [3, 3, 1, 1, 1], '8': [3, 3, 3, 1, 1], '9': [3, 3, 3, 3, 1], '?': [1, 1, 3, 3, 1, 1],
    '/': [3, 1, 1, 3, 1], '=': [3, 1, 1, 1, 3]
  }

  let totalUnits = 0
  const upperText = text.toUpperCase()

  for (let i = 0; i < upperText.length; i++) {
    const char = upperText[i]
    if (char === ' ') {
      // Word gap: 7 units, but we already added 3 for the previous character's inter-char gap
      // So add 4 more to make it 7 total
      totalUnits += 4
    } else {
      const units = morseUnits[char]
      if (units) {
        // Add units for this character
        totalUnits += units.reduce((a, b) => a + b, 0)
        // Add inter-character gap (3 units), except for last char or if next is space
        if (i < upperText.length - 1 && upperText[i + 1] !== ' ') {
          totalUnits += 3
        }
      }
    }
  }

  // Duration = (total units * 1.2 / WPM) seconds
  // 1.2 = 60 seconds / 50 units per word
  return (totalUnits * 1.2) / effectiveWPM
}

// Operation type definitions with default timeouts
const OperationDefs = {
  status: { timeout: 12000, expectsFreq: true, expectsMode: true },
  cwSpeedWarmup: { timeout: 16000, expectsFreq: true, expectsMode: true, expectsSpeed: true },
  cwSpeed: { timeout: 10000, expectsSpeed: true },
  sendCW: { timeout: 10000, fireAndForget: true },
  setCWSpeed: { timeout: 10000 },
  stopCW: { timeout: 10000, fireAndForget: true }
}

export class OperationQueue {
  /**
   * @param {object} opts
   * @param {function} opts.onSendCIV - (civFrame, opts) => void — sends a CI-V frame
   * @param {function} opts.onFlush - () => void — flushes the CI-V queue
   * @param {function} opts.onSuspendTraffic - () => void — suspends background traffic
   * @param {function} opts.onResumeTraffic - () => void — resumes background traffic
   */
  constructor ({ onSendCIV, onFlush, onSuspendTraffic, onResumeTraffic }) {
    this._sendCIV = onSendCIV
    this._flush = onFlush
    this._suspendTraffic = onSuspendTraffic
    this._resumeTraffic = onResumeTraffic

    this._queue = []
    this._active = null
    this._timeoutHandle = null
  }

  get isActive () { return this._active !== null }
  get activeType () { return this._active?.type || null }
  get depth () { return this._queue.length }

  /**
   * Enqueue an operation. Returns a Promise that resolves with the typed result.
   * @param {string} type - operation type
   * @param {*} payload - operation-specific data (e.g., text for sendCW, wpm for setCWSpeed)
   * @returns {Promise<*>}
   */
  enqueue (type, payload) {
    const def = OperationDefs[type]
    if (!def) return Promise.reject(new Error(`Unknown operation: ${type}`))

    return new Promise((resolve, reject) => {
      const op = {
        type,
        payload,
        def,
        resolve,
        reject,
        // Accumulated sub-responses for multi-part operations
        result: {}
      }
      this._queue.push(op)
      this._processNext()
    })
  }

  /**
   * Feed a CI-V response into the active operation's state accumulator.
   * Called by ConnectionManager when a CI-V data response arrives.
   * @param {'frequency'|'mode'|'cwSpeed'|'ack'|'nak'} responseType
   * @param {*} value
   */
  handleResponse (responseType, value) {
    if (!this._active) return

    const op = this._active

    if (responseType === 'nak') {
      this._finishActive(false, null, 'NAK received')
      return
    }

    if (responseType === 'ack') {
      // For fire-and-forget ops (sendCW, stopCW), ACK completes immediately
      if (op.def.fireAndForget) {
        this._finishActive(true, true)
        return
      }
      // For setCWSpeed, ACK means success
      if (op.type === 'setCWSpeed') {
        this._finishActive(true, true)
        return
      }
      // For other ops, ACK is just one response — keep accumulating
      return
    }

    // Accumulate sub-responses
    if (responseType === 'frequency' && (op.def.expectsFreq)) {
      op.result.frequency = value
    } else if (responseType === 'mode' && (op.def.expectsMode)) {
      op.result.mode = value
    } else if (responseType === 'cwSpeed' && (op.def.expectsSpeed)) {
      op.result.cwSpeed = value
    }

    // Check if all expected sub-responses are in
    if (this._isOperationComplete(op)) {
      this._finishActive(true, op.result)
    }
  }

  /**
   * Flush all pending operations (reject them as cancelled).
   * Does NOT cancel the active operation.
   */
  flushPending () {
    const pending = this._queue.splice(0)
    for (const op of pending) {
      op.reject(new OperationCancelledError())
    }
  }

  /**
   * Cancel active operation and flush everything.
   */
  cancelAll () {
    this.flushPending()
    if (this._active) {
      this._finishActive(false, null, 'Cancelled')
    }
  }

  // --- Internal ---

  _processNext () {
    if (this._active || this._queue.length === 0) return

    const op = this._queue.shift()
    this._active = op

    // Preprocessing
    this._beginOperation(op)

    // Arm timeout
    this._timeoutHandle = setTimeout(() => {
      if (this._active === op) {
        this._finishActive(false, null, `Timeout after ${op.def.timeout}ms`)
      }
    }, op.def.timeout)
  }

  _beginOperation (op) {
    switch (op.type) {
      case 'status': {
        const { buildReadFrequency, buildReadMode } = require('./CIVProtocol')
        this._sendCIV(buildReadFrequency(), { expectsReply: true })
        this._sendCIV(buildReadMode(), { expectsReply: true })
        break
      }
      case 'cwSpeedWarmup': {
        const { buildReadFrequency, buildReadMode, buildReadCWSpeed } = require('./CIVProtocol')
        this._sendCIV(buildReadFrequency(), { expectsReply: true })
        this._sendCIV(buildReadMode(), { expectsReply: true })
        this._sendCIV(buildReadCWSpeed(), { expectsReply: true })
        break
      }
      case 'cwSpeed': {
        const { buildReadCWSpeed } = require('./CIVProtocol')
        this._sendCIV(buildReadCWSpeed(), { expectsReply: true })
        break
      }
      case 'sendCW': {
        // Flush pending polling, suspend background traffic, then send
        this._flush()
        this._suspendTraffic()
        const { buildSendCW } = require('./CIVProtocol')
        const text = op.payload?.text || op.payload || ''
        const wpm = op.payload?.wpm || 20
        this._sendCIV(buildSendCW(text), { expectsReply: false })
        // Calculate delay based on WPM (min 800ms for short transmissions)
        const durationMs = Math.max(estimateCWDuration(text, wpm) * 1000, 800)
        setTimeout(() => {
          if (this._active === op) {
            this._resumeTraffic()
            this._finishActive(true, true)
          }
        }, durationMs)
        break
      }
      case 'setCWSpeed': {
        const { buildSetCWSpeed } = require('./CIVProtocol')
        this._sendCIV(buildSetCWSpeed(op.payload), { expectsReply: true })
        break
      }
      case 'stopCW': {
        const { buildStopCW } = require('./CIVProtocol')
        this._sendCIV(buildStopCW(), { expectsReply: false })
        // Complete immediately after sending stop
        setTimeout(() => {
          if (this._active === op) {
            this._resumeTraffic()
            this._finishActive(true, true)
          }
        }, 100)
        break
      }
    }
  }

  _isOperationComplete (op) {
    const d = op.def
    if (d.expectsFreq && op.result.frequency === undefined) return false
    if (d.expectsMode && op.result.mode === undefined) return false
    if (d.expectsSpeed && op.result.cwSpeed === undefined) return false
    return true
  }

  _finishActive (success, result, reason) {
    const op = this._active
    if (!op) return

    if (this._timeoutHandle) {
      clearTimeout(this._timeoutHandle)
      this._timeoutHandle = null
    }
    this._active = null

    if (success) {
      op.resolve(result)
    } else {
      if (reason && reason.startsWith('Timeout')) {
        op.reject(new TimeoutError(op.type, op.def.timeout))
      } else {
        op.reject(new OperationCancelledError())
      }
    }

    this._processNext()
  }

  destroy () {
    // Silently discard all operations on destroy (no rejections)
    this._queue.splice(0)
    if (this._active) {
      if (this._timeoutHandle) {
        clearTimeout(this._timeoutHandle)
        this._timeoutHandle = null
      }
      this._active = null
    }
  }
}
