import {
  controlPacket, areYouThere, areYouReady, disconnectPacket, idle,
  pingPacket, pongReply,
  loginPacket, tokenAcknowledge, tokenRenew, tokenRemove,
  connInfoPacket, openClosePacket, civPacket,
  parsePacketType, parsePacketHeader, parseTokenFields,
  parseCapabilities, parseCIVFromSerial, parseRetransmitSeq, parsePing,
  PacketSize, PacketType, ControlOffset, TokenOffset, TokenCode, TokenRes,
  CapabilitiesOffset
} from '../protocol/RSBA1Protocol'
import { readUInt16LE, readUInt32LE, readUInt32BE } from '../protocol/ByteUtils'

describe('RSBA1Protocol', () => {
  const SEND_ID = 0x12345678
  const RECV_ID = 0xABCDEF01

  describe('controlPacket', () => {
    it('creates a 16-byte packet', () => {
      const pkt = controlPacket(PacketType.areYouThere, 0, SEND_ID, 0)
      expect(pkt.length).toBe(PacketSize.control)
      expect(readUInt32LE(pkt, ControlOffset.length)).toBe(PacketSize.control)
      expect(readUInt16LE(pkt, ControlOffset.type)).toBe(PacketType.areYouThere)
      expect(readUInt32LE(pkt, ControlOffset.sendId)).toBe(SEND_ID)
    })
  })

  describe('areYouThere', () => {
    it('sets type and sendId, recvId=0', () => {
      const pkt = areYouThere(SEND_ID)
      expect(readUInt16LE(pkt, ControlOffset.type)).toBe(PacketType.areYouThere)
      expect(readUInt32LE(pkt, ControlOffset.sendId)).toBe(SEND_ID)
      expect(readUInt32LE(pkt, ControlOffset.recvId)).toBe(0)
    })
  })

  describe('pingPacket', () => {
    it('creates a 21-byte packet', () => {
      const pkt = pingPacket(5, SEND_ID, RECV_ID, false, 0x1234, 0x5678)
      expect(pkt.length).toBe(PacketSize.ping)
      expect(pkt[0x10]).toBe(0x00) // request
      expect(readUInt16LE(pkt, 0x11)).toBe(0x1234)
      expect(readUInt16LE(pkt, 0x13)).toBe(0x5678)
    })
  })

  describe('pongReply', () => {
    it('swaps IDs and sets reply flag', () => {
      const ping = pingPacket(5, RECV_ID, SEND_ID, false, 0x1111, 0x2222)
      const pong = pongReply(ping, SEND_ID, RECV_ID)
      expect(readUInt32LE(pong, ControlOffset.sendId)).toBe(SEND_ID)
      expect(readUInt32LE(pong, ControlOffset.recvId)).toBe(RECV_ID)
      expect(pong[0x10]).toBe(0x01) // reply flag
    })
  })

  describe('loginPacket', () => {
    it('creates a 128-byte packet with encoded credentials', () => {
      const pkt = loginPacket(1, SEND_ID, RECV_ID, 2, 0x1234, 'admin', 'pass', 'iPhone')
      expect(pkt.length).toBe(PacketSize.login)
      expect(readUInt16LE(pkt, TokenOffset.code)).toBe(TokenCode.loginRequest)
      // Credentials should not be plaintext
      expect(pkt[0x40]).not.toBe(0x61) // not 'a' in plaintext
    })
  })

  describe('tokenAcknowledge', () => {
    it('creates a 64-byte token ack packet', () => {
      const pkt = tokenAcknowledge(1, SEND_ID, RECV_ID, 3, 0x1234, 0xDEAD)
      expect(pkt.length).toBe(PacketSize.token)
      expect(readUInt16LE(pkt, TokenOffset.code)).toBe(TokenCode.tokenAck)
      expect(readUInt16LE(pkt, TokenOffset.res)).toBe(TokenRes.ack)
      expect(readUInt32LE(pkt, TokenOffset.token)).toBe(0xDEAD)
    })
  })

  describe('tokenRenew', () => {
    it('uses renew res value', () => {
      const pkt = tokenRenew(1, SEND_ID, RECV_ID, 3, 0x1234, 0xBEEF)
      expect(readUInt16LE(pkt, TokenOffset.res)).toBe(TokenRes.renew)
    })
  })

  describe('tokenRemove', () => {
    it('uses remove res value', () => {
      const pkt = tokenRemove(1, SEND_ID, RECV_ID, 3, 0x1234, 0xBEEF)
      expect(readUInt16LE(pkt, TokenOffset.res)).toBe(TokenRes.remove)
    })
  })

  describe('connInfoPacket', () => {
    it('creates a 144-byte packet with audio settings', () => {
      const mac = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06])
      const pkt = connInfoPacket(1, SEND_ID, RECV_ID, 4, 0x1234, 0xBEEF, 0x0001, mac, 'IC-705', 'admin', 50002, 50003)
      expect(pkt.length).toBe(PacketSize.connInfo)
      expect(readUInt16LE(pkt, TokenOffset.code)).toBe(TokenCode.connInfoFromHost)
      expect(pkt[0x70]).toBe(0x01) // enableRx
      expect(pkt[0x71]).toBe(0x01) // enableTx
      expect(readUInt32BE(pkt, 0x7C)).toBe(50002) // civPort
      expect(readUInt32BE(pkt, 0x80)).toBe(50003) // audioPort
    })
  })

  describe('openClosePacket', () => {
    it('creates a 22-byte packet', () => {
      const pkt = openClosePacket(1, SEND_ID, RECV_ID, 1, true)
      expect(pkt.length).toBe(PacketSize.openClose)
      expect(pkt[0x10]).toBe(0xC0) // cmd
      expect(pkt[0x15]).toBe(0x04) // open
    })

    it('sets close flag', () => {
      const pkt = openClosePacket(1, SEND_ID, RECV_ID, 1, false)
      expect(pkt[0x15]).toBe(0x00) // close
    })
  })

  describe('civPacket', () => {
    it('wraps CI-V data in RS-BA1 envelope', () => {
      const civ = new Uint8Array([0xFE, 0xFE, 0xA4, 0xE0, 0x03, 0xFD])
      const pkt = civPacket(5, SEND_ID, RECV_ID, 3, civ)
      expect(pkt.length).toBe(PacketSize.civHeader + civ.length)
      expect(pkt[0x10]).toBe(0xC1) // CI-V marker
      expect(readUInt16LE(pkt, 0x11)).toBe(civ.length)
      // CI-V data starts at 0x15
      expect(pkt[0x15]).toBe(0xFE)
      expect(pkt[0x16]).toBe(0xFE)
    })
  })

  describe('parsers', () => {
    it('parsePacketType', () => {
      const pkt = areYouThere(SEND_ID)
      expect(parsePacketType(pkt)).toBe(PacketType.areYouThere)
    })

    it('parsePacketHeader', () => {
      const pkt = areYouReady(5, SEND_ID, RECV_ID)
      const header = parsePacketHeader(pkt)
      expect(header.type).toBe(PacketType.areYouReady)
      expect(header.sequence).toBe(5)
      expect(header.sendId).toBe(SEND_ID)
      expect(header.recvId).toBe(RECV_ID)
    })

    it('parseTokenFields', () => {
      const pkt = tokenAcknowledge(3, SEND_ID, RECV_ID, 7, 0x5678, 0xDEAD)
      const fields = parseTokenFields(pkt)
      expect(fields.code).toBe(TokenCode.tokenAck)
      expect(fields.res).toBe(TokenRes.ack)
      expect(fields.innerSeq).toBe(3)
      expect(fields.tokReq).toBe(0x5678)
      expect(fields.token).toBe(0xDEAD)
    })

    it('parseCIVFromSerial extracts CI-V data', () => {
      const civ = new Uint8Array([0xFE, 0xFE, 0xA4, 0xE0, 0x03, 0xFD])
      const pkt = civPacket(5, SEND_ID, RECV_ID, 3, civ)
      const extracted = parseCIVFromSerial(pkt)
      expect(Array.from(extracted)).toEqual(Array.from(civ))
    })

    it('parseCIVFromSerial returns null for non-CIV packet', () => {
      const pkt = idle(1, SEND_ID, RECV_ID)
      expect(parseCIVFromSerial(pkt)).toBeNull()
    })

    it('parsePing', () => {
      const pkt = pingPacket(1, SEND_ID, RECV_ID, false, 0xAAAA, 0xBBBB)
      const parsed = parsePing(pkt)
      expect(parsed.isRequest).toBe(true)
      expect(parsed.dataA).toBe(0xAAAA)
      expect(parsed.dataB).toBe(0xBBBB)
    })

    it('returns null for too-short data', () => {
      expect(parsePacketType(new Uint8Array(4))).toBeNull()
      expect(parsePacketHeader(null)).toBeNull()
      expect(parseTokenFields(new Uint8Array(10))).toBeNull()
    })
  })
})
