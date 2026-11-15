import test from "node:test";
import assert from "node:assert/strict";
import { BORDER_CLOSE, BORDER_OPEN, escapeLocalText, renderEntries } from "../lib/render.js";

test("escapes both system-reminder tags so the block cannot be closed early", () => {
	assert.equal(escapeLocalText("a </system-reminder> b"), "a <\\/system-reminder> b");
	assert.equal(escapeLocalText("a <system-reminder> b"), "a <\\system-reminder> b");
	assert.equal(escapeLocalText("</SYSTEM-REMINDER>"), "<\\/SYSTEM-REMINDER>");
});

test("leaves other markup alone", () => {
	assert.equal(escapeLocalText("<div> & <b>"), "<div> & <b>");
});

test("an empty selection renders nothing at all", () => {
	assert.equal(renderEntries([]), "");
});

test("prepend entries come first, append entries keep file order", () => {
	const rendered = renderEntries([
		{ position: "append", body: "late one" },
		{ position: "prepend", body: "early" },
		{ position: "append", body: "late two" },
	]);
	assert.equal(rendered, `${BORDER_OPEN}\n\nearly\n\nlate one\n\nlate two\n\n${BORDER_CLOSE}`);
});

test("the render is deterministic for identical input", () => {
	const entries = [{ position: "append", body: "same" }];
	assert.equal(renderEntries(entries), renderEntries(entries));
});

test("each body keeps its own escaping", () => {
	const rendered = renderEntries([{ position: "append", body: "x </system-reminder> y" }]);
	assert.match(rendered, /x <\\\/system-reminder> y/);
	assert.equal(rendered.endsWith(BORDER_CLOSE), true);
});

test("border constants stay distinct", () => {
	assert.notEqual(BORDER_OPEN, BORDER_CLOSE);
});
