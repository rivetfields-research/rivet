import { BookOpen, Bot, CalendarClock, Compass, FileText, FolderOpen, Home, LayoutDashboard, LayoutGrid, ListChecks, MessageCircle, Monitor, NotebookPen, Plug, Presentation, Search, Settings, Settings2, Table2, Workflow, Zap } from 'lucide-react';
import type { ModuleView } from './modules';

export type View = ModuleView | 'home' | 'tasks' | 'artifacts' | 'reports' | 'sources' | 'connections' | 'workspace' | 'review' | 'care-worklist' | 'care-benchmarks' | 'assistant' | 'example';
type NavigationItem = { id: View; label: string; icon: typeof Home; description: string };
export const navigation: { label: string; items: NavigationItem[] }[] = [
  { label: 'Workspace', items: [
    { id: 'home', label: 'Home', icon: Home, description: 'Start work and pick up where you left off' },
    { id: 'assistant', label: 'New task', icon: Zap, description: 'Give Rivet something to work on' },
    { id: 'example', label: 'Get started', icon: Compass, description: 'Explore an example conversation, document and its sources' },
    { id: 'care-worklist', label: 'Work list', icon: CalendarClock, description: 'Recorded referral follow-ups and local schedules' },
    { id: 'care-benchmarks', label: 'Benchmark', icon: LayoutDashboard, description: 'Measured model runs and human review timing' },
    { id: 'tasks', label: 'Conversations', icon: MessageCircle, description: 'Your saved and running tasks and conversations' },
    { id: 'projects', label: 'Projects', icon: FolderOpen, description: 'Organize a purpose, context and deliverables' },
    { id: 'review', label: 'Review', icon: Search, description: 'Inspect outputs and future action requests' },
  ] },
  { label: 'Your work', items: [
    { id: 'artifacts', label: 'Reports', icon: FileText, description: 'Reports and visual analyses from your tasks' },
    { id: 'reports', label: 'Reports', icon: FileText, description: 'Source-linked briefs from your tasks' },
    { id: 'decks', label: 'Decks', icon: Presentation, description: 'Plan a presentation' },
    { id: 'dashboards', label: 'Reports', icon: LayoutDashboard, description: 'Saved dashboards, analysis charts and their evidence' },
    { id: 'tables', label: 'Sources', icon: Table2, description: 'Browse CSV tables and workspace documents' },
    { id: 'applications', label: 'Applications', icon: LayoutGrid, description: 'Design internal tools for your team' },
  ] },
  { label: 'Make it repeatable', items: [
    { id: 'playbooks', label: 'Playbooks', icon: NotebookPen, description: 'Reusable instructions and writing preferences' },
    { id: 'workflows', label: 'Workflows', icon: Workflow, description: 'Connect steps, review and delivery' },
    { id: 'schedules', label: 'Schedules', icon: CalendarClock, description: 'Plan when work should happen' },
    { id: 'agents', label: 'Agents', icon: Bot, description: 'Define an agent’s purpose and boundaries' },
    { id: 'computer', label: 'Computer', icon: Monitor, description: 'Plan a browser or repository session' },
  ] },
  { label: 'Context', items: [
    { id: 'skills', label: 'Skills', icon: Zap, description: 'Repeatable ways of doing specific work' },
    { id: 'sources', label: 'Files', icon: BookOpen, description: 'Open files and documents shared with your workspace' },
    { id: 'connections', label: 'Connections', icon: Plug, description: 'Connectors and places Rivet can work' },
    { id: 'workspace', label: 'Settings', icon: Settings, description: 'Account, usage and configured connections' },
  ] },
];
export const allNavigation = navigation.flatMap((group) => group.items);
type SidebarItem = { id: View; label: string; icon: typeof Home; views: View[] };
// Keep useful destinations in a flat list. Planning-only output types
// remain routable for existing drafts without claiming they can be generated.
export const primaryNavigation: SidebarItem[] = [
  { id: 'home', label: 'Home', icon: Home, views: ['home', 'assistant'] },
  { id: 'tables', label: 'Sources', icon: Table2, views: ['tables'] },
  { id: 'tasks', label: 'Conversations', icon: MessageCircle, views: ['tasks'] },
  { id: 'dashboards', label: 'Reports', icon: LayoutDashboard, views: ['dashboards'] },
  { id: 'workflows', label: 'Workflows', icon: Workflow, views: ['workflows'] },
];
export const utilityNavigation: NavigationItem[] = [allNavigation.find(item => item.id === 'workspace')!];
export const sidebarViewIds: View[] = [...primaryNavigation.map(item => item.id), ...utilityNavigation.map(item => item.id)];
export const careNavigation = [
  { id: 'home', label: 'Queue', icon: ListChecks, views: ['home'] },
  { id: 'assistant', label: 'Rivet', icon: Bot, views: ['assistant', 'tasks'] },
  { id: 'reports', label: 'Reports', icon: FileText, views: ['reports'] },
  { id: 'playbooks', label: 'Playbooks', icon: NotebookPen, views: ['playbooks'] },
  { id: 'workflows', label: 'Workflows', icon: Workflow, views: ['workflows'] },
  { id: 'care-worklist', label: 'Follow-ups', icon: CalendarClock, views: ['care-worklist'] },
  { id: 'care-benchmarks', label: 'Results', icon: LayoutDashboard, views: ['care-benchmarks'] },
] satisfies { id: View; label: string; icon: typeof Home; views: View[] }[];
// Healthcare keeps its own established utilities when the analyst sidebar changes.
export const careUtilityNavigation = allNavigation.filter(item => ['skills', 'sources', 'connections'].includes(item.id))
  .map(item => item.id === 'connections' ? { ...item, label: 'Intake' } : item.id === 'sources' ? { ...item, label: 'Knowledge', description: 'Inspect approved source documents' } : item);
