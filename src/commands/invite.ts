// Pure parsing for `/invite <startup> [--domaine <domaine>] [--salon <nom>|--espace [<nom>]]`.
// The bot parses + resolves the target room, then forwards to n8n (which reads
// the startup's members and performs the invitations).

// Where the invitations land. `ici` and `espace-parent` need no name: they are
// resolved from the room the command was typed in. `espace-parent` exists
// because no Matrix client offers a composer for a space, so a space can never
// be the room a command is typed in — you stand in one of its rooms instead.
export type InviteTarget =
  | { kind: "salon"; name: string }
  // A space is designated by its room ID, never by name: names collide across
  // the tree and a space has no composer to read its ID from. `/espace list`
  // prints the IDs.
  | { kind: "espace"; id: string }
  | { kind: "ici" }
  | { kind: "espace-parent" };

export interface InviteArgs {
  // The startup whose members get invited (positional, first argument).
  startup: string;
  // Optional: restrict the invitations to that domaine (job family) within the
  // startup. Matches the `domaine` column read by n8n. Absent = everybody.
  domaine?: string;
  // `--moderateur`: also raise every invited member to moderator (power 50).
  // Gated behind a stricter permission check than the invitation itself.
  moderateur?: boolean;
  // `--simuler`: resolve the target and run the permission checks, then stop
  // and report — without ever contacting n8n, so nobody is invited. The point
  // is to rehearse a command in the real room before running it for real.
  simuler?: boolean;
  target: InviteTarget;
}

// True for `/invite`, `/invite help` or `/invite aide` (show the help card).
export function isInviteHelp(text: string): boolean {
  const arg = text.replace(/^\/invite\s*/i, "").trim().toLowerCase();
  return arg === "" || arg === "help" || arg === "aide";
}

export function buildInviteHelp(): string {
  return [
    "# `/invite` — inviter les membres d'une startup",
    "",
    "Invite les membres d'une **startup** dans un salon ou un espace.",
    "",
    "| Commande | Effet |",
    "|---|---|",
    "| `@betabot /invite <startup>` | Invite la startup **dans le salon où tu tapes** |",
    "| `@betabot /invite <startup> --espace` | Invite la startup dans l'**espace qui contient ce salon** |",
    "| `@betabot /invite <startup> --salon <nom>` | Invite la startup dans le **salon** <nom> |",
    "| `@betabot /invite <startup> --espace <!id:serveur>` | Invite la startup dans l'**espace** d'ID donné |",
    "| `@betabot /invite <startup> --domaine <domaine>` | N'invite que les membres de ce **domaine** |",
    "| `@betabot /invite <startup> --moderateur` | Invite **et** passe chacun **modérateur** |",
    "| `@betabot /invite <startup> --simuler` | **N'invite personne** : affiche ce que ferait la commande |",
    "| `@betabot /invite help` | Affiche cette aide |",
    "",
    "- Le nom de la startup vient **en premier**, avant les options.",
    "- L'ordre des options n'importe pas ; elles se combinent.",
    "- `--domaine` est optionnel : sans lui, **tous** les membres de la startup sont invités.",
    "- Domaines : `Animation`, `Attributaire`, `Autre`, `Coaching`, `Data`, `Déploiement`, `Design`, `Développement`, `Intraprenariat`, `Produit`, `Support`. Casse et accents ignorés ; un préfixe marche s'il est **sans ambiguïté** (ex. `dev`, `depl`, `desi`, `data`).",
    "- `--espace` **sans valeur** vise l'espace parent : un espace n'a pas de zone de saisie, on se place donc dans un de ses salons.",
    "- `--espace` **avec valeur** attend l'**ID** (`!xxxx:serveur`), pas le nom : récupère-le avec `@betabot /espace list`.",
    "- `--salon` accepte le **nom** ou l'ID. Nom avec des espaces : entre guillemets — `--salon \"Mon Salon\"`.",
    "- Le salon/espace visé est cherché **sous l'espace géré**.",
    "- Tu dois avoir le **droit d'inviter** dans le salon/espace ciblé — être simple membre ne suffit pas si le salon réserve l'invitation aux modérateurs.",
    "- `--moderateur` exige que tu sois **toi-même modérateur** (niveau ≥ 50) dans la cible : on ne donne pas un pouvoir qu'on n'a pas.",
    "- `--simuler` (ou `--dry-run`) fait une **répétition** : le bot résout la cible et vérifie tes droits, puis s'arrête. Aucune invitation n'est envoyée, le service n'est même pas contacté.",
    "",
    "**Exemple** : depuis un salon de l'espace, `@betabot /invite api-engagement --espace --domaine dev`",
  ].join("\n");
}

