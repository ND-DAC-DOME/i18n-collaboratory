import {
  collectPages,
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

/** Fixed identity so site workflows can filter hub pushes by actor, not only message. */
const COMMIT_AUTHOR = {
  name: "i18n-collaboratory",
  email: "i18n-collaboratory@users.noreply.github.com",
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

async function ghJson<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await ghApi(token, method, path, body);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub ${method} ${path}: ${res.status} ${err.slice(0, 300)}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

type TreeEntry = {
  path: string;
  mode: "100644";
  type: "blob";
  sha: string;
};

type BranchTip = {
  parentSha: string;
  baseTreeSha: string;
  existingBlobs: Map<string, string>;
};

async function loadBranchTip(
  token: string,
  repo: string,
  branch: string,
): Promise<BranchTip> {
  const ref = await ghJson<{ object: { sha: string } }>(
    token,
    "GET",
    `/repos/${repo}/git/ref/heads/${branch}`,
  );
  const parentSha = ref.object.sha;
  const commit = await ghJson<{ tree: { sha: string } }>(
    token,
    "GET",
    `/repos/${repo}/git/commits/${parentSha}`,
  );
  const baseTreeSha = commit.tree.sha;
  const baseTree = await ghJson<{
    tree: Array<{ path?: string; sha?: string; type?: string }>;
    truncated?: boolean;
  }>(
    token,
    "GET",
    `/repos/${repo}/git/trees/${baseTreeSha}?recursive=1`,
  );
  if (baseTree.truncated) {
    throw new Error("GitHub tree listing was truncated; cannot compare file SHAs safely");
  }
  const existingBlobs = new Map<string, string>();
  for (const entry of baseTree.tree || []) {
    if (entry.type === "blob" && entry.path && entry.sha) {
      existingBlobs.set(entry.path, entry.sha);
    }
  }
  return { parentSha, baseTreeSha, existingBlobs };
}

async function createBlob(
  token: string,
  repo: string,
  content: string,
): Promise<string> {
  const blob = await ghJson<{ sha: string }>(
    token,
    "POST",
    `/repos/${repo}/git/blobs`,
    { content, encoding: "utf-8" },
  );
  return blob.sha;
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
    const sourceLocale = (project.source_locale as string) || "en";
    const localeCodes = (locales || [])
      .map((l) => l.locale as string)
      .filter((code) => code !== sourceLocale);

    const sources = await collectPages((from, to) =>
      admin
        .from("source_strings")
        .select("key, text, note")
        .eq("project_id", projectId)
        .order("key")
        .range(from, to)
    );
    const sourceFlat: Record<string, Leaf> = {};
    for (const s of sources) {
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
    const localeFiles: Record<string, string> = {};

    // Source locale stays owned by the site repo — never rewrite it on push.
    for (const code of localeCodes) {
      const rows = await collectPages((from, to) =>
        admin
          .from("translations")
          .select("key, text, note, approved, stale")
          .eq("project_id", projectId)
          .eq("locale", code)
          .order("key")
          .range(from, to)
      );
      const flat: Record<string, Leaf> = {};
      let open = 0;
      for (const r of rows) {
        flat[r.key as string] = {
          text: r.text as string,
          note: (r.note as string) || "",
        };
        if (!r.approved || r.stale) open += 1;
      }
      for (const k of Object.keys(sourceFlat)) {
        if (!(k in flat)) {
          flat[k] = { text: "", note: "" };
          open += 1;
        }
      }
      unapproved[code] = open;
      localeFiles[`${base}/${code}.json`] =
        JSON.stringify(nestStrings(flat, mode), null, 2) + "\n";
      if (mode === "plain") {
        localeFiles[`${base}/${code}.notes.json`] =
          JSON.stringify(nestNotes(flat), null, 2) + "\n";
      }
    }

    const tip = await loadBranchTip(token, project.github_repo, branch);
    const changedLocalePaths: string[] = [];
    const tree: TreeEntry[] = [];

    for (const [path, content] of Object.entries(localeFiles)) {
      const sha = await createBlob(token, project.github_repo, content);
      if (tip.existingBlobs.get(path) === sha) continue;
      tree.push({ path, mode: "100644", type: "blob", sha });
      changedLocalePaths.push(path);
    }

    let commitSha: string | null = null;
    const written: string[] = [];

    if (changedLocalePaths.length > 0) {
      const manifest = {
        project: project.slug,
        versionHash: project.head_version_hash,
        sourceLocale,
        richText: project.rich_text,
        placeholderStyle: project.placeholder_style,
        unapproved,
        exportedAt: new Date().toISOString(),
        exportedBy: userId,
      };
      const manifestPath = `${base}/manifest.json`;
      const manifestSha = await createBlob(
        token,
        project.github_repo,
        JSON.stringify(manifest, null, 2) + "\n",
      );
      if (tip.existingBlobs.get(manifestPath) !== manifestSha) {
        tree.push({
          path: manifestPath,
          mode: "100644",
          type: "blob",
          sha: manifestSha,
        });
        written.push(manifestPath);
      }
      written.push(...changedLocalePaths);

      const newTree = await ghJson<{ sha: string }>(
        token,
        "POST",
        `/repos/${project.github_repo}/git/trees`,
        { base_tree: tip.baseTreeSha, tree },
      );
      const newCommit = await ghJson<{ sha: string }>(
        token,
        "POST",
        `/repos/${project.github_repo}/git/commits`,
        {
          message,
          tree: newTree.sha,
          parents: [tip.parentSha],
          author: COMMIT_AUTHOR,
          committer: COMMIT_AUTHOR,
        },
      );
      await ghJson(
        token,
        "PATCH",
        `/repos/${project.github_repo}/git/refs/heads/${branch}`,
        { sha: newCommit.sha },
      );
      commitSha = newCommit.sha;
    }

    return jsonResponse(req, 200, {
      ok: true,
      repo: project.github_repo,
      branch,
      path: base,
      sourceLocale,
      skippedSourceLocale: true,
      commitSha,
      written,
      unchanged: commitSha == null,
      unapproved,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = /Invalid session|Missing Authorization/i.test(msg) ? 401 : 500;
    return jsonResponse(req, status, { error: msg });
  }
});
