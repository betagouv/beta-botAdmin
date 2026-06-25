import type { MatrixClient } from "matrix-bot-sdk";
import { config } from "../config.js";
import { addCreatedRoom, removeCreatedRoom } from "./created-rooms.js";

// Manage rooms inside a single configured Space (MATRIX_MANAGED_SPACE):
// create a room attached to the space, or "close" one (detach + kick + leave).
// Restricted to admins in command rooms by the caller (see matrix.ts).

// A requester must have at least this power level in a room to close it.
const MODERATOR_POWER_LEVEL = 50;

export interface RoomCmdResult {
  reaction: string;
  message: string;
}

interface SpaceChild {
  roomId: string;
  name: string;
  isSpace: boolean;
}

// Room type from m.room.create (`m.space` for spaces, undefined for normal rooms).
async function roomType(
  client: MatrixClient,
  roomId: string,
): Promise<string | null> {
  try {
    const c = (await client.getRoomStateEvent(roomId, "m.room.create", "")) as {
      type?: string;
    };
    return c?.type ?? null;
  } catch {
    return null;
  }
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
    const isSpace = (await roomType(client, roomId)) === "m.space";
    result.push({ roomId, name, isSpace });
  }
  return result;
}

// Whether a user is a joined member of a room/space.
async function isRoomMember(
  client: MatrixClient,
  roomId: string,
  userId: string,
): Promise<boolean> {
  try {
    const members = await client.getJoinedRoomMembers(roomId);
    return members.includes(userId);
  } catch {
    return false;
  }
}

// Find a sub-space of the managed space by its room ID (`!id:server`) or by its
// name (case-insensitive). The ID form lets callers target a space whose name is
// ambiguous or contains spaces.
async function resolveSubSpace(
  client: MatrixClient,
  managedSpaceId: string,
  idOrName: string,
): Promise<SpaceChild | null> {
  const children = await listChildren(client, managedSpaceId);
  const needle = idOrName.toLowerCase();
  // A room ID always starts with `!`; match by ID in that case, otherwise by name.
  const byId = idOrName.startsWith("!");
  return (
    children.find(
      (c) =>
        c.isSpace &&
        (byId
          ? c.roomId.toLowerCase() === needle
          : c.name.toLowerCase() === needle),
    ) ?? null
  );
}

// Parse a `<nom> [espace]` argument into a room name and an optional target
// espace. A **quoted** trailing segment is always the espace, so names that
// contain spaces work (e.g. `Mon Salon "Pole Tech"`). A single quoted value
// with nothing before it is the room name (`"mon salon"`). Otherwise the last
// bare word is a candidate espace, kept for backward compatibility — the caller
// only uses it when it actually resolves to an existing sub-space.
// `explicit` = the espace came from quotes, so the caller must error (not fall
// back to a room name) when it doesn't resolve.
export function parseRoomAndSpace(cleaned: string): {
  roomName: string;
  spaceCandidate: string | null;
  explicit: boolean;
} {
  const trailing = cleaned.match(/^(.*\S)\s+["']([^"']+)["']$/);
  if (trailing) {
    return {
      roomName: trailing[1]!.trim(),
      spaceCandidate: trailing[2]!.trim(),
      explicit: true,
    };
  }
  const whole = cleaned.match(/^["']([^"']+)["']$/);
  if (whole) {
    return { roomName: whole[1]!.trim(), spaceCandidate: null, explicit: false };
  }
  const tokens = cleaned.split(/\s+/);
  if (tokens.length >= 2) {
    return {
      roomName: cleaned,
      spaceCandidate: tokens[tokens.length - 1]!,
      explicit: false,
    };
  }
  return { roomName: cleaned, spaceCandidate: null, explicit: false };
}

