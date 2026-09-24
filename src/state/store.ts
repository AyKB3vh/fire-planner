/**
 * Application store: scenario editing, quick deterministic projection,
 * optimisation runs (worker pool, progress, cancellation), scenario CRUD,
 * and JSON import/export. Local-first — everything persists to IndexedDB.
 */

import type {
  OptimisationResult,
  PolicyResult,
  RuleEntry,
  RuleRegistry,
  Scenario,
  StartingStateValidation,
} from '../types';
import type { ProjectionContext } from '../engine/projection';
import { computeHorizon, runPolicy } from '../engine/projection';
import { buildDeterministicPath } from '../engine/returns';
import { generateStage0Policies } from '../engine/policy';
import { validateStartingState } from '../engine/validate';
import {
  optimisationInputHash,
  runOptimisation,
} from '../engine/optimiser';
import { createDefaultRegistry } from '../rules/registry';
import { createDefaultScenario } from '../defaults';
import { contextFromScenario } from '../engine/context';
import { createPoolRunners, type PoolRunners } from '../workers/pool';
import * as db from '../persist/db';

export type ViewId =
  | 'dashboard'
  | 'inputs'
  | 'strategy'
  | 'audit'
  | 'rules'
  | 'scenarios';

export interface QuickRun {
  validated: StartingStateValidation;
  policy: PolicyResult | null;
  policyLabel: string;
}

export interface AppState {
  view: ViewId;
  scenarioRecords: db.ScenarioRecord[];
  scenario: Scenario;
  registry: RuleRegistry;
  dirty: boolean;
  quick: QuickRun | null;
  result: OptimisationResult | null;
  running: boolean;
  progress: { stage: string; fraction: number; label: string } | null;
  error: string | null;
  selectedCandidateId: string | null;
}

const initialScenario = createDefaultScenario();

let state: AppState = {
  view: 'dashboard',
  scenarioRecords: [],
  scenario: initialScenario,
  registry: createDefaultRegistry(),
  dirty: false,
  quick: null,
  result: null,
  running: false,
  progress: null,
  error: null,
  selectedCandidateId: null,
};

const listeners = new Set<() => void>();

export function getState(): AppState {
  return state;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function set(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

/* ------------------------------------------------------------------ */
/* Context + quick deterministic projection                            */
/* ------------------------------------------------------------------ */

export function currentContext(): ProjectionContext {
  return contextFromScenario(state.scenario, state.registry);
}

export function computeQuick(scenario: Scenario, registry: RuleRegistry): QuickRun {
  const ctx = contextFromScenario(scenario, registry);
  const validated = validateStartingState(ctx);
  if (!validated.ok) return { validated, policy: null, policyLabel: 'invalid starting state' };
  try {
    const { policies } = generateStage0Policies(
      ctx,
      scenario.optimisationSettings,
      scenario.engineSettings.includeDistributionFirst,
    );
    const fallback = policies[0];
    if (!fallback) return { validated, policy: null, policyLabel: 'no candidates' };
    // Prefer the recommended policy from the last optimisation (same inputs).
    const recPolicy =
      state.result && state.result.inputHash === optimisationInputHash(ctx, scenario.monteCarloSettings, scenario.optimisationSettings)
        ? (state.result.variants.recommended.policy ?? state.result.variants.mostRobust.policy ?? null)
        : null;
    const policy = recPolicy ?? fallback;
    const label = recPolicy
      ? `recommended variant (${state.result?.variants.recommended.candidateId ?? ''})`
      : 'default stage-0 candidate';
    const h = computeHorizon(ctx);
    const run = runPolicy(ctx, policy, buildDeterministicPath('central', scenario.assumptions, h.startYear));
    return { validated, policy: run, policyLabel: label };
  } catch (e) {
    return {
      validated,
      policy: null,
      policyLabel: e instanceof Error ? e.message : String(e),
    };
  }
}

function refreshQuick(): void {
  set({ quick: computeQuick(state.scenario, state.registry) });
}

/* ------------------------------------------------------------------ */
/* Scenario editing                                                    */
/* ------------------------------------------------------------------ */

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function persistLater(scenario: Scenario): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    void db.saveScenario(scenario);
  }, 400);
}

export function updateScenario(mutator: (s: Scenario) => void): void {
  const next: Scenario = structuredClone(state.scenario);
  mutator(next);
  next.updatedAt = new Date().toISOString();
  set({ scenario: next, dirty: true, error: null });
  persistLater(next);
  // Result no longer matches edited inputs (hash invalid).
  state = { ...state, result: null, selectedCandidateId: null };
  refreshQuick();
}

export function commitScenario(): void {
  set({ dirty: false });
  void db.saveScenario(state.scenario);
}

/* ------------------------------------------------------------------ */
/* Rule registry editing (viewer in UI)                                */
/* ------------------------------------------------------------------ */

export function updateRule(key: string, patch: Partial<RuleEntry>): void {
  const entry = state.registry[key];
  if (!entry) return;
  const registry: RuleRegistry = {
    ...state.registry,
    [key]: { ...entry, ...patch, status: patch.status ?? 'userAssumed' },
  };
  set({ registry });
  refreshQuick();
}

export function resetRules(): void {
  set({ registry: createDefaultRegistry() });
  refreshQuick();
}

/* ------------------------------------------------------------------ */
/* Optimisation run                                                    */
/* ------------------------------------------------------------------ */

let pool: PoolRunners | null = null;
let cancelRequested = false;
let running = false;

function getPool(): PoolRunners | null {
  if (pool) return pool;
  try {
    pool = createPoolRunners(() => contextFromScenario(state.scenario, state.registry));
  } catch {
    pool = null;
  }
  return pool;
}

