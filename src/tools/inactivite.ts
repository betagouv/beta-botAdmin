import type { MatrixClient } from "matrix-bot-sdk";
import type { CreatedRoom } from "../commands/created-rooms.js";
import { PREFIXE_SALON_ALERTE } from "../commands/alerte.js";

// Inactive-room sweep. The bot watches the rooms it created
// (data/created-rooms.json): after `inactiveDays` without a human message it
// warns the room, and if nobody writes within `graceDays` it closes it the way
// `/salon delete` does (detach, kick, leave). The `/alerte` rooms are listed
// there too but left out: an alert room is closed by the people handling it.
//
// IO is injected so a tick can be exercised against fakes in tests and run
// read-only (dryRun) against live data without warning or closing anything.

const DAY_MS = 86_400_000;

export interface InactiviteDeps {
  now: number;
  inactiveDays: number;
  graceDays: number;
  dryRun: boolean;
  rooms: CreatedRoom[];
  // Timestamp of the latest message a human sent in the room, null if nobody
  // ever wrote. Throws when the bot can no longer read the room.
  lastHumanMessage: (roomId: string) => Promise<number | null>;
  send: (roomId: string, text: string) => Promise<void>;
  // Close the room; returns how many members were kicked.
  close: (roomId: string) => Promise<number>;
  // Persist when the room was warned; undefined clears it.
  setWarned: (roomId: string, ts: number | undefined) => void;
  notifyAdmin?: (text: string) => Promise<void>;
}

export interface InactiviteResult {
  salons: number;
  avertis: number;
  fermes: number;
  repris: number;
  erreurs: number;
}

// Day in Paris, e.g. 26/10/2026.
function jour(ts: number): string {
  return new Date(ts).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" });
}

export function buildWarningMessage(lastActivity: number, deadline: number): string {
  return (
    `⏳ **Aucun message dans ce salon depuis le ${jour(lastActivity)}.**\n\n` +
    `Sans nouveau message d'ici le **${jour(deadline)}**, je le fermerai : ` +
    `il sera retiré de l'espace et ses membres en seront exclus.\n\n` +
    `Pour le garder, il suffit d'écrire un message ici.`
  );
}

export async function runInactivityTick(
  deps: InactiviteDeps,
): Promise<InactiviteResult> {
  const { now, dryRun } = deps;
  // A NaN or zero here (bad env value) would make every room look idle and
  // every grace period over: refuse rather than close everything.
  if (!(deps.inactiveDays > 0 && deps.graceDays > 0)) {
    throw new Error(
      `durées invalides (INACTIVITE_JOURS=${deps.inactiveDays}, INACTIVITE_DELAI_JOURS=${deps.graceDays})`,
    );
  }
  const inactiveMs = deps.inactiveDays * DAY_MS;
  const graceMs = deps.graceDays * DAY_MS;
  const rooms = deps.rooms.filter(
    (r) => !r.name.startsWith(PREFIXE_SALON_ALERTE),
  );
  const result: InactiviteResult = {
    salons: rooms.length,
    avertis: 0,
    fermes: 0,
    repris: 0,
    erreurs: 0,
  };

  for (const room of rooms) {
    const label = `${room.name} (${room.roomId})`;
    let last: number | null;
    try {
      last = await deps.lastHumanMessage(room.roomId);
    } catch (err) {
      console.warn(`[inactivite] ${label} illisible, ignoré :`, err);
      result.erreurs++;
      continue;
    }
    // A room nobody ever wrote in counts from its creation.
    const activity = Math.max(last ?? 0, room.createdTs);

    if (room.avertiLe !== undefined) {
      if (activity > room.avertiLe) {
        // Someone wrote after the warning: the room stays, the countdown stops.
        result.repris++;
        if (!dryRun) deps.setWarned(room.roomId, undefined);
        continue;
      }
      if (now - room.avertiLe < graceMs) continue;
      result.fermes++;
      if (dryRun) {
        console.log(`[inactivite][DRY_RUN] fermerait ${label}`);
        continue;
      }
      try {
        const kicked = await deps.close(room.roomId);
        await deps
          .notifyAdmin?.(
            `🗑 Salon **${room.name}** fermé pour inactivité : aucun message depuis le ${jour(activity)}, ${kicked} membre(s) exclu(s).`,
          )
          .catch(() => {});
      } catch (err) {
        console.error(`[inactivite] fermeture de ${label} échouée :`, err);
        result.fermes--;
        result.erreurs++;
      }
      continue;
    }

    if (now - activity < inactiveMs) continue;
    result.avertis++;
    if (dryRun) {
      console.log(
        `[inactivite][DRY_RUN] avertirait ${label} : aucun message depuis le ${jour(activity)}`,
      );
      continue;
    }
    try {
      await deps.send(room.roomId, buildWarningMessage(activity, now + graceMs));
      deps.setWarned(room.roomId, now);
    } catch (err) {
      // Not marked: the next tick tries again.
      console.error(`[inactivite] avertissement de ${label} échoué :`, err);
      result.avertis--;
      result.erreurs++;
    }
  }

  return result;
}

// Latest message sent in the room by anyone but the bot. In an encrypted room
// the bot may fail to decrypt, but the m.room.encrypted envelope still carries
// the sender and the timestamp, which is all this needs. The bot's own posts
// (its warning included) never count as activity.
export async function lastHumanMessageTs(
  client: Pick<MatrixClient, "doRequest">,
  roomId: string,
  botUserId: string,
): Promise<number | null> {
  const filter = {
    types: ["m.room.message", "m.room.encrypted"],
    not_senders: [botUserId],
  };
  const res = (await client.doRequest(
    "GET",
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`,
    { dir: "b", limit: 1, filter: JSON.stringify(filter) },
  )) as { chunk?: Array<{ origin_server_ts?: unknown }> };
  const ts = res.chunk?.[0]?.origin_server_ts;
  return typeof ts === "number" ? ts : null;
}

// The space the room hangs from: its canonical m.space.parent, else any live
// one. Undefined when it has none (the caller falls back to the managed space).
export async function parentSpace(
  client: Pick<MatrixClient, "getRoomState">,
  roomId: string,
): Promise<string | undefined> {
  try {
    const state = (await client.getRoomState(roomId)) as Array<{
      type: string;
      state_key?: string;
      content?: Record<string, unknown>;
    }>;
    const parents = state.filter(
      (e) =>
        e.type === "m.space.parent" &&
        typeof e.state_key === "string" &&
        e.content &&
        Object.keys(e.content).length > 0,
    );
    return (parents.find((e) => e.content?.["canonical"] === true) ?? parents[0])
      ?.state_key;
  } catch {
    return undefined;
  }
}
