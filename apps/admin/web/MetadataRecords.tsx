import type { ReviewedMetadata } from '@cookmate/catalogue/content';
import type { AdminMetadataField } from '../src/contracts';
import { formatTime } from './components';
import { metadataLabels, nutritionLabels } from './metadataForm';

/** Read-only saved values and their operator evidence, including historical revisions. */
export function MetadataRecords({ metadata }: { metadata: ReviewedMetadata }) {
  return (
    <>
      {(Object.keys(metadataLabels) as AdminMetadataField[]).map((field) => {
        const row = metadata[field];
        return (
          <details className="rights-record" key={field}>
            <summary>
              {metadataLabels[field]} · {row.value === null ? 'Unknown' : 'Evidence recorded'}
            </summary>
            {row.value !== null && (
              <p className="original-text">
                {field === 'nutrition'
                  ? Object.entries(row.value as object)
                      .map(
                        ([key, value]) =>
                          `${key === 'basis' ? 'Basis' : nutritionLabels[key as keyof typeof nutritionLabels]}: ${value === null ? 'Unknown' : String(value).replaceAll('_', ' ')}`,
                      )
                      .join('\n')
                  : Array.isArray(row.value)
                    ? row.value.join(', ') || 'No tags recorded'
                    : String(row.value)}
              </p>
            )}
            {row.review && (
              <>
                <p className="original-text">{row.review.source}</p>
                <p className="small muted">
                  Recorded by {row.review.reviewerId} · {formatTime(row.review.reviewedAt)}
                </p>
              </>
            )}
          </details>
        );
      })}
    </>
  );
}
