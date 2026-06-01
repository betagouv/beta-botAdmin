import { createRequire } from "module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import nodeCrypto from "node:crypto";
import {
  MatrixClient,
  SimpleFsStorageProvider,
  RustSdkCryptoStorageProvider,
} from "matrix-bot-sdk";
import { marked } from "marked";
import { config } from "../config.js";
import { handleEmailsCommand } from "../commands/emails.js";
import { handleRoomsCommand } from "../commands/rooms.js";
import { record, query, formatHistory } from "../commands/history.js";
import { buildCommandOnlyNotice } from "../commands/notice.js";
import { buildHelp } from "../tools/help.js";

// Publicly advertised commands (shown in /help, the generic notice and the
// "unknown command" hint). `/historique` is admin-only and intentionally left
// out — it still works (handled explicitly below) but isn't advertised.
const KNOWN_COMMANDS = ["/help", "/emails", "/salon"] as const;

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array(b.length + 1).fill(0),
  );
  for (let i = 0; i <= a.length; i++) dp[i]![0] = i;
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }
  return dp[a.length]![b.length]!;
}

function suggestCommand(input: string): string | null {
  let best: { cmd: string; dist: number } | null = null;
  for (const cmd of KNOWN_COMMANDS) {
    const d = levenshtein(input.toLowerCase(), cmd);
    if (best === null || d < best.dist) best = { cmd, dist: d };
  }
  return best && best.dist <= 2 ? best.cmd : null;
}

const _require = createRequire(import.meta.url);

interface SavedCredentials {
  accessToken: string;
  deviceId: string;
  userId: string;
}

function loadCredentials(dataDir: string): SavedCredentials | null {
  const path = `${dataDir}/credentials.json`;
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SavedCredentials;
  } catch {
    return null;
  }
}

function saveCredentials(dataDir: string, creds: SavedCredentials): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(`${dataDir}/credentials.json`, JSON.stringify(creds, null, 2));
}

// ─── Crypto utilities (ported from example-verify.js) ────────────────────────

function generateX25519KeyPair() {
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync("x25519");
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const pubBytes = spki.slice(-32);
  const pubB64 = pubBytes.toString("base64");
  const pubB64NoPad = pubB64.replace(/=+$/, "");
  return { privateKey, pubBytes, pubB64, pubB64NoPad };
}

function computeX25519(
  ourPrivKey: nodeCrypto.KeyObject,
  theirPubBytes: Buffer,
): Buffer {
  const header = Buffer.from("302a300506032b656e032100", "hex");
  const theirSpki = Buffer.concat([header, theirPubBytes]);
  const theirPubKey = nodeCrypto.createPublicKey({
    key: theirSpki,
    format: "der",
    type: "spki",
  });
  return nodeCrypto.diffieHellman({
    privateKey: ourPrivKey,
    publicKey: theirPubKey,
  });
}

