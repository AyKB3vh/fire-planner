/**
 * Worker-pool runner tests with a FakeWorker: chunking, response ordering,
 * progress, cancellation, and serial-equivalence of result assembly.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Policy } from '../../types';
import type { ProjectionContext } from '../../engine/projection';
import { createPoolRunners } from '../pool';

type Handler = (e: { data: Record<string, unknown> }) => void;

class FakeWorker {
  static instances: FakeWorker[] = [];
  static delay = 0;
  private handlers: Handler[] = [];
  terminated = false;

  constructor(..._args: unknown[]) {
    FakeWorker.instances.push(this);
  }

  addEventListener(_t: string, fn: Handler): void {
    this.handlers.push(fn);
  }

  removeEventListener(_t: string, fn: Handler): void {
    this.handlers = this.handlers.filter((h) => h !== fn);
  }

  postMessage(msg: Record<string, unknown>): void {
    const respond = (): void => {
      if (this.terminated) return;
      const policies = msg.policies as Policy[];
      const kind = msg.kind as string;
      const payload: Record<string, unknown> = { id: msg.id };
      if (kind === 'mc') {
        payload.summaries = policies.map((p, i) => ({
          n: (msg.input as { paths: number }).paths,
          policyId: p.id,
          i,
        }));
      } else {
        payload.diagnostics = policies.map((p, i) => ({
          central: { terminalWealth: i, feasible: true },
          policyId: p.id,
        }));
        payload.errors = policies.map(() => null);
      }
      for (const h of [...this.handlers]) h({ data: payload });
    };
    if (FakeWorker.delay === 0) respond();
    else setTimeout(respond, FakeWorker.delay);
  }

  terminate(): void {
    this.terminated = true;
  }
}

const fakeCtx = (): ProjectionContext =>
  ({}) as unknown as ProjectionContext;

const policy = (i: number): Policy =>
  ({ id: `p${i}`, phaseStartYears: [2030], remunerationByPhase: {}, iiStartDelay: 0, iiiStartDelay: 0, bufferMonths: 0, fundingRule: 'LoanFirst', remunerationTypes: {} }) as Policy;

describe('worker pool runners', () => {
  afterEach(() => {
    FakeWorker.instances = [];
    FakeWorker.delay = 0;
    vi.unstubAllGlobals();
  });

  it('assembles chunk responses in input order and reports progress', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    FakeWorker.delay = 5;
    const pool = createPoolRunners(fakeCtx);
    expect(pool).not.toBeNull();
    const policies = Array.from({ length: 24 }, (_, i) => policy(i));
    const progress: number[] = [];
    const res = await pool!.runner(
      policies,
      { paths: 100 } as never,
      { onProgress: (done, total) => progress.push(done / total) },
    );
    expect(res.cancelled).toBe(false);
    expect(res.summaries).toHaveLength(24);
    // ordering: summaries align with input despite async worker responses
    res.summaries.forEach((s, i) => {
      expect((s as unknown as { policyId: string }).policyId).toBe(`p${i}`);
      expect((s as unknown as { n: number }).n).toBe(100);
    });
    expect(progress[progress.length - 1]).toBe(1);
    pool!.dispose();
  });

  it('chunks work across multiple workers', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const pool = createPoolRunners(fakeCtx);
    const policies = Array.from({ length: 50 }, (_, i) => policy(i));
    await pool!.runner(policies, { paths: 10 } as never, {});
    expect(FakeWorker.instances.length).toBeGreaterThan(1);
    expect(FakeWorker.instances.length).toBeLessThanOrEqual(8);
    pool!.dispose();
  });

  it('diagnostics runner maps errors and diagnostics per policy', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const pool = createPoolRunners(fakeCtx);
    const policies = [policy(0), policy(1)];
    const res = await pool!.diagRunner(policies, {});
    expect(res.cancelled).toBe(false);
    expect(res.errors).toEqual([null, null]);
    expect(res.diagnostics).toHaveLength(2);
    pool!.dispose();
  });

  it('honours shouldCancel before starting a batch', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const pool = createPoolRunners(fakeCtx);
    const policies = [policy(0), policy(1), policy(2)];
    const res = await pool!.runner(policies, { paths: 100 } as never, {
      shouldCancel: () => true,
    });
    expect(res.cancelled).toBe(true);
    expect(res.summaries.every((s) => s === null)).toBe(true);
    pool!.dispose();
  });

  it('falls back safely when disposed', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const pool = createPoolRunners(fakeCtx);
    pool!.dispose();
    const res = await pool!.runner([policy(0)], { paths: 100 } as never, {});
    expect(res.cancelled).toBe(false);
    expect(res.summaries[0]).toBeNull();
  });
});
