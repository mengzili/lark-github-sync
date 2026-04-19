/**
 * Verify an incoming GitHub webhook via X-Hub-Signature-256 header.
 *
 * GitHub signs `sha256=<hex>` where <hex> is HMAC-SHA256 of the raw body
 * using the shared secret configured when the webhook was created.
 * Ref: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
 */

const enc = new TextEncoder();

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyGitHubSignature(
  secret: string,
  rawBody: string,
  header: string | null,
): Promise<boolean> {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = 'sha256=' + (await hmacSha256Hex(secret, rawBody));
  return constantTimeEqual(expected, header);
}
