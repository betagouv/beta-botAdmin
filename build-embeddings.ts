import fs from "fs";
import path from "path";
import { embedBatch, saveBin } from "./src/embed.js";
import { buildBM25Index, saveBM25Index } from "./src/search.js";
import { parseFrontmatter, extractSections } from "./src/markdown.js";

const DATA_DIR = process.env["DATA_DIR"] ?? "./data";
const FORCE = process.argv.includes("--force");

function shouldSkip(binPath: string): boolean {
  if (FORCE) return false;
  if (fs.existsSync(binPath)) {
    console.log(`  ↩ Already exists, skipping (use --force to rebuild)`);
    return true;
  }
  return false;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface MemberEntry {
  id: string;
  fullname: string;
  role: string;
  domaine: string;
  competences: string[];
}

interface StartupEntry {
  id: string;
  name: string;
  description: string;
  active_member_count: number;
}

interface RepoEntry {
  org: string;
  repo: string;
  name: string;
  description: string;
  language: string;
  tags: string[];
}

interface DocChunk {
  path: string;
  title: string;
  breadcrumb: string;
  excerpt: string;
}

interface IncubatorEntry {
  id: string;
  title: string;
  contact: string;
  website: string | null;
  github: string | null;
  startup_count: number;
  startups_summary: string;
}

interface RawIncubatorStartup {
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
  startups: RawIncubatorStartup[];
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
  items?: PeertubeItem[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function excerpt(text: string, maxLen = 200): string {
  return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ─── Job 1: Members ───────────────────────────────────────────────────────────

async function buildMembersEmbeddings() {
  console.log("\n[1/6] Building members embeddings…");
  if (shouldSkip(path.join(DATA_DIR, "index/members.embeddings.bin"))) return;
  const members = readJson<MemberEntry[]>(
    path.join(DATA_DIR, "index/members.json")
  );

  const texts = members.map(
    (m) =>
      `${m.fullname}, ${m.role}, domaine ${m.domaine}. Compétences: ${
        (m.competences ?? []).join(", ") || "non renseignées"
      }`
  );

  const vecs = await embedBatch(texts);
  saveBin(vecs, path.join(DATA_DIR, "index/members.embeddings.bin"));

  const bm25 = await buildBM25Index(texts);
  saveBM25Index(bm25, path.join(DATA_DIR, "index/members.bm25.json"));

  console.log(`  ✓ ${members.length} members embedded`);
}

// ─── Job 2: Startups index ───────────────────────────────────────────────────

async function buildStartupsEmbeddings() {
  console.log("\n[2/6] Building startups index embeddings…");
  if (shouldSkip(path.join(DATA_DIR, "index/startups.embeddings.bin"))) return;
  const startups = readJson<StartupEntry[]>(
    path.join(DATA_DIR, "index/startups.json")
  );

  const texts = startups.map((s) => `${s.name}: ${s.description}`);
  const vecs = await embedBatch(texts);
  saveBin(vecs, path.join(DATA_DIR, "index/startups.embeddings.bin"));

  const bm25 = await buildBM25Index(texts);
  saveBM25Index(bm25, path.join(DATA_DIR, "index/startups.bm25.json"));

  console.log(`  ✓ ${startups.length} startups embedded`);
}

// ─── Job 3: Gitscan repos ────────────────────────────────────────────────────

async function buildReposEmbeddings() {
  console.log("\n[3/6] Building gitscan repos embeddings…");
  if (shouldSkip(path.join(DATA_DIR, "gitscan/repos.embeddings.bin"))) return;
  const reposDir = path.join(DATA_DIR, "gitscan/repos");
  const entries: RepoEntry[] = [];
  const texts: string[] = [];

  const orgs = fs.readdirSync(reposDir).filter((f) => {
    try {
      return fs.statSync(path.join(reposDir, f)).isDirectory();
    } catch {
      return false;
    }
  });

  for (const org of orgs) {
    const orgDir = path.join(reposDir, org);
    const repos = fs.readdirSync(orgDir).filter((f) => {
      try {
        return fs.statSync(path.join(orgDir, f)).isDirectory();
      } catch {
        return false;
      }
    });

    for (const repo of repos) {
      const overviewPath = path.join(orgDir, repo, "overview.json");
      if (!fs.existsSync(overviewPath)) continue;

      try {
        const ov = readJson<{
          name: string;
          description: string;
          language: string;
          tags: string[];
          features: string[];
          audience: string;
        }>(overviewPath);

        const text =
          `${ov.name} (${org}): ${ov.description ?? ""}. ` +
          `Language: ${ov.language ?? ""}. ` +
          `Tags: ${(ov.tags ?? []).join(", ")}. ` +
          `Features: ${(ov.features ?? []).join(", ")}. ` +
          `Audience: ${ov.audience ?? ""}`;

        entries.push({
          org,
          repo,
          name: ov.name,
          description: ov.description ?? "",
          language: ov.language ?? "",
          tags: ov.tags ?? [],
        });
        texts.push(text);
      } catch {
        // Skip repos with broken overview.json
      }
    }
  }

  const vecs = await embedBatch(texts);
  saveBin(vecs, path.join(DATA_DIR, "gitscan/repos.embeddings.bin"));

  const bm25 = await buildBM25Index(texts);
  saveBM25Index(bm25, path.join(DATA_DIR, "gitscan/repos.bm25.json"));
  writeJson(path.join(DATA_DIR, "gitscan/repos.index.json"), entries);

  console.log(`  ✓ ${entries.length} repos embedded`);
}

// ─── Job 4: Docs ─────────────────────────────────────────────────────────────

async function buildDocsEmbeddings() {
  console.log("\n[4/6] Building docs embeddings…");
  if (shouldSkip(path.join(DATA_DIR, "doc.incubateur.net/docs.embeddings.bin"))) return;
  const docsDir = path.join(DATA_DIR, "doc.incubateur.net");
  const chunks: DocChunk[] = [];
  const texts: string[] = [];

  function walkDir(dir: string) {
    for (const entry of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.endsWith(".md")) {
        processDocFile(fullPath);
      }
    }
  }

  function processDocFile(filePath: string) {
    const relativePath = path.relative(docsDir, filePath);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      return;
    }

    const { data: fm } = parseFrontmatter(content);
    const pageTitle =
      (fm["title"] as string | undefined) ??
      path.basename(filePath, ".md");

    // Intro chunk from front matter description
    if (fm["description"]) {
      const desc = String(fm["description"]);
      chunks.push({
        path: relativePath,
        title: pageTitle,
        breadcrumb: pageTitle,
        excerpt: excerpt(desc),
      });
      texts.push(`[${pageTitle}]\n${desc}`);
    }

    // Section chunks
    const sections = extractSections(content);
    for (const section of sections) {
      if (section.content.length < 30) continue;
      chunks.push({
        path: relativePath,
        title: pageTitle,
        breadcrumb: section.breadcrumb,
        excerpt: excerpt(section.content),
      });
      texts.push(`[${section.breadcrumb}]\n${section.content}`);
    }
  }

  walkDir(docsDir);

  if (texts.length === 0) {
    console.log("  ⚠ No doc files found, skipping");
    return;
  }

  const vecs = await embedBatch(texts);
  saveBin(vecs, path.join(docsDir, "docs.embeddings.bin"));

  const bm25 = await buildBM25Index(texts);
  saveBM25Index(bm25, path.join(docsDir, "docs.bm25.json"));
  writeJson(path.join(docsDir, "docs.index.json"), chunks);

  console.log(`  ✓ ${chunks.length} doc chunks embedded`);
}

// ─── Job 5: PeerTube videos ───────────────────────────────────────────────────

async function buildVideosEmbeddings() {
  console.log("\n[5/6] Building PeerTube videos embeddings…");
  const peertubeDir = path.join(DATA_DIR, "peertube");
  const outputBin = path.join(peertubeDir, "videos.embeddings.bin");
  if (shouldSkip(outputBin)) return;

  if (!fs.existsSync(peertubeDir)) {
    console.log("  ⚠ peertube directory not found, skipping");
    return;
  }

  const files = fs
    .readdirSync(peertubeDir)
    .filter((f) => f.endsWith(".json") && f !== "videos.index.json");

  const chunks: VideoChunk[] = [];
  const texts: string[] = [];

  for (const file of files) {
    const channelName = path.basename(file, ".json");
    let feed: PeertubeChannel;
    try {
      feed = readJson<PeertubeChannel>(path.join(peertubeDir, file));
    } catch {
      continue;
    }

    for (const item of feed.items ?? []) {
      const title = item.title ?? "(sans titre)";
      const url = item.url ?? item.id ?? "";
      const date = item.date_published ?? "";
      const description = item.content_html
        ? stripHtml(item.content_html)
        : (item.summary ?? "");
      chunks.push({ title, channel: channelName, url, date, description });
      texts.push(description ? `[${channelName}] ${title}\n${description}` : `[${channelName}] ${title}`);
    }
  }

  if (texts.length === 0) {
    console.log("  ⚠ No videos found, skipping");
    return;
  }

  const vecs = await embedBatch(texts);
  saveBin(vecs, outputBin);

  const bm25 = await buildBM25Index(texts);
  saveBM25Index(bm25, path.join(peertubeDir, "videos.bm25.json"));
  writeJson(path.join(peertubeDir, "videos.index.json"), chunks);

  console.log(`  ✓ ${chunks.length} videos embedded`);
}

// ─── Job 6: Incubators ───────────────────────────────────────────────────────

async function buildIncubatorsEmbeddings() {
  console.log("\n[6/6] Building incubators embeddings…");
  const outputBin = path.join(DATA_DIR, "API/incubators.embeddings.bin");
  if (shouldSkip(outputBin)) return;

  const raw = readJson<Record<string, RawIncubator>>(
    path.join(DATA_DIR, "API/incubators.json")
  );

  const entries: IncubatorEntry[] = [];
  const texts: string[] = [];

  for (const [id, incubator] of Object.entries(raw)) {
    const startupNames = incubator.startups
      .slice(0, 10)
      .map((s) => s.name)
      .join(", ");
    const summary =
      incubator.startups.length > 10
        ? `${startupNames}… (${incubator.startups.length} startups)`
        : startupNames;

    entries.push({
      id,
      title: incubator.title,
      contact: incubator.contact,
      website: incubator.website,
      github: incubator.github,
      startup_count: incubator.startups.length,
      startups_summary: summary,
    });

    texts.push(`${incubator.title} — startups: ${summary}`);
  }

  const vecs = await embedBatch(texts);
  saveBin(vecs, outputBin);

  const bm25 = await buildBM25Index(texts);
  saveBM25Index(bm25, path.join(DATA_DIR, "API/incubators.bm25.json"));
  writeJson(path.join(DATA_DIR, "API/incubators.index.json"), entries);

  console.log(`  ✓ ${entries.length} incubators embedded`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("betabot — build-embeddings");
  console.log("===========================");
  const t0 = Date.now();

  await buildMembersEmbeddings();
  await buildStartupsEmbeddings();
  await buildReposEmbeddings();
  await buildDocsEmbeddings();
  await buildVideosEmbeddings();
  await buildIncubatorsEmbeddings();

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