// A quieter sidebar must not hide saved browser resources from workspace search.
export function workspaceDestinations(healthcare: boolean): NavigationItem[] {
  if (!healthcare) {
    return [...sidebarViewIds.map(id => allNavigation.find(item => item.id === id)!),
      ...allNavigation.filter(item => !sidebarViewIds.includes(item.id) && item.id !== 'care-worklist' && item.id !== 'care-benchmarks' && item.id !== 'example' && item.id !== 'reports' && item.id !== 'connections')].map(item => {
        const primary = primaryNavigation.find(page => page.id === item.id);
        return primary ? { ...item, label: primary.label, icon: primary.icon } : item;
      });
  }
  const ids = new Set<View>([...careNavigation.flatMap(item => item.views), ...careUtilityNavigation.map(item => item.id)]);
  return allNavigation.filter(item => ids.has(item.id)).map(item => {
    const primary = careNavigation.find(page => page.id === item.id);
    if (item.id === 'home') return { ...item, ...primary, description: 'Review incoming referrals and their next steps' };
    if (item.id === 'connections') return { ...item, label: 'Intake', description: 'Receive fictional packets through simulated intake channels' };
    if (item.id === 'sources') return { ...item, label: 'Knowledge', description: 'Inspect approved source documents' };
    return primary ? { ...item, label: primary.label, icon: primary.icon } : item;
  });
}
export const sectionFor = (view: View, healthcare = false) => (healthcare ? careNavigation : primaryNavigation).find(section => (section.views as View[]).includes(view));
export const sectionPages = (view: View, healthcare = false) => (sectionFor(view, healthcare)?.views ?? []).map(id => allNavigation.find(item => item.id === id)!);
export const isView = (value: string | null): value is View => allNavigation.some((item) => item.id === value);
export const canonicalView = (view: View, healthcare: boolean): View => !healthcare && view === 'connections' ? 'workspace' : view;
export const routeView = () => {
  const params = new URLSearchParams(location.search);
  return params.has('run') ? 'tasks' : isView(params.get('view')) ? params.get('view') as View : 'home';
};
export const viewInfo = (view: View) => allNavigation.find((item) => item.id === view) ?? { label: 'Workspace', icon: Settings2, description: '' };
