/*
 * RS-BA1 connection manager: two UDP sockets (control:50001, serial:50002),
 * full auth state machine, CI-V command queue, keepalive timers.
 * Ported from UDPBase.swift, UDPControl.swift, UDPSerial.swift.
 *
 * Integrates SessionState (formal state machine), OperationQueue (serialized
 * operations with typed results), and RadioError (structured errors).
 */

import { EventEmitter } from './EventEmitter'
import { SessionState, State } from './SessionState'
import { OperationQueue } from './OperationQueue'
import {
  NotConnectedError, AlreadyConnectingError, TimeoutError,
  InvalidStateError, OperationCancelledError
} from './RadioError'
import {
  areYouThere, areYouReady, disconnectPacket, idle,
  pingPacket, pongReply,
  loginPacket, tokenAcknowledge, tokenRenew, tokenRemove,
  connInfoPacket, openClosePacket, civPacket,
  parsePacketType, parsePacketHeader, parseTokenFields,
  parseCapabilities, parseCIVFromSerial, parseRetransmitSeq, parsePing,
  PacketSize, PacketType, TokenCode, TokenRes, ControlOffset, Timing
} from './RSBA1Protocol'
import { readUInt16LE, readUInt32LE } from './ByteUtils'
import {
  parseCIVResponse,
  Command as CIVCommand,
  ACK, NAK,
  CONTROLLER_ADDRESS,
  Mode as CIVModeMap,
  parseFrequencyHz,
  CW_SPEED_MIN, CW_SPEED_MAX,
  formatKHz
} from './CIVProtocol'

const CONTROL_PORT = 50001
const SERIAL_PORT = 50002

// Re-export ConnectionState for backward compatibility
export const ConnectionState = {
  disconnected: 'disconnected',
  connecting: 'connecting',
  authenticating: 'authenticating',
  connected: 'connected'
}

/**
 * Manages RS-BA1 connection lifecycle, CI-V command queue, and operation queue.
 *
 * Events:
 *   connectionStateChanged(state)
 *   frequencyChanged(hz, display)
 *   modeChanged(modeLabel)
 *   cwSpeedChanged(wpm)
 *   radioNameChanged(name)
 *   civData(Uint8Array)
 *   sessionStateChanged({ state, from, radioName })
 *   operationStarted(type)
 *   operationCompleted(type, success)
 */
export class ConnectionManager extends EventEmitter {
  constructor (transport) {
    super()
    this._transport = transport

    // Session state machine
    this._session = new SessionState()
    this._session.on('stateChanged', (info) => {
      this.emit('sessionStateChanged', info)
      // Map session states to legacy ConnectionState events
      this._emitLegacyState(info.state)
    })

    // Legacy state (for backward compat)
    this._state = ConnectionState.disconnected

    // Connection params
    this._host = null
    this._userName = null
    this._password = null

    // Control port state
    this._controlMyId = (Math.random() * 0xFFFFFFFF) >>> 0
    this._controlRemoteId = 0
    this._controlSeq = 0
    this._innerSeq = 0
    this._tokReq = (Math.random() * 0xFFFF) >>> 0
    this._token = 0
    this._haveToken = false
    this._radioName = ''
    this._radioMACAddr = new Uint8Array(6)
    this._commCap = 0
    this._radioCIVAddr = 0xA4

    // Serial port state
    this._serialMyId = (Math.random() * 0xFFFFFFFF) >>> 0
    this._serialRemoteId = 0
    this._serialSeq = 0
    this._civSeq = 0
    this._isOpen = false
    this._closeAcknowledged = false

    // CI-V command queue
    this._commandQueue = []
    this._waitingForReply = false
    this._pendingCompletion = null
    this._pendingCivSeq = null
    this._civTimeout = null
    this._keepaliveSuspendedForCIV = false

    // Rig state
    this._frequencyHz = 0
    this._modeLabel = null
    this._cwSpeed = 20

    // Timers
    this._pingTimerCtrl = null
    this._pingTimerSerial = null
    this._idleTimerCtrl = null
    this._idleTimerSerial = null
    this._resendTimer = null
    this._tokenRenewTimer = null
    this._retryPacket = null
    this._retrySocketId = null

    // Ping
    this._pingSeqCtrl = 0
    this._pingSeqSerial = 0
    this._pingDataB = (Math.random() * 0xFFFF) >>> 0
    this._lastPingSent = null
    this.latencyMs = 0

    // Retransmit buffer
    this._sentPackets = { control: [], serial: [] }
    this._maxRetransmitBuffer = 20

    // Operation queue
    this._opQueue = new OperationQueue({
      onSendCIV: (frame, opts) => this.sendCIV(frame, opts),
      onFlush: () => this._flushCIVQueue(),
      onSuspendTraffic: () => this._forceSuspendSerialTraffic(),
      onResumeTraffic: () => this._forceResumeSerialTraffic()
    })

    // Listen for incoming data
    this._unsubscribe = transport.onData((id, data) => this._handleIncoming(id, data))
  }

