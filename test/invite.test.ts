import { test } from "node:test";
import assert from "node:assert/strict";

import { parseInviteArgs } from "../src/commands/invite.js";

test("parseInviteArgs: startup alone → the current room", () => {
  assert.deepEqual(parseInviteArgs("/invite cartobio"), {
    startup: "cartobio",
    target: { kind: "ici" },
  });
});

test("parseInviteArgs: startup + --salon", () => {
  assert.deepEqual(parseInviteArgs("/invite cartobio --salon MonSalon"), {
    startup: "cartobio",
    target: { kind: "salon", name: "MonSalon" },
  });
});

test("parseInviteArgs: startup + --espace <id>", () => {
  assert.deepEqual(parseInviteArgs("/invite cartobio --espace !abc:serveur.fr"), {
    startup: "cartobio",
    target: { kind: "espace", id: "!abc:serveur.fr" },
  });
});

// A name is accepted by the parser and rejected later, by resolveInviteTarget,
// which owns the "ID only" rule and can explain how to get the ID.
test("parseInviteArgs: --espace still parses a non-ID value", () => {
  assert.deepEqual(parseInviteArgs("/invite cartobio --espace MonEspace"), {
    startup: "cartobio",
    target: { kind: "espace", id: "MonEspace" },
  });
});

test("parseInviteArgs: bare --espace → the parent space", () => {
  assert.deepEqual(parseInviteArgs("/invite cartobio --espace"), {
    startup: "cartobio",
    target: { kind: "espace-parent" },
  });
});

test("parseInviteArgs: --domaine restricts the invitation", () => {
  assert.deepEqual(parseInviteArgs("/invite cartobio --domaine dev"), {
    startup: "cartobio",
    domaine: "dev",
    target: { kind: "ici" },
  });
});

test("parseInviteArgs: --domaine combines with a target, in any order", () => {
  const expected = {
    startup: "cartobio",
    domaine: "dev",
    target: { kind: "espace-parent" },
  };
  assert.deepEqual(parseInviteArgs("/invite cartobio --domaine dev --espace"), expected);
  assert.deepEqual(parseInviteArgs("/invite cartobio --espace --domaine dev"), expected);
});

test("parseInviteArgs: bare --espace before --domaine does not eat the next flag", () => {
  assert.deepEqual(parseInviteArgs("/invite cartobio --espace --domaine dev"), {
    startup: "cartobio",
    domaine: "dev",
    target: { kind: "espace-parent" },
  });
});

test("parseInviteArgs: quoted startup, salon and domaine with spaces", () => {
  assert.deepEqual(
    parseInviteArgs(
      '/invite "Mon Startup" --salon "Mon Salon" --domaine "chargé de déploiement"',
    ),
    {
      startup: "Mon Startup",
      domaine: "chargé de déploiement",
      target: { kind: "salon", name: "Mon Salon" },
    },
  );
});

test("parseInviteArgs: unquoted multi-word startup keeps every word", () => {
  assert.deepEqual(parseInviteArgs("/invite Mon Startup --espace"), {
    startup: "Mon Startup",
    target: { kind: "espace-parent" },
  });
});

test("parseInviteArgs: room ID as target", () => {
  assert.deepEqual(
    parseInviteArgs("/invite cartobio --salon !abc:serveur.fr"),
    { startup: "cartobio", target: { kind: "salon", name: "!abc:serveur.fr" } },
  );
});

test("parseInviteArgs: a named --salon wins over a bare --espace", () => {
  assert.deepEqual(
    parseInviteArgs("/invite cartobio --espace --salon MonSalon"),
    { startup: "cartobio", target: { kind: "salon", name: "MonSalon" } },
  );
});

test("parseInviteArgs: bare --domaine means everybody", () => {
  assert.deepEqual(parseInviteArgs("/invite cartobio --domaine"), {
    startup: "cartobio",
    target: { kind: "ici" },
  });
});

test("parseInviteArgs: --moderateur is a standalone switch", () => {
  assert.deepEqual(parseInviteArgs("/invite cartobio --moderateur"), {
    startup: "cartobio",
    moderateur: true,
    target: { kind: "ici" },
  });
});

test("parseInviteArgs: --modérateur (accented) works too", () => {
  assert.deepEqual(parseInviteArgs("/invite cartobio --modérateur"), {
    startup: "cartobio",
    moderateur: true,
    target: { kind: "ici" },
  });
});

test("parseInviteArgs: --moderateur combines with domaine and target", () => {
  assert.deepEqual(
    parseInviteArgs("/invite cartobio --espace --domaine dev --moderateur"),
    {
      startup: "cartobio",
      domaine: "dev",
      moderateur: true,
      target: { kind: "espace-parent" },
    },
  );
});

test("parseInviteArgs: --moderateur absent leaves the flag unset", () => {
  assert.deepEqual(parseInviteArgs("/invite cartobio --domaine dev"), {
    startup: "cartobio",
    domaine: "dev",
    target: { kind: "ici" },
  });
});

test("parseInviteArgs: --moderateur does not swallow a following flag", () => {
  assert.deepEqual(parseInviteArgs("/invite cartobio --moderateur --domaine dev"), {
    startup: "cartobio",
    domaine: "dev",
    moderateur: true,
    target: { kind: "ici" },
  });
});

test("parseInviteArgs: null when the startup is missing", () => {
  assert.equal(parseInviteArgs("/invite --espace MonEspace"), null);
  assert.equal(parseInviteArgs("/invite --domaine dev"), null);
});
