import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createHarness, type ModelProvider, type Run } from './index.ts';
import { validateSourceIds } from './source-scope.ts';

const json = (action: unknown) => ({content: JSON.stringify(action)});
const reply = () => json({type:'reply',content:'Choose the sources for this task.'});
const read = (sourceId: string) => json({type:'tool',name:'workspace.read',arguments:{sourceId}});
function fixture(t: TestContext, complete: ModelProvider['complete'] = async () => reply(), profile?: 'healthcare-operations') {
  const root = mkdtempSync(join(tmpdir(),'rivet-source-scope-'));
  const sourceDir = join(root,'sources'); mkdirSync(sourceDir);
  writeFileSync(join(sourceDir,'notes.md'),'# Scope notes\nA fictional approved note.');
  const options = {sourceDir,dataDir:join(root,'data'),modelBaseUrl:'http://127.0.0.1:8001/v1',...(profile ? {profile} : {}),provider:{
    status:async()=>({configured:true,available:true,model:'scripted-scope',kind:'openai-compatible' as const,label:'Test',message:'No inference'}),complete,
  }};
  const harness = createHarness(options);
  t.after(async()=>{await harness.close();rmSync(root,{recursive:true,force:true});});
  return {harness,options};
}
async function settled(harness: ReturnType<typeof createHarness>, id: string): Promise<Run> {
  for(let attempt=0;attempt<300;attempt++) {
    const run=harness.getRun(id)!;
    if(!harness.activeRunId() && !['queued','running'].includes(run.status)) return run;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw new Error('Scope test did not settle.');
}
const csvInput = (name: string, likes: number) => ({csv:`id,likes\np1,${likes}`,sourceName:`scope-${name}.csv`,mapping:{confirmed:true as const,platform:'linkedin' as const,account:`Fixture ${name}`,columns:{postId:'id',likes:'likes'}}});
const searchProvider: ModelProvider['complete'] = async ({messages}) => messages.at(-1)!.content.startsWith('TOOL RESULT') ? reply() : json({type:'tool',name:'workspace.search',arguments:{query:'scope'}});
const matches = (run: Run) => (run.events.find(event=>event.type==='tool_result' && event.toolName==='workspace.search')?.output as {matches:{id:string}[]}).matches.map(source=>source.id).sort();

test('a new conversation sees no library data until inputs are explicitly attached', async t => {
  const {harness}=fixture(t,searchProvider);
  const saved=harness.importTabularDataset(csvInput('unselected',900));
  const run=await settled(harness,(await harness.startRun({task:'Find scope data.',requestId:'empty-new-session'})).id);
  assert.equal(run.status,'completed'); assert.deepEqual(run.selectedSourceIds,[]); assert.deepEqual(run.sources,[]); assert.deepEqual(matches(run),[]);
  assert.ok(!(JSON.stringify(run.events)).includes(saved.id),'unselected dataset metadata never enters model or tool output');
  assert.ok((await harness.workspace()).sources.length>0,'the source remains discoverable in the owner library');
});

test('independent conversations retain distinct inputs and follow-ups add only explicit selections', async t => {
  const {harness}=fixture(t,searchProvider);
  const a=harness.importTabularDataset(csvInput('alpha',10)), b=harness.importTabularDataset(csvInput('beta',900));
  const first=await settled(harness,(await harness.startRun({task:'Find scope data A.',requestId:'scope-session-alpha',sourceIds:[a.source.id]})).id);
  const second=await settled(harness,(await harness.startRun({task:'Find scope data B.',requestId:'scope-session-beta',sourceIds:[b.source.id]})).id);
  assert.deepEqual(matches(first),[a.source.id]); assert.deepEqual(matches(second),[b.source.id]);
  const follow=await settled(harness,(await harness.startRun({task:'Find scope data again.',requestId:'scope-follow-alpha',parentRunId:first.id})).id);
  assert.deepEqual(matches(follow),[a.source.id]); assert.deepEqual(follow.selectedSourceIds,[a.source.id]);
  assert.equal(follow.sessionId,first.id); assert.ok(!JSON.stringify(follow.events).includes(b.id));
  const expanded=await settled(harness,(await harness.startRun({task:'Find both scope inputs.',requestId:'scope-add-beta',parentRunId:follow.id,sourceIds:[b.source.id]})).id);
  assert.deepEqual(matches(expanded),[a.source.id,b.source.id].sort()); assert.deepEqual(expanded.requestedSourceIds,[b.source.id]);
  assert.deepEqual(harness.getRun(second.id)?.selectedSourceIds,[b.source.id]);
});

test('project defaults and explicit conversation attachments remain separate', async t => {
  const {harness}=fixture(t,searchProvider);
  const a=harness.importTabularDataset(csvInput('project-alpha',10)), b=harness.importTabularDataset(csvInput('project-beta',900)), outside=harness.importTabularDataset(csvInput('project-outside',800));
  const project=harness.saveProject({id:'frozen-project-scope',name:'Scope project',brief:'Use chosen sources.',sourceIds:[a.source.id,b.source.id],version:0});
  const input={task:'Find scope data.',requestId:'project-explicit-subset',projectId:project.id,sourceIds:[a.source.id]};
  const run=await settled(harness,(await harness.startRun(input)).id);
  assert.deepEqual(matches(run),[a.source.id]);assert.deepEqual(run.selectedSourceIds,[a.source.id]);
  assert.equal((await harness.startRun(input)).id,run.id);
  const follow=await settled(harness,(await harness.startRun({task:'Find scope data again.',requestId:'project-subset-follow',parentRunId:run.id})).id);
  assert.deepEqual(matches(follow),[a.source.id]);
  const expanded=await settled(harness,(await harness.startRun({task:'Find the newly attached scope input.',requestId:'project-upload-follow',parentRunId:follow.id,sourceIds:[outside.source.id]})).id);
  assert.deepEqual(matches(expanded),[a.source.id,outside.source.id].sort());
  assert.deepEqual(harness.getProject(project.id)?.sourceIds,[a.source.id,b.source.id]);
  const defaultRun=await settled(harness,(await harness.startRun({task:'Find scope data.',requestId:'project-default-files',projectId:project.id})).id);
  assert.deepEqual(matches(defaultRun),[a.source.id,b.source.id].sort());
  const explicit=await settled(harness,(await harness.startRun({...input,requestId:'project-explicit-upload',sourceIds:[outside.source.id]})).id);
  assert.deepEqual(matches(explicit),[outside.source.id]);
  const empty=harness.saveProject({id:'empty-conversation-project',name:'Empty baseline',brief:'Use conversation attachments.',sourceIds:[],version:0});
  const attached=await settled(harness,(await harness.startRun({task:'Find scope data.',requestId:'empty-project-attached',projectId:empty.id,sourceIds:[a.source.id]})).id);
  const retained=await settled(harness,(await harness.startRun({task:'Find scope data again.',requestId:'empty-project-inherited',parentRunId:attached.id})).id);
  assert.deepEqual(matches(retained),[a.source.id]);assert.deepEqual(harness.getProject(empty.id)?.sourceIds,[]);
});

test('unknown, cross-workspace, malformed and conflicting retry selections fail before model execution', async t => {
  let calls=0;
  const {harness}=fixture(t,async()=>{calls++;return reply();});
  const foreign=fixture(t).harness.importTabularDataset(csvInput('foreign',50));
  for(const sourceIds of [[foreign.source.id],['source_unknown']]) await assert.rejects(harness.startRun({task:'Read selected data.',requestId:`bad-source-${sourceIds[0].slice(-12)}`,sourceIds}),{code:'unknown_source'});
  for(const value of [null,'source_id',['source_id','source_id'],Array.from({length:101},(_,i)=>`source_${i}`),['bad id']]) assert.throws(()=>validateSourceIds(value),{code:'invalid_source_ids'});
  assert.equal(calls,0);
  const a=harness.importTabularDataset(csvInput('one',1)), b=harness.importTabularDataset(csvInput('two',2));
  const input={task:'Use this source.',requestId:'selection-idempotency',sourceIds:[a.source.id]};
  const done=await settled(harness,(await harness.startRun(input)).id);
  assert.equal((await harness.startRun(input)).id,done.id);
  await assert.rejects(harness.startRun({...input,sourceIds:[b.source.id]}),{code:'request_id_conflict'});
  await assert.rejects(harness.startRun({...input,sourceIds:undefined}),{code:'request_id_conflict'});
});

test('a model cannot read or calculate an unselected dataset even when it guesses exact IDs', async t => {
  for(const action of ['read','calculate'] as const) {
    let outsideSource='',outsideDataset='';
    const {harness}=fixture(t,async()=>action==='read' ? read(outsideSource) : json({type:'tool',name:'workspace.analyze_table',arguments:{datasetId:outsideDataset,request:{metrics:['likes'],groupBy:'post',chart:'bar'}}}));
    const selected=harness.importTabularDataset(csvInput(`selected-${action}`,10));
    const outside=harness.importTabularDataset(csvInput(`outside-${action}`,900)); outsideSource=outside.source.id; outsideDataset=outside.id;
    const run=await settled(harness,(await harness.startRun({task:'Read selected data.',requestId:`guessed-id-${action}`,sourceIds:[selected.source.id]})).id);
    assert.equal(run.status,'failed'); assert.equal(run.result,null); assert.equal(run.events.filter(event=>event.type==='tool_call').length,0);
    assert.deepEqual(run.sourceIds,[selected.source.id]);
  }
});

test('uploads during an active run cannot alter its admitted source snapshot or follow-up selection', async t => {
  let release!:()=>void, entered!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve;}), waiting=new Promise<void>(resolve=>{entered=resolve;});
  let first=true;
  const {harness}=fixture(t,async request=>{if(first){first=false;entered();await pending;}return searchProvider(request);});
  const selected=harness.importTabularDataset(csvInput('before',10));
  const started=await harness.startRun({task:'Find scope data.',requestId:'active-immutable-upload',sourceIds:[selected.source.id]});
  await waiting;
  const added=harness.importTabularDataset(csvInput('during',900));
  const text=harness.importFile({name:'scope-during.txt',content:'Unselected new note.'});
  assert.deepEqual(harness.getRun(started.id)?.selectedSourceIds,[selected.source.id]);
  assert.ok(!harness.getRun(started.id)?.sourceIds?.includes(added.source.id));
  assert.ok(!harness.getRun(started.id)?.sourceIds?.includes(text.source.id));
  release(); const done=await settled(harness,started.id); assert.deepEqual(matches(done),[selected.source.id]);
  const follow=await settled(harness,(await harness.startRun({task:'Find scope data again.',requestId:'active-upload-follow',parentRunId:done.id})).id);
  assert.deepEqual(matches(follow),[selected.source.id]);
});

