import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { checkAccess } from "../access-control.js";
import type { Executor } from "../sandbox.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateTail } from "./truncate.js";

/**
 * Generate a unique temp file path for bash output
 */
function getTempFilePath(): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `mom-bash-${id}.log`);
}

/**
 * Commands that are blocked from execution to protect the server.
 * These are matched against the command string using word boundaries.
 */
const BLOCKED_COMMANDS = ["ffmpeg", "ffprobe"];

/**
 * Check if a command contains any blocked commands.
 * Returns the blocked command name if found, null otherwise.
 */
function findBlockedCommand(command: string): string | null {
	for (const blocked of BLOCKED_COMMANDS) {
		// Match as a word boundary — handles pipes, &&, $(), etc.
		const pattern = new RegExp(`\\b${blocked}\\b`);
		if (pattern.test(command)) {
			return blocked;
		}
	}
	return null;
}

const bashSchema = Type.Object({
	label: Type.String({ description: "Brief description of what this command does (shown to user)" }),
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/**
 * Allowlist of commands for read-only mode.
 * Only these commands (and their common usage patterns) are permitted.
 */
const READONLY_ALLOWED_COMMANDS = [
	// DB query via skill script
	/^\s*(?:QUERY_TIMEOUT_MS=\d+\s+)?(?:bash\s+)?\/workspace\/skills\/carat-db\/query\.sh\s/,
	// Basic read-only utilities
	/^\s*cat\s/,
	/^\s*grep\s/,
	/^\s*head\s/,
	/^\s*tail\s/,
	/^\s*wc\s/,
	/^\s*jq\s/,
	/^\s*date\b/,
	/^\s*echo\s/,
	/^\s*ls\s/,
	/^\s*ls$/,
	/^\s*find\s/,
	/^\s*sort\s/,
	/^\s*uniq\s/,
	/^\s*cut\s/,
	/^\s*awk\s/,
	/^\s*sed\s/,
	/^\s*diff\s/,
	/^\s*du\s/,
	/^\s*df\s/,
	/^\s*wc\b/,
	/^\s*file\s/,
	/^\s*stat\s/,
	/^\s*pwd$/,
	/^\s*env$/,
	/^\s*PGPASSWORD=.*psql\s.*-c\s/,
];

/**
 * Check if a command is allowed in read-only mode.
 * For piped commands (a | b | c), each segment must be allowed.
 */
function isReadOnlyAllowed(command: string): boolean {
	// Split by pipes, but not pipes inside quotes
	// Simple approach: split by | that is not inside quotes
	const segments = command.split(/\|/).map((s) => s.trim());
	for (const segment of segments) {
		if (!segment) continue;
		const allowed = READONLY_ALLOWED_COMMANDS.some((pattern) => pattern.test(segment));
		if (!allowed) return false;
	}
	return true;
}

/**
 * Create a read-only bash tool that only allows whitelisted commands.
 * Used for non-admin users who mention the bot in channels.
 */
export function createReadOnlyBashTool(executor: Executor): AgentTool<typeof bashSchema> {
	return {
		name: "bash",
		label: "bash",
		description: `Execute a read-only bash command. Only allows: DB queries via /workspace/skills/carat-db/query.sh, and basic read utilities (cat, grep, head, tail, jq, date, etc.). File writes, package installs, and other modifications are blocked.`,
		parameters: bashSchema,
		execute: async (
			_toolCallId: string,
			{ command, timeout }: { label: string; command: string; timeout?: number },
			signal?: AbortSignal,
		) => {
			if (!isReadOnlyAllowed(command)) {
				throw new Error(
					`Command not allowed in read-only mode. Only DB queries and read-only utilities (cat, grep, head, tail, jq, date, etc.) are permitted.`,
				);
			}

			const result = await executor.exec(command, { timeout, signal });
			let output = "";
			if (result.stdout) output += result.stdout;
			if (result.stderr) {
				if (output) output += "\n";
				output += result.stderr;
			}

			const truncation = truncateTail(output);
			const outputText = truncation.content || "(no output)";

			if (result.code !== 0) {
				throw new Error(`${outputText}\n\nCommand exited with code ${result.code}`.trim());
			}

			return { content: [{ type: "text", text: outputText }], details: undefined };
		},
	};
}

export function createBashTool(executor: Executor, getUserId: () => string | undefined): AgentTool<typeof bashSchema> {
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		parameters: bashSchema,
		execute: async (
			_toolCallId: string,
			{ command, timeout }: { label: string; command: string; timeout?: number },
			signal?: AbortSignal,
		) => {
			// Check for blocked commands (server protection)
			const blockedCmd = findBlockedCommand(command);
			if (blockedCmd) {
				throw new Error(
					`Command '${blockedCmd}' is blocked. This server has limited resources (2GB RAM, 2 vCPUs) and ${blockedCmd} could crash it. Instead, use the carat-agent skill to request the task — the Carat Agent server has sufficient resources to handle ${blockedCmd} workloads.`,
				);
			}

			// Check access control
			const userId = getUserId();
			if (userId) {
				checkAccess({ userId, command }, "execute");
			}
			// Track output for potential temp file writing
			let tempFilePath: string | undefined;
			let tempFileStream: ReturnType<typeof createWriteStream> | undefined;

			const result = await executor.exec(command, { timeout, signal });
			let output = "";
			if (result.stdout) output += result.stdout;
			if (result.stderr) {
				if (output) output += "\n";
				output += result.stderr;
			}

			const totalBytes = Buffer.byteLength(output, "utf-8");

			// Write to temp file if output exceeds limit
			if (totalBytes > DEFAULT_MAX_BYTES) {
				tempFilePath = getTempFilePath();
				tempFileStream = createWriteStream(tempFilePath);
				tempFileStream.write(output);
				tempFileStream.end();
			}

			// Apply tail truncation
			const truncation = truncateTail(output);
			let outputText = truncation.content || "(no output)";

			// Build details with truncation info
			let details: BashToolDetails | undefined;

			if (truncation.truncated) {
				details = {
					truncation,
					fullOutputPath: tempFilePath,
				};

				// Build actionable notice
				const startLine = truncation.totalLines - truncation.outputLines + 1;
				const endLine = truncation.totalLines;

				if (truncation.lastLinePartial) {
					// Edge case: last line alone > 50KB
					const lastLineSize = formatSize(Buffer.byteLength(output.split("\n").pop() || "", "utf-8"));
					outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${tempFilePath}]`;
				} else if (truncation.truncatedBy === "lines") {
					outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${tempFilePath}]`;
				} else {
					outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${tempFilePath}]`;
				}
			}

			if (result.code !== 0) {
				throw new Error(`${outputText}\n\nCommand exited with code ${result.code}`.trim());
			}

			return { content: [{ type: "text", text: outputText }], details };
		},
	};
}
