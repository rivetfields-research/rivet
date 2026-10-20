import { createYouTubeAdapter } from '../../../packages/core/src/youtube-connector.ts';
import { createLinkedInAdapter } from '../../../packages/core/src/linkedin-connector.ts';
import { createMailchimpAdapter } from '../../../packages/core/src/mailchimp-connector.ts';
import { createAnalyticsAdapter } from '../../../packages/core/src/analytics-connector.ts';
import type { SyncAdapter } from '../../../packages/core/src/sync-dispatch.ts';
import { createWindsorAdapter } from '../../../packages/core/src/windsor-connector.ts';
import type { WindsorProvider } from '../../../packages/core/src/windsor-sources.ts';

/** App settings stay on the server; browser responses contain provider names only. */
export function sourceAdaptersFromEnv(env: NodeJS.ProcessEnv): SyncAdapter[] {
  const pilotSetting = env.HARNESS_WINDSOR_PILOT_WORKSPACES;
  const pilotWorkspaces = pilotSetting ? pilotSetting.split(',').map(id => id.trim()) : undefined;
  const windsorEnabled = ['LINKEDIN', 'FACEBOOK', 'INSTAGRAM', 'MAILCHIMP', 'GA4', 'YOUTUBE'].some(key => env[`HARNESS_CONNECTOR_WINDSOR_${key}`] === '1');
  if (windsorEnabled && pilotWorkspaces && (pilotWorkspaces.length > 10 || new Set(pilotWorkspaces).size !== pilotWorkspaces.length ||
      pilotWorkspaces.some(id => !/^person_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)))) {
    throw new Error('HARNESS_WINDSOR_PILOT_WORKSPACES must list up to ten exact private workspace IDs.');
  }
  const adapters = Object.entries({ YOUTUBE: createYouTubeAdapter, LINKEDIN: createLinkedInAdapter, MAILCHIMP: createMailchimpAdapter, GA4: createAnalyticsAdapter }).flatMap(([key, create]) => {
    const flag = `HARNESS_CONNECTOR_${key}`, enabled = env[flag];
    if (enabled !== undefined && enabled !== '' && enabled !== '0' && enabled !== '1') throw new Error(`${flag} must be 0 or 1.`);
    if (enabled !== '1') return [];
    for (const suffix of ['CLIENT_ID', 'CLIENT_SECRET']) {
      const name = `HARNESS_${key}_${suffix}`, value = env[name];
      if (!value || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) throw new Error(`Configure ${name} before enabling ${key}.`);
    }
    return [create({ clientId: env[`HARNESS_${key}_CLIENT_ID`]!, clientSecret: env[`HARNESS_${key}_CLIENT_SECRET`]! })];
  });
  for (const provider of ['linkedin', 'facebook', 'instagram', 'mailchimp', 'ga4', 'youtube'] satisfies WindsorProvider[]) {
    const key = provider.toUpperCase(), flag = `HARNESS_CONNECTOR_WINDSOR_${key}`, enabled = env[flag];
    if (enabled && enabled !== '0' && enabled !== '1') throw new Error(`${flag} must be 0 or 1.`);
    if (enabled !== '1') continue;
    if (env.HARNESS_WINDSOR_CUSTOMER_USE_APPROVED !== '1' && !pilotWorkspaces?.length) {
      throw new Error('Confirm Windsor customer-facing use, or configure exact private pilot workspaces before enabling the collector.');
    }
    if (['facebook', 'instagram'].includes(provider) && (env.HARNESS_CONNECTOR_FACEBOOK === '1' || env.HARNESS_CONNECTOR_INSTAGRAM === '1')) {
      throw new Error('Choose either direct Meta or Windsor for new Meta connections.');
    }
    if (env[`HARNESS_CONNECTOR_${key}`] === '1') throw new Error(`Choose either direct ${provider === 'linkedin' ? 'LinkedIn' : key} or Windsor for new connections.`);
    adapters.push({ ...createWindsorAdapter(provider, { apiKey: env.HARNESS_WINDSOR_API_KEY ?? '' }),
      ...(pilotWorkspaces ? { workspaceIds: pilotWorkspaces } : {}) });
  }
  return adapters;
}
