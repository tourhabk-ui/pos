// @vitest-environment node
/**
 * /api/discovery на Edge — только чтение для гостя (аудит 15.10, W2-2).
 *
 * Реестр публичных API пускал анонима под весь префикс /api/discovery с GET
 * и POST. После волны 2 (PR #2516) анонимного писателя там не осталось:
 * отзывы и статистика сняты, единственный POST — публикация тура — сам
 * требует оператора. Но запись на ПРЕФИКС открывала бы анониму и любой
 * будущий POST под ним, молча: автор нового писателя не видит, что Edge его
 * уже пропустил. POST из записи снят.
 *
 * Тест ИСПОЛНЯЕТ настоящий middleware (как edge-images-head и
 * edge-admin-gate): строка в реестре ничего не доказывает, пока шлюз её не
 * прочитал. «Пропущен» — NextResponse.next(), заголовок x-middleware-next: 1.
 *
 * Второй блок — опись писателей под app/api/discovery вызовом самих
 * обработчиков без входа: на ней держится довод «снять POST безопасно —
 * вошедшему оператору Edge открыт, а гостю писать там нечего».
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { NextRequest } from 'next/server';
import { createToken } from '@/lib/auth/jwt';

const sqlCalls: string[] = [];
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: async (sql: string) => {
      sqlCalls.push(sql);
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({
      query: async (sql: string) => {
        sqlCalls.push(sql);
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    }),
  },
}));

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-at-least-32-bytes-long-000';
  // Без Upstash лимитер на Edge выключен — тест про гейт, не про лимит.
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

async function run(path: string, method: string, headers?: Record<string, string>) {
  const { middleware } = await import('../../middleware');
  return middleware(new NextRequest(`https://vedarai.ru${path}`, { method, headers }));
}

const passed = (res: Response) => res.headers.get('x-middleware-next') === '1';

const PUBLISH = '/api/discovery/tours/51/publish';
// Адрес, которого сегодня нет: так выглядит будущий писатель под префиксом.
const FUTURE_WRITER = '/api/discovery/tours/51/reviews';

describe('гость: читать можно, писать нельзя', () => {
  it.each([
    '/api/discovery/search?q=%D0%B2%D1%83%D0%BB%D0%BA%D0%B0%D0%BD',
    '/api/discovery/search/recommendations?type=trending',
    '/api/discovery/tours',
    '/api/discovery/tours/51',
  ])('GET %s пропущен на Edge', async (path) => {
    const res = await run(path, 'GET');
    expect(res.status).not.toBe(401);
    expect(passed(res)).toBe(true);
  });

  it.each([PUBLISH, FUTURE_WRITER, '/api/discovery'])('POST %s без входа — 401 на Edge', async (path) => {
    const res = await run(path, 'POST');
    expect(passed(res)).toBe(false);
    expect(res.status).toBe(401);
  });

  it('прочие записывающие методы без входа — тоже 401', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const res = await run(FUTURE_WRITER, method);
      expect(passed(res), method).toBe(false);
      expect(res.status, method).toBe(401);
    }
  });
});

describe('вошедший оператор: Edge пропускает POST к обработчику', () => {
  it('JWT оператора в cookie — пропуск', async () => {
    const token = await createToken({ userId: 'op-1', email: 'op@vedarai.ru', role: 'operator' });
    const res = await run(PUBLISH, 'POST', { cookie: `auth_token=${token}` });
    expect(passed(res)).toBe(true);
  });

  it('JWT оператора в Authorization: Bearer — пропуск', async () => {
    const token = await createToken({ userId: 'op-1', email: 'op@vedarai.ru', role: 'operator' });
    const res = await run(PUBLISH, 'POST', { authorization: `Bearer ${token}` });
    expect(passed(res)).toBe(true);
  });

  it('битый токен — 401, а не пропуск', async () => {
    const res = await run(PUBLISH, 'POST', { authorization: 'Bearer not-a-jwt' });
    expect(passed(res)).toBe(false);
    expect(res.status).toBe(401);
  });
});

/** Все route.ts под каталогом — опись с диска, а не список в тесте. */
function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (name === 'route.ts') out.push(full);
  }
  return out;
}

describe('опись писателей под app/api/discovery: каждый сам требует входа', () => {
  const ROOT = process.cwd();
  const files = routeFiles(join(ROOT, 'app/api/discovery'));

  it('опись не пуста — иначе проверять нечего, и зелёный был бы ложным', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('у каждого записывающего обработчика гость получает 401 и не доходит до базы', async () => {
    const writers: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file).split(sep).join('/');
      const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const handler = mod[method];
        if (typeof handler !== 'function') continue;
        writers.push(`${method} ${rel}`);
        // Путь запроса — каталог роута с подставленным id вместо [id].
        const url = '/' + rel.replace(/^app\//, '').replace(/\/route\.ts$/, '').replace(/\[[^\]]+\]/g, '51');
        sqlCalls.length = 0;
        const res = (await (handler as (r: NextRequest, c: unknown) => Promise<Response>)(
          new NextRequest(`https://vedarai.ru${url}`, { method, body: '{}' }),
          { params: Promise.resolve({ id: '51' }) },
        )) as Response;
        expect(res.status, `${method} ${rel}`).toBe(401);
        expect(sqlCalls, `${method} ${rel}`).toEqual([]);
      }
    }
    // Сегодня писатель один. Появился второй — опись его уже проверила выше;
    // эта строка лишь называет, кого именно она видела.
    expect(writers).toContain('POST app/api/discovery/tours/[id]/publish/route.ts');
  });
});
