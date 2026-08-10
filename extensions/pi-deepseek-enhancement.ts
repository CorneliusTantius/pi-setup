/**
 * pi-deepseek-enhancement — cache prefix stability + hashline editing + edit repair + tool steering.
 *
 * Targeted fixes for DeepSeek's known weaknesses:
 *
 * 1. Cache prefix stability — strips reasoning_content, sorts tool schemas,
 *    removes timestamps so DeepSeek's prompt cache stays hot. Without this,
 *    every turn is a full cache miss (~120x more expensive).
 *
 * 2. Hashline editing — annotates read output with per-line FNV-1a hashes,
 *    provides edit_lines tool that edits by line range + hash verification.
 *    Avoids exact-string reproduction failures.
 *
 * 3. Edit input repair — strips read-tool contamination notices from oldText,
 *    repairs JSON-string-instead-of-object args, closes truncated JSON,
 *    unwraps markdown autolink wrapping on paths.
 *
 * 4. Tool steering — first-tool hints (run→bash, bare filename→find, git URL→clone),
 *    semantic-miss blocking (bash grep→Serena, bash cat→read, etc.).
 *
 * Auto-activates when model name contains "deepseek" (case-insensitive).
 * Set PI_DEEPSEEK_PATTERN env var for custom model matching.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

// ── Config ───────────────────────────────────────────────────────────────────

const MODEL_PATTERN = (process.env.PI_DEEPSEEK_PATTERN || "deepseek").toLowerCase();
const EDIT_REPAIR_DISABLED = ["0", "false", "no", "off"].includes((process.env.PI_DEEPSEEK_EDIT_REPAIR || "").toLowerCase());

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

// ── Edit input repair ────────────────────────────────────────────────────────

const READ_CONTAMINATION_PATTERNS: RegExp[] = [
  /\n{1,2}\[Showing lines \d+-\d+ of \d+(?: \([^)]+\))?\.\s*Use offset=\d+ to continue\.\]/g,
  /\n{1,2}\[\d+ more lines in file\.\s*Use offset=\d+ to continue\.\]/g,
  /\n\[Line \d+ is [^,]+, exceeds [^\]]+ limit\.[^\]]*\]/g,
];

function stripReadContamination(text: string): string {
  let out = text;
  for (const re of READ_CONTAMINATION_PATTERNS) {
    out = out.replace(re, "");
  }
  return out;
}

// Lenient JSON parse: strict first, then try closing unterminated strings/brackets
function tryParseLenientJson(text: string): { value: unknown; truncated: boolean } | undefined {
  try {
    return { value: JSON.parse(text), truncated: false };
  } catch { /* not strict JSON */ }

  const closed = closeTruncatedJson(text);
  if (closed === text) return undefined;
  try {
    return { value: JSON.parse(closed), truncated: true };
  } catch {
    return undefined;
  }
}

function closeTruncatedJson(text: string): string {
  const stack: Array<"{" | "["> = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") { stack.push("{"); continue; }
    if (ch === "[") { stack.push("["); continue; }
    if (ch === "}") { if (stack[stack.length - 1] === "{") stack.pop(); continue; }
    if (ch === "]") { if (stack[stack.length - 1] === "[") stack.pop(); continue; }
  }
  if (inString && escaped) text += "\\";
  else if (!inString && stack.length > 0) text = text.replace(/[\s,]+$/, "");
  let suffix = "";
  if (inString) suffix += '"';
  while (stack.length > 0) suffix += stack.pop() === "{" ? "}" : "]";
  return suffix ? text + suffix : text;
}

// Unwrap markdown autolinks: [text](url) where url ends with text → bare text
function unwrapPathAutolink(value: string): string {
  return value.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)]+)\)/g, (_match, text: string, url: string) => {
    const normalizedText = text.replace(/\s+/g, "");
    const normalizedUrl = url.replace(/^https?:\/\//i, "").replace(/\s+/g, "").replace(/^\/+/, "");
    if (normalizedUrl === normalizedText || normalizedUrl.endsWith(`/${normalizedText}`)) return text;
    return _match;
  });
}

const PATH_FIELD_NAMES = new Set(["path", "filePath", "absolutePath", "relativePath"]);

function cleanPathFields(value: unknown): { value: unknown; changed: boolean } {
  let changed = false;
  const visit = (current: unknown, key?: string): unknown => {
    if (typeof current === "string" && key && PATH_FIELD_NAMES.has(key)) {
      const next = unwrapPathAutolink(current);
      changed ||= next !== current;
      return next;
    }
    if (Array.isArray(current)) return current.map((item) => visit(item));
    if (typeof current !== "object" || current === null) return current;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(current as Record<string, unknown>)) next[k] = visit(v, k);
    return next;
  };
  const nextValue = visit(value);
  return { value: changed ? nextValue : value, changed };
}

