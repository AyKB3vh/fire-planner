/**
 * Web Worker: executes batched Monte Carlo simulations or deterministic
 * diagnostics for the staged optimiser (§16.3). Receives full plain-object
 * contexts via structured clone (engine layers are pure and serialisable).
 */

import type { Policy } from '../types';
import type { ProjectionContext } from '../engine/projection';
import type { MCSummaryInput } from '../engine/montecarlo';
import { runMonteCarlo } from '../engine/montecarlo';
import { deterministicDiagnostics } from '../engine/mcrunner';

export type WorkerRequestKind = 'mc' | 'diag';

export interface WorkerRequest {
  id: number;
  kind: WorkerRequestKind;
  ctx: ProjectionContext;
  policies: Policy[];
  input?: MCSummaryInput;
}

export type WorkerResponse =
  | { id: number; kind: 'mc'; summaries: unknown[]; cancelled: false }
  | { id: number; kind: 'diag'; diagnostics: unknown[]; errors: (string | null)[]; cancelled: false }
  | { id: number; error: string };

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(msg: WorkerResponse): void;
};

scope.onmessage = (e) => {
  const { id, kind, ctx, policies, input } = e.data;
  try {
    if (kind === 'mc') {
      if (!input) throw new Error('mc request missing input');
      const summaries = policies.map(
        (p) => runMonteCarlo(ctx, p, input, {}).summary,
      );
      scope.postMessage({ id, kind: 'mc', summaries, cancelled: false });
    } else {
      const diagnostics: unknown[] = [];
      const errors: (string | null)[] = [];
      for (const p of policies) {
        try {
          diagnostics.push(deterministicDiagnostics(ctx, p));
          errors.push(null);
        } catch (err) {
          diagnostics.push(null);
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
      scope.postMessage({ id, kind: 'diag', diagnostics, errors, cancelled: false });
    }
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
