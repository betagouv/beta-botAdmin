import { test } from "node:test";
import assert from "node:assert/strict";

import { parseInviteArgs } from "../src/commands/invite.js";

test("parseInviteArgs: --salon + --liste", () => {
  assert.deepEqual(parseInviteArgs("/invite --salon MonSalon --liste pole-tech"), {
    liste: "pole-tech",
    kind: "salon",
    target: "MonSalon",
  });
});

test("parseInviteArgs: --espace + --liste", () => {
  assert.deepEqual(
    parseInviteArgs("/invite --espace MonEspace --liste pole-tech"),
    { liste: "pole-tech", kind: "espace", target: "MonEspace" },
  );
});

test("parseInviteArgs: order-independent (--liste first)", () => {
  assert.deepEqual(parseInviteArgs("/invite --liste pole-tech --salon MonSalon"), {
    liste: "pole-tech",
    kind: "salon",
    target: "MonSalon",
  });
});

test("parseInviteArgs: quoted values with spaces", () => {
  assert.deepEqual(
    parseInviteArgs('/invite --espace "Fabrique Numérique" --liste "Pole Tech"'),
    { liste: "Pole Tech", kind: "espace", target: "Fabrique Numérique" },
  );
});

test("parseInviteArgs: room ID as target", () => {
  assert.deepEqual(
    parseInviteArgs("/invite --salon !abc:serveur.fr --liste pole-tech"),
    { liste: "pole-tech", kind: "salon", target: "!abc:serveur.fr" },
  );
});

test("parseInviteArgs: null when list missing", () => {
  assert.equal(parseInviteArgs("/invite --salon MonSalon"), null);
});

test("parseInviteArgs: null when target missing", () => {
  assert.equal(parseInviteArgs("/invite --liste pole-tech"), null);
});

test("parseInviteArgs: null when no flags", () => {
  assert.equal(parseInviteArgs("/invite pole-tech MonSalon"), null);
});
