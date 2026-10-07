import { createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import {
  canonicalContentJson,
  CONTENT_LIMITS,
  contentOverlaySignaturePayload,
  fingerprintContentOverlay,
  validateContentOverlayManifest,
  type ContentOverlayManifest,
  type SignedContentOverlay,
} from '@cookmate/catalogue/content';
import { CONTENT_SIGNATURE_SCHEME, type ContentTrustKey } from '@cookmate/catalogue/content-trust';
import { sha256 } from '../drafts/repository';

/** Server-only cryptographic primitive. Review/media/sequence authority belongs to issuance. */
export function createContentOverlaySigner(options: {
  keyId: string;
  privateKey: string | KeyObject;
}) {
  let key: KeyObject;
  try {
    key =
      typeof options.privateKey === 'string'
        ? createPrivateKey(options.privateKey)
        : options.privateKey;
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(options.keyId) ||
      key.type !== 'private' ||
      key.asymmetricKeyType !== 'ed25519'
    )
      throw new Error();
  } catch {
    // Never repeat secret material or crypto-library parse details in diagnostics.
    throw new Error('Invalid content signing configuration.');
  }
  const publicKey = createPublicKey(key).export({ format: 'jwk' });
  if (publicKey.crv !== 'Ed25519' || !publicKey.x)
    throw new Error('Invalid content signing configuration.');
  const trustKey: Readonly<ContentTrustKey> = Object.freeze({
    keyId: options.keyId,
    publicKeyHex: Buffer.from(publicKey.x, 'base64url').toString('hex'),
  });
  return Object.freeze({
    trustKey,
    async signManifest(input: ContentOverlayManifest): Promise<SignedContentOverlay> {
      const manifest: ContentOverlayManifest = JSON.parse(
        canonicalContentJson(input, CONTENT_LIMITS.releaseBytes),
      );
      if (!validateContentOverlayManifest(manifest))
        throw new Error('Invalid content overlay manifest.');
      const fingerprint = await fingerprintContentOverlay(manifest, async (value) => sha256(value));
      const payload = contentOverlaySignaturePayload(manifest, fingerprint);
      return {
        manifest,
        fingerprint,
        signature: {
          keyId: trustKey.keyId,
          scheme: CONTENT_SIGNATURE_SCHEME,
          value: sign(null, Buffer.from(payload, 'utf8'), key).toString('hex'),
        },
      };
    },
  });
}
