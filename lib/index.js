/**
 * Boundary layer: register one runtime-context provider, absorb every failure,
 * and report at most one error and one info line per session.
 *
 * The provider never throws. `resolveContext` call sites in
 * `@deepseek-ai/dsh-system-prompt` have no try/catch, so a throw here would
 * abort the whole turn instead of degrading this plugin.
 */

import z from "@deepseek-ai/schemastery";
import { describeError } from "./errors.js";
import { collect } from "./layers.js";
import { selectEntries } from "./match.js";
import { renderEntries } from "./render.js";
import { normalizeSettings } from "./settings.js";

/** Cordis plugin name. */
export const name = "model-prompts";

/** Runtime-context owner. */
export const inject = ["systemPrompt"];

/** Mechanism-layer schema; see docs/DESIGN.md §2.1. */
export const Config = z.object({
	enabled: z.boolean().default(true),
	order: z.number().default(270),
	globalRoot: z.string().default("~/.dsh/model-prompts"),
	projectFile: z.string().default(".dsh/model-prompts.json"),
	allowProject: z.boolean().default(false),
	maxBytes: z.number().default(12288),
	maxTotalBytes: z.number().default(24576),
});

const CONTEXT_NAME = "model-prompts";
const ALREADY_REGISTERED = "already registered";
const MAX_DIAGNOSTICS = 5;

function say(ctx, level, message) {
	try {
		ctx.logger?.[level]?.(message);
	} catch {
		// Logging is best effort; a missing logger must never break assembly.
	}
}

/**
 * Register the per-model prompt context for this plugin instance.
 * @param ctx - the plugin context, scoped or global.
 * @param config - mechanism-layer settings.
 */
export function apply(ctx, config) {
	const settings = normalizeSettings(config);
	if (!settings.enabled) return;

	let errors = 0;
	let informed = false;
	const reported = new Set();

	const fail = (message) => {
		// Each distinct diagnostic once, and a hard cap so a broken directory
		// cannot flood the log. The provider still returns "" instead of throwing.
		if (reported.has(message) || errors >= MAX_DIAGNOSTICS) return;
		reported.add(message);
		errors += 1;
		say(ctx, "warn", `model-prompts: ${message}`);
	};

	const render = (context) => {
		try {
			const selection = context?.modelSelection;
			if (selection === undefined) return "";
			const header = context?.agent?.session?.header;
			const collected = collect(settings, header?.cwd);
			for (const diagnostic of collected.diagnostics) {
				fail(diagnostic.where === undefined ? diagnostic.message : `${diagnostic.where}: ${diagnostic.message}`);
			}
			if (!informed) {
				informed = true;
				say(
					ctx,
					"info",
					`model-prompts: ${collected.entries.length} entr${collected.entries.length === 1 ? "y" : "ies"} loaded (${collected.bytes} bytes) from ${settings.globalRoot}${settings.allowProject ? " + project layer" : ""}`,
				);
			}
			return renderEntries(selectEntries(collected.entries, selection, header));
		} catch (error) {
			fail(describeError(error));
			return "";
		}
	};

	ctx.effect(() => {
		try {
			return ctx.systemPrompt.context({
				name: CONTEXT_NAME,
				order: settings.order,
				interpolate: false,
				required: true,
				text: render,
			});
		} catch (error) {
			// A reload legitimately re-registers the same name; every other
			// registration failure stays loud (docs/DESIGN.md §0 invariant 6).
			if (String(error?.message ?? error).includes(ALREADY_REGISTERED)) {
				say(ctx, "warn", `model-prompts: context "${CONTEXT_NAME}" is already registered; keeping the existing one`);
				return () => {};
			}
			throw error;
		}
	}, "model-prompts.context()");
}
