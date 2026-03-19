#!/bin/sh
# Entrypoint for OpenClaw + Claude Code agent pods.
#
# If CLAUDE_PROXY_ENABLED=true and Claude Code credentials exist,
# starts claude-max-api-proxy in the background so the OpenClaw gateway
# can use the Claude subscription instead of per-request API billing.
#
# Each agent pod runs its own proxy with its own Claude session,
# giving every agent independent context, memory, and project state.

set -e

# Start Claude Code proxy if enabled and credentials are available
if [ "${CLAUDE_PROXY_ENABLED:-false}" = "true" ]; then
  CRED_FILE="$HOME/.claude/.credentials.json"

  if [ -f "$CRED_FILE" ]; then
    echo "[entrypoint] Starting claude-max-api-proxy on port ${CLAUDE_PROXY_PORT:-3456}..."

    # Verify claude CLI is available
    if command -v claude >/dev/null 2>&1; then
      # Start proxy in background
      claude-max-api --port "${CLAUDE_PROXY_PORT:-3456}" &
      PROXY_PID=$!
      echo "[entrypoint] Claude proxy started (PID $PROXY_PID)"

      # Give it a moment to bind
      sleep 2

      # Verify it's running
      if kill -0 $PROXY_PID 2>/dev/null; then
        echo "[entrypoint] Claude proxy ready at http://127.0.0.1:${CLAUDE_PROXY_PORT:-3456}"
      else
        echo "[entrypoint] WARNING: Claude proxy failed to start, falling back to direct API"
      fi
    else
      echo "[entrypoint] WARNING: claude CLI not found, skipping proxy"
    fi
  else
    echo "[entrypoint] No Claude credentials found at $CRED_FILE, skipping proxy"
  fi
fi

# Start the OpenClaw gateway (foreground)
echo "[entrypoint] Starting OpenClaw gateway..."
exec node openclaw.mjs gateway --allow-unconfigured
