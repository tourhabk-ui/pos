import { describe, it, expect, vi, beforeEach } from 'vitest';
import { containsProfanity } from '@/lib/services/profanity-filter';

describe('containsProfanity (PurgoMalum)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns false for empty text without calling the service', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const result = await containsProfanity('   ');
    expect(result).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns true when PurgoMalum reports profanity', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('true', { status: 200 }));
    const result = await containsProfanity('плохой текст');
    expect(result).toBe(true);
  });

  it('returns false when PurgoMalum reports clean text', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('false', { status: 200 }));
    const result = await containsProfanity('прекрасное место');
    expect(result).toBe(false);
  });

  it('returns null (fail-open) on network error, does not throw', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));
    await expect(containsProfanity('текст')).resolves.toBeNull();
  });

  it('returns null on non-ok HTTP status', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
    const result = await containsProfanity('текст');
    expect(result).toBeNull();
  });

  it('returns null on an unexpected response body (neither true nor false)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('<html>error page</html>', { status: 200 }));
    const result = await containsProfanity('текст');
    expect(result).toBeNull();
  });

  it('calls the HTTP (not HTTPS) PurgoMalum endpoint — the service does not support TLS', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('false', { status: 200 }));
    await containsProfanity('текст');
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toMatch(/^http:\/\/www\.purgomalum\.com/);
  });
});
