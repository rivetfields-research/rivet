import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { renderToStaticMarkup } from 'react-dom/server';
import { sourceDatasetId, sourceTableKind } from '../../../packages/core/src/source-table';
import type { Source, WorkspaceStatus } from '../../../packages/core/src/types';
import { libraryItems, libraryFileName, visibleLibraryItems } from './tables-library-items';

const css = registerHooks({ load(url, context, next) { return url.endsWith('.css') ? {format:'module',source:'',shortCircuit:true} : next(url,context); } });
const { TablesLibrary } = await import('./tables-library');
const { RestoreSourceButton } = await import('./restore-source');
css.deregister();

const hash = 'a'.repeat(64);
const source = (id:string,title:string,path:string):Source => ({id,title,path,bytes:42});
const csv = source('csv','Export.CSV','uploads/file/Export.CSV');
const social = source('social','Social CSV · posts.csv',`datasets/dataset_${hash}/schema.md`);
const note = source('note','Planning','notes/planning.md');
const receipt = source('receipt','Post ranking','calculations/calc/receipt.md');
const files = [receipt,note,social,csv];

test('Sources lists input files and datasets without calculation outputs', () => {
  const items = libraryItems(files);
  const ids = (category:Parameters<typeof visibleLibraryItems>[2],query='') => visibleLibraryItems(items,query,category,'name').map(item=>item.id);
  assert.deepEqual(ids('all'),['source-csv','source-note','source-social']);
  assert.deepEqual(ids('csv'),['source-csv','source-social']);
  assert.deepEqual(ids('documents'),['source-note']);
  assert.equal(libraryFileName(social),'posts.csv');
  assert.deepEqual(ids('all',' POSTS '),['source-social']);
  assert.deepEqual(ids('all','Post ranking'),[]);
  assert.deepEqual(ids('all','missing'),[]);
  assert.deepEqual(files,[receipt,note,social,csv]);
});

test('Calculation receipts stay out of Sources independently of report pagination or filenames', () => {
  const receipts = [receipt, source('checked', 'Saved CSV', `calculations/analysis_${hash}/receipt.md`), source('review', 'Source review', `calculations/source_analysis_${hash}/receipt.md`)];
  assert.deepEqual(libraryItems(receipts), []);
  assert.deepEqual(libraryItems([]), []);
  assert.equal(libraryItems([...files, ...files]).length, 3);
  const namedLikeOutput = {...note, title: 'Saved table'};
  assert.deepEqual(libraryItems([namedLikeOutput]).map(item => item.source), [namedLikeOutput]);
  const notes = [source('forecast', 'Forecast notes', 'calculations/forecast-notes.md'), source('outline', 'Outline', 'calculations/forecast/outline.md')];
  assert.deepEqual(libraryItems(notes).map(item => item.source), notes, 'ordinary inputs in a calculations folder remain visible and restorable');
  const sharedDataset = {...social, id: `team_${social.id}`, path: `datasets/team_dataset_${hash}/schema.md`};
  assert.equal(libraryItems([sharedDataset, receipt])[0].category, 'csv');
});

test('Source sorting preserves unknown dates and file types', () => {
  const items = libraryItems(files);
  assert.deepEqual(visibleLibraryItems(items,'','all','newest').map(item=>item.id),['source-csv','source-note','source-social']);
  assert.deepEqual(visibleLibraryItems(items,'','all','type').map(item=>item.label),['CSV','CSV','Document']);
  assert.equal(items.find(item=>item.id==='source-csv')?.date,undefined);
});

test('CSV detection uses saved source paths, never a misleading document title', () => {
  assert.equal(sourceTableKind(csv),'csv');
  assert.equal(sourceTableKind(social),'tabular');
  const misleading = {...note,title:'fake.csv'};
  assert.equal(sourceTableKind(misleading),null);
  for (const [prefix,name,kind] of [['usage_version_','checked-metrics','usage'],['financial_version_','checked-financials','financial']] as const) {
    const file = source(kind,'Saved CSV',`datasets/${prefix}${hash}/${name}.md`);
    assert.equal(sourceTableKind(file),kind);
    assert.equal(sourceDatasetId(file),`${prefix}${hash}`);
    assert.equal(sourceTableKind({...file,path:file.path.replace(name,'receipt')}),null);
  }
});

