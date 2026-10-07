import type { AdminDraft } from '../src/contracts';
import { Badge, Photo } from './components';
import { ReviewRecord } from './ReviewRecord';
import { RightsRecords } from './RightsPanel';
import { MetadataRecords } from './MetadataRecords';

export function RecipePreview({
  draft,
  showMetadata = false,
  unsaved = false,
}: {
  draft: AdminDraft;
  showMetadata?: boolean;
  /** Saved approval and permissions are not evidence for a changed working copy. */
  unsaved?: boolean;
}) {
  return (
    <article className="recipe-preview">
      <Photo url={draft.photoUrl} title={draft.input.title || 'Untitled recipe'} />
      <div className="preview-body">
        <p className="eyebrow">
          {draft.input.cuisine || 'Cuisine not set'} · {draft.input.category || 'Category not set'}
        </p>
        <h2>{draft.input.title || 'Untitled recipe'}</h2>
        {unsaved ? (
          <p className="small muted">Unsaved working copy · requires a new review</p>
        ) : (
          <>
            <Badge status={draft.status} />
            <ReviewRecord review={draft.review} />
            <RightsRecords rights={draft.rights} revision={draft.revision} />
          </>
        )}
        {showMetadata && !unsaved && (
          <section aria-label="Saved optional metadata">
            <h3>Optional reviewed details · revision {draft.revision}</h3>
            <p className="small muted">
              Values and operator evidence retained in this revision. These are not independent
              verification or an allergy-safety guarantee.
            </p>
            <MetadataRecords metadata={draft.metadata} />
          </section>
        )}
        {draft.input.description && <p className="original-text">{draft.input.description}</p>}
        <h3>Ingredients</h3>
        <ul className="preview-ingredients">
          {draft.input.ingredients.map((item, index) => (
            <li key={index}>
              <span>{item.rawName || 'Ingredient not entered'}</span>
              <span>{item.rawMeasure ?? 'Amount not supplied'}</span>
            </li>
          ))}
        </ul>
        <h3>Instructions</h3>
        {draft.input.instructions.map((item, index) =>
          item.presentation === 'heading' ? (
            <h4 className="original-text" key={index}>
              {item.rawText || 'Heading not entered'}
            </h4>
          ) : (
            <p className="original-text" key={index}>
              {item.rawText || 'Passage not entered'}
            </p>
          ),
        )}
        <h3>Video & credits</h3>
        {draft.input.videoUrl ? (
          <p className="url-text">{draft.input.videoUrl}</p>
        ) : (
          <p>No video link supplied.</p>
        )}
        <p className="small muted">
          Video links are shown for review. This editor does not load an external player.
        </p>
        {draft.input.recipePage && (
          <p className="url-text">Recipe collection: {draft.input.recipePage}</p>
        )}
        {draft.input.originalSourceUrl && (
          <p className="url-text">Original publisher: {draft.input.originalSourceUrl}</p>
        )}
        {draft.input.credits.map((credit, index) => (
          <p className="url-text" key={index}>
            {credit.label}
            {credit.url ? ` · ${credit.url}` : ''}
          </p>
        ))}
      </div>
    </article>
  );
}
