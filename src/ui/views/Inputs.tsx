/** Inputs view: household, withdrawal start, balances, assumptions, settings. */

import type { CSSProperties, ReactElement } from 'react';
import { useApp, Card, Field, SelectField, Toggle, eur, pct } from '../components';
import { updateScenario } from '../../state/store';
import type { Adult, BucketKey, Provenance, Scenario } from '../../types';
import { BUCKET_KEYS } from '../../types';
import { commitScenario, runOptimisationAsync } from '../../state/store';

const BUCKET_LABELS: Record<BucketKey, string> = {
  personalCash: 'Personal cash',
  ouCash: 'OÜ cash',
  ouInvestments: 'OÜ investments',
  shareholderLoan: 'Shareholder loan',
  iiPillar: 'II pillar',
  iiiPillar: 'III pillar',
};

const numStyle: CSSProperties = {
  background: '#1d2632',
  border: '1px solid #2a3644',
  color: '#e7edf4',
  borderRadius: 5,
  padding: '4px 7px',
  width: 110,
};

const PROVENANCE_OPTIONS: { value: Provenance; label: string }[] = [
  { value: 'actual', label: 'Actual (statement)' },
  { value: 'projected', label: 'Projected' },
  { value: 'estimated', label: 'Estimated' },
  { value: 'userAssumed', label: 'User assumption' },
];

function findInvalidNumber(value: unknown, path = 'scenario'): string | null {
  if (typeof value === 'number' && !Number.isFinite(value)) return path;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const invalid = findInvalidNumber(value[index], `${path}[${index}]`);
      if (invalid) return invalid;
    }
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const invalid = findInvalidNumber(child, `${path}.${key}`);
      if (invalid) return invalid;
    }
  }
  return null;
}

