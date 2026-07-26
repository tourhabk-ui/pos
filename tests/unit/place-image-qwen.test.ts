/**
 * Фото точек: умный путь Qwen-Image (DashScope) с откатом на Pollinations.
 * Проверяем, что при включённой модели берётся Qwen и пишется model='qwen-image',
 * а при сбое/выключенной — Pollinations ('pollinations-flux'). Фото у точки
 * появляется всегда.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => queryMock(...a) } }));

const dashEnabled = vi.fn();
const qwenUrl = vi.fn();
vi.mock('@/lib/notifications/cover-image', () => ({
  dashScopeImageEnabled: () => dashEnabled(),
  generateQwenImageUrl: (p: string) => qwenUrl(p),
}));

import { generateAndStoreRouteImage } from '@/lib/services/ingest/ai-image-generator';

/** Достаёт model из INSERT-вызова pool.query (4-й параметр). */
function insertedModel(): string | undefined {
  const insert = queryMock.mock.calls.find(c => String(c[0]).includes('INSERT INTO ai_route_images'));
  return insert?.[1]?.[3] as string | undefined;
}

beforeEach(() => {
  queryMock.mockReset();
  // 1-й вызов — проверка «уже есть фото» → пусто; остальные (INSERT) → ок.
  queryMock.mockImplementation((sql: string) =>
    String(sql).includes('SELECT id FROM ai_route_images')
      ? Promise.resolve({ rows: [] })
      : Promise.resolve({ rows: [] }),
  );
  dashEnabled.mockReset();
  qwenUrl.mockReset();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(16),
  }));
});

describe('generateAndStoreRouteImage — Qwen-Image с фолбэком', () => {
  it('модель включена и вернула URL → model=qwen-image', async () => {
    dashEnabled.mockReturnValue(true);
    qwenUrl.mockResolvedValue('https://oss.example/place.png');

    const res = await generateAndStoreRouteImage('11111111-1111-1111-1111-111111111111', 'Вулкан Горелый', 'volcano', 'Описание');
    expect(res.cached).toBe(false);
    expect(qwenUrl).toHaveBeenCalledOnce();
    expect(insertedModel()).toBe('qwen-image');
  });

  it('модель включена, но вернула null → откат на Pollinations', async () => {
    dashEnabled.mockReturnValue(true);
    qwenUrl.mockResolvedValue(null);

    await generateAndStoreRouteImage('22222222-2222-2222-2222-222222222222', 'Озеро', 'lake', 'Описание');
    expect(insertedModel()).toBe('pollinations-flux');
  });

  it('модель выключена → Pollinations, Qwen не зовём', async () => {
    dashEnabled.mockReturnValue(false);

    await generateAndStoreRouteImage('33333333-3333-3333-3333-333333333333', 'Бухта', 'bay', 'Описание');
    expect(qwenUrl).not.toHaveBeenCalled();
    expect(insertedModel()).toBe('pollinations-flux');
  });

  it('уже есть фото → cached, генерацию не запускаем', async () => {
    queryMock.mockImplementation((sql: string) =>
      String(sql).includes('SELECT id FROM ai_route_images')
        ? Promise.resolve({ rows: [{ id: 'x' }] })
        : Promise.resolve({ rows: [] }),
    );
    dashEnabled.mockReturnValue(true);

    const res = await generateAndStoreRouteImage('44444444-4444-4444-4444-444444444444', 'Гора', 'mountain', 'Описание');
    expect(res.cached).toBe(true);
    expect(qwenUrl).not.toHaveBeenCalled();
  });
});
