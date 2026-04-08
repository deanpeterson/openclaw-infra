# OpenClaw Gateway - UBI 9 multi-stage build (with Playwright browser support)
# Clones source from GitHub, builds, and produces a runtime image with Chromium
# for full browser automation via OpenClaw's browser tool.
#
# Build:
#   podman build -t openclaw:latest .
#   podman build --build-arg OPENCLAW_REF=v1.2.3 -t openclaw:v1.2.3 .
#   podman build --build-arg OPENCLAW_EXTENSIONS="diagnostics-otel" -t openclaw:latest .

# Global ARGs — available to all stages (re-declare inside stage to use)
ARG OPENCLAW_REPO=https://github.com/openclaw/openclaw.git
ARG OPENCLAW_REF=main
ARG ENABLE_LEGACY_CLAUDE_BRIDGE=false
# Opt-in extensions at build time (space-separated directory names).
# When empty (default), no extensions are included (matching upstream).
# Example: --build-arg OPENCLAW_EXTENSIONS="diagnostics-otel memory-core telegram"
ARG OPENCLAW_EXTENSIONS=""

# ── Stage 1: Build ──────────────────────────────────────────────
FROM registry.access.redhat.com/ubi9/nodejs-22 AS build

ARG OPENCLAW_REPO
ARG OPENCLAW_REF
ARG OPENCLAW_EXTENSIONS

WORKDIR /opt/app-root/src

# Clone the source from GitHub
USER 0
RUN dnf install -y --disablerepo='*' --enablerepo='ubi-*' git && dnf clean all
USER 1001
RUN echo "Cloning ${OPENCLAW_REPO} @ ${OPENCLAW_REF}" && \
    git clone --depth 1 --branch "${OPENCLAW_REF}" "${OPENCLAW_REPO}" /tmp/openclaw && \
    cp -a /tmp/openclaw/. . && \
    rm -rf /tmp/openclaw

# Prune extensions that have external dependencies (would bloat pnpm install).
# Extensions with no deps (memory-core, telegram, slack, etc.) are kept — they're
# just source files loaded at runtime, matching what upstream ships by default.
# Use OPENCLAW_EXTENSIONS to opt-in extensions that need deps (e.g. diagnostics-otel).
RUN if [ "${OPENCLAW_EXTENSIONS}" != "all" ]; then \
      keep=" $OPENCLAW_EXTENSIONS " && \
      for ext in extensions/*/; do \
        [ ! -f "$ext/package.json" ] && continue; \
        name="$(basename "$ext")"; \
        has_deps=$(node -e "const d=require('./$ext/package.json').dependencies||{}; process.exit(Object.keys(d).length>0?0:1)" 2>/dev/null && echo yes || echo no); \
        if [ "$has_deps" = "yes" ]; then \
          case "$keep" in \
            *" $name "*) ;; \
            *) rm -rf "$ext" ;; \
          esac; \
        fi; \
      done; \
    fi

# Install the exact pnpm version declared in package.json
USER 0
RUN PNPM_VERSION=$(node -p "require('./package.json').packageManager?.split('@')[1] || '10'") && \
    npm install -g "pnpm@$PNPM_VERSION" && \
    chown -R 1001:0 /opt/app-root/src/.npm
USER 1001

# Install dependencies without running postinstall scripts,
# then selectively rebuild only the native addons the gateway needs.
# node-llama-cpp is skipped: it requires cmake and llama.cpp compilation
# for local LLM inference, which is not needed in a gateway deployment
# that connects to remote model providers.
RUN NODE_OPTIONS=--max-old-space-size=2048 pnpm install --frozen-lockfile --ignore-scripts && \
    pnpm rebuild esbuild sharp koffi protobufjs

# Build the A2UI canvas bundle. If this fails (e.g. cross-platform
# QEMU builds), create a stub so the build script's fallback succeeds.
RUN pnpm canvas:a2ui:bundle || \
    (echo "A2UI bundle: creating stub (non-fatal)" && \
     mkdir -p src/canvas-host/a2ui && \
     echo "/* A2UI bundle unavailable in this build */" > src/canvas-host/a2ui/a2ui.bundle.js && \
     echo "stub" > src/canvas-host/a2ui/.bundle.hash && \
     rm -rf vendor/a2ui apps/shared/OpenClawKit/Tools/CanvasA2UI)
RUN pnpm build

ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

