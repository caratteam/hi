/**
 * Access control for Mom - restrict source code modifications to admin users only
 */

import { resolve } from "path";

// Protected paths - these can only be modified by admin users
const PROTECTED_PATHS = ["/pi-mono"];

// Admin users from environment variable (comma-separated Slack user IDs)
const ADMIN_USERS = new Set(
	(process.env.MOM_ADMIN_USERS || "")
		.split(",")
		.map((id) => id.trim())
		.filter(Boolean),
);

export interface AccessContext {
	userId: string;
	path?: string;
	command?: string;
}

/**
 * Check if a path is protected (source code)
 */
function isProtectedPath(targetPath: string): boolean {
	const normalized = resolve(targetPath);
	return PROTECTED_PATHS.some((protectedPath) => normalized.startsWith(protectedPath));
}

/**
 * Check if a bash command attempts to modify protected paths
 */
function commandModifiesProtectedPath(command: string): boolean {
	// Commands that modify files
	const modifyCommands = [
		/\brm\s+/,
		/\bmv\s+/,
		/\bcp\s+.*\s+\/pi-mono/,
		/\btouch\s+.*\/pi-mono/,
		/\bmkdir\s+.*\/pi-mono/,
		/\bchmod\s+.*\/pi-mono/,
		/\bchown\s+.*\/pi-mono/,
		/\bgit\s+(commit|push|pull|merge|rebase)/,
		/>\s*\/pi-mono/,
		/>>\s*\/pi-mono/,
	];

	// Check if command contains any modify operation on protected paths
	for (const pattern of modifyCommands) {
		if (pattern.test(command)) {
			// Check if it targets protected path
			if (command.includes("/pi-mono")) {
				return true;
			}
		}
	}

	return false;
}

/**
 * Check if user has access to perform an operation
 * Throws an error if access is denied
 */
export function checkAccess(context: AccessContext, operation: "read" | "write" | "execute"): void {
	// Read operations are always allowed
	if (operation === "read") {
		return;
	}

	// Check if operation involves protected paths
	let isProtected = false;

	if (context.path) {
		isProtected = isProtectedPath(context.path);
	} else if (context.command && operation === "execute") {
		isProtected = commandModifiesProtectedPath(context.command);
	}

	if (!isProtected) {
		return; // Not protected, allow
	}

	// Protected operation - check if user is admin
	if (!ADMIN_USERS.has(context.userId)) {
		const adminList = Array.from(ADMIN_USERS).join(", ");
		throw new Error(
			`Access denied: Source code modifications are restricted to admin users only.\n` +
				`Current user: ${context.userId}\n` +
				`Admin users: ${adminList || "(none configured)"}\n\n` +
				`Set MOM_ADMIN_USERS environment variable with comma-separated Slack user IDs to configure admins.`,
		);
	}

	// Admin user - allow
}

/**
 * Get list of admin users
 */
export function getAdminUsers(): string[] {
	return Array.from(ADMIN_USERS);
}
