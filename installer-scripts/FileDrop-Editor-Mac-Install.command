#!/bin/bash
# FileDrop — Editor (Receiver) macOS Installer
# Double-click this file in Finder to install.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$HOME/Applications/FileDrop"
PORT=5050

# Detect architecture and pick the right binary
ARCH="$(uname -m)"
if [ "$ARCH" = "arm64" ]; then
  BIN_NAME="FileDrop-Editor-mac-arm64"
else
  BIN_NAME="FileDrop-Editor-mac-x64"
fi

BIN_SRC="$SCRIPT_DIR/$BIN_NAME"
if [ ! -f "$BIN_SRC" ]; then
  echo "ERROR: Binary not found: $BIN_SRC"
  echo "Make sure $BIN_NAME is in the same folder as this script."
  read -p "Press Enter to exit."
  exit 1
fi

echo "Installing FileDrop (Editor / Receiver)..."
echo "Architecture: $ARCH"
echo "Install path: $INSTALL_DIR"
echo ""

mkdir -p "$INSTALL_DIR"
cp "$BIN_SRC" "$INSTALL_DIR/FileDrop-Editor"
chmod +x "$INSTALL_DIR/FileDrop-Editor"

# Register as a launchd service (auto-start on login)
"$INSTALL_DIR/FileDrop-Editor" --install

echo ""
echo "FileDrop installed successfully."
echo "Opening setup wizard in your browser..."
sleep 2
open "http://localhost:$PORT/setup"

read -p "Press Enter to close this window."
