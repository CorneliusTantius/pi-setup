import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";


// ── config ──────────────────────────────────────────────────────────
const RTK_BIN = "rtk";
const OUTPUT_LIMIT_BYTES = 45_000;


function trimMsg(raw: string, max = 180): string {
	const clean = raw.replace(/\s+/g, " ").trim();
	return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function truncateOutput(text: string): string {
	const len = Buffer.byteLength(text, "utf8");
	if (len <= OUTPUT_LIMIT_BYTES) return text;
	let lo = Math.floor(OUTPUT_LIMIT_BYTES / 2), hi = Math.min(len, OUTPUT_LIMIT_BYTES * 2);
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (Buffer.byteLength(text.slice(0, mid), "utf8") <= OUTPUT_LIMIT_BYTES) lo = mid;
		else hi = mid - 1;
	}
	return `${text.slice(0, lo)}\n\n[truncated: output exceeded ${OUTPUT_LIMIT_BYTES} bytes]`;
}

// ── ANSI stripping ──────────────────────────────────────────────────
function stripAnsi(text: string): string {
	if (!text.includes("\x1b")) return text;
	return text
		.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
		.replace(/\x1b\][0-9;]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

// ── command detection ───────────────────────────────────────────────
const ENV_PREFIX_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)*/;

const NEWLINE_RE = /\r?\n/;
const SPLIT_RE = /[&|;]/;

function firstSegment(command: string): string | null {
	const idx = command.search(NEWLINE_RE);
	const first = (idx === -1 ? command : command.slice(0, idx)).trim();
	if (!first) return null;
	const withoutEnv = first.replace(ENV_PREFIX_RE, "").trim();
	if (!withoutEnv) return null;
	return withoutEnv.split(SPLIT_RE)[0]?.trim().toLowerCase() ?? null;
}

