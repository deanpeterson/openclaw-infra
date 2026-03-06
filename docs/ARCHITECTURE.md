# Architecture

## Overview

OpenClaw is a self-hosted gateway connecting chat apps (WhatsApp, Telegram, Discord, iMessage, and more) to AI agents. It ships with **Pi**, an AI agent runtime that handles tool use, sessions, memory, and reasoning. The Gateway hosts one or more Pi agents, each customized with their own persona, tool permissions, and model. This repo deploys OpenClaw on OpenShift, Kubernetes, and bare-metal edge machines — same agent runtime everywhere, different configurations per environment.

### How OpenClaw Works

```
Chat Apps (WhatsApp, Telegram, Discord, iMessage, ...)
        │
        ▼
   ┌─────────────┐
   │   Gateway    │  Single self-hosted process
   │   :18789     │  Source of truth for sessions, routing, channels
   └──────┬──────┘
          │
    ┌─────┼──────────────────────┐
    ▼     ▼                      ▼
  Pi    CLI / Web Control UI   Mobile Nodes
(agents)  (management)         (iOS/Android)
```

- **Gateway** — the central hub that bridges chat apps to agents, manages sessions and routing, and serves the web Control UI
- **Pi** — the agent runtime that ships with OpenClaw. All agents are Pi instances. When you customize an agent with AGENTS.md, tool allowlists, and a model config, you're configuring Pi — not replacing it
- **Agents** — customized Pi instances, each with their own identity (AGENTS.md), workspace, tools, model, and cron schedule

Pi is to agents what a web server is to sites: Pi is the engine, your AGENTS.md is the config.

## Deployment Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Developer/Operator (You)                                       │
└───┬─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│  OpenClaw Pod (Namespace: <prefix>-openclaw)                    │
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Agent Runtime                                             │ │
│  │  ┌──────────────────── ┐     ┌────────────────────┐        │ │
│  │  │  Shadowman/Lynx     │     │  Resource Optimizer│        │ │
│  │  │  (customizable)     │     │  Schedule: CronJob │        │ │
│  │  │  Model: configurable│     │  Model: in-cluster │        │ │
│  │  └──────────────────── ┘     └────────────────────┘        │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌──────────────┐ ┌────────────┐ ┌────────────────────────────┐ │
│  │  Gateway     │ │ A2A Bridge │ │  OTEL Collector Sidecar    │ │
│  │  :18789      │ │ :8080      │ │  (auto-injected)           │ │
│  └──────────────┘ └────────────┘ └────────────────────────────┘ │
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  AuthBridge (transparent zero-trust)                       │ │
│  │  ┌───────────┐ ┌─────────────────┐ ┌────────────────────┐  │ │
│  │  │  Envoy    │ │ Client          │ │ SPIFFE Helper      │  │ │
│  │  │  Proxy    │ │ Registration    │ │ (SPIRE CSI)        │  │ │
│  │  └───────────┘ └─────────────────┘ └────────────────────┘  │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  Sessions stored on PVC                                         │
│  Config: openclaw.json (ConfigMap → init container → PVC)       │
└────────────────────┬────────────────────────────────────────────┘
                     │
         ┌───────────┼───────────────┐
         ▼           ▼               ▼
┌──────────────┐ ┌────────────┐ ┌─────────────────┐
│ Model        │ │ Other      │ │ Keycloak        │
│ Providers    │ │ OpenClaw   │ │ (SPIFFE realm)  │
│ - Anthropic  │ │ Instances  │ │                 │
│ - Vertex AI  │ │ (via A2A)  │ │ Token exchange  │
│ - vLLM       │ │            │ │ + validation    │
└──────────────┘ └────────────┘ └─────────────────┘
```

## Key Components

### OpenClaw Gateway
- Single-pod deployment running all agents in one process
- WebSocket + HTTP multiplexed on port 18789
- Control UI (settings, sessions, agent management)
- WebChat interface for interacting with agents
- Cron scheduler for scheduled agent tasks

### Agent Workspaces
Each agent gets an isolated workspace on the PVC:
- `AGENTS.md` — agent identity and instructions
- `agent.json` — agent metadata (name, description, capabilities)
- `.env` — agent-specific credentials (e.g., K8s SA tokens)

### Config Lifecycle
```
.envsubst template  -->  generated/  -->  openclaw-config     (template intent)
(source of truth)       (envsubst)       (K8s ConfigMap)
                                               │
                                         init container
                                               │
                                               ▼
                                  PVC /home/node/.openclaw/openclaw.json
                                        (live config used by gateway)
