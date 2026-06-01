import fs from "fs";
import path from "path";
import { config } from "../config.js";

export interface HistoryEntry {
  ts: number;
  user: string;
  room: string;
  kind: "slash" | "mention";
  text: string;
  status: "ok" | "refused" | "unknown" | "error";
  detail?: string;
}

const MAX_ENTRIES = 1000;

function filePath(): string {
  return path.join(config.dataDir, "command-history.json");
}

let cache: HistoryEntry[] | null = null;

function load(): HistoryEntry[] {
  if (cache !== null) return cache;
  try {
    const raw = fs.readFileSync(filePath(), "utf-8");
    const parsed = JSON.parse(raw) as HistoryEntry[];
    cache = Array.isArray(parsed) ? parsed : [];
  } catch {
    cache = [];
  }
  return cache;
}

function save(): void {
  if (!cache) return;
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error("[history] save failed:", err);
  }
}

export function record(entry: Omit<HistoryEntry, "ts">): void {
  const all = load();
  all.push({ ts: Date.now(), ...entry });
  while (all.length > MAX_ENTRIES) all.shift();
  cache = all;
  save();
}

export function query(
  filter?: string | undefined,
  limit = 20,
): HistoryEntry[] {
  const all = load();
  const f = (filter ?? "").trim().toLowerCase();
  const filtered = f
    ? all.filter(
        (e) =>
          e.text.toLowerCase().includes(f) ||
          e.user.toLowerCase().includes(f) ||
          e.status.toLowerCase() === f ||
          e.kind.toLowerCase() === f,
      )
    : all;
  return filtered.slice(-limit).reverse();
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function statusIcon(s: HistoryEntry["status"]): string {
  switch (s) {
    case "ok":
      return "✅";
    case "refused":
      return "⛔";
    case "unknown":
      return "❓";
    case "error":
      return "❌";
  }
}

export function formatHistory(
  entries: HistoryEntry[],
  filter: string | undefined,
): string {
  const header = filter
    ? `📜 **Historique** (filtre: \`${filter}\`) — ${entries.length} entrée(s)`
    : `📜 **Historique** — ${entries.length} dernière(s) entrée(s)`;
  if (entries.length === 0) {
    return `${header}\n\n_(aucune entrée trouvée)_`;
  }
  const lines = entries.map((e) => {
    const shortText = e.text.length > 80 ? e.text.slice(0, 77) + "…" : e.text;
    const userShort = e.user.split(":")[0] ?? e.user;
    return `- ${statusIcon(e.status)} \`${formatTime(e.ts)}\` ${e.kind} **${userShort}** : \`${shortText}\`${e.detail ? ` _(${e.detail})_` : ""}`;
  });
  return `${header}\n\n${lines.join("\n")}`;
}
