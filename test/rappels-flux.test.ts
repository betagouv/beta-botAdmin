import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.js";
import { MatrixConnector } from "../src/connectors/matrix.js";
import { runReminderTick, findForeignInscriptions } from "../src/tools/rappels-scheduler.js";

// The inscription flow end to end, through the real connector methods, with
// La Suite (CalDAV) and Grist faked behind global fetch.

const ALICE = "@alice.martin-beta.gouv.fr:agent.dinum.tchap.gouv.fr";
const MALLORY = "@mallory-beta.gouv.fr:agent.dinum.tchap.gouv.fr";
const DM = "!dm:agent.dinum.tchap.gouv.fr";
const CAL_ALICE = "https://messagerie.numerique.gouv.fr/dav/caldav/QWxpY2VDYWw/";
// A calendar whose owner La Suite cannot tell right now (503).
const CAL_PANNE = "https://messagerie.numerique.gouv.fr/dav/caldav/UGFubmU/";

config.dataDir = mkdtempSync(join(tmpdir(), "betabot-rappels-"));
config.caldav.user = "communaute@beta.gouv.fr";
config.caldav.password = "secret-de-test";
config.grist.url = "https://grist.test";
config.grist.apiKey = "cle-de-test";
config.grist.docId = "doc";

interface Row {
  id: number;
  fields: Record<string, unknown>;
}

let rows: Row[];
let events: string[];
let calls: Array<{ method: string; url: string; body: string }>;
let origFetch: typeof fetch;

