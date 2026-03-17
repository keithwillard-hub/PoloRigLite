# PoloRigLite Production Readiness Plan

**Date:** 2026-03-16
**Status:** Draft - Ready for Execution

---

## 1. Executive Summary

This plan documents the work required to make PoloRigLite's IC-705 rig control module production-ready for App Store deployment.

**Key Decisions:**
- ❌ **Abandon WebSocket/Proxy approach** — adds infrastructure burden, breaks Field AP mode
- ✅ **Keep Native UDP (Swift) transport** — thin, reliable, supports offline operation
- ✅ **Remove transport mode switching** — simplifies code, reduces test surface
- ✅ **Fix robustness issues in JS protocol stack** — state management, error handling, lifecycle

---

## 2. Architecture Decision Record (ADR)

### ADR-001: Remove WebSocket/Proxy Transport

**Context:**
The codebase currently supports dual transport modes: Native UDP (Swift) and WebSocket (to a proxy server). This was added as an alternative implementation path.

**Decision:**
Remove the WebSocket transport and all mode-switching logic. Use Native UDP exclusively.

**Rationale:**
1. **Field AP mode requirement** — Solo portable operation requires connecting directly to IC-705's access point, which has no internet connectivity
2. **Infrastructure burden** — Would require deploying/maintaining a proxy server (Raspberry Pi or VPS)
3. **Complexity without benefit** — The WebSocket adds ~120 lines plus a server, doesn't solve the actual robustness issues
4. **Test surface** — Dual modes means testing every scenario twice

**Consequences:**
- ✅ Simpler code (remove ~250 lines across 4 files)
- ✅ One transport to test thoroughly
- ✅ Works offline in Field AP mode
- ✅ Lower latency (no proxy hop)
- ❌ Cannot control radio from browser/web app (not a requirement)

---

## 3. Critical Issues to Fix

### Issue 1: Native Module Loading Race Condition [CRITICAL]
**File:** `src/extensions/other/ic705/transport/NativeUDPTransport.js`

**Problem:** Module resolution relies on fallbacks that can fail silently. Debug Alert is production-inappropriate.

**Fix:**
- Remove debug Alert
- Add synchronous availability check
- Return clear error when native module unavailable
- Add retry logic with timeout

---

### Issue 2: Missing Local Network Privacy Permission [CRITICAL]
**File:** `ios/polorig/Info.plist`

**Problem:** iOS 14+ requires permission to discover devices on local network. App will fail silently without it.

**Fix:**
Add to `Info.plist`:
```xml
<key>NSLocalNetworkUsageDescription</key>
<string>PoloRigLite connects to your IC-705 radio over your local WiFi network.</string>
<key>NSBonjourServices</key>
<array>
  <string>_rs-ba1._tcp</string>
</array>
```

---

### Issue 3: Background/Foreground State Race [HIGH]
**Files:** `IC705RigControl.js:80-84`, `useIC705.js:88-107`

**Problem:** Two competing AppState listeners cause race conditions during background/foreground transitions.

**Fix:**
- Remove AppState listener from `IC705RigControl.js`
- Keep foreground-refresh logic only in `useIC705.js`
- Disconnect on background should be handled via iOS lifecycle events in Swift if needed

---

### Issue 4: No Connection Recovery [HIGH]
**File:** `ConnectionManager.js`

**Problem:** If radio sleeps or WiFi drops, connection stays "connected" but commands fail. No auto-reconnect.

**Fix:**
- Add connection health monitoring (heartbeat)
- Track last successful response timestamp
- Auto-disconnect if no response for 5 seconds
- Emit `connectionDegraded` event for UI indicator
- Optional: exponential backoff reconnection attempts

---

### Issue 5: CW Timing Drift [MEDIUM]
**File:** `src/extensions/other/ic705/protocol/OperationQueue.js:175-188`

**Problem:** Hardcoded 800ms delay for CW send completion. Incorrect for slow speeds.

**Fix:**
Replace hardcoded delay with WPM-based calculation (ported from Swift):
```javascript
const duration = Math.max(estimateDuration(text, wpm) * 1.15, 0.8)
```

---

### Issue 6: Remove Transport Mode Switching [MEDIUM]
**Files:**
- `src/extensions/other/ic705/transport/WebSocketTransport.js` (delete)
- `src/extensions/other/ic705/transport/transportConfig.js` (simplify)
- `src/extensions/other/ic705/defaults.js` (remove ws/proxy keys)
- `IC705SettingsScreen.jsx` (remove mode selector)

**Fix:**
- Delete WebSocketTransport.js
- Simplify transportConfig.js to always return NativeUDPTransport
- Remove uiMode, transport, proxyUrl from defaults
- Remove mode selector from settings UI

---

### Issue 7: Debug Logging Cleanup [LOW]
**Files:** Throughout the codebase

**Problem:** Extensive console.log calls impact performance and leak debug info.

**Fix:**
- Replace console.log with proper logging utility
- Disable logs in production builds
- Keep error logging

---

## 4. Implementation Phases

