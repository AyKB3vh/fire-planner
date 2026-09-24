/** Rules view: inspect and edit the provenance-bearing rule registry. */

import type { ReactElement } from 'react';
import { useApp, Card } from '../components';
import { resetRules, updateRule } from '../../state/store';
import type { RuleEntry, RuleStatus } from '../../types';

function statusBadge(status: RuleStatus): ReactElement {
  const cls =
    status === 'verified' ? 'ok' : status === 'secondary' ? 'info' : 'warn';
  return <span className={`badge ${cls}`}>{status}</span>;
}

export function RulesView(): ReactElement {
  const { registry } = useApp();
  const entries = Object.entries(registry).sort(([, a], [, b]) =>
    a.id === b.id ? b.year - a.year : a.id.localeCompare(b.id),
  );

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="inline-note">
        Every numeric rule carries value, unit, status, source, retrieval date and an
        extrapolation method. <b>Unverified rules are flagged as assumptions</b> in warnings and
        results remain provisional until they are verified.
      </div>

      <Card title={`Rule registry (${entries.length} entries)`}>
        <div className="filter-row">
          <button className="btn small" onClick={resetRules}>
            Reset to defaults
          </button>
          <span className="muted">
            Edits are marked <i>userAssumed</i> and feed projections immediately.
          </span>
        </div>
        <div style={{ maxHeight: 560, overflowY: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Rule</th>
                <th>Year</th>
                <th className="num">Value</th>
                <th>Unit</th>
                <th>Status</th>
                <th>Extrapolation</th>
                <th>Source</th>
                <th>Retrieved</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([key, e]: [string, RuleEntry]) => (
                <tr key={key}>
                  <td>
                    <b>{e.label}</b>
                    <div className="mono muted">{e.id}</div>
                    {e.notes ? (
                      <div className="muted" style={{ fontSize: 11.5, maxWidth: 320 }}>
                        {e.notes}
                      </div>
                    ) : null}
                  </td>
                  <td>{e.year}</td>
                  <td className="num">
                    <input
                      type="number"
                      step="any"
                      value={e.value}
                      onChange={(ev) => {
                        const n = Number(ev.target.value);
                        if (Number.isFinite(n)) updateRule(key, { value: n });
                      }}
                      style={{
                        width: 110,
                        background: '#1d2632',
                        border: '1px solid #2a3644',
                        color: '#e7edf4',
                        borderRadius: 5,
                        padding: '4px 7px',
                        textAlign: 'right',
                      }}
                    />
                  </td>
                  <td>{e.unit}</td>
                  <td>
                    <select
                      value={e.status}
                      onChange={(ev) => updateRule(key, { status: ev.target.value as RuleStatus })}
                      style={{
                        background: '#1d2632',
                        border: '1px solid #2a3644',
                        color: '#e7edf4',
                        borderRadius: 5,
                        padding: '3px 6px',
                      }}
                    >
                      <option value="verified">verified</option>
                      <option value="secondary">secondary</option>
                      <option value="unverified">unverified</option>
                      <option value="userAssumed">userAssumed</option>
                    </select>{' '}
                    {statusBadge(e.status)}
                  </td>
                  <td>{e.extrapolation}</td>
                  <td>
                    <a href={e.source} target="_blank" rel="noreferrer" style={{ color: '#4da3ff' }}>
                      source
                    </a>
                  </td>
                  <td>{e.retrieved}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
