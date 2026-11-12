-- i18n collaboratory hub schema: multi-project translation review
-- Helpers live in private schema `app` so they are not callable via the Data API.

create schema if not exists app;
revoke all on schema app from public;
-- authenticated needs USAGE so RLS policies and public RPC wrappers can call app.* helpers.
grant usage on schema app to postgres, service_role, authenticated;

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.hub_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  github_repo text,
  github_branch text not null default 'main',
  locales_path text not null default 'locales',
  source_locale text not null default 'en',
  placeholder_style text not null default 'auto'
    check (placeholder_style in ('i18next', 'icu', 'single-brace', 'auto')),
  rich_text boolean not null default false,
  head_version_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.project_locales (
  project_id uuid not null references public.projects (id) on delete cascade,
  locale text not null,
  label text,
  primary key (project_id, locale)
);

create table public.project_members (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('admin', 'reviewer')),
  created_at timestamptz not null default now(),
  unique (project_id, user_id)
);

create table public.member_languages (
  member_id uuid not null references public.project_members (id) on delete cascade,
  locale text not null,
  primary key (member_id, locale)
);

create table public.project_invites (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  email text,
  github_login text,
  role text not null check (role in ('admin', 'reviewer')),
  locales text[] not null default '{}',
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  check (email is not null or github_login is not null)
);

create unique index project_invites_email_unique
  on public.project_invites (project_id, lower(email))
  where email is not null and accepted_at is null;

create unique index project_invites_github_unique
  on public.project_invites (project_id, lower(github_login))
  where github_login is not null and accepted_at is null;

create table public.source_strings (
  project_id uuid not null references public.projects (id) on delete cascade,
  key text not null,
  text text not null default '',
  note text not null default '',
  text_fp text not null,
  previous_text text,
  updated_at timestamptz not null default now(),
  primary key (project_id, key)
);

create table public.translations (
  project_id uuid not null references public.projects (id) on delete cascade,
  locale text not null,
  key text not null,
  text text not null default '',
  note text not null default '',
  approved boolean not null default false,
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  en_fp text,
  stale boolean not null default false,
  stale_reason text,
  updated_at timestamptz not null default now(),
  primary key (project_id, locale, key)
);

create index translations_project_locale_idx
  on public.translations (project_id, locale);

create index translations_unapproved_idx
  on public.translations (project_id, locale)
  where approved = false or stale = true;

create table public.revisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  version_hash text not null,
  pushed_at timestamptz not null default now(),
  source_key_count integer not null default 0,
  changed_key_count integer not null default 0,
  initial_approval text check (initial_approval is null or initial_approval in ('approved', 'unapproved')),
  unique (project_id, version_hash)
);

create table public.revision_changes (
  revision_id uuid not null references public.revisions (id) on delete cascade,
  key text not null,
  old_text text,
  new_text text not null,
  primary key (revision_id, key)
);

create table public.locale_leases (
  project_id uuid not null references public.projects (id) on delete cascade,
  locale text not null,
  holder_id uuid not null references auth.users (id) on delete cascade,
  holder_name text not null default '',
  until timestamptz not null,
  claimed_at timestamptz not null default now(),
  primary key (project_id, locale)
);

