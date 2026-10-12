import { test } from "node:test";
import assert from "node:assert/strict";
import type { MatrixClient } from "matrix-bot-sdk";
import {
  runInactivityTick,
  lastHumanMessageTs,
  parentSpace,
  type InactiviteDeps,
} from "../src/tools/inactivite.js";
import type { CreatedRoom } from "../src/commands/created-rooms.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-12T08:00:00Z");
const ROOM = "!salon:srv";

function salon(over: Partial<CreatedRoom> = {}): CreatedRoom {
  return { roomId: ROOM, name: "pole-data", createdTs: NOW - 200 * DAY, ...over };
}

function fake(
  rooms: CreatedRoom[],
  last: number | null | Error,
  over: Partial<InactiviteDeps> = {},
) {
  const sent: Array<{ roomId: string; text: string }> = [];
  const closed: string[] = [];
  const warned: Array<[string, number | undefined]> = [];
  const admin: string[] = [];
  const deps: InactiviteDeps = {
    now: NOW,
    inactiveDays: 60,
    graceDays: 14,
    dryRun: false,
    rooms,
    lastHumanMessage: async () => {
      if (last instanceof Error) throw last;
      return last;
    },
    send: async (roomId, text) => void sent.push({ roomId, text }),
    close: async (roomId) => {
      closed.push(roomId);
      return 3;
    },
    setWarned: (roomId, ts) => void warned.push([roomId, ts]),
    notifyAdmin: async (text) => void admin.push(text),
    ...over,
  };
  return { deps, sent, closed, warned, admin };
}

test("inactivite: a room with a message under 60 days ago is left alone", async () => {
  const f = fake([salon()], NOW - 59 * DAY);
  const res = await runInactivityTick(f.deps);
  assert.equal(res.avertis, 0);
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.warned, []);
});

test("inactivite: after 60 days without a message the room is warned, with the deadline", async () => {
  const f = fake([salon()], Date.parse("2026-08-01T10:00:00Z"));
  const res = await runInactivityTick(f.deps);
  assert.equal(res.avertis, 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.roomId, ROOM);
  assert.match(f.sent[0]!.text, /depuis le 01\/08\/2026/);
  assert.match(f.sent[0]!.text, /d'ici le \*\*26\/10\/2026\*\*/);
  assert.deepEqual(f.warned, [[ROOM, NOW]]);
  assert.deepEqual(f.closed, []);
});

test("inactivite: a room nobody ever wrote in counts from its creation", async () => {
  const recent = fake([salon({ createdTs: NOW - 10 * DAY })], null);
  assert.equal((await runInactivityTick(recent.deps)).avertis, 0);
  const old = fake([salon({ createdTs: NOW - 61 * DAY })], null);
  assert.equal((await runInactivityTick(old.deps)).avertis, 1);
});

test("inactivite: a warned room is not warned again while the grace period runs", async () => {
  const f = fake([salon({ avertiLe: NOW - 13 * DAY })], NOW - 80 * DAY);
  const res = await runInactivityTick(f.deps);
  assert.deepEqual(res, { salons: 1, avertis: 0, fermes: 0, repris: 0, erreurs: 0 });
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.closed, []);
});

test("inactivite: 14 days after the warning with no message, the room is closed and the admin told", async () => {
  const f = fake([salon({ avertiLe: NOW - 14 * DAY })], NOW - 80 * DAY);
  const res = await runInactivityTick(f.deps);
  assert.equal(res.fermes, 1);
  assert.deepEqual(f.closed, [ROOM]);
  assert.equal(f.admin.length, 1);
  assert.match(f.admin[0]!, /pole-data/);
  assert.match(f.admin[0]!, /3 membre\(s\)/);
});

test("inactivite: a message after the warning stops the countdown", async () => {
  const f = fake([salon({ avertiLe: NOW - 20 * DAY })], NOW - 2 * DAY);
  const res = await runInactivityTick(f.deps);
  assert.equal(res.repris, 1);
  assert.deepEqual(f.warned, [[ROOM, undefined]]);
  assert.deepEqual(f.closed, []);
  assert.deepEqual(f.sent, []);
});

