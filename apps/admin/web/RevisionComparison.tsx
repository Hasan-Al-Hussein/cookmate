import { useEffect, useMemo, useRef, useState } from 'react';
import type { AdminDraft } from '../src/contracts';
import { compareSavedRevisions, type ComparisonLine } from './revisionComparisonData';

export function TranslationStatus() {
  return (
    <p className="small muted">
      <strong>Translation status unavailable.</strong> Saved revisions do not record a language or a
      reviewed translation. No translation has been inferred here.
    </p>
  );
}
function SavedValues({
  revision,
  label,
  lines,
}: {
  revision: number;
  label: string;
  lines: ComparisonLine[];
}) {
  return (
    <div>
      <h4>
        {label} · revision {revision}
      </h4>
      {lines.map((item, index) => (
        <div key={index}>
          <strong className="small">{item.label}</strong>
          {item.value === null ? (
            <p className="small muted">Not supplied</p>
          ) : item.value === '' ? (
            <p className="small muted">Empty text</p>
          ) : (
            <p className="original-text">{item.value}</p>
          )}
        </div>
      ))}
    </div>
  );
}
export function RevisionComparison({
  previous,
  current,
}: {
  previous: AdminDraft;
  current: AdminDraft;
}) {
  const groups = useMemo(() => compareSavedRevisions(previous, current), [previous, current]);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [previous, current]);
  if (!groups) return <p role="alert">Choose saved revisions of the same recipe to compare.</p>;
  const changed = groups.filter((group) => group.changed);
  const shown = showUnchanged ? [...changed, ...groups.filter((group) => !group.changed)] : changed;
  return (
    <section
      className="revision-comparison"
      aria-label={`Compare revision ${previous.revision} with saved revision ${current.revision}`}
    >
      <h3 ref={heading} tabIndex={-1}>
        Revision {previous.revision} → saved revision {current.revision}
      </h3>
      <p className="small muted">
        Read-only comparison of saved versions. Unsaved edits are excluded. Lists retain their exact
        order; quantities and source text are not normalized. Comparing does not restore or change a
        recipe.
      </p>
      <p role="status">
        {changed.length
          ? `${changed.length} of ${groups.length} sections differ.`
          : 'No differences in saved content or review evidence.'}
      </p>
      <button
        className="text-button"
        aria-pressed={showUnchanged}
        onClick={() => setShowUnchanged(!showUnchanged)}
      >
        {showUnchanged ? 'Show changed sections only' : 'Include unchanged sections'}
      </button>
      {shown.map((group) => (
        <details className="rights-record" key={group.key} open={group.changed}>
          <summary>
            <strong>{group.label}</strong>
            <span>{group.changed ? 'Changed' : 'Unchanged'}</span>
          </summary>
          <div className="field-pair">
            <SavedValues
              revision={previous.revision}
              label="Selected version"
              lines={group.before}
            />
            <SavedValues
              revision={current.revision}
              label="Current saved version"
              lines={group.after}
            />
          </div>
        </details>
      ))}
    </section>
  );
}
