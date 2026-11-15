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
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { ConfigError } from "./errors.js";
import { identityOf, validateEntry } from "./entry.js";

const CACHE = new Map();
const CACHE_LIMIT = 64;

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
		stat = statSync(absolute);
	} catch (error) {
		if (error?.code === "ENOENT") throw new ConfigError("file does not exist", { where: absolute, missing: true });
		throw new ConfigError(`cannot stat file (${error?.code ?? String(error)})`, { where: absolute });
	}
	// A FIFO or device would block `readFileSync` forever; refuse before opening.
	if (!stat.isFile()) throw new ConfigError("not a regular file", { where: absolute });
	if (stat.size > maxBytes) throw new ConfigError(`file is ${stat.size} bytes, limit is ${maxBytes}`, { where: absolute });
	return stat;
}

function readBody(absolute, maxBytes) {
	const stat = statFile(absolute, maxBytes);
	const cached = CACHE.get(absolute);
	if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.text;
	const text = readFileSync(absolute, "utf8");
	if (CACHE.size >= CACHE_LIMIT) CACHE.clear();
	CACHE.set(absolute, { mtimeMs: stat.mtimeMs, size: stat.size, text });
	return text;
}

/** Drop every cached body. Used by tests. */
export function clearBodyCache() {
	CACHE.clear();
}

function realRoot(directory) {
	try {
		return realpathSync(directory);
	} catch {
		return undefined;
	}
}

function resolvePromptFile(file, baseDirectory, root, maxBytes) {
	const expanded = expandHome(file);
	const target = isAbsolute(expanded) ? expanded : resolve(baseDirectory, expanded);
	let real;
	try {
		real = realpathSync(target);
	} catch (error) {
		if (error?.code === "ENOENT") throw new ConfigError("prompt file does not exist", { where: target });
		throw new ConfigError(`cannot resolve prompt file (${error?.code ?? String(error)})`, { where: target });
	}
	if (root === undefined) throw new ConfigError("layer root is unavailable", { where: target });
	if (!isInside(root, real)) throw new ConfigError(`prompt file escapes ${root}`, { where: real });
	return readBody(real, maxBytes);
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
	return names
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
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
	const seen = new Set();
	let bytes = 0;
	let truncated = false;

	const admit = (candidate, { where, baseDirectory, root, layer }) => {
		const result = validateEntry(candidate, { where });
		if (!result.ok) {
			diagnostics.push(result.reason);
			return;
		}
		const entry = result.value;
		let body;
		try {
			body = entry.file === undefined ? entry.text : resolvePromptFile(entry.file, baseDirectory, root, settings.maxBytes);
		} catch (error) {
			diagnostics.push({ where, message: error instanceof Error ? error.message : String(error) });
			return;
		}
		const trimmed = body.trim();
		if (trimmed === "") {
			diagnostics.push({ where, message: "entry resolves to an empty body" });
			return;
		}
		const identity = identityOf(entry);
		if (seen.has(identity)) {
			diagnostics.push({ where, message: "duplicate of an entry already provided by an earlier layer" });
			return;
		}
		const size = Buffer.byteLength(trimmed, "utf8");
		if (bytes + size > settings.maxTotalBytes) {
			truncated = true;
			return;
		}
		seen.add(identity);
		bytes += size;
		entries.push({ ...entry, body: trimmed, layer });
	};

	const globalRoot = realRoot(expandHome(settings.globalRoot));
	if (globalRoot !== undefined) {
		for (const file of listConfigFiles(globalRoot)) {
			let prompts;
			try {
				prompts = readConfigFile(file, settings.maxBytes);
			} catch (error) {
				diagnostics.push({ where: file, message: error instanceof Error ? error.message : String(error) });
				continue;
			}
			prompts.forEach((candidate, index) => admit(candidate, {
				where: `${file}#prompts[${index}]`,
				baseDirectory: globalRoot,
				root: globalRoot,
				layer: "global",
			}));
		}
	}

	if (settings.allowProject && typeof cwd === "string" && cwd !== "") {
		const projectRoot = realRoot(cwd);
		const file = resolve(cwd, settings.projectFile);
		if (projectRoot !== undefined) {
			try {
				const prompts = readConfigFile(file, settings.maxBytes);
				prompts.forEach((candidate, index) => admit(candidate, {
					where: `${file}#prompts[${index}]`,
					baseDirectory: projectRoot,
					root: projectRoot,
					layer: "project",
				}));
			} catch (error) {
				if (error?.missing !== true) {
					// A missing project file is the normal case; anything else is a diagnostic.
					diagnostics.push({ where: file, message: error instanceof Error ? error.message : String(error) });
				}
			}
		}
	}

	if (truncated) diagnostics.push({ where: "total", message: `body budget exhausted at ${settings.maxTotalBytes} bytes; later entries were dropped` });

	return { entries, bytes, diagnostics };
}
