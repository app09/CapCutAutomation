#!/bin/bash
# ============================================================
#  CapCut Automation Studio — One-Click Mac Setup
#
#  SHARE ONLY THIS ONE FILE. The Mac user double-clicks it and
#  everything happens automatically:
#    1. Downloads the app source (git clone)
#    2. Installs dependencies
#    3. Updates Electron (fixes the macOS XProtect false-positive)
#    4. Builds the .dmg installer
#    5. Installs the app into /Applications
#    6. Launches it
#
#  REQUIREMENTS on the Mac:
#    - Node.js LTS  ->  https://nodejs.org
#    - git (macOS offers to install it automatically on first use)
#
#  IMPORTANT: the GitHub repo must be PUBLIC (or the person running
#  this must have access), otherwise the download step cannot reach it.
#
#  First run, if double-click is blocked:  right-click -> Open -> Open.
# ============================================================

# Keep the Terminal window open so output/errors stay readable.
trap 'echo ""; echo "Press Enter to close."; read -r _' EXIT
set -e

# ---- Settings (change these if you fork/rename) ------------
REPO_URL="https://github.com/app09/CapCutAutomation.git"
APP_NAME="CapCut Automation Studio"
WORK_DIR="$HOME/.capcut-automation-studio-src"
# -----------------------------------------------------------

echo "==================================================="
echo "   $APP_NAME — One-Click Mac Setup"
echo "==================================================="

# ── 0. Requirements ─────────────────────────────────────────
if ! command -v git >/dev/null 2>&1; then
  echo "X  git not found. Triggering the Xcode Command Line Tools installer..."
  xcode-select --install 2>/dev/null || true
  echo "   Finish that install popup, then run this file again."
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "X  Node.js / npm not found."
  echo "   Install the LTS version from https://nodejs.org and run this again."
  exit 1
fi
echo "OK  git $(git --version | awk '{print $3}'), Node $(node -v), npm $(npm -v)"

# ── 1. Download / update the source ─────────────────────────
echo ""
echo "-> [1/6] Downloading the app source..."
if [ -d "$WORK_DIR/.git" ]; then
  git -C "$WORK_DIR" fetch --all --quiet
  git -C "$WORK_DIR" reset --hard origin/main --quiet
else
  rm -rf "$WORK_DIR"
  git clone --depth 1 "$REPO_URL" "$WORK_DIR"
fi
cd "$WORK_DIR"

# ── 2. Dependencies ─────────────────────────────────────────
echo ""
echo "-> [2/6] Installing dependencies (fresh)..."
rm -rf node_modules package-lock.json
npm install

# ── 3. Auto-update Electron + builder ───────────────────────
echo ""
echo "-> [3/6] Updating Electron + electron-builder to latest..."
npm install --save-dev electron@latest electron-builder@latest

# ── 4. Clear quarantine on the Electron binary ──────────────
echo ""
echo "-> [4/6] Clearing quarantine flags..."
xattr -cr node_modules/electron/dist/Electron.app 2>/dev/null || true

# ── 5. Build the .dmg ───────────────────────────────────────
echo ""
echo "-> [5/6] Building the macOS installer (.dmg) — a few minutes..."
export CSC_IDENTITY_AUTO_DISCOVERY=false
npm run dist:mac

# ── 6. Install into /Applications and launch ────────────────
echo ""
echo "-> [6/6] Installing '$APP_NAME'..."
APP_PATH="$(find dist -maxdepth 2 -name "$APP_NAME.app" -type d 2>/dev/null | head -n 1)"
if [ -z "$APP_PATH" ]; then
  echo "X  Built app not found under dist/. Check the build log above."
  exit 1
fi

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
xattr -cr "$DEST" 2>/dev/null || true

echo ""
echo "==================================================="
echo "OK  Installed: $DEST"
echo "==================================================="
echo "-> Launching..."
open "$DEST" || true
