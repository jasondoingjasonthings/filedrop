#!/bin/bash
# FileDrop macOS Uninstaller (removes both Jason and Editor if present)
# Double-click this file in Finder to uninstall.

INSTALL_DIR="$HOME/Applications/FileDrop"

echo "Uninstalling FileDrop..."

for EXE in "$INSTALL_DIR/FileDrop-Jason" "$INSTALL_DIR/FileDrop-Editor"; do
  if [ -f "$EXE" ]; then
    echo "Stopping and removing service for $EXE..."
    "$EXE" --uninstall 2>/dev/null || true
  fi
done

if [ -d "$INSTALL_DIR" ]; then
  rm -rf "$INSTALL_DIR"
  echo "Removed $INSTALL_DIR"
fi

echo ""
echo "FileDrop has been uninstalled."
echo "Your config and data files (if any) were NOT removed."
echo "To remove data, delete: ~/Library/Application Support/FileDrop"

read -p "Press Enter to close this window."
