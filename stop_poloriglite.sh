#!/bin/zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_BUNDLE_ID="${APP_BUNDLE_ID:-com.ac0vw.polorig.prod}"
METRO_PORT="${METRO_PORT:-8082}"

echo "Stopping PoloRigLite..."

# Stop the app on simulator
echo "Terminating app ${APP_BUNDLE_ID}..."
xcrun simctl terminate booted "${APP_BUNDLE_ID}" 2>/dev/null || echo "App not running or simulator not available"

# Stop Metro bundler
echo "Stopping Metro bundler on port ${METRO_PORT}..."
METRO_PID=$(lsof -iTCP:"${METRO_PORT}" -sTCP:LISTEN -n -P -t 2>/dev/null || true)
if [[ -n "${METRO_PID}" ]]; then
  kill "${METRO_PID}" 2>/dev/null || true
  echo "Metro stopped (PID: ${METRO_PID})"
else
  echo "Metro not running"
fi

# Kill any remaining react-native start processes
pkill -f "react-native start --port ${METRO_PORT}" 2>/dev/null || true

# Shutdown simulator
echo "Shutting down simulator..."
xcrun simctl shutdown booted 2>/dev/null || echo "No booted simulator to shutdown"

# Quit Simulator app
if pgrep -q "Simulator"; then
  echo "Quitting Simulator app..."
  osascript -e 'quit app "Simulator"' 2>/dev/null || true
else
  echo "Simulator app not running"
fi

echo "PoloRigLite stopped."
