#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

IMAGE_REF="${IMAGE_REF:-quay-quay-quay-test.apps.salamander.aimlworkbench.com/deanpeterson/openclaw:codex-main-driver}"
OPENCLAW_REF="${OPENCLAW_REF:-main}"
ENABLE_LEGACY_CLAUDE_BRIDGE="${ENABLE_LEGACY_CLAUDE_BRIDGE:-false}"

echo "Building OpenClaw image"
echo "  IMAGE_REF=$IMAGE_REF"
echo "  OPENCLAW_REF=$OPENCLAW_REF"
echo "  ENABLE_LEGACY_CLAUDE_BRIDGE=$ENABLE_LEGACY_CLAUDE_BRIDGE"

podman build \
  -f "$REPO_ROOT/Dockerfile" \
  -t "$IMAGE_REF" \
  --build-arg "OPENCLAW_REF=$OPENCLAW_REF" \
  --build-arg "ENABLE_LEGACY_CLAUDE_BRIDGE=$ENABLE_LEGACY_CLAUDE_BRIDGE" \
  "$REPO_ROOT"

echo "Pushing $IMAGE_REF"
podman push "$IMAGE_REF"

echo "Done"