// Decontaminate edit args: strip read notices from oldText fields
function decontaminateEditArgs(args: any): boolean {
  let changed = false;
  const clean = (s: string): string => {
    const r = stripReadContamination(s);
    if (r !== s) changed = true;
    return r;
  };
  if (Array.isArray(args.edits)) {
    for (const e of args.edits) if (e && typeof e.oldText === "string") e.oldText = clean(e.oldText);
  }
  if (typeof args.oldText === "string") args.oldText = clean(args.oldText);
  return changed;
}

// ── Tool steering helpers ────────────────────────────────────────────────────

// First-tool hints
function runTaskFirstToolHint(prompt: string): string | undefined {
  const p = (prompt || "").toLowerCase();
  const hasExecVerb = /\b(run|running|execute|executing|build|building|compile|compiling|lint|linting|format|typecheck|type-check|deploy|install|start)\b/.test(p);
  if (!hasExecVerb) return undefined;
  if (/\b(find|list|show|where|definition|references|outline|inspect|explain|summarize|analyze|analyse|how (do|does|to)|what)\b/.test(p)) return undefined;
  return "FIRST tool must be bash (e.g. `npm test`, `pytest`) — do NOT call find/ls/read first.";
}

function readUncertainPathHint(prompt: string): string | undefined {
  const p = (prompt || "").toLowerCase();
  const isReadTask = /\b(read|show|open|view|display|cat|head|tail|first \d+ lines?|last \d+ lines?)\b/.test(p);
  if (!isReadTask) return undefined;
  if (/\b(symbols?|outline|definition|where is .+ defined|references?|declaration|implementations?|inspect)\b/.test(p)) return undefined;
  const codeExt = "(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|java|kt|kts|scala|rb|php|cs|cpp|cc|cxx|c|h|hpp|swift|sh|bash|zsh|lua|r|jl|ex|vue|svelte)";
  const files = p.match(new RegExp("\\b[a-z0-9_-]+\\." + codeExt + "\\b", "g")) || [];
  const hasBareCodeFile = files.some((f) => !p.includes("/" + f));
  if (!hasBareCodeFile) return undefined;
  return "Path uncertain — call find FIRST to locate the file, THEN read the exact path.";
}

function githubCloneFirstToolHint(prompt: string): string | undefined {
  const p = (prompt || "").toLowerCase();
  if (!/(github|gitlab|bitbucket|gitea)\.(com|org)\/[\w.-]+\/[\w.-]+/.test(p)) return undefined;
  if (!/\b(analyz|analyse|summar|understand|review|explor|inspect|describ|walk|study|assess|audit|structure)\b/.test(p)) return undefined;
  if (/\b(issue|pull request|\bpr\b|release)\b/.test(p)) return undefined;
  return "Git repo URL detected — FIRST call bash to git clone to /tmp, THEN inspect locally.";
}

