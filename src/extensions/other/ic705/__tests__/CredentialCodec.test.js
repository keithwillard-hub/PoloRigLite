import { encodeCredential } from '../protocol/CredentialCodec'

describe('CredentialCodec', () => {
  it('returns a 16-byte Uint8Array', () => {
    const result = encodeCredential('test')
    expect(result).toBeInstanceOf(Uint8Array)
    expect(result.length).toBe(16)
  })

  it('zero-pads short strings', () => {
    const result = encodeCredential('ab')
    // Bytes after position 1 should be 0
    for (let i = 2; i < 16; i++) {
      expect(result[i]).toBe(0)
    }
  })

  it('truncates strings longer than 16 chars', () => {
    const long = 'abcdefghijklmnopqrstuvwxyz'
    const result = encodeCredential(long)
    expect(result.length).toBe(16)
    // Should equal encoding of just the first 16 chars
    const truncated = encodeCredential(long.slice(0, 16))
    expect(Array.from(result)).toEqual(Array.from(truncated))
  })

  it('produces different output for different positions (position-dependent)', () => {
    // Same character at different positions should produce different encoded bytes
    const result = encodeCredential('aaa')
    // 'a' = 0x61 = 97
    // pos 0: p = 0 + 97 = 97, key[97-32] = key[65]
    // pos 1: p = 1 + 97 = 98, key[98-32] = key[66]
    // pos 2: p = 2 + 97 = 99, key[99-32] = key[67]
    expect(result[0]).not.toBe(result[1])
    expect(result[1]).not.toBe(result[2])
  })

  it('handles empty string', () => {
    const result = encodeCredential('')
    expect(result.every(b => b === 0)).toBe(true)
  })

  it('produces consistent output (deterministic)', () => {
    const a = encodeCredential('admin')
    const b = encodeCredential('admin')
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('encodes known test vector matching Swift implementation', () => {
    // 'a' at position 0: charCode=97, p=97, key[65] = 0x38
    const result = encodeCredential('a')
    expect(result[0]).toBe(0x38)
  })
})
