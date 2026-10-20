import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, ArrowUp, FileText, Folder, Pencil, Plus, Database, RefreshCw, X } from 'lucide-react';
import type { Project, ProjectInput, Run, RunSummary, WorkspaceStatus } from '../../../packages/core/src/types';
import { api, ApiError, message, readSaved, saveLocal } from './api';
import { FileUpload } from './file-upload';
import { ProjectWorkTabs } from './project-work-tabs';
import { handleComposerKeyDown } from './composer-keyboard';
import { RestoreSourceButton, type RestoreSource } from './restore-source';
import { allowsManualImports } from './workspace-scope';
import './projects.css';

export function ProjectRows({projects,onOpen}:{projects:Project[];onOpen:(id:string)=>void}) {
  return <div className="project-rows">{projects.map(project => <button key={project.id} onClick={() => onOpen(project.id)}>
    <Folder size={20}/><span><strong>{project.name}</strong><small>Updated {new Date(project.updatedAt).toLocaleDateString([], {month:'short',day:'numeric'})} · {project.sourceIds.length} {project.sourceIds.length === 1 ? 'file' : 'files'}</small></span><ArrowRight size={15}/>
  </button>)}</div>;
}

export function RecentProjects({onOpen,onAll}:{onOpen:(id:string)=>void;onAll:()=>void}) {
  const [projects,setProjects] = useState<Project[]>([]);
  const [error,setError] = useState('');
  useEffect(() => { let live=true; api<{projects:Project[]}>('/api/projects').then(data=>{if(live)setProjects(data.projects);}).catch(e=>{if(live)setError(message(e));});return()=>{live=false;}; },[]);
  return <section className="home-recent-section recent-projects"><header><h2>Recent Projects</h2><button className="text-button" onClick={onAll}>View all <ArrowRight size={12}/></button></header>
    {error ? <p role="alert">{error}</p> : projects.length ? <ProjectRows projects={projects.slice(0,3)} onOpen={onOpen}/> : <button className="project-empty" onClick={onAll}><Plus size={18}/><span>Create a project<small>Keep its files and tasks together.</small></span><ArrowRight size={15}/></button>}
  </section>;
}

export type PendingProjectTask = {task:string;requestId:string;projectId:string;sourceIds?:string[]};
export function projectDataGuidance() {
  return allowsManualImports() ? {
    empty: 'Upload your first file to get started.',
    setup: 'Select shared files or upload an export to give Rivet the context it needs.',
    label: 'Settings', view: 'workspace',
  } : {
    empty: 'No sources yet. Connect an account in Sources to get started.',
    setup: 'Select existing sources or connect an account in Sources to give Rivet the context it needs.',
    label: 'Open Sources', view: 'tables',
  };
}
export function projectTaskRequest(project: Pick<Project, 'id' | 'sourceIds'>, task: string, requestId: string, pending: PendingProjectTask | null = null): PendingProjectTask {
  return pending ?? {projectId:project.id,requestId,task:task.trim(),sourceIds:[...project.sourceIds]};
}

