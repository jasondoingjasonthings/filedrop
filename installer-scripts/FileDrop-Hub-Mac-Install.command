#!/bin/bash
# FileDrop — Hub (Jason's Office) macOS Installer
# Double-click in Finder to install.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$HOME/Applications/FileDrop"
PORT=5050

ARCH="$(uname -m)"
BIN_NAME="FileDrop-Hub-mac-$([ "$ARCH" = "arm64" ] && echo arm64 || echo x64)"
BIN_SRC="$SCRIPT_DIR/$BIN_NAME"

if [ ! -f "$BIN_SRC" ]; then
  echo "ERROR: Binary not found: $BIN_SRC"
  echo "Make sure $BIN_NAME is in the same folder as this script."
  read -p "Press Enter to exit."
  exit 1
fi

echo "Installing FileDrop Hub..."
echo "Architecture: $ARCH"
echo "Install path: $INSTALL_DIR"
echo ""

mkdir -p "$INSTALL_DIR"
cp "$BIN_SRC" "$INSTALL_DIR/FileDrop-Hub"
chmod +x "$INSTALL_DIR/FileDrop-Hub"

# Remove quarantine flag if present
xattr -d com.apple.quarantine "$INSTALL_DIR/FileDrop-Hub" 2>/dev/null || true

"$INSTALL_DIR/FileDrop-Hub" --install

echo ""
echo "FileDrop Hub installed."
echo "Opening setup wizard..."
sleep 2
open "http://localhost:$PORT/setup"

read -p "Press Enter to close."