  // --- Public Getters ---

  get state () { return this._state }
  get sessionState () { return this._session }
  get frequencyHz () { return this._frequencyHz }
  get modeLabel () { return this._modeLabel }
  get cwSpeed () { return this._cwSpeed }
  get radioName () { return this._radioName }
  get isConnected () { return this._session.isConnected }
  get isBusy () { return this._session.isBusy }
  get queueDepth () { return this._commandQueue.length }
  get activeOperation () { return this._opQueue.activeType }

  // --- Connect / Disconnect ---

  async connect (host, userName, password) {
    if (this._session.current !== State.disconnected) {
      throw new AlreadyConnectingError()
    }

    this._host = host
    this._userName = userName
    this._password = password

    this._session.transition(State.connecting)
    this._setState(ConnectionState.connecting)

    // Arm 10-second connection timeout
    this._connectTimeout = setTimeout(() => {
      if (!this._session.isConnected) {
        this.emit('error', new TimeoutError('connect', 10000))
        this.disconnect()
      }
    }, 10000)

    await this._transport.createSocket('control')
    await this._transport.createSocket('serial')

    // Start control handshake
    this._sendControl(areYouThere(this._controlMyId))
    this._retryPacket = areYouThere(this._controlMyId)
    this._retrySocketId = 'control'
    this._armResendTimer()
  }

  async disconnect () {
    if (this._session.current === State.disconnected) return

    this._session.transition(State.disconnecting)

    // Clear connection timeout
    if (this._connectTimeout) {
      clearTimeout(this._connectTimeout)
      this._connectTimeout = null
    }

    // Cancel all pending operations
    this._opQueue.cancelAll()

    // Token remove
    if (this._haveToken) {
      this._innerSeq = (this._innerSeq + 1) & 0xFF
      this._sendControlTracked(tokenRemove(
        this._innerSeq, this._controlMyId, this._controlRemoteId,
        this._nextControlSeq(), this._tokReq, this._token
      ))
    }

    // Close serial
    this._civSeq = (this._civSeq + 1) & 0xFFFF
    this._sendSerialTracked(openClosePacket(
      this._nextSerialSeq(), this._serialMyId, this._serialRemoteId, this._civSeq, false
    ))

    // Disconnect control
    const disc = disconnectPacket(0, this._controlMyId, this._controlRemoteId)
    this._sendControl(disc)
    this._sendControl(disc) // send twice for reliability

    this._cleanup()
  }

  // --- Operation Queue API (Promise-based) ---

