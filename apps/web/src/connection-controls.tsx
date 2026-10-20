import { useState, type FormEvent } from 'react';
import type { ConnectionListEntry, SyncFrequency, SyncScheduleInput } from '../../../packages/core/src/sync-jobs';
import type { WorkflowSchedule } from '../../../packages/core/src/workflow-schedules';
import { localTime, DAYS, TRIGGER_LABELS, ATTEMPT_LABELS, type ConnectionAttempt } from './connection-model';
import { scheduleEditorValues } from './connection-schedule';

const Time = ({ value }: { value: string }) => <time dateTime={value}>{localTime(value)}</time>;

export function SyncScheduleForm({ connection, busy, onSave, onCancel }: {
  connection: ConnectionListEntry; busy: boolean; onSave: (input: SyncScheduleInput) => void; onCancel: () => void;
}) {
  const job = connection.job;
  const [frequency, setFrequency] = useState<SyncFrequency>(job?.frequency ?? 'manual');
  const [initial] = useState(() => scheduleEditorValues(job));
  const [time, setTime] = useState(initial.time);
  const [timezone, setTimezone] = useState(initial.timezone);
  const [weekday, setWeekday] = useState(initial.weekday);
  const [enabled, setEnabled] = useState(job?.enabled ?? true);
  const zones = [...new Set([initial.timezone, 'UTC', ...Intl.supportedValuesOf('timeZone')])].sort();
  const id = connection.id;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    onSave({ frequency, timeUtc: job?.timeUtc ?? '06:00', ...(frequency !== 'manual' ? { localTime: time, timezone } : {}), ...(frequency === 'weekly' ? { weekday } : {}), enabled: frequency === 'manual' || enabled });
  }
  return <form className="data-connection-schedule" aria-label={`Sync schedule for ${connection.displayName}`} onSubmit={submit}>
    <div className="module-field"><label htmlFor={`${id}-frequency`}>Sync</label><select id={`${id}-frequency`} value={frequency} disabled={busy} onChange={event => setFrequency(event.target.value as SyncFrequency)}>
      <option value="manual">Only when I choose Sync now</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select></div>
    {frequency === 'weekly' && <div className="module-field"><label htmlFor={`${id}-weekday`}>Day</label><select id={`${id}-weekday`} value={weekday} disabled={busy} onChange={event => setWeekday(Number(event.target.value))}>{DAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></div>}
    {frequency !== 'manual' && <>
      <div className="module-field"><label htmlFor={`${id}-time`}>Time</label><input id={`${id}-time`} type="time" required value={time} disabled={busy} onChange={event => setTime(event.target.value)} /></div>
      <div className="module-field"><label htmlFor={`${id}-timezone`}>Timezone</label><select id={`${id}-timezone`} value={timezone} disabled={busy} onChange={event => setTimezone(event.target.value)}>{zones.map(zone => <option key={zone} value={zone}>{zone.replaceAll('_', ' ')}</option>)}</select></div>
      <label className="module-check-field"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => setEnabled(event.target.checked)}/><span>Automatic updates</span></label>
    </>}
    <p className="module-tiny">Sync timing is separate from report schedules. A report can also refresh its connected data just before it runs.</p>
    <div className="data-connection-actions"><button type="submit" className="button secondary compact" disabled={busy}>{busy ? 'Saving…' : 'Save sync schedule'}</button><button type="button" className="text-button" disabled={busy} onClick={onCancel}>Cancel</button></div>
  </form>;
}

/** Disconnect only: delete is separate retention work (W2) and is not offered here. */
export function DisconnectConfirm({ connection, schedules, busy, onConfirm, onCancel }: {
  /** null while checking; 'failed' when the schedules could not be read. */
  connection: ConnectionListEntry; schedules: Pick<WorkflowSchedule, 'id' | 'name'>[] | null | 'failed'; busy: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  return <div className="data-connection-disconnect" role="group" aria-label={`Disconnect ${connection.displayName}`}>
    <p><strong>Disconnect {connection.displayName}?</strong> Syncs stop. Data already synced, and reports made from it, are kept. Deleting synced data is not available here.</p>
    {['youtube', 'google-analytics'].includes(connection.provider) && <p className="module-tiny">This stops Rivet's syncs but does not revoke access at Google. To revoke it, remove Rivet Sources in <a href="https://myaccount.google.com/connections" target="_blank" rel="noopener noreferrer">Google account connections</a>. That can also disconnect your other YouTube or Google Analytics connections to Rivet. Request deletion of Rivet's stored copies at <a href="mailto:info@rivetfields.com">info@rivetfields.com</a>; this does not delete content from Google.</p>}
    <p>{schedules === null ? 'Checking which schedules use it…' : schedules === 'failed' ? 'Could not check which schedules use it.' : schedules.length
      ? <>Scheduled reports that use it keep using its last synced data: {schedules.map(item => item.name).join(', ')}.</>
      : 'No schedule uses it.'}</p>
    <div className="data-connection-actions"><button type="button" className="button secondary compact" disabled={busy} onClick={onConfirm}>{busy ? 'Disconnecting…' : 'Disconnect'}</button><button type="button" className="text-button" disabled={busy} onClick={onCancel}>Keep connected</button></div>
  </div>;
}

export function AttemptHistory({ attempts, error }: { attempts: ConnectionAttempt[] | null; error: string }) {
  if (error) return <p className="data-connection-hint" role="alert">{error}</p>;
  if (!attempts) return <p className="data-connection-hint" role="status">Loading sync history…</p>;
  if (!attempts.length) return <p className="data-connection-hint">No syncs yet.</p>;
  return <ol className="data-connection-history">{attempts.map(item => <li key={item.id}>
    <span><Time value={item.finishedAt ?? item.startedAt ?? item.createdAt} /> · {TRIGGER_LABELS[item.trigger]}</span>
    <span className={item.status === 'completed' || item.status === 'unchanged' ? 'pill completed' : item.status === 'failed' || item.status === 'interrupted' ? 'pill failed' : 'pill'}>{item.status === 'unchanged' && item.records === 0 && (item.message === 'No records were found in the sync window.' || item.message === 'No posts were found in the sync window.') ? 'No records' : ATTEMPT_LABELS[item.status]}</span>
    {typeof item.records === 'number' && item.status !== 'failed' && <small>{item.records.toLocaleString()} {item.records === 1 ? 'row' : 'rows'} read</small>}
    {/* A failure's plain message, or a fixed note on a sync that finished (M9: records skipped by a newer task run). */}
    {item.message && (item.status === 'failed' || item.status === 'completed' || item.status === 'unchanged') && <small>{item.message === 'No posts were found in the sync window.' ? 'No records were found in the sync window.' : item.message}</small>}
    {item.errorCode && <details><summary>Details</summary><code>{item.errorCode}</code></details>}
  </li>)}</ol>;
}
