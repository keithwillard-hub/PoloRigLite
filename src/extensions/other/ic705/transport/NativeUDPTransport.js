/*
 * Native UDP transport — wraps the Swift UDPTransport native module via React Native bridge.
 * Sends/receives raw bytes as base64 strings across the bridge.
 */

import { NativeModules, NativeEventEmitter, Platform, TurboModuleRegistry, Alert } from 'react-native'
import { TransportInterface } from './TransportInterface'
import { toBase64, fromBase64 } from '../protocol/ByteUtils'

function resolveNativeUDP () {
  if (Platform.OS !== 'ios') return null

  const debugInfo = []

  // Try TurboModuleRegistry first (new architecture)
  try {
    const turbo = TurboModuleRegistry?.get?.('UDPTransport')
    debugInfo.push('TurboModuleRegistry.get: ' + (turbo ? 'FOUND' : 'null'))
    if (turbo) return turbo
  } catch (e) {
    debugInfo.push('TurboModuleRegistry error: ' + e.message)
  }

  // In bridgeless mode, modules are on global.nativeModuleProxy (not __turboModuleProxy)
  try {
    const nmp = global.nativeModuleProxy
    debugInfo.push('nativeModuleProxy exists: ' + !!nmp)
    if (nmp) {
      const mod = nmp.UDPTransport
      debugInfo.push('nativeModuleProxy.UDPTransport: ' + (mod ? 'FOUND' : 'null'))
      if (mod) return mod
    }
  } catch (e) {
    debugInfo.push('nativeModuleProxy error: ' + e.message)
  }

  // Fall back to NativeModules (old bridge)
  if (NativeModules.UDPTransport) {
    return NativeModules.UDPTransport
  }

  debugInfo.push('NativeModules.UDPTransport: null')
  setTimeout(() => {
    Alert.alert('UDPTransport Debug', debugInfo.join('\n'))
  }, 2000)
  return null
}

const NativeUDP = resolveNativeUDP()
const emitter = NativeUDP ? new NativeEventEmitter(NativeUDP) : null

export class NativeUDPTransport extends TransportInterface {
  constructor () {
    super()
    this._subscription = null
    this._dataCallbacks = []
  }

  async createSocket (id) {
    if (!NativeUDP) throw new Error('UDPTransport native module not available')
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
    if (!NativeUDP) throw new Error('UDPTransport native module not available')
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
