---
name: claude-code
description: Use Claude Code CLI for complex reasoning, coding, shell commands, and multi-step investigations
metadata: { "openclaw": { "emoji": "🧠", "requires": { "bins": ["claude"] } } }
---

# Claude Code Skill — Powerful Reasoning & Coding via Claude Code CLI

You have access to **Claude Code**, a full-featured AI coding assistant running as a CLI tool. It can read/write files, run shell commands, search codebases, and perform multi-step investigations — all through your Max subscription (no per-request API cost).

## When to Use Claude Code

**Use it for:**
- Multi-step coding tasks (write code, run tests, fix errors, iterate)
- Investigating complex issues (read logs, search code, trace execution paths)
- Shell command sequences that need reasoning between steps
- Refactoring, debugging, or reviewing code
- Any task that benefits from persistent context across multiple interactions

**Don't use it for:**
- Simple questions you can answer from your own knowledge
- Single-command operations (just use `exec` directly)
- Quick file reads (use your own tools)
- Tasks where the user wants instant responses (Claude Code adds latency)

## Tools Reference

### `claude_code_resume` (Primary — use this by default)

Sends a prompt to Claude Code. Automatically finds and resumes your most recent session matching the `taskLabel`, or starts a new one if none exists.

```
claude_code_resume({
  prompt: "Fix the authentication bug in src/auth.ts — the JWT validation is failing for expired tokens",
  taskLabel: "fix-auth-bug",
  agentId: "{{AGENT_ID}}"
})
```

**Always provide a `taskLabel`** — it's how sessions are tracked and resumed.

### `claude_code_query` (Explicit control)

Use when you need to explicitly start a new session or resume a specific session by ID.

```
// New session (no sessionId)
claude_code_query({
  prompt: "Analyze the performance bottleneck in the API gateway",
  agentId: "{{AGENT_ID}}",
  taskLabel: "perf-investigation"
})

// Resume specific session
claude_code_query({
  prompt: "What did you find?",
  agentId: "{{AGENT_ID}}",
  sessionId: "abc-123-def"
})
```

### `claude_code_sessions`

List your sessions to see what's active, costs, and message counts.

```
claude_code_sessions({ agentId: "{{AGENT_ID}}" })
```

### `claude_code_fork`

Branch from an existing session to explore an alternative approach without losing the original thread.

```
claude_code_fork({
  sourceSessionId: "abc-123-def",
  prompt: "Try a different approach — use Redis instead of in-memory caching",
  agentId: "{{AGENT_ID}}",
  taskLabel: "perf-redis-approach"
})
```

### `claude_code_kill`

Mark a session as done when you're finished with a task.

```
claude_code_kill({ sessionId: "abc-123-def" })
```

## Session Decision Tree

When the user sends a message:

1. **Is this continuing an existing task?** → Use `claude_code_resume` with the same `taskLabel`
2. **Is this a new task?** → Use `claude_code_resume` with a new `taskLabel`
3. **Do you want to try a different approach?** → Use `claude_code_fork` from the current session
4. **Is a task done?** → Use `claude_code_kill` to clean up

## How to Relay Results

When Claude Code returns a result:

- **Summarize** the key findings or actions taken — don't dump raw output
- **Quote specific code** if the user needs to see it
- **Report the sessionId** if the user might want to continue later
- **Mention cost** only if it was significant (> $0.10)

Example:

> Claude Code fixed the JWT validation in `src/auth.ts:47` — the issue was that `exp` was being compared as a string instead of a number. Tests pass now. (Session: abc-123, cost: $0.03)

## Cost Awareness

Each Claude Code invocation uses your Max subscription. While there's no per-request cost:

- Keep prompts focused and specific — avoid sending entire files when a line range suffices
- Use `claude_code_kill` to close sessions you're done with
- Check `claude_code_sessions` periodically to see accumulated costs
- Prefer one well-crafted prompt over many small back-and-forth messages

## Error Handling

| Error | Meaning | Action |
|-------|---------|--------|
| "Claude CLI error: spawn claude ENOENT" | Claude CLI not installed | Report to admin — the container image needs rebuilding |
| "Claude CLI failed" + stderr | CLI crashed or timed out | Retry once with a simpler prompt; if persistent, report |
| Session not found | Session was killed or never existed | Start a new session with `claude_code_resume` |
| Empty response | CLI produced no output | May be a network issue — retry once |

## Agent-Specific Usage Patterns

Your **SOUL.md** determines how aggressively you use Claude Code:

- **Concierge agents**: Use Claude Code as your primary brain. Route all complex reasoning through it. Relay results directly to the user.
- **Worker agents**: Use Claude Code selectively for coding, debugging, and multi-step investigations. Use simpler tools for straightforward tasks.

The skill is the same — your SOUL.md tells you when to reach for it.
