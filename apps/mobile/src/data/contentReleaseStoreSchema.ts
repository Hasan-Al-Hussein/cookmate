import {
  canonicalContentJson,
  CONTENT_LIMITS,
  validateOverlayHead,
  type ContentHash,
  type OverlayHead,
} from '@cookmate/catalogue/content';
import type { Immutable } from '@cookmate/catalogue';
import { runBound, type SqlSession } from './sql';

export const CONTENT_STORE_LIMITS = Object.freeze({
  releases: 256,
  archiveJsonBytes: 64 * 1024 * 1024,
  archiveMediaBytes: 128 * 1024 * 1024,
  stageMediaBytes: 32 * 1024 * 1024,
  mediaCount: 8000,
});
export class ContentStoreFault extends Error {
  constructor(
    readonly code:
      | 'content_store_invalid'
      | 'content_store_incompatible'
      | 'content_store_limit'
      | 'content_store_retained_head_unavailable'
      | 'content_store_retained_ref_unavailable'
      | 'content_store_adoption_policy_changed'
      | 'stage_pending'
      | 'stage_changed'
      | 'head_changed'
      | 'review_invalid'
      | 'operation_conflict',
    message = code,
  ) {
    super(message);
    this.name = 'ContentStoreFault';
  }
}
export function insist(
  condition: unknown,
  code: ContentStoreFault['code'] = 'content_store_invalid',
): asserts condition {
  if (!condition) throw new ContentStoreFault(code);
}
export function own<Value>(value: Value): Immutable<Value> {
  const freeze = (item: unknown): void => {
    if (item && typeof item === 'object') {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
  };
  freeze(value);
  return value as Immutable<Value>;
}
export function byteLength(text: string): number {
  let result = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    result += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return result;
}
export const same = (left: unknown, right: unknown) =>
  canonicalContentJson(left) === canonicalContentJson(right);
export const identifier = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 120 &&
  /^[A-Za-z0-9]/.test(value) &&
  !/[^A-Za-z0-9._:-]/.test(value);
export const digest = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 64 && !/[^a-f0-9]/.test(value);
export function parse(text: unknown, max = CONTENT_LIMITS.releaseBytes): unknown {
  insist(typeof text === 'string' && byteLength(text) <= max);
  try {
    return JSON.parse(text);
  } catch {
    throw new ContentStoreFault('content_store_invalid');
  }
}
export function head(value: unknown): OverlayHead | null {
  insist(value === null || validateOverlayHead(value));
  return value;
}

const jsonColumns = `fingerprint TEXT NOT NULL, envelope_json TEXT NOT NULL, publications_json TEXT NOT NULL, media_json TEXT NOT NULL`;
const mediaColumns = `hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL CHECK(typeof(bytes)='integer' AND bytes>0 AND bytes<=${CONTENT_LIMITS.mediaBytes}), hex TEXT NOT NULL CHECK(typeof(hex)='text' AND length(CAST(hex AS BLOB))=2*bytes AND hex NOT GLOB '*[^a-f0-9]*')`;
const ddl = [
  `CREATE TABLE content_store_meta(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1), head_json TEXT, high_water INTEGER NOT NULL CHECK(high_water>=0), stage_epoch INTEGER NOT NULL CHECK(stage_epoch>=0))`,
  `CREATE TABLE content_store_stage(slot INTEGER PRIMARY KEY CHECK(slot=1), stage_id TEXT NOT NULL, ${jsonColumns})`,
  `CREATE TABLE content_store_stage_media(${mediaColumns}, slot INTEGER NOT NULL CHECK(slot=1) REFERENCES content_store_stage(slot) ON DELETE CASCADE)`,
  `CREATE TABLE content_store_release(release_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE CHECK(sequence>0), ${jsonColumns})`,
  `CREATE TABLE content_store_media(${mediaColumns})`,
  `CREATE TABLE content_store_operation(operation_id TEXT PRIMARY KEY, release_id TEXT NOT NULL UNIQUE REFERENCES content_store_release(release_id), fingerprint TEXT NOT NULL, receipt_json TEXT NOT NULL)`,
];
const normalized = (sql: string) => sql.replace(/\s+/g, ' ').trim().toLowerCase();
export async function initializeContentStore(session: SqlSession): Promise<void> {
  const [count] = await session.all<{ count: number }>(
    "SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  );
  insist(count && (count.count === 0 || count.count === ddl.length), 'content_store_incompatible');
  const rows = await session.all<{ sql: string }>(
    "SELECT CASE WHEN typeof(sql)='text' AND length(CAST(sql AS BLOB))<=4096 THEN sql ELSE NULL END sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  if (!rows.length) {
    for (const sql of ddl) await session.exec(sql);
    await session.exec('INSERT INTO content_store_meta VALUES(1,1,NULL,0,0)');
  } else {
    insist(rows.length === ddl.length, 'content_store_incompatible');
    insist(
      rows.every((row) => typeof row.sql === 'string'),
      'content_store_incompatible',
    );
    const actual = new Set(rows.map((row) => normalized(row.sql)));
    insist(
      ddl.every((sql) => actual.has(normalized(sql))),
      'content_store_incompatible',
    );
  }
  await readMeta(session);
}
export interface StoreMeta {
  head: OverlayHead | null;
  highWater: number;
  stageEpoch: number;
}
export async function readMeta(session: SqlSession): Promise<StoreMeta> {
  const rows = await session.all<{
    version: number;
    head_json: string | null;
    high_water: number;
    stage_epoch: number;
    head_size: number | null;
  }>(
    `SELECT version,high_water,stage_epoch,length(CAST(head_json AS BLOB)) head_size,CASE WHEN typeof(head_json)='text' AND length(CAST(head_json AS BLOB))<=1024 THEN head_json ELSE NULL END head_json FROM content_store_meta WHERE id=1`,
  );
  insist(rows.length === 1);
  const row = rows[0]!;
  insist(
    row.version === 1 &&
      Number.isSafeInteger(row.high_water) &&
      row.high_water >= 0 &&
      row.high_water <= CONTENT_STORE_LIMITS.releases &&
      Number.isSafeInteger(row.stage_epoch) &&
      row.stage_epoch >= 0,
  );
  const current = head(row.head_size === null ? null : parse(row.head_json, 1024));
  insist(current?.sequence === row.high_water || (current === null && row.high_water === 0));
  return { head: current, highWater: row.high_water, stageEpoch: row.stage_epoch };
}
export interface MediaItem {
  sha256: string;
  bytes: number;
}
export interface StoredPackage {
  fingerprint: string;
  envelope: unknown;
  publications: unknown[];
  media: MediaItem[];
  envelopeJson: string;
  publicationsJson: string;
  mediaJson: string;
}
export async function packageFingerprint(
  sha256: ContentHash,
  envelopeJson: string,
  publicationsJson: string,
  media: readonly MediaItem[],
): Promise<string> {
  const result = await sha256(
    canonicalContentJson([
      'cookmate-staged-content-v1',
      { envelope: await sha256(envelopeJson), publications: await sha256(publicationsJson), media },
    ]),
  );
  insist(digest(result));
  return result;
}
export async function readPackage(
  session: SqlSession,
  table: 'content_store_stage' | 'content_store_release',
  key: string,
  sha256: ContentHash,
): Promise<StoredPackage | null> {
  const rows = await session.all<{
    fingerprint: string;
    envelope_json: string | null;
    publications_json: string | null;
    media_json: string | null;
  }>(
    `SELECT CASE WHEN typeof(fingerprint)='text' AND length(CAST(fingerprint AS BLOB))=64 THEN fingerprint ELSE NULL END fingerprint,${['envelope_json', 'publications_json', 'media_json'].map((column) => `CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB))<=${CONTENT_LIMITS.releaseBytes} THEN ${column} ELSE NULL END ${column}`).join(',')} FROM ${table} WHERE ${table === 'content_store_stage' ? 'stage_id' : 'release_id'}=?`,
    [key],
  );
  if (!rows.length) return null;
  insist(rows.length === 1);
  const row = rows[0]!;
  const envelope = parse(row.envelope_json),
    publications = parse(row.publications_json),
    media = parse(row.media_json);
  insist(
    Array.isArray(publications) &&
      Array.isArray(media) &&
      media.length <= CONTENT_STORE_LIMITS.mediaCount,
  );
  insist(
    media.every(
      (item: unknown) =>
        !!item &&
        typeof item === 'object' &&
        Object.keys(item).length === 2 &&
        'sha256' in item &&
        digest(item.sha256) &&
        'bytes' in item &&
        Number.isSafeInteger(item.bytes) &&
        Number(item.bytes) > 0 &&
        Number(item.bytes) <= CONTENT_LIMITS.mediaBytes,
    ),
  );
  const mediaItems = media as MediaItem[];
  insist(
    new Set(mediaItems.map((item) => item.sha256)).size === mediaItems.length &&
      same(
        mediaItems,
        [...mediaItems].sort((a, b) => a.sha256.localeCompare(b.sha256)),
      ),
  );
  insist(
    mediaItems.reduce((sum, item) => sum + item.bytes, 0) <= CONTENT_STORE_LIMITS.stageMediaBytes,
  );
  insist(
    digest(row.fingerprint) &&
      (await packageFingerprint(sha256, row.envelope_json!, row.publications_json!, mediaItems)) ===
        row.fingerprint,
  );
  return {
    fingerprint: row.fingerprint,
    envelope,
    publications,
    media: mediaItems,
    envelopeJson: row.envelope_json!,
    publicationsJson: row.publications_json!,
    mediaJson: row.media_json!,
  };
}
export async function storageBounds(session: SqlSession): Promise<void> {
  const [json] = await session.all<{ count: number; bytes: number; invalid: number }>(
    `SELECT COUNT(*) count,COALESCE(SUM(length(CAST(envelope_json AS BLOB))+length(CAST(publications_json AS BLOB))+length(CAST(media_json AS BLOB))),0) bytes,COALESCE(SUM(CASE WHEN typeof(envelope_json)<>'text' OR typeof(publications_json)<>'text' OR typeof(media_json)<>'text' OR length(CAST(envelope_json AS BLOB))>${CONTENT_LIMITS.releaseBytes} OR length(CAST(publications_json AS BLOB))>${CONTENT_LIMITS.releaseBytes} OR length(CAST(media_json AS BLOB))>${CONTENT_LIMITS.releaseBytes} THEN 1 ELSE 0 END),0) invalid FROM content_store_release`,
  );
  insist(
    json &&
      json.count <= CONTENT_STORE_LIMITS.releases &&
      json.bytes <= CONTENT_STORE_LIMITS.archiveJsonBytes &&
      !json.invalid,
    'content_store_limit',
  );
  for (const [table, limit] of [
    ['content_store_media', CONTENT_STORE_LIMITS.archiveMediaBytes],
    ['content_store_stage_media', CONTENT_STORE_LIMITS.stageMediaBytes],
  ] as const) {
    const [row] = await session.all<{ count: number; bytes: number; invalid: number }>(
      `SELECT COUNT(*) count,COALESCE(SUM(bytes),0) bytes,COALESCE(SUM(CASE WHEN typeof(bytes)<>'integer' OR bytes<=0 OR bytes>${CONTENT_LIMITS.mediaBytes} OR typeof(hex)<>'text' OR length(CAST(hex AS BLOB))<>2*bytes THEN 1 ELSE 0 END),0) invalid FROM ${table}`,
    );
    insist(
      row && row.count <= CONTENT_STORE_LIMITS.mediaCount && row.bytes <= limit && !row.invalid,
      'content_store_limit',
    );
  }
}
export async function readMediaBytes(
  session: SqlSession,
  table: 'content_store_media' | 'content_store_stage_media',
  hash: string,
): Promise<Uint8Array | null> {
  const [row] = await session.all<{ bytes: number; hex: string | null }>(
    `SELECT bytes,CASE WHEN typeof(hex)='text' AND length(CAST(hex AS BLOB))<=? THEN hex ELSE NULL END hex FROM ${table} WHERE hash=?`,
    [2 * CONTENT_LIMITS.mediaBytes, hash],
  );
  if (!row) return null;
  insist(
    Number.isSafeInteger(row.bytes) &&
      row.bytes > 0 &&
      row.bytes <= CONTENT_LIMITS.mediaBytes &&
      typeof row.hex === 'string' &&
      row.hex.length === row.bytes * 2 &&
      !/[^a-f0-9]/.test(row.hex),
  );
  const bytes = new Uint8Array(row.bytes);
  for (let index = 0; index < bytes.length; index++)
    bytes[index] = Number.parseInt(row.hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}
export async function writeMediaBytes(
  session: SqlSession,
  hash: string,
  bytes: Uint8Array,
): Promise<void> {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    let chunk = '';
    for (const value of bytes.subarray(offset, offset + 8192))
      chunk += value.toString(16).padStart(2, '0');
    chunks.push(chunk);
  }
  await runBound(
    session,
    'INSERT INTO content_store_stage_media(hash,bytes,hex,slot) VALUES(?,?,?,1)',
    [hash, bytes.length, chunks.join('')],
  );
}
