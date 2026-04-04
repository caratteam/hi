/**
 * Skill-memory extension — auto-appends skill memory when SKILL.md is read.
 * Also checks for oversized files and suggests progressive disclosure.
 *
 * Two exports:
 * - default: ExtensionFactory for pi -e (used by subagent)
 * - createSkillMemoryExtension(): Extension object for mom internal use
 */

import type { Extension } from "@mariozechner/pi-coding-agent";
import { readdirSync, readFileSync } from "fs";
import { basename, dirname, join } from "path";
import * as log from "../log.js";

const SKILL_MEMORY_DIR = "skill-memory";
const SKILL_FILENAME = "SKILL.md";
const SKILL_MEMORY_MAX_LINES = 200;
const SKILL_FILE_MAX_LINES = 200;

/**
 * Find .md files in a skill directory that exceed the line threshold.
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
 * Create the skill-memory handler for a given workspace path.
 * Shared between the Extension object (mom) and the ExtensionFactory (subagent).
 */
function createSkillMemoryHandler(workspacePath: string) {
	return async (event: unknown) => {
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
		const oversized = findOversizedSkillFiles(dir);
		if (oversized.length > 0) {
			const fileList = oversized.map((f) => `${f.name} (${f.lines} lines)`).join(", ");
			appendBlock +=
				`\n\n---\n> **Skill structure note:** ${fileList} exceeded ${SKILL_FILE_MAX_LINES} lines. ` +
				`After completing the current task, apply progressive disclosure to this skill` +
				`${lines.length > SKILL_MEMORY_MAX_LINES ? ` AND its skill-memory file (${SKILL_MEMORY_DIR}/${skillName}.md)` : ""}:\n` +
				`> (1) **Classify each section**: is it needed on EVERY use of this skill, or only for specific task types? ` +
				`Content needed every time stays in SKILL.md. Content needed only for specific tasks goes into reference files.\n` +
				`> (2) **Deduplicate**: merge overlapping entries, generalize specific examples into reusable principles.\n` +
				`> (3) **Remove outdated**: delete information that no longer applies.\n` +
				`> (4) **Split conditionally-needed content** into focused reference files (e.g., references/setup.md, references/review-checklist.md). ` +
				`Add "read references/X.md when Y" pointers in SKILL.md.\n` +
				`> (5) **Compress what remains in SKILL.md**: tighten wording, remove redundancy, use tables instead of prose where possible.`;
		}

		const newContent = e.content.map((c) => {
			if (c.type === "text" && c.text !== undefined) {
				return { ...c, text: c.text + appendBlock };
			}
			return c;
		});

		return { content: newContent };
	};
}

/**
 * Create skill-memory Extension object for mom internal use.
 */
export function createSkillMemoryExtension(workspacePath: string): Extension {
	return {
		path: "<skill-memory>",
		resolvedPath: "<skill-memory>",
		sourceInfo: {
			path: "<skill-memory>",
			source: "built-in",
			scope: "temporary" as const,
			origin: "top-level" as const,
		},
		handlers: new Map([["tool_result", [createSkillMemoryHandler(workspacePath)]]]),
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	} as Extension;
}

/**
 * Default export for pi -e loading (used by subagent).
 * pi's extension loader calls this with the ExtensionAPI.
 */
export default function (pi: any) {
	const workspacePath = process.env.WORKSPACE_PATH || "/workspace";
	pi.on("tool_result", createSkillMemoryHandler(workspacePath));
}
