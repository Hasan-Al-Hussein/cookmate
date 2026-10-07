import type { ContractError } from '@cookmate/contracts';

export class GatewayError extends Error {
  constructor(
    readonly detail: ContractError,
    readonly status: number,
  ) {
    super(detail.messageKey);
    this.name = 'GatewayError';
  }
}

export function gatewayError(
  code: ContractError['code'],
  status = 422,
  retry: ContractError['retry'] = 'after_correction',
): GatewayError {
  return new GatewayError({ code, messageKey: `gateway.${code}`, retry }, status);
}

export function safeError(error: unknown): GatewayError {
  return error instanceof GatewayError
    ? error
    : gatewayError('provider_unavailable', 503, 'after_delay');
}

/** Stable, allowlisted recovery markers; no provider diagnostics cross this boundary. */
export function contextBudgetError(reason: 'token_limit' | 'byte_limit'): GatewayError {
  return new GatewayError(
    {
      code: 'too_large',
      messageKey: 'gateway.too_large',
      retry: 'after_correction',
      field: `context.${reason}`,
    },
    422,
  );
}
