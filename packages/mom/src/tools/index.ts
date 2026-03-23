import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Executor } from "../sandbox.js";
import { createAttachTool } from "./attach.js";
import { createBashTool, createReadOnlyBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export { createAttachTool } from "./attach.js";

export function createMomTools(
	executor: Executor,
	getUserId: () => string | undefined,
	uploadFn?: (filePath: string, title?: string) => Promise<void>,
): AgentTool<any>[] {
	const tools: AgentTool<any>[] = [
		createReadTool(executor),
		createBashTool(executor, getUserId),
		createEditTool(executor, getUserId),
		createWriteTool(executor, getUserId),
	];
	if (uploadFn) {
		tools.push(createAttachTool(uploadFn));
	}
	return tools;
}

/**
 * Create a restricted tool set for non-admin (read-only) users.
 * Only Read + read-only Bash (whitelisted commands) + attach are available.
 * No Write or Edit tools.
 */
export function createReadOnlyMomTools(
	executor: Executor,
	uploadFn?: (filePath: string, title?: string) => Promise<void>,
): AgentTool<any>[] {
	const tools: AgentTool<any>[] = [createReadTool(executor), createReadOnlyBashTool(executor)];
	if (uploadFn) {
		tools.push(createAttachTool(uploadFn));
	}
	return tools;
}
