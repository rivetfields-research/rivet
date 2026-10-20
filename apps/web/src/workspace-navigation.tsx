import { runTitle } from './run-presentation';
import { useEffect, useRef, useState } from 'react';
import { Building2, ChevronDown, ChevronRight, CircleAlert, CircleCheck, Clock3, LoaderCircle, LogOut, Menu, MessageCircle, PanelLeftClose, PanelLeftOpen, Pin, PinOff, Plus, RefreshCw, Search, Settings2, UserRound, X } from 'lucide-react';
import type { RunSummary } from '../../../packages/core/src/types';
import { careNavigation, careUtilityNavigation, primaryNavigation, utilityNavigation, viewInfo, type View } from './navigation';
import { RivetMark } from './rivet-mark';
import { WorkspaceBrand } from './workspace-brand';
import { customerOrganization } from './workspace-scope';
import { sessionDisplayName, type WorkspaceSession } from './session-access';
import { conversationId, sidebarConversations } from './sidebar-pins';
import { useSidebarPins } from './use-sidebar-pins';

type ConversationState = Pick<RunSummary, 'id' | 'sessionId' | 'parentRunId' | 'createdAt' | 'updatedAt' | 'status' | 'error'>;
type Props = { view: View; selectedId: string | null; runs: RunSummary[]; liveRun?: RunSummary | null; profileId?: string; ready?: boolean; collapsed: boolean; healthcare?: boolean; hosted?: boolean; session?: WorkspaceSession | null; onSignOut?:()=>void; onSwitchWorkspace?:()=>void; onCollapse: () => void; onNavigate: (view: View) => void; onRun: (id: string) => void; onNew: () => void; onSearch: () => void };

const runStatusLabels: Record<RunSummary['status'], string> = {
  queued: 'Queued', running: 'Working', completed: 'Complete',
  cancelled: 'Stopped', failed: 'Failed', interrupted: 'Interrupted',
};

function RecentRunStatus({ run }: { run: ConversationState }) {
  const completed = run.status === 'completed' && !run.error;
  const needsAttention = run.status !== 'cancelled' && (run.status === 'failed' || run.status === 'interrupted' || Boolean(run.error));
  const label = needsAttention && !['failed', 'interrupted'].includes(run.status) ? 'Needs attention' : runStatusLabels[run.status];
  return <span className={`run-sidebar-status ${needsAttention ? 'failed' : run.status}`} role="img" aria-label={label}
    title={completed ? 'Task completed. Answer checks are separate in Verification.' : label}>
    {completed ? <CircleCheck size={16} aria-hidden="true"/> : needsAttention ? <CircleAlert size={16} aria-hidden="true"/> : run.status === 'running' ? <LoaderCircle size={16} aria-hidden="true"/> : run.status === 'queued' ? <Clock3 size={16} aria-hidden="true"/> : <MessageCircle size={16} aria-hidden="true"/>}
  </span>;
}

