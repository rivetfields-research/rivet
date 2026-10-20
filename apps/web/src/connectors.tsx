import { useEffect, useState } from 'react';
import { ArrowRight, Cable, Layers3 } from 'lucide-react';
import type { WorkspaceStatus } from '../../../packages/core/src/types';
import { DriveConnectionPanel, useDriveConnection, type DriveConnection } from './drive-connection';
import { canManageSources, type WorkspaceSession } from './session-access';

/** Account access comes from server state, not a browser-saved connection plan. */
export function drivePresentation({ state, error }: Pick<DriveConnection, 'state' | 'error'>) {
  if (error) return { label: 'Needs attention', connected: false };
  if (!state) return { label: 'Checking...', connected: false };
  if (!state.configured || !state.pickerConfigured) return { label: 'Setup needed', connected: false };
  if (state.status === 'connected') return { label: 'Connected', connected: true };
  if (state.status === 'expired') return { label: 'Reconnect needed', connected: false };
  return { label: 'Not connected', connected: false };
}

export function DriveSettings({ connection, activeRun, returnedFromSignIn = false, showEmpty = false }: {
  connection: DriveConnection; activeRun: boolean; returnedFromSignIn?: boolean; showEmpty?: boolean;
}) {
  const { state, error, notice } = connection;
  // Keep broken or previously connected accounts visible, but omit unavailable integrations.
  if (state && !state.configured && !state.account && state.status === 'disconnected' && !error && !notice && !returnedFromSignIn) {
    return showEmpty ? <p className="empty-note">No data connections are configured for this workspace.</p> : null;
  }
  const view = drivePresentation(connection);
  return <div className="connection-row settings-drive">
    <span className="connection-icon"><Cable size={21} aria-hidden="true" /></span>
    <div>
      <h2>Google Drive</h2>
      <details className="settings-detail" open={returnedFromSignIn || undefined}>
        <summary>{view.label}{view.connected && state ? ` · ${state.files.length} selected documents` : ''}</summary>
        <DriveConnectionPanel connection={connection} activeRun={activeRun} />
      </details>
    </div>
  </div>;
}

function ManagedDriveSettings({ activeRun, refreshVersion, showEmpty }: { activeRun: boolean; refreshVersion: number; showEmpty: boolean }) {
  const [returnedFromSignIn] = useState(() => typeof location !== 'undefined' && new URLSearchParams(location.search).has('drive'));
  const connection = useDriveConnection();
  useEffect(() => { if (refreshVersion > 0) void connection.refresh(); }, [refreshVersion, connection.refresh]);
  return <DriveSettings connection={connection} activeRun={activeRun} returnedFromSignIn={returnedFromSignIn} showEmpty={showEmpty} />;
}

export function WorkspaceConnections({ workspace, session, refreshVersion, section = 'all' }: {
  workspace: WorkspaceStatus; session?: WorkspaceSession | null; refreshVersion: number; section?: 'all' | 'model' | 'data';
}) {
  const { provider } = workspace;
  return <section aria-label={section === 'model' ? 'Rivet service' : 'Connections'}>
    {section !== 'data' && <div className="connection-row">
      <span className="connection-icon"><Layers3 size={19} /></span>
      <div>
        <h2>Rivet service</h2>
        <p className="settings-model-status"><span className={`status-dot ${provider.available ? 'ready' : ''}`} />{provider.available ? 'Available' : provider.configured ? 'Needs attention' : 'Not configured'}</p>
        {!provider.available && <p role="status">Rivet is unavailable. Try again or contact your workspace owner.</p>}
      </div>
    </div>}
    {section !== 'model' && workspace.profile.id === 'workspace-analyst' && canManageSources(session) && <ManagedDriveSettings activeRun={Boolean(workspace.activeRunId)} refreshVersion={refreshVersion} showEmpty={section === 'data' && workspace.connectionsEnabled !== true} />}
    {section !== 'model' && workspace.profile.id === 'workspace-analyst' && workspace.connectionsEnabled === true && canManageSources(session) && <div className="connection-row">
      <span className="connection-icon"><Cable size={19}/></span><div><h2>Connected sources</h2>
        <a className="text-button" href="?view=tables">Manage sources <ArrowRight size={15}/></a>
      </div>
    </div>}
  </section>;
}
