import type { MatrixClient } from "matrix-bot-sdk";
import { config } from "../config.js";
import { addCreatedRoom, removeCreatedRoom } from "./created-rooms.js";

// Manage rooms inside a single configured Space (MATRIX_MANAGED_SPACE):
// create a room attached to the space, or "close" one (detach + kick + leave).
// Restricted to admins in command rooms by the caller (see matrix.ts).

// A requester must have at least this power level in a room to close it.
const MODERATOR_POWER_LEVEL = 50;

// Human-friendly aliases for power levels accepted by `/salon role`.
const LEVEL_ALIASES: Record<string, number> = {
  membre: 0,
  member: 0,
  user: 0,
  utilisateur: 0,
  mod: 50,
  modo: 50,
  moderateur: 50,
  modérateur: 50,
  moderator: 50,
  admin: 100,
  administrateur: 100,
};

// Parse a level from a keyword (admin/moderateur/membre) or a 0–100 integer.
function parseLevel(raw: string): number | null {
  const key = raw.toLowerCase();
  if (key in LEVEL_ALIASES) return LEVEL_ALIASES[key]!;
  if (/^\d+$/.test(raw)) {
    const n = parseInt(raw, 10);
    if (n >= 0 && n <= 100) return n;
  }
  return null;
}

export interface RoomCmdResult {
  reaction: string;
  message: string;
}

interface SpaceChild {
  roomId: string;
  name: string;
}

// Server-name part of a Matrix ID, used as the `via` for space relations.
function serverName(id: string): string {
  const i = id.indexOf(":");
  return i >= 0 ? id.slice(i + 1) : "";
}

// Close a room: detach it from the space, kick every member except the bot,
// then the bot leaves last. Returns how many members were kicked. Used by the
// `/salon delete` command.
export async function detachAndClose(
  client: MatrixClient,
  spaceId: string | undefined,
  roomId: string,
  botUserId: string,
): Promise<number> {
  if (spaceId) {
    try {
      await client.sendStateEvent(spaceId, "m.space.child", roomId, {});
    } catch {
      // not attached / no power — proceed anyway
    }
    try {
      await client.sendStateEvent(roomId, "m.space.parent", spaceId, {});
    } catch {
      // not critical
    }
  }
  let kicked = 0;
  try {
    const members = await client.getJoinedRoomMembers(roomId);
    for (const m of members) {
      if (m === botUserId) continue;
      try {
        await client.kickUser(m, roomId, "Salon fermé");
        kicked++;
      } catch {
        // member already gone / insufficient power on a specific user
      }
    }
  } catch {
    // could not list members
  }
  try {
    await client.leaveRoom(roomId);
  } catch {
    // already left
  }
  removeCreatedRoom(roomId);
  return kicked;
}

// State event shape returned by getRoomState (loosely typed).
interface StateEvent {
  type: string;
  state_key?: string;
  content?: Record<string, unknown>;
}

// List the live children of the space (m.space.child with non-empty content),
// resolving each child's display name.
async function listChildren(
  client: MatrixClient,
  spaceId: string,
): Promise<SpaceChild[]> {
  const state = (await client.getRoomState(spaceId)) as StateEvent[];
  const childIds: string[] = [];
  for (const e of state) {
    if (
      e.type === "m.space.child" &&
      typeof e.state_key === "string" &&
      e.content &&
      Object.keys(e.content).length > 0
    ) {
      childIds.push(e.state_key);
    }
  }

  const result: SpaceChild[] = [];
  for (const roomId of childIds) {
    let name = "";
    try {
      const c = (await client.getRoomStateEvent(roomId, "m.room.name", "")) as {
        name?: string;
      };
      name = c?.name ?? "";
    } catch {
      // room not joinable / no name — keep empty
    }
    result.push({ roomId, name });
  }
  return result;
}

