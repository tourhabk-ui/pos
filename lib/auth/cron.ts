/**
 * Cron authentication helpers.
 * Works with both NextRequest (has nextUrl) and plain Request (Web API).
 */

type AnyRequest = { headers: { get(name: string): string | null }; url: string };

/**
 * Reads cron secret from Authorization: Bearer header (preferred)
 * or falls back to ?secret= query param for backward compatibility.
 */
export function getCronSecret(request: AnyRequest): string | null {
  const fromHeader = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  if (fromHeader) return fromHeader;
  try {
    return new URL(request.url).searchParams.get('secret');
  } catch {
    return null;
  }
}

export function verifyCronSecret(request: AnyRequest): boolean {
  const provided = getCronSecret(request);
  const expected = process.env.CRON_SECRET;
  if (!provided || !expected) return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
