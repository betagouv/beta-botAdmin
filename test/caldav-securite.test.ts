import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import {
  checkCalendarUrl,
  davRequest,
  testAccess,
  fetchEvents,
  calendarOwnerEmails,
  parseOrganizerHref,
  parseAddressSet,
  ownsCalendar,
  hasProofEvent,
  type CalEvent,
} from "../src/connectors/caldav.js";

const CAL = "https://messagerie.numerique.gouv.fr/dav/caldav/QWxpY2VDYWw/";

config.caldav.user = "communaute@beta.gouv.fr";
config.caldav.password = "secret-de-test";

// Swap global fetch for a recorder; `reply` decides each answer.
async function withFetch(
  reply: (url: string, init: RequestInit) => Response,
  run: (calls: Array<{ url: string; init: RequestInit }>) => Promise<void>,
): Promise<void> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = input instanceof URL ? input.href : String(input);
    calls.push({ url, init });
    return reply(url, init);
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = orig;
  }
}

const multistatus = (inner: string) =>
  new Response(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${inner}</D:multistatus>`, {
    status: 207,
  });

// What La Suite answers, trimmed: the calendar's invite names the owner's
// principal, the principal lists the owner's addresses.
const INVITE_OX = `<D:response><D:propstat><D:prop><invite xmlns="http://calendarserver.org/ns/"> <CS:organizer> <D:href>mailto:/dav/principals/users/2806</D:href> <CS:common-name>Alice Martin</CS:common-name> </CS:organizer> <CS:user> <D:href>mailto:/dav/principals/users/77</D:href> <CS:access><CS:read /></CS:access> </CS:user> </invite></D:prop></D:propstat></D:response>`;
const PRINCIPAL_OX = `<D:response><D:propstat><D:prop><calendar-user-address-set xmlns="urn:ietf:params:xml:ns:caldav"> <D:href preferred="1">mailto:alice.martin@beta.gouv.fr</D:href> <D:href>mailto:Alice.Martin@numerique.gouv.fr</D:href> <D:href>/dav/principals/users/2806</D:href> <D:href>urn:uuid:00000002-0000-0af6</D:href> </calendar-user-address-set></D:prop></D:propstat></D:response>`;

test("checkCalendarUrl: a La Suite CalDAV URL is accepted, normalised", () => {
  assert.deepEqual(checkCalendarUrl(CAL), { ok: true, url: CAL });
  assert.deepEqual(
    checkCalendarUrl("https://MESSAGERIE.numerique.gouv.fr:443/dav/caldav/x/#frag"),
    { ok: true, url: "https://messagerie.numerique.gouv.fr/dav/caldav/x/" },
  );
});

test("checkCalendarUrl: every way around the host rule is refused", () => {
  for (const raw of [
    "http://messagerie.numerique.gouv.fr/dav/caldav/x/",
    "https://evil.example/dav/caldav/x/",
    "https://messagerie.numerique.gouv.fr.evil.example/dav/caldav/x/",
    "https://evil.example/messagerie.numerique.gouv.fr/dav/caldav/x/",
    "https://messagerie.numerique.gouv.fr@evil.example/dav/caldav/x/",
    "https://user:pass@messagerie.numerique.gouv.fr/dav/caldav/x/",
    "https://evil.example\\@messagerie.numerique.gouv.fr/dav/caldav/x/",
    "https://evil.example#@messagerie.numerique.gouv.fr/dav/caldav/x/",
    "https://messagerie.numerique.gouv.fr:8443/dav/caldav/x/",
    "https://messagerie.numerique.gouv.fr./dav/caldav/x/",
    "https://xn--messagerie-numrique-gouv-fr.example/dav/caldav/x/",
    "https://127.0.0.1/dav/caldav/x/",
    "https://[::1]/dav/caldav/x/",
    "file:///etc/passwd",
    "pas une url",
  ]) {
    assert.equal(checkCalendarUrl(raw).ok, false, raw);
  }
});

test("checkCalendarUrl: a stored URL without the final slash still passes", () => {
  assert.equal(checkCalendarUrl("https://messagerie.numerique.gouv.fr/dav/caldav/QWxpY2VDYWw").ok, true);
});

test("checkCalendarUrl: only calendar collections, `..` resolved before the check", () => {
  for (const raw of [
    // The bare prefix, as in the bot's own refusal message, quoted back.
    "https://messagerie.numerique.gouv.fr/dav/caldav/",
    "https://messagerie.numerique.gouv.fr/dav/caldav/`",
    "https://messagerie.numerique.gouv.fr/dav/caldav/x/y/",
    "https://messagerie.numerique.gouv.fr/appsuite/",
    "https://messagerie.numerique.gouv.fr/dav/principals/users/1",
    "https://messagerie.numerique.gouv.fr/dav/caldav/../../ajax/login",
    "https://messagerie.numerique.gouv.fr/dav/caldav/%2e%2e/%2e%2e/ajax",
  ]) {
    assert.equal(checkCalendarUrl(raw).ok, false, raw);
  }
});

