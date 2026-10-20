import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { renderToStaticMarkup } from 'react-dom/server';
import { sourceConnectOptions, sourceConnectStep, metaConnectOption } from './source-connect-options';
import type { ConnectionProviderOption } from './connection-model';
import type { ConnectionsController } from './use-connections';

const css = registerHooks({ load(url, context, next) { return url.endsWith('.css') ? {format:'module',source:'',shortCircuit:true} : next(url,context); } });
const { SourceConnectPage } = await import('./source-connect-page');
const { SourceConnectionDetail } = await import('./source-connection-detail');
css.deregister();

const providers: ConnectionProviderOption[] = [
  {id:'facebook',label:'Facebook Page',enabled:false,signIn:'oauth',signInProvider:'meta'},
  {id:'instagram',label:'Instagram professional account',enabled:true,signIn:'oauth',signInProvider:'meta'},
  {id:'fake',label:'Synthetic test feed',enabled:false},
];
const controller: ConnectionsController = {
  data:{runtimeEnabled:true,providers,connections:[]}, loadError:'', actionError:'', notice:'', busy:null,
  choice:null, focusConnection:null, keepNoticeOnNextScope:()=>{}, refresh:async()=>undefined, onAdd:async()=>null, onSync:()=>{},
  broker:{pending:null,choice:null,error:'',busy:false,signInState:'waiting',openSignIn:()=>{},check:async()=>{},begin:async()=>{},confirm:async()=>false,cancel:async()=>true},
  onSchedule:async()=>false, onDisconnect:async()=>false, loadAttempts:async()=>[], loadSchedules:async()=>[],
};
const props = {controller,session:{mode:'local'} as const,onStep:()=>{},onBack:()=>{},upload:<button>Upload file</button>};

test('the source catalog keeps file upload reachable with healthy, loading or failed connectors', () => {
  for (const state of [controller, {...controller,data:null}, {...controller,data:null,loadError:'Connections unavailable'}]) {
    const html = renderToStaticMarkup(<SourceConnectPage {...props} step="data" controller={state}/>);
    assert.match(html, />Upload file<\/button>/);
  }
  const choosing = renderToStaticMarkup(<SourceConnectPage {...props} step="data" controller={{...controller,
    choice:{id:'test',provider:'youtube',expiresAt:'2026-10-07T12:00:00Z',accounts:[]}}}/>);
  assert.doesNotMatch(choosing, /Upload file/);
});

test('desktop uses the shared catalog without offering disabled authorization or claiming server setup fixes it', () => {
  const desktop = {...controller, data:{runtimeEnabled:false, unavailableReason:'desktop' as const, providers:[], connections:[]}};
  const html = renderToStaticMarkup(<SourceConnectPage {...props} step="data" controller={desktop}/>);
  for (const name of ['Instagram', 'Facebook Pages', 'LinkedIn', 'YouTube', 'Mailchimp', 'Google Analytics', 'X']) {
    assert.ok(html.includes(`aria-label="${name}"`));
  }
  assert.equal((html.match(/Not in desktop alpha/g) ?? []).length, 5);
  assert.equal((html.match(/Not available yet/g) ?? []).length, 2);
  assert.match(html, /CSV and document imports stay on this computer/);
  assert.match(html, /Upload file/);
  assert.doesNotMatch(html, /type="submit"|Continue with|type="password"/);
  for (const step of ['instagram', 'youtube', 'google-analytics', 'mailchimp', 'facebook']) {
    const detail = renderToStaticMarkup(<SourceConnectPage {...props} step={step} controller={desktop}/>);
    assert.match(detail, /connections are not available in this desktop alpha/);
    assert.match(detail, /import a CSV or document from Connect data instead/);
    assert.match(detail, />Back<\/button>/);
    assert.doesNotMatch(detail, /type="submit"|server setup|Connection details|Google data use/);
  }
});

