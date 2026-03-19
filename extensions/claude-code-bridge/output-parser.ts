/**
 * Parses Claude CLI `--output-format stream-json` output into a ClaudeResult.
 *
 * The CLI emits one JSON object per line. We care about:
 *   - init system messages (contain session_id)
 *   - result messages (contain final text + cost)
 *   - assistant messages (incremental content)
 */

import type { ClaudeResult, StreamJsonEvent } from "./types.ts";

export function parseStreamJson(raw: string): ClaudeResult {
  const lines = raw.split("\n").filter((l) => l.trim());

  let sessionId = "";
  let cost = 0;
  let durationMs = 0;
  const textParts: string[] = [];

  for (const line of lines) {
    let event: StreamJsonEvent;
    try {
      event = JSON.parse(line);
    } catch {
      // Not JSON — skip (stderr mixed in, etc.)
      continue;
    }

    // Extract session ID from init or system messages
    if (event.session_id && !sessionId) {
      sessionId = event.session_id;
    }

    // Final result event (type: "result")
    if (event.type === "result") {
      if (typeof event.result === "string") {
        textParts.push(event.result);
      }
      if (event.cost_usd != null) cost = event.cost_usd;
      if (event.duration_ms != null) durationMs = event.duration_ms;
      if (event.session_id) sessionId = event.session_id;
      continue;
    }

    // Assistant content messages
    if (
      event.type === "assistant" &&
      event.subtype === "message" &&
      event.message
    ) {
      const content = event.message.content;
      if (typeof content === "string") {
        textParts.push(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text) {
            textParts.push(block.text);
          }
        }
      }
    }
  }

  return {
    ok: textParts.length > 0,
    text: textParts.join("\n"),
    sessionId,
    cost,
    durationMs,
    exitCode: 0, // Caller overrides with actual exit code
  };
}
