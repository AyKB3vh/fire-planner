/**
 * Main-thread worker pool (§16.3): runs batched MC and diagnostics work on
 * Web Workers while the coordinator (optimiser staging logic) stays on the
 * main thread and responsive. Falls back to serial execution when workers
 * are unavailable (tests, exotic environments).
 *
 * CRN guarantee: results are identical to serial execution because draws
 * depend only on (seed, pathIndex) — see montecarlo.ts.
 *
 * Cancellation: the optimiser polls `hooks.shouldCancel` between chunks;
 * the pool checks it every 200 ms, stops scheduling new chunks and resolves
 * with `cancelled: true`. In-flight chunks (≈1.5 s target) finish first, so
 * workers stay reusable across runs.
 */

import type { MCDistribution, Policy } from '../types';
import type { ProjectionContext } from '../engine/projection';
import type { MCSummaryInput } from '../engine/montecarlo';
import type {
  BatchHooks,
  BatchResult,
  BatchRunner,
  DiagResult,
  DiagRunner,
} from '../engine/mcrunner';
import { serialDiagRunner, serialRunner } from '../engine/mcrunner';

export interface PoolRunners {
  runner: BatchRunner;
  diagRunner: DiagRunner;
  dispose: () => void;
}

interface ChunkJob {
  kind: 'mc' | 'diag';
  policies: Policy[];
  start: number;
  input?: MCSummaryInput;
}

interface Queued {
  job: ChunkJob;
  batch: BatchState;
}

interface BatchState {
  total: number;
  done: number;
  cancelled: boolean;
  settled: boolean;
  summaries: (MCDistribution | null)[];
  diagnostics: (DiagResult['diagnostics'][number] | null)[];
  errors: (string | null)[];
  resolve: (r: BatchResult & DiagResult) => void;
  promise: Promise<BatchResult & DiagResult>;
}

const MAX_CONCURRENCY = 8;
const TARGET_CHUNK_MS = 1500;

function defaultConcurrency(): number {
  const hc =
    typeof navigator !== 'undefined' && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 2;
  return Math.max(1, Math.min(MAX_CONCURRENCY, hc));
}

/**
 * Target chunks so each worker message runs ≈ TARGET_CHUNK_MS (keeps
 * cancellation and progress granularity acceptable).
 */
function chunkSize(paths: number, policies: number): number {
  const msPerPolicy = Math.max(1, paths * 1.6); // ≈1.5 ms per simulated path
  const size = Math.ceil(TARGET_CHUNK_MS / msPerPolicy);
  return Math.max(1, Math.min(policies, size));
}

