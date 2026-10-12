// How a hand-typed mention of the bot is recognised, and which handle the help
// prints so that copying an example as plain text actually reaches the bot.
//
// A real "pill" (matrix.to link / m.mentions) is always recognised by the
// connector. These helpers cover the plain-text fallback. The connector and
// the help both rely on them, so what the help prints and what the connector
// accepts cannot drift apart.

// Lowercased leading run of handle characters: "Betabot+admin [Beta]" →
// "betabot+admin". Falls back to the whole lowercased string when it does not
// start with one.
function firstRun(s: string): string {
  return s.toLowerCase().match(/^[\p{L}\p{N}._+-]+/u)?.[0] ?? s.toLowerCase();
}

function localPartOf(userId: string): string {
  return userId ? (userId.replace(/@/, "").split(":")[0] ?? "") : "";
}

// Names a typed plain-text "@name" must match EXACTLY (case-insensitive) to
// count as a mention: the full localpart and the full display name, plus the
// display name truncated at its first whitespace (e.g. "Betabot+admin [Beta]"
// → "@betabot+admin"). The `+`, `-`, `.` and `_` are kept so the real handle
// is matched as a whole — "@betabot" (a mere prefix) does NOT count, only the
// complete "betabot+admin" handle triggers the bot.
export function mentionNames(userId: string, displayName: string): string[] {
  return [localPartOf(userId), displayName]
    .filter((p): p is string => !!p)
    .flatMap((name) => [name.toLowerCase(), firstRun(name)]);
}

// Every "@name" typed in a message body, lowercased, without the "@".
export function typedMentions(body: string): string[] {
  return (body.toLowerCase().match(/@[\p{L}\p{N}._+-]+/gu) ?? []).map((t) =>
    t.slice(1),
  );
}

// The handle printed in front of every command in the help, e.g.
// "@betabot+admin". People copy the examples as plain text, so it has to be a
// form `mentionNames` accepts: a hard-coded "@betabot" is a mere prefix of the
// bot's name and would be silently ignored. The short display name reads
// best; the localpart is the fallback when the display name does not start
// with handle characters.
export function mentionHandle(userId: string, displayName: string): string {
  const handle = [firstRun(displayName), localPartOf(userId).toLowerCase()].find(
    // Kept only when a typed "@handle" is read back whole, as a single name.
    (c) => c && typedMentions(`@${c}`)[0] === c,
  );
  // Reached only by a localpart holding characters a typed mention cannot
  // carry (never the case for Tchap accounts). The user ID at least names the
  // bot; picking it from the client's autocomplete is then the way in.
  return handle ? `@${handle}` : userId;
}
