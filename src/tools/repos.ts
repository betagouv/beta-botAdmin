import fs from "fs";
import path from "path";
import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { config } from "../config.js";
import { embedText, loadBin } from "../embed.js";
import { loadBM25Index, hybridSearch } from "../search.js";

const DATA = config.dataDir;
const DIMS = config.openai.embedDims;

interface RepoIndexEntry {
  org: string;
  repo: string;
  name: string;
  description: string;
  language: string;
  tags: string[];
}

// Lazy-loaded
let matrix: Float32Array | null = null;
let bm25: unknown = null;
let indexEntries: RepoIndexEntry[] | null = null;

async function ensureLoaded() {
  if (matrix) return;
  matrix = loadBin(path.join(DATA, "gitscan/repos.embeddings.bin"), DIMS);
  bm25 = await loadBM25Index(path.join(DATA, "gitscan/repos.bm25.json"));
  indexEntries = JSON.parse(
    fs.readFileSync(path.join(DATA, "gitscan/repos.index.json"), "utf-8")
  ) as RepoIndexEntry[];
}

async function search_repos(
  query: string,
  top_k = 10
): Promise<Array<RepoIndexEntry & { score: number }>> {
  await ensureLoaded();
  const queryVec = await embedText(query);
  return hybridSearch(
    query,
    queryVec,
    matrix!,
    bm25,
    indexEntries!,
    DIMS,
    top_k
  );
}

async function get_repo_detail(
  org: string,
  repo: string
): Promise<Record<string, unknown> | null> {
  const repoDir = path.join(DATA, "gitscan/repos", org, repo);

  const overviewPath = path.join(repoDir, "overview.json");
  if (!fs.existsSync(overviewPath)) return null;

  const overview = JSON.parse(fs.readFileSync(overviewPath, "utf-8")) as Record<string, unknown>;

  let commits: string | null = null;
  const commitsPath = path.join(repoDir, "commits.txt");
  if (fs.existsSync(commitsPath)) {
    commits = fs.readFileSync(commitsPath, "utf-8").split("\n").slice(0, 20).join("\n");
  }

  return { ...overview, recent_commits: commits };
}

async function get_repo_changelog(
  org: string,
  repo: string
): Promise<string | null> {
  const changelogPath = path.join(DATA, "gitscan/repos", org, repo, "CHANGELOG-generated.md");
  if (!fs.existsSync(changelogPath)) return null;
  return fs.readFileSync(changelogPath, "utf-8");
}

async function get_org_changelog(org: string): Promise<string | null> {
  const changelogPath = path.join(DATA, "gitscan/repos", org, "CHANGELOG-generated.md");
  if (!fs.existsSync(changelogPath)) return null;
  return fs.readFileSync(changelogPath, "utf-8");
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const searchReposTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_repos",
    description:
      "Recherche des dépôts de code de la communauté beta.gouv.fr par technologie, fonction ou thème.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Requête en langage naturel, ex: 'authentification OAuth backend Python'",
        },
        top_k: {
          type: "integer",
          description: "Nombre de résultats (défaut: 10)",
          default: 10,
        },
      },
      required: ["query"],
    },
  },
};

const getRepoDetailTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_repo_detail",
    description:
      "Récupère les détails d'un dépôt (overview + derniers commits).",
    parameters: {
      type: "object",
      properties: {
        org: {
          type: "string",
          description: "Organisation GitHub (ex: betagouv)",
        },
        repo: {
          type: "string",
          description: "Nom du dépôt",
        },
      },
      required: ["org", "repo"],
    },
  },
};

const getRepoChangelogTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_repo_changelog",
    description:
      "Retourne le changelog généré (CHANGELOG-generated.md) d'un dépôt spécifique, ou null s'il n'existe pas.",
    parameters: {
      type: "object",
      properties: {
        org: {
          type: "string",
          description: "Organisation GitHub (ex: betagouv)",
        },
        repo: {
          type: "string",
          description: "Nom du dépôt",
        },
      },
      required: ["org", "repo"],
    },
  },
};

const getOrgChangelogTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_org_changelog",
    description:
      "Retourne le changelog généré (CHANGELOG-generated.md) d'une organisation GitHub entière, ou null s'il n'existe pas.",
    parameters: {
      type: "object",
      properties: {
        org: {
          type: "string",
          description: "Organisation GitHub (ex: betagouv)",
        },
      },
      required: ["org"],
    },
  },
};

export const tools = [searchReposTool, getRepoDetailTool, getRepoChangelogTool, getOrgChangelogTool];

export const handlers: Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
> = {
  search_repos: (args) =>
    search_repos(args["query"] as string, (args["top_k"] as number) ?? 10),
  get_repo_detail: (args) =>
    get_repo_detail(args["org"] as string, args["repo"] as string),
  get_repo_changelog: (args) =>
    get_repo_changelog(args["org"] as string, args["repo"] as string),
  get_org_changelog: (args) =>
    get_org_changelog(args["org"] as string),
};

export function reset(): void {
  matrix = null;
  bm25 = null;
  indexEntries = null;
}
