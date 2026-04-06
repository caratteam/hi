// ============================================================================
// Centralized magic numbers for the mom package.
// All size/threshold constants live here for easy tuning.
// ============================================================================

// ----------------------------------------------------------------------------
// Slack message limits
// ----------------------------------------------------------------------------

/** Slack's max text length for chat.postMessage is ~40000 chars. Use a safe margin. */
export const SLACK_MAX_TEXT = 39000;

/** Slack's chat.update has a much lower limit: ~4000 UTF-8 bytes. Use a safe margin. */
export const SLACK_UPDATE_MAX_BYTES = 3800;

/** Progressive fallback limits when Slack returns msg_too_long */
export const SLACK_MSG_TOO_LONG_FALLBACKS = [30000, 20000, 10000, 4000];

// ----------------------------------------------------------------------------
// Binary data stripping
// ----------------------------------------------------------------------------

/** Min length of base64 data (chars) before it gets stripped from context */
export const BASE64_STRIP_THRESHOLD = 1000;

// ----------------------------------------------------------------------------
// Process buffer
// ----------------------------------------------------------------------------

/** Max bytes to keep in stdout/stderr buffers (10 MB) */
export const PROCESS_BUFFER_MAX = 10 * 1024 * 1024;

// ----------------------------------------------------------------------------
// Subagent output file-as-memory
// ----------------------------------------------------------------------------

/** How many days to keep subagent output files before cleanup. */
export const SUBAGENT_OUTPUT_RETENTION_DAYS = 2;

// ----------------------------------------------------------------------------
// Model defaults
// ----------------------------------------------------------------------------

/** Default context window size when model doesn't specify one */
export const DEFAULT_CONTEXT_WINDOW = 200000;
