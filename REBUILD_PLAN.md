# PoloRigLite Rebuild Plan

## Context Summary

**PoloRig** (working) has a monolithic Swift native module (~2,700 LOC across 14 Swift files) that handles all RS-BA1 protocol, CI-V commands, CW keying, and sidetone. JavaScript is a thin wrapper.

**PoloRigLite** (to be rebuilt) inverts this: all protocol/keyer logic moves to JavaScript, with only a minimal ~80-line Swift "dumb pipe" UDP transport remaining. It also supports a second mode where even that Swift code is eliminated, replaced by a WebSocket transport that talks to an external Node.js UDP proxy server.

The existing PoloRigLite code was built from an older, non-working version of PoloRig. We'll discard it and rebuild from the current working PoloRig.

---

## Phase 1: Foundation - Fresh Copy from Working PoloRig

1. **Back up** existing PoloRigLite (rename to `PoloRigLite.bak` or archive)
2. **Copy** the entire working PoloRig directory to PoloRigLite
3. **Verify** the copy builds and runs identically to PoloRig (baseline sanity check)
4. **Rename** Xcode project/scheme/bundle identifiers so both apps can coexist on a device

---

## Phase 2: Build the JavaScript Protocol Stack

Port each Swift module to JavaScript, working bottom-up through the layers:

### Layer 0: Transport Abstraction
- Create `src/extensions/other/ic705/transport/TransportInterface.js` - abstract contract (`createSocket`, `send`, `close`, `onData`, `isAvailable`)
- Create `NativeUDPTransport.js` - wraps the minimal Swift module (base64 across bridge)
- Create `WebSocketTransport.js` - sends JSON `{action, id, host, port, data}` to proxy
- Create `transportConfig.js` - feature flag reads `settings.ic705.transport` (`'native'` | `'websocket'`)

### Layer 1: Framing & Encoding
- Port `PacketBuilder.swift` + `PacketDefinitions.swift` -> `protocol/RSBA1Protocol.js`
- Port credential cipher (95-byte ENCODE_KEY) -> `protocol/CredentialCodec.js`
- Port BCD codec + CI-V constants -> `protocol/CIVProtocol.js`
- Create `protocol/ByteUtils.js` - Uint8Array helpers, base64 encode/decode
- Create `protocol/EventEmitter.js` - minimal event system (no Node dependency)

### Layer 2: Connection State Machine
- Port `UDPBase.swift` + `UDPControl.swift` + `UDPSerial.swift` -> `protocol/ConnectionManager.js`
  - Auth handshake (discover -> login -> token -> capabilities)
  - Token renewal (60s), keepalive ping (3s)
  - CI-V command queue (one-at-a-time with ACK/NAK)
  - Connection timeout (10s via `setTimeout`)

### Layer 3: CW Keyer
- Port `CWTemplateEngine.swift` -> `keyer/CWTemplateEngine.js` ($variable interpolation)
- Port `CWKeyer.swift` -> `keyer/CWKeyer.js` ({MACRO} expansion, 30-char chunking, Morse pacing)
- Port `CWSidetone.swift` -> `keyer/CWSidetone.js` (Web Audio API, deferred/optional)

**Key principle:** Each JS module is a byte-accurate port of its Swift counterpart, verified against the working PoloRig behavior.

---

## Phase 3: Minimal Swift Native Module

Replace the 14-file Swift stack with a single minimal module:

1. **Delete** all existing RigControl Swift files (UDPBase, UDPControl, UDPSerial, CIVController, CIVConstants, CWKeyer, CWTemplateEngine, CWSidetone, PacketBuilder, PacketDefinitions, DebugTrace, DirectCWSender)
2. **Delete** `IC705RigControl.swift` (the monolithic bridge)
3. **Create** `UDPTransport.swift` (~80 lines) - exposes only:
   - `createSocket(id)` - creates an NWConnection UDP socket
   - `send(id, host, port, data)` - sends base64-decoded bytes
   - `close(id)` - tears down socket
   - Emits `onData(id, base64data)` events back to JS
4. **Create** `UDPTransportBridge.m` (~20 lines) - ObjC bridge macros
5. **Update** `AppDelegate.swift` - simplify lifecycle cleanup

**Result:** ~100 lines of Swift total, vs ~2,700 before.

---

## Phase 4: Wire Up the Application Layer

