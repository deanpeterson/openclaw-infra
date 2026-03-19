/**
 * Claude Code Bridge — OpenClaw Extension
 *
 * Provides 5 tools that let OpenClaw agents use Claude Code CLI
 * through a Max subscription. No proxy, no SDK dependency — just
 * spawns the CLI as a child process.
 *
 * Tools:
 *   claude_code_resume  — Smart resume: finds or starts session by taskLabel
 *   claude_code_query   — Explicit new/resume by session ID
 *   claude_code_sessions — List agent's sessions
 *   claude_code_fork    — Branch from existing session
 *   claude_code_kill    — Mark session done
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "./session-manager.ts";
import { parseStreamJson } from "./output-parser.ts";
import type { BridgeSession, ClaudeResult } from "./types.ts";

const sessionManager = new SessionManager();

// Default working directory for Claude Code sessions
const DEFAULT_CWD =
  process.env.OPENCLAW_WORKSPACE ||
  join(process.env.HOME || "/home/node", ".openclaw", "workspace");

// Timeout for Claude CLI invocations (10 minutes)
const CLI_TIMEOUT_MS = 10 * 60 * 1000;

// ── CLI Execution ──────────────────────────────────────────────

/**
 * Spawn claude CLI and collect stream-json output.
 */
function runClaude(
  prompt: string,
  options: { sessionId?: string; cwd?: string }
): Promise<ClaudeResult> {
  return new Promise((resolve) => {
    const args = ["-p", prompt, "--output-format", "stream-json"];

    // Resume existing session if we have a real (non-pending) session ID
    if (options.sessionId && !options.sessionId.startsWith("pending-")) {
      args.push("--resume", options.sessionId);
    }

    const cwd = options.cwd || DEFAULT_CWD;
    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const child = spawn("claude", args, {
      cwd,
      env: {
        ...process.env,
        // Ensure Claude Code uses the right home for credentials
        HOME: process.env.HOME || "/home/node",
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CLI_TIMEOUT_MS,
    });

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err) => {
      resolve({
        ok: false,
        text: `Claude CLI error: ${err.message}`,
        sessionId: options.sessionId || "",
        cost: 0,
        durationMs: 0,
        exitCode: -1,
      });
    });

    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");

      const result = parseStreamJson(stdout);
      result.exitCode = code ?? 1;

      if (!result.ok && stderr) {
        result.text = result.text || `Claude CLI failed: ${stderr.trim()}`;
        result.ok = false;
      }

      resolve(result);
    });
  });
}

// ── Tool Definitions ───────────────────────────────────────────

/**
 * OpenClaw extension entry point.
 * Called by the OpenClaw extension loader with the extension API.
 */
