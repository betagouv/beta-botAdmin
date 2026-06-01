import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions.js";
import { config } from "./config.js";
import {
  tools as memberTools,
  handlers as memberHandlers,
} from "./tools/members.js";
import {
  tools as startupTools,
  handlers as startupHandlers,
} from "./tools/startups.js";
import { tools as repoTools, handlers as repoHandlers } from "./tools/repos.js";
import { tools as docTools, handlers as docHandlers } from "./tools/docs.js";
import {
  tools as calendarTools,
  handlers as calendarHandlers,
} from "./tools/calendar.js";
import {
  tools as videoTools,
  handlers as videoHandlers,
} from "./tools/videos.js";
import {
  tools as incubatorTools,
  handlers as incubatorHandlers,
} from "./tools/incubators.js";
import {
  tools as dimailTools,
  handlers as dimailHandlers,
  toolNames as dimailToolNames,
} from "./tools/dimail.js";
import { buildHelp } from "./tools/help.js";

function buildSystemPrompt(): string {
  return `Tu es **betabot**, l'assistant de la communauté beta.gouv.fr. Tu vis dans **Tchap** (la messagerie de l'État, basée sur Matrix). **Tu n'es pas un bot Slack** — n'évoque jamais Slack, et n'invente JAMAIS de commandes que tu n'as pas dans la documentation ci-dessous.

Tu réponds en français. Tu emploies le tutoiement respectueux, utilises du markdown riche et un peu d'emojis. Tes réponses sont concises et vont à l'essentiel.

Tu as accès à des outils pour chercher des membres, des startups, des dépôts de code, de la documentation et des actualités — uniquement des données publiques. Utilise toujours les outils pour répondre aux questions factuelles. Ne devine pas les noms ou les données.

Tu discutes normalement : réponds à ce qu'on te demande, de façon conversationnelle. Ne propose JAMAIS spontanément la liste de tes commandes, \`/help\`, ni un rappel de comment t'utiliser — fais-le UNIQUEMENT si on te le demande explicitement.

═══════════════════════════════════════════════════════════════
RÉFÉRENCE — uniquement si on te demande comment t'utiliser / tes commandes
═══════════════════════════════════════════════════════════════

${buildHelp()}

═══════════════════════════════════════════════════════════════
FIN DE LA RÉFÉRENCE
═══════════════════════════════════════════════════════════════

RÈGLES STRICTES :
 - Quand on te demande comment t'utiliser, quelles commandes existent, comment faire une action, ou dans quel salon : utilise UNIQUEMENT les informations de la référence ci-dessus.
 - Les seules commandes slash valides sont celles listées : \`/help\`, \`/emails\` (et ses sous-commandes), \`/historique\`, \`/salon\`. Tout autre \`/quelque-chose\` n'existe pas.
 - Quand tu cites une commande, copie sa syntaxe exacte depuis la doc — **caractère par caractère**.
 - Quand tu indiques un salon, cite le libellé exact (entre backticks).

⚠️ ORTHOGRAPHE EXACTE DES COMMANDES (PIÈGES FRÉQUENTS À ÉVITER) :
 - La commande s'écrit \`/emails\` **en un seul mot, sans tiret, avec un \`s\`**. JAMAIS \`/e-mails\`, JAMAIS \`/e-mail\`, JAMAIS \`/email\` (au singulier), JAMAIS \`/mails\`.
 - Même si l'orthographe française correcte serait "e-mail" avec un tiret, le NOM de la commande dans ce bot reste \`/emails\` sans tiret. C'est un identifiant technique, pas un mot français.
 - Si tu hésites sur l'orthographe d'une commande, recopie-la EXACTEMENT depuis la doc ci-dessus, pas depuis ta mémoire.
 - \`/historique\` s'écrit avec un \`h\` initial et la terminaison française. JAMAIS \`/history\`, JAMAIS \`/hist\`.

Pour les questions liées à notre actualité, utilise ces données:
 - calendrier
 - les mises à jour sur la documentation
 - les dernieres vidéos peertube
 - le changelog de betagouv/doc.incubateur.net-communaute
 - les changelogs des organisations

Lorsque tu mentionnes une entité, ajoute TOUJOURS un lien:
 - une startup, une produit, une équipe, créé un lien vers https://beta.gouv.fr/startups/[ghid]
 - un membre de la communauté, créé un lien vers https://espace-membre.beta.gouv.fr/community/[username]
 - un repository ou commit GIT, créé un lien vers https://github.com/[ORG]/[REPO]
 - un organisation GIT, créé un lien vers https://github.com/[ORG]
 - la documentation, crée un lien vers https://doc.incubateur.net/[PATH] sans le suffixe \`.md\`.
 - un standard beta.gouv.fr, créé un lien vers https://github.com/betagouv/standards/blob/main/[categorie]/[standard]

Cite toujours tes sources et lorsque c'est nécessaire tu peux ajouter ces liens en fin de message:
 - [documentation beta.gouv.fr](https://doc.incubateur.net)
 - [espace membre](https://espace-membre.beta.gouv.fr)
 - [site beta.gouv.fr](https://beta.gouv.fr)
 - [standards des produits beta.gouv.fr](https://standards.beta.gouv.fr)
`;
}

