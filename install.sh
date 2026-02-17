#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$SCRIPT_DIR/plugin"
OPENCODE_CACHE="$HOME/.cache/opencode"
OPENCODE_CONFIG="$HOME/.config/opencode"

echo "=== openception installer ==="
echo ""

# 1. Build the plugin
echo "[1/4] Building opencode-brain plugin..."
cd "$PLUGIN_DIR"
npm install --ignore-scripts 2>/dev/null || npm install
npm run build
echo "  Built successfully."

# 2. Pack and install to opencode cache
echo "[2/4] Installing plugin to opencode cache..."
TARBALL=$(npm pack --silent 2>/dev/null || npm pack)
cd "$OPENCODE_CACHE"
npm install "$PLUGIN_DIR/$TARBALL" 2>/dev/null

# Fix the file: URI that npm creates — opencode's plugin resolver needs valid semver
PLUGIN_VERSION=$(node -p "require('$PLUGIN_DIR/package.json').version")
cd "$SCRIPT_DIR"
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('$OPENCODE_CACHE/package.json', 'utf8'));
pkg.dependencies['opencode-brain'] = '$PLUGIN_VERSION';
fs.writeFileSync('$OPENCODE_CACHE/package.json', JSON.stringify(pkg, null, 2) + '\n');
"
rm -f "$PLUGIN_DIR/$TARBALL"
echo "  Installed opencode-brain@$PLUGIN_VERSION"

# 3. Add plugin to opencode.jsonc if not present
echo "[3/4] Checking opencode.jsonc plugin list..."
OPENCODE_JSONC="$OPENCODE_CONFIG/opencode.jsonc"
if [ -f "$OPENCODE_JSONC" ]; then
  if ! grep -q '"opencode-brain' "$OPENCODE_JSONC"; then
    # Insert after the last existing plugin entry
    node -e "
const fs = require('fs');
let content = fs.readFileSync('$OPENCODE_JSONC', 'utf8');
// Find the plugin array and add our entry before the closing bracket
content = content.replace(
  /(\"plugin\":\s*\[[\s\S]*?)(]\s*,)/,
  '\$1,\n    \"opencode-brain@$PLUGIN_VERSION\"\$2'
);
fs.writeFileSync('$OPENCODE_JSONC', content);
"
    echo "  Added opencode-brain@$PLUGIN_VERSION to plugin list."
  else
    echo "  Plugin already in opencode.jsonc."
  fi
else
  echo "  WARNING: $OPENCODE_JSONC not found. Add \"opencode-brain@$PLUGIN_VERSION\" to your plugin list manually."
fi

# 4. Copy OMO config if not present
echo "[4/4] Checking OMO config..."
OMO_JSON="$OPENCODE_CONFIG/oh-my-opencode.json"
OMO_JSONC="$OPENCODE_CONFIG/oh-my-opencode.jsonc"
if [ ! -f "$OMO_JSON" ] && [ ! -f "$OMO_JSONC" ]; then
  if [ -f "$SCRIPT_DIR/configs/oh-my-opencode.json" ]; then
    cp "$SCRIPT_DIR/configs/oh-my-opencode.json" "$OMO_JSON"
    cp "$SCRIPT_DIR/configs/oh-my-opencode.jsonc" "$OMO_JSONC" 2>/dev/null || true
    echo "  Copied OMO config."
  fi
else
  echo "  OMO config already exists (not overwriting)."
fi

echo ""
echo "=== Done. Restart opencode for changes to take effect. ==="
