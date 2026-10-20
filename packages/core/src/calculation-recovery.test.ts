import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHarness, type ModelProvider, type Run} from './index.ts';
import {HarnessError} from './errors.ts';
import type {RunAccessContext} from './types.ts';
import type {CsvMapping} from '../../data-layer/src/tabular/types.ts';

// Fresh, explicitly fictional dataset; zeros and missing values are different.
const csv = 'id,date,likes,comments\na,2026-08-01,7,1\nb,2026-08-02,0,0\nc,2026-08-03,,2\nd,2026-08-04,19,\ne,2026-08-05,5,3\n';
const mapping: CsvMapping = {confirmed:true, platform:'facebook', account:'Recovery QA', timezone:'UTC', columns:{postId:'id',publishedAt:'date',likes:'likes',comments:'comments'}};
const request = {metrics:['likes','comments'], groupBy:'day', chart:'combo', timezone:'UTC'};
const actor: RunAccessContext = {workspaceId:'recovery-test',actor:{issuer:'https://identity.example',subject:'alice'}};
const json = (action: unknown) => ({content:JSON.stringify(action),usage:{inputTokens:10,outputTokens:10}});
async function settle(h: ReturnType<typeof createHarness>, id: string): Promise<Run> {
  for (let i=0;i<300;i++) {
    const run=h.getRun(id)!;
    if (!h.activeRunId() && !['running','queued'].includes(run.status)) return run;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw new Error('Scripted recovery did not settle');
}
function fixture(t: TestContext, hosted=false, dailyRunLimit?: number, inputCsv=csv) {
  const root=mkdtempSync(join(tmpdir(),'calculation-recovery-')); mkdirSync(join(root,'sources'));
  let step=0, sourceId='', datasetId='', receipt='', allowed=true;
  let explanation: ModelProvider['complete'] = async()=>{throw new HarnessError('Explanation interrupted.',502,'provider_empty_response');};
  const provider: ModelProvider = {
    status:async()=>({configured:true,available:true,model:'scripted-recovery',kind:'openai-compatible',label:'Scripted recovery',message:'No paid inference'}),
    complete:async input=>{
      if (step++===0) return json({type:'tool',name:'workspace.read',arguments:{sourceId}});
      if (step===2) return json({type:'tool',name:'workspace.analyze_table',arguments:{datasetId,request}});
      const current=h.getRun(h.activeRunId()!)!;
      assert.ok(current.savedCalculation,'complete result is durable before the explanation call');
      receipt=current.savedCalculation.analysis.sourceId;
      return explanation(input);
    },
  };
  const options={dataDir:join(root,'data'),sourceDir:join(root,'sources'),modelBaseUrl:'http://127.0.0.1:8001/v1',provider,dailyRunLimit,
    ...(hosted?{authorization:{workspaceId:actor.workspaceId,checkPermission:async()=>{if(!allowed)throw new Error('Revoked');}}}:{})};
  let h=createHarness(options);
  const saved=h.importTabularDataset({csv:inputCsv,sourceName:'fictional-recovery-journey.csv',mapping}); sourceId=saved.source.id; datasetId=saved.id;
  t.after(async()=>{await h.close();rmSync(root,{recursive:true,force:true});});
  const context=hosted?actor:undefined;
  return {
    get h(){return h;}, sourceId, context,
    fail:async()=>settle(h,(await h.startRun({task:'Create a chart report for every uploaded post.',requestId:'recovery-original-0001',sourceIds:[sourceId]},context)).id),
    explanation:(next:ModelProvider['complete'])=>{explanation=next;},
    succeed:()=>{explanation=async({messages})=>{
      assert.match(messages.at(-2)!.content,/Tools are disabled/);
      assert.match(messages.at(-1)!.content,/SAVED CALCULATION/);
      assert.doesNotMatch(messages.map(m=>m.content).join('\n'),/Earlier conversation/);
      return json({type:'finish',title:'Recovered recorded counts',content:`The imported records contain 31 likes. [Calculation](source:${receipt})`,citations:[receipt]});
    };},
    revoke:()=>{allowed=false;},
    reopen:async()=>{await h.close();h=createHarness(options);},
  };
}

test('calculation survives explanation failure and restart with full rows, evidence and compact summaries',async t=>{
  const f=fixture(t), run=await f.fail();
  assert.equal(run.status,'failed'); assert.equal(run.errorCode,'provider_empty_response'); assert.equal(run.result,null);
  const saved=run.savedCalculation!;
  assert.equal(saved.analysis.result.totals.likes,31); assert.equal(saved.analysis.result.totals.comments,6);
  assert.equal(saved.analysis.result.rows.length,5);
  assert.equal(saved.analysis.result.metricCoverage.likes?.missingRows,1);
  assert.equal(saved.analysis.result.rows[1].likes,0); assert.equal(saved.analysis.result.rows[2].likes,null);
  assert.equal(f.h.listRuns()[0].hasSavedCalculation,true);
  assert.equal(Object.hasOwn(f.h.listRuns()[0],'savedCalculation'),false);
  await f.reopen();
  assert.deepEqual(f.h.getRun(run.id)!.savedCalculation,saved);
  assert.deepEqual(f.h.getSourceCalculation(saved.analysis.sourceId)?.analysis,saved.analysis);
});

test('failed explanations preserve every group beyond the model receipt excerpt',async t=>{
  const many='id,date,likes,comments\n'+Array.from({length:57},(_,i)=>`${i},${new Date(Date.UTC(2026,0,i+1)).toISOString()},${i+1},0`).join('\n');
  const f=fixture(t,false,undefined,many), run=await f.fail();
  assert.equal(run.status,'failed');
  const saved=run.savedCalculation!.analysis;
  assert.equal(saved.result.rows.length,57);
  assert.equal(saved.result.totals.likes,1653);
  await f.reopen();
  assert.deepEqual(f.h.getSourceCalculation(saved.sourceId)?.analysis,saved);
  assert.equal(f.h.getRun(run.id)!.savedCalculation!.analysis.result.rows[56].likes,57);
});

test('explicit retry reuses the exact calculation, deduplicates concurrent clicks and preserves the failed attempt',async t=>{
  const f=fixture(t), first=await f.fail(); await f.reopen(); f.succeed();
  const [one,two]=await Promise.all([f.h.retryExplanation(first.id,'recovery-retry-0001'),f.h.retryExplanation(first.id,'recovery-retry-0001')]);
  assert.equal(one.id,two.id);
  const retried=await settle(f.h,one.id);
  assert.equal(retried.status,'completed',retried.error??'');
  assert.equal(retried.parentRunId,first.id); assert.equal(retried.explanationRetryOf,first.id);
  assert.deepEqual(retried.result!.tabularAnalysis,first.savedCalculation!.analysis);
  assert.deepEqual(retried.savedCalculation,first.savedCalculation);
  assert.equal(retried.events.filter(e=>e.type==='tool_call').length,0);
  assert.equal(retried.events.filter(e=>e.streamPhase==='started').length,1);
  assert.equal(f.h.getRun(first.id)!.status,'failed'); assert.equal(f.h.listRuns().length,2);
  assert.equal((await f.h.retryExplanation(first.id,'recovery-retry-0001')).id,retried.id);
  await assert.rejects(f.h.retryExplanation(first.id,'recovery-retry-0002'),{code:'stale_conversation'});
  await assert.rejects(f.h.startRun({task:first.task,parentRunId:first.id,requestId:'recovery-retry-0001'}),{code:'request_id_conflict'});
  await assert.rejects(f.h.retryExplanation(retried.id,'recovery-retry-0003'),{code:'calculation_unavailable'});
});

test('an explanation retry cannot replay tools or change saved metrics even when the model asks',async t=>{
  const f=fixture(t), first=await f.fail();
  f.explanation(async()=>json({type:'tool',name:'workspace.analyze_table',arguments:{datasetId:first.savedCalculation!.analysis.datasetId,request:{...request,metrics:['shares']}}}));
  const retry=await settle(f.h,(await f.h.retryExplanation(first.id,'recovery-tools-denied')).id);
  assert.equal(retry.status,'failed'); assert.equal(retry.errorCode,'invalid_action');
  assert.equal(retry.events.filter(e=>e.type==='tool_call').length,0);
  assert.equal(retry.events.filter(e=>e.streamPhase==='started').length,3,'normal two-correction bound still applies');
  assert.deepEqual(retry.savedCalculation,first.savedCalculation);
});

test('factual-claim failure can recover after restart without loosening validation or recalculating', async t => {
  const f = fixture(t);
  f.explanation(async () => {
    const receipt = f.h.getRun(f.h.activeRunId()!)!.savedCalculation!.analysis.sourceId;
    return json({type: 'finish', title: 'Recorded counts', content: `Counts are lifetime totals with unknown timing. [Calculation](source:${receipt})`, citations: [receipt]});
  });
  const failed = await f.fail();
  assert.equal(failed.errorCode, 'invalid_tabular_narrative');
  assert.equal(failed.result, null);
  assert.equal(failed.events.filter(e => e.toolName === 'workspace.analyze_table' && e.type === 'tool_call').length, 1);
  await f.reopen();
  f.succeed();
  const recovered = await settle(f.h, (await f.h.retryExplanation(failed.id, 'recovery-factual-claim')).id);
  assert.equal(recovered.status, 'completed', recovered.error ?? '');
  assert.deepEqual(recovered.result!.tabularAnalysis, failed.savedCalculation!.analysis);
  assert.equal(recovered.events.filter(e => e.type === 'tool_call').length, 0);
  assert.equal(recovered.events.filter(e => e.streamPhase === 'started').length, 1);
  assert.equal(f.h.getRun(failed.id)!.errorCode, 'invalid_tabular_narrative');
});

test('retry checks actor, membership and archived inputs before any new model work',async t=>{
  const f=fixture(t,true), first=await f.fail();
  await assert.rejects(f.h.retryExplanation(first.id,'recovery-other-actor',{...actor,actor:{...actor.actor,subject:'bob'}}),{code:'request_id_conflict'});
  f.h.setSourceArchived(f.sourceId,true);
  await assert.rejects(f.h.retryExplanation(first.id,'recovery-archived',actor),{code:'source_archived'});
  f.h.setSourceArchived(f.sourceId,false); f.revoke();
  await assert.rejects(f.h.retryExplanation(first.id,'recovery-revoked',actor),{code:'run_permission_denied'});
  assert.equal(f.h.listRuns().length,1); assert.deepEqual(f.h.getRun(first.id)!.savedCalculation,first.savedCalculation);
});

test('retry respects the daily allowance and a provider budget refusal preserves the result again',async t=>{
  const limited=fixture(t,false,1), first=await limited.fail();
  await assert.rejects(limited.h.retryExplanation(first.id,'recovery-daily-limit'),{code:'daily_run_limit'});
  const f=fixture(t), original=await f.fail();
  f.explanation(async()=>{throw new HarnessError('Model allowance reached.',429,'model_budget_exhausted');});
  const retry=await settle(f.h,(await f.h.retryExplanation(original.id,'recovery-model-limit')).id);
  assert.equal(retry.errorCode,'model_budget_exhausted'); assert.deepEqual(retry.savedCalculation,original.savedCalculation);
});

for (const stop of ['cancel','restart'] as const) test(`calculation survives ${stop} during explanation`,async t=>{
  const f=fixture(t);
  let reached!:()=>void; const waiting=new Promise<void>(resolve=>{reached=resolve;});
  f.explanation(async({signal})=>{reached();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));});
  await f.h.startRun({task:'Create a chart report.',requestId:`stop-explanation-${stop}`,sourceIds:[f.sourceId]}); await waiting;
  const id=f.h.activeRunId()!, saved=f.h.getRun(id)!.savedCalculation;
  if(stop==='cancel') f.h.cancelRun(id); else await f.h.close();
  if (stop==='cancel') await settle(f.h,id);
  await f.reopen();
  assert.equal(f.h.getRun(id)!.status,stop==='cancel'?'cancelled':'interrupted');
  assert.deepEqual(f.h.getRun(id)!.savedCalculation,saved);
  f.succeed(); const retry=await settle(f.h,(await f.h.retryExplanation(id,`recovery-after-${stop}`)).id);
  assert.equal(retry.status,'completed',retry.error??''); assert.deepEqual(retry.result!.tabularAnalysis,saved!.analysis);
});
