import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { openAdminDatabase } from '../storage/database';
import { hashPassword } from '../auth/passwords';
import {
  adminStateDirectory,
  assertRegularAdminFile,
  createAdminSecret,
  lockAdminDirectory,
  protectAdminDirectory,
} from '../privateState';
import { promptHiddenPassword } from './passwordPrompt';

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length !== 2 ||
    args[0] !== '--username' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(args[1] ?? '')
  )
    throw new Error('Usage: npm run admin:bootstrap -- --username YOUR_NAME');
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('Use an interactive terminal to configure the operator.');
  const directory = adminStateDirectory();
  await protectAdminDirectory(directory);
  const unlock = await lockAdminDirectory(directory);
  try {
    const file = path.join(directory, 'admin.sqlite');
    await assertRegularAdminFile(file);
    const database = openAdminDatabase(file);
    try {
      if (database.countUsers() !== 0)
        throw new Error(
          'An operator is already configured. Initial setup cannot replace an account.',
        );
      let password = await promptHiddenPassword('New administrator password (12–128 characters): ');
      if (Array.from(password).length < 12) throw new Error('Use at least 12 characters.');
      let confirmation = await promptHiddenPassword('Repeat password: ');
      if (password !== confirmation)
        throw new Error('Passwords did not match. No account was created.');
      const passwordHash = await hashPassword(password);
      password = '';
      confirmation = '';
      await createAdminSecret(directory);
      database.createFirstAdministrator({ userId: randomUUID(), username: args[1]!, passwordHash });
      process.stdout.write(
        'Administrator configured locally. No service was published. Start with npm run admin:start -- --local-http for private loopback development.\n',
      );
    } finally {
      database.close();
    }
  } finally {
    await unlock();
  }
}
void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Operator setup failed.';
  // Deliberately exclude the error object/stack and all entered values.
  process.stderr.write(
    `${message.startsWith('Usage:') || /^(Use at least|Passwords did not|An operator|Use an interactive|Operator setup cancelled|Password exceeds)/.test(message) ? message : 'Operator setup could not be completed. Check the private local state directory and retry.'}\n`,
  );
  process.exitCode = 1;
});
