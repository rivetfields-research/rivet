import type { ReactNode, Ref } from 'react';
import { RivetMark } from './rivet-mark';

export function WorkspaceAccessLayout({ title, children, headingRef }: { title: string; children: ReactNode; headingRef?: Ref<HTMLHeadingElement> }) {
  return <main className="org-app workspace-access"><div className="workspace-access-content">
    <div className="org-brand"><RivetMark size={28}/><span>Rivet</span></div>
    <h1 ref={headingRef} tabIndex={headingRef ? -1 : undefined}>{title}</h1><div className="workspace-access-body">{children}</div>
  </div></main>;
}