  /**
   * Enqueue a typed operation. Returns a Promise with the typed result.
   * @param {string} type - 'status' | 'cwSpeedWarmup' | 'cwSpeed' | 'sendCW' | 'setCWSpeed' | 'stopCW'
   * @param {*} payload - operation-specific data
   * @returns {Promise<*>}
   */
  enqueueOperation (type, payload) {
    if (!this._session.isConnected) {
      return Promise.reject(new NotConnectedError())
    }

    // Transition session state for CW and status operations
    if (type === 'sendCW' || type === 'stopCW') {
      this._session.transition(State.sendingCW)
    } else if (type === 'status' || type === 'cwSpeedWarmup') {
      this._session.transition(State.queryingStatus)
    }

    this.emit('operationStarted', type)

    return this._opQueue.enqueue(type, payload).then(
      (result) => {
        this.emit('operationCompleted', type, true)
        // Return to connected state if we were in a transient state
        if (this._session.current === State.queryingStatus || this._session.current === State.sendingCW) {
          this._session.transition(State.connected)
        }
        return result
      },
      (err) => {
        this.emit('operationCompleted', type, false)
        if (this._session.current === State.queryingStatus || this._session.current === State.sendingCW) {
          this._session.transition(State.connected)
        }
        throw err
      }
    )
  }

  /**
   * Query current frequency + mode.
   * @returns {Promise<{ frequency: number, mode: string }>}
   */
  queryStatus () {
    return this.enqueueOperation('status')
  }

  /**
   * Query frequency + mode + CW speed (warmup before speed-sensitive operations).
   * @returns {Promise<{ frequency: number, mode: string, cwSpeed: number }>}
   */
  queryStatusWithSpeed () {
    return this.enqueueOperation('cwSpeedWarmup')
  }

  /**
   * Query CW keying speed.
   * @returns {Promise<{ cwSpeed: number }>}
   */
  queryCWSpeed () {
    return this.enqueueOperation('cwSpeed')
  }

  /**
   * Send CW text via operation queue (handles flush + suspend + resume).
   * @param {string} text
   * @returns {Promise<boolean>}
   */
  enqueueSendCW (text) {
    return this.enqueueOperation('sendCW', text)
  }

  /**
   * Set CW keying speed via operation queue.
   * @param {number} wpm
   * @returns {Promise<boolean>}
   */
  enqueueSetCWSpeed (wpm) {
    return this.enqueueOperation('setCWSpeed', wpm)
  }

  /**
   * Stop CW transmission via operation queue.
   * @returns {Promise<boolean>}
   */
  enqueueStopCW () {
    return this.enqueueOperation('stopCW')
  }

  // --- CI-V Command Queue (low-level, used by OperationQueue) ---

  sendCIV (civFrame, { expectsReply = true, completion } = {}) {
    this._commandQueue.push({ data: civFrame, expectsReply, completion })
    this._processQueue()
  }

  flushQueue () {
    this._flushCIVQueue()
  }

  resumeDeferredBackgroundTraffic () {
    this._forceResumeSerialTraffic()
  }

  // --- Frequency / Mode Requests (legacy, still used internally) ---

  requestFrequency () {
    const { buildFrame } = require('./CIVProtocol')
    this.sendCIV(buildFrame(CIVCommand.readFrequency))
  }

  requestMode () {
    const { buildFrame } = require('./CIVProtocol')
    this.sendCIV(buildFrame(CIVCommand.readMode))
  }

  requestCWSpeed () {
    const { buildFrame } = require('./CIVProtocol')
    this.sendCIV(buildFrame(CIVCommand.setLevel, CIVCommand.cwSpeedSub))
  }

  // --- Internal: State ---

  _setState (newState) {
    this._state = newState
    this.emit('connectionStateChanged', newState)
  }

  _emitLegacyState (sessionState) {
    switch (sessionState) {
      case State.disconnected:
        this._setState(ConnectionState.disconnected)
        break
      case State.connecting:
        this._setState(ConnectionState.connecting)
        break
      case State.connected:
      case State.queryingStatus:
      case State.sendingCW:
        if (this._state !== ConnectionState.connected) {
          this._setState(ConnectionState.connected)
        }
        break
      case State.disconnecting:
        // Keep current state during teardown
        break
    }
  }

  _nextControlSeq () {
    this._controlSeq = (this._controlSeq + 1) & 0xFFFF
    return this._controlSeq
  }

  _nextSerialSeq () {
    this._serialSeq = (this._serialSeq + 1) & 0xFFFF
    return this._serialSeq
  }

