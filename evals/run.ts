import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { config } from "../src/config.js";
import { tools as memberTools } from "../src/tools/members.js";
import { tools as startupTools } from "../src/tools/startups.js";
import { tools as repoTools } from "../src/tools/repos.js";
import { tools as docTools } from "../src/tools/docs.js";
import { tools as pageTools } from "../src/tools/pages.js";
import { tools as calendarTools } from "../src/tools/calendar.js";
import { tools as videoTools } from "../src/tools/videos.js";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions.js";

const ALL_TOOLS: ChatCompletionTool[] = [
  ...memberTools,
  ...startupTools,
  ...repoTools,
  ...docTools,
  ...pageTools,
  ...calendarTools,
  ...videoTools,
];

// Same prompt as orchestrator — divergence here is a signal something changed
const SYSTEM_PROMPT = `Tu es l'assistant de la communauté beta.gouv.fr. Tu réponds en français.
Tu as accès à des outils pour chercher des membres, des startups, des dépôts de code,
de la documentation et des actualités. Utilise toujours les outils pour répondre
aux questions factuelles. Ne devine pas les noms ou les données.`;

// Minimal realistic canned responses — enough for the LLM to stop looping.
// We test tool routing, not actual results quality.
const CANNED: Record<string, unknown> = {
  search_members: [
    { id: "dupont.marie", fullname: "Marie Dupont", role: "développeuse", domaine: "Santé", competences: ["Python"], score: 0.9 },
  ],
  search_startups: [
    { id: "test-startup", name: "TestStartup", description: "Service numérique de test.", active_member_count: 3, score: 0.9 },
  ],
  search_docs: [
    { path: "test/doc.md", title: "Documentation test", breadcrumb: "Test", excerpt: "Contenu de test.", score: 0.9 },
  ],
  search_pages: [
    { path: "manifeste.md", title: "Manifeste beta.gouv.fr", breadcrumb: "Manifeste > Introduction", excerpt: "Nouvelle manière de concevoir l'action publique.", score: 0.9 },
  ],
  search_repos: [
    { org: "betagouv", repo: "test", name: "test", description: "Repo de test.", score: 0.9 },
  ],
  get_member_detail: { id: "dupont.marie", fullname: "Marie Dupont", role: "développeuse" },
  get_member_startups: [{ startup_id: "test-startup", startup_name: "TestStartup", status: "active" }],
  get_startup_detail: { id: "test-startup", name: "TestStartup", phases: [{ name: "acceleration" }] },
  get_startup_members: [{ id: "dupont.marie", fullname: "Marie Dupont", role: "développeuse" }],
  get_repo_detail: { name: "test", description: "Repo de test.", language: "TypeScript" },
  get_doc_page: "Contenu de la page de documentation.",
  get_page: "Contenu de la page institutionnelle.",
  get_calendar: [{ summary: "Réunion communauté beta.gouv.fr", start: new Date().toISOString() }],
  get_videos: [{ title: "Vidéo communauté", channel: "bluehats", url: "https://tube.numerique.gouv.fr/w/test" }],
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface Fixture {
  id: string;
  question: string;
  // All tools that must appear in the call log. Empty array = no tool expected.
  expect_tools: string[];
}

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

interface CaseResult {
  id: string;
  question: string;
  expect_tools: string[];
  first_tool: string | null;
  tools: ToolCall[];
  pass: boolean;
  response_chars: number;
}

interface RunResult {
  timestamp: string;
  git: string;
  model: string;
  pass: number;
  total: number;
  cases: CaseResult[];
}

// ─── Eval loop ────────────────────────────────────────────────────────────────

async function runCase(
  client: OpenAI,
  question: string
): Promise<{ tools: ToolCall[]; response: string }> {
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: question },
  ];
  const toolLog: ToolCall[] = [];

  for (let i = 0; i < 5; i++) {
    const resp = await client.chat.completions.create({
      model: config.openai.model,
      messages,
      tools: ALL_TOOLS,
      tool_choice: "auto",
    });
    const msg = resp.choices[0]?.message;
    if (!msg) break;
    messages.push(msg as ChatCompletionMessageParam);

    if (!msg.tool_calls?.length) {
      return { tools: toolLog, response: msg.content ?? "" };
    }

    for (const tc of msg.tool_calls) {
      const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      toolLog.push({ name: tc.function.name, args });
      const result = CANNED[tc.function.name] ?? { error: `no canned response for ${tc.function.name}` };
      messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  return { tools: toolLog, response: "" };
}

// ─── Compare ──────────────────────────────────────────────────────────────────

function findLatest(): string | null {
  const dir = "evals/results";
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  return files.length ? path.join(dir, files[files.length - 1]) : null;
}

function printDiff(current: RunResult, prevPath: string) {
  if (!fs.existsSync(prevPath)) {
    console.log(`\n⚠ compare file not found: ${prevPath}`);
    return;
  }
  const prev = JSON.parse(fs.readFileSync(prevPath, "utf-8")) as RunResult;
  const prevById = new Map(prev.cases.map((c) => [c.id, c]));

  const regressions = current.cases.filter((c) => !c.pass && prevById.get(c.id)?.pass);
  const improvements = current.cases.filter((c) => c.pass && prevById.has(c.id) && !prevById.get(c.id)!.pass);

  console.log(`\n── vs ${path.basename(prevPath)}  (${prev.model} @ ${prev.git}) ──`);
  if (regressions.length) {
    console.log(`  Regressions (${regressions.length}):`);
    for (const c of regressions) {
      const prev = prevById.get(c.id);
      const wasTools = prev?.tools.map((t) => t.name) ?? [];
      const nowTools = c.tools.map((t) => t.name);
      console.log(`    ✗ ${c.id}`);
      console.log(`        was=[${wasTools.join(", ") || "none"}]  now=[${nowTools.join(", ") || "none"}]`);
    }
  }
  if (improvements.length) {
    console.log(`  Improvements (${improvements.length}):`);
    for (const c of improvements) {
      const prev = prevById.get(c.id);
      const wasTools = prev?.tools.map((t) => t.name) ?? [];
      const nowTools = c.tools.map((t) => t.name);
      console.log(`    ✓ ${c.id}`);
      console.log(`        was=[${wasTools.join(", ") || "none"}]  now=[${nowTools.join(", ") || "none"}]`);
    }
  }
  if (!regressions.length && !improvements.length) console.log("  No routing changes.");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const compareIdx = argv.indexOf("--compare");
  const compareArg = compareIdx !== -1 ? argv[compareIdx + 1] : null;
  const comparePath = compareArg === "latest" ? findLatest() : compareArg;

  const fixturesPath = "evals/fixtures.json";
  if (!fs.existsSync(fixturesPath)) {
    console.error("evals/fixtures.json not found — run: npm run eval:generate");
    process.exit(1);
  }
  const fixtures = JSON.parse(fs.readFileSync(fixturesPath, "utf-8")) as Fixture[];

  const client = new OpenAI({ baseURL: config.openai.baseUrl, apiKey: config.openai.apiKey });

  let git = "unknown";
  try { git = execSync("git rev-parse --short HEAD").toString().trim(); } catch { /* no git */ }

  const run: RunResult = {
    timestamp: new Date().toISOString(),
    git,
    model: config.openai.model,
    pass: 0,
    total: fixtures.length,
    cases: [],
  };

  console.log(`betabot eval — ${fixtures.length} cases  model=${run.model}  git=${run.git}\n`);

  for (const fixture of fixtures) {
    process.stdout.write(`  ${fixture.question.slice(0, 52).padEnd(54)}`);
    const { tools, response } = await runCase(client, fixture.question);
    const toolNames = tools.map((t) => t.name);
    const firstTool = toolNames[0] ?? null;
    const pass = fixture.expect_tools.length === 0
      ? toolNames.length === 0
      : fixture.expect_tools.every((t) => toolNames.includes(t));
    if (pass) run.pass++;

    run.cases.push({
      id: fixture.id,
      question: fixture.question,
      expect_tools: fixture.expect_tools,
      first_tool: firstTool,
      tools,
      pass,
      response_chars: response.length,
    });

    const gotLabel = toolNames.length ? `[${toolNames.join(", ")}]` : "no tool";
    if (pass) {
      console.log(`✓  ${gotLabel}`);
    } else {
      const exp = fixture.expect_tools.length ? `[${fixture.expect_tools.join(", ")}]` : "none";
      console.log(`✗  expected=${exp}  got=${gotLabel}`);
    }
  }

  fs.mkdirSync("evals/results", { recursive: true });
  const outFile = `evals/results/${run.timestamp.replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(outFile, JSON.stringify(run, null, 2));

  console.log(`\n${run.pass}/${run.total} passed — ${outFile}`);

  if (comparePath) printDiff(run, comparePath);
}

main().catch((err) => { console.error(err); process.exit(1); });
