import type { AnalysisResult, Grouping } from './types.ts';

export const GROUP_LABELS = { post: 'post', platform: 'platform', account: 'account', contentType: 'content type', day: 'publication day', week: 'publication week', month: 'publication month' } as const satisfies Record<Grouping, string>;

/** Present legacy group keys without changing saved columns or custom labels. */
export function analysisColumnLabel(column: Pick<AnalysisResult['columns'][number], 'id' | 'label'>, groupBy: Grouping): string {
  if (column.id !== 'group' || column.label !== groupBy || !Object.hasOwn(GROUP_LABELS, groupBy)) return column.label;
  const label = GROUP_LABELS[groupBy];
  return label[0].toUpperCase() + label.slice(1);
}
