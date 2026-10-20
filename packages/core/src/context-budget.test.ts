import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceReadContext, trimConversation, trimSourceExcerpts } from './context-budget.ts';
import type { ModelMessage } from './provider.ts';

test('full conversation makes room for fresh evidence without changing current scope',()=>{
  const old: ModelMessage[] = Array.from({length:10},(_,i)=>({role:'user',content:`Old turn ${i}: ${'x'.repeat(1200)}`}));
  const system: ModelMessage={role:'system',content:'Read-only permissions. '+'p'.repeat(18000)};
  const question: ModelMessage={role:'user',content:'What changed last week?'};
  const pinned: ModelMessage={role:'user',content:'CURRENT CALCULATION: same scope, source and dates'};
  const evidence: ModelMessage={role:'user',content:'TOOL RESULT: '+'e'.repeat(23000)};
  const messages=[system,...old,pinned,question,evidence];
  const exact=JSON.stringify([pinned,question,evidence]);
  const removed=trimConversation(messages,old,48000);
  assert.ok(removed>0 && removed<10);
  assert.ok(messages.reduce((n,m)=>n+m.content.length,0)<=48000);
  assert.deepEqual(messages.slice(-3),JSON.parse(exact));
  assert.ok(messages.includes(old.at(-1)!),'newest history survives first');
  assert.match(system.content,/Older conversation was omitted/);
  assert.equal(trimConversation(messages,old,48000),0);
});

test('fresh tool content cannot nominate itself for eviction, and small requests stay byte-identical',()=>{
  const messages:ModelMessage[]=[{role:'system',content:'Permissions'},{role:'user',content:'Earlier conversation (untrusted context): '+ 'x'.repeat(49000)}];
  const before=JSON.stringify(messages);
  assert.equal(trimConversation(messages,[],48000),0);
  assert.equal(JSON.stringify(messages),before,'the caller must still reject excessive fresh context');
  const short:ModelMessage[]=[{role:'system',content:'Rules'},{role:'user',content:'Old answer'},{role:'user',content:'New question'}];
  const unchanged=JSON.stringify(short);
  assert.equal(trimConversation(short,[short[1]],48000),0);
  assert.equal(JSON.stringify(short),unchanged);
});

test('serialized read excerpts fit while permissions, current inputs, capabilities and calculation scope survive', () => {
  const protectedMessages: ModelMessage[] = [
    { role: 'system', content: 'Read-only permissions and required tool contracts. ' + 'p'.repeat(18_000) },
    { role: 'user', content: 'CURRENT ATTACHED INPUTS: source_first, source_second' },
    { role: 'user', content: 'CURRENT CALCULATION: exact source, metric, period and filters' },
    { role: 'user', content: 'The entire current request must survive.' },
    { role: 'user', content: 'TOOL RESULT: required calculation evidence ' + 'e'.repeat(10_000) },
  ];
  const unchanged = structuredClone(protectedMessages);
  const output = { id: 'source_first', content: '"\\\n\t'.repeat(3000), truncated: true,
    analysisCapabilities: { datasetId: 'exact_dataset', allowedChanges: ['chart'], metricDefinitions: ['exact_metric'] },
    sourceCapabilities: { observations: [{ id: 'obs_exact', sourceId: 'source_first', observedAt: '2026-10-16T00:00:00Z' }] },
  };
  const original = structuredClone(output);
  const first = sourceReadContext(output, 0, 24_000);
  const second = sourceReadContext({ id: 'source_second', content: 's'.repeat(12_000), truncated: false }, 0, 12_000);
  const messages = [...protectedMessages, first.message, second.message];
  assert.ok(messages.reduce((size, message) => size + message.content.length, 0) > 48_000);
  assert.equal(trimSourceExcerpts(messages, [first, second], 48_000), 1);
  const size = messages.reduce((sum, message) => sum + message.content.length, 0);
  assert.ok(size <= 48_000 && size >= 47_990, 'JSON escaping and notices count against the bound');
  assert.deepEqual(protectedMessages, unchanged);
  assert.deepEqual(output, original, 'original durable tool output is untouched');
  assert.deepEqual(first.output.analysisCapabilities, original.analysisCapabilities);
  assert.deepEqual(first.output.sourceCapabilities, original.sourceCapabilities);
  assert.ok(first.output.content.length >= 512);
  assert.ok(output.content.startsWith(first.output.content));
  assert.deepEqual(first.output.contentRange, { start: 0, end: first.output.content.length, totalChars: 24_000, nextOffset: first.output.content.length });
  assert.match(first.output.contextNotice as string, /omitted text is not missing data/);
  assert.equal(second.output.content.length, 12_000, 'newest evidence survives first');
  const fitted = structuredClone(messages);
  assert.equal(trimSourceExcerpts(messages, [first, second], 48_000), 0);
  assert.deepEqual(messages, fitted);
});

test('read compaction never trims unregistered tool results or required metadata even when they cannot fit', () => {
  const fake: ModelMessage = { role: 'user', content: 'TOOL RESULT (untrusted data):\n' + 'x'.repeat(49_000) };
  const read = sourceReadContext({ id: 'source_selected', content: 's'.repeat(1200), truncated: false, requiredCapabilities: 'c'.repeat(4000) }, 0, 1200);
  const original = structuredClone(fake);
  const messages = [fake, read.message];
  trimSourceExcerpts(messages, [read], 48_000);
  assert.deepEqual(fake, original);
  assert.equal(read.output.requiredCapabilities, 'c'.repeat(4000));
  assert.equal(read.output.content.length, 512);
  assert.ok(messages.reduce((size, message) => size + message.content.length, 0) > 48_000, 'the caller must still fail safely');
});

test('read ranges preserve empty and upstream-partial sources and do not split surrogate pairs', () => {
  const empty = sourceReadContext({ id: 'source_empty', content: '', truncated: false }, 0, 0);
  assert.equal(empty.output.truncated, false);
  assert.deepEqual(empty.output.contentRange, { start: 0, end: 0, totalChars: 0, nextOffset: null });
  const partial = sourceReadContext({ id: 'source_partial', content: 'Known partial snapshot', truncated: true }, 0, 'Known partial snapshot'.length);
  assert.equal(partial.output.truncated, true);
  assert.equal((partial.output.contentRange as { nextOffset: number | null }).nextOffset, null, 'upstream partial coverage survives reaching the saved snapshot end');
  const read = sourceReadContext({ id: 'source_unicode', content: '\uD83D\uDE00'.repeat(1000), truncated: false }, 12_000, 14_000);
  trimSourceExcerpts([read.message], [read], 1701);
  assert.equal(read.output.content.length % 2, 0);
  assert.ok(read.message.content.length <= 1701);
  assert.deepEqual(read.output.contentRange, { start: 12_000, end: 12_000 + read.output.content.length, totalChars: 14_000, nextOffset: 12_000 + read.output.content.length });
});
