import { DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';
import type { SQLInputValue } from 'node:sqlite';
import type { AdminRole, AdminUser } from '../contracts';
import { requireAdmin } from '../auth/errors';
import { TRANSLATION_SCHEMA } from '../translations/schema';

export interface StoredUser extends AdminUser {
  passwordHash: string;
  authEpoch: number;
  enabled: boolean;
}
export interface Actor {
  user: AdminUser;
  authEpoch: number;
  sessionId: string;
}
const schema = `
CREATE TABLE admin_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, library_revision INTEGER NOT NULL, next_recipe INTEGER NOT NULL);
INSERT INTO admin_meta VALUES(1,1,0,1000000);
CREATE TABLE admin_user (user_id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('editor','reviewer','administrator')), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), auth_epoch INTEGER NOT NULL CHECK(auth_epoch>0));
CREATE TABLE admin_session (session_id TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE admin_session_revocation (session_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE admin_draft (draft_id TEXT PRIMARY KEY, recipe_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0));
CREATE TABLE admin_draft_revision (draft_id TEXT NOT NULL REFERENCES admin_draft(draft_id), revision INTEGER NOT NULL, document TEXT NOT NULL, original_evidence TEXT, review_evidence TEXT, PRIMARY KEY(draft_id,revision));
CREATE TABLE admin_operation (operation_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES admin_user(user_id), kind TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL);
CREATE TABLE admin_asset (hash TEXT PRIMARY KEY, document TEXT NOT NULL);
`;

export class AdminDatabase {
  private readonly db: DatabaseSync;
  constructor(filename: string) {
    if (filename !== ':memory:') {
      try {
        const stat = lstatSync(filename);
        requireAdmin(
          stat.isFile() && !stat.isSymbolicLink(),
          500,
          'database_path',
          'Invalid admin database location.',
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
      const tables = this.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      );
      if (tables.length === 0) this.transaction(() => this.db.exec(schema));
      const meta = this.get<{ schema_version: number }>(
        'SELECT schema_version FROM admin_meta WHERE id=1',
      );
      requireAdmin(
        meta?.schema_version === 1 || meta?.schema_version === 2,
        500,
        'database_version',
        'This admin database version is not supported.',
      );
      if (meta.schema_version === 1) {
        this.transaction(() => {
          for (const statement of TRANSLATION_SCHEMA) this.run(statement);
          this.run('UPDATE admin_meta SET schema_version=2 WHERE id=1');
        });
      }
      const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim().replace(/;$/, '');
      for (const statement of TRANSLATION_SCHEMA) {
        const name = /^CREATE (?:TABLE|INDEX) (\w+)/.exec(statement)![1]!;
        const actual = this.get<{ sql: string }>(
          'SELECT sql FROM sqlite_master WHERE name=?',
          name,
        );
        requireAdmin(
          actual && normalize(actual.sql) === normalize(statement),
          500,
          'database_schema',
          'The admin translation schema is incompatible.',
        );
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  get<T>(sql: string, ...values: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...values) as T | undefined;
  }
  all<T>(sql: string, ...values: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...values) as T[];
  }
  run(sql: string, ...values: SQLInputValue[]) {
    return this.db.prepare(sql).run(...values);
  }
  transaction<T>(body: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = body();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  countUsers(): number {
    return this.get<{ count: number }>('SELECT COUNT(*) count FROM admin_user')!.count;
  }
  createFirstAdministrator(input: {
    userId: string;
    username: string;
    passwordHash: string;
  }): void {
    requireAdmin(
      /^[A-Za-z0-9_-]{1,120}$/.test(input.userId) &&
        /^[A-Za-z0-9_.@-]{1,100}$/.test(input.username) &&
        input.passwordHash.startsWith('$argon2id$') &&
        input.passwordHash.length <= 1024,
      400,
      'invalid_operator',
      'Invalid operator account.',
    );
    this.transaction(() => {
      requireAdmin(
        this.countUsers() === 0,
        409,
        'already_configured',
        'An operator account already exists.',
      );
      this.run(
        'INSERT INTO admin_user VALUES(?,?,?,?,1,1)',
        input.userId,
        input.username,
        input.passwordHash,
        'administrator',
      );
    });
  }
  userById(id: string): StoredUser | undefined {
    return this.user('user_id', id);
  }
  userByName(name: string): StoredUser | undefined {
    return this.user('username', name);
  }
  private user(column: 'user_id' | 'username', value: string): StoredUser | undefined {
    const row = this.get<{
      user_id: string;
      username: string;
      password_hash: string;
      role: AdminRole;
      enabled: number;
      auth_epoch: number;
    }>(`SELECT * FROM admin_user WHERE ${column}=?`, value);
    return row
      ? {
          userId: row.user_id,
          username: row.username,
          passwordHash: row.password_hash,
          role: row.role,
          enabled: row.enabled === 1,
          authEpoch: row.auth_epoch,
        }
      : undefined;
  }
  assertActor(
    actor: Actor,
    now: number,
    roles: readonly AdminRole[] = ['editor', 'reviewer', 'administrator'],
  ): StoredUser {
    const user = this.userById(actor.user.userId);
    const session = this.get<{ data: string; expires_at: number }>(
      'SELECT data,expires_at FROM admin_session WHERE session_id=?',
      actor.sessionId,
    );
    const saved = session
      ? (JSON.parse(session.data) as {
          userId?: string;
          authEpoch?: number;
          absoluteExpiresAt?: number;
        })
      : null;
    requireAdmin(
      user?.enabled &&
        user.authEpoch === actor.authEpoch &&
        user.role === actor.user.role &&
        saved?.userId === user.userId &&
        saved.authEpoch === user.authEpoch &&
        (saved.absoluteExpiresAt ?? 0) > now &&
        session!.expires_at > now &&
        !this.get('SELECT 1 FROM admin_session_revocation WHERE session_id=?', actor.sessionId),
      401,
      'session_expired',
      'Please sign in again. Your unsaved changes can be kept.',
    );
    requireAdmin(
      roles.includes(user.role),
      403,
      'role_required',
      'Your role cannot perform this action.',
    );
    return user;
  }
  close(): void {
    this.db.close();
  }
}
export function openAdminDatabase(filename: string): AdminDatabase {
  return new AdminDatabase(filename);
}
