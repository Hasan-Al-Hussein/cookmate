import { fetch as expoFetch } from 'expo/fetch';
import { AccountAuthError } from './authTypes';

/** Authentication JSON is small. Bound transport and reject cross-origin redirects. */
export function createAccountAuthFetch(origin: string, admitted: () => void): typeof fetch {
  return async (input, init) => {
    admitted();
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (
      url.origin !== origin ||
      !url.pathname.startsWith('/auth/v1/') ||
      url.username ||
      url.password
    )
      throw new AccountAuthError('provider');
    const abort = new AbortController();
    const caller =
      init?.signal ?? (typeof input === 'object' && 'signal' in input ? input.signal : null);
    const cancel = () => abort.abort();
    caller?.addEventListener('abort', cancel, { once: true });
    if (caller?.aborted) abort.abort();
    const timer = setTimeout(cancel, 20_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await expoFetch(url.href, {
        ...init,
        signal: abort.signal,
        redirect: 'error',
        credentials: 'omit',
      });
      reader = response.body?.getReader();
      const size = response.headers.get('content-length');
      if (size && Number(size) > 1024 * 1024) throw new AccountAuthError('provider');
      let bytes = 0;
      let reads = 0;
      let text = '';
      const decoder = new TextDecoder('utf-8', { fatal: true });
      if (reader) {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 1024 * 1024 || ++reads > 65536) throw new AccountAuthError('provider');
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
      }
      return new Response(response.status === 204 ? null : text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      if (error instanceof AccountAuthError) throw error;
      throw new AccountAuthError('network');
    } finally {
      clearTimeout(timer);
      caller?.removeEventListener('abort', cancel);
      try {
        await reader?.cancel();
      } catch {
        /* No body retained. */
      }
    }
  };
}