export function InputsView(): ReactElement {
  const { scenario, quick, running } = useApp();
  const a = scenario.assumptions;
  const es = scenario.engineSettings;
  const mc = scenario.monteCarloSettings;
  const opt = scenario.optimisationSettings;
  const ss = scenario.startState;
  const po = scenario.pillarOverrides;

  const patch = (fn: (s: Scenario) => void): void => updateScenario(fn);

  const startYear = Number(ss.withdrawalStartDate.slice(0, 4));
  const startDateOk = /^\d{4}-01-01$/.test(ss.withdrawalStartDate);
  const totalAssets = ss.balances.personalCash + ss.balances.ouCash + ss.balances.ouInvestments + ss.balances.iiPillar + ss.balances.iiiPillar;
  const ouEquity = ss.balances.ouCash + ss.balances.ouInvestments - ss.balances.shareholderLoan;
  const blockingIssues = quick?.validated.issues.filter((i) => i.severity === 'error') ?? [];
  const warnings = quick?.validated.issues.filter((i) => i.severity === 'warning') ?? [];
  const invalidNumber = findInvalidNumber(scenario);
  const blockerCount = Math.max(blockingIssues.length, invalidNumber ? 1 : 0);

  return (
    <div className="grid inputs-page" style={{ gap: 14 }} onWheelCapture={(event) => { if ((event.target as HTMLElement).matches?.('input[type="number"]')) (event.target as HTMLInputElement).blur(); }}>
      <section className="card plan-summary" aria-label="Your plan summary">
        <div className="plan-summary-heading"><div><span className="eyebrow">Inputs</span><h2>Your plan</h2></div><button className="btn primary" disabled={running || blockerCount > 0} onClick={() => void runOptimisationAsync()}>Run search →</button></div>
        <div className="plan-facts">
          <div><span>Retirement</span><b>{startYear || '—'}</b></div>
          <div><span>Household</span><b>{scenario.household.adults.length} {scenario.household.adults.length === 1 ? 'adult' : 'adults'}</b></div>
          <div><span>Starting assets</span><b>{eur(totalAssets)}</b></div>
          <div><span>OÜ net equity</span><b>{eur(ouEquity)}</b></div>
          <div><span>Annual spending</span><b>{eur(a.spending.targetAnnualTodayEUR)}</b></div>
          <div><span>Expected return</span><b>{pct(a.returns.ou.geometricReturn)}</b></div>
          <div><span>Minimum reserve</span><b>{eur(ss.minimumCashReserve)}</b></div>
        </div>
        {blockerCount ? <div className="danger-note">{blockerCount} inputs need attention: {blockingIssues.slice(0, 3).map((i) => i.message).join(' ')} {invalidNumber ? `${invalidNumber} must contain a valid number.` : ''}</div> : <div className="ok-note">✓ Required starting inputs complete</div>}
        {warnings.slice(0, 2).map((issue, idx) => <div className="warn-note" key={`${issue.field}-${idx}`}>⚠ {issue.message}</div>)}
      </section>
      {!startDateOk ? (
        <div className="danger-note">
          Retirement start must be <b>1 January</b> of a calendar year — it is a fixed
          input, never inferred, and no date other than 01-01 is accepted.
        </div>
      ) : null}

      <Card title="1. Household" className="primary-section">
        {scenario.household.adults.map((adult, idx) => (
          <div key={adult.id} className="mb">
            <details className="adult-details" open={idx === 0}>
            <summary>
            <b>
              Adult {idx + 1}: {adult.name}
            </b>
            <span className="muted"> · Born {adult.birthMonth ? new Date(2000, adult.birthMonth - 1).toLocaleString('en', { month: 'long' }) : 'month unknown'} {adult.birthYear} · {adult.remunerationType === 'employment' ? 'Employment' : 'Board member fee'} · State pension {adult.statePensionEnabled ? 'enabled' : 'disabled'}</span>
            <span className="edit-label">Edit details</span>
            </summary>
            <div className="adult-content">
            <div className="form-grid mt">
              <Field
                label="Name"
                type="text"
                value={adult.name}
                onChange={(v: string) =>
                  patch((s) => {
                    s.household.adults[idx].name = v;
                  })
                }
              />
              <Field
                label="Birth year"
                value={adult.birthYear}
                min={1900}
                max={2100}
                onChange={(v: number) =>
                  patch((s) => {
                    s.household.adults[idx].birthYear = v;
                  })
                }
              />
              <Field
                label="Birth month (1–12)"
                value={adult.birthMonth ?? 0}
                min={0}
                max={12}
                hint="0 = unknown (Jan–June rule)"
                onChange={(v: number) =>
                  patch((s) => {
                    s.household.adults[idx].birthMonth = v === 0 ? undefined : v;
                  })
                }
              />
              <SelectField
                label="Remuneration type"
                value={adult.remunerationType}
                options={[
                  { value: 'employment', label: 'Employment' },
                  { value: 'boardMemberFee', label: 'Board member fee' },
                ]}
                hint="Recorded separately for each adult."
                onChange={(v) =>
                  patch((s) => {
                    s.household.adults[idx].remunerationType = v as Adult['remunerationType'];
                  })
                }
              />
              <Field
                label="Pension age override"
                value={adult.pensionAgeOverride ?? 0}
                min={0}
                max={100}
                hint="0 = use projected table"
                onChange={(v: number) =>
                  patch((s) => {
                    s.household.adults[idx].pensionAgeOverride = v === 0 ? undefined : v;
                  })
                }
              />
              <Field
                label="State pension today (€/mo)"
                value={adult.statePensionTodayEUR ?? 0}
                min={0}
                hint="0 = default assumption"
                onChange={(v: number) =>
                  patch((s) => {
                    s.household.adults[idx].statePensionTodayEUR = v === 0 ? undefined : v;
                  })
                }
              />
            </div>
            <div className="form-grid">
              <Toggle
                label="State pension enabled"
                checked={adult.statePensionEnabled}
                onChange={(v) =>
                  patch((s) => {
                    s.household.adults[idx].statePensionEnabled = v;
                  })
                }
              />
              <Toggle
                label="Healthcare cover required"
                checked={adult.healthcareRequired}
                onChange={(v) =>
                  patch((s) => {
                    s.household.adults[idx].healthcareRequired = v;
                  })
                }
              />
              <Toggle
                label="Work role recorded"
                checked={adult.workRoleRecorded}
                onChange={(v) =>
                  patch((s) => {
                    s.household.adults[idx].workRoleRecorded = v;
                  })
                }
              />
              <Toggle
                label="Voluntary Tervisekassa cover"
                checked={adult.voluntaryHealthcare}
                onChange={(v) =>
                  patch((s) => {
                    s.household.adults[idx].voluntaryHealthcare = v;
                  })
                }
              />
              <Toggle
                label="Explicitly allow no insurance"
                checked={adult.allowNoInsurance}
                onChange={(v) =>
                  patch((s) => {
                    s.household.adults[idx].allowNoInsurance = v;
                  })
                }
              />
            </div>
            </div>
            </details>
          </div>
        ))}
      </Card>

      <Card title="2. Retirement & starting position" className="primary-section">
        <div className="form-grid">
          <Field
            label="Retirement start year (1 January)"
            type="text"
            value={ss.withdrawalStartDate}
            hint="1 January only — validated on commit"
            onChange={(v: string) =>
              patch((s) => {
                s.startState.withdrawalStartDate = v.trim();
              })
            }
            disabled={false}
          />
          <Field
            label="Balances as of"
            type="date"
            value={ss.startingBalancesAsOf}
            hint="normally 31 Dec of the previous year"
            onChange={(v: string) =>
              patch((s) => {
                s.startState.startingBalancesAsOf = v;
              })
            }
          />
          <Field
            label="Minimum cash reserve (€)"
            value={ss.minimumCashReserve}
            min={0}
            onChange={(v: number) =>
              patch((s) => {
                s.startState.minimumCashReserve = v;
              })
            }
          />
        </div>
        <div className="inline-note">
          Starting balances refer to the day before withdrawal starts (normally 31 December).{' '}
          {startYear ? `Horizon starts ${startYear}.` : ''}
        </div>
      </Card>

      <Card title="Starting balances" className="primary-section">
        <div className="form-grid">
          {BUCKET_KEYS.map((k) => (
            <div key={k}>
              <Field
                label={`${BUCKET_LABELS[k]} (€)`}
                hint={k === 'shareholderLoan' ? 'Money your OÜ owes you. The loan is shown separately and is not added to total assets.' : undefined}
                value={ss.balances[k]}
                onChange={(v: number) =>
                  patch((s) => {
                    s.startState.balances[k] = v;
                  })
                }
              />
              <div className="field">
                <label>Provenance</label>
                <select
                  value={ss.balances.provenance[k]}
                  onChange={(e) =>
                    patch((s) => {
                      s.startState.balances.provenance[k] = e.target.value as Provenance;
                    })
                  }
                >
                  {PROVENANCE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card title="3. Spending" className="primary-section">
        <div className="form-grid">
          <Field
            label="Annual spending, today's €"
            value={a.spending.targetAnnualTodayEUR}
            min={0}
            onChange={(v: number) =>
              patch((s) => {
                s.assumptions.spending.targetAnnualTodayEUR = v;
              })
            }
          />
          <Field
            label="General inflation"
            step={0.1}
            value={a.generalInflation}
            hint={pct(a.generalInflation, 2)}
            percentage
            onChange={(v: number) =>
              patch((s) => {
                s.assumptions.generalInflation = v;
              })
            }
          />
          <Field
            label="Spending inflation"
            step={0.1}
            value={a.spendingInflation}
            hint={pct(a.spendingInflation, 2)}
            percentage
            onChange={(v: number) =>
              patch((s) => {
                s.assumptions.spendingInflation = v;
              })
            }
          />
          <Field
            label="Healthcare inflation"
            step={0.1}
            value={a.healthcareInflation}
            hint={pct(a.healthcareInflation, 2)}
            percentage
            onChange={(v: number) =>
              patch((s) => {
                s.assumptions.healthcareInflation = v;
              })
            }
          />
          <Toggle
            label="Healthcare premiums are included in annual spending"
            checked={a.spending.premiumsIncludedInSpending}
            onChange={(v) =>
              patch((s) => {
                s.assumptions.spending.premiumsIncludedInSpending = v;
              })
            }
          />
          <div className="inline-note">Healthcare premiums are {a.spending.premiumsIncludedInSpending ? `included in your ${eur(a.spending.targetAnnualTodayEUR)} annual spending figure` : `added on top of your ${eur(a.spending.targetAnnualTodayEUR)} annual spending figure`}.</div>
          <Field
            label="Voluntary healthcare premium, today €/mo"
            value={a.voluntaryPremiumTodayEUR}
            min={0}
            onChange={(v: number) =>
              patch((s) => {
                s.assumptions.voluntaryPremiumTodayEUR = v;
              })
            }
          />
        </div>
      </Card>

      <Card title="Advanced · Spending changes & one-off costs" collapsible>
        <b>Range multipliers</b>
        <table className="mb">
          <thead>
            <tr>
              <th>From year</th>
              <th>To year</th>
              <th className="num">Multiplier</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {a.spending.multipliers.map((m, i) => (
              <tr key={i}>
                <td>
                  <input
                    type="number"
                    value={m.fromYear}
                    onChange={(e) =>
                      patch((sc) => {
                        sc.assumptions.spending.multipliers[i].fromYear = e.target.value === '' ? Number.NaN : Number(e.target.value);
                      })
                    }
                    style={numStyle}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    value={m.toYear}
                    onChange={(e) =>
                      patch((sc) => {
                        sc.assumptions.spending.multipliers[i].toYear = e.target.value === '' ? Number.NaN : Number(e.target.value);
                      })
                    }
                    style={numStyle}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step="0.1"
                    value={m.multiplier}
                    onChange={(e) =>
                      patch((sc) => {
                        sc.assumptions.spending.multipliers[i].multiplier = e.target.value === '' ? Number.NaN : Number(e.target.value);
                      })
                    }
                    style={{ ...numStyle, textAlign: 'right' }}
                  />
                </td>
                <td>
                  <button
                    className="btn small danger"
                    onClick={() =>
                      patch((sc) => {
                        sc.assumptions.spending.multipliers.splice(i, 1);
                      })
                    }
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          className="btn small"
          onClick={() =>
            patch((sc) => {
              const y = Number(sc.startState.withdrawalStartDate.slice(0, 4));
              sc.assumptions.spending.multipliers.push({ fromYear: y, toYear: y + 2, multiplier: 1.2 });
            })
          }
        >
          Add multiplier
        </button>

        <b className="mt">One-off expenses (nominal €)</b>
        <table>
          <thead>
            <tr>
              <th>Year</th>
              <th className="num">Amount</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {a.spending.oneOffs.map((o, i) => (
              <tr key={i}>
                <td>
                  <input
                    type="number"
                    value={o.year}
                    onChange={(e) =>
                      patch((sc) => {
                        sc.assumptions.spending.oneOffs[i].year = e.target.value === '' ? Number.NaN : Number(e.target.value);
                      })
                    }
                    style={numStyle}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    value={o.amount}
                    onChange={(e) =>
                      patch((sc) => {
                        sc.assumptions.spending.oneOffs[i].amount = e.target.value === '' ? Number.NaN : Number(e.target.value);
                      })
                    }
                    style={{ ...numStyle, textAlign: 'right' }}
                  />
                </td>
                <td>
                  <button
                    className="btn small danger"
                    onClick={() =>
                      patch((sc) => {
                        sc.assumptions.spending.oneOffs.splice(i, 1);
                      })
                    }
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          className="btn small"
          onClick={() =>
            patch((sc) => {
              const y = Number(sc.startState.withdrawalStartDate.slice(0, 4));
              sc.assumptions.spending.oneOffs.push({ year: y + 1, amount: 10_000 });
            })
          }
        >
          Add one-off
        </button>
      </Card>

      <Card title="Actuals & tracking · Track realised balances and spending against your plan" collapsible>
        <div className="inline-note">
          Actuals override projected balances at the start of each listed year and are reported
          as an explicit revaluation-variance line in the Audit/projection output.
        </div>
        <table>
          <thead>
            <tr>
              <th>Year</th>
              <th className="num">Personal cash</th>
              <th className="num">OÜ cash</th>
              <th className="num">OÜ investments</th>
              <th className="num">Shareholder loan</th>
              <th className="num">II</th>
              <th className="num">III</th>
              <th className="num">Spending</th>
              <th>Provenance</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {Object.keys(scenario.actuals)
              .map(Number)
              .sort((x, y) => x - y)
              .map((yr) => {
                const e = scenario.actuals[yr];
                const cell = (key: keyof typeof e): ReactElement => (
                  <td className="num">
                    <input
                      type="number"
                      value={typeof e[key] === 'number' ? (e[key] as number) : ''}
                      placeholder="—"
                      onChange={(ev) =>
                        patch((sc) => {
                          const v = ev.target.value === '' ? undefined : Number(ev.target.value);
                          (sc.actuals[yr] as unknown as Record<string, unknown>)[key] = v;
                        })
                      }
                      style={{ ...numStyle, width: 90 }}
                    />
                  </td>
                );
                return (
                  <tr key={yr}>
                    <td className="mono">{yr}</td>
                    {cell('personalCash')}
                    {cell('ouCash')}
                    {cell('ouInvestments')}
                    {cell('shareholderLoan')}
                    {cell('iiPillar')}
                    {cell('iiiPillar')}
                    {cell('spending')}
                    <td>
                      <select
                        value={e.provenance}
                        onChange={(ev) =>
                          patch((sc) => {
                            sc.actuals[yr].provenance = ev.target.value as Provenance;
                          })
                        }
                        style={numStyle}
                      >
                        {PROVENANCE_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <button
                        className="btn small danger"
                        onClick={() =>
                          patch((sc) => {
                            delete sc.actuals[yr];
                          })
                        }
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
        <button
          className="btn small mt"
          onClick={() =>
            patch((sc) => {
              const y = Number(sc.startState.withdrawalStartDate.slice(0, 4));
              if (!(y in sc.actuals)) sc.actuals[y] = { year: y, provenance: 'actual' };
            })
          }
        >
          Add actual year
        </button>
      </Card>

      <Card title="4. Pensions & healthcare" className="primary-section">
        <div className="inline-note">Pension ages, access timing and healthcare coverage follow your household settings. Detailed overrides remain available below in Advanced.</div>
        <div className="form-grid">
          {scenario.household.adults.map((adult, idx) => <div key={adult.id} className="mini-card"><b>{adult.name || `Adult ${idx + 1}`}</b><Toggle label="Healthcare coverage required" checked={adult.healthcareRequired} onChange={(v) => patch((s) => { s.household.adults[idx].healthcareRequired = v; })} /><Toggle label="State pension enabled" checked={adult.statePensionEnabled} onChange={(v) => patch((s) => { s.household.adults[idx].statePensionEnabled = v; })} /></div>)}
        </div>
      </Card>

      <Card title="5. Investment assumptions" className="primary-section">
        <div className="form-grid">
          {(['ou', 'ii', 'iii'] as const).map((k) => (
            <div key={k}>
              <Field
                label={`Expected ${k.toUpperCase()} investment return`}
                step={0.1}
                value={a.returns[k].geometricReturn}
                hint={pct(a.returns[k].geometricReturn, 2)}
                percentage
                onChange={(v: number) =>
                  patch((s) => {
                    s.assumptions.returns[k].geometricReturn = v;
                  })
                }
              />
              <Field
                label={`${k.toUpperCase()} investment volatility`}
                step={1}
                value={a.returns[k].logVolatility}
                hint={pct(a.returns[k].logVolatility, 1)}
                percentage
                onChange={(v: number) =>
                  patch((s) => {
                    s.assumptions.returns[k].logVolatility = v;
                  })
                }
              />
            </div>
          ))}
          <Field
            label="Expected cash return"
            step={0.1}
            value={a.returns.cashRate}
            hint={pct(a.returns.cashRate, 2)}
            percentage
            onChange={(v: number) =>
              patch((s) => {
                s.assumptions.returns.cashRate = v;
              })
            }
          />
          <Field
            label="Equity correlation"
            step={0.01}
            value={a.returns.correlation}
            onChange={(v: number) =>
              patch((s) => {
                s.assumptions.returns.correlation = v;
              })
            }
          />
          <Field
            label="Reinvestment share of surplus"
            value={a.reinvestmentPct}
            hint={pct(a.reinvestmentPct, 0)}
            percentage
            step={5}
            onChange={(v: number) =>
              patch((s) => {
                s.assumptions.reinvestmentPct = v;
              })
            }
          />

          <Field
            label="Extra spending cap (% of target)"
            min={0}
            value={a.surplusSpendingCapPctOfTarget}
            hint={pct(a.surplusSpendingCapPctOfTarget, 0)}
            percentage
            step={5}
            onChange={(v: number) =>
              patch((s) => {
                s.assumptions.surplusSpendingCapPctOfTarget = v;
              })
            }
          />          <Field
            label="Max remuneration / adult / month (€)"
            value={a.maxRemunerationPerAdult}
            min={0}
            onChange={(v: number) =>
              patch((s) => {
                s.assumptions.maxRemunerationPerAdult = v;
              })
            }
          />
          <Field
            label="State pension indexation"
            step={0.1}
            value={a.statePensionIndexation}
            hint={pct(a.statePensionIndexation, 2)}
            percentage
            onChange={(v: number) =>
              patch((s) => {
                s.assumptions.statePensionIndexation = v;
              })
            }
          />
          <Toggle
            label="Stochastic inflation (MC)"
            checked={a.returns.stochasticInflation.enabled}
            onChange={(v) =>
              patch((s) => {
                s.assumptions.returns.stochasticInflation.enabled = v;
              })
            }
          />
        </div>
        <div className="inline-note">
          Consumption valuation &amp; PV discount default to the OÜ geometric return (
          {eur(0)} base): {pct(a.consumptionValuationRate, 2)} / {pct(a.pvDiscountRate, 2)}.
        </div>
      </Card>

      <Card title="6. Advanced settings">
      <Card title="Engine settings" collapsible>
        <div className="form-grid">
          <Toggle
            label="Reserve usable as last resort"
            checked={es.reserveUsableAsLastResort}
            hint="default on; breach reported separately (D-17)"
            onChange={(v) =>
              patch((s) => {
                s.engineSettings.reserveUsableAsLastResort = v;
              })
            }
          />
          <SelectField
            label="Repayment solvency rule"
            value={es.repaymentSolvencyRule}
            options={[
              { value: 'none', label: 'none (D-16 default)' },
              { value: 'blockIfEquityNegative', label: 'blockIfEquityNegative' },
            ]}
            onChange={(v) =>
              patch((s) => {
                s.engineSettings.repaymentSolvencyRule = v as Scenario['engineSettings']['repaymentSolvencyRule'];
              })
            }
          />
          <Toggle
            label="Search DistributionFirst"
            checked={es.includeDistributionFirst}
            hint="D-27: searched alongside LoanFirst (default rule remains LoanFirst)"
            onChange={(v) =>
              patch((s) => {
                s.engineSettings.includeDistributionFirst = v;
              })
            }
          />
          <Toggle
            label="Distributable equity includes unrealised gains"
            checked={es.distributableEquityIncludesUnrealisedGains}
            hint="assumption — confirm with accountant"
            onChange={(v) =>
              patch((s) => {
                s.engineSettings.distributableEquityIncludesUnrealisedGains = v;
              })
            }
          />
          <Toggle
            label="Search remuneration type (advanced)"
            checked={es.searchRemunerationType}
            hint="off by default: type is user input, never switched silently"
            onChange={(v) =>
              patch((s) => {
                s.engineSettings.searchRemunerationType = v;
              })
            }
          />
          <Field
            label="II contribution rate"
            step={0.1}
            value={es.iiContributionRate}
            hint="spec default 0%"
            percentage
            onChange={(v: number) =>
              patch((s) => {
                s.engineSettings.iiContributionRate = v;
              })
            }
          />
        </div>
      </Card>

      <Card title="Pension access overrides" collapsible>
        <div className="form-grid">
          <Field
            label="II access year (0 = derived)"
            value={po.iiAccessYear ?? 0}
            min={0}
            onChange={(v: number) =>
              patch((s) => {
                s.pillarOverrides.iiAccessYear = v === 0 ? null : v;
              })
            }
          />
          <Field
            label="III access year (0 = derived)"
            value={po.iiiAccessYear ?? 0}
            min={0}
            onChange={(v: number) =>
              patch((s) => {
                s.pillarOverrides.iiiAccessYear = v === 0 ? null : v;
              })
            }
          />
          <Field
            label="II term override, years (0 = table)"
            value={po.iiTermOverride ?? 0}
            min={0}
            onChange={(v: number) =>
              patch((s) => {
                s.pillarOverrides.iiTermOverride = v === 0 ? null : v;
              })
            }
          />
          <Field
            label="III term override, years (0 = table)"
            value={po.iiiTermOverride ?? 0}
            min={0}
            onChange={(v: number) =>
              patch((s) => {
                s.pillarOverrides.iiiTermOverride = v === 0 ? null : v;
              })
            }
          />
          <Toggle
            label="0%-tax long-term route available in 5-yr early window"
            checked={po.iiEarlyWindowAssumedAvailable}
            hint="Gate G1 item — set per legal evidence"
            onChange={(v) =>
              patch((s) => {
                s.pillarOverrides.iiEarlyWindowAssumedAvailable = v;
              })
            }
          />
        </div>
      </Card>

      <Card title="Monte Carlo settings" collapsible>
        <div className="form-grid">
          <SelectField
            label="Target success probability"
            value={String(mc.targetSuccessProbability)}
            options={[
              { value: '0.9', label: '90%' },
              { value: '0.95', label: '95% (default)' },
              { value: '0.97', label: '97%' },
              { value: '0.99', label: '99%' },
            ]}
            onChange={(v) =>
              patch((s) => {
                s.monteCarloSettings.targetSuccessProbability = Number(v);
              })
            }
          />
          <SelectField
            label="Precision"
            value={mc.precision}
            options={[
              { value: 'quick', label: `quick (${mc.quickPaths} paths)` },
              { value: 'default', label: `default (${mc.defaultPaths} paths)` },
              { value: 'high', label: `high (${mc.highPrecisionPaths} paths)` },
            ]}
            onChange={(v) =>
              patch((s) => {
                s.monteCarloSettings.precision = v as Scenario['monteCarloSettings']['precision'];
              })
            }
          />
          <Field
            label="Seed"
            value={mc.seed}
            min={0}
            onChange={(v: number) =>
              patch((s) => {
                s.monteCarloSettings.seed = v;
              })
            }
          />
          <Toggle
            label="Certified mode (Wilson lower bound ≥ target)"
            checked={mc.certifiedMode}
            hint="off by default; success ≠ confidence (D-13)"
            onChange={(v) =>
              patch((s) => {
                s.monteCarloSettings.certifiedMode = v;
              })
            }
          />
          <Toggle
            label="Require zero reserve breaches for success"
            checked={mc.requireNoReserveBreach}
            onChange={(v) =>
              patch((s) => {
                s.monteCarloSettings.requireNoReserveBreach = v;
              })
            }
          />
        </div>
      </Card>

      <Card title="Search settings" collapsible>
        <div className="form-grid">
          <Field
            label="II delay min (years)"
            value={opt.pillarDelayMin}
            min={0}
            onChange={(v: number) =>
              patch((s) => {
                s.optimisationSettings.pillarDelayMin = v;
              })
            }
          />
          <Field
            label="II delay max (years)"
            value={opt.pillarDelayMax}
            min={0}
            onChange={(v: number) =>
              patch((s) => {
                s.optimisationSettings.pillarDelayMax = v;
              })
            }
          />
          <Field
            label="Buffer candidates (months, comma)"
            type="text"
            value={opt.bufferCandidates.join(', ')}
            onChange={(v: string) =>
              patch((s) => {
                s.optimisationSettings.bufferCandidates = v
                  .split(',')
                  .map((x) => Number(x.trim()))
                  .filter((x) => Number.isFinite(x) && x >= 0);
              })
            }
          />
          <Field
            label="Refinement iterations"
            value={opt.refinementIterations}
            min={0}
            onChange={(v: number) =>
              patch((s) => {
                s.optimisationSettings.refinementIterations = v;
              })
            }
          />
          <Field
            label="Max stage-0 candidates (0 = no cap)"
            value={opt.maxStage0Candidates ?? 0}
            min={0}
            onChange={(v: number) =>
              patch((s) => {
                s.optimisationSettings.maxStage0Candidates = v === 0 ? null : v;
              })
            }
          />
        </div>
        <div className="inline-note">
          Stage-0 grid = (delay<sub>II</sub> × delay<sub>III</sub> × buffers × rules × remuneration
          kinks). Kinks are derived from the tax/healthcare rule registry for the start year.
        </div>
      </Card>
      </Card>
      <div className="sticky-runbar">
        <div>{blockerCount ? <span className="text-danger">{blockerCount} inputs need attention</span> : <span className="text-ok">✓ Inputs valid</span>}</div>
        <div className="sticky-actions"><button className="btn" onClick={commitScenario}>Save</button><button className="btn primary" disabled={running || blockerCount > 0} onClick={() => void runOptimisationAsync()}>Run search →</button></div>
      </div>
    </div>
  );
}
