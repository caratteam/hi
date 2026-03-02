// ============================================================================
// Centralized magic numbers for the mom package.
// All size/threshold constants live here for easy tuning.
// ============================================================================

// ----------------------------------------------------------------------------
// Slack message limits
// ----------------------------------------------------------------------------

/** Slack's max text length for chat.postMessage / chat.update is 40000. Use a safe margin. */
export const SLACK_MAX_TEXT = 39000;

/** Progressive fallback limits when Slack returns msg_too_long */
export const SLACK_MSG_TOO_LONG_FALLBACKS = [30000, 20000, 10000, 4000];

// ----------------------------------------------------------------------------
// Tool result truncation (old context messages)
// ----------------------------------------------------------------------------

/** Threshold in bytes for truncating old tool results */
export const TRUNCATE_THRESHOLD = 4096;

/** Number of recent messages to keep at full size (roughly 2 turns of user+assistant+toolResults) */
export const FULL_CONTEXT_RECENT = 6;

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
// Model defaults
// ----------------------------------------------------------------------------

/** Default context window size when model doesn't specify one */
export const DEFAULT_CONTEXT_WINDOW = 200000;
