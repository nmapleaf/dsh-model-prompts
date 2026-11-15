import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateEntry } from "../lib/entry.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const sample = join(root, "examples", "model-prompts.json");
const text = readFileSync(sample, "utf8");

test("the shipped example parses", () => {
	const parsed = JSON.parse(text);
	assert.ok(Array.isArray(parsed.prompts));
	assert.ok(parsed.prompts.length > 0);
	for (const key of Object.keys(parsed)) assert.equal(key, "prompts");
});

test("every shipped example entry validates", () => {
	const parsed = JSON.parse(text);
	parsed.prompts.forEach((entry, index) => {
		const result = validateEntry(entry, { where: `examples/model-prompts.json#prompts[${index}]` });
		assert.equal(result.ok, true, result.ok ? "" : result.reason.message);
	});
});

test("shipped text stays free of pi wording and dates", () => {
	for (const banned of ["pi-subagents", "Pi compacts", "proper_model_prompts", "GPT-6", "Sonnet 5.5"]) {
		assert.equal(text.includes(banned), false, `example mentions ${banned}`);
	}
	assert.doesNotMatch(text, /\b(19|20)\d{2}\b/);
});
