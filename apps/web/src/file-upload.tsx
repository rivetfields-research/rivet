import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, Check, FileText, Paperclip, Upload, X } from 'lucide-react';
import type { SourceDocument } from '../../../packages/core/src/types';
import type { ImportedWorkspaceFile } from '../../../packages/core/src/file-import';
import { api, ApiError, message } from './api';
import { TabularCsvImport, tabularReportTask } from './tabular-import';
import { acceptDroppedFiles, useFileDrop } from './file-drop';
import { FileUploadProgress, announceFileReady } from './file-upload-feedback';
import { allowsManualImports } from './workspace-scope';
import './file-upload.css';

type Payload = Readonly<{ name: string; content: string }>;
type Props = {
  compact?: boolean; disabled?: boolean; useLabel?: string;
  open?: boolean; onOpenChange?: (open: boolean) => void;
  initialFile?: File;
  onSaved: () => Promise<void>;
  onOpen: (id: string) => void;
  onUse: (source: SourceDocument) => void | Promise<void>;
  onPrepareTask?: (task: string, source: SourceDocument) => void | Promise<void>;
};

export function uploadFileLimit(name: string): number { return /\.csv$/i.test(name) ? 1024 * 1024 : 65536; }
export function canSaveAsText(name: string, content: string, csvAsText: boolean): boolean {
  return Boolean(content) && new TextEncoder().encode(content).byteLength <= 65536 && (!/\.csv$/i.test(name) || csvAsText);
}

/** Save and verify the file before handing its exact source to the question. */
export function FileUpload(props: Props) {
  return allowsManualImports() ? <LocalFileUpload {...props}/> : null;
}

