export type SqlValue = string | number | null;
export interface SqlStatement {
  run(values: readonly SqlValue[]): Promise<void>;
  finalize(): Promise<void>;
}
export interface SqlSession {
  exec(sql: string): Promise<void>;
  all<Row extends object>(sql: string, values?: readonly SqlValue[]): Promise<Row[]>;
  prepare(sql: string): Promise<SqlStatement>;
}
export interface SqlConnection extends SqlSession {
  close(): Promise<void>;
}

/** Cache impact only; never command authority. Missing declarations invalidate all coverage. */
export type RecoveryImpact =
  | { kind: 'read_only' }
  | { kind: 'draft_only' }
  | { kind: 'none' }
  | { kind: 'intents'; userIntentIds: readonly string[] }
  | { kind: 'all' };

export interface WriterTransactionObserver {
  begin(session: SqlSession, impact: RecoveryImpact): Promise<void>;
  beforeCommit?(session: SqlSession): Promise<void>;
  committed(reader: Pick<SqlSession, 'all'>): Promise<void>;
  failed(): void;
}

function snapshotImpact(impact: RecoveryImpact | undefined): RecoveryImpact {
  if (impact?.kind === 'intents') {
    if (
      !Array.isArray(impact.userIntentIds) ||
      !impact.userIntentIds.length ||
      impact.userIntentIds.some((id) => typeof id !== 'string' || !id)
    )
      return Object.freeze({ kind: 'all' });
    return Object.freeze({
      kind: 'intents',
      userIntentIds: Object.freeze([...new Set(impact.userIntentIds)]),
    });
  }
  return Object.freeze({
    kind:
      impact && ['read_only', 'draft_only', 'none', 'all'].includes(impact.kind)
        ? impact.kind
        : 'all',
  });
}

export async function runBound(
  session: SqlSession,
  sql: string,
  values: readonly SqlValue[],
): Promise<void> {
  const statement = await session.prepare(sql);
  try {
    await statement.run(values);
  } finally {
    await statement.finalize();
  }
}

export class StorageFault extends Error {
  constructor(
    public readonly code: 'storage_failure' | 'incompatible_version' | 'migration_failure',
    message: string,
  ) {
    super(message);
    this.name = 'StorageFault';
  }
}

/** Native convenience reads must report cleanup failure separately from a recoverable SQL error. */
export class SqlCleanupFault extends StorageFault {
  constructor() {
    super('storage_failure', 'Native statement cleanup failed');
    this.name = 'SqlCleanupFault';
  }
}

/** A store shares one queue so its rollback-journal readers cannot block its writer's COMMIT. */
export class SqlTransactionQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<Value>(work: () => Promise<Value>): Promise<Value> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** Whole transactions, including cleanup and observer publication, own the scheduling slot. */
class SerializedTransactions {
  private closing = false;
  private invalid = false;
  private closePromise: Promise<void> | undefined;
  private observer: WriterTransactionObserver | undefined;

  constructor(
    private readonly connection: SqlConnection,
    private readonly begin: 'BEGIN' | 'BEGIN IMMEDIATE',
    private readonly queue: SqlTransactionQueue = new SqlTransactionQueue(),
  ) {}

  protected attachObserver(observer: WriterTransactionObserver): void {
    if (this.observer || this.closing || this.invalid)
      throw new StorageFault('storage_failure', 'Writer observer cannot be rebound');
    this.observer = observer;
  }

  /** Sticky connection health; callers must not infer clean rollback from missing receipts. */
  requiresRecovery(): boolean {
    return this.invalid;
  }

  private invalidateObserver(): void {
    try {
      this.observer?.failed();
    } catch {
      // Observer errors must not prevent transaction cleanup.
      this.invalid = true;
    }
  }