  // --- Internal: Send ---

  _sendControl (data) {
    this._transport.send('control', this._host, CONTROL_PORT, data)
  }

  _sendSerial (data) {
    this._transport.send('serial', this._host, SERIAL_PORT, data)
  }

  _sendControlTracked (data) {
    const seq = readUInt16LE(data, ControlOffset.sequence)
    this._sentPackets.control.push({ seq, data: new Uint8Array(data) })
    if (this._sentPackets.control.length > this._maxRetransmitBuffer) {
      this._sentPackets.control.shift()
    }
    this._sendControl(data)
  }

  _sendSerialTracked (data) {
    const seq = readUInt16LE(data, ControlOffset.sequence)
    this._sentPackets.serial.push({ seq, data: new Uint8Array(data) })
    if (this._sentPackets.serial.length > this._maxRetransmitBuffer) {
      this._sentPackets.serial.shift()
    }
    this._sendSerial(data)
  }

  // --- Internal: Incoming Data ---

  _handleIncoming (socketId, data) {
    if (!data || data.length < PacketSize.control) return
    const type = parsePacketType(data)

    if (socketId === 'control') {
      this._handleControlPacket(type, data)
    } else if (socketId === 'serial') {
      this._handleSerialPacket(type, data)
    }
  }

  // --- Control Port Handling ---

  _handleControlPacket (type, data) {
    switch (type) {
      case PacketType.iAmHere:
        this._handleControlIAmHere(data)
        break
      case PacketType.areYouReady:
        this._handleControlIAmReady(data)
        break
      case PacketType.ping:
        this._handlePing('control', data, this._controlMyId, this._controlRemoteId)
        break
      case PacketType.retransmit:
        this._handleRetransmit('control', data)
        break
      case PacketType.disconnect:
        this._cleanup()
        break
      case PacketType.idle:
        this._handleControlData(data)
        break
    }
  }

  _handleControlIAmHere (data) {
    this._controlRemoteId = readUInt32LE(data, ControlOffset.sendId)
    this._cancelResendTimer()
    const packet = areYouReady(1, this._controlMyId, this._controlRemoteId)
    this._sendControl(packet)
    this._retryPacket = packet
    this._retrySocketId = 'control'
    this._armResendTimer()
  }

  _handleControlIAmReady () {
    this._cancelResendTimer()
    this._setState(ConnectionState.authenticating)
    this._sendLogin()
  }

  _sendLogin () {
    this._innerSeq = (this._innerSeq + 1) & 0xFF
    const pkt = loginPacket(
      this._innerSeq, this._controlMyId, this._controlRemoteId,
      this._nextControlSeq(), this._tokReq,
      this._userName, this._password, 'iPhone'
    )
    this._sendControlTracked(pkt)
    this._retryPacket = pkt
    this._retrySocketId = 'control'
    this._armResendTimer()
  }

  _handleControlData (data) {
    if (data.length < PacketSize.token) {
      this._armIdleTimer('control')
      return
    }

    const fields = parseTokenFields(data)
    if (!fields) return

    switch (fields.code) {
      case TokenCode.loginResponse:
        this._handleLoginResponse(data, fields)
        break
      case TokenCode.capabilities:
        this._handleCapabilities(data)
        break
      case TokenCode.tokenAckResponse:
        break // renew/remove response — acknowledged
      case TokenCode.connInfoFromRadio:
        break // acknowledged
      case TokenCode.status:
        break // acknowledged
    }
  }

  _handleLoginResponse (data, fields) {
    this._cancelResendTimer()
    this._token = fields.token
    this._innerSeq = (this._innerSeq + 1) & 0xFF
    const pkt = tokenAcknowledge(
      this._innerSeq, this._controlMyId, this._controlRemoteId,
      this._nextControlSeq(), this._tokReq, this._token
    )
    this._sendControlTracked(pkt)
    this._retryPacket = pkt
    this._retrySocketId = 'control'
    this._armResendTimer()
  }

