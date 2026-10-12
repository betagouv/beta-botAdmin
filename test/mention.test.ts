import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mentionHandle,
  mentionNames,
  typedMentions,
} from "../src/tools/mention.js";
import { buildHelp } from "../src/tools/help.js";
import { buildInviteHelp } from "../src/commands/invite.js";

const BOT = "@betabotadmin-beta.gouv.fr:agent.dinum.tchap.gouv.fr";
const NAME = "Betabot+admin [Beta]";

// The property that matters: an example copied from the help, as plain text,
// reaches the bot. A handle the connector does not accept turns every example
// into a silent no-op.
function reachesBot(handle: string, displayName: string): boolean {
  const names = mentionNames(BOT, displayName);
  return typedMentions(`${handle} /help`).some((t) => names.includes(t));
}

test("mentionHandle: the short display name when it can be typed", () => {
  assert.equal(mentionHandle(BOT, NAME), "@betabot+admin");
});

test("mentionHandle: what the help prints is what the connector accepts", () => {
  for (const name of [NAME, "", "[Beta] Bot", "Betabot"]) {
    assert.ok(reachesBot(mentionHandle(BOT, name), name), `display name "${name}"`);
  }
});

test("mentionHandle: falls back to the localpart when the display name can't be typed", () => {
  assert.equal(mentionHandle(BOT, "[Beta] Bot"), "@betabotadmin-beta.gouv.fr");
  assert.equal(mentionHandle(BOT, ""), "@betabotadmin-beta.gouv.fr");
});

// Other bots share the "betabot" prefix: a bare "@betabot" must never count as
// a mention of this one. That is exactly why the help cannot print it.
test("mentionNames: a bare prefix of the name is not a mention", () => {
  const names = mentionNames(BOT, NAME);
  assert.equal(
    typedMentions("@betabot /help").some((t) => names.includes(t)),
    false,
  );
});

test("typedMentions: a handle holding + . - is read whole", () => {
  assert.deepEqual(typedMentions("@Betabot+admin /help"), ["betabot+admin"]);
});

test("help: every example carries the handle, none the bare @betabot", () => {
  for (const text of [buildHelp("@betabot+admin"), buildInviteHelp("@betabot+admin")]) {
    assert.match(text, /`@betabot\+admin \//);
    assert.doesNotMatch(text, /@betabot \//);
  }
});
