/**
 * Agent discovery — scans a directory for agent definition markdown files.
 * Each *.md file with valid YAML frontmatter becomes an available agent.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

export interface AgentConfig {
	name: string;
	description: string;
	model?: string; // e.g. "sonnet", "haiku" — pi resolves to provider-specific ID
	tools?: string[]; // e.g. ["read", "bash"] — omit for all tools
	timeout?: number; // seconds, default 600
	systemPrompt: string; // markdown body (after frontmatter)
	filePath: string;
}

/**
 * Parse YAML frontmatter from a markdown string.
 * Returns { frontmatter, body } where frontmatter is a key-value map.
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
	const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!match) return { frontmatter: {}, body: content };

	const frontmatter: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		let value = line.slice(colonIdx + 1).trim();
		// Strip surrounding quotes
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (key) frontmatter[key] = value;
	}

	return { frontmatter, body: match[2] };
}

/**
 * Discover agents from a directory.
 * Scans *.md files, parses frontmatter, returns configs.
 * Called fresh on each invocation — file additions are immediately reflected.
 */
export function discoverAgents(agentsDir: string): AgentConfig[] {
	const agents: AgentConfig[] = [];

	let fileNames: string[];
	try {
		fileNames = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
	} catch {
		return agents;
	}

	for (const fileName of fileNames) {
		const filePath = join(agentsDir, fileName);
		try {
			const stat = statSync(filePath);
			if (!stat.isFile()) continue;
		} catch {
			continue;
		}

		let content: string;
		try {
			content = readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter(content);
		if (!frontmatter.name || !frontmatter.description) continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((t) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			model: frontmatter.model,
			tools: tools && tools.length > 0 ? tools : undefined,
			timeout: frontmatter.timeout ? parseInt(frontmatter.timeout, 10) : undefined,
			systemPrompt: body,
			filePath,
		});
	}

	return agents;
}
