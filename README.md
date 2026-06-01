# betabot

Self-hosted conversational bot that answers natural language questions (in French) about the [beta.gouv.fr](https://beta.gouv.fr) community — members, startups, code repositories, documentation, calendar, and videos.

Runs fully on a private [Ollama](https://ollama.com) instance. No external API calls.

Detailed specs : [./specs](./specs)

---

## What it can answer

- _Qui sait faire du PostgreSQL ?_
- _Quelles startups travaillent sur la santé ?_
- _Dans quelle phase est la startup recosanté ?_
- _Qui est dans l'équipe de demarches-simplifiees ?_
- _Comment organiser une visio selon la doc ?_
- _Quels sont les prochains événements de la communauté ?_
- _Quelles vidéos récentes sur les BlueHats ?_

---

## Architecture

```
User (Matrix)
  │
  ▼
MatrixConnector       (DM or @mention)
  │
  ▼
Orchestrator          (conversation loop, per-room history)
  │  OpenAI-compatible API → Ollama
  ▼
LLM with tool calling (qwen2.5, mistral-nemo…)
  │
  ▼
Tool dispatcher
  ├── search_members / get_member_detail / get_member_startups
  ├── search_startups / get_startup_detail / get_startup_members
  ├── search_repos / get_repo_detail
  ├── search_docs / get_doc_page
  ├── get_calendar
  ├── search_videos
  └── get_videos
```

Search tools use **hybrid retrieval**: dense cosine similarity on `Float32Array` `.bin` embedding matrices + BM25 sparse search, fused with Reciprocal Rank Fusion (RRF).

Every bot response ends with a discrete link to [open a feedback issue](https://github.com/betagouv/betabot/issues/new).

---

## Requirements

- Node.js 20.6+
- An [Ollama](https://ollama.com) instance (or any OpenAI-compatible API)
- Recommended models:
  | Purpose | Model |
  |---|---|
  | LLM (tool calling) | `qwen2.5:14b` or `mistral-nemo:12b` |
  | Embeddings | `nomic-embed-text` (768 dims) or `bge-m3` (1024 dims) |

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
| `OPENAI_BASE_URL` | ✅ | OpenAI-compatible endpoint for the LLM + embeddings (e.g. Ollama at `http://localhost:11434/v1`). |
| `OPENAI_API_KEY` | ✅ | API key for that endpoint (`ollama` for a local Ollama). |
| `OPENAI_MODEL` | ✅ | Tool-calling chat model, e.g. `qwen2.5:14b`. |
| `OPENAI_EMBED_MODEL` | ✅ | Embedding model used by `npm run embed`, e.g. `nomic-embed-text`. |
| `EMBED_DIMS` | ✅ | Embedding vector size — **must match** the embed model (768 for `nomic-embed-text`, 1024 for `bge-m3`). |
| `DATA_DIR` | ✅ | Where snapshots, embeddings, crypto store and session live (default `./data`). |
| `MATRIX_HOMESERVER` | ✅ | Homeserver base URL, e.g. `https://matrix.agent.dinum.tchap.gouv.fr`. |
| `MATRIX_USER` | ✅ | Bot's full Matrix ID, e.g. `@betabot:agent.dinum.tchap.gouv.fr`. |
| `MATRIX_ACCESS_TOKEN` | ✅* | Access token for the bot's **dedicated device** (see [Getting the access token](#getting-the-access-token-important)). |
| `MATRIX_PASSWORD` | ✅* | Alternative to the token: the bot logs in at startup. *Provide either the token or the password.* |
| `MATRIX_DEVICE_ID` | — | Optional, only read before the very first start; ignored once a session exists. |
| `MATRIX_ALLOWED_ROOMS` | — | Comma-separated room IDs to restrict the bot to. Empty = responds everywhere it's invited. |
| `MATRIX_COMMAND_ROOMS` | — | Rooms where slash commands (`/help`, `/emails`, `/historique`, `/salon`) are accepted. Empty = allowed wherever the bot responds. |
| `MATRIX_COMMAND_ROOMS_LABEL` | — | Human-readable name shown instead of the raw room ID when a command is refused (e.g. `Salon Admin betabot`). |
| `MATRIX_CONTACT` | — | Contact shown in the generic reply when someone DMs or @mentions the bot outside a command. Empty = the contact line is omitted. |
| `MATRIX_DIMAIL_ROOMS` | — | Rooms where the DiMail mailing-list tools are exposed. Empty = DiMail disabled. |
| `MATRIX_ADMIN_USERS` | — | Comma-separated Matrix IDs allowed to run admin commands like `/historique` and `/salon`. Empty = nobody. |
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

### 3. Fetch data

```sh
./get-data.sh
```

This downloads the API snapshots, calendar, and PeerTube feeds into `data/`.

### 4. Build embeddings

```sh
npm run embed
```

Embeds chunks across 6 sources. Each job skips automatically if its `.bin` already exists — safe to restart after an interruption. Use `--force` to rebuild everything:

```sh
npm run embed -- --force
```

### 5. Run

**Matrix bot:**

```sh
npm run dev      # development (tsx, hot reload)
npm run start    # production (compiled JS)
```

**Local CLI** (no Matrix needed — useful for testing):

```sh
npm run cli
```

```
betabot CLI — tapez votre question (Ctrl+C pour quitter)

vous > qui sait faire du PostgreSQL dans la santé ?
betabot > Voici les membres…
```

---

## Data refresh

Run nightly or on demand:

```sh
./get-data.sh && npm run embed -- --force
```

---

## Evals

Test tool routing — which tool(s) the LLM calls for a given question — against a fixture set.
Uses canned responses so runs are fast and data-independent.

Each fixture declares `expect_tools`: the full set of tools that must appear in the call log.
An empty array asserts no tool is called.

```sh
# Run against the committed fixtures
npm run eval

# Compare with a previous run to catch regressions
npm run eval -- --compare evals/results/2026-05-21T10-00-00-000Z.json
npm run eval -- --compare latest

# Generate a markdown report from two result files
node --import tsx evals/report.ts evals/results/result.json [base.json]

# Regenerate fixtures from your actual datasets (after ./get-data.sh)
npm run eval:generate
```

Results are saved to `evals/results/` (gitignored) as timestamped JSON files.
`fixtures.json` is committed — the static set covers all tools and includes multi-tool
sequences (e.g. `search_startups` → `get_startup_members`). `eval:generate` refreshes it
with real names and topics sampled from `data/`.

### CI

The workflow `.github/workflows/eval.yml` runs automatically on pull requests that touch
tool definitions, the orchestrator, or the fixture set. It posts a sticky comment with:

- Pass rate and badge (🟢 / 🟡 / 🔴)
- Failing cases with expected vs actual tool chains
- Regression / improvement diff vs the last `main` run (when a base artifact is available)
- Collapsible table of all passing cases

**Required secrets** (`Settings → Secrets → Actions`):

| Secret            | Example                     |
| :---------------- | :-------------------------- |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` |
| `OPENAI_API_KEY`  | `sk-...`                    |
| `OPENAI_MODEL`    | `gpt-4o-mini`               |

---

## Building for production

```sh
npm run build   # outputs to dist/
npm run start
```
