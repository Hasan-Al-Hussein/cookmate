import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAccountAuthConfig } from './authConfig';
test('account configuration is absent until an HTTPS project and public key are supplied', () => {
  assert.equal(parseAccountAuthConfig({}), null);
  for (const url of [
    'http://account.example',
    'https://user:secret@account.example',
    'https://account.example/path',
    'https://account.example?secret=x',
  ])
    assert.equal(parseAccountAuthConfig({ url, publishableKey: 'sb_publishable_test' }), null);
  assert.equal(
    parseAccountAuthConfig({
      url: 'https://account.example',
      publishableKey: 'sb_secret_do_not_ship',
    }),
    null,
  );
});
test('provider support is explicit and native client identifiers are validated', () => {
  const config = parseAccountAuthConfig({
    url: 'https://account.example/',
    publishableKey: 'sb_publishable_test',
    google: '1',
    apple: '0',
    googleWebClientId: '123-abc.apps.googleusercontent.com',
    googleIosClientId: 'not-an-id',
  });
  assert.equal(config?.serviceEndpoint, 'https://account.example/functions/v1/cookmate-account');
  assert.equal(config?.google, true);
  assert.equal(config?.apple, false);
  assert.equal(config?.googleIosClientId, null);
});
