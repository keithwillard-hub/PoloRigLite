import { CWKeyer, estimateDuration, EntryType, DEFAULT_MEMORIES } from '../keyer/CWKeyer'

describe('CWKeyer', () => {
  let keyer

  beforeEach(() => {
    keyer = new CWKeyer()
    jest.useFakeTimers()
  })

  afterEach(() => {
    keyer.cancelSend()
    jest.useRealTimers()
  })

  const baseContext = {
    callsign: 'W1AW',
    myCallsign: 'AC0VW',
    frequencyHz: 14060000,
    defaultRST: '599',
    cwSpeed: 20
  }

  describe('expandMacros', () => {
    it('expands {CALL}', () => {
      const entries = keyer.expandMacros('{CALL} DE {MYCALL}', baseContext)
      expect(entries).toEqual([
        { type: EntryType.TEXT, value: 'W1AW' },
        { type: EntryType.TEXT, value: ' DE ' },
        { type: EntryType.TEXT, value: 'AC0VW' }
      ])
    })

    it('expands {SERIAL} as serialNumber entry', () => {
      const entries = keyer.expandMacros('NR {SERIAL}', baseContext)
      expect(entries).toEqual([
        { type: EntryType.TEXT, value: 'NR ' },
        { type: EntryType.SERIAL_NUMBER }
      ])
    })

    it('expands {RST}', () => {
      const entries = keyer.expandMacros('{RST}', baseContext)
      expect(entries).toEqual([{ type: EntryType.TEXT, value: '599' }])
    })

    it('expands {FREQ}', () => {
      const entries = keyer.expandMacros('{FREQ}', baseContext)
      expect(entries).toEqual([{ type: EntryType.TEXT, value: '14060' }])
    })

    it('expands {SPEED:n}', () => {
      const entries = keyer.expandMacros('{SPEED:30}', baseContext)
      expect(entries).toEqual([{ type: EntryType.SPEED_CHANGE, value: 30 }])
    })

    it('expands {DELAY:n}', () => {
      const entries = keyer.expandMacros('{DELAY:2.5}', baseContext)
      expect(entries).toEqual([{ type: EntryType.DELAY, value: 2.5 }])
    })

    it('passes unknown macros through as literal', () => {
      const entries = keyer.expandMacros('{UNKNOWN}', baseContext)
      expect(entries).toEqual([{ type: EntryType.TEXT, value: '{UNKNOWN}' }])
    })

    it('handles text with no macros', () => {
      const entries = keyer.expandMacros('CQ CQ CQ', baseContext)
      expect(entries).toEqual([{ type: EntryType.TEXT, value: 'CQ CQ CQ' }])
    })

    it('handles unclosed brace', () => {
      const entries = keyer.expandMacros('NR {SERIAL', baseContext)
      expect(entries).toEqual([
        { type: EntryType.TEXT, value: 'NR ' },
        { type: EntryType.TEXT, value: '{SERIAL' }
      ])
    })

    it('is case-insensitive for macro names', () => {
      const entries = keyer.expandMacros('{call}', baseContext)
      expect(entries).toEqual([{ type: EntryType.TEXT, value: 'W1AW' }])
    })
  })

  describe('formatSerialNumber', () => {
    it('zero-pads to 3 digits', () => {
      expect(keyer.formatSerialNumber(1)).toBe('001')
      expect(keyer.formatSerialNumber(42)).toBe('042')
      expect(keyer.formatSerialNumber(100)).toBe('100')
    })

    it('applies cut numbers', () => {
      expect(keyer.formatSerialNumber(100, true)).toBe('1TT')
      expect(keyer.formatSerialNumber(99, true)).toBe('TNN')
      expect(keyer.formatSerialNumber(109, true)).toBe('1TN')
    })
  })

  describe('send and events', () => {
    it('emits sendingStarted and sendCW', () => {
      const started = jest.fn()
      const sent = jest.fn((text, cb) => cb(true))
      keyer.on('sendingStarted', started)
      keyer.on('sendCW', sent)

      keyer.send([{ type: EntryType.TEXT, value: 'CQ' }], 20)

      expect(started).toHaveBeenCalledTimes(1)
      expect(sent).toHaveBeenCalledWith('CQ', expect.any(Function))
    })

    it('emits sendingEnded after processing', () => {
      const ended = jest.fn()
      keyer.on('sendingEnded', ended)
      keyer.on('sendCW', (text, cb) => cb(true))

      keyer.send([{ type: EntryType.TEXT, value: 'CQ' }], 20)

      // Let pacing timer fire
      jest.runAllTimers()
      expect(ended).toHaveBeenCalledTimes(1)
    })

    it('chunks text longer than 30 chars', () => {
      const chunks = []
      keyer.on('sendCW', (text, cb) => { chunks.push(text); cb(true) })

      const longText = 'A'.repeat(65)
      keyer.send([{ type: EntryType.TEXT, value: longText }], 20)

      // Process all chunk timers
      jest.runAllTimers()

      expect(chunks.length).toBe(3) // 30 + 30 + 5
      expect(chunks[0].length).toBe(30)
      expect(chunks[1].length).toBe(30)
      expect(chunks[2].length).toBe(5)
    })

    it('processes speed changes', () => {
      const speeds = []
      keyer.on('setSpeed', (wpm) => speeds.push(wpm))

      keyer.send([
        { type: EntryType.SPEED_CHANGE, value: 30 },
        { type: EntryType.TEXT, value: 'CQ' }
      ], 20)

      jest.runAllTimers()
      expect(speeds).toEqual([30])
    })

    it('processes serial numbers and increments', () => {
      keyer.serialNumber = 42
      const texts = []
      keyer.on('sendCW', (text, cb) => { texts.push(text); cb(true) })

      keyer.send([{ type: EntryType.SERIAL_NUMBER }], 20)
      jest.runAllTimers()

      expect(texts).toEqual(['042'])
      expect(keyer.serialNumber).toBe(43)
    })

    it('cancelSend stops processing', () => {
      const sent = jest.fn((text, cb) => cb(true))
      keyer.on('sendCW', sent)

      keyer.send([
        { type: EntryType.TEXT, value: 'CQ' },
        { type: EntryType.DELAY, value: 5 },
        { type: EntryType.TEXT, value: 'DE' }
      ], 20)

      // First chunk sent immediately
      expect(sent).toHaveBeenCalledTimes(1)

      keyer.cancelSend()
      jest.runAllTimers()

      // 'DE' should never be sent
      expect(sent).toHaveBeenCalledTimes(1)
      expect(keyer.isSending).toBe(false)
    })
  })

  describe('sendInterpolatedTemplate', () => {
    it('interpolates $variables then expands {MACROS}', () => {
      const texts = []
      keyer.on('sendCW', (text, cb) => { texts.push(text); cb(true) })

      keyer.sendInterpolatedTemplate(
        '$callsign DE $mycall {RST}',
        { callsign: 'W1AW', mycall: 'AC0VW' },
        baseContext
      )

      jest.runAllTimers()
      expect(texts.join('')).toBe('W1AW DE AC0VW 599')
    })
  })
})

describe('estimateDuration', () => {
  it('returns 0 for 0 wpm', () => {
    expect(estimateDuration('CQ', 0)).toBe(0)
  })

  it('estimates single character', () => {
    // 'E' = 1 element, at 20 WPM dit = 60ms
    const duration = estimateDuration('E', 20)
    expect(duration).toBeCloseTo(0.06, 2)
  })

  it('handles spaces as word gaps', () => {
    const withSpace = estimateDuration('A B', 20)
    const withoutSpace = estimateDuration('AB', 20)
    expect(withSpace).toBeGreaterThan(withoutSpace)
  })

  it('skips unknown characters', () => {
    expect(estimateDuration('~', 20)).toBe(0)
  })

  it('produces reasonable duration for CQ call', () => {
    const duration = estimateDuration('CQ CQ CQ DE AC0VW K', 20)
    // Should be a few seconds
    expect(duration).toBeGreaterThan(1)
    expect(duration).toBeLessThan(15)
  })
})
