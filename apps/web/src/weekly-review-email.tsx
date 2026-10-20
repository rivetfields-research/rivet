import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Mail, X } from 'lucide-react';
import type { Run } from '../../../packages/core/src/types';
import { emailDraftFile, emailDraftLink, weeklyReviewEmailDraft } from './weekly-review-presentation';

export function WeeklyReviewEmail({ run }: { run: Run }) {
  const dialog = useRef<HTMLDialogElement>(null), opener = useRef<HTMLButtonElement>(null);
  const [recipient, setRecipient] = useState('');
  const draft = weeklyReviewEmailDraft(run, typeof location === 'undefined' ? 'http://localhost/' : location.href);
  if (!draft) return null;
  const link = emailDraftLink(recipient, draft);
  const validRecipient = !recipient.trim() || Boolean(emailDraftLink(recipient, { ...draft, body: '' }));
  function close() { dialog.current?.close(); opener.current?.focus(); }
  function download() {
    const encode = (text: string) => {
      let binary = ''; for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
      return btoa(binary);
    };
    const url = URL.createObjectURL(new Blob([emailDraftFile(recipient, draft!, encode)], { type: 'message/rfc822' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `weekly-review-${run.weeklyReview!.period.from.slice(0, 10)}.eml`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const modal = <dialog ref={dialog} className="team-share-dialog weekly-review-email" aria-labelledby={`weekly-email-${run.id}`} onCancel={() => opener.current?.focus()}>
      <header><h2 id={`weekly-email-${run.id}`}>Your weekly social & data update</h2><button type="button" className="icon-button" aria-label="Close email draft" title="Close" onClick={close}><X size={16}/></button></header>
      <p className="empty-note">Draft · not sent. Automatic review emails are managed in the workflow schedule.</p>
      <label>To<input type="email" value={recipient} onChange={event => setRecipient(event.target.value)} maxLength={254} placeholder="you@example.com"/></label>
      <label>Subject<input readOnly value={draft.subject}/></label>
      <label>Saved report<textarea readOnly value={draft.body} rows={10}/></label>
      <div className="team-share-actions"><button type="button" className="button secondary" onClick={close}>Close</button><button type="button" className="button secondary" disabled={!validRecipient} onClick={download}><Download size={14}/> Download draft</button>{link && <a className="button primary" href={link}><Mail size={14}/> Open email draft</a>}</div>
    </dialog>;
  return <><button ref={opener} type="button" title="Email report" aria-label="Email report" onClick={() => dialog.current?.showModal()}><Mail size={15}/></button>{typeof document !== 'undefined' && createPortal(modal, document.body)}</>;
}
