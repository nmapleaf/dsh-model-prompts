/**
 * The I/O zone: read the global and project layers, resolve `file` references
 * safely, cache file bodies, and merge the layers.
 *
 * Every path passes `expand -> realpath -> contains(root) -> stat -> isFile -> size`
 * before its bytes are used. Nothing here is allowed to throw past the caller:
 * the provider boundary folds failures into diagnostics.
 */

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { ConfigError } from "./errors.js";
import { identityOf, validateEntry } from "./entry.js";

/** Expand a leading `~` or `~/`. */
export function expandHome(value) {
	if (value === "~") return homedir();
	if (value.startsWith(`~${sep}`) || value.startsWith("~/")) return join(homedir(), value.slice(2));
	return value;
}

function isInside(root, target) {
	return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

function statFile(absolute, maxBytes) {
	let stat;
	try {
		// BigInt stats give nanosecond mtimes, so a same-size rewrite is still seen.
		stat = statSync(absolute, { bigint: true });
	} catch (error) {
		if (error?.code === "ENOENT") throw new ConfigError("file does not exist", { where: absolute, missing: true });
		throw new ConfigError(`cannot stat file (${error?.code ?? String(error)})`, { where: absolute });
	}
	// A FIFO or device would block `readFileSync` forever; refuse before opening.
	if (!stat.isFile()) throw new ConfigError("not a regular file", { where: absolute });
	const size = Number(stat.size);
	if (size > maxBytes) throw new ConfigError(`file is ${size} bytes, limit is ${maxBytes}`, { where: absolute });
}

/**
 * Read one file's body, refusing anything that is not a regular file within
 * the size limit.
 *
 * Deliberately uncached: timestamps are too coarse to prove a body unchanged
 * (a same-size rewrite can keep its mtime), and an unproven cache silently
 * defeats "the next request sees your edit". These files are bounded by
 * `maxBytes`, so re-reading them per step costs microseconds.
 */
function readBody(absolute, maxBytes) {
	statFile(absolute, maxBytes);
	try {
		return readFileSync(absolute, "utf8");
	} catch (error) {
		throw new ConfigError(`cannot read file (${error?.code ?? String(error)})`, { where: absolute });
	}
}

function realRoot(directory) {
	try {
		return realpathSync(directory);
	} catch {
		return undefined;
	}
}

function realFile(target, label) {
	let real;
	try {
		real = realpathSync(target);
	} catch (error) {
		if (error?.code === "ENOENT") throw new ConfigError(`${label} does not exist`, { where: target, missing: true });
		throw new ConfigError(`cannot resolve ${label} (${error?.code ?? String(error)})`, { where: target });
	}
	return real;
}

function resolvePromptFile(file, baseDirectory, root, maxBytes) {
	const expanded = expandHome(file);
	const target = isAbsolute(expanded) ? expanded : resolve(baseDirectory, expanded);
	const real = realFile(target, "prompt file");
	if (root === undefined) throw new ConfigError("layer root is unavailable", { where: real });
	if (!isInside(root, real)) throw new ConfigError(`prompt file escapes ${root}`, { where: real });
	return { text: readBody(real, maxBytes), absolute: real };
}

function readConfigFile(absolute, maxBytes) {
	let parsed;
	try {
		parsed = JSON.parse(readBody(absolute, maxBytes));
	} catch (error) {
		if (error instanceof ConfigError) throw error;
		throw new ConfigError(`invalid JSON (${error instanceof Error ? error.message : String(error)})`, { where: absolute });
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ConfigError("top level must be an object", { where: absolute });
	}
	for (const key of Object.keys(parsed)) {
		if (key !== "prompts") {
			const hint =
				key === "defaults" || key === "offerForegroundSubagents"
					? "; built-in prompt blocks were removed, put the text you need into \"prompts\" explicitly"
					: "";
			throw new ConfigError(`unknown top-level key ${JSON.stringify(key)}${hint}`, { where: absolute });
		}
	}
	if (!Array.isArray(parsed.prompts)) throw new ConfigError('"prompts" must be an array', { where: absolute });
	return parsed.prompts;
}

function listConfigFiles(directory) {
	let names;
	try {
		names = readdirSync(directory, { withFileTypes: true });
	} catch (error) {
		if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
		throw new ConfigError(`cannot read directory (${error?.code ?? String(error)})`, { where: directory });
	}
	// Symlinks are listed too: `statFile` then decides, so the result is a
	// diagnostic rather than a silently ignored file.
	return names
		.filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".json"))
		.map((entry) => join(directory, entry.name))
		.sort((a, b) => basename(a) < basename(b) ? -1 : basename(a) > basename(b) ? 1 : 0);
}

