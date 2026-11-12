import { flattenCatalog, sha256Hex, type Leaf } from "./catalog.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type ApplyCatalogInput = {
  project: Record<string, unknown>;
  locales: Record<string, unknown>;
  versionHash: string;
  sourceLocale?: string;
  initialApproval?: string;
};

export type ApplyCatalogResult = {
  ok: true;
  noop?: boolean;
  versionHash: string;
  sourceKeys?: number;
  changedKeys?: number;
  firstPush?: boolean;
  initialApproval?: string | null;
};

export class ApplyCatalogError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function applyCatalog(
  admin: SupabaseClient,
  input: ApplyCatalogInput,
): Promise<ApplyCatalogResult> {
  const project = input.project;
  const projectId = project.id as string;
  const versionHash = (input.versionHash || "").trim();
  if (!versionHash) {
    throw new ApplyCatalogError(400, "versionHash required");
  }
  if (!input.locales || typeof input.locales !== "object") {
    throw new ApplyCatalogError(400, "locales object required");
  }

  const { data: existingRev } = await admin
    .from("revisions")
    .select("id")
    .eq("project_id", projectId)
    .eq("version_hash", versionHash)
    .maybeSingle();
  if (existingRev) {
    return { ok: true, noop: true, versionHash };
  }

  const sourceLocale =
    input.sourceLocale || (project.source_locale as string) || "en";
  const sourceTree = input.locales[sourceLocale];
  if (sourceTree == null) {
    throw new ApplyCatalogError(400, `missing source locale ${sourceLocale}`);
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
      project_id: projectId,
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
    input.initialApproval === "approved" ? "approved" : "unapproved";
  if (!isFirst) initialApproval = "unapproved";

  const { data: priorSources } = await admin
    .from("source_strings")
    .select("key, text, text_fp")
    .eq("project_id", projectId);
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

  if (sourceEntries.length) {
    const { error } = await admin.from("source_strings").upsert(sourceEntries);
    if (error) throw error;
  }
  if (removedKeys.length) {
    const { error } = await admin
      .from("source_strings")
      .delete()
      .eq("project_id", projectId)
      .in("key", removedKeys);
    if (error) throw error;
    await admin
      .from("translations")
      .delete()
      .eq("project_id", projectId)
      .in("key", removedKeys);
  }

  const localeCodes = Object.keys(input.locales).filter(
    (c) => c !== sourceLocale,
  );
  for (const code of localeCodes) {
    await admin.from("project_locales").upsert({
      project_id: projectId,
      locale: code,
      label: code,
    });
  }

  const now = new Date().toISOString();
  const changedKeys = new Set(
    changes.filter((c) => c.old_text != null).map((c) => c.key),
  );
  for (const code of localeCodes) {
    const flat = flattenCatalog(input.locales[code]);
    const rows: Record<string, unknown>[] = [];

    const { data: existingRows } = await admin
      .from("translations")
      .select("*")
      .eq("project_id", projectId)
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
          project_id: projectId,
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
          project_id: projectId,
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
          project_id: projectId,
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
          existing.approved && !existing.stale && existing.en_fp === enFp;
        rows.push({
          project_id: projectId,
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
      project_id: projectId,
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
    .eq("id", projectId);

  return {
    ok: true,
    versionHash,
    sourceKeys: Object.keys(sourceFlat).length,
    changedKeys: changedOnly.length,
    firstPush: isFirst,
    initialApproval: isFirst ? initialApproval : null,
  };
}

/** Stable content hash for browser uploads (sorted locale codes, then JSON). */
export async function contentVersionHash(
  locales: Record<string, unknown>,
  sourceLocale: string,
): Promise<string> {
  const codes = Object.keys(locales).sort();
  const payload: Record<string, unknown> = { sourceLocale };
  for (const code of codes) {
    payload[code] = locales[code];
  }
  return sha256Hex(JSON.stringify(payload));
}
