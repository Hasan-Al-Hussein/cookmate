import type { Session } from 'fastify';
import type { SessionStore } from '@fastify/session';
import type { AdminDatabase } from '../storage/database';
import { requireAdmin } from './errors';

export const IDLE_MS = 30 * 60 * 1000;
export const ABSOLUTE_MS = 8 * 60 * 60 * 1000;
declare module 'fastify' {
  interface Session {
    userId?: string;
    authEpoch?: number;
    absoluteExpiresAt?: number;
    authenticatedAt?: number;
    recentAuthAt?: number;
  }
}
/** The maintained session plugin owns token generation/signing. SQLite owns persistence/revocation. */
export function createSessionStore(db: AdminDatabase, now: () => Date): SessionStore {
  return {
    get(id, callback) {
      try {
        const row = db.get<{ data: string; expires_at: number }>(
          'SELECT data,expires_at FROM admin_session WHERE session_id=?',
          id,
        );
        const value =
          row && row.expires_at > now().getTime() ? (JSON.parse(row.data) as Session) : null;
        callback(null, value);
      } catch (error) {
        callback(error);
      }
    },
    set(id, session, callback) {
      try {
        const time = now().getTime();
        db.transaction(() => {
          db.run('DELETE FROM admin_session WHERE expires_at<=?', time);
          db.run('DELETE FROM admin_session_revocation WHERE expires_at<=?', time);
          requireAdmin(
            !db.get('SELECT 1 FROM admin_session_revocation WHERE session_id=?', id) &&
              (session.absoluteExpiresAt === undefined || session.absoluteExpiresAt > time),
            401,
            'session_expired',
            'Please sign in again. Your unsaved changes can be kept.',
          );
          if (session.userId) {
            const user = db.userById(session.userId);
            const stored = db.get<{ data: string }>(
              'SELECT data FROM admin_session WHERE session_id=? AND expires_at>?',
              id,
              time,
            );
            requireAdmin(
              user?.enabled && user.authEpoch === session.authEpoch && stored,
              401,
              'session_expired',
              'Please sign in again. Your unsaved changes can be kept.',
            );
            const previous = JSON.parse(stored.data) as Session;
            // A rolling response may have loaded this same session before reauthentication.
            // It must not undo a newer server-recorded identity confirmation on completion.
            if (
              previous.userId === session.userId &&
              previous.authEpoch === session.authEpoch &&
              typeof previous.recentAuthAt === 'number' &&
              Number.isFinite(previous.recentAuthAt) &&
              previous.recentAuthAt <= time &&
              (typeof session.recentAuthAt !== 'number' ||
                !Number.isFinite(session.recentAuthAt) ||
                previous.recentAuthAt > session.recentAuthAt)
            ) {
              session.recentAuthAt = previous.recentAuthAt;
            }
          }
          const expires = Math.min(time + IDLE_MS, session.absoluteExpiresAt ?? time + ABSOLUTE_MS);
          db.run(
            'INSERT INTO admin_session VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET data=excluded.data, expires_at=excluded.expires_at',
            id,
            JSON.stringify(session),
            expires,
          );
        });
        callback();
      } catch (error) {
        callback(error);
      }
    },
    destroy(id, callback) {
      try {
        db.transaction(() => {
          db.run('DELETE FROM admin_session WHERE session_id=?', id);
          db.run(
            'INSERT INTO admin_session_revocation VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET expires_at=excluded.expires_at',
            id,
            now().getTime() + ABSOLUTE_MS + IDLE_MS,
          );
        });
        callback();
      } catch (error) {
        callback(error);
      }
    },
  };
}
