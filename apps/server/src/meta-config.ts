import type { MetaProviderConfig } from '../../../packages/core/src/index.ts';

/*
 * Meta connector settings (M8), read once at startup by both entry points. Off unless a product flag is `1`
 * (default `0` everywhere, section 6). When a product is on, the Meta app's ID, secret and Facebook Login for Business
 * configuration ID are required; an invalid or missing value stops startup with a message that names the setting and
 * never repeats its value. The secret is passed only to the runtime's OAuth client; nothing here logs.
 *
 *   HARNESS_CONNECTOR_INSTAGRAM   0 | 1   Instagram professional accounts
 *   HARNESS_CONNECTOR_FACEBOOK    0 | 1   Facebook Pages
 *   HARNESS_META_APP_ID                   the Business-type Meta app's ID (digits)
 *   HARNESS_META_APP_SECRET               its app secret
 *   HARNESS_META_CONFIG_ID                the Facebook Login for Business configuration (read permissions only)
 *
 * No setting chooses Meta's hosts or API version: the runtime pins graph.facebook.com and v26.0.
 */
export function metaProviderFromEnv(env: NodeJS.ProcessEnv): MetaProviderConfig | undefined {
  const blank = (value: string | undefined) => value === undefined || value === '';
  const flag = (name: 'HARNESS_CONNECTOR_INSTAGRAM' | 'HARNESS_CONNECTOR_FACEBOOK') => {
    const value = env[name];
    if (blank(value)) return false;
    if (value !== '0' && value !== '1') throw new Error(`${name} must be 0 or 1.`);
    return value === '1';
  };
  const instagram = flag('HARNESS_CONNECTOR_INSTAGRAM');
  const facebook = flag('HARNESS_CONNECTOR_FACEBOOK');
  if (!instagram && !facebook) return undefined;
  const required = (name: string, pattern: RegExp, description: string) => {
    const value = env[name];
    if (blank(value) || !pattern.test(value!)) throw new Error(`${name} must be set to ${description} when a Meta connector is enabled.`);
    return value!;
  };
  return {
    appId: required('HARNESS_META_APP_ID', /^[0-9]{5,30}$/, "the Meta app's numeric ID"),
    appSecret: required('HARNESS_META_APP_SECRET', /^[A-Za-z0-9]{16,128}$/, "the Meta app's secret"),
    configId: required('HARNESS_META_CONFIG_ID', /^[0-9]{5,30}$/, 'the numeric Facebook Login for Business configuration ID'),
    instagram, facebook,
  };
}
