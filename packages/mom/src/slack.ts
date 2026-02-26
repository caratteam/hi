import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import * as log from "./log.js";
import type { Attachment, ChannelStore } from "./store.js";

// ============================================================================
// Constants
// ============================================================================

/** Slack's max text length for chat.postMessage / chat.update is 40000, use a safe margin */
const SLACK_MAX_TEXT = 39000;

/** Truncate text to fit Slack's message size limit */
function truncateForSlack(text: string): string {
	if (text.length > SLACK_MAX_TEXT) {
		log.logWarning(`Truncating Slack message: ${text.length} chars -> ${SLACK_MAX_TEXT} chars`);
		return text.substring(0, SLACK_MAX_TEXT) + "\n\n_... (truncated, response too long)_";
	}
	return text;
}

// ============================================================================
// Types
// ============================================================================

export interface SlackEvent {
	type: "mention" | "dm";
	channel: string;
	ts: string;
	thread_ts?: string; // If this is in a thread, the parent message timestamp
	user: string;
	text: string;
	files?: Array<{ name?: string; url_private_download?: string; url_private?: string }>;
	/** Processed attachments with local paths (populated after logUserMessage) */
	attachments?: Attachment[];
}

export interface SlackUser {
	id: string;
	userName: string;
	displayName: string;
}

export interface SlackChannel {
	id: string;
	name: string;
}

// Types used by agent.ts
export interface ChannelInfo {
	id: string;
	name: string;
}

export interface UserInfo {
	id: string;
	userName: string;
	displayName: string;
}

export interface SlackContext {
	message: {
		text: string;
		rawText: string;
		user: string;
		userName?: string;
		channel: string;
		ts: string;
		thread_ts?: string;
		attachments: Array<{ local: string }>;
	};
	channelName?: string;
	channels: ChannelInfo[];
	users: UserInfo[];
	respond: (text: string, shouldLog?: boolean) => Promise<void>;
	replaceMessage: (text: string) => Promise<void>;
	respondInThread: (text: string, force?: boolean) => Promise<void>;
	setTyping: (isTyping: boolean) => Promise<void>;
	uploadFile: (filePath: string, title?: string) => Promise<void>;
	setWorking: (working: boolean) => Promise<void>;
	deleteMessage: () => Promise<void>;
}

export interface MomHandler {
	/**
	 * Check if channel is currently running (SYNC)
	 */
	isRunning(channelId: string): boolean;

	/**
	 * Handle an event that triggers mom (ASYNC)
	 * Called only when isRunning() returned false for user messages.
	 * Events always queue and pass isEvent=true.
	 */
	handleEvent(event: SlackEvent, slack: SlackBot, isEvent?: boolean): Promise<void>;

	/**
	 * Handle stop command (ASYNC)
	 * Called when user says "stop" while mom is running
	 */
	handleStop(channelId: string, slack: SlackBot): Promise<void>;
}

// ============================================================================
// Per-channel queue for sequential processing
// ============================================================================

type QueuedWork = () => Promise<void>;

class ChannelQueue {
	private queue: QueuedWork[] = [];
	private processing = false;

	enqueue(work: QueuedWork): void {
		this.queue.push(work);
		this.processNext();
	}

	size(): number {
		return this.queue.length;
	}

	private async processNext(): Promise<void> {
		if (this.processing || this.queue.length === 0) return;
		this.processing = true;
		const work = this.queue.shift()!;
		try {
			await work();
		} catch (err) {
			log.logWarning("Queue error", err instanceof Error ? err.message : String(err));
		}
		this.processing = false;
		this.processNext();
	}
}

// ============================================================================
// SlackBot
// ============================================================================

export class SlackBot {
	private socketClient: SocketModeClient;
	private webClient: WebClient;
	private handler: MomHandler;
	private workingDir: string;
	private store: ChannelStore;
	private botUserId: string | null = null;
	private startupTs: string | null = null; // Messages older than this are just logged, not processed

	private users = new Map<string, SlackUser>();
	private channels = new Map<string, SlackChannel>();
	private queues = new Map<string, ChannelQueue>();
	private getApiKey?: () => Promise<string>;
	private callHaikuOverride?: (prompt: string, fallback: string) => Promise<string>;

	/**
	 * Max number of non-bot messages after bot's last reply before disengaging.
	 * If more than this many messages pass without bot involvement, stop auto-responding.
	 */
	private static readonly CONVERSATION_MAX_GAP = 5;

