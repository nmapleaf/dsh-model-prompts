/**
 * Configuration problems that are reported once and never abort a step.
 *
 * Nothing here is ever thrown at the runtime-context provider boundary: the
 * provider converts every failure into an empty body plus one diagnostic.
 */
export class ConfigError extends Error {
	constructor(message, options = {}) {
		super(message);
		this.name = "ConfigError";
		this.where = options.where;
		/** true when the target simply does not exist (a normal, quiet case). */
		this.missing = options.missing === true;
	}
}

/** Render a human readable one-line reason for a diagnostic. */
export function describeError(error) {
	if (error instanceof ConfigError) return error.where ? `${error.where}: ${error.message}` : error.message;
	if (error instanceof Error) return error.message;
	return String(error);
}
