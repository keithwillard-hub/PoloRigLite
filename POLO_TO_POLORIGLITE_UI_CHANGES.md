# UI Changes from Polo to PoloRigLite

This document describes the user interface modifications made to the base Polo (Portable Logger) application for the PoloRigLite project, which adds IC-705 WiFi rig control capabilities.

## Overview

PoloRigLite extends the Polo logging application with real-time IC-705 transceiver integration. The UI changes consist of:

1. **Status Bar on QSO Page** - Real-time radio frequency/mode display
2. **Settings Screen** - Rig control configuration and connection management
3. **Settings Menu Entry** - Navigation to the new rig control settings

---

## 1. QSO Page (Logging Panel) Changes

### File: `src/screens/OperationScreens/OpLoggingTab/components/LoggingPanel.jsx`

#### Added Import
```javascript
import IC705StatusBar from '../../../../extensions/other/ic705/IC705StatusBar'
```

#### Added Component Render
The `IC705StatusBar` component is rendered at the top of the logging panel, above the `SecondaryExchangePanel`:

```jsx
<View style={styles.innerContainer}>
  <IC705StatusBar />
  <SecondaryExchangePanel
    style={styles.secondary.container}
    // ... other props
  />
  {/* ... rest of logging panel */}
</View>
```

**Location in UI**: Top of the QSO entry form, displaying as a compact horizontal bar.

### Component: `IC705StatusBar.jsx`

**File**: `src/extensions/other/ic705/IC705StatusBar.jsx`

A compact status display that shows real-time radio information when connected to an IC-705.

#### Visual Elements

| Element | Description | Conditional |
|---------|-------------|-------------|
| **Connection Dot** | 8px colored circle indicating connection state | Always visible when available (Green = connected, Gray = disconnected) |
| **Frequency** | Current radio frequency in MHz (e.g., "7.074 MHz") | Visible when connected |
| **Mode** | Operating mode (CW, USB, LSB, FM, etc.) | Visible when connected |
| **CW Speed** | Current keyer speed in WPM | Visible when CW mode active |
| **TX Indicator** | "TX" text in orange during CW transmission | Visible during `isSending` |
| **Operation State** | Status text like "querying..." or "sending..." | Visible during active operations |

#### Styling
- **Layout**: Horizontal flex row with `gap: oneSpace`
- **Font**: Roboto Mono for frequency (monospaced for alignment)
- **Colors**: Uses theme colors (`onSurface`, `primary`, `onSurfaceVariant`)
- **Sizing**: Compact height (`paddingVertical: halfSpace / 2`)

#### Redux Integration
The status bar dispatches `setVFO()` to synchronize the radio's frequency/mode with the QSO form:

```javascript
useEffect(() => {
  if (isConnected && frequency > 0) {
    dispatch(setVFO({
      freq: frequency,
      band: bandForFrequency(frequency),
      mode: mode || modeForFrequency(frequency)
    }))
  }
}, [isConnected, frequency, mode, dispatch])
```

This ensures that when the radio's VFO changes, the QSO form automatically updates to match.

---

## 2. Settings Screen Addition

### Main Settings Menu Entry

**File**: `src/screens/SettingsScreens/screens/MainSettingsScreen.jsx`

A new settings menu item was added to the "Equipment" section:

```jsx
<H2kListItem
  title="IC-705 Rig Control"
  description="WiFi rig control, CW keying, frequency display"
  onPress={() => navigation.navigate('Settings', { screen: 'IC705Settings' })}
  leftIcon="radio-handheld"
/>
```

**Menu Location**: Settings → Equipment → IC-705 Rig Control

**Icon**: `radio-handheld` (Material Community Icons)

### Navigation Registration

The IC705Settings screen is registered in the settings navigator:

```jsx
<Stack.Screen name="IC705Settings" key="IC705Settings"
  options={{ title: 'IC-705 Rig Control', leftAction: topLevelBack ? 'back' : 'none' }}
  component={IC705SettingsScreen}
/>
```

---

## 3. IC-705 Rig Control Settings Screen

**File**: `src/extensions/other/ic705/IC705SettingsScreen.jsx`

A comprehensive configuration screen for IC-705 rig control.

### Screen Layout

The settings screen is organized into sections using `H2kListSection` and `H2kListSubheader` components:

