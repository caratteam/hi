import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "child_process";
import { PROCESS_BUFFER_MAX } from "./constants.js";

// Background mode constants
const BG_THRESHOLD_MS = 60_000; // 60s — switch to background after this
const BG_EXTENDED_TIMEOUT_SECS = 30 * 60; // 30min — hard kill for backgrounded commands
const BG_MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB — max output file size (rolling tail)
const BG_COMPACT_TRIGGER = BG_MAX_OUTPUT_BYTES * 2; // compact at 2x limit
const BG_PARTIAL_OUTPUT_MAX = 20 * 1024; // 20KB tail for partial_output in response

export type SandboxConfig = { type: "host" } | { type: "docker"; container: string };

export function parseSandboxArg(value: string): SandboxConfig {
	if (value === "host") {
		return { type: "host" };
	}
	if (value.startsWith("docker:")) {
		const container = value.slice("docker:".length);
		if (!container) {
			console.error("Error: docker sandbox requires container name (e.g., docker:mom-sandbox)");
			process.exit(1);
		}
		return { type: "docker", container };
	}
	console.error(`Error: Invalid sandbox type '${value}'. Use 'host' or 'docker:<container-name>'`);
	process.exit(1);
}

export async function validateSandbox(config: SandboxConfig): Promise<void> {
	if (config.type === "host") {
		return;
	}

	// Check if Docker is available
	try {
		await execSimple("docker", ["--version"]);
	} catch {
		console.error("Error: Docker is not installed or not in PATH");
		process.exit(1);
	}

	// Check if container exists and is running
	try {
		const result = await execSimple("docker", ["inspect", "-f", "{{.State.Running}}", config.container]);
		if (result.trim() !== "true") {
			console.error(`Error: Container '${config.container}' is not running.`);
			console.error(`Start it with: docker start ${config.container}`);
			process.exit(1);
		}
	} catch {
		console.error(`Error: Container '${config.container}' does not exist.`);
		console.error("Create it with: ./docker.sh create <data-dir>");
		process.exit(1);
	}

	console.log(`  Docker container '${config.container}' is running.`);
}

function execSimple(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d) => {
			stdout += d;
		});
		child.stderr?.on("data", (d) => {
			stderr += d;
		});
		child.on("close", (code) => {
			if (code === 0) resolve(stdout);
			else reject(new Error(stderr || `Exit code ${code}`));
		});
	});
}

/**
 * Create an executor that runs commands either on host or in Docker container
 */
export function createExecutor(
	config: SandboxConfig,
	envVars?: Record<string, string>,
	hostWorkspaceDir?: string,
): Executor {
	if (config.type === "host") {
		return new HostExecutor();
	}
	return new DockerExecutor(config.container, envVars, hostWorkspaceDir);
}

export interface Executor {
	/**
	 * Execute a bash command
	 */
	exec(command: string, options?: ExecOptions): Promise<ExecResult>;

	/**
	 * Get the workspace path prefix for this executor
	 * Host: returns the actual path
	 * Docker: returns /workspace
	 */
	getWorkspacePath(hostPath: string): string;
}

export interface ExecOptions {
	timeout?: number;
	signal?: AbortSignal;
	/** Run command in background immediately. Returns pid and output file instead of waiting. */
	runInBackground?: boolean;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	/** True if command was backgrounded (threshold exceeded or runInBackground) */
	backgrounded?: boolean;
	/** PID of the background process (inside the container) */
	pid?: number;
	/** Path to background output file (inside the container) */
	outputFile?: string;
	/** Partial output captured before backgrounding */
	partialOutput?: string;
}

class HostExecutor implements Executor {
	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		return new Promise((resolve, reject) => {
			const shell = process.platform === "win32" ? "cmd" : "sh";
			const shellArgs = process.platform === "win32" ? ["/c"] : ["-c"];

			const child = spawn(shell, [...shellArgs, command], {
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";
			let timedOut = false;

			const timeoutHandle =
				options?.timeout && options.timeout > 0
					? setTimeout(() => {
							timedOut = true;
							killProcessTree(child.pid!);
						}, options.timeout * 1000)
					: undefined;

			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			if (options?.signal) {
				if (options.signal.aborted) {
					onAbort();
				} else {
					options.signal.addEventListener("abort", onAbort, { once: true });
				}
			}

			child.stdout?.on("data", (data) => {
				stdout += data.toString();
				if (stdout.length > PROCESS_BUFFER_MAX) {
					stdout = stdout.slice(0, PROCESS_BUFFER_MAX);
				}
			});

			child.stderr?.on("data", (data) => {
				stderr += data.toString();
				if (stderr.length > PROCESS_BUFFER_MAX) {
					stderr = stderr.slice(0, PROCESS_BUFFER_MAX);
				}
			});

			child.on("close", (code) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (options?.signal) {
					options.signal.removeEventListener("abort", onAbort);
				}

				if (options?.signal?.aborted) {
					reject(new Error(`${stdout}\n${stderr}\nCommand aborted`.trim()));
					return;
				}

				if (timedOut) {
					reject(new Error(`${stdout}\n${stderr}\nCommand timed out after ${options?.timeout} seconds`.trim()));
					return;
				}

				resolve({ stdout, stderr, code: code ?? 0 });
			});
		});
	}