test('a disabled desktop runtime cannot be made connectable by a stale enabled provider catalog', () => {
  const data = {runtimeEnabled:false, unavailableReason:'desktop' as const,
    providers:[{id:'youtube',label:'YouTube',enabled:true,signIn:'oauth' as const}], connections:[]};
  const html = renderToStaticMarkup(<SourceConnectPage {...props} step="youtube" controller={{...controller,data}}/>);
  assert.match(html, /not available in this desktop alpha/);
  assert.doesNotMatch(html, /type="submit"|Continue with Google/);
});

test('LinkedIn stays deferred even when a broker is configured', () => {
  const provider: ConnectionProviderOption = { id:'windsor-linkedin',sourceProvider:'linkedin',label:'LinkedIn',enabled:true,signIn:'broker',credential:'api_token',automaticDailySync:true };
  const options = sourceConnectOptions([provider]);
  assert.equal(options.filter(option => option.label === 'LinkedIn').length, 1);
  assert.equal(options.find(option => option.id === 'linkedin')?.provider.id, 'windsor-linkedin');
  const html = renderToStaticMarkup(<SourceConnectPage {...props} step="linkedin" controller={{...controller,data:{runtimeEnabled:true,providers:[provider],connections:[]}}}/>);
  assert.equal(options.find(option => option.id === 'linkedin')?.provider.enabled, false);
  assert.equal(provider.enabled, true, 'the server catalog and existing connections are not changed');
  assert.match(html, /Not available yet\./);
  assert.doesNotMatch(html, /type="submit"|Continue with LinkedIn|server setup/);
  assert.doesNotMatch(html, /Windsor/);
  assert.doesNotMatch(html, /Apify|type="password"|source-connect-name/);
});

test('Instagram and Facebook are separate platforms with server-reported availability', () => {
  const options = sourceConnectOptions(providers);
  assert.equal(options.length,8);
  assert.equal(options[0]?.label,'Instagram');
  assert.equal(options[0]?.provider.id,'instagram');
  assert.equal(options[1]?.provider.enabled,false);
  assert.ok(sourceConnectOptions([]).every(option => !option.provider.enabled));
  assert.equal(providers[0]?.enabled,false,'server catalog is not mutated');
  const html = renderToStaticMarkup(<SourceConnectPage {...props} step="data"/>);
  assert.match(html,/<h1[^>]*>Connect data<\/h1>/);
  assert.match(html,/aria-label="Synthetic test feed"/);
  assert.doesNotMatch(html,/<dialog|<form|type="radio"/);
  for (const name of ['LinkedIn', 'YouTube', 'Mailchimp', 'Google Analytics', 'X']) assert.match(html, new RegExp(`aria-label="${name}"`));
  assert.doesNotMatch(html, /source-provider-row[^>]*disabled/);
  assert.match(html,/Not available yet/);
});

test('LinkedIn and X have no new sign-in action while the remaining direct providers stay available', () => {
  const direct: ConnectionProviderOption[] = ['facebook', 'instagram', 'youtube', 'mailchimp', 'google-analytics', 'linkedin', 'x'].map(id => ({
    id, label:id, enabled:true, signIn:'oauth', signInProvider:['facebook', 'instagram'].includes(id) ? 'meta' : id,
  }));
  for (const option of sourceConnectOptions(direct)) {
    const html = renderToStaticMarkup(<SourceConnectPage {...props} step={option.id} controller={{...controller,data:{runtimeEnabled:true,providers:direct,connections:[]}}}/>);
    if (['linkedin', 'x'].includes(option.id)) {
      assert.match(html, /Not available yet\./);
      assert.doesNotMatch(html, /type="submit"|Connection details/);
    } else {
      assert.equal(option.provider.enabled, true);
      assert.equal((html.match(/type="submit"/g) ?? []).length, 1);
      assert.doesNotMatch(html, /Not available yet|Windsor|source-connect-name/);
      assert.match(html, option.id === 'mailchimp' ? /Continue with Mailchimp/ : ['youtube', 'google-analytics'].includes(option.id) ? /Continue with Google/ : /Continue with Facebook/);
    }
  }
});

