import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCommandOnlyNotice } from "../src/commands/notice.js";

test("buildCommandOnlyNotice: uses the human label when provided", () => {
  const out = buildCommandOnlyNotice({
    commandRooms: ["!abc:server.org"],
    commandRoomsLabel: "Salon Admin betabot",
    contact: undefined,
    commands: ["/help"],
  });
  assert.ok(out.includes("`Salon Admin betabot`"));
  assert.ok(!out.includes("!abc:server.org"));
});

test("buildCommandOnlyNotice: lists room ids when there is no label", () => {
  const out = buildCommandOnlyNotice({
    commandRooms: ["!a:server.org", "!b:server.org"],
    commandRoomsLabel: undefined,
    contact: undefined,
    commands: ["/help"],
  });
  assert.ok(out.includes("`!a:server.org`"));
  assert.ok(out.includes("`!b:server.org`"));
});

test("buildCommandOnlyNotice: falls back when no label and no rooms", () => {
  const out = buildCommandOnlyNotice({
    commandRooms: [],
    commandRoomsLabel: undefined,
    contact: undefined,
    commands: ["/help"],
  });
  assert.ok(out.includes("le salon dédié aux commandes"));
});

test("buildCommandOnlyNotice: includes the contact line only when set", () => {
  const withContact = buildCommandOnlyNotice({
    commandRooms: [],
    commandRoomsLabel: "Salon",
    contact: "Maxime",
    commands: ["/help"],
  });
  assert.ok(withContact.includes("Contacte **Maxime**"));

  const withoutContact = buildCommandOnlyNotice({
    commandRooms: [],
    commandRoomsLabel: "Salon",
    contact: undefined,
    commands: ["/help"],
  });
  assert.ok(!withoutContact.includes("Contacte"));
});

test("buildCommandOnlyNotice: formats the command list as inline code", () => {
  const out = buildCommandOnlyNotice({
    commandRooms: [],
    commandRoomsLabel: "Salon",
    contact: undefined,
    commands: ["/help", "/emails", "/salon"],
  });
  assert.ok(out.includes("`/help`, `/emails`, `/salon`"));
});
