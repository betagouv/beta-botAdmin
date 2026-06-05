import { test } from "node:test";
import assert from "node:assert/strict";
import { formatHistory } from "../src/commands/history.js";
import type { HistoryEntry } from "../src/commands/history.js";

const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  ts: 0,
  user: "@alice:server.org",
  room: "!r:server.org",
  kind: "slash",
  text: "/help",
  status: "ok",
  ...over,
});

test("formatHistory: empty list shows the 'no entry' message", () => {
  const out = formatHistory([], undefined);
  assert.ok(out.includes("(aucune entrée trouvée)"));
});

test("formatHistory: header reflects the active filter", () => {
  const withFilter = formatHistory([], "cartobio");
  assert.ok(withFilter.includes("filtre: `cartobio`"));
  const withoutFilter = formatHistory([], undefined);
  assert.ok(!withoutFilter.includes("filtre:"));
});

test("formatHistory: long text is truncated to 77 chars + ellipsis", () => {
  const longText = "x".repeat(100);
  const out = formatHistory([entry({ text: longText })], undefined);
  assert.ok(out.includes("x".repeat(77) + "…"));
  assert.ok(!out.includes("x".repeat(100)));
});

test("formatHistory: user id is shortened to its localpart", () => {
  const out = formatHistory([entry({ user: "@alice:server.org" })], undefined);
  assert.ok(out.includes("**@alice**"));
  assert.ok(!out.includes("server.org"));
});

test("formatHistory: status maps to the right icon", () => {
  assert.ok(formatHistory([entry({ status: "ok" })], undefined).includes("✅"));
  assert.ok(
    formatHistory([entry({ status: "refused" })], undefined).includes("⛔"),
  );
  assert.ok(
    formatHistory([entry({ status: "unknown" })], undefined).includes("❓"),
  );
  assert.ok(
    formatHistory([entry({ status: "error" })], undefined).includes("❌"),
  );
});

test("formatHistory: optional detail is rendered in parentheses", () => {
  const out = formatHistory([entry({ detail: "boom" })], undefined);
  assert.ok(out.includes("_(boom)_"));
});
