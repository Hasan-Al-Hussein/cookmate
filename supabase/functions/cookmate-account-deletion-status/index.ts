// This endpoint can only read an exact capability-bound deletion result.
import { createDeletionStatusHandler, createSupabaseBackend } from './handler.js';
const backend = createSupabaseBackend({
  url: Deno.env.get('SUPABASE_URL') ?? '',
  publishableKey: Deno.env.get('SUPABASE_ANON_KEY') ?? '',
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
});
const allowedOrigins = (Deno.env.get('COOKMATE_ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
Deno.serve(createDeletionStatusHandler({ backend, allowedOrigins }));
