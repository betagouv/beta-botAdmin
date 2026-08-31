import { test } from "node:test";
import assert from "node:assert/strict";

import { parseReply, statutPourReaction } from "../src/connectors/n8n.js";

// A silent 200 must never read as success: that is how the `--moderateur`
// branch of the workflow looked healthy while inviting nobody.
test("parseReply: an empty body is a warning, not a success", () => {
  const r = parseReply("");
  assert.equal(r.reaction, "⚠️");
  assert.match(r.message, /sans aucun message/);
});

test("parseReply: a whitespace-only body is a warning too", () => {
  assert.equal(parseReply("   \n\t ").reaction, "⚠️");
});

test("parseReply: a blank JSON message is a warning", () => {
  assert.equal(parseReply('{"message":""}').reaction, "⚠️");
  assert.equal(parseReply('{"message":"   "}').reaction, "⚠️");
  assert.equal(parseReply('{"message":null}').reaction, "⚠️");
});

test("parseReply: a blank message wins over the reaction n8n sent", () => {
  // Otherwise a workflow could claim success with a ✅ and say nothing.
  assert.equal(parseReply('{"message":"","reaction":"✅"}').reaction, "⚠️");
});

test("parseReply: a normal reply keeps its message and reaction", () => {
  assert.deepEqual(parseReply('{"message":"4 invités","reaction":"📋"}'), {
    message: "4 invités",
    reaction: "📋",
  });
});

test("parseReply: a message without reaction defaults to ✅", () => {
  assert.deepEqual(parseReply('{"message":"Fait"}'), {
    message: "Fait",
    reaction: "✅",
  });
});

test("parseReply: the message is trimmed", () => {
  assert.equal(parseReply('{"message":"  Fait  "}').message, "Fait");
});

test("parseReply: plain text is still accepted as the message", () => {
  assert.deepEqual(parseReply("Tout va bien"), {
    message: "Tout va bien",
    reaction: "✅",
  });
});

test("parseReply: a JSON object without `message` is flagged, not validated", () => {
  const r = parseReply('{"ok":true}');
  assert.equal(r.reaction, "⚠️");
  assert.match(r.message, /Réponse inattendue/);
  // Le corps reçu reste visible pour le diagnostic.
  assert.match(r.message, /\{"ok":true\}/);
});

// 📭 / 🔎 / 🤔 / 🧪 sont des réponses utiles, pas des échecs : les compter en
// erreur gonflait le taux d'échec de commandes parfaitement déroulées.
test("statutPourReaction: les réponses informatives comptent comme ok", () => {
  for (const r of ["✅", "📋", "📭", "🔎", "🤔", "🧪", "📖"]) {
    assert.equal(statutPourReaction(r), "ok", `${r} devrait être ok`);
  }
});

test("statutPourReaction: seules les vraies erreurs comptent comme error", () => {
  for (const r of ["❌", "⛔", "⏱️", "⚠️"]) {
    assert.equal(statutPourReaction(r), "error", `${r} devrait être error`);
  }
});

test("statutPourReaction: une réaction inconnue n'est pas une erreur", () => {
  assert.equal(statutPourReaction("🎉"), "ok");
  assert.equal(statutPourReaction(""), "ok");
});