async function createRoom(
  client: MatrixClient,
  spaceId: string,
  name: string,
  inviteUserId: string,
  botUserId: string,
): Promise<RoomCmdResult> {
  const existing = await listChildren(client, spaceId);
  if (existing.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    return {
      reaction: "⚠️",
      message: `⚠️ Un salon nommé **${name}** existe déjà dans l'espace géré.`,
    };
  }

  // Who gets invited: the requester, or — when the bot created the room for
  // itself (self command, e.g. via n8n) — the configured default invitees.
  // The bot's own account must never be in the list: inviting yourself (or a
  // user already in the room) is rejected by the server with M_FORBIDDEN.
  const invitees = (
    inviteUserId && inviteUserId !== botUserId
      ? [inviteUserId]
      : config.matrix.defaultInvites
  ).filter((u) => u !== botUserId);

  // Keep the bot as admin (100) and make every invitee a moderator (50) so
  // they can manage/close the room. `users` is replaced wholesale by the
  // override, so the bot must be listed explicitly or it loses its power.
  const users: Record<string, number> = { [botUserId]: 100 };
  for (const u of invitees) users[u] = MODERATOR_POWER_LEVEL;

  const spaceVia = serverName(spaceId);
  const roomId = await client.createRoom({
    name,
    preset: "private_chat",
    visibility: "private",
    invite: invitees,
    power_level_content_override: { users },
    initial_state: [
      {
        type: "m.space.parent",
        state_key: spaceId,
        content: { via: [spaceVia], canonical: true },
      },
      {
        type: "m.room.encryption",
        state_key: "",
        content: { algorithm: "m.megolm.v1.aes-sha2" },
      },
    ],
  });

  // Lower every threshold so a moderator (50) has all possible rights: room
  // settings, kick/ban/redact/invite, and even power_levels / server_acl /
  // tombstone. Matrix auth rules still cap what a level-50 user can do with
  // power_levels: they can't grant above their own level nor touch users at a
  // higher level, so the bot (100) stays safe. Done as a follow-up event
  // because Synapse rejects a full power-level override at create time.
  try {
    const pl = (await client.getRoomStateEvent(
      roomId,
      "m.room.power_levels",
      "",
    )) as Record<string, unknown> & { events?: Record<string, number> };
    await client.sendStateEvent(roomId, "m.room.power_levels", "", {
      ...pl,
      state_default: MODERATOR_POWER_LEVEL,
      ban: MODERATOR_POWER_LEVEL,
      kick: MODERATOR_POWER_LEVEL,
      redact: MODERATOR_POWER_LEVEL,
      invite: MODERATOR_POWER_LEVEL,
      events: {
        ...(pl.events ?? {}),
        "m.room.name": MODERATOR_POWER_LEVEL,
        "m.room.topic": MODERATOR_POWER_LEVEL,
        "m.room.avatar": MODERATOR_POWER_LEVEL,
        "m.room.canonical_alias": MODERATOR_POWER_LEVEL,
        "m.room.history_visibility": MODERATOR_POWER_LEVEL,
        "m.room.encryption": MODERATOR_POWER_LEVEL,
        "m.room.join_rules": MODERATOR_POWER_LEVEL,
        "m.room.power_levels": MODERATOR_POWER_LEVEL,
        "m.room.server_acl": MODERATOR_POWER_LEVEL,
        "m.room.tombstone": MODERATOR_POWER_LEVEL,
      },
    });
  } catch {
    // room is still usable with default levels if this step fails
  }

  // Attach the room to the space (needs power in the space — checked at startup).
  await client.sendStateEvent(spaceId, "m.space.child", roomId, {
    via: [serverName(roomId)],
  });

  // Track it so `/salon` commands can manage it later.
  addCreatedRoom(roomId, name);

  return {
    reaction: "✅",
    message: `🏠 Salon **${name}** créé et rattaché à l'espace géré.\nID : \`${roomId}\``,
  };
}

// Requester's power level in a room (users[id] → users_default → 0).
async function powerLevelOf(
  client: MatrixClient,
  roomId: string,
  userId: string,
): Promise<number> {
  try {
    const pl = (await client.getRoomStateEvent(
      roomId,
      "m.room.power_levels",
      "",
    )) as { users?: Record<string, number>; users_default?: number };
    return pl?.users?.[userId] ?? pl?.users_default ?? 0;
  } catch {
    return 0;
  }
}

