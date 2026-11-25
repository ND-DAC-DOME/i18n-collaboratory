-- Name-only reviewers, and writes require the 15-minute locale checkout again.
-- Per-key focus stays. Anonymous sessions never become admins.

create or replace function app.enter_as_reviewer(project_slug text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  proj public.projects%rowtype;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) is not true then
    raise exception 'name review is only for a name session';
  end if;

  if project_slug is not null and btrim(project_slug) <> '' then
    if not exists (select 1 from public.projects where slug = project_slug) then
      raise exception 'Unknown project %', project_slug;
    end if;
  end if;

  for proj in
    select *
    from public.projects p
    where project_slug is null
       or btrim(project_slug) = ''
       or p.slug = project_slug
  loop
    insert into public.project_members (project_id, user_id, role)
    values (proj.id, uid, 'reviewer')
    on conflict (project_id, user_id) do nothing;

    insert into public.member_languages (member_id, locale)
    select m.id, pl.locale
    from public.project_members m
    join public.project_locales pl on pl.project_id = m.project_id
    where m.project_id = proj.id
      and m.user_id = uid
      and m.role = 'reviewer'
    on conflict (member_id, locale) do nothing;
  end loop;
end;
$$;

revoke all on function app.enter_as_reviewer(text) from public;
grant execute on function app.enter_as_reviewer(text) to authenticated, service_role;

create or replace function public.enter_as_reviewer(project_slug text default null)
returns void
language sql
security invoker
set search_path = public, app
as $$
  select app.enter_as_reviewer(project_slug);
$$;

revoke all on function public.enter_as_reviewer(text) from public;
grant execute on function public.enter_as_reviewer(text) to authenticated;

create or replace function public.approve_translation_keys(
  pid uuid,
  loc text,
  keys text[],
  approver_display text default ''
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
  perform public.require_lease_holder(pid, loc);

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
        approved_by_name = nullif(trim(coalesce(approver_display, '')), ''),
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
  perform public.require_lease_holder(pid, loc);
  perform public.require_focus_or_free(pid, loc, k);

  update public.translations
  set approved = false,
      stale = false,
      stale_reason = null,
      approved_by = null,
      approved_by_name = null,
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
  perform public.require_lease_holder(pid, loc);
  perform public.require_focus_or_free(pid, loc, k);

  update public.translations
  set text = coalesce(new_text, text),
      note = coalesce(new_note, note),
      approved = false,
      stale = false,
      stale_reason = null,
      approved_by = null,
      approved_by_name = null,
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
