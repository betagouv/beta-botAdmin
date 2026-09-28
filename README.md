# betabot

Self-hosted **command-only** Matrix/[Tchap](https://tchap.gouv.fr) bot for the [beta.gouv.fr](https://beta.gouv.fr) community.

It handles slash commands only (room management, mailing lists, history) — it does **not** chat in natural language. Any DM or @mention that isn't a command gets a generic reply pointing to the command room and an optional contact.

---

## Commands

| Command | What it does | Who | Where |
|---|---|---|---|
| `/help` (or `/aide`) | Shows the help: all commands and their parameters | Everyone | Command rooms + OPS rooms |
| `/emails …` | Manage DiMail mailing lists (`list` / `create` / `join` / `leave`) | Everyone | Command rooms |
| `/salon …` | Manage rooms in a Space (`list` / `create` / `delete`) | Everyone (`delete` = moderator+) | Command rooms |
| `/espace …` | Manage sub-spaces (`list` / `create` / `delete`) | Everyone (`delete` = allow-listed, in DM) | Command rooms |
| `/invite <startup>` | Invite a startup's members into a room or space, via n8n | Everyone (needs invite rights in the **target**) | Anywhere — the target's permissions are the boundary |
| `/rappels-calendrier` (or `/rappels`) | Subscribe to meeting reminders; the setup happens in DM | Everyone | Command rooms + OPS rooms |
| `/rappels-stop` | Unsubscribe from meeting reminders | Everyone | Command rooms + OPS rooms |
| `/alerte [composant]` | Raise a security alert on a vulnerable component: the bot asks the procedure's questions in a DM, then opens a dedicated encrypted room, invites the référents, and announces it with @room in ~Domaine-secu | Everyone | Anywhere — DMs, OPS rooms, and rooms outside `MATRIX_ALLOWED_ROOMS` |
| `/historique [filter]` | Last 20 interactions, sent in DM | **Admin only** | Command rooms |

`/historique` is admin-only and not advertised in `/help`. For the full, always-up-to-date reference, mention the bot followed by `/help` in a command room (`/help` alone in a DM). A hand-typed mention must be the bot's whole handle — e.g. `@betabot+admin`, derived from its display name — since a mere prefix such as `@betabot` is ignored; the help prints the exact handle, so its examples can be copied as they are.

When the bot creates a room or a space, the requester is made **moderator (50)** and the bot stays **admin (100)**. Every threshold in the new room is lowered to 50, so a moderator can rename it, set the topic/avatar/history/join rules, invite, kick, ban, redact, add or remove rooms from a space, and appoint other moderators. Matrix auth rules stop them there: a level-50 user cannot grant a level above their own, so only the bot can create another admin or be removed. If the homeserver refuses that adjustment, the bot says so in its reply instead of leaving a room nobody can manage.

In the OPS rooms (`MATRIX_OPS_ROOMS`), `/help` shows how to file an OPS request instead of the bot help, and only the `/rappels-*` pair and `/alerte` work besides it — every other message is ignored silently.

`/alerte` runs the mechanical part of the SSI procedure « Composant vulnérable ». In a DM — typed in a room, the command opens one — the bot asks the questions the procedure requires (component, description, CVSS, CVE, exploited, patch, versions, advisory link, remediation), then shows the exact message that will open the alert room and waits for a `oui`. Only then does it open `tmp-alerte-securite-<composant>-JJMMAA` — private, encrypted, invite-only, history shared with newcomers, every member allowed to invite — invite whoever raised the alert (moderator) and the référents, one at a time so that a wrong ID or a rate limit never sinks the alert, post that message, and announce the room with @room in `ALERTE_SECU_ROOM`. The same component raised twice the same day joins the open room instead of notifying everyone again. `/alerte annuler` drops an alert being prepared. The email to `alertes-securite@beta.gouv.fr` stays manual; the last DM reminds it.

---

## Requirements

- Node.js 20.6+
- A Matrix/Tchap account for the bot (with a **dedicated device** token — see below)
- *(optional)* A DiMail account, if you use the `/emails` command
- *(optional)* A Grist document and a CalDAV service account, if you use the meeting reminders (`/rappels-calendrier`)
- *(optional)* An n8n webhook, if you use `/invite`

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
| `MATRIX_ALLOWED_ROOMS` | — | Comma-separated room IDs to restrict the bot to. Empty = responds everywhere it's invited. |
| `MATRIX_COMMAND_ROOMS` | — | Rooms where slash commands are accepted. Empty = allowed wherever the bot responds. |
| `MATRIX_COMMAND_ROOMS_LABEL` | — | Human-readable name shown instead of the raw room ID when a command is refused (e.g. `Salon Admin betabot`). |
| `MATRIX_COMMAND_ROOMS_URL` | — | `matrix.to` link to the command room; makes the label above clickable. |
| `MATRIX_DM_TEST_USERS` | — | Users allowed to run commands in a DM with the bot, bypassing `MATRIX_COMMAND_ROOMS` (testing). `/espace delete` is reserved to them, in DM. |
| `MATRIX_CONTACT` | — | Contact shown in the generic reply when someone DMs or @mentions the bot outside a command. Empty = the contact line is omitted. |
| `MATRIX_ADMIN_USERS` | — | Comma-separated Matrix IDs allowed to run admin commands (`/historique`). Empty = nobody. |
| `MATRIX_MANAGED_SPACE` | — | Space the bot may create/close rooms in via `/salon` and `/espace`. The bot needs power ≥ the space's `m.space.child` level (usually 100). Empty = `/salon` and `/espace` disabled. |
| `MATRIX_OPS_ROOMS` | — | Rooms where `/help` returns the OPS-request help and only `/rappels-calendrier` / `/rappels-stop` also work. |
| `MATRIX_NO_MENTION_USERS` | — | Accounts whose commands are accepted in rooms without mentioning the bot (e.g. an n8n automation). Defaults to `@betabotadmin-beta.gouv.fr:agent.dinum.tchap.gouv.fr`, the beta.gouv.fr bot's own account. |
| `MATRIX_ALLOW_SELF_COMMANDS` | — | `true` lets the bot's own account run slash commands. |
| `MATRIX_DEFAULT_INVITES` | — | Comma-separated Matrix IDs invited as moderators when the bot creates a room or space for itself (a command posted with its own account). Empty = the bot is alone in it, and a warning is logged. |
| `DIMAIL_URL` | — | DiMail API base URL (mailing lists / aliases). |
| `DIMAIL_USER` / `DIMAIL_PASSWORD` | — | DiMail credentials; the bot logs in with them at every `/emails` command. |
| `DIMAIL_DOMAIN` | — | Default mail domain used to resolve a bare list name (e.g. `cartobio` → `cartobio@<domain>`). |
| `GRIST_API_URL` / `GRIST_API_KEY` | — | Grist instance and API key storing the reminder subscriptions. |
| `GRIST_OPS_DOC_ID` | — | Grist document holding the `RappelsCalendrier` and `RappelsEnvoyes` tables (`GRIST_OPS_TABLE_INSCRIPTIONS` / `GRIST_OPS_TABLE_SENT` override their names). |
| `CALDAV_USER` / `CALDAV_PASSWORD` | — | Service account reading the subscribers' calendars — each subscriber shares their calendar with it, read-only. |
| `CALDAV_HELP_URL` | — | Page linked in the subscription DM, to find one's CalDAV URL. |
| `RAPPELS_ENABLED` | — | `false` turns the reminder scheduler off. |
| `RAPPELS_DRY_RUN` | — | ⚠️ **Dry run by default**: reminders are logged, not sent. Set `false` in production. |
| `RAPPELS_INTERVAL_MIN` / `RAPPELS_LEAD_MIN` / `RAPPELS_WINDOW_MIN` | — | Scheduler period, how long before an event to remind, and width of the detection window, in minutes (defaults 5 / 15 / 5). |
| `N8N_MEMBRES_WEBHOOK_URL` | — | n8n webhook behind `/invite`. Empty = the command answers that it is unavailable. |
| `N8N_WEBHOOK_SECRET` | — | Shared secret sent as `X-Betabot-Secret`, so n8n can reject other callers. |
| `N8N_TIMEOUT_MS` | — | How long to wait for n8n, in ms (default 15000). |
| `ALERTE_SECU_REFERENTS` | — | Comma-separated Matrix IDs of the référents (techs and SSI) invited into every `/alerte` room. Empty = the room holds only whoever raised the alert, and the reply says so. |
| `ALERTE_SECU_ROOM` | — | Room where `/alerte` announces the alert with @room (~Domaine-secu). The bot must be a member at a level allowed to notify @room (usually 50), otherwise the announcement pings nobody and the reply says so. Empty = no announcement. |

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