async function closeRoom(
  client: MatrixClient,
  spaceId: string,
  name: string,
  botUserId: string,
  requesterUserId: string,
): Promise<RoomCmdResult> {
  const children = await listChildren(client, spaceId);
  const matches = children.filter(
    (c) => c.name.toLowerCase() === name.toLowerCase(),
  );
  if (matches.length === 0) {
    return {
      reaction: "❌",
      message: `❌ Aucun salon nommé **${name}** dans l'espace géré. Tape \`/salon list\` pour voir les salons.`,
    };
  }
  if (matches.length > 1) {
    return {
      reaction: "⚠️",
      message: `⚠️ Plusieurs salons s'appellent **${name}**. Renomme l'un d'eux pour lever l'ambiguïté avant de supprimer.`,
    };
  }
  const roomId = matches[0]!.roomId;

  // Permission: the requester must be moderator or above in the target room.
  const level = await powerLevelOf(client, roomId, requesterUserId);
  if (level < MODERATOR_POWER_LEVEL) {
    return {
      reaction: "⛔",
      message: `⛔ Tu dois être **modérateur ou plus** (niveau ≥ ${MODERATOR_POWER_LEVEL}) dans **${name}** pour le fermer. Ton niveau dans ce salon : ${level}.`,
    };
  }

  const kicked = await detachAndClose(client, spaceId, roomId, botUserId);

  return {
    reaction: "✅",
    message: `🗑 Salon **${name}** fermé : détaché de l'espace, ${kicked} membre(s) expulsé(s), le bot a quitté.`,
  };
}

// Resolve a unique child room by name, or return an error result.
async function resolveUniqueChild(
  client: MatrixClient,
  spaceId: string,
  name: string,
): Promise<{ roomId: string } | { error: RoomCmdResult }> {
  const matches = (await listChildren(client, spaceId)).filter(
    (c) => c.name.toLowerCase() === name.toLowerCase(),
  );
  if (matches.length === 0)
    return {
      error: {
        reaction: "❌",
        message: `❌ Aucun salon nommé **${name}** dans l'espace géré. Tape \`/salon list\`.`,
      },
    };
  if (matches.length > 1)
    return {
      error: {
        reaction: "⚠️",
        message: `⚠️ Plusieurs salons s'appellent **${name}**. Renomme l'un d'eux pour lever l'ambiguïté.`,
      },
    };
  return { roomId: matches[0]!.roomId };
}

async function setRole(
  client: MatrixClient,
  spaceId: string,
  roomName: string,
  targetUserId: string,
  levelStr: string,
  requesterIsAdmin: boolean,
): Promise<RoomCmdResult> {
  if (!requesterIsAdmin) {
    return {
      reaction: "⛔",
      message:
        "⛔ `/salon role` est réservée aux administrateurs (liste `MATRIX_ADMIN_USERS`).",
    };
  }
  if (!/^@[^:]+:.+/.test(targetUserId)) {
    return {
      reaction: "❌",
      message: `❌ Identifiant utilisateur invalide : \`${targetUserId}\`. Format attendu : \`@nom:serveur\`.`,
    };
  }
  const level = parseLevel(levelStr);
  if (level === null) {
    return {
      reaction: "❌",
      message: `❌ Niveau invalide : \`${levelStr}\`. Utilise \`membre\`/\`moderateur\`/\`admin\` ou un nombre 0–100.`,
    };
  }

  const resolved = await resolveUniqueChild(client, spaceId, roomName);
  if ("error" in resolved) return resolved.error;
  const roomId = resolved.roomId;

  // Read current power levels, update just this user, write back.
  const pl = (await client.getRoomStateEvent(
    roomId,
    "m.room.power_levels",
    "",
  )) as Record<string, unknown> & { users?: Record<string, number> };
  const content = { ...pl, users: { ...(pl.users ?? {}), [targetUserId]: level } };
  await client.sendStateEvent(roomId, "m.room.power_levels", "", content);

  const labelEntry = Object.entries(LEVEL_ALIASES).find(([, v]) => v === level);
  const label = labelEntry ? ` (${labelEntry[0]})` : "";
  return {
    reaction: "✅",
    message: `✅ Niveau de **${targetUserId}** dans **${roomName}** réglé à **${level}**${label}.`,
  };
}