const ms = (inner: string) =>
  new Response(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${inner}</D:multistatus>`, { status: 207 });
const INVITE = `<D:response><D:propstat><D:prop><invite xmlns="http://calendarserver.org/ns/"><CS:organizer><D:href>mailto:/dav/principals/users/2806</D:href></CS:organizer></invite></D:prop></D:propstat></D:response>`;
const PRINCIPAL = `<D:response><D:propstat><D:prop><calendar-user-address-set xmlns="urn:ietf:params:xml:ns:caldav"><D:href>mailto:alice.martin@beta.gouv.fr</D:href></calendar-user-address-set></D:prop></D:propstat></D:response>`;

function ical(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// A VEVENT starting in an hour, carrying `summary` and these participants.
function vevent(summary: string, organizer?: string, attendees: string[] = []): string {
  const start = new Date(Date.now() + 3_600_000);
  return [
    "BEGIN:VEVENT",
    `UID:${summary}-${organizer ?? "perso"}`,
    `SUMMARY:${summary}`,
    `DTSTART:${ical(start)}`,
    `DTEND:${ical(new Date(start.getTime() + 1_800_000))}`,
    ...(organizer ? [`ORGANIZER:mailto:${organizer}`] : []),
    ...attendees.map((a) => `ATTENDEE:mailto:${a}`),
    "END:VEVENT",
  ].join("\r\n");
}

function fakeFetch(input: string | URL, init: RequestInit = {}): Response {
  const url = input instanceof URL ? input.href : String(input);
  const method = init.method ?? "GET";
  const body = typeof init.body === "string" ? init.body : "";
  calls.push({ method, url, body });
  if (url.startsWith("https://grist.test/")) {
    if (method === "GET") {
      const filter = JSON.parse(new URL(url).searchParams.get("filter") ?? "{}") as Record<string, unknown[]>;
      const match = rows.filter((r) =>
        Object.entries(filter).every(([col, vals]) => vals.includes(r.fields[col])),
      );
      return Response.json({ records: match });
    }
    if (method === "POST") {
      const added = (JSON.parse(body) as { records: Array<{ fields: Record<string, unknown> }> }).records;
      const ids = added.map((r) => {
        const id = rows.length + 1;
        rows.push({ id, fields: r.fields });
        return { id };
      });
      return Response.json({ records: ids });
    }
    if (method === "PATCH") {
      for (const p of (JSON.parse(body) as { records: Row[] }).records) {
        const row = rows.find((r) => r.id === p.id);
        if (row) Object.assign(row.fields, p.fields);
      }
      return Response.json({});
    }
  }
  if (url.startsWith("https://messagerie.numerique.gouv.fr/dav/")) {
    if (url === CAL_PANNE && body.includes("invite")) return new Response("indisponible", { status: 503 });
    if (url.includes("/principals/")) return ms(PRINCIPAL);
    if (method === "PROPFIND" && body.includes("invite")) return ms(INVITE);
    if (method === "PROPFIND") return ms("");
    if (method === "REPORT") {
      const cal = `BEGIN:VCALENDAR\r\n${events.join("\r\n")}\r\nEND:VCALENDAR`;
      return ms(`<D:response><D:propstat><D:prop><C:calendar-data xmlns:C="urn:ietf:params:xml:ns:caldav">${cal}</C:calendar-data></D:prop></D:propstat></D:response>`);
    }
  }
  throw new Error(`requête inattendue : ${method} ${url}`);
}

beforeEach(() => {
  rows = [];
  events = [];
  calls = [];
  origFetch = globalThis.fetch;
  globalThis.fetch = (async (i: string | URL, init?: RequestInit) => fakeFetch(i, init)) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

// The real connector, with what it would post to Matrix captured.
function connector() {
  const c = new MatrixConnector() as unknown as {
    pendingRappels: {
      start(u: string, r: string, now: number): void;
      get(u: string, r: string, now: number): { preuve?: { code: string; url: string } } | undefined;
    };
    sendMessage: (room: string, text: string) => Promise<void>;
    sendReaction: () => Promise<void>;
    notifyAdmin: (text: string) => Promise<void>;
    handleRappelsUrlReply(dm: string, sender: string, body: string, ev: string): Promise<void>;
    auditRappelsOwners(): Promise<void>;
  };
  const said: string[] = [];
  const admin: string[] = [];
  c.sendMessage = async (_room, text) => void said.push(text);
  c.sendReaction = async () => {};
  c.notifyAdmin = async (text) => void admin.push(text);
  return { c, said, admin };
}

const gristWrites = () => calls.filter((x) => x.url.startsWith("https://grist.test/") && x.method !== "GET");

test("inscription: the owner of the calendar is subscribed straight away", async () => {
  const { c, said } = connector();
  c.pendingRappels.start(ALICE, DM, Date.now());
  await c.handleRappelsUrlReply(DM, ALICE, `voici : ${CAL_ALICE}`, "$1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.fields["MatrixUserId"], ALICE);
  assert.equal(rows[0]!.fields["CalDAVUrl"], CAL_ALICE);
  assert.match(said.at(-1)!, /C'est bon/);
});

test("inscription: someone else's calendar asks for the proof and stores nothing", async () => {
  const { c, said } = connector();
  c.pendingRappels.start(MALLORY, DM, Date.now());
  await c.handleRappelsUrlReply(DM, MALLORY, CAL_ALICE, "$1");
  assert.deepEqual(gristWrites(), []);
  const code = c.pendingRappels.get(MALLORY, DM, Date.now())?.preuve?.code;
  assert.match(code ?? "", /^betabot-/);
  assert.match(said.at(-1)!, new RegExp(code!));
});

test("inscription: an invitation titled with the code does not pass the proof", async () => {
  const { c, said } = connector();
  c.pendingRappels.start(MALLORY, DM, Date.now());
  await c.handleRappelsUrlReply(DM, MALLORY, CAL_ALICE, "$1");
  const code = c.pendingRappels.get(MALLORY, DM, Date.now())!.preuve!.code;
  // Mallory invites Alice to an event carrying the code: it lands in Alice's calendar.
  events = [vevent(code, "mallory@beta.gouv.fr", ["alice.martin@beta.gouv.fr"])];
  await c.handleRappelsUrlReply(DM, MALLORY, "ok", "$2");
  assert.deepEqual(gristWrites(), []);
  assert.match(said.at(-1)!, /Je ne trouve pas/);
});

test("inscription: the owner's own event with the code passes, even answered in a quoted reply", async () => {
  // Alice's Tchap account is on another domain than her calendar.
  const aliceAilleurs = "@alice.martin-modernisation.gouv.fr:agent.dinum.tchap.gouv.fr";
  const { c, said } = connector();
  c.pendingRappels.start(aliceAilleurs, DM, Date.now());
  await c.handleRappelsUrlReply(DM, aliceAilleurs, CAL_ALICE, "$1");
  const code = c.pendingRappels.get(aliceAilleurs, DM, Date.now())!.preuve!.code;
  events = [vevent("Point hebdo", "bob@beta.gouv.fr", ["alice.martin@beta.gouv.fr"]), vevent(code)];
  await c.handleRappelsUrlReply(DM, aliceAilleurs, `> <@bot> 🔐 Cet agenda n'est pas rattaché…\n\nC’est fait`, "$2");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.fields["MatrixUserId"], aliceAilleurs);
  assert.match(said.at(-1)!, new RegExp(`supprimer l'événement \`${code}\``));
});

