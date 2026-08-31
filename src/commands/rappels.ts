// Inscription flow for meeting reminders (docs/rappels-calendrier.md §5.1).
//
// This module holds the parts that don't touch Matrix: the conversational
// state (who is waiting to send their CalDAV URL in a DM), URL extraction, and
// the message templates. The MatrixConnector wires these to the actual DM
// send/receive and the CalDAV test + Grist upsert.

import { isMeetingUrl } from "../connectors/caldav.js";

// A user who ran /rappels-calendrier and now owes us a CalDAV URL in their DM.
interface Pending {
  dmRoomId: string;
  since: number;
}

// Tracks the in-flight inscriptions, keyed by Matrix user id. In-memory only:
// on a bot restart the user simply re-runs the command. A pending entry is
// dropped after `ttlMs` so a stale prompt doesn't capture an unrelated message
// weeks later.
export class PendingInscriptions {
  private readonly map = new Map<string, Pending>();

  constructor(private readonly ttlMs = 24 * 60 * 60 * 1000) {}

  start(userId: string, dmRoomId: string, now: number): void {
    this.map.set(userId, { dmRoomId, since: now });
  }

  // Is this user awaiting URL entry in this specific DM room (and not expired)?
  isAwaiting(userId: string, dmRoomId: string, now: number): boolean {
    const p = this.map.get(userId);
    if (!p) return false;
    if (now - p.since > this.ttlMs) {
      this.map.delete(userId);
      return false;
    }
    return p.dmRoomId === dmRoomId;
  }

  clear(userId: string): void {
    this.map.delete(userId);
  }
}

// Pull a CalDAV URL out of a free-text DM reply. Prefers a La Suite
// (messagerie.numerique.gouv.fr) DAV URL, else falls back to the first http(s)
// URL in the message. Trailing punctuation is trimmed.
export function extractCalDavUrl(body: string): string | null {
  const urls = body.match(/https?:\/\/\S+/g) ?? [];
  const cleaned = urls.map((u) => u.replace(/[.,;)\]]+$/, ""));
  const preferred = cleaned.find(
    (u) => /messagerie\.numerique\.gouv\.fr/i.test(u) && /caldav|dav/i.test(u),
  );
  return preferred ?? cleaned[0] ?? null;
}

// ─── Message templates ───────────────────────────────────────────────────────

export function buildWelcomeMessage(
  helpUrl: string,
  serviceAccount: string,
): string {
  return [
    "Bonjour 👋 Je viens vers toi pour configurer tes **rappels de réunion**.",
    "",
    "**2 étapes** :",
    `1. Partage ton agenda avec \`${serviceAccount}\` en **lecture seule** ` +
      "(menu de l'agenda → *Partage / Droits*).",
    "2. Envoie-moi ton **URL CalDAV** (menu de l'agenda → *Propriétés* → " +
      "champ *URL CalDAV*).",
    "",
    `Guide illustré : [trouver mon lien CalDAV](${helpUrl})`,
    "",
    "Colle simplement l'URL dans ce message privé, je m'occupe du reste.",
  ].join("\n");
}

// Shown in the OPS/command room where the command was typed.
export function buildStartedInRoomMessage(): string {
  return "📨 Je t'ai envoyé un message privé pour configurer tes rappels.";
}

export function buildNoUrlMessage(): string {
  return [
    "🤔 Je n'ai pas trouvé d'URL dans ton message.",
    "",
    "Envoie-moi le lien CalDAV complet (il commence par `https://`).",
  ].join("\n");
}

export function buildSuccessMessage(): string {
  return "✅ C'est bon, tu seras prévenu·e avant ton prochain rendez-vous.";
}

export function buildAccessErrorMessage(
  serviceAccount: string,
  contact?: string,
): string {
  const who = contact ? contact : "Maxime ou Julien";
  return [
    "⛔ Je n'arrive pas à lire ton agenda avec ce lien.",
    "",
    `As-tu bien partagé ton agenda avec \`${serviceAccount}\` en lecture ? ` +
      "C'est nécessaire pour que je puisse le lire.",
    "",
    `Si le souci persiste, préviens ${who}.`,
  ].join("\n");
}

// Format an event start in Europe/Paris as HH:MM.
function formatParisTime(d: Date): string {
  return new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Paris",
  }).format(d);
}

// The reminder DM sent ~`leadMin` minutes before an event (docs §5.2.5). Shape:
//   📅 Rappel : *Titre* dans ~15 min (10:30) avec organisateur.
//   🔗 [Rejoindre la visio](https://visio…)
//   📝 [Notes](https://www.notion.so/…)
export function buildReminderMessage(
  event: {
    summary: string;
    start: Date | null;
    organizer: string;
    attendees: string[];
    meetingUrl: string;
    notesUrl?: string;
  },
  leadMin: number,
): string {
  const time = event.start ? ` (${formatParisTime(event.start)})` : "";
  const withWho = event.organizer
    ? ` avec ${event.organizer}`
    : event.attendees.length
      ? ` avec ${event.attendees.length} participant${event.attendees.length > 1 ? "s" : ""}`
      : "";
  const head = `📅 Rappel : **${event.summary}** dans ~${leadMin} min${time}${withWho}.`;
  const lines = [head];
  if (event.meetingUrl) {
    // A recognised conference room gets a short label; any other link is shown
    // raw so the user sees where it points.
    const link = isMeetingUrl(event.meetingUrl)
      ? `[Rejoindre la visio](${event.meetingUrl})`
      : event.meetingUrl;
    lines.push(`🔗 ${link}`);
  }
  // Notes link (Notion & co), only when it isn't already the link above.
  if (event.notesUrl && event.notesUrl !== event.meetingUrl) {
    lines.push(`📝 [Notes](${event.notesUrl})`);
  }
  return lines.join("\n");
}

// Sent once to a user when their calendar link stops working (docs §5.2.7).
export function buildLinkBrokenMessage(contact?: string): string {
  const who = contact ? contact : "Maxime ou Julien";
  return [
    "⚠️ Je n'arrive plus à lire ton agenda — ton lien ne fonctionne peut-être plus,",
    `ou le partage avec le bot a été retiré. Tes rappels sont en pause.`,
    "",
    `Retape \`/rappels-calendrier\` pour te réinscrire, ou préviens ${who}.`,
  ].join("\n");
}

export function buildStopMessage(): string {
  return "🔕 C'est noté, tu ne recevras plus de rappels. Retape `/rappels-calendrier` pour te réinscrire.";
}

export function buildStopNotFoundMessage(): string {
  return "ℹ️ Tu n'étais pas inscrit·e aux rappels.";
}