export function cancelRun(): void {
  cancelRequested = true;
}

export async function runOptimisationAsync(): Promise<void> {
  if (running) return;
  running = true;
  cancelRequested = false;
  set({ running: true, progress: null, error: null });
  const ctx = currentContext();
  const p = getPool();
  try {
    const result = await runOptimisation(ctx, {
      mc: state.scenario.monteCarloSettings,
      optim: state.scenario.optimisationSettings,
      runner: p?.runner,
      diagRunner: p?.diagRunner,
      shouldCancel: () => cancelRequested,
      onProgress: (pr) => {
        set({
          progress: { stage: pr.stage, fraction: pr.fraction, label: pr.label },
        });
      },
    });
    set({ result, running: false, progress: null, selectedCandidateId: null });
    if (!result.cancelled) void db.saveResult(result);
  } catch (e) {
    set({
      running: false,
      progress: null,
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    running = false;
    cancelRequested = false;
  }
}

/* ------------------------------------------------------------------ */
/* Scenario CRUD + import/export                                       */
/* ------------------------------------------------------------------ */

export function selectScenario(id: string): void {
  const rec = state.scenarioRecords.find((r) => r.id === id);
  if (!rec) return;
  set({ scenario: rec.scenario, result: null, selectedCandidateId: null, dirty: false, error: null });
  refreshQuick();
  void hydrateResult();
}

export function createScenario(name: string): void {
  const s = createDefaultScenario();
  s.name = name;
  set({
    scenario: s,
    result: null,
    selectedCandidateId: null,
    dirty: true,
    scenarioRecords: [
      { id: s.id, name: s.name, updatedAt: s.updatedAt, scenario: s },
      ...state.scenarioRecords,
    ],
  });
  refreshQuick();
  void db.saveScenario(s);
}

export function duplicateScenario(): void {
  const s = structuredClone(state.scenario);
  s.id = crypto.randomUUID();
  s.name = `${state.scenario.name} (copy)`;
  s.createdAt = new Date().toISOString();
  s.updatedAt = s.createdAt;
  set({
    scenario: s,
    result: null,
    selectedCandidateId: null,
    dirty: false,
    scenarioRecords: [
      { id: s.id, name: s.name, updatedAt: s.updatedAt, scenario: s },
      ...state.scenarioRecords,
    ],
  });
  refreshQuick();
  void db.saveScenario(s);
}

export function renameScenario(name: string): void {
  updateScenario((s) => {
    s.name = name;
  });
  commitScenario();
  set({
    scenarioRecords: state.scenarioRecords.map((r) =>
      r.id === state.scenario.id ? { ...r, name, updatedAt: state.scenario.updatedAt } : r,
    ),
  });
}

export function deleteScenario(id: string): void {
  if (id === state.scenario.id) return; // never delete the active scenario
  set({ scenarioRecords: state.scenarioRecords.filter((r) => r.id !== id) });
  void db.deleteScenario(id);
}

export interface ExportEnvelope {
  format: 'fire-planner-export';
  version: 1;
  exportedAt: string;
  scenario: Scenario;
  registry?: RuleRegistry;
}

export function exportScenarioJSON(): string {
  const env: ExportEnvelope = {
    format: 'fire-planner-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    scenario: state.scenario,
    registry: state.registry,
  };
  return JSON.stringify(env, null, 2);
}

export function importScenarioJSON(text: string): { ok: boolean; error?: string } {
  try {
    const parsed = JSON.parse(text) as Partial<ExportEnvelope>;
    if (parsed.format !== 'fire-planner-export') {
      return { ok: false, error: 'Not a fire-planner export file.' };
    }
    if (!parsed.scenario || typeof parsed.scenario !== 'object') {
      return { ok: false, error: 'Export file has no scenario payload.' };
    }
    const s = parsed.scenario;
    if (!s.household || !s.startState || !s.assumptions) {
      return { ok: false, error: 'Scenario payload is incomplete.' };
    }
    s.id = crypto.randomUUID();
    s.name = `${s.name ?? 'Imported'} (imported)`;
    s.updatedAt = new Date().toISOString();
    set({
      scenario: s,
      registry: parsed.registry ?? createDefaultRegistry(),
      result: null,
      selectedCandidateId: null,
      dirty: false,
      error: null,
      scenarioRecords: [
        { id: s.id, name: s.name, updatedAt: s.updatedAt, scenario: s },
        ...state.scenarioRecords,
      ],
    });
    refreshQuick();
    void db.saveScenario(s);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function hydrateResult(): Promise<void> {
  const ctx = currentContext();
  const hash = optimisationInputHash(
    ctx,
    state.scenario.monteCarloSettings,
    state.scenario.optimisationSettings,
  );
  const cached = await db.loadResult(hash);
  if (cached) set({ result: cached });
}

export function selectView(view: ViewId): void {
  set({ view });
}

export function selectCandidate(id: string | null): void {
  set({ selectedCandidateId: id });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

let booted: Promise<void> | null = null;

export function boot(): Promise<void> {
  if (booted) return booted;
  booted = (async () => {
    const records = await db.listScenarios();
    if (records.length > 0) {
      const active = records[0];
      set({ scenario: active.scenario, scenarioRecords: records, dirty: false });
    } else {
      const s = state.scenario;
      const rec: db.ScenarioRecord = {
        id: s.id,
        name: s.name,
        updatedAt: s.updatedAt,
        scenario: s,
      };
      set({ scenarioRecords: [rec] });
      void db.saveScenario(s);
    }
    refreshQuick();
    await hydrateResult();
  })();
  return booted;
}
