/*
 * RS-BA1 protocol packet construction and parsing.
 * Ported from PacketBuilder.swift and PacketDefinitions.swift.
 */

import {
  allocate,
  readUInt16LE, writeUInt16LE,
  readUInt32LE, writeUInt32LE,
  readUInt32BE, writeUInt32BE
} from './ByteUtils'
import { encodeCredential } from './CredentialCodec'

// --- Packet Sizes ---
export const PacketSize = {
  control: 0x10,     // 16
  watchdog: 0x14,    // 20
  ping: 0x15,        // 21
  openClose: 0x16,   // 22
  retransmit: 0x18,  // 24
  token: 0x40,       // 64
  status: 0x50,      // 80
  loginResponse: 0x60, // 96
  login: 0x80,       // 128
  connInfo: 0x90,    // 144
  capabilities: 0xA8, // 168
  civHeader: 0x15    // 21
}

// --- Packet Types ---
export const PacketType = {
  idle: 0x0000,
  retransmit: 0x0001,
  areYouThere: 0x0003,
  iAmHere: 0x0004,
  disconnect: 0x0005,
  areYouReady: 0x0006,
  ping: 0x0007
}

// --- Offsets ---
export const ControlOffset = {
  length: 0x00,
  type: 0x04,
  sequence: 0x06,
  sendId: 0x08,
  recvId: 0x0C
}

const PingOffset = { request: 0x10, dataA: 0x11, dataB: 0x13 }

export const TokenOffset = {
  code: 0x13,
  res: 0x15,
  innerSeq: 0x17,
  tokReq: 0x1A,
  token: 0x1C,
  commCap: 0x27,
  reqRep: 0x29,
  macAddr: 0x2A
}

export const TokenCode = {
  loginRequest: 0x0170,
  loginResponse: 0x0250,
  tokenAck: 0x0130,
  tokenAckResponse: 0x0230,
  connInfoFromHost: 0x0180,
  connInfoFromRadio: 0x0380,
  status: 0x0240,
  capabilities: 0x0298
}

export const TokenRes = {
  login: 0x0000,
  ack: 0x0002,
  connInfo: 0x0003,
  renew: 0x0005,
  remove: 0x0001
}

const LoginOffset = { userName: 0x40, password: 0x50, computer: 0x60 }

const ConnInfoOffset = {
  radioName: 0x40,
  userName: 0x60,
  enableRx: 0x70,
  enableTx: 0x71,
  rxCodec: 0x72,
  txCodec: 0x73,
  rxSample: 0x74,
  txSample: 0x78,
  civPort: 0x7C,
  audioPort: 0x80,
  txBuffer: 0x84,
  convert: 0x88
}

export const CapabilitiesOffset = {
  macAddr: 0x4C,
  radioName: 0x52,
  civAddr: 0x94
}

const OpenCloseOffset = { cmd: 0x10, length: 0x11, sequence: 0x13, request: 0x15 }
const CIVPacketOffset = { cmd: 0x10, length: 0x11, sequence: 0x13, data: 0x15 }

export const Timing = {
  pingInterval: 0.5,
  idleInterval: 0.1,
  resendInterval: 0.1,
  tokenRenewInterval: 60.0
}

// --- Packet Builders ---

export function controlPacket (type, sequence, sendId, recvId) {
  const data = allocate(PacketSize.control)
  writeUInt32LE(data, ControlOffset.length, PacketSize.control)
  writeUInt16LE(data, ControlOffset.type, type)
  writeUInt16LE(data, ControlOffset.sequence, sequence)
  writeUInt32LE(data, ControlOffset.sendId, sendId)
  writeUInt32LE(data, ControlOffset.recvId, recvId)
  return data
}

export function areYouThere (sendId) {
  return controlPacket(PacketType.areYouThere, 0, sendId, 0)
}

export function areYouReady (sequence, sendId, recvId) {
  return controlPacket(PacketType.areYouReady, sequence, sendId, recvId)
}

export function disconnectPacket (sequence, sendId, recvId) {
  return controlPacket(PacketType.disconnect, sequence, sendId, recvId)
}

export function idle (sequence, sendId, recvId) {
  return controlPacket(PacketType.idle, sequence, sendId, recvId)
}

export function pingPacket (sequence, sendId, recvId, isReply, dataA, dataB) {
  const data = allocate(PacketSize.ping)
  writeUInt32LE(data, ControlOffset.length, PacketSize.ping)
  writeUInt16LE(data, ControlOffset.type, PacketType.ping)
  writeUInt16LE(data, ControlOffset.sequence, sequence)
  writeUInt32LE(data, ControlOffset.sendId, sendId)
  writeUInt32LE(data, ControlOffset.recvId, recvId)
  data[PingOffset.request] = isReply ? 0x01 : 0x00
  writeUInt16LE(data, PingOffset.dataA, dataA)
  writeUInt16LE(data, PingOffset.dataB, dataB)
  return data
}

