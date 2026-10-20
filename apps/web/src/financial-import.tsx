import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, Check, Download, FileSpreadsheet, Upload, X } from 'lucide-react';
import type { FinancialDatasetSummary, StoredFinancialDataset } from '../../../packages/core/src/index';
import { api, ApiError, message } from './api';
import { confirmsFinancialImport, hasFinancialSummary, type FinancialImportPayload } from './financial-import-confirmation';
import './usage-import.css';

const MAX_BYTES = 1024 * 1024;
const EXAMPLE_PERIOD = { from: '2026-09-08', through: '2026-09-14' };
const EXAMPLE_CSV = `date,record_id,category,revenue,cost,currency
2026-09-01,example-001,Apparel,1000.00,600.00,USD
2026-09-03,example-002,Footwear,800.00,480.00,USD
2026-09-05,example-003,Accessories,200.00,100.00,USD
2026-09-08,example-004,Apparel,1200.00,840.00,USD
2026-09-10,example-005,Footwear,1000.00,700.00,USD
2026-09-14,example-006,Accessories,300.00,150.00,USD
`;
type Period = Readonly<{ from: string; through: string }>;
export interface FinancialCsvImportProps {
  onImported: (summary: FinancialDatasetSummary) => void | Promise<void>;
  onOpenSource?: (sourceId: string) => void;
  onPrepareTask?: (summary: FinancialDatasetSummary) => void;
  disabled?: boolean;
  triggerLabel?: string;
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith('0000-')
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function validPeriod(period: Period): boolean { return validDate(period.from) && validDate(period.through) && period.from <= period.through; }

/** Uploaded records stay in memory for an uncertain retry, never in browser storage. */
export function FinancialCsvImport({ onImported, onOpenSource, onPrepareTask, disabled = false, triggerLabel = 'Upload financial CSV' }: FinancialCsvImportProps) {
  const uid = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const successHeading = useRef<HTMLHeadingElement>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [period, setPeriod] = useState<Period>({ from: '', through: '' });
  const [completeCoverage, setCompleteCoverage] = useState(false);
  const [payload, setPayload] = useState<FinancialImportPayload | null>(null);
  const [saved, setSaved] = useState<FinancialDatasetSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refreshWarning, setRefreshWarning] = useState('');

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (open && !dialog.current?.open) { dialog.current?.showModal(); if (!saved) fileInput.current?.focus(); }
    else if (!open && dialog.current?.open) dialog.current.close();
  }, [open, saved]);
  useEffect(() => { if (saved && open) successHeading.current?.focus(); }, [saved, open]);
  useEffect(() => {
    if (!busy && !payload) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const navigate = (event: Event) => {
      event.preventDefault(); setOpen(true);
      if (!busy) setError('Confirm this import with Retry before leaving. Your file and reporting dates are still here.');
    };
    window.addEventListener('beforeunload', unload);
    window.addEventListener('rivetfields:before-navigate', navigate);
    return () => { window.removeEventListener('beforeunload', unload); window.removeEventListener('rivetfields:before-navigate', navigate); };
  }, [busy, payload]);

  const periodValid = validPeriod(period);
  const currentStart = periodValid ? Date.parse(`${period.from}T00:00:00Z`) : 0;
  const previousStart = periodValid ? currentStart - (Date.parse(`${period.through}T00:00:00Z`) - currentStart + 86_400_000) : 0;
  const coverageRange = periodValid ? { from: previousStart >= Date.parse('0001-01-01T00:00:00Z') ? new Date(previousStart).toISOString().slice(0, 10) : period.from, through: period.through } : null;
  function close() {
    if (inFlight.current) return;
    dialog.current?.close(); setOpen(false); opener.current?.focus({ preventScroll: true });
  }
  function selectPeriod(key: keyof Period, value: string) { setPeriod(previous => ({ ...previous, [key]: value })); setCompleteCoverage(false); setError(''); }
  function selectFile(next: File | null) {
    setError(''); setCompleteCoverage(false);
    if (!next) { setFile(null); return; }
    if (!next.name.toLowerCase().endsWith('.csv')) { setFile(null); setError('Choose a .csv file.'); return; }
    if (!next.size || next.size > MAX_BYTES) { setFile(null); setError('Choose a nonempty CSV no larger than 1 MiB.'); return; }
    if (new TextEncoder().encode(next.name).length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(next.name) || next.name !== next.name.trim()) {
      setFile(null); setError('Use a filename of at most 200 bytes without surrounding spaces or control characters.'); return;
    }
    setFile(next);
  }
  function useExample() {
    setFile(new File([EXAMPLE_CSV], 'fictional-financial-example.csv', { type: 'text/csv' }));
    setPeriod(EXAMPLE_PERIOD); setCompleteCoverage(true); setError('');
    if (fileInput.current) fileInput.current.value = '';
  }
  function downloadExample() {
    const url = URL.createObjectURL(new Blob([EXAMPLE_CSV], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'fictional-financial-example.csv'; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (!period.from && !period.through) setPeriod(EXAMPLE_PERIOD);
  }
  async function importFile() {
    if (inFlight.current || disabled) return;
    if (!payload && (!file || !periodValid)) { setError(!file ? 'Choose a CSV file first.' : 'Choose real reporting dates in order.'); return; }
    inFlight.current = true; setBusy(true); setError('');
    let submitted = false, postConfirmed = false;
    try {
      let next = payload;
      if (!next && file) {
        const bytes = await file.arrayBuffer();
        if (!bytes.byteLength || bytes.byteLength > MAX_BYTES) throw new Error('Choose a nonempty CSV no larger than 1 MiB.');
        let csv: string;
        try { csv = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch { throw new Error('Save this CSV as UTF-8 and choose the file again.'); }
        next = Object.freeze({ csv, sourceName: file.name, period: Object.freeze({ ...period }), ...(completeCoverage && coverageRange ? { coverage: Object.freeze({ ...coverageRange, complete: true }) } : {}) });
      }
      if (!next) throw new Error('Choose a CSV file first.');
      setPayload(next); submitted = true;
      const summary = await api<unknown>('/api/datasets/financial', { method: 'POST', body: JSON.stringify(next) });
      if (!hasFinancialSummary(summary)) throw new Error('The import response was incomplete. Retry to confirm the saved version.');
      postConfirmed = true;
      const readback = await api<StoredFinancialDataset>(`/api/datasets/financial/${encodeURIComponent(summary.id)}`);
      if (!confirmsFinancialImport(next, summary, readback)) {
        throw new Error('The saved version could not be confirmed. Retry to check the same import.');
      }
      if (!mounted.current) return;
      setSaved(summary); setPayload(null); setRefreshWarning('');
      try { await onImported(summary); }
      catch { if (mounted.current) setRefreshWarning('Your import is saved. Refresh Files if it has not appeared in the list yet.'); }
    } catch (cause) {
      if (!mounted.current) return;
      const rejected = submitted && !postConfirmed && cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && cause.status !== 408;
      if (!submitted || rejected) setPayload(null);
      setError(message(cause));
    } finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  function importAnother() {
    setSaved(null); setPayload(null); setFile(null); setCompleteCoverage(false); setError(''); setRefreshWarning('');
    if (fileInput.current) fileInput.current.value = '';
  }
  function leaveUnconfirmed() { if (!inFlight.current) { setPayload(null); close(); } }

  return <>
    <button type="button" ref={opener} className="button secondary usage-import-trigger" disabled={disabled} onClick={() => setOpen(true)}><Upload size={15} />{triggerLabel}</button>
    <dialog ref={dialog} className="usage-import-dialog" aria-labelledby={`${uid}-title`} onCancel={event => { event.preventDefault(); close(); }} onClose={() => setOpen(false)}>
      <header><span><FileSpreadsheet size={18} /><h2 id={`${uid}-title`}>{saved ? 'Financial source ready' : 'Upload financial CSV'}</h2></span><button type="button" className="icon-button" aria-label="Close financial CSV import" disabled={busy} onClick={close}><X size={17} /></button></header>
      {saved ? <div className="usage-import-body">
        <div className="usage-import-success"><span className="usage-import-check"><Check size={18} /></span><div><h3 ref={successHeading} tabIndex={-1}>{saved.sourceName}</h3><p>{saved.rowCount.toLocaleString()} records saved · {saved.currency} · {saved.period.from} to {saved.period.through} UTC</p></div></div>
        <p className="usage-import-copy">Your file and calculated summary are saved in Files. Prepare a report to compare revenue, costs and gross margin.</p>
        {saved.warnings.length > 0 && <div className="usage-import-notice" role="status">{saved.warnings.map((warning, index) => <p key={`${warning.code}-${index}`}>{warning.message}</p>)}</div>}
        {refreshWarning && <p className="usage-import-notice" role="status">{refreshWarning}</p>}
        <div className="usage-import-next">
          {onOpenSource && <button type="button" className="button secondary" disabled={busy} onClick={() => { close(); onOpenSource(saved.source.id); }}>Open source<ArrowRight size={14} /></button>}
          {onPrepareTask && <button type="button" className="button usage-import-primary" disabled={busy} onClick={() => { close(); onPrepareTask(saved); }}>Prepare financial report<ArrowRight size={14} /></button>}
        </div>
        <button type="button" className="text-button usage-import-another" disabled={busy} onClick={importAnother}>Import another CSV</button>
      </div> : <form aria-busy={busy} onSubmit={event => { event.preventDefault(); void importFile(); }}>
        <div className="usage-import-body">
          <p className="usage-import-copy">Compare revenue, costs and margin.</p>
          <div className="usage-import-file"><label htmlFor={`${uid}-file`}><FileSpreadsheet size={20} /><span><strong>{file?.name ?? 'Choose a financial CSV'}</strong><small>{file ? `${(file.size / 1024).toFixed(1)} KB · ready to import` : 'CSV · up to 1 MB'}</small></span></label><input id={`${uid}-file`} ref={fileInput} type="file" accept=".csv,text/csv" disabled={busy || Boolean(payload)} onChange={event => selectFile(event.target.files?.[0] ?? null)} /></div>
          <label className="usage-import-date" htmlFor={`${uid}-from`}><span>From</span><input id={`${uid}-from`} type="date" min="0001-01-01" max="9999-12-31" required value={period.from} disabled={busy || Boolean(payload)} onInput={event => selectPeriod('from', event.currentTarget.value)} onChange={event => selectPeriod('from', event.currentTarget.value)} /></label>
          <label className="usage-import-date" htmlFor={`${uid}-through`}><span>To</span><input id={`${uid}-through`} type="date" min={validDate(period.from) ? period.from : '0001-01-01'} max="9999-12-31" required value={period.through} disabled={busy || Boolean(payload)} onInput={event => selectPeriod('through', event.currentTarget.value)} onChange={event => selectPeriod('through', event.currentTarget.value)} /><small>Dates include the full day, in UTC.</small></label>
          <details className="usage-import-format"><summary>Compare with the previous period</summary><label className="usage-import-coverage"><input type="checkbox" checked={completeCoverage} disabled={!coverageRange || busy || Boolean(payload)} onChange={event => setCompleteCoverage(event.target.checked)} /><span>I confirm this file includes all revenue and costs for {coverageRange ? `${coverageRange.from} through ${coverageRange.through}` : 'this period and the preceding period of equal length'}.<small>Leave unchecked if incomplete. Growth comparisons require complete data for both periods.</small></span></label></details>
          <details className="usage-import-format"><summary>CSV format and example</summary><p>UTF-8 CSV, up to 10,000 rows. Use one currency: USD, EUR or GBP. Include these six columns in this order:</p><code style={{ overflowWrap: 'anywhere' }}>date,record_id,category,revenue,cost,currency</code><p>One recognized-revenue record per row, with a unique record_id and a YYYY-MM-DD date. Revenue and cost are nonnegative amounts with at most two decimal places. Blank cost is not zero.</p><p>Raw refunds, credit notes and negative adjustments are not supported. Do not drop or change their signs to make a file import.</p><div className="usage-example-actions"><button type="button" className="text-button" disabled={busy || Boolean(payload)} onClick={useExample}>Use fictional example<ArrowRight size={14} /></button><button type="button" className="text-button" disabled={busy || Boolean(payload)} onClick={downloadExample}><Download size={14} />Download CSV</button></div><small>6 fictional records · September 1–14, 2026 · both weeks complete</small></details>
          <p className="usage-import-privacy">Saved to this workspace and shared with its members.</p>
          {error && <div className="usage-import-notice is-error" role="alert"><p>{error}</p>{payload && <><p>The import may already be saved. Retry checks this same file, period and coverage declaration.</p>{!busy && <button type="button" className="text-button" onClick={leaveUnconfirmed}>Leave for now</button>}</>}</div>}
        </div>
        <footer><button type="button" className="button secondary" disabled={busy} onClick={close}>Close</button><button type="submit" className="button usage-import-primary" disabled={disabled || busy || (!payload && (!file || !periodValid))}>{busy ? 'Saving and checking…' : payload ? 'Retry import' : 'Import CSV'}{!busy && <ArrowRight size={14} />}</button></footer>
      </form>}
    </dialog>
  </>;
}
