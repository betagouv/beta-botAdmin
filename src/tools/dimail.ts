import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { config } from "../config.js";

let cachedToken: string | undefined;

// Force a fresh login against /token/ (Basic auth), discarding any cached token.
// Called at the start of every /emails command so each one re-authenticates
// instead of reusing a previous (or env-provided) token.
export async function refreshToken(): Promise<string> {
  return getToken(true);
}

async function getToken(forceRefresh = false): Promise<string> {
  if (cachedToken && !forceRefresh) return cachedToken;
  if (!config.dimail.url || !config.dimail.user || !config.dimail.password) {
    throw new Error(
      "DiMail not configured: DIMAIL_URL / DIMAIL_USER / DIMAIL_PASSWORD missing",
    );
  }
  const basic = Buffer.from(
    `${config.dimail.user}:${config.dimail.password}`,
  ).toString("base64");
  const res = await fetch(`${config.dimail.url}/token/`, {
    headers: { Authorization: `Basic ${basic}` },
  });
  if (!res.ok) {
    throw new Error(`DiMail login failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { access_token: string };
  cachedToken = data.access_token;
  console.log(
    `[dimail] nouveau token obtenu (len=${cachedToken.length}, …${cachedToken.slice(-24)})`,
  );
  return cachedToken;
}

export async function dimailFetch(
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  if (!config.dimail.url) {
    throw new Error("DIMAIL_URL not configured");
  }
  const token = await getToken();
  const doCall = async (tok: string): Promise<Response> =>
    fetch(`${config.dimail.url}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${tok}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  let res = await doCall(token);
  if (res.status === 401) {
    const fresh = await getToken(true);
    res = await doCall(fresh);
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    return { error: true, status: res.status, body };
  }
  return body;
}

function resolveDomain(arg?: string): string {
  const d = arg || config.dimail.domain;
  if (!d) {
    throw new Error(
      "No DiMail domain provided (set DIMAIL_DOMAIN or pass domain arg)",
    );
  }
  return d;
}

interface Alias {
  user_name: string;
  domain_name: string;
  destination: string;
}

async function list_mailing_lists(domain?: string): Promise<unknown> {
  const d = resolveDomain(domain);
  const all = (await dimailFetch(
    `/domains/${encodeURIComponent(d)}/aliases/`,
  )) as Alias[] | { error: true };
  if ("error" in (all as object)) return all;
  const counts = new Map<string, number>();
  for (const a of all as Alias[]) {
    counts.set(a.user_name, (counts.get(a.user_name) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([name, member_count]) => ({
    name,
    address: `${name}@${d}`,
    member_count,
  }));
}

async function get_mailing_list(
  list_name: string,
  domain?: string,
): Promise<unknown> {
  const d = resolveDomain(domain);
  return dimailFetch(
    `/domains/${encodeURIComponent(d)}/aliases/?user_name=${encodeURIComponent(list_name)}`,
  );
}

async function add_to_mailing_list(
  list_name: string,
  email: string,
  domain?: string,
): Promise<unknown> {
  const d = resolveDomain(domain);
  return dimailFetch(`/domains/${encodeURIComponent(d)}/aliases/`, {
    method: "POST",
    body: JSON.stringify({ user_name: list_name, destination: email }),
  });
}

async function remove_from_mailing_list(
  list_name: string,
  email: string,
  domain?: string,
): Promise<unknown> {
  const d = resolveDomain(domain);
  return dimailFetch(
    `/domains/${encodeURIComponent(d)}/aliases/${encodeURIComponent(list_name)}/${encodeURIComponent(email)}`,
    { method: "DELETE" },
  );
}

export const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "list_mailing_lists",
      description:
        "Liste les mailing lists (alias) existantes sur le domaine DiMail configuré.",
      parameters: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            description:
              "Nom du domaine. Optionnel, défaut: domaine configuré dans .env",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_mailing_list",
      description:
        "Retourne les destinataires (membres) d'une mailing list DiMail.",
      parameters: {
        type: "object",
        properties: {
          list_name: {
            type: "string",
            description:
              "Nom de la liste, ex: 'equipe' pour la liste equipe@domain",
          },
          domain: {
            type: "string",
            description: "Optionnel. Défaut: domaine configuré.",
          },
        },
        required: ["list_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_to_mailing_list",
      description:
        "Ajoute une adresse email comme destinataire d'une mailing list DiMail. Si la liste n'existe pas, elle est créée implicitement.",
      parameters: {
        type: "object",
        properties: {
          list_name: {
            type: "string",
            description: "Nom de la liste",
          },
          email: {
            type: "string",
            description: "Adresse email à ajouter comme destinataire",
          },
          domain: {
            type: "string",
            description: "Optionnel. Défaut: domaine configuré.",
          },
        },
        required: ["list_name", "email"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_from_mailing_list",
      description:
        "Retire une adresse email d'une mailing list DiMail.",
      parameters: {
        type: "object",
        properties: {
          list_name: {
            type: "string",
            description: "Nom de la liste",
          },
          email: {
            type: "string",
            description: "Adresse email à retirer",
          },
          domain: {
            type: "string",
            description: "Optionnel. Défaut: domaine configuré.",
          },
        },
        required: ["list_name", "email"],
      },
    },
  },
];

export const handlers: Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
> = {
  list_mailing_lists: (args) => list_mailing_lists(args["domain"] as string),
  get_mailing_list: (args) =>
    get_mailing_list(args["list_name"] as string, args["domain"] as string),
  add_to_mailing_list: (args) =>
    add_to_mailing_list(
      args["list_name"] as string,
      args["email"] as string,
      args["domain"] as string,
    ),
  remove_from_mailing_list: (args) =>
    remove_from_mailing_list(
      args["list_name"] as string,
      args["email"] as string,
      args["domain"] as string,
    ),
};

export const toolNames = tools.map((t) => t.function.name);
