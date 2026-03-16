/*
 * WebSocket-to-UDP proxy transport.
 * Connects to a Node.js proxy server that relays UDP packets.
 */

import { TransportInterface } from './TransportInterface'
import { toBase64, fromBase64 } from '../protocol/ByteUtils'

export class WebSocketTransport extends TransportInterface {
  constructor (proxyUrl) {
    super()
    this._proxyUrl = proxyUrl || 'ws://localhost:8765'
    this._ws = null
    this._dataCallbacks = []
    this._connected = false
  }

  async createSocket (id) {
    if (this._ws) return // already connected

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this._proxyUrl)

      ws.onopen = () => {
        this._connected = true
        ws.send(JSON.stringify({ action: 'create', id }))
        resolve()
      }

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.id && msg.data) {
            const data = fromBase64(msg.data)
            for (const cb of this._dataCallbacks) {
              cb(msg.id, data)
            }
          }
        } catch (e) {
          // ignore malformed messages
        }
      }

      ws.onerror = (err) => {
        if (!this._connected) reject(new Error('WebSocket connection failed'))
      }

      ws.onclose = () => {
        this._connected = false
        this._ws = null
      }

      this._ws = ws
    })
  }

  async send (id, host, port, data) {
    if (!this._ws || !this._connected) return
    this._ws.send(JSON.stringify({
      action: 'send',
      id,
      host,
      port,
      data: toBase64(data)
    }))
  }

  async close (id) {
    if (!this._ws) return
    this._ws.send(JSON.stringify({ action: 'close', id }))
  }

  onData (callback) {
    this._dataCallbacks.push(callback)
    return () => {
      this._dataCallbacks = this._dataCallbacks.filter(cb => cb !== callback)
    }
  }

  get isAvailable () {
    return typeof WebSocket !== 'undefined'
  }

  destroy () {
    if (this._ws) {
      this._ws.close()
      this._ws = null
    }
    this._dataCallbacks = []
    this._connected = false
  }
}
