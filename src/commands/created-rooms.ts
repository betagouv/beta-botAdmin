import fs from "fs";
import path from "path";
import { config } from "../config.js";

// Persistent list of rooms created by the bot (`/salon create`,
// `/alerte`), kept in data/created-rooms.json. `/alerte` reads it
// back to spot an alert raised twice for the same component the same day.
export interface CreatedRoom {
  roomId: string;
  name: string;
  createdTs: number;
  // When the inactivity warning was posted (tools/inactivite.ts). Absent while
  // the room is active.
  avertiLe?: number;
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

// The most recent room the bot created under exactly this name, if any.
export function findCreatedRoom(name: string): string | undefined {
  return load()
    .filter((r) => r.name === name)
    .sort((a, b) => b.createdTs - a.createdTs)[0]?.roomId;
}

export function removeCreatedRoom(roomId: string): void {
  cache = load().filter((r) => r.roomId !== roomId);
  save();
}

// Record (or clear, with undefined) when the inactivity warning was posted.
export function setAvertiLe(roomId: string, ts: number | undefined): void {
  const room = load().find((r) => r.roomId === roomId);
  if (!room) return;
  if (ts === undefined) delete room.avertiLe;
  else room.avertiLe = ts;
  save();
}
