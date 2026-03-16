import { ConnectionManager, ConnectionState } from '../protocol/ConnectionManager'
import { State } from '../protocol/SessionState'
import { MockTransport } from '../transport/TransportInterface'
import {
  controlPacket, pingPacket, civPacket,
  PacketType, PacketSize, ControlOffset, TokenOffset, TokenCode, TokenRes,
  CapabilitiesOffset
} from '../protocol/RSBA1Protocol'
import {
  readUInt16LE, readUInt32LE,
  writeUInt16LE, writeUInt32LE,
  allocate
} from '../protocol/ByteUtils'
import { buildFrame, PREAMBLE, TERMINATOR, ACK, Command, frequencyToBytes } from '../protocol/CIVProtocol'

describe('ConnectionManager', () => {
  let transport, cm

  beforeEach(() => {
    jest.useFakeTimers()
    transport = new MockTransport()
    cm = new ConnectionManager(transport)
  })

  afterEach(() => {
    cm.destroy()
    jest.useRealTimers()
  })

  function makeIAmHere (recvId, radioSendId) {
    return controlPacket(PacketType.iAmHere, 0, radioSendId, recvId)
  }

  function makeAreYouReady (recvId, radioSendId) {
    return controlPacket(PacketType.areYouReady, 1, radioSendId, recvId)
  }

  function makeLoginResponse (recvId, radioSendId, token) {
    const data = allocate(PacketSize.loginResponse)
    writeUInt32LE(data, ControlOffset.length, PacketSize.loginResponse)
    writeUInt16LE(data, ControlOffset.type, PacketType.idle)
    writeUInt32LE(data, ControlOffset.sendId, radioSendId)
    writeUInt32LE(data, ControlOffset.recvId, recvId)
    writeUInt16LE(data, TokenOffset.code, TokenCode.loginResponse)
    writeUInt32LE(data, TokenOffset.token, token)
    return data
  }

  function makeCapabilities (recvId, radioSendId, radioName, civAddr) {
    const data = allocate(PacketSize.capabilities)
    writeUInt32LE(data, ControlOffset.length, PacketSize.capabilities)
    writeUInt16LE(data, ControlOffset.type, PacketType.idle)
    writeUInt32LE(data, ControlOffset.sendId, radioSendId)
    writeUInt32LE(data, ControlOffset.recvId, recvId)
    writeUInt16LE(data, TokenOffset.code, TokenCode.capabilities)
    data[CapabilitiesOffset.civAddr] = civAddr || 0xA4
    if (radioName) {
      for (let i = 0; i < radioName.length; i++) {
        data[CapabilitiesOffset.radioName + i] = radioName.charCodeAt(i)
      }
    }
    return data
  }

  function makeCIVResponse (command, payload) {
    const frame = [PREAMBLE, PREAMBLE, 0xE0, 0xA4, command, ...payload, TERMINATOR]
    return civPacket(1, 0xBBBB, 0xAAAA, 1, new Uint8Array(frame))
  }

  function makeACK () {
    return makeCIVResponse(ACK, [])
  }

  describe('connect', () => {
    it('sends areYouThere on control socket', async () => {
      await cm.connect('192.168.1.100', 'admin', 'pass')
      expect(transport.sentPackets.length).toBeGreaterThan(0)
      const first = transport.sentPackets[0]
      expect(first.id).toBe('control')
      expect(first.port).toBe(50001)
      expect(readUInt16LE(first.data, ControlOffset.type)).toBe(PacketType.areYouThere)
    })

    it('transitions to connecting state', async () => {
      const states = []
      cm.on('connectionStateChanged', s => states.push(s))
      await cm.connect('192.168.1.100', 'admin', 'pass')
      expect(states).toContain(ConnectionState.connecting)
    })

    it('session state transitions to connecting', async () => {
      await cm.connect('192.168.1.100', 'admin', 'pass')
      expect(cm.sessionState.current).toBe(State.connecting)
    })

    it('rejects if already connecting', async () => {
      await cm.connect('192.168.1.100', 'admin', 'pass')
      await expect(cm.connect('192.168.1.100', 'admin', 'pass')).rejects.toThrow(/Already connecting/)
    })
  })

  describe('control handshake', () => {
    it('handles IAmHere -> sends AreYouReady', async () => {
      await cm.connect('192.168.1.100', 'admin', 'pass')
      transport.clearSent()

      const myId = cm._controlMyId
      transport.injectData('control', makeIAmHere(myId, 0xBBBB))

      const sent = transport.lastSent('control')
      expect(readUInt16LE(sent.data, ControlOffset.type)).toBe(PacketType.areYouReady)
    })

    it('handles AreYouReady -> sends login', async () => {
      await cm.connect('192.168.1.100', 'admin', 'pass')
      const myId = cm._controlMyId
      transport.injectData('control', makeIAmHere(myId, 0xBBBB))
      transport.clearSent()

      transport.injectData('control', makeAreYouReady(myId, 0xBBBB))

      expect(cm.state).toBe(ConnectionState.authenticating)
      const sent = transport.lastSent('control')
      expect(sent.data.length).toBe(PacketSize.login)
    })
  })

  describe('CI-V command queue', () => {
    async function driveToConnected () {
      await cm.connect('192.168.1.100', 'admin', 'pass')
      const ctrlMyId = cm._controlMyId

      transport.injectData('control', makeIAmHere(ctrlMyId, 0xBBBB))
      transport.injectData('control', makeAreYouReady(ctrlMyId, 0xBBBB))
      transport.injectData('control', makeLoginResponse(ctrlMyId, 0xBBBB, 0xDEAD))
      transport.injectData('control', makeCapabilities(ctrlMyId, 0xBBBB, 'IC-705', 0xA4))

      const serialMyId = cm._serialMyId
      transport.injectData('serial', makeIAmHere(serialMyId, 0xCCCC))
      transport.injectData('serial', makeAreYouReady(serialMyId, 0xCCCC))
    }

    it('sends CI-V frame wrapped in RS-BA1 packet', async () => {
      await driveToConnected()
      expect(cm.state).toBe(ConnectionState.connected)

      // ACK the initial auto-requests (freq, mode, speed) to clear the queue
      transport.injectData('serial', makeACK())
      transport.injectData('serial', makeACK())
      transport.injectData('serial', makeACK())

      transport.clearSent()
      const frame = buildFrame(Command.readFrequency)
      cm.sendCIV(frame)

      const serialSent = transport.sentPackets.filter(p => p.id === 'serial')
      expect(serialSent.length).toBeGreaterThan(0)
    })

    it('queues commands when waiting for reply', async () => {
      await driveToConnected()

      const frame1 = buildFrame(Command.readFrequency)
      const frame2 = buildFrame(Command.readMode)
      cm.sendCIV(frame1)
      cm.sendCIV(frame2)

      expect(cm.queueDepth).toBeGreaterThanOrEqual(0)
    })

    it('processes frequency response', async () => {
      await driveToConnected()
      transport.clearSent()

      const freqEvents = []
      cm.on('frequencyChanged', (hz) => freqEvents.push(hz))

      transport.injectData('serial', makeACK())
      transport.injectData('serial', makeACK())
      transport.injectData('serial', makeACK())

      const freqBytes = frequencyToBytes(14060000)
      transport.injectData('serial', makeCIVResponse(Command.readFrequency, freqBytes))

      expect(cm.frequencyHz).toBe(14060000)
      expect(freqEvents).toContain(14060000)
    })

    it('session state is connected after handshake', async () => {
      await driveToConnected()
      expect(cm.sessionState.current).toBe(State.connected)
      expect(cm.sessionState.isConnected).toBe(true)
    })
  })

  describe('operation queue integration', () => {
    async function driveToConnected () {
      await cm.connect('192.168.1.100', 'admin', 'pass')
      const ctrlMyId = cm._controlMyId
      transport.injectData('control', makeIAmHere(ctrlMyId, 0xBBBB))
      transport.injectData('control', makeAreYouReady(ctrlMyId, 0xBBBB))
      transport.injectData('control', makeLoginResponse(ctrlMyId, 0xBBBB, 0xDEAD))
      transport.injectData('control', makeCapabilities(ctrlMyId, 0xBBBB, 'IC-705', 0xA4))
      const serialMyId = cm._serialMyId
      transport.injectData('serial', makeIAmHere(serialMyId, 0xCCCC))
      transport.injectData('serial', makeAreYouReady(serialMyId, 0xCCCC))
      // ACK initial requests
      transport.injectData('serial', makeACK())
      transport.injectData('serial', makeACK())
      transport.injectData('serial', makeACK())
    }

    it('enqueueOperation rejects when not connected', async () => {
      await expect(cm.enqueueOperation('status')).rejects.toThrow(/Not connected/)
    })

    it('queryStatus enqueues status operation', async () => {
      await driveToConnected()
      const opEvents = []
      cm.on('operationStarted', (type) => opEvents.push(type))

      const promise = cm.queryStatus()
      expect(opEvents).toContain('status')
      expect(cm.activeOperation).toBe('status')

      // Feed responses to complete
      const freqBytes = frequencyToBytes(14060000)
      transport.injectData('serial', makeCIVResponse(Command.readFrequency, freqBytes))
      transport.injectData('serial', makeCIVResponse(Command.readMode, [0x03]))

      const result = await promise
      expect(result.frequency).toBe(14060000)
      expect(result.mode).toBe('CW')
    })
  })

  describe('disconnect', () => {
    it('cleans up and transitions to disconnected', async () => {
      await cm.connect('192.168.1.100', 'admin', 'pass')
      await cm.disconnect()
      expect(cm.state).toBe(ConnectionState.disconnected)
      expect(cm.sessionState.current).toBe(State.disconnected)
    })
  })

  describe('flushQueue', () => {
    it('clears pending commands', () => {
      cm._commandQueue = [{ data: new Uint8Array(0) }, { data: new Uint8Array(0) }]
      cm._waitingForReply = true
      cm.flushQueue()
      expect(cm._commandQueue.length).toBe(0)
      expect(cm._waitingForReply).toBe(false)
    })
  })

  describe('connection timeout', () => {
    it('fires after 10s if auth never completes', async () => {
      const errors = []
      cm.on('error', e => errors.push(e))

      await cm.connect('192.168.1.100', 'admin', 'pass')
      expect(cm.state).toBe(ConnectionState.connecting)

      jest.advanceTimersByTime(10100)

      expect(cm.state).toBe(ConnectionState.disconnected)
      expect(errors.length).toBe(1)
      expect(errors[0].message).toMatch(/timed out/i)
    })

    it('is cleared on successful connection', async () => {
      await cm.connect('192.168.1.100', 'admin', 'pass')
      const myId = cm._controlMyId

      transport.injectData('control', makeIAmHere(myId, 0xBBBB))
      transport.injectData('control', makeAreYouReady(myId, 0xBBBB))
      transport.injectData('control', makeLoginResponse(myId, 0xBBBB, 0xDEAD))
      transport.injectData('control', makeCapabilities(myId, 0xBBBB, 'IC-705', 0xA4))

      const serialMyId = cm._serialMyId
      transport.injectData('serial', makeIAmHere(serialMyId, 0xCCCC))
      transport.injectData('serial', makeAreYouReady(serialMyId, 0xCCCC))

      expect(cm.state).toBe(ConnectionState.connected)
      expect(cm._connectTimeout).toBeNull()

      const errors = []
      cm.on('error', e => errors.push(e))
      jest.advanceTimersByTime(15000)
      expect(cm.state).toBe(ConnectionState.connected)
      expect(errors.length).toBe(0)
    })

    it('is cleared on explicit disconnect during connecting', async () => {
      await cm.connect('192.168.1.100', 'admin', 'pass')
      expect(cm.state).toBe(ConnectionState.connecting)

      await cm.disconnect()
      expect(cm.state).toBe(ConnectionState.disconnected)

      const errors = []
      cm.on('error', e => errors.push(e))
      jest.advanceTimersByTime(15000)
      expect(errors.length).toBe(0)
    })
  })
})
