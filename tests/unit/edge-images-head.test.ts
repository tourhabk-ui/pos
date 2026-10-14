// @vitest-environment node
/**
 * HEAD к снимкам /api/images — как GET (слово владельца 14.10 «ТРОГАЙ», §7).
 *
 * Перепись sitemap 14.10 (прогон 8): 67 og:image вида /api/images/route/<id>
 * отвечали HEAD 401 при GET 200. HEAD — то, чем обходчики и превью
 * мессенджеров проверяют картинку, не скачивая её; по RFC 9110 это тот же GET
 * без тела. Роуты /api/images объявляют только GET — HEAD Next.js выводит из
 * него сам, — а Edge-реестр публичных API пускал анонима лишь с GET.
 *
 * Тест ИСПОЛНЯЕТ middleware настоящими запросами (как edge-admin-gate):
 * строка в реестре ничего не доказывает, пока шлюз её не прочитал. «Пропущен» —
 * NextResponse.next(), заголовок x-middleware-next: 1.
 *
 * Исключение узкое: открыт ровно HEAD и ровно под /api/images; запись по этим
 * адресам и HEAD к закрытым адресам по-прежнему без входа не проходят.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-at-least-32-bytes-long-000';
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

async function run(path: string, method: string) {
  const { middleware } = await import('../../middleware');
  return middleware(new NextRequest(`https://vedarai.ru${path}`, { method }));
}

const passed = (res: Response) => res.headers.get('x-middleware-next') === '1';

const IMAGES = [
  '/api/images/route/36214e49-de02-4d1b-8f71-1926a1b319fa',
  '/api/images/place-gallery/36214e49-de02-4d1b-8f71-1926a1b319fa/0',
  '/api/images/s3/places/36214e49-de02-4d1b-8f71-1926a1b319fa.jpg',
];

describe('снимки: HEAD без входа — как GET', () => {
  for (const path of IMAGES) {
    it(`HEAD ${path} пропущен на Edge`, async () => {
      const res = await run(path, 'HEAD');
      expect(res.status).not.toBe(401);
      expect(passed(res)).toBe(true);
    });

    it(`GET ${path} пропущен, как и прежде`, async () => {
      expect(passed(await run(path, 'GET'))).toBe(true);
    });
  }
});

describe('исключение узкое', () => {
  it('запись по адресу снимка без входа — 401', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await run(IMAGES[0], method);
      expect(passed(res), method).toBe(false);
      expect(res.status, method).toBe(401);
    }
  });

  it('HEAD к закрытым адресам без входа — по-прежнему 401: HEAD открыт не везде', async () => {
    for (const path of ['/api/tourist/profile', '/api/hub/operator/me', '/api/admin/places/search']) {
      const res = await run(path, 'HEAD');
      expect(passed(res), path).toBe(false);
      expect(res.status, path).toBe(401);
    }
  });

  it('адрес-двойник не попадает под исключение: сверка по сегментам, не по началу строки', async () => {
    const res = await run('/api/images-export', 'HEAD');
    expect(passed(res)).toBe(false);
    expect(res.status).toBe(401);
  });
});
