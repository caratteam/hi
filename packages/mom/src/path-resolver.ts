/**
 * Path resolver - convert container paths to host paths for file uploads
 */

import { readFileSync } from "fs";

interface MountMapping {
	containerPath: string;
	hostPath: string;
}

let cachedMappings: MountMapping[] | null = null;

/**
 * Parse /proc/self/mountinfo to extract container-to-host path mappings
 */
function parseMountMappings(): MountMapping[] {
	try {
		const mountinfo = readFileSync("/proc/self/mountinfo", "utf-8");
		const mappings: MountMapping[] = [];

		for (const line of mountinfo.split("\n")) {
			// Format: ... source_path container_path options - fstype ...
			const parts = line.split(" ");
			if (parts.length < 10) continue;

			// Find the mount point (container path) - it's at index 4
			const containerPath = parts[4];

			// Find the source path (relative to mount root) - it's at index 3
			const sourcePath = parts[3];

			// Only interested in /pi-mono and /workspace
			if (containerPath === "/pi-mono" || containerPath === "/workspace") {
				// Remove leading slash and //deleted suffix from source path
				const cleanSource = sourcePath.replace(/^\//, "").replace(/\/\/deleted$/, "");
				// Reconstruct host path: /Users/<username>/<path>
				const hostPath = `/Users/${cleanSource}`;

				mappings.push({
					containerPath,
					hostPath,
				});
			}
		}

		return mappings;
	} catch (error) {
		// Fallback: if we can't read mountinfo, return empty array
		console.error("Failed to parse mountinfo:", error);
		return [];
	}
}

/**
 * Get cached mount mappings
 */
function getMountMappings(): MountMapping[] {
	if (!cachedMappings) {
		cachedMappings = parseMountMappings();
	}
	return cachedMappings;
}

/**
 * Convert container path to host path
 * @param containerPath Path inside the container (e.g., /pi-mono/file.jpg)
 * @returns Host path (e.g., /Users/jjanggu/pi-mono/file.jpg)
 */
export function containerToHostPath(containerPath: string): string {
	const mappings = getMountMappings();

	// Try to match against known mount points
	for (const mapping of mappings) {
		if (containerPath.startsWith(`${mapping.containerPath}/`) || containerPath === mapping.containerPath) {
			// Replace container path prefix with host path prefix
			return containerPath.replace(mapping.containerPath, mapping.hostPath);
		}
	}

	// No mapping found - return as-is
	// This might happen for paths that aren't in mounted volumes
	return containerPath;
}

/**
 * Clear cached mappings (for testing)
 */
export function clearMappingCache(): void {
	cachedMappings = null;
}
