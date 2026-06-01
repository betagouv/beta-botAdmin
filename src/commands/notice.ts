// Generic reply sent when someone talks to the bot outside of a slash command.
// The bot only handles commands — it does NOT chat in natural language — so any
// DM or @mention that isn't a command gets this notice pointing to the command
// room(s) and an optional contact.

export interface CommandOnlyNoticeOptions {
  commandRooms: string[];
  commandRoomsLabel: string | undefined;
  contact: string | undefined;
  commands: readonly string[];
}

export function buildCommandOnlyNotice({
  commandRooms,
  commandRoomsLabel,
  contact,
  commands,
}: CommandOnlyNoticeOptions): string {
  const where = commandRoomsLabel
    ? `\`${commandRoomsLabel}\``
    : commandRooms.length > 0
      ? commandRooms.map((r) => `\`${r}\``).join(", ")
      : "le salon dédié aux commandes";
  const contactLine = contact
    ? `\nℹ️ Besoin d'une information ? Contacte **${contact}**.`
    : "";
  const cmds = commands.map((c) => `\`${c}\``).join(", ");
  return `🤖 Je suis un bot **à commandes** : je ne réponds pas aux messages en langage naturel.\n\n➡️ Les commandes doivent être lancées dans ${where}.${contactLine}\n\nCommandes disponibles : ${cmds}.`;
}