test('archiving hides inputs and blocks new selection while reports, source bytes and restart evidence remain intact', async t => {
  let sourceId='',datasetId='',step=0;
  const f=fixture(t,async({messages})=>{
    if(step++===0)return read(sourceId);
    if(step===2)return json({type:'tool',name:'workspace.analyze_table',arguments:{datasetId,request:{metrics:['likes'],groupBy:'post',chart:'bar'}}});
    const receiptId=JSON.parse(messages.at(-1)!.content.split('\n').slice(1).join('\n')).sourceId;
    return json({type:'finish',title:'Saved fixture report',content:`Supplied evidence. [Source](source:${receiptId})`,citations:[receiptId]});
  });
  const saved=f.harness.importTabularDataset(csvInput('archive',25));sourceId=saved.source.id;datasetId=saved.id;
  const run=await settled(f.harness,(await f.harness.startRun({task:'Create a report.',requestId:'archive-evidence-report',sourceIds:[sourceId]})).id);
  assert.equal(run.status,'completed',run.error??'');
  const before=f.harness.getSource(sourceId), state=f.harness.setSourceArchived(sourceId,true);
  assert.equal(state.archived,true); assert.ok(state.archivedAt); assert.deepEqual(f.harness.setSourceArchived(sourceId,true),state);
  assert.deepEqual(f.harness.listTabularDatasets(),[]); assert.ok(!(await f.harness.workspace()).sources.some(source=>source.id===sourceId));
  assert.equal(f.harness.importTabularDataset(csvInput('archive',25)).id,saved.id,'retry does not restore an archived input');
  await assert.rejects(f.harness.startRun({task:'Read it.',requestId:'archive-new-selection',sourceIds:[sourceId]}),{code:'source_archived'});
  await assert.rejects(f.harness.startRun({task:'Follow up.',requestId:'archive-follow-selection',parentRunId:run.id}),{code:'source_archived'});
  assert.deepEqual(f.harness.getRun(run.id),run); assert.deepEqual(f.harness.getSource(sourceId),before); assert.equal(f.harness.getTabularDataset(saved.id)?.csv,csvInput('archive',25).csv);
  await f.harness.close();const reopened=createHarness(f.options);t.after(()=>reopened.close());
  assert.deepEqual(reopened.listSourceArchives(),[state]); assert.deepEqual(reopened.getRun(run.id),run); assert.deepEqual(reopened.getSource(sourceId),before);
  const archived = (await reopened.workspace()).archivedSources!;
  const { content: _content, ...sourceMetadata } = saved.source;
  assert.deepEqual(archived, [{ source: sourceMetadata, archivedAt: state.archivedAt, canRestore: true }]);
  assert.ok(!('content' in archived[0].source), 'workspace discovery never includes file contents');
  assert.deepEqual(reopened.setSourceArchived(sourceId,false),{sourceId,archived:false,archivedAt:null});assert.equal(reopened.listTabularDatasets().length,1);
  assert.deepEqual((await reopened.workspace()).archivedSources, []);
  assert.ok((await reopened.workspace()).sources.some(source => source.id === sourceId));
  assert.deepEqual(reopened.getRun(run.id), run, 'restore never rewrites the saved calculation');
  assert.throws(()=>reopened.setSourceArchived('source_unknown',true),{code:'unknown_source'});
});

