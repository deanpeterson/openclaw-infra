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
const DEFAULT_ALLOWED_TOOLS = [
  "Bash(*)",
  "Read",
  "Edit",
  "MultiEdit",
  "Write",
  "Glob",
  "Grep",
  "LS"
];

function buildWorkspaceSkillBootstrap(cwd) {
  const workspace = cwd || DEFAULT_CWD;
  const skillsDir = join(workspace, "skills");
  const developerHubSkill = join(skillsDir, "developer-hub", "SKILL.md");
  const lines = [
    "Workspace instructions bootstrap:",
    `- Your working directory is ${workspace}.`,
    `- Workspace skills live under ${skillsDir}.`,
    "- Before acting on a domain-specific request, inspect the relevant workspace skill file(s) and use them as the source of truth.",
    "- Do not claim a skill is missing unless you first checked the corresponding file path from the workspace.",
    "- If the task involves Developer Hub, Backstage, scaffolder, catalog, templates, or RHDH, you must read ./skills/developer-hub/SKILL.md before doing anything else."
  ];
  if (existsSync(developerHubSkill)) {
    lines.push(`- Confirmed present: ${developerHubSkill}.`);
  }
  return `${lines.join("\n")}\n\n`;
}

function prepareClaudePrompt(prompt, cwd) {
  return `${buildWorkspaceSkillBootstrap(cwd)}${prompt}`;
}

function buildClaudeArgs(prompt, options) {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    process.env.CLAUDE_CODE_PERMISSION_MODE || "dontAsk"
  ];
  const allowedTools = (process.env.CLAUDE_CODE_ALLOWED_TOOLS || DEFAULT_ALLOWED_TOOLS.join(",")).split(",").map((tool) => tool.trim()).filter(Boolean);
  if (allowedTools.length > 0) {
    args.push("--allowedTools", allowedTools.join(","));
  }
  const skipPermissions = (process.env.CLAUDE_CODE_DANGEROUSLY_SKIP_PERMISSIONS || "true").toLowerCase();
  if (skipPermissions !== "false") {
    args.push("--dangerously-skip-permissions");
  }
  if (options.cwd) {
    args.push("--add-dir", options.cwd);
  }
  if (options.sessionId && !options.sessionId.startsWith("pending-")) {
    args.push("--resume", options.sessionId);
  }
  return args;
}

function runClaude(prompt, options) {
  return new Promise((resolve) => {
    const cwd = options.cwd || DEFAULT_CWD;
    const preparedPrompt = prepareClaudePrompt(prompt, cwd);
    const args = buildClaudeArgs(preparedPrompt, { ...options, cwd });
    const chunks = [], stderrChunks = [];
    const child = spawn("claude", args, {
      cwd,
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
// Self-contained definePluginEntry (avoids import from bundled core)
function definePluginEntry({ id, name, description, kind, configSchema, register }) {
  return { id, name, description, ...(kind ? { kind } : {}), configSchema: configSchema || { type: "object", additionalProperties: false, properties: {} }, register };
}

var claude_code_bridge_default = definePluginEntry({
  id: "claude-code-bridge",
  name: "Claude Code Bridge",
  description: "Bridge to Claude Code CLI for subscription-based model access",
  register(api) {
    api.registerTool((ctx) => {
      return [
        {
          name: "claude_code_resume",
          label: "Claude Code",
          description: "Send a prompt to Claude Code CLI via your Max subscription. Automatically resumes or starts sessions by taskLabel.",
          defaultProfiles: ["coding", "full", "minimal"],
          parameters: {
            type: "object",
            properties: {
              prompt: { type: "string", description: "The prompt or message to send to Claude Code" },
              taskLabel: { type: "string", description: "Label for the task thread (e.g. 'chat', 'fix-bug')" },
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
            const s = index.sessions.find(s => s.sessionId === session.sessionId);
            if (s) {
              if (realSessionId !== s.sessionId) s.sessionId = realSessionId;
              s.totalCost += result.cost; s.messageCount += 1;
              if (taskLabel) s.taskLabel = taskLabel;
              s.status = result.ok ? "active" : "error";
              s.lastUsedAt = new Date().toISOString();
              saveSessions(index);
            }
            const text = result.ok ? result.text : `Error: ${result.text}`;
            return { content: [{ type: "text", text }] };
          }
        },
        {
          name: "claude_code_sessions",
          label: "Claude Code Sessions",
          description: "List Claude Code sessions with status and cost.",
          defaultProfiles: ["coding", "full"],
          parameters: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] },
          async execute(_id, params) {
            const index = loadSessions();
            const sessions = index.sessions.filter(s => s.agentId === params.agentId);
            const lines = sessions.map(s => `- ${s.taskLabel || "(unlabeled)"}: ${s.status} (${s.messageCount} msgs, $${s.totalCost.toFixed(4)})`);
            return { content: [{ type: "text", text: sessions.length ? lines.join("\n") : "No sessions." }] };
          }
        }
      ];
    }, { names: ["claude_code_resume", "claude_code_sessions"] });
  }
});
//#endregion
export { claude_code_bridge_default as default };
