import fs from "fs";
import path from "path";
import { config } from "./config.js";
import { reset as membersReset } from "./tools/members.js";
import { reset as startupsReset } from "./tools/startups.js";
import { reset as reposReset } from "./tools/repos.js";
import { reset as docsReset } from "./tools/docs.js";
import { reset as videosReset } from "./tools/videos.js";
import { reset as incubatorsReset } from "./tools/incubators.js";

const FILE_MAP: Record<string, () => void> = {
  "index/members.embeddings.bin":  membersReset,
  "index/members.bm25.json":       membersReset,
  "index/members.json":            membersReset,
  "index/startups.embeddings.bin": startupsReset,
  "index/startups.bm25.json":      startupsReset,
  "index/startups.json":           startupsReset,
  "gitscan/repos.embeddings.bin":  reposReset,
  "gitscan/repos.bm25.json":       reposReset,
  "gitscan/repos.index.json":      reposReset,
  "doc.incubateur.net/docs.embeddings.bin": docsReset,
  "doc.incubateur.net/docs.bm25.json":      docsReset,
  "doc.incubateur.net/docs.index.json":     docsReset,
  "peertube/videos.embeddings.bin": videosReset,
  "peertube/videos.bm25.json":      videosReset,
  "peertube/videos.index.json":     videosReset,
  "API/incubators.embeddings.bin":  incubatorsReset,
  "API/incubators.bm25.json":       incubatorsReset,
  "API/incubators.index.json":      incubatorsReset,
};

const DEBOUNCE_MS = 2000;

export function startWatcher(): void {
  const dataDir = path.resolve(config.dataDir);
  if (!fs.existsSync(dataDir)) {
    console.warn(`[watcher] dataDir not found, skipping: ${dataDir}`);
    return;
  }

  const timers = new Map<() => void, ReturnType<typeof setTimeout>>();

  const watcher = fs.watch(dataDir, { recursive: true }, (_evt, filename) => {
    if (!filename) return;
    const rel = filename.split(path.sep).join("/");
    const resetFn = FILE_MAP[rel];
    if (!resetFn) return;

    const existing = timers.get(resetFn);
    if (existing !== undefined) clearTimeout(existing);
    timers.set(resetFn, setTimeout(() => {
      timers.delete(resetFn);
      resetFn();
      console.log(`[watcher] index reset: ${rel}`);
    }, DEBOUNCE_MS));
  });

  watcher.on("error", (err) => console.error("[watcher] error:", err));
  console.log(`[watcher] watching ${dataDir}`);
}
