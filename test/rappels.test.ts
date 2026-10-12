import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PendingInscriptions,
  extractCalDavUrl,
  buildReminderMessage,
  newProofCode,
  readProofReply,
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

test("extractCalDavUrl: picks the La Suite caldav URL among other links", () => {
  const body =
    "cf https://autre.example.org/x — voici mon lien: https://messagerie.numerique.gouv.fr/dav/caldav/abc123/";
  assert.deepEqual(extractCalDavUrl(body), {
    kind: "ok",
    url: "https://messagerie.numerique.gouv.fr/dav/caldav/abc123/",
  });
});

test("extractCalDavUrl: any other link is refused, never used as a fallback", () => {
  assert.deepEqual(extractCalDavUrl("mon agenda: https://cal.example.org/dav/u1"), {
    kind: "refused",
  });
  assert.deepEqual(
    extractCalDavUrl("http://messagerie.numerique.gouv.fr/dav/caldav/abc123/"),
    { kind: "refused" },
  );
});

test("extractCalDavUrl: trims trailing punctuation", () => {
  assert.deepEqual(
    extractCalDavUrl("(https://messagerie.numerique.gouv.fr/dav/caldav/u1/)."),
    { kind: "ok", url: "https://messagerie.numerique.gouv.fr/dav/caldav/u1/" },
  );
});

test("extractCalDavUrl: a quoted reply to the bot's refusal does not hide the real URL", () => {
  const body = [
    "> <@bot:srv> ⛔ Ce lien n'est pas une URL CalDAV La Suite : je ne l'ai pas ouvert.",
    "> Elle commence par `https://messagerie.numerique.gouv.fr/dav/caldav/`.",
    "",
    "https://messagerie.numerique.gouv.fr/dav/caldav/QWxpY2VDYWw",
  ].join("\n");
  assert.deepEqual(extractCalDavUrl(body), {
    kind: "ok",
    url: "https://messagerie.numerique.gouv.fr/dav/caldav/QWxpY2VDYWw",
  });
  assert.deepEqual(
    extractCalDavUrl("`https://messagerie.numerique.gouv.fr/dav/caldav/QWxpY2VDYWw`"),
    { kind: "ok", url: "https://messagerie.numerique.gouv.fr/dav/caldav/QWxpY2VDYWw" },
  );
});

test("extractCalDavUrl: an older URL quoted in the reply is not the answer", () => {
  const body = [
    "> <@alice:srv> https://messagerie.numerique.gouv.fr/dav/caldav/QW5jaWVubmU",
    "",
    "pardon, la bonne : https://messagerie.numerique.gouv.fr/dav/caldav/Tm91dmVsbGU",
  ].join("\n");
  assert.deepEqual(extractCalDavUrl(body), {
    kind: "ok",
    url: "https://messagerie.numerique.gouv.fr/dav/caldav/Tm91dmVsbGU",
  });
});

test("extractCalDavUrl: no link at all", () => {
  assert.deepEqual(extractCalDavUrl("bonjour, je ne sais pas où le trouver"), {
    kind: "none",
  });
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

test("PendingInscriptions: the proof step keeps the URL and code, and counts failures", () => {
  const p = new PendingInscriptions(1000);
  const t0 = 1_000_000;
  p.start("@u:ex", "!dm:ex", t0);
  p.askProof("@u:ex", { url: "https://h/dav/caldav/x/", code: "betabot-ABCDEF", owners: [] }, t0 + 900);
  // The clock restarted at askProof: still pending past the first TTL.
  const pending = p.get("@u:ex", "!dm:ex", t0 + 1500);
  assert.equal(pending?.preuve?.code, "betabot-ABCDEF");
  assert.equal(p.failedProof("@u:ex"), 1);
  assert.equal(p.failedProof("@u:ex"), 2);
  assert.equal(p.get("@u:ex", "!autre:ex", t0 + 1500), undefined);
});

test("newProofCode: betabot- and 6 unambiguous characters, different each time", () => {
  const codes = new Set(Array.from({ length: 50 }, () => newProofCode()));
  for (const c of codes) assert.match(c, /^betabot-[A-HJKMNP-Z2-9]{6}$/);
  assert.ok(codes.size > 45);
});

test("readProofReply: ok, annuler, or anything else", () => {
  assert.equal(readProofReply(" OK "), "ok");
  assert.equal(readProofReply("c'est fait !"), "ok");
  assert.equal(readProofReply("annuler"), "annuler");
  assert.equal(readProofReply("je ne trouve pas où créer l'événement"), "autre");
  assert.equal(readProofReply("C’est fait"), "ok");
  assert.equal(readProofReply("> <@bot:srv> 🔐 Cet agenda…\n\nok"), "ok");
  assert.equal(readProofReply("ok https://messagerie.numerique.gouv.fr/dav/caldav/x/"), "ok");
  assert.equal(readProofReply("ok 👍"), "ok");
  assert.equal(readProofReply("Ok merci !"), "ok");
  // A sentence that merely starts with ok/fait is not the answer: no try burnt.
  for (const t of ["ok je regarde", "Ok, mais je crée ça où ?", "fait pas encore", "ok annuler", "oké"]) {
    assert.equal(readProofReply(t), "autre", t);
  }
});
