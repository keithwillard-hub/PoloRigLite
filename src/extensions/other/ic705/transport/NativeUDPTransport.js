/*
 * Native UDP transport — wraps the Swift UDPTransport native module via React Native bridge.
 * Sends/receives raw bytes as base64 strings across the bridge.
 */

import { NativeModules, NativeEventEmitter, Platform, TurboModuleRegistry } from 'react-native'
import { TransportInterface } from './TransportInterface'
import { toBase64, fromBase64 } from '../protocol/ByteUtils'

/**
 * Resolve the native UDP transport module.
 * Tries multiple resolution paths for compatibility with different RN architectures.
 * @returns {object|null} The native module or null if unavailable
 */
function resolveNativeUDP () {
  if (Platform.OS !== 'ios') return null

  // Try TurboModuleRegistry first (new architecture)
  try {
    const turbo = TurboModuleRegistry?.get?.('UDPTransport')
    if (turbo) return turbo
  } catch (e) {
    // Continue to next fallback
  }

  // In bridgeless mode, modules are on global.nativeModuleProxy
  try {
    const nmp = global.nativeModuleProxy
    if (nmp?.UDPTransport) return nmp.UDPTransport
  } catch (e) {
    // Continue to next fallback
  }

  // Fall back to NativeModules (old bridge)
  if (NativeModules.UDPTransport) {
    return NativeModules.UDPTransport
  }

  return null
}

const NativeUDP = resolveNativeUDP()
const emitter = NativeUDP ? new NativeEventEmitter(NativeUDP) : null

/**
 * Error thrown when the native UDP module is not available.
 */
export class NativeModuleError extends Error {
  constructor () {
    super('UDPTransport native module not available. Ensure the iOS native module is properly linked.')
    this.name = 'NativeModuleError'
  }
}

export class NativeUDPTransport extends TransportInterface {
  constructor () {
    super()
    this._subscription = null
    this._dataCallbacks = []
  }

  async createSocket (id) {
    if (!NativeUDP) throw new NativeModuleError()
    await NativeUDP.createSocket(id)

    // Start listening for data if not already
    if (!this._subscription && emitter) {
      this._subscription = emitter.addListener('onUDPData', (event) => {
        const data = fromBase64(event.data)
        for (const cb of this._dataCallbacks) {
          cb(event.id, data)
        }
      })
    }
  }

  async send (id, host, port, data) {
    if (!NativeUDP) throw new NativeModuleError()
    const b64 = toBase64(data)
    await NativeUDP.send(id, host, port, b64)
  }

  async close (id) {
    if (!NativeUDP) return
    await NativeUDP.close(id)
  }

  onData (callback) {
    this._dataCallbacks.push(callback)
    return () => {
      this._dataCallbacks = this._dataCallbacks.filter(cb => cb !== callback)
    }
  }

  get isAvailable () {
    return !!NativeUDP
  }

  destroy () {
    if (this._subscription) {
      this._subscription.remove()
      this._subscription = null
    }
    this._dataCallbacks = []
  }
}