	constructor(
		handler: MomHandler,
		config: {
			appToken: string;
			botToken: string;
			workingDir: string;
			store: ChannelStore;
			getApiKey?: () => Promise<string>;
			callHaiku?: (prompt: string, fallback: string) => Promise<string>;
		},
	) {
		this.handler = handler;
		this.workingDir = config.workingDir;
		this.store = config.store;
		this.getApiKey = config.getApiKey;
		this.callHaikuOverride = config.callHaiku;
		this.socketClient = new SocketModeClient({ appToken: config.appToken });
		this.webClient = new WebClient(config.botToken);
	}

	// ==========================================================================
	// Public API
	// ==========================================================================

	async start(): Promise<void> {
		const auth = await this.webClient.auth.test();
		this.botUserId = auth.user_id as string;

		await Promise.all([this.fetchUsers(), this.fetchChannels()]);
		log.logInfo(`Loaded ${this.channels.size} channels, ${this.users.size} users`);

		await this.backfillAllChannels();

		this.setupEventHandlers();
		await this.socketClient.start();

		// Record startup time - messages older than this are just logged, not processed
		this.startupTs = (Date.now() / 1000).toFixed(6);

		log.logConnected();
	}

	getUser(userId: string): SlackUser | undefined {
		return this.users.get(userId);
	}

	getChannel(channelId: string): SlackChannel | undefined {
		return this.channels.get(channelId);
	}

	getAllUsers(): SlackUser[] {
		return Array.from(this.users.values());
	}

	getAllChannels(): SlackChannel[] {
		return Array.from(this.channels.values());
	}

	async postMessage(channel: string, text: string): Promise<string> {
		const truncated = truncateForSlack(text);
		log.logInfo(`[slack] postMessage: ${text.length} chars -> ${truncated.length} chars`);
		try {
			const result = await this.webClient.chat.postMessage({ channel, text: truncated });
			return result.ts as string;
		} catch (err) {
			const errData = (err as { data?: unknown }).data;
			log.logWarning(
				`[slack] postMessage FAILED (${truncated.length} chars)`,
				errData ? JSON.stringify(errData).substring(0, 500) : String(err),
			);
			throw err;
		}
	}

	async updateMessage(channel: string, ts: string, text: string): Promise<void> {
		const truncated = truncateForSlack(text);
		log.logInfo(`[slack] updateMessage: ${text.length} chars -> ${truncated.length} chars`);
		try {
			await this.webClient.chat.update({ channel, ts, text: truncated });
		} catch (err) {
			const errData = (err as { data?: unknown }).data;
			log.logWarning(
				`[slack] updateMessage FAILED (${truncated.length} chars)`,
				errData ? JSON.stringify(errData).substring(0, 500) : String(err),
			);
			throw err;
		}
	}

	async deleteMessage(channel: string, ts: string): Promise<void> {
		await this.webClient.chat.delete({ channel, ts });
	}

	async postInThread(channel: string, threadTs: string, text: string): Promise<string> {
		const truncated = truncateForSlack(text);
		log.logInfo(`[slack] postInThread: ${text.length} chars -> ${truncated.length} chars`);
		try {
			const result = await this.webClient.chat.postMessage({ channel, thread_ts: threadTs, text: truncated });
			return result.ts as string;
		} catch (err) {
			const errData = (err as { data?: unknown }).data;
			log.logWarning(
				`[slack] postInThread FAILED (${truncated.length} chars)`,
				errData ? JSON.stringify(errData).substring(0, 500) : String(err),
			);
			throw err;
		}
	}

	async addReaction(channel: string, ts: string, emoji: string): Promise<void> {
		try {
			await this.webClient.reactions.add({ channel, timestamp: ts, name: emoji });
		} catch {
			/* ignore - reaction may already exist */
		}
	}

	async removeReaction(channel: string, ts: string, emoji: string): Promise<void> {
		try {
			await this.webClient.reactions.remove({ channel, timestamp: ts, name: emoji });
		} catch {
			/* ignore - reaction may not exist */
		}
	}

	async uploadFile(channel: string, filePath: string, title?: string, threadTs?: string): Promise<void> {
		const fileName = title || basename(filePath);
		const fileContent = readFileSync(filePath);
		const opts: Record<string, unknown> = {
			channel_id: channel,
			file: fileContent,
			filename: fileName,
			title: fileName,
		};
		if (threadTs) {
			opts.thread_ts = threadTs;
		}
		await this.webClient.files.uploadV2(opts as any);
	}

