# PoloRigLite Architecture

## Overview

PoloRigLite is a React Native ham radio logging application forked from [Ham2K POLO](https://github.com/ham2k/app-polo) with integrated IC-705 rig control via WiFi. The key architectural decision is a **JavaScript-first protocol stack** — all IC-705 communication logic (RS-BA1 authentication, CI-V command framing, CW keying, template interpolation) runs in JS, backed by a minimal native UDP transport (~80 lines of Swift). This inverts the "fat native module" pattern used by PoloRig, making the protocol stack fully testable with Jest and portable across transports.

### Design Principle: Dual Transport

PoloRigLite supports two transports, selected at runtime via settings:

| Transport | Use Case | Mechanism |
|-----------|----------|-----------|
| **NativeUDPTransport** (default) | iOS device | Swift native module, base64 over RN bridge |
| **WebSocketTransport** | Browser / desktop dev | Node.js proxy relays WebSocket to UDP |

Both implement `TransportInterface`, so the entire protocol stack is transport-agnostic.

---

## Module Map

```
src/extensions/other/ic705/
|
|-- IC705Extension.js            Extension bootstrap + callCommit hook
|-- IC705RigControl.js           Orchestrator (public API singleton)
|-- IC705SettingsScreen.jsx      Settings UI (WiFi, CW, sidetone)
|-- IC705StatusBar.jsx           Compact rig status in logging panel
|
|-- protocol/
|   |-- RSBA1Protocol.js         RS-BA1 packet construction & parsing
|   |-- CIVProtocol.js           CI-V frame builders, BCD codecs, constants
|   |-- ConnectionManager.js     Auth state machine, CI-V queue, keepalive
|   |-- CredentialCodec.js       Position-dependent login cipher
|   |-- EventEmitter.js          Minimal on/off/emit (no Node dependency)
|   +-- ByteUtils.js             Uint8Array LE/BE read/write, base64
|
|-- keyer/
|   |-- CWKeyer.js               Macro expansion, 30-char chunking, pacing
|   |-- CWTemplateEngine.js      $variable interpolation (pure, stateless)
|   +-- CWSidetone.js            Morse audio sidetone (Web Audio, deferred)
|
|-- transport/
|   |-- TransportInterface.js    Abstract contract + MockTransport
|   |-- NativeUDPTransport.js    iOS Swift binding (base64 bridge)
|   |-- WebSocketTransport.js    Node.js WebSocket-to-UDP proxy client
|   +-- transportConfig.js       Feature flag: select transport by settings
|
+-- __tests__/                   141 Jest tests across 9 test files
```

Supporting files outside the extension:

| File | Purpose |
|------|---------|
| `src/hooks/useIC705.js` | React hook — subscribes to IC705 events, exposes state + methods |
| `src/store/settings/` | Redux slice — persists `ic705` config to AsyncStorage |
| `src/extensions/registry.js` | Plugin system — `registerHook()` / `findHooks()` |
| `assets/telegraph-key.png` | Telegraph key icon for ad-hoc CW send button |

---

## Layer Architecture

The system is organized into five layers, each depending only on the layer below:

```
Layer 4  Application    IC705Extension, IC705RigControl, SettingsScreen, StatusBar
Layer 3  Keyer          CWKeyer, CWTemplateEngine, CWSidetone
Layer 2  Protocol       ConnectionManager (state machine + CI-V queue)
Layer 1  Framing        RSBA1Protocol, CIVProtocol, CredentialCodec, ByteUtils
Layer 0  Transport      NativeUDPTransport | WebSocketTransport | MockTransport
```

### Layer 0: Transport

The transport abstraction defines four operations:

```js
createSocket(id)              // 'control' or 'serial'
send(id, host, port, data)    // Uint8Array out
close(id)                     // Cleanup
onData(callback)              // (socketId, Uint8Array) in
```

**NativeUDPTransport** wraps a Swift native module via `NativeModules.UDPTransport`. Data crosses the RN bridge as base64 strings, decoded with `ByteUtils.fromBase64()`.

**WebSocketTransport** sends JSON messages `{ action, id, host, port, data }` to a Node.js proxy server (`proxy/udp-proxy.js`) that creates real `dgram` UDP sockets.

**MockTransport** records sent packets and provides `injectData()` for testing — no network required.

### Layer 1: Framing (RSBA1 + CI-V)

**CI-V** is Icom's binary serial protocol for radio control. Every frame follows:

```
FE FE <dest> <src> <cmd> [sub] [payload...] FD
```

`CIVProtocol.js` provides frame builders (`buildSendCW`, `buildSetCWSpeed`, `buildReadFrequency`) and a response parser. Frequency is encoded as 5 BCD bytes (LSB first); CW speed maps linearly from 6-48 WPM to a 0-255 BCD value.

**RS-BA1** is Icom's WiFi gateway protocol. It wraps CI-V inside UDP packets with authentication, token management, keepalive, and retransmit. Two UDP sockets are used:

| Socket | Port | Purpose |
|--------|------|---------|
| Control | 50001 | Auth handshake, token lifecycle, ping/pong |
| Serial | 50002 | CI-V command queue, radio data responses |

`RSBA1Protocol.js` builds and parses all packet types: `areYouThere`, `iAmHere`, `areYouReady`, `login`, `tokenAcknowledge`, `tokenRenew`, `connInfo`, `civPacket`, `ping`, `disconnect`.

`CredentialCodec.js` encodes login credentials using a position-dependent substitution cipher (hardcoded 95-entry lookup table from Icom's spec).

### Layer 2: Protocol (ConnectionManager)

`ConnectionManager` is the central state machine (~715 lines). It manages:

**Connection States:**
```
disconnected --> connecting --> authenticating --> connected
     ^                                               |
     +-----------------------------------------------+
                    disconnect / timeout / error
```

**Auth Handshake** (mirrors `UDPBase.swift` from PoloRig):
1. Send `areYouThere` on control socket
2. Receive `iAmHere` → store radio's send ID
3. Exchange `areYouReady` → enter authenticating
4. Send login with encoded credentials
5. Receive login response with token
6. Send token acknowledge, receive capabilities (radio name, CI-V address, MAC)
7. Send connection info (ports, codecs)
8. Start control keepalive (ping every 3s, token renew every 60s)
9. Repeat handshake on serial socket
10. On serial ready → enter connected, auto-request frequency/mode/speed

**Connection Timeout:** A 10-second timer starts in `connect()`. If the state hasn't reached `connected` within 10s, it emits an `error` event and calls `disconnect()`. The timer is cleared on successful connection or explicit disconnect.

**CI-V Command Queue:** Commands are processed one-at-a-time with a 3-second response timeout. Each command is wrapped in an RS-BA1 `civPacket` envelope and sent over the serial socket. ACK/NAK/data responses complete the pending command and advance the queue.

**Retransmit Buffer:** The last 20 packets per socket are retained. When the radio requests a retransmit by sequence number, the stored packet is resent.

**Events Emitted:**
- `connectionStateChanged(state)` — UI state updates
- `frequencyChanged(hz, display)` — from CI-V frequency response
- `modeChanged(label)` — CW, USB, LSB, etc.
- `cwSpeedChanged(wpm)` — 6-48 WPM
- `radioNameChanged(name)` — from capabilities packet
- `error(Error)` — connection timeout, transport failure

### Layer 3: Keyer

**CWTemplateEngine** performs `$variable` interpolation — a pure, stateless string transform. Variables like `$callsign`, `$mycall`, `$rst` are replaced from a provided map. Unknown variables become empty strings. All output is uppercased for CW.

**CWKeyer** handles `{MACRO}` expansion and CW transmission pacing:

| Macro | Behavior |
|-------|----------|
| `{CALL}` | Substitute callsign |
| `{MYCALL}` | Substitute operator call |
| `{RST}` | Default RST for current mode |
| `{SERIAL}` | Auto-incrementing serial number (001, 002, ...) |
| `{CUT}` | Serial with cut numbers (0→T, 9→N) |
| `{SPEED:wpm}` | Change keying speed mid-message |
| `{DELAY:secs}` | Pause between segments |

The IC-705 CI-V `sendCW` command accepts at most 30 characters per frame. The keyer chunks longer messages and paces delivery using Morse duration estimation (element counts per character, adjusted for WPM + 12% safety margin).

**CWSidetone** generates local audio feedback via Web Audio API. Currently deferred (optional dependency `react-native-audio-api`).

### Layer 4: Application

**IC705RigControl** is the public API singleton. It wires the keyer and connection manager together:

```
keyer.on('sendCW') --> cm.flushQueue() + cm.sendCIV(buildSendCW(text))
keyer.on('setSpeed') --> cm.sendCIV(buildSetCWSpeed(wpm))
```

It also registers an `AppState` listener to auto-disconnect when the app goes to background or inactive — critical because the IC-705 only allows one WiFi client connection, and a dangling session locks out the radio.

**IC705Extension** registers with POLO's plugin system:
- A `setting` hook for the settings screen
- A `callCommit` hook for CW-on-miss behavior

The **callCommit hook** fires when the user commits a callsign (blur/Tab/Enter on the call field). If no lookup provider found a name for the callsign, it sends a CW query (default template: `$callsign?`). A module-level `Set` tracks sent calls to prevent duplicate sends within a QSO.

**MainExchangePanel** modifications:
- `handleCallBlur` dispatches to all registered `callCommit` hooks
- A telegraph key `Pressable` button appears next to the callsign input when IC705 is available and call length >= 3, allowing ad-hoc CW sends

**IC705SettingsScreen** provides per-WiFi-mode configuration (Home LAN vs Field AP), CW template editing, auto-send toggle, and sidetone toggle. Field AP defaults are `192.168.59.1` / `kew` / `qwerty12345`.

**IC705StatusBar** renders a compact inline display: `● 14.060 MHz CW 20wpm TX`

---

## Data Flow: Connect to Radio

```
SettingsScreen.handleConnect()
  --> useIC705().connect(ip, user, pass)
    --> IC705RigControl.connect()
      --> getInstance(settings)                  // lazy singleton
      --> cm = new ConnectionManager(transport)
      --> wire keyer events to cm
      --> register AppState listener
      --> cm.connect(host, user, pass)
        --> arm 10s connect timeout
        --> transport.createSocket('control')
        --> transport.createSocket('serial')
        --> send areYouThere on control
        --> [radio responds: iAmHere]
        --> send areYouReady
        --> [radio responds: areYouReady]
        --> send login(encoded credentials)
        --> [radio responds: loginResponse + token]
        --> send tokenAcknowledge
        --> [radio responds: capabilities]
        --> send connInfo, start pings/token renewal
        --> start serial handshake
        --> [serial ready]
        --> clear connect timeout
        --> setState(connected)
        --> requestFrequency, requestMode, requestCWSpeed
      --> resolve({ radioName })
    --> setConnectionState('connected')
  --> UI re-renders: "Disconnect" button, rig status
```

## Data Flow: CW-on-Miss

```
User types "W1AW" in call field, presses Tab
  --> MainExchangePanel.handleCallBlur()
    --> findHooks('callCommit')
    --> CWCallCommitHook.onCallCommit({ call, lookupStatus, settings })
      --> guard: isAvailable, autoSendCWOnMiss, call.length >= 3
      --> guard: lookupStatus has no name, not in cwSentCalls Set
      --> guard: IC705.getStatus() shows connected
      --> cwSentCalls.add('W1AW')
      --> IC705.sendTemplatedCW('$callsign?', { callsign: 'W1AW' })
        --> CWTemplateEngine.interpolate() --> 'W1AW?'
        --> CWKeyer.send([{ type: 'text', value: 'W1AW?' }], wpm)
          --> emit('sendCW', 'W1AW?')
          --> cm.flushQueue() + cm.sendCIV(buildSendCW('W1AW?'))
            --> RS-BA1 civPacket wrapping CI-V frame
            --> transport.send('serial', host, 50002, packet)
            --> [radio transmits Morse: .-- .---- .- .-- ..--..]
```

---

## How PoloRigLite Differs from PoloRig

| Aspect | PoloRig | PoloRigLite |
|--------|---------|-------------|
| **Protocol logic** | Swift native module (~2000 LOC across UDPBase, UDPControl, UDPSerial, CIVParser) | JavaScript (~1500 LOC in protocol/ + keyer/) |
| **Native code** | Full RS-BA1 + CI-V in Swift with NativeModules wrapper | Minimal UDP socket bridge (~80 lines Swift) |
| **Transport** | iOS-only (native UDP) | Pluggable: native UDP or WebSocket proxy |
| **Testability** | XCTest (requires Xcode, iOS simulator) | Jest (runs anywhere, 141 tests, <1s) |
| **CW hook** | `callCommit` via native module | `callCommit` via JS IC705RigControl |
| **App lifecycle** | AppDelegate.swift calls native disconnect | AppState listener in JS calls IC705.disconnect() |
| **Connection timeout** | `UDPBase.armConnectTimer()` (Swift) | `setTimeout` in `ConnectionManager.connect()` (JS) |
| **Platform support** | iOS only | iOS native + browser/desktop via WebSocket proxy |

### What PoloRigLite Preserves from PoloRig

- Same RS-BA1 packet formats and auth sequence
- Same CI-V command set and BCD codecs
- Same credential encoding algorithm
- Same CW template syntax (`$variable` + `{MACRO}`)
- Same `callCommit` hook semantics (dedup Set, retry on failure)
- Same telegraph key UI (Pressable + Image in MainExchangePanel)
- Same Field AP defaults (192.168.59.1, kew, qwerty12345)
- Same 10-second connection timeout behavior

---

## Redux Settings Schema

The `ic705` key in the settings store is persisted to AsyncStorage automatically:

```json
{
  "ic705": {
    "wifiMode": "homeLAN",
    "homeLAN": { "ip": "", "username": "", "password": "" },
    "fieldAP": { "ip": "192.168.59.1", "username": "kew", "password": "qwerty12345" },
    "cwTemplate": "$callsign?",
    "autoSendCWOnMiss": true,
    "sidetoneEnabled": true,
    "transport": "native",
    "proxyUrl": "ws://localhost:8765"
  }
}
```

---

## Test Suite

141 tests across 9 files, all runnable with `npx jest src/extensions/other/ic705/__tests__/`:

| Test File | Tests | Covers |
|-----------|-------|--------|
| CIVProtocol.test.js | ~40 | BCD codecs, frame builders, response parser |
| RSBA1Protocol.test.js | ~35 | Packet construction/parsing, token fields |
| ByteUtils.test.js | ~20 | LE/BE read/write, base64 |
| CredentialCodec.test.js | ~10 | Cipher round-trip |
| ConnectionManager.test.js | ~15 | State machine, handshake, queue, timeout |
| CWKeyer.test.js | ~25 | Macros, chunking, duration, serial numbers |
| CWTemplateEngine.test.js | ~15 | $variable interpolation |
| IC705RigControl.test.js | ~22 | Full lifecycle, keyer wiring, CW sending |
| IC705Extension.test.js | 6 | callCommit hook dedup, retry, guards |

All tests use `MockTransport` to simulate radio responses — no network or native code required.

---

## Line Counts

| Category | Files | Lines |
|----------|-------|-------|
| Protocol (layers 0-2) | 6 | ~1,200 |
| Keyer (layer 3) | 3 | ~450 |
| Transport (layer 0) | 4 | ~350 |
| Application (layer 4) | 5 | ~700 |
| Tests | 9 | ~800 |
| **Total** | **27** | **~3,500** |
