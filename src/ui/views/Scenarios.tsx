/** Scenarios view: local-first CRUD + JSON import/export. */

import type { ReactElement } from 'react';
import { useState } from 'react';
import { useApp, Card } from '../components';
import {
  createScenario,
  deleteScenario,
  duplicateScenario,
  exportScenarioJSON,
  importScenarioJSON,
  renameScenario,
  selectScenario,
} from '../../state/store';

function download(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ScenariosView(): ReactElement {
  const { scenario, scenarioRecords, dirty } = useApp();
  const [newName, setNewName] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const onImport = (file: File): void => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = importScenarioJSON(String(reader.result));
      setMsg(res.ok ? `Imported: ${file.name}` : `Import failed: ${res.error}`);
    };
    reader.readAsText(file);
  };

  return (
    <div className="grid" style={{ gap: 14 }}>
      <Card title="Active scenario">
        <div className="form-grid">
          <div className="field">
            <label>Scenario name</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                value={scenario.name}
                onChange={(e) => renameScenario(e.target.value)}
              />
              <button className="btn" onClick={() => download(`${scenario.name}.json`, exportScenarioJSON())}>
                Export JSON
              </button>
            </div>
            <span className="hint">
              {dirty ? 'unsaved edits (auto-saved shortly)' : 'saved to IndexedDB'} · id{' '}
              <span className="mono">{scenario.id.slice(0, 8)}</span> · updated{' '}
              {new Date(scenario.updatedAt).toLocaleString()}
            </span>
          </div>
        </div>
        <div className="filter-row" style={{ marginTop: 8 }}>
          <button className="btn" onClick={() => duplicateScenario()}>
            Duplicate
          </button>
          <label className="btn" style={{ cursor: 'pointer' }}>
            Import JSON…
            <input
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onImport(f);
                e.target.value = '';
              }}
            />
          </label>
          {msg ? <span className="muted">{msg}</span> : null}
        </div>
      </Card>

      <Card title={`Saved scenarios (${scenarioRecords.length})`}>
        <div className="filter-row">
          <input
            placeholder="New scenario name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={{
              background: '#1d2632',
              border: '1px solid #2a3644',
              color: '#e7edf4',
              borderRadius: 6,
              padding: '6px 9px',
              minWidth: 220,
            }}
          />
          <button
            className="btn primary"
            disabled={!newName.trim()}
            onClick={() => {
              createScenario(newName.trim());
              setNewName('');
            }}
          >
            Create
          </button>
        </div>
        <div className="grid" style={{ gap: 8 }}>
          {scenarioRecords.map((r) => (
            <div
              key={r.id}
              className={`scenario-item ${r.id === scenario.id ? 'active' : ''}`}
            >
              <div className="grow">
                <b>{r.name}</b>
                <div className="muted" style={{ fontSize: 12 }}>
                  updated {new Date(r.updatedAt).toLocaleString()} · spending{' '}
                  {r.scenario.assumptions.spending.targetAnnualTodayEUR.toLocaleString('en-EE', {
                    style: 'currency',
                    currency: 'EUR',
                    maximumFractionDigits: 0,
                  })}
                  {' · start '}
                  {r.scenario.startState.withdrawalStartDate}
                </div>
              </div>
              <button className="btn small" onClick={() => selectScenario(r.id)}>
                Open
              </button>
              <button
                className="btn small"
                onClick={() => download(`${r.name}.json`, JSON.stringify({
                  format: 'fire-planner-export',
                  version: 1,
                  exportedAt: new Date().toISOString(),
                  scenario: r.scenario,
                }, null, 2))}
              >
                Export
              </button>
              <button
                className="btn small danger"
                disabled={r.id === scenario.id}
                onClick={() => deleteScenario(r.id)}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