  _handleCapabilities (data) {
    this._cancelResendTimer()
    this._haveToken = true

    const caps = parseCapabilities(data)
    if (caps) {
      this._radioCIVAddr = caps.civAddr
      this._radioMACAddr = caps.macAddr
      this._commCap = caps.commCap
      this._radioName = caps.radioName
      this.emit('radioNameChanged', this._radioName)
    }

    // Send ConnInfo
    this._innerSeq = (this._innerSeq + 1) & 0xFF
    this._sendControlTracked(connInfoPacket(
      this._innerSeq, this._controlMyId, this._controlRemoteId,
      this._nextControlSeq(), this._tokReq, this._token,
      this._commCap, this._radioMACAddr, this._radioName,
      this._userName, SERIAL_PORT, SERIAL_PORT + 1
    ))

    // Start control keepalive
    this._startPingTimer('control')
    this._startTokenRenewTimer()

    // Begin serial handshake
    this._sendSerial(areYouThere(this._serialMyId))
    this._retryPacket = areYouThere(this._serialMyId)
    this._retrySocketId = 'serial'
    this._armResendTimer()
  }

  // --- Serial Port Handling ---

  _handleSerialPacket (type, data) {
    switch (type) {
      case PacketType.iAmHere:
        this._handleSerialIAmHere(data)
        break
      case PacketType.areYouReady:
        this._handleSerialIAmReady()
        break
      case PacketType.ping:
        this._handleSerialPing(data)
        break
      case PacketType.disconnect:
        this._cleanup()
        break
      case PacketType.idle:
        this._handleSerialIdle(data)
        break
    }
  }

  _handleSerialIAmHere (data) {
    this._serialRemoteId = readUInt32LE(data, ControlOffset.sendId)
    this._cancelResendTimer()
    const pkt = areYouReady(1, this._serialMyId, this._serialRemoteId)
    this._sendSerial(pkt)
    this._retryPacket = pkt
    this._retrySocketId = 'serial'
    this._armResendTimer()
  }

  _handleSerialIAmReady () {
    this._cancelResendTimer()

    // Open serial port
    this._civSeq = (this._civSeq + 1) & 0xFFFF
    this._sendSerialTracked(openClosePacket(
      this._nextSerialSeq(), this._serialMyId, this._serialRemoteId, this._civSeq, true
    ))
    this._isOpen = true

    // Clear connection timeout on successful connect
    if (this._connectTimeout) {
      clearTimeout(this._connectTimeout)
      this._connectTimeout = null
    }

    // Transition session state to connected
    this._session.transition(State.connected, this._radioName)
    this._setState(ConnectionState.connected)

    // Initial rig state requests
    console.log('[CM] Serial ready - requesting initial rig state')
    this.requestFrequency()
    this.requestMode()
    this.requestCWSpeed()

    // Start periodic frequency polling (1s interval, matching Swift CIVController)
    this._startPolling()
  }

  _startPolling () {
    this._stopPolling()
    console.log('[CM] Starting polling timer')
    this._pollingTimer = setInterval(() => {
      if (this._session.isConnected && !this._keepaliveSuspendedForCIV && !this._waitingForReply && this._commandQueue.length === 0) {
        console.log('[CM] Polling: requesting frequency, current freq:', this._frequencyHz)
        this.requestFrequency()
      }
    }, 1000)
  }

  _stopPolling () {
    if (this._pollingTimer) {
      clearInterval(this._pollingTimer)
      this._pollingTimer = null
    }
  }

  _handleSerialPing (data) {
    const parsed = parsePing(data)
    if (!parsed || !parsed.isRequest) return
    this._sendSerial(pongReply(data, this._serialMyId, this._serialRemoteId))
  }

  _handleSerialIdle (data) {
    if (data.length <= 0x10) return
    const marker = data[0x10]
    if (marker === 0xC1) {
      this._handleSerialData(data)
    }
    if (marker === 0xC0) {
      this._closeAcknowledged = true
    }
  }

