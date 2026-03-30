/**
 * Context management for mom.
 *
 * Mom uses per-thread context files:
 * - context-{thread_ts}.jsonl: Structured API messages for LLM context, scoped to a single thread
 * - log.jsonl: Human-readable channel history for grep (no tool results)
 *
 * This module provides:
 * - syncLogToSessionManager: Syncs messages from log.jsonl to SessionManager (thread-filtered, deduplicated)
 * - MomSettingsManager: Simple settings for mom (compaction, retry, model preferences)
 */

import type { UserMessage } from "@mariozechner/pi-ai";
import type { SessionManager, SessionMessageEntry } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

// ============================================================================
// Sync log.jsonl to SessionManager
// ============================================================================

interface LogMessage {
	date?: string;
	ts?: string;
	thread_ts?: string;
	user?: string;
	userName?: string;
	text?: string;
	isBot?: boolean;
}

/** Maximum number of messages to sync from log.jsonl in one pass.
 * Prevents overwhelming the context on first sync with a large log file.
 * Auto-compaction handles growth, but we still cap to avoid a huge initial burst. */
const MAX_SYNC_MESSAGES = 30;

/**
 * Sync user messages from log.jsonl to SessionManager.
 *
 * This ensures that messages logged while mom wasn't running (channel chatter,
 * backfilled messages, messages while busy) are added to the LLM context.
 * Messages are permanently appended to SessionManager (and thus to context.jsonl),
 * so auto-compaction handles context growth naturally.
 *
 * Thread-aware: only syncs messages belonging to the specified thread.
 *
 * @param sessionManager - The SessionManager to sync to
 * @param channelDir - Path to channel directory containing log.jsonl
 * @param threadTs - Thread timestamp to filter by (undefined = top-level messages only)
 * @param excludeSlackTs - Slack timestamp of current message (will be added via prompt(), not sync)
 * @returns Number of messages synced
 */
export function syncLogToSessionManager(
	sessionManager: SessionManager,
	channelDir: string,
	threadTs?: string,
	excludeSlackTs?: string,
): number {
	const logFile = join(channelDir, "log.jsonl");

	if (!existsSync(logFile)) return 0;

	// Build set of existing message content from session for deduplication
	const existingMessages = new Set<string>();
	for (const entry of sessionManager.getEntries()) {
		if (entry.type === "message") {
			const msgEntry = entry as SessionMessageEntry;
			const msg = msgEntry.message as { role: string; content?: unknown };
			if (msg.role === "user" && msg.content !== undefined) {
				const content = msg.content;
				if (typeof content === "string") {
					let normalized = content.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] /, "");
					const attachmentsIdx = normalized.indexOf("\n\n<slack_attachments>\n");
					if (attachmentsIdx !== -1) {
						normalized = normalized.substring(0, attachmentsIdx);
					}
					existingMessages.add(normalized);
				} else if (Array.isArray(content)) {
					for (const part of content) {
						if (
							typeof part === "object" &&
							part !== null &&
							"type" in part &&
							part.type === "text" &&
							"text" in part
						) {
							let normalized = (part as { type: "text"; text: string }).text;
							normalized = normalized.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] /, "");
							const attachmentsIdx = normalized.indexOf("\n\n<slack_attachments>\n");
							if (attachmentsIdx !== -1) {
								normalized = normalized.substring(0, attachmentsIdx);
							}
							existingMessages.add(normalized);
						}
					}
				}
			}
		}
	}

	// Read log.jsonl and find user messages not in context, filtered by thread
	const logContent = readFileSync(logFile, "utf-8");
	const logLines = logContent.trim().split("\n").filter(Boolean);

	const newMessages: Array<{ timestamp: number; message: UserMessage }> = [];

	for (const line of logLines) {
		try {
			const logMsg: LogMessage = JSON.parse(line);

			const slackTs = logMsg.ts;
			const date = logMsg.date;
			if (!slackTs || !date) continue;

			// Thread filtering: only sync messages belonging to this thread
			if (threadTs) {
				if (logMsg.thread_ts !== threadTs && logMsg.ts !== threadTs) continue;
			} else {
				// Top-level context: skip threaded messages
				if (logMsg.thread_ts) continue;
			}

			// Skip the current message being processed (will be added via prompt())
			if (excludeSlackTs && slackTs === excludeSlackTs) continue;

			// Skip bot messages - added through agent flow
			if (logMsg.isBot) continue;

			// Build the message text as it would appear in context
			const messageText = `[${logMsg.userName || logMsg.user || "unknown"}]: ${logMsg.text || ""}`;

			// Skip if this exact message text is already in context
			if (existingMessages.has(messageText)) continue;

			const msgTime = new Date(date).getTime() || Date.now();
			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: messageText }],
				timestamp: msgTime,
			};

			newMessages.push({ timestamp: msgTime, message: userMessage });
			existingMessages.add(messageText); // Track to avoid duplicates within this sync
		} catch {
			// Skip malformed lines
		}
	}

	if (newMessages.length === 0) return 0;

	// Sort by timestamp and keep only the most recent messages
	newMessages.sort((a, b) => a.timestamp - b.timestamp);
	if (newMessages.length > MAX_SYNC_MESSAGES) {
		newMessages.splice(0, newMessages.length - MAX_SYNC_MESSAGES);
	}

	for (const { message } of newMessages) {
		sessionManager.appendMessage(message);
	}

	return newMessages.length;
}

