#!/usr/bin/env node

import { existsSync, readFileSync, renameSync } from "fs";
import { join, resolve } from "path";
import { type AgentRunner, callBedrockHaiku, evictRunner, getAnthropicKey, getOrCreateRunner } from "./agent.js";
import { SLACK_MAX_TEXT, SLACK_UPDATE_MAX_BYTES } from "./constants.js";
import { downloadChannel } from "./download.js";
import { createEventsWatcher } from "./events.js";
import * as log from "./log.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import { type MomHandler, type SlackBot, SlackBot as SlackBotClass, type SlackEvent } from "./slack.js";
import { ChannelStore } from "./store.js";

// ============================================================================
// Config
// ============================================================================

// Map .mom-env variable names to the names expected by pi-ai / sandbox
// (only set if the target env var is not already set)
const envAliases: [string, string][] = [
	["FAL_TOKEN", "FAL_KEY"],
	["CARAT_TOKEN", "CARAT_AGENT_TOKEN"],
	["OPENROUTER_TOKEN", "OPENROUTER_API_KEY"],
];
for (const [src, dst] of envAliases) {
	if (process.env[src] && !process.env[dst]) {
		process.env[dst] = process.env[src];
	}
}

const MOM_SLACK_APP_TOKEN = process.env.MOM_SLACK_APP_TOKEN;
const MOM_SLACK_BOT_TOKEN = process.env.MOM_SLACK_BOT_TOKEN;

interface ParsedArgs {
	workingDir?: string;
	sandbox: SandboxConfig;
	downloadChannel?: string;
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;
	let downloadChannelId: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--sandbox=")) {
			sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
		} else if (arg === "--sandbox") {
			sandbox = parseSandboxArg(args[++i] || "");
		} else if (arg.startsWith("--download=")) {
			downloadChannelId = arg.slice("--download=".length);
		} else if (arg === "--download") {
			downloadChannelId = args[++i];
		} else if (!arg.startsWith("-")) {
			workingDir = arg;
		}
	}

	return {
		workingDir: workingDir ? resolve(workingDir) : undefined,
		sandbox,
		downloadChannel: downloadChannelId,
	};
}

const parsedArgs = parseArgs();

// Handle --download mode
if (parsedArgs.downloadChannel) {
	if (!MOM_SLACK_BOT_TOKEN) {
		console.error("Missing env: MOM_SLACK_BOT_TOKEN");
		process.exit(1);
	}
	await downloadChannel(parsedArgs.downloadChannel, MOM_SLACK_BOT_TOKEN);
	process.exit(0);
}

// Normal bot mode - require working dir
if (!parsedArgs.workingDir) {
	console.error("Usage: mom [--sandbox=host|docker:<name>] <working-directory>");
	console.error("       mom --download <channel-id>");
	process.exit(1);
}

const { workingDir, sandbox } = { workingDir: parsedArgs.workingDir, sandbox: parsedArgs.sandbox };

if (!MOM_SLACK_APP_TOKEN || !MOM_SLACK_BOT_TOKEN) {
	console.error("Missing env: MOM_SLACK_APP_TOKEN, MOM_SLACK_BOT_TOKEN");
	process.exit(1);
}

await validateSandbox(sandbox);

// ============================================================================
// State (per thread)
// ============================================================================

interface ThreadState {
	running: boolean;
	runner: AgentRunner;
	store: ChannelStore;
	stopRequested: boolean;
	stopMessageTs?: string;
}

/** Key format: "channelId:threadTs" */
function threadKey(channelId: string, threadTs: string): string {
	return `${channelId}:${threadTs}`;
}

const threadStates = new Map<string, ThreadState>();

/**
 * Resolve thread context file mismatch for bot-initiated threads.
 *
 * When the event system creates a synthetic event, it uses ts=Date.now() (epoch ms).
 * The bot posts a top-level message and Slack assigns a real ts (e.g., "1772499600.430449").
 * When a user replies in that thread, Slack sends thread_ts = the bot message's real ts.
 * But the context file was saved with the synthetic ts as the key.
 *
 * This function detects the mismatch and renames the context file so the thread
 * context is properly loaded.
 */
interface ResolveResult {
	threadTs: string;
	/** If a context file was renamed, this is the original synthetic ts it was renamed from */
	renamedFrom?: string;
}