  transaction<Value>(
    work: (session: SqlSession) => Promise<Value>,
    impact?: RecoveryImpact,
    assertCommitAdmission?: () => undefined,
  ): Promise<Value> {
    const ownedImpact = snapshotImpact(impact);
    if (this.closing)
      return Promise.reject(new StorageFault('storage_failure', 'Store is closing'));
    return this.queue.run(async () => {
      try {
        if (this.invalid) throw new StorageFault('storage_failure', 'Connection requires recovery');
        const foreignKeys = await this.connection
          .all<{ foreign_keys: number }>('PRAGMA foreign_keys')
          .catch((error: unknown) => {
            if (error instanceof SqlCleanupFault) this.invalid = true;
            throw error;
          });
        if (foreignKeys[0]?.foreign_keys !== 1)
          throw new StorageFault('storage_failure', 'Connection foreign keys are disabled');
        await this.connection.exec(this.begin);
      } catch (error) {
        this.invalidateObserver();
        throw error;
      }
      let active = true;
      let admissionRejected = false;
      const pending: Promise<unknown>[] = [];
      const statements: SqlStatement[] = [];
      const track = <Result>(task: Promise<Result>): Promise<Result> => {
        pending.push(task);
        // Observe immediately so even an accidentally unawaited statement cannot become an unhandled rejection.
        void task.catch(() => undefined);
        return task;
      };
      const assertActive = () => {
        if (!active) throw new StorageFault('storage_failure', 'Transaction scope has ended');
      };
      const execute = <Result>(operation: () => Promise<Result>): Promise<Result> => {
        try {
          assertActive();
          return track(operation());
        } catch (error) {
          return Promise.reject(error);
        }
      };
      const session: SqlSession = {
        exec: (sql) => execute(() => this.connection.exec(sql)),
        all: <Row extends object>(sql: string, values?: readonly SqlValue[]) =>
          execute(() => this.connection.all<Row>(sql, values)),
        prepare: (sql) =>
          execute(async () => {
            const statement = await this.connection.prepare(sql);
            let finalization: Promise<void> | undefined;
            const owned: SqlStatement = {
              run: (values) =>
                execute(() => {
                  if (finalization)
                    throw new StorageFault('storage_failure', 'Statement has been finalized');
                  return statement.run(values);
                }),
              finalize: () => {
                finalization ??= Promise.resolve().then(() => statement.finalize());
                return track(finalization);
              },
            };
            statements.push(owned);
            return owned;
          }),
      };
      const finalizeStatements = async () => {
        const results = await Promise.allSettled(
          statements.map((statement) => statement.finalize()),
        );
        const failed = results.find((outcome) => outcome.status === 'rejected');
        if (failed?.status === 'rejected') {
          this.invalid = true;
          throw failed.reason;
        }
      };
      try {
        await this.observer?.begin(session, ownedImpact);
        const value = await work(session);
        active = false;
        const completion = await Promise.allSettled(pending);
        const failed = completion.find((outcome) => outcome.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        await finalizeStatements();
        await this.observer?.beforeCommit?.({
          all: (sql, values) => this.connection.all(sql, values),
          exec: async () => {
            throw new StorageFault('storage_failure', 'Observer cannot mutate transaction');
          },
          prepare: async () => {
            throw new StorageFault('storage_failure', 'Observer cannot mutate transaction');
          },
        });
        // This final synchronous guard follows every transaction await; COMMIT cannot be recalled.
        try {
          assertCommitAdmission?.();
        } catch (error) {
          admissionRejected = true;
          throw error;
        }
        await this.connection.exec('COMMIT');
        await this.observer?.committed({
          all: (sql, values) => this.connection.all(sql, values),
        });
        return value;
      } catch (error) {
        this.invalidateObserver();
        active = false;
        const completion = await Promise.allSettled(pending);
        if (
          error instanceof SqlCleanupFault ||
          completion.some(
            (result) => result.status === 'rejected' && result.reason instanceof SqlCleanupFault,
          )
        )
          this.invalid = true;
        // Cleanup is also required when a callback throws before its own finally block.
        // Preserve unrelated errors; admission rejection must not mask uncertain cleanup.
        await finalizeStatements().catch(() => undefined);
        try {
          await this.connection.exec('ROLLBACK');
        } catch {
          this.invalid = true;
        }
        if (
          admissionRejected &&
          (this.invalid || completion.some((result) => result.status === 'rejected'))
        )
          throw new StorageFault('storage_failure', 'Rejected admission requires reconciliation');
        throw error;
      }
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.queue.run(() => this.connection.close());
    return this.closePromise;
  }
}

/** No UI/provider code receives the writer or its raw connection. */
export class SerializedWriter extends SerializedTransactions {
  constructor(connection: SqlConnection, queue?: SqlTransactionQueue) {
    super(connection, 'BEGIN IMMEDIATE', queue);
  }
  setObserver(observer: WriterTransactionObserver): void {
    this.attachObserver(observer);
  }
}

export class SerializedReader extends SerializedTransactions {
  constructor(connection: SqlConnection, queue?: SqlTransactionQueue) {
    super(connection, 'BEGIN', queue);
  }
}

export async function configureConnection(connection: SqlConnection): Promise<void> {
  await connection.exec('PRAGMA foreign_keys = ON');
  const rows = await connection.all<{ foreign_keys: number }>('PRAGMA foreign_keys');
  if (rows[0]?.foreign_keys !== 1)
    throw new StorageFault('storage_failure', 'Foreign keys could not be enabled');
}