1. **Rewrite** `src/extensions/other/ic705/IC705RigControl.js` - orchestrator that:
   - Selects transport based on feature flag
   - Creates ConnectionManager with chosen transport
   - Exposes `connect()`, `disconnect()`, `sendCW()`, `setCWSpeed()`, `getStatus()`
   - Handles AppState changes (disconnect on background)
2. **Update** `IC705Extension.js` - same hook registration, now calls JS orchestrator
3. **Update** `IC705SettingsScreen.jsx` - add transport mode selector (Native UDP vs WebSocket Proxy), proxy URL field
4. **Update** `IC705StatusBar.jsx` - same UI, reads from JS state instead of native events
5. **Update** `defaults.js` - add `transport: 'native'` and `proxyUrl` defaults
6. **Verify** MainExchangePanel telegraph key button + callCommit hook still work

---

## Phase 5: WebSocket-to-UDP Proxy Server

**No proxy server currently exists in the project.** We need to create one:

1. **Create** `PoloRigLite/proxy/udp-proxy.js` (~50-80 lines Node.js):
   - WebSocket server (port 8765)
   - On `create` message: create a UDP socket (dgram)
   - On `send` message: decode base64, send UDP to IC-705
   - On UDP data received: encode base64, send back over WebSocket
   - On `close` message: destroy UDP socket
2. **Create** `PoloRigLite/proxy/package.json` - dependencies: `ws` only
3. **Add** startup script: `npm run proxy` or `node proxy/udp-proxy.js`
4. **Document** usage: run on a Mac/Linux machine on the same network as the IC-705

This is a ~50-line "dumb pipe" - no protocol awareness, just relays bytes.

---

## Phase 6: Testing

1. **Write Jest tests** for every JS protocol module (target: ~140+ tests):
   - ByteUtils, CredentialCodec, RSBA1Protocol, CIVProtocol
   - ConnectionManager (with MockTransport)
   - CWKeyer, CWTemplateEngine
   - IC705RigControl, IC705Extension
2. **Test native mode** on iOS simulator + real device with IC-705
3. **Test WebSocket mode** with proxy running on Mac, app connecting via WebSocket
4. **Verify** CW-on-QRZ-miss flow end-to-end in both modes
5. **Verify** manual telegraph key button in both modes

---

## Phase 7: Cleanup & Documentation

1. **Remove** any remaining dead Swift code or unused ObjC bridges
2. **Update** Xcode project file to remove deleted Swift file references
3. **Update** README.md, ARCHITECTURE.md with new layer diagram
4. **Update** PLAN.md / TODO.md to reflect completed state

---

## Execution Order & Dependencies

```
Phase 1 (Foundation)
    |
Phase 2 (JS Protocol Stack) + Phase 5 (Proxy Server)  [parallel]
    |
Phase 3 (Minimal Swift)
    |
Phase 4 (Application Wiring)
    |
Phase 6 (Testing)
    |
Phase 7 (Cleanup)
```

Phases 2 and 5 can be done in parallel since they're independent. Phase 3 depends on Phase 2 (JS must be ready before removing Swift). Phase 4 wires everything together. Phase 6 validates.

---

## Requirement: Settings Persistence Parity with PoloRig

PoloRigLite must use the **same persistence mechanisms** as PoloRig so that user-entered settings survive app relaunches and rebuilds without re-entry.

### What PoloRig persists and how

All settings use **Redux (settingsSlice) + redux-persist + AsyncStorage**. AsyncStorage is keyed by app bundle identifier, so both apps can coexist with independent stores, but both use the same architecture.

| Setting | Redux path | Default source |
|---------|-----------|----------------|
| Operator callsign | `settings.operatorCall` | Empty string |
| QRZ login | `settings.accounts.qrz.login` | User-entered |
| QRZ password | `settings.accounts.qrz.password` | User-entered |
| IC-705 IP (Home LAN) | `settings.ic705.homeLAN.radioIPAddress` | `.env` `IC705_HOME_IP_ADDRESS` |
| IC-705 username (Home) | `settings.ic705.homeLAN.username` | `.env` `IC705_HOME_USERNAME` |
| IC-705 password (Home) | `settings.ic705.homeLAN.password` | `.env` `IC705_HOME_PASSWORD` |
| IC-705 IP (Field AP) | `settings.ic705.fieldAP.radioIPAddress` | `.env` or `192.168.59.1` |
| IC-705 username (Field) | `settings.ic705.fieldAP.username` | `.env` `IC705_FIELD_USERNAME` |
| IC-705 password (Field) | `settings.ic705.fieldAP.password` | `.env` `IC705_FIELD_PASSWORD` |
| WiFi mode | `settings.ic705.wifiMode` | `.env` or `homeLAN` |
| Location grid | `operation.grid` | Generated from GPS per-operation |
| Grid precision (6/8) | `settings.useGrid8` | `false` (6-digit default) |
| CW template | `settings.ic705.cwTemplate` | `$callsign?` |
| Auto CW on miss | `settings.ic705.autoSendCWOnMiss` | `true` |
| Sidetone | `settings.ic705.sidetoneEnabled` | `true` |

