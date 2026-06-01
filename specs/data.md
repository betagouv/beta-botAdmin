# Data acquisition spec

`get-data.sh`, `build-embeddings.ts`, `src/markdown.ts`

## Overview

Two-phase pipeline: **fetch** raw data (`get-data.sh`) then **embed** it into search indices (`build-embeddings.ts`). Run nightly or on demand; restart the bot afterwards (embeddings load into memory at startup).

```sh
./get-data.sh && npm run embed -- --force
```

---

## Phase 1 — Data fetch (`get-data.sh`)

`DATA_DIR` defaults to `./data`. All outputs are gitignored.

### API snapshots (curl)

| Output                           | Source URL                                            |
| -------------------------------- | ----------------------------------------------------- |
| `data/API/members.json`          | `https://beta.gouv.fr/api/v2.6/authors.json`          |
| `data/API/startups.json`         | `https://beta.gouv.fr/api/v2.6/startups.json`         |
| `data/API/startups_details.json` | `https://beta.gouv.fr/api/v2.6/startups_details.json` |
| `data/API/incubators.json`       | `https://beta.gouv.fr/api/v2.6/incubators.json`       |

### Git repos (shallow clone / pull)

| Output                     | Source                                                              |
| -------------------------- | ------------------------------------------------------------------- |
| `data/gitscan/`            | `github.com/betagouv/gitscan` — `--depth=1`                         |
| `data/doc.incubateur.net/` | `github.com/betagouv/doc.incubateur.net-communaute` — `--depth=500` |

On subsequent runs, `git pull` updates each repo in-place.

### PeerTube feeds (curl)

All channels from `tube.numerique.gouv.fr`, sorted by `-createdAt`:

| Output file                | Channel               |
| -------------------------- | --------------------- |
| `animation_beta.json`      | `animation_beta`      |
| `lasuite_modedemploi.json` | `lasuite_modedemploi` |
| `bluehats.json`            | `bluehats`            |
| `lasuite.json`             | `lasuite`             |
| `grist.json`               | `grist`               |
| `designgouv.json`          | `designgouv`          |
| `tchap.json`               | `tchap`               |
| `datagouvfr.json`          | `datagouvfr`          |
| `fabnum.mte.json`          | `fabnum.mte`          |

### Calendar

`data/calendar.ics` — beta.gouv.fr community Google Calendar, public ICS feed.

### Index derivation (jq, inline)

Run at the end of `get-data.sh` before the bot can embed.

**`data/index/members.json`** — active members only (at least one mission with `end > today`), fields: `id, fullname, competences, role, domaine`. Deduped by `id`.

**`data/index/startups.json`** — non-abandoned startups (phases must not include `abandon` or `abandon-investigation`), fields: `id, name, description, active_member_count`. `active_member_count` is derived from `startups_details.json[id].active_members`.

**`data/index/incubators.json`** — flat list from `incubators.json`, fields: `id, title, contact, website, github, startup_count`.

**`data/index/phases.txt`** — human-readable phase descriptions (static, written inline by the script). Used as LLM context.

---

## Phase 2 — Embedding pipeline (`build-embeddings.ts`)

```sh
npm run embed            # skip jobs whose .bin already exists
npm run embed -- --force # rebuild everything
```

Six sequential jobs. Each job:

1. Checks if the output `.bin` exists — skips unless `--force`.
2. Builds embedding texts from source data.
3. Calls `embedBatch` → `saveBin` to write the dense matrix.
4. Calls `buildBM25Index` → `saveBM25Index` to write the sparse index.
5. Writes `*.index.json` (metadata aligned with embedding rows) where needed.

### Job 1 — Members

Source: `data/index/members.json`

Embedding text per member:

```
"{fullname}, {role}, domaine {domaine}. Compétences: {competences joined by ', '}"
```

Missing `competences` → `"non renseignées"`.

Outputs: `data/index/members.embeddings.bin`, `data/index/members.bm25.json`

### Job 2 — Startups

Source: `data/index/startups.json`

Embedding text: `"{name}: {description}"`

