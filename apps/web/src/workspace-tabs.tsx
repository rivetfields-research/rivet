import { Ellipsis, FileText, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { workspaceDestinations, viewInfo, type View } from './navigation';

export type WorkspaceTab = { key: string; view: View; runId?: string; caseId?: string; projectId?: string; title: string };
export const homeTab: WorkspaceTab = { key: 'home', view: 'home', title: 'Home' };
export const MAX_IDLE_WORKSPACE_TABS = 10;
export type WorkspaceTabPolicy = { healthcare?: boolean; protectedKeys?: ReadonlySet<string>; completedKeys?: ReadonlySet<string>; runSessions?: ReadonlyMap<string, string> };
export type WorkspaceTabClose = 'others' | 'completed' | { key: string };

export function workspaceTabIdentity(tab: WorkspaceTab, policy: WorkspaceTabPolicy = {}): WorkspaceTab {
  if (tab.runId) {
    const sessionId = policy.runSessions?.get(tab.runId) ?? tab.runId;
    // Reuse the conversation tab without rewriting an explicitly opened turn.
    return tab.key === `run:${sessionId}` ? tab : { ...tab, key: `run:${sessionId}` };
  }
  if (tab.caseId) return tab.key === `case:${tab.caseId}` ? tab : { ...tab, key: `case:${tab.caseId}` };
  if (!policy.healthcare && ['home', 'assistant'].includes(tab.view)) return homeTab;
  const view = !policy.healthcare && tab.view === 'connections' ? 'workspace' : tab.view;
  const key = !policy.healthcare && ['artifacts', 'reports', 'dashboards'].includes(view) ? 'dashboards' : view;
  return tab.key === key && tab.view === view ? tab : { ...tab, key, view };
}

export function rememberWorkspaceTab(tabs: WorkspaceTab[], current: WorkspaceTab, policy: WorkspaceTabPolicy = {}): WorkspaceTab[] {
  const next = new Map<string, WorkspaceTab>([['home', tabs.find(tab => tab.key === 'home') ?? homeTab]]);
  for (const tab of tabs) { const identity = workspaceTabIdentity(tab, policy); next.set(identity.key, identity); }
  const chosen = workspaceTabIdentity(current, policy);
  next.set(chosen.key, chosen);
  // Protected work can exceed the idle limit. Never trade its access for a shorter strip.
  let idle = [...next.keys()].filter(key => key !== 'home' && !policy.protectedKeys?.has(key)).length;
  for (const key of next.keys()) {
    if (idle <= MAX_IDLE_WORKSPACE_TABS) break;
    if (key === 'home' || key === chosen.key || policy.protectedKeys?.has(key)) continue;
    next.delete(key); idle--;
  }
  const result = [...next.values()];
  return result.length === tabs.length && result.every((tab, index) => JSON.stringify(tab) === JSON.stringify(tabs[index])) ? tabs : result;
}

export function closeWorkspaceTabs(tabs: WorkspaceTab[], current: string, action: WorkspaceTabClose, policy: WorkspaceTabPolicy = {}): { tabs: WorkspaceTab[]; current: string; closed: number } {
  const kept = tabs.filter(tab => tab.key === 'home' || policy.protectedKeys?.has(tab.key) ||
    (action === 'others' ? tab.key === current : action === 'completed' ? !policy.completedKeys?.has(tab.key) : tab.key !== action.key));
  if (kept.length === tabs.length) return { tabs, current, closed: 0 };
  const index = tabs.findIndex(tab => tab.key === current);
  const fallback = kept.some(tab => tab.key === current) ? current
    : tabs.slice(0, index).reverse().find(tab => kept.includes(tab))?.key ?? kept[0]?.key ?? 'home';
  return { tabs: kept, current: fallback, closed: tabs.length - kept.length };
}

export function WorkspaceTabs({ tabs, current, healthcare, onOpen, onClose, onCloseOthers, onCloseCompleted, policy = {} }: {
  tabs: WorkspaceTab[]; current: string; healthcare: boolean;
  onOpen: (tab: WorkspaceTab) => void; onClose: (tab: WorkspaceTab) => void;
  onCloseOthers?: () => void; onCloseCompleted?: () => void; policy?: WorkspaceTabPolicy;
}) {
  const destinations = workspaceDestinations(healthcare);
  const strip = useRef<HTMLElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    strip.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [current, tabs]);
  function toggleMenu() {
    const rect = menuButton.current?.getBoundingClientRect();
    if (rect && menu.current) {
      menu.current.style.left = `${Math.max(8, Math.min(rect.right - 216, innerWidth - 224))}px`;
      menu.current.style.top = `${Math.max(8, Math.min(rect.bottom + 5, innerHeight - 100))}px`;
      menu.current.togglePopover();
    }
  }
  function menuKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.preventDefault(); menu.current?.hidePopover(); menuButton.current?.focus(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }
  function clean(action: (() => void) | undefined) { menu.current?.hidePopover(); menuButton.current?.focus(); action?.(); }
  return <div className="workspace-tabs-container"><nav ref={strip} className="workspace-resource-tabs" aria-label="Open workspace views">
    {tabs.map(tab => {
      const page = !healthcare && tab.view === 'artifacts' ? viewInfo('reports') : destinations.find(item => item.id === tab.view) ?? viewInfo(tab.view);
      const Icon = tab.caseId || tab.runId ? FileText : page.icon;
      const title = tab.caseId || tab.runId || tab.view === 'example' ? tab.title : page.label;
      return <div className={`workspace-resource-tab ${current === tab.key ? 'is-active' : ''}`} key={tab.key}>
        <button className="resource-tab-open" aria-current={current === tab.key ? 'page' : undefined} title={title} onClick={() => onOpen(tab)}><Icon size={15}/><span>{title}</span></button>
        {tab.key !== 'home' && <button className="resource-tab-close" aria-label={`Close ${title} view`} disabled={policy.protectedKeys?.has(tab.key)} title={policy.protectedKeys?.has(tab.key) ? 'Running, pinned or unfinished work is kept open' : 'Close view'} onClick={() => onClose(tab)}><X size={12}/></button>}
      </div>;
    })}
  </nav>{(onCloseOthers || onCloseCompleted) && <><button ref={menuButton} type="button" className="icon-button workspace-tabs-menu-button" aria-label="Manage open views" title="Manage open views" aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuId} onClick={toggleMenu}><Ellipsis size={17}/></button>
    <div ref={menu} id={menuId} popover="auto" role="menu" aria-label="Manage open views" className="workspace-tabs-menu" onKeyDown={menuKeys} onToggle={event => { const open = (event.nativeEvent as ToggleEvent).newState === 'open'; setMenuOpen(open); if (open) requestAnimationFrame(() => menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()); }}>
      <button type="button" role="menuitem" disabled={!onCloseOthers || !closeWorkspaceTabs(tabs, current, 'others', policy).closed} onClick={() => clean(onCloseOthers)}>Close other views</button>
      <button type="button" role="menuitem" disabled={!onCloseCompleted || !closeWorkspaceTabs(tabs, current, 'completed', policy).closed} onClick={() => clean(onCloseCompleted)}>Close completed views</button>
    </div></>}</div>;
}