// Semantic-miss and dedicated-tool detection
function commandLooksLikeSemanticCodeSearch(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const lowered = command.toLowerCase();
  if (!/\b(rg|grep|ag|ack|sed|awk|find)\b/.test(lowered)) return false;
  if (/\b(ls|pwd|git\s+status|npm\s+(test|run|install)|pnpm\s+(test|run|install)|yarn\s+(test|run|install))\b/.test(lowered)) return false;
  if (/^sed\s+-n\b/.test(command.trim().toLowerCase())) return false;
  if (/[|;&<>()$`]/.test(command)) return false;
  if (/(?:^|[\s/])(?:node_modules|dist|build|\.git|\.next|\.cache|coverage|vendors?|third_party)\/|\.d\.ts\b/i.test(lowered)) return false;
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|cpp|cc|cxx|c|h|hpp)\b/.test(lowered)
    || /\b(class|function|def|interface|implements|references?|symbol|declaration|implementation|method|variable|rename|refactor)\b/.test(lowered);
}

function commandIsSimple(command: string): boolean {
  return !/[|;&`$()]|\b(if|for|while|case|xargs|sudo|env|cd)\b/.test(command);
}

function dedicatedToolForCommand(command: unknown, activeTools: readonly string[]): string | undefined {
  if (typeof command !== "string") return undefined;
  const trimmed = command.trim();
  if (!trimmed || !commandIsSimple(trimmed)) return undefined;
  if (/^(npm|pnpm|yarn|bun|node|npx|git|make|cargo|go|pytest|python|tsx|tsc|awk)\b/.test(trimmed)) return undefined;
  if (/^ls\b/.test(trimmed) && activeTools.includes("ls")) return "ls";
  if (/^find\b/.test(trimmed) && activeTools.includes("find")) return "find";
  if (/^(grep|rg|ag|ack)\b/.test(trimmed) && activeTools.includes("grep")) return "grep";
  if (/^cat\s+\S+\s*$/.test(trimmed) && activeTools.includes("read")) return "read";
  if (/^head\s+/.test(trimmed) && activeTools.includes("read")) return "read";
  if (/^tail\s+/.test(trimmed) && activeTools.includes("read")) return "read";
  if (/^(echo|printf)\s.+>\s*\S/.test(trimmed) && activeTools.includes("write")) return "write";
  return undefined;
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
          content: [{ type: "text", text: `edit_lines: line ${e.from} hash mismatch — claimed "${e.from_hash}", actual "${actualFromHash}".\nLine: "${lines[fromIdx]}"\nRe-read the file for fresh hashes.` }],
          isError: true,
        };
      }
      if (e.to !== e.from) {
        const actualToHash = lineHash(lines[toIdx]!);
        if (actualToHash !== e.to_hash) {
          return {
            content: [{ type: "text", text: `edit_lines: line ${e.to} hash mismatch — claimed "${e.to_hash}", actual "${actualToHash}".\nLine: "${lines[toIdx]}"\nRe-read the file for fresh hashes.` }],
            isError: true,
          };
        }
      }
    }

    const result = [...lines];
    [...edits]
      .sort((a, b) => b.to - a.to)
      .forEach((e) => {
        result.splice(e.from - 1, e.to - e.from + 1, ...e.new_text.split("\n"));
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

  // ── Edit input repair: wrap the built-in edit tool ──────────────────
  if (!EDIT_REPAIR_DISABLED) {
    // We can't re-register "edit" after the fact in pi's current API,
    // so we patch via hook interception instead.
    // The before_agent_start and tool_result hooks handle decontamination.
    // We store decontamination state per-turn.
    let editRepairActive = false;

    pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
      if (!isDeepseek(ctx.model)) return;
      editRepairActive = repairEnabled();
    });

    // Intercept tool results for edit mismatch → retry with trim-tolerant matching
    pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
      if (!isDeepseek(ctx.model) || !editRepairActive) return;
      if (event.toolName !== "edit" || !event.isError) return;

      const errorText = event.content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!)
        .join("\n");

      if (!/could not find|must match exactly|found \d+ occurrences|must be unique|provide more context/i.test(errorText)) return;

      // Read the file, attempt trim-tolerant match, rebuild oldText
      const input = event.input as { path?: string; edits?: { oldText: string; newText: string }[]; oldText?: string; newText?: string } | undefined;
      if (!input?.path) return;

      const absPath = resolve(ctx.cwd, input.path);
      let fileContent: string;
      try {
        fileContent = await readFile(absPath, "utf-8");
      } catch {
        return;
      }

      // Build edits array from whatever shape the model sent
      let edits: { oldText: string; newText: string }[] = [];
      if (Array.isArray(input.edits) && input.edits.length > 0) {
        edits = input.edits;
      } else if (typeof input.oldText === "string") {
        edits = [{ oldText: input.oldText, newText: input.newText ?? "" }];
      }
      if (edits.length === 0) return;

      // Decontaminate + trim-match the failing edit
      const failing = edits[0];
      const decontaminated = stripReadContamination(failing.oldText);

      const fileLines = fileContent.split("\n");
      const patternLines = decontaminated.split("\n").map((l) => l.trim());
      if (patternLines.length > 1 && patternLines[patternLines.length - 1] === "") patternLines.pop();

      let matchCount = 0;
      let matchStart = -1;
      for (let i = 0; i <= fileLines.length - patternLines.length; i++) {
        let ok = true;
        for (let j = 0; j < patternLines.length; j++) {
          if (fileLines[i + j].trim() !== patternLines[j]) { ok = false; break; }
        }
        if (ok) {
          matchCount++;
          if (matchStart === -1) matchStart = i;
        }
      }

      if (matchCount === 1) {
        // Rebuild oldText from real file bytes
        const realOldText = fileLines.slice(matchStart, matchStart + patternLines.length).join("\n");
        if (realOldText !== failing.oldText) {
          // Return guidance to use edit with the corrected oldText
          return {
            content: [{
              type: "text" as const,
              text: `Edit mismatch resolved: the model's oldText had whitespace or contamination differences.\nUse the following corrected edit:\noldText:\n\`\`\`\n${realOldText}\n\`\`\`\nnewText:\n\`\`\`\n${failing.newText}\n\`\`\`\n\nThis is the exact file content at the match location.`,
            }],
          };
        }
      }

      if (matchCount === 0) {
        // Show nearest region
        const windowSize = Math.min(20, fileLines.length);
        let bestScore = -1;
        let bestStart = 0;
        const patternSet = new Set(patternLines.filter((l) => l.length > 0));
        for (let i = 0; i <= fileLines.length - windowSize; i++) {
          let score = 0;
          for (let j = 0; j < windowSize; j++) {
            if (patternSet.has(fileLines[i + j].trim())) score++;
          }
          if (score > bestScore) { bestScore = score; bestStart = i; }
        }
        const width = String(fileLines.length).length;
        const start = Math.max(0, bestStart - 2);
        const end = Math.min(fileLines.length, bestStart + windowSize + 2);
        const snippet = fileLines.slice(start, end).map((l, idx) => {
          const num = String(start + idx + 1).padStart(width, " ");
          return `${num} | ${l}`;
        }).join("\n");

        return {
          content: [{
            type: "text" as const,
            text: `Edit failed: the target text was not found in ${input.path}.\nNearest matching region (lines ${start + 1}-${end}):\n${snippet}\n\nRead this region and retry with exact content.`,
          }],
        };
      }
    });
  }

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

  // ── Tool steering: semantic-miss blocking + first-tool hints ────────
  let pendingGuidance: string | undefined;

  pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
    if (!isDeepseek(ctx.model)) return;

    const dynamicParts: string[] = [];
    const activeTools = pi.getActiveTools();

    // First-tool hints based on prompt
    if (activeTools.includes("bash")) {
      const runHint = runTaskFirstToolHint(event.prompt);
      if (runHint) dynamicParts.push(runHint);
      const ghHint = githubCloneFirstToolHint(event.prompt);
      if (ghHint) dynamicParts.push(ghHint);
    }
    if (activeTools.includes("find")) {
      const readHint = readUncertainPathHint(event.prompt);
      if (readHint) dynamicParts.push(readHint);
    }

    pendingGuidance = dynamicParts.length > 0 ? dynamicParts.join("\n---\n") : undefined;
  });

  // Inject dynamic guidance into the user message (not system prompt, preserve cache)
  pi.on("before_provider_request", async (event, ctx: ExtensionContext) => {
    if (!isDeepseek(ctx.model)) return;

    if (pendingGuidance) {
      const payload = event.payload as Record<string, unknown>;
      const messages = (Array.isArray(payload.messages) ? payload.messages : Array.isArray((payload as any).body?.messages) ? (payload as any).body.messages : null) as Array<Record<string, unknown>> | null;
      if (messages) {
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "user") {
            if (typeof messages[i].content === "string") {
              messages[i].content = `${messages[i].content}\n\n${pendingGuidance}`;
            } else if (Array.isArray(messages[i].content)) {
              const parts = messages[i].content as Array<Record<string, unknown>>;
              const lastText = [...parts].reverse().find((p) => typeof p.text === "string");
              if (lastText) lastText.text = `${lastText.text}\n\n${pendingGuidance}`;
              else parts.push({ type: "text", text: pendingGuidance });
            }
            break;
          }
        }
      }
      pendingGuidance = undefined;
    }
  });

  // ── Tool call steering: block semantic misses ───────────────────────
  pi.on("tool_call", (event, ctx: ExtensionContext) => {
    if (!isDeepseek(ctx.model)) return;

    if (event.toolName === "bash") {
      const input = event.input as { command?: string } | undefined;
      if (!input?.command) return;

      // Semantic search via bash → block with steer
      if (commandLooksLikeSemanticCodeSearch(input.command)) {
        return {
          block: true,
          reason: `For DeepSeek V4, use the dedicated Serena tools for code symbol search, not bash grep/find. Try: serena_find_symbol, serena_search_for_pattern, or serena_get_symbols_overview`,
        };
      }

      // Simple command that has a dedicated tool
      const dedicated = dedicatedToolForCommand(input.command, pi.getActiveTools());
      if (dedicated) {
        return {
          block: true,
          reason: `For DeepSeek V4, use the dedicated \`${dedicated}\` tool instead of bash for this operation.`,
        };
      }
    }

    // Read on guessed path → block
    if (event.toolName === "read") {
      const input = event.input as { path?: string } | undefined;
      if (!input?.path || !ctx.cwd) return;

      const filePath = input.path.trim();
      const codeExtRe = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|java|kt|kts|scala|rb|php|cs|cpp|cc|cxx|c|h|hpp|swift|sh|bash|zsh|fish|lua|r|jl|ex|exs|erl|hrl|clj|cljs|fs|fsx|ml|mli|dart|vue|svelte)$/i;
      if (filePath && codeExtRe.test(filePath) && !existsSync(resolve(ctx.cwd, filePath))) {
        const filename = filePath.split("/").pop() ?? filePath;
        const relDir = dirname(filePath);
        const dirPart = relDir !== "." ? ` under ${relDir}/` : "";
        return {
          block: true,
          reason: `Path not found: "${filePath}". Use find to locate "${filename}"${dirPart}, then read.`,
        };
      }
    }
  });
}

function repairEnabled(): boolean {
  return !EDIT_REPAIR_DISABLED;
}