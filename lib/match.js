/**
 * Model matching, ported verbatim in behaviour from the pi extension
 * `proper-model-prompts` (`model-prompts.ts:73-118`).
 *
 * A pattern is split on `*`, every other character is escaped, and the parts are
 * rejoined with `.*`, anchored and case insensitive. A pattern matches either
 * `provider/model` or the bare model id. A leading `!` marks an exclusion; an
 * entry is selected when at least one non-exclusion pattern matches and no
 * exclusion pattern matches.
 */

const REGEXP_SPECIALS = /[.+?^${}()|[\]\\]/g;
const compiled = new Map();

function compile(pattern) {
	const cached = compiled.get(pattern);
	if (cached !== undefined) return cached;
	const source = pattern
		.split("*")
		.map((part) => part.replace(REGEXP_SPECIALS, "\\$&"))
		.join(".*");
	const value = new RegExp(`^${source}$`, "i");
	if (compiled.size < 256) compiled.set(pattern, value);
	return value;
}

/** A pattern is usable when it is a non-empty string whose body is non-empty. */
export function validPattern(pattern) {
	if (typeof pattern !== "string") return false;
	const body = pattern.startsWith("!") ? pattern.slice(1) : pattern;
	return body.length > 0;
}

/** Test one pattern against one model selection. */
export function matchesModel(pattern, model) {
	if (!validPattern(pattern) || model === undefined || model === null) return false;
	const body = pattern.startsWith("!") ? pattern.slice(1) : pattern;
	const test = compile(body);
	if (typeof model.provider === "string" && typeof model.model === "string") {
		if (test.test(`${model.provider}/${model.model}`)) return true;
	}
	return typeof model.model === "string" && test.test(model.model);
}

/** Apply inclusion and exclusion patterns to one model selection. */
export function selectsModel(patterns, model) {
	let included = false;
	let excluded = false;
	for (const pattern of patterns) {
		if (pattern.startsWith("!")) {
			if (matchesModel(pattern, model)) excluded = true;
		} else if (matchesModel(pattern, model)) {
			included = true;
		}
	}
	return included && !excluded;
}

/**
 * Evaluate an entry's `when` block against the session header.
 * All three keys are optional and combine with AND; a missing `when` always applies.
 */
export function appliesTo(entry, header) {
	const when = entry.when;
	if (when === undefined) return true;
	if (when.origin !== undefined && header?.origin !== when.origin) return false;
	if (when.agentPreset !== undefined && header?.agentPreset !== when.agentPreset) return false;
	if (when.delegationDepthMin !== undefined && (header?.delegationDepth ?? 0) < when.delegationDepthMin) return false;
	return true;
}

/** Select the entries that apply to this request. */
export function selectEntries(entries, model, header) {
	return entries.filter((entry) => appliesTo(entry, header) && selectsModel(entry.models, model));
}
