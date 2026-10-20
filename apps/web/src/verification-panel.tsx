import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Check, ChevronRight, Circle, CircleAlert, Info, Link2, RefreshCw, X } from 'lucide-react';
import type { Run, Source } from '../../../packages/core/src/types';
import { buildVerificationSummary, type VerificationCategory } from './verification-summary';
import './verification-panel.css';
import { runCalculationInspection, type CalculationInspection } from './calculation-verification';
import { CalculationSourceRows, VerificationCalculationDetail } from './verification-calculation-detail';

type Props = {
  run?: Run;
  sources: Source[];
  inspection?: CalculationInspection;
  onInspect?: (inspection?: CalculationInspection) => void;
  example?: boolean;
  onClose: () => void;
  onSource: (id: string) => void;
  onDetails?: () => void;
  onRefresh?: () => Promise<void>;
};

const date = (value: string | null) => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Not recorded';

function StatusMark({ status }: { status: string }) {
  return status === 'passed' ? <span className="verification-pass-mark"><Check size={10} strokeWidth={2.5}/></span>
    : status === 'warning' ? <CircleAlert size={16} /> : status === 'linked' ? <Link2 size={15}/> : <Circle size={15} />;
}
const statusLabels = { passed: 'Passed', linked: 'Linked', recorded: 'Recorded', warning: 'Needs attention', 'not-checked': 'Not checked', 'not-applicable': 'Not applicable', illustrative: 'Example' };

export function VerificationPanel({ run, sources, inspection, onInspect, example = false, onClose, onSource, onDetails, onRefresh }: Props) {
  const summary = run ? buildVerificationSummary(run, sources, example) : undefined;
  const calculation = run ? runCalculationInspection(run) : undefined;
  const [categoryId, setCategoryId] = useState<VerificationCategory['id'] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState('');
  const [detailsFor, setDetailsFor] = useState<CalculationInspection>();
  const pending = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const category = summary?.categories.find(item => item.id === categoryId);
  const sourceRows = inspection?.kind === 'tabular' && inspection.view !== 'calculation' ? inspection : undefined;
  const showCalculationDetails = Boolean(inspection && detailsFor === inspection);
  useEffect(() => { heading.current?.focus(); }, [inspection, showCalculationDetails]);

  function openCategory(id: VerificationCategory['id']) {
    setCategoryId(id);
    requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
  }
  function back() {
    const previous = categoryId;
    setCategoryId(null);
    requestAnimationFrame(() => document.getElementById(`verification-${previous}`)?.focus({ preventScroll: true }));
  }
  async function refresh() {
    if (!onRefresh || pending.current) return;
    pending.current = true; setRefreshing(true); setNotice('');
    try { await onRefresh(); setNotice('Saved evidence is up to date.'); }
    catch { setNotice('Could not reload evidence. The saved details are still shown.'); }
    finally { pending.current = false; setRefreshing(false); }
  }

  return <section className="verification-panel" aria-label={sourceRows ? 'Source rows evidence' : 'Verification'} onKeyDown={event => {
    if (event.key === 'Escape' && inspection) { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key === 'Escape' && category) { event.preventDefault(); event.stopPropagation(); back(); }
  }}>
    <header className="verification-header">
      {sourceRows ? <button className="icon-button" onClick={showCalculationDetails ? () => setDetailsFor(undefined) : onClose} aria-label={showCalculationDetails ? 'Back to source rows' : 'Back to report'}><ArrowLeft size={16}/></button> : (inspection ? summary : category) && <button className="icon-button" onClick={inspection ? () => onInspect?.() : back} aria-label="Back to verification"><ArrowLeft size={16}/></button>}
      <h2 id="verification-heading" ref={heading} tabIndex={-1}>{sourceRows ? showCalculationDetails ? 'Calculation details' : 'Source rows' : inspection ? 'Verification Hub' : category?.title ?? 'Verification Hub'}</h2>
      {sourceRows && !showCalculationDetails && <button className="icon-button" aria-label="Open calculation details" title="Calculation details" onClick={() => setDetailsFor(sourceRows)}><Info size={16}/></button>}
      <button className="icon-button" onClick={onClose} aria-label={sourceRows ? 'Close source rows' : 'Close verification'}><X size={16}/></button>
    </header>
    <div className="verification-scroll">
      {sourceRows && !showCalculationDetails ? <CalculationSourceRows key={JSON.stringify([sourceRows.analysis.result.id, sourceRows.selection])} inspection={sourceRows}/> : inspection ? <VerificationCalculationDetail key={JSON.stringify([inspection.analysis.result.id, inspection.kind === 'tabular' ? inspection.selection : inspection.row?.key])} inspection={inspection} onSource={onSource}/> : category ? <>
        <p className="verification-description">{category.description}</p>
        <div className={`verification-detail-status status-${category.status}`}>{category.countLabel}</div>
        {category.id === 'traces' && calculation && onInspect && <button className="text-button verification-calculation-link" onClick={() => onInspect(calculation)}>Calculation details <ChevronRight size={13}/></button>}
        <div className="verification-items">{category.items.map(item => <details key={item.id} className={`verification-item status-${item.status}`}>
          <summary><StatusMark status={item.status}/><span>{item.title}<small className="verification-item-status">{statusLabels[item.status]}</small></span><ChevronRight size={13}/></summary>
          <div className="verification-item-evidence"><p>{item.evidence}</p>{item.createdAt && <time dateTime={item.createdAt}>{date(item.createdAt)}</time>}
            {item.sourceId && <button className="text-button" data-source-id={item.sourceId} onClick={() => onSource(item.sourceId!)}>Open source <ArrowUpRight size={13}/></button>}
            {item.technical && <details className="verification-technical"><summary>Technical details</summary><p>{item.technical}</p></details>}
          </div>
        </details>)}</div>
      </> : summary ? <>
        {!summary.example && <dl className="verification-metadata"><dt>{summary.timestamp.label}</dt><dd>{date(summary.timestamp.value)}</dd></dl>}
        {summary.example && <p className="verification-example">Illustrative example · no model run</p>}
        <div className="verification-categories">{summary.categories.map(item => <button id={`verification-${item.id}`} key={item.id} className={`verification-category status-${item.status}`} onClick={() => openCategory(item.id)}>
          <StatusMark status={item.status}/><span><span className="verification-category-title"><strong>{item.title}</strong><em>{item.countLabel}</em></span><small>{item.description}</small></span><ChevronRight size={14}/>
        </button>)}</div>
        <p className="verification-scope">{summary.notice}</p>
      </> : null}
    </div>
    {!inspection && (onRefresh || onDetails) && <footer className="verification-footer">
      {notice && <p role="status">{notice}</p>}
      {onRefresh && <button className="button verification-refresh" disabled={refreshing} onClick={() => void refresh()}><RefreshCw size={14}/>{refreshing ? 'Refreshing…' : 'Refresh evidence'}</button>}
      {onDetails && <button className="text-button" onClick={onDetails}>Task details <ChevronRight size={13}/></button>}
    </footer>}
  </section>;
}
