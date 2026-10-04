/**
 * Журнал серверных ошибок пишет КОНКРЕТНЫЙ адрес и digest.
 *
 * 03.10 (prod-check run 85): 4 ошибки рендера /routes/[id] за неделю, а в
 * журнале — только шаблон маршрута и замазанный текст боевой сборки («The
 * specific message is omitted…»). Ни воспроизвести, ни сличить с логом
 * контейнера было нечем.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => query(...a) }));

describe('onRequestError', () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
    process.env.NEXT_RUNTIME = 'nodejs';
  });

  it('пишет путь без query-строки, digest и кадры стека', async () => {
    const { onRequestError } = await import('@/instrumentation');
    const err = Object.assign(new Error('An error occurred in the Server Components render.'), { digest: '2817395042' });
    await onRequestError(err, { path: '/routes/dikie-ozerki?utm=x&phone=79990000000', method: 'GET' },
      { routePath: '/routes/[id]-digest-test', routeType: 'render' });
    expect(query).toHaveBeenCalledTimes(1);
    const meta = JSON.parse(String(query.mock.calls[0][1][1]));
    expect(meta.route).toBe('/routes/[id]-digest-test');
    expect(meta.path).toBe('/routes/dikie-ozerki');
    expect(meta.digest).toBe('2817395042');
    expect(typeof meta.stack).toBe('string');
  });

  it('нет digest — честный null, а не пустая строка', async () => {
    const { onRequestError } = await import('@/instrumentation');
    await onRequestError(new Error('x'), { path: '/api/x', method: 'POST' },
      { routePath: '/api/x-digest-test', routeType: 'route' });
    const meta = JSON.parse(String(query.mock.calls[0][1][1]));
    expect(meta.digest).toBeNull();
  });
});