export default function register(api: any) {
  // ── claude_code_resume ─────────────────────────────────────
  api.registerTool({
    name: "claude_code_resume",
    description:
      "Send a prompt to Claude Code. Automatically resumes the most recent session " +
      "matching the taskLabel, or starts a new session if none exists. This is the " +
      "primary tool for interacting with Claude Code.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The prompt or message to send to Claude Code",
        },
        taskLabel: {
          type: "string",
          description:
            "Label for the task/conversation thread (e.g. 'fix-auth-bug', 'investigate-logs'). " +
            "Used to find and resume the right session automatically.",
        },
        agentId: {
          type: "string",
          description:
            "Your agent ID. Used to isolate sessions between agents.",
        },
      },
      required: ["prompt", "agentId"],
    },
    execute: async ({
      prompt,
      taskLabel,
      agentId,
    }: {
      prompt: string;
      taskLabel?: string;
      agentId: string;
    }) => {
      // Try to find an existing active session
      let session = sessionManager.findActive(agentId, taskLabel);
      let isNew = false;

      if (!session) {
        session = sessionManager.create(agentId, DEFAULT_CWD, taskLabel);
        isNew = true;
      }

      const result = await runClaude(prompt, {
        sessionId: session.sessionId,
        cwd: session.cwd,
      });

      // Update session with real session ID from CLI
      const realSessionId = result.sessionId || session.sessionId;
      sessionManager.update(session.sessionId, {
        sessionId: realSessionId,
        totalCost: result.cost,
        messageCount: 1,
        taskLabel: taskLabel || session.taskLabel,
        status: result.ok ? "active" : "error",
      });

      return {
        text: result.text,
        sessionId: realSessionId,
        isNewSession: isNew,
        cost: result.cost,
        durationMs: result.durationMs,
        ok: result.ok,
      };
    },
  });

  // ── claude_code_query ──────────────────────────────────────
  api.registerTool({
    name: "claude_code_query",
    description:
      "Send a prompt to Claude Code with explicit control: start a new session " +
      "or resume a specific session by ID. Use claude_code_resume instead for " +
      "automatic session management.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The prompt to send",
        },
        agentId: {
          type: "string",
          description: "Your agent ID",
        },
        sessionId: {
          type: "string",
          description:
            "Resume this specific session. Omit to start a new session.",
        },
        taskLabel: {
          type: "string",
          description: "Label for the new session (ignored when resuming)",
        },
      },
      required: ["prompt", "agentId"],
    },
    execute: async ({
      prompt,
      agentId,
      sessionId,
      taskLabel,
    }: {
      prompt: string;
      agentId: string;
      sessionId?: string;
      taskLabel?: string;
    }) => {
      let session: BridgeSession;

      if (sessionId) {
        // Resume specific session
        const existing = sessionManager.get(sessionId);
        if (!existing) {
          return { ok: false, text: `Session ${sessionId} not found` };
        }
        session = existing;
      } else {
        // New session
        session = sessionManager.create(agentId, DEFAULT_CWD, taskLabel);
      }

      const result = await runClaude(prompt, {
        sessionId: session.sessionId,
        cwd: session.cwd,
      });

      const realSessionId = result.sessionId || session.sessionId;
      sessionManager.update(session.sessionId, {
        sessionId: realSessionId,
        totalCost: result.cost,
        messageCount: 1,
        taskLabel: taskLabel || session.taskLabel,
        status: result.ok ? "active" : "error",
      });

      return {
        text: result.text,
        sessionId: realSessionId,
        cost: result.cost,
        durationMs: result.durationMs,
        ok: result.ok,
      };
    },
  });

  // ── claude_code_sessions ───────────────────────────────────
  api.registerTool({
    name: "claude_code_sessions",
    description:
      "List your Claude Code sessions with status, cost, and message count.",
    parameters: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          description: "Your agent ID",
        },
      },
      required: ["agentId"],
    },
    execute: async ({ agentId }: { agentId: string }) => {
      const sessions = sessionManager.listForAgent(agentId);
      return {
        count: sessions.length,
        sessions: sessions.map((s) => ({
          sessionId: s.sessionId,
          taskLabel: s.taskLabel || "(unlabeled)",
          status: s.status,
          messageCount: s.messageCount,
          totalCost: s.totalCost,
          createdAt: s.createdAt,
          lastUsedAt: s.lastUsedAt,
          forkedFrom: s.forkedFrom || null,
        })),
      };
    },
  });

  // ── claude_code_fork ───────────────────────────────────────
  api.registerTool({
    name: "claude_code_fork",
    description:
      "Fork an existing Claude Code session. Creates a new session that starts " +
      "with the same context as the original, then diverges. Useful when you want " +
      "to explore an alternative approach without losing the original thread.",
    parameters: {
      type: "object",
      properties: {
        sourceSessionId: {
          type: "string",
          description: "The session ID to fork from",
        },
        prompt: {
          type: "string",
          description: "First prompt for the forked session",
        },
        agentId: {
          type: "string",
          description: "Your agent ID",
        },
        taskLabel: {
          type: "string",
          description: "Label for the forked session",
        },
      },
      required: ["sourceSessionId", "prompt", "agentId"],
    },
    execute: async ({
      sourceSessionId,
      prompt,
      agentId,
      taskLabel,
    }: {
      sourceSessionId: string;
      prompt: string;
      agentId: string;
      taskLabel?: string;
    }) => {
      const source = sessionManager.get(sourceSessionId);
      if (!source) {
        return { ok: false, text: `Source session ${sourceSessionId} not found` };
      }

      const forked = sessionManager.fork(
        sourceSessionId,
        agentId,
        source.cwd,
        taskLabel
      );

      // Claude CLI --resume with a new conversation context:
      // We prepend fork context to the prompt
      const forkPrompt =
        `[Continuing from a previous conversation. The prior session was about: ${source.taskLabel || "general work"}]\n\n${prompt}`;

      const result = await runClaude(forkPrompt, {
        // Don't pass sourceSessionId — we want a NEW session that inherits context via prompt
        cwd: source.cwd,
      });

      const realSessionId = result.sessionId || forked.sessionId;
      sessionManager.update(forked.sessionId, {
        sessionId: realSessionId,
        totalCost: result.cost,
        messageCount: 1,
        taskLabel: taskLabel || `fork of ${source.taskLabel || sourceSessionId}`,
        status: result.ok ? "active" : "error",
      });

      return {
        text: result.text,
        sessionId: realSessionId,
        forkedFrom: sourceSessionId,
        cost: result.cost,
        durationMs: result.durationMs,
        ok: result.ok,
      };
    },
  });

  // ── claude_code_kill ───────────────────────────────────────
  api.registerTool({
    name: "claude_code_kill",
    description:
      "Mark a Claude Code session as done. The session can no longer be resumed " +
      "but its history is preserved for reference.",
    parameters: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "The session ID to mark as done",
        },
      },
      required: ["sessionId"],
    },
    execute: async ({ sessionId }: { sessionId: string }) => {
      const killed = sessionManager.kill(sessionId);
      if (!killed) {
        return { ok: false, text: `Session ${sessionId} not found` };
      }
      return { ok: true, text: `Session ${sessionId} marked as done` };
    },
  });
}
