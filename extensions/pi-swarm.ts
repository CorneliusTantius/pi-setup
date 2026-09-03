import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_PARALLEL = 6;
const OUTPUT_LIMIT = 30_000;
const DEFAULT_TIMEOUT_MS = 300_000;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type ThinkingLevel = (typeof THINKING_LEVELS)[number];

type SwarmConfig = {
  defaultModel?: string;
  defaultThinking?: ThinkingLevel;
  timeoutMs?: number;
  agents: Array<{
    name: string;
    description: string;
    model?: string | null;
    thinking?: ThinkingLevel;
    tools?: string[];
    systemPrompt: string;
  }>;
};

type RunResult = {
  agent: string;
  task: string;
  exitCode: number;
  output: string;
  stderr: string;
  model?: string;
  thinking?: ThinkingLevel;
  timedOut?: boolean;
};

function defaultConfig(): SwarmConfig {
  const defaultModel = "openai-codex/gpt-5.6-luna";

  const base = "Do only the assigned task. Return findings and blockers. Stay concise and straightforward.";

  return {
    defaultModel,
    defaultThinking: "minimal",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    agents: [
      {
        name: "scout",
        description: "Read-only code scout for locating files, APIs, and likely change points.",
        model: defaultModel,
        thinking: "minimal",
        tools: ["read", "grep", "find", "ls"],
        systemPrompt: `${base}\nScout the repo. Find files, symbols, and change points. Read-only.`,
      },
      {
        name: "worker",
        description: "Small implementation worker for boring localized changes.",
        model: defaultModel,
        thinking: "minimal",
        tools: ["read", "edit", "write", "bash", "grep", "find", "ls"],
        systemPrompt: `${base}\nImplement the change. Keep edits minimal.`,
      },
      {
        name: "tester",
        description: "Test runner/debugger for failures, logs, and small fixes.",
        model: defaultModel,
        thinking: "minimal",
        tools: ["read", "bash", "grep", "find", "ls", "edit"],
        systemPrompt: `${base}\nRun tests, diagnose failures, suggest or apply fixes.`,
      },
      {
        name: "reviewer",
        description: "Read-only reviewer for diffs, risks, and missed edge cases.",
        model: defaultModel,
        thinking: "minimal",
        tools: ["read", "bash", "grep", "find", "ls"],
        systemPrompt: `${base}\nReview diffs for bugs, regressions, missing tests. Read-only.`,
      },
    ],
  };
}

function truncate(text: string) {
  if (Buffer.byteLength(text, "utf8") <= OUTPUT_LIMIT) return text;
  let out = text.slice(0, OUTPUT_LIMIT);
  while (Buffer.byteLength(out, "utf8") > OUTPUT_LIMIT) out = out.slice(0, -1);
  return `${out}\n\n[truncated: output exceeded ${OUTPUT_LIMIT} bytes]`;
}

function formatTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function getPiInvocation(args: string[]) {
  const script = process.argv[1];
  if (script && existsSync(script) && !script.startsWith("/$bunfs/root/")) {
    return { command: process.execPath, args: [script, ...args] };
  }
  const runtime = process.execPath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (/^(node|bun)(\.exe)?$/.test(runtime)) return { command: "pi", args };
  return { command: process.execPath, args };
}

