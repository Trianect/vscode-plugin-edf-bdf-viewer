#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# ── helpers ────────────────────────────────────────────────────────────────
log()  { echo "▸ $*"; }
fail() { echo "✖ $*" >&2; exit 1; }
ok()   { echo "✔ $*"; }

# ── prerequisites ──────────────────────────────────────────────────────────
log "Checking prerequisites..."
command -v node  >/dev/null 2>&1 || fail "node not found – install Node.js 18+"
command -v npm   >/dev/null 2>&1 || fail "npm not found"

NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
(( NODE_MAJOR >= 18 )) || fail "Node.js 18+ required (found v$(node -v))"
ok "Node.js $(node -v)"

# ── install dependencies ───────────────────────────────────────────────────
log "Installing dependencies..."
npm install --prefer-offline 2>&1 | grep -v "^npm warn" || true
ok "Dependencies installed"

# ── clean ──────────────────────────────────────────────────────────────────
log "Cleaning output directory..."
rm -rf "$ROOT/out"
ok "Cleaned out/"

# ── compile ────────────────────────────────────────────────────────────────
log "Compiling TypeScript..."
npm run compile
ok "Compilation succeeded"

# ── package ───────────────────────────────────────────────────────────────
log "Packaging extension..."
npx vsce package --no-git-tag-version --out "$ROOT" 2>&1

VSIX=$(ls -t "$ROOT"/*.vsix 2>/dev/null | head -1)
[[ -n "$VSIX" ]] || fail "No .vsix file produced"
ok "Package ready: $(basename "$VSIX")"

echo ""
echo "  To install locally:"
echo "  code --install-extension \"$VSIX\""
