#!/bin/bash

# Auggie Wrapper Setup Script
# This script installs dependencies and configures OpenCode to use the Augment provider

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENCODE_CONFIG_DIR="$HOME/.config/opencode"
OPENCODE_CONFIG_FILE="$OPENCODE_CONFIG_DIR/opencode.json"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║           Auggie Wrapper Setup Script                      ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check Node.js version
echo -e "${YELLOW}Checking Node.js version...${NC}"
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is not installed. Please install Node.js 22 or later.${NC}"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
    echo -e "${RED}Error: Node.js 22 or later is required. Current version: $(node -v)${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Node.js $(node -v) detected${NC}"

# Check if auggie is installed and authenticated
echo -e "${YELLOW}Checking Auggie CLI...${NC}"
if ! command -v auggie &> /dev/null; then
    echo -e "${YELLOW}Auggie CLI not found. Installing...${NC}"
    npm install -g @augmentcode/auggie
fi
echo -e "${GREEN}✓ Auggie CLI installed${NC}"

# Check for authentication
if [ ! -f "$HOME/.augment/session.json" ]; then
    echo -e "${YELLOW}Auggie not authenticated. Please run 'auggie login' first.${NC}"
    echo -e "${YELLOW}Running auggie login...${NC}"
    auggie login
fi
echo -e "${GREEN}✓ Auggie authenticated${NC}"

# Install npm dependencies
echo -e "${YELLOW}Installing npm dependencies...${NC}"
cd "$SCRIPT_DIR"
npm install
echo -e "${GREEN}✓ Dependencies installed${NC}"

# Configure OpenCode
echo -e "${YELLOW}Configuring OpenCode...${NC}"

# Create config directory if it doesn't exist
mkdir -p "$OPENCODE_CONFIG_DIR"

# Augment provider configuration - All models
if [ -f "$OPENCODE_CONFIG_FILE" ]; then
    # Check if augment provider already exists
    if grep -q '"augment"' "$OPENCODE_CONFIG_FILE" 2>/dev/null; then
        echo -e "${GREEN}✓ Augment provider already configured in OpenCode${NC}"
    else
        # Backup existing config
        cp "$OPENCODE_CONFIG_FILE" "$OPENCODE_CONFIG_FILE.backup.$(date +%Y%m%d%H%M%S)"
        echo -e "${YELLOW}Backed up existing config${NC}"

        # Use node to merge the configuration
        node -e "
const fs = require('fs');
const configPath = '$OPENCODE_CONFIG_FILE';
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

if (!config.provider) {
  config.provider = {};
}

config.provider.augment = {
  npm: '@ai-sdk/openai-compatible',
  name: 'Augment Code',
  options: {
    baseURL: 'http://localhost:8765/v1'
  },
  models: {
    'claude-opus-4.5': {
      name: 'Claude Opus 4.5 (Augment)',
      limit: { context: 200000, output: 32000 }
    },
    'claude-sonnet-4.5': {
      name: 'Claude Sonnet 4.5 (Augment)',
      limit: { context: 200000, output: 16000 }
    },
    'claude-sonnet-4': {
      name: 'Claude Sonnet 4 (Augment)',
      limit: { context: 200000, output: 16000 }
    },
    'claude-haiku-4.5': {
      name: 'Claude Haiku 4.5 (Augment)',
      limit: { context: 200000, output: 8000 }
    },
    'gpt-5': {
      name: 'GPT-5 (Augment)',
      limit: { context: 128000, output: 16000 }
    },
    'gpt-5.1': {
      name: 'GPT-5.1 (Augment)',
      limit: { context: 128000, output: 16000 }
    },
    'gpt-5.2': {
      name: 'GPT-5.2 (Augment)',
      limit: { context: 128000, output: 16000 }
    }
  }
};

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('Configuration merged successfully');
"
        echo -e "${GREEN}✓ Augment provider added to existing OpenCode config${NC}"
    fi
else
    # Create new config file
    cat > "$OPENCODE_CONFIG_FILE" << 'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "augment": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Augment Code",
      "options": {
        "baseURL": "http://localhost:8765/v1"
      },
      "models": {
        "claude-opus-4.5": {
          "name": "Claude Opus 4.5 (Augment)",
          "limit": { "context": 200000, "output": 32000 }
        },
        "claude-sonnet-4.5": {
          "name": "Claude Sonnet 4.5 (Augment)",
          "limit": { "context": 200000, "output": 16000 }
        },
        "claude-sonnet-4": {
          "name": "Claude Sonnet 4 (Augment)",
          "limit": { "context": 200000, "output": 16000 }
        },
        "claude-haiku-4.5": {
          "name": "Claude Haiku 4.5 (Augment)",
          "limit": { "context": 200000, "output": 8000 }
        },
        "gpt-5": {
          "name": "GPT-5 (Augment)",
          "limit": { "context": 128000, "output": 16000 }
        },
        "gpt-5.1": {
          "name": "GPT-5.1 (Augment)",
          "limit": { "context": 128000, "output": 16000 }
        },
        "gpt-5.2": {
          "name": "GPT-5.2 (Augment)",
          "limit": { "context": 128000, "output": 16000 }
        }
      }
    }
  }
}
EOF
    echo -e "${GREEN}✓ Created new OpenCode config with Augment provider${NC}"
fi

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                    Setup Complete!                         ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}To start the server:${NC}"
echo -e "  cd $SCRIPT_DIR"
echo -e "  npm start"
echo ""
echo -e "${BLUE}Available models in OpenCode:${NC}"
echo -e "  Claude models:"
echo -e "  - augment/claude-opus-4.5     (default, recommended)"
echo -e "  - augment/claude-sonnet-4.5"
echo -e "  - augment/claude-sonnet-4"
echo -e "  - augment/claude-haiku-4.5"
echo -e "  GPT models:"
echo -e "  - augment/gpt-5"
echo -e "  - augment/gpt-5.1"
echo -e "  - augment/gpt-5.2"
echo ""
echo -e "${BLUE}To use with OpenCode:${NC}"
echo -e "  1. Start the server (npm start)"
echo -e "  2. Run OpenCode"
echo -e "  3. Type /models and select an augment/* model"
echo ""

