import { createServer } from "node:http";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type ServerConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  token?: string;
  tokenEnv?: string;
  oauth?: boolean;
  clientMetadataUrl?: string;
};

type Settings = { mcpServers?: Record<string, ServerConfig> };
type ConnectedServer = { client: Client; transport: StdioClientTransport | StreamableHTTPClientTransport; tools: string[] };

const TOOL_PREFIX = "mcp_";
const OAUTH_CALLBACK_PORT = 43123;
const clients = new Map<string, ConnectedServer>();
const registeredTools = new Set<string>();
let enabled = false;

function settingsPaths(cwd: string): string[] {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return [join(agentDir, "settings.json"), join(cwd, ".pi", "settings.json")];
}

function loadServers(cwd: string): Record<string, ServerConfig> {
  const result: Record<string, ServerConfig> = {};
  for (const path of settingsPaths(cwd)) {
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as Settings;
      if (value.mcpServers && typeof value.mcpServers === "object") Object.assign(result, value.mcpServers);
    } catch {
      // Missing or malformed settings are reported by /mcp enable, not startup.
    }
  }
  return result;
}

function toolName(server: string, name: string): string {
  return `${TOOL_PREFIX}${server}_${name}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function schema(input: any): any {
  if (!input || input.type !== "object") return Type.Any();
  const properties = input.properties && typeof input.properties === "object" ? input.properties : {};
  const required = new Set(Array.isArray(input.required) ? input.required : []);
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(properties)) {
    const item = value as any;
    let field: any;
    if (item.type === "string") field = Type.String({ description: item.description });
    else if (item.type === "number" || item.type === "integer") field = Type.Number({ description: item.description });
    else if (item.type === "boolean") field = Type.Boolean({ description: item.description });
    else if (item.type === "array") field = Type.Array(Type.Any(), { description: item.description });
    else field = Type.Any({ description: item.description });
    out[key] = required.has(key) ? field : Type.Optional(field);
  }
  return Type.Object(out, { additionalProperties: true });
}

function contentText(result: any): string {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content.filter((item: any) => item?.type === "text").map((item: any) => item.text).join("\n");
  const structured = result?.structuredContent;
  return text || (structured === undefined ? JSON.stringify(result ?? {}) : JSON.stringify(structured));
}

type AuthState = {
  clientInformation?: any;
  tokens?: any;
  codeVerifier?: string;
  discoveryState?: any;
};

function authPath(serverName: string): string {
  const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(dir, "mcp-auth.json");
}

function loadAuth(serverName: string): AuthState {
  try {
    const all = JSON.parse(readFileSync(authPath(serverName), "utf8")) as Record<string, AuthState>;
    return all[serverName] || {};
  } catch {
    return {};
  }
}

function saveAuth(serverName: string, state: AuthState): void {
  const path = authPath(serverName);
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true });
  let all: Record<string, AuthState> = {};
  try { all = JSON.parse(readFileSync(path, "utf8")); } catch { /* first login */ }
  all[serverName] = state;
  writeFileSync(path, JSON.stringify(all, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

function clearAuth(serverName: string): void {
  const path = authPath(serverName);
  try {
    const all = JSON.parse(readFileSync(path, "utf8")) as Record<string, AuthState>;
    delete all[serverName];
    writeFileSync(path, JSON.stringify(all, null, 2), { mode: 0o600 });
  } catch { /* already logged out */ }
}

async function oauthProvider(serverName: string, config: ServerConfig): Promise<{ provider: any; waitForCode: () => Promise<string>; close: () => void }> {
  const state = loadAuth(serverName);
  const callback = createServer();
  let callbackResolve!: (code: string) => void;
  let callbackReject!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => { callbackResolve = resolve; callbackReject = reject; });
  callback.on("request", (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") { response.writeHead(404); response.end(); return; }
    const error = url.searchParams.get("error");
    if (error) {
      callbackReject(new Error(`${error}: ${url.searchParams.get("error_description") || "authorization failed"}`));
      response.end("Authorization failed. You can close this window.");
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) { callbackReject(new Error("OAuth callback did not include an authorization code")); response.end("Missing authorization code."); return; }
    callbackResolve(code);
    response.end("Pi MCP authorization complete. You can close this window.");
  });
  await new Promise<void>((resolve, reject) => callback.listen(OAUTH_CALLBACK_PORT, "127.0.0.1", () => resolve()).on("error", reject));
  const address = callback.address();
  if (!address || typeof address === "string") throw new Error("Could not start OAuth callback server");
  const redirectUrl = `http://localhost:${OAUTH_CALLBACK_PORT}/callback`;
  const provider: any = {
    get redirectUrl() { return redirectUrl; },
    clientMetadataUrl: config.clientMetadataUrl,
    get clientMetadata() { return { client_name: "Pi", redirect_uris: [redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }; },
    clientInformation: () => state.clientInformation,
    saveClientInformation: (value: any) => { state.clientInformation = value; saveAuth(serverName, state); },
    tokens: () => state.tokens,
    saveTokens: (value: any) => { state.tokens = value; saveAuth(serverName, state); },
    saveCodeVerifier: (value: string) => { state.codeVerifier = value; saveAuth(serverName, state); },
    codeVerifier: () => state.codeVerifier,
    discoveryState: () => state.discoveryState,
    saveDiscoveryState: (value: any) => { state.discoveryState = value; saveAuth(serverName, state); },
    redirectToAuthorization: (url: URL) => {
      const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
      const args = process.platform === "win32" ? ["/c", "start", "", url.toString()] : [url.toString()];
      spawn(command, args, { detached: true, stdio: "ignore" }).unref();
    },
  };
  return { provider, waitForCode: async () => { try { return await codePromise; } finally { callback.close(); } }, close: () => callback.close() };
}

async function authenticateServer(serverName: string, config: ServerConfig): Promise<any | undefined> {
  if (config.oauth === false || config.token || config.tokenEnv) return undefined;
  if (!config.url) return undefined;
  const { provider, waitForCode, close } = await oauthProvider(serverName, config);
  try {
    const first = await auth(provider, { serverUrl: config.url });
    if (first === "REDIRECT") {
      const code = await waitForCode();
      await auth(provider, { serverUrl: config.url, authorizationCode: code });
    }
    close();
    return provider;
  } catch (error) {
    close();
    throw error;
  }
}

async function connectServer(pi: ExtensionAPI, serverName: string, config: ServerConfig, cwd: string): Promise<string[]> {
  if (!config.command && !config.url) throw new Error("needs command or url");
  const client = new Client({ name: "pi-setup", version: "0.1.0" }, { capabilities: {} });
  const oauth = config.command ? undefined : await authenticateServer(serverName, config);
  let transport: StdioClientTransport | StreamableHTTPClientTransport;
  if (config.command) {
    const env = { ...config.env };
    if (config.tokenEnv && process.env[config.tokenEnv]) env[config.tokenEnv] = process.env[config.tokenEnv]!;
    transport = new StdioClientTransport({ command: config.command, args: config.args, env, cwd: config.cwd || cwd, stderr: "pipe" });
  } else {
    const headers = { ...config.headers };
    const token = config.token || (config.tokenEnv ? process.env[config.tokenEnv] : undefined);
    if (token) headers.Authorization = `Bearer ${token}`;
    transport = new StreamableHTTPClientTransport(new URL(config.url!), {
      authProvider: oauth,
      requestInit: { headers },
    });
  }
  await client.connect(transport);
  const listed = await client.listTools();
  const names: string[] = [];
  for (const remote of listed.tools ?? []) {
    const local = toolName(serverName, remote.name);
    names.push(local);
    if (registeredTools.has(local)) continue;
    pi.registerTool({
      name: local,
      label: `${serverName}: ${remote.name}`,
      description: remote.description || `MCP tool ${remote.name} from ${serverName}`,
      parameters: schema(remote.inputSchema),
      async execute(_id, params, signal) {
        const current = clients.get(serverName);
        if (!current) return { content: [{ type: "text", text: `MCP server '${serverName}' is disconnected.` }], isError: true };
        try {
          const result = await current.client.callTool({ name: remote.name, arguments: params as Record<string, unknown> }, undefined, { signal });
          return { content: [{ type: "text", text: contentText(result) }], details: result };
        } catch (error) {
          return { content: [{ type: "text", text: `MCP ${serverName}/${remote.name} failed: ${String(error)}` }], isError: true };
        }
      },
    });
    registeredTools.add(local);
  }
  clients.set(serverName, { client, transport, tools: names });
  return names;
}

async function disconnectAll(pi: ExtensionAPI): Promise<void> {
  for (const server of clients.values()) {
    try { await server.client.close(); } catch { /* best effort */ }
  }
  clients.clear();
  pi.setActiveTools(pi.getActiveTools().filter((name) => !name.startsWith(TOOL_PREFIX)));
  enabled = false;
}

export default function piMcp(pi: ExtensionAPI): void {
  pi.registerCommand("mcp", {
    description: "Enable or disable configured MCP servers",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const command = parts[0]?.toLowerCase();
      if (command === "login" || command === "logout") {
        const serverName = parts[1];
        const servers = loadServers(ctx.cwd);
        const config = serverName ? servers[serverName] : undefined;
        if (!serverName || !config) {
          ctx.ui.notify(`Usage: /mcp ${command} <server>`, "warning");
          return;
        }
        if (command === "logout") {
          clearAuth(serverName);
          ctx.ui.notify(`MCP logged out: ${serverName}`, "info");
          return;
        }
        try {
          await authenticateServer(serverName, config);
          ctx.ui.notify(`MCP login complete: ${serverName}`, "info");
        } catch (error) {
          ctx.ui.notify(`MCP login failed (${serverName}): ${String(error)}`, "error");
        }
        return;
      }
      if (command === "disable") {
        await disconnectAll(pi);
        ctx.ui.notify("MCP disabled", "info");
        return;
      }
      if (command !== "enable") {
        ctx.ui.notify("Usage: /mcp enable | /mcp disable | /mcp login <server> | /mcp logout <server>", "info");
        return;
      }
      if (enabled) {
        ctx.ui.notify("MCP is already enabled", "info");
        return;
      }
      const servers = loadServers(ctx.cwd);
      const names = Object.keys(servers);
      if (!names.length) {
        ctx.ui.notify("No mcpServers configured in settings.json", "warning");
        return;
      }
      const active = new Set(pi.getActiveTools());
      const connected: string[] = [];
      for (const name of names) {
        try {
          const tools = await connectServer(pi, name, servers[name], ctx.cwd);
          tools.forEach((tool) => active.add(tool));
          connected.push(`${name} (${tools.length} tools)`);
        } catch (error) {
          ctx.ui.notify(`MCP ${name}: ${String(error)}`, "error");
        }
      }
      enabled = connected.length > 0;
      pi.setActiveTools([...active]);
      ctx.ui.notify(enabled ? `MCP enabled: ${connected.join(", ")}` : "No MCP servers connected", enabled ? "info" : "warning");
    },
  });

  pi.on("session_start", () => { enabled = false; });
  pi.on("session_shutdown", async () => { await disconnectAll(pi); });
}
