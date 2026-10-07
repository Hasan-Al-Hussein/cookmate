import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import { canonicalContentJson, createBundledContentSnapshot } from '@cookmate/catalogue/content';
import type { CommandPlatform } from '@cookmate/domain';
import {
  migrateAccountContentHistoryDatabase,
  verifyAccountContentHistorySchema,
} from '../../data/accountContentHistoryMigration';
import {
  migrateCookingContentDatabase,
  verifyOriginalSources,
} from '../../data/cookingContentMigration';
import {
  verifyCookingPinBindings,
  verifyPlanContentBindings,
} from '../../data/cookingContentRepository';
import { initializeDatabase, type InitialIdentifiers } from '../../data/initialize';
import {
  configureConnection,
  runBound,
  SerializedWriter,
  type RecoveryImpact,
  type SqlConnection,
  type SqlSession,
} from '../../data/sql';
import {
  ownPrivateContentConfiguration,
  privateContentDatabaseNames,
  type PrivateContentConfiguration,
} from './privateContentConfig';
import { PrivateContentCleanupError } from './privateContentRuntime';

const markerKey = 'private-content:preparation';
const markerBytes = 2048;
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const activeNames = new Set<string>();
const failedCleanup = new Map<string, PrivateContentCleanupError>();

type Marker = {
  schemaVersion: 1;
  origin: string;
  databaseName: string;
  installationId: string;
  shoppingScopeId: string;
  conversationId: string;
  catalogue: typeof catalogue.identity;
};

export interface PrivateContentPreparationOptions {
  config: Readonly<PrivateContentConfiguration>;
  /** Must open the supplied reserved name; no ordinary workspace handle may be substituted. */
  openConnection(name: string): Promise<SqlConnection>;
  platform: Pick<CommandPlatform, 'newId' | 'sha256'>;
}
export type PrivateContentPreparationResult = Readonly<{
  kind: 'prepared' | 'already_prepared';
  resumed: boolean;
}>;

export class PrivateContentPreparationError extends Error {
  constructor(
    readonly reason:
      | 'busy'
      | 'unowned_workspace'
      | 'invalid_marker'
      | 'account_workspace'
      | 'unsupported_schema'
      | 'invalid_ids',
  ) {
    const messages = {
      busy: 'Private workspace preparation is already running.',
      unowned_workspace: 'This database was not created by private workspace preparation.',
      invalid_marker: 'The private workspace preparation identity could not be verified.',
      account_workspace: 'An account workspace cannot be prepared as a private review workspace.',
      unsupported_schema: 'This private workspace has an unsupported database version.',
      invalid_ids: 'Private workspace preparation requires three distinct UUID v4 identifiers.',
    };
    super(messages[reason]);
    this.name = 'PrivateContentPreparationError';
  }
}

function identifiersValid(ids: InitialIdentifiers) {
  const values = [ids.installationId, ids.shoppingScopeId, ids.conversationId];
  return (
    values.every((value) => typeof value === 'string' && uuidV4.test(value)) &&
    new Set(values).size === values.length
  );
}