type Props = {workspace:WorkspaceStatus;id:string|null;onOpen:(id:string|null)=>void;onRun:(id:string)=>void;onNavigate:(view:string)=>void;onUsePrompt:(prompt:string,sourceIds?:string[])=>void;onSource:(id:string)=>void;onRefresh:()=>Promise<void>;onRestoreSource?:RestoreSource;activeRunId?:string;activeRunState?:Pick<RunSummary,'status'|'artifactTitle'>;children?:ReactNode};
export function ProjectsPage({workspace,id,onOpen,onRun,onNavigate,onUsePrompt,onSource,onRefresh,onRestoreSource,activeRunId,activeRunState,children}:Props) {
  const guidance = projectDataGuidance();
  const key = `rivetfields.project-editor.${workspace.profile.id}`;
  const [draft,setDraft] = useState<ProjectInput|null>(()=>readSaved(key,null));
  const [projects,setProjects] = useState<Project[]>([]);
  const [project,setProject] = useState<Project|null>(null);
  const [runs,setRuns] = useState<RunSummary[]>([]);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [dataOpen,setDataOpen] = useState(false);
  const [revision,setRevision] = useState(0);
  const [query,setQuery] = useState('');
  const taskKey = `rivetfields.project-task.${workspace.profile.id}.${id ?? 'none'}`;
  const [task,setTask] = useState('');
  const [pending,setPending] = useState<PendingProjectTask|null>(null);
  const taskSourceIds = pending?.sourceIds ?? project?.sourceIds ?? [];
  const unavailableInputs = taskSourceIds.filter(id => !workspace.sources.some(source => source.id === id));
  useEffect(()=>{setTask(readSaved(taskKey,''));setPending(readSaved(`${taskKey}.pending`,null));},[taskKey]);
  useEffect(()=>{saveLocal(key,draft);},[key,draft]);
  useEffect(()=>{
    let live=true;setLoading(true);setError('');setProject(null);setRuns([]);
    const request=id ? api<{project:Project;runs:RunSummary[]}>(`/api/projects/${encodeURIComponent(id)}`).then(data=>{if(live){setProject(data.project);setRuns(data.runs);}})
      : api<{projects:Project[]}>('/api/projects').then(data=>{if(live)setProjects(data.projects);});
    request.catch(e=>{if(live)setError(message(e));}).finally(()=>{if(live)setLoading(false);});
    return()=>{live=false;};
  },[id,revision,activeRunId]);
  async function updateSources(sourceIds:string[]):Promise<boolean> {
    if(!project || busy || pending)return false;
    setBusy(true);setError('');
    try {
      const saved=await api<Project>('/api/projects',{method:'POST',body:JSON.stringify({id:project.id,name:project.name,brief:project.brief,version:project.version,sourceIds})});
      setProject(saved);return true;
    } catch(e){setError(message(e));return false;} finally {setBusy(false);}
  }
  async function save() {
    if(!draft||busy)return;setBusy(true);setError('');
    try { const saved=await api<Project>('/api/projects',{method:'POST',body:JSON.stringify(draft)});setDraft(null);saveLocal(key,null);setProject(saved);onOpen(saved.id);setRevision(n=>n+1); }
    catch(e){setError(message(e));}finally{setBusy(false);}
  }
  async function start() {
    if(!project||busy||(!task.trim()&&!pending)||(!pending&&(!project.sourceIds.length||unavailableInputs.length>0||!workspace.provider.available||!!workspace.activeRunId)))return;
    const request=projectTaskRequest(project,task,pending?.requestId ?? crypto.randomUUID(),pending);
    setPending(request);saveLocal(`${taskKey}.pending`,request);setBusy(true);setError('');
    try { const run=await api<Run>('/api/runs',{method:'POST',body:JSON.stringify(request)});setPending(null);saveLocal(`${taskKey}.pending`,null);saveLocal(taskKey,null);setTask('');onRun(run.id); }
    catch(e){if(e instanceof ApiError && e.status>=400 && e.status<500){setPending(null);saveLocal(`${taskKey}.pending`,null);}setError(message(e));}finally{setBusy(false);}
  }
  if(draft && !activeRunId)return <div className="standard-page project-editor"><div className="page-heading"><h1>{draft.version?'Edit project':'New project'}</h1><button className="text-button" disabled={busy} onClick={()=>setDraft(null)}>Cancel</button></div>
    <form onSubmit={event=>{event.preventDefault();void save();}}>
      <label>Project name<input required maxLength={120} value={draft.name} onChange={event=>setDraft({...draft,name:event.target.value})}/></label>
      <label>Goal (optional)<textarea maxLength={3000} rows={4} placeholder="What would you like to achieve or understand?" value={draft.brief} onChange={event=>setDraft({...draft,brief:event.target.value})}/></label>
{error&&<p role="alert">{error}</p>}<button className="button primary" disabled={busy||!draft.name.trim()}>{busy?'Saving…':draft.version?'Save changes':'Create project'}</button>
    </form></div>;
  if(id)return <div className={`project-workspace ${activeRunId ? 'has-project-work' : ''}`}>
    <header className="project-workspace-header">
      <button className="text-button" onClick={()=>onOpen(null)}><ArrowLeft size={15}/>All projects</button>
      {project&&<><div className="project-identity"><h1>{project.name}</h1>{project.brief&&<p title={project.brief}>{project.brief}</p>}</div>
      <div className="project-header-actions"><button className="button secondary" aria-expanded={dataOpen} onClick={()=>setDataOpen(!dataOpen)}><Database size={15}/>Data · {taskSourceIds.length}</button><button className="icon-button" disabled={busy||!!pending} aria-label="Edit project details" onClick={()=>{const next={id:project.id,name:project.name,brief:project.brief,sourceIds:project.sourceIds,version:project.version};saveLocal(key,next);setDraft(next);onOpen(project.id);}}><Pencil size={15}/></button></div></>}
    </header>
    {error&&<div className="project-notice" role="alert">{error}<button className="text-button" disabled={busy} onClick={()=>setRevision(n=>n+1)}>Reload project</button></div>}
    {loading?<p className="loading-state" role="status">Loading project…</p>:project&&<>
      <ProjectWorkTabs runs={runs} activeRunId={activeRunId} activeRunState={activeRunState} onRun={onRun} onNew={()=>{setDataOpen(false);onOpen(project.id);}}/>
      {dataOpen&&<section className="project-data-panel" aria-label="Project data"><div className="section-label"><h2>Project data</h2><button className="icon-button" aria-label="Close project data" onClick={()=>setDataOpen(false)}><X size={16}/></button></div>
        {pending&&<p role="status">Project files are fixed until this request is confirmed. Retry the same task before changing them.</p>}
        <p>Select the files Rivet should use for new work in this project. Files are shared with the workspace; existing reports keep their original sources.</p>
        <div className="project-data-actions"><FileUpload disabled={busy||!!pending} onSaved={onRefresh} onOpen={onSource} useLabel="Add to project" onUse={async source=>{if(!await updateSources([...new Set([...project.sourceIds,source.id])]))throw new Error('The file is saved, but adding it to this project could not be confirmed. Close this dialog, reload the project and select the saved file in Data.');}}/><button className="text-button" onClick={()=>onNavigate(guidance.view)}>{guidance.label} <ArrowRight size={14}/></button></div>
        <div className="project-data-files">{workspace.sources.map(source=><div className="project-data-file" key={source.id}><label className="project-file-choice"><input type="checkbox" disabled={busy||!!pending} checked={taskSourceIds.includes(source.id)} onChange={event=>void updateSources(event.target.checked?[...project.sourceIds,source.id]:project.sourceIds.filter(id=>id!==source.id))}/><span>{source.title}</span></label><button className="text-button" onClick={()=>onSource(source.id)}>Preview</button></div>)}
        {unavailableInputs.map(id => {
          const archived = workspace.archivedSources?.find(item => item.source.id === id);
          return <div className="project-data-file" key={id}><label className="project-file-choice"><input type="checkbox" checked disabled={busy||!!pending} onChange={()=>void updateSources(project.sourceIds.filter(s=>s!==id))}/><span>{archived ? `${archived.source.title} (archived)` : `Unavailable file · ${id}`}</span></label>{archived && <><button className="text-button" onClick={()=>onSource(id)}>Preview</button><RestoreSourceButton archived={archived} onRestore={onRestoreSource} disabled={busy||!!pending}/></>}</div>;
        })}</div>
        {!workspace.sources.length&&!unavailableInputs.length&&<p>{guidance.empty}</p>}{busy&&<p role="status">Saving…</p>}
      </section>}
      {activeRunId ? children : <div className="project-start"><h2>What would you like to work on?</h2><p>Ask a question or create a report. Each conversation and its output stays in its own tab.</p>
        {!project.sourceIds.length&&<div className="project-setup-note"><Database size={20}/><div><strong>Add your campaign data</strong><p>{guidance.setup}</p></div><button className="button secondary" onClick={()=>setDataOpen(true)}>Add data</button></div>}
        {unavailableInputs.length > 0 && <p role="status">{unavailableInputs.length} project {unavailableInputs.length === 1 ? 'file is' : 'files are'} archived or unavailable. <button className="text-button" onClick={()=>setDataOpen(true)}>Review project data</button></p>}
        <form className="composer" onSubmit={e=>{e.preventDefault();void start();}}><label className="sr-only" htmlFor="project-task">Ask about this project</label><textarea id="project-task" maxLength={4000} placeholder="Ask a question or describe the report you need…" value={pending?.task??task} readOnly={!!pending} onChange={event=>{setTask(event.target.value);saveLocal(taskKey,event.target.value);}} onKeyDown={event=>handleComposerKeyDown(event,()=>{void start();})}/><div className="composer-footer"><span className="small muted">{taskSourceIds.length} project files</span><button className="submit-task" aria-label={pending?'Retry project task':'Start project work'} disabled={busy||(!pending&&(!task.trim()||!project.sourceIds.length||unavailableInputs.length>0||!workspace.provider.available||!!workspace.activeRunId))}><ArrowUp size={18}/></button></div></form>
        {pending&&<p role="status">This request has not been confirmed. Retry to check the same request without creating a duplicate.</p>}
        {!workspace.provider.available&&<p className="small muted">Rivet is unavailable. <button className="text-button" onClick={()=>onNavigate('workspace')}>Check connection</button></p>}
        {workspace.activeRunId&&<button className="text-button" onClick={()=>onRun(workspace.activeRunId!)}>View work in progress <ArrowRight size={14}/></button>}
        {!runs.length&&<p className="project-empty-work">Your reports and conversations will appear above as you create them.</p>}
      </div>}
    </>}
  </div>;
  return <div className="standard-page library-page"><div className="page-heading"><div><h1>Projects</h1><p>Keep each campaign’s data, conversations and reports together.</p></div><button className="button primary" onClick={()=>setDraft({id:crypto.randomUUID(),name:'',brief:'',sourceIds:[],version:0})}><Plus size={15}/>New project</button></div>
    <div className="library-toolbar"><input className="project-search" aria-label="Search projects" placeholder="Search projects…" value={query} onChange={event=>setQuery(event.target.value)}/><button className="icon-button" aria-label="Refresh projects" title="Refresh projects" disabled={loading} onClick={()=>setRevision(n=>n+1)}><RefreshCw size={15}/></button></div>
    {loading?<p role="status">Loading projects…</p>:<ProjectRows projects={projects.filter(p=>p.name.toLowerCase().includes(query.toLowerCase()))} onOpen={onOpen}/>}
    {!loading&&!error&&!projects.length&&<p className="empty-note">Create a project for a campaign or recurring piece of work. Add its data when you’re ready.</p>}{error&&<p role="alert">Projects could not be loaded. {error} <button className="text-button" disabled={loading} onClick={()=>setRevision(n=>n+1)}>Retry</button></p>}
  </div>;
}
