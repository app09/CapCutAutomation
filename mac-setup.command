#!/bin/bash
# ============================================================
#  CapCut Automation Studio — One-Click Mac Setup
#
#  SHARE ONLY THIS ONE FILE. The Mac user double-clicks it and
#  everything happens automatically — NOTHING to pre-install:
#    0. Installs a local copy of Node.js if it's missing (no admin)
#    1. Downloads the app source (curl — no git needed)
#    2. Installs dependencies
#    3. Updates Electron (fixes the macOS XProtect false-positive)
#    4. Builds the .dmg installer
#    5. Installs the app into /Applications
#    6. Launches it
#
#  First run, if double-click is blocked:  right-click -> Open -> Open.
# ============================================================

# Keep the Terminal window open so output/errors stay readable.
trap 'echo ""; echo "Press Enter to close."; read -r _' EXIT
set -e
set -o pipefail

# ---- Settings (change these if you fork/rename) ------------
SRC_TARBALL="https://github.com/app09/CapCutAutomation/archive/refs/heads/main.tar.gz"
APP_NAME="CapCut Automation Studio"
WORK_DIR="$HOME/.capcut-automation-studio-src"
NODE_VER="v20.18.0"            # bundled fallback Node (LTS)
NODE_DIR="$HOME/.capcut-node"
# -----------------------------------------------------------

echo "==================================================="
echo "   $APP_NAME — One-Click Mac Setup"
echo "==================================================="

# ── 0. Make sure Node.js is available (auto-install locally) ─
if ! command -v npm >/dev/null 2>&1; then
  echo "-> Node.js not found — installing a local copy (no admin needed)..."
  case "$(uname -m)" in
    arm64)  NARCH="arm64" ;;
    x86_64) NARCH="x64" ;;
    *) echo "X  Unsupported CPU $(uname -m). Install Node LTS from https://nodejs.org and re-run."; exit 1 ;;
  esac
  NODE_URL="https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-darwin-${NARCH}.tar.gz"
  rm -rf "$NODE_DIR"; mkdir -p "$NODE_DIR"
  if ! curl -fsSL "$NODE_URL" | tar -xz -C "$NODE_DIR" --strip-components=1; then
    echo "X  Could not auto-install Node. Install LTS from https://nodejs.org and re-run."
    exit 1
  fi
  export PATH="$NODE_DIR/bin:$PATH"
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "X  Node/npm still unavailable. Install LTS from https://nodejs.org and re-run."
  exit 1
fi
echo "OK  Node $(node -v), npm $(npm -v)"

# ── 1. Download the app source (no git required) ────────────
echo ""
echo "-> [1/6] Downloading the app source..."
rm -rf "$WORK_DIR"; mkdir -p "$WORK_DIR"
curl -fsSL "$SRC_TARBALL" | tar -xz -C "$WORK_DIR" --strip-components=1
cd "$WORK_DIR"

# ── 2. Dependencies ─────────────────────────────────────────
echo ""
echo "-> [2/6] Installing dependencies..."
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
