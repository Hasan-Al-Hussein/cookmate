import { useId, useState } from 'react';
import type { AdminDraft } from '../src/contracts';
import { Notice } from './components';
import { RecipePreview } from './RecipePreview';

const sizes = [
  { id: 'phone', label: '428 × 926', width: 428, height: 926 },
  { id: 'narrow', label: '390 × 844', width: 390, height: 844 },
  { id: 'wide', label: 'Full width', width: '100%', height: 'auto' },
] as const;

/** Unscaled draft layout inspection. It is never an adopted recipe or a native-device proof. */
export function RecipePreviewPanel({ draft, unsaved }: { draft: AdminDraft; unsaved: boolean }) {
  const id = useId();
  const [size, setSize] = useState<(typeof sizes)[number]>(sizes[0]);
  return (
    <section className="draft-preview-panel" aria-label="Recipe layout preview">
      <Notice
        title={unsaved ? 'Preview of unsaved edits' : `Preview of saved revision ${draft.revision}`}
      >
        This editorial preview does not publish or change the app. Saved approval and permissions
        apply only to their exact saved revision.
      </Notice>
      <div className="preview-size-controls" role="group" aria-label="Preview size">
        {sizes.map((option) => (
          <button
            key={option.id}
            className="secondary"
            aria-pressed={size.id === option.id}
            aria-controls={id}
            onClick={() => setSize(option)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="small muted" id={`${id}-note`}>
        {size.id === 'wide'
          ? 'Flexible editorial layout.'
          : `${size.label} CSS pixels at 100% scale. Scroll within the preview to read the complete recipe.`}{' '}
        This is not the running app or a physical-iPhone check. Video links stay inactive here.
      </p>
      <div className="preview-scrollport">
        <div
          id={id}
          className="preview-viewport"
          data-size={size.id}
          style={{ width: size.width, height: size.height }}
          tabIndex={0}
          role="region"
          aria-label={`${size.label} recipe preview`}
          aria-describedby={`${id}-note`}
        >
          <RecipePreview draft={draft} unsaved={unsaved} showMetadata={!unsaved} />
        </div>
      </div>
    </section>
  );
}
