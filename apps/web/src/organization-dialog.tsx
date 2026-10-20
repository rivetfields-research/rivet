import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function OrganizationDialog({title, onClose, children}: {title: string; onClose: () => void; children: ReactNode}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const returnFocus = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    ref.current?.querySelector<HTMLInputElement | HTMLSelectElement>('input:not([type=checkbox]), select')?.focus();
    return () => { ref.current?.close(); returnFocus?.focus(); };
  }, []);
  return <dialog ref={ref} className="org-dialog" aria-labelledby="org-dialog-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><h2 id="org-dialog-title">{title}</h2><button type="button" className="org-icon" aria-label="Close dialog" title="Close dialog" onClick={onClose}><X size={18}/></button></header>{children}
  </dialog>;
}
