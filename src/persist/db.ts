/**
 * IndexedDB persistence (§16.1 local-first): scenarios and cached
 * optimisation results. Plain structured-cloneable objects only.
 */

import type { OptimisationResult, Scenario } from '../types';

const DB_NAME = 'fire-planner';
const DB_VERSION = 1;
const SCENARIOS = 'scenarios';
const RESULTS = 'results';

export interface ScenarioRecord {
  id: string;
  name: string;
  updatedAt: string;
  scenario: Scenario;
}

export interface ResultRecord {
  hash: string;
  createdAt: string;
  result: OptimisationResult;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SCENARIOS)) {
        db.createObjectStore(SCENARIOS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(RESULTS)) {
        db.createObjectStore(RESULTS, { keyPath: 'hash' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
      }),
  );
}

export async function listScenarios(): Promise<ScenarioRecord[]> {
  try {
    const all = await tx<ScenarioRecord[]>(SCENARIOS, 'readonly', (s) => s.getAll());
    return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

export async function saveScenario(scenario: Scenario): Promise<void> {
  try {
    const rec: ScenarioRecord = {
      id: scenario.id,
      name: scenario.name,
      updatedAt: scenario.updatedAt,
      scenario,
    };
    await tx(SCENARIOS, 'readwrite', (s) => s.put(rec));
  } catch {
    /* local-first: persist failures are non-fatal (memory state remains) */
  }
}

export async function deleteScenario(id: string): Promise<void> {
  try {
    await tx(SCENARIOS, 'readwrite', (s) => s.delete(id));
  } catch {
    /* ignore */
  }
}

const MAX_RESULTS = 20;

export async function saveResult(result: OptimisationResult): Promise<void> {
  try {
    const rec: ResultRecord = {
      hash: result.inputHash,
      createdAt: result.createdAt,
      result,
    };
    await tx(RESULTS, 'readwrite', (s) => s.put(rec));
    // trim oldest
    const all = await tx<ResultRecord[]>(RESULTS, 'readonly', (s) => s.getAll());
    if (all.length > MAX_RESULTS) {
      all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const excess = all.slice(0, all.length - MAX_RESULTS);
      for (const r of excess) await tx(RESULTS, 'readwrite', (s) => s.delete(r.hash));
    }
  } catch {
    /* ignore */
  }
}

export async function loadResult(hash: string): Promise<OptimisationResult | null> {
  try {
    return (await tx<ResultRecord | undefined>(RESULTS, 'readonly', (s) => s.get(hash)))?.result ?? null;
  } catch {
    return null;
  }
}
