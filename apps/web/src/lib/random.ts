// Random values and hashing for sign-in, from the browser's own crypto.

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Cryptographically random, URL-safe. 32 bytes → 43 characters. */
export function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** SHA-256 as lowercase hex: the form Supabase compares a sign-in nonce in. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
}
