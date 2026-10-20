const files = '(?:both|all|(?:the\\s+)?(?:two|2))\\s+(?:(?:selected|attached|uploaded|csv)\\s+){0,2}(?:files|csvs|uploads|datasets)\\b';
const scope = `\\b(?:across|from|in|for|of)\\s+${files}`;
const aggregate = '\\b(?:totals?|sum|combined|aggregate|overall)\\b';
const totalAcrossFiles = new RegExp(`${aggregate}[^.!?;\\n]{0,80}${scope}|${scope}[^.!?;\\n]{0,80}${aggregate}`);
const combineFiles = new RegExp(`\\b(?:combine|merge|sum|aggregate|add)\\b[^.!?;\\n]{0,60}\\b${files}`);

/** Recognize explicit combination wording, not arbitrary multi-source intent.
 * Comparisons, named-file requests and negated combination clauses stay outside this guard. */
export function requestsCombinedCsv(task: string): boolean {
  return task.toLowerCase().replace(/\u2019/g, "'").split(/[.!?;\n]/).some(clause =>
    !/\b(?:do not|don't|never|without|cannot|can't|instead of|rather than)\b/.test(clause) &&
    (totalAcrossFiles.test(clause) || combineFiles.test(clause)));
}

export const COMBINED_CSV_LIMITATION = 'CSV tools cannot combine uploads or deduplicate overlapping files. A one-file calculation cannot answer this combined-file request. Explain this calculation limitation and offer one-file analysis; do not substitute a partial total.';

export const COMBINED_CSV_EXPLANATION = 'CSV tools cannot combine uploads or deduplicate overlapping files, so I cannot calculate a total across these files. I can analyze one file at a time; choose which file to use.';
