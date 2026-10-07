import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import { fetch as nativeFetch } from 'expo/fetch';
import { Platform } from 'react-native';
import { validateAiProposal, validateHealthResponse } from '@cookmate/contracts';
import { readBoundedJson } from './readBoundedJson';

export interface ProbeCheck {
  name: string;
  passed: boolean;
  detail: string;
}
export interface NativeProbeResult {
  platform: string;
  osVersion: string;
  hermes: boolean;
  checks: ProbeCheck[];
}

async function sqliteChecks(checks: ProbeCheck[], suffix: string): Promise<void> {
  const databaseName = `cookmate-foundation-probe-${suffix}.db`;
  let database: SQLite.SQLiteDatabase | undefined;
  try {
    database = await SQLite.openDatabaseAsync(databaseName);
    await database.execAsync(
      'PRAGMA foreign_keys = ON; CREATE TABLE parent (id TEXT PRIMARY KEY); CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));',
    );
    const foreignKeys = await database.getFirstAsync<{ foreign_keys: number }>(
      'PRAGMA foreign_keys',
    );
    checks.push({
      name: 'sqlite.foreign_keys',
      passed: foreignKeys?.foreign_keys === 1,
      detail: 'Foreign keys enabled on disposable connection.',
    });
    let rejected = false;
    try {
      await database.runAsync(
        'INSERT INTO child (id, parent_id) VALUES (?, ?)',
        'orphan',
        'missing',
      );
    } catch {
      rejected = true;
    }
    checks.push({
      name: 'sqlite.orphan_rejected',
      passed: rejected,
      detail: 'Deliberately invalid foreign key.',
    });
    const rollback = new Error('synthetic rollback');
    try {
      await database.withExclusiveTransactionAsync(async (transaction) => {
        // Expo opens a separate connection for this callback. Checking only the
        // outer connection would miss a write boundary with FK enforcement off.
        const transactionForeignKeys = await transaction.getFirstAsync<{ foreign_keys: number }>(
          'PRAGMA foreign_keys',
        );
        checks.push({
          name: 'sqlite.transaction_foreign_keys',
          passed: transactionForeignKeys?.foreign_keys === 1,
          detail:
            'Assert enforcement on the actual transaction handle; enabling it after BEGIN would be too late.',
        });
        let transactionRejectedOrphan = false;
        try {
          await transaction.runAsync(
            'INSERT INTO child (id, parent_id) VALUES (?, ?)',
            'transaction-orphan',
            'missing',
          );
        } catch {
          transactionRejectedOrphan = true;
        }
        checks.push({
          name: 'sqlite.transaction_orphan_rejected',
          passed: transactionRejectedOrphan,
          detail:
            'Deliberately invalid FK on the exclusive write connection; rolled back in either case.',
        });
        await transaction.runAsync('INSERT INTO parent (id) VALUES (?)', 'rollback-parent');
        await transaction.runAsync(
          'INSERT INTO child (id, parent_id) VALUES (?, ?)',
          'rollback-child',
          'rollback-parent',
        );
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    const rolledBack = await database.getFirstAsync<{ total: number }>(
      'SELECT (SELECT count(*) FROM parent) + (SELECT count(*) FROM child) AS total',
    );
    checks.push({
      name: 'sqlite.transaction_rollback',
      passed: rolledBack?.total === 0,
      detail: 'Injected pre-commit failure leaves both tables empty.',
    });
    await database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.runAsync('INSERT INTO parent (id) VALUES (?)', 'committed-parent');
      await transaction.runAsync(
        'INSERT INTO child (id, parent_id) VALUES (?, ?)',
        'committed-child',
        'committed-parent',
      );
    });
    await database.closeAsync();
    database = undefined;
    database = await SQLite.openDatabaseAsync(databaseName);
    await database.execAsync('PRAGMA foreign_keys = ON');
    const restored = await database.getFirstAsync<{ total: number }>(
      'SELECT (SELECT count(*) FROM parent) + (SELECT count(*) FROM child) AS total',
    );
    checks.push({
      name: 'sqlite.close_reopen',
      passed: restored?.total === 2,
      detail:
        'Both committed rows survive connection reopen; this is not process-restart evidence.',
    });
  } finally {
    if (database) await database.closeAsync();
    await SQLite.deleteDatabaseAsync(databaseName);
  }
}

async function secureStoreChecks(checks: ProbeCheck[], suffix: string): Promise<void> {
  const key = `cookmate.foundation.probe.${suffix}`;
  if (!(await SecureStore.isAvailableAsync())) throw new Error('SecureStore unavailable');
  try {
    await SecureStore.setItemAsync(key, 'synthetic-probe-value');
    checks.push({
      name: 'secure_store.roundtrip',
      passed: (await SecureStore.getItemAsync(key)) === 'synthetic-probe-value',
      detail: 'Synthetic value only; reinstall/backup lifecycle still needs device testing.',
    });
  } finally {
    await SecureStore.deleteItemAsync(key);
  }
  checks.push({
    name: 'secure_store.delete',
    passed: (await SecureStore.getItemAsync(key)) === null,
    detail: 'Disposable probe credential removed.',
  });
}

export async function runNativeAdapterProbe(): Promise<NativeProbeResult> {
  const checks: ProbeCheck[] = [];
  const suffix = Crypto.randomUUID();
  const routines = [
    { name: 'sqlite', run: () => sqliteChecks(checks, suffix) },
    { name: 'secure_store', run: () => secureStoreChecks(checks, suffix) },
  ];
  for (const routine of routines) {
    try {
      await routine.run();
    } catch {
      checks.push({
        name: routine.name,
        passed: false,
        detail:
          'Native adapter probe failed. Inspect a redacted local diagnostic; do not infer a passing check.',
      });
    }
  }
  checks.push({
    name: 'standalone_validator.valid',
    passed: validateAiProposal({ kind: 'saveRecipe', recipeId: '53262' }),
    detail: 'Generated schema validator executed in this runtime.',
  });
  checks.push({
    name: 'standalone_validator.strict',
    passed: !validateAiProposal({ kind: 'saveRecipe', recipeId: '53262', execute: true }),
    detail: 'Unexpected consequential field rejected.',
  });
  checks.push({
    name: 'standalone_validator.unicode',
    passed:
      validateAiProposal({
        kind: 'savePreference',
        type: 'cuisine',
        explicitValue: '🍎'.repeat(256),
      }) &&
      !validateAiProposal({
        kind: 'savePreference',
        type: 'cuisine',
        explicitValue: '🍎'.repeat(257),
      }),
    detail: 'Generated Unicode helper accepted 256 code points and rejected 257.',
  });
  return {
    platform: Platform.OS,
    osVersion: String(Platform.Version),
    hermes: 'HermesInternal' in globalThis,
    checks,
  };
}

export async function runHttpsProbe(endpoint: string): Promise<ProbeCheck> {
  let address: URL;
  try {
    address = new URL(endpoint);
  } catch {
    return {
      name: 'https.health',
      passed: false,
      detail: 'Enter the operator-provided trusted HTTPS endpoint.',
    };
  }
  if (
    address.protocol !== 'https:' ||
    address.username ||
    address.password ||
    address.search ||
    address.hash
  )
    return {
      name: 'https.health',
      passed: false,
      detail: 'HTTPS without credentials, query or fragment is required.',
    };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await nativeFetch(new URL('/health', address).toString(), {
      signal: controller.signal,
      credentials: 'omit',
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
    const declaredLength = response.headers.get('content-length');
    if (
      declaredLength !== null &&
      (!Number.isInteger(Number(declaredLength)) || Number(declaredLength) > 2048)
    )
      throw new Error('Oversized health response');
    const body = await readBoundedJson(response.body, 2048);
    const passed = response.ok && validateHealthResponse(body);
    return {
      name: 'https.health',
      passed,
      detail: passed
        ? 'This build accepted the TLS endpoint and its bounded health reply. Repeat with wrong-host/untrusted certificates to prove rejection.'
        : 'Endpoint did not provide the expected bounded health response.',
    };
  } catch {
    return {
      name: 'https.health',
      passed: false,
      detail:
        'Connection/trust/deadline failure. No certificate bypass is provided; local adapter checks remain available.',
    };
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
