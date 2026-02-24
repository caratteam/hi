import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { extname } from "path";
import type { Executor } from "../sandbox.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

/**
 * Binary file extensions that should NOT be read as text.
 * Returns a descriptive category for each.
 */
const BINARY_EXTENSIONS: Record<string, string> = {
	// Images
	".jpg": "image",
	".jpeg": "image",
	".png": "image",
	".gif": "image",
	".webp": "image",
	".bmp": "image",
	".tiff": "image",
	".tif": "image",
	".ico": "image",
	".svg": "text", // SVG is actually text/XML, so we allow reading it
	// Video
	".mp4": "video",
	".mov": "video",
	".avi": "video",
	".mkv": "video",
	".webm": "video",
	".flv": "video",
	".wmv": "video",
	// Audio
	".mp3": "audio",
	".wav": "audio",
	".flac": "audio",
	".aac": "audio",
	".ogg": "audio",
	".m4a": "audio",
	".wma": "audio",
	// Archives
	".zip": "archive",
	".tar": "archive",
	".gz": "archive",
	".bz2": "archive",
	".xz": "archive",
	".7z": "archive",
	".rar": "archive",
	// Other binary
	".pdf": "document",
	".doc": "document",
	".docx": "document",
	".xls": "spreadsheet",
	".xlsx": "spreadsheet",
	".ppt": "presentation",
	".pptx": "presentation",
	".woff": "font",
	".woff2": "font",
	".ttf": "font",
	".otf": "font",
	".exe": "executable",
	".dll": "library",
	".so": "library",
	".dylib": "library",
	".o": "object",
	".a": "archive",
	".class": "compiled",
	".pyc": "compiled",
	".wasm": "compiled",
};

/**
 * Check if a file is binary based on its extension.
 * Returns the category string if binary, null if text.
 */
function getBinaryCategory(filePath: string): string | null {
	const ext = extname(filePath).toLowerCase();
	const category = BINARY_EXTENSIONS[ext];
	if (category === "text") return null; // SVG etc.
	return category || null;
}

const readSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're reading and why (shown to user)" }),
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

interface ReadToolDetails {
	truncation?: TruncationResult;
}

export function createReadTool(executor: Executor): AgentTool<typeof readSchema> {
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files only. For binary files (images, videos, audio, etc.), returns file metadata instead. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files.`,
		parameters: readSchema,
		execute: async (
			_toolCallId: string,
			{ path, offset, limit }: { label: string; path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
		): Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }> => {
			const binaryCategory = getBinaryCategory(path);

			if (binaryCategory) {
				// Binary file — return metadata only, never base64
				const metaResult = await executor.exec(
					`stat -c '%s' ${shellEscape(path)} 2>/dev/null || stat -f '%z' ${shellEscape(path)} 2>/dev/null`,
					{ signal },
				);
				if (metaResult.code !== 0) {
					throw new Error(metaResult.stderr || `Failed to read file: ${path}`);
				}
				const fileSize = Number.parseInt(metaResult.stdout.trim(), 10);
				const fileSizeStr =
					fileSize > 1024 * 1024
						? `${(fileSize / (1024 * 1024)).toFixed(1)}MB`
						: fileSize > 1024
							? `${(fileSize / 1024).toFixed(1)}KB`
							: `${fileSize}B`;

				// For images, try to get dimensions
				let extraInfo = "";
				if (binaryCategory === "image") {
					const identifyResult = await executor.exec(`file ${shellEscape(path)}`, { signal });
					if (identifyResult.code === 0) {
						extraInfo = `\nfile info: ${identifyResult.stdout.trim()}`;
					}
				} else if (binaryCategory === "video" || binaryCategory === "audio") {
					const probeResult = await executor.exec(`file ${shellEscape(path)}`, { signal });
					if (probeResult.code === 0) {
						extraInfo = `\nfile info: ${probeResult.stdout.trim()}`;
					}
				}

				return {
					content: [
						{
							type: "text",
							text: `[Binary file: ${binaryCategory}] ${path}\nsize: ${fileSizeStr}${extraInfo}\n\nThis is a binary file. Use bash commands to inspect or process it (e.g., ffprobe for video, identify for images).`,
						},
					],
					details: undefined,
				};
			}

			// Get total line count first
			const countResult = await executor.exec(`wc -l < ${shellEscape(path)}`, { signal });
			if (countResult.code !== 0) {
				throw new Error(countResult.stderr || `Failed to read file: ${path}`);
			}
			const totalFileLines = Number.parseInt(countResult.stdout.trim(), 10) + 1; // wc -l counts newlines, not lines

			// Apply offset if specified (1-indexed)
			const startLine = offset ? Math.max(1, offset) : 1;
			const startLineDisplay = startLine;

			// Check if offset is out of bounds
			if (startLine > totalFileLines) {
				throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
			}

			// Read content with offset
			let cmd: string;
			if (startLine === 1) {
				cmd = `cat ${shellEscape(path)}`;
			} else {
				cmd = `tail -n +${startLine} ${shellEscape(path)}`;
			}

			const result = await executor.exec(cmd, { signal });
			if (result.code !== 0) {
				throw new Error(result.stderr || `Failed to read file: ${path}`);
			}

			let selectedContent = result.stdout;
			let userLimitedLines: number | undefined;

			// Apply user limit if specified
			if (limit !== undefined) {
				const lines = selectedContent.split("\n");
				const endLine = Math.min(limit, lines.length);
				selectedContent = lines.slice(0, endLine).join("\n");
				userLimitedLines = endLine;
			}

			// Apply truncation (respects both line and byte limits)
			const truncation = truncateHead(selectedContent);

			let outputText: string;
			let details: ReadToolDetails | undefined;

			if (truncation.firstLineExceedsLimit) {
				// First line at offset exceeds 50KB - tell model to use bash
				const firstLineSize = formatSize(Buffer.byteLength(selectedContent.split("\n")[0], "utf-8"));
				outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
				details = { truncation };
			} else if (truncation.truncated) {
				// Truncation occurred - build actionable notice
				const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
				const nextOffset = endLineDisplay + 1;

				outputText = truncation.content;

				if (truncation.truncatedBy === "lines") {
					outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue]`;
				} else {
					outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue]`;
				}
				details = { truncation };
			} else if (userLimitedLines !== undefined) {
				// User specified limit, check if there's more content
				const linesFromStart = startLine - 1 + userLimitedLines;
				if (linesFromStart < totalFileLines) {
					const remaining = totalFileLines - linesFromStart;
					const nextOffset = startLine + userLimitedLines;

					outputText = truncation.content;
					outputText += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue]`;
				} else {
					outputText = truncation.content;
				}
			} else {
				// No truncation, no user limit exceeded
				outputText = truncation.content;
			}

			return {
				content: [{ type: "text", text: outputText }],
				details,
			};
		},
	};
}

function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}
