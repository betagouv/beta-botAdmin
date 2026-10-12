// Inscription flow for meeting reminders (docs/rappels-calendrier.md §5.1).
//
// This module holds the parts that don't touch Matrix: the conversational
// state (who is waiting to send their CalDAV URL in a DM), URL extraction, and
// the message templates. The MatrixConnector wires these to the actual DM
// send/receive and the CalDAV test + Grist upsert.

import { randomInt } from "node:crypto";
import { checkCalendarUrl, isMeetingUrl } from "../connectors/caldav.js";

// The calendar's addresses don't match the user's Tchap account: they must
// prove the calendar is theirs by creating an event titled `code` in it.
export interface Preuve {
  url: string;
  code: string;
  // The owner's addresses, as La Suite gave them (may be empty).
  owners: string[];
  essais: number;
}

// A user who ran /rappels-calendrier and now owes us a CalDAV URL in their DM,
// or, once the URL is in, the proof that the calendar is theirs.
interface Pending {
  dmRoomId: string;
  since: number;
  preuve?: Preuve;
}

// Wrong answers to the proof before the inscription is dropped.
export const MAX_ESSAIS_PREUVE = 5;

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

  // The in-flight inscription of this user in this specific DM room, unless
  // it expired.
  get(userId: string, dmRoomId: string, now: number): Pending | undefined {
    const p = this.map.get(userId);
    if (!p) return undefined;
    if (now - p.since > this.ttlMs) {
      this.map.delete(userId);
      return undefined;
    }
    return p.dmRoomId === dmRoomId ? p : undefined;
  }

  // Is this user awaiting URL entry in this specific DM room (and not expired)?
  isAwaiting(userId: string, dmRoomId: string, now: number): boolean {
    return this.get(userId, dmRoomId, now) !== undefined;
  }

  // Switch to the proof step. The clock restarts: the user gets a full TTL to
  // create the event.
  askProof(
    userId: string,
    preuve: Omit<Preuve, "essais">,
    now: number,
  ): void {
    const p = this.map.get(userId);
    if (!p) return;
    p.preuve = { ...preuve, essais: 0 };
    p.since = now;
  }

  // Count a proof that was not found; returns how many have failed so far.
  failedProof(userId: string): number {
    const preuve = this.map.get(userId)?.preuve;
    if (!preuve) return 0;
    preuve.essais += 1;
    return preuve.essais;
  }

  clear(userId: string): void {
    this.map.delete(userId);
  }
}

// Drop the quoted lines a Matrix reply puts before the answer ("> <@bot> …"):
// the bot's own words, URL template included, are not the user's answer.
function sansCitation(body: string): string {
  return body
    .split("\n")
    .filter((l) => !l.startsWith(">"))
    .join("\n");
}

export type ExtractedUrl =
  | { kind: "ok"; url: string }
  // The message holds links, none of them a La Suite CalDAV URL.
  | { kind: "refused" }
  | { kind: "none" };

// Pull a CalDAV URL out of a free-text DM reply: the first link that passes
// checkCalendarUrl. Any other link is never contacted — the bot would send it
// the service account's credentials. Trailing punctuation is trimmed.
export function extractCalDavUrl(body: string): ExtractedUrl {
  const urls = sansCitation(body).match(/https?:\/\/\S+/gi) ?? [];
  const cleaned = urls.map((u) => u.replace(/[.,;:!?)\]>"'`*»’]+$/, ""));
  for (const u of cleaned) {
    const check = checkCalendarUrl(u);
    if (check.ok) return { kind: "ok", url: check.url };
  }
  return cleaned.length > 0 ? { kind: "refused" } : { kind: "none" };
}

// Code the user puts in an event title to prove the calendar is theirs. No
// 0/O or 1/I/L, so it survives being retyped.
const ALPHABET_CODE = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function newProofCode(): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += ALPHABET_CODE[randomInt(ALPHABET_CODE.length)];
  return `betabot-${s}`;
}

// What a DM means while the proof is awaited. A quoted reply, a typographic
// apostrophe, punctuation, an emoji or the calendar URL pasted again around
// the `ok` don't change it — but the whole message must be the answer: « ok je
// regarde » or « fait pas encore » must not burn one of the tries.
export function readProofReply(body: string): "ok" | "annuler" | "autre" {
  const t = sansCitation(body)
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[’‘]/g, "'")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/^(ok|okay|c'est fait|c fait|fait|done)( (merci|c'est bon|voilà|voila))?$/.test(t)) return "ok";
  if (/^(annuler|annule|stop)$/.test(t)) return "annuler";
  return "autre";
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

// `proofCode`: the inscription went through the proof step, the event can go.
export function buildSuccessMessage(proofCode?: string): string {
  const ok = "✅ C'est bon, tu seras prévenu·e avant ton prochain rendez-vous.";
  return proofCode
    ? `${ok}\n\nTu peux supprimer l'événement \`${proofCode}\` de ton agenda.`
    : ok;
}

export function buildRefusedUrlMessage(host: string): string {
  return [
    "⛔ Ce lien n'est pas une URL CalDAV La Suite : je ne l'ai pas ouvert.",
    "",
    `Elle commence par \`https://${host}/dav/caldav/\`. Tu la trouves dans le ` +
      "menu de ton agenda → *Propriétés* → champ *URL CalDAV*.",
  ].join("\n");
}

export function buildProofChallengeMessage(code: string): string {
  return [
    "🔐 Cet agenda n'est pas rattaché à l'adresse de ton compte Tchap. " +
      "Avant de t'inscrire, je dois vérifier qu'il est bien à toi.",
    "",
    `1. Dans cet agenda, crée un événement **aujourd'hui** intitulé \`${code}\`, sans inviter personne.`,
    "2. Réponds `ok` ici.",
    "",
    "Tu pourras supprimer l'événement juste après. Pour abandonner : `annuler`.",
  ].join("\n");
}

export function buildProofPendingMessage(code: string): string {
  return `⏳ J'attends ta preuve : un événement \`${code}\` dans ton agenda, puis \`ok\` ici. Pour abandonner : \`annuler\`.`;
}

export function buildProofNotFoundMessage(code: string, restants: number): string {
  return [
    `🔎 Je ne trouve pas d'événement \`${code}\` sans invité dans cet agenda, entre hier et demain.`,
    "",
    `Vérifie le titre, puis réponds \`ok\` (encore ${restants} essai${restants > 1 ? "s" : ""}), ou \`annuler\`.`,
  ].join("\n");
}

export function buildProofFailedMessage(): string {
  return "⛔ Je n'ai pas trouvé la preuve : inscription abandonnée. Relance `/rappels-calendrier` pour recommencer.";
}

export function buildProofCancelledMessage(): string {
  return "👌 Inscription abandonnée. Relance `/rappels-calendrier` quand tu veux.";
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
