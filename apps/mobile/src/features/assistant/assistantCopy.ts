import type { ContractError, PreferenceType } from '@cookmate/contracts';
export const preferenceLabels: Record<PreferenceType, string> = {
  cuisine: 'Cuisine',
  ingredient_like: 'Ingredient I like',
  ingredient_avoid: 'Ingredient I avoid',
  dietary_style: 'Dietary style',
};
export function errorCopy(error: ContractError) {
  const message = baseErrorCopy(error);
  const seconds = error.retryAfterSeconds;
  if (
    error.retry === 'after_delay' &&
    ['busy', 'quota', 'provider_unavailable'].includes(error.code) &&
    typeof seconds === 'number' &&
    Number.isInteger(seconds) &&
    seconds > 0 &&
    seconds <= 86_400
  ) {
    const duration =
      seconds < 60
        ? `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`
        : `${Math.ceil(seconds / 60)} ${seconds <= 60 ? 'minute' : 'minutes'}`;
    // Errors also appear in retained history: this is the original hint, not a live countdown.
    return `${message} This attempt asked you to wait at least ${duration} before trying again. Nothing is sent automatically.`;
  }
  return message;
}
function baseErrorCopy(error: ContractError) {
  if (error.messageKey === 'assistant.sharing_consent_required')
    return 'Review AI data sharing before sending. Your draft and local cooking work are kept.';
  switch (error.code) {
    case 'unauthenticated':
      return 'Pair this iPhone with your laptop before asking CookMate.';
    case 'pairing_expired':
      return 'Pairing has expired. Get a new code from your laptop.';
    case 'pairing_revoked':
      return 'This pairing was revoked. Get a new pairing code if you want to reconnect.';
    case 'network_unavailable':
      return 'The laptop could not be reached. Check that it is awake and on the right network.';
    case 'untrusted_endpoint':
      return 'This address is not trusted. Use the trusted HTTPS address supplied with the laptop setup.';
    case 'incompatible_version':
      return 'The app and laptop need compatible versions. Local recipes and cooking features remain available.';
    case 'stale_context':
    case 'stale_target':
      return 'The context or saved choices changed. Review the current state and make a new request.';
    case 'too_large':
      return 'This request is too large. Keep your draft and shorten it or choose a smaller working context.';
    case 'already_pending':
      return 'This request is already pending. Wait or stop it before starting another.';
    case 'busy':
      return 'The assistant is busy. You can try this request again later.';
    case 'quota':
      return 'The AI service is limiting requests. Try later; local cooking features remain available.';
    case 'deadline':
      return 'An answer did not arrive in time. Check the request before deliberately retrying it.';
    case 'provider_unavailable':
      return 'The AI service could not answer. Keep your message and try again later.';
    case 'provider_refused':
      return 'The AI service declined this request. Edit your message before sending a new request. No actions were authorized by this reply.';
    case 'invalid_model_result':
      return 'The answer could not be verified. No actions were authorized by it.';
    case 'unsupported_request':
      return 'This request is not supported here. Use the recipe, plan or preferences controls.';
    case 'cancelled':
      return 'Waiting stopped. Any completed local changes remain saved.';
    case 'invalid_input':
      return 'Check the entered details and try again.';
    default:
      return 'The result could not be confirmed. Keep your draft and check again; your saved work has not been reset.';
  }
}
