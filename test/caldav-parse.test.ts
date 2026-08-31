import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMultistatus } from "../src/connectors/caldav.js";

// Sample DAV multistatus as returned by Open-Xchange (La Suite) for a
// calendar-query REPORT. calendar-data is XML-escaped and line-folded, like
// the real response.
const MULTISTATUS = `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/dav/caldav/abc/event1.ics</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"etag1"</d:getetag>
        <cal:calendar-data>BEGIN:VCALENDAR&#13;
VERSION:2.0&#13;
BEGIN:VEVENT&#13;
UID:evt-123@example.org&#13;
SUMMARY:Point OPS hebdo&#13;
DTSTART;TZID=Europe/Paris:20260715T150000&#13;
DTEND;TZID=Europe/Paris:20260715T153000&#13;
ORGANIZER;CN=Maxime:mailto:maxime@beta.gouv.fr&#13;
ATTENDEE:mailto:julien@beta.gouv.fr&#13;
ATTENDEE:mailto:alice@beta.gouv.fr&#13;
LOCATION:https://visio.numerique.gouv.fr/room-42&#13;
END:VEVENT&#13;
END:VCALENDAR&#13;
</cal:calendar-data>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/caldav/abc/event2.ics</d:href>
    <d:propstat>
      <d:prop>
        <cal:calendar-data>BEGIN:VCALENDAR
BEGIN:VEVENT
UID:evt-456@example.org
SUMMARY:R\\,union budget&#59; T1
DTSTART:20260715T160000Z
DESCRIPTION:Lien: https://meet.example.org/xyz merci
END:VEVENT
END:VCALENDAR
</cal:calendar-data>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

test("parseMultistatus: extracts every VEVENT from the multistatus", () => {
  const events = parseMultistatus(MULTISTATUS);
  assert.equal(events.length, 2);
});

test("parseMultistatus: parses fields of a fully-specified event", () => {
  const [e] = parseMultistatus(MULTISTATUS);
  assert.equal(e.uid, "evt-123@example.org");
  assert.equal(e.summary, "Point OPS hebdo");
  assert.equal(e.organizer, "maxime@beta.gouv.fr");
  assert.deepEqual(e.attendees, [
    "julien@beta.gouv.fr",
    "alice@beta.gouv.fr",
  ]);
  assert.equal(e.location, "https://visio.numerique.gouv.fr/room-42");
  assert.equal(e.meetingUrl, "https://visio.numerique.gouv.fr/room-42");
});

test("parseMultistatus: converts a TZID=Europe/Paris DTSTART to real UTC", () => {
  const [e] = parseMultistatus(MULTISTATUS);
  // TZID=Europe/Paris 15:00 in July (CEST, +2) → 13:00Z.
  assert.equal(e.start?.toISOString(), "2026-07-15T13:00:00.000Z");
});

test("parseMultistatus: TZID conversion respects DST (winter = CET +1)", () => {
  const ical = `<cal:calendar-data>BEGIN:VCALENDAR
BEGIN:VEVENT
UID:winter@example.org
SUMMARY:Hiver
DTSTART;TZID=Europe/Paris:20260115T090000
END:VEVENT
END:VCALENDAR
</cal:calendar-data>`;
  const [e] = parseMultistatus(ical);
  // 09:00 Paris in January (CET, +1) → 08:00Z.
  assert.equal(e.start?.toISOString(), "2026-01-15T08:00:00.000Z");
});

test("parseMultistatus: unescapes TEXT and pulls a URL from DESCRIPTION", () => {
  const e = parseMultistatus(MULTISTATUS)[1];
  assert.equal(e.summary, "R,union budget; T1");
  assert.equal(e.start?.toISOString(), "2026-07-15T16:00:00.000Z");
  assert.equal(e.meetingUrl, "https://meet.example.org/xyz");
});

// Real-world shape: LOCATION holds the Visio room, DESCRIPTION holds a link to
// the meeting notes. The Visio link must win.
test("parseMultistatus: LOCATION visio beats a DESCRIPTION notes link", () => {
  const ical = `<cal:calendar-data>BEGIN:VCALENDAR
BEGIN:VEVENT
UID:hebdo@example.org
SUMMARY:Hebdo raccourci équipe animation
DTSTART:20260723T120000Z
LOCATION:https://visio.numerique.gouv.fr/uba-nsor-unf
DESCRIPTION:Les notes sont prises sur https://www.notion.so/betagouv/R-unions
END:VEVENT
END:VCALENDAR
</cal:calendar-data>`;
  const [e] = parseMultistatus(ical);
  assert.equal(e.meetingUrl, "https://visio.numerique.gouv.fr/uba-nsor-unf");
  assert.equal(e.notesUrl, "https://www.notion.so/betagouv/R-unions");
});

test("parseMultistatus: notesUrl prefers a known notes host in DESCRIPTION", () => {
  const ical = `<cal:calendar-data>BEGIN:VCALENDAR
BEGIN:VEVENT
UID:notes@example.org
SUMMARY:Point
DTSTART:20260723T120000Z
LOCATION:https://visio.numerique.gouv.fr/abc
DESCRIPTION:Ticket https://github.com/betagouv/x/issues/1 — notes https://www.notion.so/betagouv/page
END:VEVENT
END:VCALENDAR
</cal:calendar-data>`;
  const [e] = parseMultistatus(ical);
  assert.equal(e.notesUrl, "https://www.notion.so/betagouv/page");
});

test("parseMultistatus: notesUrl is empty when the only link is the visio", () => {
  const ical = `<cal:calendar-data>BEGIN:VCALENDAR
BEGIN:VEVENT
UID:solo@example.org
SUMMARY:Point
DTSTART:20260723T120000Z
LOCATION:https://visio.numerique.gouv.fr/abc
DESCRIPTION:On se retrouve en visio https://visio.numerique.gouv.fr/abc
END:VEVENT
END:VCALENDAR
</cal:calendar-data>`;
  const [e] = parseMultistatus(ical);
  assert.equal(e.notesUrl, "");
});

// Same, but the conference link only appears in the DESCRIPTION, after another
// link: source order must not beat host recognition.
test("parseMultistatus: a conference host wins wherever it appears", () => {
  const ical = `<cal:calendar-data>BEGIN:VCALENDAR
BEGIN:VEVENT
UID:mix@example.org
SUMMARY:Point
DTSTART:20260723T120000Z
LOCATION:Salle 3\\, 2e étage — https://intranet.example.org/salles
DESCRIPTION:Ordre du jour: https://pad.example.org/x puis https://meet.google.com/abc-defg-hij
END:VEVENT
END:VCALENDAR
</cal:calendar-data>`;
  const [e] = parseMultistatus(ical);
  assert.equal(e.meetingUrl, "https://meet.google.com/abc-defg-hij");
});

// No recognised host anywhere: keep the previous behaviour (first URL found,
// LOCATION first).
test("parseMultistatus: falls back to the first URL when no known host", () => {
  const ical = `<cal:calendar-data>BEGIN:VCALENDAR
BEGIN:VEVENT
UID:fallback@example.org
SUMMARY:Point
DTSTART:20260723T120000Z
DESCRIPTION:Notes https://pad.example.org/x
END:VEVENT
END:VCALENDAR
</cal:calendar-data>`;
  const [e] = parseMultistatus(ical);
  assert.equal(e.meetingUrl, "https://pad.example.org/x");
});
