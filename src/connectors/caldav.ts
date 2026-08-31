import { config } from "../config.js";

// Minimal CalDAV read client for La Suite (Open-Xchange), used by the
// meeting-reminder feature (see docs/rappels-calendrier.md). Phase 1 (POC):
// fetch the events starting in a given time window via a REPORT
// calendar-query, then parse the returned iCalendar VEVENTs.

export interface CalEvent {
  uid: string;
  summary: string;
  start: Date | null;
  end: Date | null;
  location: string;
  organizer: string;
  attendees: string[];
  // Best meeting URL found: a recognised video-conference link if the event has
  // one, else the first URL in LOCATION, an X-*-URL property, or DESCRIPTION.
  meetingUrl: string;
  // Companion link to the meeting notes (Notion & co), when the DESCRIPTION has
  // one. Empty when the only link is the conference room.
  notesUrl: string;
}

// Hosts that are actual video-conference links. An event usually carries other
// URLs too (meeting notes, agenda, ticket), so a link on one of these hosts
// wins over any other candidate, whichever property it was found in.
const MEETING_HOST_RE =
  /^https?:\/\/(?:[\w-]+\.)*(?:visio\.numerique\.gouv\.fr|webinaire\.numerique\.gouv\.fr|webconf\.numerique\.gouv\.fr|meet\.numerique\.gouv\.fr|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|zoom\.us|whereby\.com|meet\.jit\.si|framatalk\.org|8x8\.vc)(?:[:/?#]|$)/i;

// Is this URL a video-conference room (vs. a notes/agenda link)? Exported so
// the reminder message can label it « Rejoindre la visio ».
export function isMeetingUrl(url: string): boolean {
  return MEETING_HOST_RE.test(url);
}

// Note-taking hosts, preferred when the description holds several links.
const NOTES_HOST_RE =
  /^https?:\/\/(?:[\w-]+\.)*(?:notion\.so|notion\.site|pad\.numerique\.gouv\.fr|docs\.numerique\.gouv\.fr|hedgedoc\.[\w.-]+|pad\.[\w.-]+)(?:[:/?#]|$)/i;

export interface CalDavResult {
  ok: boolean;
  status: number;
  events: CalEvent[];
  error?: string;
}

// A 2xx multistatus (207) or plain 200/201 is a success. Bug already hit in
// the doc: 201 was wrongly treated as an error.
function isCalDavOk(status: number): boolean {
  return status >= 200 && status < 300;
}

function basicAuthHeader(): string | undefined {
  if (!config.caldav.user || !config.caldav.password) return undefined;
  const raw = `${config.caldav.user}:${config.caldav.password}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

// Format a Date as an iCalendar UTC timestamp: 20260715T133000Z.
function toICalUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// Build the calendar-query REPORT body restricting to VEVENTs whose time
// overlaps [start, end].
function calendarQueryBody(start: Date, end: Date): string {
  const s = toICalUtc(start);
  const e = toICalUtc(end);
  // `<c:expand>` makes the server return concrete OCCURRENCES of recurring
  // events within [start, end], each with its real DTSTART — instead of the
  // recurrence master with its original (possibly long-past) DTSTART. Without
  // it, OX returns the May master for a weekly meeting and the reminder logic
  // never sees the occurrence starting in 15 min.
  return `<?xml version="1.0" encoding="utf-8" ?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag />
    <c:calendar-data>
      <c:expand start="${s}" end="${e}" />
    </c:calendar-data>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${s}" end="${e}" />
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
}

// Test that a calendar URL is reachable with the service credentials, without
// pulling events. A lightweight PROPFIND Depth 0. Any 2xx (200/207, and 201 —
// the doc flagged 201 being wrongly rejected) counts as success.
export async function testAccess(
  url: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
  // 1. iCal feed / share link: a GET returning an iCalendar body is a success.
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: basicAuthHeader() ? { Authorization: basicAuthHeader()! } : {},
    });
    const text = await res.text();
    if (isCalDavOk(res.status) && text.includes("BEGIN:VCALENDAR")) {
      return { ok: true, status: res.status };
    }
  } catch {
    // fall through to CalDAV probe
  }

  // 2. CalDAV collection: a PROPFIND Depth 0 with the service credentials.
  const auth = basicAuthHeader();
  if (!auth) {
    return {
      ok: false,
      status: 0,
      error:
        "URL non lisible en flux iCal, et CalDAV non configuré (CALDAV_USER / CALDAV_PASSWORD manquants)",
    };
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: "PROPFIND",
      headers: {
        Authorization: auth,
        Depth: "0",
        "Content-Type": "application/xml; charset=utf-8",
      },
      body: `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype /><d:displayname /></d:prop></d:propfind>`,
    });
  } catch (e) {
    return { ok: false, status: 0, error: String(e) };
  }
  if (isCalDavOk(res.status)) return { ok: true, status: res.status };
  const text = await res.text().catch(() => "");
  return { ok: false, status: res.status, error: text.slice(0, 300) };
}

