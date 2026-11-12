import {
  corsHeaders,
  flattenCatalog,
  jsonResponse,
  sha256Hex,
  type Leaf,
} from "../_shared/catalog.ts";
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

    const { data: existingRev } = await admin
      .from("revisions")
      .select("id")
      .eq("project_id", project.id)
      .eq("version_hash", versionHash)
      .maybeSingle();
    if (existingRev) {
      return jsonResponse(req, 200, { ok: true, noop: true, versionHash });
    }

    const sourceLocale = body.sourceLocale || project.source_locale || "en";
    const sourceTree = body.locales[sourceLocale];
    if (sourceTree == null) {
      return jsonResponse(req, 400, { error: `missing source locale ${sourceLocale}` });
    }

    const sourceFlat = flattenCatalog(sourceTree);
    const sourceEntries: {
      project_id: string;
      key: string;
      text: string;
      note: string;
      text_fp: string;
      previous_text: string | null;
      updated_at: string;
    }[] = [];
    const fps: Record<string, string> = {};
    for (const [key, leaf] of Object.entries(sourceFlat)) {
      const fp = await sha256Hex(leaf.text);
      fps[key] = fp;
      sourceEntries.push({
        project_id: project.id,
        key,
        text: leaf.text,
        note: leaf.note,
        text_fp: fp,
        previous_text: null,
        updated_at: new Date().toISOString(),
      });
    }

    const isFirst = !project.head_version_hash;
    let initialApproval =
      body.initialApproval === "approved" ? "approved" : "unapproved";
    if (!isFirst) initialApproval = "unapproved"; // ignored for later pushes

    const { data: priorSources } = await admin
      .from("source_strings")
      .select("key, text, text_fp")
      .eq("project_id", project.id);
    const priorMap = new Map(
      (priorSources || []).map((r) => [r.key as string, r]),
    );

    const changes: { key: string; old_text: string | null; new_text: string }[] =
      [];
    for (const entry of sourceEntries) {
      const prev = priorMap.get(entry.key);
      if (!prev) {
        changes.push({ key: entry.key, old_text: null, new_text: entry.text });
        continue;
      }
      if (prev.text_fp !== entry.text_fp) {
        entry.previous_text = prev.text as string;
        changes.push({
          key: entry.key,
          old_text: prev.text as string,
          new_text: entry.text,
        });
      } else {
        entry.previous_text = null;
      }
    }

    const removedKeys = [...priorMap.keys()].filter((k) => !(k in sourceFlat));

    // Upsert source strings
    if (sourceEntries.length) {
      const { error } = await admin.from("source_strings").upsert(sourceEntries);
      if (error) throw error;
    }
    if (removedKeys.length) {
      const { error } = await admin
        .from("source_strings")
        .delete()
        .eq("project_id", project.id)
        .in("key", removedKeys);
      if (error) throw error;
      await admin
        .from("translations")
        .delete()
        .eq("project_id", project.id)
        .in("key", removedKeys);
    }

    // Locales from payload (excluding source) + ensure project_locales rows
    const localeCodes = Object.keys(body.locales).filter((c) => c !== sourceLocale);
    for (const code of localeCodes) {
      await admin.from("project_locales").upsert({
        project_id: project.id,
        locale: code,
        label: code,
      });
    }

    const now = new Date().toISOString();
    const changedKeys = new Set(
      changes.filter((c) => c.old_text != null).map((c) => c.key),
    );
    for (const code of localeCodes) {
      const flat = flattenCatalog(body.locales[code]);
      const rows: Record<string, unknown>[] = [];

      const { data: existingRows } = await admin
        .from("translations")
        .select("*")
        .eq("project_id", project.id)
        .eq("locale", code);
      const existingByKey = new Map(
        (existingRows || []).map((r) => [r.key as string, r]),
      );

      for (const key of Object.keys(sourceFlat)) {
        const leaf: Leaf = flat[key] || { text: "", note: "" };
        const enFp = fps[key];
        const existing = existingByKey.get(key);

        if (isFirst) {
          const nonempty = !!(leaf.text && leaf.text.trim());
          const approve = initialApproval === "approved" && nonempty;
          rows.push({
            project_id: project.id,
            locale: code,
            key,
            text: leaf.text,
            note: leaf.note,
            approved: approve,
            approved_by: null,
            approved_at: approve ? now : null,
            en_fp: approve ? enFp : null,
            stale: false,
            stale_reason: null,
            updated_at: now,
          });
          continue;
        }

        const changed = changedKeys.has(key);
        if (!existing) {
          rows.push({
            project_id: project.id,
            locale: code,
            key,
            text: leaf.text,
            note: leaf.note,
            approved: false,
            approved_by: null,
            approved_at: null,
            en_fp: null,
            stale: false,
            stale_reason: null,
            updated_at: now,
          });
        } else if (changed) {
          rows.push({
            project_id: project.id,
            locale: code,
            key,
            text: existing.text,
            note: existing.note,
            approved: false,
            approved_by: existing.approved_by,
            approved_at: existing.approved_at,
            en_fp: existing.en_fp,
            stale: true,
            stale_reason: "en_source_changed",
            updated_at: now,
          });
        } else {
          const keep =
            existing.approved &&
            !existing.stale &&
            existing.en_fp === enFp;
          rows.push({
            project_id: project.id,
            locale: code,
            key,
            text: existing.text,
            note: existing.note ?? leaf.note,
            approved: !!keep,
            approved_by: keep ? existing.approved_by : null,
            approved_at: keep ? existing.approved_at : null,
            en_fp: keep ? enFp : null,
            stale: false,
            stale_reason: null,
            updated_at: now,
          });
        }
      }

      // Batch upsert in chunks
      const chunk = 200;
      for (let i = 0; i < rows.length; i += chunk) {
        const slice = rows.slice(i, i + chunk);
        const { error } = await admin.from("translations").upsert(slice);
        if (error) throw error;
      }
    }

    const { data: rev, error: revErr } = await admin
      .from("revisions")
      .insert({
        project_id: project.id,
        version_hash: versionHash,
        source_key_count: Object.keys(sourceFlat).length,
        changed_key_count: changes.filter((c) => c.old_text != null).length,
        initial_approval: isFirst ? initialApproval : null,
      })
      .select("id")
      .single();
    if (revErr) throw revErr;

    const changedOnly = changes.filter((c) => c.old_text != null);
    if (changedOnly.length) {
      const { error } = await admin.from("revision_changes").insert(
        changedOnly.map((c) => ({
          revision_id: rev.id,
          key: c.key,
          old_text: c.old_text,
          new_text: c.new_text,
        })),
      );
      if (error) throw error;
    }

    await admin
      .from("projects")
      .update({
        head_version_hash: versionHash,
        updated_at: now,
      })
      .eq("id", project.id);

    return jsonResponse(req, 200, {
      ok: true,
      versionHash,
      sourceKeys: Object.keys(sourceFlat).length,
      changedKeys: changedOnly.length,
      firstPush: isFirst,
      initialApproval: isFirst ? initialApproval : null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonResponse(req, 500, { error: msg });
  }
});
