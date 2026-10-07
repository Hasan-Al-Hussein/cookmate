-- Durable deletion evidence must outlive the Auth user and account-data cascades.
-- Only the authenticated admission RPC may register a capability digest. A digest
-- permits receipt lookup at the Edge boundary; it never authorizes deletion.
create table cookmate_private.account_deletions (
  operation_id uuid primary key,
  pending_owner uuid,
  base_revision bigint check (base_revision >= 0 and base_revision <= 9007199254740991),
  admitted_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  expires_at timestamptz,
  check ((pending_owner is not null and base_revision is not null
      and completed_at is null and expires_at is null)
    or (pending_owner is null and base_revision is null
      and completed_at is not null and expires_at is not null
      and completed_at >= admitted_at and expires_at > completed_at))
);
create unique index account_deletions_pending_owner
  on cookmate_private.account_deletions(pending_owner) where pending_owner is not null;
create index account_deletions_expiry
  on cookmate_private.account_deletions(expires_at) where completed_at is not null;

create table cookmate_private.account_deletion_capabilities (
  operation_id uuid not null references cookmate_private.account_deletions(operation_id) on delete cascade,
  capability_digest text not null check (length(capability_digest) = 64 and capability_digest ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz not null default clock_timestamp(),
  primary key (operation_id, capability_digest)
);
alter table cookmate_private.account_deletions enable row level security;
alter table cookmate_private.account_deletion_capabilities enable row level security;
revoke all on cookmate_private.account_deletions, cookmate_private.account_deletion_capabilities
  from public, anon, authenticated, service_role;

-- The old overload must not remain an admission path without a recovery capability.
drop function public.cookmate_account_begin_delete(uuid, uuid, uuid, bigint);
create function public.cookmate_account_begin_delete(
  p_owner uuid, p_session uuid, p_operation uuid, p_expected_revision bigint,
  p_capability_digest text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a cookmate_private.accounts;
  deletion cookmate_private.account_deletions;
begin
  -- DELETE holds the conflicting Auth-row lock before firing its completion trigger.
  -- Taking this lock before account/receipt locks avoids an inverse cascade lock order.
  perform 1 from auth.users where id = p_owner for key share;
  if not found then
    raise exception using errcode = 'CM401', message = 'account_session_invalid';
  end if;
  perform cookmate_private.require_session(p_owner, p_session);
  if not exists (select 1 from auth.sessions where id = p_session and user_id = p_owner
      and created_at > clock_timestamp() - interval '10 minutes') then
    raise exception using errcode = 'CM403', message = 'account_recent_sign_in_required';
  end if;
  if p_operation is null or p_expected_revision is null or p_expected_revision < 0
    or p_expected_revision > 9007199254740991 or p_capability_digest is null
    or length(p_capability_digest) <> 64
    or p_capability_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'CM400', message = 'account_invalid_request';
  end if;

  insert into cookmate_private.accounts(user_id) values (p_owner) on conflict do nothing;
  select * into strict a from cookmate_private.accounts where user_id = p_owner for update;
  if a.deletion_operation is not null and a.deletion_operation <> p_operation then
    raise exception using errcode = 'CM409', message = 'account_operation_rebound';
  end if;
  select * into deletion from cookmate_private.account_deletions
    where operation_id = p_operation for update;
  if found then
    if deletion.completed_at is not null or deletion.pending_owner is distinct from p_owner
      or deletion.base_revision is distinct from p_expected_revision then
      raise exception using errcode = 'CM409', message = 'account_operation_rebound';
    end if;
  else
    if a.revision <> p_expected_revision then
      -- A legacy same-operation marker is already frozen, even without new proof.
      -- Only a new, non-admitted operation may report a reviewable stale base.
      if a.deletion_operation is not null then
        raise exception using errcode = 'CM409', message = 'account_operation_rebound';
      end if;
      raise exception using errcode = 'CM412', message = 'account_revision_changed';
    end if;
    -- ON CONFLICT also covers a different owner's concurrent admission of this UUID.
    insert into cookmate_private.account_deletions(operation_id, pending_owner, base_revision)
      values (p_operation, p_owner, p_expected_revision) on conflict do nothing;
    select * into deletion from cookmate_private.account_deletions
      where operation_id = p_operation for update;
    if not found or deletion.completed_at is not null
      or deletion.pending_owner is distinct from p_owner
      or deletion.base_revision is distinct from p_expected_revision then
      raise exception using errcode = 'CM409', message = 'account_operation_rebound';
    end if;
  end if;
  if a.revision <> deletion.base_revision then
    raise exception using errcode = 'CM409', message = 'account_operation_rebound';
  end if;

  if not exists (select 1 from cookmate_private.account_deletion_capabilities
      where operation_id = p_operation and capability_digest = p_capability_digest) then
    if (select count(*) from cookmate_private.account_deletion_capabilities
        where operation_id = p_operation) >= 8 then
      raise exception using errcode = 'CM430', message = 'account_deletion_capability_limit';
    end if;
    insert into cookmate_private.account_deletion_capabilities(operation_id, capability_digest)
      values (p_operation, p_capability_digest);
  end if;
  -- A legacy marker may acquire its first receipt only at its unchanged frozen revision.
  update cookmate_private.accounts set deletion_operation = p_operation where user_id = p_owner;
  return jsonb_build_object('ownerId', p_owner, 'operationId', p_operation, 'deletionPending', true);
end;
$$;

create function cookmate_private.complete_account_deletion()
returns trigger language plpgsql security definer set search_path = '' as $$
declare stamp timestamptz := clock_timestamp();
begin
  -- No insert: an unrelated administrative deletion must never fabricate admission.
  -- This update and all FK cascades commit or roll back with the Auth DELETE itself.
  update cookmate_private.account_deletions
    set pending_owner = null, base_revision = null,
      completed_at = stamp, expires_at = stamp + interval '30 days'
    where pending_owner = old.id and completed_at is null;
  return old;
end;
$$;
revoke all on function cookmate_private.complete_account_deletion()
  from public, anon, authenticated, service_role;
create trigger cookmate_complete_account_deletion after delete on auth.users
  for each row execute function cookmate_private.complete_account_deletion();

-- Internal service-only projection. The Edge adapter compares all eight digest
-- slots in constant time and never exposes these digests in a public response.
create function public.cookmate_account_deletion_receipt(p_operation uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  deletion cookmate_private.account_deletions;
  digests jsonb;
begin
  select * into deletion from cookmate_private.account_deletions
    where operation_id = p_operation;
  if not found or (deletion.expires_at is not null and deletion.expires_at <= clock_timestamp()) then
    return null;
  end if;
  select coalesce(jsonb_agg(capability_digest order by capability_digest), '[]'::jsonb)
    into digests from cookmate_private.account_deletion_capabilities where operation_id = p_operation;
  if jsonb_array_length(digests) not between 1 and 8 then
    raise exception using errcode = 'CM500', message = 'account_deletion_evidence_invalid';
  end if;
  return jsonb_build_object('operationId', deletion.operation_id,
    'state', case when deletion.completed_at is null then 'pending' else 'deleted' end,
    'deletedAt', deletion.completed_at, 'expiresAt', deletion.expires_at,
    'capabilityDigests', digests);
end;
$$;

create function public.cookmate_account_prune_deletions(p_limit integer default 100)
returns integer language plpgsql security definer set search_path = '' as $$
declare removed integer;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception using errcode = 'CM400', message = 'account_invalid_request';
  end if;
  with expired as (
    select operation_id from cookmate_private.account_deletions
    where completed_at is not null and expires_at <= clock_timestamp()
    order by expires_at, operation_id limit p_limit for update skip locked
  ), deleted as (
    delete from cookmate_private.account_deletions d using expired e
    where d.operation_id = e.operation_id returning d.operation_id
  ) select count(*)::integer into removed from deleted;
  return removed;
end;
$$;

revoke all on function public.cookmate_account_begin_delete(uuid, uuid, uuid, bigint, text)
  from public, anon, authenticated;
revoke all on function public.cookmate_account_deletion_receipt(uuid)
  from public, anon, authenticated;
revoke all on function public.cookmate_account_prune_deletions(integer)
  from public, anon, authenticated;
grant execute on function public.cookmate_account_begin_delete(uuid, uuid, uuid, bigint, text) to service_role;
grant execute on function public.cookmate_account_deletion_receipt(uuid) to service_role;
grant execute on function public.cookmate_account_prune_deletions(integer) to service_role;
