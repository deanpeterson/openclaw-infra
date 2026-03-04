#!/usr/bin/env bash
# ============================================================================
# CLEANUP LEGACY IN-PLACE GENERATED FILES
# ============================================================================
# One-time cleanup for users who ran the old setup.sh (before the generated/
# directory change). The old layout generated .yaml files in-place next to
# their .envsubst templates. The new layout outputs everything to generated/.
#
# This script finds every .envsubst template and deletes the corresponding
# in-place .yaml if it exists. Safe to run multiple times.
#
# Usage:
#   ./scripts/cleanup-legacy-generated.sh          # Dry run (show what would be deleted)
#   ./scripts/cleanup-legacy-generated.sh --delete  # Actually delete the files
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DELETE=false
if [[ "${1:-}" == "--delete" ]]; then
  DELETE=true
fi

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

COUNT=0

# Find every .envsubst template and check for its in-place generated counterpart
for tpl in $(find "$REPO_ROOT/agents" "$REPO_ROOT/platform" -name '*.envsubst' 2>/dev/null); do
  yaml="${tpl%.envsubst}"
  if [ -f "$yaml" ]; then
    rel="${yaml#$REPO_ROOT/}"
    if $DELETE; then
      rm "$yaml"
      echo -e "${GREEN}Deleted${NC} $rel"
    else
      echo -e "${YELLOW}Found${NC}   $rel"
    fi
    COUNT=$((COUNT + 1))
  fi
done

# Also clean up edge config artifacts
for f in \
  agents/openclaw/edge/openclaw.json \
  agents/openclaw/edge/openclaw-agent-config.yaml \
  agents/openclaw/edge/openclaw-agent-secret.yaml \
  agents/openclaw/edge/openclaw-agent-agents.yaml \
  agents/openclaw/edge/openclaw-agent-pod.yaml \
  agents/openclaw/edge/AGENTS.md; do
  if [ -f "$REPO_ROOT/$f" ]; then
    if $DELETE; then
      rm "$REPO_ROOT/$f"
      echo -e "${GREEN}Deleted${NC} $f"
    else
      echo -e "${YELLOW}Found${NC}   $f"
    fi
    COUNT=$((COUNT + 1))
  fi
done

for d in agents/openclaw/edge/config agents/openclaw/edge/generated; do
  if [ -d "$REPO_ROOT/$d" ]; then
    if $DELETE; then
      rm -rf "$REPO_ROOT/$d"
      echo -e "${GREEN}Deleted${NC} $d/"
    else
      echo -e "${YELLOW}Found${NC}   $d/"
    fi
    COUNT=$((COUNT + 1))
  fi
done

echo ""
if [ $COUNT -eq 0 ]; then
  echo "Nothing to clean up."
elif $DELETE; then
  echo "$COUNT legacy file(s) deleted."
else
  echo "$COUNT legacy file(s) found. Run with --delete to remove them:"
  echo "  ./scripts/cleanup-legacy-generated.sh --delete"
fi
