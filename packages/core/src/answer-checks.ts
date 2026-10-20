import type { Run } from './types.ts';
import type { AnswerCheck, AnswerOutput, AnswerRecord } from './answers.ts';

/** A deliberately bounded observer, not a factual verifier or an enforcement gate. */
export function observeAnswer(task: string, output: AnswerOutput, answer: AnswerRecord): AnswerCheck[] {
  answer.question ??= task;
  task = answer.question;
  const native = output.sourceAnalysis?.result;
  const metrics: readonly string[] = output.tabularAnalysis?.result.request.metrics ?? (native
    ? native.metric ? [native.metric.id] : native.metrics.map(metric => metric.id)
    : output.socialAnalysis ? ['likes','comments'] : []);
  const concepts: [string, RegExp, string[]][] = [
    ['registrations', /\b(?:registrations?|signups?|sign[- ]ups?)\b/i, ['registrations']],
    ['clicks', /\bclicks?\b/i, ['totalClicks','uniqueClicks','clicks']],
    ['likes', /\blikes?\b/i, ['likes']],
    ['shares', /\bshares?\b/i, ['shares']],
    ['sessions', /\bsessions?\b/i, ['sessions']],
  ];
  const requested = concepts.filter(([,pattern]) => pattern.test(task));
  const mismatch = requested.filter(([, , ids]) => !ids.some(id => metrics.includes(id)));
  const observed = `Question: ${task}\nAsked for: ${requested.map(([name]) => name).join(', ') || 'No supported explicit metric recognized'}\nCalculated: ${metrics.join(', ') || 'No measured calculation'}\nAnswer type: ${answer.kind}`;
  const checks: AnswerCheck[] = [{ id: 'question-calculation',
    status: answer.kind !== 'measured' ? 'not-applicable' : metrics.length && requested.length ? mismatch.length ? 'would-have-blocked' : 'pass' : 'not-checked',
    detail: `${observed}\n${answer.kind !== 'measured' ? 'This is not a measured answer, so measured-metric matching does not apply. ' : mismatch.length ? `The saved calculation does not include ${mismatch.map(([name]) => name).join(', ')}. ` : ''}Observation only. This checks a small set of explicitly named metrics, not the full meaning of the question, dates or comparison. Generic conversions are not assumed to be registrations.` }];
  for (const [id, text] of [['title-result', 'title' in output ? output.title : ''], ['body-result', output.content]]) {
    const unsupported = answer.kind === 'measured' && !metrics.includes('registrations') && /\b(?:brought|generated|drove|resulted in)\s+(?:\d[\d,.]*\s+)?(?:registrations?|signups?|sign[- ]ups?)\b/i.test(text);
    checks.push({ id, status: unsupported ? 'would-have-blocked' : 'not-checked',
      detail: unsupported ? 'An outcome claim has no matching saved registration metric. Observation only; existing guards still apply.' : 'No supported general prose verifier ran. Absence of a recognized mismatch is not a pass.' });
  }
  if (answer.kind === 'hypothetical' && answer.estimate) {
    const { base, ratePercent, result } = answer.estimate;
    const same = [base, ratePercent, result].every(Number.isFinite) && result === Number((base * ratePercent / 100).toPrecision(12));
    checks.push({ id: 'estimate-arithmetic', status: same ? 'pass' : 'would-have-blocked',
      detail: same ? 'The saved result equals the saved base multiplied by the assumed percentage. This verifies the arithmetic only, not the base or the conversion assumption.' : 'The saved estimate does not match its base and rate.' });
  }
  checks.push({ id: 'saved-answer', status: 'not-checked', detail: 'Waiting for persisted answer comparison.' },
    { id: 'export-answer', status: 'not-checked', detail: 'No downloaded file has been checked for this answer.' });
  return checks;
}

export function recordSavedAnswerCheck(run: Run, readBack: Run): void {
  const output = run.result ?? run.reply, saved = readBack.result ?? readBack.reply;
  const check = output?.answer?.checks?.find(item => item.id === 'saved-answer');
  if (check) {
    const same = JSON.stringify(output) === JSON.stringify(saved);
    check.status = same ? 'pass' : 'would-have-blocked';
    check.detail = same ? 'The persisted answer matches the output, identity, inputs and calculations at save time. This does not verify its claims.' : 'The persisted answer differs from the output. Observation only.';
  }
}