  _handleSerialData (data) {
    const civData = parseCIVFromSerial(data)
    if (!civData) return

    this._handleCIVResponse(civData)
  }

  // --- CI-V Response Processing ---

  _handleCIVResponse (civData) {
    const parsed = parseCIVResponse(civData)
    if (!parsed) { console.log('[CM] CIV response: unparseable'); return }

    console.log('[CM] CIV response:', parsed.command, 'payload:', parsed.payload?.length, 'bytes')

    const isForUs = parsed.destination === CONTROLLER_ADDRESS || parsed.destination === 0x00

    if (isForUs) {
      if (parsed.isAck) {
        this._completePending(true)
        this._opQueue.handleResponse('ack', null)
        return
      }
      if (parsed.isNak) {
        this._completePending(false)
        this._opQueue.handleResponse('nak', null)
        return
      }
    }

    // Process data response (updates internal rig state + feeds operation queue)
    this._processCIVData(parsed)
    this.emit('civData', civData)

    if (isForUs && this._waitingForReply) {
      this._completePending(true)
    }
  }

  _processCIVData (parsed) {
    const { command, payload } = parsed

    switch (command) {
      case CIVCommand.readFrequency:
      case CIVCommand.setFrequency: {
        if (payload.length >= 5) {
          const hz = parseFrequencyHz(payload)
          console.log(`[CM] freq response: parsed=${hz}Hz current=${this._frequencyHz}Hz`)
          if (hz !== null) {
            // Feed operation queue
            this._opQueue.handleResponse('frequency', hz)
            if (hz !== this._frequencyHz) {
              console.log(`[CM] frequency changed: ${this._frequencyHz} -> ${hz}`)
              this._frequencyHz = hz
              this.emit('frequencyChanged', hz, formatKHz(hz))
            }
          }
        } else {
          console.log(`[CM] freq response: payload too short (${payload.length})`)
        }
        break
      }

      case CIVCommand.readMode: {
        if (payload.length >= 1) {
          const label = CIVModeMap[payload[0]] || null
          // Feed operation queue
          this._opQueue.handleResponse('mode', label)
          if (label !== this._modeLabel) {
            this._modeLabel = label
            this.emit('modeChanged', label)
          }
        }
        break
      }

      case CIVCommand.setLevel: {
        if (payload.length >= 3 && payload[0] === CIVCommand.cwSpeedSub) {
          const high = payload[1]
          const low = payload[2]
          const bcdValue = high * 100 + ((low >> 4) & 0x0F) * 10 + (low & 0x0F)
          const wpm = Math.round(bcdValue / 255 * (CW_SPEED_MAX - CW_SPEED_MIN)) + CW_SPEED_MIN
          // Feed operation queue
          this._opQueue.handleResponse('cwSpeed', wpm)
          if (wpm !== this._cwSpeed) {
            this._cwSpeed = wpm
            this.emit('cwSpeedChanged', wpm)
          }
        }
        break
      }
    }
  }

  // --- CI-V Queue ---

  _processQueue () {
    if (this._waitingForReply || this._commandQueue.length === 0) return

    const entry = this._commandQueue.shift()
    this._civSeq = (this._civSeq + 1) & 0xFFFF
    this._suspendSerialBackgroundTrafficIfCW(entry.data)

    const pkt = civPacket(
      this._nextSerialSeq(), this._serialMyId, this._serialRemoteId,
      this._civSeq, entry.data
    )
    this._sendSerialTracked(pkt)

    // Fire-and-forget: don't wait for reply
    if (!entry.expectsReply) {
      if (entry.completion) entry.completion(true)
      if (this._commandQueue.length === 0) {
        this._resumeSerialBackgroundTraffic()
      }
      this._processQueue()
      return
    }

    this._waitingForReply = true
    this._pendingCompletion = entry.completion
    this._pendingCivSeq = this._civSeq
    this._civTimeout = setTimeout(() => {
      if (this._waitingForReply && this._civSeq === this._pendingCivSeq) {
        this._completePending(false)
      }
    }, 3000)
  }

