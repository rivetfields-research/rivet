import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Share2, Users } from 'lucide-react';
import type { ShareAudience, TeamRecord } from '../../../packages/core/src/sharing-types';
import type { TabularAnalysis } from '../../../packages/core/src/tabular-datasets';
import { ApiError, api, message } from './api';
import { customerOrganization } from './workspace-scope';
import { TabularAnalysisView } from './tabular-analysis';
export type SharingIndex = {members:{id:string;name:string}[];records:TeamRecord[]};

export function ShareButton({kind,id,name,data,privateSource=false,privateConnection=false}:{kind:TeamRecord['kind'];id:string;name:string;data:Record<string,unknown>;privateSource?:boolean;privateConnection?:boolean}) {
  const dialog = useRef<HTMLDialogElement>(null), opener = useRef<HTMLButtonElement>(null);
  const [index,setIndex] = useState<SharingIndex|null>(null), [audience,setAudience] = useState<ShareAudience>({kind:'team'});
  const [metricName,setMetricName] = useState(name);
  const [record,setRecord] = useState<TeamRecord>(), [error,setError] = useState(''), [busy,setBusy] = useState(false);
  const pending = useRef<{payload:Record<string,unknown>} | null>(null);
  const shared = record && (record.audience.kind === 'team' || record.audience.memberIds.length > 0);
  if (!customerOrganization()) return null;
  async function open() {
    dialog.current?.showModal(); setError('');
    try { const result = await api<SharingIndex>('/api/sharing'); setIndex(result); const saved = result.records.find(item => privateConnection ? item.data.privateConnection?.connectionId === id : item.id === id); setRecord(saved); setMetricName(saved?.name ?? name); setAudience(saved?.audience ?? {kind:'team'}); }
    catch(cause) { setError(message(cause)); }
  }
  function close() { if (busy) return; dialog.current?.close(); opener.current?.focus(); }
  async function save(remove = false) {
    if (!pending.current) pending.current = {payload:{...data,name:kind === 'metric' ? metricName : name,audience,version:record?.version ?? 0,requestId:crypto.randomUUID(),remove}};
    setBusy(true); setError('');
    try { const result = await api<TeamRecord>(`/api/sharing/${privateConnection ? 'connection' : privateSource ? 'private-source' : kind}/${encodeURIComponent(id)}`,{method:'POST',body:JSON.stringify(pending.current.payload)}); setRecord(result); pending.current=null; dialog.current?.close(); opener.current?.focus(); }
    catch(cause) {
      if(cause instanceof ApiError && cause.status < 500 && ![408,429].includes(cause.status)) {
        pending.current=null;
        if(cause.status === 409) setIndex(null);
      }
      setError(message(cause));
    } finally {setBusy(false);}
  }
  return <><button ref={opener} className="button secondary" onClick={() => void open()}><Share2 size={15}/>{kind === 'report' ? 'Publish' : kind === 'metric' ? 'Save metric' : (privateSource || privateConnection) ? shared ? 'Sharing' : 'Share with team' : 'Access'}</button>
    <dialog ref={dialog} className="team-share-dialog" onCancel={event => {if(busy || pending.current)event.preventDefault();}}>
      <h2>{kind === 'report' ? 'Publish report' : kind === 'metric' ? 'Save metric' : (privateSource || privateConnection) ? 'Share with team' : 'Source access'}</h2>
      {privateConnection && <p className="empty-note">Share current data and future updates. You keep control of syncing and account access.</p>}
      {privateSource && <p className="empty-note">Share a snapshot. Your original stays private; later changes aren’t shared.</p>}
      {kind === 'report' && <p className="empty-note">Recipients can view this saved result, including its tables and exports. Source access stays separate.</p>}
      {record && <p className="empty-note">Published version {record.version} · {new Date(record.updatedAt).toLocaleDateString()}</p>}
      {kind === 'metric' && <label>Name<input value={metricName} disabled={busy || Boolean(pending.current)} maxLength={160} onChange={event => setMetricName(event.target.value)}/></label>}
      <label>Who can view<select disabled={busy || Boolean(pending.current)} value={audience.kind} onChange={event => setAudience(event.target.value === 'team' ? {kind:'team'} : {kind:'members',memberIds:[]})}><option value="team">Everyone in the organization</option><option value="members">Selected people</option></select></label>
      {audience.kind === 'members' && <fieldset><legend>People</legend>{index?.members.map(member => <label key={member.id} className="team-share-person"><input type="checkbox" disabled={busy || Boolean(pending.current)} checked={audience.memberIds.includes(member.id)} onChange={event => setAudience({kind:'members',memberIds:event.target.checked ? [...audience.memberIds,member.id] : audience.memberIds.filter(id => id !== member.id)})}/>{member.name}</label>)}</fieldset>}
      {error && <p role="alert" className="module-alert">{error}</p>}
      <div className="team-share-actions">{!index && error && <button className="text-button" disabled={busy} onClick={() => void open()}>Refresh access</button>}<button className="button secondary" disabled={busy || Boolean(pending.current)} onClick={close}>Cancel</button>{(kind === 'report' || privateSource || privateConnection || record?.data.privateSnapshot) && shared && <button className="text-button" disabled={busy || Boolean(pending.current)} onClick={() => void save(true)}>Stop sharing</button>}<button className="button primary" disabled={busy || !index} onClick={() => void save()}>{busy ? 'Saving…' : pending.current ? 'Retry save' : kind === 'report' ? record ? 'Publish update' : 'Publish' : (privateSource || privateConnection) ? 'Share' : 'Save'}</button></div>
    </dialog></>;
}
export function SharedReports({onSource}:{onSource:(id:string)=>void}) {
  const [index,setIndex] = useState<SharingIndex>(), [selected,setSelected] = useState<TeamRecord>(), [error,setError] = useState('');
  useEffect(() => {void api<SharingIndex>('/api/sharing').then(setIndex).catch(cause => setError(message(cause)));},[]);
  async function open(record:TeamRecord) {try {setSelected(await api<TeamRecord>(`/api/sharing/report/${record.id}`));}catch(cause){setError(message(cause));}}
  if(selected) return <section className="standard-page"><button className="text-button" onClick={() => setSelected(undefined)}><ArrowLeft size={14}/>Shared reports</button><header className="page-heading"><div><h1>{selected.name}</h1><p>Published {new Date(selected.updatedAt).toLocaleString()} · Version {selected.version}</p></div></header>{selected.data.analysis && <TabularAnalysisView sharedSnapshot analysis={selected.data.analysis} runId={selected.id} csvHref={`/api/sharing/report/${selected.id}.csv`} onSource={onSource}/>}</section>;
  return <section className="module-page"><div className="module-page-heading"><h1>Shared reports</h1></div>{error && <p role="alert">{error}</p>}{!index ? <p role="status">Loading reports…</p> : !index.records.some(item => item.kind === 'report') ? <div className="module-empty"><Users size={25}/><h2>No shared reports yet</h2></div> : <table className="module-library"><thead><tr><th>Report</th><th>Published</th></tr></thead><tbody>{index.records.filter(item => item.kind === 'report').map(record => <tr key={record.id}><td><button className="module-row-title" onClick={() => void open(record)}>{record.name}</button></td><td>{new Date(record.updatedAt).toLocaleDateString()}</td></tr>)}</tbody></table>}</section>;
}
export function TeamMetrics({onSource,onUsePrompt}:{onSource:(id:string)=>void;onUsePrompt:(prompt:string,sourceIds?:string[])=>void}) {
  const [index,setIndex] = useState<SharingIndex>(),[selected,setSelected] = useState<{record:TeamRecord;analysis:TabularAnalysis;datasetSourceId:string}>(),[error,setError] = useState('');
  useEffect(() => {void api<SharingIndex>('/api/sharing').then(setIndex).catch(cause => setError(message(cause)));},[]);
  async function calculate(record:TeamRecord) {try {const result = await api<TeamRecord & {analysis:TabularAnalysis;datasetSourceId:string}>(`/api/sharing/metric/${record.id}`);setSelected({record:result,analysis:result.analysis,datasetSourceId:result.datasetSourceId});}catch(cause){setError(message(cause));}}
  return <section className="module-page"><div className="module-page-heading"><h1>Metrics</h1></div>{error && <p role="alert">{error}</p>}{selected ? <><button className="text-button" onClick={() => setSelected(undefined)}><ArrowLeft size={14}/>All metrics</button><h2>{selected.record.name}</h2><button className="button secondary" onClick={() => onUsePrompt(`Use the shared metric ${selected.record.name} to prepare a report. Read its saved definition and use its exact calculation request.`,[`team_metric_def_${selected.record.id}_v${selected.record.version}`,selected.datasetSourceId])}>Use metric</button><TabularAnalysisView analysis={selected.analysis} runId={selected.record.id} csvHref={`/api/sharing/metric/${selected.record.id}.csv`} onSource={onSource}/></> : index?.records.filter(item => item.kind === 'metric').map(item => <button className="module-row-title" key={item.id} onClick={() => void calculate(item)}>{item.name}</button>)}{index && !index.records.some(item => item.kind === 'metric') && <p className="empty-note">No shared metrics yet.</p>}</section>;
}