test("inactivite: dry run warns, closes and clears nothing", async () => {
  const rooms = [
    salon({ roomId: "!a:srv" }),
    salon({ roomId: "!b:srv", avertiLe: NOW - 30 * DAY }),
  ];
  const f = fake(rooms, NOW - 90 * DAY, { dryRun: true });
  const res = await runInactivityTick(f.deps);
  assert.equal(res.avertis, 1);
  assert.equal(res.fermes, 1);
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.closed, []);
  assert.deepEqual(f.warned, []);
  assert.deepEqual(f.admin, []);
});

test("inactivite: a room the bot cannot read is skipped, the others still run", async () => {
  let calls = 0;
  const f = fake([salon({ roomId: "!perdu:srv" }), salon()], null, {
    lastHumanMessage: async (roomId) => {
      calls++;
      if (roomId === "!perdu:srv") throw { errcode: "M_FORBIDDEN" };
      return NOW - 90 * DAY;
    },
  });
  const res = await runInactivityTick(f.deps);
  assert.equal(calls, 2);
  assert.equal(res.erreurs, 1);
  assert.equal(res.avertis, 1);
  assert.deepEqual(f.warned, [[ROOM, NOW]]);
});

test("inactivite: a warning that fails to send is not recorded, so the next tick retries", async () => {
  const f = fake([salon()], NOW - 90 * DAY, {
    send: async () => {
      throw new Error("M_FORBIDDEN");
    },
  });
  const res = await runInactivityTick(f.deps);
  assert.equal(res.avertis, 0);
  assert.equal(res.erreurs, 1);
  assert.deepEqual(f.warned, []);
});

test("inactivite: a bad duration refuses to run instead of closing every room", async () => {
  const f = fake([salon({ avertiLe: NOW - 1 * DAY })], NOW - 90 * DAY, {
    graceDays: Number("quatorze"),
  });
  await assert.rejects(runInactivityTick(f.deps), /durées invalides/);
  assert.deepEqual(f.closed, []);
});

test("lastHumanMessageTs: asks for the latest message not sent by the bot, encrypted ones included", async () => {
  const calls: Array<{ path: string; qs: Record<string, unknown> }> = [];
  const client = {
    async doRequest(_m: string, path: string, qs: Record<string, unknown>) {
      calls.push({ path, qs });
      return { chunk: [{ origin_server_ts: 1234 }] };
    },
  } as unknown as MatrixClient;
  assert.equal(await lastHumanMessageTs(client, "!a b:srv", "@bot:srv"), 1234);
  assert.equal(calls[0]!.path, "/_matrix/client/v3/rooms/!a%20b%3Asrv/messages");
  assert.equal(calls[0]!.qs["dir"], "b");
  assert.equal(calls[0]!.qs["limit"], 1);
  assert.deepEqual(JSON.parse(calls[0]!.qs["filter"] as string), {
    types: ["m.room.message", "m.room.encrypted"],
    not_senders: ["@bot:srv"],
  });
});

test("lastHumanMessageTs: no message at all gives null", async () => {
  const client = {
    async doRequest() {
      return { chunk: [] };
    },
  } as unknown as MatrixClient;
  assert.equal(await lastHumanMessageTs(client, ROOM, "@bot:srv"), null);
});

test("parentSpace: the canonical parent wins, a removed one is ignored", async () => {
  const client = {
    async getRoomState() {
      return [
        { type: "m.space.parent", state_key: "!vieux:srv", content: {} },
        { type: "m.space.parent", state_key: "!autre:srv", content: { via: ["srv"] } },
        { type: "m.space.parent", state_key: "!pole:srv", content: { via: ["srv"], canonical: true } },
      ];
    },
  } as unknown as MatrixClient;
  assert.equal(await parentSpace(client, ROOM), "!pole:srv");
});
