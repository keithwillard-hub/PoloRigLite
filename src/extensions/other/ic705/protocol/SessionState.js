/*
 * Session state machine for IC-705 connection lifecycle.
 * Ported from SessionState.swift.
 *
 * States: disconnected, connecting, connected(radioName), queryingStatus,
 *         sendingCW, disconnecting
 */

import { EventEmitter } from './EventEmitter'

export const State = {
  disconnected: 'disconnected',
  connecting: 'connecting',
  connected: 'connected',
  queryingStatus: 'queryingStatus',
  sendingCW: 'sendingCW',
  disconnecting: 'disconnecting'
}

// Allowed transitions: { from: [to1, to2, ...] }
const TRANSITIONS = {
  [State.disconnected]: [State.connecting],
  [State.connecting]: [State.connected, State.disconnected],
  [State.connected]: [State.queryingStatus, State.sendingCW, State.disconnecting, State.disconnected],
  [State.queryingStatus]: [State.connected, State.sendingCW, State.disconnecting, State.disconnected],
  [State.sendingCW]: [State.connected, State.disconnecting, State.disconnected],
  [State.disconnecting]: [State.disconnected]
}

export class SessionState extends EventEmitter {
  constructor () {
    super()
    this._state = State.disconnected
    this._radioName = ''
  }

  get current () { return this._state }
  get radioName () { return this._radioName }

  get isConnected () {
    return this._state === State.connected ||
           this._state === State.queryingStatus ||
           this._state === State.sendingCW
  }

  get isBusy () {
    return this._state === State.connecting ||
           this._state === State.queryingStatus ||
           this._state === State.sendingCW ||
           this._state === State.disconnecting
  }

  canTransition (to) {
    const allowed = TRANSITIONS[this._state]
    return allowed ? allowed.includes(to) : false
  }

  transition (to, radioName) {
    if (!this.canTransition(to)) {
      return false
    }
    const from = this._state
    this._state = to
    if (radioName !== undefined) {
      this._radioName = radioName
    }
    if (to === State.disconnected) {
      this._radioName = ''
    }
    this.emit('stateChanged', { state: to, from, radioName: this._radioName })
    return true
  }

  reset () {
    this._state = State.disconnected
    this._radioName = ''
  }
}
