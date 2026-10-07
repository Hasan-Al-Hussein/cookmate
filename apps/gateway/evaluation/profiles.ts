export type ProfileId = 'assistant-evaluation.v1' | 'source-amendment-v2';
export interface PinnedDocument {
  role: string;
  path: string;
  sha256: string;
}
export interface EvaluationProfile {
  id: ProfileId;
  fixture: PinnedDocument;
  catalogue: {
    identity: { version: string; fingerprint: string };
    sha256: string;
    provenanceSha256: string;
  };
  documents: PinnedDocument[];
  validationReport: PinnedDocument | null;
}

export const DEPENDENCY_INVENTORY: PinnedDocument = {
  role: 'preserved_dependency_inventory',
  path: 'implementation/quality/source-amendment-v2-20260928/preserved-v1/MANIFEST.json',
  sha256: '4ae68656cf4af49d98cbdeba828f377dd96b3a49bfcd20bcc70952e6f5d6887d',
};

const qualityDocument = (role: string, path: string, sha256: string): PinnedDocument => ({
  role,
  path: `implementation/quality/${path}`,
  sha256,
});

// Actual executed build-01 report; the canonical authored NOT_RUN report remains historical below.
const V2_VALIDATION_REPORT = qualityDocument(
  'executed_validation',
  'source-amendment-v2-20260928/runs/build-01/validation-report.json',
  'af1cc5ffeca31e4fea6ac8fb8387735b025205be51188a8aeb634a6b1a28b46e',
);

