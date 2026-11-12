-- Per-key focus: one live editor per translation cell (45s stale takeover).

create table public.translation_focus (
  project_id uuid not null references public.projects (id) on delete cascade,
  locale text not null,
  key text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  display_name text not null default '',
  updated_at timestamptz not null default now(),
  primary key (project_id, locale, key)
);

create index translation_focus_project_locale_idx
  on public.translation_focus (project_id, locale);

alter table public.translation_focus enable row level security;

grant select, insert, update, delete on public.translation_focus to authenticated;

create policy translation_focus_select on public.translation_focus
  for select to authenticated
  using (app.is_project_member(project_id, auth.uid()) or app.is_hub_admin(auth.uid()));

-- Mutations go through RPCs (security invoker); allow holders to upsert/delete their rows.
create policy translation_focus_insert on public.translation_focus
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and app.can_review(project_id, locale, auth.uid())
  );

create policy translation_focus_update on public.translation_focus
  for update to authenticated
  using (user_id = auth.uid() or app.can_review(project_id, locale, auth.uid()))
  with check (user_id = auth.uid());

create policy translation_focus_delete on public.translation_focus
  for delete to authenticated
  using (user_id = auth.uid() or app.can_review(project_id, locale, auth.uid()));

create or replace function public.claim_translation_focus(
  pid uuid,
  loc text,
  k text,
  holder_display text default ''
)
returns public.translation_focus
language plpgsql
security invoker
set search_path = public, app
as $$
declare
  current public.translation_focus;
  result public.translation_focus;
  stale_before timestamptz := now() - interval '45 seconds';
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not app.can_review(pid, loc, auth.uid()) then
    raise exception 'not allowed';
  end if;

  select * into current
  from public.translation_focus
  where project_id = pid and locale = loc and key = k;

  if current.project_id is not null
     and current.user_id <> auth.uid()
     and current.updated_at > stale_before then
    return current;
  end if;

  insert into public.translation_focus as tf
    (project_id, locale, key, user_id, display_name, updated_at)
  values (pid, loc, k, auth.uid(), coalesce(holder_display, ''), now())
  on conflict (project_id, locale, key) do update
    set user_id = excluded.user_id,
        display_name = excluded.display_name,
        updated_at = now()
  returning * into result;

  return result;
end;
$$;

create or replace function public.release_translation_focus(
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
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  delete from public.translation_focus
  where project_id = pid and locale = loc and key = k and user_id = auth.uid();
end;
$$;

create or replace function public.heartbeat_translation_focus(
  pid uuid,
  loc text,
  k text
)
returns public.translation_focus
language plpgsql
security invoker
set search_path = public, app
as $$
declare
  result public.translation_focus;
begin
  update public.translation_focus
  set updated_at = now()
  where project_id = pid and locale = loc and key = k and user_id = auth.uid()
  returning * into result;
  return result;
end;
$$;

create or replace function public.require_focus_or_free(pid uuid, loc text, k text)
returns void
language plpgsql
security invoker
set search_path = public, app
as $$
declare
  focus public.translation_focus;
  stale_before timestamptz := now() - interval '45 seconds';
begin
  select * into focus
  from public.translation_focus
  where project_id = pid and locale = loc and key = k;

  if focus.project_id is not null
     and focus.user_id is distinct from auth.uid()
     and focus.updated_at > stale_before then
    raise exception 'Key is being edited by %', coalesce(nullif(focus.display_name, ''), 'someone else');
  end if;
end;
$$;

grant execute on function public.claim_translation_focus(uuid, text, text, text) to authenticated;
grant execute on function public.release_translation_focus(uuid, text, text) to authenticated;
grant execute on function public.heartbeat_translation_focus(uuid, text, text) to authenticated;
grant execute on function public.require_focus_or_free(uuid, text, text) to authenticated;

-- Gate writes on a fresh foreign focus.
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
  if not app.can_review(pid, loc, auth.uid()) then
    raise exception 'not allowed';
  end if;

  foreach k in array keys
  loop
    perform public.require_focus_or_free(pid, loc, k);
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
  if not app.can_review(pid, loc, auth.uid()) then
    raise exception 'not allowed';
  end if;
  perform public.require_focus_or_free(pid, loc, k);

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
  if not app.can_review(pid, loc, auth.uid()) then
    raise exception 'not allowed';
  end if;
  perform public.require_focus_or_free(pid, loc, k);

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
