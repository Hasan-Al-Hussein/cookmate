import { catalogue, type Immutable } from '@cookmate/catalogue';
import {
  canonicalContentJson,
  CONTENT_LIMITS,
  createBundledRecipeRevision,
  validateRecipeContentRef,
  type EffectiveContentSnapshot,
  type MediaReference,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import { insist, own, readMediaBytes, same } from './contentReleaseStoreSchema';
import type { ContentVerificationPorts } from './contentReleaseStoreVerification';
import type { SqlSession } from './sql';

/** Metadata is frozen; bytes belong exclusively to the caller and may be changed or released. */
export interface VerifiedContentPhoto {
  readonly contentRef: Immutable<RecipeContentRef>;
  readonly assetId: string;
  readonly sha256: string;
  readonly mimeType: MediaReference['mimeType'];
  readonly width: number;
  readonly height: number;
  readonly bytes: Uint8Array;
}

/** Internal capability: the host must hold its content reservation for the entire read. */
export function createContentReadingMedia(
  session: SqlSession,
  ports: ContentVerificationPorts,
  snapshot: EffectiveContentSnapshot | null,
  hasWithdrawal: boolean,
  assertActive: () => void,
) {
  return async function readPhoto(
    requestedRef: RecipeContentRef,
    assetId: string,
  ): Promise<VerifiedContentPhoto> {
    assertActive();
    insist(
      validateRecipeContentRef(requestedRef) &&
        typeof assetId === 'string' &&
        /^sha256:[a-f0-9]{64}$/.test(assetId),
      'content_store_retained_ref_unavailable',
    );
    const ref = own(JSON.parse(canonicalContentJson(requestedRef)) as RecipeContentRef);
    // Independently derive original membership. A host-nominated baseline or a matching hash
    // alone must never turn staged, substituted or unrelated bytes into packaged media.
    const bundled = catalogue.getRecipe(ref.recipeId)
      ? await createBundledRecipeRevision(ref.recipeId, ports.sha256)
      : null;
    assertActive();
    let reference: Immutable<MediaReference> | undefined;
    if (snapshot) {
      const lookup = snapshot.lookupExact(ref);
      insist(lookup.kind !== 'withdrawn', 'content_store_adoption_policy_changed');
      insist(lookup.kind === 'readable', 'content_store_retained_ref_unavailable');
      reference = lookup.value.revision.document.media.find((item) => item.assetId === assetId);
    } else {
      insist(!hasWithdrawal, 'content_store_adoption_policy_changed');
      insist(bundled && same(bundled.ref, ref), 'content_store_retained_ref_unavailable');
      reference = bundled.document.media.find((item) => item.assetId === assetId);
    }
    insist(
      reference && reference.recipeId === ref.recipeId,
      'content_store_retained_ref_unavailable',
    );
    let bytes = await readMediaBytes(session, 'content_store_media', reference.sha256);
    assertActive();
    if (!bytes && bundled?.document.media.some((item) => same(item, reference))) {
      const incoming = await ports.readBundledMedia(reference);
      assertActive();
      insist(incoming instanceof Uint8Array && incoming.length <= CONTENT_LIMITS.mediaBytes);
      // slice() on a Node Buffer can alias retained memory; construct a real owned Uint8Array.
      bytes = new Uint8Array(incoming);
    }
    insist(bytes && bytes.length === reference.bytes);
    const hash = await ports.sha256Bytes(new Uint8Array(bytes));
    assertActive();
    insist(hash === reference.sha256);
    const facts = await ports.inspectImage(new Uint8Array(bytes));
    assertActive();
    insist(
      facts &&
        facts.mimeType === reference.mimeType &&
        Number.isSafeInteger(facts.width) &&
        Number.isSafeInteger(facts.height) &&
        facts.width > 0 &&
        facts.height > 0 &&
        facts.width <= CONTENT_LIMITS.imageDimension &&
        facts.height <= CONTENT_LIMITS.imageDimension &&
        (!reference.dimensions ||
          (facts.width === reference.dimensions.width &&
            facts.height === reference.dimensions.height)),
    );
    return Object.freeze({
      contentRef: ref,
      assetId: reference.assetId,
      sha256: hash,
      mimeType: facts.mimeType,
      width: facts.width,
      height: facts.height,
      bytes: new Uint8Array(bytes),
    });
  };
}