// ── build output ────────────────────────────────────────────────────
const BUILD_PATTERNS = [
	/^cargo\s+(build|check)\b/, /^bun\s+build\b/, /^npm\s+run\s+build\b/,
	/^yarn\s+build\b/, /^pnpm\s+build\b/, /^(?:npx\s+)?tsc\b/,
	/^make\b/, /^cmake\b/, /^gradle\b/, /^mvn\b/,
	/^go\s+(build|install)\b/,
];
const BUILD_SKIP = [/^\s*(Compiling|Checking|Downloading|Downloaded|Fetching|Fetched|Updating|Updated|Building|Generated|Creating|Running)\s+/];
const BUILD_ERROR = [/^error\[/, /^error:/, /^\[ERROR\]/, /^FAIL/];
const BUILD_WARN = [/^warning:/, /^\[WARNING\]/, /^warn:/];

function isBuildCmd(cmd: string | null): boolean {
	return cmd !== null && BUILD_PATTERNS.some((p) => p.test(cmd));
}

function filterBuildOutput(text: string, cmd: string | null): string | null {
	if (!isBuildCmd(cmd)) return null;
	const lines = text.split("\n");
	let compiled = 0;
	const errors: string[][] = [];
	const warnings: string[] = [];
	let inError = false;
	let curError: string[] = [];
	let blank = 0;

	for (const line of lines) {
		if (/^\s*(Compiling|Checking|Building)\s+/.test(line)) { compiled++; continue; }
		if (BUILD_SKIP.some((p) => p.test(line))) continue;
		if (BUILD_ERROR.some((p) => p.test(line))) {
			if (inError && curError.length > 0) errors.push([...curError]);
			inError = true; curError = [line]; blank = 0; continue;
		}
		if (BUILD_WARN.some((p) => p.test(line))) { warnings.push(line); continue; }
		if (!inError) continue;
		if (line.trim() === "") {
			blank++;
			if (blank >= 2 && curError.length > 3) { errors.push([...curError]); inError = false; curError = []; }
			else curError.push(line);
		} else if (/^\s/.test(line) || /^-->/.test(line)) { curError.push(line); blank = 0; }
		else { errors.push([...curError]); inError = false; curError = []; }
	}
	if (inError && curError.length > 0) errors.push(curError);

	if (errors.length === 0 && warnings.length === 0) return `[OK] Build successful (${compiled} units compiled)`;

	const out: string[] = [];
	if (errors.length > 0) {
		out.push(`[ERROR] ${errors.length} error(s):`);
		for (const e of errors.slice(0, 5)) { out.push(...e.slice(0, 10)); if (e.length > 10) out.push("  ..."); }
		if (errors.length > 5) out.push(`... and ${errors.length - 5} more errors`);
	}
	if (warnings.length > 0) out.push(`\n[WARN] ${warnings.length} warning(s)`);
	return out.join("\n");
}

// ── test output ─────────────────────────────────────────────────────
const TEST_PATTERNS = [
	/^npm\s+test\b/, /^pnpm\s+test\b/, /^yarn\s+test\b/, /^bun\s+test\b/,
	/^cargo\s+test\b/, /^go\s+test\b/, /^pytest\b/, /^python\s+-m\s+pytest\b/,
	/^(?:pnpm\s+)?(?:npx\s+)?vitest\b/, /^(?:npx\s+)?jest\b/,
	/^mocha\b/, /^ava\b/, /^tap\b/,
];
const TEST_RESULT = [
	/test result:\s*(\w+)\.\s*(\d+)\s*passed;\s*(\d+)\s*failed;/,
	/(\d+)\s*passed(?:,\s*(\d+)\s*failed)?(?:,\s*(\d+)\s*skipped)?/i,
	/(\d+)\s*pass(?:,\s*(\d+)\s*fail)?(?:,\s*(\d+)\s*skip)?/i,
	/tests?:\s*(\d+)\s*passed(?:,\s*(\d+)\s*failed)?(?:,\s*(\d+)\s*skipped)?/i,
];
const FAIL_START = [/^FAIL\s+/, /^FAILED\s+/, /^\s*●\s+/, /^\s*✕\s+/, /test\s+\w+\s+\.\.\.\s*FAILED/, /thread\s+'\w+'\s+panicked/];

function isTestCmd(cmd: string | null): boolean {
	return cmd !== null && TEST_PATTERNS.some((p) => p.test(cmd));
}

function aggregateTestOutput(text: string, cmd: string | null): string | null {
	if (!isTestCmd(cmd)) return null;
	const lines = text.split("\n");
	let passed = 0, failed = 0, skipped = 0;
	const failures: string[] = [];

	for (const p of TEST_RESULT) {
		const m = text.match(p);
		if (m) {
			passed = Number(m[1] ?? 0) || 0;
			failed = Number(m[2] ?? 0) || 0;
			skipped = Number(m[3] ?? 0) || 0;
			break;
		}
	}
	if (passed === 0 && failed === 0) {
		for (const line of lines) {
			if (/\b(?:ok|PASS)\b|[✓✔]/.test(line)) passed++;
			if (/\b(?:FAIL|fail)\b|[✗✕]/.test(line)) failed++;
		}
	}

	if (failed > 0) {
		let inF = false, cur: string[] = [], blank = 0;
		for (const line of lines) {
			if (FAIL_START.some((p) => p.test(line))) {
				if (inF && cur.length > 0) failures.push(cur.join("\n"));
				inF = true; cur = [line]; blank = 0; continue;
			}
			if (!inF) continue;
			if (line.trim() === "") {
				blank++;
				if (blank >= 2 && cur.length > 3) { failures.push(cur.join("\n")); inF = false; cur = []; }
				else cur.push(line);
			} else if (/^\s/.test(line) || /^-/.test(line)) { cur.push(line); blank = 0; }
			else { failures.push(cur.join("\n")); inF = false; cur = []; }
		}
		if (inF && cur.length > 0) failures.push(cur.join("\n"));
	}

	const out: string[] = ["Test Results:"];
	out.push(`   PASS: ${passed} passed`);
	if (failed > 0) out.push(`   FAIL: ${failed} failed`);
	if (skipped > 0) out.push(`   SKIP: ${skipped} skipped`);
	if (failed > 0 && failures.length > 0) {
		out.push("\n   Failures:");
		for (const f of failures.slice(0, 5)) {
			const fl = f.split("\n");
			out.push(`   - ${(fl[0] ?? "").slice(0, 70)}${(fl[0] ?? "").length > 70 ? "..." : ""}`);
			for (const dl of fl.slice(1, 4)) if (dl.trim()) out.push(`     ${dl.slice(0, 65)}${dl.length > 65 ? "..." : ""}`);
			if (fl.length > 4) out.push(`     ... (${fl.length - 4} more lines)`);
		}
		if (failures.length > 5) out.push(`   ... and ${failures.length - 5} more failures`);
	}
	return out.join("\n");
}

// ── git output ──────────────────────────────────────────────────────
const GIT_PATTERNS = [/^git\s+(diff|status|log|show|stash)\b/];

function isGitCmd(cmd: string | null): boolean {
	return cmd !== null && GIT_PATTERNS.some((p) => p.test(cmd));
}

function compactDiff(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let file = "", added = 0, removed = 0;
	for (const line of lines) {
		if (out.length >= 50) { out.push("\n... (more changes truncated)"); break; }
		if (line.startsWith("diff --git")) {
			if (file && (added || removed)) out.push(`  +${added} -${removed}`);
			const m = line.match(/diff --git a\/(.+) b\/(.+)/);
			file = m?.[2] ?? "unknown"; out.push(`\n> ${file}`);
			added = 0; removed = 0; continue;
		}
		if (line.startsWith("@@")) {
			const info = line.match(/@@ .+ @@/)?.[0] ?? "@@";
			out.push(`  ${info}`); continue;
		}
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	if (file && (added || removed)) out.push(`  +${added} -${removed}`);
	return out.join("\n");
}

function compactStatus(text: string): string {
	const lines = text.split("\n");
	if (lines.length <= 1 || (lines.length === 1 && !lines[0]?.trim())) return "Clean working tree";
	let branch = "", staged = 0, modified = 0, untracked = 0, conflicts = 0;
	const stagedFiles: string[] = [], modifiedFiles: string[] = [], untrackedFiles: string[] = [];
	for (const line of lines) {
		if (line.startsWith("##")) { const m = line.match(/## (.+)/); branch = m?.[1]?.split("...")[0] ?? ""; continue; }
		if (line.length < 3) continue;
		const s = line[0], w = line[1], f = line.slice(3);
		if (["M", "A", "D", "R", "C"].includes(s)) { staged++; stagedFiles.push(f); }
		if (s === "U") conflicts++;
		if (["M", "D"].includes(w)) { modified++; modifiedFiles.push(f); }
		if (s === "?" && w === "?") { untracked++; untrackedFiles.push(f); }
	}
	const out: string[] = [`Branch: ${branch}`];
	if (staged > 0) { out.push(`Staged: ${staged} files`); stagedFiles.slice(0, 5).forEach((f) => out.push(`  ${f}`)); if (staged > 5) out.push(`  ... +${staged - 5} more`); }
	if (modified > 0) { out.push(`Modified: ${modified} files`); modifiedFiles.slice(0, 5).forEach((f) => out.push(`  ${f}`)); if (modified > 5) out.push(`  ... +${modified - 5} more`); }
	if (untracked > 0) { out.push(`Untracked: ${untracked} files`); untrackedFiles.slice(0, 3).forEach((f) => out.push(`  ${f}`)); if (untracked > 3) out.push(`  ... +${untracked - 3} more`); }
	if (conflicts > 0) out.push(`Conflicts: ${conflicts} files`);
	return out.join("\n");
}

function compactLog(text: string): string {
	const lines = text.split("\n");
	const out = lines.slice(0, 20).map((l) => l.length > 80 ? `${l.slice(0, 77)}...` : l);
	if (lines.length > 20) out.push(`... and ${lines.length - 20} more commits`);
	return out.join("\n");
}

function compactGitOutput(text: string, cmd: string | null): string | null {
	if (!isGitCmd(cmd)) return null;
	const seg = firstSegment(cmd ?? "");
	if (!seg) return null;
	if (seg.startsWith("git diff")) return /^diff --git /m.test(text) ? compactDiff(text) : null;
	if (seg.startsWith("git status")) return /^(?:## |(?:M|A|D|R|C|U|\?| )\S)/m.test(text) ? compactStatus(text) : null;
	if (seg.startsWith("git log")) return compactLog(text);
	return null;
}

// ── linter output ───────────────────────────────────────────────────
const LINT_PATTERNS = [
	/^(?:pnpm\s+)?(?:npx\s+)?eslint\b/, /^(?:npx\s+)?prettier\b/,
	/^ruff\b/, /^pylint\b/, /^mypy\b/, /^flake8\b/, /^black\b/,
	/^cargo\s+clippy\b/, /^golangci-lint\b/,
];

function isLintCmd(cmd: string | null): boolean {
	return cmd !== null && LINT_PATTERNS.some((p) => p.test(cmd));
}

function lintName(cmd: string | null): string {
	const s = cmd ?? "";
	if (/eslint\b/.test(s)) return "ESLint";
	if (/ruff\b/.test(s)) return "Ruff";
	if (/pylint\b/.test(s)) return "Pylint";
	if (/mypy\b/.test(s)) return "MyPy";
	if (/flake8\b/.test(s)) return "Flake8";
	if (/clippy\b/.test(s)) return "Clippy";
	if (/golangci-lint\b/.test(s)) return "GolangCI-Lint";
	if (/prettier\b/.test(s)) return "Prettier";
	return "Linter";
}

function aggregateLinterOutput(text: string, cmd: string | null): string | null {
	if (!isLintCmd(cmd)) return null;
	const name = lintName(cmd);
	const lines = text.split("\n");
	interface Issue { sev: "ERROR" | "WARNING"; rule: string; file: string; msg: string }
	const issues: Issue[] = [];
	for (const line of lines) {
		const fl = line.match(/^(.+?):(\d+):(\d+):\s*(.+)$/);
		if (fl) {
			const file = fl[1] ?? "?", msg = fl[4] ?? line, sev = /warning/i.test(msg) ? "WARNING" as const : "ERROR" as const;
			const rule = msg.match(/\[(.+?)\]$/)?.[1] ?? "?";
			issues.push({ sev, rule, file, msg });
			continue;
		}
		const rs = line.match(/^(error|warning):\s*(.+?)\s+at\s+(.+):(\d+):(\d+)$/);
		if (rs) {
			issues.push({ sev: (rs[1]?.toUpperCase() ?? "ERROR") as "ERROR" | "WARNING", rule: "?", file: rs[3] ?? "?", msg: rs[2] ?? line });
		}
	}
	if (issues.length === 0) return `[OK] ${name}: No issues found`;
	const errors = issues.filter((i) => i.sev === "ERROR").length;
	const warnings = issues.filter((i) => i.sev === "WARNING").length;
	const byFile = new Map<string, Issue[]>();
	for (const i of issues) { const a = byFile.get(i.file) ?? []; a.push(i); byFile.set(i.file, a); }
	const byRule = new Map<string, number>();
	for (const i of issues) byRule.set(i.rule, (byRule.get(i.rule) ?? 0) + 1);

	let out = `${name}: ${errors} errors, ${warnings} warnings in ${byFile.size} files\n═══════════════════════════════════════\nTop rules:\n`;
	const sortedRules = [...byRule.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
	for (const [r, c] of sortedRules) out += `  ${r} (${c}x)\n`;
	out += "\nTop files:\n";
	const sortedFiles = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 10);
	for (const [f, fi] of sortedFiles) {
		out += `  ${f.length > 40 ? "..." + f.slice(-37) : f} (${fi.length} issues)\n`;
		const fr = new Map<string, number>();
		for (const i of fi) fr.set(i.rule, (fr.get(i.rule) ?? 0) + 1);
		const tr = [...fr.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
		for (const [r, c] of tr) out += `    ${r} (${c})\n`;
	}
	return out;
}

// ── output compaction ───────────────────────────────────────────────
interface CompactState { text: string; techniques: string[] }

function compactBash(text: string, command: string | null): CompactState {
	const st: CompactState = { text, techniques: [] };
	const stripped = stripAnsi(st.text);
	if (stripped !== st.text) { st.text = stripped; st.techniques.push("ansi"); }
	const apply = (fn: (t: string, c: string | null) => string | null, tech: string, guard?: (c: string | null) => boolean) => {
		if (guard && !guard(command)) return;
		const r = fn(st.text, command);
		if (r !== null && r !== st.text) { st.text = r; st.techniques.push(tech); }
	};
	apply(filterBuildOutput, "build", isBuildCmd);
	if (isTestCmd(command)) apply(aggregateTestOutput, "test", () => true);
	if (isGitCmd(command)) apply(compactGitOutput, "git", () => true);
	if (isLintCmd(command)) apply(aggregateLinterOutput, "linter", () => true);
	return st;
}

// ── read/write/edit via node:fs ─────────────────────────────────────
function compactJson(text: string): string | null {
	try {
		const obj = JSON.parse(text);
		if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;

		const boringKeys = new Set([
			"devDependencies", "peerDependencies", "optionalDependencies", "bundleDependencies",
			"scripts", "engines", "publishConfig", "overrides", "pnpm", "lint-staged",
			"commitlint", "release", "husky", "jest", "vitest",
			"eslintConfig", "eslintIgnore", "stylelint", "volta", "packageManager",
		]);
		const listThreshold = 12;

		const strip = (val: unknown, depth: number): unknown => {
			if (depth > 2) return val;
			if (Array.isArray(val)) {
				if (val.length > listThreshold) return `[${val.length} items]`;
				return val.map((v) => strip(v, depth + 1));
			}
			if (val !== null && typeof val === "object") {
				const entries = Object.entries(val as Record<string, unknown>);
				if (entries.length === 0) return val;
				const out: Record<string, unknown> = {};
				for (const [k, v] of entries) {
					if (boringKeys.has(k)) {
						out[`[${k}]`] = Array.isArray(v) ? `${v.length} entries` : "(omitted)";
					} else if (Array.isArray(v) && v.length > listThreshold) {
						out[k] = `[${v.length} items]`;
					} else {
						out[k] = strip(v, depth + 1);
					}
				}
				return out;
			}
			return val;
		};

		return JSON.stringify(strip(obj, 0), null, 2);
	} catch {
		return null;
	}
}

function readFile(path: string, offset?: number, limit?: number): string {
	if (!existsSync(path)) throw new Error(`File not found: ${path}`);
	let content = readFileSync(path, "utf8");

	// JSON compaction: strip boring fields, compact large lists
	if (path.endsWith(".json") && offset === undefined && limit === undefined) {
		const compacted = compactJson(content);
		if (compacted !== null) content = compacted;
	}

	if (offset !== undefined) {
		const lines = content.split("\n");
		const start = offset < 1 ? 0 : offset - 1;
		const end = limit !== undefined ? start + limit : undefined;
		content = lines.slice(start, end).join("\n");
	}
	return content;
}

function writeFile(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, "utf8");
}

function applyEdit(path: string, oldText: string, newText: string): boolean {
	if (!existsSync(path)) throw new Error(`File not found: ${path}`);
	const content = readFileSync(path);
	const idx = content.indexOf(oldText);
	if (idx === -1) throw new Error(`oldText not found in ${path}`);
	const updated = content.slice(0, idx) + newText + content.slice(idx + oldText.length);
	writeFileSync(path, updated, "utf8");
	return true;
}

// ── RTK rewrite ─────────────────────────────────────────────────────
interface RewriteResult { changed: boolean; original: string; rewritten: string; error?: string }

let rtkStatus: { available: boolean; checkedAt: number; error?: string } = { available: false, checkedAt: 0 };

async function checkRtk(pi: ExtensionAPI): Promise<boolean> {
	const now = Date.now();
	if (now - rtkStatus.checkedAt < 300_000) return rtkStatus.available;
	try {
		const r = await pi.exec(RTK_BIN, ["--version"], { timeout: 5000 });
		rtkStatus = { available: r.code === 0, checkedAt: now, error: r.code !== 0 ? `exit ${r.code}` : undefined };
	} catch (e) {
		rtkStatus = { available: false, checkedAt: now, error: e instanceof Error ? e.message : String(e) };
	}
	return rtkStatus.available;
}

async function rewriteCommand(pi: ExtensionAPI, command: string): Promise<RewriteResult> {
	if (!command?.trim()) return { changed: false, original: command, rewritten: command };
	const seg = firstSegment(command);
	if (!seg || seg === "rtk" || seg.startsWith("rtk ")) return { changed: false, original: command, rewritten: command };
	try {
		const r = await pi.exec(RTK_BIN, ["rewrite", command], { timeout: 3000 });
		if (r.code === 2) return { changed: false, original: command, rewritten: command, error: r.stderr?.trim() || "rtk denied" };
		if (r.code === 0 || r.code === 3) {
			const rewritten = r.stdout?.trim();
			if (rewritten && rewritten !== command) return { changed: true, original: command, rewritten };
		}
		return { changed: false, original: command, rewritten: command };
	} catch (e) {
		return { changed: false, original: command, rewritten: command, error: e instanceof Error ? e.message : String(e) };
	}
}

// ── tool schemas ────────────────────────────────────────────────────
const BashParams = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional)" })),
});

const ReadParams = Type.Object({
	path: Type.String({ description: "File path to read" }),
	offset: Type.Optional(Type.Number({ description: "Starting line (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Max lines to read" })),
});

const WriteParams = Type.Object({
	path: Type.String({ description: "File path to write" }),
	content: Type.String({ description: "Content to write" }),
});

const EditParams = Type.Object({
	path: Type.String({ description: "File path to edit" }),
	oldText: Type.String({ description: "Exact text to replace (must match exactly once)" }),
	newText: Type.String({ description: "Replacement text" }),
});

// ── extension ───────────────────────────────────────────────────────
export default function rtkRewriteExtension(pi: ExtensionAPI) {
	// ── bash tool ──────────────────────────────────────────────────
	pi.registerTool({
		name: "bash",
		label: "Bash",
		description: "Execute a shell command with RTK-optimized rewriting and output compaction.",
		promptSnippet: "Execute a shell command. Output is automatically compacted (ANSI stripped, build/test/git/linter summarized).",
		promptGuidelines: [
			"RTK rewrite may optimize commands for efficiency; the rewrite is transparent.",
			"Bash output is compacted: ANSI stripped, build/test/git/linter output summarized.",
		],
		parameters: BashParams,
		async execute(_id, params, signal, onUpdate, ctx) {
			let command = params.command;
			const timeoutMs = (params.timeout ?? 90) * 1000;

			// RTK rewrite
			if (await checkRtk(pi)) {
				const decision = await rewriteCommand(pi, command);
				if (decision.changed) {
					if (ctx.hasUI) ctx.ui.notify(`rtk: ${trimMsg(command, 60)} → ${trimMsg(decision.rewritten, 60)}`, "info");
					command = decision.rewritten;
				}
			}

			onUpdate?.({ content: [{ type: "text", text: `$ ${command}` }] });

			try {
				const result = await pi.exec("bash", ["-c", command], { signal, timeout: timeoutMs });
				let output = result.stdout || result.stderr || "";
				if (result.code !== 0 && result.stderr) output = `${output}\n${result.stderr}`.trim();
				output = truncateOutput(output);

				// Compact output
				const cmdSeg = firstSegment(command);
				const compacted = compactBash(output, cmdSeg);
				const text = compacted.techniques.length > 0
					? `[RTK compacted: ${compacted.techniques.join(", ")}]\n${compacted.text}`
					: compacted.text;

				return {
					content: [{ type: "text", text: text || "(empty output)" }],
					details: { exitCode: result.code, command },
				};
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return {
					content: [{ type: "text", text: `Error: ${msg}` }],
					details: { command },
					isError: true,
				};
			}
		},
	});

	// ── read tool ──────────────────────────────────────────────────
	pi.registerTool({
		name: "read",
		label: "Read",
		description: "Read file contents. Supports offset (1-indexed line number) and limit (max lines).",
		promptSnippet: "Read file contents with optional line offset and limit.",
		promptGuidelines: ["Use read to examine files instead of cat or sed."],
		parameters: ReadParams,
		async execute(_id, params) {
			try {
				let content = readFile(params.path, params.offset, params.limit);
				content = content || "(empty file)";
				return {
					content: [{ type: "text", text: content }],
					details: { path: params.path, offset: params.offset, limit: params.limit },
				};
			} catch (e) {
				return {
					content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
					isError: true,
				};
			}
		},
	});

	// ── write tool ─────────────────────────────────────────────────
	pi.registerTool({
		name: "write",
		label: "Write",
		description: "Write content to a file. Creates parent directories if needed.",
		promptSnippet: "Write content to a file (creates parent dirs).",
		promptGuidelines: ["Use write to create new files or overwrite existing ones."],
		parameters: WriteParams,
		async execute(_id, params) {
			try {
				writeFile(params.path, params.content);
				return {
					content: [{ type: "text", text: `Wrote ${Buffer.byteLength(params.content, "utf8")} bytes to ${params.path}` }],
					details: { path: params.path, size: params.content.length },
				};
			} catch (e) {
				return {
					content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
					isError: true,
				};
			}
		},
	});

	// ── edit tool ──────────────────────────────────────────────────
	pi.registerTool({
		name: "edit",
		label: "Edit",
		description: "Edit a file by replacing exact text. oldText must match exactly once.",
		promptSnippet: "Edit a file by replacing exact matching text.",
		parameters: EditParams,
		async execute(_id, params) {
			try {
				applyEdit(params.path, params.oldText, params.newText);
				return {
					content: [{ type: "text", text: `Applied edit to ${params.path} (replaced ${params.oldText.length} chars → ${params.newText.length} chars)` }],
					details: { path: params.path },
				};
			} catch (e) {
				return {
					content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
					isError: true,
				};
			}
		},
	});
}