function canonicalJson(obj: unknown): string {
  if (typeof obj !== "object" || obj === null) return JSON.stringify(obj);
  if (Array.isArray(obj))
    return "[" + (obj as unknown[]).map(canonicalJson).join(",") + "]";
  return (
    "{" +
    Object.keys(obj as object)
      .sort()
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          canonicalJson((obj as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
}

function hkdfSha256(
  ikm: Buffer,
  salt: Buffer,
  info: string,
  length: number,
): Buffer {
  const prk = nodeCrypto.createHmac("sha256", salt).update(ikm).digest();
  const infoBuffer = Buffer.from(info, "utf8");
  const chunks: Buffer[] = [];
  let prev = Buffer.alloc(0);
  let i = 1;
  while (Buffer.concat(chunks).length < length) {
    const h = nodeCrypto.createHmac("sha256", prk);
    h.update(prev);
    h.update(infoBuffer);
    h.update(Buffer.from([i++]));
    prev = h.digest();
    chunks.push(prev);
  }
  return Buffer.concat(chunks).slice(0, length);
}

const SAS_EMOJI = [
  "🐶 Dog",
  "🐱 Cat",
  "🦁 Lion",
  "🐎 Horse",
  "🦄 Unicorn",
  "🐷 Pig",
  "🐘 Elephant",
  "🐰 Rabbit",
  "🐼 Panda",
  "🐓 Rooster",
  "🐧 Penguin",
  "🐢 Turtle",
  "🐟 Fish",
  "🐙 Octopus",
  "🦋 Butterfly",
  "🌷 Flower",
  "🌳 Tree",
  "🌵 Cactus",
  "🍄 Mushroom",
  "🌏 Globe",
  "🌙 Moon",
  "☁️ Cloud",
  "🔥 Fire",
  "🍌 Banana",
  "🍎 Apple",
  "🍓 Strawberry",
  "🌽 Corn",
  "🍕 Pizza",
  "🎂 Cake",
  "❤️ Heart",
  "😀 Smiley",
  "🤖 Robot",
  "🎩 Hat",
  "👓 Glasses",
  "🔧 Wrench",
  "🎅 Santa",
  "👍 Thumbs Up",
  "☂️ Umbrella",
  "⌛ Hourglass",
  "⏰ Clock",
  "🎁 Gift",
  "💡 Light Bulb",
  "📕 Book",
  "✏️ Pencil",
  "📎 Paperclip",
  "✂️ Scissors",
  "🔒 Lock",
  "🔑 Key",
  "🔨 Hammer",
  "📞 Telephone",
  "🏁 Flag",
  "🚂 Train",
  "🚲 Bicycle",
  "✈️ Airplane",
  "🚀 Rocket",
  "🏆 Trophy",
  "⚽ Ball",
  "🎸 Guitar",
  "🎺 Trumpet",
  "🔔 Bell",
  "⚓ Anchor",
  "🎧 Headphones",
  "📁 Folder",
  "📌 Pin",
];

function decodeSasEmoji(sasBytes: Buffer): string[] {
  const n =
    (BigInt(sasBytes[0]) << 34n) |
    (BigInt(sasBytes[1]) << 26n) |
    (BigInt(sasBytes[2]) << 18n) |
    (BigInt(sasBytes[3]) << 10n) |
    (BigInt(sasBytes[4]) << 2n) |
    (BigInt(sasBytes[5]) >> 6n);
  const emojis: string[] = [];
  for (let i = 5; i >= 0; i--) {
    emojis.unshift(SAS_EMOJI[Number((n >> BigInt(i * 6)) & 63n)]);
  }
  return emojis;
}

// ─── Verification state ───────────────────────────────────────────────────────

interface VerifState {
  sender: string;
  fromDevice: string;
  ourKeys?: ReturnType<typeof generateX25519KeyPair>;
  sharedSecret?: Buffer;
}

// ─── MatrixConnector ──────────────────────────────────────────────────────────

export class MatrixConnector {
  private client!: MatrixClient;
  private ownUserId = "";
  private ownDeviceId = "";
  private ownDisplayName = "";
  private resolvedToken = "";
  private activeBotThreads = new Set<string>();
  private dmRooms = new Set<string>();
  private pendingVerif = new Map<string, VerifState>();
  private startupTs = Date.now();

  constructor() {}

  async start(): Promise<void> {
    // Set global.Olm before creating the client (needed for matrix-bot-sdk compat layer)
    try {
      (globalThis as unknown as { Olm: unknown }).Olm =
        _require("@matrix-org/olm");
    } catch {}

    const { homeserver, user, accessToken, password } = config.matrix;
    let token = accessToken;

    if (!token) {
      const saved = loadCredentials(config.dataDir);
      if (saved) {
        token = saved.accessToken;
        console.log(
          `[Matrix] Loaded saved credentials (device=${saved.deviceId})`,
        );
      } else if (password) {
        const res = await fetch(`${homeserver}/_matrix/client/v3/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "m.login.password",
            user: user!,
            password: password!,
          }),
        });
        if (!res.ok)
          throw new Error(`[Matrix] Login failed: ${await res.text()}`);
        const data = (await res.json()) as {
          access_token: string;
          device_id: string;
          user_id: string;
        };
        token = data.access_token;
        saveCredentials(config.dataDir, {
          accessToken: token,
          deviceId: data.device_id,
          userId: data.user_id,
        });
        console.log(
          `[Matrix] New device registered (device=${data.device_id})`,
        );
      } else {
        throw new Error("[Matrix] No access token or password configured");
      }
    }

    this.resolvedToken = token;
    mkdirSync(config.dataDir, { recursive: true });

    const storageProvider = new SimpleFsStorageProvider(
      `${config.dataDir}/bot-session.json`,
    );
    // 0 = StoreType.Sqlite, the only available store type in matrix-sdk-crypto-nodejs
    const cryptoProvider = new RustSdkCryptoStorageProvider(
      `${config.dataDir}/crypto`,
      0 as unknown as never,
    );

    this.client = new MatrixClient(
      homeserver!,
      token,
      storageProvider,
      cryptoProvider,
    );

    this.setupVerification();
    this.setupMessageHandlers();

    console.log("[Matrix] Starting client sync…");
    await this.client.start();

    const whoami = await this.client.getWhoAmI();
    this.ownUserId = whoami.user_id;
    this.ownDeviceId = whoami.device_id ?? "";
    try {
      const profile = (await this.client.getUserProfile(this.ownUserId)) as {
        displayname?: string;
      };
      this.ownDisplayName = profile.displayname ?? "";
    } catch {
      this.ownDisplayName = "";
    }
    console.log(
      `[Matrix] Connected as ${this.ownUserId} / ${this.ownDeviceId} / displayName="${this.ownDisplayName}"`,
    );

    await this.loadDirectRooms();

    process.on("SIGINT", () => {
      this.client.stop();
      process.exit(0);
    });
  }

  // Intercept verification to-device events before the Rust engine processes them
  private setupVerification(): void {
    type SyncData = {
      to_device?: { events?: Array<Record<string, unknown>> };
      rooms?: Record<string, unknown>;
      device_lists?: Record<string, unknown>;
      device_one_time_keys_count?: Record<string, unknown>;
    };
    type PatchedClient = MatrixClient & {
      processSync?: (data: SyncData) => Promise<void>;
    };

    const pc = this.client as PatchedClient;
    const originalProcessSync = pc.processSync?.bind(this.client);
    if (!originalProcessSync) return;

    pc.processSync = async (syncData: SyncData) => {
      const allToDevice = syncData?.to_device?.events ?? [];
      const verifEvents = allToDevice.filter((e) =>
        (e.type as string)?.includes("verification"),
      );
      const nonVerifEvents = allToDevice.filter(
        (e) => !(e.type as string)?.includes("verification"),
      );

      for (const evt of verifEvents) {
        const txnPrefix = String(
          (evt.content as Record<string, unknown>)?.transaction_id ?? "",
        ).slice(0, 8);
        console.log(`← ${evt.type as string} [${txnPrefix}]`);
        try {
          await this.handleVerifEvent(evt);
        } catch (e) {
          console.error("[Matrix] Verif error:", (e as Error).message);
        }
      }

      const patched = JSON.parse(JSON.stringify(syncData)) as SyncData;
      patched.to_device = { events: nonVerifEvents };
      patched.rooms = patched.rooms ?? {};
      (patched.rooms as Record<string, unknown>).join =
        (patched.rooms as Record<string, unknown>).join ?? {};
      (patched.rooms as Record<string, unknown>).invite =
        (patched.rooms as Record<string, unknown>).invite ?? {};
      (patched.rooms as Record<string, unknown>).leave =
        (patched.rooms as Record<string, unknown>).leave ?? {};
      patched.device_lists = patched.device_lists ?? {};
      patched.device_one_time_keys_count =
        patched.device_one_time_keys_count ?? {};

      try {
        return await originalProcessSync(patched);
      } catch {
        return originalProcessSync(syncData);
      }
    };

    console.log("[Matrix] Device verification handler registered");
  }

  private async handleVerifEvent(evt: Record<string, unknown>): Promise<void> {
    const content = evt.content as Record<string, unknown>;
    const txId = content?.transaction_id as string;
    const sender = evt.sender as string;
    const fromDevice =
      this.pendingVerif.get(txId)?.fromDevice ??
      (content?.from_device as string | undefined) ??
      ((evt?.unsigned as Record<string, unknown>)?.device_id as
        | string
        | undefined) ??
      "";
    const whoami = await this.client.getWhoAmI();

    switch (evt.type as string) {
      case "m.key.verification.request": {
        if (!(content?.methods as string[] | undefined)?.includes("m.sas.v1"))
          return;
        this.pendingVerif.set(txId, { sender, fromDevice });
        await this.sendToDevice(
          "m.key.verification.ready",
          sender,
          fromDevice,
          {
            from_device: whoami.device_id,
            methods: ["m.sas.v1"],
            transaction_id: txId,
          },
        );
        break;
      }

      case "m.key.verification.start": {
        if (content?.method !== "m.sas.v1") return;
        const state = this.pendingVerif.get(txId) ?? { sender, fromDevice };
        const ourKeys = generateX25519KeyPair();
        const commitment = nodeCrypto
          .createHash("sha256")
          .update(ourKeys.pubB64NoPad + canonicalJson(content), "utf8")
          .digest("base64");
        state.ourKeys = ourKeys;
        this.pendingVerif.set(txId, state);
        await this.sendToDevice(
          "m.key.verification.accept",
          sender,
          fromDevice,
          {
            transaction_id: txId,
            method: "m.sas.v1",
            key_agreement_protocol: "curve25519-hkdf-sha256",
            hash: "sha256",
            message_authentication_code: "hkdf-hmac-sha256.v2",
            short_authentication_string: ["decimal", "emoji"],
            commitment,
          },
        );
        break;
      }

      case "m.key.verification.key": {
        const state = this.pendingVerif.get(txId);
        if (!state?.ourKeys) return;
        const theirPubB64 = content.key as string;
        const theirPubBytes = Buffer.from(theirPubB64, "base64");
        const theirPubNoPad = theirPubB64.replace(/=+$/, "");
        const sharedSecret = computeX25519(
          state.ourKeys.privateKey,
          theirPubBytes,
        );
        const sasInfo =
          "MATRIX_KEY_VERIFICATION_SAS" +
          `|${sender}|${fromDevice}|${theirPubNoPad}` +
          `|${whoami.user_id}|${whoami.device_id}|${state.ourKeys.pubB64NoPad}` +
          `|${txId}`;
        const sasBytes = hkdfSha256(sharedSecret, Buffer.alloc(32), sasInfo, 7);
        state.sharedSecret = sharedSecret;
        this.pendingVerif.set(txId, state);
        await this.sendToDevice("m.key.verification.key", sender, fromDevice, {
          transaction_id: txId,
          key: state.ourKeys.pubB64NoPad,
        });
        console.log("\n====== EMOJIS SAS ======");
        decodeSasEmoji(sasBytes).forEach((e) => console.log(`  ${e}`));
        console.log("========================");
        console.log(
          '\n👉 Confirme "Ils correspondent" dans Element pour continuer\n',
        );
        break;
      }

      case "m.key.verification.mac": {
        const state = this.pendingVerif.get(txId);
        if (!state?.sharedSecret) return;

        type KeysQueryResp = {
          device_keys?: {
            [userId: string]: {
              [deviceId: string]: { keys?: { [keyId: string]: string } };
            };
          };
        };

        const ownUserId = whoami.user_id as string;
        const ownDeviceId = (whoami.device_id ?? "") as string;

        // Verify their MAC
        const theirDeviceKeyId = `ed25519:${fromDevice}`;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const theirKeysResp = (await (this.client.doRequest as any)(
          "POST",
          "/_matrix/client/v3/keys/query",
          null,
          { device_keys: { [sender]: [fromDevice] } },
        )) as KeysQueryResp;
        const theirEd25519 =
          theirKeysResp?.device_keys?.[sender]?.[fromDevice]?.keys?.[
            theirDeviceKeyId
          ] ?? "";
        const theirEd25519NoPad = theirEd25519.replace(/=+$/, "");
        const theirBaseInfo = `${sender}|${fromDevice}|${ownUserId}|${ownDeviceId}|${txId}`;
        const verifyKey = hkdfSha256(
          state.sharedSecret,
          Buffer.alloc(32),
          `MATRIX_KEY_VERIFICATION_MAC|${theirBaseInfo}|${theirDeviceKeyId}`,
          32,
        );
        const mac = content.mac as Record<string, string>;
        const expectedMac = nodeCrypto
          .createHmac("sha256", verifyKey)
          .update(theirEd25519NoPad, "utf8")
          .digest("base64")
          .replace(/=+$/, "");
        console.log("✅ MAC match:", mac?.[theirDeviceKeyId] === expectedMac);

        // Send our MAC
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ourKeysResp = (await (this.client.doRequest as any)(
          "POST",
          "/_matrix/client/v3/keys/query",
          null,
          { device_keys: { [ownUserId]: [ownDeviceId] } },
        )) as KeysQueryResp;
        const keyId = `ed25519:${ownDeviceId}`;
        const ed25519key =
          ourKeysResp?.device_keys?.[ownUserId]?.[ownDeviceId]?.keys?.[keyId] ??
          "";
        const ed25519NoPad = ed25519key.replace(/=+$/, "");
        const baseInfo = `${ownUserId}|${ownDeviceId}|${sender}|${fromDevice}|${txId}`;
        const macKey = hkdfSha256(
          state.sharedSecret,
          Buffer.alloc(32),
          `MATRIX_KEY_VERIFICATION_MAC|${baseInfo}|${keyId}`,
          32,
        );
        const keyMac = nodeCrypto
          .createHmac("sha256", macKey)
          .update(ed25519NoPad, "utf8")
          .digest("base64")
          .replace(/=+$/, "");
        const keysKey = hkdfSha256(
          state.sharedSecret,
          Buffer.alloc(32),
          `MATRIX_KEY_VERIFICATION_MAC|${baseInfo}|KEY_IDS`,
          32,
        );
        const keysMac = nodeCrypto
          .createHmac("sha256", keysKey)
          .update(keyId, "utf8")
          .digest("base64")
          .replace(/=+$/, "");

        await this.sendToDevice("m.key.verification.mac", sender, fromDevice, {
          transaction_id: txId,
          mac: { [keyId]: keyMac },
          keys: keysMac,
        });
        await this.sendToDevice("m.key.verification.done", sender, fromDevice, {
          transaction_id: txId,
        });
        console.log("\n🎉 Vérification envoyée !");
        this.pendingVerif.delete(txId);
        break;
      }

      case "m.key.verification.cancel": {
        console.warn(`❌ Annulé : ${content?.reason} (${content?.code})`);
        this.pendingVerif.delete(txId);
        break;
      }
    }
  }

  private async sendToDevice(
    type: string,
    sender: string,
    deviceId: string,
    content: Record<string, unknown>,
  ): Promise<void> {
    const txnId = `${Date.now()}${Math.random().toString(36).slice(2)}`;
    const url = `${config.matrix.homeserver}/_matrix/client/v3/sendToDevice/${encodeURIComponent(type)}/${txnId}`;
    const resp = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.resolvedToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messages: { [sender]: { [deviceId]: content } } }),
    });
    if (!resp.ok) {
      const json = (await resp.json().catch(() => ({}))) as unknown;
      console.error(`❌ ${type} error:`, JSON.stringify(json));
    } else {
      console.log(`→ ${type}`);
    }
  }

  private setupMessageHandlers(): void {
    this.client.on(
      "room.invite",
      async (roomId: string, inviteEvent: Record<string, unknown>) => {
        const isDirect =
          (inviteEvent as { content?: { is_direct?: boolean } }).content
            ?.is_direct === true;
        if (isDirect) this.dmRooms.add(roomId);
        console.log(
          `[Matrix] Invited to ${roomId} isDirect=${isDirect}, joining…`,
        );
        try {
          await this.client.joinRoom(roomId);
          console.log(`[Matrix] Joined ${roomId}`);
        } catch (err) {
          console.error(`[Matrix] Failed to join ${roomId}:`, err);
        }
      },
    );

    this.client.on(
      "room.message",
      (roomId: string, event: Record<string, unknown>) => {
        void this.handleIncomingMessage(roomId, event);
      },
    );

    this.client.on(
      "room.failed_decryption",
      (roomId: string, event: Record<string, unknown>, error: Error) => {
        console.log(`[Matrix] Decryption failure in ${roomId}:`, error.message);
        const sender = event.sender as string;
        if (sender === this.ownUserId) return;
        const relates = (
          event.content as Record<string, unknown> | undefined
        )?.["m.relates_to"] as
          | { rel_type?: string; event_id?: string }
          | undefined;
        const threadRoot =
          relates?.rel_type === "m.thread"
            ? (relates.event_id ?? (event.event_id as string))
            : (event.event_id as string);
        void this.isDMRoom(roomId).then((isDM) => {
          const isActiveBotThread = this.activeBotThreads.has(threadRoot ?? "");
          if (isDM || isActiveBotThread) {
            void this.sendMessage(
              roomId,
              "_(Désolé, je n'ai pas pu déchiffrer votre message 🫣)_",
              event.event_id as string,
              isDM ? undefined : (threadRoot ?? undefined),
            );
          }
        });
      },
    );
  }

  private async handleIncomingMessage(
    roomId: string,
    event: Record<string, unknown>,
  ): Promise<void> {
    const sender = event.sender as string;
    if (sender === this.ownUserId) return;

    const eventTs = event.origin_server_ts as number | undefined;
    if (eventTs !== undefined && eventTs < this.startupTs) return;

    if (
      config.matrix.allowedRooms.length > 0 &&
      !config.matrix.allowedRooms.includes(roomId)
    ) {
      console.log(
        `[Matrix] Ignoring message in ${roomId} (not in MATRIX_ALLOWED_ROOMS)`,
      );
      return;
    }

    const content = event.content as {
      msgtype?: string;
      body?: string;
      formatted_body?: string;
      ["m.mentions"]?: { user_ids?: string[] };
    };
    if (content?.msgtype !== "m.text") return;

    const body = content.body ?? "";
    const formattedBody = content.formatted_body ?? "";
    const isDM = await this.isDMRoom(roomId);
    const localPart = this.ownUserId
      ? (this.ownUserId.replace(/@/, "").split(":")[0] ?? "")
      : "";
    // A genuine mention = a real "pill": the bot's user ID appears either in the
    // HTML formatted_body (matrix.to link) or in the m.mentions.user_ids list.
    // We deliberately do NOT match the plain-text display name, otherwise typing
    // the bot's name by hand (no pill) would trigger commands — the plain `body`
    // of a real pill is identical to hand-typed text, so it can't be trusted.
    const mentionUserIds = content["m.mentions"]?.user_ids ?? [];
    const isMentioned = this.ownUserId
      ? formattedBody.includes(this.ownUserId) ||
        mentionUserIds.includes(this.ownUserId)
      : false;

    const relates = (event.content as Record<string, unknown>)?.[
      "m.relates_to"
    ] as { rel_type?: string; event_id?: string } | undefined;
    const threadRoot =
      relates?.rel_type === "m.thread"
        ? (relates.event_id ?? (event.event_id as string))
        : (event.event_id as string);

    // Tchap may strip the "* " prefix (which marks an edited message) before our check.
    const trimmedBody = body.trim().replace(/^\*\s+/, "");
    const stripLeadingMention = (s: string): { text: string; matched: boolean } => {
      const lower = s.toLowerCase();
      const patterns = [
        this.ownUserId,
        localPart,
        this.ownDisplayName,
      ].filter((p): p is string => !!p);
      for (const pat of patterns) {
        if (lower.startsWith(pat.toLowerCase())) {
          return {
            text: s.slice(pat.length).replace(/^[\s,:;]+/, ""),
            matched: true,
          };
        }
      }
      return { text: s, matched: false };
    };
    const { text: afterMention, matched: mentionAtStart } = stripLeadingMention(trimmedBody);

    // Slash command rule:
    // - In DM: any leading "/" counts.
    // - In a room: must be a REAL @mention of the bot (pill), and "/" must be the
    //   first char right after the stripped mention text.
    const isSlashCommand = isDM
      ? trimmedBody.startsWith("/")
      : isMentioned && mentionAtStart && afterMention.startsWith("/");

    console.log(
      `[Matrix] Message from ${sender} in ${roomId} isDM=${isDM} isMentioned=${isMentioned} mentionAtStart=${mentionAtStart} isSlashCommand=${isSlashCommand} body=${JSON.stringify(body.slice(0, 100))}`,
    );

    if (!isDM && !isMentioned && !isSlashCommand) return;

    // For slash dispatch and LLM, prefer the cleanly-stripped "afterMention" when mention is at start.
    // Otherwise fall back to stripping all occurrences of the mention from the body.
    let text: string;
    if (mentionAtStart) {
      text = afterMention;
    } else {
      text = body.replace(
        new RegExp(this.ownUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
        "",
      );
      text = text.trim();
    }

    const userEventId = event.event_id as string;

    if (isSlashCommand) {
      const commandRooms = config.matrix.commandRooms;
      if (commandRooms.length > 0 && !commandRooms.includes(roomId)) {
        await this.sendReaction(roomId, userEventId, "⛔");
        const cmd = text.split(/\s+/)[0] || "/?";
        const where = config.matrix.commandRoomsLabel
          ? `\`${config.matrix.commandRoomsLabel}\``
          : commandRooms.map((r) => `\`${r}\``).join(", ");
        await this.sendMessage(
          roomId,
          `⛔ La commande \`${cmd}\` n'est pas autorisée dans ce salon.\n\nElle est disponible dans : ${where}`,
          userEventId,
          threadRoot,
        );
        record({ user: sender, room: roomId, kind: "slash", text, status: "refused", detail: "room not in MATRIX_COMMAND_ROOMS" });
        return;
      }

      if (
        text === "/help" ||
        text === "/aide" ||
        text.startsWith("/help ") ||
        text.startsWith("/aide ")
      ) {
        await this.sendReaction(roomId, userEventId, "📖");
        await this.sendMessage(roomId, buildHelp(), userEventId, threadRoot);
        record({ user: sender, room: roomId, kind: "slash", text, status: "ok" });
        return;
      }

      if (text === "/emails" || text.startsWith("/emails ") || text.startsWith("/emails\n")) {
        const result = await handleEmailsCommand(text);
        await this.sendReaction(roomId, userEventId, result.reaction);
        await this.sendMessage(roomId, result.message, userEventId, threadRoot);
        const status: "ok" | "error" =
          result.reaction === "✅" || result.reaction === "📋" || result.reaction === "📖" || result.reaction === "📭"
            ? "ok"
            : "error";
        record({ user: sender, room: roomId, kind: "slash", text, status, detail: result.reaction });
        return;
      }

      if (text === "/historique" || text.startsWith("/historique ")) {
        const isAdmin = config.matrix.adminUsers.includes(sender);
        if (!isAdmin) {
          await this.sendReaction(roomId, userEventId, "⛔");
          await this.sendMessage(
            roomId,
            `⛔ La commande \`/historique\` est réservée aux administrateurs.`,
            userEventId,
            threadRoot,
          );
          record({ user: sender, room: roomId, kind: "slash", text, status: "refused", detail: "not in MATRIX_ADMIN_USERS" });
          return;
        }
        const arg = text.replace(/^\/historique\s*/, "").trim();
        const entries = query(arg || undefined, 20);
        const msg = formatHistory(entries, arg || undefined);
        await this.sendReaction(roomId, userEventId, "📬");

        try {
          const dmRoomId = await this.client.dms.getOrCreateDm(sender);
          this.dmRooms.add(dmRoomId);
          await this.sendMessage(dmRoomId, msg);
          if (dmRoomId !== roomId) {
            await this.sendMessage(
              roomId,
              `📬 Historique envoyé en MP.`,
              userEventId,
              threadRoot,
            );
          }
          record({ user: sender, room: roomId, kind: "slash", text, status: "ok", detail: arg ? `filter=${arg} dm=ok` : "dm=ok" });
        } catch (err) {
          console.error("[Matrix] Failed to send /historique via DM:", err);
          await this.sendMessage(
            roomId,
            `⚠️ Impossible d'ouvrir un MP pour t'envoyer l'historique. Voici la réponse dans le salon :\n\n${msg}`,
            userEventId,
            threadRoot,
          );
          record({ user: sender, room: roomId, kind: "slash", text, status: "ok", detail: "dm=failed fallback=inline" });
        }
        return;
      }

      if (text === "/salon" || text.startsWith("/salon ")) {
        // Open to everyone: `create`/`list` need no role; `delete` checks that
        // the requester is moderator+ in the target room (see commands/rooms.ts).
        const result = await handleRoomsCommand(
          this.client,
          config.matrix.managedSpace,
          this.ownUserId,
          sender,
          config.matrix.adminUsers.includes(sender),
          text,
        );
        await this.sendReaction(roomId, userEventId, result.reaction);
        await this.sendMessage(roomId, result.message, userEventId, threadRoot);
        const status: "ok" | "error" = result.reaction === "❌" || result.reaction === "⛔" ? "error" : "ok";
        record({ user: sender, room: roomId, kind: "slash", text, status, detail: result.reaction });
        return;
      }

      const unknownCmd = text.split(/\s+/)[0] || "/?";
      const suggestion = suggestCommand(unknownCmd);
      const cmdList = KNOWN_COMMANDS.map((c) => `\`${c}\``).join(", ");
      await this.sendReaction(roomId, userEventId, "❌");
      await this.sendMessage(
        roomId,
        `❌ Commande inconnue : \`${unknownCmd}\`.${suggestion ? ` Voulais-tu dire \`${suggestion}\` ?` : ""}\n\nCommandes disponibles : ${cmdList}.\nTape \`/help\` pour le détail.`,
        userEventId,
        threadRoot,
      );
      record({ user: sender, room: roomId, kind: "slash", text, status: "unknown", detail: unknownCmd });
      return;
    }

    // The bot only handles slash commands — it does NOT chat in natural language.
    // For any other message (DM or @mention), reply with a generic notice that
    // points to the command room(s) and an optional contact (see notice.ts).
    await this.sendReaction(roomId, userEventId, "ℹ️");
    await this.sendMessage(
      roomId,
      buildCommandOnlyNotice({
        commandRooms: config.matrix.commandRooms,
        commandRoomsLabel: config.matrix.commandRoomsLabel,
        contact: config.matrix.contact,
        commands: KNOWN_COMMANDS,
      }),
      userEventId,
      threadRoot,
    );
    record({
      user: sender,
      room: roomId,
      kind: "mention",
      text: text || body,
      status: "refused",
      detail: "natural-language disabled",
    });
  }

  private async sendReaction(
    roomId: string,
    targetEventId: string,
    emoji: string,
  ): Promise<string | null> {
    try {
      const eventId = await this.client.sendEvent(roomId, "m.reaction", {
        "m.relates_to": {
          rel_type: "m.annotation",
          event_id: targetEventId,
          key: emoji,
        },
      });
      return eventId as string;
    } catch (err) {
      console.error("[Matrix] Failed to send reaction:", err);
      return null;
    }
  }

  // Pre-populate the DM set from the server-side `m.direct` account data so the
  // bot recognises existing direct rooms after a restart (the in-memory set is
  // otherwise only filled by fresh `is_direct` invites).
  private async loadDirectRooms(): Promise<void> {
    try {
      const direct = (await this.client.getAccountData("m.direct")) as
        | Record<string, string[]>
        | undefined;
      if (!direct) return;
      let count = 0;
      for (const roomIds of Object.values(direct)) {
        for (const roomId of roomIds ?? []) {
          if (roomId) {
            this.dmRooms.add(roomId);
            count++;
          }
        }
      }
      console.log(`[Matrix] Loaded ${count} DM room(s) from m.direct`);
    } catch (err) {
      // 404 = no m.direct account data yet; anything else we just log and skip.
      console.log(
        `[Matrix] No m.direct account data loaded (${(err as Error).message})`,
      );
    }
  }

  private async isDMRoom(roomId: string): Promise<boolean> {
    return this.dmRooms.has(roomId);
  }

  private async sendMessage(
    roomId: string,
    text: string,
    replyToEventId?: string,
    threadRootId?: string,
  ): Promise<void> {
    const buildContent = (
      withThread: boolean,
      withReply: boolean,
    ): Record<string, unknown> => {
      const c: Record<string, unknown> = {
        msgtype: "m.text",
        body: text,
        format: "org.matrix.custom.html",
        formatted_body: "",
      };
      if (withThread && threadRootId) {
        c["m.relates_to"] = {
          rel_type: "m.thread",
          event_id: threadRootId,
          "m.in_reply_to": { event_id: replyToEventId ?? threadRootId },
          is_falling_back: false,
        };
      } else if (withReply && replyToEventId) {
        c["m.relates_to"] = {
          "m.in_reply_to": { event_id: replyToEventId },
        };
      }
      return c;
    };

    const html = await marked(text);
    try {
      const c = buildContent(true, true);
      c["formatted_body"] = html;
      await this.client.sendEvent(roomId, "m.room.message", c);
    } catch (err) {
      const errMsg = String((err as { error?: string } | undefined)?.error ?? err);
      if (
        errMsg.includes("Cannot start threads from an event with a relation")
      ) {
        console.warn(
          `[Matrix] Thread refused (nested relation), falling back to plain reply in ${roomId}`,
        );
        const c = buildContent(false, true);
        c["formatted_body"] = html;
        await this.client.sendEvent(roomId, "m.room.message", c);
      } else {
        console.error(
          `[Matrix] sendMessage failed in ${roomId}:`,
          errMsg,
        );
      }
    }
  }
}