test('archiving a selected input during a model request prevents the next tool action', async t => {
  let sourceId='';
  const {harness}=fixture(t,async()=>{harness.setSourceArchived(sourceId,true);return read(sourceId);});
  sourceId=harness.importTabularDataset(csvInput('revoked',40)).source.id;
  const run=await settled(harness,(await harness.startRun({task:'Read it.',requestId:'archive-running-source',sourceIds:[sourceId]})).id);
  assert.equal(run.status,'failed'); assert.match(run.error??'',/archived/); assert.equal(run.events.filter(event=>event.type==='tool_call').length,0);
});

test('archived notes absent from the approved directory remain inspectable but not restorable', async t => {
  const f = fixture(t);
  const source = (await f.harness.workspace()).sources[0];
  f.harness.setSourceArchived(source.id, true);
  await f.harness.close();
  rmSync(join(f.options.sourceDir, 'notes.md'));
  const reopened = createHarness(f.options); t.after(() => reopened.close());
  const status = await reopened.workspace();
  assert.equal(status.archivedSources?.[0].source.id, source.id);
  assert.equal(status.archivedSources?.[0].canRestore, false);
  assert.equal(status.sources.length, 0);
  assert.ok(reopened.getSource(source.id)?.content);
  assert.throws(() => reopened.setSourceArchived(source.id, false), { code: 'unknown_source' });
});

