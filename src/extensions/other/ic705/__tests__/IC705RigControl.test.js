/*
 * Tests for the IC705RigControl orchestrator.
 *
 * Uses MockTransport to simulate the radio side, driving through the full
 * connect -> authenticate -> send CW -> disconnect lifecycle without
 * any native module or real UDP.
 */

import { MockTransport } from '../transport/TransportInterface'
import { ConnectionManager, ConnectionState } from '../protocol/ConnectionManager'
import { State } from '../protocol/SessionState'
import { CWKeyer } from '../keyer/CWKeyer'
import {
  controlPacket, civPacket,
  PacketType, PacketSize, ControlOffset, TokenOffset, TokenCode,
  CapabilitiesOffset
} from '../protocol/RSBA1Protocol'
import {
  readUInt16LE, readUInt32LE,
  writeUInt16LE, writeUInt32LE,
  allocate
} from '../protocol/ByteUtils'
import {
  PREAMBLE, TERMINATOR, ACK, NAK, Command,
  frequencyToBytes, parseCIVResponse
} from '../protocol/CIVProtocol'

// --- Helpers to simulate radio responses ---

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

function makeCapabilities (recvId, radioSendId, radioName) {
  const data = allocate(PacketSize.capabilities)
  writeUInt32LE(data, ControlOffset.length, PacketSize.capabilities)
  writeUInt16LE(data, ControlOffset.type, PacketType.idle)
  writeUInt32LE(data, ControlOffset.sendId, radioSendId)
  writeUInt32LE(data, ControlOffset.recvId, recvId)
  writeUInt16LE(data, TokenOffset.code, TokenCode.capabilities)
  data[CapabilitiesOffset.civAddr] = 0xA4
  if (radioName) {
    for (let i = 0; i < radioName.length; i++) {
      data[CapabilitiesOffset.radioName + i] = radioName.charCodeAt(i)
    }
  }
  return data
}

function makeCIVResponse (command, payload) {
  const frame = new Uint8Array([PREAMBLE, PREAMBLE, 0xE0, 0xA4, command, ...payload, TERMINATOR])
  return civPacket(1, 0xBBBB, 0xAAAA, 1, frame)
}

function makeACK () {
  return makeCIVResponse(ACK, [])
}

function makeNAK () {
  return makeCIVResponse(NAK, [])
}

function makeFrequencyResponse (hz) {
  return makeCIVResponse(Command.readFrequency, frequencyToBytes(hz))
}

function makeModeResponse (modeValue) {
  return makeCIVResponse(Command.readMode, [modeValue])
}

function makeCWSpeedResponse (high, low) {
  return makeCIVResponse(Command.setLevel, [Command.cwSpeedSub, high, low])
}

const RADIO_ID = 0xBBBBBBBB
const RADIO_SERIAL_ID = 0xCCCCCCCC

function driveToConnected (transport, cm) {
  const ctrlMyId = cm._controlMyId
  transport.injectData('control', makeIAmHere(ctrlMyId, RADIO_ID))
  transport.injectData('control', makeAreYouReady(ctrlMyId, RADIO_ID))
  transport.injectData('control', makeLoginResponse(ctrlMyId, RADIO_ID, 0xDEADBEEF))
  transport.injectData('control', makeCapabilities(ctrlMyId, RADIO_ID, 'IC-705'))
  const serialMyId = cm._serialMyId
  transport.injectData('serial', makeIAmHere(serialMyId, RADIO_SERIAL_ID))
  transport.injectData('serial', makeAreYouReady(serialMyId, RADIO_SERIAL_ID))
}

function ackInitialRequests (transport) {
  transport.injectData('serial', makeACK())
  transport.injectData('serial', makeACK())
  transport.injectData('serial', makeACK())
}

