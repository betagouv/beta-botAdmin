declare module "wink-bm25-text-search" {
  interface BM25 {
    defineConfig(config: { fldWeights: Record<string, number> }): void;
    definePrepTasks(tasks: Array<(text: string) => string[]>): void;
    addDoc(doc: Record<string, string>, id: number): void;
    consolidate(): void;
    search(query: string): Array<[number, number]>;
    exportJSON(): string;
    importJSON(json: string): void;
  }
  function bm25(): BM25;
  export default bm25;
}