function LocalFileUpload({compact=false,disabled=false,useLabel='Save and ask',open:controlledOpen,onOpenChange,initialFile,onSaved,onOpen,onUse,onPrepareTask}: Props) {
  const uid = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const chooser = useRef<HTMLInputElement>(null);
  const savedHeading = useRef<HTMLHeadingElement>(null);
  const inFlight = useRef(false);
  const handingOff = useRef(false);
  const mounted = useRef(true);
  const initialHandled = useRef<File | undefined>(undefined);
  const [internalOpen,setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  function setOpen(value:boolean) {setInternalOpen(value);onOpenChange?.(value);}
  const [view,setView] = useState<'file'|'social'>('file');
  const [chosenFile,setChosenFile] = useState<File|null>(null);
  const [socialFile,setSocialFile] = useState<File|undefined>();
  const [csvAsText,setCsvAsText] = useState(false);
  const [payload,setPayload] = useState<Payload|null>(null);
  const [uncertain,setUncertain] = useState(false);
  const [saved,setSaved] = useState<ImportedWorkspaceFile|null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const [background,setBackground] = useState(false);
  const [csvPending,setCsvPending] = useState(false);
  useFileDrop(opener, '[data-file-drop]', disabled || open || csvPending || uncertain, file => {setOpen(true);void choose(file);}, setNotice);
  useEffect(() => {mounted.current=true;return () => {mounted.current=false;};},[]);
  useEffect(() => {
    if (!initialFile || initialHandled.current === initialFile) return;
    initialHandled.current = initialFile; setOpen(true); void choose(initialFile);
  }, [initialFile]);
  useEffect(() => {if(open && view==='file' && !background) dialog.current?.showModal();else dialog.current?.close();},[open,view,background]);
  useEffect(() => {if(saved&&open)savedHeading.current?.focus();},[saved,open]);
  useEffect(() => {
    if(!busy&&!uncertain) return;
    const unload=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};
    const navigate=(event:Event)=>{if(!handingOff.current){event.preventDefault();setOpen(true);}};
    window.addEventListener('beforeunload',unload);window.addEventListener('rivetfields:before-navigate',navigate);
    return()=>{window.removeEventListener('beforeunload',unload);window.removeEventListener('rivetfields:before-navigate',navigate);};
  },[busy,uncertain]);
  function focusOpener() { const owner=opener.current?.closest('dialog'); if(!owner||owner.open)opener.current?.focus({preventScroll:true}); }
  function close() {if(inFlight.current)return;setOpen(false);focusOpener();}
  async function attachSaved(source:SourceDocument) {
    handingOff.current=true;
    try {await onUse(source);} finally {handingOff.current=false;}
  }
  async function choose(file:File|undefined) {
    if(!file||disabled||inFlight.current||uncertain)return;
    if(csvPending){setView('social');setOpen(true);return;}
    setView('file');setSocialFile(undefined);
    setBackground(false);
    setError('');setSaved(null);setNotice('');setPayload(null);setChosenFile(null);setCsvAsText(false);
    if(!/\.(csv|txt|md)$/i.test(file.name)){setError('Choose a CSV, text or Markdown file. PDF and Office documents are not supported yet.');return;}
    if(!file.size||file.size>uploadFileLimit(file.name)){setError(/\.csv$/i.test(file.name)?'Choose a nonempty CSV up to 1 MiB.':'Choose a nonempty text or Markdown file up to 64 KB.');return;}
    inFlight.current=true;setBusy(true);setBackground(true);
    try {
      const bytes=await file.arrayBuffer();
      const content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
      if(mounted.current){
        const next = Object.freeze({name:file.name,content});
        setPayload(next);setChosenFile(file);
        if(/\.csv$/i.test(file.name)){setSocialFile(file);setView('social');}
        else {inFlight.current=false;await save(next);}
      }
    } catch {if(mounted.current){setBackground(false);setError('This file could not be read. Save it as UTF-8 and try again.');}}
    finally {inFlight.current=false;if(mounted.current)setBusy(false);}
  }
  async function save(input: Payload | null = payload) {
    if(!input||disabled||inFlight.current||!canSaveAsText(input.name,input.content,csvAsText))return;
    inFlight.current=true;setBusy(true);setError('');
    let confirmed=false,used=false;
    try {
      setUncertain(true);
      const result=await api<ImportedWorkspaceFile>('/api/files',{method:'POST',body:JSON.stringify(input)});
      if(!result?.source?.id||result.name!==input.name||result.source.content!==input.content)throw new Error('The upload could not be confirmed. Retry to check the same file.');
      confirmed=true;
      const source=await api<SourceDocument>(`/api/sources/${encodeURIComponent(result.source.id)}`);
      if(source?.id!==result.source.id||source.content!==input.content)throw new Error('The saved source could not be confirmed. Retry to check the same file.');
      if(!mounted.current)return;
      setSaved(result);setUncertain(false);setPayload(null);
      try {await onSaved();}catch{if(mounted.current)setNotice('Your file is saved. Refresh the source list to see it.');}
      try {await attachSaved(source);used=true;announceFileReady(input.name);}catch(cause){if(mounted.current)setError(`Your file is saved, but could not be attached. ${message(cause)}`);}
    }catch(cause){
      if(!mounted.current)return;
      if(!confirmed&&cause instanceof ApiError&&cause.status>=400&&cause.status<500&&cause.status!==408)setUncertain(false);
      setError(message(cause));
    }finally{inFlight.current=false;if(mounted.current){setBusy(false);setBackground(false);}}
    if(used&&mounted.current){chooseAnother();close();}
  }
  async function useSaved() {
    if(!saved||disabled||inFlight.current)return;
    inFlight.current=true;setBusy(true);setError('');let used=false;
    try{await attachSaved(saved.source);used=true;announceFileReady(saved.name);}catch(cause){if(mounted.current)setError(message(cause));}
    finally{inFlight.current=false;if(mounted.current)setBusy(false);}
    if(used&&mounted.current){chooseAnother();close();}
  }
  function chooseAnother() {
    setBackground(false);
    setView('file');setSocialFile(undefined);setChosenFile(null);setPayload(null);setSaved(null);setCsvAsText(false);setError('');setNotice('');
    if(chooser.current)chooser.current.value='';
  }
  const isCsv=Boolean(payload&&/\.csv$/i.test(payload.name));
  const textReady=Boolean(payload&&canSaveAsText(payload.name,payload.content,csvAsText));
  return <>
    {open && view==='file' && background && <FileUploadProgress name={payload?.name ?? initialFile?.name ?? 'Reading file'}/>}
    {!open && notice && <p role="status" className="file-upload-note">{notice}</p>}
    {controlledOpen===undefined&&<button ref={opener} type="button" className={compact?'text-button file-attach':'button secondary'} disabled={disabled} onClick={()=>setOpen(true)}>
      {compact?<Paperclip size={16}/>:<Upload size={15}/>}<span>{compact?'Attach file':'Upload file'}</span>
    </button>}
    <dialog ref={dialog} className="file-upload-dialog" aria-labelledby={`${uid}-title`} onCancel={event=>{event.preventDefault();close();}} onClose={()=>{if(open&&view==='file'&&!background)setOpen(false);}}>
      <header><span><FileText size={18}/><h2 id={`${uid}-title`}>{saved?'File saved':'Upload a file'}</h2></span><button type="button" className="icon-button" aria-label="Close file upload" disabled={busy} onClick={close}><X size={17}/></button></header>
      <div className="file-upload-body">
        {saved?<>
          <div className="file-upload-selected"><span className="file-upload-icon"><Check size={20}/></span><div><h3 ref={savedHeading} tabIndex={-1}>{saved.name}</h3><p>File saved · {(saved.bytes/1024).toFixed(1)} KB</p></div></div>
          <div className="file-upload-actions"><button type="button" className="button secondary" disabled={busy} onClick={()=>{close();onOpen(saved.source.id);}}>View source<ArrowRight size={14}/></button><button type="button" className="button primary" disabled={busy||disabled} onClick={()=>void useSaved()}>{busy?'Attaching…':useLabel}<ArrowRight size={14}/></button></div>
          <button type="button" className="text-button" disabled={busy} onClick={chooseAnother}>Add another file</button>
        </>:<>
          <label className={`file-upload-picker ${payload?'has-file':''}`} htmlFor={`${uid}-file`} onDragOver={event=>{if(event.dataTransfer.types.includes('Files'))event.preventDefault();}} onDrop={event=>{event.preventDefault();event.stopPropagation();acceptDroppedFiles(Array.from(event.dataTransfer.files),disabled||busy||uncertain,file=>void choose(file),setError);}}>
            <span className="file-upload-icon">{payload?<FileText size={23}/>:<Upload size={23}/>}</span>
            <strong>{payload?.name??'Drop a file or choose one'}</strong>
            <span>{payload?'Choose another file':'CSV up to 1 MiB · text or Markdown up to 64 KB'}</span>
            <input ref={chooser} id={`${uid}-file`} type="file" accept=".csv,.txt,.md,text/csv,text/plain,text/markdown" disabled={busy||uncertain} onChange={event=>void choose(event.target.files?.[0])}/>
          </label>
          {payload&&<details open className="file-upload-preview"><summary>Preview file</summary><pre>{payload.content.slice(0,2000)}</pre>{payload.content.length>2000&&<small>Preview shows the first 2,000 characters. The full file will be saved.</small>}</details>}
          {isCsv&&<div className="file-upload-csv-choice" role="group" aria-label="How to use this CSV"><p className="file-upload-copy">How should Rivet use this CSV?</p><button type="button" className="button primary" disabled={busy||disabled||uncertain} onClick={()=>{if(chosenFile){setSocialFile(chosenFile);setView('social');}}}>Analyze social metrics<ArrowRight size={14}/></button><label className="file-upload-text-choice"><input type="checkbox" checked={csvAsText} disabled={busy||uncertain||!payload||new TextEncoder().encode(payload.content).byteLength>65536} onChange={event=>setCsvAsText(event.target.checked)}/><span>Keep as source text instead<small>Up to 64 KB. Read and cite the file; no calculated metrics or charts.</small></span></label></div>}
          <p className="file-upload-note">PDF, Excel and PowerPoint are not supported yet.</p>
        </>}
        {notice&&<p role="status" className="file-upload-notice">{notice}</p>}
        {error&&<div role="alert" className="file-upload-notice"><p>{error}</p>{uncertain&&<><p>The file may already be saved. Retry checks the same version.</p><button type="button" className="text-button" disabled={busy} onClick={()=>{setUncertain(false);setPayload(null);close();}}>Leave for now</button></>}</div>}
      </div>
      {!saved&&<footer><button type="button" className="button secondary" disabled={busy} onClick={close}>Cancel</button>{payload&&(!isCsv||csvAsText)&&<button type="button" className="button primary" disabled={!textReady||busy||disabled} onClick={()=>void save()}>{busy?'Saving and checking…':uncertain?'Retry upload':useLabel}{!busy&&<ArrowRight size={14}/>}</button>}</footer>}
    </dialog>
    <TabularCsvImport autoAttach onPendingChange={setCsvPending} disabled={disabled} open={open&&view==='social'} onOpenChange={value=>{if(value)setView('social');setOpen(value);if(!value)focusOpener();}} initialFile={socialFile} onChooseFile={chooseAnother} onUseAsText={payload&&new TextEncoder().encode(payload.content).byteLength<=65536?()=>{setBackground(false);setCsvAsText(true);setView('file');}:undefined} onImported={onSaved} onOpenSource={onOpen} onUse={async summary=>{await onUse(summary.source);if(mounted.current){setOpen(false);chooseAnother();}}} useLabel={useLabel} onPrepareSavedTask={onPrepareTask?summary=>onPrepareTask(tabularReportTask(summary),summary.source):undefined}/>
  </>;
}
