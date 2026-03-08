#!/bin/bash

# AMC Showtime Monitor - macOS LaunchAgent Setup Script

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST_FILE="com.user.amc-showtime-monitor.plist"
LAUNCHAGENTS_DIR="$HOME/Library/LaunchAgents"

echo "🚀 Setting up AMC Showtime Monitor as a macOS LaunchAgent..."

# Check if bun is installed
if ! command -v bun &> /dev/null; then
    echo "❌ Bun is not installed. Please install it first:"
    echo "   curl -fsSL https://bun.sh/install | bash"
    exit 1
fi

# Get the actual path to bun
BUN_PATH=$(which bun)
echo "📍 Found bun at: $BUN_PATH"

# Create the logs directory
mkdir -p "$PROJECT_DIR/logs"

# Update the plist file with the correct paths
sed -e "s|/opt/homebrew/bin/bun|$BUN_PATH|g" \
    -e "s|PROJECT_DIR_PLACEHOLDER|$PROJECT_DIR|g" \
    "$PROJECT_DIR/$PLIST_FILE" > "$PROJECT_DIR/${PLIST_FILE}.tmp"

# Ensure LaunchAgents directory exists
mkdir -p "$LAUNCHAGENTS_DIR"

# Copy the plist file to LaunchAgents
cp "$PROJECT_DIR/${PLIST_FILE}.tmp" "$LAUNCHAGENTS_DIR/$PLIST_FILE"
rm "$PROJECT_DIR/${PLIST_FILE}.tmp"

echo "✅ Copied $PLIST_FILE to $LAUNCHAGENTS_DIR"

# Load the LaunchAgent
launchctl unload "$LAUNCHAGENTS_DIR/$PLIST_FILE" 2>/dev/null || true
launchctl load "$LAUNCHAGENTS_DIR/$PLIST_FILE"

echo "✅ LaunchAgent loaded and will keep the monitor worker running"
echo "📊 Check status with: launchctl list | grep amc-showtime-monitor"
echo "📋 View logs in: $PROJECT_DIR/logs/"
echo "🛑 To stop: launchctl unload $LAUNCHAGENTS_DIR/$PLIST_FILE"

echo "🎉 Setup complete!"
