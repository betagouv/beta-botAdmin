import { config } from "../config.js";

// Thin bridge to the n8n workflow that owns the member-list command (/invite).
// The bot parses nothing business-specific: it forwards the command + context,
// and posts back whatever n8n returns. This keeps the list logic editable by
// non-devs in the n8n UI.

export interface N8nCommandPayload {
  // The command verb, e.g. "/invite".
  command: string;
  // Full command text as typed (mention already stripped), e.g.
  // "/invite cartobio --salon MonSalon --domaine dev".
  text: string;
  sender: string;
  roomId: string;
  isDM: boolean;
  // The managed space id (context for n8n).
  managedSpace?: string;
  // /invite only: the bot pre-parses and resolves the target, so n8n just
  // reads the startup's members and invites them into `targetRoomId`.
  startup?: string;
  // Optional domaine filter within the startup (matches the `domaine` column).
  // Absent = every member.
  domaine?: string;
  // `--moderateur`: n8n must also raise each invited member to power 50.
  // The bot has already checked the requester is entitled to grant it.
  moderateur?: boolean;
  targetRoomId?: string;
  // Human-readable target ("le salon **X**") for n8n's reply.
  targetLabel?: string;
  // Matrix homeserver base URL, so n8n can call the invite endpoint.
  homeserver?: string;
}

// What n8n is expected to return. `reaction` is optional (defaults to a neutral
// ack). Anything else is tolerated and ignored.
export interface N8nCommandReply {
  message: string;
  reaction: string;
}

// Forward a command to the n8n webhook and return its reply. Never throws:
// configuration, network, timeout and bad-response errors are turned into a
// user-facing reply so the caller can just post it.
export async function forwardMembresCommand(
  payload: N8nCommandPayload,
): Promise<N8nCommandReply> {
  const url = config.n8n.membresWebhookUrl;
  if (!url) {
    return {
      reaction: "⛔",
      message:
        "⛔ Commande indisponible : le webhook n8n n'est pas configuré (`N8N_MEMBRES_WEBHOOK_URL`).",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.n8n.timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.n8n.secret
          ? { "X-Betabot-Secret": config.n8n.secret }
          : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        reaction: "❌",
        message: `❌ Le service (n8n) a répondu HTTP ${res.status}. Réessaie ou préviens un admin.`,
      };
    }
    return parseReply(text);
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    return {
      reaction: "⏱️",
      message: aborted
        ? "⏱️ Le service (n8n) n'a pas répondu à temps. Réessaie."
        : `❌ Erreur de contact du service (n8n) : ${String(err instanceof Error ? err.message : err).slice(0, 200)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Parse the webhook body into a reply. Accepts a JSON object with `message`
// (and optional `reaction`), or falls back to treating the raw body as the
// message text.
function parseReply(text: string): N8nCommandReply {
  const trimmed = text.trim();
  if (!trimmed) {
    return { reaction: "✅", message: "✅ Fait." };
  }
  try {
    const obj = JSON.parse(trimmed) as {
      message?: unknown;
      reaction?: unknown;
    };
    if (obj && typeof obj === "object" && "message" in obj) {
      return {
        message: String(obj.message ?? ""),
        reaction:
          typeof obj.reaction === "string" && obj.reaction ? obj.reaction : "✅",
      };
    }
  } catch {
    // not JSON — treat the whole body as the message
  }
  return { reaction: "✅", message: trimmed };
}
