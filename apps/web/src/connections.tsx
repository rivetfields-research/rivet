import type { WorkspaceSession } from './session-access';
import { canManageSources } from './session-access';
import { useConnections } from './use-connections';
import { DataConnectionsView } from './connection-view';
export * from './connection-model';
export * from './connection-row';
export * from './connection-forms';
export * from './connection-controls';
export { DataConnectionsView } from './connection-view';

export function DataConnections({ session, workspaceName, refreshVersion, onOpenSource }: {
  session: WorkspaceSession | null | undefined; workspaceName: string; refreshVersion: number; onOpenSource?: (id: string) => void;
}) {
  const controller = useConnections(session, refreshVersion);
  if (!canManageSources(session)) return null;
  if (!controller.data) return <div className="data-connections-loading">{controller.loadError
    ? <p role="alert">{controller.loadError} <button className="text-button" onClick={() => void controller.refresh()}>Retry connections</button></p>
    : <p role="status">Loading connections...</p>}</div>;
  return <DataConnectionsView session={session} workspaceName={workspaceName} onOpenSource={onOpenSource} {...controller}/>;
}
