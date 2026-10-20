import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, LoaderCircle, X } from 'lucide-react';

const readyEvent = 'rivetfields:file-ready';
type Ready = { name: string; rows?: number };
export function announceFileReady(name: string, rows?: number) {
  window.dispatchEvent(new CustomEvent<Ready>(readyEvent, { detail: { name, rows } }));
}
export function FileUploadProgress({ name }: { name: string }) {
  return typeof document === 'undefined' ? null : createPortal(<div className="file-upload-toast" role="status" aria-live="polite">
    <LoaderCircle size={18} className="file-upload-spinner"/><span><strong>Preparing your file...</strong><small>{name}</small></span>
  </div>, document.body);
}
/** Lives above route changes so the Tables-to-composer handoff keeps its receipt. */
export function FileUploadFeedback() {
  const [ready, setReady] = useState<Ready | null>(null);
  useEffect(() => {
    const receive = (event: Event) => setReady((event as CustomEvent<Ready>).detail);
    window.addEventListener(readyEvent, receive);
    return () => window.removeEventListener(readyEvent, receive);
  }, []);
  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => setReady(null), 8000);
    return () => window.clearTimeout(timer);
  }, [ready]);
  return ready && <div className="file-upload-toast" role="status" aria-live="polite">
    <Check size={18}/><span><strong>Your file is ready</strong><small>{ready.name}{ready.rows !== undefined && ` · ${ready.rows.toLocaleString()} ${ready.rows === 1 ? 'row' : 'rows'}`}</small></span>
    <button className="icon-button" type="button" aria-label="Dismiss upload confirmation" title="Dismiss" onClick={() => setReady(null)}><X size={16}/></button>
  </div>;
}
