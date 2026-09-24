/** Dashboard: overview KPIs, balance trajectory, policy summary, warnings. */

import type { ReactElement } from 'react';
import { useApp, Card, Kpi, eur, pct, wilsonText } from '../components';
import { LineChart, BarList, StackedBars, type Series } from '../charts';
import { computeHorizon } from '../../engine/projection';

const COLORS = {
  total: '#4da3ff',
  cash: '#7ee0a3',
  ou: '#f4c76b',
  ii: '#c792ea',
  iii: '#ff9eb5',
  loan: '#ff7b72',
  reserve: '#93a3b5',
};

export function DashboardView(): ReactElement {
  const { scenario, quick, result, registry } = useApp();

  const horizonYears = quick?.policy ? computeHorizon({
    household: scenario.household,
    startState: scenario.startState,
    assumptions: scenario.assumptions,
    engineSettings: scenario.engineSettings,
    registry,
    pillarOverrides: scenario.pillarOverrides,
    baseYear: 2026,
    actuals: scenario.actuals,
  }) : null;

  const years = quick?.policy?.years ?? [];
  const last = years[years.length - 1];
  const nw = (b: { personalCash: number; ouCash: number; ouInvestments: number; shareholderLoan: number; iiPillar: number; iiiPillar: number }): number =>
    b.personalCash + b.ouCash + b.ouInvestments + b.shareholderLoan + b.iiPillar + b.iiiPillar;

  const totalSeries: Series[] = quick?.policy
    ? [
        {
          name: 'Total net worth',
          color: COLORS.total,
          points: years.map((y) => ({ x: y.year, y: y.netWorthEnd })),
        },
        {
          name: 'OÜ investments',
          color: COLORS.ou,
          points: years.map((y) => ({ x: y.year, y: y.end.ouInvestments })),
        },
        {
          name: 'II pillar',
          color: COLORS.ii,
          points: years.map((y) => ({ x: y.year, y: y.end.iiPillar })),
        },
        {
          name: 'III pillar',
          color: COLORS.iii,
          points: years.map((y) => ({ x: y.year, y: y.end.iiiPillar })),
        },
        {
          name: 'Shareholder loan (negative)',
          color: COLORS.loan,
          points: years.map((y) => ({ x: y.year, y: y.end.shareholderLoan })),
        },
      ]
    : [];

  const rec = result?.variants.recommended;
  const recCand = rec?.candidateId
    ? result?.candidates.find((c) => c.candidateId === rec.candidateId)
    : undefined;
  const recFull = recCand?.full;

  const initialNW = years[0] ? nw(years[0].end) : null;

  const balanceRows = years[0]
    ? [
        { label: 'Personal cash', value: years[0].end.personalCash, color: COLORS.cash },
        { label: 'OÜ cash', value: years[0].end.ouCash, color: '#88c0d0' },
        { label: 'OÜ investments', value: years[0].end.ouInvestments, color: COLORS.ou },
        { label: 'II pillar', value: years[0].end.iiPillar, color: COLORS.ii },
        { label: 'III pillar', value: years[0].end.iiiPillar, color: COLORS.iii },
        { label: 'Shareholder loan', value: years[0].end.shareholderLoan, color: COLORS.loan },
      ]
    : [];

  const assumptions = scenario.assumptions;

  return (
    <div className="grid" style={{ gap: 14 }}>
      {result?.noPass ? (
        <div className="warn-note">
          <b>No strategy in the searched space reaches the {pct(result.target, 0)} target.</b>{' '}
          Best observed success probability: <b>{pct(result.bestObservedSuccess, 2)}</b>
          {result.dominantFailure
            ? ` — dominant failure mode: ${result.dominantFailure.kind} (${result.dominantFailure.count} paths)`
            : ''}
          . This is a diagnosis of the inputs and the searched candidates, not a
          recommendation to change your plans.
        </div>
      ) : null}
      {result && !result.noPass && rec ? (
        <div className="ok-note">
          <b>Recommended: {rec.candidateId}</b> — success probability{' '}
          <b>{recFull ? pct(recFull.successProbability, 2) : pct(rec.successProbability ?? 0, 2)}</b>{' '}
          {recFull ? (
            <>
              (Wilson 95% interval {wilsonText(recFull.wilson)}
              {result.certified ? ', certified mode ON' : ', certified mode off'})
            </>
          ) : null}
          {' — '}
          {rec.reason}
        </div>
      ) : null}

      <div className="grid cols-4">
        <Kpi
          label="Withdrawal start"
          value={scenario.startState.withdrawalStartDate}
          sub="Fixed input — 1 January only (D-01)"
        />
        <Kpi
          label="Horizon"
          value={horizonYears ? `${horizonYears.startYear}–${horizonYears.endYear}` : '—'}
          sub={horizonYears ? `${horizonYears.length} years` : 'fix starting state'}
        />
        <Kpi
          label="Net worth (start)"
          value={initialNW !== null ? eur(initialNW) : '—'}
          sub={last ? `central path end: ${eur(nw(last.end))}` : ''}
        />
        <Kpi
          label="Spending (today)"
          value={eur(assumptions.spending.targetAnnualTodayEUR)}
          sub={`inflating at ${pct(assumptions.spendingInflation, 1)}/yr`}
        />
        <Kpi
          label="Target success"
          value={pct(scenario.monteCarloSettings.targetSuccessProbability, 0)}
          sub={`${scenario.monteCarloSettings.defaultPaths.toLocaleString()} paths · seed ${scenario.monteCarloSettings.seed}${scenario.monteCarloSettings.certifiedMode ? ' · certified' : ''}`}
        />
        <Kpi
          label="Best observed (last run)"
          value={result ? pct(result.bestObservedSuccess, 2) : '—'}
          sub={result ? `run ${new Date(result.createdAt).toLocaleString()}` : 'run the optimiser'}
        />
        <Kpi
          label="Minimum cash reserve"
          value={eur(scenario.startState.minimumCashReserve)}
          sub="breaches reported separately, not failures (default)"
        />
        <Kpi
          label="Quick projection"
          value={quick?.policy ? eur(quick.policy.rankedWealth) : '—'}
          sub={`ranked wealth · ${quick?.policyLabel ?? ''}`}
        />
      </div>

      <Card title="Balance trajectory — central-return diagnostic path">
        {quick?.policy ? (
          <>
            <LineChart
              series={totalSeries}
              reference={{
                y: scenario.startState.minimumCashReserve,
                label: 'reserve',
                color: COLORS.reserve,
              }}
              yFormat={(v) => `${Math.round(v / 1000)}k`}
            />
            <div className="inline-note">
              Central-return path is a <b>diagnostic only</b> — it is not a median simulation
              and carries no probability. Use the Strategy view for Monte Carlo outcomes.
            </div>
          </>
        ) : (
          <div className="muted">No valid projection — check the starting state in Inputs.</div>
        )}
      </Card>

      <Card title="Funding sources of household spending — central diagnostic path">
        {quick?.policy ? (
          <StackedBars
            years={years.filter((_, i) => i % 3 === 0 || i === years.length - 1).map((y) => y.year)}
            series={[
              {
                name: 'State pension',
                color: '#7ee0a3',
                values: years.filter((_, i) => i % 3 === 0 || i === years.length - 1)
                  .map((y) => y.inflows.statePensionNet),
              },
              {
                name: 'OÜ remuneration',
                color: '#4da3ff',
                values: years.filter((_, i) => i % 3 === 0 || i === years.length - 1)
                  .map((y) => y.inflows.remunerationNet),
              },
              {
                name: 'Pillar fixed-term payments',
                color: '#c792ea',
                values: years.filter((_, i) => i % 3 === 0 || i === years.length - 1)
                  .map((y) => y.inflows.pillarIIPayment + y.inflows.pillarIIIPayment),
              },
              {
                name: 'Shareholder-loan repayment',
                color: '#f4c76b',
                values: years.filter((_, i) => i % 3 === 0 || i === years.length - 1)
                  .map((y) => y.inflows.loanRepayment),
              },
              {
                name: 'OÜ distribution (net)',
                color: '#ff9eb5',
                values: years.filter((_, i) => i % 3 === 0 || i === years.length - 1)
                  .map((y) => y.inflows.distributionNet),
              },
              {
                name: 'Own cash above reserve',
                color: '#88c0d0',
                values: years.filter((_, i) => i % 3 === 0 || i === years.length - 1)
                  .map((y) => y.inflows.personalCashUsedAboveReserve + y.inflows.emergencyReserveUsed),
              },
            ]}
          />
        ) : (
          <div className="muted">No projection.</div>
        )}
      </Card>

      <div className="grid cols-2">
        <Card title="Starting balances (as of)">
          <BarList data={balanceRows} format={(v) => eur(v)} />
        </Card>
        <Card title="Quick projection summary">
          {quick?.policy ? (
            <table>
              <tbody>
                <tr>
                  <td>Feasible (central)</td>
                  <td>
                    <span className={`badge ${quick.policy.feasible ? 'ok' : 'danger'}`}>
                      {quick.policy.feasible ? 'yes' : 'no — shortfall'}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td>First spending shortfall</td>
                  <td>{quick.policy.firstShortfallYear ?? 'none'}</td>
                </tr>
                <tr>
                  <td>First reserve breach</td>
                  <td>{quick.policy.firstReserveBreachYear ?? 'none'}</td>
                </tr>
                <tr>
                  <td>OÜ insolvency (equity &lt; 0)</td>
                  <td>
                    <span className={`badge ${quick.policy.ouInsolvencyAnyYear ? 'warn' : 'ok'}`}>
                      {quick.policy.ouInsolvencyAnyYear ? 'reported (D-26)' : 'no'}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td>Terminal wealth (central)</td>
                  <td className="num">{eur(quick.policy.terminalWealth)}</td>
                </tr>
                <tr>
                  <td>Lifetime tax (PV, today's €)</td>
                  <td className="num">{eur(quick.policy.lifetimeTaxPV)}</td>
                </tr>
              </tbody>
            </table>
          ) : (
            <div className="muted">—</div>
          )}
        </Card>
      </div>

      {result && result.warnings.length > 0 ? (
        <Card title={`Warnings (${result.warnings.length})`}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {result.warnings.map((w, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                {w}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
