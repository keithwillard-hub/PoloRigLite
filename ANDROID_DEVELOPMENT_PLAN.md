# Android Development Plan for PoloRigLite

## Overview

This document outlines the plan to extend PoloRigLite to support Android devices, enabling IC-705 WiFi rig control on Android phones and tablets.

## Current State

The application is currently **iOS-only** due to the native UDP transport being implemented in Swift. The JavaScript layer (protocol handling, UI components, state management) is already cross-platform and will work on Android without modification.

### What's Already Cross-Platform

| Component | Status | Notes |
|-----------|--------|-------|
| `ConnectionManager.js` | ✅ Ready | Pure JavaScript, platform-agnostic |
| `OperationQueue.js` | ✅ Ready | Pure JavaScript |
| `CWKeyer.js` | ✅ Ready | Pure JavaScript timing logic |
| `CIVProtocol.js` | ✅ Ready | Binary protocol handling |
| `RSBA1Protocol.js` | ✅ Ready | Packet construction |
| `IC705StatusBar.jsx` | ✅ Ready | React Native component |
| `IC705SettingsScreen.jsx` | ✅ Ready | React Native component |
| `useIC705.js` | ✅ Ready | React hook |
| Native UDP Transport | ❌ Missing | Needs Kotlin implementation |

---

## Package Naming Strategy

To allow parallel installation of stable and test builds, we will use **product flavors** with different application IDs.

### Package Names

| Build Type | Package Name | Display Name |
|------------|--------------|--------------|
| **Production** | `com.ac0vw.polorig.prod` | "PoloRig" |
| **Beta** | `com.ac0vw.polorig.beta` | "PoloRig Beta" |
| **Debug** | `com.ac0vw.polorig.dev` | "PoloRig Dev" |

### Why Different Package Names?

1. **Parallel Installation**: Users can have both stable and beta versions installed
2. **Separate Data**: Each build has its own sandbox, settings, and cache
3. **Clear Identification**: Different names in app launcher and settings
4. **Safe Testing**: Beta crashes don't affect production data

### Gradle Configuration

**File**: `android/app/build.gradle`

```gradle
android {
    // ...

    flavorDimensions "version"

    productFlavors {
        prod {
            dimension "version"
            applicationId "com.ac0vw.polorig.prod"
            resValue "string", "app_name", "PoloRig"
        }
        beta {
            dimension "version"
            applicationId "com.ac0vw.polorig.beta"
            resValue "string", "app_name", "PoloRig Beta"
        }
        dev {
            dimension "version"
            applicationId "com.ac0vw.polorig.dev"
            resValue "string", "app_name", "PoloRig Dev"
        }
    }
}
```

---

## Implementation Tasks

### Phase 1: Native UDP Module (Kotlin)

**Goal**: Create Android-equivalent of `UDPTransport.swift`

#### 1.1 Create Kotlin TurboModule

**File**: `android/app/src/main/java/com/polorig/UDPTransport.kt`