```
┌─────────────────────────────────────────┐
│  IC-705 Rig Control                     │
├─────────────────────────────────────────┤
│  CONNECTION                             │
│  ┌─────────────────────────────────┐   │
│  │ [●] IC-705                      │   │
│  │     7.074 MHz | CW | 20wpm      │   │
│  │ [Connect/Disconnect]            │   │
│  └─────────────────────────────────┘   │
├─────────────────────────────────────────┤
│  WIFI MODE                              │
│  ○ Home LAN                             │
│  ○ Field AP                             │
├─────────────────────────────────────────┤
│  HOME LAN SETTINGS                      │
│  ┌─────────────────────────────────┐   │
│  │ Radio IP Address                │   │
│  │ [192.168.2.144    ]             │   │
│  │ Username                        │   │
│  │ [kew              ]             │   │
│  │ Password                        │   │
│  │ [••••••••         ]             │   │
│  └─────────────────────────────────┘   │
├─────────────────────────────────────────┤
│  CW SETTINGS                            │
│  ┌─────────────────────────────────┐   │
│  │ CW Template (sent on QRZ miss)  │   │
│  │ [$callsign?       ]             │   │
│  │ [✓] Auto-send CW on QRZ miss    │   │
│  │ [✓] CW Sidetone                 │   │
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

### Section Details

#### Connection Section

| Element | Type | Description |
|---------|------|-------------|
| **Status Display** | `H2kListItem` | Shows radio name, frequency, mode, and CW speed when connected |
| **Connect Button** | `Button` | Toggles between Connect/Disconnect based on `isConnected` state |
| **Loading State** | `Button` | Shows loading spinner during `isConnecting` |

**Button States:**
- Disconnected: Contained button, "Connect", icon: `lan-connect`
- Connected: Outlined button, "Disconnect", icon: `lan-disconnect`
- Connecting: Loading spinner, disabled

#### WiFi Mode Section

Radio-style toggle switches for network configuration:

| Mode | Icon | Description |
|------|------|-------------|
| **Home LAN** | `home` | IC-705 connected to home WiFi network |
| **Field AP** | `antenna` | IC-705 as WiFi access point (192.168.59.1) |

Only one mode can be active at a time. The selection determines which configuration set is used.

#### Connection Settings Section

Dynamic section title changes based on selected WiFi mode ("Home LAN Settings" or "Field AP Settings").

| Field | Type | Placeholder | Keyboard |
|-------|------|-------------|----------|
| **Radio IP Address** | `TextInput` | Home: "192.168.2.144", Field: "192.168.59.1" | `numeric` |
| **Username** | `TextInput` | "kew" | `default`, `autoCapitalize: 'none'` |
| **Password** | `TextInput` | "••••••••" | `secureTextEntry`, `autoCapitalize: 'none'` |

**Input Styling:**
- Background: `theme.colors.background`
- Border: 1px solid `theme.colors.outline`
- Border radius: 8px
- Padding: `oneSpace`
- Full width with horizontal margins

#### CW Settings Section

| Element | Type | Description |
|---------|------|-------------|
| **CW Template** | `TextInput` | Template sent on QRZ lookup miss (e.g., "$callsign?") |
| **Auto-send CW** | `H2kListItem` | Switch to enable automatic CW query when callsign lookup fails |
| **CW Sidetone** | `H2kListItem` | Switch to enable local audio feedback during transmission |

**Template Variables:**
- `$callsign` - Target station callsign
- `$mycall` - Your callsign
- `{RST}` - Default RST report
- `{SN}` - Serial number (increments automatically)

### State Management

Settings are persisted via Redux `setSettings()` action:

```javascript
{
  ic705: {
    wifiMode: 'homeLAN' | 'fieldAP',
    homeLAN: {
      radioIPAddress: string,
      username: string,
      password: string
    },
    fieldAP: {
      radioIPAddress: string,
      username: string,
      password: string
    },
    cwTemplate: string,
    autoSendCWOnMiss: boolean,
    sidetoneEnabled: boolean
  }
}
```

---

## 4. Platform Availability

The IC-705 features are **iOS-only** due to React Native TurboModule requirements.

### iOS
- Full functionality available
- Native UDP transport via Swift `NWConnection`
- Settings menu item visible
- Status bar renders when native module is available

### Android
- IC-705 features disabled
- Settings menu item shows placeholder: "IC-705 Rig Control is only available on iOS."
- Status bar returns `null` (not rendered)

---

## 5. Integration Points

### Redux State

The IC-705 components integrate with the following Redux slices:

| Slice | Action | Purpose |
|-------|--------|---------|
| `station` | `setVFO()` | Sync radio frequency/mode to QSO form |
| `settings` | `setSettings()` | Persist IC-705 configuration |

### Theming

All UI components use the themed styles system:

```javascript
const styles = useThemedStyles(prepareStyles)
```

Colors adapt to light/dark mode via `theme.colors`:
- `background` - Input backgrounds
- `onBackground` - Input text
- `onSurface` / `onSurfaceVariant` - Labels and secondary text
- `primary` - Accent colors (mode display)
- `outline` - Input borders

---

## 6. File Structure Summary

### New Files Added

```
src/extensions/other/ic705/
├── IC705StatusBar.jsx           # Status bar component for QSO page
├── IC705SettingsScreen.jsx      # Rig control settings screen
├── defaults.js                  # Default configuration values
├── hooks/
│   └── useIC705.js              # React hook for radio state
└── protocol/                    # Protocol implementation (non-UI)

ios/polorig/
├── UDPTransport.swift           # Native UDP implementation
├── UDPTransportBridge.m         # React Native bridge
└── ReactNativeDelegate+Modules.mm # TurboModule registration
```

### Modified Files

```
src/screens/OperationScreens/OpLoggingTab/components/
└── LoggingPanel.jsx             # Added IC705StatusBar import & render

src/screens/SettingsScreens/screens/
└── MainSettingsScreen.jsx       # Added IC-705 menu item & screen registration
```

---

## Summary

The UI changes from Polo to PoloRigLite are focused and minimal:

1. **One new component** on the QSO page (`IC705StatusBar`)
2. **One new settings screen** (`IC705SettingsScreen`)
3. **One new menu entry** in Main Settings

The design maintains consistency with Polo's existing UI patterns (H2kListItem, H2kListSection, themed styles) while adding powerful rig control capabilities that integrate seamlessly with the logging workflow.