export function createPoolRunners(ctx: () => ProjectionContext): PoolRunners | null {
  if (typeof Worker === 'undefined') return null;
  let workers: Worker[];
  try {
    const n = defaultConcurrency();
    workers = Array.from(
      { length: n },
      () => new Worker(new URL('./optimiserWorker.ts', import.meta.url), { type: 'module' }),
    );
  } catch {
    return null;
  }

  const idle: Worker[] = [...workers];
  const queue: Queued[] = [];
  const byId = new Map<number, { job: ChunkJob; batch: BatchState; hooks?: BatchHooks }>();
  let nextId = 1;
  let disposed = false;

  const pump = (): void => {
    if (disposed) return;
    while (idle.length > 0 && queue.length > 0) {
      const worker = idle.pop()!;
      const { job, batch } = queue.shift()!;
      const hooks = hooksOf.get(batch);
      const id = nextId++;
      byId.set(id, { job, batch, hooks });
      const onMsg = (e: MessageEvent): void => {
        worker.removeEventListener('message', onMsg);
        handleResponse(worker, id, e.data as Record<string, unknown>);
      };
      worker.addEventListener('message', onMsg);
      worker.postMessage({
        id,
        kind: job.kind,
        ctx: ctx(),
        policies: job.policies,
        input: job.input,
      });
    }
  };

  const settle = (batch: BatchState): void => {
    if (batch.settled) return;
    batch.settled = true;
    batch.resolve({
      summaries: batch.summaries,
      cancelled: true,
      diagnostics: batch.diagnostics,
      errors: batch.errors,
    } as BatchResult & DiagResult);
  };

  const handleResponse = (
    worker: Worker,
    id: number,
    data: Record<string, unknown>,
  ): void => {
    const rec = byId.get(id);
    if (!rec) {
      idle.push(worker);
      pump();
      return;
    }
    byId.delete(id);
    const { job, batch, hooks } = rec;
    idle.push(worker);
    if (batch.settled) {
      pump();
      return;
    }
    if (data.error !== undefined) {
      // Fatal chunk error — report as cancelled so the optimiser stops gracefully.
      batch.cancelled = true;
      settle(batch);
      pump();
      return;
    }
    if (job.kind === 'mc') {
      const list = data.summaries as MCDistribution[];
      list.forEach((s, i) => {
        batch.summaries[job.start + i] = s;
      });
    } else {
      const diagList = data.diagnostics as NonNullable<DiagResult['diagnostics'][number]>[];
      const errList = data.errors as (string | null)[];
      diagList.forEach((dg, i) => {
        batch.diagnostics[job.start + i] = dg;
      });
      errList.forEach((er, i) => {
        batch.errors[job.start + i] = er;
      });
    }
    batch.done++;
    hooks?.onProgress?.(batch.done, batch.total);
    if (batch.done >= batch.total) {
      batch.settled = true;
      batch.resolve({
        summaries: batch.summaries,
        cancelled: batch.cancelled,
        diagnostics: batch.diagnostics,
        errors: batch.errors,
      } as BatchResult & DiagResult);
    }
    pump();
  };

  const hooksOf = new Map<BatchState, BatchHooks | undefined>();

  const run = (
    kind: 'mc' | 'diag',
    policies: Policy[],
    input: MCSummaryInput | undefined,
    hooks?: BatchHooks,
  ): Promise<BatchResult & DiagResult> => {
    const empty = (): BatchResult & DiagResult =>
      kind === 'mc'
        ? ({ summaries: policies.map(() => null), cancelled: false } as BatchResult & DiagResult)
        : ({
            diagnostics: policies.map(() => null),
            errors: policies.map(() => null),
            cancelled: false,
          } as BatchResult & DiagResult);
    if (disposed || policies.length === 0) {
      return Promise.resolve(empty());
    }
    if (hooks?.shouldCancel?.()) {
      const e = empty();
      e.cancelled = true;
      return Promise.resolve(e);
    }

    const paths = kind === 'mc' ? (input?.paths ?? 100) : policies.length;
    const size =
      kind === 'mc'
        ? chunkSize(paths, policies.length)
        : Math.max(1, Math.ceil(policies.length / defaultConcurrency()));
    const jobs: ChunkJob[] = [];
    for (let i = 0; i < policies.length; i += size) {
      jobs.push({
        kind,
        policies: policies.slice(i, i + size),
        start: i,
        input,
      });
    }

    const batch: BatchState = {
      total: jobs.length,
      done: 0,
      cancelled: false,
      settled: false,
      resolve: () => undefined,
      promise: undefined as unknown as Promise<BatchResult & DiagResult>,
      summaries: kind === 'mc' ? new Array(policies.length).fill(null) : [],
      diagnostics: kind === 'diag' ? new Array(policies.length).fill(null) : [],
      errors: kind === 'diag' ? new Array(policies.length).fill(null) : [],
    };
    batch.promise = new Promise<BatchResult & DiagResult>((res) => {
      batch.resolve = res;
    });
    hooksOf.set(batch, hooks);

    for (const job of jobs) queue.push({ job, batch });
    pump();

    const timer = setInterval(() => {
      if (batch.settled) {
        clearInterval(timer);
        hooksOf.delete(batch);
        return;
      }
      if (disposed || hooks?.shouldCancel?.()) {
        // Drop unscheduled chunks of this batch and resolve as cancelled.
        for (let i = queue.length - 1; i >= 0; i--) {
          if (queue[i].batch === batch) queue.splice(i, 1);
        }
        batch.cancelled = true;
        settle(batch);
        clearInterval(timer);
        hooksOf.delete(batch);
      }
    }, 200);

    return batch.promise;
  };

  return {
    runner: (policies: Policy[], input: MCSummaryInput, hooks?: BatchHooks) =>
      run('mc', policies, input, hooks) as Promise<BatchResult>,
    diagRunner: (policies: Policy[], hooks?: BatchHooks) =>
      run('diag', policies, undefined, hooks) as Promise<DiagResult>,
    dispose: () => {
      disposed = true;
      for (const w of workers) w.terminate();
      workers.length = 0;
      for (const q of queue.splice(0)) {
        if (!q.batch.settled) {
          q.batch.cancelled = true;
          settle(q.batch);
        }
      }
      byId.clear();
      hooksOf.clear();
    },
  };
}

/** Serial fallback when workers are unavailable. */
export function createSerialRunners(ctx: ProjectionContext): PoolRunners {
  return {
    runner: serialRunner(ctx),
    diagRunner: serialDiagRunner(ctx),
    dispose: () => undefined,
  };
}
