/*
 * Abstract transport contract for UDP communication.
 * NativeUDPTransport implements this interface.
 */

export class TransportInterface {
  /**
   * Create a named UDP socket.
   * @param {string} id - socket identifier (e.g., 'control', 'serial')
   */
  async createSocket (id) {
    throw new Error('TransportInterface.createSocket not implemented')
  }

  /**
   * Send data through a named socket.
   * @param {string} id - socket identifier
   * @param {string} host - destination host
   * @param {number} port - destination port
   * @param {Uint8Array} data - bytes to send
   */
  async send (id, host, port, data) {
    throw new Error('TransportInterface.send not implemented')
  }

  /**
   * Close a named socket.
   * @param {string} id - socket identifier
   */
  async close (id) {
    throw new Error('TransportInterface.close not implemented')
  }

  /**
   * Register a callback for incoming data.
   * @param {function(string, Uint8Array): void} callback - (socketId, data)
   * @returns {function} unsubscribe function
   */
  onData (callback) {
    throw new Error('TransportInterface.onData not implemented')
  }

  /**
   * Whether this transport is available for use.
   * @returns {boolean}
   */
  get isAvailable () {
    return false
  }
}

/**
 * Mock transport for testing — records sent packets and allows injecting received data.
 */
export class MockTransport extends TransportInterface {
  constructor () {
    super()
    this.sockets = new Set()
    this.sentPackets = []
    this._dataCallbacks = []
  }

  async createSocket (id) {
    this.sockets.add(id)
  }

  async send (id, host, port, data) {
    this.sentPackets.push({ id, host, port, data: new Uint8Array(data) })
  }

  async close (id) {
    this.sockets.delete(id)
  }

  onData (callback) {
    this._dataCallbacks.push(callback)
    return () => {
      this._dataCallbacks = this._dataCallbacks.filter(cb => cb !== callback)
    }
  }

  get isAvailable () {
    return true
  }

  /**
   * Inject data as if it came from the network.
   * @param {string} id - socket identifier
   * @param {Uint8Array} data - received bytes
   */
  injectData (id, data) {
    for (const cb of this._dataCallbacks) {
      cb(id, data)
    }
  }

  /** Get the last packet sent on a given socket. */
  lastSent (id) {
    const filtered = this.sentPackets.filter(p => p.id === id)
    return filtered.length > 0 ? filtered[filtered.length - 1] : null
  }

  /** Clear sent packet history. */
  clearSent () {
    this.sentPackets = []
  }
}