### What PoloRigLite must match

1. **Redux store with redux-persist to AsyncStorage** — already in place via shared POLO fork
2. **settingsSlice.js** — must apply `withIC705Defaults()` on every settings update and in `selectSettings`, matching PoloRig's `normalizeSettingsState()` pattern so credentials are never lost during merges
3. **defaults.js `withIC705Defaults()`** — must preserve username/password through `envString()` fallback (PoloRig does this; PoloRigLite's version currently drops credentials during merge)
4. **IC705SettingsScreen.jsx** — both WiFi modes (Home LAN / Field AP) with IP, username, password fields
5. **`.env` file** — build-time defaults for IC-705 credentials so they survive clean installs during development
6. **Transport selector** — PoloRigLite adds `settings.ic705.transport` (`'native'` | `'websocket'`) and `settings.ic705.proxyUrl` for the WebSocket proxy mode

### Files to update

- `src/extensions/other/ic705/defaults.js` — sync `withIC705Defaults()` with PoloRig's credential-preserving version
- `src/store/settings/settingsSlice.js` — apply `withIC705Defaults()` in `setSettings`, `mergeSettings`, and `selectSettings` (match PoloRig)
- `.env` — ensure IC-705 dev credentials are populated so rebuilds don't lose them

---

## Risk Areas

- **Credential cipher accuracy** - the 95-byte ENCODE_KEY position-dependent cipher must be ported byte-for-byte or auth will fail
- **CI-V BCD encoding** - frequency/speed encoding must match exactly
- **Timing** - token renewal (60s), keepalive ping (3s), connection timeout (10s) must be accurate or the radio drops the connection
- **30-char CW chunking** - must match Swift's chunking behavior or radio will reject oversized CI-V commands
- **React Native bridge base64** - data crossing the JS/native boundary needs consistent encoding

---

## Key File Paths (PoloRig Source - Working Reference)

### Swift Files
- `ios/polorig/IC705RigControl.swift` (~400 LOC, bridge/orchestrator)
- `ios/polorig/RigControl/UDPBase.swift` (~350 LOC, base socket)
- `ios/polorig/RigControl/UDPControl.swift` (~600 LOC, auth/token)
- `ios/polorig/RigControl/UDPSerial.swift` (~300 LOC, CI-V queue)
- `ios/polorig/RigControl/CIVController.swift` (~250 LOC, CI-V commands)
- `ios/polorig/RigControl/CIVConstants.swift` (~200 LOC, constants/BCD)
- `ios/polorig/RigControl/CWKeyer.swift` (~200 LOC, macro/chunking)
- `ios/polorig/RigControl/CWTemplateEngine.swift` (~100 LOC, $variable)
- `ios/polorig/RigControl/CWSidetone.swift` (~150 LOC, audio)
- `ios/polorig/RigControl/PacketBuilder.swift` (~150 LOC, packet construction)
- `ios/polorig/RigControl/PacketDefinitions.swift` (~100 LOC, RS-BA1 constants)
- `ios/polorig/RigControl/DebugTrace.swift` (~50 LOC, logging)
- `ios/polorig/RigControl/DirectCWSender.swift` (~150 LOC, one-shot CW)

### JavaScript Files
- `src/native/IC705RigControl.js` (thin native wrapper)
- `src/extensions/other/ic705/IC705Extension.js` (extension + callCommit hook)
- `src/extensions/other/ic705/IC705SettingsScreen.jsx` (settings UI)
- `src/extensions/other/ic705/IC705StatusBar.jsx` (status display)
- `src/extensions/other/ic705/defaults.js` (env-based defaults)
- `src/extensions/other/ic705/interpolateCWTemplate.js` ($variable interpolation)
- `src/extensions/other/ic705/trace.js` (UI-side logging)
- `src/screens/OperationScreens/OpLoggingTab/components/LoggingPanel/MainExchangePanel.jsx` (telegraph key + callBlur)