// Grab a `--flag [value]` where value is quoted or a single token. Returns the
// unquoted value, `""` when the flag is present with no value (bare `--espace`,
// which is meaningful here), or null when the flag is absent. The `(?!--)`
// guard stops a bare flag from swallowing the next flag as its value.
function grabFlag(raw: string, flag: string): string | null {
  const m = raw.match(
    new RegExp(`--${flag}(?:\\s+("[^"]+"|'[^']+'|(?!--)\\S+))?`, "i"),
  );
  if (!m) return null;
  return m[1] ? m[1].replace(/^["']|["']$/g, "") : "";
}

// Every flag `/invite` understands, in every accepted spelling.
const FLAGS_CONNUS = new Set([
  "domaine",
  "salon",
  "espace",
  "moderateur",
  "modérateur",
  "simuler",
  "simulation",
  "dry-run",
]);

// Flags typed by the user that `/invite` does not know. An unknown flag must be
// an error, never a silent no-op: a mistyped `--simule` that we quietly ignore
// would send the real invitations the user was trying to avoid. Same reasoning
// for a mistyped `--moderateur`, in the other direction.
export function unknownInviteFlags(text: string): string[] {
  const raw = text.replace(/^\/invite\s*/i, "").trim();
  const firstFlag = raw.search(/(?:^|\s)--/);
  if (firstFlag === -1) return [];
  const flags = raw.slice(firstFlag);
  const inconnus: string[] = [];
  for (const m of flags.matchAll(/(?:^|\s)--([\p{L}\d-]+)/gu)) {
    const nom = m[1]!.toLowerCase();
    if (!FLAGS_CONNUS.has(nom)) inconnus.push(nom);
  }
  return inconnus;
}

// Parse `/invite <startup> [--domaine <domaine>] [--salon <nom> | --espace [<nom>]]`.
// The startup is mandatory and positional; the rest is optional and
// order-independent:
//   --domaine <domaine>             → only that domaine within the startup
//   --moderateur                    → also promote them to moderator (power 50)
//   --simuler | --dry-run           → rehearse only: never contacts n8n
//   --salon <nom>                   → that room, by name or id
//   --espace <!id:serveur>          → that space, by ID only
//   --espace       (no value)       → the space holding the current room
//   (no target flag)                → the current room
// Returns null only when the startup name is missing.
export function parseInviteArgs(text: string): InviteArgs | null {
  const raw = text.replace(/^\/invite\s*/i, "").trim();
  // The startup name is everything before the first `--flag`. Anchoring it
  // there is what makes `--espace` usable with *or* without a value: in
  // `/invite cartobio --espace`, a free-floating name could otherwise be read
  // as that flag's value.
  const firstFlag = raw.search(/(?:^|\s)--/);
  const head = (firstFlag === -1 ? raw : raw.slice(0, firstFlag)).trim();
  const startup = head.replace(/^["']|["']$/g, "");
  if (!startup) return null;
  const flags = firstFlag === -1 ? "" : raw.slice(firstFlag);
  const domaine = grabFlag(flags, "domaine");
  const salon = grabFlag(flags, "salon");
  const espace = grabFlag(flags, "espace");
  // Standalone switch, no value. Both spellings accepted — people type it both
  // ways and a silent no-op on an accent would be a nasty surprise.
  const moderateur = /(?:^|\s)--mod[eé]rateur\b/i.test(flags);
  // Rehearsal switch. Both spellings accepted; `--dry-run` is what people who
  // already know the concept reach for first.
  const simuler = /(?:^|\s)--(?:simuler|simulation|dry-run)\b/i.test(flags);
  // A bare `--domaine` carries no value, so it means "everybody" like an absent one.
  const base = {
    startup,
    ...(domaine ? { domaine } : {}),
    ...(moderateur ? { moderateur: true } : {}),
    ...(simuler ? { simuler: true } : {}),
  };
  if (salon) return { ...base, target: { kind: "salon", name: salon } };
  if (espace) return { ...base, target: { kind: "espace", id: espace } };
  // Bare `--espace` targets the parent space; bare `--salon` (or no target flag
  // at all) targets the room the command was typed in.
  if (espace === "") return { ...base, target: { kind: "espace-parent" } };
  return { ...base, target: { kind: "ici" } };
}
