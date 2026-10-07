-- Additive content-version upgrade only. The transport envelope/schema_version stays 1.
-- The service parser still enforces exact allowlists and the 2 MiB canonical wire limit.
-- This migration does not opt any client into uploading personal data.
do $$
declare old_constraint text; matching_constraints integer;
begin
  select count(*), min(c.conname) into matching_constraints, old_constraint
    from pg_constraint c
    where c.conrelid = 'cookmate_private.accounts'::regclass and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%schemaVersion%';
  if matching_constraints <> 1 then
    raise exception 'Expected exactly one existing account snapshot version constraint';
  end if;
  execute format('alter table cookmate_private.accounts drop constraint %I', old_constraint);
end;
$$;

alter table cookmate_private.accounts add constraint accounts_snapshot_versions_check
  check (snapshot is null or coalesce(
    jsonb_typeof(snapshot) = 'object'
    and octet_length(snapshot::text) <= 4194304
    and snapshot->>'format' = 'cookmate-account-snapshot'
    and jsonb_typeof(snapshot->'schemaVersion') = 'number'
    and snapshot->>'schemaVersion' in ('1', '2'), false));

create or replace function public.cookmate_sync_commit(
  p_owner uuid, p_session uuid, p_operation uuid, p_expected_revision bigint, p_snapshot jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a cookmate_private.accounts;
  r cookmate_private.sync_receipts;
  d text;
  stamp timestamptz;
begin
  perform cookmate_private.require_session(p_owner, p_session);
  if p_operation is null or p_expected_revision is null or p_expected_revision < 0
    or p_expected_revision >= 9007199254740991 or p_snapshot is null
    or jsonb_typeof(p_snapshot) <> 'object' or octet_length(p_snapshot::text) > 4194304
    or p_snapshot->>'format' is distinct from 'cookmate-account-snapshot'
    or jsonb_typeof(p_snapshot->'schemaVersion') is distinct from 'number'
    or p_snapshot->>'schemaVersion' not in ('1', '2') then
    raise exception using errcode = 'CM400', message = 'account_invalid_request';
  end if;
  d := encode(sha256(convert_to(p_snapshot::text, 'UTF8')), 'hex');
  insert into cookmate_private.accounts(user_id) values (p_owner) on conflict do nothing;
  select * into strict a from cookmate_private.accounts where user_id = p_owner for update;
  if a.deletion_operation is not null then
    raise exception using errcode = 'CM410', message = 'account_deletion_pending';
  end if;
  select * into r from cookmate_private.sync_receipts
    where user_id = p_owner and operation_id = p_operation;
  if found then
    if r.payload_digest <> d or r.base_revision <> p_expected_revision then
      raise exception using errcode = 'CM409', message = 'account_operation_rebound';
    end if;
    -- A previously committed v1 request keeps its exact proof after an upgrade.
    -- Returning this receipt does not reinstall its old snapshot.
    return jsonb_build_object('ownerId', r.user_id, 'operationId', r.operation_id,
      'revision', r.revision, 'committedAt', r.committed_at);
  end if;
  if a.snapshot->>'schemaVersion' = '2' and p_snapshot->>'schemaVersion' = '1' then
    raise exception using errcode = 'CM426', message = 'account_snapshot_upgrade_required';
  end if;
  if a.revision <> p_expected_revision then
    raise exception using errcode = 'CM412', message = 'account_revision_changed';
  end if;
  if (select count(*) from cookmate_private.sync_receipts
      where user_id = p_owner and committed_at > clock_timestamp() - interval '1 minute') >= 60 then
    raise exception using errcode = 'CM429', message = 'account_sync_rate_limited';
  end if;
  stamp := clock_timestamp();
  update cookmate_private.accounts set revision = a.revision + 1,
    snapshot = p_snapshot, updated_at = stamp where user_id = p_owner;
  insert into cookmate_private.sync_receipts
    (user_id, operation_id, base_revision, payload_digest, revision, committed_at)
    values (p_owner, p_operation, p_expected_revision, d, a.revision + 1, stamp);
  return jsonb_build_object('ownerId', p_owner, 'operationId', p_operation,
    'revision', a.revision + 1, 'committedAt', stamp);
end;
$$;

-- CREATE OR REPLACE retains grants; keep the restricted boundary explicit.
revoke all on function public.cookmate_sync_commit(uuid,uuid,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.cookmate_sync_commit(uuid,uuid,uuid,bigint,jsonb) to service_role;
