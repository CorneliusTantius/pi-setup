/**
 * pi-retry — simple retry for empty-detail provider errors and stalled streams.
 * Hooks into pi's built-in auto-retry by tagging errors as retryable.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STALL_MS = 90_000;

// Patterns that pi's built-in retry doesn't catch
const EMPTY_DETAIL = /Unknown error \(no error details in response\)/i;
const CODEX_WS_LIMIT = /websocket[_\s-]*connection[_\s-]*limit[_\s-]*reached|create a new websocket connection to continue/i;
const CODEX_GENERIC = /Codex error:[\s\S]*An error occurred while processing your request/i;
const CODEX_RETRY = /You can retry your request/i;

const TAG_STALL = "[stall-retry]";
const TAG_EMPTY = "[empty-detail-retry]";
const TAG_WS = "[codex-ws-limit-retry]";
const TAG_CODEX = "[codex-generic-retry]";
const HINT = "provider returned error";

let stallTimer: ReturnType<typeof setTimeout> | undefined;

export default function piRetry(pi: ExtensionAPI) {
  pi.on("agent_start", (_event, ctx) => {
    ctx.ui.setStatus("pi-retry", undefined);
  });

  pi.on("agent_settled", (_event, ctx) => {
    ctx.ui.setStatus("pi-retry", undefined);
  });

  pi.on("before_provider_request", () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => pi.abort?.(), STALL_MS);
  });

  pi.on("after_provider_response", () => {
    clearTimeout(stallTimer);
  });

  pi.on("message_start", () => {
    // Reset stall timer on each stream chunk
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => pi.abort?.(), STALL_MS);
  });

  pi.on("message_update", () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => pi.abort?.(), STALL_MS);
  });

  pi.on("agent_end", () => {
    clearTimeout(stallTimer);
  });

  pi.on("message_end", (event, ctx) => {
    clearTimeout(stallTimer);

    const msg = event.message as any;
    if (msg?.role !== "assistant" || msg?.stopReason !== "error") return;

    const err = typeof msg.errorMessage === "string" ? msg.errorMessage : "";
    if (!err) return;

    // Match known retryable patterns
    let tag: string | undefined;
    if (EMPTY_DETAIL.test(err)) tag = TAG_EMPTY;
    else if (CODEX_WS_LIMIT.test(err)) tag = TAG_WS;
    else if (CODEX_GENERIC.test(err) && CODEX_RETRY.test(err)) tag = TAG_CODEX;

    if (!tag || err.includes(tag)) return;

    ctx.ui.setStatus("pi-retry", `${tag} retrying…`);
    return {
      message: {
        ...msg,
        errorMessage: `${err}\n\n${tag} ${HINT}`,
      },
    };
  });

  // Handle abort from stall
  pi.on("agent_end", (event, ctx) => {
    const msg = event.message as any;
    if (msg?.role !== "assistant" || !msg?.errorMessage?.includes("aborted")) return;

    return {
      message: {
        ...msg,
        stopReason: "error",
        errorMessage: `${msg.errorMessage || "Provider stream stalled."}\n\n${TAG_STALL} ${HINT}`,
      },
    };
  });
}