async function createRoom(
  client: MatrixClient,
  spaceId: string,
  name: string,
  inviteUserId: string,
  botUserId: string,
  spaceLabel?: string | null,
  encrypted = true,
): Promise<RoomCmdResult> {
  const where = spaceLabel ? `l'espace **${spaceLabel}**` : "l'espace géré";
  const existing = await listChildren(client, spaceId);
  if (
    existing.some(
      (c) => !c.isSpace && c.name.toLowerCase() === name.toLowerCase(),
    )
  ) {
    return {
      reaction: "⚠️",
      message: `⚠️ Un salon nommé **${name}** existe déjà dans ${where}.`,
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
  // Synapse force le chiffrement sur les salons privés (config serveur
  // `encryption_enabled_by_default_for_room_type`). Un salon `--clair` doit
  // donc être créé en public pour rester réellement non chiffré ; sinon le
  // serveur ré-active le chiffrement malgré l'absence de m.room.encryption.
  const roomId = await client.createRoom({
    name,
    preset: encrypted ? "private_chat" : "public_chat",
    visibility: encrypted ? "private" : "public",
    invite: invitees,
    power_level_content_override: { users },
    initial_state: [
      {
        type: "m.space.parent",
        state_key: spaceId,
        content: { via: [spaceVia], canonical: true },
      },
      // Encryption is enabled by default. Skipped when `--clair` is passed so
      // the room stays unencrypted (cleartext). Encryption can't be undone once
      // turned on, so it's opt-out at creation rather than toggled later.
      ...(encrypted
        ? [
            {
              type: "m.room.encryption",
              state_key: "",
              content: { algorithm: "m.megolm.v1.aes-sha2" },
            },
          ]
        : []),
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
    message: `🏠 Salon **${name}** créé (${encrypted ? "privé, chiffré" : "public, non chiffré"}) et rattaché à ${where}.\nID : \`${roomId}\``,
  };
}

// Create a Space (a room with type m.space) and attach it under the managed
// space, so `/salon create <nom> <cet-espace>` can target it.
async function createSpace(
  client: MatrixClient,
  parentSpaceId: string,
  name: string,
  inviteUserId: string,
  botUserId: string,
): Promise<RoomCmdResult> {
  const existing = await listChildren(client, parentSpaceId);
  if (
    existing.some(
      (c) => c.isSpace && c.name.toLowerCase() === name.toLowerCase(),
    )
  ) {
    return {
      reaction: "⚠️",
      message: `⚠️ Un espace nommé **${name}** existe déjà.`,
    };
  }

  const invitees = (
    inviteUserId && inviteUserId !== botUserId
      ? [inviteUserId]
      : config.matrix.defaultInvites
  ).filter((u) => u !== botUserId);

  // Bot stays admin (100), invitees become moderators (50).
  const users: Record<string, number> = { [botUserId]: 100 };
  for (const u of invitees) users[u] = MODERATOR_POWER_LEVEL;

  const parentVia = serverName(parentSpaceId);
  const spaceId = await client.createRoom({
    name,
    preset: "private_chat",
    visibility: "private",
    invite: invitees,
    creation_content: { type: "m.space" },
    power_level_content_override: { users },
    initial_state: [
      {
        type: "m.space.parent",
        state_key: parentSpaceId,
        content: { via: [parentVia], canonical: true },
      },
    ],
  });

  // Attach the new space as a child of the managed space.
  await client.sendStateEvent(parentSpaceId, "m.space.child", spaceId, {
    via: [serverName(spaceId)],
  });

  return {
    reaction: "✅",
    message: `🌌 Espace **${name}** créé et rattaché à l'espace géré.\nTu peux y créer des salons : \`/salon create <nom> ${name}\`\nID : \`${spaceId}\``,
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
  spaceLabel?: string | null,
): Promise<RoomCmdResult> {
  const where = spaceLabel ? `l'espace **${spaceLabel}**` : "l'espace géré";
  const children = await listChildren(client, spaceId);
  const matches = children.filter(
    (c) => !c.isSpace && c.name.toLowerCase() === name.toLowerCase(),
  );
  if (matches.length === 0) {
    return {
      reaction: "❌",
      message: `❌ Aucun salon nommé **${name}** dans ${where}. Tape \`/salon list\` pour voir les salons.`,
    };
  }
  if (matches.length > 1) {
    return {
      reaction: "⚠️",
      message: `⚠️ Plusieurs salons s'appellent **${name}** dans ${where}. Renomme l'un d'eux pour lever l'ambiguïté avant de supprimer.`,
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
    message: `🗑 Salon **${name}** fermé : détaché de ${where}, ${kicked} membre(s) expulsé(s), le bot a quitté.`,
  };
}

// Resolve a unique child room by name, or return an error result.
async function listRooms(
  client: MatrixClient,
  spaceId: string,
): Promise<RoomCmdResult> {
  // Rooms live either directly under the managed space or inside a sub-space.
  // List them grouped by espace; skip unnamed / unreadable entries.
  const children = await listChildren(client, spaceId);
  const rootRooms = children.filter((c) => !c.isSpace && c.name.trim());
  const subSpaces = children.filter((c) => c.isSpace && c.name.trim());

  const sections: string[] = [];
  if (rootRooms.length) {
    sections.push(
      `**Espace géré** :\n${rootRooms.map((r) => `- ${r.name}`).join("\n")}`,
    );
  }
  for (const sp of subSpaces) {
    const kids = (await listChildren(client, sp.roomId)).filter(
      (c) => !c.isSpace && c.name.trim(),
    );
    sections.push(
      `**${sp.name}** (espace) :\n${
        kids.length ? kids.map((r) => `- ${r.name}`).join("\n") : "- _(vide)_"
      }`,
    );
  }

  if (!sections.length) {
    return { reaction: "📭", message: "📭 Aucun salon dans l'espace géré." };
  }
  return {
    reaction: "📋",
    message: `📋 Salons :\n\n${sections.join("\n\n")}`,
  };
}

// List the sub-spaces of the managed space.
async function listSpaces(
  client: MatrixClient,
  spaceId: string,
): Promise<RoomCmdResult> {
  const spaces = (await listChildren(client, spaceId)).filter(
    (c) => c.isSpace && c.name.trim(),
  );
  if (!spaces.length) {
    return { reaction: "📭", message: "📭 Aucun espace dans l'espace géré." };
  }
  const lines = spaces.map((s) => `- **${s.name}**`).join("\n");
  return {
    reaction: "📋",
    message: `🌌 Espaces (${spaces.length}) :\n${lines}`,
  };
}

function helpMessage(): RoomCmdResult {
  return {
    reaction: "📖",
    message: `# \`/salon\` — gestion des salons de l'espace

| Sous-commande | Effet |
|---|---|
| \`/salon list\` | Liste les salons, groupés par espace |
| \`/salon create <nom>\` | Crée un salon (chiffré), t'y invite, et le rattache à l'espace géré |
| \`/salon create <nom> --clair\` | Idem mais salon **non chiffré** (le chiffrement ne peut pas être retiré ensuite) |
| \`/salon create <nom> <espace>\` | Idem, mais rattache le salon au sous-espace **<espace>** (nom ou ID). Si le nom de l'espace contient des espaces, mets-le entre guillemets : \`/salon create <nom> "Pole Tech"\` |
| \`/salon delete <nom>\` | Ferme le salon de l'espace géré : détache + expulse les membres + le bot quitte |
| \`/salon delete <nom> <espace>\` | Idem, mais cible le salon situé dans le sous-espace **<espace>** (pour lever l'ambiguïté si le même nom existe ailleurs). Espace avec des espaces : entre guillemets |

Le \`<nom>\` peut contenir des espaces. Pour cibler un **<espace>** dont le nom contient des espaces, mets-le entre guillemets en dernier (\`"Pole Tech"\`) ; sinon le dernier mot est traité comme **<espace>** seulement s'il correspond au **nom ou à l'ID** d'un sous-espace existant (voir \`/espace list\`).`,
  };
}

function spacesHelpMessage(): RoomCmdResult {
  return {
    reaction: "📖",
    message: `# \`/espace\` — gestion des sous-espaces

| Sous-commande | Effet |
|---|---|
| \`/espace list\` | Liste les sous-espaces de l'espace géré |
| \`/espace create <nom>\` | Crée un sous-espace et le rattache à l'espace géré |

Ensuite, range un salon dedans : \`/salon create <nom-salon> <nom-espace>\`.`,
  };
}

// `text` is the full slash command, e.g. `/espace create Pole Tech`.
export async function handleSpacesCommand(
  client: MatrixClient,
  managedSpaceId: string | undefined,
  botUserId: string,
  senderUserId: string,
  text: string,
): Promise<RoomCmdResult> {
  if (!managedSpaceId) {
    return {
      reaction: "⛔",
      message:
        "⛔ Gestion des espaces désactivée : `MATRIX_MANAGED_SPACE` n'est pas configuré.",
    };
  }

  const m = text.trim().match(/^\/espace\s+(\S+)\s*([\s\S]*)$/i);
  const sub = (m?.[1] ?? "help").toLowerCase();
  const arg = (m?.[2] ?? "").trim().replace(/^["']|["']$/g, "").trim();

  try {
    switch (sub) {
      case "list":
        return await listSpaces(client, managedSpaceId);
      case "create":
      case "new":
        if (!arg)
          return {
            reaction: "❌",
            message: "❌ Usage : `/espace create <nom>`",
          };
        return await createSpace(
          client,
          managedSpaceId,
          arg,
          senderUserId,
          botUserId,
        );
      case "help":
      case "aide":
        return spacesHelpMessage();
      default:
        return {
          reaction: "❌",
          message: `❌ Sous-commande inconnue : \`${sub}\`. Tape \`/espace help\`.`,
        };
    }
  } catch (err) {
    return {
      reaction: "❌",
      message: `❌ Erreur : ${String(err instanceof Error ? err.message : err).slice(0, 300)}`,
    };
  }
}

// `text` is the full slash command, e.g. `/salon create ma-team`.
export async function handleRoomsCommand(
  client: MatrixClient,
  spaceId: string | undefined,
  botUserId: string,
  senderUserId: string,
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
  // Raw argument, NOT wrapping-quote-stripped: create/delete parse trailing
  // quotes themselves (a quoted espace can contain spaces), so stripping the
  // outer quote here would corrupt `<nom> "<espace>"`.
  const rawArg = (m?.[2] ?? "").trim();

  try {
    switch (sub) {
      case "list":
        return await listRooms(client, spaceId);
      case "create":
      case "new": {
        if (!rawArg)
          return {
            reaction: "❌",
            message: "❌ Usage : `/salon create <nom> [\"espace\"] [--clair]`",
          };
        // `--clair` (anywhere in the args) creates an unencrypted room. Strip
        // the flag out before parsing name/espace so it never lands in either.
        const tokensRaw = rawArg.split(/\s+/);
        const encrypted = !tokensRaw.some(
          (t) => t.toLowerCase() === "--clair",
        );
        const cleaned = tokensRaw
          .filter((t) => t.toLowerCase() !== "--clair")
          .join(" ");
        if (!cleaned)
          return {
            reaction: "❌",
            message: "❌ Usage : `/salon create <nom> [\"espace\"] [--clair]`",
          };
        const { roomName: parsedName, spaceCandidate, explicit } =
          parseRoomAndSpace(cleaned);
        let targetSpaceId = spaceId;
        let targetSpaceName: string | null = null;
        let roomName = parsedName;
        if (spaceCandidate) {
          const sub2 = await resolveSubSpace(client, spaceId, spaceCandidate);
          if (sub2) {
            // Only members of the target espace may create rooms inside it.
            // The bot itself (self command) is exempt.
            if (
              senderUserId !== botUserId &&
              !(await isRoomMember(client, sub2.roomId, senderUserId))
            ) {
              return {
                reaction: "⛔",
                message: `⛔ Tu n'es pas membre de l'espace **${sub2.name}**, tu ne peux pas y créer de salon.`,
              };
            }
            targetSpaceId = sub2.roomId;
            targetSpaceName = sub2.name;
            // Bare last-word match: drop that word from the room name. (Quoted
            // espace already gave us the prefix as `parsedName`.)
            if (!explicit)
              roomName = cleaned.split(/\s+/).slice(0, -1).join(" ");
          } else if (explicit) {
            // Quoted espace that doesn't exist: don't silently turn it into a
            // room name — the intent was explicit.
            return {
              reaction: "❌",
              message: `❌ Espace introuvable : **${spaceCandidate}**. Tape \`/espace list\` pour voir les sous-espaces.`,
            };
          }
        }
        if (!roomName)
          return {
            reaction: "❌",
            message: "❌ Usage : `/salon create <nom> [\"espace\"] [--clair]`",
          };
        return await createRoom(
          client,
          targetSpaceId,
          roomName,
          senderUserId,
          botUserId,
          targetSpaceName,
          encrypted,
        );
      }
      case "delete":
      case "close":
      case "supprimer": {
        if (!rawArg)
          return {
            reaction: "❌",
            message: "❌ Usage : `/salon delete <nom> [\"espace\"]`",
          };
        // Same scoping as create: a quoted trailing segment (or a bare last word
        // that names an existing sub-space) selects the espace to look in.
        // Disambiguates a room name that exists in several espaces.
        const { roomName: parsedName, spaceCandidate, explicit } =
          parseRoomAndSpace(rawArg);
        let targetSpaceId = spaceId;
        let targetSpaceName: string | null = null;
        let roomName = parsedName;
        if (spaceCandidate) {
          const subD = await resolveSubSpace(client, spaceId, spaceCandidate);
          if (subD) {
            targetSpaceId = subD.roomId;
            targetSpaceName = subD.name;
            if (!explicit)
              roomName = rawArg.split(/\s+/).slice(0, -1).join(" ");
          } else if (explicit) {
            return {
              reaction: "❌",
              message: `❌ Espace introuvable : **${spaceCandidate}**. Tape \`/espace list\` pour voir les sous-espaces.`,
            };
          }
        }
        return await closeRoom(
          client,
          targetSpaceId,
          roomName,
          botUserId,
          senderUserId,
          targetSpaceName,
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
