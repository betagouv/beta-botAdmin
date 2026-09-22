import { test } from "node:test";
import assert from "node:assert/strict";
import { moderatorPowerLevels } from "../src/commands/rooms.js";

// What the Tchap homeserver hands back for a space created through the API:
// every state event locked at 100, so a moderator can do nothing.
const ESPACE_TCHAP = {
  users: { "@bot:srv": 100, "@amel:srv": 50 },
  users_default: 0,
  events_default: 0,
  state_default: 100,
  invite: 50,
  kick: 50,
  ban: 50,
  redact: 50,
  events: { "m.room.name": 50, "m.room.power_levels": 100 },
};

test("moderatorPowerLevels: a moderator can add rooms to the espace they created", () => {
  const pl = moderatorPowerLevels(ESPACE_TCHAP) as {
    events: Record<string, number>;
  };
  assert.equal(pl.events["m.space.child"], 50);
  assert.equal(pl.events["m.space.parent"], 50);
});

test("moderatorPowerLevels: every locked state event comes down to 50", () => {
  const pl = moderatorPowerLevels(ESPACE_TCHAP) as Record<string, unknown> & {
    events: Record<string, number>;
  };
  assert.equal(pl["state_default"], 50);
  for (const e of [
    "m.room.name",
    "m.room.topic",
    "m.room.avatar",
    "m.room.canonical_alias",
    "m.room.history_visibility",
    "m.room.encryption",
    "m.room.join_rules",
    "m.room.power_levels",
    "m.room.server_acl",
    "m.room.tombstone",
  ]) {
    assert.equal(pl.events[e], 50, `${e} should be 50`);
  }
});

test("moderatorPowerLevels: the moderation thresholds come down to 50", () => {
  const pl = moderatorPowerLevels({
    ...ESPACE_TCHAP,
    invite: 100,
    kick: 100,
    ban: 100,
    redact: 100,
  }) as Record<string, number>;
  assert.equal(pl["invite"], 50);
  assert.equal(pl["kick"], 50);
  assert.equal(pl["ban"], 50);
  assert.equal(pl["redact"], 50);
});

test("moderatorPowerLevels: the bot keeps 100 and the creator keeps 50", () => {
  const pl = moderatorPowerLevels(ESPACE_TCHAP) as {
    users: Record<string, number>;
  };
  assert.deepEqual(pl.users, { "@bot:srv": 100, "@amel:srv": 50 });
});

test("moderatorPowerLevels: members keep talking — the defaults are untouched", () => {
  const pl = moderatorPowerLevels(ESPACE_TCHAP) as Record<string, unknown>;
  assert.equal(pl["users_default"], 0);
  assert.equal(pl["events_default"], 0);
});

test("moderatorPowerLevels: an event type we never named still comes down to 50", () => {
  const pl = moderatorPowerLevels({
    ...ESPACE_TCHAP,
    events: {
      ...ESPACE_TCHAP.events,
      "im.vector.modular.widgets": 100,
      "m.room.retention": 100,
    },
  }) as { events: Record<string, number> };
  assert.equal(pl.events["im.vector.modular.widgets"], 50);
  assert.equal(pl.events["m.room.retention"], 50);
});

test("moderatorPowerLevels: `@room` comes down to 50 too", () => {
  const pl = moderatorPowerLevels({
    ...ESPACE_TCHAP,
    notifications: { room: 100 },
  }) as { notifications: Record<string, number> };
  assert.deepEqual(pl.notifications, { room: 50 });
});

test("moderatorPowerLevels: a right already below 50 is left alone, never raised", () => {
  const pl = moderatorPowerLevels({
    ...ESPACE_TCHAP,
    invite: 0,
    events: { ...ESPACE_TCHAP.events, "m.reaction": 0, "m.room.topic": 0 },
  }) as Record<string, unknown> & { events: Record<string, number> };
  assert.equal(pl["invite"], 0);
  assert.equal(pl.events["m.reaction"], 0);
  assert.equal(pl.events["m.room.topic"], 0);
});

test("moderatorPowerLevels: a room with no notifications block gets none", () => {
  const pl = moderatorPowerLevels(ESPACE_TCHAP) as Record<string, unknown>;
  assert.equal("notifications" in pl, false);
});

test("moderatorPowerLevels: works on a payload with no events map at all", () => {
  const pl = moderatorPowerLevels({ users: { "@bot:srv": 100 } }) as {
    events: Record<string, number>;
  };
  assert.equal(pl.events["m.space.child"], 50);
});
