/*
 * Minimal EventEmitter for protocol and keyer modules.
 * Avoids dependency on Node.js 'events' or React Native internals.
 */

export class EventEmitter {
  constructor () {
    this._listeners = {}
  }

  on (event, fn) {
    if (!this._listeners[event]) this._listeners[event] = []
    this._listeners[event].push(fn)
    return () => this.off(event, fn)
  }

  off (event, fn) {
    const list = this._listeners[event]
    if (!list) return
    this._listeners[event] = list.filter(f => f !== fn)
  }

  emit (event, ...args) {
    const list = this._listeners[event]
    if (!list) return
    for (const fn of list) fn(...args)
  }

  removeAllListeners (event) {
    if (event) {
      delete this._listeners[event]
    } else {
      this._listeners = {}
    }
  }
}
