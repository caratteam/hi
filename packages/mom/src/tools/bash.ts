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
 * Trusted read-only scripts. These are inherently safe (e.g., DB queries are read-only).
 * Their arguments (SQL, API params, etc.) may contain >, <, etc. that would
 * false-positive the blocked patterns, so they bypass the blocklist entirely.
 * Matched against the full command string.
 */
const READONLY_TRUSTED_SCRIPTS = [
	// DB query via skill script (with optional env vars and bash prefix)
	// Safety: query.sh has internal keyword filter (blocks INSERT/UPDATE/DELETE/DROP) + dashboard read-only DB endpoint
	// Supports both absolute (/workspace/skills/carat-db/query.sh) and relative (query.sh) paths
	/^\s*(?:QUERY_TIMEOUT_MS=\d+\s+)?(?:bash\s+)?(?:\/workspace\/skills\/carat-db\/)?query\.sh\s/,
	// Mixpanel event query via skill script
	// Supports both absolute (/workspace/skills/mixpanel/query.sh) and relative (query.sh) paths
	/^\s*(?:bash\s+)?(?:\/workspace\/skills\/mixpanel\/)?query\.sh[\s]/,
	// AWS CLI (read-only by IAM ReadOnly policy)
	/^\s*(?:aws\s)/,
];

/**
 * Allowlist of commands for read-only mode.
 * Only these commands (and their common usage patterns) are permitted.
 * Commands here are subject to the blocked patterns check.
 */
const READONLY_ALLOWED_COMMANDS = [
	// Navigation & environment (no side effects)
	/^\s*cd\b/,
	/^\s*true$/,
	/^\s*false$/,
	// Basic read-only utilities
	/^\s*cat\b/,
	/^\s*grep\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*wc\b/,
	/^\s*jq\b/,
	/^\s*date\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*ls\b/,
	/^\s*ls$/,
	/^\s*find\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*cut\b/,
	/^\s*awk\b/,
	/^\s*sed\b/,
	/^\s*diff\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*pwd$/,
	/^\s*env$/,
	/^\s*tree\b/,
	/^\s*realpath\b/,
	/^\s*dirname\b/,
	/^\s*basename\b/,
	/^\s*readlink\b/,
	/^\s*which\b/,
	/^\s*test\b/,
	/^\s*\[\s/,
	// Note: xargs and time are intentionally excluded — they can execute arbitrary sub-commands
	// (e.g., "xargs python3 -c", "time node -e") which bypasses the allowlist.
	// curl for read-only HTTP requests (mutating flags are blocked by READONLY_BLOCKED_PATTERNS)
	/^\s*curl\b/,
];

/**
 * Patterns that indicate file-writing or destructive operations.
 * Only checked against non-trusted commands. Trusted scripts bypass this.
 */
const READONLY_BLOCKED_PATTERNS = [
	/(?:^|[^\\<>=0-9])>(?!=)/, // redirect stdout (>, >>), but allow SQL comparisons (>=, <=, =>, <>) and stderr redirects (2>/dev/null, 2>&1)
	/\btee\b/, // tee writes to files
	/\bmkdir\b/, // create directories
	/\btouch\b/, // create files
	/\brm\b/, // remove files
	/\bmv\b/, // move/rename files
	/\bcp\b/, // copy files
	/\bchmod\b/, // change permissions
	/\bchown\b/, // change ownership
	/\bln\b/, // create links
	/\binstall\b/, // install command
	/\bdd\b/, // disk dump
	// sed in-place modification
	/\bsed\b.*\s-i\b/, // sed -i
	/\bsed\b.*--in-place\b/, // sed --in-place
	// find destructive flags
	/-delete\b/, // find -delete
	/-exec\b/, // find -exec (can run arbitrary commands)
	/-execdir\b/, // find -execdir
	/-ok\b/, // find -ok
	// sort output to file
	/\bsort\b.*\s-o\b/, // sort -o writes to file
	// curl mutating operations (curl itself is in allowlist for GET requests)
	/\bcurl\b.*\s-X\s+(?:POST|PUT|DELETE|PATCH)\b/i, // explicit mutating methods
	/\bcurl\b.*\s(?:-d|--data|--data-\w+|--json)\b/, // POST data flags (--json implies POST + Content-Type)
	/\bcurl\b.*\s(?:-F|--form)\b/, // form upload
	/\bcurl\b.*\s(?:-T|--upload-file)\b/, // file upload
	/\bcurl\b.*\s(?:-o|--output)\b/, // write response to file
	/\bcurl\b.*\s-O\b/, // write response to file (remote name)
	// Note: bash/sh/python/node are NOT in the allowlist, so they are automatically rejected.
	// Only trusted scripts (query.sh etc.) bypass the allowlist check.
];

/**
 * Check if a command is allowed in read-only mode.
 *
 * Logic:
 * 1. Normalize (strip harmless stderr redirects)
 * 2. Split into shell segments (|, &&, ;, ||)
 * 3. For each segment:
 *    a. If it matches a trusted script → allow (skip blocked patterns, since arguments may contain >, < etc.)
 *    b. If it matches the blocked patterns → reject
 *    c. If it matches the general allowlist → allow
 *    d. Otherwise → reject
 */
function isReadOnlyAllowed(command: string): boolean {
	// Normalize: strip stderr redirects (2>/dev/null, 2>&1) — they are harmless
	const normalized = command.replace(/\s+2>(?:\/dev\/null|&1)/g, "");

	// Check if the entire command is a trusted script call.
	// Trusted scripts are safe end-to-end (e.g., query.sh has internal keyword filtering).
	// Their arguments often contain shell metacharacters (;, >, <) that would cause
	// false positives if we split the command by shell combinators first.
	const isTrustedFull = READONLY_TRUSTED_SCRIPTS.some((pattern) => pattern.test(normalized.trim()));
	if (isTrustedFull) return true;

	// Split by shell combinators (|, ||, &&, ;).
	// Escaped pipes (\|) in grep patterns must be preserved, not treated as shell pipes.
	const ESCAPED_PIPE_PLACEHOLDER = "\x00EP\x00";
	const escaped = normalized.replace(/\\\|/g, ESCAPED_PIPE_PLACEHOLDER);
	const segments = escaped.split(/\|{1,2}|&&|;/).map((s) => s.trim().replaceAll(ESCAPED_PIPE_PLACEHOLDER, "\\|"));

	for (const segment of segments) {
		if (!segment) continue;

		// Trusted scripts bypass blocked patterns entirely
		const isTrusted = READONLY_TRUSTED_SCRIPTS.some((pattern) => pattern.test(segment));
		if (isTrusted) continue;

		// Non-trusted commands must pass the blocked patterns check
		for (const pattern of READONLY_BLOCKED_PATTERNS) {
			if (pattern.test(segment)) return false;
		}

		// Non-trusted commands must also match the general allowlist
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
