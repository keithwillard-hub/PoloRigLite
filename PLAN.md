# PoloRigLite - Implementation Plan

## Context

PoloRig currently uses a monolithic Swift native module (~1,100 lines across 12 files) that contains ALL IC-705 rig control logic: RS-BA1 UDP protocol, CI-V commands, CW keyer, template engine, and sidetone. The JavaScript side is just a thin wrapper calling native methods.

**PoloRigLite inverts this:** move all protocol/keyer/template logic into JavaScript modules, leaving only a minimal "dumb pipe" UDP transport in native code. This makes the protocol stack testable with Jest, portable across platforms, and dramatically reduces the native surface area.

Additionally, PoloRigLite supports **two interchangeable UDP transports** behind a feature flag:
1. **Native module** (default) - thin Swift `NWConnection` wrapper, runs in-process
2. **WebSocket-to-UDP proxy** - Node.js server, enables browser/desktop use

---

## Architecture

```
Current PoloRig:
  JS (thin wrapper) --> Swift native module (ALL logic) --> UDP

PoloRigLite:
  JS (ALL logic) --> Transport interface --> Native UDP module (default)
                                         \-> WebSocket proxy (alternate)
```

### Protocol Layer Diagram

```
Layer 4: CW Application (JS)
  IC705RigControl.js (orchestrator)
  keyer/CWKeyer.js, CWTemplateEngine.js, CWSidetone.js

Layer 3: CI-V Protocol (JS)
  protocol/CIVProtocol.js (frame build/parse, BCD codec)

Layer 2: RS-BA1 Protocol (JS)
  protocol/RSBA1Protocol.js (packet construction)
  protocol/ConnectionManager.js (auth state machine, token, keepalive)
  protocol/CredentialCodec.js (login cipher)

Layer 1: Transport Interface (JS)
  transport/TransportInterface.js (abstract contract)
  transport/NativeUDPTransport.js (wraps Swift module)
  transport/WebSocketTransport.js (wraps WS-to-UDP proxy)

Layer 0: Native / External
  ios/polorig/UDPTransport.swift (~80 lines, send/receive only)
  proxy/udp-proxy.js (~50 lines Node.js server)
```

---

## Folder Structure

```
iphone_dev/PoloRigLite/
  PLAN.md                              <-- this file
  (full POLO app fork from PoloRig)

  src/extensions/other/ic705/
    IC705Extension.js                  (updated imports)
    IC705RigControl.js                 (NEW orchestrator, replaces native wrapper)
    IC705SettingsScreen.jsx            (unchanged from PoloRig)
    IC705StatusBar.jsx                 (unchanged from PoloRig)

    protocol/
      ByteUtils.js                     (Uint8Array read/write helpers)
      CredentialCodec.js               (RS-BA1 login cipher)
      RSBA1Protocol.js                 (packet construction + parsing)
      CIVProtocol.js                   (CI-V frames, BCD codec, constants)
      ConnectionManager.js             (auth state machine, CI-V queue, keepalive)

    keyer/
      CWTemplateEngine.js              ($variable interpolation)
      CWKeyer.js                       (macro expansion, chunking, pacing)
      CWSidetone.js                    (Morse audio feedback)

    transport/
      TransportInterface.js            (abstract contract both transports implement)
      NativeUDPTransport.js            (wraps native module via NativeModules)
      WebSocketTransport.js            (wraps WebSocket connection to proxy)
      transportConfig.js               (feature flag: which transport to use)

    __tests__/
      ByteUtils.test.js
      CredentialCodec.test.js
      RSBA1Protocol.test.js
      CIVProtocol.test.js
      ConnectionManager.test.js
      CWTemplateEngine.test.js
      CWKeyer.test.js

  ios/polorig/
    UDPTransport.swift                 (NEW ~80 lines, replaces fat native module)
    UDPTransportBridge.m               (NEW ~20 lines ObjC bridge)
    (DELETE: IC705RigControl.swift, IC705RigControlBridge.m, RigControl/*.swift)

  proxy/
    udp-proxy.js                       (NEW ~50 lines Node.js WebSocket-to-UDP bridge)
    package.json                       (minimal: ws dependency only)
    README.md                          (usage instructions)
```

---

## Transport Interface

Both transports implement the same contract:

```javascript
// transport/TransportInterface.js
class TransportInterface {
  async createSocket(id) {}           // create named socket
  async send(id, host, port, data) {} // send Uint8Array
  async close(id) {}                  // close socket
  onData(callback) {}                 // register: (id, Uint8Array) => void
  get isAvailable() {}                // can this transport be used?
}
```