test("davRequest: a refused URL throws before any request goes out", async () => {
  await withFetch(
    () => multistatus(""),
    async (calls) => {
      for (const raw of [
        "https://evil.example/dav/caldav/x/",
        "http://messagerie.numerique.gouv.fr/dav/caldav/x/",
        "https://messagerie.numerique.gouv.fr@evil.example/dav/",
        // Allowed host, but outside /dav/.
        "https://messagerie.numerique.gouv.fr/appsuite/api/login",
        // The host must be equal, not a look-alike or a subdomain.
        "https://evilmessagerie.numerique.gouv.fr/dav/caldav/x/",
        "https://x.messagerie.numerique.gouv.fr/dav/caldav/x/",
      ]) {
        await assert.rejects(davRequest(raw, "PROPFIND", "0", ""), /refusée/, raw);
      }
      assert.equal(calls.length, 0);
    },
  );
});

test("davRequest: credentials only to the allowed host, redirects never followed", async () => {
  await withFetch(
    () => multistatus(""),
    async (calls) => {
      await davRequest(CAL, "PROPFIND", "0", "<x/>");
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.url, CAL);
      assert.equal(calls[0]!.init.redirect, "manual");
      assert.ok(calls[0]!.init.signal, "a timeout signal is set");
      const auth = (calls[0]!.init.headers as Record<string, string>)["Authorization"];
      assert.equal(auth, `Basic ${Buffer.from("communaute@beta.gouv.fr:secret-de-test").toString("base64")}`);
    },
  );
});

test("testAccess: a redirect answer is a failure, not followed", async () => {
  await withFetch(
    () => new Response(null, { status: 302, headers: { Location: "https://evil.example/" } }),
    async (calls) => {
      const res = await testAccess(CAL);
      assert.equal(res.ok, false);
      assert.equal(res.status, 302);
      assert.equal(calls.length, 1);
    },
  );
});

test("testAccess: the old GET is gone — one PROPFIND, and nothing for a foreign URL", async () => {
  await withFetch(
    () => multistatus(""),
    async (calls) => {
      assert.equal((await testAccess("https://evil.example/x.ics")).ok, false);
      assert.equal(calls.length, 0);
      assert.equal((await testAccess(CAL)).ok, true);
      assert.deepEqual(calls.map((c) => c.init.method), ["PROPFIND"]);
    },
  );
});

test("davRequest: an endless body is cut off instead of filling the memory", async () => {
  const chunk = new Uint8Array(1024 * 1024);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      sent++;
      if (sent > 50) c.close();
      else c.enqueue(chunk);
    },
  });
  await withFetch(
    () => new Response(body, { status: 207 }),
    async () => {
      await assert.rejects(davRequest(CAL, "REPORT", "1", ""), /octets/);
      assert.ok(sent < 20, `stopped reading after ${sent} MB`);
    },
  );
});

test("fetchEvents: a stored URL that fails the rule is refused without a request", async () => {
  await withFetch(
    () => multistatus(""),
    async (calls) => {
      const res = await fetchEvents("https://evil.example/dav/caldav/x/", new Date(0), new Date());
      assert.equal(res.refused, true);
      assert.equal(res.ok, false);
      assert.equal(calls.length, 0);
    },
  );
});

test("parseOrganizerHref / parseAddressSet: La Suite's real shapes", () => {
  assert.equal(parseOrganizerHref(INVITE_OX), "mailto:/dav/principals/users/2806");
  // An empty organizer does not borrow the href of the sharee after it.
  assert.equal(
    parseOrganizerHref(`<CS:organizer /><CS:user><D:href>mailto:/dav/principals/users/77</D:href></CS:user>`),
    null,
  );
  assert.deepEqual(parseAddressSet(PRINCIPAL_OX), [
    "alice.martin@beta.gouv.fr",
    "alice.martin@numerique.gouv.fr",
  ]);
});

test("calendarOwnerEmails: invite → principal → addresses, all on the allowed host", async () => {
  await withFetch(
    (url) => (url.includes("/principals/") ? multistatus(PRINCIPAL_OX) : multistatus(INVITE_OX)),
    async (calls) => {
      assert.deepEqual(await calendarOwnerEmails(CAL), [
        "alice.martin@beta.gouv.fr",
        "alice.martin@numerique.gouv.fr",
      ]);
      assert.deepEqual(calls.map((c) => c.url), [
        CAL,
        "https://messagerie.numerique.gouv.fr/dav/principals/users/2806",
      ]);
    },
  );
});

test("calendarOwnerEmails: an organizer pointing to another host is never contacted", async () => {
  const hostile = INVITE_OX.replace(
    "mailto:/dav/principals/users/2806",
    "https://evil.example/dav/principals/users/2806",
  );
  await withFetch(
    () => multistatus(hostile),
    async (calls) => {
      assert.deepEqual(await calendarOwnerEmails(CAL), []);
      assert.deepEqual(calls.map((c) => c.url), [CAL]);
    },
  );
});