### Phase 1: Remove WebSocket/Mode Switching
**Goal:** Simplify to single transport mode

**Tasks:**
1. Delete `src/extensions/other/ic705/transport/WebSocketTransport.js`
2. Simplify `transportConfig.js` → always return NativeUDPTransport
3. Remove transport-related keys from `defaults.js`
4. Remove mode selector from `IC705SettingsScreen.jsx`
5. Update `IC705RigControl.js` to always use native transport (remove settings param where unused)
6. Verify app builds and connects in simulator

**Estimated:** 1-2 hours

---

### Phase 2: Fix Critical Robustness Issues
**Goal:** Production-ready error handling and lifecycle

**Tasks:**
1. Fix native module loading race in `NativeUDPTransport.js`
2. Add Local Network Privacy permission to Info.plist
3. Unify AppState handling (remove from IC705RigControl, keep in useIC705)
4. Add connection health monitoring to ConnectionManager
5. Implement WPM-based CW timing in OperationQueue

**Estimated:** 3-4 hours

---

### Phase 3: Testing & Hardening
**Goal:** Validate on real hardware

**Tasks:**
1. Test connection/disconnection cycles (20+ times)
2. Test background/foreground transitions
3. Test radio sleep/wake (wait for IC-705 to sleep, then wake)
4. Test CW send at various speeds (10, 20, 30, 40 WPM)
5. Test Field AP mode (direct to IC-705 AP)
6. Test Home LAN mode (through router)
7. Verify frequency tracking stays synced
8. Verify QSO form updates correctly

**Estimated:** 2-3 hours (requires radio access)

---

### Phase 4: Cleanup & Documentation
**Goal:** Code quality for maintenance

**Tasks:**
1. Remove or conditionalize debug logging
2. Add JSDoc comments to public API methods
3. Update IC705_ARCHITECTURE.md to reflect simplified transport
4. Update README with setup instructions
5. Create test checklist document

**Estimated:** 2 hours

---

## 5. Test Checklist

### Pre-Flight Checks
- [ ] App launches without console errors
- [ ] NativeUDPTransport.isAvailable returns true
- [ ] Settings screen shows only relevant options (no transport mode selector)

### Connection Tests
- [ ] Connect to radio in Home LAN mode
- [ ] Connect to radio in Field AP mode
- [ ] Frequency displays correctly in status bar
- [ ] Mode displays correctly
- [ ] CW speed displays correctly

### Robustness Tests
- [ ] Disconnect and reconnect 10 times rapidly
- [ ] Background app during connection, foreground — connection stable
- [ ] Radio powered off while connected — app detects disconnection within 5s
- [ ] Radio powered back on — can reconnect without app restart
- [ ] iOS sleep/wake cycle — connection recovers

### CW Tests
- [ ] Send CW at 10 WPM — timing correct
- [ ] Send CW at 20 WPM — timing correct
- [ ] Send CW at 30 WPM — timing correct
- [ ] Send CW with template ($callsign) — works
- [ ] Cancel CW mid-send — stops immediately
- [ ] Change CW speed — new speed takes effect

### Integration Tests
- [ ] Frequency change on radio → QSO form updates
- [ ] New QSO uses current radio frequency
- [ ] Log QSO — frequency logged correctly
- [ ] Navigate away and back — frequency still synced

---

## 6. Rollback Plan

If critical issues are discovered:

1. **Git tag before changes:** `git tag pre-production-cleanup`
2. **Keep PoloRig repo as reference** — the full Swift implementation is a working fallback
3. **Reversion commits:** Make granular commits per issue for easy reversion

---

## 7. Success Criteria

Production readiness is achieved when:

1. ✅ No WebSocket/proxy code remains in codebase
2. ✅ Native module loads reliably on app start
3. ✅ Connection recovers from radio sleep/wake
4. ✅ Background/foreground transitions don't crash or freeze UI
5. ✅ CW timing accurate across all speeds (10-40 WPM)
6. ✅ Frequency tracking works for 30+ minute session
7. ✅ All tests in Section 5 pass
8. ✅ No debug alerts or console spam in production build

---

## 8. Files to Modify/Delete

### Delete (Phase 1)
- `src/extensions/other/ic705/transport/WebSocketTransport.js`

### Modify (Phase 1 - Simplification)
- `src/extensions/other/ic705/transport/transportConfig.js`
- `src/extensions/other/ic705/defaults.js`
- `src/extensions/other/ic705/IC705SettingsScreen.jsx`

### Modify (Phase 2 - Robustness)
- `src/extensions/other/ic705/transport/NativeUDPTransport.js`
- `src/extensions/other/ic705/IC705RigControl.js`
- `src/extensions/other/ic705/protocol/ConnectionManager.js`
- `src/extensions/other/ic705/protocol/OperationQueue.js`
- `src/hooks/useIC705.js`
- `ios/polorig/Info.plist`

### Documentation Updates
- `IC705_ARCHITECTURE.md`
- `README.md`

---

**Ready to execute. Start with Phase 1?**