// ============================================================================
// MomSettingsManager - Simple settings for mom
// ============================================================================

export interface MomCompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export interface MomRetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
}

export interface MomSettings {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
	compaction?: Partial<MomCompactionSettings>;
	retry?: Partial<MomRetrySettings>;
}

/**
 * Baseline defaults used when no contextWindow is known.
 * When contextWindow IS known, reserveTokens and keepRecentTokens are
 * computed as a percentage of the window to keep compaction triggers
 * at a consistent context-usage ratio regardless of model size.
 *
 * Rationale (context rot research):
 *   - Chroma Research (2025): performance degrades non-linearly with input length
 *   - Anthropic docs: "as token count grows, accuracy and recall degrade"
 *   - 16k reserve on a 200k model = 92% fill before compaction → too late
 *   - 30% reserve → compaction at 70% fill, similar to 16k/50k ratio
 */
const DEFAULT_COMPACTION: MomCompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

/** Reserve 30% of context window → compaction triggers at 70% fill */
const RESERVE_TOKENS_RATIO = 0.3;
/** Keep 15% of context window as recent tokens after compaction */
const KEEP_RECENT_TOKENS_RATIO = 0.15;

// Min/max caps: on 1M context models, ratio-based values become excessive.
// A single prompt cache miss at 700K uncached tokens costs $10+ on Opus.
// Cap ensures compaction triggers early enough to keep worst-case cost ~$3.
const MIN_RESERVE_TOKENS = 16_384;
const MIN_KEEP_RECENT_TOKENS = 8_192;
const MAX_USABLE_CONTEXT = 200_000;
const MAX_KEEP_RECENT_TOKENS = 40_000;

const DEFAULT_RETRY: MomRetrySettings = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 2000,
};

/**
 * Settings manager for mom.
 * Stores settings in the workspace root directory.
 */
export class MomSettingsManager {
	private settingsPath: string;
	private settings: MomSettings;
	private contextWindow = 0;

	constructor(workspaceDir: string) {
		this.settingsPath = join(workspaceDir, "settings.json");
		this.settings = this.load();
	}

	/**
	 * Set the current model's context window size.
	 * Called when the model is determined at run start.
	 * Enables dynamic ratio-based compaction settings.
	 */
	setContextWindow(contextWindow: number): void {
		this.contextWindow = contextWindow;
	}