test("calendarOwnerEmails: an organizer outside /dav/ on the right host is not contacted either", async () => {
  const hostile = INVITE_OX.replace("mailto:/dav/principals/users/2806", "mailto:/appsuite/api/x");
  await withFetch(
    () => multistatus(hostile),
    async (calls) => {
      assert.deepEqual(await calendarOwnerEmails(CAL), []);
      assert.equal(calls.length, 1);
    },
  );
});

test("calendarOwnerEmails: no organizer, or an error, means owner unknown", async () => {
  await withFetch(
    () => multistatus(`<D:response><D:propstat><D:prop><invite xmlns="http://calendarserver.org/ns/"/></D:prop></D:propstat></D:response>`),
    async () => assert.deepEqual(await calendarOwnerEmails(CAL), []),
  );
  await withFetch(
    () => new Response("nope", { status: 403 }),
    async () => assert.deepEqual(await calendarOwnerEmails(CAL), []),
  );
});

test("ownsCalendar: the Tchap ID is the whole address with @ turned into -", () => {
  const owners = ["jean-pierre.dupont@beta.gouv.fr", "jp.dupont@numerique.gouv.fr"];
  assert.equal(ownsCalendar("@jean-pierre.dupont-beta.gouv.fr:agent.dinum.tchap.gouv.fr", owners), true);
  assert.equal(ownsCalendar("@JP.Dupont-numerique.gouv.fr:agent.dinum.tchap.gouv.fr", owners), true);
  // Same name, another ministry: not the owner.
  assert.equal(ownsCalendar("@jean-pierre.dupont-interieur.gouv.fr:agent.dinum.tchap.gouv.fr", owners), false);
  assert.equal(ownsCalendar("@jean-pierre-dupont-beta.gouv.fr:agent.dinum.tchap.gouv.fr", owners), false);
  assert.equal(ownsCalendar("@jean-pierre.dupont-beta.gouv.fr:agent.dinum.tchap.gouv.fr", []), false);
  assert.equal(ownsCalendar("pas-un-mxid", owners), false);
  // Whole-ID equality: a longer name ending the same way is someone else.
  assert.equal(
    ownsCalendar("@anne-marie.martin-beta.gouv.fr:agent.dinum.tchap.gouv.fr", ["marie.martin@beta.gouv.fr"]),
    false,
  );
  assert.equal(
    ownsCalendar("@marie.martin-beta.gouv.fr.evil-x.fr:agent.dinum.tchap.gouv.fr", ["marie.martin@beta.gouv.fr"]),
    false,
  );
});

function ev(over: Partial<CalEvent>): CalEvent {
  return {
    uid: "u",
    summary: "",
    start: new Date(),
    end: null,
    location: "",
    organizer: "",
    attendees: [],
    meetingUrl: "",
    notesUrl: "",
    ...over,
  };
}

test("hasProofEvent: the owner's own event with the code proves it", () => {
  const owners = ["alice.martin@beta.gouv.fr"];
  assert.equal(hasProofEvent([ev({ summary: "betabot-7F3K9Q" })], "betabot-7F3K9Q", owners), true);
  assert.equal(hasProofEvent([ev({ summary: "preuve BETABOT-7f3k9q" })], "betabot-7F3K9Q", owners), true);
  assert.equal(
    hasProofEvent(
      [ev({ summary: "betabot-7F3K9Q", organizer: "alice.martin@beta.gouv.fr", attendees: ["Alice.Martin@beta.gouv.fr"] })],
      "betabot-7F3K9Q",
      owners,
    ),
    true,
  );
});

test("hasProofEvent: an invitation titled with the code proves nothing", () => {
  const owners = ["alice.martin@beta.gouv.fr"];
  // The attacker invites the owner to an event carrying the code.
  assert.equal(
    hasProofEvent(
      [ev({ summary: "betabot-7F3K9Q", organizer: "mallory@beta.gouv.fr", attendees: ["alice.martin@beta.gouv.fr"] })],
      "betabot-7F3K9Q",
      owners,
    ),
    false,
  );
  assert.equal(
    hasProofEvent(
      [ev({ summary: "betabot-7F3K9Q", organizer: "alice.martin@beta.gouv.fr", attendees: ["mallory@beta.gouv.fr"] })],
      "betabot-7F3K9Q",
      owners,
    ),
    false,
  );
  // Owner unknown: only an event without any participant counts.
  assert.equal(
    hasProofEvent([ev({ summary: "betabot-7F3K9Q", organizer: "mallory@beta.gouv.fr" })], "betabot-7F3K9Q", []),
    false,
  );
  assert.equal(hasProofEvent([ev({ summary: "betabot-7F3K9Q" })], "betabot-7F3K9Q", []), true);
  assert.equal(hasProofEvent([ev({ summary: "betabot-AAAAAA" })], "betabot-7F3K9Q", owners), false);
});
