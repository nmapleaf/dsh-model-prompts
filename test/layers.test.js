import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect } from "../lib/layers.js";
import { normalizeSettings } from "../lib/settings.js";

const temporary = [];

after(() => {
	for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

function sandbox() {
	const root = mkdtempSync(join(tmpdir(), "model-prompts-"));
	temporary.push(root);
	const globalRoot = join(root, "global");
	mkdirSync(globalRoot, { recursive: true });
	return { root, globalRoot };
}

function writeJson(directory, name, value) {
	const file = join(directory, name);
	writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), "utf8");
	return file;
}

test("a missing global root is silent", () => {
	const { root } = sandbox();
	const settings = normalizeSettings({ globalRoot: join(root, "absent") });
	const collected = collect(settings, undefined);
	assert.deepEqual(collected.entries, []);
	assert.deepEqual(collected.diagnostics, []);
});

test("loads every json file in basename order and ignores the rest", () => {
	const { globalRoot } = sandbox();
	writeJson(globalRoot, "b.json", { prompts: [{ models: ["*"], text: "second" }] });
	writeJson(globalRoot, "a.json", { prompts: [{ models: ["*"], text: "first" }] });
	writeJson(globalRoot, "notes.txt", { prompts: [{ models: ["*"], text: "ignored" }] });
	mkdirSync(join(globalRoot, "nested"));
	writeJson(join(globalRoot, "nested"), "n.json", { prompts: [{ models: ["*"], text: "ignored" }] });

	const collected = collect(normalizeSettings({ globalRoot }), undefined);
	assert.deepEqual(collected.entries.map((entry) => entry.body), ["first", "second"]);
	assert.equal(collected.entries[0].layer, "global");
	assert.deepEqual(collected.diagnostics, []);
});

test("a global config symlinked out of the layer root is refused", () => {
	const { root, globalRoot } = sandbox();
	writeJson(root, "outside.json", { prompts: [{ models: ["*"], text: "leaked" }] });
	symlinkSync(join(root, "outside.json"), join(globalRoot, "linked.json"));

	const collected = collect(normalizeSettings({ globalRoot }), undefined);
	assert.equal(collected.entries.length, 0);
	assert.match(collected.diagnostics[0].message, /escapes/);
});

test("invalid JSON and bad shapes become diagnostics, never throws", () => {	const { globalRoot } = sandbox();
	writeJson(globalRoot, "broken.json", "{ not json");
	const collected = collect(normalizeSettings({ globalRoot }), undefined);
	assert.equal(collected.entries.length, 0);
	assert.match(collected.diagnostics[0].message, /invalid JSON/);
});

test("a removed built-in switch is explained", () => {
	const { globalRoot } = sandbox();
	writeJson(globalRoot, "old.json", { defaults: true, prompts: [] });
	const collected = collect(normalizeSettings({ globalRoot }), undefined);
	assert.match(collected.diagnostics[0].message, /built-in prompt blocks were removed/);
});

test("file bodies resolve against the layer root and are trimmed", () => {
	const { globalRoot } = sandbox();
	mkdirSync(join(globalRoot, "prompts"));
	writeFileSync(join(globalRoot, "prompts", "one.md"), "\n  body text  \n", "utf8");
	writeJson(globalRoot, "c.json", { prompts: [{ models: ["*"], file: "prompts/one.md" }] });

	const collected = collect(normalizeSettings({ globalRoot }), undefined);
	assert.equal(collected.entries[0].body, "body text");
});

test("a missing prompt file is a diagnostic", () => {
	const { globalRoot } = sandbox();
	writeJson(globalRoot, "c.json", { prompts: [{ models: ["*"], file: "nope.md" }] });
	const collected = collect(normalizeSettings({ globalRoot }), undefined);
	assert.match(collected.diagnostics[0].message, /prompt file does not exist/);
});

test("a symlink that escapes the layer root is refused", () => {
	const { root, globalRoot } = sandbox();
	writeFileSync(join(root, "outside.md"), "secret", "utf8");
	symlinkSync(join(root, "outside.md"), join(globalRoot, "link.md"));
	writeJson(globalRoot, "c.json", { prompts: [{ models: ["*"], file: "link.md" }] });

	const collected = collect(normalizeSettings({ globalRoot }), undefined);
	assert.equal(collected.entries.length, 0);
	assert.match(collected.diagnostics[0].message, /escapes/);
});

