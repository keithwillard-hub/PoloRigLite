# IC-705 Rig Control Architecture

## Overview

The IC-705 Rig Control module provides WiFi-based remote control of Icom IC-705 transceivers via the RS-BA1 protocol. It supports frequency/mode display, CW keying, and real-time radio state synchronization.

## Architecture Layers

```
┌─────────────────────────────────────────────────────────────────┐
│                        UI Layer                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ IC705StatusBar│  │ IC705Settings │  │ RadioControl (QSO)   │  │
│  │   (display)   │  │   (config)    │  │   (freq/mode inputs) │  │
│  └──────┬────────┘  └──────┬────────┘  └──────────┬───────────┘  │
└─────────┼──────────────────┼─────────────────────┼────────────────┘
          │                  │                     │
          ▼                  ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      State Management                            │
│                         (Redux)                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  stationSlice: { vfo: { freq, band, mode, power } }       │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────┐
│                    React Hooks Layer                             │
│                    ┌──────────────┐                             │
│                    │   useIC705   │                             │
│                    └──────┬───────┘                             │
└───────────────────────────┼─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                 JS Orchestrator (IC705RigControl)                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │   Connection │  │    CWKeyer   │  │      Keyer/          │  │
│  │   Manager    │  │              │  │      Sidetone        │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │
│         │                 │                      │              │
│         └─────────────────┼──────────────────────┘              │
│                           │                                     │
│                           ▼                                     │
│         ┌─────────────────────────────────┐                     │
│         │      Operation Queue            │                     │
│         │  (serialized radio operations)  │                     │
│         └─────────────────────────────────┘                     │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Transport Layer                                │
│              ┌──────────────────────┐                          │
│              │    NativeUDPTransport │                          │
│              │    (Swift/Obj-C)      │                          │
│              └──────────┬────────────┘                          │
└─────────────────────────┼───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Network Layer                                  │
│           UDP Sockets (Ports 50001/50002)                       │
│              RS-BA1 Protocol (CI-V over IP)                     │
└─────────────────────────────────────────────────────────────────┘
```

## Component Details

### 1. UI Layer

**IC705StatusBar.jsx**
- Displays: connection status, frequency, mode, CW speed, TX indicator
- Dispatches `setVFO` to Redux when radio frequency changes
- Keeps QSO form fields in sync with radio

**IC705SettingsScreen.jsx**
- Configuration: WiFi mode (Home LAN/Field AP), credentials
- Connection control: Connect/Disconnect button
- CW template configuration

**RadioControl.jsx**
- QSO form integration for frequency/mode/band inputs
- Shows current VFO state from Redux

### 2. State Management (Redux)

**stationSlice.js**
```javascript
{
  vfo: {
    freq: number,      // Frequency in Hz
    band: string,      // '40m', '20m', etc.
    mode: string,      // 'CW', 'SSB', 'FM', etc.
    power: number      // Power in watts
  },
  transceiverState: object
}
```

### 3. React Hook: useIC705.js

Subscribes to IC705 events and provides current radio state:
- `frequency`, `frequencyDisplay`, `mode`, `cwSpeed`
- `isConnected`, `isSending`, `isBusy`
- Actions: `connect()`, `disconnect()`, `sendCW()`, `setCWSpeed()`

### 4. JS Orchestrator: IC705RigControl.js

Singleton facade that wires together:
- **ConnectionManager**: RS-BA1 protocol state machine
- **CWKeyer**: CW transmission with template interpolation
- **NativeUDPTransport**: Swift UDP socket wrapper

### 5. Protocol Stack

**ConnectionManager.js**
- RS-BA1 connection handshake (control port 50001)
- Serial port management (port 50002)
- CI-V command queue with timeouts
- Periodic frequency polling (1s interval)
- Event emission: `frequencyChanged`, `modeChanged`, `connectionStateChanged`

**RS-BA1Protocol.js**
- Packet parsing: `areYouThere`, `ping`, `pong`, `token`
- Token management for radio authentication

**CIVProtocol.js**
- CI-V frame building/parsing
- Commands: `readFrequency`, `readMode`, `sendCW`, `setCWSpeed`
- Frequency conversion between BCD and Hz

### 6. Transport Layer

**NativeUDPTransport (Swift)**
- Thin wrapper around `NWConnection` (Network framework)
- Methods: `createSocket()`, `send()`, `close()`
- Event emission: `onUDPData` → base64 strings

**UDPTransportBridge.m**
- Objective-C++ bridge exposing Swift module to React Native
- RCT_EXTERN_MODULE macros for TurboModule registration

**ReactNativeDelegate+Modules.mm**
- Method swizzling to register UDPTransport with TurboModule system
- Hooks `getModuleClassFromName:` on RCTDefaultReactNativeFactoryDelegate

## Data Flow

### Frequency Update Flow

```
Radio Frequency Change
    ↓
CI-V Response (serial port 50002)
    ↓
ConnectionManager._handleCIVResponse()
    ↓
ConnectionManager.emit('frequencyChanged', hz, display)
    ↓
IC705RigControl.onFrequencyChanged() callback
    ↓
useIC705 hook → React state update
    ↓
IC705StatusBar useEffect → dispatch(setVFO({freq, band, mode}))
    ↓
Redux store update
    ↓
LoggingPanel VFO sync effect → updateQSO({freq, band, mode})
    ↓
RadioControl component re-render with new frequency
```

