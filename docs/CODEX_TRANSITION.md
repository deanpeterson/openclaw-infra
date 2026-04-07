# Codex Transition Baseline

## Why this branch exists

Anthropic has disallowed the Claude Code subscription pattern we implemented through a custom OpenClaw skill/bridge. We are preserving that work on the `claude-code-subscription-archive` branch and moving forward on the official OpenAI Codex path.

## Official upstream pattern

Current OpenClaw docs now describe first-class Codex subscription support:

- `openclaw onboard --auth-choice openai-codex`
- `openclaw models auth login --provider openai-codex`
- default model path: `openai-codex/gpt-5.4`

Official references:

- OpenClaw OpenAI provider docs: https://docs.openclaw.ai/providers/openai
- OpenClaw OAuth docs: https://docs.openclaw.ai/concepts/oauth
- OpenAI Codex with ChatGPT plan: https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan

## What is true in our current deployment

Our current custom runtime is based on OpenClaw `2026.3.22`.

Evidence:

- live agent CLI reports `OpenClaw 2026.3.22`
- this repo currently contains no `openai-codex` support strings
- the current deployed path is still based around the custom Claude bridge image work

## Implication

This is not just a config flip.

We need an OpenClaw runtime upgrade to a version that includes the official `openai-codex` provider/auth flow. Only after that should we remove the custom Claude subscription bridge and switch agents to Codex-first auth and model config.

## Recommended migration sequence

1. Upgrade the OpenClaw runtime baseline to a version with official `openai-codex` support.
2. Validate `openclaw models auth login --provider openai-codex` in-cluster.
3. Change agent defaults from Claude-bridge-driven execution to `openai-codex/gpt-5.4`.
4. Remove Claude-specific secrets, mounts, bridge plugin dependence, and UI/settings flows.
5. Keep ordinary OpenAI API billing only where explicitly desired.

## Current branch strategy

- `claude-code-subscription-archive`: preserved legacy implementation
- `codex-subscription-main-driver`: migration work toward official Codex-first pattern