test('projects with archived inputs remain editable without allowing new archived attachments or task access', async t => {
  const { harness } = fixture(t);
  const a = harness.importTabularDataset(csvInput('project-a', 10)).source.id;
  const b = harness.importTabularDataset(csvInput('project-b', 20)).source.id;
  const c = harness.importTabularDataset(csvInput('project-c', 30)).source.id;
  const input = { id: 'archived-project-test', name: 'Before', brief: '', sourceIds: [a, b], version: 0 };
  harness.saveProject(input);
  for (const id of [a, b, c]) harness.setSourceArchived(id, true);
  const renamed = harness.saveProject({ ...input, name: 'After', version: 1 });
  assert.deepEqual(renamed.sourceIds, [a, b]);
  const changed = harness.saveProject({ ...input, name: 'After', sourceIds: [b], version: 2 });
  assert.deepEqual(changed.sourceIds, [b]);
  assert.throws(() => harness.saveProject({ ...input, sourceIds: [b, c], version: 3 }), { code: 'unknown_source' });
  assert.throws(() => harness.saveProject({ ...input, sourceIds: [a, b], version: 3 }), { code: 'unknown_source' });
  assert.throws(() => harness.saveProject({ ...input, id: 'another-archived-project' }), { code: 'unknown_source' });
  await assert.rejects(harness.startRun({ task: 'Analyze', requestId: 'archived-project-start', projectId: input.id }), { code: 'source_archived' });
  harness.setSourceArchived(b, false);
  const run = await harness.startRun({ task: 'Analyze', requestId: 'restored-project-start', projectId: input.id });
  assert.equal((await settled(harness, run.id)).status, 'completed');
  assert.deepEqual(harness.getProject(input.id), changed, 'restoring a file never changes project associations');
});

