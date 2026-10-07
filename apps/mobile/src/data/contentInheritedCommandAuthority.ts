import { catalogue, catalogueBoundary } from '@cookmate/catalogue';
import { canonicalContentJson } from '@cookmate/catalogue/content';
import {
  checkLocalCommand,
  commandFingerprintInput,
  matchOperationReceipt,
  validateLocalCommand,
  type CatalogueIdentity,
} from '@cookmate/contracts';
import { validateReceiptSemantics } from '@cookmate/domain';
import { exact, readBinding, uuid } from './accountReplicationRecords';
import { isAppId, parseStoredIntent } from './conversationRecords';
import { COOKING_CONTENT_LIMITS } from './cookingContentSchema';
import { contentStored } from './cookingContentRepository';
import { runBound, type SqlSession } from './sql';

export const CONTENT_INHERITED_COMMAND_PREFIX = 'content:inherited-command:';
export const CONTENT_INHERITED_RECEIPT_PREFIX = 'content:inherited-receipt:';
const markerBytes = 1024;
const pageSize = 32;
const commandBytes = 65536;
const intentBytes = 131072;
const receiptBytes = 16384;
const maximumCommands = 20_000;
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

/** Migration provenance, not a new execution permission or adopted-content identity. */
export interface InheritedCommandAuthority {
  readonly formatVersion: 1;
  readonly installationId: string;
  readonly ownerId: string | null;
  readonly catalogue: Readonly<CatalogueIdentity>;
  readonly operationId: string;
  readonly userIntentId: string;
  readonly payloadFingerprint: string;
}

/** Retained result evidence only. It cannot register, execute or retry a deleted command. */
export interface InheritedReceiptAuthority extends InheritedCommandAuthority {
  readonly receiptDigest: string;
}

async function readInheritedMarker(
  session: SqlSession,
  operationId: string,
  receiptOnly: boolean,
): Promise<(InheritedCommandAuthority & { readonly receiptDigest?: string }) | null> {
  contentStored(isAppId(operationId));
  const version = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
    ?.user_version;
  contentStored(version === 7 || version === 8);
  const [row] = await session.all<{ value: string | null }>(
    `SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))<=? THEN value END value
     FROM app_metadata WHERE key=?`,
    [
      markerBytes,
      (receiptOnly ? CONTENT_INHERITED_RECEIPT_PREFIX : CONTENT_INHERITED_COMMAND_PREFIX) +
        operationId,
    ],
  );
  if (!row) return null;
  contentStored(typeof row.value === 'string');
  let value: unknown;
  try {
    value = JSON.parse(row.value);
  } catch {
    contentStored(false);
  }
  contentStored(
    exact(value, [
      'formatVersion',
      'installationId',
      'ownerId',
      'catalogue',
      'operationId',
      'userIntentId',
      'payloadFingerprint',
      ...(receiptOnly ? ['receiptDigest'] : []),
    ]) &&
      value.formatVersion === 1 &&
      isAppId(value.installationId) &&
      (value.ownerId === null || uuid(value.ownerId)) &&
      value.operationId === operationId &&
      isAppId(value.userIntentId) &&
      hash(value.payloadFingerprint) &&
      (!receiptOnly || hash(value.receiptDigest)) &&
      exact(value.catalogue, ['version', 'fingerprint']) &&
      value.catalogue.version === catalogue.identity.version &&
      value.catalogue.fingerprint === catalogue.identity.fingerprint,
  );
  // Our encoder is canonical; this also rejects duplicate JSON keys in a corrupt marker.
  contentStored(canonicalContentJson(value) === row.value);
  return Object.freeze({
    formatVersion: 1,
    installationId: value.installationId,
    ownerId: value.ownerId,
    catalogue: Object.freeze({ ...catalogue.identity }),
    operationId,
    userIntentId: value.userIntentId,
    payloadFingerprint: value.payloadFingerprint,
    ...(receiptOnly && hash(value.receiptDigest) ? { receiptDigest: value.receiptDigest } : {}),
  });
}

/** No command/receipt bodies are read here. The host must check its live owner and operation. */
export function readInheritedCommandAuthorityInSnapshot(
  session: SqlSession,
  operationId: string,
): Promise<InheritedCommandAuthority | null> {
  return readInheritedMarker(session, operationId, false);
}

/** The host must verify the original receipt's canonical digest; no command authority follows. */
export async function readInheritedReceiptAuthorityInSnapshot(
  session: SqlSession,
  operationId: string,
): Promise<InheritedReceiptAuthority | null> {
  const marker = await readInheritedMarker(session, operationId, true);
  if (marker === null) return null;
  contentStored(hash(marker.receiptDigest));
  return Object.freeze({ ...marker, receiptDigest: marker.receiptDigest });
}