const MAX_HISTORY = 20;
const MAX_TOOL_ITERATIONS = 10;

// Safety net: fix common LLM hallucinations in command names before sending to user.
// Even with a strong system prompt, qwen2.5:14b tends to "correct" /emails to /e-mail(s) (French)
// or write /email (singular). This regex pass forces the canonical spelling.
function fixCommandHallucinations(text: string): { fixed: string; count: number } {
  let count = 0;
  const fixed = text
    .replace(/\/e-mails?\b/g, () => {
      count++;
      return "/emails";
    })
    .replace(/\/email\b(?!s)/g, () => {
      count++;
      return "/emails";
    })
    .replace(/\/mails\b/g, () => {
      count++;
      return "/emails";
    })
    .replace(/\/history\b/g, () => {
      count++;
      return "/historique";
    })
    .replace(/\/hist\b/g, () => {
      count++;
      return "/historique";
    });
  return { fixed, count };
}

const BASE_TOOLS: ChatCompletionTool[] = [
  ...memberTools,
  ...startupTools,
  ...repoTools,
  ...docTools,
  ...calendarTools,
  ...videoTools,
  ...incubatorTools,
];

const ALL_HANDLERS: Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
> = {
  ...memberHandlers,
  ...startupHandlers,
  ...repoHandlers,
  ...docHandlers,
  ...calendarHandlers,
  ...videoHandlers,
  ...incubatorHandlers,
  ...dimailHandlers,
};

function toolsForRoom(roomId: string): ChatCompletionTool[] {
  const dimailAllowed =
    config.matrix.dimailRooms.length > 0 &&
    config.matrix.dimailRooms.includes(roomId);
  return dimailAllowed ? [...BASE_TOOLS, ...dimailTools] : BASE_TOOLS;
}

function isToolAllowedInRoom(toolName: string, roomId: string): boolean {
  if (!dimailToolNames.includes(toolName)) return true;
  return config.matrix.dimailRooms.includes(roomId);
}

export class Orchestrator {
  private client: OpenAI;
  private history: Map<string, ChatCompletionMessageParam[]> = new Map();

  constructor() {
    this.client = new OpenAI({
      baseURL: config.openai.baseUrl,
      apiKey: config.openai.apiKey,
    });
  }

  private getConversationKey(roomId: string, threadId?: string): string {
    return `${roomId}:${threadId ?? "root"}`;
  }

  private getHistory(key: string): ChatCompletionMessageParam[] {
    if (!this.history.has(key)) {
      this.history.set(key, []);
    }
    return this.history.get(key)!;
  }

  private trimHistory(messages: ChatCompletionMessageParam[]): void {
    while (messages.length > MAX_HISTORY) {
      messages.shift();
    }
  }

  clearHistory(roomId: string, threadId?: string): void {
    const key = this.getConversationKey(roomId, threadId);
    this.history.delete(key);
  }