function resolveThreadTs(channelId: string, threadTs: string): ResolveResult {
	const channelDir = join(workingDir, channelId);
	const contextFile = join(channelDir, `context-${threadTs}.jsonl`);

	// If context file already exists for this threadTs, no mismatch
	if (existsSync(contextFile)) return { threadTs };

	// Check if this threadTs corresponds to a bot message that was posted from a synthetic event.
	// In log.jsonl, such messages have ts=<real slack ts> and thread_ts=<synthetic ts>.
	const logFile = join(channelDir, "log.jsonl");
	if (!existsSync(logFile)) return { threadTs };

	try {
		const lines = readFileSync(logFile, "utf-8").trim().split("\n");
		// Search from the end for efficiency (recent messages first)
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i];
			if (!line) continue;
			try {
				const entry = JSON.parse(line);
				// Find a bot message whose Slack ts matches our threadTs
				// and whose thread_ts is different (the synthetic ts)
				if (entry.user === "bot" && entry.ts === threadTs && entry.thread_ts && entry.thread_ts !== threadTs) {
					const originalTs = entry.thread_ts;
					const originalContextFile = join(channelDir, `context-${originalTs}.jsonl`);
					if (existsSync(originalContextFile)) {
						// Rename context file to use the real Slack ts
						renameSync(originalContextFile, contextFile);
						log.logInfo(
							`[${channelId}] Resolved thread context: renamed context-${originalTs}.jsonl -> context-${threadTs}.jsonl`,
						);
						return { threadTs, renamedFrom: originalTs };
					}
				}
			} catch {
				// Skip malformed lines
			}
		}
	} catch (err) {
		log.logWarning(`[${channelId}] Error resolving thread ts`, String(err));
	}

	return { threadTs };
}

function getState(channelId: string, threadTs: string): ThreadState {
	const key = threadKey(channelId, threadTs);
	let state = threadStates.get(key);
	if (!state) {
		const channelDir = join(workingDir, channelId);
		state = {
			running: false,
			runner: getOrCreateRunner(sandbox, channelId, channelDir, threadTs),
			store: new ChannelStore({ workingDir, botToken: MOM_SLACK_BOT_TOKEN! }),
			stopRequested: false,
		};
		threadStates.set(key, state);
	}
	return state;
}

// ============================================================================
// Create SlackContext adapter
// ============================================================================

interface SlackContextOptions {
	/** Called when a synthetic event posts its first message and gets a real Slack ts.
	 *  Allows the caller to re-key thread maps so mid-run replies are properly routed. */
	onThreadKeyResolved?: (syntheticTs: string, realSlackTs: string) => void;
}

