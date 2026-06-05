import { test } from "node:test";
import assert from "node:assert/strict";

// `config` reads DIMAIL_DOMAIN once, at import time. Set it *before* importing
// the module under test (dynamic import after the env is in place).
process.env["DIMAIL_DOMAIN"] = "beta.gouv.fr";
const { parseListSpec, handleEmailsCommand } = await import(
  "../src/commands/emails.js"
);

test("parseListSpec: bare name resolves to the default domain", () => {
  assert.deepEqual(parseListSpec("cartobio"), {
    user_name: "cartobio",
    domain: "beta.gouv.fr",
  });
});

test("parseListSpec: full address splits into user_name + domain", () => {
  assert.deepEqual(parseListSpec("contact@covoiturage.beta.gouv.fr"), {
    user_name: "contact",
    domain: "covoiturage.beta.gouv.fr",
  });
});

test("parseListSpec: name with allowed punctuation is accepted", () => {
  assert.deepEqual(parseListSpec("ma-liste_2.0"), {
    user_name: "ma-liste_2.0",
    domain: "beta.gouv.fr",
  });
});

test("parseListSpec: empty spec is rejected", () => {
  const r = parseListSpec("");
  assert.ok("error" in r);
});

test("parseListSpec: name with a space is rejected", () => {
  const r = parseListSpec("a b");
  assert.ok("error" in r);
});

test("parseListSpec: address with empty user_name is rejected", () => {
  const r = parseListSpec("@beta.gouv.fr");
  assert.ok("error" in r);
});

test("parseListSpec: address with empty domain is rejected", () => {
  const r = parseListSpec("contact@");
  assert.ok("error" in r);
});

test("handleEmailsCommand: no subcommand returns the help", async () => {
  const r = await handleEmailsCommand("/emails");
  assert.equal(r.reaction, "📖");
  assert.ok(r.message.includes("/emails create"));
});

test("handleEmailsCommand: 'help' subcommand returns the help", async () => {
  const r = await handleEmailsCommand("/emails help");
  assert.ok(r.message.includes("/emails create"));
});

test("handleEmailsCommand: unknown subcommand is reported (no network)", async () => {
  const r = await handleEmailsCommand("/emails bidule");
  assert.equal(r.reaction, "❓");
  assert.ok(r.message.includes("bidule"));
});