```kotlin
package com.polorig

import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import kotlinx.coroutines.*
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.util.Base64

class UDPTransport(reactContext: ReactApplicationContext) :
    NativeEventEmitterModule(reactContext) {

    private val sockets = mutableMapOf<String, DatagramSocket>()
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    companion object {
        const val NAME = "UDPTransport"
    }

    override fun getName(): String = NAME

    @ReactMethod
    fun createSocket(id: String, promise: Promise) {
        scope.launch {
            try {
                // Close existing socket if any
                sockets[id]?.close()
                sockets.remove(id)
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("CREATE_ERROR", e.message, e)
            }
        }
    }

    @ReactMethod
    fun send(id: String, host: String, port: Int,
             base64Data: String, promise: Promise) {
        scope.launch {
            try {
                val data = Base64.getDecoder().decode(base64Data)

                val socket = sockets.getOrPut(id) {
                    DatagramSocket().apply {
                        // Create socket, start receiving
                        startReceiving(id, this)
                    }
                }

                val packet = DatagramPacket(
                    data, data.size,
                    InetAddress.getByName(host), port
                )

                socket.send(packet)
                promise.resolve(null)
            } catch (e: Exception) {
                // Log but resolve (UDP is best-effort)
                promise.resolve(null)
            }
        }
    }

    @ReactMethod
    fun close(id: String, promise: Promise) {
        scope.launch {
            sockets[id]?.close()
            sockets.remove(id)
            promise.resolve(null)
        }
    }

    private fun startReceiving(id: String, socket: DatagramSocket) {
        scope.launch {
            val buffer = ByteArray(1024)
            while (!socket.isClosed) {
                try {
                    val packet = DatagramPacket(buffer, buffer.size)
                    socket.receive(packet)

                    val data = packet.data.copyOf(packet.length)
                    val b64 = Base64.getEncoder().encodeToString(data)

                    reactApplicationContext
                        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                        ?.emit("onUDPData", Arguments.createMap().apply {
                            putString("id", id)
                            putString("data", b64)
                        })
                } catch (e: Exception) {
                    // Socket closed, exit loop
                    break
                }
            }
        }
    }
}
```

#### 1.2 Register Module

**File**: `android/app/src/main/java/com/polorig/UDPTransportPackage.kt`

```kotlin
package com.polorig

import com.facebook.react.TurboReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class UDPTransportPackage : TurboReactPackage() {
    override fun getModule(
        name: String,
        reactContext: ReactApplicationContext
    ): NativeModule? {
        return when (name) {
            UDPTransport.NAME -> UDPTransport(reactContext)
            else -> null
        }
    }

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
        return ReactModuleInfoProvider {
            mapOf(
                UDPTransport.NAME to ReactModuleInfo(
                    UDPTransport.NAME,
                    UDPTransport.NAME,
                    false,  // canOverrideExistingModule
                    false,  // needsEagerInit
                    true,   // hasConstants
                    false,  // isCxxModule
                    true    // isTurboModule
                )
            )
        }
    }
}
```

#### 1.3 Add to MainApplication

**File**: `android/app/src/main/java/com/polorig/MainApplication.kt`

Add to `getPackages()`:

```kotlin
override fun getPackages(): List<ReactPackage> =
    PackageList(this).packages.apply {
        add(UDPTransportPackage())
    }
```

### Phase 2: JavaScript Resolution Update

**File**: `src/extensions/other/ic705/transport/NativeUDPTransport.js`

Update module resolution to include Android:

```javascript
function resolveNativeUDP() {
    // Try TurboModuleRegistry first (New Architecture)
    try {
        const turbo = TurboModuleRegistry?.get?.('UDPTransport')
        if (turbo) return turbo
    } catch (e) {}

    // Fall back to NativeModules (Legacy bridge)
    if (NativeModules.UDPTransport) {
        return NativeModules.UDPTransport
    }

    return null
}
```

### Phase 3: Android Manifest Permissions

**File**: `android/app/src/main/AndroidManifest.xml`

Add network permissions:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
</manifest>
```

---

## Testing Distribution Strategy

### For 1-2 Remote Testers: Firebase App Distribution

**Why Firebase?**
- Free for small teams (up to 500 testers)
- Testers get email notifications of new builds
- Version history and release notes
- Crash reporting included
- No Play Store account required

**Setup Steps:**

1. **Install Firebase CLI:**
   ```bash
   npm install -g firebase-tools
   firebase login
   ```

2. **Configure project:**
   ```bash
   firebase init appdistribution
   ```

3. **Build and distribute:**
   ```bash
   # Build beta APK
   cd android
   ./gradlew assembleBetaRelease

   # Upload to Firebase
   firebase appdistribution:distribute \
     app/build/outputs/apk/beta/release/app-beta-release.apk \
     --app YOUR_FIREBASE_APP_ID \
     --release-notes "IC-705 Android beta - Fixed UDP socket handling" \
     --testers "tester1@email.com,tester2@email.com"
   ```

**Tester Experience:**
1. Receives email with download link
2. Taps link → Downloads APK
3. Android prompts to enable "Install unknown apps" for browser
4. Installs "PoloRig Beta" alongside any existing "PoloRig"

### Alternative: Direct APK Sharing

For quicker iteration:

```bash
# Build
./gradlew assembleBetaRelease

