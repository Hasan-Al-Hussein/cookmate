/** Explicit disposable browser setup through the actual administrator HTTP API. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { catalogue } from '@cookmate/catalogue';
import { AdminApi } from '../web/api';
import { prepareIssuanceProposal } from '../web/issuanceProposal';

if (process.argv.slice(2).join(' ') !== '--disposable-browser-review')
  throw new Error('Only the explicitly started disposable browser fixture may be seeded.');
const origin = 'http://127.0.0.1:3445';
let cookie = '';
const api = new AdminApi(
  () => {
    throw new Error('Disposable fixture authentication was lost.');
  },
  async (input, init) => {
    assert.equal(typeof input, 'string');
    assert.ok(String(input).startsWith('/admin/api/'));
    const headers = new Headers(init?.headers);
    headers.set('origin', origin);
    if (cookie) headers.set('cookie', cookie);
    const response = await fetch(origin + String(input), { ...init, headers });
    for (const value of response.headers.getSetCookie())
      if (value.startsWith('cookmate_admin=')) cookie = value.split(';')[0]!;
    return response;
  },
);
await api.session();
const session = await api.login('review.fixture', 'Disposable CookMate review only!');
assert.equal(session.user?.userId, 'browser-review-fixture');
assert.equal(session.user?.role, 'administrator');
const initial = await api.publicationReleaseState();
assert.equal(initial.status, 'ready');
if (initial.status !== 'ready') throw new Error('Fixture signing was not explicitly configured.');
assert.equal(initial.head, null, 'Never overwrite or reseed an existing release.');
assert.equal((await api.library('', 'draft')).items.length, 0);
const recipe = catalogue.recipes.find((item) => item.title === 'Cajun spiced fish tacos');
assert.ok(recipe);
let draft = (await api.create(randomUUID(), recipe.recipeId)).draft;
for (const scope of [
  'recipe_text',
  'photo',
  ...(draft.input.videoUrl ? ['video_embed'] : []),
] as const) {
  assert.ok(scope === 'recipe_text' || scope === 'photo' || scope === 'video_embed');
  draft = (
    await api.rights(draft.draftId, randomUUID(), draft.revision, {
      scope,
      status: 'permitted',
      statement: 'Disposable browser test only; not actual publication permission.',
      sourceUrl: null,
    })
  ).draft;
}
draft = (
  await api.save(draft.draftId, randomUUID(), draft.revision, {
    ...draft.input,
    changeSummary: 'Disposable browser archive workflow fixture. Original source text unchanged.',
  })
).draft;
draft = (
  await api.review(
    draft.draftId,
    randomUUID(),
    draft.revision,
    'approved',
    'Disposable workflow fixture; no real editorial or rights approval.',
  )
).draft;
const prepared = await api.preparePublication(draft.draftId, draft.revision);
const receipt = await api.issuePublicationRelease(
  await prepareIssuanceProposal(initial, prepared, randomUUID()),
);
const publishedRevision = draft.revision;
// A later draft intentionally differs; archiving must select the published reference.
draft = (
  await api.save(draft.draftId, randomUUID(), draft.revision, {
    ...draft.input,
    changeSummary:
      'Later unpublished disposable draft; do not substitute it for the published recipe.',
  })
).draft;
const library = await api.library('', 'published');
assert.equal(library.items.length, 1);
assert.equal(library.items[0]!.publication?.matchingDraftRevision, publishedRevision);
assert.equal(library.items[0]!.revision, draft.revision);
console.log(
  JSON.stringify({
    fixture: 'disposable',
    recipeId: recipe.recipeId,
    title: recipe.title,
    draftId: draft.draftId,
    publishedRevision,
    latestDraftRevision: draft.revision,
    sequence: receipt.envelope.manifest.sequence,
    adoption: 'not activated',
  }),
);
await api.logout();
