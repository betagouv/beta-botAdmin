import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRoomAndSpace } from "../src/commands/rooms.js";

test("parseRoomAndSpace: quoted trailing segment is the espace (spaces allowed)", () => {
  assert.deepEqual(parseRoomAndSpace('Mon Salon "Pole Tech"'), {
    roomName: "Mon Salon",
    spaceCandidate: "Pole Tech",
    explicit: true,
  });
});

test("parseRoomAndSpace: single-quoted trailing segment also works", () => {
  assert.deepEqual(parseRoomAndSpace("Mon Salon 'Pole Tech'"), {
    roomName: "Mon Salon",
    spaceCandidate: "Pole Tech",
    explicit: true,
  });
});

test("parseRoomAndSpace: double-quoted espace may contain an apostrophe", () => {
  assert.deepEqual(
    parseRoomAndSpace('test-chan2 "Fabrique numérique de l\'écologie"'),
    {
      roomName: "test-chan2",
      spaceCandidate: "Fabrique numérique de l'écologie",
      explicit: true,
    },
  );
});

test("parseRoomAndSpace: a wholly quoted value is the room name, no espace", () => {
  assert.deepEqual(parseRoomAndSpace('"mon salon"'), {
    roomName: "mon salon",
    spaceCandidate: null,
    explicit: false,
  });
});

test("parseRoomAndSpace: bare last word is a candidate espace (backward compatible)", () => {
  assert.deepEqual(parseRoomAndSpace("mon-salon tech"), {
    roomName: "mon-salon tech",
    spaceCandidate: "tech",
    explicit: false,
  });
});

test("parseRoomAndSpace: single bare word has no espace candidate", () => {
  assert.deepEqual(parseRoomAndSpace("mon-salon"), {
    roomName: "mon-salon",
    spaceCandidate: null,
    explicit: false,
  });
});

test("parseRoomAndSpace: unquoted multi-word name keeps the whole string as candidate room name", () => {
  // Caller only strips the last word when it resolves to an existing sub-space;
  // otherwise the full string is the room name.
  const r = parseRoomAndSpace("Mon Salon Pole Tech");
  assert.equal(r.roomName, "Mon Salon Pole Tech");
  assert.equal(r.spaceCandidate, "Tech");
  assert.equal(r.explicit, false);
});
