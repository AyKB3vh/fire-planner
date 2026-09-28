/** Shared form primitives + store hook. */

import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
import { getState, subscribe } from '../state/store';
import type { AppState } from '../state/store';

export function useApp(): AppState {
  return useSyncExternalStore(subscribe, getState, getState);
}

export function parseNumericDraft(raw: string, percentage = false): number | undefined {
  if (raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? (percentage ? value / 100 : value) : undefined;
}

export function Field(props: {
  label: string;
  value: number | string;
  onChange: (v: never) => void;
  hint?: string;
  type?: string;
  step?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  percentage?: boolean;
}): ReactElement {
  const [draft, setDraft] = useState(String(props.percentage ? Number(props.value) * 100 : props.value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(Number.isFinite(Number(props.value)) ? String(props.percentage ? Number(props.value) * 100 : props.value) : '');
  }, [props.value, props.percentage]);
  return (
    <div className="field">
      <label>{props.label}</label>
      <input
        type={props.type ?? 'number'}
        inputMode={props.type === 'text' || props.type === 'date' ? undefined : 'decimal'}
        value={props.type === 'text' || props.type === 'date' ? props.value : draft}
        step={props.step}
        min={props.min}
        max={props.max}
        disabled={props.disabled}
        onChange={(e) => {
          const raw = e.target.value;
          if (props.type !== 'text' && props.type !== 'date') setDraft(raw);
          if (props.type === 'text' || props.type === 'date') {
            (props.onChange as (v: string) => void)(raw);
          } else {
            const n = parseNumericDraft(raw, props.percentage);
            if (n !== undefined) (props.onChange as (v: number) => void)(n);
          }
        }}
        onFocus={() => { focused.current = true; }}
        onBlur={() => {
          focused.current = false;
          if (props.type !== 'text' && props.type !== 'date' && (draft.trim() === '' || !Number.isFinite(Number(draft)))) {
            (props.onChange as (v: number) => void)(Number.NaN);
          }
        }}
        aria-invalid={props.type !== 'text' && props.type !== 'date' && (draft.trim() === '' || !Number.isFinite(Number(draft)))}
        onWheel={(e) => { if ((props.type ?? 'number') === 'number') e.currentTarget.blur(); }}
      />
      {props.type !== 'text' && props.type !== 'date' && (draft.trim() === '' || !Number.isFinite(Number(draft))) ? <span className="hint field-error" role="status">Enter a number before running search.</span> : null}
      {props.hint ? <span className="hint">{props.hint}</span> : null}
    </div>
  );
}

export function SelectField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  hint?: string;
}): ReactElement {
  return (
    <div className="field">
      <label>{props.label}</label>
      <select value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {props.hint ? <span className="hint">{props.hint}</span> : null}
    </div>
  );
}

export function Toggle(props: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}): ReactElement {
  return (
    <div className="field">
      <div className="field row">
        <label style={{ cursor: 'pointer' }}>{props.label}</label>
        <input
          type="checkbox"
          checked={props.checked}
          onChange={(e) => props.onChange(e.target.checked)}
          style={{ width: 'auto' }}
        />
      </div>
      {props.hint ? <span className="hint">{props.hint}</span> : null}
    </div>
  );
}

export function Card(props: { title?: string; children: ReactNode; className?: string; collapsible?: boolean; defaultOpen?: boolean }): ReactElement {
  if (props.collapsible) return (
    <details className={`card collapsible ${props.className ?? ''}`} open={props.defaultOpen}>
      {props.title ? <summary>{props.title}</summary> : null}
      <div className="collapsible-content">{props.children}</div>
    </details>
  );
  return (
    <div className={`card ${props.className ?? ''}`}>
      {props.title ? <h3>{props.title}</h3> : null}
      {props.children}
    </div>
  );
}

export function Kpi(props: { label: string; value: string; sub?: string }): ReactElement {
  return (
    <div className="card kpi">
      <h3>{props.label}</h3>
      <div className="value">{props.value}</div>
      {props.sub ? <div className="sub">{props.sub}</div> : null}
    </div>
  );
}

export const eur = (v: number, digits = 0): string =>
  v.toLocaleString('en-EE', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });

export const pct = (v: number, digits = 1): string =>
  `${(v * 100).toFixed(digits)}%`;

export function wilsonText(w: { lower: number; upper: number }): string {
  return `${pct(w.lower, 1)} – ${pct(w.upper, 1)}`;
}
