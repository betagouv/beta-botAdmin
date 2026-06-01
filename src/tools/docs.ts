import fs from "fs";
import path from "path";
import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { config } from "../config.js";
import { embedText, loadBin } from "../embed.js";
import { loadBM25Index, hybridSearch } from "../search.js";

const DATA = config.dataDir;
const DOCS_DIR = path.join(DATA, "doc.incubateur.net");
const DIMS = config.openai.embedDims;

interface DocChunk {
  path: string;
  title: string;
  breadcrumb: string;
  excerpt: string;
}

// Lazy-loaded
let matrix: Float32Array | null = null;
let bm25: unknown = null;
let indexEntries: DocChunk[] | null = null;

async function ensureLoaded() {
  if (matrix) return;
  matrix = loadBin(path.join(DOCS_DIR, "docs.embeddings.bin"), DIMS);
  bm25 = await loadBM25Index(path.join(DOCS_DIR, "docs.bm25.json"));
  indexEntries = JSON.parse(
    fs.readFileSync(path.join(DOCS_DIR, "docs.index.json"), "utf-8"),
  ) as DocChunk[];
}

async function search_docs(
  query: string,
  top_k = 5,
): Promise<Array<DocChunk & { score: number }>> {
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

async function get_doc_page(docPath: string): Promise<string> {
  const fullPath = path.join(DOCS_DIR, docPath);
  if (!fs.existsSync(fullPath))
    return `Erreur: la page "${docPath}" n'existe pas. Utilise uniquement les chemins retournés par search_docs.`;
  const content = fs.readFileSync(fullPath, "utf-8");
  // Strip GitBook blocks for cleaner output
  return content
    .replace(/\{%.*?%\}/gs, "")
    .replace(/\s*<a\s[^>]*><\/a>/g, "")
    .trim();
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const searchDocsTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_docs",
    description:
      "Recherche dans la documentation de la communauté beta.gouv.fr (doc.incubateur.net). Utilise get_doc_page pour récupérer le contenu complet d'un résultat. Methodologie, Culture, Processes, Marchés, Services et outils, Contacts, équipes et référent.e.s pour la communauté...",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Requête en langage naturel, ex: 'comment recruter un développeur'",
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

const getDocPageTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_doc_page",
    description:
      "Récupère le contenu complet d'une page de documentation doc.incubateur.net par son chemin relatif. À utiliser UNIQUEMENT avec les chemins retournés par search_docs.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Chemin relatif retourné par search_docs (ex: gerer-son-produit/README.md)",
        },
      },
      required: ["path"],
    },
  },
};

export const tools = [searchDocsTool, getDocPageTool];

export const handlers: Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
> = {
  search_docs: (args) =>
    search_docs(args["query"] as string, (args["top_k"] as number) ?? 5),
  get_doc_page: (args) => get_doc_page(args["path"] as string),
};

export function reset(): void {
  matrix = null;
  bm25 = null;
  indexEntries = null;
}
