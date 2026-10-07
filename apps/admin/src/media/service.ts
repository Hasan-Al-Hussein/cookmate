import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import sharp from 'sharp';
import type { Sharp } from 'sharp';
import type { FastifyRequest } from 'fastify';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import type { AdminAsset } from '../contracts';
import type { Actor, AdminDatabase } from '../storage/database';
import { AdminFault, requireAdmin } from '../auth/errors';
import {
  operationResult,
  recordOperation,
  sha256,
  type DraftRepository,
} from '../drafts/repository';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 20_000_000;
const UPLOAD_TIMEOUT_MS = 30_000;
export class AdminMedia {
  private active = 0;
  constructor(
    private readonly db: AdminDatabase,
    private readonly drafts: DraftRepository,
    private readonly directory: string,
    private readonly baselineDirectory: string,
    private readonly now: () => Date,
  ) {}
  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    requireAdmin(
      stat.isDirectory() && !stat.isSymbolicLink(),
      500,
      'media_location',
      'The configured media location is invalid.',
    );
  }
  async upload(
    request: FastifyRequest,
    actor: Actor,
    draftId: string,
    expectedRevision: number,
    operationId: string,
  ): Promise<AdminAsset> {
    requireAdmin(
      this.active < 1,
      429,
      'upload_busy',
      'Another photo is being processed. Please try again shortly.',
    );
    this.db.assertActor(actor, this.now().getTime());
    this.drafts.read(draftId);
    this.active++;
    const temporary = join(this.directory, `.upload-${randomUUID()}.tmp`);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      request.raw.destroy();
    }, UPLOAD_TIMEOUT_MS);
    try {
      await this.ensureDirectory();
      let received = false;
      let sourceHash = '';
      for await (const part of request.parts({
        limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 1, headerPairs: 50 },
      })) {
        requireAdmin(
          part.type === 'file' && part.fieldname === 'file' && !received,
          400,
          'invalid_upload',
          'Upload exactly one photo in the file field.',
        );
        received = true;
        const digest = createHash('sha256');
        let bytes = 0;
        const bounded = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            bytes += chunk.length;
            if (bytes > MAX_UPLOAD_BYTES)
              return done(
                new AdminFault(413, 'photo_too_large', 'Photo uploads are limited to 10 MiB.'),
              );
            digest.update(chunk);
            done(null, chunk);
          },
        });
        await pipeline(
          part.file,
          bounded,
          createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
          { signal: controller.signal },
        );
        requireAdmin(
          !part.file.truncated && bytes > 0,
          413,
          'photo_too_large',
          'The photo is empty or exceeds 10 MiB.',
        );
        sourceHash = digest.digest('hex');
      }
      requireAdmin(received, 400, 'photo_required', 'Choose a photo to upload.');
      const fingerprint = sha256(JSON.stringify({ draftId, expectedRevision, sourceHash }));
      this.db.assertActor(actor, this.now().getTime());
      const existing = operationResult<AdminAsset>(
        this.db,
        actor,
        operationId,
        'upload',
        fingerprint,
      );
      if (existing) return existing;
      requireAdmin(
        this.drafts.read(draftId).revision === expectedRevision,
        409,
        'revision_conflict',
        'The draft changed before this photo upload. Reload its latest revision.',
      );
      const decoder = sharp(temporary, {
        limitInputPixels: MAX_PIXELS,
        failOn: 'warning',
        sequentialRead: true,
      }).timeout({ seconds: 15 });
      let output: Awaited<ReturnType<typeof encode>>;
      try {
        const metadata = await decoder.metadata();
        requireAdmin(
          ['jpeg', 'png', 'webp'].includes(metadata.format ?? '') &&
            (metadata.pages ?? 1) === 1 &&
            !!metadata.width &&
            !!metadata.height &&
            metadata.width * metadata.height <= MAX_PIXELS,
          400,
          'invalid_photo',
          'Use a single-frame JPEG, PNG or WebP photo up to 20 megapixels.',
        );
        output = await encode(decoder);
      } finally {
        decoder.destroy();
      }
      requireAdmin(
        !controller.signal.aborted && output.data.length <= MAX_UPLOAD_BYTES,
        413,
        'photo_too_large',
        'The processed photo exceeds its supported size.',
      );
      const hash = sha256(output.data);
      const asset: AdminAsset = {
        assetId: `sha256:${hash}`,
        photoUrl: `/admin/api/assets/${hash}`,
        mimeType: 'image/webp',
        bytes: output.data.length,
        width: output.info.width,
        height: output.info.height,
        rightsStatus: 'unreviewed',
      };
      const target = join(this.directory, `${hash}.webp`);
      try {
        const file = await open(target, 'wx', 0o600);
        try {
          await file.writeFile(output.data);
          await file.sync();
        } finally {
          await file.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const stat = await lstat(target);
        requireAdmin(
          stat.isFile() &&
            !stat.isSymbolicLink() &&
            stat.size === asset.bytes &&
            sha256(await readFile(target)) === hash,
          500,
          'asset_integrity',
          'The stored photo failed an integrity check.',
        );
      }
      // Files precede the transaction: a crash may leave an unlisted content-addressed file,
      // but never a receipt pointing at bytes that were not durably written.
      return this.db.transaction(() => {
        this.db.assertActor(actor, this.now().getTime());
        requireAdmin(
          !controller.signal.aborted,
          408,
          'upload_timeout',
          'The upload timed out. Retry the same file and operation.',
        );
        const prior = operationResult<AdminAsset>(
          this.db,
          actor,
          operationId,
          'upload',
          fingerprint,
        );
        if (prior) return prior;
        requireAdmin(
          this.drafts.read(draftId).revision === expectedRevision,
          409,
          'revision_conflict',
          'The draft changed during photo processing. Reload its latest revision.',
        );
        this.db.run(
          'INSERT INTO admin_asset VALUES(?,?) ON CONFLICT(hash) DO NOTHING',
          hash,
          JSON.stringify(asset),
        );
        const stored = JSON.parse(
          this.db.get<{ document: string }>('SELECT document FROM admin_asset WHERE hash=?', hash)!
            .document,
        ) as AdminAsset;
        recordOperation(this.db, actor, operationId, 'upload', fingerprint, stored);
        return stored;
      });
    } catch (error) {
      if (error instanceof AdminFault) throw error;
      const code = (error as { code?: string }).code;
      if (code?.includes('TOO_LARGE') || code?.includes('LIMIT'))
        throw new AdminFault(413, 'photo_too_large', 'Upload one photo no larger than 10 MiB.');
      if (controller.signal.aborted)
        throw new AdminFault(
          408,
          'upload_timeout',
          'The photo upload timed out. Retry the same file and operation.',
        );
      throw new AdminFault(
        400,
        'invalid_photo',
        'The photo could not be decoded or stored. Use a valid JPEG, PNG or WebP file.',
      );
    } finally {
      clearTimeout(timer);
      this.active--;
      await unlink(temporary).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
  }
  async asset(hash: string): Promise<{ bytes: Buffer; mimeType: string }> {
    requireAdmin(/^[0-9a-f]{64}$/.test(hash), 400, 'invalid_asset', 'Invalid photo identifier.');
    const row = this.db.get<{ document: string }>(
      'SELECT document FROM admin_asset WHERE hash=?',
      hash,
    );
    requireAdmin(row, 404, 'asset_not_found', 'This photo was not found.');
    const asset = JSON.parse(row.document) as AdminAsset;
    const path = join(this.directory, `${hash}.webp`);
    const stat = await lstat(path);
    requireAdmin(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.size === asset.bytes &&
        stat.size <= MAX_UPLOAD_BYTES,
      503,
      'asset_unavailable',
      'This photo is unavailable.',
    );
    const bytes = await readFile(path);
    requireAdmin(
      sha256(bytes) === hash,
      503,
      'asset_integrity',
      'This photo failed an integrity check.',
    );
    return { bytes, mimeType: asset.mimeType };
  }
  async baseline(recipeId: string): Promise<{ bytes: Buffer; mimeType: string }> {
    const recipe = catalogue.getRecipe(recipeId);
    const asset = catalogueProvenance.assets.find((row) => row.recipeId === recipeId);
    requireAdmin(
      recipe &&
        asset &&
        recipe.photoKey === `photos/${recipeId}.jpg` &&
        asset.photoKey === recipe.photoKey,
      404,
      'photo_not_found',
      'The bundled recipe photo was not found.',
    );
    const path = join(this.baselineDirectory, `${recipeId}.jpg`);
    const stat = await lstat(path);
    requireAdmin(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.size === asset.bytes &&
        stat.size <= MAX_UPLOAD_BYTES,
      503,
      'photo_unavailable',
      'The bundled photo is unavailable.',
    );
    const bytes = await readFile(path);
    requireAdmin(
      sha256(bytes) === asset.sha256,
      503,
      'photo_integrity',
      'The bundled photo failed its retained-source check.',
    );
    return { bytes, mimeType: 'image/jpeg' };
  }
}
async function encode(decoder: Sharp) {
  return decoder.rotate().webp({ quality: 90, effort: 4 }).toBuffer({ resolveWithObject: true });
}