	/**
	 * Use Haiku to determine if a message is directed at the bot in an ongoing conversation.
	 * Looks at recent conversation context to decide.
	 */
	private async isMessageDirectedAtBot(
		messageText: string,
		userName: string,
		channel: string,
		threadTs?: string,
	): Promise<boolean> {
		// Get recent conversation context from log.jsonl, filtered by thread
		let context = "";
		try {
			const logPath = join(this.workingDir, channel, "log.jsonl");
			if (existsSync(logPath)) {
				const content = readFileSync(logPath, "utf-8");
				const lines = content.trim().split("\n").slice(-30);
				const msgs: string[] = [];
				for (const line of lines) {
					try {
						const entry = JSON.parse(line);
						// Filter by thread context (including parent message whose ts == threadTs)
						const entryThread = entry.thread_ts;
						const entryTs = entry.ts;
						if (threadTs) {
							if (entryThread !== threadTs && entryTs !== threadTs) continue;
						} else {
							if (entryThread) continue;
						}

						const who = entry.isBot ? "Mom(bot)" : entry.userName || entry.user || "unknown";
						const text = (entry.text || "").substring(0, 200);
						msgs.push(`${who}: ${text}`);
					} catch {}
				}
				// Take last 10 relevant messages
				context = msgs.slice(-10).join("\n");
			}
		} catch {
			/* ignore */
		}

		return isMessageForBot(messageText, userName, context, this.getApiKey, this.callHaikuOverride);
	}

	/**
	 * Check if Mom is in an active conversation in this channel/thread.
	 * Looks at log.jsonl to count non-bot messages since Mom's last reply.
	 * Filters by thread_ts to avoid cross-thread interference.
	 * Returns the number of messages since last bot reply, or -1 if not in conversation.
	 */
	private getMessagesSinceLastReply(channel: string, threadTs?: string): number {
		try {
			const logPath = join(this.workingDir, channel, "log.jsonl");
			if (!existsSync(logPath)) return -1;

			const content = readFileSync(logPath, "utf-8");
			const lines = content.trim().split("\n");
			const recentLines = lines.slice(-30);

			// Filter to same conversation context (same thread or top-level)
			// A message belongs to a thread if:
			//   - its thread_ts matches, OR
			//   - its ts equals threadTs (it's the parent message of the thread)
			const relevantEntries: Array<{ isBot: boolean }> = [];
			for (const line of recentLines) {
				try {
					const entry = JSON.parse(line);
					const entryThread = entry.thread_ts;
					const entryTs = entry.ts;
					if (threadTs) {
						// Looking for messages in a specific thread
						if (entryThread === threadTs || entryTs === threadTs) {
							relevantEntries.push(entry);
						}
					} else {
						// Looking for top-level messages only
						if (!entryThread) {
							relevantEntries.push(entry);
						}
					}
				} catch {}
			}

			let messagesSinceBot = 0;
			for (let i = relevantEntries.length - 1; i >= 0; i--) {
				if (relevantEntries[i].isBot) {
					return messagesSinceBot;
				}
				messagesSinceBot++;
			}

			return -1; // No bot message found in this context
		} catch {
			return -1;
		}
	}

