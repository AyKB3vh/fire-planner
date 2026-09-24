/** Audit view: staged-candidate provenance, removal reasons, diagnostics. */

import type { ReactElement } from 'react';
import { useApp, Card, pct } from '../components';
import type { StageId } from '../../types';

const STAGES: (StageId | 'all')[] = [
  'all',
  'stage1',
  'stage2a',
  'stage2b',
  'stage3',
  'stage4',
];

const STAGE_LABELS: Record<string, string> = {
  all: 'All stages',
  stage1: '1 · structure + diagnostics',
  stage2a: '2A · screen 100 paths',
  stage2b: '2B · screen 400 paths',
  stage3: '3 · full simulation',
  stage4: '4 · refinement',
};

export function AuditView({
  stageFilter,
  setStageFilter,
  search,
  setSearch,
}: {
  stageFilter: StageId | 'all';
  setStageFilter: (s: StageId | 'all') => void;
  search: string;
  setSearch: (s: string) => void;
}): ReactElement {
  const { result } = useApp();

  if (!result) {
    return (
      <Card title="Audit">
        <div className="muted">
          Every candidate's staging provenance appears here after a run: which stage removed it,
          why, and what it scored. Nothing is ever pruned without a recorded reason.
        </div>
      </Card>
    );
  }

  const records = result.stageRecords.filter((r) => {
    if (stageFilter !== 'all' && r.stage !== stageFilter) return false;
    if (search && !r.candidateId.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const removals = result.candidates.filter((c) => c.removedAtStage !== null);

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="grid cols-4">
        <Card title="Candidates">
          <b>{result.candidates.length}</b> generated
          <div className="muted">input hash {result.inputHash.slice(0, 12)}…</div>
        </Card>
        <Card title="Passed target">
          <b>{result.candidates.filter((c) => c.passes).length}</b> / {result.candidates.length}
        </Card>
        <Card title="Duration">
          <b>{(result.durationMs / 1000).toFixed(1)}s</b>
          <div className="muted">
            {result.pathsUsed.toLocaleString()} paths (full) · seed {result.seed}
          </div>
        </Card>
        <Card title="Outcome">
          {result.noPass ? (
            <span className="badge warn">no-pass diagnosis</span>
          ) : (
            <span className="badge ok">recommendation available</span>
          )}
          {result.cancelled ? <span className="badge danger"> cancelled</span> : null}
        </Card>
      </div>

      <Card title="Staged candidate records">
        <div className="filter-row">
          {STAGES.map((s) => (
            <span
              key={s}
              className={`chip ${stageFilter === s ? 'active' : ''}`}
              onClick={() => setStageFilter(s)}
              role="button"
              tabIndex={0}
            >
              {STAGE_LABELS[s]}
            </span>
          ))}
          <input
            placeholder="filter candidate id…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              background: '#1d2632',
              border: '1px solid #2a3644',
              color: '#e7edf4',
              borderRadius: 6,
              padding: '5px 9px',
              minWidth: 180,
            }}
          />
          <span className="muted">{records.length} records</span>
        </div>
        <div style={{ maxHeight: 440, overflowY: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Candidate</th>
                <th>Stage</th>
                <th>Outcome</th>
                <th>Reason</th>
                <th className="num">Failures</th>
                <th className="num">p̂</th>
                <th className="num">Ranked wealth</th>
              </tr>
            </thead>
            <tbody>
              {records.slice(0, 500).map((r, i) => (
                <tr key={`${r.candidateId}-${r.stage}-${i}`}>
                  <td className="mono">{r.candidateId}</td>
                  <td>{r.stage}</td>
                  <td>
                    <span className={`badge ${r.survived ? 'ok' : 'danger'}`}>
                      {r.survived ? 'survived' : 'removed'}
                    </span>
                  </td>
                  <td>{r.reason}</td>
                  <td className="num">{r.failures ?? ''}</td>
                  <td className="num">
                    {r.successProbability !== undefined ? pct(r.successProbability, 2) : ''}
                  </td>
                  <td className="num">
                    {r.rankedWealth !== undefined && r.rankedWealth !== null
                      ? Math.round(r.rankedWealth).toLocaleString('en-EE')
                      : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid cols-2">
        <Card title={`Removals (${removals.length})`}>
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Candidate</th>
                  <th>Removed at</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {removals.slice(0, 200).map((c) => (
                  <tr key={c.candidateId}>
                    <td className="mono">{c.candidateId}</td>
                    <td>{c.removedAtStage}</td>
                    <td>{c.removalReason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Deterministic diagnostics (stage 1 · D-20 diagnostics only)">
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Candidate</th>
                  <th className="num">Central</th>
                  <th className="num">Crash −35%</th>
                  <th className="num">Lost decade</th>
                  <th className="num">High inflation</th>
                </tr>
              </thead>
              <tbody>
                {result.candidates
                  .filter((c) => c.diagnostics)
                  .slice(0, 200)
                  .map((c) => (
                    <tr key={c.candidateId}>
                      <td className="mono">{c.candidateId}</td>
                      <td className="num">
                        {Math.round(c.diagnostics!.central.terminalWealth).toLocaleString('en-EE')}
                      </td>
                      <td className="num">
                        {Math.round(c.diagnostics!.firstYearCrash.terminalWealth).toLocaleString('en-EE')}
                      </td>
                      <td className="num">
                        {Math.round(c.diagnostics!.lostDecade.terminalWealth).toLocaleString('en-EE')}
                      </td>
                      <td className="num">
                        {c.diagnostics!.highInflation
                          ? Math.round(c.diagnostics!.highInflation.terminalWealth).toLocaleString('en-EE')
                          : '—'}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {result.warnings.length > 0 ? (
        <Card title={`Warnings (${result.warnings.length})`}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title="Run metadata">
        <table>
          <tbody>
            <tr>
              <th>Input hash</th>
              <td className="mono">{result.inputHash}</td>
            </tr>
            <tr>
              <th>Created</th>
              <td>{new Date(result.createdAt).toLocaleString()}</td>
            </tr>
            <tr>
              <th>Horizon</th>
              <td>
                {result.horizon.startYear}–{result.horizon.endYear}
              </td>
            </tr>
            <tr>
              <th>Certified mode</th>
              <td>{result.certified ? 'on' : 'off'}</td>
            </tr>
            <tr>
              <th>Starting state</th>
              <td>
                <span className={`badge ${result.validated.ok ? 'ok' : 'danger'}`}>
                  {result.validated.ok ? 'valid' : 'invalid — run stopped'}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </Card>
    </div>
  );
}
