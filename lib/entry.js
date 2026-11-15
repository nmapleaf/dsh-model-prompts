/**
 * Entry validation. Produces a result instead of throwing so that the provider
 * boundary can turn a bad entry into one diagnostic and keep going.
 */

import { validPattern } from "./match.js";

const ENTRY_KEYS = new Set(["models", "position", "when", "text", "file"]);
const POSITIONS = new Set(["append", "prepend"]);
const WHEN_KEYS = new Set(["origin", "agentPreset", "delegationDepthMin"]);

function failure(where, message) {
	return { ok: false, reason: { where, message } };
}

/**
 * Validate one prompt entry.
 * @param raw - the parsed JSON value.
 * @param options.where - a human readable location for diagnostics.
 * @returns `{ ok: true, value }` or `{ ok: false, reason }`.
 */
export function validateEntry(raw, { where = "entry" } = {}) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return failure(where, "must be an object");

	for (const key of Object.keys(raw)) {
		if (!ENTRY_KEYS.has(key)) return failure(where, `unknown field ${JSON.stringify(key)}`);
	}

	const models = raw.models;
	if (!Array.isArray(models) || models.length === 0) return failure(where, '"models" must be a non-empty array');
	for (const pattern of models) {
		if (!validPattern(pattern)) return failure(where, `invalid model pattern ${JSON.stringify(pattern)}`);
	}
	if (!models.some((pattern) => !pattern.startsWith("!"))) {
		return failure(where, '"models" needs at least one pattern that is not an exclusion');
	}

	const position = raw.position === undefined ? "append" : raw.position;
	if (!POSITIONS.has(position)) return failure(where, '"position" must be "append" or "prepend"');

	let when;
	if (raw.when !== undefined) {
		const value = raw.when;
		if (value === null || typeof value !== "object" || Array.isArray(value)) return failure(where, '"when" must be an object');
		for (const key of Object.keys(value)) {
			if (!WHEN_KEYS.has(key)) return failure(where, `unknown "when" field ${JSON.stringify(key)}`);
		}
		const next = {};
		if (value.origin !== undefined) {
			if (typeof value.origin !== "string") return failure(where, '"when.origin" must be a string');
			const origin = value.origin.trim();
			if (origin !== "") next.origin = origin;
		}
		if (value.agentPreset !== undefined) {
			if (typeof value.agentPreset !== "string") return failure(where, '"when.agentPreset" must be a string');
			const preset = value.agentPreset.trim();
			if (preset !== "") next.agentPreset = preset;
		}
		if (value.delegationDepthMin !== undefined) {
			const depth = value.delegationDepthMin;
			if (!(typeof depth === "number" && Number.isFinite(depth) && depth >= 0)) {
				return failure(where, '"when.delegationDepthMin" must be a non-negative number');
			}
			next.delegationDepthMin = depth;
		}
		if (Object.keys(next).length > 0) when = next;
	}

	const hasText = raw.text !== undefined;
	const hasFile = raw.file !== undefined;
	if (hasText === hasFile) return failure(where, 'exactly one of "text" or "file" is required');
	if (hasText && (typeof raw.text !== "string" || raw.text.trim() === "")) {
		return failure(where, '"text" must be a non-empty string');
	}
	if (hasFile && (typeof raw.file !== "string" || raw.file.trim() === "")) {
		return failure(where, '"file" must be a non-empty path');
	}

	return {
		ok: true,
		value: {
			models: [...models],
			position,
			...(when === undefined ? {} : { when }),
			...(hasText ? { text: raw.text.trim() } : { file: raw.file.trim() }),
		},
	};
}

/**
 * Identity used to detect the same entry supplied by two layers.
 * The selector is part of the identity: two entries with the same body but
 * different `models`/`position`/`when` are different entries.
 */
export function identityOf(entry, resolvedFile) {
	const selector = JSON.stringify([entry.models, entry.position, entry.when ?? null]);
	return entry.file === undefined
		? `text:${selector}:${entry.text}`
		: `file:${selector}:${resolvedFile ?? entry.file}`;
}
