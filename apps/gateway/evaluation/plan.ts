import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { identity as runtimeIdentity } from '../../../packages/catalogue/src';
import { GEMINI_MODELS } from '../src/gemini';
import { ProfileAdmissionError, selectProfile, type PinnedDocument } from './profiles';

export const CASE_IDS = ['L01', 'L09', 'L14', 'L21', 'L30', 'L35', 'L37', 'L46'] as const;
export type CaseId = `L${string}`;
export const FIXTURE_SHA256 = 'a69034e897a7a66400b3ce8e58c2bf52480a4f5097333c7d834d0cdce4480113';
export const DATE = { localDate: '2026-09-28', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 };
export const ORDER = CASE_IDS.flatMap((caseId, index) =>
  (index % 2 ? [...GEMINI_MODELS].reverse() : [...GEMINI_MODELS]).map((model) => ({
    caseId,
    model,
  })),
);
export interface EvaluationCase {
  id: CaseId;
  stratum: string;
  input: { prompt: string; selectedRecipeExpectation: string | null; contextRecipeRefs?: string[] };
  expected: unknown;
}
export const sha256 = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');

export async function readPinnedDocument(docsRoot: string, input: PinnedDocument) {
  const bytes = await readFile(join(docsRoot, input.path));
  if (sha256(bytes) !== input.sha256)
    throw new ProfileAdmissionError(`document_changed:${input.role}`);
  return bytes;
}

/** Shared by preparation, activation and direct/injected execution, before any setup effects. */
export async function loadEvaluationPlan(codeRoot: string, docsRoot: string, profileId: unknown) {
  const profile = selectProfile(profileId);
  const bytes = await readPinnedDocument(docsRoot, profile.fixture);
  const bundle = JSON.parse(bytes.toString('utf8')) as {
    format: string;
    formatVersion: number;
    provenance: {
      catalogueIdentity: unknown;
      files: { role: string; base: string; relativePath: string; sha256: string }[];
    };
    liveCases: EvaluationCase[];
  };
  assert.equal(bundle.format, 'cookmate-assistant-evaluation-fixtures', 'fixture_format');
  assert.equal(bundle.formatVersion, 1, 'fixture_format_version');
  if (!isDeepStrictEqual(bundle.provenance.catalogueIdentity, profile.catalogue.identity))
    throw new ProfileAdmissionError('fixture_identity_mismatch');
  // Q27 must reach this comparison with the real pinned v1 fixture before any v1 document/file pins.
  if (!isDeepStrictEqual(runtimeIdentity, profile.catalogue.identity))
    throw new ProfileAdmissionError('catalogue_identity_mismatch');
  const catalogueBytes = await readFile(
    join(codeRoot, 'packages/catalogue/generated/catalogue.json'),
  );
  if (sha256(catalogueBytes) !== profile.catalogue.sha256)
    throw new ProfileAdmissionError('catalogue_source_changed');
  if (!isDeepStrictEqual(JSON.parse(catalogueBytes.toString('utf8')).identity, runtimeIdentity))
    throw new ProfileAdmissionError('catalogue_file_identity_mismatch');
  const cataloguePin = bundle.provenance.files.find((file) => file.role === 'catalogue');
  assert.deepEqual(
    cataloguePin,
    {
      role: 'catalogue',
      base: 'code_root',
      relativePath: 'packages/catalogue/generated/catalogue.json',
      sha256: profile.catalogue.sha256,
    },
    'fixture_catalogue_pin_mismatch',
  );
  if (
    sha256(await readFile(join(codeRoot, 'packages/catalogue/generated/provenance.json'))) !==
    profile.catalogue.provenanceSha256
  )
    throw new ProfileAdmissionError('provenance_source_changed');
  if (!profile.validationReport) throw new ProfileAdmissionError('profile_validation_pending');
  for (const input of [...profile.documents, profile.validationReport])
    await readPinnedDocument(docsRoot, input);
  const cases = CASE_IDS.map((id, index) => {
    const item = bundle.liveCases.find((candidate) => candidate.id === id);
    assert.ok(item, 'missing_fixed_case');
    assert.equal(item.stratum, 'ABCDEFGH'[index]);
    return item;
  });
  return { profile, cases, bundle };
}
