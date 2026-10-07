import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildAdminServer } from '../src/server';
import { openAdminDatabase } from '../src/storage/database';
import { hashPassword } from '../src/auth/passwords';
import type { AdminSession, AdminMutation } from '../src/contracts';
import type { AdminServerOptions } from '../src/configuration';

export const origin = 'http://127.0.0.1:3444';
export const fixturePassword = 'Fixture-only cooking password 123!';
let passwordHash: Promise<string> | undefined;
export async function fixture(
  t: TestContext,
  configure: (directory: string) => Pick<AdminServerOptions, 'publication'> = () => ({}),
) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-admin-test-'));
  const filename = join(directory, 'admin.sqlite');
  const db = openAdminDatabase(filename);
  passwordHash ??= hashPassword(fixturePassword);
  db.createFirstAdministrator({
    userId: 'fixture-admin',
    username: 'fixture.admin',
    passwordHash: await passwordHash,
  });
  for (const [id, role] of [
    ['fixture-editor', 'editor'],
    ['fixture-reviewer', 'reviewer'],
  ] as const)
    db.run('INSERT INTO admin_user VALUES(?,?,?,?,1,1)', id, id, await passwordHash, role);
  db.close();
  let clock = Date.now();
  const options = {
    databaseFile: filename,
    mediaDirectory: join(directory, 'media'),
    bundledPhotoDirectory: fileURLToPath(
      new URL('../../../packages/catalogue/assets/photos/', import.meta.url),
    ),
    origin,
    sessionSecret: 'fixture-only-session-signing-secret-with-enough-characters',
    allowInsecureLoopback: true,
    now: () => new Date(clock),
    ...configure(directory),
  } satisfies AdminServerOptions;
  let app = buildAdminServer(options);
  t.after(async () => {
    await app.close();
    const target = resolve(directory);
    const boundary = resolve(tmpdir());
    const path = relative(boundary, target);
    if (path.startsWith('..') || isAbsolute(path) || !path.startsWith('cookmate-admin-test-'))
      throw new Error('Fixture cleanup escaped temporary workspace');
    await rm(target, { recursive: true, force: true });
  });
  return {
    directory,
    filename,
    options,
    get app() {
      return app;
    },
    advance(milliseconds: number) {
      clock += milliseconds;
    },
    async reopen() {
      await app.close();
      app = buildAdminServer(options);
    },
    client() {
      return new Client(() => app);
    },
  };
}
export class Client {
  cookie = '';
  csrf = '';
  constructor(private readonly app: () => FastifyInstance) {}
  async request(
    method: NonNullable<InjectOptions['method']>,
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) {
    const options: InjectOptions = {
      method,
      url,
      headers: {
        host: '127.0.0.1:3444',
        origin,
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}),
        ...headers,
      },
      ...(payload !== undefined
        ? { payload: payload as NonNullable<InjectOptions['payload']> }
        : {}),
    };
    const response = await this.app().inject(options);
    // Session regeneration can clear the old cookie and then set its replacement.
    // A browser applies matching cookies in response order; the last value wins.
    const cookies = response.headers['set-cookie'];
    const last = Array.isArray(cookies)
      ? cookies.filter((value) => value.startsWith('cookmate_admin=')).at(-1)
      : cookies;
    if (last) this.cookie = last.split(';')[0]!;
    return response;
  }
  async login(username = 'fixture.admin') {
    const initial = await this.request('GET', '/admin/api/session');
    this.csrf = (initial.json() as AdminSession).csrfToken!;
    const response = await this.request('POST', '/admin/api/session', {
      username,
      password: fixturePassword,
    });
    if (response.statusCode !== 200)
      throw new Error(`Fixture sign-in failed: ${response.statusCode} ${response.body}`);
    this.csrf = (response.json() as AdminSession).csrfToken!;
    return response;
  }
  async create(operationId = 'create-fixture', fromRecipeId?: string): Promise<AdminMutation> {
    const response = await this.request('POST', '/admin/api/drafts', {
      operationId,
      ...(fromRecipeId ? { fromRecipeId } : {}),
    });
    if (response.statusCode !== 200)
      throw new Error(`Fixture create failed: ${response.statusCode} ${response.body}`);
    return response.json() as AdminMutation;
  }
}
export function multipartPhoto(
  bytes: Buffer,
  extra = false,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = 'cookmate-fixture-boundary';
  const one = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="untrusted-name.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    bytes,
    Buffer.from('\r\n'),
  ]);
  return {
    payload: Buffer.concat([one, ...(extra ? [one] : []), Buffer.from(`--${boundary}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}
