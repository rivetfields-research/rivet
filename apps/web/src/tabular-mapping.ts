import { COUNT_METRICS, type CanonicalField, type CsvMapping } from '../../../packages/data-layer/src/tabular/types';
import type { DataDiagnostic } from '../../../packages/data-layer/src/errors';

// Exact normalized labels only. No substring guesses, numeric-value guesses or
// platform inference. Only unique matches can take the automatic import path;
// the server must still validate every row before saving.
const ALIASES: Readonly<Record<CanonicalField, readonly string[]>> = {
  postId: ['postid', 'postidentifier', 'id'],
  publishedAt: ['publishedat', 'published', 'publicationtime', 'publicationdate', 'postpublishedat', 'postdate'],
  account: ['account', 'accountname', 'accountid', 'profilename', 'pagename'],
  contentType: ['contenttype', 'posttype', 'type'],
  likes: ['likes', 'likecount', 'likescount', 'numlikes'],
  reactions: ['reactions', 'reactioncount', 'reactionscount', 'numreactions'],
  comments: ['comments', 'commentcount', 'commentscount', 'numcomments'],
  shares: ['shares', 'sharecount', 'sharescount', 'numshares'],
  impressions: ['impressions', 'impressioncount', 'impressionscount', 'numimpressions'],
  clicks: ['clicks', 'clickcount', 'clickscount', 'numclicks'],
  saves: ['saves', 'savecount', 'savescount', 'numsaves'],
};
const key = (header: string) => header.trim().toLowerCase().replace(/[ _-]/g, '');

export function suggestCsvColumns(headers: readonly string[]): {
  columns: Partial<Record<CanonicalField, string>>;
  ambiguous: readonly CanonicalField[];
} {
  const columns: Partial<Record<CanonicalField, string>> = {}, ambiguous: CanonicalField[] = [];
  for (const [field, aliases] of Object.entries(ALIASES) as [CanonicalField, readonly string[]][]) {
    const matches = headers.filter(header => aliases.includes(key(header)));
    if (matches.length === 1) columns[field] = matches[0];
    else if (matches.length > 1) ambiguous.push(field);
  }
  return { columns, ambiguous };
}

export function csvImportReady(columns: CsvMapping['columns'], unresolved: readonly CanonicalField[]): boolean {
  return Boolean(columns.postId && COUNT_METRICS.some(metric => columns[metric]) && !unresolved.length);
}

export function importFix(diagnostic: DataDiagnostic): string {
  switch (diagnostic.code) {
    case 'invalid_metric': return 'Check the selected column. Use whole counts such as 1200, without commas, decimals or %. Leave unknown values blank.';
    case 'invalid_date': return 'Use an ISO date such as 2026-09-01T10:00:00Z. For dates without an offset, confirm UTC only if that is their actual timezone.';
    case 'duplicate_post': return 'Keep one observation for each account and post ID in this file. Choose the intended observation; do not add repeated counts together.';
    case 'missing_post_id': return 'Choose the column containing a stable ID for every post, or fill the missing ID in the original file.';
    case 'missing_account': return 'Choose the account column, or enter one account name for rows without an account.';
    case 'column_count': return 'Check commas and quoted cells in this record. Each record must match the header column count.';
    default: return 'Review the mapping or correct the original CSV, then try again. No rows have been skipped or changed.';
  }
}
