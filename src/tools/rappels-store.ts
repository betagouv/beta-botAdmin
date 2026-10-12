import { config } from "../config.js";
import {
  addRecords,
  deleteRecords,
  listRecords,
  updateRecords,
  type GristRecord,
} from "../connectors/grist.js";

// Typed store over the two Grist tables (docs/rappels-calendrier.md §4).
// This is the only module that knows the column names — the rest of the bot
// works with the interfaces below.

export type Statut = "actif" | "erreur" | "désactivé";

export interface Inscription {
  rowId: number;
  matrixUserId: string;
  calDavUrl: string;
  roomIdDM: string;
  statut: Statut;
}

// RappelsCalendrier columns.
const C = {
  user: "MatrixUserId",
  url: "CalDAVUrl",
  room: "RoomIdDM",
  statut: "Statut",
  inscrit: "DateInscription",
  dernierTest: "DernierTest",
} as const;

// RappelsEnvoyes columns.
const S = {
  user: "MatrixUserId",
  uid: "EventUID",
  debut: "DateDebut",
  envoye: "EnvoyeLe",
} as const;

// Grist DateTime columns store (and return) an epoch value in SECONDS, not the
// ISO string. Convert at the store boundary so callers work with Date objects.
function toEpochSec(d: Date): number {
  return Math.round(d.getTime() / 1000);
}

function fromEpochSec(v: unknown): Date | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n === 0) return null;
  return new Date(n * 1000);
}

function toInscription(r: GristRecord): Inscription {
  const f = r.fields;
  return {
    rowId: r.id,
    matrixUserId: String(f[C.user] ?? ""),
    calDavUrl: String(f[C.url] ?? ""),
    roomIdDM: String(f[C.room] ?? ""),
    statut: (f[C.statut] as Statut) ?? "erreur",
  };
}

// All inscriptions with Statut = actif (used by the reminder scheduler).
export async function listActiveInscriptions(): Promise<Inscription[]> {
  const records = await listRecords(config.grist.tableInscriptions, {
    [C.statut]: ["actif"],
  });
  return records.map(toInscription);
}

// Find a single inscription by Matrix user id (any status), or null.
export async function findInscription(
  matrixUserId: string,
): Promise<Inscription | null> {
  const records = await listRecords(config.grist.tableInscriptions, {
    [C.user]: [matrixUserId],
  });
  return records.length ? toInscription(records[0]) : null;
}

// Create or update an inscription for a user. Grist has no upsert, so we look
// the user up first and PATCH if present, else POST.
export async function upsertInscription(input: {
  matrixUserId: string;
  calDavUrl: string;
  roomIdDM: string;
  statut: Statut;
  // Timestamp of the last successful CalDAV access test.
  dernierTest?: Date;
  dateInscription?: Date;
}): Promise<void> {
  const fields: Record<string, unknown> = {
    [C.user]: input.matrixUserId,
    [C.url]: input.calDavUrl,
    [C.room]: input.roomIdDM,
    [C.statut]: input.statut,
  };
  if (input.dernierTest) fields[C.dernierTest] = toEpochSec(input.dernierTest);

  const existing = await findInscription(input.matrixUserId);
  if (existing) {
    await updateRecords(config.grist.tableInscriptions, [
      { id: existing.rowId, fields },
    ]);
    return;
  }
  if (input.dateInscription)
    fields[C.inscrit] = toEpochSec(input.dateInscription);
  await addRecords(config.grist.tableInscriptions, [fields]);
}

// Flip a user's status (e.g. to `erreur` when their CalDAV stops working, or
// `désactivé` on /rappels-stop).
// Returns true if an inscription existed and was updated, false if the user
// had none (lets the caller distinguish "unsubscribed" from "was never in").
export async function setStatut(
  matrixUserId: string,
  statut: Statut,
): Promise<boolean> {
  const existing = await findInscription(matrixUserId);
  if (!existing) return false;
  await updateRecords(config.grist.tableInscriptions, [
    { id: existing.rowId, fields: { [C.statut]: statut } },
  ]);
  return true;
}

// ─── Anti-duplicate log (RappelsEnvoyes) ─────────────────────────────────────

// Has a reminder already been sent for this (user, event, start)? The triple
// keys the anti-duplicate check (a recurring event reuses its UID across
// occurrences, so DateDebut disambiguates). DateDebut is a Grist DateTime, so
// we can't filter on it server-side by ISO string — filter by the two Text
// columns, then compare the start instant (epoch seconds) in JS.
export async function reminderAlreadySent(
  matrixUserId: string,
  eventUid: string,
  dateDebut: Date,
): Promise<boolean> {
  const records = await listRecords(config.grist.tableSent, {
    [S.user]: [matrixUserId],
    [S.uid]: [eventUid],
  });
  const target = toEpochSec(dateDebut);
  return records.some((r) => Number(r.fields[S.debut]) === target);
}

// Record that a reminder was sent.
export async function markReminderSent(input: {
  matrixUserId: string;
  eventUid: string;
  dateDebut: Date;
  envoyeLe: Date;
}): Promise<void> {
  await addRecords(config.grist.tableSent, [
    {
      [S.user]: input.matrixUserId,
      [S.uid]: input.eventUid,
      [S.debut]: toEpochSec(input.dateDebut),
      [S.envoye]: toEpochSec(input.envoyeLe),
    },
  ]);
}

// Purge sent-reminder rows older than `olderThanMs` (doc §4: purge > 24h). The
// scheduler calls this at the end of every tick to keep the table small.
export async function purgeOldSent(
  now: number,
  olderThanMs: number,
): Promise<number> {
  const records = await listRecords(config.grist.tableSent);
  const cutoff = now - olderThanMs;
  const stale = records.filter((r) => {
    const d = fromEpochSec(r.fields[S.envoye]);
    return d !== null && d.getTime() < cutoff;
  });
  await deleteRecords(
    config.grist.tableSent,
    stale.map((r) => r.id),
  );
  return stale.length;
}