// Keep events whose start instant falls within [start, end).
function filterByWindow(events: CalEvent[], start: Date, end: Date): CalEvent[] {
  const lo = start.getTime();
  const hi = end.getTime();
  return events.filter((e) => {
    if (!e.start) return false;
    const t = e.start.getTime();
    return t >= lo && t < hi;
  });
}

// Fetch events overlapping [start, end] from a calendar URL. Two shapes are
// supported, tried in order:
//   1. An iCal feed / OX share link (GET → text/calendar with the whole
//      VCALENDAR). No auth needed — this is what "Partage → lien public" gives.
//      We parse the full feed and filter the window client-side.
//   2. A true CalDAV collection (REPORT calendar-query, Basic auth), used as a
//      fallback when the GET doesn't return an iCalendar body.
export async function fetchEvents(
  url: string,
  start: Date,
  end: Date,
): Promise<CalDavResult> {
  // 1. Try the plain GET iCal feed first (share links, webcal exports).
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      // Send Basic auth if configured — harmless for anonymous share links,
      // required for an authenticated iCal export.
      headers: basicAuthHeader() ? { Authorization: basicAuthHeader()! } : {},
    });
    const text = await res.text();
    if (isCalDavOk(res.status) && text.includes("BEGIN:VCALENDAR")) {
      const events = filterByWindow(parseVEvents(text), start, end);
      return { ok: true, status: res.status, events };
    }
    // A 2xx that isn't iCal (e.g. an HTML page) means this isn't a feed — fall
    // through to the CalDAV path below.
  } catch {
    // Network error on GET — try CalDAV before giving up.
  }

  // 2. Fall back to a CalDAV REPORT calendar-query (needs Basic auth).
  const auth = basicAuthHeader();
  if (!auth) {
    return {
      ok: false,
      status: 0,
      events: [],
      error:
        "URL non lisible en flux iCal, et CalDAV non configuré (CALDAV_USER / CALDAV_PASSWORD manquants)",
    };
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: "REPORT",
      headers: {
        Authorization: auth,
        "Content-Type": "application/xml; charset=utf-8",
        Depth: "1",
      },
      body: calendarQueryBody(start, end),
    });
  } catch (e) {
    return { ok: false, status: 0, events: [], error: String(e) };
  }
  const text = await res.text();
  if (!isCalDavOk(res.status)) {
    return {
      ok: false,
      status: res.status,
      events: [],
      error: text.slice(0, 500),
    };
  }
  const events = filterByWindow(parseMultistatus(text), start, end);
  return { ok: true, status: res.status, events };
}

// Parse a DAV multistatus response body into a flat list of events. Exported
// so the parsing can be unit-tested without a live CalDAV server.
export function parseMultistatus(xml: string): CalEvent[] {
  return extractCalendarData(xml).flatMap(parseVEvents);
}

// Pull each <calendar-data> payload out of the DAV multistatus XML. We avoid a
// full XML parser (no dep) — the calendar-data is CDATA-free text between the
// element tags, possibly namespaced (cal:calendar-data, C:calendar-data, …).
function extractCalendarData(xml: string): string[] {
  const out: string[] = [];
  const re =
    /<(?:[a-zA-Z0-9]+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?calendar-data>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(decodeXmlEntities(m[1]));
  }
  return out;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

// Unfold RFC 5545 line folding: a CRLF followed by a space or tab continues
// the previous line.
function unfold(ical: string): string[] {
  return ical.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
}

// Parse every VEVENT block from an iCalendar string.
function parseVEvents(ical: string): CalEvent[] {
  const lines = unfold(ical);
  const events: CalEvent[] = [];
  let cur: EventAcc = { attendees: [], xPropUrls: [], descriptionUrls: [] };
  let inEvent = false;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      inEvent = true;
      cur = { attendees: [], xPropUrls: [], descriptionUrls: [] };
      continue;
    }
    if (line === "END:VEVENT") {
      if (inEvent) events.push(finalizeEvent(cur));
      inEvent = false;
      continue;
    }
    if (!inEvent) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const rawName = line.slice(0, idx);
    const value = line.slice(idx + 1);
    // Strip parameters after the property name (e.g. DTSTART;TZID=...:).
    const name = rawName.split(";")[0].toUpperCase();
    switch (name) {
      case "UID":
        cur.uid = value;
        break;
      case "SUMMARY":
        cur.summary = unescapeText(value);
        break;
      case "DTSTART":
        cur.start = parseICalDate(rawName, value);
        break;
      case "DTEND":
        cur.end = parseICalDate(rawName, value);
        break;
      case "LOCATION":
        cur.location = unescapeText(value);
        break;
      case "ORGANIZER":
        cur.organizer = value.replace(/^mailto:/i, "");
        break;
      case "ATTENDEE":
        cur.attendees.push(value.replace(/^mailto:/i, ""));
        break;
      case "DESCRIPTION":
        // Collect every URL: the conference link is not necessarily the first
        // one (a description often opens with a link to the meeting notes).
        cur.descriptionUrls.push(...allUrls(unescapeText(value)));
        break;
      default:
        // X-GOOGLE-CONFERENCE, X-MICROSOFT-SKYPETEAMSMEETINGURL, etc.
        if (name.startsWith("X-")) cur.xPropUrls.push(...allUrls(value));
    }
  }
  return events;
}

