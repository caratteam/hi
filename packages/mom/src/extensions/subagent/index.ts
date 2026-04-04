/**
 * Subagent Extension — Delegate tasks to specialized agents with isolated context.
 *
 * Based on pi's official subagent extension pattern.
 * Spawns a separate pi process per agent invocation (--mode json).
 * The parent agent receives only the final output — intermediate tool calls
 * and exploration stay inside the subagent's context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Extension } from "@mariozechner/pi-coding-agent";
import * as log from "../../log.js";
import type { SandboxConfig } from "../../sandbox.js";
import { type AgentConfig, discoverAgents } from "./agents.js";

// ---------------------------------------------------------------------------
// Subagent trace logging
// ---------------------------------------------------------------------------

const SUBAGENT_LOG_DIR = "/workspace/logs/subagent";
const SUBAGENT_LOG_RETENTION_DAYS = 7;

/** Create a trace log file path for a subagent run. Returns empty string on failure. */
function createTraceLogPath(agentName: string): string {
	try {
		mkdirSync(SUBAGENT_LOG_DIR, { recursive: true });
	} catch {
		return "";
	}
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	return join(SUBAGENT_LOG_DIR, `${ts}_${agentName}.jsonl`);
}

/** Append a single line to the trace log (best-effort). */
function appendTrace(logPath: string, line: string): void {
	try {
		appendFileSync(logPath, `${line}\n`, "utf-8");
	} catch {
		/* best effort */
	}
}

/** Write metadata header to trace log. */
function writeTraceHeader(logPath: string, agentName: string, task: string, model?: string): void {
	appendTrace(
		logPath,
		JSON.stringify({
			_trace: "header",
			agent: agentName,
			task,
			model: model || null,
			startedAt: new Date().toISOString(),
		}),
	);
}

/** Write summary footer to trace log. */
function writeTraceFooter(logPath: string, result: AgentResult): void {
	appendTrace(
		logPath,
		JSON.stringify({
			_trace: "footer",
			exitCode: result.exitCode,
			stopReason: result.stopReason || null,
			errorMessage: result.errorMessage || null,
			usage: result.usage,
			finishedAt: new Date().toISOString(),
		}),
	);
}