```

Setup scripts build a `generated/` directory that mirrors the source tree with templates processed. Kustomize and kubectl apply run from `generated/`.

The `openclaw-config` ConfigMap is derived from templates and owned by `setup.sh`. The init container copies it to the PVC at startup, where the gateway reads and writes it at runtime.

To save live config changes (UI edits, `/bind` commands, agents added via `add-agent.sh`), use `./scripts/export-config.sh` to export a local copy from the running pod. When re-running `setup.sh`, the script detects drift between the live ConfigMap and the new template and prompts to preserve or reset. Use `--preserve-config` to skip the prompt.

### OpenTelemetry Observability
- `diagnostics-otel` plugin emits OTLP traces from the gateway
- Sidecar OTEL collector (auto-injected by OpenTelemetry Operator)
- Traces exported to MLflow for LLM-specific visualization
- W3C Trace Context propagation to downstream services (e.g., vLLM)

See [OBSERVABILITY.md](OBSERVABILITY.md) for details.

### A2A Cross-Namespace Communication
- A2A bridge sidecar translates Google A2A JSON-RPC to OpenClaw's OpenAI-compatible API
- AuthBridge (Envoy + SPIFFE + Keycloak) provides transparent zero-trust authentication
- Agent cards served at `/.well-known/agent.json` for discovery
- A2A skill teaches agents to discover and message remote instances using `curl` + `jq`

See [A2A-ARCHITECTURE.md](A2A-ARCHITECTURE.md) for the full design, message flow, and security model.

### Security
- Custom `openclaw-authbridge` SCC grants only AuthBridge capabilities (NET_ADMIN, NET_RAW, spc_t, CSI)
- Gateway container fully hardened: read-only root FS, all caps dropped, no privilege escalation
- ResourceQuota, PodDisruptionBudget, NetworkPolicy
- Token-based gateway auth + OAuth proxy (OpenShift)
- Exec allowlist mode (only `curl`, `jq` permitted)
- Per-agent tool allow/deny policies
- SPIFFE workload identity per namespace (cryptographic, auditable)

## Deployment Flow

```
1. setup.sh
   ├── Prompt for prefix, API keys
   ├── Generate secrets → .env
   ├── Build generated/ (rsync static + envsubst templates)
   ├── Create namespace
   ├── Deploy via kustomize overlay from generated/ (includes AuthBridge sidecars)
   ├── Create OAuthClient (OpenShift only)
   └── Install A2A skill into agent workspace

2. Grant SCC (OpenShift only)
   └── oc adm policy add-scc-to-user openclaw-authbridge -z openclaw-oauth-proxy -n <ns>

3. setup-agents.sh (optional)
   ├── Prompt for agent name customization
   ├── envsubst on agent templates → generated/
   ├── Deploy agent ConfigMaps from generated/
   ├── Set up RBAC (resource-optimizer SA)
   ├── Install agent identity files into workspaces
   └── Configure cron jobs
```

## Per-Agent Model Configuration

Each agent can use a different model provider:

```json
{
  "agents": {
    "defaults": {
      "model": { "primary": "local/openai/gpt-oss-20b" }
    },
    "list": [
      {
        "id": "prefix_lynx",
        "model": { "primary": "anthropic/claude-sonnet-4-6" }
      },
      {
        "id": "prefix_resource_optimizer"
      }
    ]
  }
}
```

Resolution order: agent-specific `model` → `agents.defaults.model.primary` → built-in default.

## Directory Structure Inside Pod

```
~/.openclaw/
├── openclaw.json                          # Gateway config (from ConfigMap)
├── agents/
│   ├── <prefix>_<name>/sessions/          # Session transcripts
│   └── <prefix>_resource_optimizer/sessions/
├── workspace-<prefix>_<name>/             # Agent workspace
│   ├── AGENTS.md
│   └── agent.json
├── workspace-<prefix>_resource_optimizer/
│   ├── AGENTS.md
│   ├── agent.json
│   └── .env                               # OC_TOKEN (K8s SA token)
├── skills/
│   └── a2a/SKILL.md                       # A2A cross-instance communication skill
├── cron/jobs.json                         # Cron job definitions
└── scripts/                               # Deployed scripts (resource-report.sh)
```