Outputs: `data/index/startups.embeddings.bin`, `data/index/startups.bm25.json`

### Job 3 — Git repos (gitscan)

Source: `data/gitscan/repos/{ORG}/{REPO}/overview.json` — walks the full tree, skips repos with missing or broken `overview.json`.

Embedding text per repo:

```
"{name} ({org}): {description}. Language: {language}. Tags: {tags}. Features: {features}. Audience: {audience}"
```

Outputs: `data/gitscan/repos.embeddings.bin`, `data/gitscan/repos.bm25.json`, `data/gitscan/repos.index.json`

Index entry type:

```ts
{ org: string; repo: string; name: string; description: string; language: string; tags: string[] }
```

### Job 4 — Documentation

Source: all `.md` files under `data/doc.incubateur.net/` (recursive walk).

Per file, two chunk types are produced (see **Markdown parsing** below):

- **Front matter intro chunk** — from `description` field if present; breadcrumb = page title.
- **Section chunks** — one per heading section from `extractSections`.

Sections with `content.length < 30` are skipped (shorter than that are noise).

Embedding text per chunk: `"[{breadcrumb}]\n{content}"`

Outputs: `data/doc.incubateur.net/docs.embeddings.bin`, `data/doc.incubateur.net/docs.bm25.json`, `data/doc.incubateur.net/docs.index.json`

Index entry type:

```ts
{
  path: string;
  title: string;
  breadcrumb: string;
  excerpt: string;
}
```

`excerpt` is truncated to 200 chars.

### Job 5 — PeerTube videos

Source: all `data/peertube/*.json` files except `videos.index.json`.

Embedding text per video: `"[{channelName}] {title}"`

Fields taken from feed items: `title`, `url` (falls back to `id`), `date_published`.

Outputs: `data/peertube/videos.embeddings.bin`, `data/peertube/videos.bm25.json`, `data/peertube/videos.index.json`

Index entry type:

```ts
{
  title: string;
  channel: string;
  url: string;
  date: string;
}
```

### Job 6 — Incubators

Source: `data/API/incubators.json` (dict keyed by slug).

Embedding text per incubator: `"{title} — startups: {top-10 startup names}"`
If more than 10 startups: appends `"… (N startups)"`.

Outputs: `data/API/incubators.embeddings.bin`, `data/API/incubators.bm25.json`, `data/API/incubators.index.json`

Index entry type:

```ts
{
  id: string;
  title: string;
  contact: string;
  website: string | null;
  github: string | null;
  startup_count: number;
  startups_summary: string;
}
```

---

## Markdown parsing (`src/markdown.ts`)

Used by Job 4. Two exported functions.

### `parseFrontmatter(content)`

Wraps `gray-matter`. Returns `{ data: Record<string, unknown>, body: string }`.

### `extractSections(rawContent): Section[]`

1. **Strip GitBook syntax**: removes `{% ... %}` blocks and empty `<a>` anchor tags.
2. **Strip front matter** via `parseFrontmatter`.
3. **Parse** with `unified` + `remark-parse` + `remark-frontmatter` → MDAST.
4. **Walk** top-level nodes:
   - On a `heading` node: flush current section buffer, update heading stack (pop headings at same or greater depth, push new heading).
   - On any other node: extract text recursively (`nodeText`), append to buffer.
5. **Flush** final buffer.
6. **Merge short sections**: any section with `content.length < 50` is merged into the preceding section.

`Section` type:

```ts
{
  breadcrumb: string;
  depth: number;
  content: string;
}
```

`breadcrumb` = heading stack joined with `>`, e.g. `"Notre solution > Qu'est-ce que la Maison de l'autisme ?"`. Falls back to `"Introduction"` if no heading precedes the content.

---

## npm scripts

| Script                     | Command                                               |
| -------------------------- | ----------------------------------------------------- |
| `npm run embed`            | `node --import tsx build-embeddings.ts`               |
| `npm run embed -- --force` | rebuilds all jobs regardless of existing `.bin` files |
| `npm run get-data`         | `sh get-data.sh`                                      |