/** Delete trace logs older than retention period. */
function cleanupOldTraceLogs(): void {
	try {
		const cutoff = Date.now() - SUBAGENT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
		for (const file of readdirSync(SUBAGENT_LOG_DIR)) {
			if (!file.endsWith(".jsonl")) continue;
			const filePath = join(SUBAGENT_LOG_DIR, file);
			try {
				if (statSync(filePath).mtimeMs < cutoff) unlinkSync(filePath);
			} catch {
				/* skip */
			}
		}
	} catch {
		/* dir doesn't exist yet */
	}
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

interface AgentResult {
	agent: string;
	task: string;
	exitCode: number;
	finalOutput: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Run a single agent
// ---------------------------------------------------------------------------

const MAX_CONCURRENCY = 4;
const DEFAULT_TIMEOUT = 600;

async function runSingleAgent(
	agent: AgentConfig,
	task: string,
	options: {
		cwd: string;
		hostWorkspacePath: string;
		sandboxConfig: SandboxConfig;
		extensionPaths: string[];
		signal?: AbortSignal;
	},
): Promise<AgentResult> {
	const timeout = agent.timeout ?? DEFAULT_TIMEOUT;
	const isDocker = options.sandboxConfig.type === "docker";

	// Write temp system prompt.
	// For docker: write to hostWorkspacePath/.tmp/subagent/ (visible in container as /workspace/.tmp/subagent/)
	// For host: write to os tmpdir
	const hostTmpDir = isDocker ? join(options.hostWorkspacePath, ".tmp", "subagent") : join(tmpdir(), "pi-subagent");
	mkdirSync(hostTmpDir, { recursive: true });
	const promptFileName = `prompt-${agent.name}-${Date.now()}.md`;
	writeFileSync(join(hostTmpDir, promptFileName), agent.systemPrompt, "utf-8");
	// Path as seen by the pi CLI process
	const promptPath = isDocker
		? join("/workspace", ".tmp", "subagent", promptFileName)
		: join(hostTmpDir, promptFileName);
	// Path for cleanup (host filesystem)
	const hostPromptPath = join(hostTmpDir, promptFileName);

	// Create trace log for post-mortem debugging
	const traceLogPath = createTraceLogPath(agent.name);
	writeTraceHeader(traceLogPath, agent.name, task, agent.model);

	const result: AgentResult = {
		agent: agent.name,
		task,
		exitCode: 0,
		finalOutput: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	};

	try {
		const piCliArgs: string[] = ["--mode", "json", "-p", "--no-session"];
		if (agent.model) piCliArgs.push("--model", agent.model);
		if (agent.tools && agent.tools.length > 0) piCliArgs.push("--tools", agent.tools.join(","));

		// Extensions only work for host mode (paths must be accessible)
		if (!isDocker) {
			for (const extPath of options.extensionPaths) {
				piCliArgs.push("-e", extPath);
			}
		}

		piCliArgs.push("--append-system-prompt", promptPath);
		piCliArgs.push(`Task: ${task}`);

		// Build the spawn command
		let spawnCmd: string;
		let spawnArgs: string[];

		if (isDocker) {
			// Run pi CLI inside the container via docker exec
			const container = (options.sandboxConfig as { type: "docker"; container: string }).container;
			const piCli = "/pi-mono/packages/coding-agent/dist/cli.js";
			spawnCmd = "docker";
			spawnArgs = ["exec", container, "node", piCli, ...piCliArgs];
		} else {
			const piArgs = getPiInvocation(piCliArgs);
			spawnCmd = piArgs.command;
			spawnArgs = piArgs.args;
		}

		let wasAborted = false;
		let wasTimeout = false;

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn(spawnCmd, spawnArgs, {
				cwd: isDocker ? undefined : options.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				// Log every event to trace file for debugging
				appendTrace(traceLogPath, line);

				if (event.type === "message_end" && event.message?.role === "assistant") {
					const msg = event.message;
					result.usage.turns++;
					if (msg.usage) {
						result.usage.input += msg.usage.input || 0;
						result.usage.output += msg.usage.output || 0;
						result.usage.cacheRead += msg.usage.cacheRead || 0;
						result.usage.cacheWrite += msg.usage.cacheWrite || 0;
						result.usage.cost += msg.usage.cost?.total || 0;
					}
					if (msg.model) result.model = msg.model;
					if (msg.stopReason) result.stopReason = msg.stopReason;
					if (msg.errorMessage) result.errorMessage = msg.errorMessage;

					// Extract text from content
					for (const part of msg.content || []) {
						if (part.type === "text" && part.text) {
							result.finalOutput = part.text; // Keep last text block
						}
					}
				}
			};

			proc.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data: Buffer) => {
				// Log stderr but don't fail
				const text = data.toString().trim();
				if (text) log.logInfo(`[subagent:${agent.name}] ${text}`);
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => resolve(1));

			// Timeout
			const timer = setTimeout(() => {
				wasTimeout = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					try {
						proc.kill("SIGKILL");
					} catch {
						/* ignore */
					}
				}, 5000);
			}, timeout * 1000);

			// Abort signal
			if (options.signal) {
				const kill = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
				};
				if (options.signal.aborted) kill();
				else options.signal.addEventListener("abort", kill, { once: true });
			}

			proc.on("close", () => clearTimeout(timer));
		});

		result.exitCode = exitCode;
		if (wasTimeout) {
			result.errorMessage = `Timeout after ${timeout}s`;
			result.stopReason = "timeout";
		}
		if (wasAborted) {
			result.errorMessage = "Aborted";
			result.stopReason = "aborted";
		}
	} finally {
		try {
			unlinkSync(hostPromptPath);
		} catch {
			/* ignore */
		}
	}

	// Write trace footer and log the path for easy discovery
	writeTraceFooter(traceLogPath, result);
	log.logInfo(`[subagent:${agent.name}] trace: ${traceLogPath}`);

	return result;
}

