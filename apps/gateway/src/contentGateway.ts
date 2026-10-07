import {
  canonicalContentJson,
  createContentReader,
  validateOverlayHead,
  type EffectiveContentSnapshot,
  type OverlayHead,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import type { Immutable } from '@cookmate/catalogue';
import { abortable } from './admission';
import { createEvidenceBuilder } from './evidence';
import { GatewayError } from './errors';
import { createOrchestrator } from './orchestrator';
import type { ModelProvider } from './provider-contract';
import { createGateway, type GatewayOptions } from './server';

/** Host-owned cryptographic store, never a model tool or an unverified JSON snapshot. */
export interface VerifiedGatewayContent {
  head: Immutable<OverlayHead>;
  withVerifiedReading<Value>(
    head: Immutable<OverlayHead> | null,
    refs: readonly Immutable<RecipeContentRef>[],
    work: (view: {
      readonly head: Immutable<OverlayHead> | null;
      readonly snapshot: EffectiveContentSnapshot | null;
      assertActive(): undefined;
    }) => Promise<Value>,
  ): Promise<Value>;
}

const unavailable = () =>
  new GatewayError(
    {
      code: 'incompatible_version',
      messageKey: 'gateway.content_release_unavailable',
      retry: 'after_reconnect',
    },
    409,
  );

/**
 * One gateway instance serves one explicitly selected, verified content identity.
 * Every turn revalidates that head and current withdrawal policy under a reservation.
 * A newer downloaded release never silently changes a paired client's recipe evidence.
 */
export async function createVerifiedContentGateway(
  options: Omit<GatewayOptions, 'catalogue' | 'turn'> & {
    provider: ModelProvider;
    content: VerifiedGatewayContent;
  },
) {
  if (!validateOverlayHead(options.content.head)) throw unavailable();
  const head = JSON.parse(canonicalContentJson(options.content.head, 1024)) as OverlayHead;
  const reserve = options.content.withVerifiedReading.bind(options.content);
  let closed = false;
  const checkedReading = (view: Parameters<Parameters<typeof reserve>[2]>[0]) => {
    if (
      closed ||
      view.assertActive() !== undefined ||
      !view.snapshot ||
      canonicalContentJson(view.head, 1024) !== canonicalContentJson(head, 1024)
    )
      throw unavailable();
    const manifest = view.snapshot.envelope.manifest;
    if (
      manifest.releaseId !== head.releaseId ||
      manifest.sequence !== head.sequence ||
      view.snapshot.envelope.fingerprint !== head.fingerprint
    )
      throw unavailable();
    return createContentReader(view.snapshot);
  };
  const boundary = await reserve(head, [], async (view) => checkedReading(view).boundary);
  const gateway = createGateway({
    ...options,
    catalogue: boundary,
    async turn(request, execution) {
      try {
        const response = await reserve(head, [], async (view) => {
          execution.signal.throwIfAborted();
          const reading = checkedReading(view);
          if (canonicalContentJson(reading.identity) !== canonicalContentJson(boundary.identity))
            throw unavailable();
          const run = createOrchestrator(options.provider, createEvidenceBuilder(reading));
          // Deadline/disconnect releases the reservation even if a provider ignores its signal.
          const result = await abortable(run(request, execution), execution.signal);
          checkedReading(view);
          execution.signal.throwIfAborted();
          return result;
        });
        if (closed) throw unavailable();
        return response;
      } catch (error) {
        if (error instanceof GatewayError || execution.signal.aborted) throw error;
        throw unavailable();
      }
    },
  });
  gateway.app.addHook('preClose', async () => {
    closed = true;
    gateway.admission.close();
  });
  return gateway;
}
