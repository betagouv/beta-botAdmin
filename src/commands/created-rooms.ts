import fs from "fs";
import path from "path";
import { config } from "../config.js";

// Persistent list of rooms created by the bot via `/salon create`.
export interface CreatedRoom {
  roomId: string;
  name: string;
  createdTs: number;
}

function filePath(): string {
  return path.join(config.dataDir, "created-rooms.json");
}

let cache: CreatedRoom[] | null = null;

function load(): CreatedRoom[] {
  if (cache !== null) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), "utf-8")) as CreatedRoom[];
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
    console.error("[created-rooms] save failed:", err);
  }
}

export function listCreatedRooms(): CreatedRoom[] {
  return [...load()];
}

export function addCreatedRoom(roomId: string, name: string): void {
  const all = load();
  if (all.some((r) => r.roomId === roomId)) return;
  all.push({ roomId, name, createdTs: Date.now() });
  cache = all;
  save();
}

export function removeCreatedRoom(roomId: string): void {
  cache = load().filter((r) => r.roomId !== roomId);
  save();
}
