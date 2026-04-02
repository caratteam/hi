import { Agent, type AgentEvent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { getModel, type ImageContent } from "@mariozechner/pi-ai";
import {
	AgentSession,
	type AgentSessionEvent,
	AuthStorage,
	convertToLlm,
	createExtensionRuntime,
	type Extension,
	formatSkillsForPrompt,
	loadSkillsFromDir,
	ModelRegistry,
	type ResourceLoader,
	SessionManager,
	type Skill,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readdirSync, readFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { BASE64_STRIP_THRESHOLD, DEFAULT_CONTEXT_WINDOW, SLACK_MAX_TEXT } from "./constants.js";
import { MomSettingsManager, syncLogToSessionManager } from "./context.js";
import * as log from "./log.js";
import { createExecutor, type SandboxConfig } from "./sandbox.js";
import type { ChannelInfo, SlackContext, UserInfo } from "./slack.js";
import type { ChannelStore } from "./store.js";
import { createMomTools, createReadOnlyMomTools } from "./tools/index.js";

// Hardcoded model for now - TODO: make configurable (issue #63)
const model = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-6-v1");

export interface PendingMessage {
	userName: string;
	text: string;
	attachments: { local: string }[];
	timestamp: number;
}

export interface AgentRunner {
	run(
		ctx: SlackContext,
		store: ChannelStore,
		pendingMessages?: PendingMessage[],
	): Promise<{ stopReason: string; errorMessage?: string }>;
	abort(): void;
	steer(message: { userName: string; text: string }): void;
}

/** Shared AuthStorage instance for API key access */
let sharedAuthStorage: AuthStorage | null = null;

/** Get API key for a given provider, checking AuthStorage (auth.json) first then process.env */
async function getProviderApiKey(authStorage: AuthStorage, provider: string): Promise<string> {
	// Check AuthStorage first (auth.json with OAuth refresh support)
	try {
		const key = await authStorage.getApiKey(provider);
		if (key) return key;
	} catch {
		// auth.json missing or refresh failed — fall through to env
	}
	// Fall back to process.env (populated by .mom-env)
	const envKey = PROVIDER_ENV_KEYS[provider];
	if (envKey && process.env[envKey]) {
		return process.env[envKey]!;
	}
	throw new Error(
		`No API key found for ${provider}.\n\n` +
			"Set the key in ~/.mom-env (e.g. OPENROUTER_TOKEN=...) or as an environment variable.",
	);
}

/** Get Anthropic API key for lightweight operations (e.g. reaction classification) */
export async function getAnthropicKey(): Promise<string> {
	if (!sharedAuthStorage) {
		sharedAuthStorage = AuthStorage.create(join(homedir(), ".pi", "mom", "auth.json"));
	}
	return getProviderApiKey(sharedAuthStorage, "anthropic");
}

const IMAGE_MIME_TYPES: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
};

function getImageMimeType(filename: string): string | undefined {
	return IMAGE_MIME_TYPES[filename.toLowerCase().split(".").pop() || ""];
}

const MEMORY_MAX_LINES = 100;

function getMemory(channelDir: string): string {
	// Workspace-level memory only (no channel-specific memory)
	const workspaceMemoryPath = join(channelDir, "..", "MEMORY.md");
	if (existsSync(workspaceMemoryPath)) {
		try {
			const content = readFileSync(workspaceMemoryPath, "utf-8").trim();
			if (!content) return "(no working memory yet)";

			const lines = content.split("\n");
			if (lines.length <= MEMORY_MAX_LINES) {
				return content;
			}

			// Truncate and instruct consolidation
			return (
				lines.slice(0, MEMORY_MAX_LINES).join("\n") +
				`\n\n[... truncated — only first ${MEMORY_MAX_LINES} of ${lines.length} lines loaded]\n\n` +
				`> MEMORY.md has ${lines.length} lines but only the first ${MEMORY_MAX_LINES} are loaded. ` +
				`Consolidate it now: merge related entries, remove outdated items, and move skill-specific details to skill-memory/<skill-name>.md.`
			);
		} catch (error) {
			log.logWarning("Failed to read workspace memory", `${workspaceMemoryPath}: ${error}`);
		}
	}

	return "(no working memory yet)";
}

function loadMomSkills(channelDir: string, workspacePath: string): Skill[] {
	// channelDir is the host path (e.g., /Users/.../data/C0A34FL8PMH)
	// hostWorkspacePath is the parent directory on host
	const hostWorkspacePath = join(channelDir, "..");

	// Helper to translate host paths to container paths
	const translatePath = (hostPath: string): string => {
		if (hostPath.startsWith(hostWorkspacePath)) {
			return workspacePath + hostPath.slice(hostWorkspacePath.length);
		}
		return hostPath;
	};

	// Load workspace-level skills only (no channel-specific skills)
	const workspaceSkillsDir = join(hostWorkspacePath, "skills");
	const skills: Skill[] = [];
	for (const skill of loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" }).skills) {
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skills.push(skill);
	}

	return skills;
}

function buildSystemPrompt(
	workspacePath: string,
	channelId: string,
	memory: string,
	sandboxConfig: SandboxConfig,
	channels: ChannelInfo[],
	users: UserInfo[],
	skills: Skill[],
): string {
	const isDocker = sandboxConfig.type === "docker";

	// Format channel mappings
	const channelMappings =
		channels.length > 0 ? channels.map((c) => `${c.id}\t#${c.name}`).join("\n") : "(no channels loaded)";

	// Format user mappings
	const userMappings =
		users.length > 0 ? users.map((u) => `${u.id}\t@${u.userName}\t${u.displayName}`).join("\n") : "(no users loaded)";

	const envDescription = isDocker
		? `You are running inside a Docker container (Debian Linux).
- Bash working directory: / (use cd or absolute paths)
- Install tools with: apt-get update && apt-get install -y <package>
- Your changes persist across sessions`
		: `You are running directly on the host machine.
- Bash working directory: ${process.cwd()}
- Be careful with system modifications`;

	// Extract ## Rules section from memory and place it prominently in the prompt.
	// This ensures behavioral rules get high attention instead of being buried
	// deep inside the memory content where they lose effectiveness.
	let memoryRules = "";
	let memoryWithoutRules = memory;
	const memorySections = memory.split(/^(?=## )/m);
	const rulesSection = memorySections.find((s) => s.startsWith("## Rules"));
	if (rulesSection) {
		memoryRules = rulesSection.replace(/^## Rules\n/, "").trim();
		memoryWithoutRules = memorySections
			.filter((s) => !s.startsWith("## Rules"))
			.join("")
			.trim();
	}

	return `You are mom, a Slack bot assistant. Be concise. No emojis.
${memoryRules ? `\n## Rules\n${memoryRules}\n` : ""}
## Context
- For current date/time, use: date
- You have access to previous conversation context including tool results from prior turns.
- For older history beyond your context, search log.jsonl (contains user messages and your final responses, but not tool results).

## Slack Formatting (mrkdwn, NOT Markdown)
Bold: *text*, Italic: _text_, Code: \`code\`, Block: \`\`\`code\`\`\`, Links: <url|text>
Do NOT use **double asterisks** or [markdown](links).

## Slack IDs
Channels: ${channelMappings}

Users: ${userMappings}

When mentioning users, use <@username> format (e.g., <@mario>).

## Environment
${envDescription}

## Workspace Layout
${workspacePath}/
├── MEMORY.md                    # Global memory (all channels)
├── skills/                      # Global CLI tools you create
└── ${channelId}/                # This channel
    ├── log.jsonl                # Message history (no tool results)
    ├── attachments/             # User-shared files
    └── scratch/                 # Your working directory

## Skills (Custom CLI Tools)
You can create reusable CLI tools for recurring tasks (email, APIs, data processing, etc.).

### Creating Skills
Store in \`${workspacePath}/skills/<name>/\`.
Each skill directory needs a \`SKILL.md\` with YAML frontmatter:

\`\`\`markdown
---
name: skill-name
description: Short description of what this skill does
---

# Skill Name

Usage instructions, examples, etc.
Scripts are in: {baseDir}/
\`\`\`

\`name\` and \`description\` are required. Use \`{baseDir}\` as placeholder for the skill's directory path.

### Skill Memory
When you read a skill's SKILL.md, its corresponding \`${workspacePath}/skill-memory/<skill-name>.md\` is auto-appended to the read result. No need to read it separately.

### Available Skills
${skills.length > 0 ? formatSkillsForPrompt(skills) : "(no skills installed yet)"}

## Events
You can schedule events that wake you up at specific times or when external things happen. Events are JSON files in \`${workspacePath}/events/\`.

### Event Types

**Immediate** - Triggers as soon as harness sees the file. Use in scripts/webhooks to signal external events.
\`\`\`json
{"type": "immediate", "channelId": "${channelId}", "text": "New GitHub issue opened"}
\`\`\`

**One-shot** - Triggers once at a specific time. Use for reminders.
\`\`\`json
{"type": "one-shot", "channelId": "${channelId}", "text": "Remind Mario about dentist", "at": "2025-12-15T09:00:00+01:00"}
\`\`\`

**Periodic** - Triggers on a cron schedule. Use for recurring tasks.
\`\`\`json
{"type": "periodic", "channelId": "${channelId}", "text": "Check inbox and summarize", "schedule": "0 9 * * 1-5", "timezone": "${Intl.DateTimeFormat().resolvedOptions().timeZone}"}
\`\`\`

### Cron Format
\`minute hour day-of-month month day-of-week\`
- \`0 9 * * *\` = daily at 9:00
- \`0 9 * * 1-5\` = weekdays at 9:00
- \`30 14 * * 1\` = Mondays at 14:30
- \`0 0 1 * *\` = first of each month at midnight

### Timezones
All \`at\` timestamps must include offset (e.g., \`+01:00\`). Periodic events use IANA timezone names. The harness runs in ${Intl.DateTimeFormat().resolvedOptions().timeZone}. When users mention times without timezone, assume ${Intl.DateTimeFormat().resolvedOptions().timeZone}.

### Creating Events
Use unique filenames to avoid overwriting existing events. Include a timestamp or random suffix:
\`\`\`bash
cat > ${workspacePath}/events/dentist-reminder-$(date +%s).json << 'EOF'
{"type": "one-shot", "channelId": "${channelId}", "text": "Dentist tomorrow", "at": "2025-12-14T09:00:00+01:00"}
EOF
\`\`\`
Or check if file exists first before creating.

### Managing Events
- List: \`ls ${workspacePath}/events/\`
- View: \`cat ${workspacePath}/events/foo.json\`
- Delete/cancel: \`rm ${workspacePath}/events/foo.json\`

### When Events Trigger
You receive a message like:
\`\`\`
[EVENT:dentist-reminder.json:one-shot:2025-12-14T09:00:00+01:00] Dentist tomorrow
\`\`\`
Immediate and one-shot events auto-delete after triggering. Periodic events persist until you delete them.

### Debouncing
When writing programs that create immediate events (email watchers, webhook handlers, etc.), always debounce. If 50 emails arrive in a minute, don't create 50 immediate events. Instead collect events over a window and create ONE immediate event summarizing what happened, or just signal "new activity, check inbox" rather than per-item events. Or simpler: use a periodic event to check for new items every N minutes instead of immediate events.

## Memory
Save information worth remembering across sessions. When you write memory, do it in that same turn — "I'll remember" without writing is a failure.

**What to save:** user preferences, learned patterns, decisions that affect future tasks. Skip routine actions.

**Where to write:** if a relevant skill exists (check available_skills), write to \`${workspacePath}/skill-memory/<skill-name>.md\`. Use \`${workspacePath}/MEMORY.md\` only when no skill is relevant (e.g., team culture, general rules).
- \`${workspacePath}/skill-memory/<skill-name>.md\` — skill-specific memory. Read it when you load that skill's SKILL.md.
- \`${workspacePath}/MEMORY.md\` — auto-loaded every turn (below). Keep it small (<100 lines).

### Current Memory (${workspacePath}/MEMORY.md, auto-loaded)
${memoryWithoutRules}

### IMPORTANT: Record Decisions Immediately
When a new plan, decision, TODO, or phase emerges during conversation, do NOT just acknowledge it verbally. Immediately write it to the relevant file (skill-memory, SKILL.md, ARCHITECTURE.md) in that same turn.

## Environment Setup
${workspacePath}/setup.sh runs automatically on container creation (via docker.sh).
When you install packages, change config, or modify the environment, add the command to setup.sh so it persists across container rebuilds.
Do NOT maintain a separate SYSTEM.md - setup.sh is the single source of truth.

## Log Queries (for older history)
Format: \`{"date":"...","ts":"...","user":"...","userName":"...","text":"...","isBot":false}\`
The log contains user messages and your final responses (not tool calls/results).
${isDocker ? "Install jq: apt-get update && apt-get install -y jq" : ""}

\`\`\`bash
# Recent messages
tail -30 log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Search for specific topic
grep -i "topic" log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Messages from specific user
grep '"userName":"mario"' log.jsonl | tail -20 | jq -c '{date: .date[0:19], text}'
\`\`\`

## Tools
- bash: Run shell commands (primary tool). Install packages as needed.
- read: Read files
- write: Create/overwrite files
- edit: Surgical file edits
- attach: Share files to Slack

Each tool requires a "label" parameter (shown to user).
`;
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.substring(0, maxLen - 3)}...`;
}

function extractToolResultText(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}

	if (
		result &&
		typeof result === "object" &&
		"content" in result &&
		Array.isArray((result as { content: unknown }).content)
	) {
		const content = (result as { content: Array<{ type: string; text?: string }> }).content;
		const textParts: string[] = [];
		for (const part of content) {
			if (part.type === "text" && part.text) {
				textParts.push(part.text);
			}
		}
		if (textParts.length > 0) {
			return textParts.join("\n");
		}
	}

	return JSON.stringify(result);
}

// Cache runners per thread
const threadRunners = new Map<string, AgentRunner>();

/** TTL for idle thread runners: 30 minutes */
const THREAD_RUNNER_TTL_MS = 30 * 60 * 1000;

/** Track last access time per runner for eviction */
const threadRunnerLastAccess = new Map<string, number>();

/** Evict thread runners that have been idle longer than TTL */
function evictStaleRunners(): void {
	const now = Date.now();
	const staleKeys: string[] = [];
	for (const [key, lastAccess] of threadRunnerLastAccess) {
		if (now - lastAccess > THREAD_RUNNER_TTL_MS) {
			staleKeys.push(key);
		}
	}
	for (const key of staleKeys) {
		threadRunners.delete(key);
		threadRunnerLastAccess.delete(key);
		log.logInfo(`Evicted stale thread runner: ${key}`);
	}
}

/**
 * Evict a cached runner for a specific thread.
 * Used when the context file has been renamed (e.g., synthetic ts -> real Slack ts)
 * so the next getOrCreateRunner call creates a fresh runner pointing to the correct file.
 */
export function evictRunner(channelId: string, threadTs: string): void {
	const key = `${channelId}:${threadTs}`;
	if (threadRunners.has(key)) {
		threadRunners.delete(key);
		threadRunnerLastAccess.delete(key);
		log.logInfo(`Evicted runner for renamed thread: ${key}`);
	}
}

/**
 * Get or create an AgentRunner for a specific thread.
 * Runners are cached - one per thread, persistent across messages in the same thread.
 */
export function getOrCreateRunner(
	sandboxConfig: SandboxConfig,
	channelId: string,
	channelDir: string,
	threadTs: string,
): AgentRunner {
	const key = `${channelId}:${threadTs}`;
	const existing = threadRunners.get(key);
	if (existing) {
		threadRunnerLastAccess.set(key, Date.now());
		return existing;
	}

	// Evict stale runners before creating a new one
	evictStaleRunners();

	const runner = createRunner(sandboxConfig, channelId, channelDir, threadTs);
	threadRunners.set(key, runner);
	threadRunnerLastAccess.set(key, Date.now());
	return runner;
}

/**
 * Create a new AgentRunner for a channel.
 * Sets up the session and subscribes to events once.
 */
/** Known provider-to-env-var mappings for sandbox injection */
const PROVIDER_ENV_KEYS: Record<string, string> = {
	fal: "FAL_KEY",
	openai: "OPENAI_API_KEY",
	carat: "CARAT_AGENT_TOKEN",
	anthropic: "ANTHROPIC_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	"amazon-bedrock": "AWS_ACCESS_KEY_ID",
};

/** Additional AWS env vars needed for Bedrock authentication in sandbox */
const AWS_ENV_KEYS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_PROFILE"];

/**
 * Sanitize toolCall/toolResult pairs in a message array.
 *
 * Claude API requires every tool_result to have a corresponding tool_use (toolCall) block
 * in a preceding assistant message. After trimming context to recent N messages,
 * orphan toolResults (whose toolCall was trimmed) cause 400 errors.
 *
 * Internal message format (from buildSessionContext):
 * - Assistant messages: role="assistant", content array with type="toolCall", id="toolu_..."
 * - Tool results: role="toolResult" (separate message), toolCallId="toolu_..."
 *
 * This function:
 * 1. Collects all toolCall IDs from assistant messages
 * 2. Removes toolResult messages whose toolCallId has no matching toolCall
 * 3. Collects all toolResult toolCallIds
 * 4. Removes toolCall blocks from assistant messages that have no matching toolResult
 * 5. Drops empty assistant messages after filtering
 */
function sanitizeToolPairs(messages: any[], log: any, channelId: string, threadTs: string): any[] {
	// Pass 1: Collect all toolCall IDs from assistant messages
	const toolCallIds = new Set<string>();
	for (const msg of messages) {
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "toolCall" && block.id) {
					toolCallIds.add(block.id);
				}
			}
		}
	}

	// Pass 2: Collect all toolResult IDs (these are separate messages with role="toolResult")
	const toolResultIds = new Set<string>();
	for (const msg of messages) {
		if (msg.role === "toolResult" && msg.toolCallId) {
			toolResultIds.add(msg.toolCallId);
		}
	}

	let removedResults = 0;
	let removedCalls = 0;
	const result: any[] = [];

	for (const msg of messages) {
		if (msg.role === "toolResult") {
			// Drop orphan toolResult messages (no matching toolCall in any assistant message)
			if (msg.toolCallId && !toolCallIds.has(msg.toolCallId)) {
				removedResults++;
				continue;
			}
			result.push(msg);
		} else if (msg.role === "assistant" && Array.isArray(msg.content)) {
			// Remove toolCall blocks that have no matching toolResult
			const filtered = msg.content.filter((block: any) => {
				if (block.type === "toolCall" && block.id && !toolResultIds.has(block.id)) {
					removedCalls++;
					return false;
				}
				return true;
			});
			if (filtered.length > 0) {
				result.push({ ...msg, content: filtered });
			}
			// Drop empty assistant messages (all toolCalls were orphaned)
		} else {
			result.push(msg);
		}
	}

	if (removedResults > 0 || removedCalls > 0) {
		log.logInfo(
			`[${channelId}:${threadTs}] Sanitized tool pairs: removed ${removedResults} orphan toolResult(s), ${removedCalls} orphan toolCall(s)`,
		);
	}

	return result;
}

/**
 * Apply monkey-patch to SessionManager._persist to strip large binary data.
 * Without this, reading images/videos via the "read" tool writes megabytes of base64
 * into context files, which can blow up the context on reload.
 */
function patchSessionManagerPersist(sessionManager: SessionManager): void {
	const originalPersist = (sessionManager as any)._persist.bind(sessionManager);
	(sessionManager as any)._persist = (entry: any) => {
		if (entry?.type === "message") {
			const content = entry.message?.content;
			if (Array.isArray(content)) {
				let modified = false;
				const stripped = content.map((c: any) => {
					if (c?.data && typeof c.data === "string" && c.data.length > BASE64_STRIP_THRESHOLD) {
						modified = true;
						const sizeKB = Math.round(c.data.length / 1024);
						const label = c.type || "binary";
						const mime = c.mimeType || "";
						return { type: "text", text: `[${label}${mime ? `: ${mime}` : ""}, ${sizeKB}KB base64 stripped]` };
					}
					return c;
				});
				if (modified) {
					const strippedEntry = { ...entry, message: { ...entry.message, content: stripped } };
					return originalPersist(strippedEntry);
				}
			}
		}
		return originalPersist(entry);
	};
}

/**
 * Get the context file path for a given thread.
 * Each thread gets its own context file to avoid cross-contamination.
 */
function getContextFilePath(channelDir: string, threadTs?: string): string {
	if (threadTs) {
		return join(channelDir, `context-${threadTs}.jsonl`);
	}
	// This shouldn't happen in practice since top-level mentions get a thread_ts
	// from the response message, but we handle it as a fallback
	return join(channelDir, "context-main.jsonl");
}

const SKILL_MEMORY_DIR = "skill-memory";
const SKILL_FILENAME = "SKILL.md";
const SKILL_MEMORY_MAX_LINES = 200;

const SKILL_FILE_MAX_LINES = 200;

/**
 * Find .md files in a skill directory that exceed the line threshold.
 * Checks every .md file individually — any single file being too large is the problem,
 * regardless of how many other files exist.
 */
function findOversizedSkillFiles(skillDir: string): Array<{ name: string; lines: number }> {
	const oversized: Array<{ name: string; lines: number }> = [];
	try {
		const entries = readdirSync(skillDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
			try {
				const content = readFileSync(join(skillDir, entry.name), "utf-8");
				const lineCount = content.split("\n").length;
				if (lineCount > SKILL_FILE_MAX_LINES) {
					oversized.push({ name: entry.name, lines: lineCount });
				}
			} catch {
				// skip unreadable files
			}
		}
	} catch {
		// skill dir not readable
	}
	return oversized;
}

/**
 * Create a skill-memory extension that auto-appends skill memory when SKILL.md is read.
 * Also checks for oversized files and suggests progressive disclosure when appropriate.
 * Mirrors carat-pi's extension pattern: intercepts tool_result for read tool,
 * detects SKILL.md paths, and appends the corresponding skill-memory file content.
 */
function createSkillMemoryExtension(workspacePath: string): Extension {
	const handler = async (event: unknown) => {
		const e = event as {
			type: string;
			toolName: string;
			toolCallId: string;
			input: Record<string, unknown>;
			content: Array<{ type: string; text?: string }>;
			isError: boolean;
		};
		if (e.toolName !== "read" || e.isError) return;

		const readPath = e.input.path as string | undefined;
		if (!readPath) return;

		// Extract skill name from SKILL.md path
		if (basename(readPath) !== SKILL_FILENAME) return;
		const dir = dirname(readPath);
		const skillName = basename(dir);
		if (!skillName || skillName === "." || skillName === "/") return;

		// Read corresponding skill-memory file
		const memoryPath = join(workspacePath, SKILL_MEMORY_DIR, `${skillName}.md`);
		let memory: string;
		try {
			memory = readFileSync(memoryPath, "utf-8").trim();
			if (!memory) return;
		} catch {
			return;
		}

		const lines = memory.split("\n");
		let displayMemory: string;

		if (lines.length > SKILL_MEMORY_MAX_LINES) {
			displayMemory =
				lines.slice(0, SKILL_MEMORY_MAX_LINES).join("\n") +
				`\n\n[... truncated — only first ${SKILL_MEMORY_MAX_LINES} of ${lines.length} lines loaded]\n\n` +
				`> ${SKILL_MEMORY_DIR}/${skillName}.md has ${lines.length} lines but only the first ${SKILL_MEMORY_MAX_LINES} are loaded. ` +
				`Consolidate it now: merge related entries, remove outdated items, and keep only actionable observations.`;
		} else {
			displayMemory = memory;
		}

		log.logInfo(`[skill-memory] appending ${lines.length} lines for skill "${skillName}"`);

		let appendBlock = `\n\n---\n## Skill Memory (~/${SKILL_MEMORY_DIR}/${skillName}.md, auto-appended)\n\n${displayMemory}`;

		// Check for oversized files in the skill directory.
		// Any single .md file exceeding the threshold is flagged with concrete actions.
		const oversized = findOversizedSkillFiles(dir);
		if (oversized.length > 0) {
			const fileList = oversized.map((f) => `${f.name} (${f.lines} lines)`).join(", ");
			appendBlock +=
				`\n\n---\n> **Skill structure note:** ${fileList} exceeded ${SKILL_FILE_MAX_LINES} lines. ` +
				`After completing the current task, consolidate this skill AND its skill-memory file (${SKILL_MEMORY_DIR}/${skillName}.md): ` +
				`(1) deduplicate — merge overlapping entries and generalize specific examples into reusable principles, ` +
				`(2) remove outdated information that no longer applies, ` +
				`(3) classify the remaining content by task type and split into focused reference files, ` +
				`(4) add a loading guide to SKILL.md so only task-relevant files are loaded each time.`;
		}

		const newContent = e.content.map((c) => {
			if (c.type === "text" && c.text !== undefined) {
				return { ...c, text: c.text + appendBlock };
			}
			return c;
		});

		return { content: newContent };
	};

	return {
		path: "<skill-memory>",
		resolvedPath: "<skill-memory>",
		sourceInfo: {
			path: "<skill-memory>",
			source: "built-in",
			scope: "temporary" as const,
			origin: "top-level" as const,
		},
		handlers: new Map([["tool_result", [handler]]]),
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	} as Extension;
}

function createRunner(
	sandboxConfig: SandboxConfig,
	channelId: string,
	channelDir: string,
	threadTs: string,
): AgentRunner {
	// Load API keys from process.env (set via .mom-env) to inject into sandbox environment
	const sandboxEnv: Record<string, string> = {};
	for (const envVar of Object.values(PROVIDER_ENV_KEYS)) {
		if (process.env[envVar]) {
			sandboxEnv[envVar] = process.env[envVar]!;
		}
	}
	// Pass through all AWS env vars for Bedrock access in sandbox
	for (const key of AWS_ENV_KEYS) {
		if (process.env[key]) {
			sandboxEnv[key] = process.env[key]!;
		}
	}
	// Also pass through DB_* and other useful env vars
	for (const key of ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD", "MOM_ADMIN_USERS"]) {
		if (process.env[key]) {
			sandboxEnv[key] = process.env[key]!;
		}
	}

	const executor = createExecutor(sandboxConfig, sandboxEnv);
	const workspacePath = executor.getWorkspacePath(channelDir.replace(`/${channelId}`, ""));

	// User ID will be set during run()
	let currentUserId: string | undefined;

	// Per-channel upload function, updated each run() with the current ctx
	let currentUploadFn: ((filePath: string, title?: string) => Promise<void>) | null = null;

	// Upload function wrapper (shared by both tool sets)
	const uploadWrapper = async (filePath: string, title?: string) => {
		if (!currentUploadFn) throw new Error("Upload function not configured for this run");
		await currentUploadFn(filePath, title);
	};

	// Create tools with access to current user ID and upload function
	const tools = createMomTools(executor, () => currentUserId, uploadWrapper);

	// Read-only tools for non-admin users (no Write, no Edit, restricted Bash)
	const readOnlyTools = createReadOnlyMomTools(executor, uploadWrapper);

	// System prompt rebuild control — preserves Anthropic's server-side prompt cache.
	//
	// Within a thread, memory/skills edits remain visible in conversation context,
	// so we only rebuild the system prompt on:
	//   1. First run (new thread or restart) — restore from cache file if unchanged
	//   2. After compaction — must rebuild with latest memory/skills
	//
	// Key insight: on restart, even if memory changed since last session, the
	// conversation context still has those changes in message history (pre-compaction).
	// So we restore the cached prompt to preserve Anthropic's cache. Only compaction
	// (which compresses message history) forces a true rebuild.
	const promptCacheDir = join(channelDir, ".prompt-cache");
	let needsInitialPrompt = true; // first run: restore from cache or initialize
	let needsFreshRebuild = false; // after compaction: force rebuild with latest

	/**
	 * Apply system prompt. On first run, restores from cache file to preserve
	 * Anthropic's prompt cache across restarts. After compaction, rebuilds fresh.
	 */
	function applySystemPrompt(agent: Agent, threadTs: string, ctx: SlackContext): void {
		const cacheFile = join(promptCacheDir, `${threadTs}.txt`);

		if (needsFreshRebuild) {
			// Post-compaction: conversation context lost changes, must use latest
			needsFreshRebuild = false;
			const freshPrompt = buildFreshPrompt(ctx);
			agent.setSystemPrompt(freshPrompt);
			persistPromptCache(cacheFile, freshPrompt);
			log.logInfo(`[${channelId}:${threadTs}] System prompt rebuilt after compaction`);
			return;
		}

		if (needsInitialPrompt) {
			// First run: try to restore cached prompt to preserve Anthropic cache
			needsInitialPrompt = false;
			let cached: string | null = null;
			try {
				if (existsSync(cacheFile)) cached = readFileSync(cacheFile, "utf-8");
			} catch {
				/* ignore */
			}

			if (cached !== null) {
				// Restore previous prompt — changes since then are in conversation context
				agent.setSystemPrompt(cached);
				log.logInfo(`[${channelId}:${threadTs}] System prompt restored from cache`);
			} else {
				// No cache (new thread) — initialize with latest
				const freshPrompt = buildFreshPrompt(ctx);
				agent.setSystemPrompt(freshPrompt);
				persistPromptCache(cacheFile, freshPrompt);
				log.logInfo(`[${channelId}:${threadTs}] System prompt initialized`);
			}
			return;
		}

		// Subsequent runs in same session: no rebuild needed, prompt cache preserved
	}

	function buildFreshPrompt(ctx: SlackContext): string {
		const freshMemory = getMemory(channelDir);
		const freshSkills = loadMomSkills(channelDir, workspacePath);
		return buildSystemPrompt(
			workspacePath,
			channelId,
			freshMemory,
			sandboxConfig,
			ctx.channels,
			ctx.users,
			freshSkills,
		);
	}

	function persistPromptCache(cacheFile: string, content: string): void {
		mkdir(promptCacheDir, { recursive: true })
			.then(() => writeFile(cacheFile, content, "utf-8"))
			.catch(() => {
				/* ignore */
			});
	}

	// Initial system prompt for agent creation (channels/users not yet available)
	const memory = getMemory(channelDir);
	const skills = loadMomSkills(channelDir, workspacePath);
	const systemPrompt = buildSystemPrompt(workspacePath, channelId, memory, sandboxConfig, [], [], skills);

	const settingsManager = new MomSettingsManager(join(channelDir, ".."));

	// Create AuthStorage and ModelRegistry
	const authStorage = AuthStorage.create(join(homedir(), ".pi", "mom", "auth.json"));
	sharedAuthStorage = authStorage;
	const modelRegistry = new ModelRegistry(authStorage);

	/** Create a new Agent instance (one per thread) */
	function createAgent(initialSystemPrompt: string): Agent {
		return new Agent({
			initialState: {
				systemPrompt: initialSystemPrompt,
				model,
				thinkingLevel: "off",
				tools,
			},
			convertToLlm,
			getApiKey: async (provider?: string) => getProviderApiKey(authStorage, provider || model.provider),
		});
	}

	// Extension handler runs on host, so use host path (channelDir/..) to read files.
	// workspacePath is the container-internal path (/workspace) used in system prompt text only.
	const hostWorkspacePath = join(channelDir, "..");
	const skillMemoryExtension = createSkillMemoryExtension(hostWorkspacePath);
	const extensionRuntime = createExtensionRuntime();

	const resourceLoader: ResourceLoader = {
		getExtensions: () => ({ extensions: [skillMemoryExtension], errors: [], runtime: extensionRuntime }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};

	const baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

	// Single session for this thread runner (1 runner = 1 thread = 1 session)
	const contextFile = getContextFilePath(channelDir, threadTs);
	const sessionManager = SessionManager.open(contextFile, channelDir);
	patchSessionManagerPersist(sessionManager);

	const threadAgent = createAgent(systemPrompt);

	const session = new AgentSession({
		agent: threadAgent,
		sessionManager,
		settingsManager: settingsManager as any,
		cwd: process.cwd(),
		modelRegistry,
		resourceLoader,
		baseToolsOverride,
	});

	log.logInfo(`[${channelId}:${threadTs}] Created thread runner`);

	// Mutable per-run state - event handler references this
	// Safe because each runner handles only one thread, and runs are sequential within a thread
	const runState: {
		ctx: SlackContext | null;
		logCtx: { channelId: string; userName?: string; channelName?: string } | null;
		queue: {
			enqueue(fn: () => Promise<void>, errorContext: string): void;
			enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog?: boolean): void;
		} | null;
		pendingTools: Map<string, { toolName: string; args: unknown; startTime: number }>;
		totalUsage: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
		};
		stopReason: string;
		errorMessage: string | undefined;
	} = {
		ctx: null,
		logCtx: null,
		queue: null,
		pendingTools: new Map(),
		totalUsage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		errorMessage: undefined,
	};

	// Subscribe to session events (one session per runner, so no need to check currentSession)
	session.subscribe(async (event: AgentSessionEvent) => {
		if (!runState.ctx || !runState.logCtx || !runState.queue) return;
		handleSessionEvent(event, runState);
	});

	/** Handle session events (shared across all thread sessions) */
	function handleSessionEvent(event: AgentSessionEvent, state: typeof runState): void {
		if (!state.ctx || !state.logCtx || !state.queue) return;

		const { ctx, logCtx, queue, pendingTools } = state;

		if (event.type === "tool_execution_start") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_start" };
			const args = agentEvent.args as { label?: string };
			const label = args.label || agentEvent.toolName;

			pendingTools.set(agentEvent.toolCallId, {
				toolName: agentEvent.toolName,
				args: agentEvent.args,
				startTime: Date.now(),
			});

			log.logToolStart(logCtx, agentEvent.toolName, label, agentEvent.args as Record<string, unknown>);
			queue.enqueue(() => ctx.respond(`_→ ${label}_`, false), "tool label");
		} else if (event.type === "tool_execution_end") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_end" };
			const resultStr = extractToolResultText(agentEvent.result);
			const pending = pendingTools.get(agentEvent.toolCallId);
			pendingTools.delete(agentEvent.toolCallId);

			const durationMs = pending ? Date.now() - pending.startTime : 0;

			if (agentEvent.isError) {
				log.logToolError(logCtx, agentEvent.toolName, durationMs, resultStr);
			} else {
				log.logToolSuccess(logCtx, agentEvent.toolName, durationMs, resultStr);
			}

			if (agentEvent.isError) {
				queue.enqueue(() => ctx.respond(`_Error: ${truncate(resultStr, 200)}_`, false), "tool error");
			}
		} else if (event.type === "message_start") {
			const agentEvent = event as AgentEvent & { type: "message_start" };
			if (agentEvent.message.role === "assistant") {
				log.logResponseStart(logCtx);
			}
		} else if (event.type === "message_end") {
			const agentEvent = event as AgentEvent & { type: "message_end" };
			if (agentEvent.message.role === "assistant") {
				const assistantMsg = agentEvent.message as any;

				if (assistantMsg.stopReason) {
					state.stopReason = assistantMsg.stopReason;
				}
				if (assistantMsg.errorMessage) {
					state.errorMessage = assistantMsg.errorMessage;
				}

				if (assistantMsg.usage) {
					state.totalUsage.input += assistantMsg.usage.input;
					state.totalUsage.output += assistantMsg.usage.output;
					state.totalUsage.cacheRead += assistantMsg.usage.cacheRead;
					state.totalUsage.cacheWrite += assistantMsg.usage.cacheWrite;
					state.totalUsage.cost.input += assistantMsg.usage.cost.input;
					state.totalUsage.cost.output += assistantMsg.usage.cost.output;
					state.totalUsage.cost.cacheRead += assistantMsg.usage.cost.cacheRead;
					state.totalUsage.cost.cacheWrite += assistantMsg.usage.cost.cacheWrite;
					state.totalUsage.cost.total += assistantMsg.usage.cost.total;
				}

				const content = agentEvent.message.content;
				const thinkingParts: string[] = [];
				const textParts: string[] = [];
				for (const part of content) {
					if (part.type === "thinking") {
						thinkingParts.push((part as any).thinking);
					} else if (part.type === "text") {
						textParts.push((part as any).text);
					}
				}

				const text = textParts.join("\n");

				for (const thinking of thinkingParts) {
					log.logThinking(logCtx, thinking);
					queue.enqueueMessage(`_${thinking}_`, "main", "thinking main");
				}

				if (text.trim()) {
					log.logResponse(logCtx, text);
					// Final text response is posted only as a thread reply (at end of run),
					// not accumulated into the main status message (which shows tool labels).
				}
			}
		} else if (event.type === "auto_compaction_start") {
			const compSettings = settingsManager.getCompactionSettings();
			log.logInfo(
				`Auto-compaction started (reason: ${(event as any).reason}), settings: reserve=${compSettings.reserveTokens}, keepRecent=${compSettings.keepRecentTokens}, contextWindow=${(session as any).model?.contextWindow ?? "unknown"}`,
			);
			queue.enqueue(() => ctx.respond("_Compacting context..._", false), "compaction start");
		} else if (event.type === "auto_compaction_end") {
			const compEvent = event as any;
			if (compEvent.result) {
				log.logInfo(
					`Auto-compaction complete: ${compEvent.result.tokensBefore} tokens compacted, summary length: ${compEvent.result.summary?.length ?? 0} chars`,
				);
				// Compaction compresses conversation context, potentially losing
				// memory/skills changes that were only visible in message history.
				// Force a fresh rebuild on next run.
				needsFreshRebuild = true;
			} else if (compEvent.aborted) {
				log.logInfo("Auto-compaction aborted");
			} else if (compEvent.errorMessage) {
				log.logWarning(`Auto-compaction failed: ${compEvent.errorMessage}`);
			} else {
				log.logWarning(`Auto-compaction ended with no result (no error, no abort, no result)`);
			}
		} else if (event.type === "auto_retry_start") {
			const retryEvent = event as any;
			log.logWarning(`Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})`, retryEvent.errorMessage);
			queue.enqueue(
				() => ctx.respond(`_Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})..._`, false),
				"retry",
			);
		}
	}

	// Slack message limit
	const splitForSlack = (text: string): string[] => {
		if (text.length <= SLACK_MAX_TEXT) return [text];
		const parts: string[] = [];
		let remaining = text;
		let partNum = 1;
		while (remaining.length > 0) {
			const chunk = remaining.substring(0, SLACK_MAX_TEXT - 50);
			remaining = remaining.substring(SLACK_MAX_TEXT - 50);
			const suffix = remaining.length > 0 ? `\n_(continued ${partNum}...)_` : "";
			parts.push(chunk + suffix);
			partNum++;
		}
		return parts;
	};

	return {
		async run(
			ctx: SlackContext,
			_store: ChannelStore,
			_pendingMessages?: PendingMessage[],
		): Promise<{ stopReason: string; errorMessage?: string }> {
			// Set current user ID for access control
			currentUserId = ctx.message.user;

			// Ensure channel directory exists
			await mkdir(channelDir, { recursive: true });

			// Sync messages from log.jsonl that arrived while we were offline or busy
			// These are permanently appended to SessionManager (and thus context.jsonl),
			// so auto-compaction handles context growth naturally.
			const syncedCount = syncLogToSessionManager(sessionManager, channelDir, threadTs, ctx.message.ts);
			if (syncedCount > 0) {
				log.logInfo(`[${channelId}:${threadTs}] Synced ${syncedCount} messages from log.jsonl`);
			}

			// Reload messages from thread's context file (picks up synced messages too)
			const reloadedSession = sessionManager.buildSessionContext();
			if (reloadedSession.messages.length > 0) {
				// Strip large binary data from historical messages
				let strippedCount = 0;
				for (const msg of reloadedSession.messages) {
					const content = (msg as any).content;
					if (!content || !Array.isArray(content)) continue;
					for (let i = content.length - 1; i >= 0; i--) {
						const block = content[i];
						if (block.data && typeof block.data === "string" && block.data.length > BASE64_STRIP_THRESHOLD) {
							const label = block.type || "binary";
							const mime = block.mimeType || "";
							content.splice(i, 1, {
								type: "text",
								text: `[${label}${mime ? `: ${mime}` : ""} — removed from context]`,
							});
							strippedCount++;
						}
					}
				}
				if (strippedCount > 0) {
					log.logInfo(`[${channelId}:${threadTs}] Stripped ${strippedCount} large data block(s) from context`);
				}

				threadAgent.replaceMessages(reloadedSession.messages);
				log.logInfo(`[${channelId}:${threadTs}] Loaded ${reloadedSession.messages.length} messages from context`);
			} else {
				// New thread - start fresh
				threadAgent.replaceMessages([]);
			}

			// Apply system prompt (from cache on restart, fresh after compaction, skip otherwise)
			applySystemPrompt(threadAgent, threadTs, ctx);

			// Swap tools based on read-only mode (non-admin users)
			if (ctx.readOnly) {
				threadAgent.setTools(readOnlyTools);
				log.logInfo(`[${channelId}:${threadTs}] Read-only mode: restricted tools`);
			} else {
				threadAgent.setTools(tools);
			}

			// Dynamic model override from settings.json
			let actualModel = model; // Start with default
			const savedProvider = settingsManager.getDefaultProvider();
			const savedModelId = settingsManager.getDefaultModel();
			if (savedProvider && savedModelId) {
				const dynamicModel = getModel(savedProvider as any, savedModelId as any);
				if (dynamicModel) {
					threadAgent.setModel(dynamicModel);
					actualModel = dynamicModel; // Track actual model used
				}
			}

			// Inform settings manager of the model's context window so
			// compaction thresholds scale proportionally to context size.
			if (actualModel.contextWindow) {
				settingsManager.setContextWindow(actualModel.contextWindow);
			}

			// Set up file upload function for this run's context
			currentUploadFn = async (filePath: string, title?: string) => {
				const hostPath = translateToHostPath(filePath, channelDir, workspacePath, channelId);
				await ctx.uploadFile(hostPath, title);
			};

			// Reset per-run state
			runState.ctx = ctx;
			runState.logCtx = {
				channelId: ctx.message.channel,
				userName: ctx.message.userName,
				channelName: ctx.channelName,
			};
			runState.pendingTools.clear();
			runState.totalUsage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			runState.stopReason = "stop";
			runState.errorMessage = undefined;

			// Create queue for this run
			let queueChain = Promise.resolve();
			runState.queue = {
				enqueue(fn: () => Promise<void>, errorContext: string): void {
					queueChain = queueChain.then(async () => {
						try {
							await fn();
						} catch (err) {
							const errMsg = err instanceof Error ? err.message : String(err);
							const errData = (err as { data?: unknown }).data;
							log.logWarning(`Slack API error (${errorContext})`, errMsg);
							if (errData) {
								log.logWarning(
									`Slack API error details (${errorContext})`,
									JSON.stringify(errData).substring(0, 500),
								);
							}
							// Don't try to respondInThread for msg_too_long - it will likely fail too
							if (!errMsg.includes("msg_too_long")) {
								try {
									await ctx.respondInThread(`_Error: ${errMsg}_`);
								} catch {
									// Ignore
								}
							}
						}
					});
				},
				enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog = true): void {
					const parts = splitForSlack(text);
					for (const part of parts) {
						this.enqueue(
							() => (target === "main" ? ctx.respond(part, doLog) : ctx.respondInThread(part)),
							errorContext,
						);
					}
				},
			};

			// Log context info
			log.logInfo(`Context sizes - system: ${systemPrompt.length} chars, memory: ${memory.length} chars`);
			log.logInfo(`Channels: ${ctx.channels.length}, Users: ${ctx.users.length}`);

			// Build user message with timestamp and username prefix
			// Format: "[YYYY-MM-DD HH:MM:SS+HH:MM] [username]: message" so LLM knows when and who
			const now = new Date();
			const pad = (n: number) => n.toString().padStart(2, "0");
			const offset = -now.getTimezoneOffset();
			const offsetSign = offset >= 0 ? "+" : "-";
			const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
			const offsetMins = pad(Math.abs(offset) % 60);
			const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetSign}${offsetHours}:${offsetMins}`;
			let userMessage = `[${timestamp}] [${ctx.message.userName || "unknown"}]: ${ctx.message.text}`;

			const imageAttachments: ImageContent[] = [];
			const nonImagePaths: string[] = [];

			for (const a of ctx.message.attachments || []) {
				const fullPath = `${workspacePath}/${a.local}`;
				const mimeType = getImageMimeType(a.local);

				if (mimeType && existsSync(fullPath)) {
					try {
						imageAttachments.push({
							type: "image",
							mimeType,
							data: readFileSync(fullPath).toString("base64"),
						});
					} catch {
						nonImagePaths.push(fullPath);
					}
				} else {
					nonImagePaths.push(fullPath);
				}
			}

			if (nonImagePaths.length > 0) {
				userMessage += `\n\n<slack_attachments>\n${nonImagePaths.join("\n")}\n</slack_attachments>`;
			}

			// Debug: write context to last_prompt.jsonl
			const debugContext = {
				systemPrompt,
				messages: session.messages,
				newUserMessage: userMessage,
				imageAttachmentCount: imageAttachments.length,
			};
			await writeFile(join(channelDir, "last_prompt.jsonl"), JSON.stringify(debugContext, null, 2));

			// Try prompt, handle recoverable errors by fixing context and retrying
			let retries = 0;
			const maxRetries = 3;
			while (true) {
				await session.prompt(userMessage, imageAttachments.length > 0 ? { images: imageAttachments } : undefined);

				const currentStopReason = (runState as { stopReason: string }).stopReason;
				const currentErrorMessage = (runState as { errorMessage?: string }).errorMessage;

				if (currentStopReason !== "error" || retries >= maxRetries) break;

				if (currentErrorMessage?.includes("msg_too_long")) {
					retries++;
					const messages = session.messages;
					const keepCount = Math.max(2, Math.floor(messages.length / 2));
					const trimmed = sanitizeToolPairs(messages.slice(messages.length - keepCount), log, channelId, threadTs);
					threadAgent.replaceMessages(trimmed);
					log.logInfo(
						`[${channelId}] Context too long, trimmed to ${trimmed.length} messages (retry ${retries}/${maxRetries})`,
					);
					runState.stopReason = "";
					runState.errorMessage = undefined;
					continue;
				}

				break;
			}

			// Wait for queued messages
			await queueChain;

			// Handle error case - update main message and post error to thread
			if (runState.stopReason === "error") {
				const errorDetail = runState.errorMessage || "unknown error";
				log.logWarning(`[${channelId}] Agent stopped with error: ${errorDetail}`);
				try {
					await ctx.replaceMessage(`_Sorry, something went wrong: ${errorDetail}_`);
					await ctx.respondInThread(`_Error: ${errorDetail}_`);
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					log.logWarning("Failed to post error message", errMsg);
				}
			} else {
				// Final message update - use last assistant message with meaningful content.
				// Reflection responses (SYSTEM LESSON) contain [RESUME] marker.
				// Strategy: prefer non-RESUME messages, but if the last message has
				// [RESUME], extract text after it (the actual continuation content).
				const messages = session.messages;
				let finalText = "";
				for (let i = messages.length - 1; i >= 0; i--) {
					const m = messages[i] as any;
					if (m.role === "assistant") {
						const text =
							m.content
								?.filter((c: any): c is { type: "text"; text: string } => c.type === "text")
								.map((c: { type: "text"; text: string }) => c.text)
								.join("\n") || "";
						if (!text.includes("[RESUME]")) {
							// Clean message with no reflection - use as-is
							finalText = text;
							break;
						}
						// Message contains [RESUME] - extract content after the last [RESUME]
						const resumeIdx = text.lastIndexOf("[RESUME]");
						const afterResume = text.substring(resumeIdx + "[RESUME]".length).trim();
						if (afterResume) {
							// Has meaningful content after [RESUME] - use it
							finalText = afterResume;
							break;
						}
						// Only [RESUME] with no real content after it - skip and check earlier messages
					}
				}

				if (finalText.trim()) {
					// For bot-initiated top-level messages (EVENT with no thread_ts),
					// update the main message with final response so it's visible without opening the thread.
					// When a user sends a top-level message and the bot replies in thread,
					// we should NOT replace the bot's reply — keep the intermediate tool call labels visible.
					const isBotTopLevel = ctx.message.user === "EVENT" && !ctx.message.thread_ts;
					if (isBotTopLevel) {
						try {
							await ctx.replaceMessage(finalText);
						} catch (err) {
							const errMsg = err instanceof Error ? err.message : String(err);
							log.logWarning("Failed to update main message with final text", errMsg);
						}
					}
					// Always post full response in thread
					try {
						const chunks = splitForSlack(finalText);
						for (const chunk of chunks) {
							await ctx.respondInThread(chunk);
						}
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning("Failed to post final text in thread", errMsg);
					}
				}
			}

			// Log usage summary - always send to hansol DM
			const USAGE_SUMMARY_CHANNEL = "D0AHEJW16S0";
			if (runState.totalUsage.cost.total > 0) {
				// Get last non-aborted assistant message for context calculation
				const messages = session.messages;
				const lastAssistantMessage = messages
					.slice()
					.reverse()
					.find((m: any) => m.role === "assistant" && (m as any).stopReason !== "aborted") as any;

				const contextTokens = lastAssistantMessage
					? lastAssistantMessage.usage.input +
						lastAssistantMessage.usage.output +
						lastAssistantMessage.usage.cacheRead +
						lastAssistantMessage.usage.cacheWrite
					: 0;
				const contextWindow = actualModel.contextWindow || DEFAULT_CONTEXT_WINDOW;

				const summary = log.logUsageSummary(
					runState.logCtx!,
					runState.totalUsage,
					contextTokens,
					contextWindow,
					actualModel.id,
					join(channelDir, "..", "daily-usage.json"),
				);
				if (ctx.message.channel === USAGE_SUMMARY_CHANNEL) {
					// Already in hansol DM - post in thread as before
					runState.queue.enqueue(() => ctx.respondInThread(summary, true), "usage summary");
				} else {
					// Other channel - send to hansol DM instead
					runState.queue.enqueue(async () => {
						await ctx.postToChannel(USAGE_SUMMARY_CHANNEL, summary);
					}, "usage summary to DM");
				}
				await queueChain;
			}

			// Clear run state
			runState.ctx = null;
			runState.logCtx = null;
			runState.queue = null;

			return { stopReason: runState.stopReason, errorMessage: runState.errorMessage };
		},

		abort(): void {
			session.abort();
		},

		steer(message: { userName: string; text: string }): void {
			const now = new Date();
			const pad = (n: number) => n.toString().padStart(2, "0");
			const offset = -now.getTimezoneOffset();
			const offsetSign = offset >= 0 ? "+" : "-";
			const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
			const offsetMins = pad(Math.abs(offset) % 60);
			const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetSign}${offsetHours}:${offsetMins}`;

			const userMessage: AgentMessage = {
				role: "user",
				content: [{ type: "text", text: `[${timestamp}] [${message.userName}]: ${message.text}` }],
				timestamp: Date.now(),
			};
			threadAgent.steer(userMessage);
			log.logInfo(
				`[${channelId}:${threadTs}] Steered with message from ${message.userName}: ${message.text.substring(0, 50)}`,
			);
		},
	};
}

/**
 * Translate container path back to host path for file operations
 */
function translateToHostPath(
	containerPath: string,
	channelDir: string,
	workspacePath: string,
	channelId: string,
): string {
	if (workspacePath === "/workspace") {
		const prefix = `/workspace/${channelId}/`;
		if (containerPath.startsWith(prefix)) {
			return join(channelDir, containerPath.slice(prefix.length));
		}
		if (containerPath.startsWith("/workspace/")) {
			return join(channelDir, "..", containerPath.slice("/workspace/".length));
		}
	}
	return containerPath;
}
