import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, Check, Download, FileSpreadsheet, Upload, X } from 'lucide-react';
import type { StoredUsageDataset, UsageDatasetSummary } from '../../../packages/core/src/index';
import { api, ApiError, message } from './api';
import './usage-import.css';

const MAX_BYTES = 1024 * 1024;
const EXAMPLE_WEEK = '2026-09-14';
const EXAMPLE_CSV = `date,user_id,event
2026-09-07,example-001,lesson_started
2026-09-08,example-002,lesson_started
2026-09-09,example-001,lesson_completed
2026-09-10,example-003,lesson_started
2026-09-11,example-002,lesson_completed
2026-09-13,example-003,lesson_completed
2026-09-14,example-001,lesson_started
2026-09-14,example-002,lesson_started
2026-09-15,example-001,lesson_completed
2026-09-15,example-003,lesson_started
2026-09-16,example-002,lesson_completed
2026-09-17,example-003,lesson_completed
2026-09-18,example-004,lesson_started
2026-09-20,example-004,lesson_completed
`;
type ImportPayload = Readonly<{ csv: string; sourceName: string; weekStart: string; coverage?: { from: string; through: string; complete: boolean } }>;
export interface UsageCsvImportProps {
  onImported: (summary: UsageDatasetSummary) => void | Promise<void>;
  onOpenSource?: (sourceId: string) => void;
  onPrepareTask?: (summary: UsageDatasetSummary) => void;
  disabled?: boolean;
  triggerLabel?: string;
}

function validWeek(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const start = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== value) return false;
  return new Date(start + 6 * 86_400_000).getUTCFullYear() <= 9999;
}

function hasSummary(value: unknown): value is UsageDatasetSummary {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<UsageDatasetSummary>;
  return typeof item.id === 'string' && typeof item.contentHash === 'string'
    && typeof item.sourceName === 'string' && Number.isSafeInteger(item.rowCount) && Number(item.rowCount) > 0
    && Number.isSafeInteger(item.duplicateRows) && Number(item.duplicateRows) >= 0
    && Array.isArray(item.warnings) && item.warnings.every(warning => warning && typeof warning.message === 'string')
    && typeof item.period?.from === 'string' && typeof item.period.through === 'string'
    && typeof item.source?.id === 'string' && typeof item.source.title === 'string' && typeof item.source.content === 'string';
}

