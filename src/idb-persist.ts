import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

type IndexDef = { keyPath: string | string[]; multiEntry: boolean; unique: boolean };
type StoreDef = {
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: Record<string, IndexDef>;
  records: { key: IDBValidKey; value: unknown }[];
};
type DbDump = Record<string, { version: number; stores: Record<string, StoreDef> }>;

function promiseReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dumpDb(
  idb: IDBFactory,
  name: string
): Promise<{ version: number; stores: Record<string, StoreDef> }> {
  const db = await promiseReq(idb.open(name));
  const storeNames = Array.from(db.objectStoreNames);
  const stores: Record<string, StoreDef> = {};

  for (const storeName of storeNames) {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const indexes: Record<string, IndexDef> = {};
    for (const idxName of Array.from(store.indexNames)) {
      const idx = store.index(idxName);
      indexes[idxName] = {
        keyPath: idx.keyPath as string | string[],
        multiEntry: idx.multiEntry,
        unique: idx.unique,
      };
    }
    const [keys, values] = await Promise.all([
      promiseReq(store.getAllKeys()),
      promiseReq(store.getAll() as IDBRequest<unknown[]>),
    ]);
    stores[storeName] = {
      keyPath: store.keyPath as string | string[] | null,
      autoIncrement: store.autoIncrement,
      indexes,
      records: keys.map((k, i) => ({ key: k, value: values[i] })),
    };
  }

  const version = db.version;
  db.close();
  return { version, stores };
}

export async function dumpIDB(idb: IDBFactory, filePath: string): Promise<void> {
  try {
    const dbList = await idb.databases();
    if (dbList.length === 0) return;
    const dump: DbDump = {};
    for (const { name } of dbList) {
      if (!name) continue;
      dump[name] = await dumpDb(idb, name);
    }
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(dump, replacer));
    console.log(`[Matrix] Crypto state saved (${Object.keys(dump).length} dbs)`);
  } catch (err) {
    console.warn("[Matrix] Failed to save crypto state:", err);
  }
}

export async function restoreIDB(idb: IDBFactory, filePath: string): Promise<void> {
  if (!existsSync(filePath)) return;
  try {
    const dump = JSON.parse(readFileSync(filePath, "utf-8"), reviver) as DbDump;
    for (const [dbName, { version, stores }] of Object.entries(dump)) {
      // Two-phase restore:
      // 1. onupgradeneeded — create schema only (put() inside versionchange is unreliable in fake-indexeddb)
      // 2. onsuccess — insert records in a separate readwrite transaction
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = idb.open(dbName, version);
        req.onupgradeneeded = () => {
          const db = req.result;
          for (const [storeName, def] of Object.entries(stores)) {
            if (db.objectStoreNames.contains(storeName)) continue;
            const store = db.createObjectStore(storeName, {
              keyPath: def.keyPath ?? undefined,
              autoIncrement: def.autoIncrement,
            });
            for (const [idxName, idxDef] of Object.entries(def.indexes)) {
              store.createIndex(idxName, idxDef.keyPath, {
                multiEntry: idxDef.multiEntry,
                unique: idxDef.unique,
              });
            }
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error(`IDB open blocked for ${dbName}`));
      });

      for (const [storeName, def] of Object.entries(stores)) {
        if (def.records.length === 0) continue;
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(storeName, "readwrite");
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          const store = tx.objectStore(storeName);
          for (const { key, value } of def.records) {
            def.keyPath ? store.put(value) : store.put(value, key);
          }
        });
      }

      db.close();
    }
    console.log("[Matrix] Crypto state restored");
  } catch (err) {
    console.warn("[Matrix] Failed to restore crypto state (starting fresh):", err);
  }
}

function replacer(_k: string, v: unknown): unknown {
  if (v instanceof Uint8Array)
    return { __t: "u8", d: Buffer.from(v).toString("base64") };
  if (v instanceof ArrayBuffer)
    return { __t: "ab", d: Buffer.from(v).toString("base64") };
  return v;
}

function reviver(_k: string, v: unknown): unknown {
  if (v && typeof v === "object" && "__t" in (v as object)) {
    const o = v as { __t: string; d: string };
    if (o.__t === "u8") return new Uint8Array(Buffer.from(o.d, "base64"));
    if (o.__t === "ab") return Buffer.from(o.d, "base64").buffer;
  }
  return v;
}
