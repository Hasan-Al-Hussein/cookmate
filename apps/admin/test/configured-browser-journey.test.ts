import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { catalogue } from '@cookmate/catalogue';
import { canonicalContentJson } from '@cookmate/catalogue/content';
import type {
  AdminDraft,
  AdminPublicationIssueReceipt,
  AdminPublicationPreparation,
  AdminPublicationReleaseState,
} from '../src/contracts';
import { prepareIssuanceProposal } from '../web/issuanceProposal';
import { Client, origin as adminOrigin } from './helpers';
import {
  createConfiguredBrowserJourney,
  openConfiguredJourneyConsumer,
  readConfiguredBrowserJourney,
  selectConfiguredJourneyRelease,
} from './configured-browser-journey';

test('one disposable signer serves sequential operator-selected releases to an isolated consumer without widening access', async (t) => {
  const consumerOrigin = 'http://127.0.0.1:3458';
  const f = await createConfiguredBrowserJourney({ adminOrigin, consumerOrigin });
  const consumerApps: Awaited<ReturnType<typeof openConfiguredJourneyConsumer>>[] = [];
  t.after(async () => {
    for (const consumer of consumerApps) await consumer.app.close();
    await f.close();
    const target = resolve(f.manifest.directory),
      child = relative(resolve(tmpdir()), target);
    assert.ok(
      !child.startsWith('..') &&
        !isAbsolute(child) &&
        child.startsWith('cookmate-configured-journey-'),
    );
    await rm(target, { recursive: true, force: true });
  });
  await writeFile(
    join(f.manifest.directory, 'web', 'index.html'),
    '<!doctype html><title>Disposable fixture asset only</title>',
  );
  const client = new Client(() => f.app);
  await client.login();
  let draft = (await client.create(randomUUID(), catalogue.recipes[0]!.recipeId)).draft;
  async function request<T>(
    method: 'GET' | 'POST' | 'PUT',
    route: string,
    payload?: unknown,
  ): Promise<T> {
    const response = await client.request(method, route, payload);
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as T;
  }
  async function issue(title: string) {
    draft = (
      await request<{ draft: AdminDraft }>('PUT', `/admin/api/drafts/${draft.draftId}`, {
        operationId: randomUUID(),
        expectedRevision: draft.revision,
        input: {
          ...draft.input,
          title,
          changeSummary: 'Synthetic disposable journey; original quantities remain unchanged.',
        },
      })
    ).draft;
    for (const scope of [
      'recipe_text',
      'photo',
      ...(draft.input.videoUrl ? ['video_embed'] : []),
    ]) {
      draft = (
        await request<{ draft: AdminDraft }>('POST', `/admin/api/drafts/${draft.draftId}/rights`, {
          operationId: randomUUID(),
          expectedRevision: draft.revision,
          scope,
          status: 'permitted',
          statement: 'Synthetic test-only permission assertion; not real distribution rights.',
          sourceUrl: null,
        })
      ).draft;
    }
    draft = (
      await request<{ draft: AdminDraft }>('POST', `/admin/api/drafts/${draft.draftId}/reviews`, {
        operationId: randomUUID(),
        expectedRevision: draft.revision,
        decision: 'approved',
        note: 'Synthetic local acceptance only.',
      })
    ).draft;
    const preparation = await request<AdminPublicationPreparation>(
      'POST',
      `/admin/api/drafts/${draft.draftId}/publication-preparation`,
      { expectedRevision: draft.revision },
    );
    const current = await request<AdminPublicationReleaseState>(
      'GET',
      '/admin/api/publication/releases/current',
    );
    const proposal = await prepareIssuanceProposal(current, preparation, randomUUID());
    return request<AdminPublicationIssueReceipt>(
      'POST',
      '/admin/api/publication/releases',
      proposal,
    );
  }
  const first = await issue('Disposable journey first revision');
  const firstId = first.envelope.manifest.releaseId;
  let selected = await selectConfiguredJourneyRelease(f.manifest.directory, firstId);
  const headers = { host: new URL(consumerOrigin).host, origin: consumerOrigin };
  const get = (
    consumer: (typeof consumerApps)[number],
    url: string,
    extra: Record<string, string> = {},
  ) => consumer.app.inject({ method: 'GET', url, headers: { ...headers, ...extra } });
  const firstConsumer = await openConfiguredJourneyConsumer(f.manifest.directory);
  consumerApps.push(firstConsumer);
  await t.test(
    'actual protected issuance and signature-verified delivery share exact public trust',
    async () => {
      assert.equal(selected.head.sequence, 1);
      assert.equal(selected.head.fingerprint, first.envelope.fingerprint);
      assert.deepEqual(selected.config.trustKeys, f.manifest.trustKeys);
      const delivered = await get(firstConsumer, `/cookmate-content/releases/${firstId}/package`);
      assert.equal(delivered.statusCode, 200, delivered.body);
      assert.equal(delivered.json().envelope.fingerprint, first.envelope.fingerprint);
      assert.equal(
        delivered.json().publications[0].revision.document.recipe.title,
        'Disposable journey first revision',
      );
      const source = await readFile(join(f.manifest.directory, 'journey.json'), 'utf8');
      assert.doesNotMatch(source, /privateKey|sessionSecret|passwordHash|BEGIN PRIVATE/);
    },
  );
  await t.test(
    'consumer never exposes admin assets, metadata or an unselected release',
    async () => {
      for (const url of [
        '/admin/',
        '/admin/api/session',
        '/journey.json',
        `/cookmate-content/releases/unselected/package`,
      ])
        assert.equal((await get(firstConsumer, url)).statusCode, 404, url);
      assert.equal(
        (
          await get(firstConsumer, `/cookmate-content/releases/${firstId}/package`, {
            cookie: 'cookmate_admin=fixture',
          })
        ).statusCode,
        400,
      );
      assert.equal((await get(firstConsumer, '/', { origin: adminOrigin })).statusCode, 403);
      assert.equal((await get(firstConsumer, '/')).statusCode, 200);
    },
  );
  await t.test('failed explicit selection leaves the original configuration intact', async () => {
    const before = await readFile(join(f.manifest.directory, 'ordinary-config.json'), 'utf8');
    await assert.rejects(
      selectConfiguredJourneyRelease(f.manifest.directory, 'release-not-issued'),
    );
    assert.equal(
      await readFile(join(f.manifest.directory, 'ordinary-config.json'), 'utf8'),
      before,
    );
  });
  const second = await issue('Disposable journey second revision');
  const secondId = second.envelope.manifest.releaseId;
  await t.test('issuance alone does not change the old consumer allowlist', async () => {
    assert.equal(
      (await get(firstConsumer, `/cookmate-content/releases/${secondId}/package`)).statusCode,
      404,
    );
    assert.equal(
      (await get(firstConsumer, `/cookmate-content/releases/${firstId}/package`)).statusCode,
      200,
    );
  });
  await firstConsumer.app.close();
  selected = await selectConfiguredJourneyRelease(f.manifest.directory, secondId);
  const secondConsumer = await openConfiguredJourneyConsumer(f.manifest.directory);
  consumerApps.push(secondConsumer);
  await t.test(
    'next target retains installation and trust but requires deliberate consumer reopening',
    async () => {
      assert.equal(selected.head.sequence, 2);
      assert.equal(selected.config.installationId, f.manifest.installationId);
      assert.deepEqual(selected.config.trustKeys, f.manifest.trustKeys);
      assert.equal(
        (await get(secondConsumer, `/cookmate-content/releases/${firstId}/package`)).statusCode,
        404,
      );
      const delivered = await get(secondConsumer, `/cookmate-content/releases/${secondId}/package`);
      assert.equal(delivered.statusCode, 200, delivered.body);
      assert.equal(delivered.json().envelope.fingerprint, second.envelope.fingerprint);
      assert.equal(
        (await readConfiguredBrowserJourney(f.manifest.directory)).installationId,
        f.manifest.installationId,
      );
    },
  );
  await t.test('edited installation metadata and foreign roots are rejected', async () => {
    await writeFile(
      join(f.manifest.directory, 'ordinary-config.json'),
      canonicalContentJson({ ...selected.config, installationId: randomUUID() }, 10_240),
    );
    await assert.rejects(openConfiguredJourneyConsumer(f.manifest.directory));
    await assert.rejects(readConfiguredBrowserJourney(tmpdir()));
    await assert.rejects(readConfiguredBrowserJourney(join(f.manifest.directory, 'web')));
  });
});