test('Tables shows actual files, safe names, upload controls and a read-only reviewer state', () => {
  const workspace = {sources:[...files,source('untrusted','<script>alert(1)</script>','notes/untrusted.md')]} as WorkspaceStatus;
  const props = {workspace,onRefresh:async()=>{},onSource:()=>{},onUsePrompt:()=>{},onAskSource:()=>{}};
  const html = renderToStaticMarkup(<TablesLibrary {...props}/>);
  assert.match(html, /<h1[^>]*>Sources<\/h1>/);
  assert.match(html, /Export.CSV/); assert.match(html, /posts.csv/); assert.match(html, /Planning/);
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /Post ranking|Saved tables|Loading saved tables|Load more saved tables/);
  assert.match(html, /4 items/);
  assert.match(html, /Search sources/); assert.match(html, /CSV files/); assert.match(html, /Documents/);
  assert.match(html, /Item type/); assert.match(html, /Sort by/);
  assert.match(html, /Upload file/);
  assert.match(renderToStaticMarkup(<TablesLibrary {...props} readOnly/>), /class="button secondary" disabled=""/);
});

test('Tables offers existing account controls only to source managers on enabled runtimes', () => {
  const props = { workspace: { sources: [], connectionsEnabled: true } as unknown as WorkspaceStatus, onRefresh: async () => {}, onSource: () => {}, onUsePrompt: () => {}, onAskSource: () => {} };
  assert.match(renderToStaticMarkup(<TablesLibrary {...props} session={{mode:'local'}}/>), /Connected accounts/);
  assert.doesNotMatch(renderToStaticMarkup(<TablesLibrary {...props}/>), /Connected accounts/);
  assert.doesNotMatch(renderToStaticMarkup(<TablesLibrary {...props} workspace={{...props.workspace!,connectionsEnabled:false}} session={{mode:'local'}}/>), /Connected accounts/);
  for (const privateWorkspace of [true, false]) {
    assert.doesNotMatch(renderToStaticMarkup(<TablesLibrary {...props} session={{mode:'authenticated',role:'reviewer',workspaceId:'test',privateWorkspace,signInUrl:'/',signOutUrl:'/'}} readOnly/>), /Connected accounts/);
  }
});

test('local Sources keeps direct upload and shared setup available when account connections are off', () => {
  const props = {workspace:{sources:[],connectionsEnabled:false} as unknown as WorkspaceStatus,
    onRefresh:async()=>{},onSource:()=>{},onUsePrompt:()=>{},onAskSource:()=>{},session:{mode:'local'} as const};
  const html = renderToStaticMarkup(<TablesLibrary {...props}/>);
  assert.match(html, /id="tables-connect-accounts"[^>]*>.*Connect source/);
  assert.match(html, /Upload file/);
  assert.doesNotMatch(html, /Connected accounts/);
  const readonly = renderToStaticMarkup(<TablesLibrary {...props} readOnly/>);
  assert.doesNotMatch(readonly, /id="tables-connect-accounts"/);
});

test('archive recovery is explicit and respects restore permissions and unavailable originals', () => {
  const archived = { source: social, archivedAt: '2026-09-27T00:00:00Z', canRestore: true };
  const props = { workspace: { sources: [], archivedSources: [archived, {...archived, source: receipt}] } as unknown as WorkspaceStatus, onRefresh: async () => {}, onSource: () => {}, onUsePrompt: () => {}, onAskSource: () => {} };
  const html = renderToStaticMarkup(<TablesLibrary {...props}/>);
  assert.match(html, /Archived files \(1\)/);
  assert.doesNotMatch(html, /library-file-source-social/);
  assert.doesNotMatch(html, /Post ranking/);
  assert.match(renderToStaticMarkup(<RestoreSourceButton archived={archived} onRestore={async () => {}}/>), /Restore file/);
  assert.doesNotMatch(renderToStaticMarkup(<RestoreSourceButton archived={archived}/>), /<button/);
  const missing = renderToStaticMarkup(<RestoreSourceButton archived={{...archived, canRestore: false}} onRestore={async () => {}}/>);
  assert.match(missing, /Original file unavailable/);
  assert.doesNotMatch(missing, /<button/);
});