# ── Stage 2: Runtime (with Playwright + Chromium) ─────────────
# Using full UBI 9 nodejs-22 (not minimal) because Chromium requires
# many shared libraries that are not available in the minimal image.
FROM registry.access.redhat.com/ubi9/nodejs-22

ARG ENABLE_LEGACY_CLAUDE_BRIDGE

LABEL org.opencontainers.image.source="https://github.com/deanpeterson/openclaw-infra" \
      org.opencontainers.image.title="OpenClaw (UBI 9 + Browser)" \
      org.opencontainers.image.description="OpenClaw gateway on UBI 9 Node.js 22 with Playwright Chromium. Legacy Claude bridge is optional on the Codex migration branch."

WORKDIR /app

# Install Chromium runtime dependencies.
# Playwright does not officially support RPM-based distros, so we install
# the shared libraries Chromium needs manually instead of using --with-deps.
USER 0
RUN dnf install -y --disablerepo='*' --enablerepo='ubi-*' \
        alsa-lib \
        at-spi2-atk \
        at-spi2-core \
        atk \
        cairo \
        cups-libs \
        dbus-libs \
        expat \
        gdk-pixbuf2 \
        glib2 \
        gtk3 \
        libX11 \
        libXcomposite \
        libXdamage \
        libXext \
        libXfixes \
        libXrandr \
        libXtst \
        libdrm \
        libgcc \
        libstdc++ \
        libxcb \
        libxkbcommon \
        libxshmfence \
        mesa-libgbm \
        nspr \
        nss \
        nss-util \
        pango \
        zlib \
        libicu \
        libjpeg-turbo \
        libwebp \
    && dnf clean all

# Create node user (uid 1000) matching upstream openclaw image.
RUN useradd -u 1000 -g 0 -d /home/node -m node && \
    chown node:0 /app

COPY --from=build --chown=node:0 /opt/app-root/src/dist ./dist
COPY --from=build --chown=node:0 /opt/app-root/src/node_modules ./node_modules
COPY --from=build --chown=node:0 /opt/app-root/src/package.json .
COPY --from=build --chown=node:0 /opt/app-root/src/openclaw.mjs .
COPY --from=build --chown=node:0 /opt/app-root/src/extensions ./extensions
COPY --from=build --chown=node:0 /opt/app-root/src/docs ./docs

# Normalize extension permissions (plugin safety checks reject world-writable dirs)
RUN find /app/extensions -type d -exec chmod 755 {} + 2>/dev/null; \
    find /app/extensions -type f -exec chmod 644 {} + 2>/dev/null; \
    true

# Expose CLI binary without requiring npm global writes as non-root
RUN ln -sf /app/openclaw.mjs /usr/local/bin/openclaw && \
    chmod 755 /app/openclaw.mjs

# Install Playwright Chromium browser binary.
# Use OpenClaw's bundled playwright-core CLI to avoid npm version conflicts.
# Store browsers in a shared path accessible to the node user.
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
RUN mkdir -p $PLAYWRIGHT_BROWSERS_PATH && \
    chown -R node:0 $PLAYWRIGHT_BROWSERS_PATH && \
    chmod -R g=u $PLAYWRIGHT_BROWSERS_PATH

USER node
RUN node /app/node_modules/playwright-core/cli.js install chromium

USER 0

# Optional legacy bridge for the archived Claude subscription path.
RUN if [ "$ENABLE_LEGACY_CLAUDE_BRIDGE" = "true" ]; then \
      npm install -g @anthropic-ai/claude-code 2>/dev/null || true; \
    fi

# Pre-create state directories with OpenShift-compatible perms (group 0 = root group)
# Each agent gets its own PVC mounted at /home/node, so .openclaw/ and .claude/
# persist across restarts with independent session state.
RUN mkdir -p /home/node/.openclaw /home/node/.claude && \
    chown -R node:0 /home/node && \
    chmod -R g=u /home/node

USER node

ENV NODE_ENV=production
ENV HOME=/home/node

COPY --chown=node:0 extensions/claude-code-bridge /app/extensions/claude-code-bridge
RUN if [ "$ENABLE_LEGACY_CLAUDE_BRIDGE" != "true" ]; then \
      rm -rf /app/extensions/claude-code-bridge; \
    fi

EXPOSE 18789

HEALTHCHECK --interval=3m --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:18789/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
