-- Retire exclusive locale checkout: writes are gated by app.can_review only.
-- locale_leases table remains but is unused by RPCs and the UI.

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
