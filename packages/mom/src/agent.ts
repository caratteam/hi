import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import { getModel, type ImageContent, type UserMessage } from "@mariozechner/pi-ai";
import {
	AgentSession,
	type AgentSessionEvent,
	AuthStorage,
	convertToLlm,
	createExtensionRuntime,
	formatSkillsForPrompt,
	loadSkillsFromDir,
	ModelRegistry,
	type ResourceLoader,
	SessionManager,
	type Skill,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { getLogMessages, MomSettingsManager } from "./context.js";
import * as log from "./log.js";
import { createExecutor, type SandboxConfig } from "./sandbox.js";
import type { ChannelInfo, SlackContext, UserInfo } from "./slack.js";
import type { ChannelStore } from "./store.js";
import { createMomTools } from "./tools/index.js";

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
}

/** Shared AuthStorage instance for API key access */
let sharedAuthStorage: AuthStorage | null = null;

/** Get API key for a given provider, checking process.env first then AuthStorage */
async function getProviderApiKey(authStorage: AuthStorage, provider: string): Promise<string> {
	// Check process.env first (populated by .mom-env)
	const envKey = PROVIDER_ENV_KEYS[provider];
	if (envKey && process.env[envKey]) {
		return process.env[envKey]!;
	}
	// Fall back to AuthStorage (reads auth.json + env vars via pi-ai)
	const key = await authStorage.getApiKey(provider);
	if (!key) {
		throw new Error(
			`No API key found for ${provider}.\n\n` +
				"Set the key in ~/.mom-env (e.g. OPENROUTER_TOKEN=...) or as an environment variable.",
		);
	}
	return key;
}

/** Get Anthropic API key for lightweight operations (e.g. reaction classification) */
export async function getAnthropicKey(): Promise<string> {
	if (!sharedAuthStorage) {
		sharedAuthStorage = AuthStorage.create(join(homedir(), ".pi", "mom", "auth.json"));
	}
	return getProviderApiKey(sharedAuthStorage, "anthropic");
}

/**
 * Call Bedrock Haiku for lightweight classification tasks.
 * Returns the response text, or fallback on error.
 * Uses AWS credentials from process.env (set via .mom-env).
 */
