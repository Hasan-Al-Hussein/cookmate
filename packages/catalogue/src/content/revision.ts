import type { Immutable } from '../catalogue';
import { canonicalContentJson, copyContent, freezeContent, requireContent } from './canonical';
import { CONTENT_LIMITS } from './types';
import type { ContentHash, RecipeContentRef, RecipeContentRevision } from './types';
import { assertRecipeContentDocument, exact, fingerprint, identity, validateRecipeContentRef } from './validation';

export async function hashContent(domain: string, value: unknown, sha256: ContentHash): Promise<string> {
  const digest = await sha256(canonicalContentJson([domain, value]));
  requireContent(fingerprint(digest), 'hash_output');
  return digest;
}
export async function createRecipeContentRevision(
  input: unknown,
  revisionId: string,
  sha256: ContentHash,
): Promise<Immutable<RecipeContentRevision>> {
  requireContent(identity(revisionId), 'revision_id');
  const document = copyContent(input, CONTENT_LIMITS.documentBytes);
  assertRecipeContentDocument(document);
  // Snapshot before hashing: caller-owned data cannot change during an asynchronous adapter call.
  const ref: RecipeContentRef = {
    recipeId: document.recipe.recipeId,
    revisionId,
    contentFingerprint: await hashContent('cookmate-recipe-content-v1', document, sha256),
  };
  const revisionFingerprint = await hashContent('cookmate-recipe-revision-v1', ref, sha256);
  return freezeContent({ ref, document, revisionFingerprint });
}
export async function readRecipeContentRevision(
  input: unknown,
  sha256: ContentHash,
): Promise<Immutable<RecipeContentRevision>> {
  const revision = copyContent(input, CONTENT_LIMITS.documentBytes + 1024);
  requireContent(exact(revision, ['ref', 'document', 'revisionFingerprint']) && validateRecipeContentRef(revision.ref) && fingerprint(revision.revisionFingerprint), 'recipe_revision');
  const expected = await createRecipeContentRevision(revision.document, revision.ref.revisionId, sha256);
  requireContent(canonicalContentJson(expected.ref) === canonicalContentJson(revision.ref) && expected.revisionFingerprint === revision.revisionFingerprint, 'revision_integrity');
  return expected;
}
