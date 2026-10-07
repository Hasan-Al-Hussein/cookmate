// Generated handler.js is created by npm run build --workspace @cookmate/account-service.
// These are server environment variables; never EXPO_PUBLIC_ values.
import { createAccountHandler, createSupabaseBackend } from './handler.js';
const backend = createSupabaseBackend({
  url: Deno.env.get('SUPABASE_URL') ?? '',
  publishableKey: Deno.env.get('SUPABASE_ANON_KEY') ?? '',
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
});
const allowedOrigins = (Deno.env.get('COOKMATE_ALLOWED_ORIGINS') ?? '')
  .split(',').map((value) => value.trim()).filter(Boolean);
Deno.serve(createAccountHandler({ backend, allowedOrigins }));
