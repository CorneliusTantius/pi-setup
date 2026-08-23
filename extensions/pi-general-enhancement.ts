/**
 * pi-general-enhancement — storm-breaker + edit retry.
 *
 * Model-agnostic improvements that work with any provider:
 *
 * 1. Storm-breaker — enhances cryptic tool errors with actionable diagnostics,
 *    breaks consecutive-failure loops after N identical errors. Prevents the
 *    model from spinning on the same broken call.
 *
 * 2. Edit retry with fuzzy matching — when edit fails, reads the file, does
 *    trim-tolerant block matching, and retries with real file bytes. Resolves
 *    ~60% of edit mismatches from whitespace/contamination differences.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// ── Config ───────────────────────────────────────────────────────────────────

const FAIL_THRESHOLD = 3;

// ── Storm-breaker state ──────────────────────────────────────────────────────

interface FailureRecord {
  toolName: string;
  errorSignature: string;
  count: number;
}

let currentFailure: FailureRecord | null = null;

function errorSignature(toolName: string, errorText: string): string {
  return `${toolName}:${errorText
    .replace(/\/[^\s:]+/g, "<path>")
    .replace(/line \d+/gi, "line N")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, "<ts>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .slice(0, 200)}`;
}

function enhanceError(toolName: string, errorText: string): string {
  if (/no such file or directory/i.test(errorText) || /open\s*:?\s*no such file/i.test(errorText)) {
    if (errorText.includes('""') || /open\s+|open\s+''/.test(errorText)) {
      return "Error: the 'path' argument is empty or missing. Provide a valid file path.";
    }
  }
  if (/permission denied/i.test(errorText)) {
    return `${errorText}\n\nCheck file permissions or path.`;
  }
  if (/old_text.*not found|old_string.*not found|did not match|exact string.*not found/i.test(errorText)) {
    return `${errorText}\n\nThe exact string was not found. The file may have changed or whitespace differs. Re-read the file and retry.`;
  }
  if (/offset.*beyond end of file/i.test(errorText)) {
    return `${errorText}\nFile may be shorter than expected. Use read without offset to see the full file.`;
  }
  if (/rate limit|429|too many requests|exceeded.*limit/i.test(errorText)) {
    return `${errorText}\nRate-limited. Wait before retrying or simplify the request.`;
  }
  if (/timed? ?out|timeout/i.test(errorText)) {
    return `${errorText}\nTimed out. Use simpler inputs or reduce scope.`;
  }
  return `[${toolName}] ${errorText}`;
}

// ── Edit retry with fuzzy matching ───────────────────────────────────────────

const READ_CONTAMINATION_PATTERNS: RegExp[] = [
  /\n{1,2}\[Showing lines \d+-\d+ of \d+(?: \([^)]+\))?\.\s*Use offset=\d+ to continue\.\]/g,
  /\n{1,2}\[\d+ more lines in file\.\s*Use offset=\d+ to continue\.\]/g,
  /\n\[Line \d+ is [^,]+, exceeds [^\]]+ limit\.[^\]]*\]/g,
];

function stripReadContamination(text: string): string {
  let out = text;
  for (const re of READ_CONTAMINATION_PATTERNS) out = out.replace(re, "");
  return out;
}

function findTrimMatch(fileContent: string, oldText: string): { count: number; firstIndex: number } {
  const fileLines = fileContent.split("\n");
  const patternLines = oldText.split("\n").map((l) => l.trim());
  if (patternLines.length > 1 && patternLines[patternLines.length - 1] === "") patternLines.pop();
  if (patternLines.length === 0 || patternLines.length > fileLines.length) return { count: 0, firstIndex: -1 };

  let count = 0;
  let firstIndex = -1;
  for (let i = 0; i <= fileLines.length - patternLines.length; i++) {
    let ok = true;
    for (let j = 0; j < patternLines.length; j++) {
      if (fileLines[i + j].trim() !== patternLines[j]) { ok = false; break; }
    }
    if (ok) {
      count++;
      if (firstIndex === -1) firstIndex = i;
    }
  }
  return { count, firstIndex };
}

function nearestBlock(content: string, oldText: string, ctx = 6): string {
  const fileLines = content.split("\n");
  const patternSet = new Set(oldText.split("\n").map((l) => l.trim()).filter((l) => l.length > 0));
  if (patternSet.size === 0 || fileLines.length === 0) return "";
  const window = Math.max(ctx, Math.min(40, fileLines.length));
  let bestStart = 0;
  let bestScore = -1;
  for (let i = 0; i <= fileLines.length - window; i++) {
    let score = 0;
    for (let j = 0; j < window; j++) {
      if (patternSet.has(fileLines[i + j].trim())) score++;
    }
    if (score > bestScore) { bestScore = score; bestStart = i; }
  }
  const width = String(fileLines.length).length;
  const start = Math.max(0, bestStart - 1);
  const end = Math.min(fileLines.length, bestStart + window + 1);
  return fileLines.slice(start, end).map((l, idx) => {
    const num = String(start + idx + 1).padStart(width, " ");
    return `${num} | ${l}`;
  }).join("\n");
}


export default function piGeneralEnhancement(pi: ExtensionAPI) {
  // ═══════════════════════════════════════════════════════════════════════
  // Storm-breaker
  // ═══════════════════════════════════════════════════════════════════════

  // Hook 1: enhance error messages
  pi.on("tool_result", async (event: ToolResultEvent) => {
    if (!event.isError) return;

    const errorText = event.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n")
      .slice(0, 500);

    if (!errorText) return;

    const enhanced = enhanceError(event.toolName, errorText);
    if (enhanced === errorText) return;

    return { content: [{ type: "text" as const, text: enhanced }] };
  });

  // Hook 2: detect consecutive failures and break loops
  pi.on("tool_execution_end", async (event: any, ctx: ExtensionContext) => {
    if (!event.isError) {
      currentFailure = null;
      return;
    }

    const resultText = (() => {
      if (typeof event.result === "string") return event.result;
      const r = event.result as Record<string, unknown> | undefined;
      if (!r) return "";
      if (r.content) {
        const arr = Array.isArray(r.content) ? r.content : [{ text: String(r.content) }];
        return (arr as { text?: string }[]).map((c: any) => c.text ?? "").join("\n");
      }
      return String(r.error ?? r.message ?? "");
    })();

    const sig = errorSignature(event.toolName, resultText);

    if (currentFailure && currentFailure.toolName === event.toolName && currentFailure.errorSignature === sig) {
      currentFailure.count++;
    } else {
      currentFailure = { toolName: event.toolName, errorSignature: sig, count: 1 };
    }

    if (currentFailure.count >= FAIL_THRESHOLD) {
      ctx.abort();

      pi.sendMessage(
        {
          customType: "harness_stormbreaker",
          content: [
            `Unable to continue: tool \`${currentFailure.toolName}\` failed ${currentFailure.count} times in a row.`,
            "",
            `Last error: ${resultText.slice(0, 300) || "unknown error"}`,
            "",
            "The arguments may be wrong, or the target may not exist.",
            "Please clarify what you'd like me to do.",
          ].join("\n"),
          display: true,
          details: { tool: currentFailure.toolName, count: currentFailure.count, error: resultText.slice(0, 300) },
        },
        { triggerTurn: false },
      );

      ctx.ui.notify(`Storm-breaker: ${currentFailure.toolName} failed ${currentFailure.count}x — loop broken`, "warning");
      currentFailure = null;
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Edit retry: catch edit mismatches, do trim-tolerant match, rebuild oldText
  // ═══════════════════════════════════════════════════════════════════════

  pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
    if (event.toolName !== "edit" || !event.isError) return;

    const errorText = event.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n");

    // Only intercept edit mismatch errors, not other edit failures
    if (!/could not find|must match exactly|found \d+ occurrences|must be unique|provide more context/i.test(errorText)) return;

    const input = event.input as { path?: string; edits?: { oldText: string; newText: string }[]; oldText?: string; newText?: string } | undefined;
    if (!input?.path) return;

    const absPath = resolve(ctx.cwd, input.path);
    let fileContent: string;
    try {
      fileContent = await readFile(absPath, "utf-8");
    } catch {
      return; // can't retry if we can't read the file
    }

    // Normalize line endings
    fileContent = fileContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    // Strip BOM
    if (fileContent.startsWith("\uFEFF")) fileContent = fileContent.slice(1);

    // Build edits array from whatever shape the model sent
    let edits: { oldText: string; newText: string }[] = [];
    if (Array.isArray(input.edits) && input.edits.length > 0) {
      edits = input.edits;
    } else if (typeof input.oldText === "string") {
      edits = [{ oldText: input.oldText, newText: input.newText ?? "" }];
    }
    if (edits.length === 0) return;

    // Decontaminate + trim-match the first failing edit
    const failing = edits[0];
    const decontaminated = stripReadContamination(failing.oldText);
    const { count, firstIndex } = findTrimMatch(fileContent, decontaminated);

    if (count === 1) {
      // Rebuild oldText from real file bytes
      const patternLines = decontaminated.split("\n").map((l) => l.trim());
      if (patternLines.length > 1 && patternLines[patternLines.length - 1] === "") patternLines.pop();
      const realOldText = fileContent.split("\n").slice(firstIndex, firstIndex + patternLines.length).join("\n");

      if (realOldText !== failing.oldText) {
        // Return the corrected edit as guidance for the model to retry
        return {
          content: [{
            type: "text" as const,
            text: `Edit mismatch resolved — whitespace/contamination difference detected.\n\nCorrected edit (oldText copied from actual file):\n\npath: ${input.path}\nedits[0].oldText:\n\`\`\`\n${realOldText}\n\`\`\`\nedits[0].newText:\n\`\`\`\n${failing.newText}\n\`\`\`\n\nCall edit again with the corrected oldText above.`,
          }],
        };
      }
    }

    if (count === 0) {
      const nearest = nearestBlock(fileContent, decontaminated);
      return {
        content: [{
          type: "text" as const,
          text: `Edit failed: the target text was not found in ${input.path}.\n\n${nearest}\n\nRead this region and retry with exact content from the file.`,
        }],
      };
    }

    // count > 1: ambiguous match, leave default error
  });
}