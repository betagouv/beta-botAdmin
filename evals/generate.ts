/**
 * Generates evals/fixtures.json from the current datasets.
 * Run after ./get-data.sh so data/ is populated.
 *
 * Usage: npm run eval:generate
 */
import fs from "fs";
import path from "path";
import { parseFrontmatter } from "../src/markdown.js";

const DATA_DIR = process.env["DATA_DIR"] ?? "./data";
const OUT = "evals/fixtures.json";
const N = 5; // questions sampled per category

interface Fixture {
  id: string;
  question: string;
  expect_tools: string[];
}

function sample<T>(arr: T[], n: number): T[] {
  return [...arr].sort(() => Math.random() - 0.5).slice(0, n);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

function walkMd(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) out.push(...walkMd(full));
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

const fixtures: Fixture[] = [];
const counts: Record<string, number> = {};

function add(f: Fixture, category: string) {
  fixtures.push(f);
  counts[category] = (counts[category] ?? 0) + 1;
}

// ─── Members ──────────────────────────────────────────────────────────────────

const membersFile = path.join(DATA_DIR, "index/members.json");
if (fs.existsSync(membersFile)) {
  const members = JSON.parse(fs.readFileSync(membersFile, "utf-8")) as Array<{
    fullname: string;
    domaine: string;
    competences: string[];
  }>;

  // Skill questions — deduplicate competences (case-insensitive), sample N
  const competences = [
    ...new Map(
      members.flatMap((m) => m.competences ?? []).filter(Boolean).map((c) => [c.toLowerCase(), c])
    ).values(),
  ];
  for (const c of sample(competences, N)) {
    add({ id: `member-skill-${slug(c)}`, question: `qui sait faire du ${c} ?`, expect_tools: ["search_members"] }, "members");
  }

  // Domain questions
  const domains = [...new Set(members.map((m) => m.domaine).filter(Boolean))];
  for (const d of sample(domains, N)) {
    add({ id: `member-domain-${slug(d)}`, question: `qui travaille dans le domaine ${d} ?`, expect_tools: ["search_members"] }, "members");
  }

  // Detail questions — expect search then profile fetch
  const namedMembers = members.filter((m) => m.fullname?.trim());
  for (const m of sample(namedMembers, N)) {
    add({
      id: `member-detail-${slug(m.fullname)}`,
      question: `quel est le rôle de ${m.fullname} et sur quelles startups travaille-t-il/elle ?`,
      expect_tools: ["search_members", "get_member_startups"],
    }, "members");
  }
} else {
  console.warn(`⚠ ${membersFile} not found — skipping member questions`);
}

// ─── Startups ─────────────────────────────────────────────────────────────────

const startupsFile = path.join(DATA_DIR, "index/startups.json");
if (fs.existsSync(startupsFile)) {
  const startups = JSON.parse(fs.readFileSync(startupsFile, "utf-8")) as Array<{
    id: string;
    name: string;
  }>;

  for (const s of sample(startups, N)) {
    add({ id: `startup-about-${s.id}`, question: `que fait la startup ${s.name} ?`, expect_tools: ["search_startups"] }, "startups");
  }
  for (const s of sample(startups, N)) {
    add({
      id: `startup-team-${s.id}`,
      question: `qui est dans l'équipe de ${s.name} ?`,
      expect_tools: ["search_startups", "get_startup_members"],
    }, "startups");
  }
} else {
  console.warn(`⚠ ${startupsFile} not found — skipping startup questions`);
}

// ─── Pages ────────────────────────────────────────────────────────────────────

const pagesDir = path.join(DATA_DIR, "beta.gouv.fr/_pages");
for (const filePath of sample(walkMd(pagesDir), N)) {
  const { data: fm } = parseFrontmatter(fs.readFileSync(filePath, "utf-8"));
  const title = (fm["title"] as string | undefined) ?? path.basename(filePath, ".md");
  const rel = path.relative(pagesDir, filePath);
  add(
    { id: `page-${slug(rel)}`, question: `c'est quoi "${title}" chez beta.gouv.fr ?`, expect_tools: ["search_pages"] },
    "pages"
  );
}

// ─── Docs ─────────────────────────────────────────────────────────────────────

const docsDir = path.join(DATA_DIR, "doc.incubateur.net");
for (const filePath of sample(walkMd(docsDir), N)) {
  const { data: fm } = parseFrontmatter(fs.readFileSync(filePath, "utf-8"));
  const title = (fm["title"] as string | undefined) ?? path.basename(filePath, ".md");
  if (title.length > 3) {
    add(
      { id: `doc-${slug(title)}`, question: `comment ${title.toLowerCase()} selon la documentation ?`, expect_tools: ["search_docs"] },
      "docs"
    );
  }
}

// ─── Static (calendar, videos, no-tool) ──────────────────────────────────────

const statics: Fixture[] = [
  { id: "calendar-next",    question: "quels sont les prochains événements de la communauté ?", expect_tools: ["get_calendar"] },
  { id: "calendar-week",    question: "y a-t-il des événements beta.gouv.fr cette semaine ?",   expect_tools: ["get_calendar"] },
  { id: "videos-recent",    question: "quelles sont les dernières vidéos publiées ?",            expect_tools: ["get_videos"] },
  { id: "videos-bluehats",  question: "quelles vidéos récentes sur les BlueHats ?",             expect_tools: ["get_videos"] },
  { id: "no-tool-greeting", question: "bonjour !",                                              expect_tools: [] },
  { id: "no-tool-thanks",   question: "merci pour ta réponse !",                                expect_tools: [] },
];
for (const f of statics) add(f, "static");

// ─── Write ────────────────────────────────────────────────────────────────────

fs.mkdirSync("evals", { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(fixtures, null, 2));

console.log(`✓ ${fixtures.length} fixtures → ${OUT}`);
for (const [cat, n] of Object.entries(counts)) {
  console.log(`  ${cat.padEnd(12)} ${n}`);
}