async function version(session: SqlSession) {
  return (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version;
}

/** Decorate existing migration transactions, rather than maintaining a second initializer/schema. */
class PreparationWriter extends SerializedWriter {
  private marker: Readonly<Marker> | undefined;
  private encoded: string | undefined;

  constructor(
    connection: SqlConnection,
    private readonly config: Readonly<PrivateContentConfiguration>,
    private readonly databaseName: string,
    private readonly newId: () => string,
  ) {
    super(connection);
  }

  get identifiers(): InitialIdentifiers {
    if (!this.marker) throw new PrivateContentPreparationError('invalid_marker');
    return {
      installationId: this.marker.installationId,
      shoppingScopeId: this.marker.shoppingScopeId,
      conversationId: this.marker.conversationId,
    };
  }

  private async admit(session: SqlSession): Promise<0 | 6 | 7 | 8> {
    const current = await version(session);
    if (current === 0) {
      // Include views/triggers/indexes and temporary objects; an empty-looking app table is not fresh.
      if (
        (
          await session.all(
            "SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' UNION ALL SELECT 1 FROM sqlite_temp_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1",
          )
        ).length
      )
        throw new PrivateContentPreparationError('unowned_workspace');
      if (!this.marker) {
        const ids = {
          installationId: this.config.installationId,
          shoppingScopeId: this.newId(),
          conversationId: this.newId(),
        };
        if (!identifiersValid(ids)) throw new PrivateContentPreparationError('invalid_ids');
        this.marker = Object.freeze({
          schemaVersion: 1,
          origin: this.config.origin,
          databaseName: this.databaseName,
          ...ids,
          catalogue: Object.freeze({ ...catalogue.identity }),
        });
        this.encoded = canonicalContentJson(this.marker, markerBytes);
      }
      return 0;
    }
    if (current !== 6 && current !== 7 && current !== 8)
      throw new PrivateContentPreparationError('unsupported_schema');
    // Metadata existence only: never parse account payloads or promote even settled account data.
    if (
      (
        await session.all(
          "SELECT 1 FROM app_metadata WHERE key LIKE 'account-replication:%' LIMIT 1",
        )
      ).length ||
      (
        await session.all(
          'SELECT 1 FROM account_cooking_history UNION ALL SELECT 1 FROM account_cooking_history_removed LIMIT 1',
        )
      ).length
    )
      throw new PrivateContentPreparationError('account_workspace');
    const rows = await session.all<{ value: string | null }>(
      "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))<=? THEN value END value FROM app_metadata WHERE key=? LIMIT 2",
      [markerBytes, markerKey],
    );
    if (!rows.length) throw new PrivateContentPreparationError('unowned_workspace');
    if (rows.length !== 1 || rows[0]!.value === null)
      throw new PrivateContentPreparationError('invalid_marker');
    const serialized = rows[0]!.value;
    let candidate: Marker;
    try {
      candidate = JSON.parse(serialized) as Marker;
      if (
        !candidate ||
        typeof candidate !== 'object' ||
        Array.isArray(candidate) ||
        Object.keys(candidate).sort().join(',') !==
          'catalogue,conversationId,databaseName,installationId,origin,schemaVersion,shoppingScopeId' ||
        candidate.schemaVersion !== 1 ||
        candidate.installationId !== this.config.installationId ||
        candidate.origin !== this.config.origin ||
        candidate.databaseName !== this.databaseName ||
        !identifiersValid(candidate) ||
        canonicalContentJson(candidate.catalogue, markerBytes) !==
          canonicalContentJson(catalogue.identity, markerBytes) ||
        canonicalContentJson(candidate, markerBytes) !== serialized ||
        (this.encoded !== undefined && serialized !== this.encoded)
      )
        throw new Error();
    } catch {
      throw new PrivateContentPreparationError('invalid_marker');
    }
    const installation = await session.all<{ value: string | null }>(
      "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))=36 THEN value END value FROM app_metadata WHERE key='installation_id' LIMIT 2",
    );
    if (installation.length !== 1 || installation[0]!.value !== candidate.installationId)
      throw new PrivateContentPreparationError('invalid_marker');
    this.marker = Object.freeze({
      ...candidate,
      catalogue: Object.freeze({ ...candidate.catalogue }),
    });
    this.encoded = serialized;
    return current;
  }

  override transaction<Value>(
    work: (session: SqlSession) => Promise<Value>,
    impact?: RecoveryImpact,
    assertCommitAdmission?: () => undefined,
  ): Promise<Value> {
    return super.transaction(
      async (session) => {
        const previous = await this.admit(session);
        const result = await work(session);
        const current = await version(session);
        if (previous === 0 && current !== 0) {
          if (current !== 6 || !this.encoded)
            throw new PrivateContentPreparationError('invalid_marker');
          // Initial schema, canonical seed, installation and preparation identity commit together.
          await runBound(session, 'INSERT INTO app_metadata(key,value) VALUES (?,?)', [
            markerKey,
            this.encoded,
          ]);
        }
        await this.admit(session);
        return result;
      },
      impact,
      assertCommitAdmission,
    );
  }
}

/** Explicit operator action only. Opening the private runtime never calls this function. */
export async function preparePrivateContentWorkspace(
  options: PrivateContentPreparationOptions,
): Promise<PrivateContentPreparationResult> {
  const config = ownPrivateContentConfiguration(options.config);
  const { cooking: databaseName } = privateContentDatabaseNames(config.installationId);
  const { openConnection } = options;
  const { newId, sha256 } = options.platform;
  const blocked = failedCleanup.get(databaseName);
  if (blocked) throw blocked;
  if (activeNames.has(databaseName)) throw new PrivateContentPreparationError('busy');
  activeNames.add(databaseName);
  let connection: SqlConnection | undefined;
  let writer: PreparationWriter | undefined;
  let primaryFailure: unknown;
  try {
    connection = await openConnection(databaseName);
    await configureConnection(connection);
    writer = new PreparationWriter(connection, config, databaseName, newId);
    const initial = await writer.transaction(version, { kind: 'read_only' });
    if (initial !== 0 && initial !== 6 && initial !== 7 && initial !== 8)
      throw new PrivateContentPreparationError('invalid_marker');
    const checkedHash = async (text: string) => {
      const digest = await sha256(text);
      if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest))
        throw new Error('Invalid private preparation digest.');
      return digest;
    };
    await completePreparedContentSchema(writer, writer.identifiers, checkedHash, initial);
    return Object.freeze({
      kind: initial === 8 ? 'already_prepared' : 'prepared',
      resumed: initial === 6 || initial === 7,
    });
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      if (writer) await writer.close();
      else if (connection) await connection.close();
    } catch (error) {
      const failure = new PrivateContentCleanupError(
        primaryFailure === undefined ? [error] : [primaryFailure, error],
      );
      failedCleanup.set(databaseName, failure);
      throw failure;
    } finally {
      activeNames.delete(databaseName);
    }
  }
}

/** Shared physical-schema completion after the caller's transaction admission verifies its own
 * preparation identity. Does not select a filename, claim data, grant consent or bind an owner.
 */
export async function completePreparedContentSchema(
  writer: SerializedWriter,
  identifiers: InitialIdentifiers,
  sha256: (text: string) => Promise<string>,
  initial: 0 | 6 | 7 | 8,
) {
  if (initial === 0 || initial === 6) {
    await initializeDatabase(
      writer,
      {
        identity: catalogue.identity,
        recipes: catalogue.recipes,
        recipeSources: catalogueProvenance.recipeSources,
      },
      identifiers,
      {
        enablePortableRestore: true,
        enableCooking: true,
        enablePersonal: true,
        enableAccountHistory: true,
      },
    );
  }
  if (initial !== 8) {
    await migrateCookingContentDatabase(writer, { sha256 });
    await migrateAccountContentHistoryDatabase(writer, { sha256 });
  }
  const baseline = await createBundledContentSnapshot(sha256);
  await writer.transaction(
    async (session) => {
      await verifyAccountContentHistorySchema(session);
      await verifyOriginalSources(session, baseline);
      await verifyPlanContentBindings(session, sha256);
      await verifyCookingPinBindings(session, sha256);
    },
    { kind: 'read_only' },
  );
}
