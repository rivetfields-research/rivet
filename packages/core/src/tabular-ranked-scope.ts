import type { AnalysisResult, AnalysisValues } from '../../data-layer/src/tabular/types.ts';

/** Additive values only: rates cannot be summed or averaged across returned groups. */
export function rankedScopeFacts(result: AnalysisResult) {
  if (!result.selection?.omittedGroups) return undefined;
  const totals: Partial<Record<keyof AnalysisValues, number | null>> = {};
  for (const definition of result.definitions) {
    if (definition.aggregation === 'ratio_of_sums') continue;
    const values = result.rows.flatMap(row => typeof row[definition.id] === 'number' ? [row[definition.id] as number] : []);
    totals[definition.id] = values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  }
  return {
    scope: 'returned_groups_only' as const,
    groupCount: result.rows.length,
    totals,
    notice: 'These additive subtotals cover every returned chart/table/CSV group, not just the model row excerpt. Missing values remain missing; a subtotal adds only present values. Rates are omitted: never sum or average group rates. Label full-cohort totals and returned-group subtotals in separate sentences.',
  };
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const small = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
function countPattern(value: number): string {
  const word = value < 20 ? small[value] : value < 100
    ? `${['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'][Math.floor(value / 10)]}${value % 10 ? `[- ]${small[value % 10]}` : ''}` : undefined;
  return `(?:${[String(value), value.toLocaleString('en-US'), word].filter(Boolean).join('|')})`;
}

/** A narrow check for known full-cohort count totals attributed to a ranked subset. */
export function hasAmbiguousRankedTotal(content: string, result: AnalysisResult): boolean {
  const returned = rankedScopeFacts(result);
  if (!returned) return false;
  const units = '(?:posts?|videos?(?! posts?\\b)|rows?|records?|groups?|days?|weeks?|months?|platforms?|content types?)';
  const count = `(?:${countPattern(result.counts.includedRows)}|${countPattern(result.selection!.totalGroups)})`;
  // Only the executed single-type filter can label the whole filtered cohort.
  const contentType = result.request.contentTypes?.length === 1 ? `(?:${escape(result.request.contentTypes[0].toLowerCase())} )?` : '';
  const full = new RegExp(`\\b(?:full(?:[- ]filtered)?[- ](?:cohort|dataset|population)|(?:whole|entire) (?:filtered )?(?:dataset|cohort|population)|overall(?: totals?)?|all (?:the )?(?:(?:matching|filtered|uploaded) )?(?:${count} )?${contentType}${units}|across (?:all )?${count} (?:matching |filtered )?${contentType}${units})\\b`, 'g');
  const subset = /\b(?:(?:top|bottom)[- ](?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|twenty|fifty|hundred)|(?:shown|displayed|returned|these|those) (?:\d+ )?(?:posts?|videos?|rows?|groups?)|(?:posts?|videos?|rows?|groups?) (?:shown|displayed|returned))\b/g;
  const text = content.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').toLowerCase();
  // Keep decimal points and grouped thousands within a claim, but reset scope at sentence boundaries.
  const clauses = text.split(/(?<!\d)\.|\.(?!\d)|[!?;\n]+/);
  for (const clause of clauses) {
    const scopes = [...clause.matchAll(full)].map(match => ({ index: match.index, full: true }))
      .concat([...clause.matchAll(subset)].map(match => ({ index: match.index, full: false }))).sort((a, b) => a.index - b.index);
    for (const definition of result.definitions) {
      const total = result.totals[definition.id];
      if (definition.aggregation === 'ratio_of_sums' || typeof total !== 'number' || total === returned.totals[definition.id]) continue;
      const label = escape(definition.label.toLowerCase());
      const number = '(?<![\\w.,])(\\d[\\d,]*(?:\\.\\d+)?)';
      const patterns = [new RegExp(`${number}\\s+(?:(?:recorded|total|combined)\\s+)?${label}\\b`, 'g'),
        new RegExp(`\\b${label}\\s*(?:(?:total|totaling|totalling|of|are|is|were|was)\\s*)?[:=]?\\s*${number}(?![\\w.,])`, 'g')];
      for (const pattern of patterns) for (const match of clause.matchAll(pattern)) {
        if (Number(match[1].replaceAll(',', '')) !== total) continue;
        const before = clause.slice(0, match.index);
        if (/\b(?:not|never|(?:do|does|did) not (?:total|sum to|amount to))\s*$/.test(before)) continue;
        const preceding = scopes.filter(scope => scope.index < match.index).at(-1);
        const scope = preceding ?? scopes.find(scope => scope.index > match.index);
        if (!scope?.full) return true;
      }
    }
  }
  return false;
}

export function rankedScopeCorrection(result: AnalysisResult): string {
  const returned = rankedScopeFacts(result);
  return `The saved totals cover all ${result.counts.includedRows} filtered posts before ranking, not just the ${result.rows.length} returned groups. Full-cohort totals: ${JSON.stringify(result.totals)}. Returned-group additive subtotals: ${JSON.stringify(returned?.totals ?? {})}. Put each population in a separate sentence: label full totals with "Across all ${result.counts.includedRows} filtered posts" and returned subtotals with "The ${result.rows.length} shown groups". Do not average rates or replace missing values with zero.`;
}
