import { createPortal } from 'react-dom';
import { useEffect, useId, useRef, useState } from 'react';
import { Archive, FileText, Paperclip, Search, Table2, Upload, X } from 'lucide-react';
import type { Run, Source } from '../../../packages/core/src/types';
import { FileUpload } from './file-upload';
import { useFileDrop } from './file-drop';
import { allowsManualImports } from './workspace-scope';
import './session-inputs.css';
import { localTime } from './connection-model';
import { SOURCE_PROVIDERS } from './source-connect-options';

export function inputIds(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))].slice(0, 100) : [];
}
export function addInput(ids: readonly string[], id: string): string[] { return inputIds([...ids, id]); }
/** Old runs may include calculation receipts. Only known input files are eligible. */
export function conversationInputIds(run: Partial<Pick<Run, 'sourceIds' | 'selectedSourceIds' | 'events' | 'reply' | 'result'>>, sources: Source[]): string[] {
  if (run.selectedSourceIds) return inputIds(run.selectedSourceIds);
  const inputs = new Set(sources.filter(source => !source.path.startsWith('calculations/') && !source.path.endsWith('/weekly-summary.md')).map(source => source.id));
  const used = [...(run.reply?.citations ?? []), ...(run.result?.citations ?? []), ...(run.events ?? []).filter(event => event.toolName === 'workspace.read').map(event => (event.input as {sourceId?: unknown} | null)?.sourceId)];
  return inputIds(used).filter(id => inputs.has(id));
}
export function inputSourceOptions(sources: Source[]) {
  return sources.flatMap<{ key: string; source: Source; title: string; connection: NonNullable<Source["connections"]>[number] | undefined }>(source => source.connections?.length
    ? source.connections.map(connection => ({ key: connection.id, source, title: connection.displayName, connection }))
    : [{ key: source.id, source, title: source.title, connection: undefined }]);
}
export function inputDraftKey(profile: string, sessionId: string) { return `rivetfields.inputs.${profile}.${sessionId}`; }

export function followupParentId(requestId: string, run: Pick<Run, 'id' | 'requestId' | 'parentRunId'>, previousTurns: Pick<Run, 'id' | 'requestId' | 'parentRunId'>[]): string {
  return [...previousTurns, run].find(turn => turn.requestId === requestId)?.parentRunId ?? run.id;
}

