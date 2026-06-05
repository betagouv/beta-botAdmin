import { config } from "../config.js";
import { dimailFetch, refreshToken } from "../tools/dimail.js";

export interface CommandResult {
  reaction: string;
  message: string;
}

const HELP = `📖 **Commandes \`/emails\` disponibles**

- \`/emails create <liste> <email>\` — Crée une liste avec un propriétaire
- \`/emails list <liste>\` — Affiche les membres d'une liste
- \`/emails join <liste> <email>\` — Ajoute un membre à une liste
- \`/emails leave <liste> <email>\` — Retire un membre d'une liste

**Exemples**
- \`/emails join cartobio jean.louis@beta.gouv.fr\` → ajoute à \`cartobio@${config.dimail.domain ?? "<DIMAIL_DOMAIN non configuré>"}\`
- \`/emails join contact@covoiturage.beta.gouv.fr jean.louis@beta.gouv.fr\` → adresse complète pour sous-domaine`;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LIST_NAME_RE = /^[a-z0-9._-]+$/i;

interface ListSpec {
  user_name: string;
  domain: string;
}

export function parseListSpec(spec: string): ListSpec | { error: string } {
  if (!spec) return { error: "Le nom de liste est vide." };
  if (spec.includes("@")) {
    const at = spec.indexOf("@");
    const user_name = spec.slice(0, at);
    const domain = spec.slice(at + 1);
    if (!user_name || !domain) {
      return { error: `Adresse de liste invalide: \`${spec}\`` };
    }
    if (!LIST_NAME_RE.test(user_name)) {
      return { error: `Nom de liste invalide: \`${user_name}\`` };
    }
    return { user_name, domain };
  }
  if (!LIST_NAME_RE.test(spec)) {
    return {
      error: `Nom de liste invalide: \`${spec}\` (autorisé: lettres, chiffres, \`.\` \`_\` \`-\`)`,
    };
  }
  if (!config.dimail.domain) {
    return {
      error:
        "Aucun domaine par défaut configuré (DIMAIL_DOMAIN vide). Utilise la forme `<liste>@<domaine>`.",
    };
  }
  return { user_name: spec, domain: config.dimail.domain };
}

function fmtListAddress(l: ListSpec): string {
  return `\`${l.user_name}@${l.domain}\``;
}

function badUsage(usage: string): CommandResult {
  return {
    reaction: "📖",
    message: `📖 **Usage** : \`${usage}\`\n\n${HELP}`,
  };
}

function badEmail(s: string): CommandResult {
  return {
    reaction: "⚠️",
    message: `⚠️ Adresse email invalide : \`${s}\`\nExemple attendu : \`prenom.nom@beta.gouv.fr\``,
  };
}

function dimailError(action: string, res: unknown): CommandResult {
  const r = res as { status?: number; body?: unknown };
  const status = r.status ?? "?";
  let detail = "";
  if (r.body && typeof r.body === "object" && "detail" in r.body) {
    detail = String((r.body as { detail: unknown }).detail);
  } else if (typeof r.body === "string") {
    detail = r.body;
  }
  let hint = "";
  if (r.status === 403) {
    hint =
      "\n💡 Ton compte n'a pas les droits sur ce domaine (ACLs vides côté DiMail).";
  } else if (r.status === 404) {
    hint = "\n💡 Le domaine ou la liste n'existe pas.";
  } else if (r.status === 401) {
    hint = "\n💡 Token DiMail invalide ou expiré.";
  }
  return {
    reaction: "❌",
    message: `❌ Échec ${action} (HTTP ${status})${detail ? `: ${detail}` : ""}${hint}`,
  };
}

function isDimailError(res: unknown): res is { error: true; status: number; body: unknown } {
  return (
    typeof res === "object" &&
    res !== null &&
    "error" in res &&
    (res as { error: unknown }).error === true
  );
}

interface Alias {
  destination: string;
}

async function cmdCreate(args: string[]): Promise<CommandResult> {
  if (args.length !== 2) {
    return badUsage("/emails create <liste> <email>");
  }
  const [listSpec, email] = args;
  if (!email || !EMAIL_RE.test(email)) return badEmail(email ?? "");
  const parsed = parseListSpec(listSpec ?? "");
  if ("error" in parsed) {
    return { reaction: "⚠️", message: `⚠️ ${parsed.error}` };
  }

  const existing = (await dimailFetch(
    `/domains/${encodeURIComponent(parsed.domain)}/aliases/?user_name=${encodeURIComponent(parsed.user_name)}`,
  )) as Alias[] | { error: true; status: number; body: unknown };

  if (isDimailError(existing)) {
    return dimailError("de la vérification d'existence", existing);
  }

  if (Array.isArray(existing) && existing.length > 0) {
    return {
      reaction: "⚠️",
      message: `⚠️ La liste ${fmtListAddress(parsed)} existe déjà (${existing.length} membre(s)). Utilise \`/emails join\` pour ajouter un membre.`,
    };
  }

  const created = await dimailFetch(
    `/domains/${encodeURIComponent(parsed.domain)}/aliases/`,
    {
      method: "POST",
      body: JSON.stringify({ user_name: parsed.user_name, destination: email }),
    },
  );

  if (isDimailError(created)) {
    return dimailError("de la création", created);
  }

  return {
    reaction: "✅",
    message: `✅ Liste ${fmtListAddress(parsed)} créée avec le propriétaire \`${email}\`.`,
  };
}

