import { test } from "node:test";
import assert from "node:assert/strict";
import type { MatrixClient } from "matrix-bot-sdk";
import { handleSpacesCommand } from "../src/commands/rooms.js";

const BOT = "@bot:srv";
const AMEL = "@amel:srv";
const GERE = "!gere:srv";

// An empty managed space: just enough for `/espace create` to run end to end.
function fake() {
  const created: Array<Record<string, unknown>> = [];
  const client = {
    async getRoomState() {
      return [];
    },
    async createRoom(props: Record<string, unknown>) {
      created.push(props);
      return "!nouveau:srv";
    },
    async getRoomStateEvent() {
      return { users: { [BOT]: 100 } };
    },
    async sendStateEvent() {
      return "$ev";
    },
  } as unknown as MatrixClient;
  return { client, created };
}

function historyVisibility(room: Record<string, unknown>): unknown {
  const state = room["initial_state"] as Array<{ type: string; content: unknown }>;
  return state.find((e) => e.type === "m.room.history_visibility")?.content;
}

test("/espace create: a private space people can preview before joining", async () => {
  const f = fake();
  const res = await handleSpacesCommand(f.client, GERE, BOT, AMEL, "/espace create Pole");
  assert.equal(res.reaction, "✅");
  const space = f.created[0]!;
  assert.equal(space["preset"], "private_chat");
  assert.deepEqual(historyVisibility(space), { history_visibility: "world_readable" });
  assert.match(res.message, /aperçu/);
});

test("/espace create --clair: a public space keeps the preview too", async () => {
  const f = fake();
  await handleSpacesCommand(f.client, GERE, BOT, AMEL, "/espace create Pole --clair");
  const space = f.created[0]!;
  assert.equal(space["preset"], "public_chat");
  assert.deepEqual(historyVisibility(space), { history_visibility: "world_readable" });
});
