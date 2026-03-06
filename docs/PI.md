# Pi — The Agent Engine Behind OpenClaw

## What is Pi?

Pi is a standalone TypeScript AI agent toolkit created by **Mario Zechner** (creator of the [libGDX](https://libgdx.com/) game framework). It lives in its own repo at [badlogic/pi-mono](https://github.com/badlogic/pi-mono) — it is **not** part of the OpenClaw organization. OpenClaw embeds Pi; it doesn't own it.

**License:** MIT (same as OpenClaw)

## Philosophy

Mario built Pi when he got frustrated with Claude Code's growing complexity. Pi ships with exactly **4 tools** (read, write, edit, bash) and a system prompt under 1,000 tokens. The philosophy: what you leave out matters more than what you put in. Extend via TypeScript extensions, skills, and prompt templates — not forks.

## Package Stack

Pi is a monorepo of layered packages published under `@mariozechner/` on npm:

| Package | What it does |
|---------|-------------|
| `pi-ai` | Unified LLM API — multi-provider (Anthropic, OpenAI, Google, xAI, Groq, Cerebras, OpenRouter, and any OpenAI-compatible endpoint), streaming, tool calling, cost tracking |
| `pi-agent-core` | Stateful agent loop + tool execution engine |
| `pi-coding-agent` | Full coding agent with built-in tools (read, write, edit, bash), session persistence, extensibility |
| `pi-tui` | Terminal UI components for building CLI interfaces |

## Relationship to OpenClaw

OpenClaw **embeds** Pi directly — it imports `createAgentSession()` from `@mariozechner/pi-coding-agent` rather than spawning Pi as a subprocess. This gives OpenClaw full control over session lifecycle, event handling, and tool injection.

OpenClaw adds the gateway layer on top of Pi's agent engine:
- Multi-channel messaging (WhatsApp, Telegram, Discord, iMessage)
- Session routing and isolation
- Web Control UI
- Cron scheduling
- Multi-agent routing

When you create an agent in OpenClaw with AGENTS.md, tool allowlists, and a model config, you're configuring a Pi instance — not replacing it. All OpenClaw agents are Pi agents under the hood.

There is an active [RFC discussion (#5536)](https://github.com/openclaw/openclaw/discussions/5536) to generalize the runtime beyond Pi, so other agent backends (like Claude Code SDK) could be swapped in.

## Links

- [Pi mono repo (badlogic/pi-mono)](https://github.com/badlogic/pi-mono)
- [Pi website](https://shittycodingagent.ai/)
- [OpenClaw Pi docs](https://github.com/openclaw/openclaw/blob/main/docs/pi.md)
- [Mario's blog: What I learned building a minimal coding agent](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)
- [Nader's guide: Building with PI](https://nader.substack.com/p/how-to-build-a-custom-agent-framework)
