/*
 * Transport selection via feature flag / settings.
 */

import { NativeUDPTransport } from './NativeUDPTransport'
import { WebSocketTransport } from './WebSocketTransport'

const DEFAULT_TRANSPORT = 'native'

/**
 * Get the appropriate transport based on settings.
 * @param {Object} settings - ic705 extension settings
 * @returns {TransportInterface}
 */
export function getTransport (settings) {
  const uiMode = settings?.ic705?.uiMode
  const transport = settings?.ic705?.transport || DEFAULT_TRANSPORT

  // uiMode takes precedence: 'swift' → native, 'websocket' → websocket
  const effectiveMode = uiMode === 'websocket' ? 'websocket'
    : uiMode === 'swift' ? 'native'
      : transport

  if (effectiveMode === 'websocket') {
    const proxyUrl = settings?.ic705?.proxyUrl || 'ws://localhost:8765'
    return new WebSocketTransport(proxyUrl)
  }

  return new NativeUDPTransport()
}
