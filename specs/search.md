# Search spec

`src/search.ts`, `src/embed.ts`

## Overview

All search tools use **hybrid retrieval**: dense cosine similarity over `Float32Array` embedding matrices fused with BM25 sparse search via Reciprocal Rank Fusion (RRF).

---

## Embeddings — `src/embed.ts`

### `embedText(text, retries = 5): Promise<number[]>`

Calls `openai.embeddings.create` (pointed at Ollama). On HTTP 429, backs off using the `x-ratelimit-reset-requests` response header if present, otherwise exponential backoff (`2000ms × 2^attempt`). Throws after `retries` exhausted.

### `embedBatch(texts): Promise<number[][]>`

Sequential (one at a time) to respect rate limits. Prints progress to stdout every 10 items.

### `saveBin(vecs, binPath)`

Writes a `Float32Array` as a flat little-endian binary file. Layout: `vecs.length × dims × 4` bytes, row-major.

### `loadBin(binPath, dims): Float32Array`

Reads the `.bin` file and returns a `Float32Array` view. Row `i` = `matrix.subarray(i * dims, (i + 1) * dims)`.

---

## Hybrid search — `src/search.ts`

### BM25 (sparse)

**Text preparation** (`prepareText`):

1. Lowercase
2. NFD normalize → strip combining accents (`̀–ͯ`)
3. Split on non-alphanumeric characters
4. Drop tokens of length ≤ 1 and French stopwords

French stopwords: a fixed set of ~70 common function words (articles, pronouns, prepositions, auxiliary verbs).

**Index operations:**

| Function                        | Description                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `buildBM25Index(docs)`          | Creates a `wink-bm25-text-search` index over `docs[i]` keyed by numeric id `i`. Single field `text`, weight `1`.      |
| `saveBM25Index(index, path)`    | Serialises via `index.exportJSON()` to disk.                                                                          |
| `loadBM25Index(path)`           | Creates a fresh BM25 instance and imports JSON from disk.                                                             |
| `sparseSearch(index, query, k)` | Prepares query text, calls `index.search()`, returns `{index, score}[]` sliced to `k`. Empty token list returns `[]`. |

### Dense (cosine)

**`cosineSimilarity(a, b): number`** — dot product divided by norms; returns `0` if either vector is zero.

**`denseSearch(queryVec, matrix, k, dims)`** — computes cosine similarity against every row of `matrix`, sorts descending, returns top-`k` `{index, score}[]`.

### Fusion — `rrf(dense, sparse, k = 60)`

RRF formula (rank-based, no score normalisation needed):

```
score(d) = Σ  1 / (k + rank + 1)
           r ∈ {dense, sparse}
```

where `rank` is 0-based. `k = 60` (standard parameter-free default).

Returns merged `{index, score}[]` sorted descending by fused score.

### `hybridSearch<T>(query, queryVec, matrix, bm25Index, indexEntries, dims, topK)`

Main entry point for all tool search handlers.

1. `searchK = max(topK × 3, 30)` — over-fetches before fusion.
2. Runs `denseSearch` and `sparseSearch` with `searchK`.
3. Fuses via `rrf`.
4. Slices to `topK`, maps each `index` to `indexEntries[index]`, attaches `.score`.

Returns `Array<T & { score: number }>`.

---

## Data layout

Every searchable source has two build-time outputs:

| File               | Content                                                       |
| ------------------ | ------------------------------------------------------------- |
| `*.embeddings.bin` | `Float32Array`, `n × dims` rows, little-endian                |
| `*.bm25.json`      | Serialised BM25 index (`wink-bm25-text-search` JSON format)   |
| `*.index.json`     | Array of metadata objects — row `i` matches embedding row `i` |

Sources and their index locations:

| Source          | Bin / BM25 prefix              | Index JSON                                |
| --------------- | ------------------------------ | ----------------------------------------- |
| Members         | `data/index/members`           | implicit (members.json is the index)      |
| Startups        | `data/index/startups`          | implicit (startups.json is the index)     |
| Git repos       | `data/gitscan/repos`           | `data/gitscan/repos.index.json`           |
| Docs            | `data/doc.incubateur.net/docs` | `data/doc.incubateur.net/docs.index.json` |
| PeerTube videos | `data/peertube/videos`         | `data/peertube/videos.index.json`         |
| Incubators      | `data/API/incubators`          | `data/API/incubators.index.json`          |

---

## Config used

`config.openai.{baseUrl, apiKey, embedModel, embedDims}` from `src/config.ts`.