	private load(): MomSettings {
		if (!existsSync(this.settingsPath)) {
			return {};
		}

		try {
			const content = readFileSync(this.settingsPath, "utf-8");
			return JSON.parse(content);
		} catch {
			return {};
		}
	}

	private save(): void {
		try {
			const dir = dirname(this.settingsPath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), "utf-8");
		} catch (error) {
			console.error(`Warning: Could not save settings file: ${error}`);
		}
	}

	getCompactionSettings(): MomCompactionSettings {
		const explicit = this.settings.compaction ?? {};
		// If contextWindow is known, compute ratio-based defaults.
		// Explicit values in settings.json always take precedence.
		if (this.contextWindow > 0) {
			// Ensure compaction triggers before MAX_USABLE_CONTEXT tokens.
			// On 200K models: ratio-based 60K wins → triggers at 140K (unchanged).
			// On 1M models: (1M - 200K) = 800K wins → triggers at 200K (capped).
			const ratioBased = Math.round(this.contextWindow * RESERVE_TOKENS_RATIO);
			const capBased = this.contextWindow - MAX_USABLE_CONTEXT;
			const reserve = Math.max(MIN_RESERVE_TOKENS, ratioBased, capBased);
			const usable = this.contextWindow - reserve;
			const keep = Math.min(
				MAX_KEEP_RECENT_TOKENS,
				Math.max(MIN_KEEP_RECENT_TOKENS, Math.round(usable * KEEP_RECENT_TOKENS_RATIO)),
			);
			return {
				enabled: explicit.enabled ?? DEFAULT_COMPACTION.enabled,
				reserveTokens: explicit.reserveTokens ?? reserve,
				keepRecentTokens: explicit.keepRecentTokens ?? keep,
			};
		}
		return {
			...DEFAULT_COMPACTION,
			...explicit,
		};
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? DEFAULT_COMPACTION.enabled;
	}

	setCompactionEnabled(enabled: boolean): void {
		this.settings.compaction = { ...this.settings.compaction, enabled };
		this.save();
	}

	getRetrySettings(): MomRetrySettings {
		return {
			...DEFAULT_RETRY,
			...this.settings.retry,
		};
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? DEFAULT_RETRY.enabled;
	}

	setRetryEnabled(enabled: boolean): void {
		this.settings.retry = { ...this.settings.retry, enabled };
		this.save();
	}

	getDefaultModel(): string | undefined {
		this.settings = this.load();
		return this.settings.defaultModel;
	}

	getDefaultProvider(): string | undefined {
		this.settings = this.load();
		return this.settings.defaultProvider;
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.settings.defaultProvider = provider;
		this.settings.defaultModel = modelId;
		this.save();
	}

	getDefaultThinkingLevel(): string {
		return this.settings.defaultThinkingLevel || "off";
	}

	setDefaultThinkingLevel(level: string): void {
		this.settings.defaultThinkingLevel = level as MomSettings["defaultThinkingLevel"];
		this.save();
	}

	// Compatibility methods for AgentSession
	getSteeringMode(): "all" | "one-at-a-time" {
		return "one-at-a-time"; // Mom processes one message at a time
	}

	setSteeringMode(_mode: "all" | "one-at-a-time"): void {
		// No-op for mom
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return "one-at-a-time"; // Mom processes one message at a time
	}

	setFollowUpMode(_mode: "all" | "one-at-a-time"): void {
		// No-op for mom
	}

	getHookPaths(): string[] {
		return []; // Mom doesn't use hooks
	}

	getHookTimeout(): number {
		return 30000;
	}

	// Compatibility shims for pi-coding-agent
	getShellCommandPrefix(): string | undefined {
		return undefined;
	}

	getImageAutoResize(): boolean {
		return true;
	}

	getBranchSummarySettings(): { reserveTokens: number } {
		const reserveTokens = this.contextWindow > 0 ? Math.round(this.contextWindow * RESERVE_TOKENS_RATIO) : 16384;
		return { reserveTokens };
	}

	getTheme(): string | undefined {
		return undefined;
	}
}
