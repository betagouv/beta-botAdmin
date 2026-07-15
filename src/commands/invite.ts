// Pure parsing for `/invite <liste> --salon <nom>` / `--espace <nom>`.
// The bot parses + resolves the target room, then forwards to n8n (which reads
// the member list and performs the invitations).

export interface InviteArgs {
  liste: string;
  kind: "salon" | "espace";
  target: string;
}

// True for `/invite`, `/invite help` or `/invite aide` (show the help card).
export function isInviteHelp(text: string): boolean {
  const arg = text.replace(/^\/invite\s*/i, "").trim().toLowerCase();
  return arg === "" || arg === "help" || arg === "aide";
}

export function buildInviteHelp(): string {
  return [
    "# `/invite` — inviter une liste de membres",
    "",
    "Invite tous les membres d'une **liste** dans un salon ou un espace.",
    "",
    "| Commande | Effet |",
    "|---|---|",
    "| `@betabot /invite --salon <nom> --liste <liste>` | Invite la liste dans le **salon** <nom> |",
    "| `@betabot /invite --espace <nom> --liste <liste>` | Invite la liste dans l'**espace** <nom> |",
    "| `@betabot /invite help` | Affiche cette aide |",
    "",
    "- L'ordre des options n'importe pas.",
    "- Le salon/espace est cherché **sous l'espace géré** (par nom, ou ID `!…:serveur`).",
    "- Tu dois être **membre** du salon/espace ciblé.",
    "- Les listes se gèrent dans Grist ; vois les membres avec `/liste-membre <liste>`.",
    "- Un nom avec des espaces : entre guillemets — `--espace \"Fabrique Numérique\"`.",
    "",
    "**Exemple** : `@betabot /invite --salon Coordination --liste pole-tech`",
  ].join("\n");
}

// Grab a `--flag value` where value is quoted or a single token. Returns the
// unquoted value, or null.
function grabFlag(raw: string, flag: string): string | null {
  const m = raw.match(
    new RegExp(`--${flag}\\s+("[^"]+"|'[^']+'|\\S+)`, "i"),
  );
  return m ? m[1]!.replace(/^["']|["']$/g, "") : null;
}

// Parse `/invite --salon <nom> --liste <liste>` (or `--espace`). Flags may be
// in any order. Returns null when either the target or the list is missing.
export function parseInviteArgs(text: string): InviteArgs | null {
  const raw = text.replace(/^\/invite\s*/i, "").trim();
  const liste = grabFlag(raw, "liste");
  const salon = grabFlag(raw, "salon");
  const espace = grabFlag(raw, "espace");
  if (!liste) return null;
  if (salon) return { liste, kind: "salon", target: salon };
  if (espace) return { liste, kind: "espace", target: espace };
  return null;
}
