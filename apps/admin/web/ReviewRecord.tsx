import type { AdminReviewRecord } from '../src/contracts';
import { formatTime } from './components';

export function ReviewRecord({ review }: { review: AdminReviewRecord | null | undefined }) {
  if (!review) return null;
  return (
    <section className="recorded-review" aria-label="Recorded review">
      <strong>
        {review.decision === 'changes_requested' ? 'Changes requested' : 'Approval recorded'}
      </strong>
      <p className="original-text">{review.note || 'No review note supplied.'}</p>
      <p className="small muted">
        Stored review of revision {review.inputRevision} · {review.reviewerId} ·{' '}
        {formatTime(review.reviewedAt)}
      </p>
    </section>
  );
}
