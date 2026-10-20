// Keep reading the retired flag so old installations start safely without re-enabling acquisition.
export function apifyEnabledFromEnv(env: NodeJS.ProcessEnv): boolean {
  const value = env.HARNESS_CONNECTOR_APIFY;
  if (value === undefined || value === '') return false;
  if (value !== '0' && value !== '1') throw new Error('HARNESS_CONNECTOR_APIFY must be 0 or 1.');
  if (value === '1') console.warn('HARNESS_CONNECTOR_APIFY is retired and ignored. Use direct account connections; existing data is preserved.');
  return false;
}