  _completePending (success) {
    console.log(`[CM] _completePending: success=${success} qLen=${this._commandQueue.length}`)
    if (this._civTimeout) {
      clearTimeout(this._civTimeout)
      this._civTimeout = null
    }
    const completion = this._pendingCompletion
    this._pendingCompletion = null
    this._pendingCivSeq = null
    this._waitingForReply = false
    this._resumeSerialBackgroundTraffic()
    if (completion) completion(success)
    this._processQueue()
  }

  _flushCIVQueue () {
    // Complete pending commands with failure before clearing
    const pendingCompletion = this._pendingCompletion
    this._commandQueue = []
    this._waitingForReply = false
    this._pendingCompletion = null
    this._pendingCivSeq = null
    if (this._civTimeout) {
      clearTimeout(this._civTimeout)
      this._civTimeout = null
    }
    if (pendingCompletion) pendingCompletion(false)
    this._forceResumeSerialTraffic()
  }

  // --- Ping/Pong ---

  _handlePing (socketId, data, myId, remoteId) {
    const parsed = parsePing(data)
    if (!parsed) return

    if (parsed.isRequest) {
      const sendFn = socketId === 'control' ? d => this._sendControl(d) : d => this._sendSerial(d)
      sendFn(pongReply(data, myId, remoteId))
    } else {
      if (this._lastPingSent) {
        this.latencyMs = (Date.now() - this._lastPingSent) / 2
      }
    }
  }

  _startPingTimer (socketId) {
    const timerKey = socketId === 'control' ? '_pingTimerCtrl' : '_pingTimerSerial'
    if (this[timerKey]) clearInterval(this[timerKey])
    this[timerKey] = setInterval(() => {
      const myId = socketId === 'control' ? this._controlMyId : this._serialMyId
      const remoteId = socketId === 'control' ? this._controlRemoteId : this._serialRemoteId
      const seqKey = socketId === 'control' ? '_pingSeqCtrl' : '_pingSeqSerial'
      this[seqKey] = (this[seqKey] + 1) & 0xFFFF
      const dataA = (Math.random() * 0xFFFF) >>> 0
      const pkt = pingPacket(this[seqKey], myId, remoteId, false, dataA, this._pingDataB)
      this._lastPingSent = Date.now()
      const sendFn = socketId === 'control' ? d => this._sendControl(d) : d => this._sendSerial(d)
      sendFn(pkt)
    }, Timing.pingInterval * 1000)
  }

  // --- Idle ---

  _armIdleTimer (socketId) {
    const timerKey = socketId === 'control' ? '_idleTimerCtrl' : '_idleTimerSerial'
    if (this[timerKey]) clearTimeout(this[timerKey])
    this[timerKey] = setTimeout(() => {
      const myId = socketId === 'control' ? this._controlMyId : this._serialMyId
      const remoteId = socketId === 'control' ? this._controlRemoteId : this._serialRemoteId
      const seq = socketId === 'control' ? this._nextControlSeq() : this._nextSerialSeq()
      const pkt = idle(seq, myId, remoteId)
      const sendFn = socketId === 'control' ? d => this._sendControl(d) : d => this._sendSerial(d)
      sendFn(pkt)
    }, Timing.idleInterval * 1000)
  }

  // --- Resend ---

  _armResendTimer () {
    this._cancelResendTimer()
    this._resendTimer = setTimeout(() => {
      if (this._retryPacket) {
        const sendFn = this._retrySocketId === 'control' ? d => this._sendControl(d) : d => this._sendSerial(d)
        sendFn(this._retryPacket)
        this._armResendTimer()
      }
    }, Timing.resendInterval * 1000)
  }

  _cancelResendTimer () {
    if (this._resendTimer) {
      clearTimeout(this._resendTimer)
      this._resendTimer = null
    }
    this._retryPacket = null
    this._retrySocketId = null
  }

  // --- Retransmit ---

