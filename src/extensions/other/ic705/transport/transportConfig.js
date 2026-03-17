/*
 * Transport configuration — Native UDP only (WebSocket/proxy approach abandoned).
 */

import { NativeUDPTransport } from './NativeUDPTransport'

/**
 * Get the UDP transport for IC-705 communication.
 * @returns {NativeUDPTransport}
 */
export function getTransport () {
  return new NativeUDPTransport()
}