  async handle(input: {
    userId: string;
    roomId: string;
    threadId?: string;
    text: string;
  }): Promise<string> {
    const key = this.getConversationKey(input.roomId, input.threadId);
    const history = this.getHistory(key);

    history.push({ role: "user", content: input.text });
    this.trimHistory(history);

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: buildSystemPrompt() },
      ...history,
    ];

    const debug = (...args: unknown[]) =>
      process.stderr.write(`[debug] ${args.join(" ")}\n`);

    debug(`handle key=${key} text=${JSON.stringify(input.text)}`);
    debug(`history length=${history.length}`);

    let iterations = 0;

    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;
      debug(`--- LLM iteration ${iterations}/${MAX_TOOL_ITERATIONS} ---`);
      debug(
        `sending ${messages.length} messages to model=${config.openai.model}`,
      );

      const response = await this.client.chat.completions.create({
        model: config.openai.model,
        messages,
        tools: toolsForRoom(input.roomId),
        tool_choice: "auto",
      });

      const choice = response.choices[0];
      if (!choice) throw new Error("No response from LLM");

      const assistantMessage = choice.message;
      messages.push(assistantMessage);

      debug(
        `finish_reason=${choice.finish_reason} tool_calls=${assistantMessage.tool_calls?.length ?? 0}`,
      );
      if (response.usage) {
        debug(
          `tokens: prompt=${response.usage.prompt_tokens} completion=${response.usage.completion_tokens} total=${response.usage.total_tokens}`,
        );
      }

      if (
        choice.finish_reason === "stop" ||
        !assistantMessage.tool_calls?.length
      ) {
        const rawText = assistantMessage.content ?? "";
        if (rawText.trim()) {
          const { fixed, count } = fixCommandHallucinations(rawText);
          if (count > 0) debug(`fixed ${count} command hallucination(s)`);
          debug(`final response (${fixed.length} chars)`);
          history.push({ role: "assistant", content: fixed });
          this.trimHistory(history);
          return fixed;
        }
        // LLM stopped but returned no content — ask it to summarize what it found
        debug(`empty response after stop, requesting summary`);
        break;
      }

      // Dispatch tool calls
      debug(`dispatching ${assistantMessage.tool_calls.length} tool call(s)`);
      const toolResults: ChatCompletionToolMessageParam[] = await Promise.all(
        assistantMessage.tool_calls.map(async (tc) => {
          const handler = ALL_HANDLERS[tc.function.name];
          let result: unknown;
          debug(`  tool=${tc.function.name} args=${tc.function.arguments}`);
          if (!isToolAllowedInRoom(tc.function.name, input.roomId)) {
            result = {
              error: `Tool ${tc.function.name} is not allowed in this room`,
            };
            debug(`  -> tool not allowed in room ${input.roomId}`);
          } else if (!handler) {
            result = { error: `Unknown tool: ${tc.function.name}` };
            debug(`  -> unknown tool`);
          } else {
            try {
              const args = JSON.parse(tc.function.arguments) as Record<
                string,
                unknown
              >;
              result = await handler(args);
              const resultStr = JSON.stringify(result);
              debug(
                `  -> result (${resultStr.length} chars): ${resultStr.slice(0, 200)}${resultStr.length > 200 ? "..." : ""}`,
              );
            } catch (err) {
              result = { error: String(err) };
              debug(`  -> error: ${err}`);
            }
          }
          return {
            role: "tool" as const,
            tool_call_id: tc.id,
            content: JSON.stringify(result),
          };
        }),
      );

      messages.push(...toolResults);
    }

    // Fallback: ask LLM to summarize with what we have
    debug(`max iterations reached, requesting final summary`);
    messages.push({
      role: "user",
      content:
        "Réponds maintenant à la question en te basant uniquement sur les informations récupérées ci-dessus. Ne fais plus d'appel d'outil.",
    });
    const finalResponse = await this.client.chat.completions.create({
      model: config.openai.model,
      messages,
    });

    const rawText = finalResponse.choices[0]?.message.content ?? "";
    const { fixed, count } = fixCommandHallucinations(rawText);
    if (count > 0) debug(`fixed ${count} command hallucination(s) in fallback`);
    debug(`fallback final response (${fixed.length} chars)`);
    history.push({ role: "assistant", content: fixed });
    this.trimHistory(history);
    return fixed;
  }
}
