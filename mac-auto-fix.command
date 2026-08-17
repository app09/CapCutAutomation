#!/bin/bash
# ============================================================
#  CapCut Automation Studio — Mac Auto-Fixer
#  Double-click to run. It will:
#    1. Install dependencies
#    2. Auto-update Electron (fixes the macOS XProtect false-positive)
#    3. Build the .dmg installer
#    4. Install the app into /Applications
#    5. Launch it
#
#  First time only, if double-click is blocked, run once in Terminal:
#      chmod +x mac-auto-fix.command
#  and if macOS says "unidentified developer": right-click → Open.
# ============================================================

# Always run from the folder this script lives in.
cd "$(dirname "$0")" || exit 1

# Pause before the window closes so errors stay readable.
trap 'echo ""; echo "Press Enter to close."; read -r _' EXIT
set -e

APP_NAME="CapCut Automation Studio"

echo "==================================================="
echo "   $APP_NAME — Mac Auto-Fixer"
echo "==================================================="

# ── 0. Require Node.js ──────────────────────────────────────
if ! command -v npm >/dev/null 2>&1; then
  echo "X  Node.js / npm not found."
  echo "   Install the LTS version from https://nodejs.org and run this again."
  exit 1
fi
echo "OK Node $(node -v), npm $(npm -v)"

# ── 1. Fresh dependency install ─────────────────────────────
echo ""
echo "-> [1/5] Installing dependencies (fresh)..."
rm -rf node_modules package-lock.json
npm install

# ── 2. Auto-update Electron + builder ───────────────────────
# Old Electron builds get quarantined by macOS XProtect as a false-positive.
# Pulling the latest Electron (and a matching builder) avoids that.
echo ""
echo "-> [2/5] Updating Electron + electron-builder to latest..."
npm install --save-dev electron@latest electron-builder@latest

# ── 3. Clear quarantine on the Electron binary ──────────────
# Stops macOS from killing/flagging the fresh binary during the build.
echo ""
echo "-> [3/5] Clearing quarantine flags on the Electron binary..."
xattr -cr node_modules/electron/dist/Electron.app 2>/dev/null || true

# ── 4. Build the macOS installer (.dmg) ─────────────────────
echo ""
echo "-> [4/5] Building the macOS installer (.dmg) — this can take a few minutes..."
export CSC_IDENTITY_AUTO_DISCOVERY=false
npm run dist:mac

# ── 5. Install into /Applications and launch ────────────────
echo ""
echo "-> [5/5] Installing '$APP_NAME' ..."

APP_PATH="$(find dist -maxdepth 2 -name "$APP_NAME.app" -type d 2>/dev/null | head -n 1)"
if [ -z "$APP_PATH" ]; then
  echo "X  Built app not found under dist/. Check the build log above for errors."
  exit 1
fi
echo "   Built: $APP_PATH"

# Try /Applications; fall back to ~/Applications if it isn't writable.
rm -rf "/Applications/$APP_NAME.app" 2>/dev/null || true
if cp -R "$APP_PATH" "/Applications/" 2>/dev/null; then
  DEST="/Applications/$APP_NAME.app"
else
  echo "   (No permission for /Applications — installing to ~/Applications instead)"
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/$APP_NAME.app" 2>/dev/null || true
  cp -R "$APP_PATH" "$HOME/Applications/"
  DEST="$HOME/Applications/$APP_NAME.app"
fi

# Clear quarantine on the installed copy so it opens without the malware prompt.
xattr -cr "$DEST" 2>/dev/null || true

DMG_PATH="$(find dist -maxdepth 1 -name "*.dmg" 2>/dev/null | head -n 1)"

echo ""
echo "==================================================="
echo "OK  Installed: $DEST"
[ -n "$DMG_PATH" ] && echo "    Installer .dmg also saved at: $DMG_PATH"
echo "==================================================="

echo "-> Launching the app..."
open "$DEST" || true
