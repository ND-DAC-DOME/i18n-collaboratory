-- Table-level privileges were missing; RLS alone is not enough for PostgREST.
grant select, insert, update, delete on public.translation_focus to authenticated;
