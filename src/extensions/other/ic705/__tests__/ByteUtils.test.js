import {
  allocate,
  readUInt16LE, writeUInt16LE,
  readUInt32LE, writeUInt32LE,
  readUInt16BE, writeUInt16BE,
  readUInt32BE, writeUInt32BE,
  toBase64, fromBase64
} from '../protocol/ByteUtils'

describe('ByteUtils', () => {
  describe('allocate', () => {
    it('creates a zero-filled Uint8Array', () => {
      const buf = allocate(16)
      expect(buf).toBeInstanceOf(Uint8Array)
      expect(buf.length).toBe(16)
      expect(buf.every(b => b === 0)).toBe(true)
    })
  })

  describe('UInt16 LE', () => {
    it('round-trips a value', () => {
      const buf = allocate(4)
      writeUInt16LE(buf, 1, 0x1234)
      expect(readUInt16LE(buf, 1)).toBe(0x1234)
    })

    it('writes low byte first', () => {
      const buf = allocate(2)
      writeUInt16LE(buf, 0, 0xABCD)
      expect(buf[0]).toBe(0xCD)
      expect(buf[1]).toBe(0xAB)
    })
  })

  describe('UInt32 LE', () => {
    it('round-trips a value', () => {
      const buf = allocate(8)
      writeUInt32LE(buf, 2, 0xDEADBEEF)
      expect(readUInt32LE(buf, 2)).toBe(0xDEADBEEF)
    })

    it('writes low byte first', () => {
      const buf = allocate(4)
      writeUInt32LE(buf, 0, 0x01020304)
      expect(buf[0]).toBe(0x04)
      expect(buf[1]).toBe(0x03)
      expect(buf[2]).toBe(0x02)
      expect(buf[3]).toBe(0x01)
    })
  })

  describe('UInt16 BE', () => {
    it('round-trips a value', () => {
      const buf = allocate(4)
      writeUInt16BE(buf, 1, 0x1234)
      expect(readUInt16BE(buf, 1)).toBe(0x1234)
    })

    it('writes high byte first', () => {
      const buf = allocate(2)
      writeUInt16BE(buf, 0, 0xABCD)
      expect(buf[0]).toBe(0xAB)
      expect(buf[1]).toBe(0xCD)
    })
  })

  describe('UInt32 BE', () => {
    it('round-trips a value', () => {
      const buf = allocate(8)
      writeUInt32BE(buf, 2, 0xDEADBEEF)
      expect(readUInt32BE(buf, 2)).toBe(0xDEADBEEF)
    })

    it('writes high byte first', () => {
      const buf = allocate(4)
      writeUInt32BE(buf, 0, 0x01020304)
      expect(buf[0]).toBe(0x01)
      expect(buf[1]).toBe(0x02)
      expect(buf[2]).toBe(0x03)
      expect(buf[3]).toBe(0x04)
    })
  })

  describe('base64', () => {
    it('round-trips binary data', () => {
      const original = new Uint8Array([0x00, 0xFF, 0x80, 0x7F, 0x01])
      const encoded = toBase64(original)
      const decoded = fromBase64(encoded)
      expect(Array.from(decoded)).toEqual(Array.from(original))
    })

    it('encodes known values', () => {
      // "Hello" in ASCII
      const data = new Uint8Array([72, 101, 108, 108, 111])
      expect(toBase64(data)).toBe('SGVsbG8=')
    })

    it('decodes known values', () => {
      const result = fromBase64('SGVsbG8=')
      expect(Array.from(result)).toEqual([72, 101, 108, 108, 111])
    })

    it('handles empty input', () => {
      expect(toBase64(new Uint8Array(0))).toBe('')
      expect(fromBase64('').length).toBe(0)
    })
  })
})
