import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The boundary layer needs the peer dependencies to import. When they are not
 * installed (a plain checkout), these tests skip instead of failing.
 */
async function load(t) {
	try {
		return await import("../lib/index.js");
	} catch (error) {
		if (error?.code === "ERR_MODULE_NOT_FOUND") {
			t.skip("peer dependencies are not installed");
			return undefined;
		}
		throw error;
	}
}

function fakeContext() {
	const state = { logs: [], specs: [], effects: [] };
	const ctx = {
		logger: {
			info: (message) => state.logs.push(["info", message]),
			warn: (message) => state.logs.push(["warn", message]),
		},
		effect(fn, label) {
			state.effects.push(label);
			return fn();
		},
		systemPrompt: {
			context(spec) {
				state.specs.push(spec);
				return () => {};
			},
		},
	};
	return { ctx, state };
}

function workspace() {
	const root = mkdtempSync(join(tmpdir(), "model-prompts-reg-"));
	const globalRoot = join(root, "global");
	mkdirSync(globalRoot, { recursive: true });
	writeFileSync(join(globalRoot, "a.json"), JSON.stringify({ prompts: [{ models: ["*"], text: "hello" }] }), "utf8");
	return { root, globalRoot };
}

test("registers one required, non-interpolated context", async (t) => {
	const module = await load(t);
	if (module === undefined) return;
	const { root, globalRoot } = workspace();
	const { ctx, state } = fakeContext();

	module.apply(ctx, { globalRoot, projectFile: "missing.json", allowProject: true });

	assert.deepEqual(state.effects, ["model-prompts.context()"]);
	assert.equal(state.specs.length, 1);
	const spec = state.specs[0];
	assert.equal(spec.name, "model-prompts");
	assert.equal(spec.order, 270);
	assert.equal(spec.interpolate, false);
	assert.equal(spec.required, true);
	assert.equal(typeof spec.text, "function");
	assert.equal(module.Config !== undefined, true);

	assert.match(spec.text({ modelSelection: { provider: "deepseek", model: "chat" } }), /hello/);
	assert.equal(spec.text({}), "");
	assert.equal(state.logs.filter(([level]) => level === "warn").length, 0);
	assert.equal(state.logs.filter(([level]) => level === "info").length, 1);

	// Repeated calls with the same context are deterministic (the runtime relies
	// on that for its deep-equality dedupe).
	const first = spec.text({ modelSelection: { provider: "deepseek", model: "chat" } });
	assert.equal(spec.text({ modelSelection: { provider: "deepseek", model: "chat" } }), first);
	assert.equal(root.length > 0, true);
});

test("a broken config file costs only that file", async (t) => {
	const module = await load(t);
	if (module === undefined) return;
	const { globalRoot } = workspace();
	writeFileSync(join(globalRoot, "b.json"), "{ nope", "utf8");
	const { ctx, state } = fakeContext();

	module.apply(ctx, { globalRoot });
	const spec = state.specs[0];
	assert.match(spec.text({ modelSelection: { provider: "deepseek", model: "chat" } }), /hello/);
	const warns = state.logs.filter(([level]) => level === "warn");
	assert.equal(warns.length, 1);
	assert.match(warns[0][1], /invalid JSON/);
});

test("a duplicate registration degrades instead of throwing", async (t) => {
	const module = await load(t);
	if (module === undefined) return;
	const { globalRoot } = workspace();
	const { ctx, state } = fakeContext();
	ctx.systemPrompt.context = (spec) => {
		state.specs.push(spec);
		throw new Error('context "model-prompts" is already registered');
	};

	assert.doesNotThrow(() => module.apply(ctx, { globalRoot }));
	assert.equal(typeof state.specs[0].text, "function");
	assert.match(state.logs.find(([level]) => level === "warn")[1], /already registered/);
});

test("a registration failure other than a duplicate stays loud", async (t) => {
	const module = await load(t);
	if (module === undefined) return;
	const { globalRoot } = workspace();
	const { ctx } = fakeContext();
	ctx.systemPrompt.context = () => {
		throw new Error("something else broke");
	};

	assert.throws(() => module.apply(ctx, { globalRoot }), /something else broke/);
});

test("disabled registers nothing", async (t) => {
	const module = await load(t);
	if (module === undefined) return;
	const { globalRoot } = workspace();
	const { ctx, state } = fakeContext();

	module.apply(ctx, { globalRoot, enabled: false });
	assert.deepEqual(state.effects, []);
	assert.deepEqual(state.specs, []);
});
