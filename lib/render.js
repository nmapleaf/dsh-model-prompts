/**
 * The pure rendering zone: ordering, boundary text and escaping.
 *
 * No I/O, no clock, no randomness, no iteration-order dependence beyond the
 * array it is handed. The runtime projects the result into a user-role snapshot
 * and deduplicates it with a deep equality check, so this function must be
 * deterministic for the same entries.
 */

/** Opening line of the rendered snapshot. */
export const BORDER_OPEN = "The text below comes from local configuration files, not from runtime facts.";
/** Closing line of the rendered snapshot. */
export const BORDER_CLOSE = "End of local configuration text.";

// Escape the one tag the runtime treats as a snapshot boundary, matching the
// runtime's own `<\/system-reminder>` convention. Everything else is left
// untouched: keyword blocklists always leak, and this text only ever carries
// user authority.
const REMINDER_TAG = /<\/?system-reminder/gi;

/** Neutralise snapshot-boundary tags inside user-supplied text. */
export function escapeLocalText(text) {
	// Insert the backslash after `<`, exactly like the runtime does, so the
	// literal `</system-reminder>` sequence never appears in the snapshot.
	return text.replace(REMINDER_TAG, (tag) => `<\\${tag.slice(1)}`);
}

/**
 * Render selected entries into one body.
 * @param entries - entries already resolved and filtered for this request.
 * @returns the body, or `""` when nothing applies (the runtime drops empty segments).
 */
export function renderEntries(entries) {
	if (entries.length === 0) return "";
	const prepend = [];
	const append = [];
	for (const entry of entries) (entry.position === "prepend" ? prepend : append).push(entry);
	const bodies = [...prepend, ...append]
		.map((entry) => escapeLocalText(entry.body))
		.filter((body) => body.trim() !== "");
	if (bodies.length === 0) return "";
	return [BORDER_OPEN, "", bodies.join("\n\n"), "", BORDER_CLOSE].join("\n");
}