test('legacy reports stay readable but their old all-library permission does not spread into follow-ups', async t => {
  let sourceId='';
  const f=fixture(t,async({messages})=>messages.at(-1)!.content.startsWith('TOOL RESULT') ? json({type:'reply',content:`Fixture note. [Source](source:${sourceId})`,citations:[sourceId]}) : read(sourceId));
  const a=f.harness.importFile({name:'scope-a.txt',content:'Approved A'}), b=f.harness.importFile({name:'scope-b.txt',content:'Unrelated B'});sourceId=a.source.id;
  const run=await settled(f.harness,(await f.harness.startRun({task:'Read the note.',requestId:'legacy-source-parent',sourceIds:[a.source.id,b.source.id]})).id);
  await f.harness.close();
  const db=new DatabaseSync(join(f.options.dataDir,'harness.sqlite'));
  const legacy=JSON.parse(db.prepare('SELECT data FROM runs WHERE id=?').get(run.id)!.data as string); delete legacy.selectedSourceIds;delete legacy.requestedSourceIds;
  db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(legacy),run.id);db.close();
  const reopened=createHarness(f.options);t.after(()=>reopened.close());
  assert.deepEqual(reopened.getRun(run.id)?.reply,run.reply);
  const follow=await settled(reopened,(await reopened.startRun({task:'Read it again.',requestId:'legacy-source-follow',parentRunId:run.id})).id);
  assert.equal(follow.status,'completed',follow.error??'');assert.deepEqual(follow.selectedSourceIds,[a.source.id]);assert.ok(!follow.sourceIds?.includes(b.source.id));
});

test('the healthcare profile retains its approved local notes without analyst attachments', async t => {
  let sourceId='';
  const {harness}=fixture(t,async({messages})=>messages.at(-1)!.content.startsWith('TOOL RESULT') ? json({type:'finish',title:'Administrative fixture',content:`Source reviewed. [Source](source:${sourceId})`,citations:[sourceId]}) : read(sourceId),'healthcare-operations');
  sourceId=(await harness.workspace()).sources[0].id;
  const run=await settled(harness,(await harness.startRun({task:'Review approved notes.',requestId:'healthcare-source-compat'})).id);
  assert.equal(run.status,'completed',run.error??'');assert.deepEqual(run.sourceIds,[sourceId]);
});

test('legacy typed calculations inherit their actual input even when they did not read its descriptor first', async t => {
  let datasetId='',step=0;
  const f=fixture(t,async({messages})=>{
    if(step++%2===0)return json({type:'tool',name:'workspace.calculate_usage',arguments:{datasetId,weekStart:'2026-09-14',comparePrevious:true}});
    const receipt=JSON.parse(messages.at(-1)!.content.split('\n').slice(1).join('\n'));
    return json({type:'finish',title:'Usage fixture',content:`Computed fixture values. [Calculation](source:${receipt.id})`,citations:[receipt.id]});
  });
  const a=f.harness.importUsageDataset({csv:'date,user_id,event\n2026-09-14,fictional-a,login',sourceName:'scope-usage-a.csv',weekStart:'2026-09-14'});
  const b=f.harness.importUsageDataset({csv:'date,user_id,event\n2026-09-14,fictional-b,login',sourceName:'scope-usage-b.csv',weekStart:'2026-09-14'});datasetId=a.id;
  const parent=await settled(f.harness,(await f.harness.startRun({task:'Create a usage report.',requestId:'legacy-calculation-parent',sourceIds:[a.source.id,b.source.id]})).id);
  assert.equal(parent.status,'completed',parent.error??'');await f.harness.close();
  const db=new DatabaseSync(join(f.options.dataDir,'harness.sqlite'));
  const legacy=JSON.parse(db.prepare('SELECT data FROM runs WHERE id=?').get(parent.id)!.data as string);delete legacy.selectedSourceIds;delete legacy.requestedSourceIds;
  db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(legacy),parent.id);db.close();
  const reopened=createHarness(f.options);t.after(()=>reopened.close());
  const follow=await settled(reopened,(await reopened.startRun({task:'Create a usage report again.',requestId:'legacy-calculation-follow',parentRunId:parent.id})).id);
  assert.equal(follow.status,'completed',follow.error??'');assert.deepEqual(follow.selectedSourceIds,[a.source.id]);assert.ok(!follow.sourceIds?.includes(b.source.id));
});