export function pongReply (pingData, sendId, recvId) {
  const reply = new Uint8Array(pingData)
  writeUInt32LE(reply, ControlOffset.length, PacketSize.ping)
  writeUInt32LE(reply, ControlOffset.sendId, sendId)
  writeUInt32LE(reply, ControlOffset.recvId, recvId)
  reply[PingOffset.request] = 0x01
  return reply
}

export function tokenPacket (code, res, innerSeq, sendId, recvId, sequence, tokReq, token) {
  const data = allocate(PacketSize.token)
  writeUInt32LE(data, ControlOffset.length, PacketSize.token)
  writeUInt16LE(data, ControlOffset.type, PacketType.idle)
  writeUInt16LE(data, ControlOffset.sequence, sequence)
  writeUInt32LE(data, ControlOffset.sendId, sendId)
  writeUInt32LE(data, ControlOffset.recvId, recvId)
  writeUInt16LE(data, TokenOffset.code, code)
  writeUInt16LE(data, TokenOffset.res, res)
  data[TokenOffset.innerSeq] = innerSeq
  writeUInt16LE(data, TokenOffset.tokReq, tokReq)
  writeUInt32LE(data, TokenOffset.token, token)
  return data
}

export function loginPacket (innerSeq, sendId, recvId, sequence, tokReq, userName, password, computerName) {
  const data = allocate(PacketSize.login)
  writeUInt32LE(data, ControlOffset.length, PacketSize.login)
  writeUInt16LE(data, ControlOffset.type, PacketType.idle)
  writeUInt16LE(data, ControlOffset.sequence, sequence)
  writeUInt32LE(data, ControlOffset.sendId, sendId)
  writeUInt32LE(data, ControlOffset.recvId, recvId)
  writeUInt16LE(data, TokenOffset.code, TokenCode.loginRequest)
  writeUInt16LE(data, TokenOffset.res, TokenRes.login)
  data[TokenOffset.innerSeq] = innerSeq
  writeUInt16LE(data, TokenOffset.tokReq, tokReq)
  writeUInt32LE(data, TokenOffset.token, 0)

  const encodedUser = encodeCredential(userName)
  data.set(encodedUser, LoginOffset.userName)

  const encodedPass = encodeCredential(password)
  data.set(encodedPass, LoginOffset.password)

  const compBytes = new Uint8Array(16)
  for (let i = 0; i < Math.min(computerName.length, 16); i++) {
    compBytes[i] = computerName.charCodeAt(i)
  }
  data.set(compBytes, LoginOffset.computer)

  return data
}

export function tokenAcknowledge (innerSeq, sendId, recvId, sequence, tokReq, token) {
  return tokenPacket(TokenCode.tokenAck, TokenRes.ack, innerSeq, sendId, recvId, sequence, tokReq, token)
}

export function tokenRenew (innerSeq, sendId, recvId, sequence, tokReq, token) {
  return tokenPacket(TokenCode.tokenAck, TokenRes.renew, innerSeq, sendId, recvId, sequence, tokReq, token)
}

export function tokenRemove (innerSeq, sendId, recvId, sequence, tokReq, token) {
  return tokenPacket(TokenCode.tokenAck, TokenRes.remove, innerSeq, sendId, recvId, sequence, tokReq, token)
}

export function connInfoPacket (innerSeq, sendId, recvId, sequence, tokReq, token, commCap, macAddr, radioName, userName, serialPort, audioPort) {
  const data = allocate(PacketSize.connInfo)
  writeUInt32LE(data, ControlOffset.length, PacketSize.connInfo)
  writeUInt16LE(data, ControlOffset.type, PacketType.idle)
  writeUInt16LE(data, ControlOffset.sequence, sequence)
  writeUInt32LE(data, ControlOffset.sendId, sendId)
  writeUInt32LE(data, ControlOffset.recvId, recvId)
  writeUInt16LE(data, TokenOffset.code, TokenCode.connInfoFromHost)
  writeUInt16LE(data, TokenOffset.res, TokenRes.connInfo)
  data[TokenOffset.innerSeq] = innerSeq
  writeUInt16LE(data, TokenOffset.tokReq, tokReq)
  writeUInt32LE(data, TokenOffset.token, token)
  writeUInt16LE(data, TokenOffset.commCap, commCap)

  if (macAddr && macAddr.length >= 6) {
    data.set(macAddr.slice(0, 6), TokenOffset.macAddr)
  }

  for (let i = 0; i < Math.min(radioName.length, 16); i++) {
    data[ConnInfoOffset.radioName + i] = radioName.charCodeAt(i)
  }

  const encodedUser = encodeCredential(userName)
  data.set(encodedUser, ConnInfoOffset.userName)

  data[ConnInfoOffset.enableRx] = 0x01
  data[ConnInfoOffset.enableTx] = 0x01
  data[ConnInfoOffset.rxCodec] = 0x04
  data[ConnInfoOffset.txCodec] = 0x04
  writeUInt32BE(data, ConnInfoOffset.rxSample, 8000)
  writeUInt32BE(data, ConnInfoOffset.txSample, 8000)
  writeUInt32BE(data, ConnInfoOffset.civPort, serialPort)
  writeUInt32BE(data, ConnInfoOffset.audioPort, audioPort)
  writeUInt32BE(data, ConnInfoOffset.txBuffer, 100)
  data[ConnInfoOffset.convert] = 0x01

  return data
}

