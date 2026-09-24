/** Strategy view: variants, Monte Carlo outcomes, Wilson intervals, diagnosis. */

import type { ReactElement } from 'react';
import { useApp, Card, eur, pct, wilsonText } from '../components';
import { QuantileBars } from '../charts';
import { selectCandidate } from '../../state/store';
import type { MCDistribution, StrategyVariant } from '../../types';

function variantCard(
  v: StrategyVariant,
  full: MCDistribution | undefined,
  selected: boolean,
  target: number,
  certified: boolean,
  onSelect: () => void,
): ReactElement {
  const pass = full ? full.successProbability >= target : false;
  return (
    <div
      className={`variant ${selected ? 'selected' : ''}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSelect();
      }}
    >
      <div className="name">
        {v.variant === 'recommended' ? '★ ' : ''}
        {v.variant}
        {v.candidateId ? <span className="muted"> · {v.candidateId}</span> : null}
      </div>
      <div className="metrics">
        <span>
          p̂ <b>{full ? pct(full.successProbability, 2) : v.successProbability !== null ? pct(v.successProbability, 2) : '—'}</b>
        </span>
        <span>
          Wilson{' '}
          <b>{full ? wilsonText(full.wilson) : '—'}</b>
        </span>
        <span>
          ranked <b>{v.rankedWealth !== null ? eur(v.rankedWealth) : '—'}</b>
        </span>
        <span>
          tax PV <b>{v.pvLifetimeTax !== null ? eur(v.pvLifetimeTax) : '—'}</b>
        </span>
      </div>
      {full ? (
        <div className="metrics">
          <span className={`badge ${certified && pass ? 'ok' : pass ? 'info' : 'warn'}`}>
            {certified
              ? pass
                ? 'certified pass'
                : 'certified fail (Wilson lower < target)'
              : pass
                ? 'passes p̂ ≥ target (uncertified)'
                : 'below target'}
          </span>
        </div>
      ) : null}
      <div className="reason">{v.reason}</div>
    </div>
  );
}

export function StrategyView(): ReactElement {
  const { result, selectedCandidateId } = useApp();

  if (!result) {
    return (
      <Card title="Strategy">
        <div className="muted">
          No optimisation result yet. Press <b>Run search</b> in the header to run the staged
          optimiser (screens 100 / 400 paths → full Monte Carlo → refinement).
        </div>
      </Card>
    );
  }

  const { variants, target, certified } = result;
  const selectedId =
    selectedCandidateId ?? variants.recommended.candidateId ?? result.candidates[0]?.candidateId ?? null;
  const cand = selectedId ? result.candidates.find((c) => c.candidateId === selectedId) : undefined;
  const dist = cand?.full ?? cand?.screen2 ?? cand?.screen1;

  return (
    <div className="grid" style={{ gap: 14 }}>
      {result.noPass ? (
        <div className="warn-note">
          <b>No-pass diagnosis (§10.7).</b> None of the {result.candidates.length} searched
          candidates reached {pct(target, 0)} success probability; best observed{' '}
          <b>{pct(result.bestObservedSuccess, 2)}</b>.
          {result.dominantFailure ? (
            <>
              {' '}
              Dominant failure: <b>{result.dominantFailure.kind}</b> —{' '}
              {result.dominantFailure.count} paths
              {result.dominantFailure.medianFirstYear !== null
                ? ` (median first failure year ${result.dominantFailure.medianFirstYear})`
                : ''}
              .
            </>
          ) : null}{' '}
          The closest candidates are shown neutrally below — this is a diagnosis of the searched
          space, not a recommendation.
        </div>
      ) : null}

      <div className="grid cols-2">
        {(['recommended', 'lowestTax', 'mostRobust', 'simplest'] as const).map((k) => {
          const v = variants[k];
          const c = v.candidateId
            ? result.candidates.find((x) => x.candidateId === v.candidateId)
            : undefined;
          return (
            <div key={k}>
              {variantCard(
                v,
                c?.full ?? (c?.screen2 ?? c?.screen1),
                selectedId === v.candidateId,
                target,
                certified,
                () => selectCandidate(v.candidateId),
              )}
            </div>
          );
        })}
      </div>

      <Card title={`Monte Carlo summary — ${selectedId ?? '—'}`}>
        {cand && dist ? (
          <>
            <div className="inline-note">
              {cand.full
                ? `Full simulation: ${dist.n} paths · seed ${result.seed} · common random numbers (CRN prefix property).`
                : cand.screen2
                  ? `Screen 2 (${cand.screen2.n} paths) — full simulation not reached for this candidate.`
                  : `Screen 1 (${cand.screen1?.n ?? 0} paths) — earlier screen only.`}
            </div>
            <div className="grid cols-2">
              <table>
                <tbody>
                  <tr>
                    <th>Success probability p̂</th>
                    <td className="num">
                      <b>{pct(dist.successProbability, 2)}</b> ({dist.successes}/{dist.n})
                    </td>
                  </tr>
                  <tr>
                    <th>Wilson 95% interval</th>
                    <td className="num">
                      {wilsonText(dist.wilson)}{' '}
                    </td>
                  </tr>
                  <tr>
                    <th>Target / mode</th>
                    <td className="num">
                      {pct(target, 0)} · {certified ? 'certified' : 'uncertified'}
                    </td>
                  </tr>
                  <tr>
                    <th>Spending shortfall</th>
                    <td className="num">{pct(dist.spendingShortfallProbability, 2)}</td>
                  </tr>
                  <tr>
                    <th>Coverage failure</th>
                    <td className="num">{pct(dist.coverageFailureProbability, 2)}</td>
                  </tr>
                  <tr>
                    <th>Reserve breach</th>
                    <td className="num">{pct(dist.reserveBreachProbability, 2)}</td>
                  </tr>
                  <tr>
                    <th>Liquid depletion</th>
                    <td className="num">{pct(dist.liquidDepletionProbability, 2)}</td>
                  </tr>
                  <tr>
                    <th>Total depletion</th>
                    <td className="num">{pct(dist.totalDepletionProbability, 2)}</td>
                  </tr>
                  <tr>
                    <th>OÜ insolvency</th>
                    <td className="num">{pct(dist.ouInsolvencyProbability, 2)}</td>
                  </tr>
                </tbody>
              </table>
              <div>
                <h3>Target comparison (§1.1.6)</h3>
                <table>
                  <thead>
                    <tr>
                      <th>Target</th>
                      <th>p̂ ≥ target</th>
                      <th>Wilson lower ≥ target (certified)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[0.9, 0.95, 0.97, 0.99].map((t) => (
                      <tr key={t}>
                        <td>{pct(t, 0)}</td>
                        <td>
                          <span
                            className={`badge ${dist.successProbability >= t ? 'ok' : 'warn'}`}
                          >
                            {dist.successProbability >= t ? 'pass' : 'fail'}
                          </span>
                        </td>
                        <td>
                          <span
                            className={`badge ${dist.wilson.lower >= t ? 'ok' : 'warn'}`}
                          >
                            {dist.wilson.lower >= t ? 'certified' : 'below'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <QuantileBars
                  rows={[
                    {
                      label: 'Terminal wealth (€)',
                      p5: dist.terminalWealth.p5,
                      median: dist.terminalWealth.median,
                      p95: dist.terminalWealth.p95,
                    },
                    {
                      label: 'Ranked wealth (€, median only)',
                      p5: dist.rankedWealthMedian,
                      median: dist.rankedWealthMedian,
                      p95: dist.rankedWealthMedian,
                    },
                    {
                      label: 'Lifetime tax (€)',
                      p5: dist.lifetimeTax.p5,
                      median: dist.lifetimeTax.median,
                      p95: dist.lifetimeTax.p95,
                    },
                    {
                      label: 'Extra spending (€)',
                      p5: dist.extraSpending.p5,
                      median: dist.extraSpending.median,
                      p95: dist.extraSpending.p95,
                    },
                  ]}
                />
              </div>
            </div>
            <div className="mt">
              <h3>Failure timing</h3>
              <table>
                <thead>
                  <tr>
                    <th>First failure year</th>
                    <th className="num">paths</th>
                    <th>First depletion year</th>
                    <th className="num">paths</th>
                  </tr>
                </thead>
                <tbody>
                  {Array.from({
                    length: Math.max(
                      dist.firstFailureYearHistogram.length,
                      dist.firstDepletionYearHistogram.length,
                    ),
                  }).map((_, i) => {
                    const f = dist.firstFailureYearHistogram[i];
                    const d = dist.firstDepletionYearHistogram[i];
                    return (
                      <tr key={i}>
                        <td>{f ? f.year : ''}</td>
                        <td className="num">{f ? f.count : ''}</td>
                        <td>{d ? d.year : ''}</td>
                        <td className="num">{d ? d.count : ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="muted">No distribution for this candidate.</div>
        )}
      </Card>

      <Card title="Policy detail">
        {cand ? (
          <div className="form-grid">
            <div>
              <b>Candidate</b>
              <div className="mono">{cand.candidateId}</div>
            </div>
            <div>
              <b>Funding rule</b> <span className="mono">{cand.policy.fundingRule}</span>
            </div>
            <div>
              <b>II delay</b> {cand.policy.iiStartDelay}y · <b>III delay</b>{' '}
              {cand.policy.iiiStartDelay}y
            </div>
            <div>
              <b>Buffer</b> {cand.policy.bufferMonths} months
            </div>
            <div>
              <b>Phases</b>{' '}
              <span className="mono">{cand.policy.phaseStartYears.join(' → ')}</span>
            </div>
            <div>
              <b>Remuneration (€/mo, per phase)</b>
              <div className="mono">
                {Object.entries(cand.policy.remunerationByPhase)
                  .map(([id, arr]) => `${id}: [${arr.join(', ')}]`)
                  .join('  ')}
              </div>
            </div>
            <div>
              <b>Legal type</b>
              <div className="mono">
                {Object.entries(cand.policy.remunerationTypes)
                  .map(([id, t]) => `${id}: ${t}`)
                  .join('  ')}
              </div>
            </div>
          </div>
        ) : null}
        <div className="warn-note">
          Deterministic paths in the Audit view (central, crash, lost decade, high inflation) are{' '}
          <b>diagnostics only</b> — they are never labelled median simulations and never used to
          prune candidates (D-20).
        </div>
      </Card>

      <Card title={`Stress tests — ${variants.recommended.candidateId ?? 'n/a'} (diagnostics)`}>
        {result.stressTests.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Stress</th>
                <th>Description</th>
                <th className="num">Terminal wealth (central)</th>
                <th>Feasible</th>
              </tr>
            </thead>
            <tbody>
              {result.stressTests.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.id}</td>
                  <td>{s.label}</td>
                  <td className="num">{eur(s.terminalWealth)}</td>
                  <td>
                    <span className={`badge ${s.feasible ? 'ok' : 'danger'}`}>
                      {s.feasible ? 'yes' : 'no'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="muted">No stress results.</div>
        )}
      </Card>
    </div>
  );
}