# Upload to Google Drive/Dropbox
# Share link via email/Slack
```

---

## Build Commands Reference

| Command | Output | Purpose |
|---------|--------|---------|
| `./gradlew assembleProdRelease` | `app-prod-release.apk` | Production build |
| `./gradlew assembleBetaRelease` | `app-beta-release.apk` | Beta test build |
| `./gradlew assembleDevDebug` | `app-dev-debug.apk` | Development debug |
| `./gradlew bundleProdRelease` | `app-prod-release.aab` | Play Store bundle |
| `npx react-native run-android --variant=devDebug` | Installs dev build | Local development |

---

## Development Timeline

### Week 1: Core Implementation (8-10 hours)

- [ ] Day 1-2: Create Kotlin UDPTransport module
- [ ] Day 3: Test local build on Android device
- [ ] Day 4: Set up product flavors (prod/beta/dev)
- [ ] Day 5: Configure Firebase App Distribution

### Week 2: Testing & Polish (6-8 hours)

- [ ] Day 1: Deploy beta build to Firebase
- [ ] Day 2-4: Fix issues found by testers
- [ ] Day 5: Final verification with IC-705 hardware

### Total Estimated Effort: 14-18 hours

---

## Testing Checklist

### Pre-Distribution Testing

Before sharing with external testers, verify:

- [ ] App launches without crash
- [ ] Settings screen displays correctly
- [ ] Can enter IP/credentials
- [ ] Connect button responds
- [ ] Status bar shows when connected
- [ ] Frequency updates from radio
- [ ] Mode displays correctly
- [ ] CW send works
- [ ] App survives background/foreground
- [ ] Disconnect/reconnect cycle works

### Tester Feedback Template

Provide testers with this checklist:

```markdown
## PoloRig Android Beta Test

Device: _________
Android Version: _________
IC-705 Connection: Home LAN / Field AP

### Setup
- [ ] Was able to install APK without issues
- [ ] App launches and shows settings screen
- [ ] Can enter radio IP address

### Connection
- [ ] Connect button establishes connection
- [ ] Status bar shows frequency/mode
- [ ] Frequency updates when VFO is changed

### CW Keying
- [ ] CW send button works
- [ ] "TX" indicator shows during transmission
- [ ] Sidetone plays (if enabled)

### Issues Found
Describe any crashes, UI glitches, or connection problems:
_________________________________
```

---

## Package Name Migration Path

When ready for Play Store release:

1. **Keep beta separate**: Continue using `com.ac0vw.polorig.beta` for testers
2. **Prod is Play Store**: Use `com.ac0vw.polorig.prod` for Play Store builds
3. **User transition**: Beta users can install prod build and uninstall beta

---

## Related Documentation

- `IC705_ARCHITECTURE.md` - High-level component overview
- `IC705_TECHNICAL_GUIDE.md` - JS/Swift bridge details (Kotlin equivalent)
- `POLO_TO_POLORIGLITE_UI_CHANGES.md` - UI modifications

---

## Notes

### CI-V Protocol Compatibility

The CI-V protocol is identical across iOS and Android - the IC-705 radio communicates the same way regardless of the controller's OS. The only platform-specific code is the UDP socket implementation.

### Field AP Mode

Android handles WiFi connections differently than iOS:
- Android can connect to the IC-705's access point while maintaining cellular data
- No special handling needed - standard `DatagramSocket` works
- May need to disable "WiFi data saver" if present

### Background Operation

Android 8+ (API 26+) imposes background execution limits:
- UDP socket will work while app is foreground
- For background operation, consider a foreground service
- Most users operate with app in foreground during QSOs