// ---------------------------------------------------------------------------
// Pi invocation helper (from official subagent extension)
// ---------------------------------------------------------------------------

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	// mom's process.argv[1] is mom's main.js, not the pi CLI.
	// Resolve the pi CLI from the coding-agent package instead.
	// Resolve pi CLI: find the monorepo root via package.json, then coding-agent/dist/cli.js
	let piCli = "";
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 10; i++) {
		const candidate = join(dir, "packages", "coding-agent", "dist", "cli.js");
		if (existsSync(candidate)) {
			piCli = candidate;
			break;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	if (existsSync(piCli)) {
		return { command: process.execPath, args: [piCli, ...args] };
	}
	return { command: "pi", args };
}

// ---------------------------------------------------------------------------
// Parallel execution with concurrency limit
// ---------------------------------------------------------------------------

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let nextIndex = 0;
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (true) {
			const idx = nextIndex++;
			if (idx >= items.length) return;
			results[idx] = await fn(items[idx]);
		}
	});
	await Promise.all(workers);
	return results;
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export interface SubagentExtensionConfig {
	agentsDirs: string[];
	workspacePath: string;
	hostWorkspacePath: string;
	extensionPaths: string[];
	sandboxConfig: SandboxConfig;
}

export function createSubagentExtension(config: SubagentExtensionConfig): Extension {
	const { agentsDirs, workspacePath, hostWorkspacePath, extensionPaths, sandboxConfig } = config;

	// Discover agents from all configured directories, deduplicating by name (first wins)
	function discoverAllAgents(): AgentConfig[] {
		const seen = new Set<string>();
		const all: AgentConfig[] = [];
		for (const dir of agentsDirs) {
			for (const agent of discoverAgents(dir)) {
				if (!seen.has(agent.name)) {
					seen.add(agent.name);
					all.push(agent);
				}
			}
		}
		return all;
	}

	// Build agent list for tool description (dynamic — updates on each discover)
	function getDescription(): string {
		const agents = discoverAllAgents();
		const agentList = agents.map((a) => `  - ${a.name}: ${a.description}`).join("\n");
		return [
			"Delegate tasks to specialized subagents with isolated context windows.",
			"The subagent runs in a separate process — its intermediate tool calls and exploration",
			"do not enter your context. You receive only the final output.",
			"Use when information is not in your current context.",
			"Exception: reading 1 file is faster with the read tool directly.",
			"",
			"Available agents:",
			agentList || "  (none — add *.md files to ~/.pi/agents/ or /workspace/agents/)",
			"",
			"Modes:",
			'  - Single: { "agent": "name", "task": "..." }',
			'  - Parallel: { "tasks": [{"agent": "name", "task": "..."}, ...] }',
			'  - Chain: { "chain": [{"agent": "name", "task": "... {previous} ..."}, ...] }',
			"Chain mode replaces {previous} with the output of the prior step.",
		].join("\n");
	}

	// The tool execute function
	async function execute(
		_toolCallId: string,
		params: any,
		signal: AbortSignal | undefined,
	): Promise<{ content: Array<{ type: string; text: string }>; details: unknown }> {
		cleanupOldTraceLogs();

		const agents = discoverAllAgents();
		const cwd = workspacePath;

		const runOpts = { cwd, hostWorkspacePath, sandboxConfig, extensionPaths, signal };

		function findAgent(name: string): AgentConfig | undefined {
			return agents.find((a) => a.name === name);
		}

		function formatResult(r: AgentResult): string {
			if (r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "timeout") {
				return `[${r.agent}] Error: ${r.errorMessage || "(no output)"}`;
			}
			return r.finalOutput || "(no output)";
		}

		// --- Single mode ---
		if (params.agent && params.task) {
			const agent = findAgent(params.agent);
			if (!agent) {
				const available = agents.map((a) => a.name).join(", ") || "none";
				return {
					content: [{ type: "text", text: `Unknown agent: "${params.agent}". Available: ${available}` }],
					details: null,
				};
			}
			log.logInfo(`[subagent] single: ${agent.name} — ${params.task.substring(0, 80)}`);
			const result = await runSingleAgent(agent, params.task, runOpts);
			return { content: [{ type: "text", text: formatResult(result) }], details: result };
		}

		// --- Parallel mode ---
		if (params.tasks && params.tasks.length > 0) {
			const tasks = params.tasks as Array<{ agent: string; task: string }>;
			if (tasks.length > 8) {
				return {
					content: [{ type: "text", text: `Too many parallel tasks (${tasks.length}). Max is 8.` }],
					details: null,
				};
			}

			log.logInfo(`[subagent] parallel: ${tasks.length} tasks`);
			const results = await mapWithConcurrency(tasks, MAX_CONCURRENCY, async (t) => {
				const agent = findAgent(t.agent);
				if (!agent) {
					return {
						agent: t.agent,
						task: t.task,
						exitCode: 1,
						finalOutput: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
						errorMessage: `Unknown agent: "${t.agent}"`,
					} as AgentResult;
				}
				return runSingleAgent(agent, t.task, runOpts);
			});

			const summaries = results.map((r) => `[${r.agent}] ${formatResult(r)}`);
			const successCount = results.filter((r) => r.exitCode === 0).length;
			const text = `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`;
			return { content: [{ type: "text", text }], details: results };
		}

		// --- Chain mode ---
		if (params.chain && params.chain.length > 0) {
			const steps = params.chain as Array<{ agent: string; task: string }>;
			log.logInfo(`[subagent] chain: ${steps.length} steps`);

			let previousOutput = "";
			const results: AgentResult[] = [];

			for (let i = 0; i < steps.length; i++) {
				const step = steps[i];
				const agent = findAgent(step.agent);
				if (!agent) {
					const errResult: AgentResult = {
						agent: step.agent,
						task: step.task,
						exitCode: 1,
						finalOutput: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
						errorMessage: `Unknown agent: "${step.agent}"`,
					};
					results.push(errResult);
					return {
						content: [{ type: "text", text: `Chain stopped at step ${i + 1}: ${errResult.errorMessage}` }],
						details: results,
					};
				}

				const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
				const result = await runSingleAgent(agent, taskWithContext, runOpts);
				results.push(result);

				if (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "timeout") {
					return {
						content: [
							{
								type: "text",
								text: `Chain stopped at step ${i + 1} (${step.agent}): ${result.errorMessage || "(failed)"}`,
							},
						],
						details: results,
					};
				}

				previousOutput = result.finalOutput;
			}

			return {
				content: [{ type: "text", text: results[results.length - 1].finalOutput || "(no output)" }],
				details: results,
			};
		}

		// No valid mode
		const available = agents.map((a) => `${a.name}: ${a.description}`).join("\n");
		return {
			content: [
				{
					type: "text",
					text: `Invalid parameters. Provide {agent, task}, {tasks: [...]}, or {chain: [...]}.\n\nAvailable agents:\n${available}`,
				},
			],
			details: null,
		};
	}

	// Build the Extension object with the registered tool
	const toolDefinition = {
		name: "subagent",
		label: "Subagent",
		description: getDescription(),
		parameters: {
			type: "object" as const,
			properties: {
				agent: { type: "string", description: "Agent name (for single mode)" },
				task: { type: "string", description: "Task to delegate (for single mode)" },
				tasks: {
					type: "array",
					description: "Array of {agent, task} for parallel execution (max 8)",
					items: {
						type: "object",
						properties: {
							agent: { type: "string" },
							task: { type: "string" },
						},
						required: ["agent", "task"],
					},
				},
				chain: {
					type: "array",
					description: "Array of {agent, task} for sequential execution. Use {previous} placeholder.",
					items: {
						type: "object",
						properties: {
							agent: { type: "string" },
							task: { type: "string" },
						},
						required: ["agent", "task"],
					},
				},
			},
		},
		execute,
	};

	const sourceInfo = {
		path: "<subagent>",
		source: "built-in" as const,
		scope: "temporary" as const,
		origin: "top-level" as const,
	};

	return {
		path: "<subagent>",
		resolvedPath: "<subagent>",
		sourceInfo,
		handlers: new Map(),
		tools: new Map([[toolDefinition.name, { definition: toolDefinition as any, sourceInfo }]]) as any,
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	} as Extension;
}
