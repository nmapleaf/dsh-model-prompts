import test from "node:test";
import assert from "node:assert/strict";
import { matchesModel, selectsModel, validPattern, selectEntries } from "../lib/match.js";

const model = (provider, id) => ({ provider, model: id });

test("wildcard matches every provider", () => {
	assert.equal(matchesModel("*", model("deepseek", "deepseek-chat")), true);
	assert.equal(matchesModel("*", model("anthropic", "claude-opus-4")), true);
});

test("matches provider/model and the bare model id", () => {
	assert.equal(matchesModel("anthropic/*", model("anthropic", "claude-opus-4")), true);
	assert.equal(matchesModel("anthropic/*", model("openai", "gpt-6")), false);
	assert.equal(matchesModel("claude-opus-4", model("anthropic", "claude-opus-4")), true);
	assert.equal(matchesModel("anthropic/claude-opus-4", model("anthropic", "claude-opus-4")), true);
});

test("matching is case insensitive", () => {
	assert.equal(matchesModel("Anthropic/Claude-*", model("anthropic", "claude-haiku-5")), true);
});

test("regex metacharacters in a pattern are literal", () => {
	assert.equal(matchesModel("gpt-4.1", model("openai", "gpt-4.1")), true);
	assert.equal(matchesModel("gpt-4.1", model("openai", "gpt-4x1")), false);
	assert.equal(matchesModel("a+b", model("x", "aab")), false);
});

test("a pattern must match the whole model id", () => {
	assert.equal(matchesModel("claude", model("anthropic", "claude-opus-4")), false);
	assert.equal(matchesModel("claude*", model("anthropic", "claude-opus-4")), true);
});

test("invalid patterns never match and are reported by validPattern", () => {
	assert.equal(validPattern(""), false);
	assert.equal(validPattern("!"), false);
	assert.equal(validPattern(null), false);
	assert.equal(matchesModel("", model("deepseek", "deepseek-chat")), false);
	assert.equal(validPattern("*"), true);
	assert.equal(validPattern("anthropic/*"), true);
	assert.equal(validPattern("*deepseek"), true);
});

test("exclusions and includes compose as an AND", () => {
	const patterns = ["anthropic/*", "!anthropic/claude-3*"];
	assert.equal(selectsModel(patterns, model("anthropic", "claude-opus-4")), true);
	assert.equal(selectsModel(patterns, model("anthropic", "claude-3-5-sonnet")), false);
	assert.equal(selectsModel(patterns, model("openai", "gpt-6")), false);
});

test("an excluded match beats a wildcard include", () => {
	assert.equal(selectsModel(["*", "!openai/*"], model("openai", "gpt-6")), false);
	assert.equal(selectsModel(["*", "!openai/*"], model("deepseek", "deepseek-chat")), true);
});

test("selectEntries keeps model matches and applies when filters", () => {
	const entries = [
		{ models: ["*"], text: "all" },
		{ models: ["anthropic/*"], text: "anthropic" },
		{ models: ["*"], when: { origin: "subagent" }, text: "subagent" },
		{ models: ["*"], when: { delegationDepthMin: 2 }, text: "deep" },
	];
	const top = selectEntries(entries, model("deepseek", "deepseek-chat"), { origin: "root" });
	assert.deepEqual(top.map((entry) => entry.text), ["all"]);

	const child = selectEntries(entries, model("anthropic", "claude-opus-4"), { origin: "subagent", delegationDepth: 1 });
	assert.deepEqual(child.map((entry) => entry.text), ["all", "anthropic", "subagent"]);

	const grandchild = selectEntries(entries, model("deepseek", "deepseek-chat"), { origin: "subagent", delegationDepth: 2 });
	assert.deepEqual(grandchild.map((entry) => entry.text), ["all", "subagent", "deep"]);
});

test("selectEntries tolerates a missing header", () => {
	const entries = [{ models: ["*"], when: { origin: "root" }, text: "root only" }];
	assert.deepEqual(selectEntries(entries, model("deepseek", "x"), undefined), []);
});

test("agentPreset filters on the session header", () => {
	const entries = [{ models: ["*"], when: { agentPreset: "planner" }, text: "planner" }];
	assert.equal(selectEntries(entries, model("deepseek", "x"), { agentPreset: "planner" }).length, 1);
	assert.equal(selectEntries(entries, model("deepseek", "x"), { agentPreset: "coder" }).length, 0);
});
