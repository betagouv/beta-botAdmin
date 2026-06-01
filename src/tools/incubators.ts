import fs from "fs";
import path from "path";
import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { config } from "../config.js";
import { embedText, loadBin } from "../embed.js";
import { loadBM25Index, hybridSearch } from "../search.js";

const DATA = config.dataDir;
const API_DIR = path.join(DATA, "API");
const DIMS = config.openai.embedDims;

interface IncubatorEntry {
  id: string;
  title: string;
  contact: string;
  website: string | null;
  github: string | null;
  startup_count: number;
  startups_summary: string;
}

interface RawStartupRef {
  id: string;
  name: string;
  pitch: string;
  repository: string | null;
  contact: string;
  phases: Array<{ name: string; start: string }>;
}

interface RawIncubator {
  title: string;
  owner: string;
  contact: string;
  address: string | null;
  website: string | null;
  github: string | null;
  startups: RawStartupRef[];
}

// Lazy-loaded
let matrix: Float32Array | null = null;
let bm25: unknown = null;
let indexEntries: IncubatorEntry[] | null = null;

async function ensureLoaded() {
  if (matrix) return;
  matrix = loadBin(path.join(API_DIR, "incubators.embeddings.bin"), DIMS);
  bm25 = await loadBM25Index(path.join(API_DIR, "incubators.bm25.json"));
  indexEntries = JSON.parse(
    fs.readFileSync(path.join(API_DIR, "incubators.index.json"), "utf-8"),
  ) as IncubatorEntry[];
}

async function search_incubators(
  query: string,
  top_k = 5,
): Promise<Array<IncubatorEntry & { score: number }>> {
  await ensureLoaded();
  const queryVec = await embedText(query);
  return hybridSearch(
    query,
    queryVec,
    matrix!,
    bm25,
    indexEntries!,
    DIMS,
    top_k,
  );
}

async function get_incubator_detail(
  id: string,
): Promise<Record<string, unknown> | null> {
  const all = JSON.parse(
    fs.readFileSync(path.join(API_DIR, "incubators.json"), "utf-8"),
  ) as Record<string, RawIncubator>;

  const incubator = all[id];
  if (!incubator) return null;

  return {
    id,
    title: incubator.title,
    owner: incubator.owner,
    contact: incubator.contact,
    address: incubator.address,
    website: incubator.website,
    github: incubator.github,
    startup_count: incubator.startups.length,
    startups: incubator.startups.map((s) => ({
      id: s.id,
      name: s.name,
      pitch: s.pitch,
      contact: s.contact,
      repository: s.repository,
      phases: s.phases,
    })),
  };
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const searchIncubatorsTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_incubators",
    description:
      "Recherche un incubateur de la communauté beta.gouv.fr par nom, thème ou ministère. Utilise get_incubator_detail pour récupérer la liste complète des startups d'un incubateur.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Requête en langage naturel, ex: 'incubateur éducation nationale' ou 'DINUM'",
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

const getIncubatorDetailTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_incubator_detail",
    description:
      "Retourne les détails complets d'un incubateur (liste de startups incluse). Pour les détails d'une startup individuelle, utiliser get_startup_detail.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "Identifiant de l'incubateur, issu de search_incubators (ex: dinum, menj, anct)",
        },
      },
      required: ["id"],
    },
  },
};

export const tools = [searchIncubatorsTool, getIncubatorDetailTool];

export const handlers: Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
> = {
  search_incubators: (args) =>
    search_incubators(args["query"] as string, (args["top_k"] as number) ?? 5),
  get_incubator_detail: (args) =>
    get_incubator_detail(args["id"] as string),
};

export function reset(): void {
  matrix = null;
  bm25 = null;
  indexEntries = null;
}
