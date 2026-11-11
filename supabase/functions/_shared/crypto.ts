/** AES-GCM encrypt/decrypt for per-project GitHub tokens. */

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function keyFromSecret(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptSecret(
  plaintext: string,
): Promise<{ ciphertext: string; nonce: string }> {
  const secret = Deno.env.get("CREDENTIALS_ENCRYPTION_KEY");
  if (!secret) throw new Error("CREDENTIALS_ENCRYPTION_KEY is not set");
  const key = await keyFromSecret(secret);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    new TextEncoder().encode(plaintext),
  );
  return {
    ciphertext: b64encode(new Uint8Array(cipher)),
    nonce: b64encode(nonce),
  };
}

export async function decryptSecret(
  ciphertext: string,
  nonce: string,
): Promise<string> {
  const secret = Deno.env.get("CREDENTIALS_ENCRYPTION_KEY");
  if (!secret) throw new Error("CREDENTIALS_ENCRYPTION_KEY is not set");
  const key = await keyFromSecret(secret);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64decode(nonce) },
    key,
    b64decode(ciphertext),
  );
  return new TextDecoder().decode(plain);
}

export async function hashPushSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function randomSecret(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
