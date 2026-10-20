type PickerResult = { action?: unknown; docs?: unknown } | null;
type Picker = { setVisible(value: boolean): void; dispose(): void };
interface PickerNamespace {
  ViewId: { DOCS: string };
  Feature: { MULTISELECT_ENABLED: string };
  Action: { PICKED: string; CANCEL: string };
  DocsView: new (id: string) => { setMimeTypes(value: string): unknown; setIncludeFolders(value: boolean): unknown };
  PickerBuilder: new () => {
    setDeveloperKey(value: string): unknown; setAppId(value: string): unknown;
    setOAuthToken(value: string): unknown; setOrigin(value: string): unknown;
    addView(view: unknown): unknown; enableFeature(feature: string): unknown;
    setMaxItems(value: number): unknown; setCallback(callback: (value: PickerResult) => void): unknown;
    build(): Picker;
  };
}
declare global {
  interface Window {
    gapi?: { load(name: string, callbacks: { callback: () => void; onerror: () => void; timeout: number; ontimeout: () => void }): void };
    google?: { picker?: PickerNamespace };
  }
}
let loading: Promise<PickerNamespace> | undefined;
function loadPicker(): Promise<PickerNamespace> {
  if (window.google?.picker) return Promise.resolve(window.google.picker);
  if (loading) return loading;
  loading = new Promise<PickerNamespace>((resolve, reject) => {
    const fail = () => reject(new Error('Google’s file picker could not load. Check your connection and try again.'));
    const timer = setTimeout(fail, 15_000);
    const ready = () => window.gapi?.load('picker', { callback: () => { clearTimeout(timer); window.google?.picker ? resolve(window.google.picker) : fail(); }, onerror: () => { clearTimeout(timer); fail(); }, timeout: 10_000, ontimeout: () => { clearTimeout(timer); fail(); } });
    if (window.gapi) { ready(); return; }
    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js'; script.async = true;
    script.onload = ready;
    script.onerror = () => { clearTimeout(timer); script.remove(); fail(); };
    document.head.append(script);
  }).catch(error => { loading = undefined; throw error; });
  return loading;
}

/** The Picker access token stays in memory; no browser storage or model context. */
export async function chooseGoogleDocs(session: { accessToken: string; apiKey: string; appId: string }, signal: AbortSignal): Promise<string[] | null> {
  const api = await loadPicker();
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const view = new api.DocsView(api.ViewId.DOCS);
    view.setMimeTypes('application/vnd.google-apps.document'); view.setIncludeFolders(false);
    const builder = new api.PickerBuilder();
    builder.setDeveloperKey(session.apiKey); builder.setAppId(session.appId); builder.setOAuthToken(session.accessToken); builder.setOrigin(location.origin);
    builder.addView(view); builder.enableFeature(api.Feature.MULTISELECT_ENABLED); builder.setMaxItems(20);
    let picker: Picker | undefined;
    let settled = false;
    const finish = (ids: string[] | null, error?: unknown) => {
      if (settled) return; settled = true;
      signal.removeEventListener('abort', abort);
      try { picker?.setVisible(false); } catch { /* Always settle even if the SDK has already removed its frame. */ }
      try { picker?.dispose(); } catch { /* Token references are released with this completed picker session. */ }
      error ? reject(error) : resolve(ids);
    };
    const abort = () => finish(null, signal.reason ?? new Error('File selection cancelled.'));
    builder.setCallback(value => {
      if (value?.action === api.Action.CANCEL) return finish(null);
      if (value?.action !== api.Action.PICKED) return;
      const ids = Array.isArray(value.docs) ? value.docs.map(doc => doc && typeof doc === 'object' ? doc.id : undefined) : undefined;
      if (!ids?.length || ids.length > 20 || ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id))) return finish(null, new Error('Choose up to 20 supported Google Docs.'));
      finish([...new Set(ids as string[])]);
    });
    try { picker = builder.build(); signal.addEventListener('abort', abort, { once: true }); picker.setVisible(true); }
    catch { finish(null, new Error('Google’s file picker could not open. Check its API key and authorized origin.')); }
  });
}
