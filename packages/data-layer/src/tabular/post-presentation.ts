import type { AnalysisResult, NormalizedDataset, NormalizedRow } from './types.ts';

export interface PostPresentation {
  readonly label: string;
  readonly context: string;
  readonly postId: string;
  readonly url?: string;
}

export function groupPresentation(result: AnalysisResult, group: string, labels?: ReadonlyMap<string, PostPresentation>): { label: string; context?: string; postId?: string; url?: string } {
  const saved = labels?.get(group);
  if (saved) return saved;
  if (result.request.groupBy === 'account') {
    try {
      const parts: unknown = JSON.parse(group);
      if (Array.isArray(parts) && parts.length === 2 && typeof parts[0] === 'string' && (parts[1] === null || typeof parts[1] === 'string')) return {
        label: parts[1] ?? 'Account not specified',
        context: parts[0] === 'unspecified' ? undefined : parts[0],
      };
    } catch { /* Keep legacy labels readable. */ }
  }
  if (result.request.groupBy === 'post') {
    try {
      const parts: unknown = JSON.parse(group);
      if (Array.isArray(parts) && parts.length === 3 && typeof parts[2] === 'string') return {
        label: `Post ${result.rows.findIndex(row => row.group === group) + 1}`,
        context: [typeof parts[1] === 'string' ? parts[1] : '', parts[0] === 'unspecified' ? '' : parts[0]].filter(Boolean).join(' · '), postId: parts[2],
      };
    } catch { /* Old non-identity group labels remain readable. */ }
  }
  return { label: result.request.groupBy === 'platform' && group === 'unspecified' ? 'Platform not specified' : group };
}

export function exportGroupLabel(result: AnalysisResult, group: string, labels?: ReadonlyMap<string, PostPresentation>): string {
  const display = groupPresentation(result, group, labels);
  return [display.label, display.context].filter(Boolean).join(' · ');
}

export function postTextLabels(result: AnalysisResult, presentations?: ReadonlyMap<string, PostPresentation>): ReadonlyMap<string, string> {
  const labels = new Map<string, string>(), ambiguous = new Set<string>();
  result.rows.forEach((row, index) => {
    const post = presentations?.get(row.group);
    if (!post || !post.postId.startsWith('urn:')) return;
    if (labels.has(post.postId)) ambiguous.add(post.postId);
    labels.set(post.postId, `${post.label} (Post ${index + 1})`);
  });
  ambiguous.forEach(id => labels.delete(id));
  return labels;
}

export function replacePostText(text: string, labels: ReadonlyMap<string, string>): string {
  return text.replace(/urn:[a-zA-Z0-9_:.-]+/g, id => {
    if (labels.has(id)) return labels.get(id)!;
    const withoutPunctuation = id.replace(/\.+$/, '');
    return labels.has(withoutPunctuation) ? labels.get(withoutPunctuation)! + id.slice(withoutPunctuation.length) : id;
  });
}

const bounded = (text: string, limit = 120) => {
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return [...clean].length > limit ? `${[...clean].slice(0, limit).join('')}…` : clean;
};
const headerKey = (text: string) => text.toLowerCase().replace(/[ _-]/g, '');

/** Display metadata only. Never changes the row identity, mapping or calculation. */
export function postPresentation(dataset: NormalizedDataset, row: NormalizedRow, options: { includeSourceText?: boolean } = {}): PostPresentation {
  const cell = (keys: readonly string[]) => {
    const matches = dataset.headers.flatMap((header, index) => keys.includes(headerKey(header)) ? [row.rawCells[index]?.trim() ?? ''] : []);
    return matches.length === 1 ? matches[0] : '';
  };
  const title = options.includeSourceText === false ? '' : cell(['posttitle', 'title']) || cell(['posttext', 'caption', 'postcontent']);
  const type = bounded(row.contentType ?? '', 40);
  const date = row.publishedAt && Number.isFinite(Date.parse(row.publishedAt))
    ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(row.publishedAt)) : '';
  const description = [type ? type[0].toUpperCase() + type.slice(1) : 'Post', date].filter(Boolean).join(' · ');
  const label = title ? bounded(title) : date || type ? description : `Post from CSV row ${row.provenance.record}`;
  const platform = { linkedin: 'LinkedIn', facebook: 'Facebook', instagram: 'Instagram', unspecified: '' }[row.platform];
  let url: string | undefined;
  try {
    const candidate = new URL(cell(['posturl', 'permalink']));
    const domain = { linkedin: 'linkedin.com', facebook: 'facebook.com', instagram: 'instagram.com', unspecified: '' }[row.platform];
    if (domain && candidate.protocol === 'https:' && !candidate.username && !candidate.password && !candidate.port &&
        (candidate.hostname === domain || candidate.hostname === `www.${domain}`)) url = candidate.href;
  } catch { /* A missing or unsafe source URL is not a link. */ }
  return { label, context: [bounded(row.account ?? '', 80), platform, ...(title ? [description] : [])].filter(Boolean).join(' · '), postId: row.postId, ...(url ? { url } : {}) };
}

export function postPresentations(dataset: NormalizedDataset, result: AnalysisResult, options: { includeSourceText?: boolean } = {}): ReadonlyMap<string, PostPresentation> {
  if (result.request.groupBy !== 'post' || dataset.id !== result.datasetId || dataset.hash !== result.datasetHash || dataset.sourceHash !== result.sourceHash) return new Map();
  const rows = new Map(dataset.rows.map(row => [JSON.stringify([row.platform, row.account, row.postId]), row]));
  return new Map(result.rows.flatMap(({ group }) => {
    const row = rows.get(group);
    return row ? [[group, postPresentation(dataset, row, options)] as const] : [];
  }));
}