function createSlackContext(
	event: SlackEvent,
	slack: SlackBot,
	state: ThreadState,
	isEvent?: boolean,
	options?: SlackContextOptions,
) {
	let messageTs: string | null = null;
	const threadMessageTs: string[] = [];
	let accumulatedText = "";
	let isWorking = true;
	const workingIndicator = " ...";

	/** Get UTF-8 byte length of a string */
	const byteLen = (s: string) => Buffer.byteLength(s, "utf8");

	/** Trim the front of text to fit within Slack chat.update's byte limit (~4000 bytes) */
	const trimFront = (text: string): string => {
		if (byteLen(text) <= SLACK_UPDATE_MAX_BYTES) return text;
		// Binary search for the right slice point that fits within byte limit
		let lo = 0;
		let hi = text.length;
		const target = SLACK_UPDATE_MAX_BYTES - 100; // margin for prefix
		while (lo < hi - 1) {
			const mid = Math.floor((lo + hi) / 2);
			if (byteLen(text.slice(mid)) <= target) {
				hi = mid;
			} else {
				lo = mid;
			}
		}
		const trimmed = text.slice(hi);
		// Try to find the first newline to avoid cutting mid-line
		const firstNewline = trimmed.indexOf("\n");
		const cleanStart = firstNewline > 0 && firstNewline < 200 ? trimmed.slice(firstNewline + 1) : trimmed;
		return `_...(trimmed)_\n${cleanStart}`;
	};
	let updatePromise = Promise.resolve();

	const user = slack.getUser(event.user);

	// Extract event filename for status message
	const eventFilename = isEvent ? event.text.match(/^\[EVENT:([^:]+):/)?.[1] : undefined;

	return {
		message: {
			text: event.text,
			rawText: event.text,
			user: event.user,
			userName: user?.userName,
			channel: event.channel,
			ts: event.ts,
			thread_ts: event.thread_ts,
			attachments: (event.attachments || []).map((a) => ({ local: a.local })),
		},
		channelName: slack.getChannel(event.channel)?.name,
		store: state.store,
		channels: slack.getAllChannels().map((c) => ({ id: c.id, name: c.name })),
		users: slack.getAllUsers().map((u) => ({ id: u.id, userName: u.userName, displayName: u.displayName })),

		respond: async (text: string, shouldLog = true) => {
			let lastError: unknown;
			updatePromise = updatePromise
				.then(async () => {
					accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;
					// trimFront ensures accumulated text fits chat.update byte limit
					accumulatedText = trimFront(accumulatedText);
					const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;

					const threadTs = event.thread_ts || event.ts;
					const isSyntheticEvent = event.user === "EVENT";
					if (messageTs) {
						await slack.updateMessage(event.channel, messageTs, displayText);
					} else if (isSyntheticEvent && !event.thread_ts) {
						messageTs = await slack.postMessage(event.channel, displayText);
						if (messageTs && options?.onThreadKeyResolved) {
							options.onThreadKeyResolved(event.ts, messageTs);
						}
					} else {
						messageTs = await slack.postInThread(event.channel, threadTs, displayText);
					}

					if (shouldLog && messageTs) {
						slack.logBotResponse(event.channel, text, messageTs, threadTs);
					}
				})
				.catch((err) => {
					lastError = err;
				});
			await updatePromise;
			if (lastError) throw lastError;
		},

		replaceMessage: async (text: string) => {
			let lastError: unknown;
			updatePromise = updatePromise
				.then(async () => {
					const threadTs = event.thread_ts || event.ts;
					const isSyntheticEvent = event.user === "EVENT";
					const textBytes = byteLen(text);

					// chat.update has a ~4000 byte limit. If text fits, update in place.
					// If too large, update main msg with trimmed version and post full text in thread.
					if (textBytes <= SLACK_UPDATE_MAX_BYTES) {
						accumulatedText = text;
						const displayText = isWorking ? text + workingIndicator : text;
						if (messageTs) {
							await slack.updateMessage(event.channel, messageTs, displayText);
						} else if (isSyntheticEvent && !event.thread_ts) {
							messageTs = await slack.postMessage(event.channel, displayText);
							if (messageTs && options?.onThreadKeyResolved) {
								options.onThreadKeyResolved(event.ts, messageTs);
							}
						} else {
							messageTs = await slack.postInThread(event.channel, threadTs, displayText);
						}
					} else {
						// Text exceeds chat.update byte limit.
						// replaceMessage is always a "final answer" replacement,
						// so post full text in thread regardless of isWorking state.
						const trimmed = trimFront(text);
						log.logInfo(
							`replaceMessage: text too large for update (${textBytes} bytes), posting full text in thread`,
						);
						try {
							if (messageTs) {
								await slack.updateMessage(
									event.channel,
									messageTs,
									`${trimmed}\n\n_(full response in thread)_`,
								);
							}
						} catch {
							// If even trimmed update fails, that's fine - thread will have the full text
						}

						// Post full text in thread via postMessage (supports ~40000 chars)
						const replyTs = messageTs || threadTs;
						// Split into chunks that fit postMessage limit
						const chunkSize = SLACK_MAX_TEXT;
						for (let i = 0; i < text.length; i += chunkSize) {
							const chunk = text.slice(i, i + chunkSize);
							await slack.postInThread(event.channel, replyTs, chunk);
						}
						accumulatedText = text;
					}
				})
				.catch((err) => {
					lastError = err;
				});
			await updatePromise;
			if (lastError) throw lastError;
		},

		respondInThread: async (text: string, force?: boolean) => {
			let lastError: unknown;
			updatePromise = updatePromise
				.then(async () => {
					if (messageTs) {
						// When already in a thread, skip sub-thread messages unless forced
						if (event.thread_ts && !force) {
							return;
						}
						const threadTs = event.thread_ts || messageTs;
						const ts = await slack.postInThread(event.channel, threadTs, text);
						threadMessageTs.push(ts);
					}
				})
				.catch((err) => {
					lastError = err;
				});
			await updatePromise;
			if (lastError) throw lastError;
		},

		setTyping: async (isTyping: boolean) => {
			if (isTyping && !messageTs) {
				updatePromise = updatePromise
					.then(async () => {
						if (!messageTs) {
							accumulatedText = eventFilename ? `_Starting event: ${eventFilename}_` : "_Thinking_";
							const displayText = accumulatedText + workingIndicator;
							const threadTs = event.thread_ts || event.ts;
							const isSyntheticEvent = event.user === "EVENT";
							if (isSyntheticEvent && !event.thread_ts) {
								messageTs = await slack.postMessage(event.channel, displayText);
								// Notify caller so thread maps can be re-keyed with the real Slack ts
								if (messageTs && options?.onThreadKeyResolved) {
									options.onThreadKeyResolved(event.ts, messageTs);
								}
							} else {
								messageTs = await slack.postInThread(event.channel, threadTs, displayText);
							}
						}
					})
					.catch((err) => {
						log.logWarning("setTyping error", String(err));
					});
				await updatePromise;
			}
		},

		uploadFile: async (filePath: string, title?: string) => {
			// Upload in the current thread (or top-level if no thread)
			const threadTs = event.thread_ts || messageTs || undefined;
			await slack.uploadFile(event.channel, filePath, title, threadTs);
		},

		setWorking: async (working: boolean) => {
			updatePromise = updatePromise
				.then(async () => {
					isWorking = working;
					if (messageTs) {
						const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
						await slack.updateMessage(event.channel, messageTs, displayText);
					}
				})
				.catch((err) => {
					log.logWarning("setWorking error", String(err));
				});
			await updatePromise;
		},

		deleteMessage: async () => {
			let lastError: unknown;
			updatePromise = updatePromise
				.then(async () => {
					// Delete thread messages first (in reverse order)
					for (let i = threadMessageTs.length - 1; i >= 0; i--) {
						try {
							await slack.deleteMessage(event.channel, threadMessageTs[i]);
						} catch {
							// Ignore errors deleting thread messages
						}
					}
					threadMessageTs.length = 0;
					// Then delete main message
					if (messageTs) {
						await slack.deleteMessage(event.channel, messageTs);
						messageTs = null;
					}
				})
				.catch((err) => {
					lastError = err;
				});
			await updatePromise;
			if (lastError) throw lastError;
		},

		postToChannel: async (channelId: string, text: string, threadTs?: string) => {
			if (threadTs) {
				return await slack.postInThread(channelId, threadTs, text);
			}
			return await slack.postMessage(channelId, text);
		},
	};
}

// ============================================================================
// Handler
// ============================================================================

const handler: MomHandler = {
	isRunning(channelId: string, threadTs?: string): boolean {
		if (threadTs) {
			const state = threadStates.get(threadKey(channelId, threadTs));
			return state?.running ?? false;
		}
		// If no threadTs, check if ANY thread in this channel is running (for DMs without threads)
		for (const [key, state] of threadStates) {
			if (key.startsWith(`${channelId}:`) && state.running) return true;
		}
		return false;
	},

	async handleStop(channelId: string, slack: SlackBot, threadTs?: string): Promise<void> {
		if (threadTs) {
			const state = threadStates.get(threadKey(channelId, threadTs));
			if (state?.running) {
				state.stopRequested = true;
				state.runner.abort();
				const ts = await slack.postInThread(channelId, threadTs, "_Stopping..._");
				state.stopMessageTs = ts;
			} else {
				await slack.postInThread(channelId, threadTs, "_Nothing running in this thread_");
			}
		} else {
			// No threadTs: stop all running threads in this channel
			let stopped = false;
			for (const [key, state] of threadStates) {
				if (key.startsWith(`${channelId}:`) && state.running) {
					state.stopRequested = true;
					state.runner.abort();
					stopped = true;
				}
			}
			if (stopped) {
				const ts = await slack.postMessage(channelId, "_Stopping..._");
				// Store on first running state found for update later
				for (const [key, state] of threadStates) {
					if (key.startsWith(`${channelId}:`) && state.stopRequested) {
						state.stopMessageTs = ts;
						break;
					}
				}
			} else {
				await slack.postMessage(channelId, "_Nothing running_");
			}
		}
	},

	steerMessage(channelId: string, threadTs: string, userName: string, text: string): void {
		const state = threadStates.get(threadKey(channelId, threadTs));
		if (state?.running) {
			state.runner.steer({ userName, text });
		}
	},

	async handleEvent(event: SlackEvent, slack: SlackBot, isEvent?: boolean): Promise<void> {
		// Determine thread context
		let eventThreadTs = event.thread_ts || event.ts;

		// For user replies in bot-initiated threads (from events), resolve context file mismatch.
		// If the context file was renamed (synthetic ts -> real Slack ts), we must also evict
		// any cached runner/state that was re-keyed by onThreadKeyResolved during the original
		// event run, since that runner's SessionManager still points to the old filename.
		if (event.thread_ts && !isEvent) {
			const resolved = resolveThreadTs(event.channel, eventThreadTs);
			eventThreadTs = resolved.threadTs;
			if (resolved.renamedFrom) {
				// The old runner (created with synthetic ts) was re-keyed to eventThreadTs
				// by onThreadKeyResolved. Its SessionManager still writes to context-{syntheticTs}.jsonl
				// which no longer exists. Evict it so getState creates a fresh runner.
				const staleKey = threadKey(event.channel, eventThreadTs);
				threadStates.delete(staleKey);
				// Also evict from the runner cache (keyed by original synthetic ts)
				evictRunner(event.channel, resolved.renamedFrom);
			}
		}

		const state = getState(event.channel, eventThreadTs);

		// Start run
		state.running = true;
		state.stopRequested = false;

		log.logInfo(`[${event.channel}:${eventThreadTs}] Starting run: ${event.text.substring(0, 50)}`);

		try {
			// Create context adapter with thread key resolution for synthetic events.
			// When a synthetic event posts its first message, Slack assigns a real ts.
			// We re-key the threadStates map so mid-run replies (steer) are properly routed.
			const ctx = createSlackContext(event, slack, state, isEvent, {
				onThreadKeyResolved: (syntheticTs: string, realSlackTs: string) => {
					// Re-key threadStates so mid-run steer/stop works with real Slack thread_ts
					const oldKey = threadKey(event.channel, syntheticTs);
					const newKey = threadKey(event.channel, realSlackTs);
					const existingState = threadStates.get(oldKey);
					if (existingState) {
						threadStates.set(newKey, existingState);
						threadStates.delete(oldKey);
						log.logInfo(`[${event.channel}] Re-keyed thread state: ${syntheticTs} -> ${realSlackTs}`);
					}
					// Note: The SessionManager continues writing to context-{syntheticTs}.jsonl
					// during this run. resolveThreadTs() will rename it when a user replies later.
				},
			});

			// Run the agent
			await ctx.setTyping(true);
			await ctx.setWorking(true);
			const result = await state.runner.run(ctx as any, state.store);
			await ctx.setWorking(false);

			if (result.stopReason === "aborted" && state.stopRequested) {
				if (state.stopMessageTs) {
					await slack.updateMessage(event.channel, state.stopMessageTs, "_Stopped_");
					state.stopMessageTs = undefined;
				} else {
					await slack.postInThread(event.channel, eventThreadTs, "_Stopped_");
				}
			}
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			const errStack = err instanceof Error ? err.stack : undefined;
			log.logWarning(`[${event.channel}:${eventThreadTs}] Run error: ${errMsg}`);
			if (errStack) log.logWarning(`[${event.channel}:${eventThreadTs}] Stack: ${errStack}`);
			try {
				await slack.postInThread(event.channel, event.ts, `_Sorry, something went wrong: ${errMsg}_`);
			} catch {
				// Last resort - at least it's in the logs
			}
		} finally {
			state.running = false;
		}
	},
};

// ============================================================================
// Start
// ============================================================================

log.logStartup(workingDir, sandbox.type === "host" ? "host" : `docker:${sandbox.container}`);

// Shared store for attachment downloads (also used per-channel in getState)
const sharedStore = new ChannelStore({ workingDir, botToken: MOM_SLACK_BOT_TOKEN! });

const bot = new SlackBotClass(handler, {
	appToken: MOM_SLACK_APP_TOKEN,
	botToken: MOM_SLACK_BOT_TOKEN,
	workingDir,
	store: sharedStore,
	getApiKey: getAnthropicKey,
	callHaiku: callBedrockHaiku,
});

// Start events watcher
const eventsWatcher = createEventsWatcher(workingDir, bot);
eventsWatcher.start();

// Handle shutdown
process.on("SIGINT", () => {
	log.logInfo("Shutting down...");
	eventsWatcher.stop();
	process.exit(0);
});

process.on("SIGTERM", () => {
	log.logInfo("Shutting down...");
	eventsWatcher.stop();
	process.exit(0);
});

bot.start();
