/**
 * pi-deepseek-enhancement — cache prefix stability + hashline editing.
 *
 * Two targeted fixes for DeepSeek's known weaknesses:
 *
 * 1. Cache prefix stability — strips reasoning_content, sorts tool schemas,
 *    removes timestamps so DeepSeek's prompt cache (byte-prefix based) stays
 *    hot. Without this, every turn is a full cache miss (~120x more expensive).
 *
 * 2. Hashline editing — annotates read output with per-line FNV-1a hashes,
 *    provides edit_lines tool that edits by line range + hash verification.
 *    Avoids exact-string reproduction failures (main source of DeepSeek retries).
 *
 * Both modules auto-activate only when the model name contains "deepseek" (case-insensitive).
 * Set PI_DEEPSEEK_PATTERN env var for custom model matching.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// ── Config ───────────────────────────────────────────────────────────────────

const MODEL_PATTERN = (process.env.PI_DEEPSEEK_PATTERN || "deepseek").toLowerCase();

function isDeepseek(model?: { id: string; provider: string; name: string }): boolean {
  if (!model) return false;
  const haystack = `${model.provider} ${model.id} ${model.name}`.toLowerCase();
  return haystack.includes(MODEL_PATTERN);
}

// ── FNV-1a 12-bit (3 hex chars) ──────────────────────────────────────────────

function lineHash(line: string): string {
  const s = line.replace(/\s+$/, "");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h & 0xfff).toString(16).padStart(3, "0");
}

const NOTICE_RE = /^\[(Showing|.*to continue\.\])/;
const ANNOTATED_RE = /^\s*\d+:[0-9a-f]{3}\u2192/;

function annotateContent(content: string, startLine = 1): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let num = startLine;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (NOTICE_RE.test(line) || (line === "" && i + 1 < lines.length && NOTICE_RE.test(lines[i + 1]!))) {
      out.push(line);
    } else if (ANNOTATED_RE.test(line)) {
      out.push(line);
    } else {
      const n = String(num).padStart(5, " ");
      out.push(`${n}:${lineHash(line)}\u2192${line}`);
      num++;
    }
  }
  return out.join("\n");
}

// ── Cache: timestamp patterns ─────────────────────────────────────────────────

const TIMESTAMP_RE = /(?:Current (?:date|time)(?:\s+is)?[:\s]\s*.*|Today(?:\s+is)?[:\s]\s*.*|Date[:\s]\s*\d{4}-\d{2}-\d{2}.*|Time[:\s]\s*\d{2}:\d{2}(?::\d{2})?.*)$/gim;

function stripTimestamps(prompt: string): string {
  TIMESTAMP_RE.lastIndex = 0;
  if (!TIMESTAMP_RE.test(prompt)) return prompt;
  TIMESTAMP_RE.lastIndex = 0;
  return prompt.replace(TIMESTAMP_RE, "").replace(/\n{3,}/g, "\n\n");
}

// ── Tool: edit_lines ──────────────────────────────────────────────────────────

interface HashEdit {
  from: number;
  from_hash: string;
  to: number;
  to_hash: string;
  new_text: string;
}

const editLinesTool: ToolDefinition = {
  name: "edit_lines",
  label: "edit lines",
  description:
    "Edit a file using hash-anchored line ranges. Each edit specifies a line range (from..to, 1-based inclusive) with the expected content hashes at both endpoints. The tool reads the file fresh, verifies the hashes, and rejects on mismatch.\n\n" +
    "Prefer edit_lines when you have a recent 'read' whose output shows per-line hash annotations (format: N:HHH->content).\n" +
    "Use the built-in 'edit' tool when you want exact-string replacement.\n\n" +
    "Example: { \"path\": \"lib/foo.ts\", \"edits\": [{ \"from\": 10, \"from_hash\": \"a1b\", \"to\": 15, \"to_hash\": \"c4d\", \"new_text\": \"    new body\" }] }",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to edit (relative or absolute)." },
      edits: {
        type: "array",
        description: "Hash-anchored edits to apply. Each edit replaces lines from..to (inclusive, 1-based).",
        items: {
          type: "object",
          properties: {
            from: { type: "integer", description: "1-based start line number." },
            from_hash: { type: "string", description: "3-char hex hash of the 'from' line." },
            to: { type: "integer", description: "1-based end line number (inclusive)." },
            to_hash: { type: "string", description: "3-char hex hash of the 'to' line." },
            new_text: { type: "string", description: "Replacement text (may contain newlines)." },
          },
          required: ["from", "from_hash", "to", "to_hash", "new_text"],
        },
      },
    },
    required: ["path", "edits"],
  } as const,
  executionMode: "sequential",
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const { path: rawPath, edits } = params as { path: string; edits: HashEdit[] };

    // Validate edits array
    if (!Array.isArray(edits) || edits.length === 0) {
      return {
        content: [{ type: "text" as const, text: "edit_lines: `edits` must be a non-empty array of {from, from_hash, to, to_hash, new_text}." }],
        isError: true,
      };
    }

    const absPath = resolve(ctx.cwd, rawPath);

    let content: string;
    try {
      content = await readFile(absPath, "utf-8");
    } catch (err) {
      return { content: [{ type: "text", text: `Error reading file: ${err}` }], isError: true };
    }

    const lines = content.split("\n");

    // Validate all edits before applying
    for (const e of edits) {
      const fromIdx = e.from - 1;
      const toIdx = e.to - 1;

      if (fromIdx < 0 || fromIdx >= lines.length) {
        return { content: [{ type: "text", text: `edit_lines: line ${e.from} out of range (file has ${lines.length} lines).` }], isError: true };
      }
      if (toIdx < 0 || toIdx >= lines.length || toIdx < fromIdx) {
        return { content: [{ type: "text", text: `edit_lines: line ${e.to} out of range (file has ${lines.length} lines).` }], isError: true };
      }

      const actualFromHash = lineHash(lines[fromIdx]!);
      if (actualFromHash !== e.from_hash) {
        return {
          content: [{ type: "text", text: `edit_lines: line ${e.from} hash mismatch — claimed "${e.from_hash}", actual "${actualFromHash}".\nLine content: "${lines[fromIdx]}"\nRe-read the file to get fresh hashes.` }],
          isError: true,
        };
      }

      if (e.to !== e.from) {
        const actualToHash = lineHash(lines[toIdx]!);
        if (actualToHash !== e.to_hash) {
          return {
            content: [{ type: "text", text: `edit_lines: line ${e.to} hash mismatch — claimed "${e.to_hash}", actual "${actualToHash}".\nLine content: "${lines[toIdx]}"\nRe-read the file to get fresh hashes.` }],
            isError: true,
          };
        }
      }
    }

    // Apply edits in reverse order to preserve line numbers
    const result = [...lines];
    [...edits]
      .sort((a, b) => b.to - a.to)
      .forEach((e) => {
        const newLines = e.new_text.split("\n");
        result.splice(e.from - 1, e.to - e.from + 1, ...newLines);
      });

    try {
      await writeFile(absPath, result.join("\n"), "utf-8");
    } catch (err) {
      return { content: [{ type: "text", text: `Error writing file: ${err}` }], isError: true };
    }

    const changed = edits.reduce((s, e) => s + (e.to - e.from + 1), 0);
    const added = edits.reduce((s, e) => s + e.new_text.split("\n").length, 0);

    return {
      content: [{ type: "text", text: `Applied ${edits.length} edit(s) to ${rawPath} (${changed} lines replaced, ${added} lines added).` }],
      details: { editsApplied: edits.length, linesChanged: changed, linesAdded: added },
    };
  },
};

// ── Entry ────────────────────────────────────────────────────────────────────

export default function piDeepseekEnhancement(pi: ExtensionAPI) {
  // ── Hook: annotate read output with hashes ──────────────────────────
  pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
    if (!isDeepseek(ctx.model)) return;
    if (event.toolName !== "read" || event.isError) return;

    const textContent = event.content.find(
      (c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string",
    );
    if (!textContent) return;

    const input = event.input as { offset?: number } | Record<string, unknown>;
    const offset = typeof input?.offset === "number" && input.offset > 0 ? input.offset : 1;

    const annotated = annotateContent(textContent.text, offset);
    if (annotated === textContent.text) return;

    return {
      content: event.content.map((c) =>
        c.type === "text" && typeof c.text === "string" ? { type: "text" as const, text: annotated } : c,
      ),
    };
  });

  // ── Register edit_lines tool ────────────────────────────────────────
  pi.registerTool(editLinesTool);

  // ── Cache: strip reasoning_content ──────────────────────────────────
  pi.on("context", async (event, ctx: ExtensionContext) => {
    if (!isDeepseek(ctx.model)) return;
    for (const msg of event.messages) {
      const m = msg as Record<string, unknown>;
      delete m.reasoning_content;
      delete m.reasoning;
      if (Array.isArray(m.content)) {
        const filtered = (m.content as unknown[]).filter((b) => {
          const block = b as Record<string, unknown> | undefined;
          return block?.type !== "thinking" && block?.type !== "reasoning";
        });
        m.content = filtered.length === 0 ? [{ type: "text", text: "" }] : filtered;
      }
    }
  });

  // ── Cache: sort tool schemas deterministically ──────────────────────
  pi.on("before_provider_request", async (event, ctx: ExtensionContext) => {
    if (!isDeepseek(ctx.model)) return;
    const payload = event.payload as Record<string, unknown> | undefined;
    if (!payload || !Array.isArray(payload.tools)) return;

    (payload.tools as unknown[]).sort((a, b) => {
      const ta = a as Record<string, unknown> | undefined;
      const tb = b as Record<string, unknown> | undefined;
      const fnA = ta?.function as Record<string, unknown> | undefined;
      const fnB = tb?.function as Record<string, unknown> | undefined;
      const nameA = (fnA?.name as string) ?? (ta?.name as string) ?? "";
      const nameB = (fnB?.name as string) ?? (tb?.name as string) ?? "";
      return nameA.localeCompare(nameB);
    });
  });

  // ── Cache: strip timestamps from system prompt ──────────────────────
  pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
    if (!isDeepseek(ctx.model)) return;
    const cleaned = stripTimestamps(event.systemPrompt);
    if (cleaned !== event.systemPrompt) {
      return { systemPrompt: cleaned };
    }
  });
}