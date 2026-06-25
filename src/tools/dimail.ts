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