test('legacy social preparation is limited to explicitly selected immutable input batches', async t => {
  const {harness}=fixture(t);
  const first=harness.importSocialDataset({json:[{id:'a',url:'https://www.instagram.com/p/a/',ownerUsername:'alpha',type:'Image',timestamp:'2026-09-21T10:00:00Z',likesCount:10,commentsCount:1}],platform:'instagram',accountId:'alpha',requestId:'social-scope-one'});
  const other=harness.importSocialDataset({json:[{id:'b',url:'https://www.instagram.com/p/b/',ownerUsername:'bravo',type:'Image',timestamp:'2026-09-21T10:00:00Z',likesCount:900,commentsCount:9}],platform:'instagram',accountId:'bravo',requestId:'social-scope-two'});
  const empty=await settled(harness,(await harness.startRun({task:'How did Instagram posts do?',requestId:'social-no-selection'})).id);
  assert.equal(empty.events.some(event=>(event.output as {batchId?:string}|undefined)?.batchId),false);
  const selected=await settled(harness,(await harness.startRun({task:'How did alpha posts do?',requestId:'social-selected-scope',sourceIds:[first.source.id]})).id);
  assert.ok(selected.events.some(event=>(event.output as {batchId?:string}|undefined)?.batchId===first.batchId));
  assert.ok(!selected.events.some(event=>(event.output as {batchId?:string}|undefined)?.batchId===other.batchId));
  assert.ok(!JSON.stringify(selected.events).includes(other.batchId));
  const outside=await settled(harness,(await harness.startRun({task:'How did bravo posts do?',requestId:'social-outside-account',sourceIds:[first.source.id]})).id);
  assert.equal(outside.events.some(event=>(event.output as {batchId?:string}|undefined)?.batchId),false,'an unselected account cannot trigger another dataset or substitute the selected account');
});

test('older calculation receipts stay available only inside their original conversation', async t => {
  let sourceId='',datasetId='',firstReceipt='',secondReceipt='';
  const {harness}=fixture(t,async({messages})=>{
    const task=messages.findLast(message=>message.role==='user' && message.content.startsWith('Keep it in chat. Receipt'))!.content;
    const third=task.endsWith('three');
    if(!messages.at(-1)!.content.startsWith('TOOL RESULT'))return read(third ? firstReceipt : sourceId);
    const output=JSON.parse(messages.at(-1)!.content.split('\n').slice(1).join('\n'));
    if(!third && !output.sourceId)return json({type:'tool',name:'workspace.analyze_table',arguments:{datasetId,request:{metrics:['likes'],groupBy:task.endsWith('one')?'post':'platform',chart:'table'}}});
    const citation=third ? firstReceipt : output.sourceId;
    if(task.endsWith('one'))firstReceipt=citation;
    if(task.endsWith('two'))secondReceipt=citation;
    return json({type:'reply',content:`Saved evidence. [Calculation](source:${citation})`,citations:[citation]});
  });
  const input=harness.importTabularDataset(csvInput('receipts',30));sourceId=input.source.id;datasetId=input.id;
  const first=await settled(harness,(await harness.startRun({task:'Keep it in chat. Receipt one',requestId:'receipt-first-turn',sourceIds:[sourceId]})).id);
  const second=await settled(harness,(await harness.startRun({task:'Keep it in chat. Receipt two',requestId:'receipt-second-turn',parentRunId:first.id})).id);
  assert.equal(first.status,'completed',first.error??'');assert.equal(second.status,'completed',second.error??'');assert.notEqual(firstReceipt,secondReceipt);
  const third=await settled(harness,(await harness.startRun({task:'Keep it in chat. Receipt three',requestId:'receipt-third-turn',parentRunId:second.id})).id);
  assert.equal(third.status,'completed',third.error??'');assert.ok(third.sourceIds?.includes(firstReceipt));assert.ok(third.sourceIds?.includes(secondReceipt));
  await assert.rejects(harness.startRun({task:'Read this receipt in a different conversation.',requestId:'receipt-cross-session',sourceIds:[firstReceipt]}),{code:'unknown_source'});
});

test('a renamed repeat social upload during a run preserves its original descriptor and creation time', async t => {
  const {harness}=fixture(t,async()=>new Promise(()=>{}));
  const input={json:[{id:'stable',url:'https://www.instagram.com/p/stable/',ownerUsername:'alpha',type:'Image',timestamp:'2026-09-21T10:00:00Z',likesCount:10,commentsCount:1}],platform:'instagram' as const,accountId:'alpha',sourceName:'original.json',requestId:'immutable-social-import'};
  const saved=harness.importSocialDataset(input);
  const run=await harness.startRun({task:'Wait for instructions.',requestId:'immutable-social-run',sourceIds:[saved.source.id]});
  const repeated=harness.importSocialDataset({...input,sourceName:'renamed.json',requestId:'immutable-social-repeat'});
  assert.deepEqual(repeated,saved);assert.deepEqual(harness.listSocialDatasets(),[saved]);assert.deepEqual(harness.getSource(saved.source.id),saved.source);
  assert.deepEqual(harness.getRun(run.id)?.selectedSourceIds,[saved.source.id]);
  harness.cancelRun(run.id);await settled(harness,run.id);
});