// Accumulator while parsing one VEVENT. URLs are kept per source so
// finalizeEvent can rank them instead of taking whichever came first.
interface EventAcc extends Partial<CalEvent> {
  attendees: string[];
  xPropUrls: string[];
  descriptionUrls: string[];
}

function finalizeEvent(cur: EventAcc): CalEvent {
  const location = cur.location ?? "";
  // Candidates in source order (LOCATION is where La Suite puts the Visio
  // link), then pick a recognised conference host if there is one — otherwise
  // fall back to the first URL, as before.
  const candidates = [
    ...allUrls(location),
    ...cur.xPropUrls,
    ...cur.descriptionUrls,
  ];
  const meetingUrl = candidates.find(isMeetingUrl) ?? candidates[0] ?? "";
  // Notes link: a known note-taking host in the DESCRIPTION, else the first
  // description link that isn't the conference room we already show.
  const others = cur.descriptionUrls.filter(
    (u) => u !== meetingUrl && !isMeetingUrl(u),
  );
  const notesUrl = others.find((u) => NOTES_HOST_RE.test(u)) ?? others[0] ?? "";
  return {
    uid: cur.uid ?? "",
    summary: cur.summary ?? "(sans titre)",
    start: cur.start ?? null,
    end: cur.end ?? null,
    location,
    organizer: cur.organizer ?? "",
    attendees: cur.attendees,
    meetingUrl,
    notesUrl,
  };
}

// Every http(s) URL in a string, trailing punctuation trimmed.
function allUrls(s: string): string[] {
  return (s.match(/https?:\/\/\S+/g) ?? []).map((u) =>
    u.replace(/[.,;)\]>]+$/, ""),
  );
}

// Unescape RFC 5545 TEXT values: \\, \; \, \n.
function unescapeText(s: string): string {
  return s
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

// Offset (ms) between the given IANA time zone and UTC at a given instant,
// i.e. zoneLocalTime - utc. Computed via Intl so DST is handled. Returns 0 for
// an unknown zone.
function zoneOffsetMs(timeZone: string, at: Date): number {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const p: Record<string, number> = {};
    for (const part of dtf.formatToParts(at)) {
      if (part.type !== "literal") p[part.type] = Number(part.value);
    }
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return asUtc - at.getTime();
  } catch {
    return 0;
  }
}

// Convert a wall-clock time expressed in `timeZone` to the real UTC instant.
// Near a DST transition the offset is momentarily ambiguous (±1h); we accept
// that — reminder timing tolerates it.
function wallClockToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const offset = zoneOffsetMs(timeZone, new Date(guess));
  return new Date(guess - offset);
}

// Parse an iCal date/date-time value. Handles:
//   20260715T133000Z                      (UTC — trailing Z)
//   DTSTART;TZID=Europe/Paris:20260715…   (wall-clock in a named zone)
//   20260715T133000                       (floating, no zone — treated as UTC)
//   VALUE=DATE:20260715                    (all-day)
function parseICalDate(rawName: string, value: string): Date | null {
  if (/VALUE=DATE(?![-])/i.test(rawName) || /^\d{8}$/.test(value)) {
    const m = value.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  // Trailing Z → already UTC.
  if (z) return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  // TZID param → convert that zone's wall-clock to UTC.
  const tzid = rawName.match(/TZID=([^;:]+)/i)?.[1];
  if (tzid) return wallClockToUtc(+y, +mo, +d, +h, +mi, +s, tzid);
  // Floating time, no zone info: fall back to UTC.
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
}
