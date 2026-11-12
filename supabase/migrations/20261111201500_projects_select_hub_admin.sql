-- INSERT ... RETURNING (what the browser uses for create) also applies the
-- SELECT policy to the new row. The old policy required
-- id IN (SELECT app.member_project_ids(auth.uid())), and that helper's hub-admin
-- branch scans projects. A STABLE scan uses the statement snapshot, so the new
-- id is missing, the SELECT check fails, and Postgres reports
-- "new row violates row-level security policy" even though the INSERT check
-- (is_hub_admin) passed.

drop policy if exists projects_select on public.projects;

create policy projects_select on public.projects
  for select to authenticated
  using (
    (select app.is_hub_admin(auth.uid()))
    or app.is_project_member(id, (select auth.uid()))
  );
