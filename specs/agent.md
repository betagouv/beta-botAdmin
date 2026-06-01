# Agent — Orchestrator spec

`src/orchestrator.ts`

## Role

Drives the LLM conversation loop. Receives a user message, manages per-conversation history, dispatches tool calls, and returns a final text response.

## Interface

```ts
class Orchestrator {
  handle(input: {
    userId: string;
    roomId: string;
    threadId?: string;
    text: string;
  }): Promise<string>;
  clearHistory(roomId: string, threadId?: string): void;
}
```

Conversation key: `"${roomId}:${threadId ?? 'root'}"` — distinct per Matrix thread or DM.

## Loop

1. Append user message to history.
2. Build `messages = [system, ...history]`.
3. Call `chat.completions.create` with all tools, `tool_choice: "auto"`.
4. If `finish_reason === "stop"` or no tool calls → return assistant content.
5. If tool calls → dispatch all in parallel (`Promise.all`), append results, repeat.
6. After `MAX_TOOL_ITERATIONS = 10` → inject a "summarize now" user turn and do one final call without tools.

History is trimmed to `MAX_HISTORY = 20` messages after each turn (user + assistant only; tool messages are ephemeral within a turn).

## System prompt

- Language: French, tutoiement, markdown-rich, concise.
- Always use tools for factual answers — never guess names or data.
- For "actualité" questions use: calendar, doc updates, PeerTube videos, org changelogs.
- Entity linking rules (always add a link when mentioning):
  - Startup → `https://beta.gouv.fr/startups/[ghid]`
  - Member → `https://espace-membre.beta.gouv.fr/community/[username]`
  - Git repo → `https://github.com/[ORG]/[REPO]`
  - Git org → `https://github.com/[ORG]`
  - Doc page → `https://doc.incubateur.net/[PATH]` (no `.md` suffix)
  - Standard → `https://github.com/betagouv/standards/blob/main/[categorie]/[standard]`
- Cite sources; standard footer links available (doc, espace-membre, beta.gouv.fr, standards).

## Tools registered

| Module                | Tools                                                          |
| --------------------- | -------------------------------------------------------------- |
| `tools/members.ts`    | `search_members`, `get_member_detail`, `get_member_startups`   |
| `tools/startups.ts`   | `search_startups`, `get_startup_detail`, `get_startup_members` |
| `tools/repos.ts`      | `search_repos`, `get_repo_detail`                              |
| `tools/docs.ts`       | `search_docs`, `get_doc_page`                                  |
| `tools/calendar.ts`   | `get_calendar`                                                 |
| `tools/videos.ts`     | `search_videos`, `get_videos`                                  |
| `tools/incubators.ts` | `search_incubators`, `get_incubator_detail`                    |

Each tool module exports `tools: ChatCompletionTool[]` (JSON schema definitions) and `handlers: Record<string, (args) => Promise<unknown>>`.

## Debug output

All debug lines go to `stderr` prefixed `[debug]`. Includes per-iteration message count, model name, finish reason, tool call count, token usage, and truncated tool results.

## Config used

`config.openai.baseUrl`, `config.openai.apiKey`, `config.openai.model` (from `src/config.ts`).
