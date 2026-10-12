import { test } from "node:test";
import assert from "node:assert/strict";

// The Grist settings are read when config is first imported, so they are set
// before the dynamic imports below. `node --test` runs each file in its own
// process: nothing leaks into the other test files.
process.env["GRIST_API_KEY"] = "test-key";
process.env["GRIST_OPS_DOC_ID"] = "doc-test";
const { config } = await import("../src/config.js");
const { runReminderTick } = await import("../src/tools/rappels-scheduler.js");

const NOW = new Date("2026-09-28T10:00:00Z");
const HOUR = 60 * 60 * 1000;

// A Grist with no active inscription (so no calendar is read) and the given
// anti-duplicate rows. Records every call and every deletion.
function fakeGrist(
  sentAgesMs: Record<number, number>,
  { failPurgeRead = false } = {},
): { calls: string[]; deleted: number[][] } {
  const log = { calls: [] as string[], deleted: [] as number[][] };
  const { tableInscriptions, tableSent } = config.grist;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    log.calls.push(`${method} ${url}`);
    if (url.includes(`/tables/${tableInscriptions}/records`)) {
      return Response.json({ records: [] });
    }
    if (method === "GET" && url.includes(`/tables/${tableSent}/records`)) {
      if (failPurgeRead) return new Response("boom", { status: 500 });
      const records = Object.entries(sentAgesMs).map(([id, age]) => ({
        id: Number(id),
        fields: { EnvoyeLe: Math.round((NOW.getTime() - age) / 1000) },
      }));
      return Response.json({ records });
    }
    if (method === "POST" && url.endsWith(`/tables/${tableSent}/data/delete`)) {
      log.deleted.push(JSON.parse(String(init?.body)) as number[]);
      return Response.json(null);
    }
    throw new Error(`appel inattendu : ${method} ${url}`);
  }) as typeof fetch;
  return log;
}

function tick(dryRun: boolean) {
  return runReminderTick({
    now: NOW,
    leadMin: 15,
    windowMin: 5,
    dryRun,
    send: async () => {
      throw new Error("aucun rappel ne devait partir");
    },
  });
}

test("tick: drops the anti-duplicate rows older than a day, keeps the rest", async () => {
  const grist = fakeGrist({ 1: 25 * HOUR, 2: 23 * HOUR, 3: HOUR });
  const res = await tick(false);
  assert.deepEqual(grist.deleted, [[1]]);
  assert.equal(res.purged, 1);
});

test("tick: nothing to purge, nothing deleted", async () => {
  const grist = fakeGrist({ 1: HOUR });
  const res = await tick(false);
  assert.deepEqual(grist.deleted, []);
  assert.equal(res.purged, 0);
});

// Dry run promises not to write: the purge is a write, so it does not run.
test("tick: dry run leaves the anti-duplicate log alone", async () => {
  const grist = fakeGrist({ 1: 25 * HOUR });
  const res = await tick(true);
  assert.deepEqual(grist.deleted, []);
  assert.equal(res.purged, 0);
  assert.ok(!grist.calls.some((c) => c.includes(config.grist.tableSent)));
});

test("tick: a failing purge never breaks the tick", async (t) => {
  t.mock.method(console, "error", () => {});
  fakeGrist({ 1: 25 * HOUR }, { failPurgeRead: true });
  const res = await tick(false);
  assert.equal(res.purged, 0);
  assert.equal(res.inscriptions, 0);
});
