import { corsHeaders, jsonResponse } from "../_shared/catalog.ts";
import {
  ApplyCatalogError,
  applyCatalog,
} from "../_shared/applyCatalog.ts";
import { adminClient } from "../_shared/supabase.ts";
import { hashPushSecret, timingSafeEqual } from "../_shared/crypto.ts";

type IngestBody = {
  projectSlug?: string;
  versionHash?: string;
  initialApproval?: string;
  locales?: Record<string, unknown>;
  sourceLocale?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  if (req.method !== "POST") {
    return jsonResponse(req, 405, { error: "method not allowed" });
  }

  try {
    const auth = req.headers.get("Authorization") || "";
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (!token) return jsonResponse(req, 401, { error: "missing push secret" });

    const body = (await req.json()) as IngestBody;
    const slug = (body.projectSlug || "").trim();
    const versionHash = (body.versionHash || "").trim();
    if (!slug || !versionHash) {
      return jsonResponse(req, 400, { error: "projectSlug and versionHash required" });
    }
    if (!body.locales || typeof body.locales !== "object") {
      return jsonResponse(req, 400, { error: "locales object required" });
    }

    const admin = adminClient();
    const { data: project, error: pErr } = await admin
      .from("projects")
      .select("*")
      .eq("slug", slug)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!project) return jsonResponse(req, 404, { error: "unknown project" });

    const { data: creds } = await admin
      .from("project_credentials")
      .select("push_secret_hash")
      .eq("project_id", project.id)
      .maybeSingle();
    if (!creds?.push_secret_hash) {
      return jsonResponse(req, 401, { error: "push secret not configured" });
    }
    const presented = await hashPushSecret(token);
    if (!timingSafeEqual(presented, creds.push_secret_hash)) {
      return jsonResponse(req, 401, { error: "invalid push secret" });
    }

    const result = await applyCatalog(admin, {
      project,
      locales: body.locales,
      versionHash,
      sourceLocale: body.sourceLocale,
      initialApproval: body.initialApproval,
    });
    return jsonResponse(req, 200, result);
  } catch (e) {
    if (e instanceof ApplyCatalogError) {
      return jsonResponse(req, e.status, { error: e.message });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return jsonResponse(req, 500, { error: msg });
  }
});