/** One deliberate action in the Knowledge library; original CSV rows never enter browser storage. */
export function UsageCsvImport({ onImported, onOpenSource, onPrepareTask, disabled = false, triggerLabel = 'Upload usage CSV' }: UsageCsvImportProps) {
  const uid = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const successHeading = useRef<HTMLHeadingElement>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [weekStart, setWeekStart] = useState('');
  const [completeCoverage, setCompleteCoverage] = useState(false);
  const [payload, setPayload] = useState<ImportPayload | null>(null);
  const [saved, setSaved] = useState<UsageDatasetSummary | null>(null);
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
      event.preventDefault();
      setOpen(true);
      if (!busy) setError('Confirm this import with Retry before leaving. Your file and reporting date are still here.');
    };
    window.addEventListener('beforeunload', unload);
    window.addEventListener('rivetfields:before-navigate', navigate);
    return () => {
      window.removeEventListener('beforeunload', unload);
      window.removeEventListener('rivetfields:before-navigate', navigate);
    };
  }, [busy, payload]);

  function close() {
    if (inFlight.current) return;
    dialog.current?.close();
    setOpen(false);
    opener.current?.focus({ preventScroll: true });
  }
  function downloadExample() {
    const url = URL.createObjectURL(new Blob([EXAMPLE_CSV], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'fictional-usage-example.csv'; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (!weekStart) setWeekStart(EXAMPLE_WEEK);
  }
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
  function selectWeek(value: string) { setWeekStart(value); setCompleteCoverage(false); setError(''); }
  const coverageRange = validWeek(weekStart) ? {
    from: new Date(Date.parse(`${weekStart}T00:00:00Z`) - (weekStart >= '0001-01-08' ? 7 : 0) * 86_400_000).toISOString().slice(0, 10),
    through: new Date(Date.parse(`${weekStart}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10),
  } : null;
  function useExample() {
    setFile(new File([EXAMPLE_CSV], 'fictional-usage-example.csv', { type: 'text/csv' }));
    setWeekStart(EXAMPLE_WEEK); setCompleteCoverage(true); setError('');
    if (fileInput.current) fileInput.current.value = '';
  }
  async function importFile() {
    if (inFlight.current || disabled) return;
    if (!payload && (!file || !validWeek(weekStart))) {
      setError(!file ? 'Choose a CSV file first.' : 'Choose a real starting date for the seven-day reporting period.'); return;
    }
    inFlight.current = true; setBusy(true); setError('');
    let submitted = false;
    let postConfirmed = false;
    try {
      let next = payload;
      if (!next && file) {
        const bytes = await file.arrayBuffer();
        if (bytes.byteLength > MAX_BYTES) throw new Error('The CSV must be no larger than 1 MiB.');
        let csv: string;
        try { csv = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch { throw new Error('Save this CSV as UTF-8 and choose the file again.'); }
        next = Object.freeze({ csv, sourceName: file.name, weekStart, ...(completeCoverage && coverageRange ? { coverage: { ...coverageRange, complete: true } } : {}) });
      }
      if (!next) throw new Error('Choose a CSV file first.');
      // The same exact upload and week is retried; the server assigns a stable content-based version.
      setPayload(next); submitted = true;
      const summary = await api<unknown>('/api/datasets/usage', { method: 'POST', body: JSON.stringify(next) });
      if (!hasSummary(summary)) throw new Error('The import response was incomplete. Retry to confirm the saved version.');
      postConfirmed = true;
      const readback = await api<StoredUsageDataset>(`/api/datasets/usage/${encodeURIComponent(summary.id)}`);
      if (!hasSummary(readback) || readback.id !== summary.id || readback.contentHash !== summary.contentHash
        || readback.source.id !== summary.source.id || readback.source.content !== summary.source.content
        || readback.period.from !== summary.period.from || readback.period.through !== summary.period.through
        || readback.period.from !== next.weekStart || readback.csv !== next.csv
        || JSON.stringify(readback.coverage) !== JSON.stringify(next.coverage)) {
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
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function importAnother() {
    setSaved(null); setPayload(null); setFile(null); setCompleteCoverage(false); setError(''); setRefreshWarning('');
    if (fileInput.current) fileInput.current.value = '';
  }
  function leaveUnconfirmed() {
    if (inFlight.current) return;
    // Release only the local retry/navigation guard. The server may already
    // have saved the import; this is not cancellation or deletion.
    setPayload(null);
    close();
  }

  return <>
    <button type="button" ref={opener} className="button secondary usage-import-trigger" disabled={disabled} onClick={() => setOpen(true)}><Upload size={15} />{triggerLabel}</button>
    <dialog ref={dialog} className="usage-import-dialog" aria-labelledby={`${uid}-title`} onCancel={event => { event.preventDefault(); close(); }} onClose={() => setOpen(false)}>
      <header><span><FileSpreadsheet size={18} /><h2 id={`${uid}-title`}>{saved ? 'Usage source ready' : 'Upload usage CSV'}</h2></span><button type="button" className="icon-button" aria-label="Close CSV import" disabled={busy} onClick={close}><X size={17} /></button></header>
      {saved ? <div className="usage-import-body">
        <div className="usage-import-success"><span className="usage-import-check"><Check size={18} /></span><div><h3 ref={successHeading} tabIndex={-1}>{saved.sourceName}</h3><p>{saved.rowCount.toLocaleString()} rows saved · {saved.period.from} to {saved.period.through} UTC</p></div></div>
        <p className="usage-import-copy">Your file and calculated summary are saved in Files. Prepare a visual report to see the activity, comparisons and evidence together.</p>
        {saved.warnings.length > 0 && <div className="usage-import-notice" role="status">{saved.warnings.map((warning, index) => <p key={`${warning.code}-${index}`}>{warning.message}</p>)}</div>}
        {refreshWarning && <p className="usage-import-notice" role="status">{refreshWarning}</p>}
        <div className="usage-import-next">
          {onOpenSource && <button type="button" className="button secondary" disabled={busy} onClick={() => { close(); onOpenSource(saved.source.id); }}>Open source<ArrowRight size={14} /></button>}
          {onPrepareTask && <button type="button" className="button usage-import-primary" disabled={busy} onClick={() => { close(); onPrepareTask(saved); }}>Prepare visual report<ArrowRight size={14} /></button>}
        </div>
        <button type="button" className="text-button usage-import-another" disabled={busy} onClick={importAnother}>Import another CSV</button>
      </div> : <form aria-busy={busy} onSubmit={event => { event.preventDefault(); void importFile(); }}>
        <div className="usage-import-body">
          <p className="usage-import-copy">Add one export and choose the week you want to understand.</p>
          <div className="usage-import-file"><label htmlFor={`${uid}-file`}><FileSpreadsheet size={20} /><span><strong>{file?.name ?? 'Choose a usage CSV'}</strong><small>{file ? `${(file.size / 1024).toFixed(1)} KB · ready to import` : 'UTF-8 · up to 1 MiB and 10,000 rows'}</small></span></label><input id={`${uid}-file`} ref={fileInput} type="file" accept=".csv,text/csv" disabled={busy || Boolean(payload)} onChange={event => selectFile(event.target.files?.[0] ?? null)} /></div>
          <label className="usage-import-date" htmlFor={`${uid}-week`}><span>Reporting week starts</span><input id={`${uid}-week`} type="date" min="0001-01-01" max="9999-12-25" required value={weekStart} disabled={busy || Boolean(payload)} onInput={event => selectWeek(event.currentTarget.value)} onChange={event => selectWeek(event.currentTarget.value)} /><small>Seven days, using UTC dates.</small></label>
          <label className="usage-import-coverage"><input type="checkbox" checked={completeCoverage} disabled={!coverageRange || busy || Boolean(payload)} onChange={event => setCompleteCoverage(event.target.checked)} /><span>This export contains all events for {coverageRange ? `${coverageRange.from} through ${coverageRange.through}` : 'this week and the previous week'}.<small>Optional. Without this declaration, missing dates stay unknown and growth comparisons are withheld.</small></span></label>
          <details className="usage-import-format"><summary>CSV format and example</summary><p>This first import supports activity data with these three columns in this order:</p><code>date,user_id,event</code><p>One event per row. Dates use YYYY-MM-DD. Repeated rows are kept and flagged for review.</p><div className="usage-example-actions"><button type="button" className="text-button" disabled={busy || Boolean(payload)} onClick={useExample}>Use fictional example<ArrowRight size={14} /></button><button type="button" className="text-button" disabled={busy || Boolean(payload)} onClick={downloadExample}><Download size={14} />Download CSV</button></div><small>14 fictional rows · September 7–20, 2026 · both weeks complete</small></details>
          <p className="usage-import-privacy">Shared with members of this workspace. The agent receives calculated summaries; original rows stay saved here.</p>
          {error && <div className="usage-import-notice is-error" role="alert"><p>{error}</p>{payload && <><p>The import may already be saved. Retry checks the same import. Uploading the same file and week again will reuse that version.</p>{!busy && <button type="button" className="text-button" onClick={leaveUnconfirmed}>Leave for now</button>}</>}</div>}
        </div>
        <footer><button type="button" className="button secondary" disabled={busy} onClick={close}>Close</button><button type="submit" className="button usage-import-primary" disabled={disabled || busy || (!payload && (!file || !validWeek(weekStart)))}>{busy ? 'Saving and checking…' : payload ? 'Retry import' : 'Import CSV'}{!busy && <ArrowRight size={14} />}</button></footer>
      </form>}
    </dialog>
  </>;
}