/** Called only inside the real six-to-seven transaction; never on an existing content store. */
export async function recordInheritedCommandAuthoritiesForMigration(
  session: SqlSession,
  sha256: (text: string) => Promise<string>,
): Promise<void> {
  contentStored(
    (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version === 6,
  );
  contentStored(
    (
      await session.all('SELECT 1 FROM app_metadata WHERE key GLOB ? OR key GLOB ? LIMIT 1', [
        CONTENT_INHERITED_COMMAND_PREFIX + '*',
        CONTENT_INHERITED_RECEIPT_PREFIX + '*',
      ])
    ).length === 0,
  );
  const [installation] = await session.all<{ id: string | null }>(
    "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))=36 THEN value END id FROM app_metadata WHERE key='installation_id'",
  );
  contentStored(isAppId(installation?.id));
  const installationId = installation.id;
  const ownerId = await readBinding(session);
  let totalBytes = 0;
  for (const [table, predicate, invalid, bytes] of [
    [
      'command_slot',
      '1',
      `typeof(operation_id)<>'text' OR length(CAST(operation_id AS BLOB))<>36 OR typeof(user_intent_id)<>'text' OR length(CAST(user_intent_id AS BLOB))<>36 OR typeof(slot_id)<>'text' OR length(CAST(slot_id AS BLOB))<>36 OR typeof(position)<>'integer' OR position<0 OR position>=8 OR typeof(command_json)<>'text' OR length(CAST(command_json AS BLOB))>${commandBytes}`,
      'length(CAST(command_json AS BLOB))+108',
    ],
    [
      'pending_intent',
      'EXISTS (SELECT 1 FROM command_slot s WHERE s.user_intent_id=pending_intent.user_intent_id)',
      `typeof(user_intent_id)<>'text' OR length(CAST(user_intent_id AS BLOB))<>36 OR typeof(revision)<>'integer' OR revision<0 OR revision>9007199254740991 OR typeof(phase)<>'text' OR length(CAST(phase AS BLOB))>32 OR typeof(intent_json)<>'text' OR length(CAST(intent_json AS BLOB))>${intentBytes}`,
      'length(CAST(intent_json AS BLOB))+68',
    ],
    [
      'operation_receipt',
      '1',
      `typeof(operation_id)<>'text' OR length(CAST(operation_id AS BLOB))<>36 OR typeof(user_intent_id)<>'text' OR length(CAST(user_intent_id AS BLOB))<>36 OR typeof(payload_fingerprint)<>'text' OR length(CAST(payload_fingerprint AS BLOB))<>64 OR typeof(outcome)<>'text' OR length(CAST(outcome AS BLOB))>16 OR typeof(committed_at)<>'text' OR length(CAST(committed_at AS BLOB))>40 OR typeof(shopping_projection)<>'text' OR length(CAST(shopping_projection AS BLOB))>16 OR typeof(effects_json)<>'text' OR length(CAST(effects_json AS BLOB))>${receiptBytes}`,
      'length(CAST(effects_json AS BLOB))+208',
    ],
  ]) {
    const [bound] = await session.all<{ count: number; bytes: number; invalid: number }>(
      `SELECT COUNT(*) count, COALESCE(SUM(${bytes}),0) bytes, COALESCE(MAX(CASE WHEN ${invalid} THEN 1 ELSE 0 END),0) invalid FROM ${table} WHERE ${predicate}`,
    );
    contentStored(bound && bound.count <= maximumCommands && bound.invalid === 0);
    totalBytes += bound.bytes;
    contentStored(
      Number.isSafeInteger(totalBytes) && totalBytes <= COOKING_CONTENT_LIMITS.archiveBytes,
    );
  }
  contentStored(
    (
      await session.all(
        `SELECT 1 FROM operation_receipt r LEFT JOIN command_slot s ON s.operation_id=r.operation_id
         WHERE (s.operation_id IS NOT NULL AND r.user_intent_id IS NOT s.user_intent_id)
         OR (s.operation_id IS NULL AND EXISTS (SELECT 1 FROM direct_command_recovery d WHERE d.operation_id=r.operation_id)) LIMIT 1`,
      )
    ).length === 0,
  );
  contentStored(
    (
      await session.all(
        `SELECT 1 FROM command_slot s LEFT JOIN pending_intent p ON p.user_intent_id=s.user_intent_id WHERE p.user_intent_id IS NULL LIMIT 1`,
      )
    ).length === 0,
  );
  let after = '';
  for (;;) {
    const rows = await session.all<{
      operationId: string;
      userIntentId: string;
      slotId: string;
      position: number;
      commandJson: string;
      revision: number;
      phase: string;
      intentJson: string;
      slotCount: number;
      receiptOperation: string | null;
      receiptUserIntent: string | null;
      payloadFingerprint: string | null;
      outcome: string | null;
      committedAt: string | null;
      shoppingProjection: string | null;
      effectsJson: string | null;
    }>(
      `SELECT s.operation_id operationId,s.user_intent_id userIntentId,s.slot_id slotId,s.position,s.command_json commandJson,
       p.revision,p.phase,p.intent_json intentJson,(SELECT COUNT(*) FROM command_slot c WHERE c.user_intent_id=s.user_intent_id) slotCount,
       r.operation_id receiptOperation,r.user_intent_id receiptUserIntent,r.payload_fingerprint payloadFingerprint,
       r.outcome,r.committed_at committedAt,r.shopping_projection shoppingProjection,r.effects_json effectsJson
       FROM command_slot s JOIN pending_intent p ON p.user_intent_id=s.user_intent_id
       LEFT JOIN operation_receipt r ON r.operation_id=s.operation_id
       WHERE s.operation_id>? ORDER BY s.operation_id LIMIT ?`,
      [after, pageSize],
    );
    if (!rows.length) break;
    for (const row of rows) {
      contentStored(isAppId(row.operationId) && isAppId(row.userIntentId) && isAppId(row.slotId));
      const intent = parseStoredIntent(row.intentJson, row);
      const command: unknown = JSON.parse(row.commandJson);
      contentStored(
        validateLocalCommand(command) && checkLocalCommand(command, catalogueBoundary).ok,
      );
      const slot = intent.slots[row.position];
      contentStored(
        intent.slots.length === row.slotCount &&
          slot?.slotId === row.slotId &&
          command.operationId === row.operationId &&
          command.userIntentId === row.userIntentId &&
          command.intentRevision === intent.revision &&
          canonicalContentJson(command.origin ?? null) ===
            canonicalContentJson(intent.origin ?? null) &&
          slot.command.payloadFingerprint === command.payloadFingerprint &&
          commandFingerprintInput(slot.command) === commandFingerprintInput(command),
      );
      const digest = await sha256(commandFingerprintInput(command));
      contentStored(hash(digest) && digest === command.payloadFingerprint);
      if (row.receiptOperation !== null) {
        contentStored(typeof row.effectsJson === 'string');
        const receipt: unknown = {
          schemaVersion: 1,
          operationId: row.receiptOperation,
          userIntentId: row.receiptUserIntent,
          payloadFingerprint: row.payloadFingerprint,
          outcome: row.outcome,
          committedAt: row.committedAt,
          shoppingProjection: row.shoppingProjection,
          effects: JSON.parse(row.effectsJson),
        };
        contentStored(
          validateReceiptSemantics(receipt, catalogueBoundary) &&
            matchOperationReceipt(command, receipt) === 'existing',
        );
      }
      const marker: InheritedCommandAuthority = {
        formatVersion: 1,
        installationId,
        ownerId,
        catalogue: catalogue.identity,
        operationId: command.operationId,
        userIntentId: command.userIntentId,
        payloadFingerprint: command.payloadFingerprint,
      };
      const text = canonicalContentJson(marker);
      contentStored(new TextEncoder().encode(text).length <= markerBytes);
      await runBound(session, 'INSERT INTO app_metadata(key,value) VALUES (?,?)', [
        CONTENT_INHERITED_COMMAND_PREFIX + command.operationId,
        text,
      ]);
    }
    after = rows.at(-1)!.operationId;
  }
  // Conversation clear deliberately keeps receipts after removing attached commands.
  // Preserve only the validated historical result, never reconstruct those commands.
  after = '';
  for (;;) {
    const rows = await session.all<{
      operationId: string;
      userIntentId: string;
      payloadFingerprint: string;
      outcome: string;
      committedAt: string;
      shoppingProjection: string;
      effectsJson: string;
    }>(
      `SELECT r.operation_id operationId,r.user_intent_id userIntentId,r.payload_fingerprint payloadFingerprint,
       r.outcome,r.committed_at committedAt,r.shopping_projection shoppingProjection,r.effects_json effectsJson
       FROM operation_receipt r WHERE NOT EXISTS (SELECT 1 FROM command_slot s WHERE s.operation_id=r.operation_id)
       AND r.operation_id>? ORDER BY r.operation_id LIMIT ?`,
      [after, pageSize],
    );
    if (!rows.length) break;
    for (const { effectsJson, ...fields } of rows) {
      const receipt: unknown = { schemaVersion: 1, ...fields, effects: JSON.parse(effectsJson) };
      contentStored(validateReceiptSemantics(receipt, catalogueBoundary));
      const receiptDigest = await sha256(canonicalContentJson(receipt));
      contentStored(hash(receiptDigest));
      const marker: InheritedReceiptAuthority = {
        formatVersion: 1,
        installationId,
        ownerId,
        catalogue: catalogue.identity,
        operationId: receipt.operationId,
        userIntentId: receipt.userIntentId,
        payloadFingerprint: receipt.payloadFingerprint,
        receiptDigest,
      };
      const text = canonicalContentJson(marker);
      contentStored(new TextEncoder().encode(text).length <= markerBytes);
      await runBound(session, 'INSERT INTO app_metadata(key,value) VALUES (?,?)', [
        CONTENT_INHERITED_RECEIPT_PREFIX + receipt.operationId,
        text,
      ]);
    }
    after = rows.at(-1)!.operationId;
  }
}
