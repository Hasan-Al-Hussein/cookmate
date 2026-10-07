import { ConnectionError } from '../../connection/errors';

/** Change this version whenever the disclosed recipients or data scope changes. */
export const aiConsentVersion = '2026-09-30.1';
export const aiConsentKey = 'cookmate.ai-sharing-consent.v1';
export interface AiConsentStore {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}
export interface AiConsentState {
  status: 'loading' | 'required' | 'allowed' | 'declined' | 'saving' | 'error';
  acceptedAt?: string;
}
interface ConsentRecord {
  format: 1;
  installationId: string;
  disclosureVersion: string;
  allowed: boolean;
  decidedAt: string;
}

function parseRecord(raw: string): ConsentRecord {
  if (raw.length > 2048) throw new Error('Invalid consent record');
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid consent');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !==
      'allowed,decidedAt,disclosureVersion,format,installationId' ||
    record.format !== 1 ||
    typeof record.installationId !== 'string' ||
    !record.installationId ||
    typeof record.disclosureVersion !== 'string' ||
    !record.disclosureVersion ||
    typeof record.allowed !== 'boolean' ||
    typeof record.decidedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.decidedAt)) ||
    new Date(record.decidedAt).toISOString() !== record.decidedAt
  )
    throw new Error('Invalid consent record');
  return record as unknown as ConsentRecord;
}

/** Device-local permission, separate from pairing, backups, chat and action approvals. */
export class AiConsentController {
  private state: AiConsentState = { status: 'loading' };
  private listeners = new Set<() => void>();
  private installationId: string | null = null;
  private epoch = 0;
  private writes: Promise<void> = Promise.resolve();
  private pendingChoice: boolean | undefined;
  constructor(
    private store: AiConsentStore,
    private now = () => new Date().toISOString(),
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(state: AiConsentState) {
    this.state = Object.freeze(state);
    this.listeners.forEach((listener) => listener());
  }
  async bind(installationId: string | null) {
    if (installationId === this.installationId && this.pendingChoice !== undefined) {
      await this.decide(this.pendingChoice);
      return;
    }
    const epoch = ++this.epoch;
    this.installationId = installationId;
    this.pendingChoice = undefined;
    this.publish({ status: 'loading' });
    if (!installationId) {
      this.publish({ status: 'error' });
      return;
    }
    try {
      await this.writes;
      const raw = await this.store.read();
      if (epoch !== this.epoch) return;
      const record = raw === null ? null : parseRecord(raw);
      if (
        !record ||
        record.installationId !== installationId ||
        record.disclosureVersion !== aiConsentVersion
      ) {
        this.publish({ status: 'required' });
      } else {
        this.publish(
          record.allowed
            ? { status: 'allowed', acceptedAt: record.decidedAt }
            : { status: 'declined' },
        );
      }
    } catch {
      if (epoch === this.epoch) this.publish({ status: 'error' });
    }
  }
  retry = () => this.bind(this.installationId);
  decide(allowed: boolean): Promise<void> {
    const installationId = this.installationId;
    if (
      !installationId ||
      this.state.status === 'loading' ||
      (this.state.status === 'error' && this.pendingChoice === undefined) ||
      (allowed && this.state.status === 'saving')
    )
      return Promise.resolve();
    const epoch = ++this.epoch;
    this.pendingChoice = allowed;
    // Stop granting permission immediately, including while a withdrawal is being saved.
    this.publish({ status: 'saving' });
    const operation = this.writes
      .catch(() => undefined)
      .then(async () => {
        const record: ConsentRecord = {
          format: 1,
          installationId,
          disclosureVersion: aiConsentVersion,
          allowed,
          decidedAt: this.now(),
        };
        const serialized = JSON.stringify(record);
        try {
          await this.store.write(serialized);
          if ((await this.store.read()) !== serialized)
            throw new Error('Consent was not confirmed');
          if (epoch === this.epoch) {
            this.pendingChoice = undefined;
            this.publish(
              allowed
                ? { status: 'allowed', acceptedAt: record.decidedAt }
                : { status: 'declined' },
            );
          }
        } catch {
          if (epoch === this.epoch) this.publish({ status: 'error' });
        }
      });
    this.writes = operation;
    return operation;
  }
  assertAllowed() {
    if (this.state.status !== 'allowed')
      throw new ConnectionError({
        code: 'unsupported_request',
        messageKey: 'assistant.sharing_consent_required',
        retry: 'after_correction',
      });
  }
}
