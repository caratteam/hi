/**
 * Context management for mom.
 *
 * Mom uses per-thread context files:
 * - context-{thread_ts}.jsonl: Structured API messages for LLM context, scoped to a single thread
 * - log.jsonl: Human-readable channel history for grep (no tool results)
 *
 * This module provides:
 * - getLogMessages: Reads conversation history from log.jsonl (thread-filtered, deduplicated)
 * - MomSettingsManager: Simple settings for mom (compaction, retry, model preferences)
 */

import type { UserMessage } from "@mariozechner/pi-ai";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

// ============================================================================
// Get conversation messages from log.jsonl
// ============================================================================

/** Maximum number of recent messages to read from log.jsonl */
const MAX_SYNC_MESSAGES = 20;

interface LogMessage {
	date?: string;
	ts?: string;
	thread_ts?: string;
	user?: string;
	userName?: string;
	text?: string;
	isBot?: boolean;
}

/**
 * Extract normalized text content from context messages for deduplication.
 */
function extractMessageTexts(messages: any[]): { userTexts: Set<string>; assistantTexts: Set<string> } {
	const userTexts = new Set<string>();
	const assistantTexts = new Set<string>();

	for (const msg of messages) {
		const role = msg.role;
		if (role !== "user" && role !== "assistant") continue;
		const targetSet = role === "assistant" ? assistantTexts : userTexts;
		const content = msg.content;
		if (typeof content === "string") {
			let normalized = content.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] /, "");
			const attachmentsIdx = normalized.indexOf("\n\n<slack_attachments>\n");
			if (attachmentsIdx !== -1) normalized = normalized.substring(0, attachmentsIdx);
			targetSet.add(normalized);
		} else if (Array.isArray(content)) {
			for (const part of content) {
				if (typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part) {
					let normalized = (part as { type: "text"; text: string }).text;
					normalized = normalized.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] /, "");
					const attachmentsIdx = normalized.indexOf("\n\n<slack_attachments>\n");
					if (attachmentsIdx !== -1) normalized = normalized.substring(0, attachmentsIdx);
					targetSet.add(normalized);
				}
			}
		}
	}

	return { userTexts, assistantTexts };
}

/**
 * Read conversation messages from log.jsonl, deduplicated against existing context messages.
 *
 * Returns an array of UserMessage objects (with role "user" for both user and bot messages,
 * since these are injected as conversation history context, not direct assistant responses).
 *
 * Bot messages use [bot/name] prefix, user messages use [name] prefix.
 *
 * @param channelDir - Path to channel directory containing log.jsonl
 * @param threadTs - Thread timestamp to filter by (undefined = top-level messages only)
 * @param excludeSlackTs - Slack timestamp of current message (will be added via prompt(), not sync)
 * @param existingMessages - Already-loaded context messages to check for duplicates
 * @returns Array of messages to prepend to context
 */
export function getLogMessages(
	channelDir: string,
	threadTs: string | undefined,
	excludeSlackTs: string | undefined,
	existingMessages: any[],
): UserMessage[] {
	const logFile = join(channelDir, "log.jsonl");

	if (!existsSync(logFile)) return [];

	// Build dedup sets from existing context messages
	const { userTexts: existingUserTexts, assistantTexts: existingAssistantTexts } =
		extractMessageTexts(existingMessages);

	// Read log.jsonl and filter to matching thread
	const logContent = readFileSync(logFile, "utf-8");
	const logLines = logContent.trim().split("\n").filter(Boolean);

	const threadMessages: Array<{ logMsg: LogMessage }> = [];

	for (const line of logLines) {
		try {
			const logMsg: LogMessage = JSON.parse(line);
			if (!logMsg.ts || !logMsg.date) continue;

			if (threadTs) {
				if (logMsg.thread_ts !== threadTs && logMsg.ts !== threadTs) continue;
			} else {
				if (logMsg.thread_ts) continue;
			}

			threadMessages.push({ logMsg });
		} catch {
			// Skip malformed lines
		}
	}

	// Take only the most recent MAX_SYNC_MESSAGES
	const totalThreadMessages = threadMessages.length;
	const wasTruncated = totalThreadMessages > MAX_SYNC_MESSAGES;
	const recentMessages = threadMessages.slice(-MAX_SYNC_MESSAGES);

	const result: UserMessage[] = [];
	const seenTexts = new Set<string>(existingUserTexts);

	// If messages were truncated, prepend a notice
	if (wasTruncated) {
		const omitted = totalThreadMessages - MAX_SYNC_MESSAGES;
		const noticeText = `[... ${omitted}개의 이전 메시지 생략. 이전 대화는 log.jsonl을 검색하세요 ...]`;
		if (!seenTexts.has(noticeText)) {
			const noticeTime =
				recentMessages.length > 0
					? (new Date(recentMessages[0].logMsg.date!).getTime() || Date.now()) - 1
					: Date.now();
			result.push({
				role: "user",
				content: [{ type: "text", text: noticeText }],
				timestamp: noticeTime,
			});
			seenTexts.add(noticeText);
		}
	}

	for (const { logMsg } of recentMessages) {
		// Skip the current message being processed (will be added via prompt())
		if (excludeSlackTs && logMsg.ts === excludeSlackTs) continue;

		const name = logMsg.userName || logMsg.user || "unknown";
		const messageText = logMsg.isBot ? `[bot/${name}]: ${logMsg.text || ""}` : `[${name}]: ${logMsg.text || ""}`;

		// Skip duplicates: check against existing context + already added
		if (seenTexts.has(messageText) || existingAssistantTexts.has(messageText)) continue;
		if (logMsg.isBot && existingAssistantTexts.has(logMsg.text || "")) continue;

		const msgTime = new Date(logMsg.date!).getTime() || Date.now();
		result.push({
			role: "user",
			content: [{ type: "text", text: messageText }],
			timestamp: msgTime,
		});
		seenTexts.add(messageText);
	}

	return result;
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

const DEFAULT_COMPACTION: MomCompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

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

	constructor(workspaceDir: string) {
		this.settingsPath = join(workspaceDir, "settings.json");
		this.settings = this.load();
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
		return {
			...DEFAULT_COMPACTION,
			...this.settings.compaction,
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
		return this.settings.defaultModel;
	}

	getDefaultProvider(): string | undefined {
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
		return { reserveTokens: 16384 };
	}

	getTheme(): string | undefined {
		return undefined;
	}
}
