import fs from "fs";
import path from "path";
import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { config } from "../config.js";
import { embedText, loadBin } from "../embed.js";
import { loadBM25Index, hybridSearch } from "../search.js";

const DATA = config.dataDir;
const DIMS = config.openai.embedDims;

interface StartupIndexEntry {
  id: string;
  name: string;
  description: string;
  active_member_count: number;
}

interface RawStartup {
  id: string;
  attributes: {
    name: string;
    pitch: string;
    phases: Array<{ name: string; start: string; end?: string }>;
    incubator: string;
    content_url_encoded_markdown: string;
    repository?: string;
    contact?: string;
    link?: string;
    stats_url?: string;
    impact_url?: string;
    sponsors?: string[];
    thematiques?: string[];
    technos?: string[];
    accessibility_status?: string;
    events?: Array<{ name: string; date: string; comment?: string }>;
  };
  relationships?: {
    incubator?: { data?: { id: string; type: string } };
  };
}

interface StartupDetail {
  id: string;
  name: string;
  active_members?: string[];
  previous_members?: string[];
  expired_members?: string[];
  repository?: string;
  contact?: string;
  phases?: Array<{ name: string; start: string }>;
}

interface RawMember {
  id: string;
  fullname: string;
  role: string;
  domaine: string;
  competences?: string[];
}

// Lazy-loaded
let matrix: Float32Array | null = null;
let bm25: unknown = null;
let indexEntries: StartupIndexEntry[] | null = null;

async function ensureLoaded() {
  if (matrix) return;
  matrix = loadBin(path.join(DATA, "index/startups.embeddings.bin"), DIMS);
  bm25 = await loadBM25Index(path.join(DATA, "index/startups.bm25.json"));
  indexEntries = JSON.parse(
    fs.readFileSync(path.join(DATA, "index/startups.json"), "utf-8"),
  ) as StartupIndexEntry[];
}

async function search_startups(
  query: string,
  top_k = 10,
): Promise<Array<StartupIndexEntry & { score: number }>> {
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

async function get_startup_detail(
  id: string,
): Promise<Record<string, unknown> | null> {
  const startups = JSON.parse(
    fs.readFileSync(path.join(DATA, "API/startups.json"), "utf-8"),
  ) as { data: RawStartup[] };

  const raw = startups.data.find((s) => s.id === id);

  const details = JSON.parse(
    fs.readFileSync(path.join(DATA, "API/startups_details.json"), "utf-8"),
  ) as Record<string, StartupDetail>;

  const detail = details[id];

  if (!raw && !detail) return null;

  return {
    id,
    name: raw?.attributes.name ?? detail?.name,
    pitch: raw?.attributes.pitch,
    description: decodeURIComponent(
      raw?.attributes.content_url_encoded_markdown || "",
    ),
    link: raw?.attributes.link,
    stats_url: raw?.attributes.stats_url,
    impact_url: raw?.attributes.impact_url,
    repository: raw?.attributes.repository ?? detail?.repository,
    contact: raw?.attributes.contact ?? detail?.contact,
    incubator: raw?.relationships?.incubator?.data?.id ?? raw?.attributes.incubator,
    sponsors: raw?.attributes.sponsors,
    thematiques: raw?.attributes.thematiques,
    technos: raw?.attributes.technos,
    accessibility_status: raw?.attributes.accessibility_status,
    events: raw?.attributes.events,
    phases: raw?.attributes.phases ?? detail?.phases,
    active_member_count: (detail?.active_members ?? []).length,
    active_members: detail?.active_members ?? [],
  };
}

async function get_startup_members(
  id: string,
  include_previous = false,
): Promise<
  Array<{
    id: string;
    fullname: string;
    role: string;
    domaine: string;
    competences: string[];
    status: string;
  }>
> {
  const details = JSON.parse(
    fs.readFileSync(path.join(DATA, "API/startups_details.json"), "utf-8"),
  ) as Record<string, StartupDetail>;

  const detail = details[id];
  if (!detail) return [];

  const memberIds = [
    ...(detail.active_members ?? []).map((m) => ({ id: m, status: "active" })),
    ...(include_previous
      ? (detail.previous_members ?? []).map((m) => ({
          id: m,
          status: "previous",
        }))
      : []),
  ];

  const allMembers = JSON.parse(
    fs.readFileSync(path.join(DATA, "API/members.json"), "utf-8"),
  ) as RawMember[];

  const memberMap = new Map(allMembers.map((m) => [m.id, m]));

  return memberIds
    .map(({ id: memberId, status }) => {
      const m = memberMap.get(memberId);
      if (!m) return null;
      return {
        id: m.id,
        fullname: m.fullname,
        role: m.role,
        domaine: m.domaine,
        competences: m.competences ?? [],
        status,
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const searchStartupsTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_startups",
    description: "Recherche des startups d'État par thème, mission ou phase.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Requête en langage naturel, ex: 'startup sur l'éducation en accélération'",
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

const getStartupDetailTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_startup_detail",
    description:
      "Récupère les détails complets d'une startup par son slug (ex: recosante).",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Slug de la startup, issu de search_startups",
        },
      },
      required: ["id"],
    },
  },
};

const getStartupMembersTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_startup_members",
    description:
      "Retourne les membres actifs (et optionnellement passés) d'une startup.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Slug de la startup",
        },
        include_previous: {
          type: "boolean",
          description: "Inclure les membres passés (défaut: false)",
          default: false,
        },
      },
      required: ["id"],
    },
  },
};

export const tools = [
  searchStartupsTool,
  getStartupDetailTool,
  getStartupMembersTool,
];

export const handlers: Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
> = {
  search_startups: (args) =>
    search_startups(args["query"] as string, (args["top_k"] as number) ?? 10),
  get_startup_detail: (args) => get_startup_detail(args["id"] as string),
  get_startup_members: (args) =>
    get_startup_members(
      args["id"] as string,
      (args["include_previous"] as boolean) ?? false,
    ),
};

export function reset(): void {
  matrix = null;
  bm25 = null;
  indexEntries = null;
}