/**
 * Collect every prompt that applies to this request.
 * @param settings - normalized plugin settings.
 * @param cwd - the session working directory, used for the project layer.
 * @returns `{ entries, bytes, diagnostics }`; `entries[].body` is already resolved.
 */
export function collect(settings, cwd) {
	const diagnostics = [];
	const entries = [];
	// Identities admitted by earlier layers only: a layer may repeat itself,
	// a later layer may not repeat an earlier one.
	const seen = new Set();
	let bytes = 0;
	let truncated = false;

	const admit = (candidate, { where, baseDirectory, root, layer, identities }) => {
		if (truncated) return;
		const result = validateEntry(candidate, { where });
		if (!result.ok) {
			diagnostics.push(result.reason);
			return;
		}
		const entry = result.value;
		let body;
		let resolvedFile;
		try {
			if (entry.file === undefined) {
				body = entry.text;
			} else {
				const resolved = resolvePromptFile(entry.file, baseDirectory, root, settings.maxBytes);
				body = resolved.text;
				resolvedFile = resolved.absolute;
			}
		} catch (error) {
			diagnostics.push({ where, message: error instanceof Error ? error.message : String(error) });
			return;
		}
		const trimmed = body.trim();
		if (trimmed === "") {
			diagnostics.push({ where, message: "entry resolves to an empty body" });
			return;
		}
		const identity = identityOf(entry, resolvedFile);
		if (seen.has(identity)) {
			diagnostics.push({ where, message: "duplicate of an entry already provided by an earlier layer" });
			return;
		}
		const size = Buffer.byteLength(trimmed, "utf8");
		if (bytes + size > settings.maxTotalBytes) {
			truncated = true;
			return;
		}
		identities.push(identity);
		bytes += size;
		entries.push({ ...entry, body: trimmed, layer });
	};

	const globalRoot = realRoot(expandHome(settings.globalRoot));
	if (globalRoot !== undefined) {
		const identities = [];
		for (const file of listConfigFiles(globalRoot)) {
			let prompts;
			let real;
			try {
				real = realFile(file, "config file");
				if (!isInside(globalRoot, real)) throw new ConfigError(`config file escapes ${globalRoot}`, { where: real });
				prompts = readConfigFile(real, settings.maxBytes);
			} catch (error) {
				diagnostics.push({ where: real ?? file, message: error instanceof Error ? error.message : String(error) });
				continue;
			}
			prompts.forEach((candidate, index) => admit(candidate, {
				where: `${real}#prompts[${index}]`,
				baseDirectory: dirname(real),
				root: globalRoot,
				layer: "global",
				identities,
			}));
		}
		for (const identity of identities) seen.add(identity);
	}

	if (settings.allowProject && typeof cwd === "string" && cwd !== "") {
		const projectRoot = realRoot(cwd);
		if (projectRoot !== undefined) {
			const identities = [];
			let target;
			try {
				target = resolve(cwd, settings.projectFile);
				const real = realFile(target, "project config");
				if (!isInside(projectRoot, real)) throw new ConfigError(`project config escapes ${projectRoot}`, { where: real });
				const prompts = readConfigFile(real, settings.maxBytes);
				prompts.forEach((candidate, index) => admit(candidate, {
					where: `${real}#prompts[${index}]`,
					baseDirectory: dirname(real),
					root: projectRoot,
					layer: "project",
					identities,
				}));
				for (const identity of identities) seen.add(identity);
			} catch (error) {
				if (error?.missing !== true) {
					// A missing project file is the normal case; anything else is a diagnostic.
					diagnostics.push({ where: target ?? "project", message: error instanceof Error ? error.message : String(error) });
				}
			}
		}
	}

	if (truncated) diagnostics.push({ where: "total", message: `body budget exhausted at ${settings.maxTotalBytes} bytes; later entries were dropped` });

	return { entries, bytes, diagnostics };
}