### CW Send Flow

```
User taps CW button
    ↓
CWKeyer.sendTemplatedCW(template, variables)
    ↓
Template interpolation (variables → text)
    ↓
Chunk into CW elements (50ms timing)
    ↓
ConnectionManager.enqueueSendCW(text)
    ↓
OperationQueue serializes operation
    ↓
sendCIV(buildSendCW(chunk)) for each chunk
    ↓
NativeUDPTransport.send() → UDP socket
    ↓
Radio transmits CW
```

## Configuration

### Metro Port
Metro bundler runs on port **8082** (not default 8081):
- Configured in `AppDelegate.swift`: `RCTBundleURLProvider.sharedSettings().jsBundleURL(..., packagerHost: "localhost:8082")`
- Environment variable: `METRO_PORT=8082`

### Network Ports
- **50001**: RS-BA1 Control port (authentication, keepalive)
- **50002**: RS-BA1 Serial port (CI-V data)

## File Structure

```
src/extensions/other/ic705/
├── IC705RigControl.js           # Main orchestrator singleton
├── IC705SettingsScreen.jsx      # Settings/configuration (no Debug button in prod)
├── IC705DebugScreen.jsx         # Debug view (preserved for development)
├── defaults.js                  # Default configuration values
├── hooks/
│   └── useIC705.js              # React hook for radio state
├── protocol/
│   ├── ConnectionManager.js     # RS-BA1 connection state machine
│   ├── OperationQueue.js        # Serialized radio operations
│   ├── RSBA1Protocol.js         # Packet parsing/building
│   ├── CIVProtocol.js           # CI-V command protocol
│   ├── SessionState.js          # Connection state transitions
│   ├── RadioError.js            # Error types
│   ├── ByteUtils.js             # Binary data utilities
│   ├── CredentialCodec.js       # Password encoding
│   └── EventEmitter.js          # Minimal EventEmitter
├── transport/
│   ├── NativeUDPTransport.js    # JS transport wrapper (native UDP only)
│   ├── TransportInterface.js    # Abstract transport interface
│   └── transportConfig.js       # Transport factory (native UDP only)
└── keyer/
    ├── CWKeyer.js               # CW transmission engine
    └── CWTemplateEngine.js      # Template interpolation

ios/polorig/
├── UDPTransport.swift           # Swift UDP implementation
├── UDPTransportBridge.m         # RN bridge registration
├── ReactNativeDelegate+Modules.mm # TurboModule hook
├── AppDelegate.swift            # RN setup + bundle URL
└── Info.plist                   # Includes NSLocalNetworkUsageDescription
```

## Key Design Decisions

1. **Native UDP Transport**: Uses Swift `NWConnection` instead of Node.js dgram for better iOS integration and background handling.

2. **Operation Queue**: Serializes radio operations to prevent CI-V command collisions.

3. **Redux Sync**: Status bar dispatches `setVFO` to keep QSO form in sync - this decouples radio polling from form updates.

4. **Polling Strategy**: 1-second frequency polling when idle, suspended during CW transmission.

5. **WPM-Based CW Timing**: CW transmission completion is calculated based on actual Morse timing (Paris standard) rather than hardcoded delays. This ensures accurate timing across different speeds (6-48 WPM).

6. **Connection Health Monitoring**: Active health checks detect stalled connections and emit `connectionDegraded` events for UI feedback.

7. **TurboModule Registration**: Method swizzling on `RCTDefaultReactNativeFactoryDelegate` because React Native 0.83+ with New Architecture requires explicit module registration.

## Testing

### Unit Tests

All tests passing (199 total):

```bash
npm test -- --testPathPattern="ic705"
```

Test coverage includes:
- Connection lifecycle (connect → authenticate → connected)
- Session state machine transitions
- Frequency/mode/CW speed tracking from CI-V responses
- CW keyer chunking and pacing
- Template interpolation with macros
- Operation queue serialization and timeouts
- CI-V command queue behavior (ACK/NAK handling)

### Manual Test Checklist

- [ ] Connect to radio (Home LAN or Field AP mode)
- [ ] Frequency display updates when radio VFO changes
- [ ] Mode display updates (CW/SSB/FM/etc.)
- [ ] CW speed query and set
- [ ] CW send with template interpolation (`$callsign`, `$frequencyHz`, etc.)
- [ ] Navigate away/back - frequency stays synced
- [ ] New QSO uses current radio frequency
- [ ] Connection recovers from brief network interruption

## Production Checklist

See `PRODUCTION_READINESS_PLAN.md` for full details.

**Completed:**
- [x] WebSocket transport removed (native UDP only)
- [x] Settings UI simplified (no transport mode selection)
- [x] Debug button removed from settings screen
- [x] Native UDP hardened with error handling
- [x] Connection health monitoring implemented
- [x] WPM-based CW timing (not hardcoded)
- [x] Unit tests updated and passing
- [x] NSLocalNetworkUsageDescription added to Info.plist
- [x] Metro port fixed to 8082

## Related Documentation

- `IC705_TECHNICAL_GUIDE.md` - Deep dive into JS/Swift bridge, sequence diagrams, data flow
- `PRODUCTION_READINESS_PLAN.md` - Testing and deployment checklist
- `REBUILD_PLAN.md` - Migration from native to JS implementation notes
- `ARCHITECTURE.md` - Overall app architecture