async function listRooms(
  client: MatrixClient,
  spaceId: string,
): Promise<RoomCmdResult> {
  // Only list rooms that actually have a name (skip unnamed / unreadable ones),
  // and show just the name — no room IDs.
  const named = (await listChildren(client, spaceId)).filter(
    (c) => c.name.trim().length > 0,
  );
  if (named.length === 0) {
    return { reaction: "📭", message: "📭 Aucun salon nommé dans l'espace géré." };
  }
  const lines = named.map((c) => `- **${c.name}**`).join("\n");
  return {
    reaction: "📋",
    message: `📋 Salons de l'espace géré (${named.length}) :\n${lines}`,
  };
}

function helpMessage(): RoomCmdResult {
  return {
    reaction: "📖",
    message: `# \`/salon\` — gestion des salons de l'espace

| Sous-commande | Effet |
|---|---|
| \`/salon list\` | Liste les salons de l'espace géré |
| \`/salon create <nom>\` | Crée un salon (chiffré), t'y invite, et le rattache à l'espace |
| \`/salon delete <nom>\` | Ferme le salon : détache de l'espace + expulse les membres + le bot quitte |

Le \`<nom>\` peut contenir des espaces (les guillemets sont optionnels).`,
  };
}

// `text` is the full slash command, e.g. `/salon create ma-team`.
export async function handleRoomsCommand(
  client: MatrixClient,
  spaceId: string | undefined,
  botUserId: string,
  senderUserId: string,
  requesterIsAdmin: boolean,
  text: string,
): Promise<RoomCmdResult> {
  if (!spaceId) {
    return {
      reaction: "⛔",
      message:
        "⛔ Gestion des salons désactivée : `MATRIX_MANAGED_SPACE` n'est pas configuré.",
    };
  }

  const m = text.trim().match(/^\/salon\s+(\S+)\s*([\s\S]*)$/i);
  const sub = (m?.[1] ?? "help").toLowerCase();
  const arg = (m?.[2] ?? "").trim().replace(/^["']|["']$/g, "").trim();

  try {
    switch (sub) {
      case "list":
        return await listRooms(client, spaceId);
      case "create":
      case "new":
        if (!arg)
          return {
            reaction: "❌",
            message: "❌ Usage : `/salon create <nom>`",
          };
        return await createRoom(client, spaceId, arg, senderUserId, botUserId);
      case "delete":
      case "close":
      case "supprimer":
        if (!arg)
          return {
            reaction: "❌",
            message: "❌ Usage : `/salon delete <nom>`",
          };
        return await closeRoom(client, spaceId, arg, botUserId, senderUserId);
      case "role":
      case "droit":
      case "droits":
      case "power": {
        const toks = arg.split(/\s+/).filter(Boolean);
        if (toks.length < 3)
          return {
            reaction: "❌",
            message:
              "❌ Usage : `/salon role <salon> <@user:serveur> <niveau>` (niveau = membre/moderateur/admin ou 0–100)",
          };
        const levelStr = toks.pop()!;
        const targetUser = toks.pop()!;
        const roomName = toks.join(" ").replace(/^["']|["']$/g, "").trim();
        return await setRole(
          client,
          spaceId,
          roomName,
          targetUser,
          levelStr,
          requesterIsAdmin,
        );
      }
      case "help":
      case "aide":
        return helpMessage();
      default:
        return {
          reaction: "❌",
          message: `❌ Sous-commande inconnue : \`${sub}\`. Tape \`/salon help\`.`,
        };
    }
  } catch (err) {
    return {
      reaction: "❌",
      message: `❌ Erreur : ${String(err instanceof Error ? err.message : err).slice(0, 300)}`,
    };
  }
}
