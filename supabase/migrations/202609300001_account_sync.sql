-- Client tokens cannot read or mutate these tables or execute privileged RPCs.
-- The Edge handler validates the complete allowlisted snapshot and derives both
-- identities from a verified Supabase session, never from the request body.
create schema if not exists cookmate_private;
revoke all on schema cookmate_private from public, anon, authenticated;

create table cookmate_private.accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0 and revision <= 9007199254740991),
  schema_version integer not null default 1 check (schema_version = 1),
  snapshot jsonb,
  updated_at timestamptz,
  deletion_operation uuid,
  check ((revision = 0 and snapshot is null and updated_at is null)
      or (revision > 0 and snapshot is not null and updated_at is not null)),
  check (snapshot is null or (jsonb_typeof(snapshot) = 'object'
    -- JSONB's textual representation inserts whitespace. The Edge domain parser
    -- independently retains the stricter 2 MiB snapshot wire budget.
    and octet_length(snapshot::text) <= 4194304
    and snapshot->>'format' = 'cookmate-account-snapshot'
    and snapshot->>'schemaVersion' = '1'))
);
create table cookmate_private.sync_receipts (
  user_id uuid not null references cookmate_private.accounts(user_id) on delete cascade,
  operation_id uuid not null,
  base_revision bigint not null check (base_revision >= 0),
  payload_digest text not null,
  revision bigint not null check (revision > 0),
  committed_at timestamptz not null,
  primary key (user_id, operation_id),
  unique (user_id, revision)
);
create index sync_receipts_by_time on cookmate_private.sync_receipts(user_id, committed_at);
alter table cookmate_private.accounts enable row level security;
alter table cookmate_private.sync_receipts enable row level security;
revoke all on all tables in schema cookmate_private from public, anon, authenticated;

create function cookmate_private.require_session(p_owner uuid, p_session uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_owner is null or p_session is null or not exists (
    select 1 from auth.sessions s join auth.users u on u.id = s.user_id
    where s.id = p_session and s.user_id = p_owner
  ) then
    raise exception using errcode = 'CM401', message = 'account_session_invalid';
  end if;
end;
$$;
revoke all on function cookmate_private.require_session(uuid, uuid) from public, anon, authenticated;

create function public.cookmate_sync_read(p_owner uuid, p_session uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a cookmate_private.accounts;
begin
  perform cookmate_private.require_session(p_owner, p_session);
  insert into cookmate_private.accounts(user_id) values (p_owner) on conflict do nothing;
  select * into strict a from cookmate_private.accounts where user_id = p_owner;
  return jsonb_build_object('ownerId', a.user_id, 'revision', a.revision,
    'schemaVersion', a.schema_version, 'snapshot', a.snapshot,
    'updatedAt', a.updated_at, 'deletionPending', a.deletion_operation is not null,
    'deletionOperationId', a.deletion_operation);
end;
$$;

create function public.cookmate_sync_commit(
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
    or p_snapshot->>'schemaVersion' is distinct from '1' then
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
    return jsonb_build_object('ownerId', r.user_id, 'operationId', r.operation_id,
      'revision', r.revision, 'committedAt', r.committed_at);
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

create function public.cookmate_account_begin_delete(
  p_owner uuid, p_session uuid, p_operation uuid, p_expected_revision bigint
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare a cookmate_private.accounts;
begin
  perform cookmate_private.require_session(p_owner, p_session);
  -- Token refresh does not create a new auth session: deletion requires recent sign-in.
  if not exists (select 1 from auth.sessions where id = p_session
      and user_id = p_owner and created_at > clock_timestamp() - interval '10 minutes') then
    raise exception using errcode = 'CM403', message = 'account_recent_sign_in_required';
  end if;
  if p_operation is null or p_expected_revision is null or p_expected_revision < 0 then
    raise exception using errcode = 'CM400', message = 'account_invalid_request';
  end if;
  insert into cookmate_private.accounts(user_id) values (p_owner) on conflict do nothing;
  select * into strict a from cookmate_private.accounts where user_id = p_owner for update;
  if a.deletion_operation is null and a.revision <> p_expected_revision then
    raise exception using errcode = 'CM412', message = 'account_revision_changed';
  end if;
  if a.deletion_operation is not null and a.deletion_operation <> p_operation then
    raise exception using errcode = 'CM409', message = 'account_operation_rebound';
  end if;
  update cookmate_private.accounts set deletion_operation = p_operation where user_id = p_owner;
  return jsonb_build_object('ownerId', p_owner, 'operationId', p_operation, 'deletionPending', true);
end;
$$;

revoke all on function public.cookmate_sync_read(uuid, uuid) from public, anon, authenticated;
revoke all on function public.cookmate_sync_commit(uuid, uuid, uuid, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.cookmate_account_begin_delete(uuid, uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.cookmate_sync_read(uuid, uuid) to service_role;
grant execute on function public.cookmate_sync_commit(uuid, uuid, uuid, bigint, jsonb) to service_role;
grant execute on function public.cookmate_account_begin_delete(uuid, uuid, uuid, bigint) to service_role;
