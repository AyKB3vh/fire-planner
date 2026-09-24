/** App shell: header (scenario, run controls), tabs, view routing. */

import { useEffect, useState, type ReactElement } from 'react';
import { useApp, pct } from './components';
import {
  boot,
  cancelRun,
  runOptimisationAsync,
  selectScenario,
  selectView,
  exportScenarioJSON,
  importScenarioJSON,
  type ViewId,
} from '../state/store';
import { DashboardView } from './views/Dashboard';
import { InputsView } from './views/Inputs';
import { StrategyView } from './views/Strategy';
import { AuditView } from './views/Audit';
import { RulesView } from './views/Rules';
import { ScenariosView } from './views/Scenarios';
import type { StageId } from '../types';

const TABS: { id: ViewId; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'inputs', label: 'Inputs' },
  { id: 'strategy', label: 'Strategy' },
  { id: 'audit', label: 'Audit' },
  { id: 'rules', label: 'Rules' },
  { id: 'scenarios', label: 'Scenarios' },
];

export function App(): ReactElement {
  const s = useApp();
  const [stageFilter, setStageFilter] = useState<StageId | 'all'>('all');
  const [search, setSearch] = useState('');
  const [importMsg, setImportMsg] = useState<string | null>(null);

  useEffect(() => {
    void boot();
  }, []);

  const stageLabel = s.progress
    ? `${s.progress.stage}: ${s.progress.label} (${pct(s.progress.fraction, 0)})`
    : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          FIRE &amp; Withdrawal Planner <small>Estonia · local-first · spec v2.4</small>
        </div>
        <select
          value={s.scenario.id}
          onChange={(e) => selectScenario(e.target.value)}
          style={{
            background: '#1d2632',
            border: '1px solid #2a3644',
            color: '#e7edf4',
            borderRadius: 6,
            padding: '6px 9px',
            maxWidth: 240,
          }}
        >
          {s.scenarioRecords.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <span className="spacer" />
        {stageLabel ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 240 }}>
            <div className="progress">
              <div style={{ width: `${Math.round((s.progress?.fraction ?? 0) * 100)}%` }} />
            </div>
            <span className="progress-label">{stageLabel}</span>
          </div>
        ) : null}
        {s.running ? (
          <button className="btn danger" onClick={cancelRun}>
            Cancel
          </button>
        ) : (
          <button
            className="btn primary"
            onClick={() => void runOptimisationAsync()}
            title="Run the staged optimiser with Monte Carlo screens"
          >
            Run search
          </button>
        )}
        <label className="btn" style={{ cursor: 'pointer' }} title="Import a scenario JSON file">
          Import
          <input
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const reader = new FileReader();
              reader.onload = () => {
                const res = importScenarioJSON(String(reader.result));
                setImportMsg(res.ok ? `Imported ${f.name}` : `Import failed: ${res.error}`);
                setTimeout(() => setImportMsg(null), 4000);
              };
              reader.readAsText(f);
              e.target.value = '';
            }}
          />
        </label>
        <button
          className="btn"
          onClick={() => {
            const blob = new Blob([exportScenarioJSON()], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${s.scenario.name}.json`;
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          Export
        </button>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab ${s.view === t.id ? 'active' : ''}`}
            onClick={() => selectView(t.id)}
          >
            {t.label}
            {t.id === 'strategy' && s.result?.noPass ? ' ⚠' : ''}
          </button>
        ))}
      </nav>

      <main className="main">
        {s.error ? <div className="danger-note">{s.error}</div> : null}
        {importMsg ? <div className="inline-note">{importMsg}</div> : null}
        {s.view === 'dashboard' ? <DashboardView /> : null}
        {s.view === 'inputs' ? <InputsView /> : null}
        {s.view === 'strategy' ? <StrategyView /> : null}
        {s.view === 'audit' ? (
          <AuditView
            stageFilter={stageFilter}
            setStageFilter={setStageFilter}
            search={search}
            setSearch={setSearch}
          />
        ) : null}
        {s.view === 'rules' ? <RulesView /> : null}
        {s.view === 'scenarios' ? <ScenariosView /> : null}
      </main>

      <footer
        className="muted"
        style={{ padding: '10px 18px', borderTop: '1px solid #2a3644', fontSize: 12 }}
      >
        Local-first: data stays in this browser (IndexedDB). Success probability ≠ confidence —
        Wilson intervals always shown. Central-path outputs are diagnostics, not median
        simulations. Unverified tax/healthcare rules are flagged as assumptions.
        {s.result ? (
          <>
            {' · '}last run: best observed p̂ {pct(s.result.bestObservedSuccess, 2)}, horizon{' '}
            {s.result.horizon.startYear}–{s.result.horizon.endYear}
          </>
        ) : null}
      </footer>
    </div>
  );
}
