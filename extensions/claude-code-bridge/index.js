import { i as definePluginEntry } from "../../core-CaZPnQeC.js";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

//#region session-manager
const SESSION_PATH = join(process.env.HOME || "/home/node", ".claude", "bridge-sessions.json");

function loadSessions() {
  try {
    const raw = readFileSync(SESSION_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.version === 1 && Array.isArray(parsed.sessions)) return parsed;
  } catch {}
  return { version: 1, sessions: [] };
}

function saveSessions(index) {
  try {
    mkdirSync(dirname(SESSION_PATH), { recursive: true });
    writeFileSync(SESSION_PATH, JSON.stringify(index, null, 2));
  } catch (err) {
    console.error("[claude-code-bridge] save error:", err);
  }
}

function findActive(index, agentId, taskLabel) {
  const candidates = index.sessions.filter(s => s.agentId === agentId && s.status === "active");
  if (taskLabel) {
    const byLabel = candidates.find(s => s.taskLabel === taskLabel);
    if (byLabel) return byLabel;
  }
  return candidates.sort((a, b) => new Date(b.lastUsedAt) - new Date(a.lastUsedAt))[0];
}
//#endregion

//#region output-parser
function parseStreamJson(raw) {
  const lines = raw.split("\n").filter(l => l.trim());
  let sessionId = "", cost = 0, durationMs = 0;
  const textParts = [];

  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.session_id && !sessionId) sessionId = event.session_id;
    if (event.type === "result") {
      if (typeof event.result === "string") textParts.push(event.result);
      if (event.cost_usd != null) cost = event.cost_usd;
      if (event.duration_ms != null) durationMs = event.duration_ms;
      if (event.session_id) sessionId = event.session_id;
      continue;
    }
    if (event.type === "assistant" && event.subtype === "message" && event.message) {
      const content = event.message.content;
      if (typeof content === "string") textParts.push(content);
      else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text) textParts.push(block.text);
        }
      }
    }
  }
  return { ok: textParts.length > 0, text: textParts.join("\n"), sessionId, cost, durationMs, exitCode: 0 };
}
//#endregion

//#region cli-runner
const DEFAULT_CWD = process.env.OPENCLAW_WORKSPACE || join(process.env.HOME || "/home/node", ".openclaw", "workspace");
const CLI_TIMEOUT_MS = 10 * 60 * 1000;

function runClaude(prompt, options) {
  return new Promise((resolve) => {
    const args = ["-p", prompt, "--output-format", "stream-json"];
    if (options.sessionId && !options.sessionId.startsWith("pending-")) {
      args.push("--resume", options.sessionId);
    }
    const chunks = [], stderrChunks = [];
    const child = spawn("claude", args, {
      cwd: options.cwd || DEFAULT_CWD,
      env: { ...process.env, HOME: process.env.HOME || "/home/node" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CLI_TIMEOUT_MS
    });
    child.stdout.on("data", c => chunks.push(c));
    child.stderr.on("data", c => stderrChunks.push(c));
    child.on("error", err => resolve({ ok: false, text: `Claude CLI error: ${err.message}`, sessionId: "", cost: 0, durationMs: 0, exitCode: -1 }));
    child.on("close", code => {
      const stdout = Buffer.concat(chunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      const result = parseStreamJson(stdout);
      result.exitCode = code ?? 1;
      if (!result.ok && stderr) { result.text = result.text || `Claude CLI failed: ${stderr.trim()}`; }
      resolve(result);
    });
  });
}
//#endregion

//#region extensions/claude-code-bridge/index.ts
var claude_code_bridge_default = definePluginEntry({
  id: "claude-code-bridge",
  name: "Claude Code Bridge",
  description: "Bridge to Claude Code CLI for subscription-based model access",
  register(api) {
    // claude_code_resume — primary tool
    api.registerTool(() => ({
      name: "claude_code_resume",
      label: "Claude Code (Resume)",
      description: "Send a prompt to Claude Code CLI. Automatically resumes the most recent session matching the taskLabel, or starts a new session. This is the primary tool for using Claude Code through your Max subscription.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The prompt or message to send to Claude Code" },
          taskLabel: { type: "string", description: "Label for the task/conversation thread (e.g. 'chat', 'fix-bug')" },
          agentId: { type: "string", description: "Your agent ID for session isolation" }
        },
        required: ["prompt", "agentId"]
      },
      async execute(_id, params) {
        const { prompt, taskLabel, agentId } = params;
        const index = loadSessions();
        let session = findActive(index, agentId, taskLabel);
        let isNew = false;

        if (!session) {
          const now = new Date().toISOString();
          session = { sessionId: `pending-${randomUUID()}`, agentId, taskLabel, cwd: DEFAULT_CWD, status: "active", createdAt: now, lastUsedAt: now, messageCount: 0, totalCost: 0 };
          index.sessions.push(session);
          saveSessions(index);
          isNew = true;
        }

        const result = await runClaude(prompt, { sessionId: session.sessionId, cwd: session.cwd });
        const realSessionId = result.sessionId || session.sessionId;

        // Update session
        const s = index.sessions.find(s => s.sessionId === session.sessionId);
        if (s) {
          if (realSessionId !== s.sessionId) s.sessionId = realSessionId;
          s.totalCost += result.cost;
          s.messageCount += 1;
          if (taskLabel) s.taskLabel = taskLabel;
          s.status = result.ok ? "active" : "error";
          s.lastUsedAt = new Date().toISOString();
          saveSessions(index);
        }

        const text = result.ok ? result.text : `Error: ${result.text}`;
        return { content: [{ type: "text", text: `[Claude Code${isNew ? " (new session)" : ""} | session: ${realSessionId.substring(0,8)}... | cost: $${result.cost.toFixed(4)}]\n\n${text}` }] };
      }
    }));

    // claude_code_sessions — list sessions
    api.registerTool(() => ({
      name: "claude_code_sessions",
      label: "Claude Code Sessions",
      description: "List your Claude Code sessions with status, cost, and message count.",
      parameters: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "Your agent ID" }
        },
        required: ["agentId"]
      },
      async execute(_id, params) {
        const index = loadSessions();
        const sessions = index.sessions.filter(s => s.agentId === params.agentId);
        const lines = sessions.map(s => `- ${s.taskLabel || "(unlabeled)"}: ${s.status} (${s.messageCount} msgs, $${s.totalCost.toFixed(4)}) [${s.sessionId.substring(0,8)}...]`);
        return { content: [{ type: "text", text: sessions.length ? lines.join("\n") : "No sessions found." }] };
      }
    }));

    // claude_code_kill — mark session done
    api.registerTool(() => ({
      name: "claude_code_kill",
      label: "Claude Code Kill Session",
      description: "Mark a Claude Code session as done.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID to kill" }
        },
        required: ["sessionId"]
      },
      async execute(_id, params) {
        const index = loadSessions();
        const session = index.sessions.find(s => s.sessionId === params.sessionId);
        if (!session) return { content: [{ type: "text", text: `Session ${params.sessionId} not found.` }] };
        session.status = "done";
        session.lastUsedAt = new Date().toISOString();
        saveSessions(index);
        return { content: [{ type: "text", text: `Session ${params.sessionId} marked as done.` }] };
      }
    }));
  }
});
//#endregion
export { claude_code_bridge_default as default };
