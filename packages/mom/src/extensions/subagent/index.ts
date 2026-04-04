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
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Extension, Skill } from "@mariozechner/pi-coding-agent";
import { formatSkillsForPrompt } from "@mariozechner/pi-coding-agent";
import * as log from "../../log.js";
import { type AgentConfig, discoverAgents } from "./agents.js";

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
// Common header for subagent system prompts
// ---------------------------------------------------------------------------

function buildCommonHeader(workspacePath: string, skills: Skill[]): string {
	const date = new Date().toISOString().slice(0, 10);

	let memory = "";
	try {
		memory = readFileSync(join(workspacePath, "MEMORY.md"), "utf-8");
	} catch {
		// no memory file
	}

	const parts = [
		`Current date: ${date}`,
		"",
		"## Workspace Layout",
		`${workspacePath}/`,
		"├── MEMORY.md",
		"├── skills/",
		"├── agents/",
		"└── [channel dirs]",
		"",
		"## Skills",
		formatSkillsForPrompt(skills),
		"",
		"## Memory",
		memory,
	];

	return parts.join("\n");
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
		extensionPaths: string[];
		commonHeader: string;
		signal?: AbortSignal;
	},
): Promise<AgentResult> {
	const timeout = agent.timeout ?? DEFAULT_TIMEOUT;

	// Write temp system prompt: [common header] + [agent body]
	const tmpDir = join(tmpdir(), "pi-subagent");
	mkdirSync(tmpDir, { recursive: true });
	const promptPath = join(tmpDir, `prompt-${agent.name}-${Date.now()}.md`);
	writeFileSync(promptPath, `${options.commonHeader}\n\n${agent.systemPrompt}`, "utf-8");

	const result: AgentResult = {
		agent: agent.name,
		task,
		exitCode: 0,
		finalOutput: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	};

	try {
		const args: string[] = ["--mode", "json", "-p", "--no-session"];
		if (agent.model) args.push("--model", agent.model);
		if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

		// Pass all mom extensions to the subagent
		for (const extPath of options.extensionPaths) {
			args.push("-e", extPath);
		}

		args.push("--append-system-prompt", promptPath);
		args.push(`Task: ${task}`);

		// Resolve pi invocation — reuse current process if possible
		const piArgs = getPiInvocation(args);

		let wasAborted = false;
		let wasTimeout = false;

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn(piArgs.command, piArgs.args, {
				cwd: options.cwd,
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
			unlinkSync(promptPath);
		} catch {
			/* ignore */
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// Pi invocation helper (from official subagent extension)
// ---------------------------------------------------------------------------

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
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
	agentsDir: string;
	workspacePath: string;
	skills: Skill[];
	extensionPaths: string[];
}

export function createSubagentExtension(config: SubagentExtensionConfig): Extension {
	const { agentsDir, workspacePath, skills, extensionPaths } = config;

	// Build agent list for tool description (dynamic — updates on each discover)
	function getDescription(): string {
		const agents = discoverAgents(agentsDir);
		const agentList = agents.map((a) => `  - ${a.name}: ${a.description}`).join("\n");
		return [
			"Delegate tasks to specialized subagents with isolated context windows.",
			"The subagent runs in a separate process — its intermediate tool calls and exploration",
			"do not enter your context. You receive only the final output.",
			"Use when information is not in your current context.",
			"Exception: reading 1 file is faster with the read tool directly.",
			"",
			"Available agents:",
			agentList || "  (none — add *.md files to /workspace/agents/)",
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
		const agents = discoverAgents(agentsDir);
		const commonHeader = buildCommonHeader(workspacePath, skills);
		const cwd = workspacePath;

		const runOpts = { cwd, extensionPaths, commonHeader, signal };

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
