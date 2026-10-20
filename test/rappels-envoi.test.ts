import { test, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A reminder the homeserver refuses: not recorded as sent, the other
// subscribers still get theirs, and the next ticks try it again until the
// meeting starts. Grist and La Suite are faked behind global fetch. The
// settings are read from the environment when config is first imported, so
// they are set before the dynamic imports below.
const dataDir = mkdtempSync(join(tmpdir(), "betabot-rappels-envoi-"));
after(() => rmSync(dataDir, { recursive: true, force: true }));
process.env["DATA_DIR"] = dataDir;
process.env["GRIST_URL"] = "https://grist.test";
process.env["GRIST_API_KEY"] = "cle-de-test";
process.env["GRIST_OPS_DOC_ID"] = "doc";
process.env["CALDAV_USER"] = "communaute@beta.gouv.fr";
process.env["CALDAV_PASSWORD"] = "secret-de-test";
process.env["RAPPELS_DRY_RUN"] = "false";
const { config } = await import("../src/config.js");
const { runReminderTick } = await import("../src/tools/rappels-scheduler.js");
const { MatrixConnector } = await import("../src/connectors/matrix.js");

const MIN = 60_000;
const NOW = Date.parse("2026-10-20T08:00:00Z");
const ALICE = "@alice.martin-beta.gouv.fr:agent.dinum.tchap.gouv.fr";
const BOB = "@bob.durand-beta.gouv.fr:agent.dinum.tchap.gouv.fr";
// The homeserver refuses the bot's posts in Alice's DM.
const DM_ALICE = "!dm-alice:agent.dinum.tchap.gouv.fr";
const DM_BOB = "!dm-bob:agent.dinum.tchap.gouv.fr";

interface Row {
  id: number;
  fields: Record<string, unknown>;
}

let inscriptions: Row[];
let envoyes: Row[];
let reunions: string[];
let origFetch: typeof fetch;

function ical(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// A VEVENT for a 30-minute meeting starting at `start`.
function reunion(summary: string, start: number): string {
  return [
    "BEGIN:VEVENT",
    `UID:${summary}`,
    `SUMMARY:${summary}`,
    `DTSTART:${ical(start)}`,
    `DTEND:${ical(start + 30 * MIN)}`,
    "END:VEVENT",
  ].join("\r\n");
}

// Both calendars hold the same `reunions`.
function fakeFetch(input: string | URL, init: RequestInit = {}): Response {
  const url = String(input);
  const method = init.method ?? "GET";
  if (url.startsWith("https://grist.test/")) {
    const table = url.includes(`/tables/${config.grist.tableSent}/`) ? envoyes : inscriptions;
    if (method === "GET") {
      const filter = JSON.parse(new URL(url).searchParams.get("filter") ?? "{}") as Record<string, unknown[]>;
      return Response.json({
        records: table.filter((r) => Object.entries(filter).every(([col, vals]) => vals.includes(r.fields[col]))),
      });
    }
    if (method === "POST" && url.endsWith("/records")) {
      const added = (JSON.parse(String(init.body)) as { records: Array<{ fields: Record<string, unknown> }> }).records;
      const ids = added.map((r) => {
        table.push({ id: table.length + 1, fields: r.fields });
        return { id: table.length };
      });
      return Response.json({ records: ids });
    }
  }
  if (method === "REPORT" && url.startsWith("https://messagerie.numerique.gouv.fr/dav/caldav/")) {
    const cal = `BEGIN:VCALENDAR\r\n${reunions.join("\r\n")}\r\nEND:VCALENDAR`;
    return new Response(
      `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:propstat><D:prop><C:calendar-data xmlns:C="urn:ietf:params:xml:ns:caldav">${cal}</C:calendar-data></D:prop></D:propstat></D:response></D:multistatus>`,
      { status: 207 },
    );
  }
  throw new Error(`requête inattendue : ${method} ${url}`);
}

beforeEach(() => {
  inscriptions = [
    { id: 1, fields: { MatrixUserId: ALICE, CalDAVUrl: "https://messagerie.numerique.gouv.fr/dav/caldav/QWxpY2VDYWw/", RoomIdDM: DM_ALICE, Statut: "actif" } },
    { id: 2, fields: { MatrixUserId: BOB, CalDAVUrl: "https://messagerie.numerique.gouv.fr/dav/caldav/Qm9iQ2Fs/", RoomIdDM: DM_BOB, Statut: "actif" } },
  ];
  envoyes = [];
  reunions = [];
  origFetch = globalThis.fetch;
  globalThis.fetch = (async (i: string | URL, init?: RequestInit) => fakeFetch(i, init)) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

// Who the anti-duplicate log says got a reminder.
const enregistres = () => envoyes.map((r) => r.fields["MatrixUserId"]);

// A tick at `now` (ms) that keeps `retry` across calls; `refuse` says whether
// the homeserver turns down the post in that room.
function ticker(retry: Map<string, number>, refuse: (room: string) => boolean) {
  const posted: Array<{ room: string; text: string }> = [];
  const tick = (now: number) =>
    runReminderTick({
      now: new Date(now),
      leadMin: 15,
      windowMin: 5,
      dryRun: false,
      retry,
      send: async (room, text) => {
        if (refuse(room)) throw new Error("M_FORBIDDEN");
        posted.push({ room, text });
      },
    });
  return { tick, posted };
}

test("rappels: a refused reminder is not recorded, the others still get theirs, and the next tick sends it", async (t) => {
  t.mock.method(console, "error", () => {});
  reunions = [reunion("Point hebdo", NOW + 12 * MIN)];
  const retry = new Map<string, number>();
  let panne = true;
  const { tick, posted } = ticker(retry, (room) => panne && room === DM_ALICE);

  const premier = await tick(NOW);
  assert.equal(premier.sent, 1);
  assert.equal(premier.failed, 1);
  assert.deepEqual(posted.map((p) => p.room), [DM_BOB]);
  assert.match(posted[0]!.text, /dans ~15 min/);
  assert.deepEqual(enregistres(), [BOB]);

  // Five minutes later the window has moved past the meeting: only the
  // refused reminder goes out, with the time really left.
  panne = false;
  const second = await tick(NOW + 5 * MIN);
  assert.equal(second.sent, 1);
  assert.deepEqual(posted.map((p) => p.room), [DM_BOB, DM_ALICE]);
  assert.match(posted[1]!.text, /dans ~7 min/);
  assert.deepEqual(enregistres(), [BOB, ALICE]);
  assert.equal(retry.size, 0);
});

test("rappels: a reminder still refused is tried until the meeting starts, then given up", async (t) => {
  t.mock.method(console, "error", () => {});
  const warn = t.mock.method(console, "warn", () => {});
  reunions = [reunion("Point hebdo", NOW + 12 * MIN)];
  const retry = new Map<string, number>();
  const { tick, posted } = ticker(retry, (room) => room === DM_ALICE);

  await tick(NOW);
  const encore = await tick(NOW + 5 * MIN);
  assert.equal(encore.failed, 1);
  assert.equal(retry.size, 1);

  await tick(NOW + 13 * MIN);
  assert.equal(retry.size, 0);
  assert.deepEqual(posted.map((p) => p.room), [DM_BOB]);
  assert.deepEqual(enregistres(), [BOB]);
  assert.ok(warn.mock.calls.some((c) => String(c.arguments[0]).includes("jamais parti")));
});

test("rappels: a refused reminder is not sent for a meeting moved since", async (t) => {
  t.mock.method(console, "error", () => {});
  reunions = [reunion("Point hebdo", NOW + 12 * MIN)];
  const retry = new Map<string, number>();
  let panne = true;
  const { tick, posted } = ticker(retry, (room) => panne && room === DM_ALICE);

  await tick(NOW);
  reunions = [reunion("Point hebdo", NOW + 60 * MIN)];
  panne = false;
  await tick(NOW + 5 * MIN);
  assert.deepEqual(posted.map((p) => p.room), [DM_BOB]);
  assert.deepEqual(enregistres(), [BOB]);
});

// Calendars are read from now on for the retries: a meeting already past the
// window without a refused reminder is still not reminded, as before.
test("rappels: a meeting starting before the window gets no reminder of its own", async () => {
  reunions = [reunion("Imprévu", NOW + 7 * MIN)];
  const { tick, posted } = ticker(new Map(), () => false);
  const res = await tick(NOW);
  assert.equal(res.events, 0);
  assert.deepEqual(posted, []);
});

test("rappels: through the connector, a reminder the homeserver refuses is kept for a retry, not recorded", async (t) => {
  t.mock.method(console, "error", () => {});
  reunions = [reunion("Point hebdo", Date.now() + 12 * MIN)];
  const posted: string[] = [];
  const client = {
    async sendEvent(roomId: string) {
      if (roomId === DM_ALICE) {
        throw { errcode: "M_FORBIDDEN", error: "You don't have permission to post that to the room." };
      }
      posted.push(roomId);
      return "$ev";
    },
  };
  const c = new MatrixConnector() as unknown as {
    client: typeof client;
    remindersToRetry: Map<string, number>;
    reminderTick(): Promise<void>;
  };
  c.client = client;

  await c.reminderTick();

  assert.deepEqual(posted, [DM_BOB]);
  assert.deepEqual(enregistres(), [BOB], "refused reminder recorded as sent: it would never go out");
  assert.equal(c.remindersToRetry.size, 1);
});
