import { test } from "node:test";
import assert from "node:assert/strict";

// Same module, but with NO default domain configured. Runs in its own process
// (node --test isolates each file), so this env state is independent.
delete process.env["DIMAIL_DOMAIN"];
const { parseListSpec } = await import("../src/commands/emails.js");

test("parseListSpec: bare name without a default domain is rejected", () => {
  const r = parseListSpec("cartobio");
  assert.ok("error" in r);
  assert.match(r.error, /DIMAIL_DOMAIN/);
});

test("parseListSpec: full address still works without a default domain", () => {
  assert.deepEqual(parseListSpec("contact@covoiturage.beta.gouv.fr"), {
    user_name: "contact",
    domain: "covoiturage.beta.gouv.fr",
  });
});
