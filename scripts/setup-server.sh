#!/bin/bash
# ─── Forge Server Setup ──────────────────────────────────────────
# Run this on 192.168.12.111 to set up the Telegram bot as a service.
#
# Prerequisites:
#   - Node.js >= 18 installed
#   - Claude CLI installed at /usr/local/bin/claude
#   - gh CLI installed and authenticated
#   - This repo cloned to /home/zbonham/forge
#
# Usage:
#   cd /home/zbonham/forge
#   bash scripts/setup-server.sh

set -euo pipefail

FORGE_DIR="/home/zbonham/forge"
PROJECTS_DIR="/home/zbonham/projects"
SERVICE_FILE="scripts/forge-telegram.service"

echo "=== Forge Server Setup ==="

# 1. Create projects directory
echo "[1/5] Creating projects directory..."
mkdir -p "$PROJECTS_DIR"

# 2. Install npm dependencies
echo "[2/5] Installing dependencies..."
cd "$FORGE_DIR"
npm install

# 3. Create .env if it doesn't exist
if [ ! -f "$FORGE_DIR/.env" ]; then
  echo "[3/5] Creating .env file..."
  cat > "$FORGE_DIR/.env" << 'ENVEOF'
FORGE_TELEGRAM_TOKEN=your-bot-token-here
FORGE_TELEGRAM_CHAT=your-chat-id-here
FORGE_PROJECTS_DIR=/home/zbonham/projects
ENVEOF
  echo "  ** Edit $FORGE_DIR/.env with your actual token and chat ID **"
else
  echo "[3/5] .env already exists — skipping"
  # Ensure FORGE_PROJECTS_DIR is in .env
  if ! grep -q "FORGE_PROJECTS_DIR" "$FORGE_DIR/.env"; then
    echo "FORGE_PROJECTS_DIR=/home/zbonham/projects" >> "$FORGE_DIR/.env"
    echo "  Added FORGE_PROJECTS_DIR to .env"
  fi
fi

# 4. Install systemd service
echo "[4/5] Installing systemd service..."
sudo cp "$FORGE_DIR/$SERVICE_FILE" /etc/systemd/system/forge-telegram.service
sudo systemctl daemon-reload
sudo systemctl enable forge-telegram.service

# 5. Start the service
echo "[5/5] Starting service..."
sudo systemctl start forge-telegram.service

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Service status:"
sudo systemctl status forge-telegram.service --no-pager -l
echo ""
echo "Useful commands:"
echo "  sudo systemctl status forge-telegram    # Check status"
echo "  sudo systemctl restart forge-telegram   # Restart bot"
echo "  sudo journalctl -u forge-telegram -f    # Follow logs"
echo ""
echo "To add a project for the bot to manage:"
echo "  cd $PROJECTS_DIR"
echo "  git clone git@github.com:ZbOscar/my-project.git"
echo "  cd my-project && forge init"
echo ""
echo "Then in Telegram:"
echo "  /projects        — see available projects"
echo "  /target my-project — switch to it"
echo "  /status          — check it"
