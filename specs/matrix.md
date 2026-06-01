# Matrix connector spec

`src/connectors/matrix.ts`

## Role

Bridges Matrix rooms/DMs to the `Orchestrator`. Handles authentication, E2EE, invite auto-join, message filtering, mention detection, thread tracking, reply formatting, and SAS device verification.

## Class

```ts
class MatrixConnector {
  constructor(orchestrator: Orchestrator);
  async start(): Promise<void>;
}
```

## Authentication

Three modes, checked in priority order:

| Priority | Condition                           | Method                                                                            |
| -------- | ----------------------------------- | --------------------------------------------------------------------------------- |
| 1st      | `$DATA_DIR/credentials.json` exists | Load saved `accessToken` + `deviceId` + `userId`.                                |
| 2nd      | `MATRIX_ACCESS_TOKEN` is set        | Direct token auth.                                                                |
| 3rd      | `MATRIX_PASSWORD` is set            | `m.login.password` flow — creates a new device once, then saves credentials.     |

After the first successful password login, credentials are written to `$DATA_DIR/credentials.json` so subsequent starts reuse the same device.

## Credential persistence

File: `$DATA_DIR/credentials.json` (default `./data/credentials.json`).

```json
{ "accessToken": "...", "deviceId": "...", "userId": "@bot:example.org" }
```

To force re-registration (new device), delete this file.

## E2EE

Uses `matrix-bot-sdk` with `RustSdkCryptoStorageProvider` (Rust crypto, stored in `$DATA_DIR/crypto/`). Global `Olm` is initialised from `@matrix-org/olm` before the client is created.

Session state is persisted via `SimpleFsStorageProvider` (`$DATA_DIR/bot-session.json`), which stores the sync token so the client resumes from the last seen position on restart.

## Device verification (SAS)

The bot intercepts to-device events **before** the Rust engine can process them by monkey-patching `client.processSync`. Verification events (`*.verification.*`) are stripped from the sync payload forwarded to the SDK and handled manually.

Flow on receiving a verification request:

| Step | Event received                   | Bot action                                                                                    |
| ---- | -------------------------------- | --------------------------------------------------------------------------------------------- |
| 1    | `m.key.verification.request`     | Stores `{ sender, fromDevice }` in `pendingVerif`; sends `m.key.verification.ready`.          |
| 2    | `m.key.verification.start`       | Generates an X25519 key pair; computes SHA-256 commitment; sends `m.key.verification.accept`. |
| 3    | `m.key.verification.key`         | Computes DH shared secret; derives SAS bytes via HKDF-SHA-256; logs emojis to console; sends own `m.key.verification.key`. |
| 4    | `m.key.verification.mac`         | Verifies the MAC from the other side; sends own MAC + `m.key.verification.done`.              |
| —    | `m.key.verification.cancel`      | Logs the reason and clears the pending state.                                                 |

The patched `processSync` also sets `patched.rooms.join/invite/leave` to `{}` when absent, preventing the Rust SDK from throwing and falling back to the original (unfiltered) sync data.

`whoami` is fetched fresh inside each `handleVerifEvent` call to ensure the correct `user_id` and `device_id` are used regardless of startup timing.

To verify the bot, initiate a device verification from Element; the bot logs the SAS emojis and the user confirms on their side.

## Startup message filter

`startupTs` is recorded at instantiation time (`Date.now()`). Any incoming room message whose `origin_server_ts` predates `startupTs` is silently dropped, preventing the bot from replying to messages that arrived while it was offline.

## Invite auto-join

On `room.invite`:

- Adds the room to `dmRooms` if `is_direct: true` in the invite content.
- Joins the room unconditionally.
- Sends `WELCOME_MESSAGE` only for DM rooms (single interlocutor), once per room (tracked in `greetedRooms`). Group channels are joined silently.

## Message routing

On `room.message`, a message is handled if **any** of the following is true:

| Condition           | Detail                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| DM room             | Room has exactly 2 members, or was flagged `is_direct` at invite time.                                                                   |
| Bot mentioned       | `formatted_body` contains `ownUserId`, or `body` contains `ownUserId` (case-insensitive), or `body` contains the local part of `ownUserId`. |
| Active bot thread   | A previous mention in this thread was recorded in `activeBotThreads`.                                                                    |

Ignored: own messages, non-`m.text` messages, messages older than `startupTs`.

Decryption failures in DMs or active bot threads receive a dedicated apology message.

## Processing indicator

When a message is accepted for processing:

1. A 🧠 reaction is sent on the user's message via `m.reaction` (`m.annotation`).
2. The reaction remains after the answer is sent (it is never redacted).

## Thread tracking

When the bot is mentioned, the `threadRoot` event ID is added to `activeBotThreads`. Subsequent messages in the same thread are handled without requiring another mention.

Thread root resolution:

- `m.relates_to.rel_type === "m.thread"` → `relates_to.event_id`.
- Otherwise → `event.event_id` (the event itself becomes the thread root).

## Text cleaning

Before passing to the orchestrator, the bot's own user ID is stripped from the message body (regex, case-insensitive). If stripping leaves an empty string, the original body is used.

## Sending replies

`sendMessage(roomId, text, replyToEventId?, threadRootId?)`:

- Content type: `m.text` with `format: org.matrix.custom.html`.
- `formatted_body`: Markdown rendered to HTML via `marked`.
- In a thread: `m.relates_to` with `rel_type: m.thread` + `m.in_reply_to`.
- In a DM (no thread): plain `m.in_reply_to` only.

On orchestrator error, sends `_(Erreur interne, merci de réessayer.)_` as fallback.

## Welcome message

Sent once per **DM room** on first join. Lists the bot's capabilities in French with bullet points and emojis. Not sent in group channels.

## Config used

`config.matrix.{homeserver, user, accessToken, password}` from `src/config.ts`.  
`config.dataDir` for storage paths.