test('unconfigured providers explain setup without offering a dead sign-in action', () => {
  const html = renderToStaticMarkup(<SourceConnectPage {...props} step="youtube"/>);
  assert.match(html, /YouTube isn&#x27;t available in this workspace yet/);
  assert.match(html, /Rivet&#x27;s server setup must be completed/);
  assert.doesNotMatch(html, /An administrator needs/);
  assert.doesNotMatch(html, /type="submit"/);
  assert.match(html, />Back<\/button>/);
});

test('direct Google sign-in shows applicable policies before leaving Rivet, without adding scopes or steps', () => {
  for (const id of ['youtube', 'google-analytics']) {
    const provider: ConnectionProviderOption = { id, label:id, enabled:true, signIn:'oauth', signInProvider:id, automaticDailySync:true };
    const html = renderToStaticMarkup(<SourceConnectPage {...props} step={id} controller={{...controller,data:{runtimeEnabled:true,providers:[provider],connections:[]}}}/>);
    const disclosure = html.slice(html.indexOf('</details>'), html.indexOf('class="source-connect-actions"'));
    assert.match(disclosure, /aria-label="Google data use"/);
    assert.match(disclosure, /href="https:\/\/rivetfields.com\/privacy"/);
    assert.match(disclosure, /href="https:\/\/policies.google.com\/privacy"/);
    assert.match(disclosure, /authorization tokens encrypted/);
    if (id === 'youtube') {
      assert.match(disclosure, /href="https:\/\/www.youtube.com\/t\/terms"/);
      assert.match(html, /view, like and comment counts/);
      assert.match(html, /not activity during a selected week/);
    } else {
      assert.doesNotMatch(disclosure, /YouTube Terms/);
      assert.match(html, /daily sessions, active users, page and screen views, and engaged sessions/);
    }
    assert.equal((html.match(/type="submit"/g) ?? []).length, 1);
    assert.doesNotMatch(html, /type="submit"[^>]*disabled/);
  }
  assert.doesNotMatch(renderToStaticMarkup(<SourceConnectPage {...props} step="instagram"/>), /Google data use/);
  assert.doesNotMatch(renderToStaticMarkup(<SourceConnectPage {...props} step="youtube"/>), /Google data use/, 'unavailable source does not ask for agreement');
});

test('Instagram has one direct sign-in action and a short professional-account prerequisite', () => {
  const html = renderToStaticMarkup(<SourceConnectPage {...props} step="instagram"/>);
  assert.match(html, /Connect Instagram/);
  assert.match(html, /Facebook account linked to your professional Instagram account/);
  assert.match(html, /Continue with Facebook/);
  assert.match(html, /class="lucide lucide-cable"/);
  assert.doesNotMatch(html, /branding\/platforms\/|<img\b/);
  assert.doesNotMatch(html, /Windsor|Choose a platform|source-connect-name|Upload file/);
  assert.equal((html.match(/type="submit"/g) ?? []).length, 1);
  const chosen = renderToStaticMarkup(<SourceConnectPage {...props} step="data" controller={{...controller,
    choice:{id:'test',provider:'meta',product:'instagram',expiresAt:'2026-10-04',accounts:[]}}}/>);
  assert.match(chosen, /Connect Instagram/);
  assert.doesNotMatch(chosen, /Connect Meta/);
});

test('returning from YouTube sign-in names the correct provider', () => {
  const html = renderToStaticMarkup(<SourceConnectPage {...props} step="data" controller={{ ...controller,
    choice: { id:'test', provider:'youtube', expiresAt:'2026-10-03T12:00:00Z', accounts:[] } }}/ >);
  assert.match(html, /Connect YouTube/); assert.doesNotMatch(html, /Connect Meta/);
});

test('direct Meta retains a shared sign-in for both products and keeps scope and privacy accessible', () => {
  assert.equal(metaConnectOption(providers).choices, undefined);
  const html = renderToStaticMarkup(<SourceConnectPage {...props} step="meta"/>);
  assert.match(html,/aria-label="Connect Meta"/);
  assert.match(html,/Facebook Pages and Instagram/);
  assert.match(html,/Posts from the last 90 days/);
  assert.match(html,/Only this local workspace/);
  assert.match(html,/<details class="source-connect-details">/);
  assert.match(html,/Up to 500 posts per account/);
  assert.match(html,/Continue with Facebook/);
  assert.equal((html.match(/Only this local workspace/g) ?? []).length,1,'privacy is stated once');
  assert.doesNotMatch(html,/Who can see|What Rivet reads|Step 1/);
  assert.equal((html.match(/type="submit"/g) ?? []).length,1);
  assert.doesNotMatch(html,/source-connect-name|Upload file|<dialog/);
});

test('connect deep links are constrained to Sources and non-secret provider keys', () => {
  assert.equal(sourceConnectStep('?view=tables&connect=data'),'data');
  assert.equal(sourceConnectStep('?view=tables&connect=meta'),'meta');
  for (const search of ['?connect=meta','?view=workspace&connect=meta','?view=tables&connect=../admin','?view=tables&connect=']) assert.equal(sourceConnectStep(search),null);
});

test('a failed provider catalog keeps both retry and file fallback available', () => {
  const html = renderToStaticMarkup(<SourceConnectPage {...props} step="data" controller={{...controller,data:null,loadError:'Connections could not be refreshed.'}}/>);
  assert.match(html,/Retry connections/);
  assert.match(html,/Upload file/);
  assert.doesNotMatch(html,/No account connections are available|source-provider-row/);
});

test('brokers stay behind platform entries, and never replace an available direct Meta connection', () => {
  const meta: ConnectionProviderOption[] = ['facebook', 'instagram'].map(sourceProvider => ({
    id:`windsor-${sourceProvider}`, sourceProvider, label:sourceProvider === 'facebook' ? 'Facebook Pages' : 'Instagram',
    enabled:true, signIn:'broker', credential:'api_token', automaticDailySync:true,
  }));
  const data = {runtimeEnabled:true,providers:meta,connections:[]};
  const options = sourceConnectOptions([...providers, ...meta]);
  assert.equal(options.filter(option => option.id === 'instagram').length, 1);
  assert.equal(options.find(option => option.id === 'instagram')?.provider.id, 'instagram');
  assert.equal(sourceConnectOptions([...meta, ...providers]).find(option => option.id === 'instagram')?.provider.id, 'instagram');
  assert.equal(options.find(option => option.id === 'facebook')?.provider.id, 'windsor-facebook');
  const chooser = renderToStaticMarkup(<SourceConnectPage {...props} step="meta" controller={{...controller,data}}/>);
  assert.match(chooser, /aria-label="Facebook Pages"/); assert.match(chooser, /aria-label="Instagram"/);
  assert.doesNotMatch(chooser, /<form|Windsor|Setup required/);
  for (const platform of meta) {
    const html = renderToStaticMarkup(<SourceConnectPage {...props} step={platform.sourceProvider!} controller={{...controller,data}}/>);
    assert.match(html, new RegExp(`Continue with ${platform.label}`));
    assert.doesNotMatch(html, /Last 90 days|Windsor|type="password"|source-connect-name/);
  }
});

test('broker account selection names each source rather than always saying LinkedIn', () => {
  for (const label of ['Facebook Pages', 'Instagram', 'Mailchimp', 'Google Analytics', 'YouTube']) {
    const broker = { ...controller.broker!, pending:{id:'request',provider:'test',url:'https://example.invalid',expiresAt:'2026-10-03'},
      choice:{id:'request',provider:'test',expiresAt:'2026-10-03',accounts:[{id:'option',provider:'test',providerLabel:label,displayName:'Fictional school',state:'new' as const}]} };
    const html = renderToStaticMarkup(<SourceConnectPage {...props} step="data" controller={{...controller,broker}}/>);
    assert.match(html, new RegExp(`${label} account`)); assert.match(html, /Connect account/);
    assert.doesNotMatch(html, /LinkedIn Page|Choose a Page|Continue with Windsor/);
  }
});

test('a reconnect handoff keeps the provider heading when opened from source details', () => {
  const provider: ConnectionProviderOption = {id:'windsor-mailchimp',sourceProvider:'mailchimp',label:'Mailchimp',enabled:true,signIn:'broker'};
  const broker = { ...controller.broker!, pending:{id:'request',provider:provider.id,url:'https://example.invalid',expiresAt:'2026-10-03'} };
  const html = renderToStaticMarkup(<SourceConnectPage {...props} step={null} controller={{...controller,broker,
    data:{runtimeEnabled:true,providers:[provider],connections:[]}}}/>);
  assert.match(html, /<h1[^>]*>Connect Mailchimp<\/h1>/); assert.match(html, /Waiting for Mailchimp sign-in/);
  assert.doesNotMatch(html, /Sign in with Mailchimp|Check again|href="https:\/\/example.invalid"/);
  assert.match(html, /<details class="source-connect-details">/);
  assert.match(html, /Windsor handles account authorization and collection for Rivet/);
  assert.doesNotMatch(html, /Continue with Windsor|<iframe|type="password"/);
});

test('single broker account is named and ready to confirm without a redundant picker', () => {
  const broker = {...controller.broker, pending:{id:'request',provider:'windsor-instagram',url:'https://example.invalid',expiresAt:'2026-10-04'},
    choice:{id:'request',provider:'windsor-instagram',expiresAt:'2026-10-04',accounts:[{id:'option',provider:'windsor-instagram',providerLabel:'Instagram',displayName:'Fictional school',state:'new' as const}]}};
  const html = renderToStaticMarkup(<SourceConnectPage {...props} step="instagram" controller={{...controller,broker}}/>);
  assert.match(html, /Fictional school/);
  assert.match(html, /Instagram account/);
  assert.doesNotMatch(html, /<select|disabled=""[^>]*>Connect account/);
});

test('blocked sign-in exposes one platform action, not a permanent second step', () => {
  const broker = {...controller.broker, signInState:'blocked' as const,
    pending:{id:'request',provider:'windsor-mailchimp',url:'https://example.invalid',expiresAt:'2026-10-04'}};
  const provider: ConnectionProviderOption = {id:'windsor-mailchimp',sourceProvider:'mailchimp',label:'Mailchimp',enabled:true,signIn:'broker'};
  const html = renderToStaticMarkup(<SourceConnectPage {...props} step="mailchimp" controller={{...controller,broker,data:{runtimeEnabled:true,providers:[provider],connections:[]}}}/>);
  assert.match(html, /Open sign-in to continue/);
  assert.match(html, /Sign in with Mailchimp/);
  assert.doesNotMatch(html, /Continue with Windsor|Check again|https:\/\/example.invalid/);
});

test('broker source details offer reconnect for disconnected or unhealthy accounts only when enabled', () => {
  const provider: ConnectionProviderOption = {id:'windsor-ga4',sourceProvider:'google-analytics',label:'Google Analytics',enabled:true,signIn:'broker'};
  const connection = {
    id:`conn_${'a'.repeat(24)}`,workspaceId:'local',provider:provider.id,accountKey:'b'.repeat(32),
    providerAccountId:'fictional-property',displayName:'Fictional property',status:'active' as const,version:1,
    createdAt:'2026-10-04T00:00:00Z',updatedAt:'2026-10-04T00:00:00Z',
    job:null,latestVersion:null,activeAttempt:null,lastFailure:null,
  };
  for (const status of ['disconnected','needs_attention'] as const) {
    for (const enabled of [true,false]) {
      const html = renderToStaticMarkup(<SourceConnectionDetail connection={{...connection,status}}
        controller={{...controller,data:{runtimeEnabled:true,providers:[{...provider,enabled}],connections:[]}}}
        onBack={()=>{}} onAskSource={()=>{}} onSource={()=>{}}/>);
      assert.equal(html.includes('>Reconnect</button>'),enabled);
      assert.match(html, /class="lucide lucide-cable"/);
      assert.doesNotMatch(html, /branding\/platforms\/|<img\b/);
    }
  }
});

test('provider rows and legacy Meta choices retain generic icons without excluded brand artwork', () => {
  const html = renderToStaticMarkup(<SourceConnectPage {...props} step="data"/>);
  const icons = [...html.matchAll(/<span class="source-provider-brand">([\s\S]*?)<\/span>/g)];
  assert.equal(icons.length, 8);
  for (const [, icon] of icons) assert.match(icon, /<svg[^>]*width="24"[^>]*height="24"[^>]*class="lucide lucide-cable"[^>]*aria-hidden="true"/);
  assert.doesNotMatch(html, /branding\/platforms\/|<img\b/);
  assert.doesNotMatch(html, /source-provider-brand[^>]*>(M|in|YT|MC|GA)<\/span>/);
  const meta: ConnectionProviderOption[] = ['facebook', 'instagram'].map(sourceProvider => ({
    id:`windsor-${sourceProvider}`, sourceProvider, label:sourceProvider, enabled:true, signIn:'broker',
  }));
  const chooser = renderToStaticMarkup(<SourceConnectPage {...props} step="meta" controller={{...controller,data:{runtimeEnabled:true,providers:meta,connections:[]}}}/>);
  const chooserIcons = [...chooser.matchAll(/<span class="source-provider-brand">([\s\S]*?)<\/span>/g)];
  assert.equal(chooserIcons.length, 2);
  for (const [, icon] of chooserIcons) assert.match(icon, /class="lucide lucide-cable"/);
  assert.doesNotMatch(chooser, /branding\/platforms\/|<img\b/);
});

test('empty successful collection shows its check time without inventing a data timestamp or post metrics', () => {
  for (const provider of ['facebook', 'instagram', 'windsor-youtube', 'windsor-mailchimp', 'windsor-ga4']) {
    const checkedAt = '2026-10-05T02:00:00Z';
    const connection = {
      id:`conn_${'a'.repeat(24)}`,workspaceId:'local',provider,accountKey:'b'.repeat(32),
      providerAccountId:'fictional-account',displayName:'Fictional account',status:'active' as const,version:1,
      createdAt:checkedAt,updatedAt:checkedAt,job:null,latestVersion:null,activeAttempt:null,lastFailure:null,
      lastAttempt:{id:'attempt',status:'succeeded' as const,at:checkedAt},
    };
    const html = renderToStaticMarkup(<SourceConnectionDetail connection={connection} controller={controller}
      onBack={()=>{}} onAskSource={()=>{}} onSource={()=>{}}/>);
    assert.match(html,/Last checked/);
    assert.match(html,/dateTime="2026-10-05T02:00:00Z"/i);
    assert.match(html,/No records were returned for this period\./);
    assert.doesNotMatch(html,/Data as of|Last synced|Not yet|No posts/);
    assert.match(html,/disabled=""[^>]*>Ask about this/);
    const disconnected = renderToStaticMarkup(<SourceConnectionDetail connection={{...connection,status:'disconnected'}} controller={controller}
      onBack={()=>{}} onAskSource={()=>{}} onSource={()=>{}}/>);
    assert.match(disconnected,/Syncing has stopped/);
    assert.doesNotMatch(disconnected,/Connected\.|No records were returned for this period/);
  }
});

test('a failed later collection keeps the saved data time separate from its attempt time', () => {
  const observedAt = '2026-10-04T02:00:00Z', checkedAt = '2026-10-05T02:00:00Z';
  const connection = {
    id:`conn_${'a'.repeat(24)}`,workspaceId:'local',provider:'facebook',accountKey:'b'.repeat(32),
    providerAccountId:'fictional-account',displayName:'Fictional account',status:'active' as const,version:1,
    createdAt:observedAt,updatedAt:checkedAt,job:null,latestVersion:{sourceId:'saved',observedAt},activeAttempt:null,
    lastFailure:{errorCode:'provider_error',message:'Try again.'},
    lastAttempt:{id:'attempt',status:'failed' as const,at:checkedAt,errorCode:'provider_error'},
  };
  const html = renderToStaticMarkup(<SourceConnectionDetail connection={connection} controller={controller}
    onBack={()=>{}} onAskSource={()=>{}} onSource={()=>{}}/>);
  assert.match(html,/Last checked/); assert.match(html,/Data as of/);
  for (const time of [observedAt,checkedAt]) assert.ok(html.includes(`dateTime="${time}"`));
  assert.match(html,/Your last synced data is still available/);
});