const profiles: Record<ProfileId, EvaluationProfile> = {
  'assistant-evaluation.v1': {
    id: 'assistant-evaluation.v1',
    fixture: qualityDocument(
      'fixture',
      'fixtures/assistant-evaluation.v1.json',
      'a69034e897a7a66400b3ce8e58c2bf52480a4f5097333c7d834d0cdce4480113',
    ),
    catalogue: {
      identity: {
        version: 'cookmate-2026-09-27.v1',
        fingerprint: '1c564aed197f0ff13e0c8a81c95d775960f8c7f021cd3e948f116ae471b5e1ef',
      },
      sha256: 'f153eb9e31928233602109a2cbae5d7598475d7dc5f641d9b47074fac8062193',
      provenanceSha256: '342914858b0ec601732e65360c9f48fbca96541d8c1b857bf6c7796975786e6d',
    },
    documents: [
      // Preserved current plan bytes; the bundle's older build-time hash stays historical.
      qualityDocument(
        'plan',
        'assistant-evaluation-plan.md',
        'cb49245fe56cae3d9235e3e80bb0828e424f742efcd0aea0440a3fc4d989160c',
      ),
      qualityDocument(
        'builder',
        'build-assistant-fixtures.mjs',
        '16d81a998d1f9fcb07ef106a39223a46df1b2acd6835ca912466b5d0225dd47d',
      ),
      qualityDocument(
        'validator',
        'validate-assistant-fixtures.mjs',
        '1946e6b6d7fceec85b202abc7000cd4f86c06873e6bf650388d2e4915f066342',
      ),
      qualityDocument(
        'schema',
        'fixtures/assistant-fixture.schema.json',
        '54af7ed7a5c9595bf01de6a7204e1c9b016718460969129c69edc8ffa7716a41',
      ),
      qualityDocument(
        'readme',
        'fixtures/README.md',
        '7c6950aad548fd2699a762e74aaa183898e83a93a1174b5e5f8efe1dd9a7e564',
      ),
      qualityDocument(
        'review',
        'fixtures/review-record.md',
        '16310544014842b864592f70f83cbb97549db3d48296656673f88fbf330a5856',
      ),
    ],
    validationReport: qualityDocument(
      'executed_validation',
      'fixtures/validation-report.json',
      '84f85fab17df2d0a4cd6367a00d8347be3b6344a2be76e6956b7b73186e11587',
    ),
  },
  'source-amendment-v2': {
    id: 'source-amendment-v2',
    fixture: qualityDocument(
      'fixture',
      'fixtures/v2/assistant-evaluation.v2.json',
      'ec5d9e90a9ef455181f80ec41a6fb948f4b513cce58ff3b85e00ec1f103905a6',
    ),
    catalogue: {
      identity: {
        version: 'cookmate-2026-09-28.v2',
        fingerprint: '383be590385bea53149d7697ae7faed6b6098efda12e7679a0524cfaab2df217',
      },
      sha256: '0ded08f1d81513f4dd6247e1a9584e0f0d4832811fbb3ae10e1c2160d5657b4a',
      provenanceSha256: '382b71fbc76a1456eee24da71c03d9e8babb8b307e357344fa7fa5bfd4bc5e93',
    },
    documents: [
      qualityDocument(
        'plan',
        'assistant-evaluation-plan.v2.md',
        '17535cb5effd78e9aada7ddcd13a9e4afad90c3eb81702b5d6a7eda11033fe54',
      ),
      qualityDocument(
        'builder',
        'build-assistant-fixtures.v2.mjs',
        '2c24757df2721ff925883693371314f6816f624f6d277e24e8284065f04fe3c3',
      ),
      qualityDocument(
        'validator',
        'validate-assistant-fixtures.v2.mjs',
        '2c523bf8a2897a106a0b6856c9638f60b3e47591c917ef704ecdf2840a52b9aa',
      ),
      qualityDocument(
        'rules',
        'source-amendment-v2.rules.mjs',
        'cc1aae2d2847e3fb9e73716f96186d1424d28ab94c309fecd86c51a05f5ce2b1',
      ),
      qualityDocument(
        'schema',
        'fixtures/v2/assistant-fixture.schema.json',
        '54af7ed7a5c9595bf01de6a7204e1c9b016718460969129c69edc8ffa7716a41',
      ),
      qualityDocument(
        'readme',
        'fixtures/v2/README.md',
        '7397f365533ee1a33b52cbcbed60ac703a8d8da4b625f28bc9e5c45bbd22d0fe',
      ),
      qualityDocument(
        'review',
        'fixtures/v2/review-record.md',
        'eeb8f4ab864a8d9e80adfbd9b6c51cfa53b3482b58c53ea75308ed0e9b97965a',
      ),
      qualityDocument(
        'historical_authored_not_run_report',
        'fixtures/v2/validation-report.json',
        '1590d5f9a5b83f2d5b136f66868ea0628c3f20618ba0048955ea1b831244f8b2',
      ),
      qualityDocument(
        'control_descriptor',
        'fixtures/v2/unannotated-s06.control.json',
        '6d6b5c30761db6ab553a6c7670f64bac5db4b6755c99df93a181b51f7d634970',
      ),
      qualityDocument(
        'control_identity_input',
        'fixtures/v2/unannotated-s06.identity-input.json',
        '037797146981bd6a912a16b27bef244e71ac8165a57af0097702098e518b1b94',
      ),
      qualityDocument(
        'control_harness',
        'unannotated-s06.control.v2.mjs',
        '52b7be09d9dbe463e69fdb2e62cd9225b2de6abe767d0bf9a012417059507789',
      ),
      qualityDocument(
        'control_purposes',
        'fixtures/v2/amendment-controls.v2.json',
        '7319142f8201c3976dc6dd2e0b19126a0fe4cbcdd34c97ce7099a753b1250ca7',
      ),
      qualityDocument(
        'control_frozen_v1_fixture',
        'source-amendment-v2-20260928/preserved-v1/docsRoot/implementation/quality/fixtures/assistant-evaluation.v1.json',
        'a69034e897a7a66400b3ce8e58c2bf52480a4f5097333c7d834d0cdce4480113',
      ),
    ],
    validationReport: V2_VALIDATION_REPORT,
  },
};

export class ProfileAdmissionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ProfileAdmissionError';
  }
}

export function selectProfile(id: unknown): EvaluationProfile {
  if (typeof id !== 'string' || !id) throw new ProfileAdmissionError('profile_required');
  if (!Object.hasOwn(profiles, id)) throw new ProfileAdmissionError('unknown_profile');
  // Callers cannot modify the registered pins for a later invocation.
  return structuredClone(profiles[id as ProfileId]);
}
