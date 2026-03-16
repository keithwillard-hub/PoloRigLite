/*
 * IC-705 Rig Control Orchestrator (JS-based, replaces native module wrapper).
 *
 * Wires together ConnectionManager, CWKeyer, and CWSidetone.
 * Uses the Promise-based operation queue for all radio interactions.
 * Exposes the same public API as the old src/native/IC705RigControl.js.
 */

import { AppState } from 'react-native'
import { ConnectionManager, ConnectionState } from './protocol/ConnectionManager'
import { CWKeyer } from './keyer/CWKeyer'
import { interpolate, standardVariables } from './keyer/CWTemplateEngine'
import { getTransport } from './transport/transportConfig'
import {
  buildFrame, buildSendCW, buildStopCW, buildSetCWSpeed,
  Command, formatMHz, formatKHz
} from './protocol/CIVProtocol'
import { NotConnectedError, AlreadyConnectingError } from './protocol/RadioError'

let _instance = null

function getInstance (settings) {
  if (!_instance) {
    const transport = getTransport(settings)
    _instance = {
      cm: new ConnectionManager(transport),
      keyer: new CWKeyer(),
      transport,
      connected: false
    }
  }
  return _instance
}

function destroyInstance () {
  if (_instance) {
    _instance.cm.destroy()
    _instance.transport.destroy?.()
    _instance = null
  }
}

