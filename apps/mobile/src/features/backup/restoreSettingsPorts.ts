import type {
  Immutable,
  PortableRestoreReview,
  PortableRestoreService,
  PreparedPortableRestore,
  RepositoryResult,
} from '@cookmate/domain';

/** Presentation only. The service retains authority over the exact issued review object. */
export type RestoreReviewPresentation = Omit<Immutable<PortableRestoreReview>, 'blockers'> & {
  readonly blockers: readonly string[];
};
export interface RestoreSettingsPort<Review extends RestoreReviewPresentation> {
  review(serialized: string): Promise<RepositoryResult<Review>>;
  prepare(review: Review): Promise<RepositoryResult<Immutable<PreparedPortableRestore>>>;
  execute: PortableRestoreService['execute'];
  readReceipt: PortableRestoreService['readReceipt'];
  readArchive: PortableRestoreService['readArchive'];
}
