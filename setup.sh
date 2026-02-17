#!/bin/bash

# Augment Code for OpenCode — Setup Script
# Installs the OpenCode plugin and configures authentication.
# No separate server process needed — the plugin embeds everything.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$SCRIPT_DIR/plugin"
OPENCODE_CONFIG_DIR="$HOME/.config/opencode"
OPENCODE_CONFIG_FILE="$OPENCODE_CONFIG_DIR/opencode.json"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║        Augment Code for OpenCode — Setup                   ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

# ─── Prerequisites ───────────────────────────────────────────────────────────

echo -e "${YELLOW}Checking prerequisites...${NC}"

# Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}✗ Node.js is not installed. Please install Node.js 20 or later.${NC}"
    exit 1
fi
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo -e "${RED}✗ Node.js 20+ required. Current: $(node -v)${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Node.js $(node -v)${NC}"

# OpenCode
if ! command -v opencode &> /dev/null; then
    echo -e "${YELLOW}⚠ OpenCode not found in PATH. Install from https://opencode.ai${NC}"
fi

# Auggie CLI
if ! command -v auggie &> /dev/null; then
    echo -e "${YELLOW}Auggie CLI not found. Installing...${NC}"
    npm install -g @augmentcode/auggie
fi
echo -e "${GREEN}✓ Auggie CLI installed${NC}"

# Authentication
if [ ! -f "$HOME/.augment/session.json" ]; then
    echo -e "${YELLOW}Not authenticated. Running 'auggie login'...${NC}"
    auggie login
fi
echo -e "${GREEN}✓ Auggie authenticated${NC}"

# ─── Build Plugin ────────────────────────────────────────────────────────────

echo ""
echo -e "${YELLOW}Building plugin...${NC}"
cd "$PLUGIN_DIR"
npm install
npm run build
echo -e "${GREEN}✓ Plugin built${NC}"

# ─── Configure OpenCode ─────────────────────────────────────────────────────

echo ""
echo -e "${YELLOW}Configuring OpenCode...${NC}"
mkdir -p "$OPENCODE_CONFIG_DIR"

if [ -f "$OPENCODE_CONFIG_FILE" ]; then
    # Check if plugin is already configured
    if grep -q "opencode-augment-auth\|$PLUGIN_DIR" "$OPENCODE_CONFIG_FILE" 2>/dev/null; then
        echo -e "${GREEN}✓ Plugin already configured in OpenCode${NC}"
    else
        # Backup and merge
        cp "$OPENCODE_CONFIG_FILE" "$OPENCODE_CONFIG_FILE.backup.$(date +%Y%m%d%H%M%S)"
        echo -e "${YELLOW}Backed up existing config${NC}"

        node -e "
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('$OPENCODE_CONFIG_FILE', 'utf-8'));
if (!config.plugin) config.plugin = [];
if (!config.plugin.includes('$PLUGIN_DIR')) {
  config.plugin.push('$PLUGIN_DIR');
}
fs.writeFileSync('$OPENCODE_CONFIG_FILE', JSON.stringify(config, null, 2));
console.log('Plugin added to OpenCode config');
"
        echo -e "${GREEN}✓ Plugin added to OpenCode config${NC}"
    fi
else
    cat > "$OPENCODE_CONFIG_FILE" << EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugin": ["$PLUGIN_DIR"],
  "model": "augment/claude-opus-4-6"
}
EOF
    echo -e "${GREEN}✓ Created OpenCode config${NC}"
fi

# ─── Auth Setup ──────────────────────────────────────────────────────────────

echo ""
echo -e "${YELLOW}Setting up authentication...${NC}"

AUTH_FILE="$HOME/.local/share/opencode/auth.json"
if [ -f "$AUTH_FILE" ] && grep -q '"augment"' "$AUTH_FILE" 2>/dev/null; then
    echo -e "${GREEN}✓ Auth already configured${NC}"
else
    mkdir -p "$(dirname "$AUTH_FILE")"
    if [ -f "$AUTH_FILE" ]; then
        node -e "
const fs = require('fs');
const auth = JSON.parse(fs.readFileSync('$AUTH_FILE', 'utf-8'));
auth.augment = { type: 'api', key: 'session' };
fs.writeFileSync('$AUTH_FILE', JSON.stringify(auth, null, 2));
console.log('Auth entry added');
"
    else
        echo '{"augment":{"type":"api","key":"session"}}' > "$AUTH_FILE"
    fi
    echo -e "${GREEN}✓ Auth configured${NC}"
fi

# ─── Done ────────────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                    Setup Complete!                         ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}Just run OpenCode — no server to start:${NC}"
echo -e "  opencode"
echo ""
echo -e "${BLUE}Available models (use augment/<model-id>):${NC}"
echo -e "  Claude:  claude-opus-4-6 (default), claude-opus-4-5, claude-sonnet-4-5,"
echo -e "           claude-sonnet-4, claude-haiku-4-5"
echo -e "  GPT:     gpt-5, gpt-5-1, gpt-5-2"
echo ""
echo -e "${BLUE}The plugin auto-configures everything:${NC}"
echo -e "  • Provider and models are registered automatically"
echo -e "  • An embedded server starts inside OpenCode (no separate process)"
echo -e "  • Authentication uses your existing auggie session"
echo ""
