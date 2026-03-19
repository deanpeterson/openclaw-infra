/**
 * Session Manager — file-backed session persistence for Claude Code Bridge.
 *
 * Each agent gets isolated sessions tracked by agentId.
 * Sessions are stored at ~/.claude/bridge-sessions.json and survive restarts.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BridgeSession, SessionIndex } from "./types.ts";

const DEFAULT_INDEX_PATH = join(
  process.env.HOME || "/home/node",
  ".claude",
  "bridge-sessions.json"
);

export class SessionManager {
  private indexPath: string;
  private index: SessionIndex;

  constructor(indexPath?: string) {
    this.indexPath = indexPath || DEFAULT_INDEX_PATH;
    this.index = this.load();
  }

  /** Load the session index from disk, or create an empty one. */
  private load(): SessionIndex {
    try {
      const raw = readFileSync(this.indexPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed.version === 1 && Array.isArray(parsed.sessions)) {
        return parsed as SessionIndex;
      }
    } catch {
      // File doesn't exist or is corrupt — start fresh
    }
    return { version: 1, sessions: [] };
  }

  /** Persist the current index to disk. */
  private save(): void {
    try {
      mkdirSync(dirname(this.indexPath), { recursive: true });
      writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2));
    } catch (err) {
      console.error("[claude-code-bridge] Failed to save session index:", err);
    }
  }

  /** Find the most recent active session for an agent, optionally matching a taskLabel. */
  findActive(agentId: string, taskLabel?: string): BridgeSession | undefined {
    const candidates = this.index.sessions.filter(
      (s) => s.agentId === agentId && s.status === "active"
    );

    if (taskLabel) {
      const byLabel = candidates.find((s) => s.taskLabel === taskLabel);
      if (byLabel) return byLabel;
    }

    // Return most recently used
    return candidates.sort(
      (a, b) =>
        new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime()
    )[0];
  }

  /** Get a session by its sessionId. */
  get(sessionId: string): BridgeSession | undefined {
    return this.index.sessions.find((s) => s.sessionId === sessionId);
  }

  /** List all sessions for an agent. */
  listForAgent(agentId: string): BridgeSession[] {
    return this.index.sessions
      .filter((s) => s.agentId === agentId)
      .sort(
        (a, b) =>
          new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime()
      );
  }

  /** Create a new session record. Returns the session (sessionId may be placeholder until CLI reports real one). */
  create(
    agentId: string,
    cwd: string,
    taskLabel?: string
  ): BridgeSession {
    const now = new Date().toISOString();
    const session: BridgeSession = {
      sessionId: `pending-${randomUUID()}`,
      agentId,
      taskLabel,
      cwd,
      status: "active",
      createdAt: now,
      lastUsedAt: now,
      messageCount: 0,
      totalCost: 0,
    };
    this.index.sessions.push(session);
    this.save();
    return session;
  }

  /** Update a session after a CLI invocation completes. */
  update(
    pendingOrSessionId: string,
    updates: Partial<
      Pick<
        BridgeSession,
        "sessionId" | "status" | "totalCost" | "messageCount" | "taskLabel"
      >
    >
  ): BridgeSession | undefined {
    const session = this.index.sessions.find(
      (s) => s.sessionId === pendingOrSessionId
    );
    if (!session) return undefined;

    if (updates.sessionId && updates.sessionId !== session.sessionId) {
      session.sessionId = updates.sessionId;
    }
    if (updates.status) session.status = updates.status;
    if (updates.totalCost != null) session.totalCost += updates.totalCost;
    if (updates.messageCount != null) session.messageCount += updates.messageCount;
    if (updates.taskLabel) session.taskLabel = updates.taskLabel;
    session.lastUsedAt = new Date().toISOString();

    this.save();
    return session;
  }

  /** Fork a session — creates a new session record referencing the original. */
  fork(
    originalSessionId: string,
    agentId: string,
    cwd: string,
    taskLabel?: string
  ): BridgeSession {
    const now = new Date().toISOString();
    const session: BridgeSession = {
      sessionId: `pending-${randomUUID()}`,
      agentId,
      taskLabel,
      cwd,
      status: "active",
      createdAt: now,
      lastUsedAt: now,
      messageCount: 0,
      totalCost: 0,
      forkedFrom: originalSessionId,
    };
    this.index.sessions.push(session);
    this.save();
    return session;
  }

  /** Mark a session as done. */
  kill(sessionId: string): boolean {
    const session = this.index.sessions.find((s) => s.sessionId === sessionId);
    if (!session) return false;
    session.status = "done";
    session.lastUsedAt = new Date().toISOString();
    this.save();
    return true;
  }
}
