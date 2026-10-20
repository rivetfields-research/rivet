import { useId } from 'react';
import { signInReturn } from './connections';

export type SettingsSection = 'account' | 'usage' | 'connections' | 'team' | 'billing';
export function settingsSection(search: string, connections: boolean, billing = false): SettingsSection {
  const params = new URLSearchParams(search);
  if (connections && (params.has('drive') || signInReturn(search))) return 'connections';
  const section = params.get('settings');
  return section === 'team' || section === 'usage' || (section === 'connections' && connections) || (section === 'billing' && billing) ? section : 'account';
}

export function SettingsTabs({ section, connections, team = false, billing = false, onChange }: {
  section: SettingsSection; connections: boolean; team?: boolean; billing?: boolean; onChange: (section: SettingsSection) => void;
}) {
  const id = useId();
  const tabs: {id: SettingsSection; label: string}[] = [
    {id:'account',label:'Account'}, {id:'usage',label:'Usage'},
    ...(team ? [{id:'team' as const,label:'Team'}] : []),
    ...(connections ? [{id:'connections' as const,label:'Connections'}] : []),
    ...(billing ? [{id:'billing' as const,label:'Billing'}] : []),
  ];
  return <div className="settings-tabs" role="tablist" aria-label="Settings sections">
    {tabs.map((tab, index) => <button key={tab.id} id={`${id}-${tab.id}`} type="button" role="tab"
      aria-selected={section === tab.id} aria-controls={`settings-${tab.id}`} tabIndex={section === tab.id ? 0 : -1}
      onClick={() => onChange(tab.id)} onKeyDown={event => {
        const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
          : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
        if (next === null) return;
        event.preventDefault();
        onChange(tabs[next]!.id);
        document.getElementById(`${id}-${tabs[next]!.id}`)?.focus();
      }}>{tab.label}</button>)}
  </div>;
}
