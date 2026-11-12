import { corsHeaders, jsonResponse } from "../_shared/catalog.ts";
import { requireUser } from "../_shared/supabase.ts";
import {
  encryptSecret,
  hashPushSecret,
  randomSecret,
} from "../_shared/crypto.ts";

type Body = {
  projectId?: string;
  action?: "rotate_push_secret" | "set_github_token" | "clear_github_token";
  githubToken?: string;
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

    const action = body.action;
    if (action === "rotate_push_secret") {
      const secret = randomSecret(32);
      const hash = await hashPushSecret(secret);
      const { error } = await admin.from("project_credentials").upsert({
        project_id: projectId,
        push_secret_hash: hash,
        updated_at: new Date().toISOString(),
        updated_by: userId,
      });
      if (error) throw error;
      return jsonResponse(req, 200, {
        ok: true,
        pushSecret: secret,
        note: "Store this secret now. It is shown only once.",
      });
    }

    if (action === "set_github_token") {
      const token = (body.githubToken || "").trim();
      if (!token) return jsonResponse(req, 400, { error: "githubToken required" });
      const { ciphertext, nonce } = await encryptSecret(token);
      const { data: existing } = await admin
        .from("project_credentials")
        .select("push_secret_hash")
        .eq("project_id", projectId)
        .maybeSingle();
      const { error } = await admin.from("project_credentials").upsert({
        project_id: projectId,
        push_secret_hash: existing?.push_secret_hash ?? null,
        github_token_ciphertext: ciphertext,
        github_token_nonce: nonce,
        updated_at: new Date().toISOString(),
        updated_by: userId,
      });
      if (error) throw error;
      return jsonResponse(req, 200, { ok: true });
    }

    if (action === "clear_github_token") {
      const { error } = await admin
        .from("project_credentials")
        .update({
          github_token_ciphertext: null,
          github_token_nonce: null,
          updated_at: new Date().toISOString(),
          updated_by: userId,
        })
        .eq("project_id", projectId);
      if (error) throw error;
      return jsonResponse(req, 200, { ok: true });
    }

    return jsonResponse(req, 400, { error: "unknown action" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = /Invalid session|Missing Authorization/i.test(msg) ? 401 : 500;
    return jsonResponse(req, status, { error: msg });
  }
});
