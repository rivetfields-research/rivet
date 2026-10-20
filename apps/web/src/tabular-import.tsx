import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, Check, Download, FileSpreadsheet, Upload, X } from 'lucide-react';
import type { CanonicalField, CsvMapping, CsvPlatform, CsvPreview } from '../../../packages/data-layer/src/tabular/types';
import type { StoredTabularDataset, TabularDatasetSummary } from '../../../packages/core/src/tabular-datasets';
import { api, ApiError, message } from './api';
import type { DataDiagnostic } from '../../../packages/data-layer/src/errors';
import type { TabularValidation } from '../../../packages/core/src/tabular-validation';
import { csvImportReady, importFix, suggestCsvColumns } from './tabular-mapping';
import { FileUploadProgress, announceFileReady } from './file-upload-feedback';

const MAX_BYTES = 1024 * 1024;
const FIELDS: readonly { id: CanonicalField; label: string; required?: boolean }[] = [
  { id: 'postId', label: 'Post ID', required: true }, { id: 'publishedAt', label: 'Published at' },
  { id: 'account', label: 'Account' }, { id: 'contentType', label: 'Content type' },
  { id: 'likes', label: 'Likes' }, { id: 'reactions', label: 'Reactions' }, { id: 'comments', label: 'Comments' }, { id: 'shares', label: 'Shares' },
  { id: 'impressions', label: 'Impressions' }, { id: 'clicks', label: 'Clicks' }, { id: 'saves', label: 'Saves' },
];
export const SYNTHETIC_SOCIAL_CSV = `post_id,published_at,account,content_type,likes,comments,shares,impressions,clicks
synthetic-001,2026-09-01T10:00:00Z,Synthetic studio,Image,12,3,2,400,8
synthetic-002,2026-09-03T14:30:00Z,Synthetic studio,Video,25,6,4,900,15
synthetic-003,2026-09-05T09:00:00Z,Synthetic studio,Image,0,0,0,0,0
synthetic-004,2026-09-08T10:00:00Z,Synthetic studio,Video,18,4,3,600,10
synthetic-005,2026-09-10T14:30:00Z,Synthetic studio,Image,9,2,1,,4
synthetic-006,2026-09-12T09:00:00Z,Synthetic studio,Video,30,8,5,1100,20
`;

export type TabularImportSummary = TabularDatasetSummary;
export interface TabularImportPayload { readonly csv: string; readonly sourceName: string; readonly mapping: CsvMapping }
type TabularReadback = StoredTabularDataset;
export interface TabularCsvImportProps {
  readonly disabled?: boolean;
  readonly onImported: (summary: TabularImportSummary) => void | Promise<void>;
  readonly onOpenSource?: (sourceId: string) => void;
  readonly onPrepareTask?: (task: string) => void;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly initialFile?: File;
  readonly autoAttach?: boolean;
  readonly onPendingChange?: (pending: boolean) => void;
  readonly onChooseFile?: () => void;
  readonly onUseAsText?: () => void;
  readonly useLabel?: string;
  readonly onUse?: (summary: TabularImportSummary) => void | Promise<void>;
  readonly onPrepareSavedTask?: (summary: TabularImportSummary) => void | Promise<void>;
}

