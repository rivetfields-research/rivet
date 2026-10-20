import { useEffect, useState, type ComponentProps } from 'react';
import { TablesLibrary } from './tables-library';
import { api, message } from './api';
import { customerOrganization } from './workspace-scope';
import type { WorkspaceStatus } from '../../../packages/core/src/types';
import { TeamMetrics } from './team-sharing';

type DataSpace = 'team' | 'private' | 'metrics';
const teamId = (id: string) => id.startsWith('team_') ? id : `team_${id}`;
function currentSpace(): DataSpace {
  const query = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const saved = query.get('data');
  if (saved === 'private' || saved === 'metrics') return saved;
  if (!saved && query.get('file') && !query.get('file')!.startsWith('team_')) return 'private';
  return 'team';
}
export function TeamSources(props: ComponentProps<typeof TablesLibrary>) {
  const [scope, setScope] = useState<DataSpace>(currentSpace);
  const [workspace, setWorkspace] = useState<WorkspaceStatus | null>(null);
  const [error, setError] = useState('');
  function choose(value: DataSpace) {
    const url = new URL(location.href);
    url.searchParams.set('data', value);
    for (const key of ['file','source','connection','connect']) url.searchParams.delete(key);
    history.replaceState(null, '', url);
    setScope(value);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
  async function refresh() {
    if (!customerOrganization()) return;
    try {
      setWorkspace(await api<WorkspaceStatus>('/team/api/workspace'));
      setError('');
      await props.onRefresh();
    } catch (cause) { setError(message(cause)); }
  }
  useEffect(() => {
    const read = () => setScope(currentSpace());
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);
  useEffect(() => {
    if (customerOrganization() && scope === 'team') {
      const url = new URL(location.href);
      url.searchParams.set('data','team');
      history.replaceState(null,'',url);
      void refresh();
    }
  }, [scope]);
  if (!customerOrganization()) return <TablesLibrary {...props}/>;
  const team = scope === 'team';
  return <>
    <div className="sharing-scope-tabs" aria-label="Data space">
      {(['team','private','metrics'] as const).map(value => <button key={value} className="text-button"
        aria-current={scope === value ? 'page' : undefined} onClick={() => choose(value)}>
        {value === 'team' ? 'Team sources' : value === 'private' ? 'My sources' : 'Metrics'}
      </button>)}
    </div>
    {error && <p role="alert" className="module-alert">{error}</p>}
    {scope === 'metrics' ? <TeamMetrics onSource={props.onSource} onUsePrompt={(prompt,ids) => { void props.onRefresh().then(() => props.onUsePrompt(prompt,ids)).catch(cause => setError(message(cause))); }}/> :
      <TablesLibrary key={scope} {...props}
        workspace={team ? workspace : props.workspace && {...props.workspace,sources:props.workspace.sources.filter(source => !source.id.startsWith('team_'))}}
        session={team && props.session?.mode === 'authenticated' ? {...props.session,privateWorkspace:false} : props.session}
        readOnly={props.readOnly || (team && props.session?.mode === 'authenticated' && props.session.role !== 'owner')}
        onRefresh={team ? refresh : props.onRefresh}
        onSource={id => props.onSource(team ? teamId(id) : id)}
        onAskSource={id => props.onAskSource(team ? teamId(id) : id)}
        onUsePrompt={(prompt,ids) => props.onUsePrompt(prompt,team ? ids?.map(teamId) : ids)}/>
    }
  </>;
}
