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
  // Set by `/salon create … --liste <liste>`: the connector then triggers the
  // n8n invite flow for that list into the freshly-created room.
  createdRoomId?: string;
  inviteListe?: string;
  targetLabel?: string;
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

// Find a sub-space anywhere under the managed space by its room ID (`!id:server`)
// or name (case-insensitive). The ID form lets callers target a space whose name
// is ambiguous or contains spaces. The search is a breadth-first walk of the
// whole space tree, so a nested espace (child of a child) resolves too — e.g.
// `/espace create X test` where `test` sits under another sub-espace. On a name
// clash the shallowest match wins (BFS). A `visited` set makes it cycle-safe
// (the Matrix space graph may contain loops).
async function resolveSubSpace(
  client: MatrixClient,
  managedSpaceId: string,
  idOrName: string,
): Promise<SpaceChild | null> {
  const needle = idOrName.toLowerCase();
  // A room ID always starts with `!`; match by ID in that case, otherwise by name.
  const byId = idOrName.startsWith("!");
  const visited = new Set<string>([managedSpaceId]);
  let frontier = await listChildren(client, managedSpaceId);
  while (frontier.length) {
    const next: SpaceChild[] = [];
    for (const c of frontier) {
      if (visited.has(c.roomId)) continue;
      visited.add(c.roomId);
      if (!c.isSpace) continue;
      if (byId ? c.roomId.toLowerCase() === needle : c.name.toLowerCase() === needle) {
        return c;
      }
      next.push(...(await listChildren(client, c.roomId)));
    }
    frontier = next;
  }
  return null;
}

// Find a room (non-space child) anywhere under the managed space by ID or name.
// BFS the whole tree so a room nested in a sub-espace resolves too. Returns
// { room, ambiguous }: ambiguous when several rooms share the name.
async function resolveRoom(
  client: MatrixClient,
  managedSpaceId: string,
  idOrName: string,
): Promise<{ room: SpaceChild | null; ambiguous: boolean }> {
  const needle = idOrName.toLowerCase();
  const byId = idOrName.startsWith("!");
  const matches: SpaceChild[] = [];
  const visited = new Set<string>([managedSpaceId]);
  let frontier = await listChildren(client, managedSpaceId);
  while (frontier.length) {
    const next: SpaceChild[] = [];
    for (const c of frontier) {
      if (visited.has(c.roomId)) continue;
      visited.add(c.roomId);
      if (c.isSpace) {
        next.push(...(await listChildren(client, c.roomId)));
        continue;
      }
      if (byId ? c.roomId.toLowerCase() === needle : c.name.toLowerCase() === needle) {
        matches.push(c);
      }
    }
    frontier = next;
  }
  if (matches.length === 0) return { room: null, ambiguous: false };
  if (matches.length > 1) return { room: null, ambiguous: true };
  return { room: matches[0]!, ambiguous: false };
}

// Whether a user is a joined member of a room/space (exported for /invite).
export async function isMemberOf(
  client: MatrixClient,
  roomId: string,
  userId: string,
): Promise<boolean> {
  return isRoomMember(client, roomId, userId);
}

