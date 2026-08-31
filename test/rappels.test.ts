import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PendingInscriptions,
  extractCalDavUrl,
  buildReminderMessage,
} from "../src/commands/rappels.js";

const EVENT = {
  summary: "Hebdo raccourci équipe animation",
  start: new Date("2026-07-23T12:00:00Z"),
  organizer: "marine@beta.gouv.fr",
  attendees: [],
  meetingUrl: "https://visio.numerique.gouv.fr/uba-nsor-unf",
};

test("buildReminderMessage: labels a known visio link", () => {
  const msg = buildReminderMessage(EVENT, 15);
  assert.equal(
    msg,
    "📅 Rappel : **Hebdo raccourci équipe animation** dans ~15 min (14:00) avec marine@beta.gouv.fr." +
      "\n🔗 [Rejoindre la visio](https://visio.numerique.gouv.fr/uba-nsor-unf)",
  );
});

test("buildReminderMessage: adds a notes line when the event has one", () => {
  const msg = buildReminderMessage(
    { ...EVENT, notesUrl: "https://www.notion.so/betagouv/page" },
    15,
  );
  assert.equal(
    msg.split("\n")[2],
    "📝 [Notes](https://www.notion.so/betagouv/page)",
  );
});

test("buildReminderMessage: no notes line when it duplicates the visio", () => {
  const msg = buildReminderMessage({ ...EVENT, notesUrl: EVENT.meetingUrl }, 15);
  assert.ok(!msg.includes("📝"));
});

test("buildReminderMessage: shows an unknown link raw", () => {
  const msg = buildReminderMessage(
    { ...EVENT, meetingUrl: "https://pad.example.org/x" },
    15,
  );
  assert.ok(msg.endsWith("\n🔗 https://pad.example.org/x"));
});

test("buildReminderMessage: omits the link line when there is none", () => {
  const msg = buildReminderMessage({ ...EVENT, meetingUrl: "" }, 15);
  assert.ok(!msg.includes("🔗"));
});

test("extractCalDavUrl: prefers a La Suite caldav URL over other links", () => {
  const body =
    "Voici mon lien: https://messagerie.numerique.gouv.fr/dav/caldav/abc123/ (cf https://autre.example.org/x)";
  assert.equal(
    extractCalDavUrl(body),
    "https://messagerie.numerique.gouv.fr/dav/caldav/abc123/",
  );
});

test("extractCalDavUrl: falls back to the first http(s) URL", () => {
  assert.equal(
    extractCalDavUrl("mon agenda: https://cal.example.org/dav/u1"),
    "https://cal.example.org/dav/u1",
  );
});

test("extractCalDavUrl: trims trailing punctuation", () => {
  assert.equal(
    extractCalDavUrl("(https://cal.example.org/dav/u1)."),
    "https://cal.example.org/dav/u1",
  );
});

test("extractCalDavUrl: returns null when there is no URL", () => {
  assert.equal(extractCalDavUrl("bonjour, je ne sais pas où le trouver"), null);
});

test("PendingInscriptions: awaits only in the DM room it was started for", () => {
  const p = new PendingInscriptions();
  const t0 = 1_000_000;
  p.start("@u:ex", "!dm:ex", t0);
  assert.equal(p.isAwaiting("@u:ex", "!dm:ex", t0), true);
  assert.equal(p.isAwaiting("@u:ex", "!autre:ex", t0), false);
  assert.equal(p.isAwaiting("@autre:ex", "!dm:ex", t0), false);
});

test("PendingInscriptions: clear() stops awaiting", () => {
  const p = new PendingInscriptions();
  const t0 = 1_000_000;
  p.start("@u:ex", "!dm:ex", t0);
  p.clear("@u:ex");
  assert.equal(p.isAwaiting("@u:ex", "!dm:ex", t0), false);
});

test("PendingInscriptions: entry expires after the TTL", () => {
  const p = new PendingInscriptions(1000);
  const t0 = 1_000_000;
  p.start("@u:ex", "!dm:ex", t0);
  assert.equal(p.isAwaiting("@u:ex", "!dm:ex", t0 + 500), true);
  assert.equal(p.isAwaiting("@u:ex", "!dm:ex", t0 + 1500), false);
});