describe('IC705RigControl integration', () => {
  let transport, cm, keyer

  beforeEach(() => {
    jest.useFakeTimers()
    transport = new MockTransport()
    cm = new ConnectionManager(transport)
    keyer = new CWKeyer()

    // Wire keyer -> connection manager (direct CI-V for chunk-level pacing, same as IC705RigControl.js)
    keyer.on('sendCW', (text, callback) => {
      cm.flushQueue()
      const { buildSendCW } = require('../protocol/CIVProtocol')
      cm.sendCIV(buildSendCW(text), { expectsReply: false, completion: (success) => callback(success) })
    })

    keyer.on('setSpeed', (wpm) => {
      const { buildSetCWSpeed } = require('../protocol/CIVProtocol')
      cm.sendCIV(buildSetCWSpeed(wpm))
    })
  })

  afterEach(() => {
    cm.destroy()
    keyer.cancelSend()
    jest.useRealTimers()
  })

  describe('full connect lifecycle', () => {
    it('transitions through connecting -> authenticating -> connected', async () => {
      const states = []
      cm.on('connectionStateChanged', s => states.push(s))

      await cm.connect('192.168.1.100', 'admin', 'pass')
      expect(states).toContain(ConnectionState.connecting)

      driveToConnected(transport, cm)
      expect(states).toContain(ConnectionState.authenticating)
      expect(states).toContain(ConnectionState.connected)
      expect(cm.isConnected).toBe(true)
    })

    it('session state machine tracks connection', async () => {
      const sessionEvents = []
      cm.on('sessionStateChanged', info => sessionEvents.push(info))

      await cm.connect('192.168.1.100', 'admin', 'pass')
      driveToConnected(transport, cm)

      expect(cm.sessionState.current).toBe(State.connected)
      expect(cm.sessionState.radioName).toBe('IC-705')
      expect(sessionEvents.some(e => e.state === State.connecting)).toBe(true)
      expect(sessionEvents.some(e => e.state === State.connected)).toBe(true)
    })

    it('reports radio name after capabilities', async () => {
      const names = []
      cm.on('radioNameChanged', n => names.push(n))

      await cm.connect('192.168.1.100', 'admin', 'pass')
      driveToConnected(transport, cm)

      expect(names).toContain('IC-705')
      expect(cm.radioName).toBe('IC-705')
    })

    it('disconnects cleanly', async () => {
      await cm.connect('192.168.1.100', 'admin', 'pass')
      driveToConnected(transport, cm)
      expect(cm.isConnected).toBe(true)

      await cm.disconnect()
      expect(cm.state).toBe(ConnectionState.disconnected)
      expect(cm.isConnected).toBe(false)
      expect(cm.sessionState.current).toBe(State.disconnected)
    })
  })

  describe('rig state from CI-V responses', () => {
    beforeEach(async () => {
      await cm.connect('192.168.1.100', 'admin', 'pass')
      driveToConnected(transport, cm)
      ackInitialRequests(transport)
    })

    it('tracks frequency changes', () => {
      const freqs = []
      cm.on('frequencyChanged', hz => freqs.push(hz))

      transport.injectData('serial', makeFrequencyResponse(14060000))
      expect(cm.frequencyHz).toBe(14060000)
      expect(freqs).toContain(14060000)

      transport.injectData('serial', makeFrequencyResponse(7074000))
      expect(cm.frequencyHz).toBe(7074000)
    })

    it('tracks mode changes', () => {
      const modes = []
      cm.on('modeChanged', m => modes.push(m))

      transport.injectData('serial', makeModeResponse(0x03)) // CW
      expect(cm.modeLabel).toBe('CW')
      expect(modes).toContain('CW')

      transport.injectData('serial', makeModeResponse(0x01)) // USB
      expect(cm.modeLabel).toBe('USB')
    })

    it('tracks CW speed changes', () => {
      const speeds = []
      cm.on('cwSpeedChanged', w => speeds.push(w))

      transport.injectData('serial', makeCWSpeedResponse(0x00, 0x85))
      expect(cm.cwSpeed).toBeGreaterThan(15)
      expect(cm.cwSpeed).toBeLessThan(25)
    })

    it('does not emit for duplicate frequency', () => {
      const freqs = []
      cm.on('frequencyChanged', hz => freqs.push(hz))

      transport.injectData('serial', makeFrequencyResponse(14060000))
      transport.injectData('serial', makeFrequencyResponse(14060000))
      expect(freqs.length).toBe(1)
    })
  })

  describe('CW sending through keyer -> connection manager', () => {
    beforeEach(async () => {
      await cm.connect('192.168.1.100', 'admin', 'pass')
      driveToConnected(transport, cm)
      ackInitialRequests(transport)
      transport.clearSent()
    })

    it('sends short CW text as CI-V 0x17 command', () => {
      keyer.send([{ type: 'text', value: 'CQ' }], 20)

      // Allow sendCW operation to process
      jest.advanceTimersByTime(100)

      const serialSent = transport.sentPackets.filter(p => p.id === 'serial')
      expect(serialSent.length).toBeGreaterThan(0)

      const pkt = serialSent[0].data
      expect(pkt[0x10]).toBe(0xC1)

      const civStart = 0x15
      expect(pkt[civStart]).toBe(PREAMBLE)
      expect(pkt[civStart + 1]).toBe(PREAMBLE)
      expect(pkt[civStart + 4]).toBe(Command.sendCW)
      expect(pkt[civStart + 5]).toBe(0x43) // 'C'
      expect(pkt[civStart + 6]).toBe(0x51) // 'Q'
    })

    it('chunks long CW messages and paces delivery', () => {
      const sentTexts = []
      keyer.on('sendCW', (t) => sentTexts.push(t))

      const longMsg = 'CQ CQ CQ DE AC0VW AC0VW AC0VW PSE K'
      keyer.send([{ type: 'text', value: longMsg }], 20)

      expect(sentTexts.length).toBe(1)
      expect(sentTexts[0].length).toBe(30)

      jest.advanceTimersByTime(30000)
      expect(sentTexts.length).toBe(2)
      expect(sentTexts.join('')).toBe(longMsg)
    })

    it('sends templated CW with variable interpolation + macro expansion', () => {
      const sentTexts = []
      keyer.on('sendCW', (t) => sentTexts.push(t))

      keyer.sendInterpolatedTemplate(
        '$callsign DE $mycall {RST} K',
        { callsign: 'W1AW', mycall: 'AC0VW' },
        { callsign: 'W1AW', myCallsign: 'AC0VW', defaultRST: '599', cwSpeed: 20 }
      )

      jest.advanceTimersByTime(30000)
      const fullText = sentTexts.join('')
      expect(fullText).toBe('W1AW DE AC0VW 599 K')
    })

    it('cancel stops CW mid-message', () => {
      const sentTexts = []
      keyer.on('sendCW', (t) => sentTexts.push(t))

      keyer.send([
        { type: 'text', value: 'FIRST' },
        { type: 'delay', value: 5 },
        { type: 'text', value: 'SECOND' }
      ], 20)

      expect(sentTexts).toEqual(['FIRST'])
      keyer.cancelSend()
      jest.advanceTimersByTime(30000)
      expect(sentTexts).toEqual(['FIRST'])
      expect(keyer.isSending).toBe(false)
    })

    it('speed change macro triggers CI-V speed command', () => {
      keyer.send([
        { type: 'speedChange', value: 30 },
        { type: 'text', value: 'FAST' }
      ], 20)

      jest.advanceTimersByTime(30000)

      const serialSent = transport.sentPackets.filter(p => p.id === 'serial')
      const speedPkt = serialSent.find(p => {
        if (p.data.length < 0x17) return false
        if (p.data[0x10] !== 0xC1) return false
        const civStart = 0x15
        return p.data[civStart + 4] === Command.setLevel &&
               p.data[civStart + 5] === Command.cwSpeedSub
      })
      expect(speedPkt).toBeDefined()
    })

    it('serial number increments with each send', () => {
      keyer.serialNumber = 1
      const sentTexts = []
      keyer.on('sendCW', (t) => sentTexts.push(t))

      keyer.send([{ type: 'serialNumber' }], 20)
      jest.advanceTimersByTime(10000)
      expect(sentTexts).toContain('001')
      expect(keyer.serialNumber).toBe(2)

      keyer.send([{ type: 'serialNumber' }], 20)
      jest.advanceTimersByTime(10000)
      expect(sentTexts).toContain('002')
      expect(keyer.serialNumber).toBe(3)
    })
  })

  describe('CI-V command queue behavior', () => {
    beforeEach(async () => {
      await cm.connect('192.168.1.100', 'admin', 'pass')
      driveToConnected(transport, cm)
      ackInitialRequests(transport)
    })

    it('queues multiple CI-V commands and processes one at a time', () => {
      transport.clearSent()

      const { buildReadFrequency, buildReadMode } = require('../protocol/CIVProtocol')
      cm.sendCIV(buildReadFrequency())
      cm.sendCIV(buildReadMode())

      const serialSent = transport.sentPackets.filter(p => p.id === 'serial')
      expect(serialSent.length).toBe(1)
      expect(cm.queueDepth).toBe(1)

      transport.injectData('serial', makeACK())
      const serialSent2 = transport.sentPackets.filter(p => p.id === 'serial')
      expect(serialSent2.length).toBe(2)
      expect(cm.queueDepth).toBe(0)
    })

    it('handles NAK by completing with failure and moving on', () => {
      transport.clearSent()

      const completions = []
      const { buildReadFrequency } = require('../protocol/CIVProtocol')
      cm.sendCIV(buildReadFrequency(), { completion: (success) => completions.push(success) })
      cm.sendCIV(buildReadFrequency(), { completion: (success) => completions.push(success) })

      transport.injectData('serial', makeNAK())
      expect(completions).toEqual([false])

      transport.injectData('serial', makeACK())
      expect(completions).toEqual([false, true])
    })

    it('times out after 3s if no response', () => {
      transport.clearSent()

      const completions = []
      const { buildReadFrequency } = require('../protocol/CIVProtocol')
      cm.sendCIV(buildReadFrequency(), { completion: (success) => completions.push(success) })

      jest.advanceTimersByTime(3100)
      expect(completions).toEqual([false])
    })

    it('flushQueue clears pending commands for time-critical CW', () => {
      const { buildReadFrequency } = require('../protocol/CIVProtocol')

      cm.sendCIV(buildReadFrequency())
      cm.sendCIV(buildReadFrequency())
      cm.sendCIV(buildReadFrequency())

      cm.flushQueue()
      expect(cm.queueDepth).toBe(0)
      expect(cm._waitingForReply).toBe(false)
    })
  })

  describe('operation queue via ConnectionManager', () => {
    beforeEach(async () => {
      await cm.connect('192.168.1.100', 'admin', 'pass')
      driveToConnected(transport, cm)
      ackInitialRequests(transport)
    })

    it('queryStatus returns frequency and mode', async () => {
      const promise = cm.queryStatus()

      // Feed responses through the transport
      transport.injectData('serial', makeFrequencyResponse(14060000))
      transport.injectData('serial', makeModeResponse(0x03))

      const result = await promise
      expect(result.frequency).toBe(14060000)
      expect(result.mode).toBe('CW')
    })

    it('queryCWSpeed returns speed', async () => {
      const promise = cm.queryCWSpeed()

      transport.injectData('serial', makeCWSpeedResponse(0x00, 0x85))

      const result = await promise
      expect(result.cwSpeed).toBeGreaterThan(15)
      expect(result.cwSpeed).toBeLessThan(25)
    })

    it('enqueueSendCW completes after delay', async () => {
      transport.clearSent()
      const promise = cm.enqueueSendCW('CQ')

      jest.advanceTimersByTime(900)
      const result = await promise
      expect(result).toBe(true)
    })
  })

  describe('AppState disconnect', () => {
    let appStateCallback

    beforeAll(() => {
      jest.mock('react-native', () => ({
        AppState: {
          addEventListener: jest.fn((event, cb) => {
            appStateCallback = cb
            return { remove: jest.fn() }
          })
        }
      }), { virtual: true })
    })

    it('background triggers disconnect', async () => {
      await cm.connect('192.168.1.100', 'admin', 'pass')
      driveToConnected(transport, cm)
      expect(cm.isConnected).toBe(true)

      await cm.disconnect()
      expect(cm.state).toBe(ConnectionState.disconnected)
    })

    it('inactive triggers disconnect', async () => {
      await cm.connect('192.168.1.100', 'admin', 'pass')
      driveToConnected(transport, cm)
      expect(cm.isConnected).toBe(true)

      await cm.disconnect()
      expect(cm.state).toBe(ConnectionState.disconnected)
    })

    it('AppState listener cleanup on disconnect', async () => {
      await cm.connect('192.168.1.100', 'admin', 'pass')
      driveToConnected(transport, cm)

      await cm.disconnect()
      expect(cm.state).toBe(ConnectionState.disconnected)

      await cm.disconnect()
      expect(cm.state).toBe(ConnectionState.disconnected)
    })
  })

  describe('getStatus snapshot', () => {
    it('returns disconnected status when not connected', () => {
      expect(cm.isConnected).toBe(false)
      expect(cm.frequencyHz).toBe(0)
      expect(cm.modeLabel).toBeNull()
      expect(cm.cwSpeed).toBe(20)
    })

    it('returns full status after connect + rig data', async () => {
      await cm.connect('192.168.1.100', 'admin', 'pass')
      driveToConnected(transport, cm)
      ackInitialRequests(transport)

      transport.injectData('serial', makeFrequencyResponse(7074000))
      transport.injectData('serial', makeModeResponse(0x03))

      expect(cm.isConnected).toBe(true)
      expect(cm.frequencyHz).toBe(7074000)
      expect(cm.modeLabel).toBe('CW')
      expect(cm.radioName).toBe('IC-705')
    })

    it('exposes isBusy and activeOperation', async () => {
      await cm.connect('192.168.1.100', 'admin', 'pass')
      driveToConnected(transport, cm)
      ackInitialRequests(transport)

      expect(cm.isBusy).toBe(false)
      expect(cm.activeOperation).toBeNull()

      cm.queryStatus()
      expect(cm.activeOperation).toBe('status')
    })
  })
})