function mappingEqual(a: CsvMapping, b: CsvMapping): boolean {
  return Boolean(a && b && a.columns && b.columns) && a.confirmed === true && b.confirmed === true && a.platform === b.platform && a.account === b.account && a.timezone === b.timezone
    && FIELDS.every(field => a.columns[field.id] === b.columns[field.id]);
}
export function isTabularSummary(value: unknown): value is TabularImportSummary {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<TabularImportSummary>;
  return typeof item.id === 'string' && item.id.length > 0 && typeof item.sourceName === 'string'
    && typeof item.sourceHash === 'string' && typeof item.batchId === 'string' && typeof item.createdAt === 'string' && Number.isSafeInteger(item.bytes) && Array.isArray(item.warnings)
    && Number.isSafeInteger(item.rowCount) && item.rowCount! >= 0 && Boolean(item.source && typeof item.source.id === 'string' && typeof item.source.title === 'string')
    && Boolean(item.mapping && item.mapping.confirmed === true && item.mapping.columns && typeof item.mapping.columns === 'object');
}
export function confirmsTabularImport(payload: TabularImportPayload, summary: TabularImportSummary, value: unknown): boolean {
  if (!isTabularSummary(value)) return false;
  const saved = value as TabularReadback;
  return saved.csv === payload.csv && saved.id === summary.id && saved.sourceName === summary.sourceName
    && saved.rowCount === summary.rowCount && saved.bytes === summary.bytes && saved.sourceHash === summary.sourceHash && saved.batchId === summary.batchId
    && saved.source.id === summary.source.id && saved.source.title === summary.source.title && saved.source.content === summary.source.content
    && mappingEqual(payload.mapping, saved.mapping) && mappingEqual(payload.mapping, summary.mapping)
    && saved.dataset?.id === summary.id && saved.dataset.sourceHash === summary.sourceHash && saved.dataset.rows?.length === summary.rowCount && mappingEqual(payload.mapping, saved.dataset.mapping);
}
export function tabularReportTask(summary: TabularImportSummary): string {
  const grouping = summary.mapping.columns.contentType ? 'content type (groupBy: contentType)' : 'post (groupBy: post)';
  return `Create a source-linked social performance report using the exact saved CSV datasetId ${summary.id} (${summary.sourceName}). Inspect the confirmed column mapping first. Analyze the full uploaded file, including all its rows, without a date filter. Analyze only available mapped metrics and group the results by ${grouping}. Use this single grouping for one interactive bar chart and aggregated data table; the CSV download contains this aggregated table. Calculation evidence in the report links formulas to original source rows. Label synthetic data explicitly when indicated by the filename or saved source metadata. Explain missing values, zero denominators and coverage limits. Use UTC for publication dates; export counts do not establish activity during the publication period. Metric capture time, native-export status and whether counts are lifetime counts remain unknown unless explicitly documented by the source; do not assume them.`;
}