// Resolve the target of `/invite … --salon|--espace <name>` to a room ID under
// the managed space. Returns { roomId, label } or { error } (a ready-to-send
// message). The bot resolves the target so n8n only has to invite into an id.
export async function resolveInviteTarget(
  client: MatrixClient,
  managedSpaceId: string | undefined,
  kind: "salon" | "espace",
  name: string,
): Promise<{ roomId: string; label: string } | { error: string }> {
  if (!managedSpaceId) {
    return { error: "⛔ `MATRIX_MANAGED_SPACE` n'est pas configuré." };
  }
  if (kind === "espace") {
    const sp = await resolveSubSpace(client, managedSpaceId, name);
    if (!sp) return { error: `❌ Aucun espace **${name}**. Tape \`/espace list\`.` };
    return { roomId: sp.roomId, label: `l'espace **${sp.name}**` };
  }
  const { room, ambiguous } = await resolveRoom(client, managedSpaceId, name);
  if (ambiguous)
    return {
      error: `⚠️ Plusieurs salons s'appellent **${name}**. Précise l'ID : \`--salon !id:serveur\`.`,
    };
  if (!room) return { error: `❌ Aucun salon **${name}**. Tape \`/salon list\`.` };
  return { roomId: room.roomId, label: `le salon **${room.name}**` };
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
  // Opening and closing quote must be the SAME type (backref `\2`) so the
  // content can itself contain the other quote — notably an apostrophe inside a
  // double-quoted espace, e.g. `"Fabrique numérique de l'écologie"`.
  const trailing = cleaned.match(/^(.*\S)\s+(["'])(.+)\2$/);
  if (trailing) {
    return {
      roomName: trailing[1]!.trim(),
      spaceCandidate: trailing[3]!.trim(),
      explicit: true,
    };
  }
  const whole = cleaned.match(/^(["'])(.+)\1$/);
  if (whole) {
    return { roomName: whole[2]!.trim(), spaceCandidate: null, explicit: false };
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
    createdRoomId: roomId,
    targetLabel: `le salon **${name}**`,
  };
}

// Create a Space (a room with type m.space) and attach it under a parent space
// (the managed space, or a sub-espace for nesting), so `/salon create <nom>
// <cet-espace>` can target it. `parentLabel` names the parent for the reply.
async function createSpace(
  client: MatrixClient,
  parentSpaceId: string,
  name: string,
  inviteUserId: string,
  botUserId: string,
  parentLabel?: string | null,
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

  const where = parentLabel
    ? `l'espace **${parentLabel}**`
    : "l'espace géré";
  return {
    reaction: "✅",
    message: `🌌 Espace **${name}** créé et rattaché à ${where}.\nTu peux y créer des salons : \`/salon create <nom> ${name}\`\nID : \`${spaceId}\``,
  };
}

// The parent spaces a space is attached to (m.space.parent state, non-empty
// content). Used to detach a space from every parent before deleting it.
async function spaceParents(
  client: MatrixClient,
  spaceId: string,
): Promise<string[]> {
  const state = (await client.getRoomState(spaceId)) as StateEvent[];
  const parents: string[] = [];
  for (const e of state) {
    if (
      e.type === "m.space.parent" &&
      typeof e.state_key === "string" &&
      e.content &&
      Object.keys(e.content).length > 0
    ) {
      parents.push(e.state_key);
    }
  }
  return parents;
}

// Delete a sub-space: resolve it anywhere under the managed space, refuse if it
// still holds rooms or sub-espaces (no cascade — the caller must empty it first),
// then detach it from every parent and the bot leaves. Gated to DM by the caller.
async function closeSpace(
  client: MatrixClient,
  managedSpaceId: string,
  nameOrId: string,
  botUserId: string,
): Promise<RoomCmdResult> {
  const target = await resolveSubSpace(client, managedSpaceId, nameOrId);
  if (!target) {
    return {
      reaction: "❌",
      message: `❌ Aucun espace nommé **${nameOrId}** sous l'espace géré. Tape \`/espace list\`.`,
    };
  }
  const kids = (await listChildren(client, target.roomId)).filter((c) =>
    c.name.trim(),
  );
  if (kids.length) {
    return {
      reaction: "⚠️",
      message: `⚠️ L'espace **${target.name}** n'est pas vide (${kids.length} élément(s)). Supprime ou déplace d'abord son contenu.`,
    };
  }
  const parents = await spaceParents(client, target.roomId);
  // Remove the child link on every parent that references the space, then
  // detachAndClose (via the primary parent) kicks members and the bot leaves.
  for (const p of parents) {
    try {
      await client.sendStateEvent(p, "m.space.child", target.roomId, {});
    } catch {
      // not attached / no power — proceed
    }
  }
  const kicked = await detachAndClose(
    client,
    parents[0] ?? managedSpaceId,
    target.roomId,
    botUserId,
  );
  return {
    reaction: "✅",
    message: `🗑 Espace **${target.name}** supprimé : détaché, ${kicked} membre(s) expulsé(s), le bot a quitté.`,
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

// List the sub-spaces directly under `spaceId`. `label` names it in the reply
// (the managed space by default, or a sub-espace when `/espace list <espace>`).
async function listSpaces(
  client: MatrixClient,
  spaceId: string,
  label?: string | null,
): Promise<RoomCmdResult> {
  const where = label ? `l'espace **${label}**` : "l'espace géré";
  const spaces = (await listChildren(client, spaceId)).filter(
    (c) => c.isSpace && c.name.trim(),
  );
  if (!spaces.length) {
    return { reaction: "📭", message: `📭 Aucun sous-espace dans ${where}.` };
  }
  const lines = spaces.map((s) => `- **${s.name}**`).join("\n");
  return {
    reaction: "📋",
    message: `🌌 Sous-espaces de ${where} (${spaces.length}) :\n${lines}`,
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
| \`/salon create <nom> --liste <liste>\` | Idem, et **invite** tous les membres de la liste **<liste>** (voir \`/liste-membre\`) dans le salon créé |
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
| \`/espace list <espace>\` | Liste les sous-espaces d'un sous-espace (nom ou ID, à n'importe quelle profondeur) |
| \`/espace create <nom>\` | Crée un sous-espace et le rattache à l'espace géré |
| \`/espace create <nom> <espace-parent>\` | Crée un sous-espace **imbriqué** dans **<espace-parent>** (nom ou ID). Nom avec des espaces : entre guillemets — \`/espace create <nom> "Pole Tech"\` |
| \`/espace delete <nom>\` | Supprime un sous-espace **vide** (réservé à un utilisateur autorisé, en MP) |

Le \`<nom>\` peut contenir des espaces. Pour cibler un **<espace-parent>** dont le nom contient des espaces, mets-le entre guillemets en dernier ; sinon le dernier mot est traité comme parent seulement s'il correspond au nom ou à l'ID d'un sous-espace existant.

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
  // `/espace delete` is gated: the connector only sets this true for an
  // allow-listed user in a DM (MATRIX_DM_TEST_USERS). Everywhere else it stays
  // false and delete is refused.
  allowDelete = false,
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
  // Raw argument, NOT wrapping-quote-stripped: create parses the trailing espace
  // itself (a quoted parent espace can contain spaces), so stripping the outer
  // quote here would corrupt `<nom> "<espace-parent>"`.
  const rawArg = (m?.[2] ?? "").trim();

  try {
    switch (sub) {
      case "list": {
        // No arg → sub-espaces of the managed space. `/espace list <espace>` →
        // sub-espaces of that (nested) espace, resolved anywhere in the tree.
        const target = rawArg.replace(/^["']|["']$/g, "").trim();
        if (!target) return await listSpaces(client, managedSpaceId);
        const sub = await resolveSubSpace(client, managedSpaceId, target);
        if (!sub) {
          return {
            reaction: "❌",
            message: `❌ Aucun espace nommé **${target}** sous l'espace géré. Tape \`/espace list\`.`,
          };
        }
        return await listSpaces(client, sub.roomId, sub.name);
      }
      case "create":
      case "new": {
        if (!rawArg)
          return {
            reaction: "❌",
            message: '❌ Usage : `/espace create <nom> ["espace-parent"]`',
          };
        // `<nom> [espace-parent]`: same grammar as `/salon create`. A trailing
        // quoted segment (or a bare last word that names an existing sub-espace)
        // nests the new espace inside that parent instead of the managed space.
        const { roomName: parsedName, spaceCandidate, explicit } =
          parseRoomAndSpace(rawArg);
        let parentSpaceId = managedSpaceId;
        let parentLabel: string | null = null;
        let spaceName = parsedName;
        if (spaceCandidate) {
          const parent = await resolveSubSpace(
            client,
            managedSpaceId,
            spaceCandidate,
          );
          if (parent) {
            // Only members of the parent espace may nest a sub-espace inside it.
            // The bot itself (self command) is exempt.
            if (
              senderUserId !== botUserId &&
              !(await isRoomMember(client, parent.roomId, senderUserId))
            ) {
              return {
                reaction: "⛔",
                message: `⛔ Tu n'es pas membre de l'espace **${parent.name}**, tu ne peux pas y créer de sous-espace.`,
              };
            }
            parentSpaceId = parent.roomId;
            parentLabel = parent.name;
            // Bare last-word match: drop that word from the espace name. (Quoted
            // parent already gave us the prefix as `parsedName`.)
            if (!explicit)
              spaceName = rawArg.split(/\s+/).slice(0, -1).join(" ");
          } else if (explicit) {
            // Quoted parent that doesn't exist: don't silently turn it into the
            // espace name — the intent was explicit.
            return {
              reaction: "❌",
              message: `❌ Espace parent introuvable : **${spaceCandidate}**. Tape \`/espace list\` pour voir les sous-espaces.`,
            };
          }
        }
        if (!spaceName)
          return {
            reaction: "❌",
            message: '❌ Usage : `/espace create <nom> ["espace-parent"]`',
          };
        return await createSpace(
          client,
          parentSpaceId,
          spaceName,
          senderUserId,
          botUserId,
          parentLabel,
        );
      }
      case "delete":
      case "close":
      case "supprimer": {
        if (!allowDelete) {
          return {
            reaction: "⛔",
            message:
              "⛔ `/espace delete` est réservé à un utilisateur autorisé, en message privé (MP) avec le bot.",
          };
        }
        // The whole argument is the espace name; strip one layer of wrapping
        // quotes so a name with spaces works (`"Pole Tech"`).
        const name = rawArg.replace(/^["']|["']$/g, "").trim();
        if (!name)
          return {
            reaction: "❌",
            message: '❌ Usage : `/espace delete <nom>`',
          };
        return await closeSpace(client, managedSpaceId, name, botUserId);
      }
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
            message:
              "❌ Usage : `/salon create <nom> [\"espace\"] [--clair] [--liste <liste>]`",
          };
        // Extract `--liste <nom>` (optional): after creation, the connector
        // invites that member list via n8n. Pulled out first so its value never
        // lands in the room/espace name.
        let inviteListe: string | null = null;
        let argAfterListe = rawArg;
        const listeMatch = rawArg.match(
          /(?:^|\s)--liste\s+("[^"]+"|'[^']+'|\S+)/i,
        );
        if (listeMatch) {
          inviteListe = listeMatch[1]!.replace(/^["']|["']$/g, "");
          argAfterListe = (
            rawArg.slice(0, listeMatch.index) +
            " " +
            rawArg.slice(listeMatch.index! + listeMatch[0].length)
          ).trim();
        }
        // `--clair` (anywhere in the args) creates an unencrypted room. Strip
        // the flag out before parsing name/espace so it never lands in either.
        const tokensRaw = argAfterListe.split(/\s+/).filter(Boolean);
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
            message:
              "❌ Usage : `/salon create <nom> [\"espace\"] [--clair] [--liste <liste>]`",
          };
        const created = await createRoom(
          client,
          targetSpaceId,
          roomName,
          senderUserId,
          botUserId,
          targetSpaceName,
          encrypted,
        );
        // If a list was requested and the room was created, tag the result so
        // the connector triggers the n8n invite flow into the new room.
        if (inviteListe && created.createdRoomId) {
          created.inviteListe = inviteListe;
        }
        return created;
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
