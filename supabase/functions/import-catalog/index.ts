import { corsHeaders, jsonResponse } from "../_shared/catalog.ts";
import {
  ApplyCatalogError,
  applyCatalog,
  contentVersionHash,
} from "../_shared/applyCatalog.ts";
import { requireUser } from "../_shared/supabase.ts";

type Body = {
  projectId?: string;
  locales?: Record<string, unknown>;
  sourceLocale?: string;
  initialApproval?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  if (req.method !== "POST") {
    return jsonResponse(req, 405, { error: "method not allowed" });
  }

  try {
    const { userId, admin } = await requireUser(req);
    const body = (await req.json()) as Body;
    const projectId = (body.projectId || "").trim();
    if (!projectId) return jsonResponse(req, 400, { error: "projectId required" });
    if (!body.locales || typeof body.locales !== "object") {
      return jsonResponse(req, 400, { error: "locales object required" });
    }

    const { data: member } = await admin
      .from("project_members")
      .select("role")
      .eq("project_id", projectId)
      .eq("user_id", userId)
      .maybeSingle();
    const { data: hub } = await admin
      .from("hub_admins")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();
    if ((!member || member.role !== "admin") && !hub) {
      return jsonResponse(req, 403, { error: "project admin required" });
    }

    const { data: project, error: pErr } = await admin
      .from("projects")
      .select("*")
      .eq("id", projectId)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!project) return jsonResponse(req, 404, { error: "unknown project" });

    const sourceLocale =
      (body.sourceLocale || "").trim() ||
      (project.source_locale as string) ||
      "en";
    if (body.locales[sourceLocale] == null) {
      return jsonResponse(req, 400, {
        error: `missing source locale ${sourceLocale}`,
      });
    }

    const versionHash = await contentVersionHash(body.locales, sourceLocale);
    const result = await applyCatalog(admin, {
      project,
      locales: body.locales,
      versionHash,
      sourceLocale,
      initialApproval: body.initialApproval,
    });
    return jsonResponse(req, 200, result);
  } catch (e) {
    if (e instanceof ApplyCatalogError) {
      return jsonResponse(req, e.status, { error: e.message });
    }
    const msg = e instanceof Error ? e.message : String(e);
    const status = /Invalid session|Missing Authorization/i.test(msg)
      ? 401
      : 500;
    return jsonResponse(req, status, { error: msg });
  }
});
