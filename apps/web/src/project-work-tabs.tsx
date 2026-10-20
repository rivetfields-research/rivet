import { FileText, Plus } from 'lucide-react';
import type { RunSummary } from '../../../packages/core/src/types';
import { runTitle } from './run-presentation';

/** Follow-up runs belong to the same work tab. */
export function projectWorkItems(runs:RunSummary[], activeRunId?:string) {
  const byId=new Map(runs.map(run=>[run.id,run]));
  const root=(run:RunSummary)=>{const seen=new Set<string>();while(run.parentRunId&&byId.has(run.parentRunId)&&!seen.has(run.id)){seen.add(run.id);run=byId.get(run.parentRunId)!;}return run.id;};
  const groups=new Map<string,RunSummary[]>();
  for(const run of runs){const id=root(run);groups.set(id,[...(groups.get(id)??[]),run]);}
  return [...groups].map(([id,turns])=>{const latest=turns.slice().sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];return {id,run:turns.find(run=>run.id===activeRunId)??latest,active:turns.some(run=>run.id===activeRunId)};});
}
export function ProjectWorkTabs({runs,activeRunId,activeRunState,onRun,onNew}:{runs:RunSummary[];activeRunId?:string;activeRunState?:Pick<RunSummary,'status'|'artifactTitle'>;onRun:(id:string)=>void;onNew:()=>void}) {
  return <nav className="project-work-tabs" aria-label="Project work"><button className={!activeRunId?'selected':''} aria-current={!activeRunId?'page':undefined} onClick={onNew}><Plus size={15}/>New work</button>{projectWorkItems(runs,activeRunId).map(item=>{const current=item.active&&activeRunState?{...item.run,...activeRunState}:item.run;return <button key={item.id} className={item.active?'selected':''} aria-current={item.active?'page':undefined} title={runTitle(current)} onClick={()=>onRun(item.run.id)}><FileText size={15}/><span>{runTitle(current)}</span>{['running','queued'].includes(current.status)&&<span className="status-dot running" aria-label="Working"/>}</button>;})}</nav>;
}