/** Preview and pending retries remain in memory; source records never go into browser storage. */
export function TabularCsvImport({ disabled = false, onImported, onOpenSource, onPrepareTask, open: controlledOpen, onOpenChange, initialFile, autoAttach = false, onPendingChange, onChooseFile, onUseAsText, useLabel = 'Use in a task', onUse, onPrepareSavedTask }: TabularCsvImportProps) {
  const uid = useId(), dialog = useRef<HTMLDialogElement>(null), opener = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null), stageHeading = useRef<HTMLHeadingElement>(null), errorPanel = useRef<HTMLDivElement>(null);
  const active = useRef(true), inFlight = useRef(false), initialHandled = useRef<File | undefined>(undefined);
  const handingOff = useRef(false);
  const [internalOpen, setInternalOpen] = useState(false), [file, setFile] = useState<File | null>(null);
  const open = controlledOpen ?? internalOpen;
  function setOpen(value: boolean) { setInternalOpen(value); onOpenChange?.(value); }
  const [csv, setCsv] = useState(''), [preview, setPreview] = useState<CsvPreview | null>(null);
  const [platform, setPlatform] = useState<CsvPlatform>('unspecified'), [account, setAccount] = useState('');
  const [columns, setColumns] = useState<Partial<Record<CanonicalField, string>>>({});
  const [showMapping, setShowMapping] = useState(false);
  const [diagnostics, setDiagnostics] = useState<readonly DataDiagnostic[]>([]);
  const [ambiguous, setAmbiguous] = useState<readonly CanonicalField[]>([]);
  const [utc, setUtc] = useState(false), [showDates, setShowDates] = useState(false);
  const [pending, setPending] = useState<TabularImportPayload | null>(null), [saved, setSaved] = useState<TabularImportSummary | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [refreshWarning, setRefreshWarning] = useState('');
  const [needsReview, setNeedsReview] = useState(false);
  const visible = open && (!autoAttach || !initialFile || needsReview);
  useEffect(() => { onPendingChange?.(Boolean(pending) || busy); }, [pending, busy, onPendingChange]);

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (!initialFile) { initialHandled.current = undefined; return; }
    if (initialHandled.current === initialFile) return;
    initialHandled.current = initialFile; reset(); void chooseFile(initialFile);
  }, [initialFile]);
  useEffect(() => {
    if (visible && !dialog.current?.open) { dialog.current?.showModal(); fileInput.current?.focus(); }
    if (!visible && dialog.current?.open) dialog.current.close();
  }, [visible]);
  useEffect(() => { if (visible && (preview || saved)) stageHeading.current?.focus(); }, [preview, saved, visible]);
  useEffect(() => { if (visible && error) errorPanel.current?.focus(); }, [error, visible]);
  useEffect(() => {
    if (!pending && !busy) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const navigate = (event: Event) => { if (handingOff.current) return; event.preventDefault(); setOpen(true); if (!busy) setError('Retry to confirm this saved import before leaving. Your file and mapping are still here.'); };
    window.addEventListener('beforeunload', unload); window.addEventListener('rivetfields:before-navigate', navigate);
    return () => { window.removeEventListener('beforeunload', unload); window.removeEventListener('rivetfields:before-navigate', navigate); };
  }, [pending, busy]);

  function close() { if (inFlight.current) return; setOpen(false); opener.current?.focus({ preventScroll: true }); }
  async function handoff(summary: TabularImportSummary, action: (summary: TabularImportSummary) => void | Promise<void>) {
    handingOff.current = true;
    try { await action(summary); } finally { handingOff.current = false; }
  }
  function reset() {
    setNeedsReview(false);
    setFile(null); setCsv(''); setPreview(null); setSaved(null); setPending(null); setColumns({}); setPlatform('unspecified'); setAccount(''); setUtc(false); setShowDates(false); setError(''); setRefreshWarning(''); setDiagnostics([]); setShowMapping(false); setAmbiguous([]);
    if (fileInput.current) fileInput.current.value = '';
  }
  async function chooseFile(next: File | null) {
    if (disabled || inFlight.current) return;
    setError(''); setDiagnostics([]); setPreview(null); setCsv(''); setColumns({}); setPlatform('unspecified'); setAccount(''); setUtc(false); setShowDates(false); setAmbiguous([]);
    if (next && (!next.name.toLowerCase().endsWith('.csv') || !next.size || next.size > MAX_BYTES)) { setNeedsReview(true); setFile(null); setError('Choose a nonempty .csv file no larger than 1 MiB.'); return; }
    if (next && (next.name.length > 180 || /[/\\\u0000-\u001f\u007f-\u009f]/u.test(next.name) || next.name !== next.name.trim())) { setNeedsReview(true); setFile(null); setError('Use a filename of at most 180 characters without slashes, surrounding spaces or control characters.'); return; }
    setFile(next);
    if (next) await previewFile(next);
  }
  async function previewFile(selected: File | null = file) {
    if (!selected || disabled || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      const bytes = await selected.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > MAX_BYTES) throw new Error('Choose a nonempty CSV no larger than 1 MiB.');
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new Error('Save the CSV as UTF-8 and choose the file again.'); }
      const response = await api<CsvPreview>('/api/datasets/tabular/preview', { method: 'POST', body: JSON.stringify({ csv: text }) });
      if (!Array.isArray(response.headers) || !Array.isArray(response.sampleRows) || !Number.isSafeInteger(response.rowCount)) throw new Error('The CSV preview was incomplete. Try again.');
      if (active.current) {
        const suggestions = suggestCsvColumns(response.headers);
        setCsv(text); setPreview(response); setColumns(suggestions.columns); setAmbiguous(suggestions.ambiguous);
        const ready = csvImportReady(suggestions.columns, suggestions.ambiguous);
        setShowMapping(!ready);
        if (autoAttach && onUse && ready) {
          // Reuse the same full-file validation, durable save and exact readback as manual corrections.
          inFlight.current = false;
          await save({ csv: text, sourceName: selected.name, mapping: { confirmed: true, platform: 'unspecified', columns: suggestions.columns } }, response.rowCount);
        } else setNeedsReview(true);
      }
    } catch (cause) { if (active.current) { setNeedsReview(true); setError(message(cause)); setDiagnostics(cause instanceof ApiError ? cause.diagnostics : []); } }
    finally { inFlight.current = false; if (active.current) setBusy(false); }
  }
  const canSave = csvImportReady(columns, ambiguous);
  async function save(automatic?: TabularImportPayload, rowCount = preview?.rowCount) {
    if (disabled || inFlight.current || (!automatic && !pending && (!canSave || !file || !preview))) return;
    inFlight.current = true; setBusy(true); setError(''); setDiagnostics([]); let submitted = false, acknowledged = false, attached = false;
    try {
      const mapping: CsvMapping = { confirmed: true, platform: platform as CsvPlatform, columns: { ...columns }, ...(account.trim() ? { account: account.trim() } : {}), ...(utc ? { timezone: 'UTC' as const } : {}) };
      const payload = pending ?? automatic ?? { csv, sourceName: file!.name, mapping };
      if (!pending) {
        const check = await api<TabularValidation>('/api/datasets/tabular/validate', { method: 'POST', body: JSON.stringify({ csv: payload.csv, mapping: payload.mapping }) });
        if (!check || typeof check.valid !== 'boolean' || (check.valid && (!Number.isSafeInteger(check.rowCount) || check.rowCount !== rowCount))) throw new Error('The row check was incomplete. Please try again.');
        if (!check.valid) { setNeedsReview(true); setDiagnostics(check.diagnostics); if (check.diagnostics.some(item => item.code === 'invalid_date')) setShowDates(true); if (check.diagnostics.some(item => item.code !== 'invalid_date')) setShowMapping(true); setError('One detail needs your attention before this file is ready.'); return; }
      }
      setPending(payload); submitted = true;
      const summary = await api<unknown>('/api/datasets/tabular', { method: 'POST', body: JSON.stringify(payload) });
      if (!isTabularSummary(summary)) throw new Error('The save response was incomplete. Retry to confirm the same import.');
      acknowledged = true;
      const readback = await api<unknown>(`/api/datasets/tabular/${encodeURIComponent(summary.id)}`);
      if (!confirmsTabularImport(payload, summary, readback)) throw new Error('The saved file and mapping could not be confirmed. Retry to check the same import.');
      if (!active.current) return;
      setSaved(summary); setPending(null); setRefreshWarning('');
      try { await onImported(summary); } catch { if (active.current) setRefreshWarning('Your CSV is saved. Refresh Tables if it has not appeared yet.'); }
      if (onUse && active.current) { await handoff(summary, onUse); attached = true; announceFileReady(summary.sourceName, summary.rowCount); }
    } catch (cause) {
      if (!active.current) return;
      setNeedsReview(true);
      if (!submitted || (!acknowledged && cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && cause.status !== 408)) setPending(null);
      setError(message(cause)); setDiagnostics(cause instanceof ApiError ? cause.diagnostics : []);
    } finally { inFlight.current = false; if (active.current) { setBusy(false); if (attached) close(); } }
  }
  function map(field: CanonicalField, header: string) {
    setColumns(previous => { const next = { ...previous }; if (header) next[field] = header; else delete next[field]; return next; }); setAmbiguous(previous => previous.filter(item => item !== field)); setError(''); setDiagnostics([]);
  }

  async function useSaved(action: (summary: TabularImportSummary) => void | Promise<void>) {
    if (!saved || disabled || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    let used = false;
    try { await handoff(saved, action); used = true; announceFileReady(saved.sourceName, saved.rowCount); }
    catch (cause) { if (active.current) setError(message(cause)); }
    finally { inFlight.current = false; if (active.current) setBusy(false); }
    if (used && active.current) close();
  }

  return <>
    {open && autoAttach && !needsReview && initialFile && <FileUploadProgress name={initialFile.name}/>}
    {controlledOpen === undefined && <button ref={opener} type="button" className="button secondary tabular-import-trigger" disabled={disabled} onClick={() => setOpen(true)}><Upload size={15} />Upload social CSV</button>}
    <dialog ref={dialog} className="tabular-import-dialog" aria-labelledby={`${uid}-title`} onCancel={event => { event.preventDefault(); close(); }} onClose={() => { if (visible) setOpen(false); opener.current?.focus({ preventScroll: true }); }}>
      <header><span><FileSpreadsheet size={18} /><h2 id={`${uid}-title`}>{saved ? 'Social CSV ready' : 'Upload social CSV'}</h2></span><button type="button" className="icon-button" aria-label="Close social CSV import" disabled={busy} onClick={close}><X size={17} /></button></header>
      {saved ? <div className="tabular-import-body">
        <div className="tabular-import-success"><Check size={20} /><div><h3 ref={stageHeading} tabIndex={-1}>{saved.sourceName}</h3><p>{saved.rowCount.toLocaleString()} rows saved{saved.mapping.platform !== 'unspecified' && ` · ${saved.mapping.platform}`}</p></div></div>
        <p>Your CSV is ready. Ask a short question about it or prepare a report.</p>
        {!!saved.warnings?.length && <details><summary>Import notes ({saved.warnings.length})</summary><ul>{saved.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}</li>)}</ul></details>}
        {refreshWarning && <p role="status">{refreshWarning}</p>}
        {error && <p role="alert" className="tabular-notice is-error">{error}</p>}
        <div className="tabular-import-actions">{onOpenSource && <button type="button" className="button secondary" disabled={busy} onClick={() => { close(); onOpenSource(saved.source.id); }}>Open source<ArrowRight size={14} /></button>}{onUse && <button type="button" className="button" disabled={busy || disabled} onClick={() => void useSaved(onUse)}>{busy ? 'Attaching…' : useLabel}<ArrowRight size={14}/></button>}{(onPrepareTask || onPrepareSavedTask) && <button type="button" className="button secondary" disabled={busy || disabled} onClick={() => void useSaved(summary => onPrepareSavedTask ? onPrepareSavedTask(summary) : onPrepareTask!(tabularReportTask(summary)))}>Prepare social report<ArrowRight size={14} /></button>}</div>
        <button type="button" className="text-button" disabled={busy} onClick={() => { reset(); onChooseFile?.(); }}>Import another CSV</button>
      </div> : <form aria-busy={busy} onSubmit={event => { event.preventDefault(); void (preview ? save() : previewFile()); }}>
        <div className="tabular-import-body">
          {!preview ? <>
            <p>Bring a post-level CSV from Instagram, Facebook or LinkedIn. Review its columns before saving.</p>
            <label className="tabular-file" htmlFor={`${uid}-file`}><span><FileSpreadsheet size={20} /><strong>{file?.name ?? 'Choose a social CSV'}</strong></span><small>UTF-8 CSV · up to 1 MiB</small><input ref={fileInput} id={`${uid}-file`} type="file" accept=".csv,text/csv" disabled={busy} onChange={event => void chooseFile(event.target.files?.[0] ?? null)} /></label>
            <details><summary>Format and synthetic sample</summary><p>Use one post per row with a unique post ID. Map publication dates for time trends. Numeric metrics need plain nonnegative counts. Blank values stay missing; they are not zero.</p><p>Column labels vary by export. This importer does not detect or certify a native platform export format.</p><a className="text-button tabular-sample" href={`data:text/csv;charset=utf-8,${encodeURIComponent(SYNTHETIC_SOCIAL_CSV)}`} download="synthetic-social-example.csv"><Download size={14} />Download synthetic sample CSV</a><small>6 invented posts for testing. No real account or customer data.</small></details>
          </> : <>
            <div><h3 ref={stageHeading} tabIndex={-1}>{canSave && !error ? 'Ready to attach' : 'Check columns'}</h3><p>{file?.name} · {preview.rowCount.toLocaleString()} {preview.rowCount === 1 ? 'row' : 'rows'}</p></div>
            <details open className="tabular-preview"><summary>Original rows ({preview.sampleRows.length} of {preview.rowCount.toLocaleString()})</summary><div className="tabular-scroll" role="region" aria-label="Original CSV preview" tabIndex={0}><table style={{ width: `${preview.headers.length * 150}px` }}><thead><tr>{preview.headers.map(header => <th key={header} scope="col"><span title={header}>{header}</span></th>)}</tr></thead><tbody>{preview.sampleRows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}><span title={cell}>{cell === '' ? <span className="tabular-empty-cell">Blank</span> : cell}</span></td>)}</tr>)}</tbody></table></div></details>
            <fieldset disabled={busy || Boolean(pending)} className="tabular-mapping">
              <legend className="sr-only">Source and column mapping</legend>
              <div className="tabular-mapping-review">
                <div className="tabular-mapping-review-heading"><strong>Recognized columns</strong><button type="button" className="text-button" aria-expanded={showMapping} onClick={() => setShowMapping(value => !value)}>{showMapping ? 'Hide editor' : 'Edit columns'}</button></div>
                <p>{FIELDS.filter(field => columns[field.id]).map(field => field.label).join(', ') || 'No supported columns recognized.'}</p>
                {!columns.postId && <p>Choose a post ID column.</p>}
                {!['likes', 'reactions', 'comments', 'shares', 'impressions', 'clicks', 'saves'].some(field => columns[field as CanonicalField]) && <p>Choose at least one count metric.</p>}
                {!!ambiguous.length && <p role="status">More than one column matches {ambiguous.map(field => FIELDS.find(item => item.id === field)!.label).join(', ')}. Choose a column or explicitly leave it out.</p>}
                <small>Only these columns are analyzed. All original columns are kept.</small>
              </div>
              {showMapping && <div className="tabular-mapping-editor">{FIELDS.map(field => <label key={field.id}><span>{field.label}{field.required && <small>Required</small>}</span><select aria-label={field.label + ' column'} required={field.required} value={ambiguous.includes(field.id) ? '__review__' : columns[field.id] ?? ''} onChange={event => map(field.id, event.target.value)}>{ambiguous.includes(field.id) && <option value="__review__" disabled>Choose a matching column</option>}<option value="">{field.required ? 'Choose CSV column' : 'Not mapped'}</option>{preview.headers.map(header => <option key={header} value={header} disabled={Object.entries(columns).some(([key, value]) => key !== field.id && value === header)}>{header}</option>)}</select></label>)}
              </div>}
              <details><summary>Source details (optional)</summary><div className="tabular-mapping-editor tabular-source-details"><label htmlFor={`${uid}-platform`}><span>Platform</span><select id={`${uid}-platform`} aria-label="Platform" value={platform} onChange={event => { setPlatform(event.target.value as CsvPlatform); setDiagnostics([]); }}><option value="unspecified">Not specified</option><option value="instagram">Instagram</option><option value="facebook">Facebook</option><option value="linkedin">LinkedIn</option></select></label><label><span>{columns.account ? 'Account fallback' : 'Account name'}</span><input value={account} maxLength={200} placeholder="Not specified" onChange={event => { setAccount(event.target.value); setDiagnostics([]); }} /></label><small>Missing account values remain unattributed unless you supply a name.</small></div></details>
              {preview.headers.some(header => !Object.values(columns).includes(header)) && <details><summary>Columns not used ({preview.headers.filter(header => !Object.values(columns).includes(header)).length})</summary><p>{preview.headers.filter(header => !Object.values(columns).includes(header)).join(', ')}</p><small>Original columns are preserved in source evidence, but only mapped columns are analyzed.</small></details>}
              {columns.publishedAt && <details open={showDates} onToggle={event => setShowDates(event.currentTarget.open)}><summary>Publication dates and timezone</summary><p>Dates with an offset are converted to UTC. Grouping uses publication time; metric collection time remains unknown.</p><label className="tabular-checkbox"><input type="checkbox" checked={utc} onChange={event => { setUtc(event.target.checked); setDiagnostics([]); setError(''); }} /><span>Dates without a timezone are UTC.<small>Only select this if the original dates actually use UTC.</small></span></label></details>}
            </fieldset>
          </>}
          {error && <div ref={errorPanel} tabIndex={-1} className="tabular-notice is-error" role="alert"><p>{error}</p>{diagnostics.map((item, index) => <div className="tabular-import-issue" key={index}><strong>{item.record ? `Source record ${item.record} (header is record 1)` : 'Column mapping'}{item.field ? ` · ${columns[item.field as CanonicalField] ?? item.field}` : ''}</strong><p>{item.message}</p><small>{importFix(item)}</small></div>)}{pending && <><p>The file may already be saved. Retry checks the same file and mapping.</p><button type="button" className="text-button" disabled={busy} onClick={() => { setPending(null); close(); }}>Leave for now</button></>}</div>}
        </div>
        <footer><button type="button" className="button secondary" disabled={busy} onClick={close}>Cancel</button>{onUseAsText && !pending && <button type="button" className="text-button" disabled={busy} onClick={onUseAsText}>Use as text instead</button>}{onChooseFile && !pending && <button type="button" className="text-button" disabled={busy} onClick={onChooseFile}>Choose another file</button>}<button type="submit" className="button" disabled={disabled || busy || (preview ? !pending && !canSave : !file)}>{busy ? preview ? 'Saving and checking…' : 'Reading CSV…' : pending ? 'Retry import' : preview ? onUse ? 'Attach CSV' : 'Add CSV' : 'Retry preview'}{!busy && <ArrowRight size={14} />}</button></footer>
      </form>}
    </dialog>
  </>;
}
