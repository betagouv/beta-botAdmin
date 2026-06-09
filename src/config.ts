function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function optionalInt(name: string, fallback: number): number {
  const val = process.env[name];
  return val ? parseInt(val, 10) : fallback;
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
  openai: {
    baseUrl: optional("OPENAI_BASE_URL", "http://localhost:11434/v1"),
    apiKey: optional("OPENAI_API_KEY", "ollama"),
    model: optional("OPENAI_MODEL", "qwen2.5:14b"),
    embedModel: optional("OPENAI_EMBED_MODEL", "nomic-embed-text"),
    embedDims: optionalInt("EMBED_DIMS", 768),
  },
  dataDir: optional("DATA_DIR", "./data"),
  matrix: {
    homeserver: process.env["MATRIX_HOMESERVER"],
    user: process.env["MATRIX_USER"],
    accessToken: process.env["MATRIX_ACCESS_TOKEN"],
    password: process.env["MATRIX_PASSWORD"],
    deviceId: process.env["MATRIX_DEVICE_ID"],
    allowedRooms: optionalList("MATRIX_ALLOWED_ROOMS"),
    commandRooms: optionalList("MATRIX_COMMAND_ROOMS"),
    commandRoomsLabel: process.env["MATRIX_COMMAND_ROOMS_LABEL"],
    dimailRooms: optionalList("MATRIX_DIMAIL_ROOMS"),
    adminUsers: optionalList("MATRIX_ADMIN_USERS"),
    // Email domains allowed to run /emails. Tchap encodes the email in the mxid
    // localpart (`@prenom.nom-beta.gouv.fr:server`), so the gate matches the
    // `-<domain>` suffix. Override via MATRIX_EMAILS_ALLOWED_DOMAINS (comma-sep).
    emailsAllowedDomains:
      optionalList("MATRIX_EMAILS_ALLOWED_DOMAINS").length > 0
        ? optionalList("MATRIX_EMAILS_ALLOWED_DOMAINS")
        : ["beta.gouv.fr", "numerique.gouv.fr", "modernisation.gouv.fr"],
    managedSpace: process.env["MATRIX_MANAGED_SPACE"],
    // Contact shown in the generic reply when someone talks to the bot outside a command.
    contact: process.env["MATRIX_CONTACT"],
  },
  dimail: {
    url: process.env["DIMAIL_URL"],
    user: process.env["DIMAIL_USER"],
    password: process.env["DIMAIL_PASSWORD"],
    token: process.env["DIMAIL_TOKEN"],
    domain: process.env["DIMAIL_DOMAIN"],
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