### Feature Flag

```javascript
// transport/transportConfig.js
import { NativeUDPTransport } from './NativeUDPTransport'
import { WebSocketTransport } from './WebSocketTransport'

const TRANSPORT = 'native' // 'native' | 'websocket'

export function getTransport(settings) {
  const mode = settings?.ic705?.transport || TRANSPORT
  if (mode === 'websocket') return new WebSocketTransport(settings.ic705.proxyUrl)
  return new NativeUDPTransport()
}
```

The transport choice is exposed as a setting in `IC705Extension.js` so users can switch without rebuilding.

---

## Module Details

### ByteUtils.js
- `readUInt16LE/BE`, `writeUInt16LE/BE`, `readUInt32LE/BE`, `writeUInt32LE/BE`
- `toBase64(Uint8Array)`, `fromBase64(string)` using project's existing `base64-js`
- `allocate(size)` - zero-filled Uint8Array
- Source reference: `PacketBuilder.swift` Data extensions

### CredentialCodec.js
- `encodeCredential(string)` -> 16-byte Uint8Array
- Position-dependent substitution using 95-byte ENCODE_KEY constant
- Source reference: `PacketDefinitions.swift` CredentialCodec enum

### CIVProtocol.js
- Constants: addresses (0xA4, 0xE0), commands (0x03-0x17), modes, ACK/NAK
- `buildFrame(command, subCommand, data)` -> Uint8Array
- BCD codec: `parseFrequencyHz(bytes)`, `frequencyToBytes(hz)`
- CW speed: `wpmToValue(wpm)` -> [high, low] BCD bytes
- Response parser: `parseCIVResponse(data)` -> { command, payload, isAck, isNak }
- Convenience builders: `buildReadFrequency()`, `buildSendCW(text)`, `buildSetCWSpeed(wpm)`, etc.
- Source reference: `CIVConstants.swift`, `CIVController.swift`

### RSBA1Protocol.js
- All packet builders: controlPacket, areYouThere, login, tokenAck, connInfo, civPacket, etc.
- All packet parsers: parsePacketType, parseLoginResponse, parseCapabilities, parseCIVFromSerial
- Constants: packet sizes, offsets, type codes, timing values
- Source reference: `PacketBuilder.swift`, `PacketDefinitions.swift`

### ConnectionManager.js
- `EventEmitter` subclass managing two UDP sockets (control:50001, serial:50002)
- Full RS-BA1 auth state machine: handshake -> login -> token -> capabilities -> connInfo
- CI-V command queue: one-at-a-time, 3s timeout, ACK/NAK handling
- Timers: ping (3s), idle (1s), token renewal (60s), resend (5s)
- Events: `connectionStateChanged`, `frequencyChanged`, `modeChanged`, `cwSpeedChanged`, `civData`
- Constructor takes a `TransportInterface` instance (injectable for testing)
- Source reference: `UDPBase.swift`, `UDPControl.swift`, `UDPSerial.swift`

### CWTemplateEngine.js
- `interpolate(template, variables)` - $variable substitution, uppercase output
- `standardVariables(callsign, myCallsign, frequencyHz, mode, name)`
- Source reference: `CWTemplateEngine.swift`

### CWKeyer.js
- `EventEmitter` subclass with send buffer, macro expansion, chunking
- Macros: {CALL}, {MYCALL}, {SERIAL}, {CUT}, {RST}, {FREQ}, {SPEED:n}, {DELAY:n}
- 30-char chunk splitting with paced `setTimeout` delivery
- MorseTiming: element counts table, `estimateDuration(text, wpm)` with 12% safety margin
- Events: `sendingStarted`, `sendingEnded`, `chunkSent`
- Source reference: `CWKeyer.swift`

### CWSidetone.js
- Morse audio playback using `react-native-audio-api` (OscillatorNode + GainNode)
- 600Hz default pitch, 5ms fade envelope
- Can be deferred to a later phase if audio dependency is problematic
- Source reference: `CWSidetone.swift`

### IC705RigControl.js (Orchestrator)
- Instantiates ConnectionManager, CWKeyer, CWSidetone, wires callbacks
- **Same public API** as current `src/native/IC705RigControl.js`:
  - `connect(host, user, pass)`, `disconnect()`, `sendCW(text)`, `sendTemplatedCW(template, vars)`
  - `setCWSpeed(wpm)`, `cancelCW()`, `getStatus()`
  - Event subscriptions: `onConnectionStateChanged(cb)`, `onFrequencyChanged(cb)`, etc.