	getWorkspacePath(hostPath: string): string {
		return hostPath;
	}
}

/** Container-internal path for background output files (on the shared /workspace volume) */
const BG_DIR_CONTAINER = "/workspace/.bg";

class DockerExecutor implements Executor {
	private envVars: Record<string, string>;
	/** Host-side path that maps to /workspace inside the container */
	private hostWorkspaceDir: string;

	constructor(
		private container: string,
		envVars?: Record<string, string>,
		hostWorkspaceDir?: string,
	) {
		this.envVars = envVars || {};
		this.hostWorkspaceDir = hostWorkspaceDir || "/workspace";
	}

	/**
	 * Convert a container path (e.g., /workspace/.bg/xxx.out) to the host-side path.
	 */
	private containerPathToHost(containerPath: string): string {
		if (containerPath.startsWith("/workspace/")) {
			return join(this.hostWorkspaceDir, containerPath.slice("/workspace/".length));
		}
		if (containerPath === "/workspace") return this.hostWorkspaceDir;
		return containerPath;
	}

	/**
	 * Build the `docker exec` command string with env flags.
	 */
	private buildDockerCmd(command: string): string {
		const envFlags = Object.entries(this.envVars)
			.map(([k, v]) => `-e ${k}=${shellEscape(v)}`)
			.join(" ");
		return `docker exec ${envFlags} ${this.container} sh -c ${shellEscape(command)}`;
	}

	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		const runInBg = options?.runInBackground === true;

		if (runInBg) {
			return this.execBackground(command);
		}

