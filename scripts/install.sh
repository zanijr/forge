#!/bin/bash
# Forge Installer — Linux / macOS / Windows (Git Bash)
# Usage: curl -sSL https://raw.githubusercontent.com/zanijr/forge/master/scripts/install.sh | bash
set -euo pipefail

REPO="zanijr/forge"
INSTALL_DIR="$HOME/.forge-tool"

# ─── Colors ───────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { echo -e "${BLUE}[forge]${NC} $1"; }
ok()    { echo -e "${GREEN}[forge]${NC} $1"; }
warn()  { echo -e "${YELLOW}[forge]${NC} $1"; }
fail()  { echo -e "${RED}[forge]${NC} $1"; exit 1; }

# ─── Detect OS ────────────────────────────────────────────────────
detect_os() {
  case "$(uname -s)" in
    Linux*)   OS="linux";;
    Darwin*)  OS="mac";;
    MINGW*|MSYS*|CYGWIN*) OS="windows";;
    *)        OS="unknown";;
  esac
  echo "$OS"
}

OS=$(detect_os)
info "Detected OS: $OS"

# ─── Check prerequisites ─────────────────────────────────────────
check_cmd() {
  if command -v "$1" &>/dev/null; then
    ok "$1 found: $(command -v "$1")"
    return 0
  else
    return 1
  fi
}

info "Checking prerequisites..."

# Node.js
if ! check_cmd node; then
  fail "Node.js not found. Install it first:
    Linux:   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
    macOS:   brew install node
    Windows: https://nodejs.org/en/download"
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  fail "Node.js 18+ required (found v$NODE_VERSION)"
fi

# npm
check_cmd npm || fail "npm not found"

# Git
check_cmd git || fail "git not found"

# GitHub CLI
if ! check_cmd gh; then
  warn "GitHub CLI (gh) not found. Installing..."
  case "$OS" in
    linux)
      if command -v apt &>/dev/null; then
        curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
        sudo apt update && sudo apt install gh -y
      else
        warn "Could not auto-install gh. See: https://cli.github.com/"
      fi
      ;;
    mac)
      if command -v brew &>/dev/null; then
        brew install gh
      else
        warn "Install Homebrew first, then: brew install gh"
      fi
      ;;
    windows)
      warn "Install gh from: https://cli.github.com/"
      warn "Or: winget install --id GitHub.cli"
      ;;
  esac
  check_cmd gh || fail "gh CLI is required. Install it and re-run."
fi

# Claude Code CLI
if ! check_cmd claude; then
  warn "Claude Code CLI not found. Installing..."
  npm install -g @anthropic-ai/claude-code 2>/dev/null || {
    warn "Could not install Claude Code globally. Trying with sudo..."
    sudo npm install -g @anthropic-ai/claude-code 2>/dev/null || {
      fail "Could not install Claude Code CLI. Install manually: npm install -g @anthropic-ai/claude-code"
    }
  }
  check_cmd claude || fail "Claude Code CLI is required."
fi

# tmux (optional — needed for remote workers on Linux)
if [ "$OS" = "linux" ]; then
  if ! check_cmd tmux; then
    warn "tmux not found — needed for remote worker support"
    warn "Install with: sudo apt install tmux"
  fi
fi

# ─── Check auth ───────────────────────────────────────────────────
info "Checking authentication..."

# gh auth
if ! gh auth status &>/dev/null; then
  warn "GitHub CLI not authenticated. Run: gh auth login"
fi

# claude auth
if ! claude --version &>/dev/null; then
  warn "Claude Code may need authentication. Run: claude login"
fi

# ─── Install Forge ────────────────────────────────────────────────
info "Installing Forge..."

if [ -d "$INSTALL_DIR" ]; then
  info "Updating existing installation..."
  cd "$INSTALL_DIR"
  git pull origin master 2>/dev/null || git pull origin main 2>/dev/null || true
else
  info "Cloning forge..."
  git clone "https://github.com/$REPO.git" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# Install dependencies
info "Installing dependencies..."
npm install --production=false 2>&1 | tail -3

# Build
info "Building..."
npm run build 2>&1

# Link globally
info "Linking forge command..."
npm link 2>&1 | tail -2

# ─── Verify ───────────────────────────────────────────────────────
echo ""
if command -v forge &>/dev/null; then
  ok "Forge installed successfully!"
  echo ""
  forge --version
  echo ""
  ok "Installation directory: $INSTALL_DIR"
  echo ""
  echo -e "${GREEN}Quick start:${NC}"
  echo "  cd your-project"
  echo "  forge plan \"Build the thing\""
  echo "  forge approve"
  echo "  forge build"
  echo "  forge status"
  echo ""
  echo -e "${GREEN}Or create a new project:${NC}"
  echo "  mkdir my-project && cd my-project"
  echo "  forge plan \"Description of what to build\""
  echo ""
  echo -e "${GREEN}MCP integration (Claude Code):${NC}"
  echo "  Add to ~/.mcp.json:"
  echo "  {"
  echo "    \"mcpServers\": {"
  echo "      \"forge\": {"
  echo "        \"command\": \"npx\","
  echo "        \"args\": [\"tsx\", \"$INSTALL_DIR/src/interfaces/mcp-server.ts\"]"
  echo "      }"
  echo "    }"
  echo "  }"
else
  fail "Installation completed but 'forge' command not found in PATH"
fi
