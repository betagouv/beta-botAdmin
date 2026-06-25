# betabot

Self-hosted **command-only** Matrix/[Tchap](https://tchap.gouv.fr) bot for the [beta.gouv.fr](https://beta.gouv.fr) community.

It handles slash commands only (room management, mailing lists, history) — it does **not** chat in natural language. Any DM or @mention that isn't a command gets a generic reply pointing to the command room and an optional contact.

Detailed specs : [./specs](./specs)

---

## Commands

| Command | What it does | Who | Where |
|---|---|---|---|
| `/help` (or `/aide`) | Shows the help: all commands and their parameters | Everyone | Command rooms |
| `/emails …` | Manage DiMail mailing lists (`list` / `create` / `join` / `leave`) | Everyone | DiMail rooms |
| `/salon …` | Manage rooms in a Space (`list` / `create` / `delete` / `role`) | Everyone (`delete` = moderator+, `role` = admin) | Command rooms |
| `/historique [filter]` | Last 20 interactions, sent in DM | **Admin only** | Command rooms |

`/historique` and `/salon role` are admin-only and not advertised in `/help`. Type `/help` in a command room for the full, always-up-to-date reference.

---

## Requirements

- Node.js 20.6+
- A Matrix/Tchap account for the bot (with a **dedicated device** token — see below)
- *(optional)* A DiMail account, if you use the `/emails` command

---

## Setup

### 1. Install dependencies

```sh
npm install
```

### 2. Configure environment

```sh
cp .env.example .env
# edit .env
```

#### Environment variables

| Variable | Required | What it does |
|---|---|---|
| `DATA_DIR` | ✅ | Where the crypto store and Matrix session live (default `./data`). |
| `MATRIX_HOMESERVER` | ✅ | Homeserver base URL, e.g. `https://matrix.agent.dinum.tchap.gouv.fr`. |
| `MATRIX_USER` | ✅ | Bot's full Matrix ID, e.g. `@betabot:agent.dinum.tchap.gouv.fr`. |
| `MATRIX_ACCESS_TOKEN` | ✅* | Access token for the bot's **dedicated device** (see [Getting the access token](#getting-the-access-token-important)). |
| `MATRIX_PASSWORD` | ✅* | Alternative to the token: the bot logs in at startup. *Provide either the token or the password.* |
| `MATRIX_DEVICE_ID` | — | Optional, only read before the very first start; ignored once a session exists. |
| `MATRIX_ALLOWED_ROOMS` | — | Comma-separated room IDs to restrict the bot to. Empty = responds everywhere it's invited. |
| `MATRIX_COMMAND_ROOMS` | — | Rooms where slash commands are accepted. Empty = allowed wherever the bot responds. |
| `MATRIX_COMMAND_ROOMS_LABEL` | — | Human-readable name shown instead of the raw room ID when a command is refused (e.g. `Salon Admin betabot`). |
| `MATRIX_CONTACT` | — | Contact shown in the generic reply when someone DMs or @mentions the bot outside a command. Empty = the contact line is omitted. |
| `MATRIX_DIMAIL_ROOMS` | — | Rooms where the `/emails` (DiMail) command is available. Empty = DiMail disabled. |
| `MATRIX_ADMIN_USERS` | — | Comma-separated Matrix IDs allowed to run admin commands (`/historique`, `/salon role`). Empty = nobody. |
| `MATRIX_MANAGED_SPACE` | — | Space the bot may create/close rooms in via `/salon`. The bot needs power ≥ the space's `m.space.child` level (usually 100). Empty = `/salon` disabled. |
| `DIMAIL_URL` | — | DiMail API base URL (mailing lists / aliases). |
| `DIMAIL_USER` / `DIMAIL_PASSWORD` | — | DiMail credentials; used to fetch a token when `DIMAIL_TOKEN` is empty. |
| `DIMAIL_DOMAIN` | — | Default mail domain used to resolve a bare list name (e.g. `cartobio` → `cartobio@<domain>`). |
| `DIMAIL_TOKEN` | — | Pre-existing DiMail Bearer token; if set, `DIMAIL_USER`/`PASSWORD` are not needed. |

\* Either `MATRIX_ACCESS_TOKEN` **or** `MATRIX_PASSWORD` must be set.

#### Getting the access token (important)

> ⚠️ **Take the token from a `curl` login, _not_ from the Tchap/Element web client.**
>
> A token copied from a browser session belongs to a device whose **end-to-end encryption is already managed by that web client**. The bot cannot co-manage the same device's crypto: it ends up unable to share its message keys, so users see *"Déchiffrement en cours…"*, and you hit `One time key … already exists` errors on startup.
>
> Logging in with `curl` mints a **fresh, dedicated device** that the bot alone owns — clean E2E, no conflicts.

Run this once and copy the returned `access_token` into `MATRIX_ACCESS_TOKEN`:

```sh
curl -XPOST -H "Content-Type: application/json" \
  -d '{
    "type": "m.login.password",
    "identifier": { "type": "m.id.user", "user": "@betabot:example.org" },
    "password": "<bot-account-password>",
    "initial_device_display_name": "betabot"
  }' \
  https://matrix.example.org/_matrix/client/r0/login
```

Response:

```json
{ "access_token": "mct_…", "device_id": "Cc8zy2CNm6", "user_id": "@betabot:example.org" }
```

- Put `access_token` into `MATRIX_ACCESS_TOKEN`.
- Keep this token secret — it grants full access to the bot account. Never commit it or paste it in screenshots; rotate it (log the device out) if it leaks.
- Each `curl` login creates a **new** device. If you re-mint a token, delete `data/crypto` so the bot rebuilds a clean store for the new device.

### 3. Run

```sh
npm run dev      # development (tsx, hot reload)
npm run start    # production (compiled JS)
```

---

## Building for production

```sh
npm run build   # outputs to dist/
npm run start
```