test("a non-regular file is refused instead of blocking the read", (t) => {
	const { globalRoot } = sandbox();
	const fifo = join(globalRoot, "pipe.md");
	try {
		execFileSync("mkfifo", [fifo]);
	} catch {
		t.skip("mkfifo is unavailable");
		return;
	}
	writeJson(globalRoot, "c.json", { prompts: [{ models: ["*"], file: "pipe.md" }] });

	const collected = collect(normalizeSettings({ globalRoot }), undefined);
	assert.match(collected.diagnostics[0].message, /not a regular file/);
});

test("an oversized file names the limit", () => {
	const { globalRoot } = sandbox();
	writeFileSync(join(globalRoot, "big.md"), "x".repeat(600), "utf8");
	writeJson(globalRoot, "c.json", { prompts: [{ models: ["*"], file: "big.md" }] });

	const collected = collect(normalizeSettings({ globalRoot, maxBytes: 256 }), undefined);
	assert.match(collected.diagnostics[0].message, /limit is 256/);
});

test("an empty body is rejected", () => {
	const { globalRoot } = sandbox();
	writeFileSync(join(globalRoot, "empty.md"), "   \n", "utf8");
	writeJson(globalRoot, "c.json", { prompts: [{ models: ["*"], file: "empty.md" }] });

	const collected = collect(normalizeSettings({ globalRoot }), undefined);
	assert.match(collected.diagnostics[0].message, /empty body/);
});

test("the total budget drops later entries", () => {
	const { globalRoot } = sandbox();
	writeFileSync(join(globalRoot, "big.md"), "a".repeat(1100), "utf8");
	writeJson(globalRoot, "c.json", {
		prompts: [
			{ models: ["*"], file: "big.md" },
			{ models: ["*"], text: "b".repeat(1100) },
		],
	});

	const collected = collect(normalizeSettings({ globalRoot, maxBytes: 2000, maxTotalBytes: 2000 }), undefined);
	assert.equal(collected.entries.length, 1);
	assert.match(collected.diagnostics.at(-1).message, /body budget exhausted/);
});

test("the project layer stays off unless allowed", () => {
	const { root, globalRoot } = sandbox();
	const project = join(root, "project");
	mkdirSync(join(project, ".dsh"), { recursive: true });
	writeJson(join(project, ".dsh"), "model-prompts.json", { prompts: [{ models: ["*"], text: "project" }] });

	const off = collect(normalizeSettings({ globalRoot }), project);
	assert.equal(off.entries.length, 0);

	// Without a schema (a `link:` install), a string is not a boolean: "false"
	// must not open a prompt-injection surface.
	const stringly = collect(normalizeSettings({ globalRoot, allowProject: "false" }), project);
	assert.equal(stringly.entries.length, 0);

	const on = collect(normalizeSettings({ globalRoot, allowProject: true }), project);
	assert.deepEqual(on.entries.map((entry) => entry.body), ["project"]);
	assert.equal(on.entries[0].layer, "project");
});

test("a project file must stay inside the project root", () => {
	const { root, globalRoot } = sandbox();
	const project = join(root, "project");
	mkdirSync(join(project, ".dsh"), { recursive: true });
	writeFileSync(join(root, "outside.md"), "secret", "utf8");
	symlinkSync(join(root, "outside.md"), join(project, ".dsh", "link.md"));
	writeJson(join(project, ".dsh"), "model-prompts.json", { prompts: [{ models: ["*"], file: "link.md" }] });

	const collected = collect(normalizeSettings({ globalRoot, allowProject: true }), project);
	assert.equal(collected.entries.length, 0);
	assert.match(collected.diagnostics[0].message, /escapes/);
});

test("project file references resolve against the config file's directory", () => {
	const { root, globalRoot } = sandbox();
	const project = join(root, "project");
	// The layer root is the project itself, but `file` is relative to `.dsh/`.
	mkdirSync(join(project, "prompts"), { recursive: true });
	writeFileSync(join(project, "prompts", "wrong.md"), "wrong", "utf8");
	mkdirSync(join(project, ".dsh", "prompts"), { recursive: true });
	writeFileSync(join(project, ".dsh", "prompts", "right.md"), "right", "utf8");
	writeJson(join(project, ".dsh"), "model-prompts.json", { prompts: [{ models: ["*"], file: "prompts/right.md" }] });

	const collected = collect(normalizeSettings({ globalRoot, allowProject: true }), project);
	assert.deepEqual(collected.entries.map((entry) => entry.body), ["right"]);
});