export function WorkspaceNavigation({ view, selectedId, runs, liveRun, profileId = 'workspace-analyst', ready = true, collapsed, healthcare = false, session, onSignOut, onSwitchWorkspace, onCollapse, onNavigate, onRun, onNew, onSearch }: Props) {
  const conversations = sidebarConversations(liveRun ? [...runs, liveRun] : runs);
  const pinState = useSidebarPins(profileId, conversations);
  const byId = new Map(conversations.map(run => [conversationId(run), run]));
  const selectedConversation = liveRun && selectedId ? conversationId(liveRun) : conversationId(runs.find(run => run.id === selectedId) ?? { id: selectedId ?? '' });
  const unpinned = conversations.filter(run => !pinState.pins.includes(conversationId(run)));
  const recent = unpinned.slice(0, 6);
  const selected = unpinned.find(run => conversationId(run) === selectedConversation);
  if (selected && !recent.includes(selected)) recent.splice(5, 1, selected);
  const pinControls = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingFocus.current) return;
    const control = pinControls.current.get(pendingFocus.current);
    const container = pendingFocus.current.startsWith('true:') ? '.navigation-drawer' : '#workspace-sidebar';
    (control ?? document.querySelector<HTMLButtonElement>(`${container} [aria-label="Recent tasks"] .recent-heading button`) ?? document.querySelector<HTMLButtonElement>(`${container} .sidebar-new-task`))?.focus();
    pendingFocus.current = null;
  }, [pinState.pins]);
  const customer = session?.mode === 'authenticated' && session.organizationId ? session.workspaceName : customerOrganization() ? 'Rivet' : undefined;
  const [recentOpen, setRecentOpen] = useState(!healthcare);
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const drawer = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const mobile = window.matchMedia('(max-width: 700px)');
    const closeOnDesktop = () => { if (!mobile.matches) drawer.current?.close(); };
    mobile.addEventListener('change', closeOnDesktop);
    closeOnDesktop();
    return () => mobile.removeEventListener('change', closeOnDesktop);
  }, []);
  useEffect(() => {
    if (healthcare) return;
    const previousTitle = document.title;
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    const previousHref = icon?.getAttribute('href');
    const previousType = icon?.getAttribute('type');
    document.title = customer?.trim() && customer.trim() !== 'Rivet' ? `${customer.trim()} | Rivet` : 'Rivet';
    if (icon) { icon.href = '/favicon.svg'; icon.type = 'image/svg+xml'; }
    return () => {
      document.title = previousTitle;
      if (icon) {
        if (previousHref === null || previousHref === undefined) icon.removeAttribute('href'); else icon.setAttribute('href', previousHref);
        if (previousType === null || previousType === undefined) icon.removeAttribute('type'); else icon.setAttribute('type', previousType);
      }
    };
  }, [healthcare, customer]);
  const items = healthcare ? careNavigation : primaryNavigation;
  const utilities = healthcare ? careUtilityNavigation : utilityNavigation;
  const act = (action: () => void) => { drawer.current?.close(); action(); };
  function pinControl(id: string, title: string, mobile: boolean, unavailable = false) {
    const pinned = pinState.pins.includes(id), focusKey = `${mobile}:${id}`;
    const label = unavailable ? 'Unpin unavailable conversation' : `${pinned ? 'Unpin' : 'Pin'} ${title}`;
    return <button type="button" className={`sidebar-pin ${pinned ? 'is-pinned' : ''}`} aria-label={label} title={label} aria-pressed={pinned}
      ref={element => { if (element) pinControls.current.set(focusKey, element); else pinControls.current.delete(focusKey); }}
      onClick={() => { pendingFocus.current = focusKey; setPinnedOpen(true); setRecentOpen(true); pinState.toggle(id); }}>
      {pinned ? <PinOff size={14}/> : <Pin size={14}/>}
    </button>;
  }
  function conversationRow(run: RunSummary, mobile: boolean) {
    const id = conversationId(run), title = runTitle(run);
    return <div key={id} className={`sidebar-task-row ${selectedConversation === id && view === 'tasks' ? 'selected' : ''}`}>
      <button className="recent-run" onClick={() => act(() => onRun(id))} title={title} aria-current={selectedConversation === id && view === 'tasks' ? 'page' : undefined}>
        <RecentRunStatus run={run}/><span className="recent-run-title">{title}</span>
      </button>{pinControl(id, title, mobile)}
    </div>;
  }
  function content(mobile: boolean) {
    return <>
      <div className="brand"><button className="brand-identity" aria-label={!mobile && collapsed ? "Expand navigation" : "Open workspace"} title={!mobile && collapsed ? "Expand navigation" : "Open workspace"} onClick={!mobile && collapsed ? onCollapse : () => act(() => onNavigate('home'))}>{healthcare || customer ? <><RivetMark size={23}/><span className="brand-word" title={customer} style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',minWidth:0}}>{customer || 'Rivetfields'}</span></> : <WorkspaceBrand compact={!mobile && collapsed}/>}</button><div className="brand-actions"><button className="icon-button collapse-button" onClick={mobile ? () => drawer.current?.close() : onCollapse} aria-label={mobile ? 'Close navigation' : collapsed ? 'Expand navigation' : 'Collapse navigation'}>{mobile ? <X size={15}/> : collapsed ? <PanelLeftOpen size={15}/> : <PanelLeftClose size={15}/>}</button></div></div>
      <button className="nav-search" onClick={() => act(onSearch)} aria-label="Search workspace" title="Search workspace (⌘ K)"><Search size={16}/><span>Search</span><kbd>⌘ K</kbd></button>
      <div className="navigation-scroll"><nav className="primary-navigation" aria-label="Main">{items.map(item => { const selected = (item.views as View[]).includes(view); const childViews = item.views.filter(id => id !== 'assistant' && id !== item.id); return <div key={item.id}><button className={`nav-item ${selected ? 'selected' : ''}`} aria-current={(healthcare ? item.id === view : selected) ? 'page' : undefined} aria-label={item.label} title={item.label} onClick={() => act(() => onNavigate(item.id))}><item.icon size={18}/><span>{item.label}</span></button>{healthcare && selected && childViews.length > 0 && <div className="sidebar-sections">{childViews.map(id => { const info = viewInfo(id); return <button key={id} className="nav-item sidebar-section-item" aria-current={id === view ? 'page' : undefined} aria-label={info.label} title={info.label} onClick={() => act(() => onNavigate(id))}><info.icon size={18}/><span>{info.label}</span></button>; })}</div>}</div>; })}</nav>
      <button className="nav-item sidebar-new-task" onClick={() => act(onNew)} title="New task" aria-label="New task"><Plus size={18}/><span>New task</span></button>
      {pinState.pins.length > 0 && <section className="recent-runs pinned-runs" aria-label="Pinned"><div className="recent-heading"><button aria-expanded={pinnedOpen} onClick={() => setPinnedOpen(!pinnedOpen)}>Pinned <ChevronDown size={12} className={pinnedOpen ? '' : 'closed'}/></button></div>{pinnedOpen && <div>{pinState.pins.map(id => {
        const pinned = byId.get(id) ?? pinState.resolved.get(id);
        return pinned ? conversationRow(pinned, mobile) : <div key={id} className="sidebar-task-row unavailable">
          <span className="recent-run"><MessageCircle size={16}/><span className="recent-run-title">{pinState.resolved.get(id) === null ? 'Conversation unavailable' : 'Loading conversation...'}</span></span>
          {pinState.resolved.get(id) === null && <button className="sidebar-retry" aria-label="Retry pinned conversation" title="Retry pinned conversation" onClick={pinState.retry}><RefreshCw size={14}/></button>}
          {pinControl(id, '', mobile, true)}
        </div>;
      })}</div>}</section>}
      {conversations.length > 0 && <section className="recent-runs" aria-label="Recent tasks"><div className="recent-heading"><button aria-expanded={recentOpen} onClick={() => setRecentOpen(!recentOpen)}>Recent tasks <ChevronDown size={12} className={recentOpen ? '' : 'closed'}/></button></div>{recentOpen && <div>{recent.map(run => conversationRow(run, mobile))}<button className="recent-run recent-all" onClick={() => act(() => onNavigate('tasks'))}>All tasks <ChevronRight size={12}/></button></div>}</section>}
      {pinState.notice && <p className="sidebar-pin-notice" role="status">{pinState.notice}</p>}</div>
      {utilities.length > 0 && <nav className="utility-navigation" aria-label="Workspace tools">{utilities.map(item => <button key={item.id} className={`nav-item ${view === item.id ? 'selected' : ''}`} aria-current={view === item.id ? 'page' : undefined} aria-label={item.label} title={item.label} onClick={() => act(() => onNavigate(item.id))}><item.icon size={16}/><span>{item.label}</span></button>)}</nav>}

      <details className="workspace-profile" onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}>
        <summary aria-label={`Account: ${sessionDisplayName(session) ?? (session?.mode === 'local' ? 'Local workspace' : 'Your account')}`}><span className="workspace-avatar"><UserRound size={17}/></span><span className="workspace-profile-name"><strong>{sessionDisplayName(session) ?? (session?.mode === 'local' ? 'Local workspace' : 'Your account')}</strong><small>{session?.mode === 'authenticated' ? 'Account & settings' : session?.mode === 'local' ? 'Workspace settings' : 'Loading…'}</small></span><ChevronDown size={13}/></summary>
        <div className="workspace-profile-popover">{session?.mode === 'authenticated' && session.email && <p>{session.email}</p>}<button type="button" onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); act(() => onNavigate('workspace')); }}><Settings2 size={15}/>Settings</button>{session?.workspacesEnabled && onSwitchWorkspace && <button type="button" onClick={() => act(onSwitchWorkspace)}><Building2 size={15}/>Your workspaces</button>}{session?.organizationAdmin && <a href="/admin" target="_blank" rel="noopener"><Building2 size={15}/>Rivet Admin</a>}{onSignOut && <a href={session?.mode === 'authenticated' ? session.signOutUrl : '#'} aria-label="Sign out" onClick={event => { event.preventDefault(); act(onSignOut); }}><LogOut size={15}/>Sign out</a>}</div>
      </details>
    </>;
  }
  return <><header className="mobile-workspace-bar"><button className="icon-button" aria-label="Open navigation" disabled={!ready} title={ready ? 'Open navigation' : 'Loading navigation'} onClick={() => drawer.current?.showModal()}><Menu size={19}/></button>{healthcare || customer ? <><RivetMark size={22}/><span style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',minWidth:0}}>{customer || 'Rivetfields'}</span></> : <span className="mobile-workspace-identity"><WorkspaceBrand compact size={26}/></span>}<button className="icon-button" aria-label="Search workspace" onClick={onSearch}><Search size={17}/></button><button className="icon-button" aria-label="New task" onClick={onNew}><Plus size={19}/></button></header><aside id="workspace-sidebar" className="sidebar" aria-label="Workspace navigation">{content(false)}</aside><dialog ref={drawer} className="navigation-drawer" aria-label="Workspace navigation" onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX > rect.right || event.clientY > rect.bottom) drawer.current?.close(); } }}><div className="drawer-content">{content(true)}</div></dialog></>;
}
