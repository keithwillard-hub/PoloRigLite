import {
  parseFrequencyHz, frequencyToBytes,
  wpmToValue, valueToWpm,
  buildFrame, buildReadFrequency, buildSendCW, buildStopCW, buildSetCWSpeed,
  parseCIVResponse, formatMHz, formatKHz,
  PREAMBLE, TERMINATOR, RADIO_ADDRESS, CONTROLLER_ADDRESS, ACK, NAK,
  Command, CW_SPEED_MIN, CW_SPEED_MAX
} from '../protocol/CIVProtocol'

describe('CIVProtocol', () => {
  describe('BCD frequency codec', () => {
    it('parses 14.060.000 MHz', () => {
      // 14060000 Hz -> BCD bytes LSB first:
      // 00 00 06 14 00
      expect(parseFrequencyHz([0x00, 0x00, 0x06, 0x14, 0x00])).toBe(14060000)
    })

    it('parses 7.074.000 MHz', () => {
      expect(parseFrequencyHz([0x00, 0x40, 0x07, 0x07, 0x00])).toBe(7074000)
    })

    it('parses 146.520.000 MHz', () => {
      expect(parseFrequencyHz([0x00, 0x00, 0x52, 0x46, 0x01])).toBe(146520000)
    })

    it('round-trips frequencies', () => {
      const testFreqs = [14060000, 7074000, 3573000, 28074000, 146520000, 440000000]
      for (const freq of testFreqs) {
        expect(parseFrequencyHz(frequencyToBytes(freq))).toBe(freq)
      }
    })

    it('returns null for invalid BCD digits', () => {
      expect(parseFrequencyHz([0xFF, 0x00, 0x00, 0x00, 0x00])).toBeNull()
    })

    it('returns null for too few bytes', () => {
      expect(parseFrequencyHz([0x00, 0x00])).toBeNull()
      expect(parseFrequencyHz(null)).toBeNull()
    })
  })

  describe('CW speed codec', () => {
    it('maps 6 WPM to [0, 0]', () => {
      expect(wpmToValue(6)).toEqual([0, 0])
    })

    it('maps 48 WPM to BCD 255 -> [2, 0x55]', () => {
      const [h, l] = wpmToValue(48)
      expect(h).toBe(2)
      expect(l).toBe(0x55)
    })

    it('clamps below minimum', () => {
      expect(wpmToValue(1)).toEqual(wpmToValue(6))
    })

    it('clamps above maximum', () => {
      expect(wpmToValue(100)).toEqual(wpmToValue(48))
    })

    it('round-trips common speeds', () => {
      for (const wpm of [6, 10, 15, 20, 25, 30, 35, 40, 48]) {
        const [h, l] = wpmToValue(wpm)
        const result = valueToWpm(h, l)
        expect(Math.abs(result - wpm)).toBeLessThanOrEqual(1)
      }
    })
  })

  describe('buildFrame', () => {
    it('builds a basic CI-V frame', () => {
      const frame = buildFrame(0x03)
      expect(Array.from(frame)).toEqual([0xFE, 0xFE, 0xA4, 0xE0, 0x03, 0xFD])
    })

    it('includes sub-command', () => {
      const frame = buildFrame(0x14, 0x0C)
      expect(Array.from(frame)).toEqual([0xFE, 0xFE, 0xA4, 0xE0, 0x14, 0x0C, 0xFD])
    })

    it('includes data bytes', () => {
      const frame = buildFrame(0x17, null, [0x48, 0x49])
      expect(Array.from(frame)).toEqual([0xFE, 0xFE, 0xA4, 0xE0, 0x17, 0x48, 0x49, 0xFD])
    })
  })

  describe('convenience builders', () => {
    it('buildReadFrequency', () => {
      const frame = buildReadFrequency()
      expect(frame[4]).toBe(Command.readFrequency)
      expect(frame.length).toBe(6)
    })

    it('buildSendCW limits to 30 chars', () => {
      const long = 'A'.repeat(50)
      const frame = buildSendCW(long)
      // 6 header/footer bytes + 30 data bytes
      expect(frame.length).toBe(36)
    })

    it('buildSendCW uppercases text', () => {
      const frame = buildSendCW('cq')
      expect(frame[5]).toBe(0x43) // 'C'
      expect(frame[6]).toBe(0x51) // 'Q'
    })

    it('buildStopCW sends 0xFF', () => {
      const frame = buildStopCW()
      expect(frame[5]).toBe(0xFF)
    })

    it('buildSetCWSpeed', () => {
      const frame = buildSetCWSpeed(20)
      expect(frame[4]).toBe(Command.setLevel)
      expect(frame[5]).toBe(Command.cwSpeedSub)
    })
  })

  describe('parseCIVResponse', () => {
    it('parses a valid frame', () => {
      const data = new Uint8Array([0xFE, 0xFE, 0xE0, 0xA4, 0x03, 0x00, 0x00, 0x06, 0x40, 0x01, 0xFD])
      const result = parseCIVResponse(data)
      expect(result.command).toBe(0x03)
      expect(result.source).toBe(0xA4)
      expect(result.destination).toBe(0xE0)
      expect(result.payload.length).toBe(5)
      expect(result.isAck).toBe(false)
      expect(result.isNak).toBe(false)
    })

    it('detects ACK', () => {
      const data = new Uint8Array([0xFE, 0xFE, 0xE0, 0xA4, ACK, 0xFD])
      const result = parseCIVResponse(data)
      expect(result.isAck).toBe(true)
    })

    it('detects NAK', () => {
      const data = new Uint8Array([0xFE, 0xFE, 0xE0, 0xA4, NAK, 0xFD])
      const result = parseCIVResponse(data)
      expect(result.isNak).toBe(true)
    })

    it('returns null for invalid frame', () => {
      expect(parseCIVResponse(new Uint8Array([0x00, 0x01]))).toBeNull()
      expect(parseCIVResponse(null)).toBeNull()
    })
  })

  describe('format helpers', () => {
    it('formatMHz', () => {
      expect(formatMHz(14060000)).toBe('14.060 MHz')
      expect(formatMHz(440000000)).toBe('440.000 MHz')
      expect(formatMHz(1296000000)).toBe('1.296 GHz')
      expect(formatMHz(500000)).toBe('500.000 kHz')
    })

    it('formatKHz', () => {
      expect(formatKHz(14060000)).toBe('14060')
      expect(formatKHz(7074000)).toBe('7074')
    })
  })
})