		return this.execWithBackground(command, options);
	}

	/**
	 * Execute with auto-background: runs normally via docker exec, but if the
	 * command exceeds BG_THRESHOLD_MS it switches to background mode in-place.
	 *
	 * When backgrounding:
	 * 1. The process keeps running (NOT killed).
	 * 2. Accumulated stdout/stderr is flushed to an output file.
	 * 3. Future stdout/stderr is appended to the file instead of memory.
	 * 4. The result is returned immediately with the output file path.
	 *
	 * This preserves all output and avoids re-executing the command.
	 * Inspired by carat-pi's sandbox approach.
	 */
	private execWithBackground(command: string, options?: ExecOptions): Promise<ExecResult> {
		return new Promise((resolve, reject) => {
			const dockerCmd = this.buildDockerCmd(command);
			const child = spawn("sh", ["-c", dockerCmd], {
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});

			if (child.pid == null) {
				reject(new Error("Failed to spawn docker exec process"));
				return;
			}

			const pid = child.pid;
			let stdout = "";
			let stderr = "";
			let resolved = false;
			let backgrounded = false;
			let outputStream: ReturnType<typeof createWriteStream> | null = null;
			let bgOutputFile: string | null = null;
			let outputBytes = 0;

			// Kill the host-side process tree (the docker exec process)
			const killChild = () => {
				try {
					process.kill(-pid, "SIGTERM");
				} catch {}
				setTimeout(() => {
					try {
						process.kill(-pid, "SIGKILL");
					} catch {}
				}, 5000);
			};

			// Abort signal handling
			const onAbort = () => killChild();
			if (options?.signal) {
				if (options.signal.aborted) {
					onAbort();
				} else {
					options.signal.addEventListener("abort", onAbort, { once: true });
				}
			}

			// Compaction: keep output file under BG_MAX_OUTPUT_BYTES
			const TRUNCATION_HEADER = "--- earlier output truncated ---\n";
			let compacting = false;
			const pendingChunks: (Buffer | string)[] = [];

			const compactBgOutput = () => {
				if (!bgOutputFile || !outputStream) return;
				compacting = true;
				const stream = outputStream;
				outputStream = null;
				stream.end();
				stream.once("finish", () => {
					try {
						const content = readFileSync(bgOutputFile!, "utf-8");
						const keep = Math.floor(BG_MAX_OUTPUT_BYTES * 0.8);
						const truncated = TRUNCATION_HEADER + content.slice(-keep);
						writeFileSync(bgOutputFile!, truncated);
						outputBytes = Buffer.byteLength(truncated);
					} catch {}
					try {
						outputStream = createWriteStream(bgOutputFile!, { flags: "a" });
						outputStream.on("error", () => {
							outputStream = null;
						});
					} catch {
						outputStream = null;
					}
					compacting = false;
					for (const c of pendingChunks) appendBgOutput(c);
					pendingChunks.length = 0;
				});
			};

			const appendBgOutput = (chunk: Buffer | string) => {
				if (compacting) {
					pendingChunks.push(chunk);
					return;
				}
				if (!outputStream) return;
				outputStream.write(chunk);
				outputBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
				if (outputBytes >= BG_COMPACT_TRIGGER) compactBgOutput();
			};

			// Hard kill timer: prevent infinite runs
			let killTimer: ReturnType<typeof setTimeout> | null = null;

			// Background threshold timer: switch output to file, keep process alive
			const bgTimer = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				backgrounded = true;

				// Container path (shown to LLM) vs host path (used for file I/O)
				const fileId = `${randomUUID()}.out`;
				const containerOutputFile = `${BG_DIR_CONTAINER}/${fileId}`;
				const hostBgDir = this.containerPathToHost(BG_DIR_CONTAINER);
				const hostOutputFile = join(hostBgDir, fileId);

				try {
					mkdirSync(hostBgDir, { recursive: true });
				} catch {}

				bgOutputFile = hostOutputFile;
				try {
					outputStream = createWriteStream(hostOutputFile, { flags: "w" });
					outputStream.on("error", () => {
						outputStream = null;
					});
				} catch {
					outputStream = null;
				}

				// Flush accumulated output to file
				const accumulated = stdout + (stderr ? `\nSTDERR:\n${stderr}` : "");
				if (outputStream && accumulated) {
					outputStream.write(accumulated);
					outputBytes = Buffer.byteLength(accumulated);
				}

				// Set hard kill timer for backgrounded process
				killTimer = setTimeout(() => {
					killChild();
				}, BG_EXTENDED_TIMEOUT_SECS * 1000);

				let partialOutput = accumulated;
				if (Buffer.byteLength(partialOutput) > BG_PARTIAL_OUTPUT_MAX) {
					partialOutput = `... (truncated)\n${partialOutput.slice(-BG_PARTIAL_OUTPUT_MAX)}`;
				}

				resolve({
					stdout: "",
					stderr: "",
					code: 0,
					backgrounded: true,
					pid,
					outputFile: containerOutputFile,
					partialOutput,
				});
			}, BG_THRESHOLD_MS);

			child.stdout?.on("data", (data: Buffer) => {
				if (backgrounded) {
					appendBgOutput(data);
				} else {
					stdout += data.toString();
					if (stdout.length > PROCESS_BUFFER_MAX) {
						stdout = stdout.slice(-PROCESS_BUFFER_MAX);
					}
				}
			});

			child.stderr?.on("data", (data: Buffer) => {
				if (backgrounded) {
					appendBgOutput(data);
				} else {
					stderr += data.toString();
					if (stderr.length > PROCESS_BUFFER_MAX) {
						stderr = stderr.slice(-PROCESS_BUFFER_MAX);
					}
				}
			});

			child.on("error", (err) => {
				clearTimeout(bgTimer);
				if (killTimer) clearTimeout(killTimer);
				if (backgrounded) {
					if (outputStream) {
						outputStream.end(`\n--- ERROR: ${err.message} ---\n`);
						outputStream = null;
					}
					return;
				}
				if (!resolved) {
					resolved = true;
					reject(err);
				}
			});

			child.on("close", (code) => {
				clearTimeout(bgTimer);
				if (killTimer) clearTimeout(killTimer);
				if (options?.signal) {
					options.signal.removeEventListener("abort", onAbort);
				}
				if (backgrounded) {
					if (outputStream) {
						outputStream.end(`\n--- EXIT CODE: ${code} ---\n`);
						outputStream = null;
					}
					return;
				}
				if (!resolved) {
					resolved = true;
					if (options?.signal?.aborted) {
						reject(new Error(`${stdout}\n${stderr}\nCommand aborted`.trim()));
						return;
					}
					resolve({ stdout, stderr, code: code ?? 0 });
				}
			});
		});
	}

	/**
	 * Launch a command inside the container with nohup, writing output to a file.
	 * Uses a wrapper script that handles rolling tail compaction.
	 * Returns immediately with the output file path and container PID.
	 */
	private async launchInContainer(command: string): Promise<ExecResult> {
		const fileId = randomUUID();
		const outputFile = `${BG_DIR_CONTAINER}/${fileId}.out`;
		const pidFile = `${BG_DIR_CONTAINER}/${fileId}.pid`;

		// Create bg dir and launch the command with nohup inside the container.
		// The wrapper:
		// 1. Runs the command, piping output to the file
		// 2. Records its PID
		// 3. Appends exit code when done
		// 4. Runs a background compaction loop to keep file under BG_MAX_OUTPUT_BYTES
		const wrapperScript = [
			`mkdir -p ${BG_DIR_CONTAINER}`,
			`(`,
			// Compaction loop: every 30s, if file > limit, keep last 80%
			`  _compact() {`,
			`    while kill -0 $$ 2>/dev/null; do`,
			`      sleep 30`,
			`      local size=$(stat -c%s "${outputFile}" 2>/dev/null || echo 0)`,
			`      if [ "$size" -gt ${BG_COMPACT_TRIGGER} ]; then`,
			`        tail -c ${BG_MAX_OUTPUT_BYTES} "${outputFile}" > "${outputFile}.tmp" 2>/dev/null`,
			`        printf '--- earlier output truncated ---\\n' > "${outputFile}.compact" 2>/dev/null`,
			`        cat "${outputFile}.tmp" >> "${outputFile}.compact" 2>/dev/null`,
			`        mv "${outputFile}.compact" "${outputFile}" 2>/dev/null`,
			`        rm -f "${outputFile}.tmp" 2>/dev/null`,
			`      fi`,
			`    done`,
			`  }`,
			`  _compact &`,
			`  _COMPACT_PID=$!`,
			// Hard kill watchdog: kill the command after extended timeout
			`  _watchdog() {`,
			`    sleep ${BG_EXTENDED_TIMEOUT_SECS}`,
			`    kill $1 2>/dev/null`,
			`    sleep 5`,
			`    kill -9 $1 2>/dev/null`,
			`  }`,
			// Run the actual command in a subshell so we can get its PID for the watchdog
			`  ( ${command} ) > "${outputFile}" 2>&1 &`,
			`  _CMD_PID=$!`,
			`  _watchdog $_CMD_PID &`,
			`  _WATCHDOG_PID=$!`,
			`  wait $_CMD_PID 2>/dev/null`,
			`  _EXIT_CODE=$?`,
			`  kill $_WATCHDOG_PID 2>/dev/null; wait $_WATCHDOG_PID 2>/dev/null`,
			`  kill $_COMPACT_PID 2>/dev/null; wait $_COMPACT_PID 2>/dev/null`,
			`  echo "" >> "${outputFile}"`,
			`  echo "--- EXIT CODE: $_EXIT_CODE ---" >> "${outputFile}"`,
			`) &`,
			`echo $! > "${pidFile}"`,
			`cat "${pidFile}"`,
		].join("\n");

		// Execute the wrapper and capture the PID
		const hostExecutor = new HostExecutor();
		const result = await hostExecutor.exec(this.buildDockerCmd(wrapperScript));
		const containerPid = parseInt(result.stdout.trim(), 10) || 0;

		return {
			stdout: "",
			stderr: "",
			code: 0,
			backgrounded: true,
			pid: containerPid,
			outputFile,
			partialOutput: "(command re-launched in background after exceeding 60s threshold)",
		};
	}

	/**
	 * Execute command in immediate background mode.
	 * Launches inside the container with nohup, returns immediately.
	 */
	private async execBackground(command: string): Promise<ExecResult> {
		return this.launchInContainer(command);
	}

	getWorkspacePath(_hostPath: string): string {
		// Docker container sees /workspace
		return "/workspace";
	}
}

function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
			});
		} catch {
			// Ignore errors
		}
	} else {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		}
	}
}

function shellEscape(s: string): string {
	// Escape for passing to sh -c
	return `'${s.replace(/'/g, "'\\''")}'`;
}
