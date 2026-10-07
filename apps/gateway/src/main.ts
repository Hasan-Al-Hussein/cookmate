import { createInterface } from 'node:readline';
import { readGatewayConfiguration } from './configuration';
import { launchGateway } from './launcher';
import { safeError } from './errors';

async function main() {
  const gateway = await launchGateway(readGatewayConfiguration(process.env));
  process.stdout.write(
    'CookMate HTTPS gateway ready. Commands: pair, close-pairing, clients, revoke <client-id>, quit.\n',
  );
  const terminal = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      terminal.close();
      await gateway.close();
    })());
  const signal = () => {
    void stop().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', signal);
  process.once('SIGTERM', signal);
  try {
    for await (const line of terminal) {
      const command = line.trim();
      try {
        if (command === 'pair') {
          if (!process.stdin.isTTY || !process.stdout.isTTY) {
            process.stdout.write('Pairing requires a local interactive terminal.\n');
            continue;
          }
          const window = gateway.pairing.openWindow();
          process.stdout.write(
            `One-use pairing code: ${window.code} (expires ${window.expiresAt})\n`,
          );
        } else if (command === 'close-pairing') gateway.pairing.closeWindow();
        else if (command === 'clients')
          for (const client of gateway.listClients())
            process.stdout.write(
              `${client.clientId} ${client.expiresAt} ${client.revoked ? 'revoked' : 'issued'}\n`,
            );
        else if (
          /^revoke [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            command,
          )
        ) {
          const revoked = await gateway.revoke(command.slice(7));
          process.stdout.write(revoked ? 'Client revoked.\n' : 'Client not found.\n');
        } else if (command === 'quit') break;
        else if (command) process.stdout.write('Unknown operator command.\n');
      } catch (error) {
        process.stdout.write(`Operation failed: ${safeError(error).detail.code}\n`);
      }
    }
  } finally {
    process.removeListener('SIGINT', signal);
    process.removeListener('SIGTERM', signal);
    await stop();
  }
}
main().catch((error: unknown) => {
  process.stderr.write(`CookMate gateway could not start: ${safeError(error).detail.code}\n`);
  process.exitCode = 1;
});
