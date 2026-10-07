/** Exact recipe identity shared by content, portable data and account formats.
 * Structure is not signature verification, rights approval or permission to read a body.
 */
export interface RecipeContentRef {
  recipeId: string;
  revisionId: string;
  contentFingerprint: string;
}

export function validateRecipeContentRef(value: unknown): value is RecipeContentRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  const fields = ['recipeId', 'revisionId', 'contentFingerprint'];
  return (
    Object.keys(ref).length === fields.length &&
    fields.every((field) => Object.hasOwn(ref, field)) &&
    typeof ref.recipeId === 'string' &&
    /^[0-9]{1,20}$/.test(ref.recipeId) &&
    typeof ref.revisionId === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(ref.revisionId) &&
    typeof ref.contentFingerprint === 'string' &&
    /^[0-9a-f]{64}$/.test(ref.contentFingerprint)
  );
}