  _handleRetransmit (socketId, data) {
    const requestedSeq = parseRetransmitSeq(data)
    if (requestedSeq === null) return

    const buffer = this._sentPackets[socketId]
    const found = buffer.find(p => p.seq === requestedSeq)
    const sendFn = socketId === 'control' ? d => this._sendControl(d) : d => this._sendSerial(d)

    if (found) {
      sendFn(found.data)
    } else {
      const myId = socketId === 'control' ? this._controlMyId : this._serialMyId
      const remoteId = socketId === 'control' ? this._controlRemoteId : this._serialRemoteId
      sendFn(idle(requestedSeq, myId, remoteId))
    }
  }

  // --- Token Renewal ---

  _startTokenRenewTimer () {
    if (this._tokenRenewTimer) clearInterval(this._tokenRenewTimer)
    this._tokenRenewTimer = setInterval(() => {
      if (!this._haveToken) return
      this._innerSeq = (this._innerSeq + 1) & 0xFF
      this._sendControlTracked(tokenRenew(
        this._innerSeq, this._controlMyId, this._controlRemoteId,
        this._nextControlSeq(), this._tokReq, this._token
      ))
    }, Timing.tokenRenewInterval * 1000)
  }

  // --- CW Background Traffic Suspension ---

  _isCWCommand (civFrame) {
    return civFrame && civFrame.length >= 6 && civFrame[4] === CIVCommand.sendCW
  }

  _suspendSerialBackgroundTrafficIfCW (civFrame) {
    if (!this._isCWCommand(civFrame) || this._keepaliveSuspendedForCIV) return
    this._forceSuspendSerialTraffic()
  }

  _forceSuspendSerialTraffic () {
    if (this._keepaliveSuspendedForCIV) return
    this._keepaliveSuspendedForCIV = true
    if (this._pingTimerSerial) { clearInterval(this._pingTimerSerial); this._pingTimerSerial = null }
    if (this._idleTimerSerial) { clearTimeout(this._idleTimerSerial); this._idleTimerSerial = null }
  }

  _resumeSerialBackgroundTraffic () {
    if (!this._keepaliveSuspendedForCIV) return
    this._forceResumeSerialTraffic()
  }

  _forceResumeSerialTraffic () {
    if (!this._keepaliveSuspendedForCIV) return
    this._keepaliveSuspendedForCIV = false
    this._armIdleTimer('serial')
    this._startPolling()
  }

  // --- Cleanup ---

  _cleanup () {
    this._stopPolling()
    if (this._connectTimeout) { clearTimeout(this._connectTimeout); this._connectTimeout = null }
    this._cancelResendTimer()
    if (this._pingTimerCtrl) { clearInterval(this._pingTimerCtrl); this._pingTimerCtrl = null }
    if (this._pingTimerSerial) { clearInterval(this._pingTimerSerial); this._pingTimerSerial = null }
    if (this._idleTimerCtrl) { clearTimeout(this._idleTimerCtrl); this._idleTimerCtrl = null }
    if (this._idleTimerSerial) { clearTimeout(this._idleTimerSerial); this._idleTimerSerial = null }
    if (this._tokenRenewTimer) { clearInterval(this._tokenRenewTimer); this._tokenRenewTimer = null }
    if (this._civTimeout) { clearTimeout(this._civTimeout); this._civTimeout = null }

    this._haveToken = false
    this._token = 0
    this._commandQueue = []
    this._waitingForReply = false
    this._pendingCompletion = null
    this._pendingCivSeq = null
    this._keepaliveSuspendedForCIV = false
    this._frequencyHz = 0
    this._modeLabel = null
    this._isOpen = false
    this._closeAcknowledged = false
    this._sentPackets = { control: [], serial: [] }

    // Silently discard pending operations on cleanup (no rejections)
    this._opQueue.destroy()

    this._transport.close('control')
    this._transport.close('serial')

    this._session.transition(State.disconnected)
    this._setState(ConnectionState.disconnected)
  }

  destroy () {
    this._cleanup()
    this._opQueue.destroy()
    if (this._unsubscribe) {
      this._unsubscribe()
      this._unsubscribe = null
    }
  }
}
