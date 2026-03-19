/**
 * Claude Code Bridge — shared types
 */

export interface BridgeSession {
  /** Unique session ID (from Claude CLI or generated) */
  sessionId: string;
  /** Agent that owns this session */
  agentId: string;
  /** Human-readable label for session lookup */
  taskLabel?: string;
  /** Working directory for this session */
  cwd: string;
  /** Session state */
  status: "active" | "done" | "error";
  /** When the session was created */
  createdAt: string;
  /** When the session was last used */
  lastUsedAt: string;
  /** Total messages exchanged */
  messageCount: number;
  /** Total cost reported by Claude CLI (USD) */
  totalCost: number;
  /** Session ID this was forked from, if any */
  forkedFrom?: string;
}

export interface SessionIndex {
  /** Schema version for forward compat */
  version: 1;
  /** All tracked sessions */
  sessions: BridgeSession[];
}

/** A single result message parsed from Claude CLI stream-json output */
export interface ClaudeResult {
  /** Whether the CLI exited successfully */
  ok: boolean;
  /** The final assistant text (concatenated from result messages) */
  text: string;
  /** Session ID reported by the CLI */
  sessionId: string;
  /** Cost in USD for this invocation */
  cost: number;
  /** Duration in ms */
  durationMs: number;
  /** Raw exit code */
  exitCode: number;
}

/** JSON event from --output-format stream-json */
export interface StreamJsonEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
  };
  result?: string;
  [key: string]: unknown;
}
