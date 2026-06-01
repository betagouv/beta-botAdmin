import fs from "fs";

// wink-bm25-text-search has no types; import as any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BM25Index = any;

// French stopwords for BM25 preprocessing
const FRENCH_STOPWORDS = new Set([
  "le","la","les","un","une","des","du","de","d","l","je","tu","il","elle",
  "nous","vous","ils","elles","ce","se","sa","son","ses","mon","ma","mes",
  "ton","ta","tes","notre","votre","leur","leurs","que","qui","quoi","dont",
  "où","et","ou","mais","donc","car","ni","si","dans","sur","sous","par",
  "pour","avec","sans","entre","vers","chez","en","au","aux","à","y","ne",
  "pas","plus","très","bien","aussi","comme","tout","tous","toute","toutes",
  "cela","ceci","on","est","sont","était","être","avoir","a","ont","eu",
]);

function prepareText(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !FRENCH_STOPWORDS.has(t));
}

// Dynamic import for ESM-only wink-bm25
async function createBM25(): Promise<BM25Index> {
  const mod = await import("wink-bm25-text-search");
  const bm25 = mod.default();
  bm25.defineConfig({ fldWeights: { text: 1 } });
  bm25.definePrepTasks([prepareText]);
  return bm25;
}

async function buildBM25Index(docs: string[]): Promise<BM25Index> {
  const bm25 = await createBM25();
  docs.forEach((doc, i) => {
    bm25.addDoc({ text: doc }, i);
  });
  bm25.consolidate();
  return bm25;
}

function saveBM25Index(index: BM25Index, path: string): void {
  fs.writeFileSync(path, index.exportJSON());
}

async function loadBM25Index(path: string): Promise<BM25Index> {
  const bm25 = await createBM25();
  bm25.importJSON(fs.readFileSync(path, "utf-8"));
  return bm25;
}

function sparseSearch(
  index: BM25Index,
  query: string,
  k: number
): { index: number; score: number }[] {
  const terms = prepareText(query);
  if (terms.length === 0) return [];
  const results: Array<[number, number]> = index.search(terms.join(" "));
  return results.slice(0, k).map(([docId, score]) => ({
    index: docId,
    score,
  }));
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function denseSearch(
  queryVec: number[],
  matrix: Float32Array,
  k: number,
  dims: number
): { index: number; score: number }[] {
  const qf = new Float32Array(queryVec);
  const count = matrix.length / dims;
  const scores: { index: number; score: number }[] = [];
  for (let i = 0; i < count; i++) {
    const row = matrix.subarray(i * dims, (i + 1) * dims);
    scores.push({ index: i, score: cosineSimilarity(qf, row) });
  }
  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, k);
}

function rrf(
  dense: { index: number; score: number }[],
  sparse: { index: number; score: number }[],
  k = 60
): { index: number; score: number }[] {
  const scoreMap = new Map<number, number>();

  dense.forEach(({ index }, rank) => {
    scoreMap.set(index, (scoreMap.get(index) ?? 0) + 1 / (k + rank + 1));
  });
  sparse.forEach(({ index }, rank) => {
    scoreMap.set(index, (scoreMap.get(index) ?? 0) + 1 / (k + rank + 1));
  });

  return Array.from(scoreMap.entries())
    .map(([index, score]) => ({ index, score }))
    .sort((a, b) => b.score - a.score);
}

async function hybridSearch<T>(
  query: string,
  queryVec: number[],
  matrix: Float32Array,
  bm25Index: BM25Index,
  indexEntries: T[],
  dims: number,
  topK: number
): Promise<Array<T & { score: number }>> {
  const searchK = Math.max(topK * 3, 30);
  const denseResults = denseSearch(queryVec, matrix, searchK, dims);
  const sparseResults = sparseSearch(bm25Index, query, searchK);
  const fused = rrf(denseResults, sparseResults);

  return fused.slice(0, topK).map(({ index, score }) => ({
    ...indexEntries[index],
    score,
  }));
}

export {
  BM25Index,
  buildBM25Index,
  saveBM25Index,
  loadBM25Index,
  sparseSearch,
  cosineSimilarity,
  denseSearch,
  rrf,
  hybridSearch,
};
