/**
 * pi-general-enhancement — storm-breaker + rewind.
 *
 * Model-agnostic improvements that work with any provider:
 *
 * 1. Storm-breaker — enhances cryptic tool errors with actionable diagnostics,
 *    breaks consecutive-failure loops after N identical errors. Prevents the
 *    model from spinning on the same broken call.
 *
 * 2. Rewind — git-stash-based file snapshots before each turn. /rewind N
 *    restores files to before turn N. Disabled by default (set PI_REWIND_ENABLED=1).
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";

// ── Config ───────────────────────────────────────────────────────────────────

const FAIL_THRESHOLD = Math.max(1, Number(process.env.PI_STORMBREAKER_THRESHOLD) || 3);
const REWIND_ENABLED = ["1", "true", "yes"].includes((process.env.PI_REWIND_ENABLED || "").toLowerCase());

// ── Storm-breaker state ──────────────────────────────────────────────────────

interface FailureRecord {
  toolName: string;
  errorSignature: string; // normalized error dedup key
  count: number;
}

let currentFailure: FailureRecord | null = null;

// Normalize error for dedup (strip paths, line numbers, timestamps)
function errorSignature(toolName: string, errorText: string): string {
  return `${toolName}:${errorText
    .replace(/\/[^\s:]+/g, "<path>")
    .replace(/line \d+/gi, "line N")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, "<ts>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .slice(0, 200)}`;
}

function enhanceError(toolName: string, errorText: string): string {
  // Empty path errors
  if (/no such file or directory/i.test(errorText) || /open\s*:?\s*no such file/i.test(errorText)) {
    if (errorText.includes('""') || /open\s+|open\s+''/.test(errorText)) {
      return "Error: the 'path' argument is empty or missing. Provide a valid file path.";
    }
  }
  // Permission errors
  if (/permission denied/i.test(errorText)) {
    return `${errorText}\n\nCheck file permissions or path.`;
  }
  // Edit not-found errors
  if (/old_text.*not found|old_string.*not found|did not match|exact string.*not found/i.test(errorText)) {
    return `${errorText}\n\nThe exact string was not found. The file may have changed or whitespace differs. Re-read the file and retry.`;
  }
  // Offset out of bounds
  if (/offset.*beyond end of file/i.test(errorText)) {
    return `${errorText}\nFile may be shorter than expected. Use read without offset to see the full file.`;
  }
  return `[${toolName}] ${errorText}`;
}

// ── Rewind state ─────────────────────────────────────────────────────────────

interface Checkpoint {
  turnIndex: number;
  stashRef: string;
  headSha: string;
  timestamp: number;
}

let checkpoints: Map<number, Checkpoint> = new Map();
let insideRepo = false;

function checkGitRepo(cwd: string): boolean {
  try {
    const out = execSync("git rev-parse --is-inside-work-tree", {
      cwd,
      timeout: 2000,
      encoding: "utf-8",
    });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

function createStashSnapshot(cwd: string): { stashRef: string; headSha: string } {
  let stashRef = "";
  let headSha = "";
  try {
    stashRef = execSync("git stash create --include-untracked", {
      cwd,
      timeout: 5000,
      encoding: "utf-8",
    }).trim();
  } catch { /* tree may be clean */ }
  try {
    headSha = execSync("git rev-parse HEAD", {
      cwd,
      timeout: 2000,
      encoding: "utf-8",
    }).trim();
  } catch { /* no commits */ }
  return { stashRef, headSha };
}

// ── Entry ────────────────────────────────────────────────────────────────────

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

    // Extract result text
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
  // Rewind (off by default)
  // ═══════════════════════════════════════════════════════════════════════

  if (!REWIND_ENABLED) return;

  // Check git repo on session start
  pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
    insideRepo = checkGitRepo(ctx.cwd);
  });

  // Snapshot before each turn
  pi.on("turn_start", async (event: any, ctx: ExtensionContext) => {
    if (!insideRepo) return;

    const { stashRef, headSha } = createStashSnapshot(ctx.cwd);
    checkpoints.set(event.turnIndex, { turnIndex: event.turnIndex, stashRef, headSha, timestamp: event.timestamp });

    // Keep last 100
    if (checkpoints.size > 100) {
      const oldest = Math.min(...checkpoints.keys());
      checkpoints.delete(oldest);
    }
  });

  // /rewind command
  pi.registerCommand("rewind", {
    description: "Rewind to a previous turn: /rewind N restores files to before turn N. Without N, lists checkpoints.",
    handler: async (args: string, ctx: any) => {
      if (!insideRepo) {
        ctx.ui.notify("Rewind requires a git repository", "warning");
        return;
      }

      const turnArg = args.trim();

      // No argument — list checkpoints
      if (!turnArg) {
        if (checkpoints.size === 0) {
          ctx.ui.notify("No checkpoints recorded yet", "info");
          return;
        }
        const lines = ["Available rewind checkpoints:"];
        for (const [turn, cp] of checkpoints) {
          const time = new Date(cp.timestamp).toLocaleTimeString();
          const status = cp.stashRef ? "has changes" : "clean tree";
          lines.push(`  Turn ${turn} (${time}, ${status})`);
        }
        lines.push("", "Use /rewind N to rewind to before turn N");
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      const targetTurn = Number.parseInt(turnArg, 10);
      if (!Number.isFinite(targetTurn)) {
        ctx.ui.notify(`Invalid turn number: ${turnArg}`, "warning");
        return;
      }

      const checkpoint = checkpoints.get(targetTurn);
      if (!checkpoint) {
        ctx.ui.notify(`No checkpoint for turn ${targetTurn}. Available: ${[...checkpoints.keys()].join(", ")}`, "warning");
        return;
      }

      try {
        if (checkpoint.stashRef) {
          execSync("git reset HEAD -- .", { cwd: ctx.cwd, timeout: 5000 });
          execSync("git checkout -- .", { cwd: ctx.cwd, timeout: 5000 });
          execSync("git clean -fd", { cwd: ctx.cwd, timeout: 5000 });

          // If HEAD drifted, reset to checkpoint's HEAD first
          try {
            const currentHead = execSync("git rev-parse HEAD", { cwd: ctx.cwd, timeout: 2000, encoding: "utf-8" }).trim();
            if (currentHead && checkpoint.headSha && currentHead !== checkpoint.headSha) {
              execSync(`git reset --hard ${checkpoint.headSha}`, { cwd: ctx.cwd, timeout: 5000 });
            }
          } catch { /* ignore */ }

          execSync(`git stash apply ${checkpoint.stashRef}`, { cwd: ctx.cwd, timeout: 5000 });
        } else {
          execSync("git reset HEAD -- .", { cwd: ctx.cwd, timeout: 5000 });
          execSync("git checkout -- .", { cwd: ctx.cwd, timeout: 5000 });
          execSync("git clean -fd", { cwd: ctx.cwd, timeout: 5000 });
        }
      } catch (err) {
        ctx.ui.notify(`Failed to restore files: ${err}`, "error");
        return;
      }

      ctx.ui.notify(
        `Rewound to before turn ${targetTurn}. Files restored from git stash.\nUse session tree (ctrl+t) to navigate conversation if needed.`,
        "info",
      );
    },
  });
}