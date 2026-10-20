import { useEffect, useRef, type RefObject } from 'react';

export function acceptDroppedFiles(files: readonly File[], blocked: boolean, accept: (file: File) => void, reject: (message: string) => void) {
  if (blocked) { reject('Finish the current upload or request before adding another file.'); return; }
  if (files.length !== 1) { reject('Add one file at a time. No files were uploaded.'); return; }
  accept(files[0]);
}

/** Only the owning composer/library accepts drops; never navigate to a dropped file. */
export function useFileDrop(anchor: RefObject<HTMLElement | null>, selector: string, blocked: boolean, accept: (file: File) => void, reject: (message: string) => void) {
  const current = useRef({ blocked, accept, reject });
  current.current = { blocked, accept, reject };
  useEffect(() => {
    const target = anchor.current?.closest<HTMLElement>(selector);
    if (!target) return;
    const isFile = (event: DragEvent) => event.dataTransfer?.types.includes('Files');
    const clear = () => target.removeAttribute('data-file-drag');
    const over = (event: DragEvent) => {
      if (!isFile(event)) return;
      event.preventDefault(); event.stopPropagation();
      event.dataTransfer!.dropEffect = current.current.blocked ? 'none' : 'copy';
      if (!current.current.blocked) target.setAttribute('data-file-drag', 'true');
    };
    const leave = (event: DragEvent) => { if (!target.contains(event.relatedTarget as Node | null)) clear(); };
    const drop = (event: DragEvent) => {
      if (!isFile(event)) return;
      event.preventDefault(); event.stopPropagation(); clear();
      const state = current.current;
      acceptDroppedFiles(Array.from(event.dataTransfer!.files), state.blocked, state.accept, state.reject);
    };
    target.addEventListener('dragover', over); target.addEventListener('dragleave', leave); target.addEventListener('drop', drop);
    return () => { clear(); target.removeEventListener('dragover', over); target.removeEventListener('dragleave', leave); target.removeEventListener('drop', drop); };
  }, [anchor, selector]);
}
