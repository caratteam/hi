#!/usr/bin/env node

import { join, resolve } from "path";
import { type AgentRunner, callBedrockHaiku, getAnthropicKey, getOrCreateRunner } from "./agent.js";
import { SLACK_MAX_TEXT, SLACK_MSG_TOO_LONG_FALLBACKS } from "./constants.js";
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

function createSlackContext(event: SlackEvent, slack: SlackBot, state: ThreadState, isEvent?: boolean) {
	let messageTs: string | null = null;
	const threadMessageTs: string[] = [];
	let accumulatedText = "";
	let isWorking = true;
	const workingIndicator = " ...";

	/** Trim the front of text to fit within Slack's message limit, keeping the latest content visible */
	const trimFront = (text: string): string => {
		if (text.length <= SLACK_MAX_TEXT) return text;
		const trimmed = text.slice(text.length - SLACK_MAX_TEXT + 50);
		// Try to find the first newline to avoid cutting mid-line
		const firstNewline = trimmed.indexOf("\n");
		const cleanStart = firstNewline > 0 && firstNewline < 200 ? trimmed.slice(firstNewline + 1) : trimmed;
		return `_... (earlier content trimmed)_\n${cleanStart}`;
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
					accumulatedText = trimFront(accumulatedText);
					let displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;

					const threadTs = event.thread_ts || event.ts;
					const isSyntheticEvent = event.user === "EVENT";
					const tryUpdate = async (txt: string) => {
						if (messageTs) {
							await slack.updateMessage(event.channel, messageTs, txt);
						} else if (isSyntheticEvent && !event.thread_ts) {
							// Synthetic events (periodic/one-shot) have fake ts, post top-level
							messageTs = await slack.postMessage(event.channel, txt);
						} else {
							// Always reply in thread (user's message is the thread parent)
							messageTs = await slack.postInThread(event.channel, threadTs, txt);
						}
					};

					try {
						await tryUpdate(displayText);
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						const errData = (err as { data?: unknown }).data;
						const isTooLong =
							errMsg.includes("msg_too_long") || (errData && JSON.stringify(errData).includes("msg_too_long"));
						if (isTooLong) {
							// Halve the accumulated text and retry
							accumulatedText = trimFront(accumulatedText.slice(Math.floor(accumulatedText.length / 2)));
							displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
							log.logWarning(`respond msg_too_long, retrying with ${displayText.length} chars`);
							await tryUpdate(displayText);
						} else {
							throw err;
						}
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
					accumulatedText = trimFront(text);
					let displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;

					const threadTs = event.thread_ts || event.ts;
					const isSyntheticEvent = event.user === "EVENT";
					const tryUpdate = async (txt: string) => {
						if (messageTs) {
							await slack.updateMessage(event.channel, messageTs, txt);
						} else if (isSyntheticEvent && !event.thread_ts) {
							messageTs = await slack.postMessage(event.channel, txt);
						} else {
							messageTs = await slack.postInThread(event.channel, threadTs, txt);
						}
					};

					try {
						await tryUpdate(displayText);
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						const errData = (err as { data?: unknown }).data;
						const isTooLong =
							errMsg.includes("msg_too_long") || (errData && JSON.stringify(errData).includes("msg_too_long"));
						if (isTooLong) {
							// Retry with progressively shorter text
							for (const limit of SLACK_MSG_TOO_LONG_FALLBACKS) {
								try {
									displayText = trimFront(text.length > limit ? text.slice(text.length - limit) : text);
									log.logWarning(`replaceMessage msg_too_long, retrying with ${limit} chars`);
									await tryUpdate(displayText);
									return;
								} catch {}
							}
						}
						throw err;
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
		const eventThreadTs = event.thread_ts || event.ts;
		const state = getState(event.channel, eventThreadTs);

		// Start run
		state.running = true;
		state.stopRequested = false;

		log.logInfo(`[${event.channel}:${eventThreadTs}] Starting run: ${event.text.substring(0, 50)}`);

		try {
			// Create context adapter
			const ctx = createSlackContext(event, slack, state, isEvent);

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
