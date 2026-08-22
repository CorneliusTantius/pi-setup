import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_PARALLEL = 6;
const OUTPUT_LIMIT = 30_000;
const DEFAULT_TIMEOUT_MS = 120_000;
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
  const defaultModel = "azure_ai/deepseek-v4-flash";

  const base = [
    "You are a small focused swarm agent.",
    "Use low/medium effort, stay concise, and do only the assigned task.",
    "Return findings, changed files, commands run, and any blockers.",
    "Do not start broad refactors or extra work.",
  ].join("\n");

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
        systemPrompt: `${base}\nYou scout the repo and report exact files, symbols, and next steps. Do not edit files.`,
      },
      {
        name: "worker",
        description: "Small implementation worker for boring localized changes.",
        model: defaultModel,
        thinking: "minimal",
        tools: ["read", "edit", "write", "bash", "grep", "find", "ls"],
        systemPrompt: `${base}\nYou implement small localized code changes. Keep edits minimal and obvious.`,
      },
      {
        name: "tester",
        description: "Test runner/debugger for failures, logs, and small fixes.",
        model: defaultModel,
        thinking: "minimal",
        tools: ["read", "bash", "grep", "find", "ls", "edit"],
        systemPrompt: `${base}\nYou run targeted tests, diagnose failures, and suggest or apply small fixes only when asked.`,
      },
      {
        name: "reviewer",
        description: "Read-only reviewer for diffs, risks, and missed edge cases.",
        model: defaultModel,
        thinking: "minimal",
        tools: ["read", "bash", "grep", "find", "ls"],
        systemPrompt: `${base}\nYou review work. Prioritize bugs, regressions, missing tests, and simple fixes. Do not edit files.`,
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
      timeout: timeoutMs,
    });

    let stdout = "";
    let stderr = "";
    let finalOutput = "";
    let buffer = "";
    let settled = false;

    const settle = (result: RunResult) => {
      if (settled) return;
      settled = true;
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
      const abort = () => child.kill("SIGTERM");
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
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
    description: "Spawn configured low/medium-thinking swarm agents. Use one agent+task or parallel tasks.",
    promptSnippet: "Spawn configured swarm agents for isolated grunt work, scouting, testing, or review.",
    promptGuidelines: [
      "Use spawn_swarm to delegate independent grunt-work tasks to small configured agents.",
      "Keep spawn_swarm tasks specific and bounded; do not delegate broad planning or vague work.",
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