create table public.project_credentials (
  project_id uuid primary key references public.projects (id) on delete cascade,
  push_secret_hash text,
  github_token_ciphertext text,
  github_token_nonce text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

-- ---------------------------------------------------------------------------
-- Auth helpers (private schema)
-- ---------------------------------------------------------------------------

create or replace function app.is_hub_admin(uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.hub_admins h where h.user_id = uid
  );
$$;

create or replace function app.is_project_member(pid uuid, uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.project_members m
    where m.project_id = pid and m.user_id = uid
  );
$$;

create or replace function app.is_project_admin(pid uuid, uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.project_members m
    where m.project_id = pid and m.user_id = uid and m.role = 'admin'
  )
  or app.is_hub_admin(uid);
$$;

create or replace function app.can_review(pid uuid, loc text, uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    app.is_project_admin(pid, uid)
    or exists (
      select 1
      from public.project_members m
      join public.member_languages ml on ml.member_id = m.id
      where m.project_id = pid
        and m.user_id = uid
        and m.role = 'reviewer'
        and ml.locale = loc
    );
$$;

create or replace function app.member_project_ids(uid uuid default auth.uid())
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.project_id from public.project_members m where m.user_id = uid
  union
  select p.id from public.projects p where app.is_hub_admin(uid);
$$;

revoke all on function app.is_hub_admin(uuid) from public;
revoke all on function app.is_project_member(uuid, uuid) from public;
revoke all on function app.is_project_admin(uuid, uuid) from public;
revoke all on function app.can_review(uuid, text, uuid) from public;
revoke all on function app.member_project_ids(uuid) from public;

grant execute on function app.is_hub_admin(uuid) to authenticated, service_role;
grant execute on function app.is_project_member(uuid, uuid) to authenticated, service_role;
grant execute on function app.is_project_admin(uuid, uuid) to authenticated, service_role;
grant execute on function app.can_review(uuid, text, uuid) to authenticated, service_role;
grant execute on function app.member_project_ids(uuid) to authenticated, service_role;

-- Public wrappers for the browser (thin, no secrets)
create or replace function public.is_hub_admin()
returns boolean
language sql
stable
security invoker
set search_path = public, app
as $$
  select app.is_hub_admin(auth.uid());
$$;

create or replace function public.can_review(pid uuid, loc text)
returns boolean
language sql
stable
security invoker
set search_path = public, app
as $$
  select app.can_review(pid, loc, auth.uid());
$$;

grant execute on function public.is_hub_admin() to authenticated;
grant execute on function public.can_review(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Invite acceptance on sign-in
-- ---------------------------------------------------------------------------

create or replace function app.accept_invites_for_user()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  u auth.users%rowtype;
  inv public.project_invites%rowtype;
  mid uuid;
  loc text;
  gh text;
begin
  select * into u from auth.users where id = auth.uid();
  if u.id is null then
    return;
  end if;

  gh := nullif(lower(coalesce(u.raw_user_meta_data->>'user_name', u.raw_user_meta_data->>'preferred_username', '')), '');

  for inv in
    select *
    from public.project_invites i
    where i.accepted_at is null
      and (
        (i.email is not null and lower(i.email) = lower(u.email))
        or (i.github_login is not null and gh is not null and lower(i.github_login) = gh)
      )
  loop
    insert into public.project_members (project_id, user_id, role)
    values (inv.project_id, u.id, inv.role)
    on conflict (project_id, user_id) do update
      set role = excluded.role
    returning id into mid;

    if inv.role = 'reviewer' then
      delete from public.member_languages where member_id = mid;
      foreach loc in array inv.locales
      loop
        insert into public.member_languages (member_id, locale)
        values (mid, loc)
        on conflict do nothing;
      end loop;
    end if;

    update public.project_invites
    set accepted_at = now()
    where id = inv.id;
  end loop;
end;
$$;

revoke all on function app.accept_invites_for_user() from public;
grant execute on function app.accept_invites_for_user() to authenticated, service_role;

create or replace function public.accept_my_invites()
returns void
language sql
security invoker
set search_path = public, app
as $$
  select app.accept_invites_for_user();
$$;

grant execute on function public.accept_my_invites() to authenticated;

-- ---------------------------------------------------------------------------
-- Lease helpers
-- ---------------------------------------------------------------------------

create or replace function public.claim_locale_lease(
  pid uuid,
  loc text,
  minutes integer default 15,
  holder_display text default ''
)
returns public.locale_leases
language plpgsql
security invoker
set search_path = public, app
as $$
declare
  mins integer := greatest(5, least(coalesce(minutes, 15), 180));
  current public.locale_leases;
  result public.locale_leases;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not app.can_review(pid, loc, auth.uid()) then
    raise exception 'not allowed to review this locale';
  end if;

  select * into current
  from public.locale_leases
  where project_id = pid and locale = loc;

  if current.project_id is not null
     and current.until > now()
     and current.holder_id <> auth.uid() then
    return current;
  end if;

  insert into public.locale_leases as ll (project_id, locale, holder_id, holder_name, until, claimed_at)
  values (
    pid,
    loc,
    auth.uid(),
    coalesce(nullif(holder_display, ''), current.holder_name, ''),
    now() + make_interval(mins => mins),
    coalesce(current.claimed_at, now())
  )
  on conflict (project_id, locale) do update
    set holder_id = excluded.holder_id,
        holder_name = excluded.holder_name,
        until = excluded.until,
        claimed_at = case
          when ll.holder_id = excluded.holder_id and ll.until > now() then ll.claimed_at
          else now()
        end
  returning * into result;

  return result;
end;
$$;

create or replace function public.release_locale_lease(pid uuid, loc text)
returns void
language plpgsql
security invoker
set search_path = public, app
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  delete from public.locale_leases
  where project_id = pid
    and locale = loc
    and (holder_id = auth.uid() or app.is_project_admin(pid, auth.uid()));
end;
$$;

create or replace function public.heartbeat_locale_lease(
  pid uuid,
  loc text,
  minutes integer default 15
)
returns public.locale_leases
language plpgsql
security invoker
set search_path = public, app
as $$
declare
  mins integer := greatest(5, least(coalesce(minutes, 15), 180));
  result public.locale_leases;
begin
  update public.locale_leases
  set until = now() + make_interval(mins => mins)
  where project_id = pid
    and locale = loc
    and holder_id = auth.uid()
    and until > now()
  returning * into result;

  if result.project_id is null then
    select * into result
    from public.locale_leases
    where project_id = pid and locale = loc;
  end if;
  return result;
end;
$$;

grant execute on function public.claim_locale_lease(uuid, text, integer, text) to authenticated;
grant execute on function public.release_locale_lease(uuid, text) to authenticated;
grant execute on function public.heartbeat_locale_lease(uuid, text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Translation mutations (approve / unapprove / save)
-- ---------------------------------------------------------------------------

create or replace function public.require_lease_holder(pid uuid, loc text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  lease public.locale_leases;
begin
  select * into lease
  from public.locale_leases
  where project_id = pid and locale = loc and until > now();

  if lease.holder_id is distinct from auth.uid() then
    raise exception 'You do not hold the checkout for this locale';
  end if;
end;
$$;

grant execute on function public.require_lease_holder(uuid, text) to authenticated;

create or replace function public.approve_translation_keys(
  pid uuid,
  loc text,
  keys text[]
)
returns setof public.translations
language plpgsql
security invoker
set search_path = public, app
as $$
declare
  k text;
  en public.source_strings;
begin
  perform public.require_lease_holder(pid, loc);
  if not app.can_review(pid, loc, auth.uid()) then
    raise exception 'not allowed';
  end if;

  foreach k in array keys
  loop
    select * into en from public.source_strings where project_id = pid and key = k;
    if en.key is null then
      continue;
    end if;

    update public.translations t
    set approved = true,
        stale = false,
        stale_reason = null,
        approved_by = auth.uid(),
        approved_at = now(),
        en_fp = en.text_fp,
        updated_at = now()
    where t.project_id = pid and t.locale = loc and t.key = k;
  end loop;

  return query
    select * from public.translations
    where project_id = pid and locale = loc and key = any(keys);
end;
$$;

create or replace function public.unapprove_translation_key(
  pid uuid,
  loc text,
  k text
)
returns void
language plpgsql
security invoker
set search_path = public, app
as $$
begin
  perform public.require_lease_holder(pid, loc);
  if not app.can_review(pid, loc, auth.uid()) then
    raise exception 'not allowed';
  end if;

  update public.translations
  set approved = false,
      stale = false,
      stale_reason = null,
      approved_by = null,
      approved_at = null,
      en_fp = null,
      updated_at = now()
  where project_id = pid and locale = loc and key = k;
end;
$$;

create or replace function public.save_translation(
  pid uuid,
  loc text,
  k text,
  new_text text,
  new_note text default null
)
returns public.translations
language plpgsql
security invoker
set search_path = public, app
as $$
declare
  result public.translations;
begin
  perform public.require_lease_holder(pid, loc);
  if not app.can_review(pid, loc, auth.uid()) then
    raise exception 'not allowed';
  end if;

  update public.translations
  set text = coalesce(new_text, text),
      note = coalesce(new_note, note),
      approved = false,
      stale = false,
      stale_reason = null,
      approved_by = null,
      approved_at = null,
      en_fp = null,
      updated_at = now()
  where project_id = pid and locale = loc and key = k
  returning * into result;

  if result.key is null then
    insert into public.translations (project_id, locale, key, text, note)
    values (pid, loc, k, coalesce(new_text, ''), coalesce(new_note, ''))
    returning * into result;
  end if;

  return result;
end;
$$;

grant execute on function public.approve_translation_keys(uuid, text, text[]) to authenticated;
grant execute on function public.unapprove_translation_key(uuid, text, text) to authenticated;
grant execute on function public.save_translation(uuid, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.hub_admins enable row level security;
alter table public.projects enable row level security;
alter table public.project_locales enable row level security;
alter table public.project_members enable row level security;
alter table public.member_languages enable row level security;
alter table public.project_invites enable row level security;
alter table public.source_strings enable row level security;
alter table public.translations enable row level security;
alter table public.revisions enable row level security;
alter table public.revision_changes enable row level security;
alter table public.locale_leases enable row level security;
alter table public.project_credentials enable row level security;

-- hub_admins
create policy hub_admins_select on public.hub_admins
  for select to authenticated
  using (user_id = auth.uid() or app.is_hub_admin(auth.uid()));

create policy hub_admins_insert on public.hub_admins
  for insert to authenticated
  with check (app.is_hub_admin(auth.uid()));

create policy hub_admins_delete on public.hub_admins
  for delete to authenticated
  using (app.is_hub_admin(auth.uid()));

-- projects
-- Hub admins must be allowed by is_hub_admin() itself. Do not express that as
-- "id is in member_project_ids()": that helper scans projects, and a STABLE
-- scan does not see the row of an in-flight INSERT ... RETURNING, so create
-- fails with "new row violates row-level security policy".
create policy projects_select on public.projects
  for select to authenticated
  using (
    (select app.is_hub_admin(auth.uid()))
    or app.is_project_member(id, (select auth.uid()))
  );

create policy projects_insert on public.projects
  for insert to authenticated
  with check (app.is_hub_admin(auth.uid()));

create policy projects_update on public.projects
  for update to authenticated
  using (app.is_project_admin(id, auth.uid()))
  with check (app.is_project_admin(id, auth.uid()));

create policy projects_delete on public.projects
  for delete to authenticated
  using (app.is_hub_admin(auth.uid()));

-- project_locales
create policy project_locales_select on public.project_locales
  for select to authenticated
  using (project_id in (select app.member_project_ids(auth.uid())));

create policy project_locales_write on public.project_locales
  for all to authenticated
  using (app.is_project_admin(project_id, auth.uid()))
  with check (app.is_project_admin(project_id, auth.uid()));

-- project_members
create policy project_members_select on public.project_members
  for select to authenticated
  using (
    user_id = auth.uid()
    or app.is_project_admin(project_id, auth.uid())
  );

create policy project_members_write on public.project_members
  for all to authenticated
  using (app.is_project_admin(project_id, auth.uid()))
  with check (app.is_project_admin(project_id, auth.uid()));

-- member_languages
create policy member_languages_select on public.member_languages
  for select to authenticated
  using (
    exists (
      select 1 from public.project_members m
      where m.id = member_id
        and (m.user_id = auth.uid() or app.is_project_admin(m.project_id, auth.uid()))
    )
  );

create policy member_languages_write on public.member_languages
  for all to authenticated
  using (
    exists (
      select 1 from public.project_members m
      where m.id = member_id and app.is_project_admin(m.project_id, auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.project_members m
      where m.id = member_id and app.is_project_admin(m.project_id, auth.uid())
    )
  );

-- project_invites
create policy project_invites_select on public.project_invites
  for select to authenticated
  using (app.is_project_admin(project_id, auth.uid()));

create policy project_invites_write on public.project_invites
  for all to authenticated
  using (app.is_project_admin(project_id, auth.uid()))
  with check (app.is_project_admin(project_id, auth.uid()));

-- source_strings / translations / revisions (members can read)
create policy source_strings_select on public.source_strings
  for select to authenticated
  using (project_id in (select app.member_project_ids(auth.uid())));

create policy translations_select on public.translations
  for select to authenticated
  using (project_id in (select app.member_project_ids(auth.uid())));

-- Mutations go through SECURITY INVOKER RPCs that check the lease.
-- Direct table writes for reviewers are denied; admins/service_role can manage.
create policy translations_update_via_rpc on public.translations
  for update to authenticated
  using (app.can_review(project_id, locale, auth.uid()))
  with check (app.can_review(project_id, locale, auth.uid()));

create policy translations_insert_via_rpc on public.translations
  for insert to authenticated
  with check (app.can_review(project_id, locale, auth.uid()));

create policy revisions_select on public.revisions
  for select to authenticated
  using (project_id in (select app.member_project_ids(auth.uid())));

create policy revision_changes_select on public.revision_changes
  for select to authenticated
  using (
    exists (
      select 1 from public.revisions r
      where r.id = revision_id
        and r.project_id in (select app.member_project_ids(auth.uid()))
    )
  );

-- locale_leases
create policy locale_leases_select on public.locale_leases
  for select to authenticated
  using (project_id in (select app.member_project_ids(auth.uid())));

create policy locale_leases_insert on public.locale_leases
  for insert to authenticated
  with check (app.can_review(project_id, locale, auth.uid()) and holder_id = auth.uid());

create policy locale_leases_update on public.locale_leases
  for update to authenticated
  using (
    holder_id = auth.uid()
    or app.is_project_admin(project_id, auth.uid())
  )
  with check (
    holder_id = auth.uid()
    or app.is_project_admin(project_id, auth.uid())
  );

create policy locale_leases_delete on public.locale_leases
  for delete to authenticated
  using (
    holder_id = auth.uid()
    or app.is_project_admin(project_id, auth.uid())
  );

-- project_credentials: NO select for authenticated. service_role only via Edge Functions.
-- Admins may upsert through the credentials function (service role), not PostgREST.
-- Intentionally no policies for authenticated on project_credentials.

grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant select on public.hub_admins, public.projects, public.project_locales,
  public.project_members, public.member_languages, public.project_invites,
  public.source_strings, public.translations, public.revisions,
  public.revision_changes, public.locale_leases to authenticated;
grant insert, update, delete on public.projects, public.project_locales,
  public.project_members, public.member_languages, public.project_invites,
  public.locale_leases, public.hub_admins to authenticated;
grant insert, update on public.translations to authenticated;
-- No grants on project_credentials to authenticated
revoke all on public.project_credentials from anon, authenticated;
grant all on public.project_credentials to service_role;
