/**
 * /api/images/s3/<ключ> — снимок из хранилища по ключу (14.10).
 *
 * Статья летописи собирается при сборке образа, а адрес объекта зависит от
 * S3_BUCKET — поэтому страница ставит этот адрес, а сервер на запросе
 * отвечает редиректом. Открыто ровно то, что публикуется: `photos/…jpg`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { photoKeyOf, photoPath } from '@/lib/images/photo-key';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function get(parts: string[]) {
  const { GET } = await import('@/app/api/images/s3/[...key]/route');
  return GET(new Request('https://vedarai.ru/api/images/s3/x'), { params: Promise.resolve({ key: parts }) });
}

describe('какой ключ открывается', () => {
  it('снимки под photos/ — да', () => {
    expect(photoKeyOf(['photos', 'kronotsky', 'kronotskaya-v-shlyape.jpg'])).toBe('photos/kronotsky/kronotskaya-v-shlyape.jpg');
    expect(photoPath('photos/kronotsky/a.jpg')).toBe('/api/images/s3/photos/kronotsky/a.jpg');
  });

  it('чужие префиксы, не JPEG и выход наверх — нет', () => {
    expect(photoKeyOf(['places', '7190e0a4-0000-4000-8000-000000000000', 'a.jpg'])).toBeNull();
    expect(photoKeyOf(['videos', 'fishingkam', 'clip-fish-catch.mp4'])).toBeNull();
    expect(photoKeyOf(['photos', 'kronotsky', 'a.png'])).toBeNull();
    expect(photoKeyOf(['photos', '..', 'maps', 'a.jpg'])).toBeNull();
    expect(photoKeyOf(['photos', 'Kronotsky', 'A.jpg'])).toBeNull();
  });
});

describe('ответ сервера', () => {
  it('ключ под photos/ — редирект на объект хранилища', async () => {
    vi.stubEnv('S3_BUCKET', 'vedar-test');
    vi.stubEnv('S3_ENDPOINT', 'https://s3.twcstorage.ru');
    const res = await get(['photos', 'kronotsky', 'kronotskaya-v-shlyape.jpg']);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://s3.twcstorage.ru/vedar-test/photos/kronotsky/kronotskaya-v-shlyape.jpg');
  });

  it('чужой ключ — 404, бакета нет — 404, а не редирект в корень хранилища', async () => {
    vi.stubEnv('S3_BUCKET', 'vedar-test');
    expect((await get(['places', 'x', 'a.jpg'])).status).toBe(404);
    vi.resetModules();
    vi.stubEnv('S3_BUCKET', '');
    expect((await get(['photos', 'kronotsky', 'a.jpg'])).status).toBe(404);
  });
});
