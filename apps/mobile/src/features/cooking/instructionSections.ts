export interface ReadingPassage {
  sequence: number;
  presentation: 'heading' | 'passage';
}

/** Group source headings with their passages without rewriting or renumbering the source. */
export function instructionSections<Passage extends ReadingPassage>(recipe: {
  readonly instructions: readonly Passage[];
}) {
  if (!recipe.instructions.some((passage) => passage.presentation === 'heading'))
    return recipe.instructions.map((passage) => [passage]);
  const sections: Passage[][] = [];
  let current: Passage[] = [];
  for (const passage of recipe.instructions) {
    if (
      passage.presentation === 'heading' &&
      current.some((entry) => entry.presentation !== 'heading')
    ) {
      sections.push(current);
      current = [];
    }
    current.push(passage);
  }
  if (current.length) sections.push(current);
  return sections;
}

/** Anchors refer to original passage sequences, never a translated or cosmetic step number. */
export function sectionForPassage(
  sections: readonly (readonly ReadingPassage[])[],
  passageSequence: number,
): number | null {
  const index = sections.findIndex((section) =>
    section.some((passage) => passage.sequence === passageSequence),
  );
  return index < 0 ? null : index;
}
