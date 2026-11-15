/**
 * Mechanism-layer settings: turn whatever the profile supplied into one frozen,
 * fully populated object. No I/O, no validation errors — bad numbers are clamped
 * and the defaults documented in the README win.
 */

const DEFAULT_ORDER = 270;
const DEFAULT_MAX_BYTES = 12288;
const DEFAULT_MAX_TOTAL_BYTES = 24576;
const MIN_MAX_BYTES = 256;

function positiveInteger(value, fallback, minimum) {
	const number = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
	return number < minimum ? minimum : number;
}

/** Normalize plugin config into the settings the rest of the plugin reads. */
export function normalizeSettings(config = {}) {
	const maxBytes = positiveInteger(config.maxBytes, DEFAULT_MAX_BYTES, MIN_MAX_BYTES);
	const maxTotalBytes = Math.max(maxBytes, positiveInteger(config.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, MIN_MAX_BYTES));
	return Object.freeze({
		enabled: config.enabled ?? true,
		order: typeof config.order === "number" && Number.isFinite(config.order) ? config.order : DEFAULT_ORDER,
		globalRoot: config.globalRoot ?? "~/.dsh/model-prompts",
		projectFile: config.projectFile ?? ".dsh/model-prompts.json",
		allowProject: config.allowProject ?? false,
		maxBytes,
		maxTotalBytes,
	});
}
