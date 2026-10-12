import {
  fetchEvents,
  calendarOwnerEmails,
  ownsCalendar,
} from "../connectors/caldav.js";
import {
  buildReminderMessage,
  buildLinkBrokenMessage,
} from "../commands/rappels.js";
import {
  listActiveInscriptions,
  reminderAlreadySent,
  markReminderSent,
  purgeOldSent,
  setStatut,
  type Inscription,
} from "./rappels-store.js";

// Reminder scheduler (docs/rappels-calendrier.md §5.2, "Workflow B"). One tick
// scans every active inscription, finds events starting inside the lead window,
// and DMs a reminder — exactly once per (user, event, start).
//
// IO is injected so a tick can be exercised against fakes in tests and run
// read-only (dryRun) against live data without sending anything.

export interface TickDeps {
  now: Date;
  leadMin: number;
  windowMin: number;
  dryRun: boolean;
  // Contact shown in error messages.
  contact?: string;
  // Send a message to a room (the user's DM room, or an admin room).
  send: (roomId: string, text: string) => Promise<void>;
  // Optional: notify the admin when a user's calendar breaks.
  notifyAdmin?: (text: string) => Promise<void>;
}

export interface TickResult {
  inscriptions: number;
  events: number;
  sent: number;
  broken: number;
  // Rows dropped from the anti-duplicate log this tick.
  purged: number;
}

// HTTP statuses that mean the link/credentials are permanently broken (vs. a
// transient 5xx we should retry next tick).
const BROKEN_STATUSES = new Set([401, 403, 404, 410]);

// Age past which an anti-duplicate row is dropped (docs §4: purge > 24h). A
// row only matters while its event can still fall in the lead window, which is
// minutes after the reminder went out; a day later it can never re-arm one.
const PURGE_AFTER_MS = 24 * 60 * 60 * 1000;

export async function runReminderTick(deps: TickDeps): Promise<TickResult> {
  const { now, leadMin, windowMin, dryRun, send } = deps;
  const windowStart = new Date(now.getTime() + (leadMin - windowMin) * 60_000);
  const windowEnd = new Date(now.getTime() + leadMin * 60_000);

  const inscriptions = await listActiveInscriptions();
  const result: TickResult = {
    inscriptions: inscriptions.length,
    events: 0,
    sent: 0,
    broken: 0,
    purged: 0,
  };

  for (const ins of inscriptions) {
    const res = await fetchEvents(ins.calDavUrl, windowStart, windowEnd);
    if (!res.ok) {
      // `refused`: a stored URL the credentials may not be sent to (saved
      // before the URL rule existed) — as broken as a revoked share.
      if (res.refused || BROKEN_STATUSES.has(res.status)) {
        result.broken++;
        await handleBrokenLink(ins, res.status, deps);
      } else {
        console.warn(
          `[rappels] ${ins.matrixUserId}: lecture agenda échouée (HTTP ${res.status}) — on réessaiera`,
        );
      }
      continue;
    }

    for (const ev of res.events) {
      if (!ev.start) continue;
      result.events++;
      if (await reminderAlreadySent(ins.matrixUserId, ev.uid, ev.start)) continue;

      const msg = buildReminderMessage(ev, leadMin);
      if (dryRun) {
        console.log(
          `[rappels][DRY_RUN] → ${ins.matrixUserId} @ ${ins.roomIdDM}: ${ev.summary} (${ev.start.toISOString()})`,
        );
        // Read-only: do not mark, so a real run still fires.
        continue;
      }
      await send(ins.roomIdDM, msg);
      await markReminderSent({
        matrixUserId: ins.matrixUserId,
        eventUid: ev.uid,
        dateDebut: ev.start,
        envoyeLe: now,
      });
      result.sent++;
    }
  }

  // Housekeeping comes last, so a Grist failure here never costs a reminder.
  // Skipped in dry run, which promises not to write anything.
  if (!dryRun) {
    try {
      result.purged = await purgeOldSent(now.getTime(), PURGE_AFTER_MS);
    } catch (e) {
      console.error("[rappels] purge de RappelsEnvoyes échouée:", e);
    }
  }

  return result;
}

// Active inscriptions whose calendar La Suite attaches to another account
// than the subscriber's. The owner check only runs at inscription time: this
// catches rows stored before it existed. `illisibles`: the owner could not be
// read (La Suite down, timeout, no organizer) — not evidence of anything, so
// kept apart. Read-only — an admin decides.
export async function findForeignInscriptions(): Promise<{
  etrangeres: Inscription[];
  illisibles: Inscription[];
}> {
  const etrangeres: Inscription[] = [];
  const illisibles: Inscription[] = [];
  for (const ins of await listActiveInscriptions()) {
    const owners = await calendarOwnerEmails(ins.calDavUrl);
    if (owners.length === 0) illisibles.push(ins);
    else if (!ownsCalendar(ins.matrixUserId, owners)) etrangeres.push(ins);
  }
  return { etrangeres, illisibles };
}

export function buildForeignInscriptionsNotice(users: string[]): string {
  return [
    `🔎 Rappels : ${users.length} inscription(s) active(s) dont l'agenda n'est pas rattaché au compte Tchap :`,
    ...users.map((u) => `- ${u}`),
    "",
    "Si la personne est bien la propriétaire (même nom, autre domaine), rien à faire : tu ne seras plus prévenu pour elle. Sinon, passe sa ligne en « désactivé » dans Grist : elle reçoit les réunions de quelqu'un d'autre.",
  ].join("\n");
}

async function handleBrokenLink(
  ins: Inscription,
  status: number,
  deps: TickDeps,
): Promise<void> {
  console.warn(
    `[rappels] ${ins.matrixUserId}: lien cassé (HTTP ${status}) → statut=erreur`,
  );
  if (deps.dryRun) return;
  await setStatut(ins.matrixUserId, "erreur");
  try {
    await deps.send(ins.roomIdDM, buildLinkBrokenMessage(deps.contact));
  } catch (e) {
    console.error(`[rappels] notify user failed for ${ins.matrixUserId}:`, e);
  }
  if (deps.notifyAdmin) {
    await deps
      .notifyAdmin(
        `⚠️ Rappels: agenda de ${ins.matrixUserId} illisible (HTTP ${status}), inscription passée en \`erreur\`.`,
      )
      .catch(() => {});
  }
}