export const IC705 = {
  /**
   * Connect to IC-705 via WiFi.
   * @returns {Promise<{ radioName: string }>}
   */
  connect: (host, username, password, settings) => {
    return new Promise((resolve, reject) => {
      const inst = getInstance(settings)
      if (inst.connected) {
        reject(new AlreadyConnectingError())
        return
      }

      const { cm, keyer } = inst

      // Wire keyer -> connection manager (direct CI-V for chunk-level pacing)
      keyer.on('sendCW', (text, callback) => {
        cm.flushQueue()
        const frame = buildSendCW(text)
        cm.sendCIV(frame, { expectsReply: false, completion: (success) => callback(success) })
      })

      keyer.on('setSpeed', (wpm) => {
        const frame = buildSetCWSpeed(wpm)
        cm.sendCIV(frame)
      })

      // Listen for connected state
      const unsub = cm.on('connectionStateChanged', (state) => {
        if (state === ConnectionState.connected) {
          inst.connected = true
          unsub()
          resolve({ radioName: cm.radioName })
        }
      })

      // Auto-disconnect on app background/inactive
      inst.appStateSubscription = AppState.addEventListener('change', (nextState) => {
        if (nextState === 'background' || nextState === 'inactive') {
          IC705.disconnect(settings)
        }
      })

      cm.connect(host, username, password).catch(reject)
    })
  },

  /** Disconnect from IC-705 with graceful 1s teardown. */
  disconnect: async (settings) => {
    const inst = getInstance(settings)
    if (!inst.connected) return

    // Remove AppState listener
    if (inst.appStateSubscription) {
      inst.appStateSubscription.remove()
      inst.appStateSubscription = null
    }

    inst.keyer.cancelSend()
    await inst.cm.disconnect()

    // Graceful 1s delay matching Swift teardown
    await new Promise(resolve => setTimeout(resolve, 1000))

    inst.connected = false
    destroyInstance()
  },

  /**
   * Query current frequency + mode via operation queue.
   * @returns {Promise<{ frequency: number, mode: string }>}
   */
  queryStatus: async (settings) => {
    const inst = getInstance(settings)
    if (!inst.connected) throw new NotConnectedError()
    return inst.cm.queryStatus()
  },

  /** Send raw CW text via operation queue. */
  sendCW: async (text, settings) => {
    const inst = getInstance(settings)
    if (!inst.connected) throw new NotConnectedError()
    return inst.cm.enqueueSendCW(text)
  },

  /**
   * Send templated CW with $variable interpolation + {MACRO} expansion.
   */
  sendTemplatedCW: async (template, variables, settings) => {
    const inst = getInstance(settings)
    if (!inst.connected) throw new NotConnectedError()

    const context = {
      callsign: variables?.callsign || '',
      myCallsign: variables?.mycall || '',
      frequencyHz: inst.cm.frequencyHz,
      defaultRST: getDefaultRST(inst.cm.modeLabel),
      cwSpeed: inst.cm.cwSpeed
    }

    inst.keyer.sendInterpolatedTemplate(template, variables || {}, context)
  },

  /** Set CW keying speed in WPM (6-48) via operation queue. */
  setCWSpeed: async (wpm, settings) => {
    const inst = getInstance(settings)
    if (!inst.connected) throw new NotConnectedError()
    return inst.cm.enqueueSetCWSpeed(wpm)
  },

  /**
   * Query CW keying speed via operation queue.
   * @returns {Promise<{ cwSpeed: number }>}
   */
  queryCWSpeed: async (settings) => {
    const inst = getInstance(settings)
    if (!inst.connected) throw new NotConnectedError()
    return inst.cm.queryCWSpeed()
  },

  /** Cancel CW transmission in progress via operation queue. */
  cancelCW: (settings) => {
    const inst = getInstance(settings)
    inst.keyer.cancelSend()
    if (inst.connected) {
      inst.cm.enqueueStopCW().catch(() => {})
    }
  },

  /** Get current status. */
  getStatus: async (settings) => {
    const inst = _instance
    if (!inst) return { isConnected: false }
    return {
      isConnected: inst.connected,
      frequencyHz: inst.cm.frequencyHz,
      frequencyDisplay: formatMHz(inst.cm.frequencyHz),
      mode: inst.cm.modeLabel,
      cwSpeed: inst.cm.cwSpeed,
      isSending: inst.keyer.isSending,
      radioName: inst.cm.radioName,
      isBusy: inst.cm.isBusy,
      activeOperation: inst.cm.activeOperation
    }
  },

  // --- Event subscriptions ---

  onConnectionStateChanged: (cb, settings) => {
    const inst = getInstance(settings)
    return inst.cm.on('connectionStateChanged', cb)
  },

  onSessionStateChanged: (cb, settings) => {
    const inst = getInstance(settings)
    return inst.cm.on('sessionStateChanged', cb)
  },

  onFrequencyChanged: (cb, settings) => {
    const inst = getInstance(settings)
    return inst.cm.on('frequencyChanged', (hz) => {
      cb({ frequencyHz: hz, display: formatMHz(hz) })
    })
  },

  onModeChanged: (cb, settings) => {
    const inst = getInstance(settings)
    return inst.cm.on('modeChanged', (mode) => cb({ mode }))
  },

  onCWSpeedChanged: (cb, settings) => {
    const inst = getInstance(settings)
    return inst.cm.on('cwSpeedChanged', (wpm) => cb({ wpm }))
  },

  onSendingStateChanged: (cb, settings) => {
    const inst = getInstance(settings)
    const unsub1 = inst.keyer.on('sendingStarted', () => cb({ isSending: true }))
    const unsub2 = inst.keyer.on('sendingEnded', () => cb({ isSending: false }))
    return () => { unsub1(); unsub2() }
  },

  onRadioNameChanged: (cb, settings) => {
    const inst = getInstance(settings)
    return inst.cm.on('radioNameChanged', (name) => cb({ name }))
  },

  onOperationStarted: (cb, settings) => {
    const inst = getInstance(settings)
    return inst.cm.on('operationStarted', (type) => cb({ type }))
  },

  onOperationCompleted: (cb, settings) => {
    const inst = getInstance(settings)
    return inst.cm.on('operationCompleted', (type, success) => cb({ type, success }))
  },

  /** Whether the JS rig control module is available. */
  get isAvailable () {
    return true
  }
}

function getDefaultRST (modeLabel) {
  if (!modeLabel) return '599'
  switch (modeLabel) {
    case 'CW': case 'CW-R': return '599'
    case 'LSB': case 'USB': return '59'
    case 'AM': case 'FM': return '59'
    case 'RTTY': case 'RTTY-R': return '599'
    default: return '599'
  }
}