export async function callBedrockHaiku(prompt: string, fallback: string): Promise<string> {
	try {
		const { BedrockRuntimeClient, ConverseCommand } = await import("@aws-sdk/client-bedrock-runtime");
		const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
		const client = new BedrockRuntimeClient({ region });
		const command = new ConverseCommand({
			modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
			messages: [{ role: "user", content: [{ text: prompt }] }],
			inferenceConfig: { maxTokens: 100 },
		});
		const response = await client.send(command);
		const output = response.output;
		if (output?.message?.content?.[0] && "text" in output.message.content[0]) {
			return output.message.content[0].text?.trim() || fallback;
		}
		return fallback;
	} catch (err) {
		log.logWarning("Bedrock Haiku call error", err instanceof Error ? err.message : String(err));
		return fallback;
	}
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

function getMemory(channelDir: string): string {
	const parts: string[] = [];

	// Read workspace-level memory (shared across all channels)
	const workspaceMemoryPath = join(channelDir, "..", "MEMORY.md");
	if (existsSync(workspaceMemoryPath)) {
		try {
			const content = readFileSync(workspaceMemoryPath, "utf-8").trim();
			if (content) {
				parts.push(`### Global Workspace Memory\n${content}`);
			}
		} catch (error) {
			log.logWarning("Failed to read workspace memory", `${workspaceMemoryPath}: ${error}`);
		}
	}

	// Read channel-specific memory
	const channelMemoryPath = join(channelDir, "MEMORY.md");
	if (existsSync(channelMemoryPath)) {
		try {
			const content = readFileSync(channelMemoryPath, "utf-8").trim();
			if (content) {
				parts.push(`### Channel-Specific Memory\n${content}`);
			}
		} catch (error) {
			log.logWarning("Failed to read channel memory", `${channelMemoryPath}: ${error}`);
		}
	}

	if (parts.length === 0) {
		return "(no working memory yet)";
	}

	return parts.join("\n\n");
}

function loadMomSkills(channelDir: string, workspacePath: string): Skill[] {
	const skillMap = new Map<string, Skill>();

	// channelDir is the host path (e.g., /Users/.../data/C0A34FL8PMH)
	// hostWorkspacePath is the parent directory on host
	// workspacePath is the container path (e.g., /workspace)
	const hostWorkspacePath = join(channelDir, "..");

	// Helper to translate host paths to container paths
	const translatePath = (hostPath: string): string => {
		if (hostPath.startsWith(hostWorkspacePath)) {
			return workspacePath + hostPath.slice(hostWorkspacePath.length);
		}
		return hostPath;
	};

	// Load workspace-level skills (global)
	const workspaceSkillsDir = join(hostWorkspacePath, "skills");
	for (const skill of loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" }).skills) {
		// Translate paths to container paths for system prompt
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	// Load channel-specific skills (override workspace skills on collision)
	const channelSkillsDir = join(channelDir, "skills");
	for (const skill of loadSkillsFromDir({ dir: channelSkillsDir, source: "channel" }).skills) {
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	return Array.from(skillMap.values());
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
	const channelPath = `${workspacePath}/${channelId}`;
	const isDocker = sandboxConfig.type === "docker";

	// Format channel mappings
	const channelMappings =
		channels.length > 0 ? channels.map((c) => `${c.id}\t#${c.name}`).join("\n") : "(no channels loaded)";

	// Format user mappings
	const userMappings =
		users.length > 0 ? users.map((u) => `${u.id}\t@${u.userName}\t${u.displayName}`).join("\n") : "(no users loaded)";

	const envDescription = isDocker
		? `You are running inside a Docker container (Alpine Linux).
- Bash working directory: / (use cd or absolute paths)
- Install tools with: apk add <package>
- Your changes persist across sessions`
		: `You are running directly on the host machine.
- Bash working directory: ${process.cwd()}
- Be careful with system modifications`;

	return `You are mom, a Slack bot assistant. Be concise. No emojis.

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
    ├── MEMORY.md                # Channel-specific memory
    ├── log.jsonl                # Message history (no tool results)
    ├── attachments/             # User-shared files
    ├── scratch/                 # Your working directory
    └── skills/                  # Channel-specific tools

## Skills (Custom CLI Tools)
You can create reusable CLI tools for recurring tasks (email, APIs, data processing, etc.).

### Creating Skills
Store in \`${workspacePath}/skills/<name>/\` (global) or \`${channelPath}/skills/<name>/\` (channel-specific).
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

### Silent Completion
For periodic events where there's nothing to report, respond with just \`[SILENT]\` (no other text). This deletes the status message and posts nothing to Slack. Use this to avoid spamming the channel when periodic checks find nothing actionable.

### Debouncing
When writing programs that create immediate events (email watchers, webhook handlers, etc.), always debounce. If 50 emails arrive in a minute, don't create 50 immediate events. Instead collect events over a window and create ONE immediate event summarizing what happened, or just signal "new activity, check inbox" rather than per-item events. Or simpler: use a periodic event to check for new items every N minutes instead of immediate events.

### Limits
Maximum 5 events can be queued. Don't create excessive immediate or periodic events.

## Memory
Write to MEMORY.md files to persist context across conversations.
- Global (${workspacePath}/MEMORY.md): skills, preferences, project info
- Channel (${channelPath}/MEMORY.md): channel-specific decisions, ongoing work
Update when you learn something important or when asked to remember something.

### Current Memory
${memory}

## System Configuration Log
Maintain ${workspacePath}/SYSTEM.md to log all environment modifications:
- Installed packages (apk add, npm install, pip install)
- Environment variables set
- Config files modified (~/.gitconfig, cron jobs, etc.)
- Skill dependencies installed

Update this file whenever you modify the environment. On fresh container, read it first to restore your setup.

## Log Queries (for older history)
Format: \`{"date":"...","ts":"...","user":"...","userName":"...","text":"...","isBot":false}\`
The log contains user messages and your final responses (not tool calls/results).
${isDocker ? "Install jq: apk add jq" : ""}

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

function formatToolArgsForSlack(_toolName: string, args: Record<string, unknown>): string {
	const lines: string[] = [];

	for (const [key, value] of Object.entries(args)) {
		if (key === "label") continue;

		if (key === "path" && typeof value === "string") {
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined && limit !== undefined) {
				lines.push(`${value}:${offset}-${offset + limit}`);
			} else {
				lines.push(value);
			}
			continue;
		}

		if (key === "offset" || key === "limit") continue;

		if (typeof value === "string") {
			lines.push(value);
		} else {
			lines.push(JSON.stringify(value));
		}
	}

	return lines.join("\n");
}

// Cache runners per channel
const channelRunners = new Map<string, AgentRunner>();

/**
 * Get or create an AgentRunner for a channel.
 * Runners are cached - one per channel, persistent across messages.
 */
export function getOrCreateRunner(sandboxConfig: SandboxConfig, channelId: string, channelDir: string): AgentRunner {
	const existing = channelRunners.get(channelId);
	if (existing) return existing;

	const runner = createRunner(sandboxConfig, channelId, channelDir);
	channelRunners.set(channelId, runner);
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

/** Maximum number of messages to keep from context file when loading */
const MAX_CONTEXT_MESSAGES = 20;

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
					if (c?.data && typeof c.data === "string" && c.data.length > 1000) {
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

function createRunner(sandboxConfig: SandboxConfig, channelId: string, channelDir: string): AgentRunner {
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

	// Create tools with access to current user ID and upload function
	const tools = createMomTools(
		executor,
		() => currentUserId,
		async (filePath: string, title?: string) => {
			if (!currentUploadFn) throw new Error("Upload function not configured for this run");
			await currentUploadFn(filePath, title);
		},
	);

	// Initial system prompt (will be updated each run with fresh memory/channels/users/skills)
	const memory = getMemory(channelDir);
	const skills = loadMomSkills(channelDir, workspacePath);
	const systemPrompt = buildSystemPrompt(workspacePath, channelId, memory, sandboxConfig, [], [], skills);

	const settingsManager = new MomSettingsManager(join(channelDir, ".."));

	// Create AuthStorage and ModelRegistry
	const authStorage = AuthStorage.create(join(homedir(), ".pi", "mom", "auth.json"));
	sharedAuthStorage = authStorage;
	const modelRegistry = new ModelRegistry(authStorage);

	// Create agent
	const agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			thinkingLevel: "off",
			tools,
		},
		convertToLlm,
		getApiKey: async (provider?: string) => getProviderApiKey(authStorage, provider || model.provider),
	});

	const resourceLoader: ResourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		getPathMetadata: () => new Map(),
		extendResources: () => {},
		reload: async () => {},
	};

	const baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

	// Per-thread session cache: threadTs -> { sessionManager, session }
	const threadSessions = new Map<string, { sessionManager: SessionManager; session: AgentSession }>();

	/** Get or create a session for a specific thread */
	function getThreadSession(threadTs: string): { sessionManager: SessionManager; session: AgentSession } {
		const existing = threadSessions.get(threadTs);
		if (existing) return existing;

		const contextFile = getContextFilePath(channelDir, threadTs);
		const sessionManager = SessionManager.open(contextFile, channelDir);
		patchSessionManagerPersist(sessionManager);

		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager: settingsManager as any,
			cwd: process.cwd(),
			modelRegistry,
			resourceLoader,
			baseToolsOverride,
		});

		// Subscribe to events for this session (same handler for all threads)
		// Guard: only handle events if THIS session is the currently active one.
		// Since all sessions share the same Agent, the Agent's event listeners
		// fire for ALL sessions, causing duplicate handling without this check.
		session.subscribe(async (event: AgentSessionEvent) => {
			if (!runState.ctx || !runState.logCtx || !runState.queue) return;
			if (runState.currentSession !== session) return;
			handleSessionEvent(event, runState);
		});

		const entry = { sessionManager, session };
		threadSessions.set(threadTs, entry);
		log.logInfo(`[${channelId}] Created new thread session: ${threadTs}`);
		return entry;
	}

	// Mutable per-run state - event handler references this
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
		currentSession: AgentSession | null;
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
		currentSession: null,
	};

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

			const label = pending?.args ? (pending.args as { label?: string }).label : undefined;
			const argsFormatted = pending
				? formatToolArgsForSlack(agentEvent.toolName, pending.args as Record<string, unknown>)
				: "(args not found)";
			const duration = (durationMs / 1000).toFixed(1);
			let threadMessage = `*${agentEvent.isError ? "✗" : "✓"} ${agentEvent.toolName}*`;
			if (label) threadMessage += `: ${label}`;
			threadMessage += ` (${duration}s)\n`;
			if (argsFormatted) threadMessage += `\`\`\`\n${argsFormatted}\n\`\`\`\n`;
			threadMessage += `*Result:*\n\`\`\`\n${resultStr}\n\`\`\``;

			queue.enqueueMessage(threadMessage, "thread", "tool result thread", false);

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
					queue.enqueueMessage(`_${thinking}_`, "thread", "thinking thread", false);
				}

				if (text.trim()) {
					log.logResponse(logCtx, text);
					queue.enqueueMessage(text, "main", "response main");
					queue.enqueueMessage(text, "thread", "response thread", false);
				}
			}
		} else if (event.type === "auto_compaction_start") {
			log.logInfo(`Auto-compaction started (reason: ${(event as any).reason})`);
			queue.enqueue(() => ctx.respond("_Compacting context..._", false), "compaction start");
		} else if (event.type === "auto_compaction_end") {
			const compEvent = event as any;
			if (compEvent.result) {
				log.logInfo(`Auto-compaction complete: ${compEvent.result.tokensBefore} tokens compacted`);
			} else if (compEvent.aborted) {
				log.logInfo("Auto-compaction aborted");
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
	const SLACK_MAX_LENGTH = 40000;
	const splitForSlack = (text: string): string[] => {
		if (text.length <= SLACK_MAX_LENGTH) return [text];
		const parts: string[] = [];
		let remaining = text;
		let partNum = 1;
		while (remaining.length > 0) {
			const chunk = remaining.substring(0, SLACK_MAX_LENGTH - 50);
			remaining = remaining.substring(SLACK_MAX_LENGTH - 50);
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

			// Determine thread context:
			// - If in an existing thread: use event.thread_ts
			// - If top-level mention: use the message ts (will become thread parent)
			const threadTs = ctx.message.thread_ts || ctx.message.ts;

			// Get or create thread-specific session
			const { sessionManager, session } = getThreadSession(threadTs);

			// Store current session for abort()
			runState.currentSession = session;

			// Reload messages from thread's context file
			const reloadedSession = sessionManager.buildSessionContext();
			if (reloadedSession.messages.length > 0) {
				// Strip large binary data from historical messages
				let strippedCount = 0;
				for (const msg of reloadedSession.messages) {
					const content = (msg as any).content;
					if (!content || !Array.isArray(content)) continue;
					for (let i = content.length - 1; i >= 0; i--) {
						const block = content[i];
						if (block.data && typeof block.data === "string" && block.data.length > 1000) {
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

				// Step 1: Trim context.jsonl to most recent MAX_CONTEXT_MESSAGES
				const messages = reloadedSession.messages;
				const contextWasTrimmed = messages.length > MAX_CONTEXT_MESSAGES;
				let trimmedMessages = contextWasTrimmed ? messages.slice(messages.length - MAX_CONTEXT_MESSAGES) : messages;
				if (contextWasTrimmed) {
					log.logInfo(
						`[${channelId}:${threadTs}] Trimmed context from ${messages.length} to ${trimmedMessages.length} messages`,
					);
				}

				// Sanitize tool_use/tool_result pairs after trimming
				trimmedMessages = sanitizeToolPairs(trimmedMessages, log, channelId, threadTs);

				// Step 2: Get conversation history from log.jsonl, deduplicated against trimmed context
				const logMessages = getLogMessages(channelDir, threadTs, ctx.message.ts, trimmedMessages);
				if (logMessages.length > 0) {
					log.logInfo(`[${channelId}:${threadTs}] Prepending ${logMessages.length} messages from log.jsonl`);
				}

				// Step 3: Build final message array
				// [log truncation notice?] [log messages] [context trim notice?] [trimmed context messages]
				const finalMessages: any[] = [];

				// Add log messages (conversation history) first
				if (logMessages.length > 0) {
					finalMessages.push(...logMessages);
				}

				// Add context trim notice if context was trimmed
				if (contextWasTrimmed) {
					const omitted = messages.length - MAX_CONTEXT_MESSAGES;
					const contextNotice: UserMessage = {
						role: "user",
						content: [
							{
								type: "text",
								text: `[... ${omitted}개의 이전 tool 호출/결과 메시지 생략 ...]`,
							},
						],
						timestamp: Date.now(),
					};
					finalMessages.push(contextNotice);
				}

				// Add trimmed context messages
				finalMessages.push(...trimmedMessages);

				agent.replaceMessages(finalMessages);
				log.logInfo(
					`[${channelId}:${threadTs}] Loaded ${finalMessages.length} messages (${logMessages.length} from log + ${trimmedMessages.length} from context)`,
				);
			} else {
				// New thread - clear any messages from previous thread
				agent.replaceMessages([]);
			}

			// Update system prompt with fresh memory, channel/user info, and skills
			const memory = getMemory(channelDir);
			const skills = loadMomSkills(channelDir, workspacePath);
			const systemPrompt = buildSystemPrompt(
				workspacePath,
				channelId,
				memory,
				sandboxConfig,
				ctx.channels,
				ctx.users,
				skills,
			);
			session.agent.setSystemPrompt(systemPrompt);

			// Dynamic model override from settings.json
			let actualModel = model; // Start with default
			const savedProvider = settingsManager.getDefaultProvider();
			const savedModelId = settingsManager.getDefaultModel();
			if (savedProvider && savedModelId) {
				const dynamicModel = getModel(savedProvider as any, savedModelId as any);
				if (dynamicModel) {
					session.agent.setModel(dynamicModel);
					actualModel = dynamicModel; // Track actual model used
				}
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
					session.agent.replaceMessages(trimmed);
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
				// Final message update
				const messages = session.messages;
				const lastAssistant = messages.filter((m: any) => m.role === "assistant").pop() as any;
				const finalText =
					lastAssistant?.content
						.filter((c: any): c is { type: "text"; text: string } => c.type === "text")
						.map((c: { type: "text"; text: string }) => c.text)
						.join("\n") || "";

				// Check for [SILENT] marker - delete message and thread instead of posting
				if (finalText.trim() === "[SILENT]" || finalText.trim().startsWith("[SILENT]")) {
					try {
						await ctx.deleteMessage();
						log.logInfo("Silent response - deleted message and thread");
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning("Failed to delete message for silent response", errMsg);
					}
				} else if (finalText.trim()) {
					try {
						const mainText =
							finalText.length > SLACK_MAX_LENGTH
								? `${finalText.substring(0, SLACK_MAX_LENGTH - 50)}\n\n_(see thread for full response)_`
								: finalText;
						await ctx.replaceMessage(mainText);
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning("Failed to replace message with final text", errMsg);
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
				const contextWindow = actualModel.contextWindow || 200000;

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
			runState.currentSession = null;

			return { stopReason: runState.stopReason, errorMessage: runState.errorMessage };
		},

		abort(): void {
			if (runState.currentSession) {
				runState.currentSession.abort();
			}
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