export function openClosePacket (sequence, sendId, recvId, civSequence, isOpen) {
  const data = allocate(PacketSize.openClose)
  writeUInt32LE(data, ControlOffset.length, PacketSize.openClose)
  writeUInt16LE(data, ControlOffset.type, PacketType.idle)
  writeUInt16LE(data, ControlOffset.sequence, sequence)
  writeUInt32LE(data, ControlOffset.sendId, sendId)
  writeUInt32LE(data, ControlOffset.recvId, recvId)
  data[OpenCloseOffset.cmd] = 0xC0
  writeUInt16LE(data, OpenCloseOffset.length, 0x0001)
  writeUInt16LE(data, OpenCloseOffset.sequence, civSequence)
  data[OpenCloseOffset.request] = isOpen ? 0x04 : 0x00
  return data
}

export function civPacket (sequence, sendId, recvId, civSequence, civData) {
  const totalLength = PacketSize.civHeader + civData.length
  const data = allocate(totalLength)
  writeUInt32LE(data, ControlOffset.length, totalLength)
  writeUInt16LE(data, ControlOffset.type, PacketType.idle)
  writeUInt16LE(data, ControlOffset.sequence, sequence)
  writeUInt32LE(data, ControlOffset.sendId, sendId)
  writeUInt32LE(data, ControlOffset.recvId, recvId)
  data[CIVPacketOffset.cmd] = 0xC1
  writeUInt16LE(data, CIVPacketOffset.length, civData.length)
  writeUInt16LE(data, CIVPacketOffset.sequence, civSequence)
  data.set(civData instanceof Uint8Array ? civData : new Uint8Array(civData), CIVPacketOffset.data)
  return data
}

// --- Packet Parsers ---

export function parsePacketType (data) {
  if (!data || data.length < PacketSize.control) return null
  return readUInt16LE(data, ControlOffset.type)
}

export function parsePacketHeader (data) {
  if (!data || data.length < PacketSize.control) return null
  return {
    length: readUInt32LE(data, ControlOffset.length),
    type: readUInt16LE(data, ControlOffset.type),
    sequence: readUInt16LE(data, ControlOffset.sequence),
    sendId: readUInt32LE(data, ControlOffset.sendId),
    recvId: readUInt32LE(data, ControlOffset.recvId)
  }
}

export function parseTokenFields (data) {
  if (!data || data.length < PacketSize.token) return null
  return {
    code: readUInt16LE(data, TokenOffset.code),
    res: readUInt16LE(data, TokenOffset.res),
    innerSeq: data[TokenOffset.innerSeq],
    tokReq: readUInt16LE(data, TokenOffset.tokReq),
    token: readUInt32LE(data, TokenOffset.token)
  }
}

export function parseCapabilities (data) {
  if (!data || data.length < PacketSize.capabilities) return null
  const macAddr = data.slice(CapabilitiesOffset.macAddr, CapabilitiesOffset.macAddr + 6)
  const nameBytes = data.slice(CapabilitiesOffset.radioName, CapabilitiesOffset.radioName + 16)
  let radioName = ''
  for (const b of nameBytes) {
    if (b === 0) break
    radioName += String.fromCharCode(b)
  }
  return {
    macAddr,
    radioName: radioName.trim(),
    civAddr: data[CapabilitiesOffset.civAddr],
    commCap: readUInt16LE(data, TokenOffset.commCap)
  }
}

export function parseCIVFromSerial (data) {
  if (!data || data.length <= PacketSize.civHeader) return null
  if (data[CIVPacketOffset.cmd] !== 0xC1) return null
  const civLength = readUInt16LE(data, CIVPacketOffset.length)
  const civStart = CIVPacketOffset.data
  if (civStart + civLength > data.length) return null
  return data.slice(civStart, civStart + civLength)
}

export function parseRetransmitSeq (data) {
  if (!data || data.length < 18) return null
  return readUInt16LE(data, 0x10)
}

export function parsePing (data) {
  if (!data || data.length < PacketSize.ping) return null
  return {
    isRequest: data[PingOffset.request] === 0x00,
    dataA: readUInt16LE(data, PingOffset.dataA),
    dataB: readUInt16LE(data, PingOffset.dataB)
  }
}
