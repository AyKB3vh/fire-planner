# Estonian Household FIRE & Withdrawal Planner (spec v2.4)

Local-first, tax-aware household withdrawal planner for Estonia. React + Vite +
TypeScript (strict) / IndexedDB / Web Workers. Pure engine layers; no `any` in
the financial core.

## Commands

```bash
npm run dev        # dev server (this workspace's live preview)
npm run build      # tsc -b && vite build
npm test           # vitest: 81 tests (§15 coverage)
npm run typecheck  # tsc -b --noEmit
```

## Layout

- `src/engine/` — pure engine: money, tax, pension, healthcare, pillars,
  returns, projection (`runPolicy`), policy generation, staged optimiser,
  Monte Carlo/statistics, validation, hashing, batch runners (`mcrunner`).
- `src/rules/registry.ts` — provenance-bearing rule registry (value, unit,
  status, source, retrieved, extrapolation). Unverified rules flagged as
  assumptions in the UI.
- `src/state/store.ts` — app store: scenario CRUD, quick projection,
  optimisation runs (progress/cancel), JSON import/export.
- `src/persist/db.ts` — IndexedDB: scenarios + result cache by input hash.
- `src/workers/` — optimiser worker + main-thread pool (batched MC and stage-1
  diagnostics across `navigator.hardwareConcurrency` workers; serial fallback).
- `src/ui/` — views: Dashboard, Inputs, Strategy, Audit, Rules, Scenarios;
  SVG charts; local-first header with run/progress/cancel.

## Key invariants (Appendix A)

- Withdrawal start date is a fixed user input: 1 January only, never inferred;
  no retirement-date search; no accumulation engine.
- Central-return / stress paths are diagnostics only — never "median
  simulation"; deterministic outcomes never prune candidates (D-20).
- Success probability ≠ confidence: Wilson intervals always shown; certified
  mode off by default (D-13).
- LoanFirst default but DistributionFirst searched (D-27); remuneration type is
  explicit user input (never switched silently); reserve usable as last resort
  by default (breach reported separately); `repaymentSolvencyRule = none`.
- No-pass output is a diagnosis of the searched space — never "retire later".
- CRN: draws depend only on (seed, pathIndex); results cacheable by input hash.

## Gate status

- G1 pillar mechanics ✓, G2 tax/healthcare verify-or-flag ✓,
  G3 tax + property tests before optimisation ✓,
  G4 conservation/determinism/CRN-prefix before MC exposure ✓,
  G5 optimiser regressions ✓ (81 tests green).
