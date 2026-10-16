// Proof Key for Code Exchange (RFC 7636). The website makes a random secret
// (the verifier), sends only its hash (the challenge) when sign-in starts, and
// must show the secret itself to turn the returned code into a session. A
// code stolen from the address bar or a log is useless without it.

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Cryptographically random, URL-safe. 32 bytes → 43 characters. */
export function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}
