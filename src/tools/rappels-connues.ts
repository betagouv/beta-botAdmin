import fs from "fs";
import path from "path";
import { config } from "../config.js";

// Inscriptions the admin need not hear about again: subscribed through the
// proof step, or already reported once by the startup audit (see
// findForeignInscriptions). Kept in data/rappels-connues.json, keyed by user
// and calendar URL — a new URL for the same user is a new inscription.

function filePath(): string {
  return path.join(config.dataDir, "rappels-connues.json");
}

const key = (matrixUserId: string, calDavUrl: string) => `${matrixUserId} ${calDavUrl}`;

let cache: Set<string> | null = null;

function load(): Set<string> {
  if (cache !== null) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), "utf-8")) as unknown;
    cache = new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    cache = new Set();
  }
  return cache;
}

export function isKnownInscription(matrixUserId: string, calDavUrl: string): boolean {
  return load().has(key(matrixUserId, calDavUrl));
}

export function markKnownInscription(matrixUserId: string, calDavUrl: string): void {
  const all = load();
  const k = key(matrixUserId, calDavUrl);
  if (all.has(k)) return;
  all.add(k);
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify([...all], null, 2));
  } catch (err) {
    console.error("[rappels] rappels-connues.json non enregistré :", err);
  }
}