test("inscription: pasting the same URL again during the proof keeps the same code", async () => {
  const { c } = connector();
  c.pendingRappels.start(MALLORY, DM, Date.now());
  await c.handleRappelsUrlReply(DM, MALLORY, CAL_ALICE, "$1");
  const code = c.pendingRappels.get(MALLORY, DM, Date.now())!.preuve!.code;
  await c.handleRappelsUrlReply(DM, MALLORY, `ok ${CAL_ALICE}`, "$2");
  assert.equal(c.pendingRappels.get(MALLORY, DM, Date.now())?.preuve?.code, code);
  assert.deepEqual(gristWrites(), []);
});

test("inscription: a foreign link is never contacted and the URL is still awaited", async () => {
  const { c, said } = connector();
  c.pendingRappels.start(MALLORY, DM, Date.now());
  await c.handleRappelsUrlReply(DM, MALLORY, "https://evil.example/dav/caldav/x/", "$1");
  assert.deepEqual(calls, []);
  assert.match(said.at(-1)!, /je ne l'ai pas ouvert/);
  assert.ok(c.pendingRappels.get(MALLORY, DM, Date.now()));
});

test("scheduler: a stored URL that fails the rule is flagged broken, nothing sent to it", async () => {
  rows = [{ id: 1, fields: { MatrixUserId: MALLORY, CalDAVUrl: "https://evil.example/cal.ics", RoomIdDM: DM, Statut: "actif" } }];
  const sent: string[] = [];
  const res = await runReminderTick({
    now: new Date(),
    leadMin: 15,
    windowMin: 5,
    dryRun: false,
    send: async (roomId) => void sent.push(roomId),
  });
  assert.equal(res.broken, 1);
  assert.equal(rows[0]!.fields["Statut"], "erreur");
  assert.deepEqual(sent, [DM]);
  assert.ok(!calls.some((x) => x.url.includes("evil.example")));
});

test("findForeignInscriptions: someone else's calendar apart from an unreadable owner", async () => {
  rows = [
    { id: 1, fields: { MatrixUserId: ALICE, CalDAVUrl: CAL_ALICE, RoomIdDM: DM, Statut: "actif" } },
    { id: 2, fields: { MatrixUserId: MALLORY, CalDAVUrl: CAL_ALICE, RoomIdDM: DM, Statut: "actif" } },
    { id: 3, fields: { MatrixUserId: ALICE, CalDAVUrl: CAL_PANNE, RoomIdDM: DM, Statut: "actif" } },
  ];
  const { etrangeres, illisibles } = await findForeignInscriptions();
  assert.deepEqual(etrangeres.map((i) => i.matrixUserId), [MALLORY]);
  assert.deepEqual(illisibles.map((i) => i.calDavUrl), [CAL_PANNE]);
  assert.ok(gristWrites().length === 0, "read-only");
});

test("audit: the admin hears once about a foreign inscription, never in dry run, never for an unreadable owner", async () => {
  const bob = "@bob-beta.gouv.fr:agent.dinum.tchap.gouv.fr";
  rows = [
    { id: 1, fields: { MatrixUserId: bob, CalDAVUrl: CAL_ALICE, RoomIdDM: DM, Statut: "actif" } },
    { id: 2, fields: { MatrixUserId: ALICE, CalDAVUrl: CAL_PANNE, RoomIdDM: DM, Statut: "actif" } },
  ];
  const { c, admin } = connector();
  config.rappels.dryRun = true;
  await c.auditRappelsOwners();
  assert.deepEqual(admin, []);
  config.rappels.dryRun = false;
  try {
    await c.auditRappelsOwners();
    assert.equal(admin.length, 1);
    assert.match(admin[0]!, new RegExp(bob.replace(/[.]/g, "\\.")));
    assert.doesNotMatch(admin[0]!, /alice/);
    // Next start: already reported.
    await c.auditRappelsOwners();
    assert.equal(admin.length, 1);
  } finally {
    config.rappels.dryRun = true;
  }
});

test("audit: an inscription that went through the proof is never reported", async () => {
  const aliceAilleurs = "@alice.martin-numerique.gouv.fr.fr:agent.dinum.tchap.gouv.fr";
  const { c, admin } = connector();
  c.pendingRappels.start(aliceAilleurs, DM, Date.now());
  await c.handleRappelsUrlReply(DM, aliceAilleurs, CAL_ALICE, "$1");
  events = [vevent(c.pendingRappels.get(aliceAilleurs, DM, Date.now())!.preuve!.code)];
  await c.handleRappelsUrlReply(DM, aliceAilleurs, "ok", "$2");
  assert.equal(rows.length, 1);
  config.rappels.dryRun = false;
  try {
    await c.auditRappelsOwners();
  } finally {
    config.rappels.dryRun = true;
  }
  assert.deepEqual(admin, []);
});
