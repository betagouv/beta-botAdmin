function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

// First non-empty value among the given env vars, else the fallback. Unlike a
// plain `??` chain, an env var set to "" (present in .env but blank) is skipped
// rather than treated as a real value.
function firstNonEmpty(names: string[], fallback: string): string {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim().length > 0) return v.trim();
  }
  return fallback;
}

// Bare host names only. A scheme, port or path in the value would refuse
// every stored calendar URL, and the scheduler would flag every inscription as
// broken on its first tick: such entries are dropped, loudly.
function hostList(name: string, fallback: string[]): string[] {
  const raw = optionalList(name).map((h) => h.toLowerCase());
  const ok = raw.filter((h) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h));
  for (const h of raw) {
    if (!ok.includes(h)) {
      console.error(`[config] ${name} : « ${h} » ignoré, ce n'est pas un nom d'hôte nu`);
    }
  }
  return ok.length > 0 ? ok : fallback;
}

function optionalList(name: string): string[] {
  const val = process.env[name];
  if (!val) return [];
  return val
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export const config = {
  dataDir: optional("DATA_DIR", "./data"),
  matrix: {
    homeserver: process.env["MATRIX_HOMESERVER"],
    user: process.env["MATRIX_USER"],
    accessToken: process.env["MATRIX_ACCESS_TOKEN"],
    password: process.env["MATRIX_PASSWORD"],
    allowedRooms: optionalList("MATRIX_ALLOWED_ROOMS"),
    commandRooms: optionalList("MATRIX_COMMAND_ROOMS"),
    // Users allowed to run slash commands via a direct message (DM) with the
    // bot, bypassing the MATRIX_COMMAND_ROOMS restriction. Intended for testing
    // without polluting a shared command room. Comma-separated mxids.
    dmTestUsers: optionalList("MATRIX_DM_TEST_USERS"),
    commandRoomsLabel: process.env["MATRIX_COMMAND_ROOMS_LABEL"],
    commandRoomsUrl: process.env["MATRIX_COMMAND_ROOMS_URL"],
    // Rooms where `/help` returns the OPS-request help (how to make a demande
    // d'OPS) and is open to everyone — even if the room is not in
    // MATRIX_COMMAND_ROOMS. Comma-separated room IDs.
    opsRooms: optionalList("MATRIX_OPS_ROOMS"),
    adminUsers: optionalList("MATRIX_ADMIN_USERS"),
    // Let the bot's own account trigger slash commands (e.g. an automation
    // like n8n posting with the same account — you can't @mention yourself).
    // Only messages starting with "/" are processed, so the bot's own replies
    // can never loop back into the handler.
    allowSelfCommands: process.env["MATRIX_ALLOW_SELF_COMMANDS"] === "true",
    // Accounts whose slash commands are accepted in rooms WITHOUT @mentioning
    // the bot (e.g. an n8n automation account). All other checks still apply
    // (command rooms, admin). Override via MATRIX_NO_MENTION_USERS
    // (comma-separated mxids).
    noMentionUsers:
      optionalList("MATRIX_NO_MENTION_USERS").length > 0
        ? optionalList("MATRIX_NO_MENTION_USERS")
        : ["@betabotadmin-beta.gouv.fr:agent.dinum.tchap.gouv.fr"],
    // Users invited (as moderators) when the bot creates a room for itself —
    // i.e. a self command (e.g. n8n posting with the bot's account): the bot
    // can't invite its own account, so these people get invited instead.
    // Comma-separated mxids (MATRIX_DEFAULT_INVITES). Empty = such a room holds
    // only the bot, and a warning is logged when it happens.
    defaultInvites: optionalList("MATRIX_DEFAULT_INVITES"),
    managedSpace: process.env["MATRIX_MANAGED_SPACE"],
    // Contact shown in the generic reply when someone talks to the bot outside a command.
    contact: process.env["MATRIX_CONTACT"],
  },
  dimail: {
    url: process.env["DIMAIL_URL"],
    user: process.env["DIMAIL_USER"],
    password: process.env["DIMAIL_PASSWORD"],
    domain: process.env["DIMAIL_DOMAIN"],
  },
  grist: {
    // Host root, e.g. https://grist.numerique.gouv.fr. Accepts a value that
    // already includes a trailing "/api" (GRIST_API_URL) — the connector adds
    // "/api" itself, so we strip it here to avoid a doubled path.
    url: firstNonEmpty(
      ["GRIST_API_URL", "GRIST_URL"],
      "https://grist.numerique.gouv.fr",
    )
      .replace(/\/+$/, "")
      .replace(/\/api$/, ""),
    apiKey: process.env["GRIST_API_KEY"],
    // Document holding the reminder tables (Settings → API → ID du Document).
    docId: firstNonEmpty(["GRIST_OPS_DOC_ID", "GRIST_DOC_ID"], "") || undefined,
    // Table IDs (overridable if they differ from the doc §4 names).
    tableInscriptions: firstNonEmpty(
      [
        "GRIST_OPS_TABLE_INSCRIPTIONS",
        "GRIST_OPS_TABLE_ID",
        "GRIST_TABLE_INSCRIPTIONS",
      ],
      "RappelsCalendrier",
    ),
    tableSent: firstNonEmpty(
      ["GRIST_OPS_TABLE_SENT", "GRIST_TABLE_SENT"],
      "RappelsEnvoyes",
    ),
  },
  rappels: {
    // Master switch for the reminder scheduler (docs/rappels-calendrier.md §5.2).
    enabled: process.env["RAPPELS_ENABLED"] !== "false",
    // Safety default: log instead of sending. Flip to "false" to actually DM.
    dryRun: process.env["RAPPELS_DRY_RUN"] !== "false",
    // Scheduler tick interval (minutes).
    intervalMin: Number(optional("RAPPELS_INTERVAL_MIN", "5")),
    // How long before an event to remind (minutes).
    leadMin: Number(optional("RAPPELS_LEAD_MIN", "15")),
    // Width of the detection window (minutes): events starting in
    // [now + lead - window, now + lead] are reminded this tick.
    windowMin: Number(optional("RAPPELS_WINDOW_MIN", "5")),
  },
  inactivite: {
    // Sweep of the rooms the bot created (tools/inactivite.ts): a warning after
    // `jours` without a human message, then the room is closed if nobody
    // writes in the next `delaiJours`.
    enabled: process.env["INACTIVITE_ENABLED"] !== "false",
    // Safety default: log instead of warning or closing. Flip to "false" to act.
    dryRun: process.env["INACTIVITE_DRY_RUN"] !== "false",
    jours: Number(optional("INACTIVITE_JOURS", "60")),
    delaiJours: Number(optional("INACTIVITE_DELAI_JOURS", "14")),
  },
  caldav: {
    // Service account used to reach La Suite (Open-Xchange) CalDAV over Basic
    // auth. The per-user calendar URL is provided at inscription time; these
    // credentials authenticate the request.
    user: process.env["CALDAV_USER"],
    password: process.env["CALDAV_PASSWORD"],
    // Hosts the service credentials may ever be sent to. A calendar URL comes
    // from the user, so anything else is refused before any request goes out.
    allowedHosts: hostList("CALDAV_ALLOWED_HOSTS", ["messagerie.numerique.gouv.fr"]),
    // POC only: a single hardcoded calendar URL to validate the read flow
    // (section 7.1 of docs/rappels-calendrier.md). Remove once inscription
    // stores per-user URLs.
    pocUrl: process.env["CALDAV_POC_URL"],
    // Link shown to the user in the inscription DM, pointing to the La Suite
    // page where they find their CalDAV URL.
    helpUrl: optional(
      "CALDAV_HELP_URL",
      "https://messagerie.numerique.gouv.fr/appsuite/",
    ),
  },
  alerte: {
    // /alerte: people invited into every alert room — the référents
    // techs and SSI of the procedure (comma-separated mxids). Empty = the room
    // holds only whoever raised the alert, and the reply says so.
    referents: optionalList("ALERTE_SECU_REFERENTS"),
    // Room where the alert is announced with @room (~Domaine-secu). The bot
    // must be a member there, at a level allowed to notify @room (usually 50).
    room: process.env["ALERTE_SECU_ROOM"],
  },
  n8n: {
    // Webhook that handles the member-list command (/invite). The bot forwards
    // the parsed command to it; n8n reads the espace-membre database, performs
    // the invitations, and returns the reply the bot posts. Empty → the command
    // is reported as unavailable.
    membresWebhookUrl: process.env["N8N_MEMBRES_WEBHOOK_URL"],
    // Optional shared secret sent as `X-Betabot-Secret` so n8n can reject
    // requests that don't come from the bot.
    secret: process.env["N8N_WEBHOOK_SECRET"],
    // Per-call timeout (ms) before the bot gives up on n8n.
    timeoutMs: Number(optional("N8N_TIMEOUT_MS", "15000")),
  },
} as const;

export function validateMatrixConfig(): void {
  if (!config.matrix.homeserver)
    throw new Error("Missing required environment variable: MATRIX_HOMESERVER");
  if (!config.matrix.user)
    throw new Error("Missing required environment variable: MATRIX_USER");
  if (!config.matrix.accessToken && !config.matrix.password)
    throw new Error(
      "Either MATRIX_ACCESS_TOKEN or MATRIX_PASSWORD must be set"
    );
}
