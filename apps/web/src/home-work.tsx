import { ArrowRight, CircleAlert, FileText, Table2, Workflow } from 'lucide-react';
import type { RunSummary } from '../../../packages/core/src/types';
import type { View } from './navigation';
import { runTitle } from './run-presentation';

export function homeWork(runs: RunSummary[]) {
  return {
    recent: runs.filter(run => run.status === 'completed' || run.status === 'running' || run.status === 'queued').slice(0, 3),
    attention: runs.filter(run => run.status === 'failed' || run.status === 'interrupted').slice(0, 3),
  };
}

export function HomeWork({ runs, hasSources, onRun, onNavigate }: {
  runs: RunSummary[]; hasSources: boolean; onRun: (id: string) => void; onNavigate: (view: View) => void;
}) {
  const { recent, attention } = homeWork(runs);
  const row = (run: RunSummary, needsAttention = false) => <button className="home-work-row" key={run.id} onClick={() => onRun(run.id)}>
    <span className="home-work-icon" aria-hidden="true">{needsAttention ? <CircleAlert size={18}/> : <FileText size={18}/>}</span>
    <span className="home-work-copy"><strong>{runTitle(run)}</strong><small>{needsAttention ? run.hasSavedCalculation ? 'Calculation saved; explanation incomplete' : 'Needs attention'
      : run.status === 'running' || run.status === 'queued' ? 'In progress' : run.artifactTitle ? 'Saved report' : 'Conversation'}
      {' · '}<time dateTime={run.createdAt}>{new Date(run.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time></small></span><ArrowRight size={15}/>
  </button>;
  return <div className="home-work">
    {recent.length > 0 && <section aria-label="Recent work"><header><h2>Recent work</h2><button className="text-button" onClick={() => onNavigate('tasks')}>All conversations <ArrowRight size={13}/></button></header>{recent.map(run => row(run))}</section>}
    {attention.length > 0 && <section aria-label="Needs attention"><header><h2>Needs attention</h2></header>{attention.map(run => row(run, true))}</section>}
    {!runs.length && <section aria-label="Get started"><header><h2>{hasSources ? 'Your sources are ready' : 'Start with your data'}</h2></header>
      <button className="home-work-row" onClick={() => onNavigate('tables')}><span className="home-work-icon" aria-hidden="true"><Table2 size={18}/></span><span className="home-work-copy"><strong>{hasSources ? 'Open sources' : 'Add your first source'}</strong></span><ArrowRight size={15}/></button>
    </section>}
    <nav className="home-work-links" aria-label="Saved work"><button className="text-button" onClick={() => onNavigate('dashboards')}><FileText size={15}/>Reports</button><button className="text-button" onClick={() => onNavigate('workflows')}><Workflow size={15}/>Workflows</button></nav>
  </div>;
}
