import fs from "fs";
import path from "path";
import ical from "ical";
import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { config } from "../config.js";

const DATA = config.dataDir;

interface CalendarEvent {
  summary: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
}

async function get_calendar(days_ahead = 14, days_back = 0): Promise<CalendarEvent[]> {
  const icsPath = path.join(DATA, "calendar.ics");
  if (!fs.existsSync(icsPath)) return [];

  const raw = fs.readFileSync(icsPath, "utf-8");
  const parsed = ical.parseICS(raw);

  const now = new Date();
  const from = new Date(now.getTime() - days_back * 24 * 60 * 60 * 1000);
  const to = new Date(now.getTime() + days_ahead * 24 * 60 * 60 * 1000);

  const events: CalendarEvent[] = [];

  for (const [, component] of Object.entries(parsed)) {
    if (component.type !== "VEVENT") continue;

    const start = component.start ? new Date(component.start) : null;
    const end = component.end ? new Date(component.end) : null;

    if (!start || start < from || start > to) continue;

    events.push({
      summary: component.summary ?? "(sans titre)",
      start: start.toISOString(),
      end: end?.toISOString() ?? start.toISOString(),
      ...(component.location ? { location: component.location } : {}),
      ...(component.description
        ? { description: (component.description as string).slice(0, 500) }
        : {}),
    });
  }

  events.sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
  );
  return events;
}

// ─── Tool definition ──────────────────────────────────────────────────────────

const getCalendarTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_calendar",
    description:
      "Retourne les événements du calendrier de la communauté beta.gouv.fr, à venir ou passés.",
    parameters: {
      type: "object",
      properties: {
        days_ahead: {
          type: "integer",
          description: "Nombre de jours à venir (défaut: 14)",
          default: 14,
        },
        days_back: {
          type: "integer",
          description: "Nombre de jours dans le passé à inclure (défaut: 0)",
          default: 0,
        },
      },
    },
  },
};

export const tools = [getCalendarTool];

export const handlers: Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
> = {
  get_calendar: (args) =>
    get_calendar((args["days_ahead"] as number) ?? 14, (args["days_back"] as number) ?? 0),
};