- UI components (`useIC705.js`, settings screen, status bar) need only import path changes

---

## Native Module: UDPTransport.swift (~80 lines)

```swift
@objc(UDPTransport)
class UDPTransport: RCTEventEmitter {
    private var sockets: [String: NWConnection] = [:]

    @objc func createSocket(_ id: String) { ... }
    @objc func send(_ id: String, host: String, port: Int,
                    base64Data: String, resolve: ..., reject: ...) { ... }
    @objc func close(_ id: String) { ... }

    // Emits "onUDPData" -> { id: String, data: String(base64) }
}
```

No protocol knowledge. Just bytes in, bytes out.

---

## WebSocket-to-UDP Proxy: proxy/udp-proxy.js (~50 lines)

```javascript
// Node.js server: WebSocket <-> UDP relay
// Usage: node udp-proxy.js [--port 8765]
// Client sends: { action: 'create'|'send'|'close', id, host, port, data(base64) }
// Server sends: { id, data(base64) }
```

Uses Node.js `dgram` for UDP and `ws` package for WebSocket. Pure byte relay, no protocol awareness.

---

## Implementation Order

### Phase 1: Setup + Pure Logic (no native changes)
1. Fork PoloRig into `iphone_dev/PoloRigLite/`
2. `ByteUtils.js` + tests
3. `CWTemplateEngine.js` + tests (trivial port, validates approach)
4. `CredentialCodec.js` + tests
5. `CIVProtocol.js` + tests (BCD codec, frame building)
6. `CWKeyer.js` + tests (macro expansion, chunking, pacing)

### Phase 2: Protocol Layer
7. `RSBA1Protocol.js` + tests (packet construction/parsing)
8. `TransportInterface.js` (abstract contract)
9. `ConnectionManager.js` + tests (uses MockTransport in tests)

### Phase 3: Transport Implementations
10. `UDPTransport.swift` + `UDPTransportBridge.m` (native module)
11. `NativeUDPTransport.js` (JS wrapper)
12. `proxy/udp-proxy.js` (Node.js WebSocket-to-UDP bridge)
13. `WebSocketTransport.js` (JS wrapper)
14. `transportConfig.js` (feature flag + settings integration)

### Phase 4: Integration + Wiring
15. `IC705RigControl.js` (new orchestrator)
16. Update `IC705Extension.js` to use JS-based orchestrator
17. Update `useIC705.js` import path
18. Add transport selector to settings screen
19. `CWSidetone.js` (can be deferred)

### Phase 5: Cleanup
20. Delete old Swift files: `IC705RigControl.swift`, `IC705RigControlBridge.m`, `RigControl/*.swift`
21. Delete old `src/native/IC705RigControl.js`
22. Delete old Swift test files (replaced by Jest)

---

## Testing Strategy

### Cross-Validation
Port Swift test cases to Jest with identical input/output data. For example:
- `CIV.Frequency.parseHz([0x00, 0x00, 0x06, 0x40, 0x01])` = `14060000` in both Swift and JS
- Credential encoding with known username/password pairs
- Packet construction byte-for-byte comparison

### Test Infrastructure
- Pure logic modules (Phase 1-2): standard Jest, no mocking needed
- ConnectionManager: inject `MockTransport` that captures sends and allows injecting receives
- CWSidetone: mock audio API, verify timing/frequency parameters
- Jest config already uses `react-native` preset in POLO

### End-to-End Verification
1. Build the app in Xcode with the new native module
2. Connect to IC-705 over WiFi using native transport (default)
3. Verify: connection, frequency display, CW sending, speed changes
4. Switch to WebSocket transport in settings
5. Start proxy: `cd proxy && node udp-proxy.js`
6. Verify same operations work through the proxy
7. Run `npx jest src/extensions/other/ic705/` for all unit tests

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Full POLO fork (not modules-only) | User wants a runnable app to trial the approach |
| Both transports with feature flag | Native for reliability, WebSocket for portability |
| Native module as default | In-process, lower latency, no external process to manage |
| Transport as constructor param | Enables mock injection for ConnectionManager tests |
| Same public API surface | Minimizes changes to UI components and extension hooks |
| base64 for native bridge data | Uint8Array can't cross RN bridge; RS-BA1 packets are tiny (16-168 bytes) |
| Settings via POLO Redux store | Replaces Swift UserDefaults; consistent with all other extensions |
| CWSidetone deferred | Audio dependency adds complexity; can be added last or kept native |
