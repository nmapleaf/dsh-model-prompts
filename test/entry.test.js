import test from "node:test";
import assert from "node:assert/strict";
import { identityOf, validateEntry } from "../lib/entry.js";

const where = "config.json#prompts[0]";

test("accepts a minimal text entry", () => {
	const result = validateEntry({ models: ["*"], text: "be brief" }, { where });
	assert.equal(result.ok, true);
	assert.equal(result.value.text, "be brief");
	assert.equal(result.value.position, "append");
	assert.equal(identityOf(result.value).startsWith("text:"), true);
	assert.equal(identityOf(result.value).endsWith(":be brief"), true);
});

test("trims the body and rejects an empty one", () => {
	const ok = validateEntry({ models: ["*"], text: "  padded  " }, { where });
	assert.equal(ok.value.text, "padded");
	const empty = validateEntry({ models: ["*"], text: "   " }, { where });
	assert.equal(empty.ok, false);
	assert.match(empty.reason.message, /non-empty string/);
});

test("requires a non-empty models array of strings", () => {
	for (const models of [undefined, [], "anthropic/*", [42]]) {
		const result = validateEntry({ models, text: "x" }, { where });
		assert.equal(result.ok, false, `models=${JSON.stringify(models)}`);
	}
});

test("rejects a list that consists only of exclusions", () => {
	const result = validateEntry({ models: ["!openai/*"], text: "x" }, { where });
	assert.equal(result.ok, false);
	assert.match(result.reason.message, /at least one pattern that is not an exclusion/);
});

test("rejects invalid patterns and bare exclusions", () => {
	for (const pattern of ["", "!", 42]) {
		const result = validateEntry({ models: [pattern], text: "x" }, { where });
		assert.equal(result.ok, false, `pattern=${pattern}`);
	}
	assert.equal(validateEntry({ models: ["*deepseek"], text: "x" }, { where }).ok, true);
});

test("requires exactly one of text and file", () => {
	const both = validateEntry({ models: ["*"], text: "x", file: "a.md" }, { where });
	assert.equal(both.ok, false);
	assert.match(both.reason.message, /exactly one/);

	const neither = validateEntry({ models: ["*"] }, { where });
	assert.equal(neither.ok, false);
	assert.match(neither.reason.message, /exactly one/);
});

test("accepts a file entry and records its identity", () => {
	const result = validateEntry({ models: ["*"], file: " prompts/one.md " }, { where });
	assert.equal(result.ok, true);
	assert.equal(result.value.file, "prompts/one.md");
	assert.equal(identityOf(result.value).startsWith("file:"), true);
	assert.equal(identityOf(result.value).endsWith(":prompts/one.md"), true);
});

test("rejects unknown fields, bad positions and bad when clauses", () => {
	const unknownField = validateEntry({ models: ["*"], text: "x", nope: 1 }, { where });
	assert.equal(unknownField.ok, false);
	assert.match(unknownField.reason.message, /unknown field "nope"/);

	const badPosition = validateEntry({ models: ["*"], text: "x", position: "middle" }, { where });
	assert.equal(badPosition.ok, false);
	assert.match(badPosition.reason.message, /position/);

	const nullPosition = validateEntry({ models: ["*"], text: "x", position: null }, { where });
	assert.equal(nullPosition.ok, false);

	const badWhen = validateEntry({ models: ["*"], text: "x", when: { mode: "tui" } }, { where });
	assert.equal(badWhen.ok, false);
	assert.match(badWhen.reason.message, /unknown "when" field "mode"/);
});

test("normalizes the when clause", () => {
	const origin = validateEntry({ models: ["*"], text: "x", when: { origin: "subagent" } }, { where });
	assert.deepEqual(origin.value.when, { origin: "subagent" });

	const depth = validateEntry({ models: ["*"], text: "x", when: { delegationDepthMin: 1 } }, { where });
	assert.deepEqual(depth.value.when, { delegationDepthMin: 1 });

	const preset = validateEntry({ models: ["*"], text: "x", when: { agentPreset: " planner " } }, { where });
	assert.deepEqual(preset.value.when, { agentPreset: "planner" });

	const empty = validateEntry({ models: ["*"], text: "x", when: {} }, { where });
	assert.equal(empty.value.when, undefined);
});

test("rejects a negative delegation depth", () => {
	const result = validateEntry({ models: ["*"], text: "x", when: { delegationDepthMin: -1 } }, { where });
	assert.equal(result.ok, false);
});

test("the reason carries the entry location", () => {
	const result = validateEntry({ models: [], text: "x" }, { where });
	assert.equal(result.reason.where, where);
});
