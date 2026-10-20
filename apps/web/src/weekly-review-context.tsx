import { CircleAlert } from 'lucide-react';
import type { WeeklyReviewMetadata } from '../../../packages/core/src/types';
import { weeklyReviewDates } from './weekly-review-presentation';

export function WeeklyReviewContext({ review }: { review: WeeklyReviewMetadata }) {
  const stale = ['partial', 'failed'].includes(review.presync.status);
  return <div className="weekly-report-context">
    <p>{weeklyReviewDates(review.period)}<span>{review.connectionIds.length} {review.connectionIds.length === 1 ? 'account' : 'accounts'}</span></p>
    {stale && <p className="weekly-report-warning" role="status"><CircleAlert size={15}/><span>Some accounts could not refresh. This review uses their last saved data.</span></p>}
    {review.missingConnectionIds.length > 0 && <p className="weekly-report-warning" role="status"><CircleAlert size={15}/><span>{review.missingConnectionIds.length} selected {review.missingConnectionIds.length === 1 ? 'account is' : 'accounts are'} missing from this review.</span></p>}
  </div>;
}