type Props = {
  sources: Source[]; inheritedSources?: Source[]; selectedIds: string[]; inheritedIds?: string[]; working?: boolean; disabled?: boolean;
  onChange: (ids: string[] | ((current: string[]) => string[])) => void; onRefresh: () => Promise<void>; onSource: (id: string) => void;
  onPrepareTask?: (task: string) => void;
  onArchive?: (sourceId: string, archived: boolean) => Promise<void>;
  onUploadingChange?: (uploading: boolean) => void;
  allowUpload?: boolean;
  onManageSources?: () => void;
};
export function SessionInputs({ sources, inheritedSources = [], selectedIds, inheritedIds = [], working = false, disabled = false, onChange, onRefresh, onSource, onPrepareTask, onArchive, onUploadingChange, allowUpload: requestedUpload = true, onManageSources }: Props) {
  const allowUpload = requestedUpload && allowsManualImports();
  const uid = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [droppedFile, setDroppedFile] = useState<File>();
  const [dropError, setDropError] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [archiving, setArchiving] = useState<string | null>(null);
  const [archived, setArchived] = useState<Source | null>(null);
  const [archiveError, setArchiveError] = useState('');
  const [newSources, setNewSources] = useState<Source[]>([]);
  // Cached upload labels may outlive a refresh; only the server list drives discovery.
  const available = [...new Map(sources.map(source => [source.id, source])).values()].filter(source => !source.path.startsWith('calculations/'));
  const options = inputSourceOptions(available);
  const matches = options.filter(option => `${option.title} ${option.source.title} ${option.connection?.provider ?? ""}`.toLowerCase().includes(filter.toLowerCase()));
  const inherited = new Set(inheritedIds);
  const additions = selectedIds.filter(id => !inherited.has(id));
  const all = [...new Set([...inheritedIds, ...additions])];
  useFileDrop(opener, 'form', !allowUpload || disabled || uploadOpen || all.length >= 100, file => {setDropError('');setDroppedFile(file);setUploadOpen(true);},
    error => setDropError(allowUpload ? error : 'Open Sources to connect an account.'));
  useEffect(() => {onUploadingChange?.(uploadOpen);return () => onUploadingChange?.(false);}, [uploadOpen, onUploadingChange]);
  function close() { dialog.current?.close(); opener.current?.focus(); }
  function attach(source: Source) {
    if (!all.includes(source.id) && all.length >= 100) throw new Error('Remove a file from the next message before attaching another.');
    setNewSources(current => [...current.filter(item => item.id !== source.id), source]);
    if (!inherited.has(source.id)) onChange(current => addInput(current, source.id));
  }
  const title = (id: string) => {
    const source = [...available, ...newSources, ...inheritedSources].find(source => source.id === id);
    return source?.connections?.map(item => item.displayName).join(', ') || source?.title || 'Saved input';
  };
  async function archive(source: Source, hide: boolean) {
    if (!onArchive || archiving) return;
    setArchiving(source.id); setArchiveError('');
    try {
      await onArchive(source.id, hide);
      if (hide) { setNewSources(current => current.filter(item => item.id !== source.id)); onChange(current => current.filter(id => id !== source.id)); }
      setArchived(hide ? source : null);
    } catch (error) { setArchiveError(error instanceof Error ? error.message : 'Could not update available data. Try again.'); }
    finally { setArchiving(null); }
  }
  return <div className="session-inputs">
    {all.length > 0 && <ul className="session-input-chips" aria-label="Conversation inputs">{all.map(id => <li key={id} className={inherited.has(id) ? 'is-inherited' : ''}>
      <button type="button" data-source-id={id} title={title(id)} onClick={() => onSource(id)}><FileText size={13}/><span>{title(id)}</span></button>
      {inherited.has(id) ? <span className="sr-only">Used in this conversation</span> : <button type="button" disabled={disabled} aria-label={`Remove ${title(id)} from next message`} onClick={() => onChange(selectedIds.filter(item => item !== id))}><X size={12}/></button>}
    </li>)}</ul>}
    <div className="session-input-actions"><button ref={opener} type="button" className="text-button" disabled={disabled || uploadOpen} onClick={() => available.length || !allowUpload ? dialog.current?.showModal() : setUploadOpen(true)}>{allowUpload ? <Paperclip size={15}/> : <Table2 size={15}/>}<span>{allowUpload ? 'Attach' : 'Choose sources'}</span></button>{additions.length > 0 && <small role="status">{working ? 'Added for your next message' : `${additions.length} ${allowUpload ? additions.length === 1 ? 'file' : 'files' : additions.length === 1 ? 'source' : 'sources'} selected`}</small>}</div>
    {dropError && <p role="alert" className="file-upload-note">{dropError}</p>}
    {typeof document !== 'undefined' && createPortal(<div onSubmit={event => event.stopPropagation()}>
    {allowUpload && <FileUpload initialFile={droppedFile} open={uploadOpen} onOpenChange={value => {setUploadOpen(value);if(!value){setDroppedFile(undefined);requestAnimationFrame(() => opener.current?.focus());}}} disabled={disabled || all.length >= 100} useLabel="Save and attach" onSaved={onRefresh} onOpen={onSource} onUse={attach} onPrepareTask={onPrepareTask ? (task, source) => {attach(source);onPrepareTask(task);} : undefined}/>}
    <dialog ref={dialog} className="session-input-dialog" aria-labelledby={`${uid}-title`} onCancel={event => { event.preventDefault(); close(); }}>
      <header><h2 id={`${uid}-title`}>{allowUpload ? 'Attach files' : 'Choose sources'}</h2><button type="button" className="icon-button" aria-label="Close input picker" onClick={close}><X size={17}/></button></header>
      {working && <p>Additions will be used with your next message.</p>}
      {allowUpload && <div className="session-input-upload"><button type="button" className="button secondary" disabled={disabled} onClick={() => {dialog.current?.close();setUploadOpen(true);}}><Upload size={15}/>Upload file</button></div>}
      {!allowUpload && onManageSources && <div className="session-input-upload"><button type="button" className="button secondary" onClick={() => {close();onManageSources();}}><Table2 size={15}/>Open sources</button></div>}
      <label className="search-field"><Search size={15}/><input aria-label={allowUpload ? 'Find an input file' : 'Find a source'} placeholder={allowUpload ? 'Find a file' : 'Find a source'} value={filter} onChange={event => setFilter(event.target.value)}/></label>
      <fieldset><legend className="sr-only">Available input files</legend>{matches.map(({source, title, key, connection}) => <div key={key} className="session-input-option"><label><input type="checkbox" checked={inherited.has(source.id) || selectedIds.includes(source.id)} disabled={disabled || inherited.has(source.id) || (all.length >= 100 && !selectedIds.includes(source.id))} onChange={event => onChange(event.target.checked ? addInput(selectedIds, source.id) : selectedIds.filter(id => id !== source.id))}/><span>{title}{connection && <small>{SOURCE_PROVIDERS.find(item => item.id === connection.provider)?.label ?? connection.provider} · Synced <time dateTime={connection.syncedAt ?? connection.observedAt}>{localTime(connection.syncedAt ?? connection.observedAt)}</time></small>}{inherited.has(source.id) && <small>Used in this conversation</small>}</span></label>{onArchive && <button type="button" className="icon-button" title="Remove from available data" aria-label={`Remove ${source.title} from available data`} disabled={Boolean(archiving)} onClick={() => void archive(source, true)}><Archive size={14}/></button>}</div>)}{available.length === 0 && <p className="empty-note">{allowUpload ? 'Upload a file to get started. No workspace files are selected automatically.' : 'No sources yet. Open Sources to connect an account.'}</p>}{available.length > 0 && matches.length === 0 && <p className="empty-note">{allowUpload ? 'No files match your search.' : 'No sources match your search.'}</p>}</fieldset>
      {onArchive && <p className="session-archive-note">Removing data archives it from the file picker. Saved reports and their evidence stay available.</p>}
      {archived && <p role="status" className="session-archive-note">{archived.title} removed from available data. <button type="button" className="text-button" disabled={Boolean(archiving)} onClick={() => void archive(archived, false)}>Undo</button></p>}
      {archiveError && <p role="alert" className="session-archive-note">{archiveError}</p>}
      <footer><span>{all.length} selected</span><button type="button" className="button" onClick={close}>Done</button></footer>
    </dialog></div>, document.body)}
  </div>;
}