// Members of a single list. Requires an explicit list name — there is no
// "list everything" command (disabled on purpose).
async function cmdListOne(spec: string): Promise<CommandResult> {
  const parsed = parseListSpec(spec);
  if ("error" in parsed) {
    return { reaction: "⚠️", message: `⚠️ ${parsed.error}` };
  }
  const res = (await dimailFetch(
    `/domains/${encodeURIComponent(parsed.domain)}/aliases/?user_name=${encodeURIComponent(parsed.user_name)}`,
  )) as Alias[] | { error: true; status: number; body: unknown };
  if (isDimailError(res)) return dimailError("du listing", res);

  if (!Array.isArray(res) || res.length === 0) {
    return {
      reaction: "📭",
      message: `📭 Aucun membre sur la liste ${fmtListAddress(parsed)} (la liste n'existe peut-être pas).`,
    };
  }
  const lines = res
    .map((a) => `- \`${a.destination}\``)
    .sort((a, b) => a.localeCompare(b));
  return {
    reaction: "📋",
    message: `📋 **${res.length} membre(s) sur ${fmtListAddress(parsed)}** :\n\n${lines.join("\n")}`,
  };
}

async function cmdJoin(args: string[]): Promise<CommandResult> {
  if (args.length !== 2) {
    return badUsage("/emails join <liste> <email>");
  }
  const [listSpec, email] = args;
  if (!email || !EMAIL_RE.test(email)) return badEmail(email ?? "");
  const parsed = parseListSpec(listSpec ?? "");
  if ("error" in parsed) {
    return { reaction: "⚠️", message: `⚠️ ${parsed.error}` };
  }
  const res = await dimailFetch(
    `/domains/${encodeURIComponent(parsed.domain)}/aliases/`,
    {
      method: "POST",
      body: JSON.stringify({ user_name: parsed.user_name, destination: email }),
    },
  );
  if (isDimailError(res)) return dimailError("de l'ajout", res);
  return {
    reaction: "✅",
    message: `✅ \`${email}\` ajouté à la liste ${fmtListAddress(parsed)}.`,
  };
}

async function cmdLeave(args: string[]): Promise<CommandResult> {
  if (args.length !== 2) {
    return badUsage("/emails leave <liste> <email>");
  }
  const [listSpec, email] = args;
  if (!email || !EMAIL_RE.test(email)) return badEmail(email ?? "");
  const parsed = parseListSpec(listSpec ?? "");
  if ("error" in parsed) {
    return { reaction: "⚠️", message: `⚠️ ${parsed.error}` };
  }
  const res = await dimailFetch(
    `/domains/${encodeURIComponent(parsed.domain)}/aliases/${encodeURIComponent(parsed.user_name)}/${encodeURIComponent(email)}`,
    { method: "DELETE" },
  );
  if (isDimailError(res)) return dimailError("du retrait", res);
  return {
    reaction: "✅",
    message: `✅ \`${email}\` retiré de la liste ${fmtListAddress(parsed)}.`,
  };
}

export async function handleEmailsCommand(text: string): Promise<CommandResult> {
  const stripped = text.trim().replace(/^\/emails\b\s*/i, "");
  const tokens = stripped.split(/\s+/).filter((t) => t.length > 0);

  if (tokens.length === 0) {
    return { reaction: "📖", message: HELP };
  }

  const sub = (tokens[0] ?? "").toLowerCase();
  const rest = tokens.slice(1);

  try {
    // Re-authenticate on every command that hits the API: fetch a fresh token
    // from /token/ instead of reusing a cached or env-provided one.
    if (["create", "list", "join", "leave"].includes(sub)) {
      await refreshToken();
    }
    switch (sub) {
      case "help":
      case "?":
        return { reaction: "📖", message: HELP };
      case "create":
        return await cmdCreate(rest);
      case "list":
        // `/emails list <liste>` only. Bare `/emails list` is disabled on purpose.
        if (rest.length === 1) return await cmdListOne(rest[0] ?? "");
        return badUsage("/emails list <liste>");
      case "join":
        return await cmdJoin(rest);
      case "leave":
        return await cmdLeave(rest);
      default:
        return {
          reaction: "❓",
          message: `❓ Sous-commande inconnue : \`${sub}\`\n\n${HELP}`,
        };
    }
  } catch (err) {
    return {
      reaction: "❌",
      message: `❌ Erreur interne : \`${String(err instanceof Error ? err.message : err)}\``,
    };
  }
}
