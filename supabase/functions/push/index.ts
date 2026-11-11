import {
  corsHeaders,
  jsonResponse,
  nestNotes,
  nestStrings,
  type Leaf,
} from "../_shared/catalog.ts";
import { requireUser } from "../_shared/supabase.ts";
import { decryptSecret } from "../_shared/crypto.ts";

type Body = {
  projectId?: string;
  message?: string;
};

async function ghApi(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "i18n-collaboratory",
      "Content-Type": "application/json",
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
}

async function putFile(
  token: string,
  repo: string,
  branch: string,
  path: string,
  content: string,
  message: string,
): Promise<void> {
  const getRes = await ghApi(
    token,
    "GET",
    `/repos/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`,
  );
  let sha: string | undefined;
  if (getRes.ok) {
    const meta = await getRes.json();
    sha = meta.sha;
  } else if (getRes.status !== 404) {
    throw new Error(`GitHub GET ${path}: ${getRes.status}`);
  }
  const putRes = await ghApi(token, "PUT", `/repos/${repo}/contents/${encodeURI(path)}`, {
    message,
    content: btoa(unescape(encodeURIComponent(content))),
    branch,
    ...(sha ? { sha } : {}),
  });
  if (!putRes.ok) {
    const err = await putRes.text();
    throw new Error(`GitHub PUT ${path}: ${putRes.status} ${err.slice(0, 300)}`);
  }
}

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

    const { data: project } = await admin
      .from("projects")
      .select("*")
      .eq("id", projectId)
      .single();
    if (!project?.github_repo) {
      return jsonResponse(req, 400, { error: "project.github_repo is not set" });
    }

    const { data: creds } = await admin
      .from("project_credentials")
      .select("github_token_ciphertext, github_token_nonce")
      .eq("project_id", projectId)
      .maybeSingle();
    if (!creds?.github_token_ciphertext || !creds.github_token_nonce) {
      return jsonResponse(req, 400, { error: "GitHub token not configured" });
    }
    const token = await decryptSecret(
      creds.github_token_ciphertext,
      creds.github_token_nonce,
    );

    const { data: locales } = await admin
      .from("project_locales")
      .select("locale")
      .eq("project_id", projectId);
    const localeCodes = (locales || []).map((l) => l.locale as string);

    const { data: sources } = await admin
      .from("source_strings")
      .select("key, text, note")
      .eq("project_id", projectId);
    const sourceFlat: Record<string, Leaf> = {};
    for (const s of sources || []) {
      sourceFlat[s.key as string] = {
        text: s.text as string,
        note: (s.note as string) || "",
      };
    }

    const mode = project.rich_text ? "rich" : "plain";
    const base = (project.locales_path || "locales").replace(/\/$/, "");
    const branch = project.github_branch || "main";
    const message =
      body.message ||
      `i18n: export ${project.slug} @ ${project.head_version_hash || "head"}`;

    const unapproved: Record<string, number> = {};

    // Source locale
    const sourceJson = JSON.stringify(
      nestStrings(sourceFlat, mode),
      null,
      2,
    ) + "\n";
    await putFile(
      token,
      project.github_repo,
      branch,
      `${base}/${project.source_locale}.json`,
      sourceJson,
      message,
    );
    if (mode === "plain") {
      const notes = nestNotes(sourceFlat);
      await putFile(
        token,
        project.github_repo,
        branch,
        `${base}/${project.source_locale}.notes.json`,
        JSON.stringify(notes, null, 2) + "\n",
        message,
      );
    }

    for (const code of localeCodes) {
      const { data: rows } = await admin
        .from("translations")
        .select("key, text, note, approved, stale")
        .eq("project_id", projectId)
        .eq("locale", code);
      const flat: Record<string, Leaf> = {};
      let open = 0;
      for (const r of rows || []) {
        flat[r.key as string] = {
          text: r.text as string,
          note: (r.note as string) || "",
        };
        if (!r.approved || r.stale) open += 1;
      }
      // Ensure every source key exists
      for (const k of Object.keys(sourceFlat)) {
        if (!(k in flat)) {
          flat[k] = { text: "", note: "" };
          open += 1;
        }
      }
      unapproved[code] = open;
      await putFile(
        token,
        project.github_repo,
        branch,
        `${base}/${code}.json`,
        JSON.stringify(nestStrings(flat, mode), null, 2) + "\n",
        message,
      );
      if (mode === "plain") {
        await putFile(
          token,
          project.github_repo,
          branch,
          `${base}/${code}.notes.json`,
          JSON.stringify(nestNotes(flat), null, 2) + "\n",
          message,
        );
      }
    }

    const manifest = {
      project: project.slug,
      versionHash: project.head_version_hash,
      sourceLocale: project.source_locale,
      richText: project.rich_text,
      placeholderStyle: project.placeholder_style,
      unapproved,
      exportedAt: new Date().toISOString(),
      exportedBy: userId,
    };
    await putFile(
      token,
      project.github_repo,
      branch,
      `${base}/manifest.json`,
      JSON.stringify(manifest, null, 2) + "\n",
      message,
    );

    return jsonResponse(req, 200, {
      ok: true,
      repo: project.github_repo,
      branch,
      path: base,
      unapproved,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = /Invalid session|Missing Authorization/i.test(msg) ? 401 : 500;
    return jsonResponse(req, status, { error: msg });
  }
});
