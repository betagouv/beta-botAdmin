import fs from "fs";
import path from "path";
import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { config } from "../config.js";
import { embedText, loadBin } from "../embed.js";
import { loadBM25Index, hybridSearch } from "../search.js";

const DATA = config.dataDir;
const DIMS = config.openai.embedDims;

interface MemberIndexEntry {
  id: string;
  fullname: string;
  role: string;
  domaine: string;
  competences: string[];
}

interface RawMember {
  id: string;
  fullname: string;
  role: string;
  domaine: string;
  link: string;
  bio: string;
  github?: string;
  competences?: string[];
  missions?: Array<{
    start: string;
    end: string;
    status: string;
    employer: string;
    startups?: string[];
  }>;
}

// Lazy-loaded embeddings
let matrix: Float32Array | null = null;
let bm25: unknown = null;
let indexEntries: MemberIndexEntry[] | null = null;

async function ensureLoaded() {
  if (matrix) return;
  matrix = loadBin(path.join(DATA, "index/members.embeddings.bin"), DIMS);
  bm25 = await loadBM25Index(path.join(DATA, "index/members.bm25.json"));
  indexEntries = JSON.parse(
    fs.readFileSync(path.join(DATA, "index/members.json"), "utf-8")
  ) as MemberIndexEntry[];
}

async function search_members(
  query: string,
  top_k = 10
): Promise<Array<MemberIndexEntry & { score: number }>> {
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

async function get_member_detail(id: string): Promise<RawMember | null> {
  const members = JSON.parse(
    fs.readFileSync(path.join(DATA, "API/members.json"), "utf-8")
  ) as RawMember[];
  return members.find((m) => m.id === id) ?? null;
}

async function get_member_startups(member_id: string): Promise<
  Array<{ startup_id: string; startup_name: string; status: "active" | "previous" }>
> {
  const details = JSON.parse(
    fs.readFileSync(path.join(DATA, "API/startups_details.json"), "utf-8")
  ) as Record<
    string,
    {
      name: string;
      active_members?: string[];
      previous_members?: string[];
    }
  >;

  const results: Array<{
    startup_id: string;
    startup_name: string;
    status: "active" | "previous";
  }> = [];

  for (const [slug, detail] of Object.entries(details)) {
    if ((detail.active_members ?? []).includes(member_id)) {
      results.push({
        startup_id: slug,
        startup_name: detail.name,
        status: "active",
      });
    } else if ((detail.previous_members ?? []).includes(member_id)) {
      results.push({
        startup_id: slug,
        startup_name: detail.name,
        status: "previous",
      });
    }
  }

  return results;
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const searchMembersTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_members",
    description:
      "Recherche des membres de la communauté beta.gouv.fr par compétences, rôle, domaine ou nom.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Requête en langage naturel, ex: 'développeur PostgreSQL dans la santé'",
        },
        top_k: {
          type: "integer",
          description: "Nombre de résultats à retourner (défaut: 10)",
          default: 10,
        },
      },
      required: ["query"],
    },
  },
};

const getMemberDetailTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_member_detail",
    description:
      "Récupère le profil complet d'un membre par son identifiant (ex: julien.bouquillon).",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "Identifiant du membre (format: prenom.nom), issu de search_members",
        },
      },
      required: ["id"],
    },
  },
};

const getMemberStartupsTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_member_startups",
    description:
      "Retourne les startups sur lesquelles un membre travaille ou a travaillé.",
    parameters: {
      type: "object",
      properties: {
        member_id: {
          type: "string",
          description: "Identifiant du membre (ex: julien.bouquillon)",
        },
      },
      required: ["member_id"],
    },
  },
};

export const tools = [
  searchMembersTool,
  getMemberDetailTool,
  getMemberStartupsTool,
];

export const handlers: Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
> = {
  search_members: (args) =>
    search_members(args["query"] as string, (args["top_k"] as number) ?? 10),
  get_member_detail: (args) => get_member_detail(args["id"] as string),
  get_member_startups: (args) =>
    get_member_startups(args["member_id"] as string),
};

export function reset(): void {
  matrix = null;
  bm25 = null;
  indexEntries = null;
}