	/**
	 * Log a message to log.jsonl (SYNC)
	 * This is the ONLY place messages are written to log.jsonl
	 */
	logToFile(channel: string, entry: object): void {
		const dir = join(this.workingDir, channel);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	/**
	 * Log a bot response to log.jsonl
	 */
	logBotResponse(channel: string, text: string, ts: string, threadTs?: string): void {
		this.logToFile(channel, {
			date: new Date().toISOString(),
			ts,
			thread_ts: threadTs,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	// ==========================================================================
	// Events Integration
	// ==========================================================================

	/**
	 * Enqueue an event for processing. Always queues (no "already working" rejection).
	 * Returns true if enqueued, false if queue is full (max 5).
	 */
	enqueueEvent(event: SlackEvent): boolean {
		const queue = this.getQueue(event.channel);
		if (queue.size() >= 5) {
			log.logWarning(`Event queue full for ${event.channel}, discarding: ${event.text.substring(0, 50)}`);
			return false;
		}
		log.logInfo(`Enqueueing event for ${event.channel}: ${event.text.substring(0, 50)}`);
		queue.enqueue(() => this.handler.handleEvent(event, this, true));
		return true;
	}

	// ==========================================================================
	// Private - Event Handlers
	// ==========================================================================

	private getQueue(channelId: string): ChannelQueue {
		let queue = this.queues.get(channelId);
		if (!queue) {
			queue = new ChannelQueue();
			this.queues.set(channelId, queue);
		}
		return queue;
	}

	private setupEventHandlers(): void {
		// Channel @mentions
		this.socketClient.on("app_mention", ({ event, ack }) => {
			const e = event as {
				text: string;
				channel: string;
				user: string;
				ts: string;
				thread_ts?: string;
				files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
			};

			// Skip DMs (handled by message event)
			if (e.channel.startsWith("D")) {
				ack();
				return;
			}

			const slackEvent: SlackEvent = {
				type: "mention",
				channel: e.channel,
				ts: e.ts,
				thread_ts: e.thread_ts,
				user: e.user,
				text: e.text.replace(/<@[A-Z0-9]+>/gi, "").trim(),
				files: e.files,
			};

			// SYNC: Log to log.jsonl (ALWAYS, even for old messages)
			// Also downloads attachments in background and stores local paths
			slackEvent.attachments = this.logUserMessage(slackEvent);

			// Only trigger processing for messages AFTER startup (not replayed old messages)
			if (this.startupTs && e.ts < this.startupTs) {
				log.logInfo(
					`[${e.channel}] Logged old message (pre-startup), not triggering: ${slackEvent.text.substring(0, 30)}`,
				);
				ack();
				return;
			}

			// Check for stop command - execute immediately, don't queue!
			if (slackEvent.text.toLowerCase().trim() === "stop") {
				if (this.handler.isRunning(e.channel)) {
					this.handler.handleStop(e.channel, this); // Don't await, don't queue
				} else {
					this.postMessage(e.channel, "_Nothing running_");
				}
				ack();
				return;
			}

			// Enqueue (ChannelQueue handles sequential processing)
			const queued = this.handler.isRunning(e.channel);
			if (queued) this.addReaction(e.channel, e.ts, "hourglass_flowing_sand");
			this.getQueue(e.channel).enqueue(async () => {
				if (queued) this.removeReaction(e.channel, e.ts, "hourglass_flowing_sand");
				await this.handler.handleEvent(slackEvent, this);
			});

			ack();
		});

		// Reaction events - emoji on mom's messages can trigger actions
		this.socketClient.on("reaction_added", ({ event, ack }) => {
			const e = event as {
				type: string;
				user: string;
				reaction: string;
				item: { type: string; channel: string; ts: string };
				item_user?: string;
			};

			ack();

			// Only care about reactions on messages
			if (e.item.type !== "message") return;

			// Only care about reactions on mom's messages
			if (e.item_user !== this.botUserId) return;

			// Skip if before startup
			if (this.startupTs && e.item.ts < this.startupTs) return;

			// Skip if already busy
			if (this.handler.isRunning(e.item.channel)) return;

			// Handle async
			this.handleReaction(e.user, e.reaction, e.item.channel, e.item.ts).catch((err) => {
				log.logWarning("Reaction handler error", err instanceof Error ? err.message : String(err));
			});
		});

		// All messages (for logging) + DMs (for triggering)
		this.socketClient.on("message", async ({ event, ack }) => {
			const e = event as {
				text?: string;
				channel: string;
				user?: string;
				ts: string;
				thread_ts?: string;
				channel_type?: string;
				subtype?: string;
				bot_id?: string;
				files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
			};

			// Skip bot messages, edits, etc.
			if (e.bot_id || !e.user || e.user === this.botUserId) {
				ack();
				return;
			}
			if (e.subtype !== undefined && e.subtype !== "file_share") {
				ack();
				return;
			}
			if (!e.text && (!e.files || e.files.length === 0)) {
				ack();
				return;
			}

			const isDM = e.channel_type === "im";
			const isBotMention = e.text?.includes(`<@${this.botUserId}>`);

			// Skip channel @mentions - already handled by app_mention event
			if (!isDM && isBotMention) {
				ack();
				return;
			}

			const slackEvent: SlackEvent = {
				type: isDM ? "dm" : "mention",
				channel: e.channel,
				ts: e.ts,
				thread_ts: e.thread_ts,
				user: e.user,
				text: (e.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim(),
				files: e.files,
			};

			// SYNC: Log to log.jsonl (ALL messages - channel chatter and DMs)
			// Also downloads attachments in background and stores local paths
			slackEvent.attachments = this.logUserMessage(slackEvent);

			// Ack immediately - Slack expects ack within 3 seconds
			ack();

			// Only trigger processing for messages AFTER startup (not replayed old messages)
			if (this.startupTs && e.ts < this.startupTs) {
				log.logInfo(`[${e.channel}] Skipping old message (pre-startup): ${slackEvent.text.substring(0, 30)}`);
				return;
			}

			// Check for stop command - execute immediately, don't queue!
			if (isDM) {
				if (slackEvent.text.toLowerCase().trim() === "stop") {
					if (this.handler.isRunning(e.channel)) {
						this.handler.handleStop(e.channel, this);
					} else {
						this.postMessage(e.channel, "_Nothing running_");
					}
					return;
				}
			}

			// Determine if we should handle this message
			let shouldHandle = isDM;

			if (!isDM && !isBotMention) {
				const msgGap = this.getMessagesSinceLastReply(e.channel, e.thread_ts);
				if (msgGap >= 0 && msgGap <= SlackBot.CONVERSATION_MAX_GAP) {
					// Mom recently participated in this thread/channel. Ask Haiku if this message is directed at Mom.
					const userName = this.users.get(e.user)?.userName || e.user;
					const directed = await this.isMessageDirectedAtBot(e.text || "", userName, e.channel, e.thread_ts);
					if (directed) {
						shouldHandle = true;
						log.logInfo(
							`[${e.channel}] Implicit conversation with ${userName} (${msgGap} msgs since last reply, Haiku: directed)`,
						);
					} else {
						log.logInfo(`[${e.channel}] Skipping implicit - Haiku says not directed (${msgGap} msgs gap)`);
					}
				}
			}

			if (shouldHandle) {
				const queued = this.handler.isRunning(e.channel);
				if (queued) this.addReaction(e.channel, e.ts, "hourglass_flowing_sand");
				this.getQueue(e.channel).enqueue(async () => {
					if (queued) this.removeReaction(e.channel, e.ts, "hourglass_flowing_sand");
					await this.handler.handleEvent(slackEvent, this);
				});
			}
		});
	}

	/**
	 * Log a user message to log.jsonl (SYNC)
	 * Downloads attachments in background via store
	 */
	private logUserMessage(event: SlackEvent): Attachment[] {
		const user = this.users.get(event.user);
		// Process attachments - queues downloads in background
		const attachments = event.files ? this.store.processAttachments(event.channel, event.files, event.ts) : [];
		this.logToFile(event.channel, {
			date: new Date(parseFloat(event.ts) * 1000).toISOString(),
			ts: event.ts,
			thread_ts: event.thread_ts,
			user: event.user,
			userName: user?.userName,
			displayName: user?.displayName,
			text: event.text,
			attachments,
			isBot: false,
		});
		return attachments;
	}

	// ==========================================================================
	// Private - Backfill
	// ==========================================================================

	private getExistingTimestamps(channelId: string): Set<string> {
		const logPath = join(this.workingDir, channelId, "log.jsonl");
		const timestamps = new Set<string>();
		if (!existsSync(logPath)) return timestamps;

		const content = readFileSync(logPath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.ts) timestamps.add(entry.ts);
			} catch {}
		}
		return timestamps;
	}

	private async backfillChannel(channelId: string): Promise<number> {
		const existingTs = this.getExistingTimestamps(channelId);

		// Find the biggest ts in log.jsonl
		let latestTs: string | undefined;
		for (const ts of existingTs) {
			if (!latestTs || parseFloat(ts) > parseFloat(latestTs)) latestTs = ts;
		}

		type Message = {
			user?: string;
			bot_id?: string;
			text?: string;
			ts?: string;
			subtype?: string;
			files?: Array<{ name: string }>;
		};
		const allMessages: Message[] = [];

		let cursor: string | undefined;
		let pageCount = 0;
		const maxPages = 3;

		do {
			const result = await this.webClient.conversations.history({
				channel: channelId,
				oldest: latestTs, // Only fetch messages newer than what we have
				inclusive: false,
				limit: 1000,
				cursor,
			});
			if (result.messages) {
				allMessages.push(...(result.messages as Message[]));
			}
			cursor = result.response_metadata?.next_cursor;
			pageCount++;
		} while (cursor && pageCount < maxPages);

		// Filter: include mom's messages, exclude other bots, skip already logged
		const relevantMessages = allMessages.filter((msg) => {
			if (!msg.ts || existingTs.has(msg.ts)) return false; // Skip duplicates
			if (msg.user === this.botUserId) return true;
			if (msg.bot_id) return false;
			if (msg.subtype !== undefined && msg.subtype !== "file_share") return false;
			if (!msg.user) return false;
			if (!msg.text && (!msg.files || msg.files.length === 0)) return false;
			return true;
		});

		// Reverse to chronological order
		relevantMessages.reverse();

		// Log each message to log.jsonl
		for (const msg of relevantMessages) {
			const isMomMessage = msg.user === this.botUserId;
			const user = this.users.get(msg.user!);
			// Strip @mentions from text (same as live messages)
			const text = (msg.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim();
			// Process attachments - queues downloads in background
			const attachments = msg.files ? this.store.processAttachments(channelId, msg.files, msg.ts!) : [];

			this.logToFile(channelId, {
				date: new Date(parseFloat(msg.ts!) * 1000).toISOString(),
				ts: msg.ts!,
				user: isMomMessage ? "bot" : msg.user!,
				userName: isMomMessage ? undefined : user?.userName,
				displayName: isMomMessage ? undefined : user?.displayName,
				text,
				attachments,
				isBot: isMomMessage,
			});
		}

		return relevantMessages.length;
	}

	private async backfillAllChannels(): Promise<void> {
		const startTime = Date.now();

		// Only backfill channels that already have a log.jsonl (mom has interacted with them before)
		const channelsToBackfill: Array<[string, SlackChannel]> = [];
		for (const [channelId, channel] of this.channels) {
			const logPath = join(this.workingDir, channelId, "log.jsonl");
			if (existsSync(logPath)) {
				channelsToBackfill.push([channelId, channel]);
			}
		}

		log.logBackfillStart(channelsToBackfill.length);

		let totalMessages = 0;
		for (const [channelId, channel] of channelsToBackfill) {
			try {
				const count = await this.backfillChannel(channelId);
				if (count > 0) log.logBackfillChannel(channel.name, count);
				totalMessages += count;
			} catch (error) {
				log.logWarning(`Failed to backfill #${channel.name}`, String(error));
			}
		}

		const durationMs = Date.now() - startTime;
		log.logBackfillComplete(totalMessages, durationMs);
	}

	// ==========================================================================
	// Private - Fetch Users/Channels
	// ==========================================================================

	private async fetchUsers(): Promise<void> {
		let cursor: string | undefined;
		do {
			const result = await this.webClient.users.list({ limit: 200, cursor });
			const members = result.members as
				| Array<{ id?: string; name?: string; real_name?: string; deleted?: boolean }>
				| undefined;
			if (members) {
				for (const u of members) {
					if (u.id && u.name && !u.deleted) {
						this.users.set(u.id, { id: u.id, userName: u.name, displayName: u.real_name || u.name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);
	}

	private async fetchChannels(): Promise<void> {
		// Fetch public/private channels
		let cursor: string | undefined;
		do {
			const result = await this.webClient.conversations.list({
				types: "public_channel,private_channel",
				exclude_archived: true,
				limit: 200,
				cursor,
			});
			const channels = result.channels as Array<{ id?: string; name?: string; is_member?: boolean }> | undefined;
			if (channels) {
				for (const c of channels) {
					if (c.id && c.name && c.is_member) {
						this.channels.set(c.id, { id: c.id, name: c.name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);

		// Also fetch DM channels (IMs)
		cursor = undefined;
		do {
			const result = await this.webClient.conversations.list({
				types: "im",
				limit: 200,
				cursor,
			});
			const ims = result.channels as Array<{ id?: string; user?: string }> | undefined;
			if (ims) {
				for (const im of ims) {
					if (im.id) {
						// Use user's name as channel name for DMs
						const user = im.user ? this.users.get(im.user) : undefined;
						const name = user ? `DM:${user.userName}` : `DM:${im.id}`;
						this.channels.set(im.id, { id: im.id, name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);
	}

	/**
	 * Handle a reaction on mom's message.
	 * Finds the original requester from the thread, verifies the reactor is that person,
	 * then uses a lightweight LLM to classify the emoji intent.
	 */
	private async handleReaction(
		reactorUserId: string,
		emoji: string,
		channel: string,
		messageTs: string,
	): Promise<void> {
		// Find the requester: the last non-bot user who spoke BEFORE the reacted message.
		// Strategy:
		// 1. Try thread context (conversations.replies with thread parent) - for in-thread conversations
		// 2. Fall back to channel history (conversations.history) - for top-level messages
		let requesterId: string | null = null;

		// Helper: find last human user before messageTs in a list of messages
		const findRequester = (messages: Array<{ user?: string; bot_id?: string; ts: string }>): string | null => {
			for (let i = messages.length - 1; i >= 0; i--) {
				const msg = messages[i];
				if (msg.ts >= messageTs) continue;
				if (msg.user && msg.user !== this.botUserId && !msg.bot_id) {
					return msg.user;
				}
			}
			return null;
		};

		// Find the thread parent ts from log.jsonl (the reacted message may be inside a thread)
		let threadParentTs: string | undefined;
		try {
			const logPath = join(this.workingDir, channel, "log.jsonl");
			if (existsSync(logPath)) {
				const content = readFileSync(logPath, "utf-8");
				const lines = content.trim().split("\n").slice(-50);
				for (const line of lines) {
					try {
						const entry = JSON.parse(line);
						if (entry.ts === messageTs && entry.thread_ts) {
							threadParentTs = entry.thread_ts;
							break;
						}
					} catch {}
				}
			}
		} catch {
			/* ignore */
		}

		try {
			// 1. Try thread replies first (use thread parent ts, not the message ts itself)
			const threadTs = threadParentTs || messageTs;
			const threadResult = await this.webClient.conversations.replies({
				channel,
				ts: threadTs,
				limit: 100,
			});
			const threadMessages = threadResult.messages as
				| Array<{ user?: string; bot_id?: string; ts: string }>
				| undefined;
			if (threadMessages) {
				requesterId = findRequester(threadMessages);
			}
		} catch {
			// conversations.replies may fail if messageTs is not a thread parent
		}

		if (!requesterId) {
			try {
				// 2. Fall back to channel history - look for messages before the reacted one
				const historyResult = await this.webClient.conversations.history({
					channel,
					latest: messageTs,
					limit: 10,
					inclusive: false,
				});
				const historyMessages = historyResult.messages as
					| Array<{ user?: string; bot_id?: string; ts: string }>
					| undefined;
				if (historyMessages) {
					// history returns newest first, so first non-bot message is the closest one before messageTs
					for (const msg of historyMessages) {
						if (msg.user && msg.user !== this.botUserId && !msg.bot_id) {
							requesterId = msg.user;
							break;
						}
					}
				}
			} catch {
				// Can't determine requester
			}
		}

		if (!requesterId) {
			log.logInfo(`[${channel}] Reaction :${emoji}: could not determine requester, ignoring`);
			return;
		}

		// Only the requester can approve via reaction
		if (requesterId !== reactorUserId) {
			log.logInfo(`[${channel}] Reaction :${emoji}: from non-requester, ignoring`);
			return;
		}

		// Interpret the emoji reaction using a lightweight LLM
		const interpretation = await interpretReaction(emoji, this.getApiKey, this.callHaikuOverride);
		log.logInfo(`[${channel}] Reaction :${emoji}: interpreted as "${interpretation}"`);

		if (interpretation === "ignore") return;

		const intentText = `[이모지 :${emoji}: 리액션] ${interpretation}`;

		const user = this.users.get(reactorUserId);
		log.logInfo(`[${channel}] Reaction trigger :${emoji}: from ${user?.userName || reactorUserId} → "${intentText}"`);

		const slackEvent: SlackEvent = {
			type: "mention",
			channel,
			ts: messageTs,
			thread_ts: messageTs,
			user: reactorUserId,
			text: intentText,
		};

		this.logUserMessage(slackEvent);
		this.getQueue(channel).enqueue(() => this.handler.handleEvent(slackEvent, this));
	}
}

/**
 * Interpret a Slack emoji reaction using a lightweight LLM (Claude Haiku).
 * Returns a natural language interpretation of the emoji's intent,
 * or "ignore" if the emoji is not meaningful enough to act on.
 */
/**
 * Call Claude Haiku for lightweight classification tasks.
 * Returns the response text, or fallback on error.
 */
async function callHaiku(prompt: string, fallback: string, getApiKey?: () => Promise<string>): Promise<string> {
	let apiKey = process.env.ANTHROPIC_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
	if (!apiKey && getApiKey) {
		try {
			apiKey = await getApiKey();
		} catch {
			// Failed to get API key
		}
	}
	if (!apiKey) {
		log.logWarning("No Anthropic API key available for Haiku call");
		return fallback;
	}

	try {
		const isOAuth = apiKey.includes("sk-ant-oat");
		const headers: Record<string, string> = {
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
		};
		if (isOAuth) {
			headers["authorization"] = `Bearer ${apiKey}`;
			headers["anthropic-beta"] = "claude-code-20250219,oauth-2025-04-20";
			headers["anthropic-dangerous-direct-browser-access"] = "true";
			headers["user-agent"] = "claude-cli/2.1.2 (external, cli)";
			headers["x-app"] = "cli";
		} else {
			headers["x-api-key"] = apiKey;
		}

		const response = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: "claude-haiku-4-5",
				max_tokens: 100,
				messages: [{ role: "user", content: prompt }],
			}),
		});

		if (!response.ok) {
			const errorBody = await response.text().catch(() => "");
			log.logWarning(
				`Haiku API error: ${response.status} (auth: ${isOAuth ? "oauth" : "api-key"})`,
				errorBody.substring(0, 200),
			);
			return fallback;
		}

		const data = (await response.json()) as { content: Array<{ type: string; text: string }> };
		return data.content?.[0]?.text?.trim() || fallback;
	} catch (err) {
		log.logWarning("Haiku call error", err instanceof Error ? err.message : String(err));
		return fallback;
	}
}

/**
 * Interpret a Slack emoji reaction using Haiku.
 */
async function interpretReaction(
	emoji: string,
	getApiKey?: () => Promise<string>,
	callHaikuOverride?: (prompt: string, fallback: string) => Promise<string>,
): Promise<string> {
	const prompt = `A user reacted to an AI assistant's Slack message with the emoji :${emoji}:

Interpret what the user likely means by this reaction. Consider possibilities like:
- Approval/agreement (go ahead, yes, proceed)
- Disapproval/rejection (no, stop, don't do that)
- Curiosity or questioning (what does this mean?)
- Humor or amusement (that's funny)
- Amazement or excitement (wow, brilliant idea)
- Gratitude (thanks)
- Other emotions or intentions

Reply with a SHORT phrase describing the user's intent (e.g. "승인", "거절", "재미있다는 반응", "감탄", "궁금해하는 반응").
If the emoji is too ambiguous or meaningless to interpret, reply with exactly "ignore".`;

	const haikuFn = callHaikuOverride || ((p: string, f: string) => callHaiku(p, f, getApiKey));
	const result = await haikuFn(prompt, "ignore");
	return result.toLowerCase() === "ignore" ? "ignore" : result;
}

/**
 * Determine if a channel message (without @mention) is directed at the bot,
 * given recent conversation context.
 */
async function isMessageForBot(
	messageText: string,
	userName: string,
	recentContext: string,
	getApiKey?: () => Promise<string>,
	callHaikuOverride?: (prompt: string, fallback: string) => Promise<string>,
): Promise<boolean> {
	const prompt = `You are "나노캐럿(Mom)", an AI assistant in a Slack channel. You recently participated in a conversation.

Recent conversation:
${recentContext}

New message from ${userName}: "${messageText}"

Is this new message directed at you (the AI assistant)? Consider:
- If your last message invited a response (e.g. "물어보세요", "알려주세요", "해볼까요?", "도와드릴까요?"), the next message from the same user is almost certainly directed at you.
- Is the user continuing a conversation with you?
- Is the user asking you to do something, requesting information, or responding to something you said?
- Does the message contain a command, question, or request that an AI assistant would handle (e.g. DB queries, file operations, code changes, content generation)?
- Or is this clearly general chatter between humans that has nothing to do with you?

When in doubt, answer "yes". Reply with exactly "yes" or "no".`;

	const haikuFn = callHaikuOverride || ((p: string, f: string) => callHaiku(p, f, getApiKey));
	const result = await haikuFn(prompt, "no");
	return result.toLowerCase().startsWith("yes");
}
