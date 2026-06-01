import fs from "fs";
import OpenAI from "openai";
import { config } from "./config.js";

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      baseURL: config.openai.baseUrl,
      apiKey: config.openai.apiKey,
    });
  }
  return _client;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function embedText(text: string, retries = 5): Promise<number[]> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await getClient().embeddings.create({
        model: config.openai.embedModel,
        input: text,
      });
      return response.data[0].embedding;
    } catch (err: unknown) {
      const isRateLimit =
        err instanceof Error &&
        "status" in err &&
        (err as { status: number }).status === 429;

      if (isRateLimit && attempt < retries) {
        // Parse reset time from headers if available, else exponential backoff
        const headers =
          (err as { headers?: Record<string, string> }).headers ?? {};
        const resetHeader = headers["x-ratelimit-reset-requests"] ?? "";
        const resetMs = parseResetHeader(resetHeader) ?? 2000 * 2 ** attempt;
        process.stdout.write(`\n  Rate limited — waiting ${Math.round(resetMs / 1000)}s…`);
        await sleep(resetMs + 500);
        continue;
      }
      throw err;
    }
  }
  throw new Error("embedText: max retries exceeded");
}

function parseResetHeader(header: string): number | null {
  // header format: "29s964ms" or "1ms" or "2m30s"
  const match = header.match(/(?:(\d+)m)?(?:(\d+)s)?(?:(\d+)ms)?/);
  if (!match) return null;
  const mins = parseInt(match[1] ?? "0", 10);
  const secs = parseInt(match[2] ?? "0", 10);
  const ms = parseInt(match[3] ?? "0", 10);
  const total = mins * 60_000 + secs * 1_000 + ms;
  return total > 0 ? total : null;
}

/**
 * Embed texts one at a time (sequential) to stay within rate limits.
 * Prints progress to stdout.
 */
async function embedBatch(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    results.push(await embedText(texts[i]));
    if ((i + 1) % 10 === 0 || i + 1 === texts.length) {
      process.stdout.write(`\r  Embedding: ${i + 1}/${texts.length}   `);
    }
  }
  process.stdout.write("\n");
  return results;
}

function saveBin(vecs: number[][], binPath: string): void {
  if (vecs.length === 0) throw new Error("No vectors to save");
  const dims = vecs[0].length;
  const buffer = Buffer.allocUnsafe(vecs.length * dims * 4);
  for (let i = 0; i < vecs.length; i++) {
    for (let j = 0; j < dims; j++) {
      buffer.writeFloatLE(vecs[i][j], (i * dims + j) * 4);
    }
  }
  fs.writeFileSync(binPath, buffer);
}

function loadBin(binPath: string, dims: number): Float32Array {
  const buffer = fs.readFileSync(binPath);
  return new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength / 4
  );
}

export { embedText, embedBatch, saveBin, loadBin };
