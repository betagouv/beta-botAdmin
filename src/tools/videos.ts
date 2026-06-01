import fs from "fs";
import path from "path";
import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { config } from "../config.js";
import { embedText, loadBin } from "../embed.js";
import { loadBM25Index, hybridSearch } from "../search.js";

const DATA = config.dataDir;
const PEERTUBE_DIR = path.join(DATA, "peertube");
const DIMS = config.openai.embedDims;

interface Video {
  title: string;
  date: string;
  url: string;
  channel: string;
  description: string;
}

interface VideoChunk {
  title: string;
  channel: string;
  url: string;
  date: string;
  description: string;
}

interface PeertubeItem {
  id: string;
  url: string;
  title: string;
  summary?: string;
  content_html?: string;
  date_published?: string;
  date_modified?: string;
}

interface PeertubeChannel {
  title: string;
  items?: PeertubeItem[];
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// Lazy-loaded search indices
let matrix: Float32Array | null = null;
let bm25: unknown = null;
let indexEntries: VideoChunk[] | null = null;

async function ensureLoaded() {
  if (matrix) return;
  matrix = loadBin(path.join(PEERTUBE_DIR, "videos.embeddings.bin"), DIMS);
  bm25 = await loadBM25Index(path.join(PEERTUBE_DIR, "videos.bm25.json"));
  indexEntries = JSON.parse(
    fs.readFileSync(path.join(PEERTUBE_DIR, "videos.index.json"), "utf-8"),
  ) as VideoChunk[];
}

async function search_videos(
  query: string,
  top_k = 5,
): Promise<Array<VideoChunk & { score: number }>> {
  await ensureLoaded();
  const queryVec = await embedText(query);
  return hybridSearch(query, queryVec, matrix!, bm25, indexEntries!, DIMS, top_k);
}

async function get_videos(channel?: string): Promise<Video[]> {
  if (!fs.existsSync(PEERTUBE_DIR)) return [];

  const files = fs.readdirSync(PEERTUBE_DIR).filter((f) => f.endsWith(".json") && f !== "videos.index.json");
  const channelFiles = channel
    ? files.filter((f) => f === `${channel}.json`)
    : files;

  const results: Video[] = [];

  for (const file of channelFiles) {
    const channelName = path.basename(file, ".json");
    let feed: PeertubeChannel;
    try {
      feed = JSON.parse(
        fs.readFileSync(path.join(PEERTUBE_DIR, file), "utf-8"),
      ) as PeertubeChannel;
    } catch {
      continue;
    }

    const items = (feed.items ?? []).slice(0, 25);
    for (const item of items) {
      const description = item.content_html
        ? stripHtml(item.content_html)
        : (item.summary ?? "");
      results.push({
        title: item.title ?? "(sans titre)",
        date: item.date_published ?? item.date_modified ?? "",
        url: item.url ?? item.id ?? "",
        channel: channelName,
        description,
      });
    }
  }

  results.sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );

  return results;
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const searchVideosTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_videos",
    description:
      "Recherche des vidéos PeerTube de la communauté beta.gouv.fr par sujet, titre ou chaîne via recherche hybride (sémantique + mots-clés).",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Requête en langage naturel, ex: 'bluehats accessibilité', 'retour d'expérience produit'",
        },
        top_k: {
          type: "integer",
          description: "Nombre de résultats (défaut: 5)",
          default: 5,
        },
      },
      required: ["query"],
    },
  },
};

const getVideosTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_videos",
    description:
      "Retourne les vidéos récentes de la communauté beta.gouv.fr sur PeerTube.",
    parameters: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description:
            "Nom de la chaîne (ex: bluehats, animation_beta). Omis = toutes les chaînes.",
        },
      },
    },
  },
};

export const tools = [searchVideosTool, getVideosTool];

export const handlers: Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
> = {
  search_videos: (args) =>
    search_videos(args["query"] as string, (args["top_k"] as number) ?? 5),
  get_videos: (args) => get_videos(args["channel"] as string | undefined),
};

export function reset(): void {
  matrix = null;
  bm25 = null;
  indexEntries = null;
}
