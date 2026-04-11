#!/bin/bash
# FileDrop — Spoke (Jason's Laptop / Mitch) macOS Installer
# Double-click in Finder to install.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$HOME/Applications/FileDrop"
PORT=5050

ARCH="$(uname -m)"
BIN_NAME="FileDrop-Spoke-mac-$([ "$ARCH" = "arm64" ] && echo arm64 || echo x64)"
BIN_SRC="$SCRIPT_DIR/$BIN_NAME"

if [ ! -f "$BIN_SRC" ]; then
  echo "ERROR: Binary not found: $BIN_SRC"
  echo "Make sure $BIN_NAME is in the same folder as this script."
  read -p "Press Enter to exit."
  exit 1
fi

echo "Installing FileDrop..."
echo "Architecture: $ARCH"
echo "Install path: $INSTALL_DIR"
echo ""

mkdir -p "$INSTALL_DIR"
cp "$BIN_SRC" "$INSTALL_DIR/FileDrop-Spoke"
chmod +x "$INSTALL_DIR/FileDrop-Spoke"

xattr -d com.apple.quarantine "$INSTALL_DIR/FileDrop-Spoke" 2>/dev/null || true

"$INSTALL_DIR/FileDrop-Spoke" --install

echo ""
echo "FileDrop installed."
echo "Opening setup wizard..."
sleep 2
open "http://localhost:$PORT/setup"

read -p "Press Enter to close."
