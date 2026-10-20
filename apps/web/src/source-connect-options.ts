import type { ConnectionProviderOption } from './connection-model';

export interface SourceConnectOption {
  id: string; label: string; description: string; provider: ConnectionProviderOption;
  choices?: SourceConnectOption[];
  deferred?: boolean;
}
export const SOURCE_PROVIDERS = [
  { id: 'instagram', label: 'Instagram', description: 'Posts, reels and engagement' },
  { id: 'facebook', label: 'Facebook Pages', description: 'Page posts and engagement' },
  { id: 'linkedin', label: 'LinkedIn', description: 'Company posts and engagement' },
  { id: 'youtube', label: 'YouTube', description: 'Videos, views and engagement' },
  { id: 'mailchimp', label: 'Mailchimp', description: 'Email campaign performance' },
  { id: 'google-analytics', label: 'Google Analytics', description: 'Website traffic by day and channel' },
  { id: 'x', label: 'X', description: 'Posts and engagement' },
] as const;
const DEFERRED_PROVIDERS = new Set(['linkedin', 'x']);

/** Platforms are customer-facing; the server still chooses their connection backend. */
export function sourceConnectOptions(providers: ConnectionProviderOption[]): SourceConnectOption[] {
  const options: SourceConnectOption[] = [];
  for (const provider of providers) {
    const id = provider.sourceProvider ?? provider.id;
    const existing = options.find(option => option.id === id);
    if (existing) {
      if (provider.enabled && (!existing.provider.enabled || (existing.provider.signIn === 'broker' && provider.signIn === 'oauth'))) existing.provider = provider;
      continue;
    }
    options.push({ id, provider, label: provider.label,
      description: provider.credential === 'api_token' ? 'Saved datasets and completed task results'
          : provider.id.startsWith('fake') ? 'Fictional data for local testing' : 'Account data and performance',
    });
  }
  return [
    ...SOURCE_PROVIDERS.map(item => {
      const option = options.find(option => option.id === item.id);
      const provider = option?.provider ?? { id: item.id, label: item.label, enabled: false };
      const deferred = DEFERRED_PROVIDERS.has(item.id);
      return { ...option, ...item, deferred, provider: deferred ? { ...provider, enabled: false } : provider };
    }),
    ...options.filter(option => !SOURCE_PROVIDERS.some(item => item.id === option.id)),
  ];
}

/** Keep existing Meta bookmarks working without adding a duplicate platform to the list. */
export function metaConnectOption(providers: ConnectionProviderOption[]): SourceConnectOption {
  const choices = sourceConnectOptions(providers).filter(option => ['instagram', 'facebook'].includes(option.id));
  const direct = providers.find(provider => provider.signInProvider === 'meta' && provider.enabled);
  return { id: 'meta', label: 'Meta', description: 'Facebook Pages and Instagram',
    provider: direct ? { ...direct, id: 'meta' } : choices.find(option => option.provider.enabled)?.provider ?? { id: 'meta', label: 'Meta', enabled: false },
    ...(!direct ? { choices } : {}) };
}

export function sourceConnectStep(search: string): string | null {
  const params = new URLSearchParams(search);
  const step = params.get('connect');
  return params.get('view') === 'tables' && step && /^[a-z][a-z0-9-]{0,39}$/.test(step) ? step : null;
}

export function rememberConnectStep(step: string | null, push = true) {
  const url = new URL(location.href);
  url.searchParams.delete('file');
  url.searchParams.delete('sourceConnection');
  if (step) url.searchParams.set('connect', step);
  else url.searchParams.delete('connect');
  if (push) history.pushState(history.state, '', url);
  else history.replaceState(history.state, '', url);
}