test("a project file may only add, not shadow", () => {
	const { root, globalRoot } = sandbox();
	writeJson(globalRoot, "a.json", { prompts: [{ models: ["*"], text: "same text" }] });
	const project = join(root, "project");
	mkdirSync(join(project, ".dsh"), { recursive: true });
	writeJson(join(project, ".dsh"), "model-prompts.json", { prompts: [{ models: ["*"], text: "same text" }] });

	const collected = collect(normalizeSettings({ globalRoot, allowProject: true }), project);
	assert.equal(collected.entries.length, 1);
	assert.equal(collected.entries[0].layer, "global");
	assert.match(collected.diagnostics.at(-1).message, /duplicate/);
});

test("an edited body is re-read on the next collect", () => {
	const { globalRoot } = sandbox();
	writeFileSync(join(globalRoot, "one.md"), "before", "utf8");
	writeJson(globalRoot, "c.json", { prompts: [{ models: ["*"], file: "one.md" }] });
	const settings = normalizeSettings({ globalRoot });

	assert.equal(collect(settings, undefined).entries[0].body, "before");
	writeFileSync(join(globalRoot, "one.md"), "after, longer", "utf8");
	assert.equal(collect(settings, undefined).entries[0].body, "after, longer");
});

test("a same-size rewrite is still re-read", () => {
	const { globalRoot } = sandbox();
	writeFileSync(join(globalRoot, "one.md"), "aaaa", "utf8");
	writeJson(globalRoot, "c.json", { prompts: [{ models: ["*"], file: "one.md" }] });
	const settings = normalizeSettings({ globalRoot });

	assert.equal(collect(settings, undefined).entries[0].body, "aaaa");
	writeFileSync(join(globalRoot, "one.md"), "bbbb", "utf8");
	assert.equal(collect(settings, undefined).entries[0].body, "bbbb");
});

test("a layer may repeat a body for a different model", () => {
	const { globalRoot } = sandbox();
	writeJson(globalRoot, "c.json", {
		prompts: [
			{ models: ["anthropic/*"], text: "shared" },
			{ models: ["openai/*"], text: "shared" },
		],
	});

	const collected = collect(normalizeSettings({ globalRoot }), undefined);
	assert.deepEqual(collected.entries.map((entry) => entry.body), ["shared", "shared"]);
	assert.deepEqual(collected.diagnostics, []);
});

test("once the budget is exhausted later entries are dropped", () => {
	const { globalRoot } = sandbox();
	writeFileSync(join(globalRoot, "big.md"), "a".repeat(1100), "utf8");
	writeJson(globalRoot, "c.json", {
		prompts: [
			{ models: ["*"], file: "big.md" },
			{ models: ["*"], text: "b".repeat(1100) },
			{ models: ["*"], text: "small" },
		],
	});

	const collected = collect(normalizeSettings({ globalRoot, maxBytes: 2000, maxTotalBytes: 2000 }), undefined);
	assert.equal(collected.entries.length, 1);
	assert.match(collected.diagnostics.at(-1).message, /body budget exhausted/);
});

test("an unreadable file is a diagnostic", (t) => {
	if (typeof process.getuid === "function" && process.getuid() === 0) {
		t.skip("root ignores file permissions");
		return;
	}
	const { globalRoot } = sandbox();
	const locked = join(globalRoot, "locked.md");
	writeFileSync(locked, "secret", "utf8");
	writeJson(globalRoot, "c.json", { prompts: [{ models: ["*"], file: "locked.md" }] });
	chmodSync(locked, 0o000);

	const collected = collect(normalizeSettings({ globalRoot }), undefined);
	chmodSync(locked, 0o600);
	assert.equal(collected.entries.length, 0);
	assert.match(collected.diagnostics[0].message, /cannot read file \(EACCES\)/);
});

test("the project config file itself may not point outside the project", () => {	const { root, globalRoot } = sandbox();
	const project = join(root, "project");
	mkdirSync(join(project, ".dsh"), { recursive: true });
	writeJson(root, "outside.json", { prompts: [{ models: ["*"], text: "leaked" }] });
	symlinkSync(join(root, "outside.json"), join(project, ".dsh", "model-prompts.json"));

	const collected = collect(normalizeSettings({ globalRoot, allowProject: true }), project);
	assert.equal(collected.entries.length, 0);
	assert.match(collected.diagnostics[0].message, /escapes/);
});