async function runAgent(
  config: SwarmConfig,
  agentName: string,
  task: string,
  cwd: string,
  signal?: AbortSignal,
) {
  const agent = config.agents.find((item) => item.name === agentName);
  if (!agent) {
    const available = config.agents.map((item) => item.name).join(", ") || "none";
    throw new Error(`Unknown agent "${agentName}". Available: ${available}`);
  }

  const model = agent.model ?? config.defaultModel;
  const thinking = agent.thinking ?? config.defaultThinking ?? "low";
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const prompt = `${agent.systemPrompt}\n\nAssigned task:\n${task}`;
  const args = [
    "--mode", "json",
    "--print",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--thinking", thinking,
  ];
  if (model) args.push("--model", model);
  if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
  args.push(prompt);

  return await new Promise<RunResult>((resolve) => {
    const invocation = getPiInvocation(args);
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group so we can kill the whole tree below
    });

    let stdout = "";
    let stderr = "";
    let finalOutput = "";
    let buffer = "";
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;

    // Kill the entire process group. spawn()'s own timeout and child.kill() only hit
    // the direct child; grandchildren (LLM HTTP client, the bash/git the worker/tester
    // agents run) would orphan and leak memory as zombies until the OS reaps them.
    const killGroup = (sig: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try { child.kill(sig); } catch {}
      }
    };

    const clearTimers = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
    };

    const settle = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimers();
      killGroup("SIGKILL"); // reap the whole tree even if close/error already fired
      resolve(result);
    };

    const parseLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (event.type === "message_end" && event.message?.role === "assistant") {
          const text = event.message.content?.find?.((part: any) => part.type === "text")?.text;
          if (text) finalOutput = text;
        }
      } catch {
        stdout += `${line}\n`;
      }
    };

    child.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) parseLine(line);
    });

    child.stderr.on("data", (data) => (stderr += data.toString()));

    child.on("close", (code) => {
      if (buffer) parseLine(buffer);
      const output = truncate(finalOutput || stdout.trim() || stderr.trim() || "(no output)");
      settle({
        agent: agentName,
        task,
        exitCode: code ?? 1,
        output,
        stderr: truncate(stderr.trim()),
        model: model || undefined,
        thinking,
      });
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ETIMEDOUT" || error.message?.includes("timeout")) {
        killGroup("SIGKILL");
        settle({
          agent: agentName,
          task,
          exitCode: 124,
          output: `Agent timed out after ${formatTime(timeoutMs)}.`,
          stderr: `Timeout: ${error.message}`,
          model: model || undefined,
          thinking,
          timedOut: true,
        });
      } else {
        settle({
          agent: agentName,
          task,
          exitCode: 1,
          output: error.message,
          stderr: error.message,
          model: model || undefined,
          thinking,
        });
      }
    });

    if (signal) {
      const abort = () => {
        // Kill the whole group immediately so Esc never leaves a hanging swarm.
        killGroup("SIGKILL");
        if (!settled) {
          settle({
            agent: agentName,
            task,
            exitCode: 130,
            output: "Agent aborted by user (Esc).",
            stderr: "",
            model: model || undefined,
            thinking,
          });
        }
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }

    // Hard timeout managed here: spawn()'s own timeout only kills the direct child.
    timeoutTimer = setTimeout(() => {
      killGroup("SIGKILL");
      if (!settled) {
        settle({
          agent: agentName,
          task,
          exitCode: 124,
          output: `Agent timed out after ${formatTime(timeoutMs)}.`,
          stderr: `Timeout after ${formatTime(timeoutMs)}.`,
          model: model || undefined,
          thinking,
          timedOut: true,
        });
      }
    }, timeoutMs);
    timeoutTimer.unref?.();
  });
}

async function runParallel<T>(items: T[], limit: number, fn: (item: T) => Promise<RunResult>) {
  const results: RunResult[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function formatResults(results: RunResult[]) {
  return results
    .map((result) => {
      let status: string;
      if (result.timedOut) status = "timed out";
      else if (result.exitCode === 0) status = "ok";
      else status = `failed (${result.exitCode})`;

      const meta = [result.model, result.thinking && `thinking:${result.thinking}`]
        .filter(Boolean)
        .join(", ");
      return `## ${result.agent} - ${status}${meta ? ` [${meta}]` : ""}\n\n${result.output}${result.stderr && result.exitCode !== 0 ? `\n\nstderr:\n${result.stderr}` : ""}`;
    })
    .join("\n\n---\n\n");
}

const TaskSchema = Type.Object({
  agent: Type.String({ description: "Configured swarm agent name" }),
  task: Type.String({ description: "Specific task for this agent" }),
});

export default function swarmExtension(pi: ExtensionAPI) {
  const config = defaultConfig();

  pi.registerTool({
    name: "spawn_swarm",
    label: "Spawn Swarm",
    description: "Spawn agents to do work in parallel. One agent+task or many tasks. Fire this for any independent subtask.",
    promptSnippet: "Spawn agents for parallel work — scouting, implementing, testing, reviewing.",
    promptGuidelines: [
      "Use spawn_swarm freely for any independent, bounded subtask.",
      "Prefer spawning agents over doing work yourself when work can be parallelized.",
      "Keep each task specific and bounded.",
    ],
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "Swarm agent name for single mode" })),
      task: Type.Optional(Type.String({ description: "Task for single mode" })),
      tasks: Type.Optional(Type.Array(TaskSchema, { description: "Parallel tasks. Max 6." })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const single = params.agent && params.task;
      const batch = params.tasks?.length ? params.tasks : undefined;
      if (Number(Boolean(single)) + Number(Boolean(batch)) !== 1) {
        return { content: [{ type: "text", text: "Provide exactly one mode: agent+task or tasks[]." }] };
      }
      if (batch && batch.length > MAX_PARALLEL) {
        return { content: [{ type: "text", text: `Too many tasks: max ${MAX_PARALLEL}.` }] };
      }

      if (single) {
        onUpdate?.({ content: [{ type: "text", text: `Running ${params.agent}...` }] });
        const result = await runAgent(config, params.agent!, params.task!, ctx.cwd, signal);
        return {
          content: [{ type: "text", text: formatResults([result]) }],
          details: { results: [result] },
        };
      }

      onUpdate?.({ content: [{ type: "text", text: `Running ${batch!.length} agents...` }] });
      const results = await runParallel(batch!, MAX_PARALLEL, (item) =>
        runAgent(config, item.agent, item.task, ctx.cwd, signal),
      );
      return {
        content: [{ type: "text", text: formatResults(results) }],
        details: { results },
      };
    },
  });
}
