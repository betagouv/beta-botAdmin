// Detecting the `--options` a command does NOT know.
//
// An unknown option must always be an error, never a silent no-op. A mistyped
// `--simule` on `/invite`, quietly ignored, sends the very invitations the user
// was trying to hold back; a mistyped `--startip` on `/salon create` invites
// nobody and lands in the room's name instead.
//
// `args` is the command line with the verb already stripped. Everything before
// the first option is the positional argument (a startup, a room name), so the
// scan starts at the first option and ignores what precedes it.

// Blank out quoted segments, keeping the string's length so every other offset
// stays valid. A name or an option value may contain a `--` of its own
// (`--salon "Mon --Salon"`); inside quotes it is text, not an option.
function blankQuoted(s: string): string {
  return s.replace(/(["'])(.*?)\1/g, (m) => " ".repeat(m.length));
}

export function unknownFlags(args: string, known: ReadonlySet<string>): string[] {
  const raw = blankQuoted(args.trim());
  const first = raw.search(/(?:^|\s)--/);
  if (first === -1) return [];
  const inconnus: string[] = [];
  for (const m of raw.slice(first).matchAll(/(?:^|\s)--([\p{L}\d-]+)/gu)) {
    const nom = m[1]!.toLowerCase();
    if (!known.has(nom)) inconnus.push(nom);
  }
  return inconnus;
}

// Shared wording for the refusal, so `/invite`, `/salon` and `/espace` all
// explain an unknown option the same way.
export function unknownFlagsMessage(
  inconnus: string[],
  connus: readonly string[],
  aide: string,
): string {
  return (
    `❌ Option inconnue : ${inconnus.map((f) => `\`--${f}\``).join(", ")}.\n\n` +
    `Options reconnues : ${connus.map((f) => `\`--${f}\``).join(", ")}. Aide : \`${aide}\`.`
  );
}
