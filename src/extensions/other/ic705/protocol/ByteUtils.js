/*
 * Uint8Array read/write helpers for RS-BA1 and CI-V protocol packets.
 * All multi-byte reads/writes default to little-endian unless suffixed with BE.
 */

export function allocate (size) {
  return new Uint8Array(size)
}

// --- Little-endian ---

export function readUInt16LE (buf, offset) {
  return buf[offset] | (buf[offset + 1] << 8)
}

export function writeUInt16LE (buf, offset, value) {
  buf[offset] = value & 0xFF
  buf[offset + 1] = (value >> 8) & 0xFF
}

export function readUInt32LE (buf, offset) {
  return (
    buf[offset] |
    (buf[offset + 1] << 8) |
    (buf[offset + 2] << 16) |
    ((buf[offset + 3] << 24) >>> 0) // >>> 0 to stay unsigned
  ) >>> 0
}

export function writeUInt32LE (buf, offset, value) {
  buf[offset] = value & 0xFF
  buf[offset + 1] = (value >> 8) & 0xFF
  buf[offset + 2] = (value >> 16) & 0xFF
  buf[offset + 3] = (value >> 24) & 0xFF
}

// --- Big-endian ---

export function readUInt16BE (buf, offset) {
  return (buf[offset] << 8) | buf[offset + 1]
}

export function writeUInt16BE (buf, offset, value) {
  buf[offset] = (value >> 8) & 0xFF
  buf[offset + 1] = value & 0xFF
}

export function readUInt32BE (buf, offset) {
  return (
    ((buf[offset] << 24) >>> 0) |
    (buf[offset + 1] << 16) |
    (buf[offset + 2] << 8) |
    buf[offset + 3]
  ) >>> 0
}

export function writeUInt32BE (buf, offset, value) {
  buf[offset] = (value >> 24) & 0xFF
  buf[offset + 1] = (value >> 16) & 0xFF
  buf[offset + 2] = (value >> 8) & 0xFF
  buf[offset + 3] = value & 0xFF
}

// --- Base64 ---

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function toBase64 (uint8Array) {
  let result = ''
  const len = uint8Array.length
  for (let i = 0; i < len; i += 3) {
    const a = uint8Array[i]
    const b = i + 1 < len ? uint8Array[i + 1] : 0
    const c = i + 2 < len ? uint8Array[i + 2] : 0
    result += B64_CHARS[(a >> 2) & 0x3F]
    result += B64_CHARS[((a << 4) | (b >> 4)) & 0x3F]
    result += i + 1 < len ? B64_CHARS[((b << 2) | (c >> 6)) & 0x3F] : '='
    result += i + 2 < len ? B64_CHARS[c & 0x3F] : '='
  }
  return result
}

const B64_LOOKUP = new Uint8Array(128)
for (let i = 0; i < B64_CHARS.length; i++) B64_LOOKUP[B64_CHARS.charCodeAt(i)] = i

export function fromBase64 (str) {
  const cleanStr = str.replace(/=+$/, '')
  const len = cleanStr.length
  const byteLen = (len * 3) >> 2
  const result = new Uint8Array(byteLen)
  let p = 0
  for (let i = 0; i < len; i += 4) {
    const a = B64_LOOKUP[cleanStr.charCodeAt(i)]
    const b = i + 1 < len ? B64_LOOKUP[cleanStr.charCodeAt(i + 1)] : 0
    const c = i + 2 < len ? B64_LOOKUP[cleanStr.charCodeAt(i + 2)] : 0
    const d = i + 3 < len ? B64_LOOKUP[cleanStr.charCodeAt(i + 3)] : 0
    result[p++] = (a << 2) | (b >> 4)
    if (p < byteLen) result[p++] = ((b << 4) | (c >> 2)) & 0xFF
    if (p < byteLen) result[p++] = ((c << 6) | d) & 0xFF
  }
  return result
}
