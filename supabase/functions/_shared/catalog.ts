/** Catalog flatten / nest helpers. Mirrors approval_util.flatten_catalog leaf rules. */

export type Leaf = { text: string; note: string };

export function isLeafEntry(node: unknown): node is { text: string; note?: string } {
  if (!node || typeof node !== "object" || Array.isArray(node)) return false;
  const obj = node as Record<string, unknown>;
  if (typeof obj.text !== "string") return false;
  return Object.keys(obj).every((k) => k === "text" || k === "note");
}

export function leafText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "object" && typeof (node as { text?: unknown }).text === "string") {
    return (node as { text: string }).text;
  }
  return "";
}

export function leafNote(node: unknown): string {
  if (node && typeof node === "object" && typeof (node as { note?: unknown }).note === "string") {
    return (node as { note: string }).note;
  }
  return "";
}

export function flattenCatalog(
  obj: unknown,
  prefix = "",
): Record<string, Leaf> {
  const out: Record<string, Leaf> = {};
  let items: [string, unknown][] = [];
  if (Array.isArray(obj)) {
    items = obj.map((v, i) => [String(i), v]);
  } else if (obj && typeof obj === "object") {
    items = Object.entries(obj as Record<string, unknown>);
  } else {
    return out;
  }
  for (const [k, v] of items) {
    if (String(k).startsWith("_")) continue;
    const path = prefix ? `${prefix}.${k}` : String(k);
    if (isLeafEntry(v)) {
      out[path] = { text: leafText(v), note: leafNote(v) };
    } else if (v && typeof v === "object") {
      Object.assign(out, flattenCatalog(v, path));
    } else if (typeof v === "string" && k !== "note") {
      out[path] = { text: v, note: "" };
    }
  }
  return out;
}

export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text ?? "");
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Rebuild a nested object from dotted keys. Arrays are used when every sibling key is numeric. */
export function nestStrings(
  flat: Record<string, Leaf>,
  mode: "plain" | "rich",
): unknown {
  const root: Record<string, unknown> = {};
  for (const [key, leaf] of Object.entries(flat)) {
    const parts = key.split(".");
    let cur: Record<string, unknown> | unknown[] = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      const next = parts[i + 1];
      const wantArray = /^\d+$/.test(next);
      if (Array.isArray(cur)) {
        const idx = Number(p);
        if (cur[idx] == null) cur[idx] = wantArray ? [] : {};
        cur = cur[idx] as Record<string, unknown> | unknown[];
      } else {
        if (cur[p] == null) cur[p] = wantArray ? [] : {};
        cur = cur[p] as Record<string, unknown> | unknown[];
      }
    }
    const last = parts[parts.length - 1];
    const value = mode === "rich"
      ? (leaf.note ? { text: leaf.text, note: leaf.note } : { text: leaf.text })
      : leaf.text;
    if (Array.isArray(cur)) {
      cur[Number(last)] = value;
    } else {
      cur[last] = value;
    }
  }
  return root;
}

export function nestNotes(flat: Record<string, Leaf>): unknown {
  const notes: Record<string, Leaf> = {};
  for (const [k, v] of Object.entries(flat)) {
    if (v.note) notes[k] = { text: v.note, note: "" };
  }
  return nestStrings(notes, "plain");
}

export function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get("Origin") ?? "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

export function jsonResponse(
  req: Request,
  status: number,
  body: unknown,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
